/**
 * The default-deny write guard, **packaged**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * The only control in this project that genuinely *stops* a write today lives in
 * `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs`. It is a local Node
 * process, reachable from an example, importable by nothing. **In a deployed
 * preview the proxy does not exist**, so every control that depends on it —
 * default-deny classification, dot-segment normalisation, the WebSocket leg —
 * is local-dev only.
 *
 * This is that classifier as a package export, so the deployment's own origin
 * can run the identical policy server-side. It is behaviourally pinned to the
 * example by `runWriteGuardContract` (`sanity-overlay-testkit`), the same
 * contract the proxy passes: two implementations, one contract, no room for
 * them to drift apart quietly. P1-1 is why that matters — the truncation bug
 * was present in both, identically, and only a shared contract case could have
 * caught it in both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE POLICY: DEFAULT-DENY
 *
 * Not "is this one of the writers I know about?" but **"is this one of the reads
 * I know about?"** — and if it is not, it is a write and it is blocked. Spike F
 * is the reason: `POST /projects/<p>/tokens`, `PUT /users/me/keyvalue/<k>`,
 * `POST /schedules/<p>/<d>`, `POST /descriptors/claim` and `POST /intake/batch`
 * all sailed through an enumerate-the-writers guard, none of them under a
 * guarded prefix. No amount of extending that list catches the class; only its
 * complement does.
 *
 * The read allowlist is derived from two independent sources, never invented:
 * `@sanity/client@7.26.0`'s URL builders, and 422 real request lines from a live
 * Studio session in `spikeB-proxy/proxy-log.jsonl`. Blocking a read the Studio
 * really performs breaks the Studio loudly and in one place; allowing a write we
 * have never heard of corrupts the dataset silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT CANNOT DO
 *
 * It classifies request lines. It cannot see a stolen token (Spike F attack 27),
 * and `GET /projects/<p>/tokens` — listing credentials — is a read by this
 * definition and passes. Credential containment is a separate control: no
 * write-capable credential in the preview environment (`options.ts`
 * `assertNoWriteToken`) and a read-only token on the server side.
 *
 * Dependency-free on purpose: it must run in a route handler, in an edge
 * runtime, in Node and in a test.
 */

/** `/v2025-02-19`, `/v1`, `/vX` — stripped so rules are version-agnostic. */
const API_VERSION_PREFIX = /^\/v(?:\d{4}-\d{2}-\d{2}|\d+|x)(?=\/|$)/

/** `/projects/<projectId>/datasets/<dataset>` — `resourceDataBase()` case 'dataset'. */
const PROJECT_DATASET_BASE = /^\/projects\/[^/]+\/datasets\/[^/]+(\/.*)?$/

/** `/canvases/<id>`, `/media-libraries/<id>`, `/dashboards/<id>` — the other bases. */
const RESOURCE_BASE = /^\/(?:canvases|media-libraries|dashboards)\/[^/]+(\/.*)?$/

/**
 * Operations with NO read semantics — a write whatever verb carries them, so
 * `GET /data/mutate/<ds>` is blocked as the probe it is. `/upload` is
 * `buildAssetUploadUrl()`'s media-library form.
 */
const NO_READ_OPS = ['/mutate', '/actions', '/upload']

/** Agent Actions that reach Content Lake: `/agent/action/<verb>/<dataset>`. */
const AGENT_WRITE_ACTIONS = new Set(['patch', 'generate', 'transform', 'translate', 'prompt'])

/**
 * Data-plane operations with read semantics, relative to `/data` or a resource
 * base.
 *
 * `/references` is the referring-documents index the delete-confirm dialog
 * reads (`sanity@6.8.0 structureTool-EN0gOzyJ.js:762`). It is a GET over an
 * index and writes nothing; it is absent from the evidence log this list was
 * otherwise built from because the probe is gated behind an existence check
 * that used to answer "absent" for everything. See the long note on the same
 * constant in `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs` — the two
 * lists are under one contract and must not drift.
 */
