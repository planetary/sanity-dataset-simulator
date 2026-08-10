#!/usr/bin/env node
/**
 * SPIKE A · Track B — HTTP API host / transport proxy (PRD §36.1 Track B)
 *
 * A dependency-free Node 22 HTTP server that sits between the pinned Sanity Studio
 * (`sanity dev` on http://localhost:3333) and the Sanity Content Lake API host
 * (https://<projectId>.api.sanity.io).
 *
 * Design constraints taken from Spike A Track A evidence
 * (docs/plans/evidence/phase-1/spike-a-studio-interception/{report.md,listener-event-shapes.md}):
 *
 *   - @sanity/client 7 streams `/data/listen` SSE over `fetch`, NOT `EventSource`.
 *     => response bodies MUST be forwarded incrementally, chunk by chunk, never buffered.
 *   - Studio opens 5-6 concurrent long-lived listen streams per document pane.
 *     => no request timeouts, keep-alive upstream agent, Nagle disabled.
 *   - Studio sends `Authorization: Bearer` and/or cookies (`withCredentials: true`).
 *     => credentials forwarded faithfully; CORS answered locally (the proxy, not
 *        Sanity, is the browser-facing origin). ANSWERED FROM AN ALLOWLIST, not
 *        reflected — see `corsHeaders` and `originSafety.mjs` §4 for the 2026-08-06
 *        P2-4 finding that verbatim reflection let any page the developer had
 *        open read every unpublished draft in the staging dataset.
 *   - The write path is the Actions API (`POST /data/actions/<ds>`), not `/data/mutate`.
 *     => the write guard must cover it explicitly.
 *   - Studio's listener also opens a WebSocket (`/v2022-06-30/socket/<dataset>`).
 *     => the server must handle `upgrade`, or the handshake dies and Studio spins on
 *        "No activity within 45000 milliseconds. Reconnecting." with panes stuck on
 *        "Loading document…".
 *
 *   - Chromium allows SIX concurrent HTTP/1.1 connections per origin and Studio holds
 *     six listener streams open, so over cleartext the SEVENTH request — the document
 *     pane's first snapshot — is queued forever and no pane ever loads. Content Lake is
 *     HTTP/2, where those six are streams on one connection.
 *     => the CLI serves HTTP/2 over TLS *on the same port*, chosen per connection by
 *        the first byte. See `createProxyStack` and `tlsMaterial.mjs`.
 *
 * Usage:
 *   node proxy.mjs                       # CLI: BOTH framings on PROXY_PORT
 *   import {createProxyServer} from './proxy.mjs'   # embedded, HTTP/1.1 only
 *   import {createProxyStack} from './proxy.mjs'    # embedded, both framings
 *
 * Env (CLI defaults; every one is overridable through createProxyServer options):
 *   PROXY_PORT=3999                       listen port (http:// AND https:// both)
 *   PROXY_BIND=<addr>                     bind address (default: all interfaces, v4+v6)
 *   PROXY_TLS=0                           disable the HTTP/2 listener (see README)
 *   PROXY_TLS_DIR=<dir>                   where a minted certificate is cached
 *   PROXY_TLS_CERT / PROXY_TLS_KEY        use a certificate you already have
 *   PROXY_TLS_SOURCE=mkcert|self-signed   pin a rung of the certificate ladder
 *   PROXY_TLS_NAMES=<a,b>                 extra certificate subject names
 *   SANITY_API_HOST=https://b1n03q3z.api.sanity.io   upstream origin — declare it
 *                                         in examples/kitchen-sink/.env, not in
 *                                         your shell; see resolveProxyConfig
 *   PROXY_BLOCK_WRITES=1                  enable the overlay write guard
 *   PROXY_DERIVE_PROJECT_HOST=0           disable `<project>.localhost` -> `<project>.api.sanity.io`
 *   PROXY_FORWARD_ORIGIN=1                forward browser Origin/Referer upstream (default: strip)
 *   PROXY_REWRITE_COOKIES=0               disable Set-Cookie rewriting (`Domain` always;
 *                                         `Secure` on the cleartext leg only)
 *   PROXY_LOG=<path>                      JSONL request log (default: ./proxy-log.jsonl)
 *   PROXY_VERBOSE=1                       also mirror the log line to stderr
 */

import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {createRealtimeFrameGuard, isWriteRequest} from './writeGuard.mjs'
import {describeTlsMaterial, ensureTlsMaterial, trustVisitUrl} from './tlsMaterial.mjs'
import {
  assertLoopbackBind,
  isGrantedOrigin,
  isLoopbackBind,
  isOriginModeRequested,
  isOriginWriteRoute,
  normalizeGrantedOrigins,
} from './originSafety.mjs'
import {loadExplicitEnv} from '../../explicitEnv.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The example this spike belongs to — where its `.env` files live. */
const STUDIO_DIR = join(HERE, '..')

/**
 * The upstream this spike is pointed at, declared in code.
 *
 * `SANITY_API_HOST` is the single most expensive ambient read in `examples/`,
 * because Mode 1 forwards Studio's REAL traffic — session cookie and bearer
 * token included — to whatever it names. An exported value from another project
 * would not misread content; it would post this developer's credentials to a
 * host they never typed. So it is resolved from `examples/kitchen-sink/.env`
 * (or this constant) and a disagreeing ambient value is refused.
 */
const DECLARED_UPSTREAM = Object.freeze({
  SANITY_API_HOST: 'https://b1n03q3z.api.sanity.io',
})

/**
 * Headers HTTP/2 has no spelling for, and which Node REFUSES to put on an h2
 * response: `ERR_HTTP2_INVALID_CONNECTION_HEADERS`, thrown from `respond()`.
 *
 * This overlaps {@link HOP_BY_HOP} almost entirely, and is a separate set on
 * purpose. `HOP_BY_HOP` is a FORWARDING rule about what a proxy may relay; this
 * is a FRAMING rule about what the wire can carry. The SSE branch below adds
 * `Connection: keep-alive` of its own accord — it is not relayed, so no
 * forwarding rule can catch it — and on an h2 stream that one header would turn
 * every listener into a 500. So the h2 response path filters again, at the last
 * moment, against the set that describes the transport rather than the relay.
 */
const H2_ILLEGAL_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
])

/** RFC 7230 §6.1 hop-by-hop headers — must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/**
 * Headers the proxy owns and therefore strips from the upstream response.
 *
 * THIS SET IS PART OF THE P2-4 FIX, not housekeeping. Everything else in
 * `upstreamRes.headers` is relayed WHOLESALE (see the forwarding loop below), so
 * any cross-origin grant Content Lake happens to emit would otherwise arrive at
 * the browser with the proxy's own hostname in front of it — defeating the
 * allowlist without touching it. The rule for membership is therefore "does this
 * header grant a cross-origin capability", not "have we seen Sanity send it".
 *
 * The last two were added when the allowlist landed:
 *   - `access-control-allow-private-network` is Chrome's Private Network Access
 *     grant, i.e. the header that lets a PUBLIC page reach a LOOPBACK server at
 *     all. Nothing upstream may issue that on this proxy's behalf.
 *   - `timing-allow-origin` is not an access grant, but it hands a cross-origin
 *     page this response's transfer size and timing, which is a side channel on
 *     content it cannot read directly.
 */
const PROXY_OWNED_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-allow-private-network',
  'timing-allow-origin',
])

/**
 * What the request path forwards when the write guard is OFF: everything,
 * because that is exactly what an unguarded proxy does.
 */
const DEFAULT_ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'

/**
 * What it forwards when the write guard is ON.
 *
 * `writeGuard.mjs` is default-deny and its read allowlist is reachable only by
 * `GET`/`HEAD` (any allowlisted path) and `POST` (the GROQ-over-POST fallback);
 * `PUT`, `PATCH` and `DELETE` classify as writes on every path there is, so the
 * guard 403s them unconditionally. `OPTIONS` is never a write and never reaches
 * the guard anyway — the preflight is answered locally, above it.
 *
 * A preflight that promised `DELETE` and then 403'd the request would be lying
 * in the security-relevant direction: it tells a browser the capability exists.
 * `test/proxy-cors.test.ts` pins the two sets equal by MEASURING the request
 * path rather than by restating this comment.
 */
const GUARDED_ALLOW_METHODS = 'GET, HEAD, POST, OPTIONS'
const DEFAULT_ALLOW_HEADERS =
  'Authorization, Content-Type, Accept, Accept-Encoding, X-Sanity-Project-ID, ' +
  'Sanity-Project-ID, X-Requested-With, Cache-Control, Last-Event-ID'
const EXPOSE_HEADERS =
  'Content-Length, Content-Type, Content-Encoding, X-Sanity-Warning, ' +
  'X-Sanity-Trace-Id, Retry-After, WWW-Authenticate'

// ---------------------------------------------------------------------------
// path helpers (config-free)
// ---------------------------------------------------------------------------

const API_VERSION_SEGMENT = /^v(?:\d{4}-\d{2}-\d{2}|\d+|X)$/

