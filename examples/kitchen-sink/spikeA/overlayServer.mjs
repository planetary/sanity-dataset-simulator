// SPIKE A — the overlay persistence server (PRD §14, §36.1 Track A).
//
// WHAT THIS IS FOR
// `localEcho.ts` proves an overlay can own the Studio write path. Until now it
// echoed from an in-memory map, so a page reload threw every edit away. This
// server is the missing half: it puts the intercepted writes through the real
// `FsOverlayStore`, so the canonical `.sanity-overlay/documents/<id>/intent.json`
// exists on disk and survives both a browser reload and a server restart.
//
// SHAPE
// Four endpoints, JSON in / JSON out, CORS'd for the Studio dev origin:
//
//   GET  /health   liveness plus which overlay root is in play
//   GET  /state    full overlay state, for boot-time hydration of the echo layer
//   POST /commit   one intercepted write batch, committed as one transaction
//   POST /resolve  a batch READ — the virtual documents for a set of IDs
//
// `/resolve` is the read half. Until it existed, Studio could save into a store
// the rest of it could not see: a renamed document still listed under its old
// title, a branch-created document appeared nowhere, and reference pickers showed
// staging values. It resolves the on-disk records through core's §18.1/§18.2
// batch read and answers with virtual documents.
//
// LAYERING
// The server owns *no* semantics. Translation is `overlayTranslate.ts` (pure);
// applying a mutation is core's `applyTransaction` (pure); persistence is
// `FsOverlayStore`. This file is glue: HTTP, an overlay lifecycle, an in-memory
// projection of the persisted state, and a commit mutex.
//
// RUNNING IT
//   node --experimental-strip-types examples/kitchen-sink/spikeA/runOverlayServer.mjs
// (or `pnpm --filter kitchen-sink overlay:server`). The launcher exists because
// `sanity-overlay-core` and `sanity-overlay-store-fs` import each other with
// extensionless specifiers, which Node's ESM resolver does not accept; the
// launcher registers a `.ts` fallback resolve hook before loading this module.
import {createServer} from 'node:http'
import {isAbsolute, resolve as resolvePath} from 'node:path'
import {fileURLToPath} from 'node:url'

import {
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
} from '../../../packages/sanity-overlay-core/src/index.ts'
import {
  FsOverlayStore,
  revalidationIsNotable,
  watchOverlay,
} from '../../../packages/sanity-overlay-store-fs/src/index.ts'
import {translateDocumentActions, translateInterceptedWrite} from './overlayTranslate.ts'
import {deriveReadQuery, evaluateReadQuery} from './readQueries.ts'
import {loadExplicitEnv} from '../../explicitEnv.mjs'
import {
  DECLARED_STUDIO_IDENTITY,
  STUDIO_IDENTITY_KEYS,
  studioIdentity,
} from '../studioIdentity.mjs'

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

export const DEFAULT_PORT = 3998
/** The Studio dev server origin. Anything else is refused a CORS grant. */
export const DEFAULT_ORIGIN = 'http://localhost:3333'
/**
 * `.sanity-overlay/` is created *inside* this directory (PRD §14.1) — i.e.
 * `examples/kitchen-sink/.sanity-overlay/`.
 *
 * `fileURLToPath`, not `URL.pathname`: the latter is percent-encoded, so a
 * checkout under a path containing a space would silently create the overlay in
 * a directory literally named `…%20…`.
 */
export const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url))

const DEFAULT_ACTOR = {
  type: 'user',
  id: 'spike-a-studio',
  displayName: 'Studio (spike A local echo)',
}

const JSON_HEADERS = {'content-type': 'application/json; charset=utf-8'}
/** Studio autosaves on every keystroke burst; a runaway body is a bug, not content. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Direct-edit poll period for the `/events` bridge (ms).
 *
 * `0` turns the watcher off entirely, leaving `/events` a commit-only bridge.
 * The interval is a latency knob and nothing else: every §14.4 behaviour lives
 * in `FsOverlayStore.revalidate`, which the watcher only triggers.
 */
const DEFAULT_WATCH_INTERVAL_MS = 250

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeActor(value) {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  const type = ['user', 'agent', 'service'].includes(value.type) ? value.type : 'user'
  const actor = {type, id: value.id}
  if (typeof value.displayName === 'string') actor.displayName = value.displayName
  return actor
}

/**
 * Base documents usable as a merge ancestor (PRD §13.3, §13.4).
 *
 * A document with no `_rev` cannot anchor an ancestor, and a document carrying a
 * *synthetic* overlay `_rev` (PRD §13.9) is something this overlay already
 * produced — treating it as base would make the overlay its own ancestor. Both
 * are dropped rather than repaired.
 */
