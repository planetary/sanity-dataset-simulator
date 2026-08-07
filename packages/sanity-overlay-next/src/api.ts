/**
 * The overlay HTTP API, as one framework-neutral handler.
 *
 * `handle(request: Request): Promise<Response>` is deliberately the Web Fetch
 * shape rather than a `node:http` one, because PRD §10.1 requires this package
 * to expose App Router handlers: a `route.ts` is
 *
 *   export const POST = (request: Request) => api.handle(request)
 *
 * and `server.ts` mounts the same handler on a `node:http` server for local
 * development. One route table, two mountings, no second implementation to keep
 * in step.
 *
 * ROUTES (PRD §37 Phase 2 "Local API and client")
 *
 *   GET  /health      liveness, plus which overlay root is in play
 *   GET  /state       the whole projection, for boot-time hydration
 *   GET  /events      SSE change bridge (§14.4 steps 8-10)
 *   POST /resolve     batch document read (§18.1, §18.2, §22.2)
 *   POST /commit      one write batch — mutations or document actions
 *   POST /query       a registered GROQ query, evaluated (§22.6)
 *   POST /query/plan  what must be fetched from base to answer it exactly
 *
 * WHAT THIS FILE OWNS: HTTP, an overlay lifecycle, an in-memory projection of
 * what is on disk, a commit queue, and the event bridge. It owns no overlay
 * semantics at all — mutations and document actions are core's reducers,
 * persistence is the store, GROQ is `sanity-overlay-query`.
 */
