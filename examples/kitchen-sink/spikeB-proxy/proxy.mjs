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
 *     => credentials forwarded faithfully; CORS reflected locally (the proxy, not
 *        Sanity, is the browser-facing origin).
 *   - The write path is the Actions API (`POST /data/actions/<ds>`), not `/data/mutate`.
 *     => the write guard must cover it explicitly.
 *   - Studio's listener also opens a WebSocket (`/v2022-06-30/socket/<dataset>`).
 *     => the server must handle `upgrade`, or the handshake dies and Studio spins on
 *        "No activity within 45000 milliseconds. Reconnecting." with panes stuck on
 *        "Loading document…".
 *
 * Usage:
 *   node proxy.mjs                       # CLI: config from the environment
 *   import {createProxyServer} from './proxy.mjs'   # embedded: config injected
 *
 * Env (CLI defaults; every one is overridable through createProxyServer options):
 *   PROXY_PORT=3999                       listen port
 *   PROXY_BIND=<addr>                     bind address (default: all interfaces, v4+v6)
 *   SANITY_API_HOST=https://b1n03q3z.api.sanity.io   upstream origin
 *   PROXY_BLOCK_WRITES=1                  enable the overlay write guard
 *   PROXY_DERIVE_PROJECT_HOST=0           disable `<project>.localhost` -> `<project>.api.sanity.io`
 *   PROXY_FORWARD_ORIGIN=1                forward browser Origin/Referer upstream (default: strip)
 *   PROXY_REWRITE_COOKIES=0               disable Set-Cookie Domain/Secure rewriting
 *   PROXY_LOG=<path>                      JSONL request log (default: ./proxy-log.jsonl)
 *   PROXY_VERBOSE=1                       also mirror the log line to stderr
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {createRealtimeFrameGuard, isWriteRequest} from './writeGuard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

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

/** Headers the proxy owns and therefore strips from the upstream response. */
const PROXY_OWNED_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
])

const DEFAULT_ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
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
 * Reflect CORS for the browser. Studio uses `withCredentials: true`, so a wildcard
 * origin is illegal — the request Origin must be echoed verbatim.
 */
function corsHeaders(req) {
  const origin = req.headers.origin
  const headers = {
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
  } else {
    // Non-browser caller (curl, server-side client): wildcard is fine and
    // credentials must NOT be advertised alongside it.
    headers['Access-Control-Allow-Origin'] = '*'
  }
  return headers
}