function usableBaseDocuments(value) {
  if (!Array.isArray(value)) return []
  return value.filter(
    (document) =>
      isRecord(document) &&
      typeof document._id === 'string' &&
      typeof document._type === 'string' &&
      typeof document._rev === 'string' &&
      document._rev.length > 0 &&
      !isSyntheticRev(document._rev),
  )
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------------ *
 * Overlay lifecycle
 * ------------------------------------------------------------------ */

/**
 * Open the overlay at `root`, creating it if absent, and rebuild the in-memory
 * projection the mutation engine works on.
 *
 * The projection is derived entirely from what is on disk, which is what makes a
 * restart transparent: the server holds no state that the store does not.
 */
async function openOverlay(store, {overlayId, base, source, actor}) {
  let manifest = null
  try {
    manifest = await store.inspect()
  } catch (error) {
    if (error?.code !== 'OVERLAY_NOT_FOUND') throw error
  }

  if (manifest === null) {
    manifest = await store.createOverlay({overlayId, base, source, actor, ifNotExists: true})
  }

  const state = await hydrateState(store, manifest)
  return {manifest, state}
}

async function hydrateState(store, manifest) {
  const documents = {}
  const heads = await store.listChangedDocuments(manifest.overlayId, {includeUnchanged: true})
  for (const head of heads) {
    const read = await store.readDocumentByLogicalId(manifest.overlayId, head.logicalId)
    /* `record === null` means the immutable revision was pruned but the review
     * surface survives (a fresh clone with no `.runtime/`). Rebuilding a record
     * from intent + snapshot needs the three-way merge engine, so the document is
     * simply not replayable in this spike — reported, not faked. */
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
 * materialized draft and published documents exactly as Studio addresses them
 * (PRD §13.9 `_id` rule). A tombstoned perspective is `null`, which is how the
 * echo layer learns to hide a locally deleted document.
 *
 * `conflicts` is ALWAYS present, and `[]` means clean. The absence of the key is
 * a different fact — "this server cannot tell you" — and §28.1 forbids
 * collapsing the two. While this projection omitted it, the Studio's conflict
 * action was permanently disabled with "Conflict state unknown" and nothing said
 * why: core detected, persisted and counted the conflicts, and the one surface
 * the UI reads never carried them.
 *
 * Nothing is recomputed. §17.11 makes the COMMIT the detection point, so
 * `record.conflicts` is already the answer; `hydrateState` reads it back from
 * disk at boot. Re-detecting here is not merely expensive, it is impossible —
 * core never fetches base (§16.1) and `/state` is handed no base documents — so
 * the persisted set is the only honest answer, and reading it is free.
 *
 * This projection must stay byte-equivalent to `sanity-overlay-next`'s
 * `hydrationDocuments`. Two servers with divergent `/state` shapes is how this
 * class of gap recurs; the Studio cannot tell which one it is talking to.
 */
function hydrationDocuments(state) {
  return Object.keys(state.documents)
    .sort()
    .map((logicalId) => {
      const record = state.documents[logicalId]
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
        draft: record.local.draftTombstone ? null : (record.local.draft?.materialized ?? null),
        published: record.local.publishedTombstone
          ? null
          : (record.local.published?.materialized ?? null),
        conflicts: record.conflicts,
        origin: record.origin,
        baseStatus: base?.baseStatus ?? null,
        /* §5.5: omitted rather than filled in. A branch-created document has no
         * merge ancestor, and a plausible placeholder in a reviewer-facing
         * column is exactly the filler that section rules out. */
        ...(capturedRevision === undefined ? {} : {baseRevisionAtFirstTouch: capturedRevision}),
        ...(observedRevision === undefined ? {} : {currentBaseRevision: observedRevision}),
      }
    })
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

export async function startOverlayServer(options = {}) {
  const rootInput =
    options.root ?? process.env.SPIKE_OVERLAY_ROOT ?? DEFAULT_ROOT
  const root = isAbsolute(rootInput) ? rootInput : resolvePath(process.cwd(), rootInput)
  const port = options.port ?? Number(process.env.SPIKE_OVERLAY_PORT ?? DEFAULT_PORT)
  const host = options.host ?? '127.0.0.1'
  const allowedOrigins = new Set(
    options.origins ?? [process.env.SPIKE_OVERLAY_ORIGIN ?? DEFAULT_ORIGIN],
  )
  const now = options.now ?? (() => new Date().toISOString())
  const defaultActor = normalizeActor(options.actor) ?? DEFAULT_ACTOR
  const log = options.log ?? (() => {})

  /* `hooks` is the store's own fault-injection surface (`beforeRename`). It is
   * threaded through so a test can hold a commit open inside the store and prove
   * that neither the HTTP response nor `close()` runs ahead of the disk write. */
  /* `base` is stamped into `.sanity-overlay/manifest.json`, which is a COMMITTED
   * artefact: it is how a branch overlay records which dataset it is a branch
   * of. So the identity behind it is read from the declared source and an
   * ambient value that disagrees is refused — a shell must not be able to put a
   * foreign project id into this repository's history. Everything else below
   * (`SPIKE_OVERLAY_*`) selects behaviour on this machine and is read ambiently
   * on purpose. */
  const declared = studioIdentity(
    loadExplicitEnv({
      dirs: [DEFAULT_ROOT],
      keys: STUDIO_IDENTITY_KEYS,
      defaults: DECLARED_STUDIO_IDENTITY,
      who: 'spike-a overlay server',
    }),
  )

  const store = new FsOverlayStore({root, now, hooks: options.hooks})
  const opened = await openOverlay(store, {
    overlayId: options.overlayId ?? process.env.SPIKE_OVERLAY_ID ?? 'spike-a-local-echo',
    base: options.base ?? {
      projectId: declared.projectId,
      dataset: declared.dataset,
      apiVersion: '2025-02-19',
    },
    source: options.source ?? {
      repositoryId: 'github:planetary/sanity-branch-overlay',
      branch: process.env.SPIKE_OVERLAY_BRANCH ?? 'spike/a-local-echo',
    },
    actor: defaultActor,
  })

  const overlayId = opened.manifest.overlayId
  let state = opened.state
  /* Studio fires autosaves faster than a commit round-trip; the manifest is the
   * commit point, so two overlapping commits would race on its revision. One
   * promise chain makes the whole pipeline serial. */
  let queue = Promise.resolve()
  let sequence = 0

  function enqueue(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /* ---------------------------------------------------------------- *
   * The event bridge — PRD §14.4 steps 8-10, §37 Phase 2
   * ---------------------------------------------------------------- *
   *
   * §14.4 step 8 emits `document.changed` and step 9 has Studio and preview
   * refetch. Both halves of the change surface already existed and neither said
   * anything: commits landed durably, and `watchOverlay` ran the direct-edit
   * workflow on a poll. This is the announcement.
   *
   * DURABILITY PRECEDES NOTIFICATION. Every `emit` below runs after the store has
   * passed its commit point, never before. An event is an instruction to refetch,
   * so an early one makes a subscriber read the PREVIOUS state and cache it as
   * current — the same defect, with a longer fuse, as answering an HTTP request
   * before the write finished.
   *
   * FRAMES ARE ENCODED, NOT INTERPOLATED. SSE terminates a field at a newline and
   * a frame at a blank line, so a document title containing `\n\n` would forge a
   * second event if the payload were pasted into the frame. `JSON.stringify`
   * escapes every newline, which is the whole reason the payload goes through it.
   */

  /** Open `text/event-stream` responses. A Set, so a double `close` is harmless. */
  const subscribers = new Set()
  let eventSequence = 0

  function writeFrame(response, id, event, data) {
    response.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /** Broadcast one frame to every live subscriber. Returns its sequence number. */
  function emit(event, data) {
    eventSequence += 1
    for (const subscriber of subscribers) {
      try {
        writeFrame(subscriber, eventSequence, event, data)
      } catch (error) {
        /* A subscriber that vanished between the close event and this write is
         * not a server fault, and must not stop the other subscribers. */
        subscribers.delete(subscriber)
        log('error', `overlay events: dropped a subscriber mid-write: ${error?.message ?? error}`)
      }
    }
    return eventSequence
  }

  /**
   * Announce a committed transaction.
   *
   * `projection: 'current'` because a commit updates the in-memory projection in
   * the same step that made it durable, so `/state` and `/resolve` are already
   * consistent with the event by the time it is written.
   */
  function announceCommit(result) {
    if (result?.committed !== true) return
    const documentIds = Array.isArray(result.affectedDocumentIds)
      ? [...result.affectedDocumentIds].sort()
      : []
    if (documentIds.length === 0) return
    emit('document.changed', {
      overlayId,
      revision: result.revision,
      /* A LIST, never a joined string: two documents must stay two elements, or
       * the payload becomes indistinguishable from one document whose ID
       * contained the separator. */
      documentIds,
      origin: 'commit',
      projection: 'current',
      transactionId: result.transactionId,
    })
  }

  /* ---------------------------------------------------------------- *
   * Direct edits (PRD §14.3, §14.4 steps 2-4, 7, 10)
   * ---------------------------------------------------------------- */

  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  /* `intervalMs: 0` deliberately disables the watcher's OWN timer. Its `poll()`
   * calls `store.revalidate`, which repairs stale checksums by rewriting
   * `intent.json` — a write, and therefore something that must not run beside a
   * commit. The timer below puts every pass on the same `enqueue` mutex the
   * commit path uses, so the two can never interleave their writes. */
  const watcher = watchOverlay(store, overlayId, {intervalMs: 0})
  let watchTimer = null

  /**
   * The fingerprint of the last announced `overlay.invalid` set.
   *
   * A broken file stays broken, so every pass re-reports it. Without this, one
   * bad file becomes an unbounded event stream that buries every real change.
   * The fingerprint is a JSON array of arrays — structurally unambiguous — and
   * NOT a separator-joined string, which would let two different findings
   * fingerprint identically.
   */
  let lastInvalidFingerprint = '[]'

  function invalidFingerprint(invalid) {
    return JSON.stringify(invalid.map((failure) => [failure.ref, failure.code, failure.message]))
  }

  async function runWatchPass() {
    const report = await watcher.poll()
    if (!revalidationIsNotable(report)) return

    /* The manifest is the revision authority; the projection only mirrors it. */
    if (report.manifestChanged) {
      const manifest = await store.inspect()
      state = {...state, revision: manifest.revision}
    }

    const changed = [...new Set([...report.changed, ...report.repairedChecksums])]
    if (report.changed.length > 0) {
      emit('document.changed', {
        overlayId,
        revision: state.revision,
        documentIds: [...report.changed].sort(),
        origin: 'direct-edit',
        /**
         * `/state` and `/resolve` are built from the IMMUTABLE record named by
         * the manifest head. A direct edit rewrites `intent.json` and touches
         * neither, and replaying intent + base snapshot back into a record needs
         * core's three-way merge engine, which exports no such entry point today
         * (see `hydrateState`). So the staleness is declared on the wire rather
         * than hidden: a consumer reading the canonical files — the CLI, a
         * preview build — is fully served, and a consumer reading `/state` is
         * told not to trust it.
         */
        projection: 'stale',
      })
    } else if (changed.length > 0 && report.repairedChecksums.length > 0) {
      /* A checksum repair changes bytes without changing meaning (§14.3), so it
       * is reported as its own thing rather than as a content change. */
      emit('overlay.repaired', {
        overlayId,
        revision: state.revision,
        refs: [...report.repairedChecksums].sort(),
      })
    }

    const fingerprint = invalidFingerprint(report.invalid)
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

  async function commit(body) {
    if (!isRecord(body)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'commit body must be a JSON object')
    }
    const {idempotencyKey, kind, payload} = body
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'commit requires a non-empty `idempotencyKey` (PRD §13.10, §34.6)',
      )
    }
    if (kind !== 'actions' && kind !== 'mutations' && kind !== 'documentActions') {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'commit requires kind "actions", "mutations" or "documentActions"',
      )
    }

    if (kind === 'documentActions') return commitDocumentActions(body)

    /* §34.6 — the *store* is the durable deduplication authority. Checking core's
     * in-memory ledger alone would re-apply every key after a restart, because
     * the ledger is not rehydrated from disk. */
    const replayed = await store.getTransaction(overlayId, {idempotencyKey})
    if (replayed !== null) {
      return {
        ok: true,
        committed: false,
        replayed: true,
        overlayId,
        revision: state.revision,
        transactionId: replayed.transactionId,
        unsupported: [],
        documents: hydrationDocuments(state),
      }
    }

    const translated = translateInterceptedWrite({kind, payload})
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
    sequence += 1
    const applied = applyTransaction(state, translated.mutations, {
      transactionId: `spike-a-${String(sequence).padStart(6, '0')}`,
      idempotencyKey,
      actor,
      now,
      base: createBaseSource(usableBaseDocuments(body.baseDocuments)),
    })

    const records = applied.transaction.affectedDocumentIds
      .map((logicalId) => applied.state.documents[logicalId])
      .filter((record) => record !== undefined)

    /* AWAITED, deliberately. The HTTP response is the browser's only signal that
     * an edit is durable, so it must not be sent before the store has finished
     * writing. A detached (`void`) commit here also escapes every `try` in this
     * file and surfaces as an unhandled rejection. */
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

  /* ---------------------------------------------------------------- *
   * Document actions (PRD §18.4-§18.9)
   * ---------------------------------------------------------------- *
   *
   * Studio's publish / unpublish / delete / discard / duplicate / restore are
   * not mutations, so they cannot go through `applyTransaction`. They dispatch
   * to core's §18 reducers instead — this file names the reducer and supplies the
   * transaction envelope, and owns none of the semantics.
   *
   * Each reducer call is its own transaction, because §34.5 pins one revision
   * increment per transaction and core exposes no way to fold two reducers into
   * one. Per-step idempotency keys are derived from the request's key, so a
   * retried request replays every step it already ran (§34.6) rather than
   * applying half of it twice.
   */

  const REDUCERS = {
    publish,
    unpublish,
    discardDraft,
    delete: deleteDocument,
    duplicate,
    restore,
  }

  async function commitDocumentActions(body) {
    const {idempotencyKey, payload} = body
    const translated = translateDocumentActions(payload)
    if (translated.unsupported.length > 0) {
      log('warn', `overlay document actions ${idempotencyKey}: ${translated.unsupported.join('; ')}`)
    }

    const stepKey = (index) => `${idempotencyKey}#${index}`

    /* The first step's key stands for the whole request: if it is on disk the
     * request already ran, so nothing is re-applied. */
    const replayed = await store.getTransaction(overlayId, {idempotencyKey: stepKey(0)})
    if (replayed !== null) {
      return {
        ok: true,
        committed: false,
        replayed: true,
        overlayId,
        revision: state.revision,
        transactionId: replayed.transactionId,
        unsupported: translated.unsupported,
        documents: hydrationDocuments(state),
      }
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
    const affectedDocumentIds = []
    let committed = 0
    let lastTransactionId

    /** Run one core call and push its result through the store. */
    const runStep = async (index, apply) => {
      sequence += 1
      const applied = apply({
        transactionId: `spike-a-${String(sequence).padStart(6, '0')}`,
        idempotencyKey: stepKey(index),
        actor,
        now,
        base,
      })

      const records = applied.transaction.affectedDocumentIds
        .map((logicalId) => applied.state.documents[logicalId])
        .filter((record) => record !== undefined)

      /* AWAITED for the same reason the mutation path awaits: the HTTP response
       * is the browser's only durability signal. */
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
          await runStep(index, (options) =>
            restore(state, {id: step.id, target: step.target}, options),
          )
          index += 1
        }

        /* The restored body itself is an ordinary full replacement. */
        if (step.document !== undefined) {
          await runStep(index, (options) =>
            applyTransaction(state, [{type: 'createOrReplace', document: step.document}], options),
          )
          index += 1
        }
        continue
      }

      const reducer = REDUCERS[step.type]
      /* istanbul ignore next -- translateDocumentActions cannot emit another type */
      if (reducer === undefined) {
        throw new HttpError(400, 'INVALID_REQUEST', `unknown document action ${step.type}`)
      }
      const input =
        step.type === 'duplicate' ? {id: step.id, newId: step.newId} : {id: step.id}
      await runStep(index, (options) => reducer(state, input, options))
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
   * Reads (PRD §18.1, §18.2, §22.2)
   * ---------------------------------------------------------------- *
   *
   * `POST /resolve` answers "what do these IDs look like in the branch?".
   *
   * The caller supplies the base documents it already holds, because core never
   * fetches base (§16.1) and this server has no Sanity credentials of its own —
   * the browser has just read them, so it ships them along. Anything the caller
   * omits is simply absent base, which is exactly right for a branch-created
   * document.
   *
   * SYNCHRONOUS AND UNQUEUED, both deliberately:
   *
   *   - synchronous, because the resolution is a pure function of the in-memory
   *     projection. Nothing is started here that could outlive the request — the
   *     bug class `/commit` was fixed for.
   *   - unqueued, because a read is not a write. Putting it on the commit mutex
   *     would stall every pane behind an autosave, and it would gain nothing:
   *     `state` is replaced by a single assignment *after* the store has passed
   *     its commit point, so a read either sees a transaction whole or not at
   *     all.
   */

  const RESOLVE_PERSPECTIVES = new Set(['published', 'drafts'])

  function requireStringArray(value, field) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        `resolve requires \`${field}\` to be an array of non-empty strings`,
      )
    }
    return value
  }

  function resolveRead(body) {
    if (!isRecord(body)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'resolve body must be a JSON object')
    }

    const mode = body.mode ?? 'perspective'
    if (mode !== 'perspective' && mode !== 'version') {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'resolve `mode` must be "perspective" (§18.1/§18.2) or "version" (getDocument semantics)',
      )
    }

    const requested = requireStringArray(body.ids, 'ids')
    const perspective = body.perspective ?? 'drafts'
    if (mode === 'perspective' && !RESOLVE_PERSPECTIVES.has(perspective)) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        'resolve `perspective` must be "published" or "drafts" (§18.3 raw is not a batch read)',
      )
    }
    const types = body.types === undefined ? undefined : requireStringArray(body.types, 'types')

    /* §22.2 "add branch-created and modified candidates": a base query can never
     * return an ID base has never held, so the overlay's own documents of the
     * requested types are added to the set here. Reported separately, because a
     * caller that merges this into a base result has to know which IDs it did
     * not ask for. */
    const added = []
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
      /* Same filter the write path uses: a base document with no `_rev`, or one
       * carrying a synthetic overlay `_rev` (§13.9), cannot be a merge ancestor.
       * Accepting an echoed-back overlay document as base would make the overlay
       * its own ancestor. */
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

  /* ---------------------------------------------------------------- *
   * GROQ reads (PRD §22)
   * ---------------------------------------------------------------- *
   *
   * `POST /query/plan` answers "what must be fetched from base to answer this
   * query exactly, if it can be answered exactly at all?".
   * `POST /query`      answers the query itself, given those documents.
   *
   * WHY THE WORK IS SPLIT ACROSS TWO PARTIES
   * Only the browser holds a Sanity credential, so only the browser can fetch
   * base candidates. Only this process holds the overlay, and — decisively —
   * only this process should decide *how many* candidates a query may
   * materialise: `sanity-overlay-query` enforces §22.9
   * `CANDIDATE_LIMIT_EXCEEDED` inside `evaluateOverlayQuery`, and a limit
   * enforced in a browser tab is a limit a reload can lose. So the plan is
   * derived here, the fetch happens there, and the evaluation happens back here.
   *
   * The plan is re-derived on `/query` rather than trusted from the request: a
   * caller that under-fetches gets a smaller candidate set, but it can never
   * talk this endpoint into evaluating a plan the deriver would have refused.
   *
   * Like `/resolve`, this is unqueued — a read is not a write — and every
   * candidate resolution is synchronous against the in-memory projection.
   */

  /**
   * The branch as `sanity-overlay-query` consumes it (§22.6 steps 6, 7, 13),
   * keyed by the ID Studio addresses a document by (PRD §13.9): `drafts.x` and
   * `x` are separate addresses, exactly as they are in a raw dataset read.
   *
   * `documents` holds only versions the branch actually owns, so the overlay
   * never claims a document it has no opinion about; `tombstones` is the ONLY
   * place suppression is decided, so removing it is falsifiable by a test rather
   * than silently compensated for somewhere else.
   */
  function overlayQuerySource(base) {
    const documents = new Map()
    const tombstones = new Set()
    const addresses = []

    for (const logicalId of Object.keys(state.documents).sort()) {
      const record = state.documents[logicalId]
      if (record.local.draftTombstone) tombstones.add(`drafts.${logicalId}`)
      else if (record.local.draft) addresses.push(`drafts.${logicalId}`)
      else if (record.local.published && !record.local.publishedTombstone) {
        /* §18.2 R5 (2026-08-11): a branch publish leaves {published, draft:
         * null} — the draft address is SUPERSEDED, not unowned. Leaving it out
         * entirely lets a caller's raw-addressed base draft answer for it. */
        tombstones.add(`drafts.${logicalId}`)
      }
      if (record.local.publishedTombstone) tombstones.add(logicalId)
      else if (record.local.published) addresses.push(logicalId)
    }

    /* The full §17.3 merge, not the raw local materialization: a branch edit on
     * top of a base document is only correct once the ancestor is folded in. */
    const resolved = resolveVersionBatch({
      ids: addresses,
      now: now(),
      records: state.documents,
      base,
    })

    for (const entry of resolved.entries) {
      if (entry.document === null) continue
      documents.set(entry.documentId, {
        ...entry.document,
        /* Addressed identity wins: a `_type` is required by the query layer and
         * a materialized body could in principle omit it. */
        _id: entry.documentId,
        _type: entry.document._type ?? state.documents[entry.logicalId]?.schemaType,
      })
    }

    return {
      documents,
      tombstones,
      conflicts: new Set(resolved.conflicts.map((conflict) => conflict.documentId)),
    }
  }

  /** Shared front half of both query routes: validate, then derive. */
  function deriveFromBody(body, label) {
    if (!isRecord(body)) {
      throw new HttpError(400, 'INVALID_REQUEST', `${label} body must be a JSON object`)
    }
    const {query} = body
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HttpError(400, 'INVALID_REQUEST', `${label} requires a non-empty \`query\` string`)
    }
    const params = isRecord(body.params) ? body.params : {}
    return {query, params, derivation: deriveReadQuery(query, params)}
  }

  function planQuery(body) {
    const {derivation} = deriveFromBody(body, 'query/plan')

    /* An unsupported query is DATA, not an HTTP failure. §22.5 requires the
     * caller to log it, and a 4xx would be indistinguishable from "the overlay
     * is down" — which is the one distinction the read policy rests on. */
    if (!derivation.supported) {
      return {ok: true, overlayId, revision: state.revision, supported: false, reason: derivation.reason}
    }

    const {definition, baseRequests} = derivation.plan
    return {
      ok: true,
      overlayId,
      revision: state.revision,
      supported: true,
      queryId: definition.id,
      queryChecksum: definition.queryChecksum,
      candidatePlan: definition.candidatePlan,
      maxCandidates: definition.maxCandidates,
      /* §22.5 wants the caller able to record what it is trusting. A plan can
       * carry a boundary that is exact-by-product-decision rather than
       * exact-by-proof — today, the release-version namespace a
       * `sanity::versionOf` set deliberately excludes (PRD §32) — and the caller
       * is the party about to believe the answer, so it is told. */
      ...(definition.notes === undefined ? {} : {notes: definition.notes}),
      baseRequests,
    }
  }

  async function runQuery(body) {
    const {params, derivation} = deriveFromBody(body, 'query')

    /* §22.2: what cannot be evaluated exactly fails structurally. The §22.5
     * passthrough licence belongs to the caller — it holds the credential and
     * can ask staging itself — and is not this endpoint's to grant. */
    if (!derivation.supported) {
      throw new HttpError(400, 'UNSUPPORTED_QUERY', derivation.reason)
    }

    /* Same filter the write path applies: a document with no `_rev`, or one
     * carrying a synthetic overlay `_rev` (§13.9), is not base. Accepting an
     * echoed-back overlay document here would let the overlay be its own
     * ancestor AND let the browser smuggle branch content in as staging. */
    const baseDocuments = usableBaseDocuments(body.baseDocuments)
    const overlay = overlayQuerySource(createBaseSource(baseDocuments))

    const evaluated = await evaluateReadQuery({
      plan: derivation.plan,
      params,
      baseDocuments,
      overlay,
      ...(body.perspective === undefined ? {} : {perspective: body.perspective}),
    })

    return {
      ok: true,
      overlayId,
      revision: state.revision,
      queryId: derivation.plan.definition.id,
      result: evaluated.result,
      diagnostics: evaluated.diagnostics,
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  function corsHeaders(request) {
    const origin = request.headers.origin
    const headers = {vary: 'Origin'}
    if (typeof origin === 'string' && (allowedOrigins.has(origin) || allowedOrigins.has('*'))) {
      headers['access-control-allow-origin'] = origin
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
      headers['access-control-allow-headers'] = 'content-type'
      headers['access-control-max-age'] = '600'
    }
    /* `access-control-allow-credentials` is deliberately never emitted: this
     * server carries no ambient credential, and reflecting an origin alongside
     * that header is how a local dev server becomes an exfiltration endpoint for
     * everything it serves — here, the whole branch. */
    return headers
  }

  /**
   * Refuse a forged cross-site write (PRD §5.5 security review P2-4).
   *
   * `POST` + `Content-Type: text/plain` is CORS-SAFELISTED, so it fires no
   * preflight and any page the developer has open could drive `/commit`. A
   * loopback bind is no defence — a page in the developer's own browser is on
   * loopback. Requiring a JSON content type takes the request out of the
   * safelisted set, which is what forces the preflight the allowlist above then
   * answers; `Sec-Fetch-Site` covers the case where `Origin` is absent; and the
   * origin check treats same-origin structurally rather than by listing it.
   *
   * An absent `Origin` stays allowed: curl and the CLI carry no ambient browser
   * credential and are not the actor this exists for.
   *
   * The policy is stated once, at `sanity-overlay-next`'s `assertWriteIsNotForged`.
   * This is the same policy; the two servers must not diverge.
   */
  function assertWriteIsNotForged(request) {
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (contentType !== 'application/json') {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'a state-changing request must declare `content-type: application/json`, which is what ' +
          'forces a CORS preflight and closes the forged simple-request path',
      )
    }

    const site = request.headers['sec-fetch-site']
    const forbidden = () =>
      new HttpError(
        403,
        'FORBIDDEN_ORIGIN',
        'this request did not come from an origin the overlay server grants; a state-changing ' +
          'request must be same-origin or from a configured origin',
      )

    if (site === 'cross-site') throw forbidden()

    const origin = request.headers.origin
    if (typeof origin !== 'string' || origin === '') return
    if (allowedOrigins.has(origin) || allowedOrigins.has('*')) return
    if (site === 'same-origin') return
    try {
      const self = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (self.origin === origin) return
    } catch {
      /* An unparseable request line cannot establish same-origin. */
    }
    throw forbidden()
  }

  function send(request, response, status, payload) {
    const body = payload === undefined ? '' : `${JSON.stringify(payload)}\n`
    response.writeHead(status, {
      ...corsHeaders(request),
      ...(payload === undefined ? {} : JSON_HEADERS),
    })
    response.end(body)
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      log('error', `overlay server crashed handling ${request.method} ${request.url}: ${error}`)
      try {
        send(request, response, 500, {
          ok: false,
          error: {code: 'INTERNAL', message: String(error?.message ?? error)},
        })
      } catch {
        response.destroy()
      }
    })
  })

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const route = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      send(request, response, 204, undefined)
      return
    }

    if (request.method === 'GET' && route === '/health') {
      send(request, response, 200, {ok: true, overlayId, root, revision: state.revision})
      return
    }

    if (request.method === 'GET' && route === '/events') {
      response.writeHead(200, {
        ...corsHeaders(request),
        'content-type': 'text/event-stream; charset=utf-8',
        /* `no-transform` as well as `no-cache`: a compressing proxy would buffer
         * the stream and turn a live bridge into a stalled one. */
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        /* nginx's own buffering opt-out; harmless everywhere else. */
        'x-accel-buffering': 'no',
      })
      /* Without this, Nagle holds a small frame back until the next one arrives —
       * so the last edit before a pause is the one that never gets announced. */
      request.socket?.setNoDelay?.(true)

      subscribers.add(response)
      const drop = () => subscribers.delete(response)
      request.on('close', drop)
      request.on('error', drop)
      response.on('close', drop)
      response.on('error', drop)

      /* The opening frame carries the revision the subscriber is joining at, so a
       * client that reconnects can tell whether it missed a window. */
      eventSequence += 1
      writeFrame(response, eventSequence, 'hello', {
        ok: true,
        overlayId,
        root,
        revision: state.revision,
        watching: watchTimer !== null,
      })
      return
    }

    if (request.method === 'GET' && route === '/state') {
      send(request, response, 200, {
        ok: true,
        overlayId,
        root,
        revision: state.revision,
        /* Top-level, because an overlay with ZERO documents has no per-document
         * field to read: without this, "empty branch" and "cannot tell you" are
         * indistinguishable. §13.1 already fixes the shape. */
        conflictSummary: overlayConflictSummary(state),
        documents: hydrationDocuments(state),
      })
      return
    }

    /** Parse a JSON request body, or answer 400 and return `undefined`. */
    async function jsonBody(label) {
      try {
        const raw = await readBody(request)
        return raw.length === 0 ? {} : JSON.parse(raw)
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(
                400,
                'INVALID_JSON',
                `${label} body is not valid JSON: ${error?.message ?? error}`,
              )
        log('error', `overlay ${label} rejected [${failure.code}]: ${failure.message}`)
        send(request, response, failure.status, {
          ok: false,
          error: {code: failure.code, message: failure.message},
        })
        return undefined
      }
    }

    if (request.method === 'POST' && route === '/resolve') {
      const body = await jsonBody('resolve')
      if (body === undefined) return

      try {
        /* Not enqueued: see `resolveRead`. Synchronous, so nothing this request
         * starts can outlive it. */
        send(request, response, 200, resolveRead(body))
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error?.code ? 400 : 500
        const code = error?.code ?? 'INTERNAL'
        log('error', `overlay resolve failed [${code}]: ${error?.message ?? error}`)
        send(request, response, status, {
          ok: false,
          error: {code, message: String(error?.message ?? error)},
        })
      }
      return
    }

    /* The two GROQ read routes. Unqueued, like `/resolve`: a read is not a
     * write, and `state` is replaced by a single assignment after the store has
     * passed its commit point, so a read sees a transaction whole or not at all. */
    if (request.method === 'POST' && (route === '/query' || route === '/query/plan')) {
      const label = route.slice(1)
      const body = await jsonBody(label)
      if (body === undefined) return

      try {
        const payload = route === '/query' ? await runQuery(body) : planQuery(body)
        send(request, response, 200, payload)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error?.code ? 400 : 500
        const code = error?.code ?? 'INTERNAL'
        log('error', `overlay ${label} failed [${code}]: ${error?.message ?? error}`)
        send(request, response, status, {
          ok: false,
          error: {code, message: String(error?.message ?? error)},
        })
      }
      return
    }

    if (request.method === 'POST' && route === '/commit') {
      /* BEFORE the body is read, so a forged request is refused without the
       * server doing any work on its behalf. */
      try {
        assertWriteIsNotForged(request)
      } catch (error) {
        request.resume()
        log('error', `overlay commit refused [${error.code}]: ${error.message}`)
        send(request, response, error.status, {
          ok: false,
          error: {code: error.code, message: error.message},
        })
        return
      }

      const body = await jsonBody('commit')
      if (body === undefined) return

      try {
        const result = await enqueue(() => commit(body))
        /* Announced BEFORE the response is sent, and only after `enqueue`
         * resolved — i.e. only after the store passed its commit point. Emitting
         * first also means a subscriber can never observe the acknowledgement
         * without the event that explains it. */
        announceCommit(result)
        send(request, response, 200, result)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : error?.code ? 400 : 500
        const code = error?.code ?? 'INTERNAL'
        /* Loud by contract: a write that reached the server and did not land is
         * the one failure mode this spike must never hide. */
        log('error', `overlay commit failed [${code}]: ${error?.message ?? error}`)
        send(request, response, status, {
          ok: false,
          error: {code, message: String(error?.message ?? error)},
        })
      }
      return
    }

    send(request, response, 404, {
      ok: false,
      error: {code: 'NOT_FOUND', message: `no route for ${request.method} ${route}`},
    })
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  /* Started only once the socket is bound, so a failed listen leaves no timer
   * behind polling a store nobody can reach. */
  if (watchIntervalMs > 0) {
    watchTimer = setInterval(() => {
      if (watcher.closed) return
      void enqueue(runWatchPass).catch((error) => {
        log('error', `overlay watch pass failed: ${error?.message ?? error}`)
      })
    }, watchIntervalMs)
    /* Never hold the process (or the test runner) open. */
    watchTimer.unref?.()
  }

  const boundPort = server.address().port

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    host,
    root,
    overlayId,
    store,
    get revision() {
      return state.revision
    },
    async close() {
      /* Stop scheduling before anything else, so no pass is queued behind the
       * drain below and nothing polls a root the caller is about to delete. */
      if (watchTimer !== null) {
        clearInterval(watchTimer)
        watchTimer = null
      }
      watcher.close()

      /* End every event stream explicitly. An SSE response is a socket the
       * server itself is holding open, so `server.close()` — which waits for
       * connections to finish — would otherwise never resolve. Ending is also
       * kinder than `closeAllConnections()`: the subscriber sees a clean end of
       * stream instead of a truncated read it has to distinguish from a crash. */
      for (const subscriber of subscribers) {
        try {
          subscriber.end()
        } catch {
          /* Already gone; the Set is cleared below regardless. */
        }
      }
      subscribers.clear()

      await new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
      /* Stop listening first, then drain. Closing the socket does not cancel a
       * commit already inside the store, and abandoning one half-written would
       * leave immutable artifacts the manifest never names — plus it hands the
       * caller a green light to delete the overlay root out from under a live
       * write. `queue` never rejects (see `enqueue`), so this cannot throw. */
      await queue
    },
  }
}
