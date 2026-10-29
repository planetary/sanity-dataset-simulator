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
  isForbiddenKey,
  publish,
  recordFromIntent,
  resolveVersionBatch,
  toPublishedId,
  unpublish,
} from '../../../packages/sanity-overlay-core/src/index.ts'
import {FsOverlayStore} from '../../../packages/sanity-overlay-store-fs/src/index.ts'
import {isGrantedOrigin} from './originSafety.mjs'

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

/**
 * The transaction log is NDJSON, and NDJSON's empty document is ZERO LINES.
 *
 * `sanity@6.8.0` reads `/data/history/<ds>/transactions/<ids>` with the global
 * `fetch` and decodes it line by line (`datastores-DqFH7RLd.js:6879 getStream`:
 * split on "\n", `JSON.parse` each non-empty line, parse the trailing buffer at
 * EOF). So the JSON envelope this endpoint used to answer —
 * `{"transactions":[]}` — does not mean "no transactions". It decodes to
 * exactly ONE transaction, the envelope, which has no `effects`, and
 * `useBundleDocuments-BYW8M9LS.js:4965 getEditEvents` then evaluates
 * `tx.effects[documentId]` and throws:
 *
 *     TypeError: Cannot read properties of undefined
 *       (reading 'drafts.e2e-unicode-multihunk')
 *
 * observed live 2026-08-09, three-plus times per branch document. `[]` fails
 * identically. The only body that decodes to nothing is nothing.
 *
 * `packages/sanity-overlay-studio/src/client/history.ts` states the same
 * constant for the client half of this contract. The two are deliberately
 * SEPARATE definitions — that module is a Studio-side client and this is a
 * server; importing it here would invert the layering — and
 * `test/origin-history-wire-format.test.ts` pins them equal so they cannot
 * drift.
 */
const EMPTY_TRANSLOG_NDJSON = ''

/**
 * And it must be LABELLED as NDJSON. Studio parses these bytes line by line
 * whatever the header says, but a body served as `application/json` tells every
 * other reader of the same response something false about it.
 */
const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

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
 * cross-site request forgery, and who may read the branch
 * ------------------------------------------------------------------ *
 *
 * Mode 2's identity is synthetic and FULLY GRANTED (`originSafety.mjs`), so
 * there is no authentication anywhere behind `/data/mutate` and `/data/actions`.
 * That is only safe while a request has to come from somewhere trusted, and
 * until the 2026-08-06 security review (P2-4) nothing checked. `POST` +
 * `Content-Type: text/plain` is CORS-SAFELISTED, so it fires no preflight: any
 * page the developer had open could drive a write. The loopback bind — which is
 * otherwise sound — stops a LAN attacker and nothing else, because a page in the
 * developer's own browser is on loopback by definition.
 *
 * WHY LOOPBACK ORIGINS ARE THE ALLOWLIST
 * Mode 2 refuses to bind anything but loopback, and its one browser client is a
 * local dev server whose port cannot be known in advance (`3333` for `sanity
 * dev`, `5173` for a bare Vite, whatever `--port` said). So the grant is derived
 * from the same structural predicate the bind check uses, rather than from a
 * list that would have to be guessed or configured. A page at
 * `https://evil.example` is refused — including one whose DNS has been rebound
 * to 127.0.0.1, because rebinding changes where a name resolves and not what a
 * page's ORIGIN is.
 */

/*
 * Is `value` an origin Mode 2 will talk to? — `originSafety.mjs`, imported at
 * the top of this file, and NOT a copy of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE WAS A PRIVATE COPY HERE, AND IT HAD ALREADY DRIFTED.
 *
 * The local version read `if (allowed.has('*') || allowed.has(value))`. The
 * shared one has no wildcard clause, because `normalizeGrantedOrigins` refuses
 * `'*'` outright: the proxy reflects the granted origin back with
 * `Access-Control-Allow-Credentials: true`, so a wildcard there is the
 * 2026-08-06 P2-4 hole restated as configuration. `origin.mjs` never ran its
 * `origins` list through that normaliser, so `createOriginHandler({origins:
 * ['*']})` granted `https://evil.example` a state-changing request against the
 * whole branch — a list the proxy's own front door would have refused.
 *
 * The swap can only NARROW. For any allowlist, the shared predicate grants a
 * strict subset of what the copy granted: the two clauses are identical except
 * for the wildcard the copy honoured. `origin-granted-parity.test.ts` ran both
 * against one corpus of origin shapes before the copy was deleted and recorded
 * that they agreed on every case except exactly that one.
 *
 * Duplicating a security predicate is what produced the CORS hole in the first
 * place: two copies agree the day they are written and nothing makes them keep
 * agreeing. One definition — the same one `proxy.mjs` imports, and the same
 * `isLoopbackBind` the bind check uses, so "loopback" means one thing for the
 * socket and for the caller.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Refuse a forged cross-site state-changing request.
 *
 * Three clauses. The JSON content type is the one that closes the CLASS: it
 * takes the request out of the CORS-safelisted set, so a cross-origin browser
 * must preflight first. `Sec-Fetch-Site` is what still holds when `Origin` is
 * absent — browsers set it and page JS cannot forge it. The origin check is the
 * backstop for a caller that sends `Origin` and nothing else.
 *
 * An ABSENT `Origin` is allowed: curl, the recorded-session replays and any
 * non-browser client carry no ambient browser credential and are not the actor
 * this control exists for.
 */
