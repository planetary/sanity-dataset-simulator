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
 * FOUR RULINGS, ALL FAIL-CLOSED
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
 */
const READ_DATA_OPS = ['/query', '/doc', '/listen', '/history', '/export', '/live/events', '/ping']

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
 * @param {unknown} rawUrl
 * @returns {{path: string, dotSegments: boolean}} the canonical path, plus
 *   whether producing it required resolving `.`/`..` segments.
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

  path = cutAt(cutAt(path, '#'), '?')

  // Decode to a fixed point (bounded), re-cutting each pass so an encoded `?`
  // or `#` cannot smuggle path text past the first cut. Repeated decoding can
  // only ever reveal more path, so it can only ever make the guard stricter.
  for (let pass = 0; pass < 5; pass++) {
    const decoded = safeDecode(path)
    if (decoded === path) break
    path = cutAt(cutAt(decoded, '#'), '?')
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
  return {path, dotSegments: resolved.sawDotSegment}
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
function readReason(verb, path, dotSegments) {
  if (verb === 'OPTIONS') return 'CORS preflight is never a write'

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
  const {path, dotSegments} = analysePath(url)
  const reason = readReason(verb, path, dotSegments)
  if (reason !== null) return {write: false, path, reason}
  return {
    write: true,
    path,
    reason: dotSegments
      ? 'path carries "." or ".." segments, so the proxy and Content Lake could ' +
        'read it differently — never a read (default-deny)'
      : 'not on the read allowlist (default-deny)',
  }
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
