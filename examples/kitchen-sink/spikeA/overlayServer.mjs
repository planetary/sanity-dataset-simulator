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
  isSyntheticRev,
  overlayDocumentIds,
  publish,
  resolveDocumentBatch,
  resolveVersionBatch,
  restore,
  toPublishedId,
  unpublish,
} from '../../../packages/sanity-overlay-core/src/index.ts'
import {FsOverlayStore} from '../../../packages/sanity-overlay-store-fs/src/index.ts'
import {translateDocumentActions, translateInterceptedWrite} from './overlayTranslate.ts'
import {deriveReadQuery, evaluateReadQuery} from './readQueries.ts'

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
 */
function hydrationDocuments(state) {
  return Object.keys(state.documents)
    .sort()
    .map((logicalId) => {
      const record = state.documents[logicalId]
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
  const store = new FsOverlayStore({root, now, hooks: options.hooks})
  const opened = await openOverlay(store, {
    overlayId: options.overlayId ?? process.env.SPIKE_OVERLAY_ID ?? 'spike-a-local-echo',
    base: options.base ?? {
      projectId: process.env.SANITY_STUDIO_PROJECT_ID ?? 'b1n03q3z',
      dataset: process.env.SANITY_STUDIO_DATASET ?? 'parity',
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
        const record = state.documents[toPublishedId(step.id)]
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
    return headers
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

    if (request.method === 'GET' && route === '/state') {
      send(request, response, 200, {
        ok: true,
        overlayId,
        root,
        revision: state.revision,
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
      const body = await jsonBody('commit')
      if (body === undefined) return

      try {
        send(request, response, 200, await enqueue(() => commit(body)))
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
