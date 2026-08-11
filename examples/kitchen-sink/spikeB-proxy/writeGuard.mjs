/**
 * The overlay write guard — the single place that answers "does this request
 * write to Content Lake?" (PRD §36.1 Track B: "reject unknown write-capable
 * endpoints"; §35.14 security suite).
 *
 * Extracted from `proxy.mjs` so the classification is testable on its own and
 * so exactly one implementation is under contract. Its behaviour is pinned by
 * `packages/sanity-overlay-testkit/src/writeGuardContract.ts`, which any other
 * guard in this project must also pass.
 *
 * THE POLICY: DEFAULT-DENY
 * ------------------------
 * Spike F (docs/plans/evidence/phase-1/spike-f-safety-boundary/report.md) is
 * the reason this file exists, and the second round of Spike F review is the
 * reason it is shaped like this. The first fix enumerated the write endpoints
 * — `/data/*`, `/assets/*`, `/agent/*`, `/datasets/*` — and failed closed
 * inside them. That is still a default-ALLOW guard: it assumes its author has
 * heard of every write endpoint Sanity ships. They had not. All of these were
 * waved straight through by the enumerate-the-writers design:
 *
 *   POST /projects/<p>/tokens                mints a write-capable credential
 *   PUT  /users/me/keyvalue/<key>            Studio preference writes
 *   POST /schedules/<p>/<dataset>            a deferred document publish
 *   POST /descriptors/claim                  observed 3x, HTTP 200, in the log
 *   POST /intake/batch                       telemetry egress from a branch build
 *   PATCH/DELETE /projects/<p>               project administration
 *
 * None of them lives under a guarded prefix, and no amount of extending the
 * list would have caught the *class* — only its complement would.
 *
 * So the question the guard asks is inverted. Not "is this one of the writers
 * I know about?" but **"is this one of the reads I know about?"** — and if it
 * is not, it is a write and it is blocked. `isWriteRequest` is therefore
 * `!isAllowedRead(...)` and nothing else. Adding an endpoint to READ_* below is
 * the only way to open a hole, which makes every hole a reviewable diff.
 *
 * WHERE THE ALLOWLIST COMES FROM
 * ------------------------------
 * Two independent sources, neither of them memory:
 *   1. `proxy-log.jsonl` — 422 real request lines from a live Studio session
 *      through this proxy. Every GET namespace in that log is represented.
 *   2. The `@sanity/client@7.26.0` URL-builder inventory (`uri:` literals,
 *      `_getDataUrl`, `buildAssetUploadUrl`, `resourceDataBase`), which is how
 *      the resource-scoped data plane (`/projects/<p>/datasets/<d>/mutate`,
 *      `/canvases/<id>/…`) got covered without ever appearing in the log.
 *
 * FIVE RULINGS, ALL FAIL-CLOSED
 * -----------------------------
 *   - `OPTIONS` is never a write. CORS preflight must succeed or the browser
 *     never delivers the 403 that follows, and the developer sees a CORS error
 *     instead of "blocked by the overlay proxy".
 *   - `GET`/`HEAD` are allowlist-only, exactly like every other verb. An
 *     unknown path is blocked whatever the verb.
 *     TRADEOFF, accepted deliberately: a Sanity read endpoint that nobody has
 *     observed yet returns 403 until someone adds it below. That failure is
 *     loud, local, and one log line away from a fix. The other direction —
 *     "GET is probably safe" — reinstates precisely the assumption Spike F
 *     destroyed, that a writer can be recognised by looking at it. `GET
 *     /data/mutate/<ds>` and `GET /agent/action/patch/<ds>` are the standing
 *     proof that it cannot: those endpoints have no read semantics at all.
 *   - Within `/data/*` and the resource-scoped data plane the *operation* must
 *     also be a recognised read (`GET /data/frobnicate` is blocked), because
 *     that plane is where writers actually live. Outside it, a recognised
 *     namespace plus GET/HEAD is enough — those planes put their writes behind
 *     non-GET verbs, which default-deny already catches.
 *   - A path carrying `.` or `..` segments is never a read. The guard matches a
 *     canonical path; the proxy forwards the RAW request line. Resolving dot
 *     segments closes `/x/../data/mutate/<ds>`, but it opens the mirror image —
 *     `/data/mutate/<ds>/../../query/<ds>` canonicalises to a read while the
 *     bytes on the wire still say `mutate`, and `<write>/../../../../../../ping`
 *     launders any write endpoint at all into an allowlisted GET. Whether
 *     Content Lake resolves those the same way is not knowable from here, and a
 *     request with two possible meanings is exactly what default-deny is for.
 *     Nothing @sanity/client builds contains a dot segment, so no read is lost.
 *   - A request line whose PATH is truncated at a literal `#` is never a read,
 *     for the same reason: the guard classifies the head, `proxy.mjs` forwards
 *     `pathname + search` and `splitPath` only cuts at `?`, so the tail travels
 *     upstream where it can spell `../data/mutate/<ds>`. A `#` after a `?` is
 *     query text on both sides and is left alone (security review 2026-08-06,
 *     P1-1). See `analysePath` for why the `?`/`#` cut happens exactly once.
 *
 * WHAT THIS GUARD DOES NOT DO
 * ---------------------------
 * It classifies request lines. It cannot see a stolen token (Spike F attack
 * 27), and `GET /projects/<p>/tokens` — listing credentials — is a read by
 * this definition and passes. Credential containment is §5.2's job (no
 * write-capable credential in the preview) and the CI token scan's (§11.3).
 */

