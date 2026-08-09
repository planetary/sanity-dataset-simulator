/**
 * MODE 2 (`--origin` / `OVERLAY_BASE=none`) — the safety predicates.
 *
 * WHAT MODE 2 IS, STATED PLAINLY
 * ------------------------------
 * PRD §0.2 fixes the overlay's base as a *live staging dataset*: the proxy sits
 * between Studio and Content Lake and intercepts the data plane. That is Mode 1,
 * it is the default, and nothing here changes it.
 *
 * Mode 2 is a deliberate extension, not a config tweak. There is no Sanity
 * project, no dataset, no account and no upstream at all: the proxy stops being
 * a proxy and becomes an **origin**, answering every request from the overlay.
 * Every document is therefore branch-created (PRD §17.2 precedence rule 2), and
 * the identity it serves is fabricated.
 *
 * WHY THE SAFETY PREDICATES LIVE HERE AND NOT IN `origin.mjs`
 * -----------------------------------------------------------
 * `origin.mjs` imports `sanity-overlay-core` and `sanity-overlay-store-fs`,
 * which are TypeScript sources with extensionless internal specifiers — Node's
 * ESM resolver cannot load them without a resolve hook (see `tsResolveHook.mjs`).
 * `proxy.mjs` must stay loadable by bare `node proxy.mjs` in Mode 1, so it can
 * only *statically* import modules with no such dependency.
 *
 * This file is that module: dependency-free apart from the write guard, which
 * `proxy.mjs` already imports. It holds the four things the transport layer
 * needs to decide before any overlay code is loaded — is Mode 2 requested, is
 * the bind address safe, is this request one of the two the overlay owns, and
 * (§4 below, which applies to BOTH modes) is this browser origin one the proxy
 * will hand a CORS grant.
 */

import {normalizePath} from './writeGuard.mjs'

/* ------------------------------------------------------------------ *
 * 1. explicit opt-in
 * ------------------------------------------------------------------ */

/** The environment variable that turns Mode 2 on, and the ONE value that does it. */
export const ORIGIN_MODE_ENV = 'OVERLAY_BASE'
export const ORIGIN_MODE_ENV_VALUE = 'none'

/**
 * Is Mode 2 requested?
 *
 * **Explicitly, or not at all.** The tempting inference — "no `SANITY_API_HOST`,
 * so the user must want a local origin" — would turn a typo, an unset shell, or
 * an upstream outage into a server that hands a full-grant synthetic identity to
 * whoever asks. A missing upstream in Mode 1 is a 502; that is the correct,
 * loud, harmless failure, and it stays.
 *
 * The environment value is compared verbatim: no trimming, no case folding, no
 * truthiness. `OVERLAY_BASE=NONE ` is not `none`, and a config that nearly says
 * something dangerous should do nothing at all.
 *
 * @param {{origin?: boolean}} [options] explicit option (what `--origin` sets)
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isOriginModeRequested(options = {}, env = {}) {
  if (typeof options?.origin === 'boolean') return options.origin
  return env?.[ORIGIN_MODE_ENV] === ORIGIN_MODE_ENV_VALUE
}

/* ------------------------------------------------------------------ *
 * 2. loopback only
 * ------------------------------------------------------------------ */

/** Refusing to start is an error the launcher must not swallow, so it is typed. */
export class OriginBindError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'OriginBindError'
    this.code = 'OVERLAY_ORIGIN_NON_LOOPBACK'
  }
}

/** 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1. */
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV4_ANY = /^\d{1,3}(?:\.\d{1,3}){3}$/

