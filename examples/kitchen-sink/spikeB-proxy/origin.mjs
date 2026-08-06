/**
 * MODE 2 (`--origin` / `OVERLAY_BASE=none`) — the overlay-backed origin.
 *
 * WHAT THIS IS
 * ------------
 * Mode 1 is a proxy: it sits between Studio and a real Sanity project and
 * intercepts the data plane. Mode 2 is an ORIGIN: there is no Sanity project,
 * no account, no upstream and no base dataset. Every request Studio makes is
 * answered here, from `.sanity-overlay/` on disk.
 *
 * This is a deliberate extension of PRD §0.2, not a reinterpretation of it.
 * §0.2 fixes the overlay's base as a *live staging dataset*; Mode 2 removes the
 * base entirely, which makes every document branch-created (§17.2 precedence
 * rule 2) and makes the "base holds nothing" path the only path there is.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not an authentication system, and the identity it serves is not a
 * stub *of* one — there is nothing to stub. `GET /users/me` returns a
 * fabricated `local-dev` user; `/acl` returns `filter: "true"` with every
 * permission. Nothing is verified because there is nothing to verify against.
 * That is why `originSafety.mjs` refuses to bind anything but loopback, and why
 * `proxy.mjs` keeps the write guard in front of this file rather than behind it.
 *
 * LAYERING
 * --------
 * This file owns no overlay semantics. It is HTTP plus translation:
 *
 *   persistence      `FsOverlayStore`                 (sanity-overlay-store-fs)
 *   mutation engine  `applyTransaction`, §18 actions  (sanity-overlay-core)
 *   perspectives     `resolveVersionBatch`            (sanity-overlay-core)
 *   GROQ             `groq-js` 2.0.0, the pinned evaluator
 *
 * WHY GROQ IS EVALUATED DIRECTLY AND NOT THROUGH `sanity-overlay-query`
 * ---------------------------------------------------------------------
 * That package exists to make a query EXACT over a base dataset it cannot see
 * in full: it registers queries, plans the minimum set of base candidates to
 * fetch, and refuses anything it cannot plan (PRD §22.2 — approximate results
 * are forbidden). Mode 2 has no base. The overlay is not a diff against a
 * dataset, it IS the dataset, so the candidate set is "everything" and there is
 * nothing to plan or to bound. Running the original query over the complete
 * corpus is the *exact* answer by construction, which is the property §22.2 is
 * protecting. It also means Studio's arbitrary, unregistered GROQ works, which
 * a registry could never allow.
 *
 * RUNNING IT
 *   node --experimental-strip-types examples/kitchen-sink/spikeB-proxy/runOrigin.mjs --origin
 * (the launcher registers the `.ts` resolve fallback these imports need).
 */

import crypto from 'node:crypto'
import {isAbsolute, resolve as resolvePath} from 'node:path'

import {evaluate as evaluateGroq, parse as parseGroq} from 'groq-js'

import {
  applyTransaction,
  createOverlayState,
  deleteDocument,
  discardDraft,
  publish,
  resolveVersionBatch,
  toPublishedId,
  unpublish,
} from '../../../packages/sanity-overlay-core/src/index.ts'
import {FsOverlayStore} from '../../../packages/sanity-overlay-store-fs/src/index.ts'

/* ------------------------------------------------------------------ *
 * the synthetic identity
 * ------------------------------------------------------------------ */

/**
 * The fabricated user. Every field is chosen to be unmistakable in a screenshot
 * or a support thread:
 *
 *   id      `local-dev`  — not a Sanity user id shape (those are opaque, e.g. `pa9MITSCy`)
 *   email   `.invalid`   — RFC 2606 reserves it so it can never resolve
 *   name    says so out loud
 *
 * Studio renders `name` in the navbar avatar menu, so "Local Dev (no Sanity
 * account)" is visible for as long as the session lasts.
 */
export const ORIGIN_USER = Object.freeze({
  id: 'local-dev',
  name: 'Local Dev (no Sanity account)',
  email: 'local-dev@overlay.invalid',
  profileImage: null,
  provider: 'sanity-overlay-origin',
  role: 'administrator',
  roles: [
    {
      name: 'administrator',
      title: 'Administrator',
      description: 'Synthetic local-dev role. Mode 2 has no account and nothing to authenticate.',
    },
  ],
})

/**
 * Full document grants.
 *
 * `sanity@6.8.0` `createGrantsStore` evaluates `*[<filter>]` against a
 * single-element dataset containing the document being checked
 * (`datastores-*.js` `matchesFilter`), so `filter: 'true'` grants on every
 * document. The permission names are the `DocumentValuePermission` union from
 * `sanity/lib/index-*.d.ts`, read out rather than guessed.
 */
export const ORIGIN_GRANTS = Object.freeze([
  Object.freeze({
    filter: 'true',
    permissions: Object.freeze(['read', 'create', 'update', 'history', 'editHistory']),
  }),
])

const DEFAULT_ACTOR = Object.freeze({
  type: 'user',
  id: 'local-dev',
  displayName: 'Local Dev (Mode 2 origin)',
})

const JSON_HEADERS = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