/** `/v2025-02-19`, `/v1`, `/vX` — stripped so rules are version-agnostic. */
const API_VERSION_PREFIX = /^\/v(?:\d{4}-\d{2}-\d{2}|\d+|x)(?=\/|$)/

/** `/projects/<projectId>/datasets/<dataset>` — `resourceDataBase()` case 'dataset'. */
const PROJECT_DATASET_BASE = /^\/projects\/[^/]+\/datasets\/[^/]+(\/.*)?$/

/** `/canvases/<id>`, `/media-libraries/<id>`, `/dashboards/<id>` — the other resource bases. */
const RESOURCE_BASE = /^\/(?:canvases|media-libraries|dashboards)\/[^/]+(\/.*)?$/

/**
 * Operations with NO read semantics — a write whatever verb carries them, so
 * `GET /data/mutate/<ds>` is blocked as the probe it is.
 * `/upload` is `buildAssetUploadUrl()`'s media-library form.
 */
const NO_READ_OPS = ['/mutate', '/actions', '/upload']

/** Agent Actions that reach Content Lake: `/agent/action/<verb>/<dataset>`. */
const AGENT_WRITE_ACTIONS = new Set(['patch', 'generate', 'transform', 'translate', 'prompt'])

/* ------------------------------------------------------------------ *
 * the read allowlist — the only thing that is not a write
 * ------------------------------------------------------------------ */

/**
 * Data-plane operations with read semantics, relative to `/data` or to a
 * resource base. Sources: `_getDataUrl()` in @sanity/client, and the GET
 * traffic in proxy-log.jsonl (`/data/query` x54, `/data/listen` x26,
 * `/data/doc` x8, `/data/history` x16, `/data/ping` x3).
 *
 * `/references` IS NOT IN THAT LOG, AND THAT IS THE INTERESTING PART.
 * ------------------------------------------------------------------
 * `sanity@6.8.0 lib/structureTool-EN0gOzyJ.js:762` issues
 *   `GET /data/references/<ds>/documents/<id>/to?excludeInternalReferences=true&excludePaths=true`
 * from the delete-confirm dialog, to list the documents still pointing at the
 * one being removed. It reads an index and writes nothing.
 *
 * It is absent from the 422-line evidence log because the probe is GATED behind
 * `getDocumentExistence`, and in Mode 2 that answered "absent" for every id
 * until the overlay learned to answer it from branch state. So the allowlist
 * gap was unreachable, and it opened the moment a NEIGHBOURING component
 * started telling the truth: `GET …/references/… -> 403 OVERLAY_WRITE_BLOCKED`,
 * a React error boundary tearing down the document pane, and Delete and
 * Unpublish silently never writing a tombstone (four E2E specs, 2026-08-10).
 *
 * The lesson is in the guard's own header: an allowlist built from observed
 * traffic is only as complete as what the observation could reach. The
 * derived check in `packages/sanity-overlay-testkit/test/write-guard.test.ts`
 * enumerates `/data/<op>` out of the shipped Studio bundle instead, so the next
 * one of these fails by name rather than as a 403 in someone's browser.
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
 * back to `POST /data/query` when a GROQ query is too long for a URL. Nothing
 * else may use a write verb and still be a read.
 */
const POST_READ_DATA_OPS = ['/query']

/**
 * Resource-scoped tails that are console metadata reads rather than data-plane
 * operations. `/acl` is observed in the log (`GET /projects/<p>/datasets/<d>/acl`
 * x3); `/settings` is the read side of `settings/embeddings`, whose PUT is a
 * write and is blocked. The base itself (empty tail) is dataset/canvas
 * metadata. Nothing goes in this list that has not been seen or read out of
 * the client source — inventing entries is how a default-deny guard rots.
 */
