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
 *
 * Env:
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
import fs from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {isWriteRequest} from './writeGuard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = process.env

const PORT = Number(env.PROXY_PORT || 3999)
const BIND = env.PROXY_BIND || undefined
const UPSTREAM = new URL(env.SANITY_API_HOST || 'https://b1n03q3z.api.sanity.io')
const BLOCK_WRITES = env.PROXY_BLOCK_WRITES === '1' || env.PROXY_BLOCK_WRITES === 'true'
const DERIVE_PROJECT_HOST = env.PROXY_DERIVE_PROJECT_HOST !== '0'
const FORWARD_ORIGIN = env.PROXY_FORWARD_ORIGIN === '1'
const REWRITE_COOKIES = env.PROXY_REWRITE_COOKIES !== '0'
const LOG_PATH = env.PROXY_LOG || join(HERE, 'proxy-log.jsonl')
const VERBOSE = env.PROXY_VERBOSE === '1'

const upstreamIsTls = UPSTREAM.protocol === 'https:'
const transport = upstreamIsTls ? https : http
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: Infinity,
  maxFreeSockets: 64,
  // Studio holds many simultaneous SSE sockets; never let the agent recycle them early.
  scheduling: 'lifo',
})

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
// logging
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// path + guard helpers
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

function isListenPath(apiPath) {
  return apiPath === '/data/listen' || apiPath.startsWith('/data/listen/')
}

// ---------------------------------------------------------------------------
// CORS
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

// ---------------------------------------------------------------------------
// upstream request construction
// ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

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

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

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
        description: 'Writes to Content Lake are blocked by the overlay proxy (PRD §36.1 Track B).',
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
      port: UPSTREAM.port || (upstreamIsTls ? 443 : 80),
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
      `[proxy] write-guard: ${BLOCK_WRITES ? 'ON (PROXY_BLOCK_WRITES=1)' : 'off'}` +
      ` · project-host derivation: ${DERIVE_PROJECT_HOST ? 'on' : 'off'}` +
      ` · origin forwarding: ${FORWARD_ORIGIN ? 'on' : 'off (stripped)'}\n` +
      `[proxy] log: ${LOG_PATH}\n`,
  )
})