const READ_DATA_OPS = [
  '/query',
  '/doc',
  '/listen',
  '/history',
  '/references',
  '/export',
  '/live/events',
  '/ping',
]

/**
 * Data-plane reads that legitimately arrive over POST: `_dataRequest()` falls
 * back to `POST /data/query` when a GROQ query is too long for a URL.
 */
const POST_READ_DATA_OPS = ['/query']

/** Resource-scoped tails that are console metadata reads, not data operations. */
const READ_RESOURCE_OPS = ['/acl', '/settings']

/**
 * Root-scope namespaces whose GET/HEAD traffic is a read. Every entry is a
 * namespace observed in `proxy-log.jsonl` or a documented read API.
 */
const READ_ROOT_PREFIXES = [
  '/ping',
  '/help',
  '/features',
  '/journey',
  '/intake/telemetry-status' /* the POST sibling /intake/batch is deliberately absent */,
  '/socket',
  '/schedules',
  /* Login-screen reads: GET /auth/providers (the first request an
   * unauthenticated Studio makes) and GET /auth/fetch?sid=… (login
   * completion). Observed live 2026-08-11 — every earlier recorded session
   * already carried a session, so the login flow had never been exercised.
   * POST /auth/logout stays a write and stays blocked. */
  '/auth',
  '/users',
  '/projects',
  '/datasets',
  '/assets',
]

/** `/agent/<id>/bundles/…` — the agent bundle listener. Narrowly scoped. */
const AGENT_BUNDLES_READ = /^\/agent\/[^/]+\/bundles(?:\/|$)/

/** Methods that can carry a read at all. Everything else is a write, always. */
const READ_METHODS = new Set(['GET', 'HEAD'])

/* ------------------------------------------------------------ normalisation */

function cutAt(value: string, marker: string): string {
  const index = value.indexOf(marker)
  return index === -1 ? value : value.slice(0, index)
}

/**
 * `decodeURIComponent` throws on a malformed escape (`%zz`). A guard that throws
 * is a guard that fails open, so fall back to decoding only the well-formed
 * triplets and leaving the rest verbatim.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value.replace(/%[0-9a-fA-F]{2}/g, (triplet) => {
      try {
        return decodeURIComponent(triplet)
      } catch {
        return triplet
      }
    })
  }
}

/**
 * RFC 3986 §5.2.4 remove_dot_segments, minus the leading-slash escape.
 *
 * Reports whether it had anything to do, because that fact is load-bearing —
 * a path that needed dot segments resolved is a path whose meaning depends on
 * who is resolving it.
 */