const READ_RESOURCE_OPS = ['/acl', '/settings']

/**
 * Root-scope namespaces whose GET/HEAD traffic is a read. Every entry is a
 * namespace observed in proxy-log.jsonl or a documented read API; the count is
 * the live-session occurrence.
 */
const READ_ROOT_PREFIXES = [
  '/ping', //                     x22 across three API versions — health check
  '/help', //                     x2  — /v1/help
  '/features', //                 x3  — feature flags
  '/journey', //                  x27 — trial/announcements/limits banners
  '/intake/telemetry-status', //  x1  — telemetry opt-in state (the POST sibling
  //                                    /intake/batch is deliberately NOT here)
  '/socket', //                   x38 — the presence WebSocket upgrade (a GET)
  '/schedules', //                x3  — scheduled-publishing list; POST/PUT/DELETE
  //                                    on the same path are writes and are blocked
  '/auth', //                     login-screen reads: GET /auth/providers (the first
  //                                    request an unauthenticated Studio makes) and
  //                                    GET /auth/fetch?sid=… (login completion).
  //                                    Absent from every recorded session because they
  //                                    all carried a session already; observed live
  //                                    2026-08-11. POST /auth/logout stays a write.
  '/users', //                    x12 — /users/me and /users/me/keyvalue/<k> reads
  '/projects', //                 x21 — project metadata, grants, dataset list,
  //                                    user-applications
  '/datasets', //                 dataset list/metadata (DatasetsClient.list)
  '/assets', //                   asset DOWNLOAD; the upload is a POST and blocked
]

/**
 * `/agent/<id>/bundles/…` — the agent bundle listener, observed as
 * `GET /v2025-02-19/agent/oTu7RImef/bundles/mine/listen` x3. Narrowly scoped so
 * it cannot become a hole in the rest of `/agent/*`, which is all writes.
 */
const AGENT_BUNDLES_READ = /^\/agent\/[^/]+\/bundles(?:\/|$)/

/** Methods that can carry a read at all. Everything else is a write, always. */
const READ_METHODS = new Set(['GET', 'HEAD'])

/* ------------------------------------------------------------------ *
 * normalisation
 * ------------------------------------------------------------------ */

function cutAt(value, marker) {
  const index = value.indexOf(marker)
  return index === -1 ? value : value.slice(0, index)
}

/**
 * `decodeURIComponent` throws on a malformed escape (`%zz`). A guard that
 * throws is a guard that fails open, so fall back to decoding only the
 * well-formed triplets and leaving the rest verbatim.
 */