class OriginError extends Error {
  constructor(status, code, description, details) {
    super(description)
    this.name = 'OriginError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new OriginError(413, 'OVERLAY_ORIGIN_PAYLOAD_TOO_LARGE', 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJson(request) {
  const text = await readBody(request)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new OriginError(400, 'OVERLAY_ORIGIN_INVALID_JSON', `request body is not JSON: ${cause.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * path shape
 * ------------------------------------------------------------------ */

const API_VERSION = /^v(?:\d{4}-\d{2}-\d{2}|\d+|X)$/

/**
 * Split `/v2025-02-19/data/doc/parity/a,b` into its version-free segments.
 * The version is *recorded*, never enforced: Studio pins six different API
 * versions across one boot (`proxy-log.jsonl` shows 2021-06-07, 2021-12-15,
 * 2022-06-30, 2023-12-11, 2024-09-19, 2025-02-19, 2026-05-04 and `/v1`), and an
 * origin that policed them would break the boot for no benefit.
 */
function splitApiPath(pathname) {
  const segments = pathname.split('/').filter((segment) => segment !== '')
  if (segments.length > 0 && API_VERSION.test(segments[0])) {
    return {apiVersion: segments[0], segments: segments.slice(1)}
  }
  return {apiVersion: null, segments}
}

/* ------------------------------------------------------------------ *
 * Sanity patch paths -> OverlayPath (PRD §13.6)
 * ------------------------------------------------------------------ */

/**
 * `body[_key=="a1"].text` -> `['body', {_key: 'a1'}, 'text']`.
 *
 * Deliberately partial. Sanity's patch path grammar also has slices
 * (`arr[0:2]`), predicates (`arr[cond]`) and wildcards (`arr[]`); none of them
 * appears in the recorded Studio traffic, and each carries real semantics that
 * an approximation would get subtly wrong. So the unsupported shapes raise —
 * a 400 naming the path is recoverable, a silently mis-applied patch is not.
 */
export function parseSanityPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new OriginError(400, 'OVERLAY_ORIGIN_UNSUPPORTED_PATH', `patch path must be a non-empty string`, {path: input})
  }

  const path = []
  let index = 0
  const fail = (why) => {
    throw new OriginError(400, 'OVERLAY_ORIGIN_UNSUPPORTED_PATH', `${why} in patch path ${JSON.stringify(input)}`, {path: input})
  }

  while (index < input.length) {
    if (input[index] === '.') {
      index += 1
      continue
    }
    if (input[index] === '[') {
      const end = input.indexOf(']', index)
      if (end === -1) fail('unterminated "["')
      const inner = input.slice(index + 1, end)
      const keyMatch = /^_key\s*==\s*(?:"([^"]*)"|'([^']*)')$/.exec(inner)
      if (keyMatch) {
        path.push({_key: keyMatch[1] ?? keyMatch[2]})
      } else if (/^\d+$/.test(inner)) {
        path.push(Number(inner))
      } else {
        fail(`unsupported bracket selector ${JSON.stringify(inner)} (only [<index>] and [_key=="<key>"] are implemented)`)
      }
      index = end + 1
      continue
    }
    const next = input.slice(index).search(/[.[]/)
    const segment = next === -1 ? input.slice(index) : input.slice(index, index + next)
    if (segment === '') fail('empty path segment')
    path.push(segment)
    index = next === -1 ? input.length : index + next
  }

  if (path.length === 0) fail('empty path')
  return path
}

/* ------------------------------------------------------------------ *
 * wire mutations -> OverlayMutation (PRD §13.7)
 * ------------------------------------------------------------------ */

/** Patch keys that carry no operation — preconditions and response flags. */
const PATCH_NON_OPERATION_KEYS = new Set([
  'id',
  'query',
  'params',
  'ifRevisionID',
  'ifRevisionId',
  // `unsetIsEmpty` rides along on every Actions-API edit patch; see
  // docs/plans/evidence/phase-1/spike-a-studio-interception/listener-event-shapes.md
  'unsetIsEmpty',
  'purge',
])

function patchOperations(patch) {
  const operations = []
  const unsupported = []

  for (const [key, value] of Object.entries(patch)) {
    if (PATCH_NON_OPERATION_KEYS.has(key)) continue
    switch (key) {
      case 'set':
      case 'setIfMissing':
        for (const [rawPath, next] of Object.entries(value ?? {})) {
          operations.push({type: key, path: parseSanityPath(rawPath), value: next})
        }
        break
      case 'unset':
        for (const rawPath of Array.isArray(value) ? value : []) {
          operations.push({type: 'unset', path: parseSanityPath(rawPath)})
        }
        break
      case 'inc':
      case 'dec':
        for (const [rawPath, amount] of Object.entries(value ?? {})) {
          operations.push({type: key, path: parseSanityPath(rawPath), amount: Number(amount)})
        }
        break
      case 'diffMatchPatch':
        for (const [rawPath, hunk] of Object.entries(value ?? {})) {
          operations.push({type: 'diffMatchPatch', path: parseSanityPath(rawPath), patch: String(hunk)})
        }
        break
      case 'insert': {
        /* `{insert: {before|after|replace: '<path>', items: [...]}}` */
        const position = ['before', 'after', 'replace'].find((candidate) => candidate in (value ?? {}))
        if (position === undefined || !Array.isArray(value.items)) {
          unsupported.push(`patch.insert ${JSON.stringify(value)}`)
          break
        }
        operations.push({
          type: 'insert',
          path: parseSanityPath(value[position]),
          position,
          items: value.items,
        })
        break
      }
      default:
        unsupported.push(`patch.${key}`)
    }
  }

  return {operations, unsupported}
}

/**
 * Translate the `mutations` array of `POST /data/mutate/<ds>` into core's
 * `OverlayMutation[]`.
 *
 * Anything unrecognised is COLLECTED, not skipped. A mutation the origin cannot
 * apply must surface as a 400 naming it — Studio's autosave has no way to
 * notice a write that was accepted and then quietly dropped, and "my edit
 * vanished on reload" is the single worst failure this whole project can have.
 */
export function translateMutations(mutations) {
  if (!Array.isArray(mutations)) {
    throw new OriginError(400, 'OVERLAY_ORIGIN_UNSUPPORTED_MUTATION', '`mutations` must be an array', {received: typeof mutations})
  }

  const out = []
  const unsupported = []

  for (const mutation of mutations) {
    if (!isRecord(mutation)) {
      unsupported.push(`mutation is not an object: ${JSON.stringify(mutation)}`)
      continue
    }
    const keys = Object.keys(mutation)
    for (const key of keys) {
      const value = mutation[key]
      switch (key) {
        case 'create':
        case 'createOrReplace':
        case 'createIfNotExists':
          if (!isRecord(value) || typeof value._id !== 'string') {
            unsupported.push(`${key} needs a document with a string _id`)
            break
          }
          out.push({type: key, document: value})
          break
        case 'delete':
          if (isRecord(value) && typeof value.id === 'string') {
            out.push({type: 'delete', id: value.id})
          } else if (typeof value === 'string') {
            out.push({type: 'delete', id: value})
          } else {
            /* `{delete: {query: '...'}}` deletes by GROQ. Not implemented:
             * a query-scoped delete against an overlay needs the §19 strong
             * reference check over the whole matched set, and getting that
             * wrong destroys content. */
            unsupported.push(`delete by ${JSON.stringify(Object.keys(value ?? {}))}`)
          }
          break
        case 'patch': {
          if (!isRecord(value) || typeof value.id !== 'string') {
            unsupported.push('patch needs a string id (query-scoped patches are not implemented)')
            break
          }
          const {operations, unsupported: bad} = patchOperations(value)
          unsupported.push(...bad)
          const patch = {type: 'patch', id: value.id, operations}
          const ifRevision = value.ifRevisionID ?? value.ifRevisionId
          if (typeof ifRevision === 'string') patch.ifRevision = ifRevision
          out.push(patch)
          break
        }
        default:
          unsupported.push(key)
      }
    }
  }

  return {mutations: out, unsupported}
}

/* ------------------------------------------------------------------ *
 * wire actions -> core §18 reducers
 * ------------------------------------------------------------------ */

/**
 * The Actions API shapes sanity 6.8.0 puts on the wire, mapped to the §18
 * reducer that means the same thing. Sources are the `serverOperationImpls`
 * table recorded in
 * `docs/plans/evidence/phase-1/spike-a-studio-interception/listener-event-shapes.md`.
 *
 * An action type NOT in this table is a 400 that names it. Content releases,
 * document versions and scheduled publishes all have `sanity.action.*` types
 * and none of them has overlay semantics yet; answering 200 to those would tell
 * Studio a release was created when nothing happened.
 */
export const SUPPORTED_ACTION_TYPES = Object.freeze([
  'sanity.action.document.create',
  'sanity.action.document.delete',
  'sanity.action.document.discard',
  'sanity.action.document.edit',
  'sanity.action.document.publish',
  'sanity.action.document.replaceDraft',
  'sanity.action.document.unpublish',
])

/** One reducer call, described as data so the commit loop stays uniform. */
export function translateActions(actions) {
  const list = Array.isArray(actions) ? actions : [actions]
  const steps = []
  const unsupported = []

  for (const action of list) {
    if (!isRecord(action) || typeof action.actionType !== 'string') {
      unsupported.push(`action is not an object with an actionType: ${JSON.stringify(action)}`)
      continue
    }
    switch (action.actionType) {
      case 'sanity.action.document.create': {
        const attributes = action.attributes
        if (!isRecord(attributes)) {
          unsupported.push('sanity.action.document.create without `attributes`')
          break
        }
        const document = {...attributes}
        if (typeof document._id !== 'string') {
          document._id = `drafts.${toPublishedId(String(action.publishedId ?? ''))}`
        }
        steps.push({
          kind: 'mutations',
          mutations: [
            {type: action.ifExists === 'ignore' ? 'createIfNotExists' : 'create', document},
          ],
        })
        break
      }
      case 'sanity.action.document.replaceDraft': {
        const attributes = action.attributes
        if (!isRecord(attributes)) {
          unsupported.push('sanity.action.document.replaceDraft without `attributes`')
          break
        }
        const document = {
          ...attributes,
          _id: `drafts.${toPublishedId(String(attributes._id ?? action.publishedId ?? ''))}`,
        }
        steps.push({kind: 'mutations', mutations: [{type: 'createOrReplace', document}]})
        break
      }
      case 'sanity.action.document.edit': {
        const patch = isRecord(action.patch) ? action.patch : null
        if (patch === null) {
          unsupported.push('sanity.action.document.edit without `patch`')
          break
        }
        const id = typeof action.draftId === 'string'
          ? action.draftId
          : `drafts.${toPublishedId(String(action.publishedId ?? ''))}`
        const {operations, unsupported: bad} = patchOperations(patch)
        unsupported.push(...bad)
        steps.push({kind: 'mutations', mutations: [{type: 'patch', id, operations}]})
        break
      }
      case 'sanity.action.document.publish':
        steps.push({kind: 'reducer', reducer: 'publish', id: String(action.publishedId ?? action.draftId ?? '')})
        break
      case 'sanity.action.document.unpublish':
        steps.push({kind: 'reducer', reducer: 'unpublish', id: String(action.publishedId ?? '')})
        break
      case 'sanity.action.document.discard':
        steps.push({
          kind: 'reducer',
          reducer: 'discardDraft',
          id: String(action.draftId ?? action.publishedId ?? ''),
        })
        break
      case 'sanity.action.document.delete': {
        /* `includeDrafts` lists the draft ids to remove alongside the published
         * one. Core's `deleteDocument` tombstones both versions of a logical
         * document at once, so the published id is the whole instruction. */
        steps.push({kind: 'reducer', reducer: 'delete', id: String(action.publishedId ?? '')})
        break
      }
      default:
        unsupported.push(action.actionType)
    }
  }

  return {steps, unsupported}
}

/* ------------------------------------------------------------------ *
 * the handler
 * ------------------------------------------------------------------ */

/**
 * Build the Mode 2 origin.
 *
 * @param {object} options
 * @param {string} options.root directory that CONTAINS `.sanity-overlay/`
 * @param {string} [options.projectId] the project id Studio is configured with
 * @param {string} [options.dataset] the one dataset this origin serves
 * @param {string} [options.overlayId]
 * @param {() => string} [options.now] injected clock
 * @param {(level: string, message: string) => void} [options.log]
 */
export async function createOriginHandler(options = {}) {
  const rootInput = options.root ?? process.cwd()
  const root = isAbsolute(rootInput) ? rootInput : resolvePath(process.cwd(), rootInput)
  const projectId = options.projectId ?? 'local-dev'
  const dataset = options.dataset ?? 'local'
  const overlayId = options.overlayId ?? 'overlay-origin-local'
  const now = options.now ?? (() => new Date().toISOString())
  const log = options.log ?? (() => {})

  const store = new FsOverlayStore({root, now})

  let manifest = null
  try {
    manifest = await store.inspect()
  } catch (error) {
    if (error?.code !== 'OVERLAY_NOT_FOUND') throw error
  }
  if (manifest === null) {
    manifest = await store.createOverlay({
      overlayId,
      /* The manifest still records a `base`, because §13.1 requires the field.
       * What Mode 2 records there is *which project this overlay is FOR*, not a
       * dataset it reads: nothing in this file ever fetches from it. */
      base: {projectId, dataset, apiVersion: '2025-02-19'},
      source: {repositoryId: 'local:sanity-overlay-origin', branch: 'local'},
      actor: DEFAULT_ACTOR,
      ifNotExists: true,
    })
  }

  /** In-memory projection of what is on disk. Rebuilt from the store, never invented. */
  let state = await hydrate(store, manifest)
  let sequence = 0
  /** Serialises commits: one transaction at a time, in arrival order. */
  let commitQueue = Promise.resolve()

  async function hydrate(theStore, theManifest) {
    const documents = {}
    const heads = await theStore.listChangedDocuments(theManifest.overlayId, {includeUnchanged: true})
    for (const head of heads) {
      const read = await theStore.readDocumentByLogicalId(theManifest.overlayId, head.logicalId)
      if (read?.record) documents[read.record.logicalId] = read.record
    }
    return createOverlayState({
      overlayId: theManifest.overlayId,
      revision: theManifest.revision,
      documents,
    })
  }

  /* ---------------------------------------------------------------- *
   * reads
   * ---------------------------------------------------------------- */

  /**
   * Every document in the overlay, addressed exactly as Studio addresses it
   * (PRD §13.9): the draft as `drafts.<id>`, the published as `<id>`, and a
   * tombstoned version simply absent.
   *
   * This is the whole GROQ corpus. With no base there is nothing else — which
   * is why the query below is exact rather than approximate.
   */
  function datasetDocuments() {
    const logicalIds = Object.keys(state.documents).sort()
    if (logicalIds.length === 0) return []
    const ids = []
    for (const logicalId of logicalIds) {
      ids.push(logicalId, `drafts.${logicalId}`)
    }
    const batch = resolveVersionBatch({
      ids,
      now: now(),
      records: state.documents,
      /* No `base` — `EMPTY_BASE_SOURCE` is the default, and in Mode 2 it is the
       * truth rather than a fallback. */
    })
    return batch.entries
      .filter((entry) => entry.document !== null)
      .map((entry) => entry.document)
  }

  function readDocuments(ids) {
    const batch = resolveVersionBatch({ids, now: now(), records: state.documents})
    const documents = []
    const omitted = []
    for (const entry of batch.entries) {
      if (entry.document === null) {
        /* Content Lake's `omitted` reason vocabulary is `existence` |
         * `permission` — Studio branches on it. Mode 2 grants everything, so
         * the only reason it can ever report is `existence`. Core's own, finer
         * absence reason (`missing`, `tombstoned`, …) rides along under a
         * namespaced key so a diagnosis is still possible without pretending
         * it is part of the Sanity wire contract. */
        omitted.push({
          id: entry.requestedId,
          reason: 'existence',
          overlayAbsence: entry.absence ?? null,
        })
        continue
      }
      documents.push(entry.document)
    }
    return {documents, omitted}
  }

  async function runQuery(queryText, params) {
    let tree
    try {
      tree = parseGroq(String(queryText))
    } catch (cause) {
      throw new OriginError(400, 'OVERLAY_ORIGIN_INVALID_GROQ', `GROQ parse error: ${cause.message}`)
    }
    const startedAt = Date.now()
    const value = await evaluateGroq(tree, {dataset: datasetDocuments(), params})
    const result = await value.get()
    return {ms: Date.now() - startedAt, query: String(queryText), result}
  }

  /* ---------------------------------------------------------------- *
   * the listen channel
   * ---------------------------------------------------------------- */

  /** Open SSE responses that receive mutation events, by id. */
  const listeners = new Map()
  /**
   * EVERY long-lived response and upgraded socket this handler owns.
   *
   * Separate from `listeners` because the agent-bundle stream receives no
   * mutation events but still holds a socket open, and an upgraded WebSocket is
   * not a `ServerResponse` at all. `http.Server.close()` waits for every open
   * connection, so anything not in here is a shutdown that never completes —
   * which is exactly the hang this set exists to prevent.
   */
  const openConnections = new Set()
  let listenerSequence = 0

  function track(connection) {
    openConnections.add(connection)
    const forget = () => openConnections.delete(connection)
    connection.on('close', forget)
    connection.on('error', forget)
  }

  function openListener(res, {includeResult}) {
    const id = `listener-${(listenerSequence += 1)}`
    listeners.set(id, res)
    res.on('close', () => listeners.delete(id))
    sendEvent(res, 'welcome', {listenerName: id})
    /* Sanity's own stream sends a comment as a keepalive; without one an idle
     * proxy or browser can reap the socket and Studio logs "No activity within
     * 45000 milliseconds. Reconnecting." */
    const keepalive = setInterval(() => {
      if (res.writableEnded) return
      res.write(': keepalive\n\n')
    }, 20_000)
    keepalive.unref?.()
    res.on('close', () => clearInterval(keepalive))
    return id
  }

  function sendEvent(res, event, data) {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /**
   * Announce a committed transaction.
   *
   * DELIBERATE OVER-DELIVERY. A real Content Lake listener only emits events for
   * documents matching that stream's GROQ filter. This one emits every affected
   * document to every open stream on the dataset, because Studio opens an
   * unconstrained `*` preview listener anyway (see listener-event-shapes.md) and
   * because the two failure modes are not symmetric: an extra event costs a
   * refetch, a missing one parks a pane on "Loading document…" for the 30 s
   * `resolveChainDeadline`. `transactionCurrentEvent`/`transactionTotalEvents`
   * are therefore consistent for every listener, which is exactly what
   * `allPendingTransactionEventsReceived` needs to release the group.
   */
  function announce(transactionId, affectedDocumentIds, transition) {
    const documentIds = affectedDocumentIds.flatMap((logicalId) => {
      const record = state.documents[logicalId]
      if (record === undefined) return []
      const ids = []
      if (record.local.draft !== null && !record.local.draftTombstone) ids.push(`drafts.${logicalId}`)
      if (record.local.published !== null && !record.local.publishedTombstone) ids.push(logicalId)
      /* A fully tombstoned document still has to be announced, or the pane
       * never learns it went away. */
      if (ids.length === 0) ids.push(`drafts.${logicalId}`, logicalId)
      return ids
    })
    if (documentIds.length === 0) return

    const timestamp = now()
    documentIds.forEach((documentId, index) => {
      const payload = {
        eventId: `${transactionId}#${documentId}`,
        documentId,
        transactionId,
        transition,
        identity: ORIGIN_USER.id,
        resultRev: transactionId,
        timestamp,
        visibility: 'transaction',
        transactionCurrentEvent: index + 1,
        transactionTotalEvents: documentIds.length,
        /* No `effects`: mendoza patches are what Studio applies OPTIMISTICALLY
         * to a document it already holds. Fabricating one would corrupt the
         * pane. Without it Studio refetches, which is slower and correct. */
      }
      for (const res of listeners.values()) sendEvent(res, 'mutation', payload)
    })
  }

  /* ---------------------------------------------------------------- *
   * writes
   * ---------------------------------------------------------------- */

  /** Run one core call and push its result through the store. Serialised. */
  async function commit(idempotencyKey, apply) {
    sequence += 1
    const transactionId = `origin-${String(sequence).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`
    const applied = apply({
      transactionId,
      idempotencyKey,
      actor: DEFAULT_ACTOR,
      now,
      /* No `base`. Mode 2 has none, so every record is branch-created and every
       * merge ancestor is absent — the §17.2 rule-2 path, exercised on every
       * single write rather than as an edge case. */
    })

    const records = applied.transaction.affectedDocumentIds
      .map((logicalId) => applied.state.documents[logicalId])
      .filter((record) => record !== undefined)

    const stored = await store.commitTransaction(manifest.overlayId, {
      idempotencyKey,
      actor: DEFAULT_ACTOR,
      mutations: applied.transaction.mutations,
      records,
    })

    state = {...applied.state, revision: stored.manifest.revision}
    return {
      transactionId: stored.transaction.transactionId,
      affectedDocumentIds: applied.transaction.affectedDocumentIds,
    }
  }

  /** Serialise a write behind whatever is already in flight. */
  function enqueue(task) {
    const result = commitQueue.then(task, task)
    commitQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const REDUCERS = {publish, unpublish, discardDraft, delete: deleteDocument}

  async function handleMutate(request, url) {
    const body = await readJson(request)
    const {mutations, unsupported} = translateMutations(body.mutations)
    if (unsupported.length > 0) {
      throw new OriginError(
        400,
        'OVERLAY_ORIGIN_UNSUPPORTED_MUTATION',
        `Mode 2 does not implement: ${unsupported.join('; ')}. It is refused rather than ` +
          'silently dropped — a write Studio believes succeeded but that never landed is the ' +
          'worst failure this overlay can have.',
        {unsupported},
      )
    }
    if (mutations.length === 0) {
      return {status: 200, body: {transactionId: null, results: []}}
    }

    const key = String(url.searchParams.get('idempotencyKey') ?? crypto.randomUUID())
    const committed = await enqueue(async () => {
      try {
        return await commit(key, (context) => applyTransaction(state, mutations, context))
      } catch (error) {
        throw asOriginError(error)
      }
    })
    announce(committed.transactionId, committed.affectedDocumentIds, 'update')

    return {
      status: 200,
      body: {
        transactionId: committed.transactionId,
        results: mutations.map((mutation) => ({
          id: mutation.type === 'patch' || mutation.type === 'delete' ? mutation.id : mutation.document._id,
          operation:
            mutation.type === 'patch'
              ? 'update'
              : mutation.type === 'delete'
                ? 'delete'
                : mutation.type === 'create'
                  ? 'create'
                  : 'update',
        })),
      },
    }
  }

  async function handleActions(request) {
    const body = await readJson(request)
    const {steps, unsupported} = translateActions(body.actions ?? body.action ?? [])
    if (unsupported.length > 0) {
      throw new OriginError(
        400,
        'OVERLAY_ORIGIN_UNSUPPORTED_ACTION',
        `Mode 2 does not implement: ${unsupported.join('; ')}. Supported action types are ` +
          `${SUPPORTED_ACTION_TYPES.join(', ')}.`,
        {unsupported, supported: SUPPORTED_ACTION_TYPES},
      )
    }
    if (steps.length === 0) return {status: 200, body: {transactionId: null}}

    const base = crypto.randomUUID()
    const affected = []
    let transactionId = null

    await enqueue(async () => {
      let index = 0
      for (const step of steps) {
        const key = `${base}#${index}`
        index += 1
        try {
          const committed = await commit(key, (context) =>
            step.kind === 'mutations'
              ? applyTransaction(state, step.mutations, context)
              : REDUCERS[step.reducer](state, {id: step.id}, context),
          )
          transactionId = committed.transactionId
          for (const id of committed.affectedDocumentIds) {
            if (!affected.includes(id)) affected.push(id)
          }
        } catch (error) {
          throw asOriginError(error)
        }
      }
    })

    announce(transactionId, affected, 'update')
    return {status: 200, body: {transactionId}}
  }

  /** Core's structured errors carry a code; map them rather than losing them. */
  function asOriginError(error) {
    if (error instanceof OriginError) return error
    return new OriginError(
      409,
      'OVERLAY_ORIGIN_MUTATION_FAILED',
      error?.message ?? String(error),
      {cause: error?.code ?? null},
    )
  }

  /* ---------------------------------------------------------------- *
   * routing
   * ---------------------------------------------------------------- */

  function jsonAnswer(body, status = 200) {
    return {status, body}
  }

  function unimplemented(what) {
    throw new OriginError(
      501,
      'OVERLAY_ORIGIN_UNIMPLEMENTED',
      `Mode 2 (origin) does not implement ${what}. It answers 501 rather than a plausible ` +
        'empty result, because a Studio feature that silently does nothing is harder to ' +
        'diagnose than one that says it is missing.',
      {endpoint: what},
    )
  }

  /**
   * The route table, derived from `proxy-log*.jsonl` — every distinct request
   * line a recorded `sanity dev` session actually sent. `origin-boot.test.ts`
   * replays those logs against this table, so an endpoint that appears in a
   * future recorded session appears there as a failure rather than as a 404.
   */
  async function route(request, {pathname, search}) {
    const url = new URL(`http://origin${pathname}${search}`)
    const {segments} = splitApiPath(pathname)
    const [head, ...rest] = segments
    const method = (request.method || 'GET').toUpperCase()

    switch (head) {
      /* --- liveness ---------------------------------------------------- */
      case 'ping':
        return jsonAnswer({ok: true, mode: 'origin'})

      /* --- identity ---------------------------------------------------- */
      case 'users': {
        if (rest[0] !== 'me') return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND'}}, 404)
        if (rest[1] === undefined) return jsonAnswer(ORIGIN_USER)
        if (rest[1] === 'keyvalue') {
          /* `GET /users/me/keyvalue/<a,b,c>` — Studio parks pane layout and sort
           * order here. Mode 2 has no per-user server-side storage, and saying
           * so with `value: null` is exactly the "not set yet" answer Studio
           * already handles on a fresh account. The PUT is a write and stays
           * 403 at the guard, so a layout change simply does not persist across
           * reloads; that is a declared limitation, not a silent failure. */
          const keys = String(rest[2] ?? '').split(',').filter((key) => key !== '')
          return jsonAnswer(keys.map((key) => ({key, value: null})))
        }
        return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND'}}, 404)
      }

      /* --- project and dataset metadata --------------------------------- */
      case 'projects': {
        if (rest[0] !== projectId) {
          return jsonAnswer(
            {
              error: {
                code: 'OVERLAY_ORIGIN_UNKNOWN_PROJECT',
                description:
                  `This origin serves project ${JSON.stringify(projectId)} only. ` +
                  `Received ${JSON.stringify(rest[0] ?? '')}.`,
              },
            },
            404,
          )
        }
        if (rest[1] === undefined) return jsonAnswer(projectDocument())
        if (rest[1] === 'grants') return jsonAnswer(projectRoleGrants())
        if (rest[1] === 'user-applications') return jsonAnswer([])
        if (rest[1] === 'datasets') {
          if (rest[2] === undefined) return jsonAnswer([datasetDocument()])
          if (rest[2] !== dataset) return unknownDataset(rest[2])
          if (rest[3] === 'acl') return jsonAnswer(ORIGIN_GRANTS)
          if (rest[3] === undefined) return jsonAnswer(datasetDocument())
          return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND'}}, 404)
        }
        return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND'}}, 404)
      }

      case 'datasets':
        return jsonAnswer([datasetDocument()])

      /* --- console banners --------------------------------------------- *
       *
       * Every one of these drives a banner, a nag or an upsell in the Studio
       * chrome. There is nothing to report in Mode 2 — no trial, no quota, no
       * organisation — and the empty/disabled answer is the same one a project
       * with none of those features gets. */
      case 'journey':
        return jsonAnswer(journeyAnswer(rest[0]))
      case 'features':
        return jsonAnswer([])
      case 'schedules':
        return jsonAnswer([])
      case 'help':
        return jsonAnswer([])
      case 'intake':
        /* `GET /intake/telemetry-status`. Telemetry is off and has nowhere to
         * go; the POST sibling `/intake/batch` is a write and stays 403. */
        return jsonAnswer({status: 'denied', reason: 'Mode 2 sends no telemetry'})

      /* --- the agent bundle listener ------------------------------------ */
      case 'agent': {
        if (rest[1] === 'bundles' && rest[3] === 'listen') return {stream: 'agent'}
        return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND'}}, 404)
      }

      /* --- the data plane ------------------------------------------------ */
      case 'data': {
        const [operation, ds, ...tail] = rest
        if (operation === 'ping') {
          if (ds !== dataset) return unknownDataset(ds)
          return jsonAnswer({ok: true, mode: 'origin'})
        }
        if (ds !== dataset) return unknownDataset(ds)

        switch (operation) {
          case 'query': {
            /* GET carries the query in the URL and params as `$name=<json>`;
             * POST is `@sanity/client`'s long-query fallback and carries both
             * in the body (`_dataRequest`). Same evaluator either way. */
            const posted = method === 'POST' ? await readJson(request) : null
            const text = posted === null ? url.searchParams.get('query') : posted.query
            if (typeof text !== 'string' || text.trim() === '') {
              throw new OriginError(400, 'OVERLAY_ORIGIN_MISSING_QUERY', 'a `query` is required')
            }
            const params =
              posted === null
                ? queryParamsFrom(url.searchParams)
                : isRecord(posted.params)
                  ? posted.params
                  : {}
            return jsonAnswer(await runQuery(text, params))
          }
          case 'doc': {
            const ids = String(tail.join('/'))
              .split(',')
              .map((id) => decodeURIComponent(id))
              .filter((id) => id !== '')
            if (ids.length === 0) {
              throw new OriginError(400, 'OVERLAY_ORIGIN_MISSING_ID', 'at least one document id is required')
            }
            return jsonAnswer(readDocuments(ids))
          }
          case 'listen':
            return {stream: 'listen', includeResult: url.searchParams.get('includeResult') === 'true'}
          case 'history':
            /* An empty timeline. The overlay DOES keep transactions (§13.10),
             * but Studio's history UI reads Content Lake's `mendoza` event
             * stream, which is a different model entirely; translating one into
             * the other is PRD §37 Phase 5 work. Empty is honest: the document
             * has no *Content Lake* history, because it has never been there. */
            return jsonAnswer(historyAnswer(tail))
          case 'mutate':
            return await handleMutate(request, url)
          case 'actions':
            return await handleActions(request)
          case 'export':
            return unimplemented('the dataset export endpoint')
          default:
            return jsonAnswer({error: {code: 'OVERLAY_ORIGIN_NOT_FOUND', description: `unknown data operation ${operation}`}}, 404)
        }
      }

      case 'socket':
        /* Reached only as a plain GET (no Upgrade header). The upgrade path is
         * `handleUpgrade` below. */
        return unimplemented('the realtime socket as a plain GET')

      default:
        return jsonAnswer(
          {
            error: {
              code: 'OVERLAY_ORIGIN_NOT_FOUND',
              description: `Mode 2 has no route for ${method} ${pathname}`,
            },
          },
          404,
        )
    }
  }

  function unknownDataset(received) {
    return jsonAnswer(
      {
        error: {
          code: 'OVERLAY_ORIGIN_UNKNOWN_DATASET',
          description:
            `This origin serves dataset ${JSON.stringify(dataset)} only. ` +
            `Received ${JSON.stringify(received ?? '')}. There is no upstream to forward to.`,
        },
      },
      404,
    )
  }

  function projectDocument() {
    const createdAt = manifest.createdAt ?? now()
    return {
      id: projectId,
      displayName: 'Local overlay (no Sanity project)',
      studioHost: null,
      organizationId: null,
      isBlocked: false,
      isDisabled: false,
      isDisabledByUser: false,
      createdAt,
      updatedAt: createdAt,
      maxRetentionDays: 0,
      activityFeedEnabled: false,
      members: [{id: ORIGIN_USER.id, role: 'administrator', isRobot: false, isCurrentUser: true}],
      features: [],
      metadata: {color: '#7c3aed', externalStudioHost: ''},
    }
  }

  function datasetDocument() {
    return {
      name: dataset,
      aclMode: 'public',
      createdAt: manifest.createdAt ?? now(),
      createdByUserId: ORIGIN_USER.id,
      addonFor: null,
      datasetProfile: 'content',
      features: [],
      tags: [],
    }
  }

  /**
   * `/projects/<p>/grants` is the *role* grant map, a different endpoint from
   * `/datasets/<d>/acl` (the document grants above). Studio reads it through
   * `getProjectGrants`; its type is `Record<string, RoleGrant[] | undefined>`
   * (`sanity/lib/index-*.d.ts` `ProjectGrants`).
   */
  function projectRoleGrants() {
    return {
      administrator: [
        {
          id: 'local-dev-administrator',
          name: 'administrator',
          title: 'Administrator',
          description: 'Synthetic local-dev role — Mode 2 has no account system.',
          isCustom: false,
          config: {},
          grants: [{name: 'sanity.project.documents', params: {}}],
        },
      ],
    }
  }

  function journeyAnswer(kind) {
    switch (kind) {
      case 'announcements':
        return []
      case 'trial':
        return null
      case 'asset-limit':
      case 'document-limit':
        /* No quota exists, so no quota is nearly reached. */
        return {limit: null, usage: 0, status: 'ok'}
      case 'scheduled-drafts':
      case 'content-releases':
        return {enabled: false}
      default:
        return []
    }
  }

  function historyAnswer(tail) {
    if (tail[0] === 'events') return {events: []}
    if (tail[0] === 'transactions') return {transactions: []}
    return {documents: []}
  }

  function queryParamsFrom(searchParams) {
    const params = {}
    for (const [key, value] of searchParams.entries()) {
      if (!key.startsWith('$')) continue
      try {
        params[key.slice(1)] = JSON.parse(value)
      } catch {
        params[key.slice(1)] = value
      }
    }
    return params
  }

  /* ---------------------------------------------------------------- *
   * the HTTP surface `proxy.mjs` calls
   * ---------------------------------------------------------------- */

  async function handle(request, response, context) {
    const cors = context?.cors ?? {}
    try {
      const answer = await route(request, {
        pathname: context?.pathname ?? request.url ?? '/',
        search: context?.search ?? '',
      })

      if (answer.stream === 'listen' || answer.stream === 'agent') {
        response.writeHead(200, {
          ...cors,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.flushHeaders?.()
        response.socket?.setNoDelay(true)
        track(response)
        if (answer.stream === 'listen') openListener(response, answer)
        else sendEvent(response, 'welcome', {listenerName: 'agent-bundles', bundles: []})
        return
      }

      const payload = JSON.stringify(answer.body ?? null)
      response.writeHead(answer.status ?? 200, {
        ...cors,
        ...JSON_HEADERS,
        'content-length': Buffer.byteLength(payload),
      })
      response.end(payload)
    } catch (error) {
      request.resume()
      const status = error instanceof OriginError ? error.status : 500
      const payload = JSON.stringify({
        error: {
          code: error instanceof OriginError ? error.code : 'OVERLAY_ORIGIN_ERROR',
          description: error?.message ?? String(error),
          ...(error?.details === undefined ? {} : {details: error.details}),
        },
      })
      log('warn', `${request.method} ${context?.pathname} -> ${status}: ${error?.message}`)
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(status, {...cors, ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload)})
      response.end(payload)
    }
  }

  /* ---------------------------------------------------------------- *
   * the realtime socket — declared, not faked
   * ---------------------------------------------------------------- *
   *
   * `GET /v2022-06-30/socket/<ds>` is @sanity/bifur-client's JSON-RPC 2.0
   * channel (see writeGuard.mjs's realtime section for the source citations).
   * Mode 2 completes the RFC 6455 handshake and keeps the socket alive, then
   * answers every JSON-RPC request with an explicit JSON-RPC ERROR naming the
   * gap.
   *
   * That is a deliberate middle position between the two things it could do:
   *
   *   - refusing the upgrade makes @sanity/bifur-client reconnect forever, and
   *     the recorded sessions show what that looks like (`GET /socket/parity`
   *     404 x33, 502 x18 in proxy-log*.jsonl).
   *   - fabricating `authorization` and `presence` results would invent
   *     collaborators and session state out of nothing.
   *
   * An error the client can see beats both. **This is the one part of Mode 2
   * that has not been verified against a live Studio** — see ORIGIN.md.
   */
  function handleUpgrade(request, socket, head) {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || !/websocket/i.test(String(request.headers.upgrade || ''))) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return 400
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)
    socket.setTimeout(0)
    track(socket)

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
    const send = (payload) => {
      if (!socket.writable) return
      socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8')))
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      let frame = decodeClientFrame(buffer)
      while (frame !== null) {
        buffer = buffer.subarray(frame.consumed)
        if (frame.opcode === 0x8) {
          socket.end(encodeServerFrame(0x8, Buffer.alloc(0)))
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeServerFrame(0xa, frame.payload))
        } else if (frame.opcode === 0x1) {
          let message = null
          try {
            message = JSON.parse(frame.payload.toString('utf8'))
          } catch {
            /* not JSON-RPC; ignore rather than guess */
          }
          if (isRecord(message) && message.id !== undefined) {
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32601,
                message:
                  'Mode 2 (origin) does not implement the bifur realtime channel. ' +
                  'Presence, realtime document sync and the `authorization` handshake are ' +
                  'unavailable; the HTTP data plane and the /data/listen SSE stream are not.',
                data: {method: message.method ?? null, mode: 'origin'},
              },
            })
          }
        }
        frame = decodeClientFrame(buffer)
      }
    })

    socket.on('error', () => socket.destroy())
    return 101
  }

  /* ---------------------------------------------------------------- *
   * lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Release everything this handler owns.
   *
   * Call it BEFORE `http.Server.close()`. `close()` refuses to complete while
   * any connection is open, and neither an SSE stream nor an upgraded WebSocket
   * ever ends by itself — so a server that is asked to stop while a Studio tab
   * is attached would otherwise wait forever.
   */
  async function close() {
    for (const connection of openConnections) {
      try {
        if (typeof connection.end === 'function' && connection.writableEnded !== true) {
          connection.end()
        }
        connection.destroy?.()
      } catch {
        /* already gone */
      }
    }
    openConnections.clear()
    listeners.clear()
    /* Let any in-flight commit reach its rename before the caller exits. */
    await commitQueue.catch(() => undefined)
  }

  return {
    handle,
    handleUpgrade,
    close,
    /* `proxy.mjs` scopes the origin write allowlist to this dataset, so a
     * dataset-swapped client (Spike F attack 14) cannot reach the overlay. */
    dataset,
    projectId,
    root,
    get overlayId() {
      return manifest.overlayId
    },
    get revision() {
      return state.revision
    },
  }
}

/* ------------------------------------------------------------------ *
 * RFC 6455 framing — server side, the minimum bifur needs
 * ------------------------------------------------------------------ */

function encodeServerFrame(opcode, payload) {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 0x10000) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

/** Returns null when `buf` does not yet hold a whole frame. Client frames are masked. */
function decodeClientFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let length = buf[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buf.length < 4) return null
    length = buf.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(MAX_BODY_BYTES)) return null
    length = Number(big)
    offset = 10
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buf.length < offset + length) return null

  const payload = Buffer.from(buf.subarray(offset, offset + length))
  if (masked) {
    for (let i = 0; i < length; i += 1) payload[i] ^= buf[maskOffset + (i % 4)]
  }
  return {opcode, payload, consumed: offset + length}
}