function resolveDotSegments(path: string): {path: string; sawDotSegment: boolean} {
  const out: string[] = []
  let sawDotSegment = false
  for (const segment of path.split('/')) {
    if (segment === '.') {
      sawDotSegment = true
      continue
    }
    if (segment === '..') {
      sawDotSegment = true
      /* Never pop the leading empty segment: `/../x` must stay rooted at `/x`. */
      if (out.length > 1) out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  return {path: joined.startsWith('/') ? joined : `/${joined}`, sawDotSegment}
}

/**
 * Canonicalise whatever the caller passed into a single comparable path.
 *
 * `//data/mutate/ds` is treated as a duplicated slash, NOT as a protocol-relative
 * URL: the input is a proxy request line, where `//x` is a path, and reading it
 * as an authority would silently discard the endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CUT ONCE, ON THE RAW LINE (security review 2026-08-06, P1-1)
 *
 * This function used to re-cut at `?`/`#` after every decode pass, claiming that
 * repeated decoding could "only ever make the guard stricter". A percent-encoded
 * `?` is a PATH CHARACTER (RFC 3986 §3.3), so decoding it and cutting there
 * discards path — including the `..` segments `readReason` step 0 exists to
 * refuse. `POST /data/query%3F/../actions/<ds>` classified as a GROQ read while
 * `remove_dot_segments` over the untouched request line resolves it to
 * `/data/actions/<ds>`.
 *
 * That mattered most HERE. In a deployed preview there is no proxy behind this
 * classifier — `preview-write-impossibility.md` §6 nominates it as the only
 * door — so the cut now happens exactly once, against the bytes as received.
 *
 * A literal `#` is still cut (the independent audit allowlist cuts there too),
 * but the truncation itself is recorded: `#` is not legal in an origin-form
 * request target, servers relay it verbatim, and the discarded tail can carry
 * `../data/mutate/<ds>`. A `#` after a `?` is inside the query string, reaches
 * nobody's path, and is left alone.
 */
function analysePath(rawUrl: unknown): {
  path: string
  dotSegments: boolean
  fragmentTruncated: boolean
} {
  let path = typeof rawUrl === 'string' ? rawUrl : String(rawUrl ?? '')

  /* Absolute URL: drop scheme + authority, keep the path. */
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(path)
  if (scheme) {
    const afterScheme = path.slice(scheme[0].length)
    const firstSlash = afterScheme.indexOf('/')
    path = firstSlash === -1 ? '/' : afterScheme.slice(firstSlash)
  }

  /* The ONE cut, on the raw request line. */
  const hashIndex = path.indexOf('#')
  const queryIndex = path.indexOf('?')
  const fragmentTruncated = hashIndex !== -1 && (queryIndex === -1 || hashIndex < queryIndex)
  path = cutAt(cutAt(path, '#'), '?')

  /* Decode to a fixed point (bounded). NOTHING is cut again: a delimiter that
   * only appears after decoding was percent-encoded on the wire, which makes it
   * an ordinary path character to everyone downstream. */
  for (let pass = 0; pass < 5; pass++) {
    const decoded = safeDecode(path)
    if (decoded === path) break
    path = decoded
  }

  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/{2,}/g, '/')
  const resolved = resolveDotSegments(path)
  path = resolved.path.toLowerCase()

  let version = API_VERSION_PREFIX.exec(path)
  while (version) {
    path = path.slice(version[0].length) || '/'
    version = API_VERSION_PREFIX.exec(path)
  }

  if (path.length > 1) path = path.replace(/\/+$/, '') || '/'
  return {path, dotSegments: resolved.sawDotSegment, fragmentTruncated}
}

/** The canonical path alone: lower-case, rooted, version-stripped. */
export function normalizePreviewPath(rawUrl: unknown): string {
  return analysePath(rawUrl).path
}

/* ---------------------------------------------------------- classification */

/** Segment-aware prefix test: `/datasets` must not match `/data`. */
function hasSegmentPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => hasSegmentPrefix(path, prefix))
}

function splitScope(path: string): {scope: 'data' | 'resource' | 'root'; tail: string} {
  if (path === '/data') return {scope: 'data', tail: ''}
  if (path.startsWith('/data/')) return {scope: 'data', tail: path.slice('/data'.length)}

  const projectDataset = PROJECT_DATASET_BASE.exec(path)
  if (projectDataset) return {scope: 'resource', tail: projectDataset[1] || ''}

  const resource = RESOURCE_BASE.exec(path)
  if (resource) return {scope: 'resource', tail: resource[1] || ''}

  return {scope: 'root', tail: path}
}

/** `/agent/action/{patch,generate,transform,translate,prompt}/<dataset>`. */
function isAgentWriteAction(path: string): boolean {
  const segments = path.split('/')
  return segments[1] === 'agent' && segments[2] === 'action' && AGENT_WRITE_ACTIONS.has(segments[3])
}

/**
 * The allowlist itself. A reason string when the request is a recognised read,
 * `null` when it is not — and "not" is the answer for every path this function
 * has never been told about.
 */