import {
  REBASE_MODES,
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  discardDraft,
  duplicate,
  getRecord,
  isSyntheticRev,
  overlayConflictSummary,
  overlayDocumentIds,
  publish,
  resolveDocumentBatch,
  resolveVersionBatch,
  restore,
  toPublishedId,
  unpublish,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayConflict,
  OverlayDocumentRecord,
  OverlayState,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import type {
  FsOverlayAssetStore,
  FsOverlayStore,
  OverlayWatchHandle,
} from '../../sanity-overlay-store-fs/src/index'
import {revalidationIsNotable, watchOverlay} from '../../sanity-overlay-store-fs/src/index'
import {createQueryRegistry, M_LOCAL_QUERIES} from '../../sanity-overlay-query/src/index'
import type {
  OverlayQueryRegistry,
  QueryPerspective,
} from '../../sanity-overlay-query/src/index'
import {
  ASSET_UPLOAD_HEADER,
  assertUploadIsNotForged,
  assetBasePathFor,
  assetRouteOf,
  cdnFallthroughLocation,
  deliverAsset,
  putUploadedAsset,
  uploadFilenameFrom,
  uploadResponseBody,
  withUrl,
} from './assets'
import {OverlayApiError} from './errors'
import {evaluateRegisteredQuery, planRegisteredQuery} from './queries'
import {runRebase as performRebase, type StudioRebaseMode} from './rebase'
import {encodeSseFrame} from './sse'
import {translateDocumentActions, translateInterceptedWrite} from './translate'

type Rec = Record<string, unknown>

/** Studio autosaves on every keystroke burst; a runaway body is a bug, not content. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * The transport ceiling for an upload — PRD §24.5 "enforce size limits".
 *
 * SEPARATE FROM {@link MAX_BODY_BYTES}, because they bound different things: a
 * JSON commit that big is a bug, an image that big is a photograph. This is the
 * outer bound the SERVER will read at all; `FsOverlayAssetStore` applies the
 * project's own (smaller, configurable) `maxBytes` afterwards, and its refusal is
 * the one an editor sees. Kept in step with core's `DEFAULT_MAX_ASSET_BYTES`.
 */
const MAX_ASSET_BYTES = 20 * 1024 * 1024

const DEFAULT_ACTOR: OverlayActor = {
  type: 'user',
  id: 'overlay-local-api',
  displayName: 'Overlay local API',
}

/** The events this bridge is allowed to emit (PRD §14.4 steps 8-10). */
export type OverlayEventName =
  | 'hello'
  | 'document.changed'
  | 'overlay.invalid'
  | 'overlay.repaired'

/** One document as the Studio addresses it, for boot-time hydration (§13.9). */
export interface OverlayHydrationDocument {
  logicalId: string
  schemaType: string
  runtimeRevision: string
  updatedAt: string
  draftTombstone: boolean
  publishedTombstone: boolean
  draft: Rec | null
  published: Rec | null
  /**
   * The unresolved-and-resolved conflict records this document currently carries
   * (PRD §13.3, §17.11, §28.1-§28.3).
   *
   * ALWAYS PRESENT, and `[]` means clean. The ABSENCE of this key is a different
   * fact — "this API cannot tell you" — and §28.1 forbids collapsing the two: a
   * consumer that reads a missing field as zero is hiding conflicts, and one
   * that reads an empty array as unknown disables its own resolution UI forever.
   * That second failure is not hypothetical; it is what happened while `/state`
   * omitted the key and only `/resolve` computed it.
   */
  conflicts: OverlayConflict[]
  /** §17.2 precedence: `branch` means the document exists nowhere upstream. */
  origin: 'base' | 'branch'
  /** §16.4. `null` when the document has no base block at all. */
  baseStatus: 'present' | 'deleted' | 'unknown' | null
  /** §13.4 — the revision the merge ancestor was captured at, when there is one. */
  baseRevisionAtFirstTouch?: string
  /** §13.4 — the most recent base revision this overlay observed. */
  currentBaseRevision?: string
}

export interface OverlayApiOptions {
  /** An opened filesystem store. The API never constructs one for you. */
  store: FsOverlayStore
  /**
   * Branch-local asset storage (PRD §24.3). ABSENT MEANS THE ASSET ROUTES DO NOT
   * EXIST, and that is a stated refusal rather than a silent 404: an upload to a
   * server with no asset store is answered `501 ASSETS_NOT_CONFIGURED` with the
   * reason, because §5.5 forbids letting a caller conclude anything from silence.
   */
  assetStore?: FsOverlayAssetStore
  overlayId?: string
  base?: {projectId: string; dataset: string; apiVersion: string}
  source?: {repositoryId: string; branch?: string}
  actor?: unknown
  /** Injected clock. Required in spirit: nothing here reads a wall clock. */
  now: () => string
  /**
   * The §22.5 query registry. Defaults to the `[M-LOCAL]` slice — a query that
   * is not in it is refused with a reason, never approximated (§5.5).
   */
  registry?: OverlayQueryRegistry
  /**
   * Origins granted a CORS grant. `['*']` allows any.
   *
   * DEFAULTS TO NONE, deliberately. This API serves the entire branch — every
   * draft, every unpublished edit — and a permissive default would let any page
   * in the same browser read all of it. An App Router mounting is same-origin
   * and needs nothing here; `startOverlayApiServer` names the Studio dev origin
   * because it exists for exactly one client.
   */
  origins?: readonly string[]
  log?: (level: 'warn' | 'error', message: string) => void
  /** Prefix for the transaction IDs this API assigns (PRD §13.10). */
  transactionIdPrefix?: string
}

export interface OverlayApi {
  readonly overlayId: string
  readonly revision: number
  /** Mount this from a Next App Router `route.ts`, or from `server.ts`. */
  handle(request: Request): Promise<Response>
  /**
   * Run one direct-edit revalidation pass (PRD §14.3, §14.4 steps 2-4, 7, 10).
   *
   * PUBLIC because it is the unit that must share the commit mutex, and a
   * serialisation claim that cannot be driven from a test is a claim nobody
   * checks. `server.ts` puts this on a timer; the timer is a latency knob and
   * nothing else.
   */
  pollDirectEdits(): Promise<void>
  /** Number of live `/events` subscribers, for tests and diagnostics. */
  subscriberCount(): number
  close(): Promise<void>
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeActor(value: unknown): OverlayActor | null {
  if (!isRec(value)) return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  const type = ['user', 'agent', 'service'].includes(value.type as string)
    ? (value.type as OverlayActor['type'])
    : 'user'
  const actor: OverlayActor = {type, id: value.id}
  if (typeof value.displayName === 'string') actor.displayName = value.displayName
  return actor
}

/**
 * Base documents usable as a merge ancestor (PRD §13.3, §13.4).
 *
 * A document with no `_rev` cannot anchor an ancestor, and one carrying a
 * SYNTHETIC overlay `_rev` (§13.9) is something this overlay already produced —
 * accepting it as base would make the overlay its own ancestor, and would let a
 * browser smuggle branch content in as if it were staging. Both are dropped
 * rather than repaired.
 */
function usableBaseDocuments(value: unknown): SanityDocument[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (document): document is SanityDocument =>
      isRec(document) &&
      typeof document._id === 'string' &&
      typeof document._type === 'string' &&
      typeof document._rev === 'string' &&
      document._rev.length > 0 &&
      !isSyntheticRev(document._rev),
  )
}

async function openOverlay(
  store: FsOverlayStore,
  input: {
    overlayId: string
    base: OverlayApiOptions['base']
    source: OverlayApiOptions['source']
    actor: OverlayActor
  },
): Promise<{overlayId: string; state: OverlayState}> {
  let manifest: Awaited<ReturnType<FsOverlayStore['inspect']>> | null = null
  try {
    manifest = await store.inspect()
  } catch (error) {
    if ((error as {code?: string})?.code !== 'OVERLAY_NOT_FOUND') throw error
  }

  if (manifest === null) {
    manifest = await store.createOverlay({
      overlayId: input.overlayId,
      base: input.base,
      source: input.source,
      actor: input.actor,
      ifNotExists: true,
    } as Parameters<FsOverlayStore['createOverlay']>[0])
  }

  return {overlayId: manifest.overlayId, state: await hydrateState(store, manifest)}
}

/**
 * Rebuild the projection entirely from what is on disk.
 *
 * That is what makes a restart transparent: the API holds no state the store
 * does not. A `read.record === null` means the immutable revision was pruned
 * while the review surface survived (a fresh clone with no `.runtime/`); the
 * document is simply not replayable, which is reported by `/events` rather than
 * faked here.
 */
async function hydrateState(
  store: FsOverlayStore,
  manifest: {overlayId: string; revision: number},
): Promise<OverlayState> {
  const documents: Record<string, OverlayDocumentRecord> = {}
  const heads = await store.listChangedDocuments(manifest.overlayId, {includeUnchanged: true})
  for (const head of heads) {
    const read = await store.readDocumentByLogicalId(manifest.overlayId, head.logicalId)
    if (read?.record) documents[read.record.logicalId] = read.record
  }
  return createOverlayState({
    overlayId: manifest.overlayId,
    revision: manifest.revision,
    documents,
  })
}

/**
 * The boot-time hydration payload: for every document the overlay touches, the
 * materialized draft and published bodies exactly as Studio addresses them
 * (§13.9). A tombstoned perspective is `null`, which is how a client learns to
 * hide a locally deleted document.
 *
 * The §28.2 review columns ride along, because they are facts the record already
 * holds and a reviewer needs them on the same screen as the conflict itself. An
 * absent base revision is OMITTED rather than filled with a placeholder (§5.5):
 * a branch-created document has no merge ancestor, and inventing a plausible one
 * in a reviewer-facing column is exactly the filler that section rules out.
 *
 * NOTHING IS RECOMPUTED HERE. §17.11 makes the commit the detection point, so
 * `record.conflicts` is already the answer — written by `persistConflicts` at
 * commit and read back from disk by `hydrateState` at boot. Re-detecting would
 * anyway be impossible: core never fetches base (§16.1) and this endpoint is
 * handed no `baseDocuments`, so the persisted set is the only honest answer
 * there is. That is what makes the Studio's 5-second `/state` poll free — an
 * array read and an O(documents) count, no merge, no I/O.
 */
function hydrationDocuments(state: OverlayState): OverlayHydrationDocument[] {
  return Object.keys(state.documents)
    .sort()
    .map((logicalId) => {
      const record = state.documents[logicalId]!
      const base = record.base
      const capturedRevision = base?.published?.revision ?? base?.draft?.revision
      const observedRevision =
        base?.lastObservedPublishedRevision ?? base?.lastObservedDraftRevision
      return {
        logicalId,
        schemaType: record.schemaType,
        runtimeRevision: record.runtimeRevision,
        updatedAt: record.updatedAt,
        draftTombstone: record.local.draftTombstone,
        publishedTombstone: record.local.publishedTombstone,
        draft: record.local.draftTombstone
          ? null
          : ((record.local.draft?.materialized ?? null) as Rec | null),
        published: record.local.publishedTombstone
          ? null
          : ((record.local.published?.materialized ?? null) as Rec | null),
        conflicts: record.conflicts,
        origin: record.origin,
        baseStatus: base?.baseStatus ?? null,
        ...(capturedRevision === undefined ? {} : {baseRevisionAtFirstTouch: capturedRevision}),
        ...(observedRevision === undefined ? {} : {currentBaseRevision: observedRevision}),
      }
    })
}

const REDUCERS = {
  publish,
  unpublish,
  discardDraft,
  delete: deleteDocument,
  duplicate,
} as const

export async function createOverlayApi(options: OverlayApiOptions): Promise<OverlayApi> {
  const {store} = options
  const now = options.now
  const log = options.log ?? (() => undefined)
  const registry = options.registry ?? createQueryRegistry(M_LOCAL_QUERIES)
  const defaultActor = normalizeActor(options.actor) ?? DEFAULT_ACTOR
  const allowedOrigins = new Set(options.origins ?? [])
  const idPrefix = options.transactionIdPrefix ?? 'overlay-api'

  const opened = await openOverlay(store, {
    overlayId: options.overlayId ?? 'overlay-local',
    base: options.base,
    source: options.source,
    actor: defaultActor,
  })

  const overlayId = opened.overlayId
  let state = opened.state
  let sequence = 0

  /* ---------------------------------------------------------------- *
   * The commit mutex
   * ---------------------------------------------------------------- *
   *
   * The manifest IS the commit point, so two overlapping commits race on its
   * revision. One promise chain makes the pipeline serial.
   *
   * THE TAIL IS FLATTENED, and that is the whole of it. `queue` is advanced to a
   * promise that resolves however `run` settled, so it can never reject. A tail
   * that carried the rejection would leave every later `queue.then(task)`
   * skipping its task — one poisoned autosave wedging every autosave after it —
   * and would hand the same rejection to `close()`, which awaits this chain.
   *
   * The caller still gets the real outcome: `run` is returned unflattened, so a
   * failed commit is a failed commit for the request that made it, and only for
   * that request.
   */
  let queue: Promise<void> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /* ---------------------------------------------------------------- *
   * The event bridge — PRD §14.4 steps 8-10
   * ---------------------------------------------------------------- *
   *
   * DURABILITY PRECEDES NOTIFICATION. Every `emit` runs after the store has
   * passed its commit point, never before. An event is an instruction to
   * refetch, so an early one makes a subscriber read the PREVIOUS state and
   * cache it as current — the same defect as acknowledging an HTTP request
   * before the write finished, with a longer fuse.
   *
   * FRAMES ARE ENCODED, NOT INTERPOLATED — see `sse.ts`, which owns that and
   * says why it is a separate unit.
   */
  const encoder = new TextEncoder()
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let eventSequence = 0

  function writeFrame(
    controller: ReadableStreamDefaultController<Uint8Array>,
    id: number,
    event: OverlayEventName,
    data: unknown,
  ): void {
    controller.enqueue(encoder.encode(encodeSseFrame({id, event, data})))
  }

  function emit(event: OverlayEventName, data: unknown): number {
    eventSequence += 1
    for (const controller of [...subscribers]) {
      try {
        writeFrame(controller, eventSequence, event, data)
      } catch (error) {
        /* A subscriber that vanished between its close callback and this write
         * is not a server fault, and must not stop the other subscribers. */
        subscribers.delete(controller)
        log('error', `overlay events: dropped a subscriber mid-write: ${String(error)}`)
      }
    }
    return eventSequence
  }

  /**
   * Announce a committed transaction.
   *
   * `projection: 'current'` because a commit updates the projection in the same
   * step that made it durable, so `/state` and `/resolve` already agree with the
   * event by the time it is written.
   */
  function announceCommit(result: Rec): void {
    if (result.committed !== true) return
    const documentIds = Array.isArray(result.affectedDocumentIds)
      ? [...(result.affectedDocumentIds as string[])].sort()
      : []
    if (documentIds.length === 0) return
    emit('document.changed', {
      overlayId,
      revision: result.revision,
      /* A LIST, never a joined string: two documents must stay two elements, or
       * the payload is indistinguishable from one document whose ID contained
       * the separator. */
      documentIds,
      origin: 'commit',
      projection: 'current',
      transactionId: result.transactionId,
    })
  }

  /* ---------------------------------------------------------------- *
   * Direct edits (PRD §14.3, §14.4)
   * ---------------------------------------------------------------- *
   *
   * `intervalMs: 0` disables the watcher's OWN timer on purpose. Its `poll()`
   * calls `store.revalidate`, which repairs a stale checksum by REWRITING
   * `intent.json` — a write, and therefore something that must never run beside
   * a commit. `pollDirectEdits` below puts every pass on the same mutex the
   * commit path uses, so the two can never interleave their writes.
   */
  const watcher: OverlayWatchHandle = watchOverlay(store, overlayId, {intervalMs: 0})

  /**
   * Fingerprint of the last announced `overlay.invalid` set.
   *
   * A broken file stays broken, so every pass re-reports it. Without this, one
   * bad file becomes an unbounded event stream that buries every real change.
   * The fingerprint is a JSON array of arrays — structurally unambiguous — and
   * NOT a separator-joined string, which would let two different findings
   * fingerprint identically.
   */
  let lastInvalidFingerprint = '[]'

  async function runWatchPass(): Promise<void> {
    const report = await watcher.poll()
    if (!revalidationIsNotable(report)) return

    /* The manifest is the revision authority; the projection only mirrors it. */
    if (report.manifestChanged) {
      const manifest = await store.inspect()
      state = {...state, revision: manifest.revision}
    }

    if (report.changed.length > 0) {
      emit('document.changed', {
        overlayId,
        revision: state.revision,
        documentIds: [...report.changed].sort(),
        origin: 'direct-edit',
        /**
         * `/state` and `/resolve` are built from the IMMUTABLE record the
         * manifest head names. A direct edit rewrites `intent.json` and touches
         * neither, and replaying intent + base snapshot back into a record needs
         * core's three-way merge engine, which exports no such entry point
         * today. So the staleness is DECLARED ON THE WIRE rather than hidden: a
         * consumer reading the canonical files — the CLI, a preview build — is
         * fully served, and a consumer reading `/state` is told not to trust it.
         */
        projection: 'stale',
      })
    }

    if (report.repairedChecksums.length > 0) {
      /*
       * A checksum repair changes bytes without changing meaning (§14.3), so it
       * is its own kind of news — and it is emitted INDEPENDENTLY of
       * `document.changed`, not as an alternative to it.
       *
       * The two nearly always co-occur, because a hand-edited file is both
       * changed and stale-checksummed in the same pass. Reporting only the
       * change would mean the one event that says "the overlay rewrote a file
       * under you" is unreachable in practice, which makes it undiagnosable when
       * a repair is the thing that surprised someone.
       */
      emit('overlay.repaired', {
        overlayId,
        revision: state.revision,
        refs: [...report.repairedChecksums].sort(),
      })
    }

    const fingerprint = JSON.stringify(
      report.invalid.map((failure) => [failure.ref, failure.code, failure.message]),
    )
    if (report.invalid.length > 0 && fingerprint !== lastInvalidFingerprint) {
      emit('overlay.invalid', {
        overlayId,
        revision: state.revision,
        /* §14.4 step 10 — the store keeps serving the last valid state, so this
         * is a report, not a state transition. `brokenCopyRef` is the route out
         * that `sanity-overlay normalize` prints. */
        invalid: report.invalid.map((failure) => ({
          ref: failure.ref,
          logicalId: failure.logicalId,
          code: failure.code,
          message: failure.message,
          brokenCopyRef: failure.brokenCopyRef,
        })),
      })
    }
    lastInvalidFingerprint = fingerprint
  }

  /* ---------------------------------------------------------------- *
   * Writes
   * ---------------------------------------------------------------- */

  function nextTransactionId(): string {
    sequence += 1
    return `${idPrefix}-${String(sequence).padStart(6, '0')}`
  }

  function replayEnvelope(transactionId: string, unsupported: string[]): Rec {
    return {
      ok: true,
      committed: false,
      replayed: true,
      overlayId,
      revision: state.revision,
      transactionId,
      unsupported,
      documents: hydrationDocuments(state),
    }
  }

  async function commitMutations(body: Rec, kind: 'actions' | 'mutations'): Promise<Rec> {
    const idempotencyKey = body.idempotencyKey as string

    /*
     * §34.6 — checked HERE, before the mutation engine runs, and against the
     * STORE rather than core's in-memory ledger.
     *
     *   - Before translation, because `applyTransaction` would otherwise apply
     *     the mutations to the projection a second time. The store would refuse
     *     to persist them, so `/state` would then report a value the file on
     *     disk contradicts — a divergence with no error attached to it.
     *   - Against the store, because core's ledger is not rehydrated from disk,
     *     so a restart would re-apply every key ever used.
     */
    const replayed = await store.getTransaction(overlayId, {idempotencyKey})
    if (replayed !== null) return replayEnvelope(replayed.transactionId, [])

    const translated = translateInterceptedWrite({kind, payload: body.payload})
    if (translated.unsupported.length > 0) {
      log('warn', `overlay commit ${idempotencyKey}: ${translated.unsupported.join('; ')}`)
    }

    if (translated.mutations.length === 0) {
      return {
        ok: true,
        committed: false,
        replayed: false,
        overlayId,
        revision: state.revision,
        unsupported: translated.unsupported,
        documents: hydrationDocuments(state),
      }
    }

    const actor = normalizeActor(body.actor) ?? defaultActor
    const applied = applyTransaction(state, translated.mutations, {
      transactionId: nextTransactionId(),
      idempotencyKey,
      actor,
      now,
      base: createBaseSource(usableBaseDocuments(body.baseDocuments)),
    })

    const records = applied.transaction.affectedDocumentIds
      .map((logicalId) => applied.state.documents[logicalId])
      .filter((record): record is OverlayDocumentRecord => record !== undefined)

    /* AWAITED, deliberately. The HTTP response is the browser's only signal that
     * an edit is durable, so it must not be produced before the store has
     * finished writing. A detached commit here would also escape every `try` in
     * this file and surface as an unhandled rejection. */
    const stored = await store.commitTransaction(overlayId, {
      idempotencyKey,
      actor,
      mutations: translated.mutations,
      records,
    })

    /* The store owns the persisted revision counter, so the projection adopts it
     * rather than keeping a second, drifting one. */
    state = {...applied.state, revision: stored.manifest.revision}

    return {
      ok: true,
      committed: true,
      replayed: stored.replayed,
      overlayId,
      revision: stored.manifest.revision,
      transactionId: stored.transaction.transactionId,
      affectedDocumentIds: applied.transaction.affectedDocumentIds,
      unsupported: translated.unsupported,
      documents: hydrationDocuments(state),
    }
  }

  /**
   * Studio's publish / unpublish / delete / discard / duplicate / restore are
   * not mutations, so they cannot go through `applyTransaction`. They dispatch
   * to core's §18 reducers instead — this function names the reducer and
   * supplies the transaction envelope, and owns none of the semantics.
   *
   * Each reducer call is its own transaction, because §34.5 pins one revision
   * increment per transaction and core exposes no way to fold two reducers into
   * one. Per-step idempotency keys derive from the request's key, so a retried
   * request replays every step it already ran (§34.6) rather than applying half
   * of it twice.
   */
  async function commitDocumentActions(body: Rec): Promise<Rec> {
    const idempotencyKey = body.idempotencyKey as string
    const translated = translateDocumentActions(body.payload)
    if (translated.unsupported.length > 0) {
      log('warn', `overlay actions ${idempotencyKey}: ${translated.unsupported.join('; ')}`)
    }

    const stepKey = (index: number): string => `${idempotencyKey}#${index}`

    /* The first step's key stands for the whole request: if it is on disk the
     * request already ran, so nothing is re-applied. */
    const replayed = await store.getTransaction(overlayId, {idempotencyKey: stepKey(0)})
    if (replayed !== null) {
      return replayEnvelope(replayed.transactionId, translated.unsupported)
    }

    if (translated.steps.length === 0) {
      return {
        ok: true,
        committed: false,
        replayed: false,
        overlayId,
        revision: state.revision,
        unsupported: translated.unsupported,
        documents: hydrationDocuments(state),
      }
    }

    const actor = normalizeActor(body.actor) ?? defaultActor
    const base = createBaseSource(usableBaseDocuments(body.baseDocuments))
    const affectedDocumentIds: string[] = []
    let committed = 0
    let lastTransactionId: string | undefined

    type ApplyOptions = Parameters<typeof publish>[2]
    const runStep = async (
      index: number,
      apply: (options: ApplyOptions) => {state: OverlayState; transaction: {
        affectedDocumentIds: string[]
        mutations: Parameters<FsOverlayStore['commitTransaction']>[1]['mutations']
      }},
    ): Promise<void> => {
      const applied = apply({
        transactionId: nextTransactionId(),
        idempotencyKey: stepKey(index),
        actor,
        now,
        base,
      } as ApplyOptions)

      const records = applied.transaction.affectedDocumentIds
        .map((logicalId) => applied.state.documents[logicalId])
        .filter((record): record is OverlayDocumentRecord => record !== undefined)

      /* AWAITED for the same reason the mutation path awaits. */
      const stored = await store.commitTransaction(overlayId, {
        idempotencyKey: stepKey(index),
        actor,
        mutations: applied.transaction.mutations,
        records,
      })

      state = {...applied.state, revision: stored.manifest.revision}
      committed += 1
      lastTransactionId = stored.transaction.transactionId
      for (const id of applied.transaction.affectedDocumentIds) {
        if (!affectedDocumentIds.includes(id)) affectedDocumentIds.push(id)
      }
    }

    let index = 0
    for (const step of translated.steps) {
      if (step.type === 'restore') {
        /* core's `getRecord`, not a bare `state.documents[…]`. `step.id` comes
         * off the wire, and a plain-object map answers `"__proto__"` /
         * `"constructor"` / `"toString"` from the prototype chain — so the
         * lookup returned `Object.prototype` and the `record.local` read below
         * threw an uncoded 500 (review P3-10). */
        const record = getRecord(state, step.id) ?? undefined
        const tombstoned =
          record !== undefined &&
          ((step.target !== 'published' && record.local.draftTombstone) ||
            (step.target !== 'draft' && record.local.publishedTombstone))

        /* §18.8 restore proper — clearing a tombstone. Skipped when there is no
         * tombstone, so a plain history restore does not burn a revision on a
         * no-op state transition. */
        if (tombstoned) {
          await runStep(index, (o) => restore(state, {id: step.id, target: step.target}, o) as never)
          index += 1
        }

        /* The restored body itself is an ordinary full replacement. */
        if (step.document !== undefined) {
          const document = step.document
          await runStep(
            index,
            (o) => applyTransaction(state, [{type: 'createOrReplace', document}], o) as never,
          )
          index += 1
        }
        continue
      }

      const reducer = REDUCERS[step.type]
      const input =
        step.type === 'duplicate' ? {id: step.id, newId: step.newId} : {id: step.id}
      await runStep(index, (o) => (reducer as never as Function)(state, input, o))
      index += 1
    }

    return {
      ok: true,
      committed: committed > 0,
      replayed: false,
      overlayId,
      revision: state.revision,
      transactionId: lastTransactionId,
      affectedDocumentIds,
      unsupported: translated.unsupported,
      documents: hydrationDocuments(state),
    }
  }

  /* ---------------------------------------------------------------- *
   * §29.1 — checkpoint
   * ---------------------------------------------------------------- *
   *
   * A CHECKPOINT CHANGES NO BRANCH STATE. It renders the review-facing tree —
   * manifest, one intent per head, the base snapshots those intents name, and
   * the §14.3 checksums — into a directory a human commits to Git. No
   * transaction, no revision increment, nothing lost. `committed: false` in the
   * answer is that fact, not a failure.
   *
   * `manifest.checkpoint` (§13.1) IS NOT STAMPED UNLESS THE CALLER NAMES A
   * COMMIT. That field records `{overlayRevision, commitSha, createdAt}`, and a
   * checkpoint written from a Studio has no commit SHA — the commit does not
   * exist yet, by construction, since this is what produces the files that will
   * be committed. Inventing one would put a fabricated SHA into the manifest
   * that `sanity-overlay status` prints and CI's §29.6 policy trusts, which is
   * precisely the silent approximation §5.5 forbids. A CI step that HAS the SHA
   * passes `commitSha` and gets the marker; the browser gets the tree and is
   * told, in `manifestMarked`, that the marker was not written and why.
   */
  async function commitCheckpoint(body: Rec): Promise<Rec> {
    const payload = isRec(body.payload) ? body.payload : {}
    const dir = typeof payload.dir === 'string' && payload.dir.length > 0 ? payload.dir : undefined
    const commitSha =
      typeof payload.commitSha === 'string' && payload.commitSha.trim().length > 0
        ? payload.commitSha.trim()
        : undefined

    let manifestMarked = false
    let markerReason =
      'no `commitSha` was supplied, so PRD §13.1 `manifest.checkpoint` was not stamped — the ' +
      'commit that will carry this checkpoint does not exist yet. Commit the tree and record ' +
      'the SHA, or call this endpoint again with `commitSha` from CI.'

    if (commitSha !== undefined) {
      /* STAMPED BEFORE THE RENDER, deliberately. `exportCheckpoint` writes
       * `manifest.json` and `checksums.json` together; marking the manifest
       * afterwards would leave the tree's own checksum file describing bytes the
       * tree no longer holds, and the next `importCheckpoint` would report it as
       * divergence. */
      const current = await store.readManifest(overlayId)
      const marked = await store.writeManifestConditional(
        overlayId,
        {
          ...current,
          revision: current.revision + 1,
          checkpoint: {
            overlayRevision: current.revision + 1,
            commitSha,
            createdAt: now(),
          },
        },
        current.revision,
        {actor: normalizeActor(body.actor) ?? defaultActor},
      )
      state = {...state, revision: marked.revision}
      manifestMarked = true
      markerReason = ''
    }

    const exported = await store.exportCheckpoint(
      overlayId,
      dir === undefined ? {} : {dir},
    )

    return {
      ok: true,
      /* No transaction was recorded, so no `document.changed` is announced. */
      committed: false,
      replayed: false,
      overlayId,
      revision: state.revision,
      checkpoint: {
        dir: exported.dir,
        files: exported.files,
        checksum: exported.checksums.checksum,
        overlayRevision: state.revision,
        manifestMarked,
        ...(manifestMarked ? {} : {manifestMarkerReason: markerReason}),
      },
      unsupported: [],
      documents: hydrationDocuments(state),
    }
  }

  /* ---------------------------------------------------------------- *
   * §17, §28.4, §28.5 — rebase
   * ---------------------------------------------------------------- *
   *
   * `documents` in the answer is the PER-DOCUMENT OUTCOME, not the hydration
   * array every other endpoint puts there. That is what
   * `sanity-overlay-studio`'s `readRebaseOutcome` reads, and it exists because
   * §28.5's four preconditions come back as `applied: false` with a `blockedBy`
   * list rather than as an error: a 200 carrying a hydration array would be read
   * as "the rebase happened" by a client that only checked the status code.
   *
   * NOTHING IS PARTIALLY APPLIED. If any in-scope document is blocked, the whole
   * run is reported and no record is written — a half-rebased overlay has no
   * spelling in §13.1 and no way back.
   */
  async function commitRebase(body: Rec): Promise<Rec> {
    const idempotencyKey = body.idempotencyKey as string
    const replayed = await store.getTransaction(overlayId, {idempotencyKey})
    if (replayed !== null) return replayEnvelope(replayed.transactionId, [])

    const payload = isRec(body.payload) ? body.payload : {}
    const mode = typeof payload.mode === 'string' ? payload.mode : 'auto'
    if (mode !== 'auto' && !(REBASE_MODES as readonly string[]).includes(mode)) {
      throw new OverlayApiError(
        400,
        'INVALID_REQUEST',
        `unknown rebase mode ${JSON.stringify(mode)}. PRD §28.4 defines ` +
          `${REBASE_MODES.join(', ')}, and §28.5 adds "auto".`,
      )
    }

    const requested = Array.isArray(payload.documentIds)
      ? payload.documentIds.filter((id): id is string => typeof id === 'string')
      : null
    const scope = (requested === null ? overlayDocumentIds(state.documents) : requested).map(
      toPublishedId,
    )

    const records = scope
      .map((logicalId) => getRecord(state, logicalId))
      .filter((record): record is OverlayDocumentRecord => record !== null && record !== undefined)

    if (records.length === 0) {
      return {
        ok: true,
        committed: false,
        replayed: false,
        overlayId,
        revision: state.revision,
        documents: [],
        unsupported: ['the overlay holds no branch record for any requested document'],
      }
    }

    /* §16.1 — core never fetches base, and this server holds no Sanity
     * credential. The caller states the base or the rebase does not run. */
    const currentBase = new Map<string, SanityDocument>()
    for (const document of usableBaseDocuments(body.baseDocuments)) {
      currentBase.set(toPublishedId(document._id), document)
    }

    const missing = records
      .filter((record) => !currentBase.has(record.logicalId))
      .map((record) => record.logicalId)
    if (missing.length > 0) {
      throw new OverlayApiError(
        400,
        'BASE_REQUIRED',
        `a rebase recomputes against the CURRENT base, and this request carried no usable base ` +
          `document for ${missing.join(', ')}. PRD §16.1 keeps base fetching out of the overlay, ` +
          `so the caller must send the current base (as \`baseDocuments\`) — assuming the base ` +
          `has not moved would report a rebase that never happened.`,
      )
    }

    const actor = normalizeActor(body.actor) ?? defaultActor
    const run = performRebase({
      mode: mode as StudioRebaseMode,
      records,
      currentBase,
      overlayRevision: state.revision,
      now: now(),
      actor,
      transactionId: () => nextTransactionId(),
    })

    const blocked = run.outcomes.filter((outcome) => outcome.blockedBy.length > 0)
    if (blocked.length > 0 || run.records.length === 0) {
      return {
        ok: true,
        committed: false,
        replayed: false,
        overlayId,
        revision: state.revision,
        documents: run.outcomes,
        unsupported: [],
      }
    }

    const stored = await store.commitTransaction(overlayId, {
      idempotencyKey,
      actor,
      /* Empty on purpose, matching `sanity-overlay rebase`: the post-state record
       * IS the payload — there is no mutation that spells "the ancestor moved". */
      mutations: [],
      records: run.records,
      expectedOverlayRevision: state.revision,
    })

    const documents: Record<string, OverlayDocumentRecord> = {...state.documents}
    for (const record of run.records) documents[record.logicalId] = record
    state = createOverlayState({
      overlayId,
      revision: stored.manifest.revision,
      documents,
    })

    return {
      ok: true,
      committed: true,
      replayed: stored.replayed,
      overlayId,
      revision: stored.manifest.revision,
      transactionId: stored.transaction.transactionId,
      affectedDocumentIds: run.records.map((record) => record.logicalId),
      documents: run.outcomes,
      unsupported: [],
    }
  }

  async function commit(body: unknown): Promise<Rec> {
    if (!isRec(body)) {
      throw new OverlayApiError(400, 'INVALID_REQUEST', 'commit body must be a JSON object')
    }
    const {idempotencyKey, kind} = body
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new OverlayApiError(
        400,
        'INVALID_REQUEST',
        'commit requires a non-empty `idempotencyKey` (PRD §13.10, §34.6)',
      )
    }
    if (kind === 'documentActions') return commitDocumentActions(body)
    if (kind === 'actions' || kind === 'mutations') return commitMutations(body, kind)
    if (kind === 'checkpoint') return commitCheckpoint(body)
    if (kind === 'rebase') return commitRebase(body)
    throw new OverlayApiError(
      400,
      'INVALID_REQUEST',
      'commit requires kind "actions", "mutations", "documentActions", "checkpoint" or "rebase"',
    )
  }

  /* ---------------------------------------------------------------- *
   * Reads (PRD §18.1, §18.2, §22.2)
   * ---------------------------------------------------------------- *
   *
   * SYNCHRONOUS AND UNQUEUED, both deliberately:
   *
   *   - synchronous, because resolution is a pure function of the projection.
   *     Nothing started here can outlive the request — the bug class `/commit`
   *     was fixed for.
   *   - unqueued, because a read is not a write. Putting reads on the commit
   *     mutex would stall every pane behind an autosave and gain nothing:
   *     `state` is replaced by a single assignment AFTER the store passed its
   *     commit point, so a read sees a transaction whole or not at all.
   */

  const RESOLVE_PERSPECTIVES = new Set(['published', 'drafts'])

  function requireStringArray(value: unknown, field: string): string[] {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string' || item.length === 0)
    ) {
      throw new OverlayApiError(
        400,
        'INVALID_REQUEST',
        `resolve requires \`${field}\` to be an array of non-empty strings`,
      )
    }
    return value as string[]
  }

  function resolveRead(body: unknown): Rec {
    if (!isRec(body)) {
      throw new OverlayApiError(400, 'INVALID_REQUEST', 'resolve body must be a JSON object')
    }

    const mode = body.mode ?? 'perspective'
    if (mode !== 'perspective' && mode !== 'version') {
      throw new OverlayApiError(
        400,
        'INVALID_REQUEST',
        'resolve `mode` must be "perspective" (§18.1/§18.2) or "version" (getDocument semantics)',
      )
    }

    const requested = requireStringArray(body.ids, 'ids')
    const perspective = (body.perspective ?? 'drafts') as 'published' | 'drafts'
    if (mode === 'perspective' && !RESOLVE_PERSPECTIVES.has(perspective)) {
      throw new OverlayApiError(
        400,
        'INVALID_REQUEST',
        'resolve `perspective` must be "published" or "drafts" (§18.3 raw is not a batch read)',
      )
    }
    const types = body.types === undefined ? undefined : requireStringArray(body.types, 'types')

    /* §22.2 "add branch-created and modified candidates": a base query can never
     * return an ID base has never held, so the overlay's own documents of the
     * requested types are added here — and reported SEPARATELY, because a caller
     * merging this into a base result has to know which IDs it did not ask for. */
    const added: string[] = []
    if (types !== undefined) {
      const seen = new Set(requested.map(toPublishedId))
      for (const logicalId of overlayDocumentIds(state.documents, {types})) {
        if (seen.has(logicalId)) continue
        seen.add(logicalId)
        added.push(logicalId)
      }
    }

    const request = {
      ids: [...requested, ...added],
      now: now(),
      records: state.documents,
      base: createBaseSource(usableBaseDocuments(body.baseDocuments)),
    }

    const result =
      mode === 'version'
        ? resolveVersionBatch(request)
        : resolveDocumentBatch({...request, perspective})

    return {
      ok: true,
      overlayId,
      revision: state.revision,
      mode,
      perspective: result.perspective,
      entries: result.entries,
      documents: result.documents,
      missing: result.missing,
      addedIds: added,
      conflicts: result.conflicts,
    }
  }

  /**
   * The branch as `sanity-overlay-query` consumes it (§22.6 steps 6, 7, 13).
   *
   * `OverlaySource` is documented as a PERSPECTIVE-APPLIED view keyed by the
   * LOGICAL document ID, and that is not a formality: the query layer overlays
   * this map onto the base candidates the caller fetched, so the two must be
   * keyed the same way. A `published`/`drafts` base fetch returns `article-1`,
   * so a branch keyed by `drafts.article-1` would never win over it — the query
   * would answer with pre-branch content and no test that only checked the
   * shape would notice.
   *
   * So the perspective decides the shape: §18.1/§18.2 resolution through core's
   * batch read for `published`/`drafts`, and addressed identities (§13.9) for
   * `raw`, which is what a raw dataset read actually returns. Either way this is
   * the full §17.3 merge and not the raw local materialization — a branch edit
   * on top of a base document is only correct once the ancestor is folded in.
   *
   * A `null` resolution becomes a TOMBSTONE rather than an omission. The branch
   * holds a record for every ID here, so "resolves to nothing in this
   * perspective" is an opinion, and base must not leak through underneath it.
   */
  function overlayQuerySource(
    perspective: QueryPerspective,
    base: ReturnType<typeof createBaseSource>,
  ) {
    const documents = new Map<string, Rec & {_id: string; _type: string}>()
    const tombstones = new Set<string>()
    const logicalIds = Object.keys(state.documents).sort()

    const resolved =
      perspective === 'raw'
        ? resolveVersionBatch({
            ids: logicalIds.flatMap((logicalId) => [`drafts.${logicalId}`, logicalId]),
            now: now(),
            records: state.documents,
            base,
          })
        : resolveDocumentBatch({
            ids: logicalIds,
            perspective,
            now: now(),
            records: state.documents,
            base,
          })

    for (const entry of resolved.entries) {
      const key = perspective === 'raw' ? entry.documentId : entry.logicalId
      if (entry.document === null) {
        tombstones.add(key)
        continue
      }
      documents.set(key, {
        ...(entry.document as Rec),
        /* Addressed identity wins: `_type` is required by the query layer and a
         * materialized body could in principle omit it. */
        _id: key,
        _type:
          ((entry.document as Rec)._type as string) ??
          state.documents[entry.logicalId]?.schemaType,
      } as Rec & {_id: string; _type: string})
    }

    return {
      documents,
      tombstones,
      conflicts: new Set(resolved.conflicts.map((conflict) => conflict.documentId)),
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin')
    const headers: Record<string, string> = {vary: 'Origin'}
    if (origin !== null && (allowedOrigins.has(origin) || allowedOrigins.has('*'))) {
      headers['access-control-allow-origin'] = origin
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
      headers['access-control-allow-headers'] = 'content-type'
      headers['access-control-max-age'] = '600'
    }
    /* `access-control-allow-credentials` is deliberately NEVER emitted. This API
     * carries no ambient credential, and reflecting an origin alongside that
     * header is the standard way a local dev server becomes an exfiltration
     * endpoint for everything it serves — which here is the whole branch. Not
     * emitting it means a future widening of `origins` cannot resurrect that. */
    return headers
  }

  /* ---------------------------------------------------------------- *
   * Cross-site request forgery — PRD §5.5 security review P2-4
   * ---------------------------------------------------------------- *
   *
   * The overlay API has no authentication, by design: it is a local development
   * surface. That is only safe while a request has to COME FROM somewhere
   * trusted, and nothing enforced that. `POST` + `Content-Type: text/plain` is
   * CORS-SAFELISTED, so it fires no preflight — any page the developer happens
   * to have open could drive `/commit` and mutate the branch. A loopback bind is
   * no defence: a page in the developer's own browser is on loopback.
   *
   * Three clauses, each doing a job the others cannot:
   *
   *   1. JSON CONTENT TYPE. This alone removes the request from the safelisted
   *      set, so a cross-origin browser must preflight — and the preflight is
   *      answered by the allowlist above, which grants nothing by default. It is
   *      the clause that closes the class rather than an instance, and it is
   *      applied regardless of who is asking, or the safelisted shape stays
   *      reachable from an allowlisted origin.
   *   2. `Sec-Fetch-Site`. Browsers set it and page JS cannot forge it (it is a
   *      forbidden header name). It is what still holds when `Origin` is absent.
   *   3. THE ORIGIN ALLOWLIST, with same-origin recognised structurally rather
   *      than listed. An App Router mounting is same-origin by construction and
   *      names no origins; requiring it to list its own deployment URL would be
   *      a footgun that fails closed in production only.
   *
   * An ABSENT `Origin` is allowed. curl, the CLI and a server-side client carry
   * no ambient browser credential and are not the actor this control exists for;
   * refusing them buys nothing and breaks every non-browser caller.
   */
  const JSON_CONTENT_TYPE = 'application/json'

  function assertWriteIsNotForged(request: Request): void {
    const contentType = (request.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase()
    if (contentType !== JSON_CONTENT_TYPE) {
      throw new OverlayApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `a state-changing request must declare \`content-type: ${JSON_CONTENT_TYPE}\`, which ` +
          'is what forces a CORS preflight and closes the forged simple-request path',
      )
    }

    const forbidden = (): OverlayApiError =>
      new OverlayApiError(
        403,
        'FORBIDDEN_ORIGIN',
        'this request did not come from an origin the overlay API grants; a state-changing ' +
          'request must be same-origin or from a configured `origins` entry',
      )

    if (request.headers.get('sec-fetch-site') === 'cross-site') throw forbidden()

    const origin = request.headers.get('origin')
    if (origin === null) return
    if (allowedOrigins.has(origin) || allowedOrigins.has('*')) return
    /* A proxy that rewrites `Origin` cannot rewrite `Sec-Fetch-Site`, so an
     * explicit same-origin claim from the browser is honoured on its own. */
    if (request.headers.get('sec-fetch-site') === 'same-origin') return
    try {
      if (new URL(request.url).origin === origin) return
    } catch {
      /* An unparseable request URL cannot establish same-origin. */
    }
    throw forbidden()
  }

  function json(request: Request, status: number, payload: unknown): Response {
    return new Response(`${JSON.stringify(payload)}\n`, {
      status,
      headers: {...corsHeaders(request), 'content-type': 'application/json; charset=utf-8'},
    })
  }

  function failure(request: Request, error: unknown, label: string): Response {
    const api = error instanceof OverlayApiError ? error : null
    const code = api?.code ?? ((error as {code?: string})?.code || 'INTERNAL')
    const status = api?.status ?? ((error as {code?: string})?.code ? 400 : 500)
    const message = String((error as Error)?.message ?? error)
    /* Loud by contract: a write that reached the server and did not land is the
     * one failure mode this API must never hide. */
    log('error', `overlay ${label} failed [${code}]: ${message}`)
    return json(request, status, {ok: false, error: {code, message}})
  }

  async function readJsonBody(request: Request, label: string): Promise<unknown> {
    const declared = request.headers.get('content-length')
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      throw new OverlayApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large')
    }
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
      throw new OverlayApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large')
    }
    if (raw.length === 0) return {}
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new OverlayApiError(
        400,
        'INVALID_JSON',
        `${label} body is not valid JSON: ${String((error as Error)?.message ?? error)}`,
      )
    }
  }

  /**
   * `/api/sanity-overlay/query/plan` and `/query/plan` must name the same route,
   * because the App Router mounting carries a prefix the dev server does not.
   * Matching on the trailing segments — and ONLY on names this table knows —
   * makes the handler mount-point agnostic without accepting arbitrary paths.
   */
  const ROUTES = new Set(['health', 'state', 'events', 'resolve', 'commit', 'query'])

  function routeOf(pathname: string): string | null {
    const trimmed = pathname.replace(/\/+$/, '')
    const segments = trimmed.split('/').filter((segment) => segment.length > 0)
    const last = segments[segments.length - 1]
    if (last === undefined) return null
    if (last === 'plan' && segments[segments.length - 2] === 'query') return 'query/plan'
    return ROUTES.has(last) ? last : null
  }

  function eventStream(request: Request): Response {
    let self: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller
        subscribers.add(controller)
        /* The opening frame carries the revision the subscriber is joining at,
         * so a client that reconnects can tell whether it missed a window. */
        eventSequence += 1
        writeFrame(controller, eventSequence, 'hello', {
          ok: true,
          overlayId,
          revision: state.revision,
        })
      },
      cancel() {
        subscribers.delete(self)
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'content-type': 'text/event-stream; charset=utf-8',
        /* `no-transform` as well as `no-cache`: a compressing proxy would buffer
         * the stream and turn a live bridge into a stalled one. */
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        /* nginx's own buffering opt-out; harmless everywhere else. */
        'x-accel-buffering': 'no',
      },
    })
  }

  /* ---------------------------------------------------------------- *
   * Assets — PRD §24.3 steps 1-7, §24.7
   * ---------------------------------------------------------------- *
   *
   * The routing decisions live in `assets.ts`; what is here is the HTTP
   * envelope, the CSRF control and the ONE thing that must not be delegated:
   * an accepted upload is committed into the overlay's document set as a
   * synthetic `sanity.imageAsset` / `sanity.fileAsset` (§24.3 step 5), on the
   * SAME mutex as `/commit`, so `asset._ref` resolves through the ordinary
   * reference machinery and `assertAssetDeletable` can see who uses it.
   *
   * Bytes first, document second — the same ordering rule the store uses
   * internally. A crash between them leaves an asset whose bytes exist and
   * which nothing references; the reverse would leave a reference to nothing.
   */
  function assetsUnavailable(): OverlayApiError {
    return new OverlayApiError(
      501,
      'ASSETS_NOT_CONFIGURED',
      'this overlay API was created without an `assetStore`, so branch-local assets are not ' +
        'available here (PRD §24.3). Nothing was stored and nothing was sent to Sanity.',
    )
  }

  /** §24.3 step 5, as a transaction, so the asset is an ordinary overlay document. */
  async function commitAssetDocument(document: SanityDocument): Promise<void> {
    /* Already present — the same bytes under a second filename — so there is
     * nothing to write and nothing to announce. */
    if (state.documents[document._id] !== undefined) return

    const idempotencyKey = `asset:${document._id}`
    if ((await store.getTransaction(overlayId, {idempotencyKey})) !== null) return

    const applied = applyTransaction(state, [{type: 'create', document}], {
      transactionId: nextTransactionId(),
      idempotencyKey,
      actor: defaultActor,
      now,
    })
    const records = applied.transaction.affectedDocumentIds
      .map((logicalId) => applied.state.documents[logicalId])
      .filter((record): record is OverlayDocumentRecord => record !== undefined)

    const stored = await store.commitTransaction(overlayId, {
      idempotencyKey,
      actor: defaultActor,
      mutations: [{type: 'create', document}],
      records,
    })
    state = {...applied.state, revision: stored.manifest.revision}
  }

  async function handleAssetRequest(request: Request): Promise<Response | null> {
    const route = assetRouteOf(request)
    if (route === null) return null

    const assetStore = options.assetStore
    const basePath = assetBasePathFor(request)

    if (route.kind === 'upload') {
      if (request.method !== 'POST') {
        return json(request, 405, {
          ok: false,
          error: {code: 'METHOD_NOT_ALLOWED', message: 'the upload route accepts POST'},
        })
      }
      try {
        /* BEFORE the body is read, so a forged request costs the server nothing. */
        assertUploadIsNotForged(request, allowedOrigins)
        if (assetStore === undefined) throw assetsUnavailable()

        const declared = request.headers.get('content-length')
        if (declared !== null && Number(declared) > MAX_ASSET_BYTES) {
          throw new OverlayApiError(413, 'PAYLOAD_TOO_LARGE', 'asset body is too large')
        }
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > MAX_ASSET_BYTES) {
          throw new OverlayApiError(413, 'PAYLOAD_TOO_LARGE', 'asset body is too large')
        }

        const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim()
        /* Serialised with `/commit`: the upload ends in a transaction, and two
         * transactions racing on the manifest is the one thing the mutex exists
         * to stop. `put` is inside the critical section too, so a crash cannot
         * leave a blob the document step never got to name. */
        const result = await enqueue(async () => {
          const put = await putUploadedAsset(
            {assetStore, overlayId},
            {
              bytes,
              ...(uploadFilenameFrom(request) === undefined
                ? {}
                : {filename: uploadFilenameFrom(request)}),
              ...(contentType === '' ? {} : {contentType}),
              actor: defaultActor,
            },
          )
          await commitAssetDocument(withUrl(put.document, basePath))
          return put
        })

        emit('document.changed', {
          overlayId,
          revision: state.revision,
          documentIds: [result.record.assetDocumentId],
          origin: 'commit',
          projection: 'current',
        })
        return json(request, 200, uploadResponseBody(result, overlayId, basePath))
      } catch (error) {
        return failure(request, error, 'asset upload')
      }
    }

    /* Delivery. `GET`/`HEAD` only; the responder itself answers 405 otherwise. */
    if (assetStore === undefined) {
      return failure(request, assetsUnavailable(), 'asset delivery')
    }

    try {
      const delivered = await deliverAsset({assetStore, overlayId}, request)
      if (delivered !== null && delivered.status !== 404) {
        return new Response(delivered.body === null ? null : (delivered.body as BodyInit), {
          status: delivered.status,
          headers: {...corsHeaders(request), ...delivered.headers},
        })
      }

      /*
       * §24.1 — an asset this branch does not hold is Sanity's, and Sanity's
       * CDN is where it lives. Only the CDN-shaped routes fall through: the
       * `<mount>/assets/<id>` route is this overlay's own namespace and a miss
       * there is a genuine 404.
       */
      if (route.kind === 'cdn-fallthrough' && (request.method === 'GET' || request.method === 'HEAD')) {
        const location = cdnFallthroughLocation(request)
        if (location !== null) {
          return new Response(null, {
            status: 302,
            headers: {
              ...corsHeaders(request),
              location,
              'x-overlay-asset': 'base',
            },
          })
        }
      }

      if (delivered !== null) {
        return new Response(null, {
          status: delivered.status,
          headers: {...corsHeaders(request), ...delivered.headers},
        })
      }
      return json(request, 404, {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `${request.url} is not a branch asset this overlay can serve`,
        },
      })
    } catch (error) {
      return failure(request, error, 'asset delivery')
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = routeOf(url.pathname)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          /* The upload's custom header must survive the preflight, or the
           * control above turns into a control that blocks the only caller. */
          ...(corsHeaders(request)['access-control-allow-headers'] === undefined
            ? {}
            : {
                'access-control-allow-headers': `content-type, ${ASSET_UPLOAD_HEADER}, x-overlay-asset-filename`,
              }),
        },
      })
    }

    /* Assets are matched FIRST: `routeOf` reads only the last path segment, and
     * an asset ID is not one of its names, so `/assets/<id>` would otherwise
     * fall straight through to the 404 below. */
    const assetResponse = await handleAssetRequest(request)
    if (assetResponse !== null) return assetResponse

    if (request.method === 'GET' && route === 'health') {
      return json(request, 200, {ok: true, overlayId, revision: state.revision})
    }

    if (request.method === 'GET' && route === 'state') {
      return json(request, 200, {
        ok: true,
        overlayId,
        revision: state.revision,
        /*
         * TOP-LEVEL, and not merely a convenience over the per-document arrays.
         * An overlay with ZERO documents has no per-document field to read, so a
         * documents-only contract makes "empty branch" and "this server cannot
         * tell you" indistinguishable — the same defect one level down. Its
         * presence is the unambiguous statement that this API computes
         * conflicts; §13.1 already defines the shape.
         */
        conflictSummary: overlayConflictSummary(state),
        documents: hydrationDocuments(state),
      })
    }

    if (request.method === 'GET' && route === 'events') {
      return eventStream(request)
    }

    if (request.method === 'POST' && route === 'commit') {
      let body: unknown
      try {
        /* BEFORE the body is read, so a forged request is refused without the
         * server doing any work on its behalf. */
        assertWriteIsNotForged(request)
        body = await readJsonBody(request, 'commit')
      } catch (error) {
        return failure(request, error, 'commit')
      }
      try {
        const result = await enqueue(() => commit(body))
        /* Announced only after `enqueue` resolved — i.e. only after the store
         * passed its commit point — and before the response is produced, so a
         * subscriber can never observe the acknowledgement without the event
         * that explains it. */
        announceCommit(result)
        return json(request, 200, result)
      } catch (error) {
        return failure(request, error, 'commit')
      }
    }

    if (request.method === 'POST' && route === 'resolve') {
      let body: unknown
      try {
        body = await readJsonBody(request, 'resolve')
      } catch (error) {
        return failure(request, error, 'resolve')
      }
      try {
        return json(request, 200, resolveRead(body))
      } catch (error) {
        return failure(request, error, 'resolve')
      }
    }

    if (request.method === 'POST' && (route === 'query' || route === 'query/plan')) {
      const label = route
      let body: unknown
      try {
        body = await readJsonBody(request, label)
      } catch (error) {
        return failure(request, error, label)
      }
      try {
        if (route === 'query/plan') {
          return json(request, 200, {
            overlayId,
            revision: state.revision,
            ...planRegisteredQuery(registry, body),
          })
        }
        const baseDocuments = usableBaseDocuments((body as Rec)?.baseDocuments)
        const base = createBaseSource(baseDocuments)
        const evaluated = await evaluateRegisteredQuery(registry, body, {
          baseDocuments: baseDocuments as never,
          overlayFor: (perspective) => overlayQuerySource(perspective, base) as never,
        })
        return json(request, 200, {overlayId, revision: state.revision, ...evaluated})
      } catch (error) {
        return failure(request, error, label)
      }
    }

    return json(request, 404, {
      ok: false,
      error: {code: 'NOT_FOUND', message: `no route for ${request.method} ${url.pathname}`},
    })
  }

  return {
    overlayId,
    get revision() {
      return state.revision
    },
    handle,
    /* On the SAME mutex as `/commit`. See `watcher` above. */
    pollDirectEdits: () => enqueue(runWatchPass),
    subscriberCount: () => subscribers.size,
    async close() {
      watcher.close()

      /* End every event stream explicitly. An SSE response is a socket the
       * server itself holds open, so a `close()` that waits for connections to
       * finish would otherwise never resolve. */
      for (const controller of subscribers) {
        try {
          controller.close()
        } catch {
          /* Already gone; the Set is cleared below regardless. */
        }
      }
      subscribers.clear()

      /* Drain. Abandoning a commit already inside the store would leave
       * immutable artifacts the manifest never names — and would hand the caller
       * a green light to delete the overlay root out from under a live write.
       * `queue` never rejects (see `enqueue`), so this cannot throw. */
      await queue
    },
  }
}