/** Split "/v2025-02-19/data/actions/parity?x=1" -> {pathname, search, apiPath}. */
function splitPath(rawUrl) {
  const qIndex = rawUrl.indexOf('?')
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex)
  const search = qIndex === -1 ? '' : rawUrl.slice(qIndex)
  // Strip a leading API-version segment so guard rules are version-agnostic.
  const segments = pathname.split('/')
  let apiPath = pathname
  if (segments.length > 1 && API_VERSION_SEGMENT.test(segments[1])) {
    apiPath = '/' + segments.slice(2).join('/')
  }
  return {pathname, search, apiPath}
}

function isListenPath(apiPath) {
  return apiPath === '/data/listen' || apiPath.startsWith('/data/listen/')
}

// ---------------------------------------------------------------------------
// CORS (config-free)
// ---------------------------------------------------------------------------

/**
 * `Vary` on an ordinary response. The grant below depends on the request
 * `Origin` and on nothing else, so that is the one field named here.
 *
 * NOT OPTIONAL, and not only on the responses that carry a grant. A shared cache
 * that stored the allowlisted answer without this would replay it, grant and
 * all, to the next origin that asked — re-opening the hole through the cache
 * rather than through the code. So it is emitted on every response, including
 * the ones that were refused a grant, because those are equally wrong to replay.
 */
const CORS_VARY = 'Origin'

/** A preflight additionally echoes the two `Access-Control-Request-*` fields. */
const PREFLIGHT_VARY = `${CORS_VARY}, Access-Control-Request-Headers, Access-Control-Request-Method`

/**
 * The browser-facing CORS grant — an ALLOWLIST, never a reflection.
 *
 * SECURITY REVIEW 2026-08-06, FINDING P2-4. This function used to echo
 * `req.headers.origin` verbatim alongside `Access-Control-Allow-Credentials:
 * true`. In Mode 2 the damage was contained by `origin.mjs`, which strips a
 * grant it would not have issued. In MODE 1 IT WAS LIVE: the forwarding path
 * below hands Content Lake's responses to the browser with that grant attached,
 * and the browser attaches the developer's own session cookie to the request
 * that produced them. Any page the developer had open could therefore read
 * whatever this proxy can read — every unpublished draft in the staging dataset.
 *
 * The allowlist is `originSafety.mjs`'s {@link isGrantedOrigin}: loopback
 * derived structurally from the same predicate the Mode 2 bind check uses, plus
 * anything the caller named explicitly. Its reasoning — including why a
 * wildcard entry is refused rather than supported, and why THIS surface keeps
 * emitting `Allow-Credentials` when the other three refuse to — is stated there
 * and not repeated here.
 *
 * TWO SHAPES ONLY, and that is load-bearing. Either the origin is granted and
 * gets `Allow-Origin` + `Allow-Credentials` + `Expose-Headers` together, or it
 * gets no access-control header at all. There is no third branch, so no response
 * anywhere in this file can emit one of those without the others, and none can
 * emit credentials to an origin off the list.
 *
 * AN ABSENT `Origin` GETS NOTHING — not even the `*` this used to send. There is
 * no browser to protect, so there is nothing to grant, and a cached `*` is a
 * grant to whoever the cache serves next.
 */
function corsHeaders(req, allowed) {
  const origin = req.headers.origin
  const headers = {Vary: CORS_VARY}
  if (!isGrantedOrigin(origin, allowed)) return headers
  headers['Access-Control-Allow-Origin'] = origin
  headers['Access-Control-Allow-Credentials'] = 'true'
  headers['Access-Control-Expose-Headers'] = EXPOSE_HEADERS
  return headers
}

/**
 * The preflight answer.
 *
 * It advertises the methods the REQUEST PATH will really forward — see
 * {@link GUARDED_ALLOW_METHODS} — rather than a fixed list, and it advertises
 * nothing whatsoever to an origin the allowlist refused. A 204 with no
 * access-control headers is how a preflight says no; the browser then never
 * sends the request.
 */
function preflightHeaders(req, allowed, blockWrites) {
  const headers = {...corsHeaders(req, allowed), 'Content-Length': '0'}
  if (headers['Access-Control-Allow-Origin'] === undefined) return headers
  headers.Vary = PREFLIGHT_VARY
  headers['Access-Control-Allow-Methods'] = blockWrites
    ? GUARDED_ALLOW_METHODS
    : DEFAULT_ALLOW_METHODS
  headers['Access-Control-Allow-Headers'] =
    req.headers['access-control-request-headers'] || DEFAULT_ALLOW_HEADERS
  headers['Access-Control-Max-Age'] = '600'
  return headers
}

/**
 * Union of `Vary` field lists, order-preserving and case-insensitively deduped.
 *
 * The proxy used to REPLACE the upstream `Vary` with its own, which silently
 * dropped `Vary: Accept-Encoding` — the same class of cache defect as dropping
 * `Vary: Origin`, one axis over: a shared cache would then be free to hand a
 * gzip body to a client that never asked for one. `*` absorbs everything, since
 * it already means "do not reuse this for any other request".
 */
function mergeVary(...values) {
  const tokens = []
  const seen = new Set()
  for (const value of values) {
    for (const raw of String(value ?? '').split(',')) {
      const token = raw.trim()
      if (token === '') continue
      if (token === '*') return '*'
      const key = token.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tokens.push(token)
    }
  }
  return tokens.join(', ')
}

/**
 * Case-insensitive header set. Node forwards `cache-control` and `Cache-Control`
 * as two separate header lines, which fetch() then joins into `no-cache, no-cache`.
 * Every proxy-owned header must therefore replace, not shadow, the upstream one.
 */
