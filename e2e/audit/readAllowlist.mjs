/**
 * A SECOND, INDEPENDENT read allowlist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT JUST IMPORT `writeGuard.mjs`
 *
 * Because then the audit would be the guard grading its own homework. The proxy
 * decides `blocked: true/false` using `writeGuard.classifyRequest`; if the audit
 * asked the same function whether that decision was right, the two would agree
 * by construction on every input, including the inputs where the guard is wrong.
 * A guard with a hole would produce a log full of `blocked: false` rows that the
 * audit would cheerfully certify — which is exactly the shape of the Spike F
 * incident: an enumeration that had not heard of an endpoint, trusted anyway.
 *
 * So this module re-derives the policy from the same public source (Sanity's
 * HTTP API surface, as tabulated in `examples/kitchen-sink/spikeB-proxy/README.md`)
 * without reading the guard's implementation. `predicates.mjs` then runs BOTH and
 * treats one specific disagreement — the guard says read where this says write —
 * as a failure. The opposite direction is only a note: this list being stricter
 * costs nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THIS DELIBERATELY DIFFERS FROM THE GUARD, AND WHY
 *
 * The guard is default-deny on **every** verb, `GET` included: an unobserved
 * read endpoint returns 403 until someone adds it, "a loud, local failure,
 * deliberately preferred over reinstating the assumption Spike F destroyed".
 * That is right for a guard, which must fail closed.
 *
 * It is wrong for an audit. An audit answers one question — *did a write
 * escape?* — and a `GET /favicon.ico` that the allowlist has never heard of is
 * not an escape. Scoring it as one buries the real signal under noise, and an
 * audit nobody can read is an audit that gets switched off. So:
 *
 *   - `GET`/`HEAD` are reads, **except** on the four families that have no read
 *     semantics at all, where even a `GET` is a write (Spike F gap 23):
 *     `/data/mutate`, `/data/actions`, `/agent/action/*`, and `…/upload`.
 *   - Every other verb is default-deny: a write unless it matches a named read.
 *     The single exception is `POST …/query`, the long-GROQ fallback Studio
 *     really uses.
 *
 * Two further differences, both in the strict direction:
 *
 *   - **No case folding.** `/DATA/MUTATE/parity` is judged as spelled. A path
 *     whose case does not match what Studio emits is anomalous, and an audit
 *     that normalises anomalies away cannot report them.
 *   - **Dot segments are fatal, before anything else.** A path containing `.`
 *     or `..` is a write whatever it spells, because the proxy forwards the raw
 *     request line and Content Lake may resolve it differently.
 */

/** Verbs that cannot mutate, whatever the path. Everything else must be matched. */
const SAFE_VERBS = new Set(['GET', 'HEAD'])

/** Read leaves under a data-plane resource, e.g. `/data/query/<dataset>`. */
const DATA_READ_LEAVES = new Set(['query', 'doc', 'listen', 'history', 'export', 'ping'])

/** Bases that answer reads about themselves. */
const RESOURCE_SUFFIXES = new Set(['', 'acl', 'settings'])

/** Root namespaces that answer `GET`/`HEAD` and hold no write semantics. */
const ROOT_READ_NAMESPACES = new Set([
  'ping',
  'help',
  'features',
  'journey',
  'socket',
  'schedules',
  'users',
  'projects',
  'datasets',
  'assets',
])

/**
 * Canonicalise a request target the way a *reader* of the log must: decode
 * percent escapes, drop the query string, collapse duplicate slashes, drop a
 * trailing slash, and strip a leading API-version segment.
 *
 * Returns `dotSegments: true` when the RAW path contained a `.` or `..`
 * segment, before or after decoding — that flag alone decides the verdict.
 */
export function canonicalise(rawPath) {
  const withoutQuery = String(rawPath ?? '').split('?')[0].split('#')[0]

  let decoded = withoutQuery
  /* Decode repeatedly: `%252e` is `%2e` is `.`, and a single pass would miss it. */
  for (let round = 0; round < 3; round += 1) {
    let next
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break
    }
    if (next === decoded) break
    decoded = next
  }

  const rawSegments = decoded.split('/')
  const dotSegments = rawSegments.some((segment) => segment === '.' || segment === '..')

  const segments = rawSegments.filter((segment) => segment.length > 0)
  if (segments.length > 0 && /^v[0-9X][^/]*$/.test(segments[0])) segments.shift()

  return {segments, dotSegments, path: `/${segments.join('/')}`}
}