function readReason(
  verb: string,
  path: string,
  dotSegments: boolean,
  fragmentTruncated: boolean,
): string | null {
  if (verb === 'OPTIONS') return 'CORS preflight is never a write'

  /* 0a. A request line whose PATH was truncated at a literal `#` is never a
   *     read: this classifier saw the head, the server relays the whole thing,
   *     and the tail is free to carry `../data/mutate/<ds>`. */
  if (fragmentTruncated) return null

  /* 0. A path that needed `.`/`..` resolved is never a read.
   *
   *    Resolving dot segments is what lets the guard see through
   *    `/x/../data/mutate/<ds>`. It also runs the other way:
   *    `/data/mutate/<ds>/../../query/<ds>` canonicalises to a read while the
   *    request line still says mutate, and a proxy forwards the RAW request
   *    line — so the guard would be agreeing to a read that Content Lake may
   *    route as a write. A request with two possible meanings is exactly what
   *    default-deny is for, and no URL @sanity/client builds contains a dot
   *    segment, so no read is lost. */
  if (dotSegments) return null

  const {scope, tail} = splitScope(path)
  const isReadMethod = READ_METHODS.has(verb)

  /* 1. Endpoints with no read semantics at all — checked BEFORE the method, so
   *    a GET probe at /data/mutate or /agent/action/patch is still a write. */
  if (startsWithAny(tail, NO_READ_OPS)) return null
  if (isAgentWriteAction(path)) return null

  /* 2. The data plane and the resource-scoped data plane are operation-strict:
   *    the op must be a named read, not merely "not a known write". */
  if (scope === 'data' || scope === 'resource') {
    if (isReadMethod && startsWithAny(tail, READ_DATA_OPS)) return 'data-plane read operation'
    if (verb === 'POST' && startsWithAny(tail, POST_READ_DATA_OPS)) {
      return 'GROQ over POST (long-query fallback)'
    }
    if (scope !== 'resource' || !isReadMethod) return null
    if (tail === '' || startsWithAny(tail, READ_RESOURCE_OPS)) return 'resource metadata read'
    return null
  }

  /* 3. Root scope: a recognised read namespace, GET/HEAD only. */
  if (!isReadMethod) return null
  if (startsWithAny(path, READ_ROOT_PREFIXES)) return 'allowlisted read namespace'
  if (AGENT_BUNDLES_READ.test(path)) return 'agent bundle listener'

  /* 4. Default deny. Silence is not consent. */
  return null
}

export interface PreviewGuardRequest {
  method?: unknown
  url?: unknown
}

export interface PreviewGuardVerdict {
  write: boolean
  /** The canonical path the guard matched on, not the one the caller sent. */
  path: string
  reason: string
}

/**
 * Classify a request AND say why.
 *
 * Under default-deny a 403 no longer means "you hit a known write endpoint", it
 * means "nothing on the allowlist matched" — and those are very different things
 * to debug. A server should put `reason` and `path` in its log line and in the
 * 403 body.
 */
export function classifyPreviewRequest(request: PreviewGuardRequest): PreviewGuardVerdict {
  const verb = String(request?.method ?? '').toUpperCase()
  const {path, dotSegments, fragmentTruncated} = analysePath(request?.url)
  const reason = readReason(verb, path, dotSegments, fragmentTruncated)
  if (reason !== null) return {write: false, path, reason}
  if (dotSegments) {
    return {
      write: true,
      path,
      reason:
        'path carries "." or ".." segments, so the proxy and Content Lake could ' +
        'read it differently — never a read (default-deny)',
    }
  }
  if (fragmentTruncated) {
    return {
      write: true,
      path,
      reason:
        'the request line carries a literal "#" in its path, so the guard and the ' +
        'upstream see different paths — never a read (default-deny)',
    }
  }
  return {write: true, path, reason: 'not on the read allowlist (default-deny)'}
}