function assertWriteIsNotForged(request, allowed) {
  const contentType = String(request.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    throw new OriginError(
      415,
      'OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE',
      'a state-changing request must declare `content-type: application/json`, which is what ' +
        'forces a CORS preflight and closes the forged simple-request path. Mode 2 has no ' +
        'authentication behind this route, so the request has to prove where it came from.',
    )
  }

  const site = request.headers['sec-fetch-site']
  const origin = request.headers.origin
  const forbidden = () =>
    new OriginError(
      403,
      'OVERLAY_ORIGIN_FORBIDDEN_ORIGIN',
      `Mode 2 does not accept a state-changing request from ${JSON.stringify(origin ?? '(cross-site)')}. ` +
        'It serves a synthetic full-grant identity from a loopback socket, so only a loopback ' +
        'origin — or one named explicitly — may drive a write.',
      {origin: origin ?? null},
    )

  /* A granted Origin decides first. Page JS cannot forge `Origin`, and a stock
   * Studio on `http://localhost` writing to `https://<project>.localhost` is
   * always labelled `cross-site` (scheme and site both differ), so checking the
   * label first refused every legitimate write. `cross-site` still refuses
   * whenever no granted Origin vouches for the request. */
  if (typeof origin === 'string' && origin !== '' && isGrantedOrigin(origin, allowed)) return
  if (site === 'cross-site') throw forbidden()
  if (typeof origin !== 'string' || origin === '') return
  throw forbidden()
}

/** Header names the transport owns and Mode 2 will not pass on unearned. */
const CORS_GRANT_HEADERS = ['access-control-allow-origin', 'access-control-allow-credentials']

/**
 * Strip a CORS grant this origin would not have issued.
 *
 * `corsHeaders` is computed in `proxy.mjs` and reflects the request `Origin`
 * verbatim with `Access-Control-Allow-Credentials: true` — which is the standard
 * way a local dev server becomes an exfiltration endpoint, and here the thing
 * exfiltrated is the whole branch, every unpublished draft included. Mode 2
 * cannot fix the transport, but every byte of branch content leaves through
 * THIS module, so it refuses to carry a grant it disagrees with. A caller that
 * sent no `Origin` is left alone: there is no browser to protect.
 */