function setHeader(headers, name, value) {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
  headers[name] = value
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

// ---------------------------------------------------------------------------
// transport — the four places h2 is not "h1 with different framing"
// ---------------------------------------------------------------------------

/** Is this request an HTTP/2 stream rather than an HTTP/1.1 message? */
function isH2(req) {
  return req.httpVersionMajor === 2
}

/**
 * Did this request arrive over TLS?
 *
 * Both listeners can serve either protocol: the TLS listener answers HTTP/1.1
 * too (ALPN falls back, and Chrome opens WebSockets that way), so "h2" and
 * "encrypted" are independent questions and only one of them decides whether a
 * `Secure` cookie is usable.
 */
function isEncrypted(req) {
  if (isH2(req)) return true
  return Boolean(req.socket && req.socket.encrypted)
}

/**
 * The authority this request was addressed to.
 *
 * HTTP/2 has NO `Host` header — RFC 9113 §8.3.1 replaces it with the
 * `:authority` pseudo-header — so a proxy that reads `req.headers.host` and
 * nothing else silently stops deriving `<projectId>.localhost` ->
 * `<projectId>.api.sanity.io` the moment a browser negotiates h2, and sends
 * every project's traffic to the configured default instead.
 */
function requestAuthority(req) {
  const raw = req.headers[':authority'] ?? req.headers.host ?? ''
  return String(Array.isArray(raw) ? raw[0] : raw)
}

/**
 * Re-emit a request line + headers on a raw socket. Used only by the upgrade
 * path, which cannot go through `http.request()`: after the 101 the connection
 * stops being HTTP and becomes an opaque byte stream.
 */
function serializeRequestHead(method, target, headers) {
  const lines = [`${method} ${target} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

/**
 * How the upgrade path should dial the upstream — as data, so it can be
 * asserted without opening a socket.
 *
 * Extracted from the upgrade handler for evidence review F5a. The handler used
 * to build these options inline, which meant the branch that runs in
 * production (`https:` upstream, i.e. always, against `<project>.api.sanity.io`)
 * could only be exercised by standing up a real TLS server — and so it never
 * was. `test/proxy-tls.test.ts` now does both: it asserts this function
 * directly, AND drives a real `tls.connect` against a self-signed upstream.
 *
 * Three things here are load-bearing and each has a test:
 *   - `servername`: SNI must carry the DERIVED hostname (`resolveUpstreamHostname`
 *     rewrites `<project>.localhost` onto `<project>.api.sanity.io`), or the
 *     handshake asks for a certificate the upstream cannot present.
 *   - `ALPNProtocols: ['http/1.1']`: HTTP/2 removed the upgrade mechanism
 *     (RFC 9113 §8.1). If ALPN negotiates h2 the handshake bytes below are
 *     nonsense on the wire.
 *   - the ABSENCE of `rejectUnauthorized: false`. This proxy forwards the
 *     user's `Authorization: Bearer` upstream; disabling verification would
 *     hand that token to anything that can answer on the API host's address.
 *     Not a default worth relying on implicitly, so it is asserted.
 *
 * @param {{tls: boolean, hostname: string, port: number}} target
 * @returns {{transport: 'tls'|'net', connectEvent: 'secureConnect'|'connect', options: object}}
 */
export function upstreamDialSpec({tls: useTls, hostname, port}) {
  if (!useTls) {
    return {transport: 'net', connectEvent: 'connect', options: {host: hostname, port}}
  }
  return {
    transport: 'tls',
    connectEvent: 'secureConnect',
    options: {host: hostname, port, servername: hostname, ALPNProtocols: ['http/1.1']},
  }
}

/** Open the socket a dial spec describes. The default `dialUpstream`. */
function dialFromSpec(spec) {
  return spec.transport === 'tls' ? tls.connect(spec.options) : net.connect(spec.options)
}

// ---------------------------------------------------------------------------
// disposition — what happened to the bytes
// ---------------------------------------------------------------------------

/**
 * THE FIELD THE NETWORK AUDIT READS INSTEAD OF GUESSING.
 *
 * Every log record used to be `{at, method, path, status, ms, blocked}`, and
 * `blocked: true` means exactly one thing: THE WRITE GUARD REFUSED THIS. A
 * request refused by any other gate — the preflight, Mode 2's CSRF check, an
 * origin handler that threw — recorded `blocked: false`, and
 * `e2e/audit/predicates.mjs` read that absence as "forwarded to Sanity". The
 * last E2E run reported six escaped writes that never left the process.
 *
 * The mirror image is what makes it unusable: a REAL escape answering anything
 * but 403 was modelled identically, in the direction of a PASSING predicate. So
 * the log now states the fact rather than leaving it to be inferred, and it is
 * stated AT THE POINT OF THE DECISION — never reconstructed afterwards, because
 * a reconstruction is the same guess with a longer code path.
 *
 * `blocked` keeps its narrow meaning and becomes redundant-but-consistent:
 * `blocked === true` implies `disposition === 'local' && gate === 'write-guard'`,
 * which the audit checks rather than assumes.
 *
 * @param {string} gate the stage that produced the whole response here
 * @param {string} [refusal] that stage's own error code, when it has one
 */
function localDisposition(gate, refusal) {
  const entry = {disposition: 'local', gate}
  if (typeof refusal === 'string' && refusal !== '') entry.refusal = refusal
  return entry
}

/**
 * The proxy dialled the upstream and relayed.
 *
 * `target` is the REAL destination as `host:port`, because "forwarded" without a
 * destination cannot distinguish a test double on 127.0.0.1 from
 * `api.sanity.io:443`, and the audit's whole job is that distinction.
 *
 * A dial that was ATTEMPTED and failed is still `upstream`, flagged
 * `dialFailed`. That is deliberately conservative: an attempted egress recorded
 * as `local` is the one direction this field must never be wrong in.
 */
function upstreamDisposition(target, extra) {
  return {disposition: 'upstream', upstream: target, ...extra}
}

/** Status code of an HTTP response whose first bytes are `chunk`. */
function parseStatusCode(chunk) {
  const head = chunk.toString('latin1', 0, Math.min(chunk.length, 64))
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
  return match ? Number(match[1]) : 502
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the proxy configuration from explicit options first, the environment
 * second. Options exist so the proxy can be started in-process (tests, a future
 * `sanity-overlay` CLI) without mutating `process.env`; the CLI path below keeps
 * behaving exactly as documented in README.md.
 *
 * ONE VALUE IS TREATED DIFFERENTLY. Ports, bind addresses, log paths and the
 * four `PROXY_*` switches select behaviour on this machine, and reading them
 * from the shell is what they are for. `SANITY_API_HOST` names the host that
 * receives Studio's authenticated traffic, which is not a switch — see
 * `DECLARED_UPSTREAM` above.
 */
export function resolveProxyConfig(options = {}) {
  const env = options.env || process.env
  /**
   * The upstream is resolved from the DECLARED source, not from `env`.
   *
   * An injected `options.env` is explicit by construction — an in-process
   * caller typed that map — so it is treated as declared and checked against
   * nothing. The bare-CLI path (`node proxy.mjs`, no options) is the one that
   * inherits a shell, and there the declared files plus `DECLARED_UPSTREAM`
   * decide, with a disagreeing ambient `SANITY_API_HOST` refused outright.
   */
  const declaredUpstream = options.env
    ? {...DECLARED_UPSTREAM, ...options.env}
    : loadExplicitEnv({
        /* The Studio's own directory, and only it: one declared location for
         * the whole kitchen-sink example, which is the one the READMEs name. */
        dirs: [STUDIO_DIR],
        keys: Object.keys(DECLARED_UPSTREAM),
        defaults: DECLARED_UPSTREAM,
        who: 'spike-b proxy',
      })
  const upstream = new URL(
    options.upstream || declaredUpstream.SANITY_API_HOST || DECLARED_UPSTREAM.SANITY_API_HOST,
  )
  /**
   * MODE 2 (origin). Explicit opt-in only — see `originSafety.mjs`. In Mode 2
   * `upstream` is still resolved (the default keeps the config shape stable and
   * one less branch downstream) but is never dialled: the request path returns
   * before it can be.
   */
  const origin = isOriginModeRequested(options, env)
  return {
    port: options.port ?? Number(env.PROXY_PORT || 3999),
    // Mode 2 defaults to loopback instead of "every interface". An explicit
    // non-loopback bind is not corrected here — it is refused, loudly, below.
    bind: options.bind ?? env.PROXY_BIND ?? (origin ? '127.0.0.1' : undefined),
    upstream,
    origin,
    /**
     * The overlay-backed request handler, injected. It lives in `origin.mjs`,
     * which imports the TypeScript overlay packages; keeping it an option is
     * what lets this file stay loadable by bare `node proxy.mjs` in Mode 1.
     */
    originHandler: options.originHandler ?? null,
    blockWrites: origin
      ? // In Mode 2 the guard is not a policy switch. `PROXY_BLOCK_WRITES=0`
        // there would mean "classify nothing", and since Mode 2 routes two
        // classified writes to the overlay, an unclassified request would fall
        // through the whole boundary. Forced on, with no way to ask otherwise.
        true
      : (options.blockWrites ??
        (env.PROXY_BLOCK_WRITES === '1' || env.PROXY_BLOCK_WRITES === 'true')),
    /**
     * Extra browser origins granted CORS, on top of the loopback default.
     *
     * OPTION-ONLY, WITH NO ENVIRONMENT VARIABLE BEHIND IT, for the same reason
     * `dialUpstream` has none: this list is the whole of the P2-4 containment
     * (see `originSafety.mjs` §4), and an ambient value is exactly how a "just
     * let my other dev server in" instruction would widen a CREDENTIALLED grant
     * from outside the process. `'*'` is refused outright.
     */
    origins: normalizeGrantedOrigins(options.origins),
    deriveProjectHost: options.deriveProjectHost ?? env.PROXY_DERIVE_PROJECT_HOST !== '0',
    forwardOrigin: options.forwardOrigin ?? env.PROXY_FORWARD_ORIGIN === '1',
    rewriteCookies: options.rewriteCookies ?? env.PROXY_REWRITE_COOKIES !== '0',
    logPath: options.logPath ?? env.PROXY_LOG ?? join(HERE, 'proxy-log.jsonl'),
    verbose: options.verbose ?? env.PROXY_VERBOSE === '1',
    /* --- the HTTP/2 listener ------------------------------------------------
     *
     * ON BY DEFAULT, and read from the environment like every other switch
     * about this machine. It is not a security control — it does not decide
     * what may be forwarded, only which framings the same handler will accept —
     * so the reasoning that keeps `origins` option-only does not apply.
     *
     * `PROXY_TLS=0` is the documented opt-out for a run that has no browser in
     * it (curl, CI, the E2E suite's HTTP/1.1 relay). It costs nothing there and
     * it costs everything in a browser: see README, "HTTP/2". */
    tls: options.tls ?? env.PROXY_TLS !== '0',
    tlsDir: options.tlsDir ?? env.PROXY_TLS_DIR ?? join(HERE, '.tls'),
    tlsCertPath: options.tlsCertPath ?? env.PROXY_TLS_CERT,
    tlsKeyPath: options.tlsKeyPath ?? env.PROXY_TLS_KEY,
    /* `auto` walks the ladder in tlsMaterial.mjs. Tests pin `self-signed` so a
     * developer's mkcert installation cannot change what they measure. */
    tlsCertSource: options.tlsCertSource ?? env.PROXY_TLS_SOURCE ?? 'auto',
    /** Extra certificate subject names, comma-separated. */
    tlsNames: options.tlsNames ?? env.PROXY_TLS_NAMES ?? '',
    // Test seam ONLY, with no environment variable behind it on purpose: there
    // must be no way to weaken the upstream dial from outside the process.
    // `test/proxy-tls.test.ts` uses it to add a trust anchor for a self-signed
    // upstream and to count dials; it receives the spec `upstreamDialSpec`
    // produced and cannot see the request. Default is the real dial.
    dialUpstream: options.dialUpstream ?? dialFromSpec,
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/**
 * THE PROXY ITSELF — the guard, the relay, the log — as three handlers and no
 * server.
 *
 * WHY THIS IS FACTORED OUT. There are now two listeners: cleartext HTTP/1.1 on
 * the port everyone already uses, and TLS on the same port, where a browser
 * negotiates h2 and stops being limited to six concurrent connections. Two
 * listeners is a licence to grow two behaviours, and one of them would be the
 * one nobody tests — an h2 path that forgot the write guard, or forgot to log a
 * disposition, is precisely the kind of divergence the whole evidence chain
 * rests on not existing.
 *
 * So there are not two paths. There is one set of handlers, built once, and the
 * two servers are two ways of arriving at it. Everything transport-dependent is
 * decided PER REQUEST, from the request, by {@link isH2} and
 * {@link isEncrypted} — never per server — so the TLS listener's own HTTP/1.1
 * fallback (which is how Chrome opens a WebSocket) behaves like HTTP/1.1
 * automatically.
 *
 * @param {ReturnType<typeof resolveProxyConfig>} config
 */
export function createProxyCore(config) {
  const {
    upstream: UPSTREAM,
    blockWrites: BLOCK_WRITES,
    deriveProjectHost: DERIVE_PROJECT_HOST,
    forwardOrigin: FORWARD_ORIGIN,
    rewriteCookies: REWRITE_COOKIES,
    logPath: LOG_PATH,
    verbose: VERBOSE,
    dialUpstream: DIAL_UPSTREAM,
    origin: ORIGIN,
    originHandler: ORIGIN_HANDLER,
    origins: ORIGINS,
  } = config

  /** The CORS grant for this request, bound to this server's allowlist. */
  const cors = (req) => corsHeaders(req, ORIGINS)

  /* --- Mode 2 preconditions, checked before a socket exists ---------------
   *
   * Both are hard failures rather than warnings. Mode 2 serves a fabricated
   * full-grant identity; a Mode 2 process that started with either of these
   * wrong is a process that should not be running at all. */
  if (ORIGIN) {
    assertLoopbackBind(config.bind)
    if (ORIGIN_HANDLER === null || typeof ORIGIN_HANDLER.handle !== 'function') {
      throw new Error(
        'Mode 2 (origin) needs an `originHandler` — build one with ' +
          '`createOriginHandler()` from ./origin.mjs, or use ./runOrigin.mjs.',
      )
    }
  }

  const upstreamIsTls = UPSTREAM.protocol === 'https:'
  const upstreamPort = Number(UPSTREAM.port || (upstreamIsTls ? 443 : 80))
  const transport = upstreamIsTls ? https : http
  const agent = new transport.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: Infinity,
    maxFreeSockets: 64,
    // Studio holds many simultaneous SSE sockets; never let the agent recycle them early.
    scheduling: 'lifo',
  })

  // -------------------------------------------------------------------------
  // logging
  // -------------------------------------------------------------------------

  fs.mkdirSync(dirname(LOG_PATH), {recursive: true})

  /**
   * One JSONL line per request. Written synchronously so that a SIGTERM/SIGINT
   * during a spike run can never lose evidence.
   */
  function logLine(entry) {
    const line = JSON.stringify(entry)
    try {
      fs.appendFileSync(LOG_PATH, line + '\n')
    } catch (err) {
      process.stderr.write(`[proxy] log write failed: ${err.message}\n`)
    }
    if (VERBOSE) process.stderr.write(line + '\n')
  }

  // -------------------------------------------------------------------------
  // guard + upstream request construction
  // -------------------------------------------------------------------------

  /**
   * Overlay write guard (§36.1 Track B: "Reject unknown write-capable endpoints").
   *
   * The classification itself lives in `./writeGuard.mjs` and is pinned by the
   * write-guard contract in `packages/sanity-overlay-testkit`. It replaced the
   * inline rule set that Spike F escaped four ways (no leading slash, /assets/*,
   * /agent/action/*, /datasets/*); see that module's header for the full record.
   *
   * The proxy keeps only the policy switch: PROXY_BLOCK_WRITES decides *whether*
   * to enforce, the guard decides *what* counts as a write. The raw request URL
   * is handed over unmodified — normalising before classification is the guard's
   * job, and doing it here as well would just be a second place to get it wrong.
   */
  function isBlockedWrite(method, rawUrl) {
    if (!BLOCK_WRITES) return false
    return isWriteRequest({method, url: rawUrl})
  }

  /**
   * @sanity/client builds project-scoped URLs as `<protocol>://<projectId>.<apiHost-host>`.
   * With `apiHost: 'http://localhost:3999'` the browser therefore hits
   * `http://b1n03q3z.localhost:3999`. Chrome/Firefox resolve `*.localhost` to loopback,
   * so the request lands here — and we map the incoming first label back onto the
   * upstream host: `b1n03q3z.localhost` -> `b1n03q3z.api.sanity.io`.
   */
  function resolveUpstreamHostname(req) {
    const base = UPSTREAM.hostname
    if (!DERIVE_PROJECT_HOST) return base
    /* `requestAuthority`, not `req.headers.host`: HTTP/2 has no Host header. */
    const rawHost = requestAuthority(req).split(':')[0].toLowerCase()
    if (!rawHost || IPV4.test(rawHost) || rawHost.startsWith('[')) return base
    if (!rawHost.endsWith('.localhost')) return base // only rewrite for the *.localhost case
    const label = rawHost.split('.')[0]
    if (!label) return base
    const upstreamLabels = base.split('.')
    if (upstreamLabels.length < 2) return base
    upstreamLabels[0] = label
    return upstreamLabels.join('.')
  }

  function buildUpstreamHeaders(req, hostname, apiPath) {
    const out = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase()
      /* h2 pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`) have no
       * HTTP/1.1 spelling. Forwarded verbatim they do not merely arrive wrong —
       * `http.request` throws ERR_INVALID_HTTP_TOKEN and the request dies
       * before a socket exists. Their information is carried by the request
       * line and by `host`, both of which are set from them below. */
      if (k.startsWith(':')) continue
      if (HOP_BY_HOP.has(k)) continue
      if (k === 'host') continue
      if (!FORWARD_ORIGIN && (k === 'origin' || k === 'referer')) continue
      if (value === undefined) continue
      out[key] = value
    }
    out.host = UPSTREAM.port ? `${hostname}:${UPSTREAM.port}` : hostname

    // SSE must never be compressed: a gzip/br stream buffers until the deflate window
    // flushes, which would delay `welcome`/`mutation` events reaching Studio.
    if (isListenPath(apiPath)) {
      delete out['accept-encoding']
      delete out['Accept-Encoding']
    }
    return out
  }

  /**
   * Make an upstream cookie usable on THIS leg.
   *
   * `Domain=.sanity.io` is rejected outright by a localhost origin, on any
   * transport, so it goes unconditionally.
   *
   * `Secure` is transport-dependent, and it is the one rewrite that the h2
   * listener changed. Over cleartext a `Secure` cookie is simply discarded by
   * the browser, which is why it was stripped. Over TLS the opposite is true:
   * Sanity's session cookie is `SameSite=None`, and Chrome REJECTS
   * `SameSite=None` without `Secure` — so the strip that rescues the cleartext
   * leg destroys the cookie on the TLS one, and cookie auth (README, "Cookies —
   * the real blocker") stays broken for the exact topology that was supposed to
   * fix it. Each leg therefore gets the cookie it can actually store, and both
   * are self-consistent: whichever leg set it is the leg that can send it back.
   */
  function rewriteSetCookie(values, {overTls}) {
    if (!REWRITE_COOKIES) return values
    const list = Array.isArray(values) ? values : [values]
    return list.map((cookie) => {
      const withoutDomain = String(cookie).replace(/;\s*Domain=[^;]*/gi, '')
      return overTls ? withoutDomain : withoutDomain.replace(/;\s*Secure/gi, '')
    })
  }

  // -------------------------------------------------------------------------
  // request handling
  // -------------------------------------------------------------------------

  const handleRequest = (req, res) => {
    const startedAt = Date.now()
    const {pathname, search, apiPath} = splitPath(req.url || '/')
    const h2 = isH2(req)
    const overTls = isEncrypted(req)
    let settled = false

    /* Nothing may reap a listener stream: a document pane holds one open for as
     * long as it is mounted. On h1 this is `server.timeout = 0` below; an h2
     * stream carries its own. */
    res.setTimeout?.(0)

    /**
     * @param {number} status
     * @param {boolean} blocked the WRITE GUARD refused it — nothing wider
     * @param {object} where {@link localDisposition} or {@link upstreamDisposition};
     *   required, because a record that omits it is one the audit must treat as
     *   unproven, and every call site here knows the answer
     */
    const finish = (status, blocked, where) => {
      if (settled) return
      settled = true
      logLine({
        at: new Date(startedAt).toISOString(),
        method: req.method,
        path: pathname,
        status,
        ms: Date.now() - startedAt,
        blocked: Boolean(blocked),
        /* WHICH LISTENER SERVED IT. Additive and omitted on HTTP/1.1, so every
         * record the audit already knows how to read is byte-identical — but a
         * log that could not tell the two transports apart could not show that
         * the h2 path is guarded, and "the browser really used h2" would have
         * to be taken on trust. Everything else about this record is the same
         * on both, which is the property `proxy-h2.test.ts` pins. */
        ...(h2 ? {h2: true} : {}),
        ...where,
      })
    }

    // --- 1. CORS preflight is answered locally; it never reaches Sanity. -------
    if (req.method === 'OPTIONS') {
      res.writeHead(204, preflightHeaders(req, ORIGINS, BLOCK_WRITES))
      res.end()
      finish(204, false, localDisposition('preflight'))
      return
    }

    // --- 2. Overlay write guard ----------------------------------------------
    //
    // MODE 2 NOTE. The guard is consulted first and unchanged. The only thing
    // Mode 2 adds is a second question asked of the *same* verdict: is this one
    // of the two writes the overlay owns? If not, the 403 below stands exactly
    // as it does in Mode 1. `isOriginWriteRoute` is strict-canonical, so no
    // normalisation escape can reach the overlay through this branch — see
    // `originSafety.mjs`.
    const originOwnsWrite =
      ORIGIN && isOriginWriteRoute(req.method, req.url || '/', ORIGIN_HANDLER?.dataset)
    if (!originOwnsWrite && isBlockedWrite(req.method, req.url || '/')) {
      const body = JSON.stringify({
        error: {
          code: 'OVERLAY_WRITE_BLOCKED',
          description:
            'Writes to Content Lake are blocked by the overlay proxy (PRD §36.1 Track B).',
          method: req.method,
          path: pathname,
        },
      })
      res.writeHead(403, {
        ...cors(req),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      res.end(body)
      // Drain the request body so keep-alive survives a blocked POST.
      req.resume()
      finish(403, true, localDisposition('write-guard', 'OVERLAY_WRITE_BLOCKED'))
      return
    }

    // --- 3. MODE 2: answer from the overlay, and never dial anything ---------
    if (ORIGIN) {
      /**
       * `try` AROUND THE CALL, not only `.catch` after it.
       *
       * This used to read `Promise.resolve(ORIGIN_HANDLER.handle(…))`, and the
       * argument to `Promise.resolve` is evaluated BEFORE `Promise.resolve`
       * exists to wrap anything — so a handler that threw SYNCHRONOUSLY (a bad
       * option, a `require` that failed, any bug above its first `await`) went
       * straight past the `.catch` below to `uncaughtException`, and the client
       * got no response at all rather than the 500 this block plainly intends.
       * `origin.mjs`'s handler is `async`, which is why it was never seen; a
       * handler is an INJECTED callable and this file cannot assume that.
       */
      let answered
      try {
        answered = Promise.resolve(
          ORIGIN_HANDLER.handle(req, res, {pathname, search, apiPath, cors: cors(req)}),
        )
      } catch (err) {
        answered = Promise.reject(err)
      }
      answered
        .then(() =>
          /**
           * `res.overlayRefusalCode` is set by `origin.mjs`'s single `catch`
           * chokepoint, which is the only place that turns an `OriginError` into
           * a status. It is a plain property on the response object and NOT a
           * response header: this is a security-sensitive surface and there is
           * no reason to change the bytes on the wire to carry a log field.
           *
           * Without it the 415 above is indistinguishable from any other local
           * answer, and the audit's finding reads "a write was refused" with no
           * way to see WHICH gate refused it.
           */
          finish(res.statusCode || 200, false, localDisposition('origin', res.overlayRefusalCode)),
        )
        .catch((err) => {
          if (!res.headersSent) {
            const body = JSON.stringify({
              error: {
                code: 'OVERLAY_ORIGIN_ERROR',
                description: 'The overlay origin failed to answer this request',
                message: err?.message ?? String(err),
              },
            })
            try {
              res.writeHead(500, {
                ...cors(req),
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
              })
              res.end(body)
            } catch {
              res.destroy()
            }
          } else {
            res.destroy()
          }
          finish(500, false, localDisposition('origin-error', 'OVERLAY_ORIGIN_ERROR'))
        })
      return
    }

    // --- 4. Mode 1: forward upstream -------------------------------------------
    const hostname = resolveUpstreamHostname(req)
    const sse = isListenPath(apiPath)
    /**
     * Where the bytes are about to go, resolved BEFORE the dial and used by
     * every `finish` below it.
     *
     * Past this line there is no local answer left to give: a 502, a 499 on a
     * client abort and a `writeHead` that threw are all outcomes of a request
     * this proxy chose to relay, and every one of them is recorded as an egress.
     */
    const relayTarget = `${hostname}:${upstreamPort}`

    const upstreamReq = transport.request(
      {
        protocol: UPSTREAM.protocol,
        hostname,
        port: upstreamPort,
        method: req.method,
        path: pathname + search,
        headers: buildUpstreamHeaders(req, hostname, apiPath),
        agent,
        // servername is required for SNI when we rewrite the hostname
        servername: upstreamIsTls ? hostname : undefined,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502
        const headers = {}
        /**
         * The upstream's own `Vary`, held aside rather than copied.
         *
         * The CORS block below sets `Vary: Origin`, and `setHeader` REPLACES —
         * so copying the upstream value here would simply lose it, which is how
         * `Vary: Accept-Encoding` used to disappear on every forwarded response.
         * Both field lists matter, so they are merged instead.
         */
        let upstreamVary = ''

        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const k = key.toLowerCase()
          if (HOP_BY_HOP.has(k)) continue
          if (PROXY_OWNED_RESPONSE_HEADERS.has(k)) continue
          if (k === 'vary') {
            upstreamVary = Array.isArray(value) ? value.join(', ') : String(value ?? '')
            continue
          }
          if (k === 'set-cookie') {
            headers['Set-Cookie'] = rewriteSetCookie(value, {overTls})
            continue
          }
          if (sse && k === 'content-length') continue
          headers[key] = value
        }
        for (const [name, value] of Object.entries(cors(req))) {
          setHeader(headers, name, value)
        }
        setHeader(headers, 'Vary', mergeVary(upstreamVary, CORS_VARY))

        if (sse) {
          // Anything that could buffer the stream is neutralised here.
          setHeader(headers, 'Cache-Control', 'no-cache, no-transform')
          setHeader(headers, 'X-Accel-Buffering', 'no')
          /* HTTP/2 has no `Connection` header and Node throws
           * ERR_HTTP2_INVALID_CONNECTION_HEADERS rather than send one — the
           * stream is persistent by construction, so there is nothing to ask
           * for. On h1 it still matters. */
          if (!h2) setHeader(headers, 'Connection', 'keep-alive')
        }

        /* The last-moment framing filter. Everything above is a forwarding
         * decision; this is the wire refusing to carry a shape. It runs on ALL
         * h2 responses, not only SSE, so that no future edit anywhere above can
         * reintroduce a header that turns a whole class of response into a
         * 500 — which, for `/data/listen`, means every document pane. */
        if (h2) {
          for (const key of Object.keys(headers)) {
            if (H2_ILLEGAL_RESPONSE_HEADERS.has(key.toLowerCase())) delete headers[key]
          }
        }

        try {
          res.writeHead(status, headers)
        } catch (err) {
          upstreamRes.destroy()
          finish(status, false, upstreamDisposition(relayTarget))
          return
        }

        if (sse) {
          // Push headers to the client immediately and disable Nagle so every
          // SSE frame leaves the socket the moment it arrives from Sanity.
          res.flushHeaders()
          /* `res.socket` on an h2 stream is a Proxy that THROWS on any direct
           * manipulation — `setNoDelay` is one of the names it refuses
           * (ERR_HTTP2_NO_SOCKET_MANIPULATION) — and the session has already
           * disabled Nagle for itself, so there is nothing to ask for and
           * asking would kill the stream. h1 only. */
          if (!h2) res.socket?.setNoDelay(true)
          upstreamRes.socket?.setNoDelay(true)
        }

        // Manual chunk pump (instead of .pipe) so every chunk is written the
        // instant it arrives, with explicit backpressure handling.
        upstreamRes.on('data', (chunk) => {
          const ok = res.write(chunk)
          if (!ok) {
            upstreamRes.pause()
            res.once('drain', () => upstreamRes.resume())
          }
        })
        upstreamRes.on('end', () => {
          res.end()
          finish(status, false, upstreamDisposition(relayTarget))
        })
        upstreamRes.on('error', () => {
          res.destroy()
          finish(status, false, upstreamDisposition(relayTarget))
        })
        upstreamRes.on('aborted', () => {
          res.destroy()
          finish(status, false, upstreamDisposition(relayTarget))
        })
      },
    )

    // Never time out: /data/listen streams are open for the lifetime of a pane.
    upstreamReq.setTimeout(0)

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        const body = JSON.stringify({
          error: {
            code: 'OVERLAY_PROXY_UPSTREAM',
            description: `Upstream request to ${hostname} failed`,
            message: err.message,
          },
        })
        try {
          res.writeHead(502, {
            ...cors(req),
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
          })
          res.end(body)
        } catch {
          res.destroy()
        }
      } else {
        res.destroy()
      }
      /* The dial itself is what usually fails here (ECONNREFUSED, DNS, TLS), and
       * it is STILL recorded as an egress: the request was routed onto the
       * network path, and "we tried and it did not answer" must never be filed
       * as "the proxy handled it locally". */
      finish(502, false, upstreamDisposition(relayTarget, {dialFailed: true}))
    })

    // Client aborted (tab closed, pane unmounted, listener unsubscribed):
    // tear the upstream socket down so we do not leak sockets or events.
    const abortUpstream = () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    }
    req.on('aborted', abortUpstream)
    res.on('close', () => {
      if (!res.writableEnded) {
        abortUpstream()
        finish(res.statusCode || 499, false, upstreamDisposition(relayTarget))
      }
    })
    req.on('error', () => {
      abortUpstream()
      finish(400, false, upstreamDisposition(relayTarget))
    })

    // Body passthrough (POST /data/query, POST /data/actions, asset uploads, ...).
    req.pipe(upstreamReq)
    req.on('end', () => {
      /* upstreamReq is ended by the pipe */
    })
  }

  // -------------------------------------------------------------------------
  // protocol upgrade (Studio's listener WebSocket)
  // -------------------------------------------------------------------------

  /**
   * `GET /v2022-06-30/socket/<dataset>` with `Connection: Upgrade`.
   *
   * Without this listener Node does NOT emit `upgrade` at all: `parserOnIncoming`
   * clears `req.upgrade` when nobody is listening and replays the request down the
   * ordinary `request` path, where `buildUpstreamHeaders` strips the hop-by-hop
   * `Upgrade`/`Connection` headers — so Sanity answers a plain 404, Studio never
   * gets its socket, and every pane sits on "Loading document…" while the client
   * logs "No activity within 45000 milliseconds. Reconnecting."
   *
   * After the 101 the connection is no longer HTTP, so nothing here may parse the
   * byte stream: dial upstream raw, replay the handshake, then pipe.
   *
   * THE GUARD RUNS HERE TOO, and it has to.
   * `http.Server` routes a request to `upgrade` INSTEAD OF `request` the moment it
   * carries `Connection: Upgrade` + `Upgrade: <x>` — so everything that arrives
   * here has already gone around the write guard in the `request` handler above.
   * An earlier revision of this file argued that was harmless because "the
   * listener socket is a GET on a read-only channel". That reasoning describes
   * the request Studio sends, not the requests this handler can receive:
   *
   *     POST /v2025-02-19/data/actions/<ds>     <- two extra request headers
   *     Connection: Upgrade
   *     Upgrade: websocket
   *     <mutation body>
   *
   * Node routes that to `upgrade` as well, hands the body over as `head`, and the
   * code below would replay both upstream verbatim and stream the reply back — an
   * unguarded tunnel to Content Lake reachable by anyone who can reach the proxy.
   * Every Spike F gap class is spellable this way. A guard the transport can be
   * asked to skip is not a guard, so the same predicate is consulted, on the raw
   * request line, BEFORE the upstream socket is dialled.
   *
   * The 403 is serialised by hand because there is no `ServerResponse` at this
   * point in the lifecycle — Node has already handed us the bare socket.
   *
   * WHAT HTTP/2 CHANGED HERE: NOTHING, AND THAT IS THE ANSWER.
   * RFC 9113 §8.1 deleted the `Upgrade:` mechanism outright; h2's replacement
   * is RFC 8441 Extended CONNECT, which a server must opt into by advertising
   * `SETTINGS_ENABLE_CONNECT_PROTOCOL`. This proxy deliberately does NOT
   * advertise it, so Chrome does what it does against any origin that has not:
   * it opens `new WebSocket()` on a SEPARATE HTTP/1.1 TLS connection, which the
   * same listener serves (`allowHTTP1: true`) and which arrives here as an
   * ordinary upgrade. That is not a workaround, it is the better answer — the
   * `Upgrade:` handshake is the shape the write guard, the frame guard and the
   * 101 relay below all understand, and WebSockets have their own, far larger
   * per-host budget, so this leg was never what the six-connection ceiling was
   * about. If Extended CONNECT is ever wanted, it needs a frame guard that
   * speaks it; until then, not advertising it is what keeps this handler true.
   */
  const handleUpgrade = (req, clientSocket, head) => {
    const startedAt = Date.now()
    const {pathname, search, apiPath} = splitPath(req.url || '/')
    let settled = false

    // Node hands this event a BARE socket: no error handling of its own, and an
    // 'error' with no listener is THROWN, not logged. A client that RSTs the
    // instant its head is on the wire would otherwise take the process down from
    // inside the very branch that exists to reject it. First thing, every time.
    clientSocket.on('error', () => {
      if (!clientSocket.destroyed) clientSocket.destroy()
    })

    const finish = (status, blocked, where) => {
      if (settled) return
      settled = true
      logLine({
        at: new Date(startedAt).toISOString(),
        method: req.method,
        path: pathname,
        status,
        ms: Date.now() - startedAt,
        blocked: Boolean(blocked),
        upgrade: true,
        ...where,
      })
    }

    // --- write guard, transport-independent ----------------------------------
    //
    // MODE 2 does NOT extend the origin write allowlist to this path. The two
    // overlay-owned routes are ordinary POSTs with a body; there is no reason
    // for either to arrive as an upgrade, and "the same write, but wearing two
    // extra headers" is precisely the shape this handler's 403 exists to stop.
    if (isBlockedWrite(req.method, req.url || '/')) {
      const body = JSON.stringify({
        error: {
          code: 'OVERLAY_WRITE_BLOCKED',
          description:
            'Writes to Content Lake are blocked by the overlay proxy (PRD §36.1 Track B).',
          method: req.method,
          path: pathname,
          upgrade: true,
        },
      })
      if (clientSocket.writable) {
        clientSocket.end(
          'HTTP/1.1 403 Forbidden\r\n' +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Cache-Control: no-store\r\n' +
            'Connection: close\r\n\r\n' +
            body,
        )
      } else {
        clientSocket.destroy()
      }
      finish(403, true, localDisposition('write-guard', 'OVERLAY_WRITE_BLOCKED'))
      return
    }

    // --- MODE 2: the socket terminates here; there is nothing to tunnel to ----
    if (ORIGIN) {
      let status = 501
      /* The handshake is completed, refused or 501'd entirely inside this
       * process. There is no upstream in Mode 2, so there is no branch here
       * that could produce anything but `local`. */
      let where = localDisposition('origin-upgrade')
      try {
        if (typeof ORIGIN_HANDLER.handleUpgrade === 'function') {
          status = ORIGIN_HANDLER.handleUpgrade(req, clientSocket, head, {pathname, search, apiPath}) || 101
        } else if (clientSocket.writable) {
          clientSocket.end(
            'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          )
        }
      } catch (err) {
        if (clientSocket.writable) {
          clientSocket.end(
            'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          )
        } else {
          clientSocket.destroy()
        }
        status = 500
        where = localDisposition('origin-upgrade-error', 'OVERLAY_ORIGIN_ERROR')
      }
      finish(status, false, where)
      return
    }

    const hostname = resolveUpstreamHostname(req)
    /** Same contract as the request path: every outcome below is an egress. */
    const relayTarget = `${hostname}:${upstreamPort}`
    const headers = buildUpstreamHeaders(req, hostname, apiPath)
    // `Connection`/`Upgrade` are hop-by-hop for a proxied request — but for an
    // upgrade they *are* the request, so they are restored for this one hop.
    setHeader(headers, 'Connection', 'Upgrade')
    setHeader(headers, 'Upgrade', req.headers.upgrade || 'websocket')

    const dialSpec = upstreamDialSpec({
      tls: upstreamIsTls,
      hostname,
      port: upstreamPort,
    })
    /**
     * The dial is wrapped for the same reason the Mode 2 `handle()` call above
     * is: `DIAL_UPSTREAM` is an INJECTED callable, and this handler has already
     * been given a raw socket. A synchronous throw here — a bad TLS option, an
     * `ENOENT` on a trust anchor — would leave that socket open with nothing
     * listening on either end, so the client hangs until it times out instead of
     * being told. A 502 is the same answer the asynchronous failure below gives.
     */
    let upstreamSocket
    try {
      upstreamSocket = DIAL_UPSTREAM(dialSpec)
    } catch (err) {
      if (clientSocket.writable) {
        const body = JSON.stringify({
          error: {
            code: 'OVERLAY_PROXY_UPSTREAM',
            description: `Upstream upgrade to ${hostname} could not be dialled`,
            message: err?.message ?? String(err),
          },
        })
        clientSocket.end(
          'HTTP/1.1 502 Bad Gateway\r\n' +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body,
        )
      } else {
        clientSocket.destroy()
      }
      finish(502, false, upstreamDisposition(relayTarget, {dialFailed: true}))
      return
    }

    let torn = false
    const teardown = () => {
      if (torn) return
      torn = true
      if (!clientSocket.destroyed) clientSocket.destroy()
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    }

    // Frames must leave the moment they arrive, and a listener socket lives for
    // the lifetime of a pane — no Nagle, no timeouts, on either leg.
    clientSocket.setNoDelay(true)
    clientSocket.setTimeout(0)
    upstreamSocket.setNoDelay(true)
    upstreamSocket.setTimeout(0)

    /* --- the frame guard (evidence review F5b) ------------------------------
     *
     * Past the 101 this handler used to `clientSocket.pipe(upstreamSocket)` —
     * an opaque bidirectional tunnel on an allowlisted path, carrying the
     * user's credentials. `/v2022-06-30/socket/<ds>` is not a stream: it is
     * @sanity/bifur-client's JSON-RPC 2.0 channel, and `'mutate'` is one of its
     * declared client request methods (see writeGuard.mjs's realtime section
     * for the source citations). So the client leg is parsed, classified and
     * logged frame by frame instead of piped.
     *
     * Only when the client asked for `websocket`. Any other upgrade protocol
     * has no framing this guard understands; it is relayed as before and the
     * log says `frameGuard: 'not-applicable'` rather than implying an audit
     * that did not happen.
     */
    const isWebSocket = /websocket/i.test(String(req.headers.upgrade || ''))
    const frameGuard = isWebSocket ? createRealtimeFrameGuard({enforce: BLOCK_WRITES}) : null

    /**
     * One log line per client frame. Method name and JSON-RPC id only —
     * NEVER `params`. The first frame the bifur client sends is
     * `{method:'authorization', params:{authorization:'Bearer <token>'}}`
     * (@sanity/bifur-client/src/createClient.ts:107-125); a guard that logged
     * payloads would write the user's credential to disk on every connection.
     *
     * THE DISPOSITION IS THE SOCKET'S, NOT THE FRAME'S. Every frame here is on
     * an already-established Mode 1 tunnel — the Mode 2 branch returned long
     * before this closure existed — so the byte path is upstream whatever the
     * frame guard decides to do with any individual frame. `blocked` still says
     * whether this one was stopped.
     */
    const logFrame = (verdict, enforced) => {
      logLine({
        at: new Date().toISOString(),
        method: 'WS',
        path: pathname,
        status: enforced ? 1008 : 101,
        ms: Date.now() - startedAt,
        blocked: Boolean(enforced),
        upgrade: true,
        ...upstreamDisposition(relayTarget),
        frame: true,
        opcode: verdict.opcode,
        rpc: verdict.rpcMethod,
        rpcId: verdict.rpcId,
        // The guard's verdict, independent of whether it was acted on — so an
        // escape in observation mode is still server-side evidenced.
        wouldBlock: Boolean(verdict.write),
        reason: verdict.reason,
      })
    }

    /** RFC 6455 §5.5.1 close frame, unmasked (server -> client). */
    const closeFrame = (code) => {
      const payload = Buffer.alloc(2)
      payload.writeUInt16BE(code)
      return Buffer.concat([Buffer.from([0x88, payload.length]), payload])
    }

    const rejectFrames = () => {
      if (clientSocket.writable) clientSocket.write(closeFrame(1008)) // policy violation
      teardown()
    }

    /**
     * Client -> upstream. Replaces `pipe()`, so backpressure is ours to manage:
     * a `write()` that returns false means the upstream's buffer is full and
     * the client must stop until it drains, or a slow listener socket turns
     * into unbounded memory growth in this process.
     */
    const forwardFromClient = (chunk) => {
      if (!frameGuard) {
        if (!upstreamSocket.write(chunk)) clientSocket.pause()
        return
      }
      const result = frameGuard.inspect(chunk)
      for (const verdict of result.frames) {
        logFrame(verdict, Boolean(result.blocked) && verdict.write && BLOCK_WRITES)
      }
      if (result.forward.length && !upstreamSocket.write(result.forward)) clientSocket.pause()
      if (result.blocked && BLOCK_WRITES) rejectFrames()
    }

    upstreamSocket.on('drain', () => clientSocket.resume())

    upstreamSocket.once(dialSpec.connectEvent, () => {
      upstreamSocket.write(serializeRequestHead(req.method || 'GET', pathname + search, headers))
      // Bytes the client pipelined behind its request head, before we dialled.
      // For a websocket upgrade these are by definition frames, so they go
      // through the guard like any others — otherwise putting the mutate frame
      // in the same TCP segment as the GET would walk straight past it.
      if (head && head.length) forwardFromClient(head)
      clientSocket.on('data', forwardFromClient)
    })

    // Sniff the status line of the first upstream chunk for the log, then get out
    // of the way: everything after it is opaque and must be relayed byte for byte
    // (the 101 and the first frames can share a single TCP segment).
    upstreamSocket.once('data', (chunk) => {
      finish(parseStatusCode(chunk), false, upstreamDisposition(relayTarget))
      if (clientSocket.writable) clientSocket.write(chunk)
      upstreamSocket.pipe(clientSocket, {end: false})
    })

    upstreamSocket.on('error', (err) => {
      if (!settled && clientSocket.writable) {
        const body = JSON.stringify({
          error: {
            code: 'OVERLAY_PROXY_UPSTREAM',
            description: `Upstream upgrade to ${hostname} failed`,
            message: err.message,
          },
        })
        clientSocket.write(
          'HTTP/1.1 502 Bad Gateway\r\n' +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body,
        )
      }
      finish(502, false, upstreamDisposition(relayTarget, {dialFailed: true}))
      teardown()
    })

    /**
     * FIN on either leg ends the session.
     *
     * Nothing reaps a half-closed upgraded socket for us: `http.Server` builds its
     * sockets with `allowHalfOpen: true` and removes its own FIN handling the
     * moment it emits `upgrade`, so a client that goes away leaves this socket
     * pair open forever — one leaked pair per closed pane. A bare FIN on a
     * WebSocket is the end of the connection anyway (RFC 6455 §7.1.1), so the
     * queued bytes are flushed towards the peer and then both legs are dropped.
     */
    const halfClose = (peer) => {
      if (peer.writable && !peer.writableEnded) peer.end(() => teardown())
      else teardown()
    }
    clientSocket.on('end', () => halfClose(upstreamSocket))
    upstreamSocket.on('end', () => halfClose(clientSocket))

    // Either side going away ends the session: a half-open upgraded socket is a
    // leak on one leg and a silent stall on the other.
    upstreamSocket.on('close', () => {
      finish(502, false, upstreamDisposition(relayTarget))
      teardown()
    })
    clientSocket.on('error', () => teardown())
    clientSocket.on('close', () => {
      finish(499, false, upstreamDisposition(relayTarget))
      teardown()
    })
  }

  // Malformed request lines / oversized headers must not take the process down.
  const handleClientError = (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  }

  return {config, handleRequest, handleUpgrade, handleClientError}
}

// ---------------------------------------------------------------------------
// the two listeners
// ---------------------------------------------------------------------------

/** Long-lived SSE streams must not be reaped by a server's own timers. */
function applyServerTimeouts(server) {
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = 0
}

/**
 * --- Mode 2: the same check again, against the address really bound ---------
 *
 * `assertLoopbackBind(config.bind)` reads the *config*. `listen()` takes its own
 * host argument and never consults it, so a launcher that passed
 * `server.listen(port)` — or `listen(port, '0.0.0.0')` — would sail past the
 * construction-time check and publish a full-grant identity server on every
 * interface. The authority on where a socket is bound is the socket, so the
 * socket is asked, and a wrong answer closes it before the first request.
 *
 * @param {{close: Function, emit: Function, address: Function}} bound the thing
 *   that actually owns the listening socket — the plain server in the
 *   single-listener case, the polyglot listener in the stack's.
 */
function refuseNonLoopback(bound) {
  const address = bound.address()
  const where = address === null || typeof address === 'string' ? address : address.address
  if (isLoopbackBind(where)) return
  bound.close()
  bound.emit(
    'error',
    new Error(
      `Mode 2 (origin) refused to serve: the socket bound ${String(where)}, which is not a ` +
        'loopback address. Its identity is synthetic and unauthenticated; it may only ' +
        'listen on 127.0.0.0/8 or ::1.',
    ),
  )
}

/**
 * Build (but do not start) the HTTP/1.1 proxy. The caller owns `listen()` so
 * tests can bind port 0 and the CLI can bind the configured port.
 *
 * UNCHANGED, ON PURPOSE. This is what every existing embedder, test and script
 * calls, and it still returns a bare `http.Server` that speaks cleartext
 * HTTP/1.1 and nothing else. The HTTP/2 listener is {@link createProxyStack},
 * which is additive: no caller of this function acquires a TLS socket, a
 * certificate, or a new port by upgrading.
 *
 * @param {object} [options] see resolveProxyConfig
 * @returns {import('node:http').Server} with `.proxyConfig` attached
 */
export function createProxyServer(options = {}) {
  const core = createProxyCore(resolveProxyConfig(options))
  const server = http.createServer(core.handleRequest)
  server.on('upgrade', core.handleUpgrade)
  server.on('clientError', core.handleClientError)
  applyServerTimeouts(server)
  if (core.config.origin) server.on('listening', () => refuseNonLoopback(server))
  server.proxyConfig = core.config
  return server
}

/**
 * Build (but do not start) the HTTP/2 + TLS listener, sharing `core`'s handlers.
 *
 * `allowHTTP1: true` is not a convenience. It is what makes a WebSocket work:
 * Chrome opens `new WebSocket()` on its own HTTP/1.1 TLS connection unless the
 * server advertises RFC 8441 Extended CONNECT, which this one does not (see
 * `handleUpgrade`). Without the fallback the realtime socket would simply fail
 * against the TLS listener while every other request succeeded.
 */
function createSecureListener(core, material) {
  const server = http2.createSecureServer({
    key: material.key,
    cert: material.cert,
    allowHTTP1: true,
    /* Studio opens six listener streams per pane and Chrome will happily open
     * more; the default of 100 is a ceiling of the same kind this listener
     * exists to remove. */
    settings: {maxConcurrentStreams: 256},
  })
  server.on('request', core.handleRequest)
  server.on('upgrade', core.handleUpgrade)
  server.on('clientError', core.handleClientError)
  applyServerTimeouts(server)
  /* A session lives as long as the pane that opened it. Nothing here may reap
   * it, and `session.setTimeout(0)` is how an h2 session says so. */
  server.on('session', (session) => session.setTimeout(0))
  return server
}

/**
 * The concrete hostnames a browser will ask this proxy for.
 *
 * `@sanity/client` prepends the project id as a label to the configured
 * `apiHost`, so with `apiHost: https://localhost:3999` the browser resolves and
 * requests `b1n03q3z.localhost`. That name must be IN the certificate — a
 * `*.localhost` wildcard alone is a single-label-parent wildcard, which
 * verifiers decline (see `tlsMaterial.mjs`).
 *
 * Both the configured upstream's project label and the declared one are
 * covered, because a test double on `127.0.0.1` leaves the first with nothing
 * usable and the developer's real project id is still the name their browser
 * will ask for.
 */
function browserHostnames(config) {
  const labels = new Set()
  for (const host of [
    config.upstream?.hostname,
    new URL(DECLARED_UPSTREAM.SANITY_API_HOST).hostname,
  ]) {
    if (!host || IPV4.test(host) || host.startsWith('[')) continue
    const [label] = host.split('.')
    if (label && label !== 'localhost') labels.add(label)
  }
  const extra = String(config.tlsNames || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return [...[...labels].map((label) => `${label}.localhost`), ...extra]
}

/** The first byte of a TLS ClientHello: ContentType `handshake` (RFC 8446 §5.1). */
const TLS_HANDSHAKE_BYTE = 0x16

/**
 * How long a connection may sit without sending its first byte.
 *
 * Not a policy, a leak fix: a socket that never speaks belongs to neither
 * server and would otherwise be held forever. Well above any handshake, well
 * below "forever".
 */
const SNIFF_TIMEOUT_MS = 30_000

/**
 * BOTH PROTOCOLS, ONE PORT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY h2 IS ADDITIVE AND NOT A REPLACEMENT
 *
 * Everything that speaks to this proxy today speaks cleartext HTTP/1.1 to it:
 * the CLI banner's URL, `curl http://localhost:3999/vX/ping`, every probe in
 * README's verification checklist, `test/proxy-*.test.ts`, and — right now —
 * `e2e/harness/dataPlaneFront.mjs`, which relays to it over HTTP/1.1. Replacing
 * the listener would break all of them to fix a problem only a browser has.
 *
 * WHY ONE PORT AND NOT TWO
 *
 * A second port is a second thing to configure, to document, to collide with,
 * and to get wrong; and the browser origin would then differ from the
 * documented one by both scheme AND port. TLS is trivially distinguishable from
 * an HTTP request line by its first byte — a ClientHello starts 0x16, and no
 * HTTP method does — so the first byte is peeked, pushed back, and the socket is
 * handed to whichever server owns that framing. The browser origin then differs
 * from today's only by `https:`, and every cleartext client keeps the address it
 * already has.
 *
 * The peek is the ONLY thing this layer does. It does not parse, classify, log
 * or answer; a socket reaches one of the two servers built above with its bytes
 * untouched, so nothing here can make a request look like anything other than
 * what the guard and the log saw.
 *
 * @param {object} [options] see resolveProxyConfig
 */
export function createProxyStack(options = {}) {
  const config = resolveProxyConfig(options)
  const core = createProxyCore(config)

  const plain = http.createServer(core.handleRequest)
  plain.on('upgrade', core.handleUpgrade)
  plain.on('clientError', core.handleClientError)
  applyServerTimeouts(plain)

  /* Minted (or read) at CONSTRUCTION, before a socket exists, so a machine that
   * cannot produce a certificate fails where it can be read — not on the first
   * browser request, three layers down, as a TLS alert. */
  const material = config.tls
    ? ensureTlsMaterial({
        dir: config.tlsDir,
        certPath: config.tlsCertPath,
        keyPath: config.tlsKeyPath,
        names: browserHostnames(config),
        source: config.tlsCertSource,
      })
    : null
  const secure = material ? createSecureListener(core, material) : null

  const sockets = new Set()

  const listener = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))

    /* Until a byte arrives this socket belongs to nobody, and an 'error' with no
     * listener is THROWN. Both of these are removed the instant it is handed
     * over, so the owning server's own error handling is not shadowed. */
    const preDispatchError = () => socket.destroy()
    const preDispatchTimeout = () => socket.destroy()
    socket.once('error', preDispatchError)
    socket.setTimeout(SNIFF_TIMEOUT_MS, preDispatchTimeout)

    const dispatch = (first) => {
      socket.off('error', preDispatchError)
      socket.off('timeout', preDispatchTimeout)
      /* `server.timeout` is 0 on both servers, and Node only calls
       * `setTimeout` on a connection when the server's timeout is non-zero — so
       * an armed sniff timer would survive the handover and reap the first
       * listener stream at 30 seconds. Disarm explicitly. */
      socket.setTimeout(0)
      socket.unshift(first)
      const target = first[0] === TLS_HANDSHAKE_BYTE ? secure : plain
      if (target === null) {
        /* TLS was asked for and this process has no certificate. Say so on the
         * wire rather than hanging: the client sees a connection reset, and the
         * banner said why at startup. */
        socket.destroy()
        return
      }
      target.emit('connection', socket)
    }

    /* `read(1)` may already have the byte, or may need one turn of the loop. */
    const peek = () => {
      const first = socket.read(1)
      if (first === null) return false
      dispatch(first)
      return true
    }
    if (!peek()) socket.once('readable', peek)
  })

  if (config.origin) listener.on('listening', () => refuseNonLoopback(listener))

  return {
    config,
    /** The HTTP/1.1 server. Never listens itself; it is fed sockets. */
    plain,
    /** The HTTP/2 + TLS server, or null when `PROXY_TLS=0`. */
    secure,
    /** The socket that is actually bound. */
    listener,
    /** What was minted or read, and what the developer still has to do. */
    tls: material,
    listen: (port = config.port, bind = config.bind) =>
      new Promise((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(port, bind, () => {
          listener.off('error', reject)
          const address = listener.address()
          resolve({port: address?.port ?? port, address})
        })
      }),
    address: () => listener.address(),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        listener.close(() => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isDirectRun =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  /**
   * THE CLI STARTS THE STACK, NOT THE BARE HTTP/1.1 SERVER.
   *
   * Mode 1 is the shipping topology and its whole point is a browser. A
   * cleartext-only listener is unusable there past the sixth concurrent stream,
   * so "started successfully" would be a lie the developer only discovers when
   * a document pane never loads. Both framings, one port, and if a certificate
   * cannot be produced this exits rather than starting something that looks
   * healthy and is not — `PROXY_TLS=0` is the way to say you meant cleartext.
   */
  let stack
  try {
    stack = createProxyStack()
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  const {port: PORT, bind: BIND, upstream: UPSTREAM, ...flags} = stack.config
  const server = stack.listener

  server.on('error', (err) => {
    process.stderr.write(`[proxy] server error: ${err.stack || err.message}\n`)
    if (err.code === 'EADDRINUSE') process.exit(1)
  })

  // A spike proxy should degrade, never die.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[proxy] uncaughtException: ${err.stack || err.message}\n`)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[proxy] unhandledRejection: ${reason}\n`)
  })

  const shutdown = (signal) => {
    process.stderr.write(`[proxy] ${signal} received, closing\n`)
    stack.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  stack.listen(PORT, BIND).then(() => {
    const host = BIND || 'localhost'
    process.stderr.write(
      `[proxy] listening on http://${host}:${PORT} -> ${UPSTREAM.origin}\n` +
        (stack.tls
          ? `[proxy] and on https://${host}:${PORT} — HTTP/2, which is what a BROWSER must use:\n` +
            `[proxy]   Chromium allows six concurrent HTTP/1.1 connections per origin and Studio\n` +
            `[proxy]   holds six listener streams open, so over http:// the seventh request (the\n` +
            `[proxy]   document pane's first snapshot) is queued forever and no pane ever loads.\n` +
            `[proxy]   In sanity.config.ts: apiHost: 'https://localhost:${PORT}'\n` +
            `[proxy] certificate: ${describeTlsMaterial(stack.tls)}\n` +
            (stack.tls.manualStep ? `[proxy] ONE-TIME STEP: ${stack.tls.manualStep}\n` : '') +
            /* The placeholder in `manualStep`, filled in — a developer should
             * not have to work out which URL "the origin" means. */
            (stack.tls.trusted === 'yes' || trustVisitUrl(stack.tls, PORT) === null
              ? ''
              : `[proxy]   i.e. visit ${trustVisitUrl(stack.tls, PORT)} and accept it, ` +
                'BEFORE loading the Studio\n')
          : '[proxy] HTTP/2 listener DISABLED (PROXY_TLS=0). A browser talking to this proxy will\n' +
            '[proxy]   stall at the seventh concurrent request; see README.md, "HTTP/2".\n') +
        `[proxy] write-guard: ${flags.blockWrites ? 'ON (PROXY_BLOCK_WRITES=1)' : 'off'}` +
        ` · project-host derivation: ${flags.deriveProjectHost ? 'on' : 'off'}` +
        ` · origin forwarding: ${flags.forwardOrigin ? 'on' : 'off (stripped)'}\n` +
        `[proxy] log: ${flags.logPath}\n`,
    )
  })
}
