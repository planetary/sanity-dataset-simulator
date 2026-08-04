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
// Three endpoints, JSON in / JSON out, CORS'd for the Studio dev origin:
//
//   GET  /health   liveness plus which overlay root is in play
//   GET  /state    full overlay state, for boot-time hydration of the echo layer
//   POST /commit   one intercepted write batch, committed as one transaction
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
  publish,
  restore,
  toPublishedId,
  unpublish,
} from '../../../packages/sanity-overlay-core/src/index.ts'
import {FsOverlayStore} from '../../../packages/sanity-overlay-store-fs/src/index.ts'
import {translateDocumentActions, translateInterceptedWrite} from './overlayTranslate.ts'

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

    if (request.method === 'POST' && route === '/commit') {
      let body
      try {
        const raw = await readBody(request)
        body = raw.length === 0 ? {} : JSON.parse(raw)
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(
                400,
                'INVALID_JSON',
                `commit body is not valid JSON: ${error?.message ?? error}`,
              )
        log('error', `overlay commit rejected [${failure.code}]: ${failure.message}`)
        send(request, response, failure.status, {
          ok: false,
          error: {code: failure.code, message: failure.message},
        })
        return
      }

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