function isIpv4Loopback(value) {
  const match = IPV4_LOOPBACK.exec(value)
  if (match === null) return false
  return match.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * Is this bind address loopback-only?
 *
 * `undefined` and `''` are **not**: they are Node's "listen on every interface",
 * which is precisely the case this predicate exists to catch. Every other answer
 * is derived structurally rather than by string matching against a short
 * denylist — a denylist would have to know every routable address there is,
 * and the failure mode of a missing entry is a full-grant identity server on
 * the LAN.
 *
 * @param {unknown} bind
 * @returns {boolean}
 */
export function isLoopbackBind(bind) {
  if (typeof bind !== 'string' || bind.length === 0) return false

  // A bracketed literal is the URL spelling of an IPv6 address.
  let value = bind.trim()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  // A zone index (`::1%lo0`) does not change which address it is.
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  const lower = value.toLowerCase()

  // The only hostname that is loopback by definition. `localhost.evil.test`
  // and `notlocalhost` are ordinary names that resolve wherever DNS says.
  if (lower === 'localhost') return true

  if (IPV4_ANY.test(lower)) return isIpv4Loopback(lower)

  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is an IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (mapped) return isIpv4Loopback(mapped[1])

  if (lower.includes(':')) {
    // Expand `::` and compare numerically: `::1` and `0:0:0:0:0:0:0:1` are the
    // same address, and `::` (all interfaces) must not be mistaken for either.
    const groups = expandIpv6(lower)
    if (groups === null) return false
    return groups.length === 8 && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1
  }

  return false
}

/** `::1` -> [0,0,0,0,0,0,0,1]; returns null for anything that is not a plain IPv6 literal. */
function expandIpv6(value) {
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parse = (part) =>
    part === ''
      ? []
      : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))

  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return null

  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...new Array(fill).fill(0), ...tail]
}

/**
 * Refuse to start Mode 2 anywhere but loopback.
 *
 * There is deliberately **no override**. A flag that unlocks this would be the
 * first thing a "just make it work on my LAN" instruction reaches for, and the
 * thing it unlocks is an unauthenticated full-grant write surface.
 *
 * @param {unknown} bind
 * @returns {void}
 * @throws {OriginBindError}
 */
export function assertLoopbackBind(bind) {
  if (isLoopbackBind(bind)) return
  const shown = bind === undefined || bind === '' ? 'every interface (0.0.0.0/::)' : String(bind)
  throw new OriginBindError(
    `Mode 2 (origin) refuses to bind ${shown}. Its identity is a synthetic full-grant ` +
      'local-dev user with nothing to authenticate against, so it may only listen on a ' +
      'loopback address (127.0.0.0/8, ::1, localhost). There is no flag to override this.',
  )
}

/* ------------------------------------------------------------------ *
 * 3. the two routes the overlay owns
 * ------------------------------------------------------------------ */

/**
 * The ONLY write endpoints Mode 2 answers instead of blocking.
 *
 * The write guard is untouched: `isWriteRequest()` still classifies both of
 * these as writes, exactly as it does in Mode 1. What changes in Mode 2 is only
 * where a write *goes* — there is no Content Lake to protect, and the overlay
 * owns the write path. So the policy becomes:
 *
 *     blocked_in_mode_2(r)  =  isWriteRequest(r)  AND  NOT isOriginWriteRoute(r)
 *
 * and this list is the entire second term. Two entries, both observed in
 * `proxy-log.jsonl` as the Studio write path (`POST /data/actions/<ds>` is what
 * sanity 6.8.0 actually uses; `POST /data/mutate/<ds>` is what `@sanity/client`
 * falls back to). Everything else the guard blocks stays blocked: asset uploads,
 * `/agent/action/*`, `/datasets/*`, `/descriptors/claim`, `/intake/batch`,
 * `PUT /users/me/keyvalue/*`, and every path nobody has heard of. All of those
 * are 403 in Mode 1 with a Studio that boots anyway — the log proves it — so
 * Mode 2 loses nothing by keeping them 403.
 */
export const ORIGIN_WRITE_PATHS = Object.freeze(['/data/actions', '/data/mutate'])

/** `/data/{mutate,actions}/<dataset>`, canonical form, nothing after the dataset. */
const ORIGIN_WRITE_PATH = /^\/data\/(?:mutate|actions)\/([^/]+)$/

const API_VERSION_PREFIX = /^\/v(?:\d{4}-\d{2}-\d{2}|\d+|X)(?=\/|$)/

/**
 * The request target with only the query/fragment and ONE api-version segment
 * removed — no decoding, no dot-segment resolution, no case folding, no
 * separator collapsing.
 *
 * This is not a normaliser. It is the "what the caller literally sent" side of
 * an equality check; see {@link isOriginWriteRoute}.
 */