/**
 * The four families where a `GET` is still a write.
 *
 * Spike F gap 23, verbatim from the proxy README: *"`/agent/action/{patch,
 * generate,transform,translate,prompt}` is blocked whatever the verb — those
 * endpoints have no read semantics, so a `GET` probe is a write. Same for
 * `/data/mutate`, `/data/actions` and `/…/upload`."*
 */
function hasNoReadSemantics(segments) {
  for (const [index, segment] of segments.entries()) {
    if (segment === 'upload') return true
    if (segment === 'agent' && segments[index + 1] === 'action') return true
    if (segment === 'mutate' || segment === 'actions') {
      const previous = segments[index - 1]
      /* `/data/mutate/<ds>` and the resource-scoped `/…/datasets/<d>/mutate`. */
      if (previous === 'data' || segments[index - 2] === 'datasets') return true
    }
  }
  return false
}

/** `…/query` in either of its two spellings — the long-GROQ POST read. */
function isQueryLeaf(segments) {
  const index = segments.indexOf('query')
  if (index < 1) return false
  return segments[index - 1] === 'data' || (index >= 2 && segments[index - 2] === 'datasets')
}

/**
 * Is this request line a READ?
 *
 * @param {{method?: string, path?: string}} record
 * @returns {{read: boolean, reason: string, path: string}}
 */
export function classify(record) {
  const verb = String(record?.method ?? '').toUpperCase()
  const {segments, dotSegments, path} = canonicalise(record?.path)

  if (dotSegments) {
    return {read: false, path, reason: 'path carries a "." or ".." segment — never a read'}
  }

  /* CORS preflight. Content Lake never sees it (the proxy answers it locally),
   * but it appears in the log and must classify. */
  if (verb === 'OPTIONS') return {read: true, path, reason: 'CORS preflight'}

  if (hasNoReadSemantics(segments)) {
    return {read: false, path, reason: `${verb} on an endpoint with no read semantics is a write`}
  }

  if (SAFE_VERBS.has(verb)) {
    /* Named reads get a specific reason so the audit output is diagnosable;
     * everything else is still a read, because a GET cannot mutate outside the
     * four families above. */
    if (segments.length === 0) return {read: true, path, reason: 'root probe'}
    const dataIndex = segments.indexOf('data')
    if (dataIndex !== -1 && DATA_READ_LEAVES.has(segments[dataIndex + 1])) {
      return {read: true, path, reason: `data read: ${segments[dataIndex + 1]}`}
    }
    if (dataIndex !== -1 && segments[dataIndex + 1] === 'live' && segments[dataIndex + 2] === 'events') {
      return {read: true, path, reason: 'live events stream'}
    }
    for (const kind of ['datasets', 'canvases', 'media-libraries', 'dashboards']) {
      const index = segments.indexOf(kind)
      if (index === -1) continue
      const tail = segments.slice(index + 2)
      if (tail.length === 0 || RESOURCE_SUFFIXES.has(tail[0]) || DATA_READ_LEAVES.has(tail[0])) {
        return {read: true, path, reason: `${kind} resource read`}
      }
    }
    if (ROOT_READ_NAMESPACES.has(segments[0])) {
      return {read: true, path, reason: `root namespace read: /${segments[0]}`}
    }
    return {read: true, path, reason: `${verb} cannot mutate, and this is not a no-read-semantics path`}
  }

  if (verb === 'POST' && isQueryLeaf(segments)) {
    return {read: true, path, reason: 'GROQ over POST — the long-query read fallback'}
  }

  return {read: false, path, reason: `${verb} is a mutating verb and this is not a named read (default-deny)`}
}

/** Convenience inverse. */
export function isWrite(record) {
  return !classify(record).read
}