function grantedCorsHeaders(request, cors, allowed) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return cors
  if (isGrantedOrigin(origin, allowed)) return cors
  const stripped = {}
  for (const [name, value] of Object.entries(cors)) {
    if (CORS_GRANT_HEADERS.includes(name.toLowerCase())) continue
    stripped[name] = value
  }
  return stripped
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
 *
 * A field segment spelling a §35.14 prototype key raises for exactly that
 * reason. `__proto__`, `constructor` and `prototype` can never be own keys of
 * canonical overlay JSON, and a plain assignment to the first runs the prototype
 * SETTER — so the write vanishes while the caller is answered a `transactionId`
 * (security review 2026-08-06 P2-5). Mode 2 has no upstream, so a discarded
 * write is not a divergence from staging: it is content that exists nowhere.
 * Core refuses it too, but a 409 from the mutation engine is a worse answer than
 * a 400 that names the path. A `_key` PREDICATE spelling the same word is
 * untouched — that is a value, not a property name.
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
    if (isForbiddenKey(segment)) {
      fail(
        `prototype-polluting segment ${JSON.stringify(segment)} cannot be a document field ` +
          '(PRD §35.14); the write is refused rather than stored as something else',
      )
    }
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
 * findability — the query Studio's structure list actually sends
 * ------------------------------------------------------------------ *
 *
 * A structure list pane does NOT send `*[_type == "article"]`. It sends the
 * search service's *findability* query, built by `createSearchQuery` in
 * `sanity@6.8.0`:
 *
 *   // findability-mvi:5
 *   // findability-source: list
 *   *[_type in $__types && ([@, _id] match text::query($__query) ||
 *      references($__rawQuery)) && (_type == $type)] {
 *     _type, _id, _originalId, "orderings": [_updatedAt]
 *   } | order(orderings[0] desc) [0...$__limit]
 *
 * Two things in it defeat `groq-js` 2.0.0, and both were fatal in Mode 2, where
 * an unanswered query means an EMPTY CONTENT LIST rather than a fallback to
 * staging:
 *
 *   1. `[0...$__limit]` — groq-js: "slicing must use constant numbers". The
 *      whole query fails to PARSE, so not one document comes back.
 *   2. `text::query(...)` — groq-js parses it and then throws "not implemented"
 *      during evaluation. It is Content Lake's hosted full-text index.
 *
 * WHAT THE PARAMETERS ACTUALLY CARRY  (from `createSearchQuery` + `prefixLast`
 * in the installed dist; `origin-findability.test.ts` extracts and RUNS
 * Studio's own `prefixLast` rather than taking anyone's word for it)
 *
 *   unfiltered pane   the pane passes `searchQuery || ""`, so the raw term is
 *                     `""`; `prefixLast("")` returns `"*"`.
 *                     -> `$__query = "*"`, `$__rawQuery = ""`
 *   typed term "Born" -> `$__query = "Born*"`, `$__rawQuery = "Born"`
 *   always            -> `$__limit = (limit ?? 1000) + 1`
 *
 * That is the crux. For the case the structure list overwhelmingly uses — no
 * search term — the predicate means "match everything of these types". Over a
 * Mode 2 dataset, which IS the overlay in full, that answer is EXACT. Returning
 * nothing was never the honest degradation; it was simply wrong.
 *
 * WHAT IS APPROXIMATE, AND HOW IT SAYS SO
 * ---------------------------------------
 * With a typed term, hosted `text::query` does stemming, language analysis and
 * relevance ranking against an index this process does not have. Mode 2 does
 * case-insensitive prefix token matching over the document's own text, using
 * groq-js's own `match` operator so the tokenisation is at least the pinned
 * evaluator's rather than a hand-rolled one. It is close, it is not the same,
 * and it must not pretend: every such query answers with an
 * `overlayApproximation` array naming `text::query`, the term and the reason.
 * `"*"` is reported as exact, because it is.
 *
 * Anywhere `text::query` is used as a VALUE rather than as the right-hand side
 * of `match`, there is no honest local answer at all, and Mode 2 raises 501.
 */

/** `[0...$__limit]` and friends. `...` before `..` — alternation order matters. */
const PARAMETERISED_SLICE =
  /\[\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*(\.\.\.|\.\.)\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*\]/g

/**
 * Replace `$param` slice endpoints with their integer values.
 *
 * Applied ONLY after groq-js has already refused the source, so a query that
 * parses is never rewritten and this can introduce no behaviour of its own. A
 * `$param` that is not a safe integer is deliberately left alone: the re-parse
 * then fails again and the caller gets the parse error, rather than a silently
 * unbounded list.
 */
export function substituteSliceParameters(source, params) {
  return source.replace(PARAMETERISED_SLICE, (whole, left, dots, right) => {
    const resolve = (side) => {
      if (!side.startsWith('$')) return side
      const value = isRecord(params) ? params[side.slice(1)] : undefined
      return Number.isSafeInteger(value) ? String(value) : null
    }
    const a = resolve(left)
    const b = resolve(right)
    if (a === null || b === null) return whole
    return `[${a}${dots}${b}]`
  })
}

/** groq-js's own `match`, reused so the tokenisation is the evaluator's. */
const MATCH_PROBE = parseGroq('$__haystack match $__pattern')

/** Guards against a pathological document; the overlay is small, not trusted. */
const MAX_TEXT_DEPTH = 12
const MAX_TEXT_LEAVES = 5000

/**
 * Every searchable string reachable from a value.
 *
 * System fields are skipped by key prefix: `_rev`, `_createdAt`, `_key`, `_ref`
 * and friends are bookkeeping, and hosted full-text search does not surface a
 * document because its revision hash happened to contain your term. `_id` still
 * participates, because Studio's predicate names it explicitly as its own array
 * element (`[@, _id]`) rather than relying on `@`.
 */