/** Does this request write to Content Lake? Default-deny by construction. */
export function isPreviewWriteRequest(request: PreviewGuardRequest): boolean {
  return classifyPreviewRequest(request).write
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * the realtime leg — `/socket/<dataset>` past the 101
 * ══════════════════════════════════════════════════════════════════════════ *
 *
 * `/socket` is on the read allowlist, so the handshake passes and a proxy
 * upgrades. What is an allowlisted upgrade a tunnel TO?
 *
 * Read out of the vendored source, not guessed: `sanity@6.8.0`
 * `lib/WorkspaceLoader-BRx2afZV.js:8300-8303` builds
 * `wss://<p>.api.sanity.io/v2022-06-30/socket/<ds>?tag=sanity.studio` and hands
 * it to `fromUrl` from `@sanity/bifur-client@1.0.0` — a generic JSON-RPC 2.0
 * request/response channel, not a one-way stream. Its `RequestMethod` union
 * (`src/types.ts:6-15`) is `'doc' | 'query' | 'mutate' | 'presence_rollcall' |
 * 'presence_announce' | 'presence_disconnect' | 'authorization'`.
 *
 * **`'mutate'` is a declared client request method on this socket.** No shipped
 * code path calls it, but the bifur client is exposed to page JS as
 * `__internal.bifur` (`lib/datastores-DqFH7RLd.js:7958`) and nothing between
 * that object and Content Lake checks anything. So the channel could not be
 * proven read-only, and the same policy that governs the request line governs
 * the frames.
 *
 * NOTE FOR A DEPLOYED PREVIEW: frame inspection needs raw socket access, which a
 * serverless function does not have. Where the runtime cannot proxy a WebSocket,
 * the only available control is to refuse the connection — CSP `connect-src`
 * excluding `wss://*.api.sanity.io`, plus the browser barrier. Studio loses
 * presence; it does not lose editing.
 */

/**
 * JSON-RPC methods the bifur client legitimately sends. Every entry is a member
 * of `RequestMethod`/`SubscribeMethods` with a read or ephemeral-session
 * meaning. Presence writes ephemeral session state, not documents.
 * Deliberately ABSENT: `mutate`.
 */
const READ_RPC_METHODS = [
  'authorization',
  'presence',
  'presence_rollcall',
  'presence_announce',
  'presence_disconnect',
  'listen',
  'doc',
  'query',
] as const

/**
 * `listen(m)` sends `` `${m}_subscribe` `` and its teardown `` `${m}_unsubscribe` ``,
 * but ONLY for the three members of `SubscribeMethods`. Enumerated from that set
 * rather than computed by stripping a suffix off whatever arrived: a strip rule
 * would accept `doc_subscribe`, which is not a wire method.
 */
const SUBSCRIBE_RPC_METHODS = ['presence', 'listen', 'authorization'] as const

/** The complete set of method tokens a client may put on the wire. */
export const ALLOWED_REALTIME_RPC_METHODS: ReadonlySet<string> = new Set<string>([
  ...READ_RPC_METHODS,
  ...SUBSCRIBE_RPC_METHODS.flatMap((method) => [`${method}_subscribe`, `${method}_unsubscribe`]),
])

/**
 * Classify one JSON-RPC method name from a client frame.
 *
 * NOT trimmed, NOT lower-cased, NOT suffix-stripped: JSON-RPC method names are
 * exact tokens, so `  mutate  `, `MUTATE` and `mutate_subscribe` are simply not
 * methods this client sends. Every loosening of this comparison widens the
 * allowlist and none of them narrows it.
 */
export function classifyRealtimeRpcMethod(method: unknown): {write: boolean; reason: string} {
  if (typeof method !== 'string' || method.length === 0) {
    return {write: true, reason: 'frame carries no JSON-RPC method (default-deny)'}
  }
  if (ALLOWED_REALTIME_RPC_METHODS.has(method)) {
    return {write: false, reason: `allowlisted RPC method ${method}`}
  }
  return {write: true, reason: `RPC method ${JSON.stringify(method)} is not an allowlisted read`}
}