function preflightHeaders(req) {
  return {
    ...corsHeaders(req),
    'Access-Control-Allow-Methods': DEFAULT_ALLOW_METHODS,
    'Access-Control-Allow-Headers':
      req.headers['access-control-request-headers'] || DEFAULT_ALLOW_HEADERS,
    'Access-Control-Max-Age': '600',
    'Content-Length': '0',
  }
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
 */
export function resolveProxyConfig(options = {}) {
  const env = options.env || process.env
  const upstream = new URL(
    options.upstream || env.SANITY_API_HOST || 'https://b1n03q3z.api.sanity.io',
  )
  return {
    port: options.port ?? Number(env.PROXY_PORT || 3999),
    bind: options.bind ?? env.PROXY_BIND ?? undefined,
    upstream,
    blockWrites:
      options.blockWrites ??
      (env.PROXY_BLOCK_WRITES === '1' || env.PROXY_BLOCK_WRITES === 'true'),
    deriveProjectHost: options.deriveProjectHost ?? env.PROXY_DERIVE_PROJECT_HOST !== '0',
    forwardOrigin: options.forwardOrigin ?? env.PROXY_FORWARD_ORIGIN === '1',
    rewriteCookies: options.rewriteCookies ?? env.PROXY_REWRITE_COOKIES !== '0',
    logPath: options.logPath ?? env.PROXY_LOG ?? join(HERE, 'proxy-log.jsonl'),
    verbose: options.verbose ?? env.PROXY_VERBOSE === '1',
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
 * Build (but do not start) the proxy. The caller owns `listen()` so tests can
 * bind port 0 and the CLI can bind the configured port.
 *
 * @param {object} [options] see resolveProxyConfig
 * @returns {import('node:http').Server} with `.proxyConfig` attached
 */
export function createProxyServer(options = {}) {
  const config = resolveProxyConfig(options)
  const {
    upstream: UPSTREAM,
    blockWrites: BLOCK_WRITES,
    deriveProjectHost: DERIVE_PROJECT_HOST,
    forwardOrigin: FORWARD_ORIGIN,
    rewriteCookies: REWRITE_COOKIES,
    logPath: LOG_PATH,
    verbose: VERBOSE,
    dialUpstream: DIAL_UPSTREAM,
  } = config

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
    const rawHost = (req.headers.host || '').split(':')[0].toLowerCase()
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

  function rewriteSetCookie(values) {
    if (!REWRITE_COOKIES) return values
    const list = Array.isArray(values) ? values : [values]
    return list.map((cookie) =>
      String(cookie)
        // `Domain=.sanity.io` would be rejected outright by a localhost origin.
        .replace(/;\s*Domain=[^;]*/gi, '')
        // `Secure` is unusable over plain-HTTP localhost.
        .replace(/;\s*Secure/gi, ''),
    )
  }

  // -------------------------------------------------------------------------
  // request handling
  // -------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    const startedAt = Date.now()
    const {pathname, search, apiPath} = splitPath(req.url || '/')
    let settled = false

    const finish = (status, blocked) => {
      if (settled) return
      settled = true
      logLine({
        at: new Date(startedAt).toISOString(),
        method: req.method,
        path: pathname,
        status,
        ms: Date.now() - startedAt,
        blocked: Boolean(blocked),
      })
    }

    // --- 1. CORS preflight is answered locally; it never reaches Sanity. -------
    if (req.method === 'OPTIONS') {
      res.writeHead(204, preflightHeaders(req))
      res.end()
      finish(204, false)
      return
    }

    // --- 2. Overlay write guard ----------------------------------------------
    if (isBlockedWrite(req.method, req.url || '/')) {
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
        ...corsHeaders(req),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      res.end(body)
      // Drain the request body so keep-alive survives a blocked POST.
      req.resume()
      finish(403, true)
      return
    }

    // --- 3. Forward ------------------------------------------------------------
    const hostname = resolveUpstreamHostname(req)
    const sse = isListenPath(apiPath)

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

        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const k = key.toLowerCase()
          if (HOP_BY_HOP.has(k)) continue
          if (PROXY_OWNED_RESPONSE_HEADERS.has(k)) continue
          if (k === 'set-cookie') {
            headers['Set-Cookie'] = rewriteSetCookie(value)
            continue
          }
          if (sse && k === 'content-length') continue
          headers[key] = value
        }
        for (const [name, value] of Object.entries(corsHeaders(req))) {
          setHeader(headers, name, value)
        }

        if (sse) {
          // Anything that could buffer the stream is neutralised here.
          setHeader(headers, 'Cache-Control', 'no-cache, no-transform')
          setHeader(headers, 'X-Accel-Buffering', 'no')
          setHeader(headers, 'Connection', 'keep-alive')
        }

        try {
          res.writeHead(status, headers)
        } catch (err) {
          upstreamRes.destroy()
          finish(status, false)
          return
        }

        if (sse) {
          // Push headers to the client immediately and disable Nagle so every
          // SSE frame leaves the socket the moment it arrives from Sanity.
          res.flushHeaders()
          res.socket?.setNoDelay(true)
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
          finish(status, false)
        })
        upstreamRes.on('error', () => {
          res.destroy()
          finish(status, false)
        })
        upstreamRes.on('aborted', () => {
          res.destroy()
          finish(status, false)
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
            ...corsHeaders(req),
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
      finish(502, false)
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
        finish(res.statusCode || 499, false)
      }
    })
    req.on('error', () => {
      abortUpstream()
      finish(400, false)
    })

    // Body passthrough (POST /data/query, POST /data/actions, asset uploads, ...).
    req.pipe(upstreamReq)
    req.on('end', () => {
      /* upstreamReq is ended by the pipe */
    })
  })

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
   */
  server.on('upgrade', (req, clientSocket, head) => {
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

    const finish = (status, blocked = false) => {
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
      })
    }

    // --- write guard, transport-independent ----------------------------------
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
      finish(403, true)
      return
    }

    const hostname = resolveUpstreamHostname(req)
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
    const upstreamSocket = DIAL_UPSTREAM(dialSpec)

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
      finish(parseStatusCode(chunk))
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
      finish(502)
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
      finish(502)
      teardown()
    })
    clientSocket.on('error', () => teardown())
    clientSocket.on('close', () => {
      finish(499)
      teardown()
    })
  })

  // Long-lived SSE connections must not be reaped by the server's own timers.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 75_000
  server.timeout = 0

  // Malformed request lines / oversized headers must not take the process down.
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  })

  server.proxyConfig = config
  return server
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isDirectRun =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  const server = createProxyServer()
  const {port: PORT, bind: BIND, upstream: UPSTREAM, ...flags} = server.proxyConfig

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
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  server.listen(PORT, BIND, () => {
    process.stderr.write(
      `[proxy] listening on http://${BIND || 'localhost'}:${PORT} -> ${UPSTREAM.origin}\n` +
        `[proxy] write-guard: ${flags.blockWrites ? 'ON (PROXY_BLOCK_WRITES=1)' : 'off'}` +
        ` · project-host derivation: ${flags.deriveProjectHost ? 'on' : 'off'}` +
        ` · origin forwarding: ${flags.forwardOrigin ? 'on' : 'off (stripped)'}\n` +
        `[proxy] log: ${flags.logPath}\n`,
    )
  })
}