function safeDecode(value) {
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
 * see `readReason`. A path that needed dot segments resolved is a path whose
 * meaning depends on who is resolving it.
 */
function resolveDotSegments(path) {
  const out = []
  let sawDotSegment = false
  for (const segment of path.split('/')) {
    if (segment === '.') {
      sawDotSegment = true
      continue
    }
    if (segment === '..') {
      sawDotSegment = true
      // Never pop the leading empty segment: `/../x` must stay rooted at `/x`.
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
 * Accepts a request-line path (`/v2025-02-19/data/mutate/ds?tag=x`), a bare
 * client-style path (`data/mutate/ds`) or a fully-qualified URL.
 *
 * Note that `//data/mutate/ds` is treated as a duplicated slash, NOT as a
 * protocol-relative URL: the input this guard sees is a proxy request line,
 * where `//x` is a path, and reading it as an authority would silently discard
 * the endpoint.
 *
 * Matching a *canonical* path is the whole point — a rule set applied to an
 * attacker-chosen spelling is not a rule set (Spike F gap 20).
 *
 * CUT ONCE, ON THE RAW LINE (security review 2026-08-06, P1-1)
 * ------------------------------------------------------------
 * This function used to re-cut at `?`/`#` after every decode pass, on the
 * stated reasoning that "repeated decoding can only ever reveal more path, so
 * it can only ever make the guard stricter". That was false, and it was the
 * only genuine bypass the §5.5 review found in this classifier.
 *
 * A percent-encoded `?` is a PATH CHARACTER (RFC 3986 §3.3), not a delimiter.
 * Decoding `%3F` and then cutting there does not reveal path — it DISCARDS
 * path, and everything after it, including the `..` segments that `readReason`
 * step 0 exists to refuse:
 *
 *     POST /data/query%3F/../actions/<ds>
 *          re-cut  -> /data/query           -> "GROQ over POST", allowed
 *          on the wire, unchanged, and RFC 3986 §5.2.4 `remove_dot_segments`
 *          resolves the raw bytes to /data/actions/<ds> — the Studio write API.
 *
 * So the cut happens exactly once, against the bytes the proxy actually
 * received, and every later pass may only ever add to what the guard can see.
 * The contract's `encoded-delimiter` group is the permanent statement of this.
 *
 * A LITERAL `#` IS STILL CUT — AND THAT IS WHY IT IS AMBIGUOUS
 * -----------------------------------------------------------
 * Cutting at `#` on the raw line is right: `e2e/audit/readAllowlist.mjs` and
 * every URL parser do the same, and refusing to cut would put this guard and
 * the independent audit allowlist into disagreement. But `#` is not legal in an
 * origin-form request target, Node's HTTP parser hands it through verbatim, and
 * `proxy.mjs` forwards `pathname + search` where `splitPath` only cuts at `?`.
 * The discarded text therefore DOES reach the upstream. That is the same "two
 * possible meanings" situation dot segments create, so it gets the same answer:
 * never a read. A `#` that appears AFTER a `?` lives inside the query string,
 * never reaches the path on either side, and is left alone — GROQ text is full
 * of them.
 *
 * @param {unknown} rawUrl
 * @returns {{path: string, dotSegments: boolean, fragmentTruncated: boolean}}
 *   the canonical path, plus the two ways producing it made the request mean
 *   two different things to the two ends of the proxy.
 */
function analysePath(rawUrl) {
  let path = typeof rawUrl === 'string' ? rawUrl : String(rawUrl ?? '')

  // Absolute URL: drop scheme + authority, keep the path.
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(path)
  if (scheme) {
    const afterScheme = path.slice(scheme[0].length)
    const firstSlash = afterScheme.indexOf('/')
    path = firstSlash === -1 ? '/' : afterScheme.slice(firstSlash)
  }

  // The ONE cut, on the raw request line. A `#` ahead of any `?` truncates the
  // PATH the guard classifies while the proxy relays the whole thing.
  const hashIndex = path.indexOf('#')
  const queryIndex = path.indexOf('?')
  const fragmentTruncated = hashIndex !== -1 && (queryIndex === -1 || hashIndex < queryIndex)
  path = cutAt(cutAt(path, '#'), '?')

  // Decode to a fixed point (bounded). NOTHING is cut again: a delimiter that
  // only appears after decoding was percent-encoded on the wire, which makes it
  // an ordinary path character to everyone downstream.
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

/**
 * The canonical path alone, for callers (and tests) that only need the string.
 *
 * @param {unknown} rawUrl
 * @returns {string} a lower-case, rooted, version-stripped path
 */
export function normalizePath(rawUrl) {
  return analysePath(rawUrl).path
}

/* ------------------------------------------------------------------ *
 * classification
 * ------------------------------------------------------------------ */

/** Segment-aware prefix test: `/datasets` must not match `/data`. */
function hasSegmentPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => hasSegmentPrefix(path, prefix))
}

/**
 * Split a normalised path into the scope that owns it and the data-plane
 * operation inside that scope.
 *
 * `/data/mutate/ds`                        -> {scope:'data',     tail:'/mutate/ds'}
 * `/projects/p/datasets/d/mutate`          -> {scope:'resource', tail:'/mutate'}
 * `/canvases/c1/assets/images`             -> {scope:'resource', tail:'/assets/images'}
 * `/assets/images/ds`                      -> {scope:'root',     tail:'/assets/images/ds'}
 */
function splitScope(path) {
  if (path === '/data') return {scope: 'data', tail: ''}
  if (path.startsWith('/data/')) return {scope: 'data', tail: path.slice('/data'.length)}

  const projectDataset = PROJECT_DATASET_BASE.exec(path)
  if (projectDataset) return {scope: 'resource', tail: projectDataset[1] || ''}

  const resource = RESOURCE_BASE.exec(path)
  if (resource) return {scope: 'resource', tail: resource[1] || ''}

  return {scope: 'root', tail: path}
}

/** `/agent/action/{patch,generate,transform,translate,prompt}/<dataset>`. */
function isAgentWriteAction(path) {
  const segments = path.split('/')
  return segments[1] === 'agent' && segments[2] === 'action' && AGENT_WRITE_ACTIONS.has(segments[3])
}

/**
 * The allowlist itself. Returns a reason string when the request is a
 * recognised read, or `null` when it is not — and "not" is the answer for
 * every path this function has never been told about.
 */
function readReason(verb, path, dotSegments, fragmentTruncated) {
  if (verb === 'OPTIONS') return 'CORS preflight is never a write'

  // 0a. A request line whose PATH was truncated at a literal `#` is never a
  //     read: the guard classified the head, the proxy forwards the whole
  //     thing, and the tail is free to carry `../data/mutate/<ds>`. Same
  //     ruling, same reason, as the dot-segment rule below.
  if (fragmentTruncated) return null

  // 0. A path that needed `.`/`..` resolved is never a read.
  //
  //    Resolving dot segments is what lets the guard see through `/x/../data/
  //    mutate/<ds>`. It also runs the other way: `/data/mutate/<ds>/../../query/
  //    <ds>` canonicalises to a read while the request line still says mutate,
  //    and the proxy forwards the RAW request line — so the guard would have
  //    been agreeing to a read that Content Lake may well route as a write.
  //    Which of the two is "correct" is not this file's call to make; a request
  //    whose meaning depends on who resolves it has no single meaning, and
  //    default-deny already says what to do with that. No URL @sanity/client
  //    builds contains a dot segment, so nothing legitimate is lost.
  if (dotSegments) return null

  const {scope, tail} = splitScope(path)
  const isReadMethod = READ_METHODS.has(verb)

  // 1. Endpoints with no read semantics at all — checked BEFORE the method, so
  //    a GET probe at /data/mutate or /agent/action/patch is still a write.
  if (startsWithAny(tail, NO_READ_OPS)) return null
  if (isAgentWriteAction(path)) return null

  // 2. The data plane (`/data/*`) and the resource-scoped data plane are
  //    operation-strict: the op must be a named read, not merely "not a
  //    known write".
  if (scope === 'data' || scope === 'resource') {
    if (isReadMethod && startsWithAny(tail, READ_DATA_OPS)) return 'data-plane read operation'
    if (verb === 'POST' && startsWithAny(tail, POST_READ_DATA_OPS)) {
      return 'GROQ over POST (long-query fallback)'
    }
    if (scope !== 'resource' || !isReadMethod) return null
    // A resource base also carries console metadata: `/projects/<p>/datasets/<d>`
    // itself, its ACL, its settings.
    if (tail === '' || startsWithAny(tail, READ_RESOURCE_OPS)) return 'resource metadata read'
    return null
  }

  // 3. Root scope: a recognised read namespace, GET/HEAD only.
  if (!isReadMethod) return null
  if (startsWithAny(path, READ_ROOT_PREFIXES)) return 'allowlisted read namespace'
  if (AGENT_BUNDLES_READ.test(path)) return 'agent bundle listener'

  // 4. Default deny. Silence is not consent.
  return null
}

/**
 * Classify a request AND say why — under default-deny a 403 no longer means
 * "you hit a known write endpoint", it means "nothing on the allowlist
 * matched", and those are very different things to debug. `proxy.mjs` should
 * put `reason` and `path` in its log line and its 403 body.
 *
 * @param {{method?: string, url?: string}} request - the raw request line
 * @returns {{write: boolean, path: string, reason: string}} `path` is the
 *   canonical path the guard actually matched on, not the one the caller sent.
 */
export function classifyRequest(request) {
  const {method, url} = request || {}
  const verb = String(method ?? '').toUpperCase()
  const {path, dotSegments, fragmentTruncated} = analysePath(url)
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

/**
 * Does this request write to Content Lake?
 *
 * Default-deny by construction: the only way to be classified as a read is to
 * match the read allowlist above.
 *
 * @param {{method?: string, url?: string}} request - the raw request line
 * @returns {boolean} true when the request must be blocked
 */
export function isWriteRequest(request) {
  return classifyRequest(request).write
}

/* ================================================================== *
 * the realtime leg — `/socket/<dataset>` past the 101
 * ================================================================== *
 *
 * Everything above classifies a REQUEST LINE. `/socket` is on the read
 * allowlist (READ_ROOT_PREFIXES), so the handshake passes and `proxy.mjs`
 * upgrades. Evidence review F5b asked the question the allowlist entry had
 * quietly assumed away: what is an allowlisted upgrade a tunnel TO?
 *
 * Read out of the vendored source, not guessed:
 *
 *   sanity@6.8.0 lib/WorkspaceLoader-BRx2afZV.js:8300-8303 builds
 *   `wss://<p>.api.sanity.io/v2022-06-30/socket/<ds>?tag=sanity.studio` and
 *   hands it to `fromUrl` from @sanity/bifur-client@1.0.0.
 *
 *   That client is a generic JSON-RPC 2.0 request/response channel, not a
 *   one-way stream. src/createClient.ts:42-49 is the envelope
 *   (`{jsonrpc:'2.0', method, params, id}`); createClient.ts:137 is the single
 *   `ws.send()` that carries every request, and it takes `method: string`
 *   straight from its caller.
 *
 *   src/types.ts:6-15 declares the methods:
 *       RequestMethod = 'doc' | 'query' | 'mutate'
 *                     | 'presence_rollcall' | 'presence_announce'
 *                     | 'presence_disconnect' | 'authorization'
 *
 * `'mutate'` is a declared client request method ON THIS SOCKET. No shipped
 * code path calls it — Studio mutations go over HTTP `POST /data/mutate/<ds>`
 * (lib/datastores-DqFH7RLd.js:1789) and @sanity/mutator contains no WebSocket
 * code at all — but the bifur client is exposed to page JS as
 * `__internal.bifur` (lib/datastores-DqFH7RLd.js:7958), and nothing between
 * that object and Content Lake checks anything.
 *
 * So the channel could NOT be proven read-only, and the same policy that
 * governs the request line now governs the frames: an allowlist of the reads we
 * have read out of the source, and default-deny for everything else. Frames are
 * classified on the CLIENT -> UPSTREAM leg only; the server leg stays opaque,
 * because parsing it would break on any protocol extension Sanity ships and the
 * threat here points the other way.
 */

/**
 * JSON-RPC methods the bifur client legitimately sends. Every entry is a member
 * of `RequestMethod`/`SubscribeMethods` in @sanity/bifur-client/src/types.ts:6-25
 * with a read or ephemeral-session meaning; nothing is here on a guess.
 *
 *   authorization        createClient.ts:114 — the Bearer handshake frame
 *   presence_rollcall    datastores-DqFH7RLd.js:7350 — "who is here?"
 *   presence_announce    :7351 — this session's cursor/field locations
 *   presence_disconnect  :7353 — leaving
 *   presence / listen    SubscribeMethods; the read subscriptions
 *   doc / query          RequestMethod — document and GROQ reads, the frame
 *                        analogues of READ_DATA_OPS above
 *
 * Presence writes ephemeral session state, not documents: the payload is a
 * session id plus document ids and field paths, and it does not reach Content
 * Lake. Deliberately ABSENT: `mutate`.
 */
const READ_RPC_METHODS = new Set([
  'authorization',
  'presence',
  'presence_rollcall',
  'presence_announce',
  'presence_disconnect',
  'listen',
  'doc',
  'query',
])

/**
 * `listen(m)` sends `` `${m}_subscribe` `` and its teardown sends
 * `` `${m}_unsubscribe` `` (createClient.ts:157, 174) — but ONLY for the three
 * members of `SubscribeMethods` (types.ts:20-25). The derived forms are
 * enumerated from that set rather than computed by stripping a suffix off
 * whatever arrived: a strip rule would accept `doc_subscribe`, which is not a
 * wire method, and the whole point of default-deny is that "looks close enough
 * to something real" is not a reason to forward a frame.
 */
const SUBSCRIBE_RPC_METHODS = ['presence', 'listen', 'authorization']

/** The complete set of method tokens a client may put on the wire. */
const ALLOWED_RPC_METHODS = new Set([
  ...READ_RPC_METHODS,
  ...SUBSCRIBE_RPC_METHODS.flatMap((method) => [`${method}_subscribe`, `${method}_unsubscribe`]),
])

/**
 * Classify one JSON-RPC method name from a client frame.
 *
 * @param {unknown} method
 * @returns {{write: boolean, reason: string}}
 */
export function classifyRealtimeMethod(method) {
  if (typeof method !== 'string' || method.length === 0) {
    return {write: true, reason: 'frame carries no JSON-RPC method (default-deny)'}
  }
  // NOT trimmed, NOT lower-cased, NOT suffix-stripped: JSON-RPC method names are
  // exact tokens, so `  mutate  `, `MUTATE` and `mutate_subscribe` are simply
  // not methods this client sends. Every loosening of this comparison widens the
  // allowlist and none of them narrows it.
  if (ALLOWED_RPC_METHODS.has(method)) return {write: false, reason: `allowlisted RPC method ${method}`}
  return {write: true, reason: `RPC method ${JSON.stringify(method)} is not an allowlisted read`}
}

/** RFC 6455 opcodes. */
const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/**
 * A presence announce is a few hundred bytes. 128 KiB is four orders of
 * magnitude of headroom and still refuses to let a peer name its own buffer
 * size — a guard that allocated whatever the frame header claimed would be a
 * memory-exhaustion primitive reachable before any allowlist check.
 */
const MAX_FRAME_BYTES = 128 * 1024

/**
 * A streaming RFC 6455 reader for the CLIENT -> UPSTREAM leg.
 *
 * Bytes are only released once the MESSAGE they belong to has been parsed AND
 * classified — a reader that forwarded optimistically could not take the prefix
 * of a mutation back. On the first blocked frame the guard latches shut and
 * forwards nothing else for the lifetime of the connection: the client has
 * demonstrated intent, and re-admitting it after one rejection would make the
 * block advisory.
 *
 * MESSAGE, NOT FRAME (security review 2026-08-06, P1-2)
 * -----------------------------------------------------
 * That invariant was stated here before and was false. `releaseUpTo` advanced
 * past everything scanned so far whenever a frame was not itself a fragment —
 * and a control frame is not a fragment. RFC 6455 §5.4 expressly allows control
 * frames to be interleaved into a fragmented message, so a two-byte PING sent
 * after `TEXT(fin=0, <the whole mutate body>)` released the held fragment
 * upstream. A new final TEXT frame did the same by another route: it silently
 * reset the chain, judged only its own (allowlisted) payload, and that verdict
 * flushed the discarded bytes too.
 *
 * The accounting is therefore stated in terms of what was JUDGED:
 *
 *   - `scanned` walks every complete frame; `releaseUpTo` only ever moves to a
 *     point where no message is in progress, i.e. a judged message boundary.
 *   - A control frame arriving while a chain is open is held WITH the chain. It
 *     is still classified and reported immediately, so the audit trail is not
 *     delayed; only its bytes wait. Ordering is preserved, which a "forward
 *     control frames on a side channel" fix would not do.
 *   - A data frame arriving while a chain is open is an RFC 6455 §5.4 protocol
 *     violation, and is treated as one instead of as a reset.
 *   - `held` remembers how far the previous call had already parsed, so held
 *     bytes are never re-parsed. Without it a re-scan would append a
 *     continuation payload to the reassembly buffer twice.
 *
 * @returns {{inspect: (chunk: Buffer) => {frames: Array<object>, forward: Buffer, blocked: object|null}}}
 */
export function createRealtimeFrameGuard(options = {}) {
  // `enforce: false` is observation mode, matching PROXY_BLOCK_WRITES=0 on the
  // HTTP leg: every frame is still classified and reported so the audit trail
  // is never conditional on the policy, but nothing is held back. The escape is
  // evidenced either way — which is the point of logging server-side.
  const enforce = options.enforce !== false
  let pending = Buffer.alloc(0)
  /** Payload of a fragmented message in progress (FIN=0 chains). */
  let fragment = null
  /** Bytes at the front of `pending` already parsed AND classified, but held. */
  let held = 0
  let latched = null

  /** Decode one frame from the front of `buffer`, or null if it is incomplete. */
  function readFrame(buffer) {
    if (buffer.length < 2) return null
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    const lengthByte = buffer[1] & 0x7f

    let offset = 2
    let length = lengthByte
    if (lengthByte === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (lengthByte === 127) {
      if (buffer.length < 10) return null
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(MAX_FRAME_BYTES)) return {oversize: true, declared: big.toString()}
      length = Number(big)
      offset = 10
    }
    if (length > MAX_FRAME_BYTES) return {oversize: true, declared: String(length)}

    // Masking is decided BEFORE waiting for the payload: an unmasked client
    // frame is an RFC 6455 §5.1 violation, and the guard must not sit waiting
    // for bytes whose framing it does not trust.
    if (!masked) return {unmasked: true}

    const maskOffset = offset
    offset += 4
    if (buffer.length < offset + length) return null

    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    const key = buffer.subarray(maskOffset, maskOffset + 4)
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]

    return {fin, opcode, payload, consumed: offset + length}
  }

  /** Turn a decoded frame into a verdict, maintaining fragment state. */
  function classifyFrame(frame) {
    if (frame.opcode === OPCODE_CLOSE || frame.opcode === OPCODE_PING || frame.opcode === OPCODE_PONG) {
      // Control frames carry no RPC. They must pass or the connection cannot be
      // kept alive or closed politely.
      return {opcode: frame.opcode, rpcMethod: null, rpcId: null, write: false, reason: 'control frame'}
    }

    if (frame.opcode === OPCODE_TEXT) {
      if (fragment !== null) {
        // RFC 6455 §5.4: a data frame may not interrupt a fragmented message.
        // The old code read this as "start over", discarded the chain and
        // judged only the newcomer — so an allowlisted method in the second
        // frame released the first one's unjudged bytes (P1-2, vector D).
        // There is no reading of this stream both ends agree on, which is the
        // same situation the HTTP leg answers with default-deny.
        fragment = null
        return {
          opcode: frame.opcode,
          rpcMethod: null,
          rpcId: null,
          write: true,
          reason: 'text frame arrived while a fragmented message was in progress (RFC 6455 §5.4)',
        }
      }
      fragment = frame.fin ? null : {payload: frame.payload}
      if (!frame.fin) {
        return {opcode: frame.opcode, rpcMethod: null, rpcId: null, write: false, reason: 'fragment'}
      }
      return judge(frame.opcode, frame.payload)
    }

    if (frame.opcode === OPCODE_CONTINUATION) {
      if (!fragment) {
        return {
          opcode: frame.opcode,
          rpcMethod: null,
          rpcId: null,
          write: true,
          reason: 'continuation frame with no message in progress',
        }
      }
      fragment.payload = Buffer.concat([fragment.payload, frame.payload])
      if (fragment.payload.length > MAX_FRAME_BYTES) {
        fragment = null
        return {
          opcode: frame.opcode,
          rpcMethod: null,
          rpcId: null,
          write: true,
          reason: 'reassembled message too large to inspect',
        }
      }
      if (!frame.fin) {
        return {opcode: frame.opcode, rpcMethod: null, rpcId: null, write: false, reason: 'fragment'}
      }
      const whole = fragment.payload
      fragment = null
      return judge(frame.opcode, whole)
    }

    // Binary (0x2) and every reserved opcode. The bifur protocol is JSON text
    // (createClient.ts:42), so a binary client frame is not something the
    // allowlist can vouch for.
    return {
      opcode: frame.opcode,
      rpcMethod: null,
      rpcId: null,
      write: true,
      reason: `opcode 0x${frame.opcode.toString(16)} is not a JSON text frame`,
    }
  }

  function judge(opcode, payload) {
    let message
    try {
      message = JSON.parse(payload.toString('utf8'))
    } catch {
      return {
        opcode,
        rpcMethod: null,
        rpcId: null,
        write: true,
        reason: 'text frame is not JSON, so its method cannot be established',
      }
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return {opcode, rpcMethod: null, rpcId: null, write: true, reason: 'frame is not a JSON-RPC object'}
    }
    const verdict = classifyRealtimeMethod(message.method)
    return {
      opcode,
      rpcMethod: typeof message.method === 'string' ? message.method : null,
      // The id is a nanoid (createClient.ts:35-38) — safe to log, unlike params.
      rpcId: typeof message.id === 'string' || typeof message.id === 'number' ? String(message.id) : null,
      write: verdict.write,
      reason: verdict.reason,
    }
  }

  return {
    inspect(chunk) {
      if (latched) return {frames: [], forward: Buffer.alloc(0), blocked: latched}

      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
      const frames = []
      // `scanned` walks every complete frame; `releaseUpTo` only ever advances
      // to a point where NO message is in progress — a judged message boundary.
      // Scanning resumes at `held`, the frontier the previous call reached, so
      // nothing is parsed, classified or reassembled twice.
      let scanned = held
      let releaseUpTo = 0

      for (;;) {
        const frame = readFrame(pending.subarray(scanned))
        if (!frame) break

        if (frame.oversize || frame.unmasked) {
          // Unparseable framing. There is no safe place to resume reading a
          // stream whose frame boundaries are unknown, so this stops the reader
          // in BOTH modes: observation mode can report what it saw, but it
          // cannot go on claiming to have seen the rest.
          latched = {
            opcode: null,
            rpcMethod: null,
            rpcId: null,
            write: true,
            reason: frame.oversize
              ? `frame declares ${frame.declared} bytes, too large to inspect`
              : 'client frame is not masked (RFC 6455 §5.1)',
          }
          frames.push(latched)
          break
        }

        const verdict = classifyFrame(frame)
        scanned += frame.consumed
        const isFragment = verdict.reason === 'fragment'
        if (!isFragment) frames.push(verdict)

        if (verdict.write && enforce) {
          latched = verdict
          break
        }

        if (!enforce) {
          // Observation mode holds nothing — the tunnel stays byte-transparent,
          // exactly as PROXY_BLOCK_WRITES=0 promises on the HTTP leg.
          releaseUpTo = scanned
          continue
        }

        // `fragment !== null` means a message is open and unjudged. Nothing
        // behind it may leave, whatever THIS frame turned out to be: a control
        // frame is allowed to interleave (RFC 6455 §5.4) and its own verdict
        // says nothing about the bytes it is sitting between. Holding is a
        // delay, not a drop — the whole run is released together the moment the
        // continuation chain closes and its method is known.
        if (fragment === null && !isFragment) releaseUpTo = scanned
      }

      const forward = Buffer.from(pending.subarray(0, releaseUpTo))
      if (latched) {
        pending = Buffer.alloc(0)
        held = 0
      } else {
        pending = Buffer.from(pending.subarray(releaseUpTo))
        held = scanned - releaseUpTo
      }
      return {frames, forward, blocked: latched}
    },
  }
}