function collectSearchableStrings(value, out = [], depth = 0) {
  if (out.length >= MAX_TEXT_LEAVES || depth > MAX_TEXT_DEPTH) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchableStrings(item, out, depth + 1)
    return out
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('_')) continue
      collectSearchableStrings(item, out, depth + 1)
    }
  }
  return out
}

function isTextQueryCall(node) {
  return isRecord(node) && node.type === 'FuncCall' && node.namespace === 'text' && node.name === 'query'
}

/** A constant string argument, or `null` when it cannot be known before evaluation. */
function constantString(node, params) {
  if (!isRecord(node)) return null
  if (node.type === 'Parameter') {
    const value = isRecord(params) ? params[node.name] : undefined
    return typeof value === 'string' ? value : null
  }
  if (node.type === 'Value' && typeof node.value === 'string') return node.value
  return null
}

/** Pre-order walk yielding every `<expr> match text::query(<arg>)` node. */
function collectTextQueryMatches(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectTextQueryMatches(item, found)
    return found
  }
  if (!isRecord(node)) return found
  if (node.type === 'OpCall' && node.op === 'match' && isTextQueryCall(node.right)) found.push(node)
  for (const value of Object.values(node)) collectTextQueryMatches(value, found)
  return found
}

function containsTextQueryCall(node) {
  if (Array.isArray(node)) return node.some((item) => containsTextQueryCall(item))
  if (!isRecord(node)) return false
  if (isTextQueryCall(node)) return true
  return Object.values(node).some((value) => containsTextQueryCall(value))
}

/** Structural copy with the collected nodes swapped for their replacements. */
function replaceNodes(node, replacements) {
  if (Array.isArray(node)) return node.map((item) => replaceNodes(item, replacements))
  if (!isRecord(node)) return node
  const replacement = replacements.get(node)
  if (replacement !== undefined) return replacement
  const next = {}
  for (const [key, value] of Object.entries(node)) next[key] = replaceNodes(value, replacements)
  return next
}

/**
 * Resolve every `text::query` match against the corpus, ahead of evaluation.
 *
 * The left-hand side is evaluated by groq-js once per document with that
 * document as `@`, so this works for `[@, _id]`, for a plain field path, and for
 * a dereference alike — no special-casing of the one query shape we happen to
 * have captured. The predicate then becomes `_id in $<generated>`, which the
 * pinned evaluator can run.
 *
 * @returns {Promise<{tree: object, params: object, approximations: object[]}>}
 */
