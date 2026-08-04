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
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * Spike F (docs/plans/evidence/phase-1/spike-f-safety-boundary/report.md) beat
 * the previous guard four different ways, and every one of them is answered
 * below:
 *
 *   gap 20  `request({url: 'data/mutate/parity'})` — @sanity/client's `_getUrl`
 *           does `uri.replace(/^\//, '')`, so the guard's leading-slash regex
 *           never matched. => normalise the path BEFORE matching, never match
 *           against a raw URL string.
 *   gap 21  `/assets/*` was not in the rule set at all.
 *   gap 23  `POST /agent/action/patch/<dataset>` was passed by the proxy
 *           allowlist (`/agent/*` was explicitly allowed).
 *   gap 24  `client.datasets` (`PUT|PATCH|DELETE /datasets/<name>`) unguarded.
 *
 * DESIGN
 * ------
 * 1. Normalise first (`normalizePath`): strip scheme+authority, query and
 *    fragment; percent-decode repeatedly and safely; collapse duplicate
 *    slashes; resolve `.` / `..`; force a leading slash; drop the
 *    `/vYYYY-MM-DD` | `/vN` | `/vX` API-version prefix; lower-case; drop the
 *    trailing slash. Matching a *canonical* path is the whole point — a rule
 *    set applied to an attacker-chosen spelling is not a rule set.
 * 2. Classify by scope + operation, so the resource-scoped data plane
 *    (`/projects/<p>/datasets/<d>/mutate`, `/canvases/<id>/mutate`, ...) built
 *    by @sanity/client's `resourceDataBase()` is covered by the same rules as
 *    `/data/mutate/<dataset>`.
 * 3. Fail closed: an unrecognised non-GET request anywhere in the data plane
 *    (`/data/*`, `/assets/*`, `/agent/*`, the dataset-administration tree, or a
 *    resource base) is a write. Silence is not consent.
 *
 * Two deliberate rulings, both fail-closed:
 *   - `OPTIONS` is never a write. CORS preflight must succeed or the browser
 *     never delivers the 403 that follows.
 *   - `GET`/`HEAD` on `/data/mutate`, `/data/actions` and the agent action
 *     verbs ARE writes: those endpoints have no read semantics, so a GET there
 *     is either a probe or an API we do not know about.
 */

/** Methods that can only ever read — everything else is a candidate write. */
const READ_METHODS = new Set(['GET', 'HEAD'])

/** `/v2025-02-19`, `/v1`, `/vX` — stripped so rules are version-agnostic. */
const API_VERSION_PREFIX = /^\/v(?:\d{4}-\d{2}-\d{2}|\d+|x)(?=\/|$)/

/** `/projects/<projectId>/datasets/<dataset>` — `resourceDataBase()` case 'dataset'. */
const PROJECT_DATASET_BASE = /^\/projects\/[^/]+\/datasets\/[^/]+(\/.*)?$/

/** `/canvases/<id>`, `/media-libraries/<id>`, `/dashboards/<id>` — the other resource bases. */
const RESOURCE_BASE = /^\/(?:canvases|media-libraries|dashboards)\/[^/]+(\/.*)?$/

/** `/projects/<projectId>/datasets` — dataset administration, one level up. */
const PROJECT_DATASETS_ROOT = /^\/projects\/[^/]+\/datasets(?:\/|$)/

/** Operations that write no matter which verb carries them. */
const ALWAYS_WRITE_OPS = ['/mutate', '/actions']

// The read-only data-plane operations are, for the record, /query, /listen,
// /doc, /history, /export and /live/events. There is deliberately no allowlist
// constant for them: reads are decided by method, so an operation nobody has
// thought to list still fails closed instead of being waved through.

/** Agent Actions that reach Content Lake: `/agent/action/<verb>/<dataset>`. */
const AGENT_WRITE_ACTIONS = new Set(['patch', 'generate', 'transform', 'translate', 'prompt'])

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

/** RFC 3986 §5.2.4 remove_dot_segments, minus the leading-slash escape. */
function resolveDotSegments(path) {
  const out = []
  for (const segment of path.split('/')) {
    if (segment === '.') continue
    if (segment === '..') {
      // Never pop the leading empty segment: `/../x` must stay rooted at `/x`.
      if (out.length > 1) out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  return joined.startsWith('/') ? joined : `/${joined}`
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
 * @param {unknown} rawUrl
 * @returns {string} a lower-case, rooted, version-stripped path
 */
export function normalizePath(rawUrl) {
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
  path = resolveDotSegments(path)
  path = path.toLowerCase()

  let version = API_VERSION_PREFIX.exec(path)
  while (version) {
    path = path.slice(version[0].length) || '/'
    version = API_VERSION_PREFIX.exec(path)
  }

  if (path.length > 1) path = path.replace(/\/+$/, '') || '/'
  return path
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
 * Does this request write to Content Lake?
 *
 * Fail-closed by construction: the only way to be classified as a read is to
 * match a known read shape.
 *
 * @param {{method?: string, url?: string}} request - the raw request line
 * @returns {boolean} true when the request must be blocked
 */
export function isWriteRequest(request) {
  const {method, url} = request || {}
  const verb = String(method ?? '').toUpperCase()

  // CORS preflight is never a write; blocking it hides the 403 from the browser.
  if (verb === 'OPTIONS') return false

  const isReadMethod = READ_METHODS.has(verb)
  const path = normalizePath(url)
  const {scope, tail} = splitScope(path)

  // 1. Endpoints with no read semantics: a write whatever the verb.
  if (startsWithAny(tail, ALWAYS_WRITE_OPS)) return true
  if (isAgentWriteAction(path)) return true

  // 2. GET/HEAD everywhere else is a read: GROQ, listeners, documents, history,
  //    exports, live events, /users/me, /projects/*, asset downloads, /ping.
  if (isReadMethod) return false

  // 3. GROQ over POST is a read (`_dataRequest` falls back to POST for long queries).
  if (verb === 'POST' && hasSegmentPrefix(tail, '/query')) return false

  // -- everything below is a non-GET/HEAD/OPTIONS verb -----------------------

  // 4. Fail closed across the whole data plane.
  if (scope === 'data') return true // unknown /data/* writer
  if (scope === 'resource') return true // unknown resource-scoped writer
  if (hasSegmentPrefix(path, '/assets')) return true // uploads (gap 21)
  if (hasSegmentPrefix(path, '/agent')) return true // agent actions (gap 23)
  if (hasSegmentPrefix(path, '/datasets')) return true // dataset admin (gap 24)
  if (PROJECT_DATASETS_ROOT.test(path)) return true // dataset admin, project host

  // 5. Outside the data plane (auth, telemetry, /users, /projects metadata).
  return false
}