function rawApiPath(rawUrl) {
  let value = String(rawUrl ?? '')
  for (const marker of ['#', '?']) {
    const index = value.indexOf(marker)
    if (index !== -1) value = value.slice(0, index)
  }
  const version = API_VERSION_PREFIX.exec(value)
  if (version) value = value.slice(version[0].length) || '/'
  return value
}

/**
 * Is this request one of the two writes the overlay owns?
 *
 * STRICT-CANONICAL, and that is the whole design.
 *
 * The obvious implementation — canonicalise the URL, then match — would make
 * Mode 2 reachable by request shapes Mode 1 blocks outright. `POST
 * /x/../data/mutate/<ds>` canonicalises to a route on this list, but the guard
 * rejects it in Mode 1 precisely *because* its meaning depends on who resolves
 * the dot segments (see `writeGuard.mjs` `readReason` step 0). Widening that in
 * Mode 2 would be exactly the "something became reachable that used to be
 * blocked" this file exists to prevent.
 *
 * So the test is an equality, not a match: the guard's own canonical path must
 * already equal what the caller sent. Any escape the Spike F class is made of —
 * missing leading slash, upper case, duplicated separators, percent-encoding,
 * dot segments, stacked version prefixes, trailing slash — makes the two
 * strings differ, and differing means "not this route", which means the guard's
 * 403 stands. There is no second normaliser to get wrong, because there is no
 * second normaliser: `normalizePath` is imported from the guard itself.
 *
 * DATASET-SCOPED. Spike F attack 14 is `POST /data/mutate/scratch` — a
 * dataset-swapped client clone. Mode 2 serves exactly one dataset out of one
 * overlay root, so a write addressed to any other dataset has no destination
 * here and stays a 403 rather than being silently applied to the only overlay
 * that exists. The dataset is compared against the canonical (lower-cased) path
 * because Sanity dataset names are lower-case by construction.
 *
 * @param {unknown} method
 * @param {unknown} rawUrl the raw request line, unnormalised
 * @param {string} [dataset] the one dataset this origin serves; omit to accept any
 * @returns {boolean}
 */
export function isOriginWriteRoute(method, rawUrl, dataset) {
  if (String(method ?? '').toUpperCase() !== 'POST') return false
  const canonical = normalizePath(rawUrl)
  const match = ORIGIN_WRITE_PATH.exec(canonical)
  if (match === null) return false
  if (dataset !== undefined && match[1] !== String(dataset).toLowerCase()) return false
  return rawApiPath(rawUrl) === canonical
}

/* ------------------------------------------------------------------ *
 * 4. who may read what the proxy can read — the CORS allowlist
 * ------------------------------------------------------------------ *
 *
 * This section is NOT Mode 2 specific. It lives here because the grant is
 * derived from {@link isLoopbackBind}, and one definition of "loopback" for the
 * socket and for the caller is the entire point of putting them side by side.
 *
 * WHAT IT REPLACES (security review 2026-08-06, finding P2-4)
 * `proxy.mjs` used to echo the request `Origin` VERBATIM alongside
 * `Access-Control-Allow-Credentials: true`. In Mode 1 that meant any page the
 * developer had open could read whatever the proxy could read — every
 * unpublished draft in the staging dataset — because the browser attaches the
 * developer's own session cookie to the request and the reflected grant then
 * hands the response to the attacker's script.
 *
 * WHY LOOPBACK IS THE DEFAULT ALLOWLIST
 * The proxy's one browser client is a local Studio whose dev port cannot be
 * known in advance (`3333` for `sanity dev`, `5173` for a bare Vite, whatever
 * `--port` said), so a port list would be a guess that fails closed on the
 * developer and open on nobody. Deriving it structurally covers every port at
 * once. `https://evil.example` is refused, INCLUDING one whose DNS has been
 * rebound to 127.0.0.1: rebinding changes where a name resolves, not what a
 * page's origin is.
 *
 * THE RESIDUAL, STATED RATHER THAN HIDDEN
 * Any process the developer runs on loopback can therefore read through a Mode 1
 * proxy. That is accepted: such a process is already executing code on the
 * developer's machine and can read their Sanity credentials from disk directly,
 * so the grant adds no authority it did not already have. The attacker this
 * closes is the remote page, which cannot become a loopback origin.
 */