async function resolveTextQueries(tree, params, documents, evaluateNode) {
  const matches = collectTextQueryMatches(tree)
  if (matches.length === 0) {
    if (containsTextQueryCall(tree)) {
      throw new OriginError(
        501,
        'OVERLAY_ORIGIN_UNIMPLEMENTED',
        'Mode 2 (origin) does not implement `text::query()` anywhere except as the right-hand ' +
          'side of a `match` predicate. As a value it is a handle into Content Lake\'s hosted ' +
          'full-text index, which this process does not have and will not fake.',
        {endpoint: 'text::query as a value'},
      )
    }
    return {tree, params: {}, approximations: []}
  }

  const replacements = new Map()
  const generated = {}
  const approximations = []
  let index = 0

  for (const node of matches) {
    const pattern = constantString(node.right.args?.[0], params)
    if (pattern === null) {
      throw new OriginError(
        501,
        'OVERLAY_ORIGIN_UNIMPLEMENTED',
        'Mode 2 (origin) does not implement `text::query()` with a search term it cannot know ' +
          'before evaluation. Studio passes it as a parameter (`$__query`); a computed term ' +
          'would need the hosted index.',
        {endpoint: 'text::query with a computed term'},
      )
    }

    const ids = []
    for (const document of documents) {
      const left = await evaluateNode(node.left, {root: document})
      const haystack = collectSearchableStrings(left)
      if (haystack.length === 0) continue
      const matched = await evaluateNode(MATCH_PROBE, {
        params: {__haystack: haystack, __pattern: pattern},
      })
      if (matched === true) ids.push(document._id)
    }

    const name = `__overlayTextMatch${(index += 1)}`
    generated[name] = ids
    replacements.set(node, {
      type: 'OpCall',
      op: 'in',
      left: {type: 'AccessAttribute', name: '_id'},
      right: {type: 'Parameter', name},
    })

    /* `*` is `prefixLast('')` — "everything". Over a corpus that IS the overlay
     * that is exact, so it is not reported as an approximation. Any other term
     * is. */
    if (pattern.trim() === '*') continue
    if (approximations.some((entry) => entry.term === pattern)) continue
    approximations.push({
      function: 'text::query',
      term: pattern,
      matched: ids.length,
      reason:
        "Content Lake's hosted full-text index — stemming, language analysis and relevance " +
        'ranking — has no local equivalent. Mode 2 substitutes case-insensitive prefix token ' +
        "matching over the document's own text. Results may differ from the hosted dataset.",
    })
  }

  return {tree: replaceNodes(tree, replacements), params: generated, approximations}
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
 * @param {readonly string[]} [options.origins] extra browser origins allowed to
 *   write and to read cross-origin. Loopback origins are always allowed — see
 *   `isGrantedOrigin` — so this exists for the unusual case, not the normal one.
 */
export async function createOriginHandler(options = {}) {
  const rootInput = options.root ?? process.cwd()
  const root = isAbsolute(rootInput) ? rootInput : resolvePath(process.cwd(), rootInput)
  const projectId = options.projectId ?? 'local-dev'
  const dataset = options.dataset ?? 'local'
  const overlayId = options.overlayId ?? 'overlay-origin-local'
  const now = options.now ?? (() => new Date().toISOString())
  const log = options.log ?? (() => {})
  const allowedOrigins = new Set(options.origins ?? [])

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
      if (read?.record) {
        documents[read.record.logicalId] = read.record
        continue
      }
      /* The fresh-clone path — `.runtime/` is gitignored, so a cloned overlay
       * has intents and snapshots but no records. Same rebuild the overlay API
       * does (see `hydrateState` in sanity-overlay-next): `recordFromIntent`
       * refuses anything it cannot rebuild honestly, and refused documents
       * stay unserved rather than guessed at. */
      if (read?.intent) {
        const rebuilt = recordFromIntent(read.intent, {
          overlayId: theManifest.overlayId,
          baseSnapshot: read.baseSnapshot,
          runtimeRevision: read.head.runtimeRevision,
          createdAt: read.head.updatedAt,
          updatedAt: read.head.updatedAt,
        })
        if (rebuilt !== null) documents[rebuilt.logicalId] = rebuilt
      }
    }
    return createOverlayState({
      overlayId: theManifest.overlayId,
      revision: theManifest.revision,
      documents,
    })
  }

  /* ---------------------------------------------------------------- *
   * THE ORIGIN IS NOT THE ONLY WRITER OF `.sanity-overlay/`
   * ---------------------------------------------------------------- *
   *
   * `state` above is a projection of the disk, and for a long time it was built
   * exactly once — here, at construction — and thereafter only ever mutated by
   * this file's own `/data/mutate` and `/data/actions` handlers. That is correct
   * for a process that owns its storage, and Mode 2 does not:
   *
   *   playwright.config.ts     runOrigin.mjs --root=$OVERLAY_ROOT      (:3999)
   *   e2e/harness/…Harness.mjs the overlay API on the SAME root  (:3997/:3998)
   *
   * With `sanity-overlay-studio` installed, an edit is intercepted in the
   * browser and committed to the OVERLAY API, which writes the overlay root.
   * Nothing tells this process. So the projection stayed at whatever the disk
   * held when the process started — for the E2E stack, EMPTY — for the whole
   * session, while the branch on disk filled up.
   *
   * WHY THAT IS NOT A COSMETIC STALENESS
   * ────────────────────────────────────
   * This origin is where the Studio facade DELEGATES. A GROQ read the branch
   * planner declines to answer exactly is recorded as a `passthrough` and sent
   * to the data plane, which in Mode 2 is here. A passthrough was therefore not
   * a fallback to a less convenient source — it was a confident `[]` from a
   * source that had been told nothing since boot. PRD §5.5 asks for the right
   * answer or a stated refusal; an empty array shaped exactly like a real answer
   * is neither, and it is what a user saw as "No results" in the reference
   * picker for a document sitting in the branch.
   *
   * WHY READ-TIME, AND NOT A WATCHER
   * ────────────────────────────────
   * Watching the overlay root — `fs.watch`, or a poll, the way the local site's
   * client does — was the obvious alternative and it is the wrong one HERE. A
   * watcher is eventually consistent: between a `/commit` landing on disk and
   * the event arriving there is a window in which this process still answers
   * from the old projection, and it answers SILENTLY. That is the same class of
   * defect, merely smaller and harder to reproduce. Reading the commit point on
   * the same tick as the answer has no window at all.
   *
   * It is also affordable, which is what makes the choice available: the check
   * is one small JSON file (`manifest.json`), and a full re-projection happens
   * only when that file says the corpus actually moved.
   *
   * WHAT IS COMPARED, AND WHY IT IS SUFFICIENT
   * ──────────────────────────────────────────
   * Not `revision` alone. The E2E harness resets by DELETING the overlay root
   * and letting the overlay API recreate it, so revision runs backwards to 0 and
   * can revisit a number this process has already seen with a different corpus
   * behind it. `corpusToken` therefore names the identity of the overlay
   * (`overlayId`, `createdAt`) alongside the commit point, and then the
   * content-addressed `checksum` of every head — which is precisely and only
   * what `hydrate` reads. Two manifests with equal tokens cannot project to
   * different documents.
   *
   * THE ONE THING THIS DOES NOT SEE, SAID OUT LOUD
   * ──────────────────────────────────────────────
   * A human hand-editing `documents/<id>/intent.json` changes the disk without
   * moving the manifest, and §14.3 direct-edit reconciliation — which is what
   * turns such an edit into a commit point — belongs to the overlay API's
   * `pollDirectEdits`, not here. Once ANY reconciler has run, the manifest moves
   * and this sees it. Until then the manifest is the commit point and this file
   * reads the commit point, deliberately.
   * ---------------------------------------------------------------- */

  /**
   * A value that changes if and only if `hydrate` could project something
   * different. Cheap: the manifest is already parsed by the time this runs.
   *
   * `JSON.stringify` of nested arrays rather than a joined string, because the
   * only failure mode that matters here is a FALSE MATCH — two different
   * corpora collapsing to one token, which would serve stale documents and
   * report nothing at all. Any single-character separator can be forged by a
   * logical id containing that character; JSON escaping cannot be. (A false
   * MISMATCH is merely one extra re-projection, and costs only time.)
   */
  function corpusToken(theManifest) {
    const heads = Object.entries(theManifest.documentHeads ?? {})
      .map(([logicalId, head]) => [logicalId, head?.checksum ?? ''])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return JSON.stringify([
      theManifest.overlayId,
      theManifest.createdAt ?? '',
      theManifest.status ?? '',
      theManifest.revision,
      theManifest.transactionHead ?? '',
      heads,
    ])
  }

  let hydratedToken = corpusToken(manifest)

  /** The token for "there is no overlay at this root". Distinct from any manifest's. */
  const ABSENT_TOKEN = JSON.stringify(['<absent>'])

  /**
   * Bring `manifest` and `state` up to the bytes on disk, if they are not there
   * already.
   *
   * AN ABSENT OVERLAY IS AN EMPTY CORPUS, NOT AN ERROR.
   * ──────────────────────────────────────────────────
   * This refused with a 503 at first, on the reasoning that "the branch is
   * momentarily not there" and "the branch is empty" are different facts. Two
   * things were wrong with that.
   *
   * Empirically: `e2e/harness/overlayHarness.mjs` `POST /reset` does
   * `rmSync(root)` and restarts the overlay API against the empty directory,
   * and `e2e/playwright/fixtures.ts` calls it BEFORE EVERY TEST. The origin is
   * not restarted with it, so an absent `.sanity-overlay/` is not an exceptional
   * mid-flight glimpse — it is a routine state that every spec passes through.
   * Refusing produced 72 `OVERLAY_ORIGIN_BRANCH_UNAVAILABLE` responses in one
   * run and failed five specs that had nothing to do with this change.
   *
   * And on the merits: Mode 2 has no base, so the overlay IS the dataset. A
   * dataset that does not exist contains no documents, and `[]` is therefore the
   * correct answer rather than a plausible-looking guess. What §5.5 forbids is a
   * STALE corpus presented as a current one — which is what this function
   * exists to prevent and is the opposite of reporting emptiness truthfully.
   *
   * A WRITE is not given the same treatment and does not need to be:
   * `store.commitTransaction` refuses against an overlay that is not there, and
   * that refusal is named and surfaces as an error. Nothing is silently dropped.
   *
   * A manifest that is on disk but UNPARSEABLE is deliberately not handled here.
   * `FsOverlayStore` already owns that rule (§14.3: refuse malformed JSON,
   * retain the last valid in-memory state, write a diagnostic copy), and a
   * second opinion about it in this file is how the CORS predicate above drifted
   * into a security hole.
   */
  async function refreshFromDisk() {
    let current = null
    try {
      current = await store.inspect()
    } catch (error) {
      if (error?.code !== 'OVERLAY_NOT_FOUND') throw error
    }

    if (current === null) {
      if (hydratedToken === ABSENT_TOKEN) return
      /* `manifest` is left alone: it still describes the overlay this origin was
       * started for, which is what `/projects` and `/datasets` answer about, and
       * inventing a manifest for an overlay that is not there would be worse
       * than reporting the one we were configured with. Only the CORPUS is
       * emptied, because only the corpus is a claim about content. */
      state = createOverlayState({
        overlayId: manifest.overlayId,
        /* 0 is what `createOverlay` stamps on an overlay that holds nothing, so
         * it is the honest revision for a corpus with nothing in it — carrying
         * the last-seen number forward would report progress that no longer has
         * anything behind it. */
        revision: 0,
        documents: {},
      })
      hydratedToken = ABSENT_TOKEN
      return
    }

    const token = corpusToken(current)
    if (token === hydratedToken) return
    manifest = current
    state = await hydrate(store, current)
    hydratedToken = token
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

  /**
   * Parse, with one narrowly-scoped retry.
   *
   * groq-js 2.0.0 rejects a parameterised slice (`[0...$__limit]`), which every
   * findability query ends with. The retry substitutes integer parameters into
   * slice endpoints and parses again. It runs ONLY after a real parse failure,
   * so a query groq-js accepts is never rewritten.
   */
  function parseQuery(source, params) {
    try {
      return parseGroq(source)
    } catch (cause) {
      const substituted = substituteSliceParameters(source, params)
      if (substituted !== source) {
        try {
          return parseGroq(substituted)
        } catch {
          /* fall through to the original, more informative error */
        }
      }
      throw new OriginError(400, 'OVERLAY_ORIGIN_INVALID_GROQ', `GROQ parse error: ${cause.message}`)
    }
  }

  async function runQuery(queryText, params) {
    const source = String(queryText)
    const tree = parseQuery(source, params)
    const documents = datasetDocuments()

    /* Sub-expression evaluation for the findability resolver: same corpus, same
     * parameters, one document as `@`. */
    const evaluateNode = async (node, {root, params: extra} = {}) => {
      const value = await evaluateGroq(node, {
        dataset: documents,
        params: extra === undefined ? params : {...params, ...extra},
        ...(root === undefined ? {} : {root}),
      })
      return value.get()
    }

    const prepared = await resolveTextQueries(tree, params, documents, evaluateNode)

    const startedAt = Date.now()
    const value = await evaluateGroq(prepared.tree, {
      dataset: documents,
      params: {...params, ...prepared.params},
    })
    const result = await value.get()
    const answer = {ms: Date.now() - startedAt, query: source, result}
    if (prepared.approximations.length > 0) {
      /* PRD §5.5: an approximation may never be silent. It rides in the body so
       * a browser devtools panel shows it, and on the log so a terminal does. */
      answer.overlayApproximation = prepared.approximations
      for (const entry of prepared.approximations) {
        log(
          'warn',
          `approximated ${entry.function} for term ${JSON.stringify(entry.term)} — ` +
            `${entry.matched} local match(es); hosted ranking is not reproduced`,
        )
      }
    }
    return answer
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
    /*
     * THE WRITE PATH READS THE PROJECTION TOO, and a stale one here is worse
     * than a stale read: `apply` builds the next document from `state`, so an
     * ancestor this process last saw at boot is content SILENTLY overwritten
     * rather than merely content not shown. Refreshed inside `commit`, which
     * means inside `enqueue`'s serialisation — so the projection cannot move
     * between this line and the `store.commitTransaction` below.
     *
     * Deliberately NOT hoisted into the route table beside the read refresh:
     * `assertWriteIsNotForged` runs before a body is read precisely so a forged
     * request costs the server nothing, and a manifest read in front of it would
     * spend work on exactly the caller that control exists to reject.
     */
    await refreshFromDisk()

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
    /* Before the body is read, so a forged request costs the server nothing. */
    assertWriteIsNotForged(request, allowedOrigins)
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
    /* Before the body is read, so a forged request costs the server nothing. */
    assertWriteIsNotForged(request, allowedOrigins)
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

        /*
         * THE ONE PLACE A READ LEARNS WHAT IS ON DISK.
         *
         * `query` and `doc` are the two routes that project `state`; `listen`
         * opens a socket, `history` is a constant, and `mutate`/`actions`
         * refresh inside `commit` behind their own CSRF gate. Naming the two
         * rather than refreshing the whole `data` case keeps the write guard's
         * "a forged request costs the server nothing" property intact.
         */
        if (operation === 'query' || operation === 'doc') await refreshFromDisk()

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
             * has no *Content Lake* history, because it has never been there.
             *
             * `historyAnswer` returns a whole answer, not a body: one of these
             * three endpoints is NDJSON and wrapping it in `jsonAnswer` is the
             * bug this route used to have. */
            return historyAnswer(tail)
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

  /**
   * `<ids>` as Studio spells it: `ids.join(',')`, percent-encoded, possibly
   * spread over the remaining path segments.
   */
  function historyDocumentIds(segments) {
    return String(segments.join('/'))
      .split(',')
      .map((id) => {
        try {
          return decodeURIComponent(id)
        } catch {
          /* A malformed escape is still the id the caller asked about. */
          return id
        }
      })
      .filter((id) => id !== '')
  }

  /**
   * The three history reads — THREE SHAPES, and two wire formats. Each one is
   * dictated by how `sanity@6.8.0` decodes it, cited at the call site; every
   * "obvious" empty answer here crashes a pane.
   */
  function historyAnswer(tail) {
    /* NDJSON, and empty means empty. See {@link EMPTY_TRANSLOG_NDJSON}. */
    if (tail[0] === 'transactions') {
      return {status: 200, raw: EMPTY_TRANSLOG_NDJSON, contentType: NDJSON_CONTENT_TYPE}
    }

    /* `useBundleDocuments-BYW8M9LS.js:5006` reads
     * `response.events[documentId]?.map(…) || []`, so `events` is an OBJECT
     * KEYED BY DOCUMENT ID. `{events: []}` is not a smaller version of that
     * shape, it is a different one: the `?.` hides it at the call site, so the
     * pane shows nothing and reports nothing. `nextCursor` must be a string or
     * `loadMore` is handed `undefined` as a cursor. */
    if (tail[0] === 'events') {
      const events = {}
      /* `events/documents/<ids>` is the spelling Studio sends; `events/<ids>`
       * is accepted rather than 404'd, because the id list is the instruction
       * and the extra segment is not. */
      const rest = tail[1] === 'documents' ? tail.slice(2) : tail.slice(1)
      for (const id of historyDocumentIds(rest)) events[id] = []
      return jsonAnswer({events, nextCursor: ''})
    }

    /* `useBundleDocuments-BYW8M9LS.js:5101` reads `response.documents[0]` with
     * NO optional chaining, so the envelope is not optional. */
    return jsonAnswer({documents: []})
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
    /* Sanitised once, so the success path, the stream path and the error path
     * cannot disagree about who was granted what. */
    const cors = grantedCorsHeaders(request, context?.cors ?? {}, allowedOrigins)
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

      /**
       * A body that is NOT JSON.
       *
       * One route needs it — the NDJSON transaction log — and it needs it badly
       * enough that serving it through `JSON.stringify` is a Studio crash (see
       * {@link EMPTY_TRANSLOG_NDJSON}). The answer carries its own bytes and its
       * own content type; everything else about the response is unchanged, so
       * the CORS sanitisation above still applies to it.
       */
      if (typeof answer.raw === 'string') {
        const bytes = Buffer.from(answer.raw, 'utf8')
        response.writeHead(answer.status ?? 200, {
          ...cors,
          'content-type': answer.contentType ?? 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': bytes.length,
        })
        response.end(bytes)
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
      const code = error instanceof OriginError ? error.code : 'OVERLAY_ORIGIN_ERROR'

      /**
       * WHICH GATE REFUSED THIS, RECORDED WHERE `proxy.mjs` CAN LOG IT.
       *
       * This is the single chokepoint that turns an `OriginError` into a status,
       * so it is the only place that knows. The proxy logs it as `refusal`
       * alongside `disposition: 'local'`, which is what turns
       *
       *     POST /v…/data/mutate/parity → 415
       *
       * from something the network audit reported as an ESCAPED WRITE (it read
       * `blocked !== true` as "forwarded to Sanity") into
       *
       *     …status: 415, disposition: 'local', gate: 'origin',
       *       refusal: 'OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE'
       *
       * A PLAIN PROPERTY, DELIBERATELY NOT A RESPONSE HEADER. The wire format of
       * a security-sensitive origin should not change to carry a log field, and
       * a header would additionally hand every browser client the name of the
       * control that stopped it. The property never leaves this process.
       */
      response.overlayRefusalCode = code

      const payload = JSON.stringify({
        error: {
          code,
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