/**
 * Is `value` an origin the proxy will hand a CORS grant?
 *
 * `Origin: null` — a sandboxed iframe, a `data:` document, some redirect chains
 * — fails `new URL` and is refused, which is right: it is not a name that can be
 * granted, and it is exactly what a hostile iframe sends.
 *
 * @param {unknown} value the request `Origin` header
 * @param {{has: (value: string) => boolean}} [allowed] extra origins, verbatim
 * @returns {boolean}
 */
export function isGrantedOrigin(value, allowed) {
  if (typeof value !== 'string' || value === '') return false
  if (allowed !== undefined && allowed.has(value)) return true
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return isLoopbackBind(url.hostname)
  } catch {
    return false
  }
}

/** A wildcard allowlist is refused, so the refusal is typed like the bind one. */
export class OriginGrantError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'OriginGrantError'
    this.code = 'OVERLAY_ORIGIN_WILDCARD_GRANT'
  }
}

/**
 * Normalise an explicit origin allowlist, refusing a wildcard.
 *
 * THIS IS THE STRUCTURAL STAND-IN FOR "NEVER EMIT `Allow-Credentials`".
 *
 * `createOverlayApi`, `overlayServer.mjs` and `origin.mjs`'s own view all refuse
 * to emit that header at all, because none of them carries an ambient
 * credential: not emitting it means a future widening of the allowlist cannot
 * resurrect the hole. The proxy cannot buy the guarantee that way — it is a
 * browser-facing origin that deliberately HOLDS an ambient credential (upstream
 * `Set-Cookie`s are rewritten onto its own host so they stick, and
 * `@sanity/client` reads through it with `withCredentials: true`), so a response
 * without the header is one the browser refuses to show Studio. Dropping it
 * would not harden Mode 1; it would delete it.
 *
 * So the containment rests entirely on the allowlist staying narrow, and the one
 * value that would destroy it is refused outright rather than documented. There
 * is deliberately no environment variable behind this list either: an ambient
 * value is precisely how a "just let my other dev server in" instruction would
 * end up widening a credentialled grant.
 *
 * @param {unknown} origins
 * @returns {Set<string>}
 * @throws {OriginGrantError}
 */
export function normalizeGrantedOrigins(origins) {
  if (origins === undefined || origins === null) return new Set()
  const list = Array.isArray(origins) ? origins : [origins]
  const out = new Set()
  for (const entry of list) {
    const value = String(entry)
    if (value === '*') {
      throw new OriginGrantError(
        'The proxy refuses a wildcard CORS allowlist. It reflects the granted origin back with ' +
          '`Access-Control-Allow-Credentials: true` — which it must, because Studio reads through ' +
          'it with `withCredentials: true` — so `origins: ["*"]` is verbatim reflection with ' +
          'credentials attached, i.e. the 2026-08-06 P2-4 hole restated as configuration. Name ' +
          'the origins, or rely on the loopback default.',
      )
    }
    if (value !== '') out.add(value)
  }
  return out
}

/**
 * The startup banner. Mode 2 must be impossible to run by accident and
 * impossible to mistake for Mode 1 in a terminal scrollback.
 *
 * @param {{bind?: string, port?: number, root?: string, projectId?: string, dataset?: string}} info
 * @returns {string}
 */
export function originStartupBanner(info = {}) {
  const where = `http://${info.bind ?? '127.0.0.1'}:${info.port ?? '?'}`
  return [
    '[proxy] ============================================================',
    '[proxy] MODE 2 — ORIGIN. There is NO Sanity project and NO upstream.',
    '[proxy] Identity is SYNTHETIC: a fabricated `local-dev` user with all',
    '[proxy] grants. Nothing is authenticated and nothing can be.',
    `[proxy] LOOPBACK ONLY — bound to ${where}. Do not expose this port.`,
    '[proxy] Every document is branch-created; there is no base dataset.',
    `[proxy] overlay root : ${info.root ?? '(unset)'}`,
    `[proxy] project/ds   : ${info.projectId ?? '(unset)'} / ${info.dataset ?? '(unset)'}`,
    '[proxy] ============================================================',
  ].join('\n')
}
