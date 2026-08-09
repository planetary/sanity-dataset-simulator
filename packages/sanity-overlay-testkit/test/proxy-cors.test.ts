/**
 * SPIKE B PROXY — who may read what this proxy can read.
 *
 * THE DEFECT THIS FILE PINS
 * `docs/plans/evidence/phase-1/security-review-2026-08-06.md` finding P2-4, the
 * half that was left open when the other three surfaces were fixed.
 *
 *   `proxy.mjs` `corsHeaders` reflected the request `Origin` **verbatim**
 *   together with `Access-Control-Allow-Credentials: true`, and
 *   `preflightHeaders` advertised `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
 *   to that reflected origin.
 *
 * In **Mode 2** the residual was wrong-but-inert: `origin.mjs` now strips a grant
 * it would not have issued, and the write path 403s. In **Mode 1 it was live**.
 * The proxy forwards Content Lake's responses to the browser with that reflected
 * grant attached, and the browser attaches the developer's own session cookie to
 * the request that produced them — so any page the developer had open could read
 * whatever the proxy can read, which is every unpublished draft in the staging
 * dataset.
 *
 * THE POLICY, and why it is not simply "never emit credentials"
 * ------------------------------------------------------------
 * `packages/sanity-overlay-next/src/api.ts`, `examples/kitchen-sink/spikeA/
 * overlayServer.mjs` and `origin.mjs` all refuse to emit
 * `Access-Control-Allow-Credentials` **at all**, because none of them carries an
 * ambient credential: emitting it there is pure downside, and not emitting it
 * means a future widening of the allowlist cannot resurrect the hole.
 *
 * The proxy is the one surface where that reasoning does not transfer. It is a
 * browser-facing origin that deliberately holds an ambient credential: upstream
 * `Set-Cookie`s are rewritten onto the proxy's own host (`rewriteSetCookie`
 * strips `Domain=`/`Secure` precisely so they stick), and `@sanity/client` reads
 * through it with `withCredentials: true`. A response without
 * `Allow-Credentials: true` is one the browser refuses to expose to Studio, so
 * dropping the header does not harden Mode 1 — it deletes it.
 *
 * So the guarantee is bought a different way, and the tests below are what buy
 * it:
 *   - the grant is an ALLOWLIST, never a reflection;
 *   - `Allow-Origin` and `Allow-Credentials` are emitted from ONE branch, so
 *     there is no response anywhere that can carry one without the other, and
 *     none at all for an origin off the list;
 *   - the allowlist cannot be widened to a wildcard — `origins: ['*']` is
 *     refused at construction, which is the structural stand-in for "never emit
 *     credentials";
 *   - loopback is derived from `originSafety.mjs`'s `isLoopbackBind`, the same
 *     predicate the Mode 2 bind check uses. Studio's dev port is not knowable in
 *     advance (3333, 5173, whatever `--port` said), so a port list would be a
 *     guess; a DNS-rebound `https://evil.example` keeps its own origin and is
 *     still refused.
 *
 * THE CLASS, not the two functions
 * --------------------------------
 * Every response-writing path in `proxy.mjs` is exercised below — the preflight,
 * the write-guard 403, the Mode 1 upstream forward, the Mode 1 upstream-error
 * 502, the SSE stream, the Mode 2 handler error, and the upgrade path. A grant
 * attached to a 403 is still a grant.
 *
 * Every OTHER response header carrying authority is covered too: whether the
 * proxy relays upstream response headers wholesale (it must not relay a CORS
 * grant, `Timing-Allow-Origin`, or Chrome's Private Network Access grant), and
 * whether `Vary` names `Origin` on every one of those paths — an allowlisted
 * response cached and replayed for a different origin would re-open the hole
 * through the cache rather than through the code.
 */
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer, resolveProxyConfig} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {isWriteRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'

const DATASET = 'parity'
const V = '/v2025-02-19'
const READ_PATH = `${V}/data/query/${DATASET}?query=${encodeURIComponent('*[_type=="article"]')}`
const LISTEN_PATH = `${V}/data/listen/${DATASET}`
const BLOCKED_PATH = `${V}/users/me/keyvalue/studio-prefs`

const EVIL_ORIGIN = 'https://evil.example'
const STUDIO_ORIGIN = 'http://localhost:3333'
const VITE_ORIGIN = 'http://127.0.0.1:5173'
const IPV6_ORIGIN = 'http://[::1]:4000'
/** A name that merely CONTAINS "localhost" resolves wherever DNS says. */
const LOOKALIKE_ORIGIN = 'http://localhost.evil.example'

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-cors-'))
let logSeq = 0
const tempLog = (): string => path.join(LOG_DIR, `log-${(logSeq += 1)}.jsonl`)

const teardowns: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})
afterAll(() => fs.rmSync(LOG_DIR, {recursive: true, force: true}))

/* ------------------------------------------------------------------ *
 * a mock Content Lake whose response headers each test controls
 * ------------------------------------------------------------------ */

let upstreamExtraHeaders: Record<string, string> = {}
let upstream: http.Server
let upstreamOrigin = ''

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const isSse = (req.url || '').includes('/data/listen/')
    res.writeHead(200, {
      'content-type': isSse ? 'text/event-stream' : 'application/json',
      ...upstreamExtraHeaders,
    })
    if (isSse) {
      res.write('event: welcome\ndata: {}\n\n')
      /* Held open the way a real listener is; the test closes the socket. */
      return
    }
    res.end(JSON.stringify({result: []}))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('no upstream address')
  upstreamOrigin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

afterEach(() => {
  upstreamExtraHeaders = {}
})

/* ------------------------------------------------------------------ *
 * a raw HTTP client — `rawHeaders`, so a duplicated header line is
 * visible instead of being joined into one by undici
 * ------------------------------------------------------------------ */

interface Answer {
  status: number
  /** lower-cased name -> every value line, in order */
  headers: Map<string, string[]>
  body: string
}

function lines(answer: Answer, name: string): string[] {
  return answer.headers.get(name.toLowerCase()) ?? []
}

/** The value a browser would see: `null` when the header is absent. */
function header(answer: Answer, name: string): string | null {
  const values = lines(answer, name)
  return values.length === 0 ? null : values.join(', ')
}

async function startProxy(overrides: Record<string, unknown> = {}): Promise<string> {
  const server: http.Server = createProxyServer({
    upstream: upstreamOrigin,
    logPath: tempLog(),
    deriveProjectHost: false,
    env: {},
    ...overrides,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  teardowns.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no proxy address')
  return `http://127.0.0.1:${address.port}`
}

function send(
  base: string,
  target: string,
  options: {method?: string; headers?: Record<string, string>; body?: string} = {},
): Promise<Answer> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        method: options.method ?? 'GET',
        path: target,
        headers: options.headers ?? {},
      },
      (response) => {
        const headers = new Map<string, string[]>()
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          const name = response.rawHeaders[i]!.toLowerCase()
          const list = headers.get(name) ?? []
          list.push(response.rawHeaders[i + 1]!)
          headers.set(name, list)
        }
        const chunks: Buffer[] = []
        const settle = (): void =>
          resolve({status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8')})
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          /* An SSE response never ends; the headers are what this suite reads. */
          if (String(response.headers['content-type'] ?? '').includes('event-stream')) {
            response.destroy()
            settle()
          }
        })
        response.on('end', settle)
        response.on('error', settle)
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** Every proxy response shape that can carry a CORS grant, as data. */
async function everyResponsePath(origin: string | undefined): Promise<Array<[string, Answer]>> {
  const headers = origin === undefined ? {} : {origin}
  const forwarding = await startProxy({blockWrites: true})
  const unreachable = await startProxy({upstream: 'http://127.0.0.1:1'})
  return [
    ['preflight', await send(forwarding, READ_PATH, {method: 'OPTIONS', headers})],
    ['forwarded read', await send(forwarding, READ_PATH, {headers})],
    ['SSE stream', await send(forwarding, LISTEN_PATH, {headers})],
    [
      'write-guard 403',
      await send(forwarding, BLOCKED_PATH, {method: 'PUT', headers, body: '{}'}),
    ],
    ['upstream 502', await send(unreachable, READ_PATH, {headers})],
  ]
}

/* ================================================================== *
 * 1. The grant is an allowlist, not a reflection
 * ================================================================== */

describe('an arbitrary origin gets no CORS grant from the proxy', () => {
  for (const origin of [EVIL_ORIGIN, LOOKALIKE_ORIGIN, 'null', 'http://evil.example:3333']) {
    it(`${origin} is refused on every response the proxy writes`, async () => {
      for (const [label, answer] of await everyResponsePath(origin)) {
        expect(header(answer, 'access-control-allow-origin'), label).toBeNull()
        expect(header(answer, 'access-control-allow-credentials'), label).toBeNull()
        expect(header(answer, 'access-control-allow-methods'), label).toBeNull()
        expect(header(answer, 'access-control-expose-headers'), label).toBeNull()
      }
    })
  }

  it('never answers a reflected origin with a wildcard grant either', async () => {
    /* `Allow-Origin: *` cannot carry credentials, but it is still a grant, and a
     * cached one is a grant to whoever the cache serves next. */
    for (const [label, answer] of await everyResponsePath(EVIL_ORIGIN)) {
      expect(header(answer, 'access-control-allow-origin'), label).not.toBe('*')
    }
  })
})

describe('the origins the proxy does grant', () => {
  for (const origin of [STUDIO_ORIGIN, VITE_ORIGIN, IPV6_ORIGIN, 'http://127.0.0.7:9999']) {
    it(`${origin} is granted structurally, without guessing a port`, async () => {
      const base = await startProxy({blockWrites: true})
      const answer = await send(base, READ_PATH, {headers: {origin}})
      expect(answer.status).toBe(200)
      expect(header(answer, 'access-control-allow-origin')).toBe(origin)
      expect(header(answer, 'access-control-allow-credentials')).toBe('true')
    })
  }

  it('grants an origin named explicitly, whatever its host', async () => {
    const base = await startProxy({origins: ['https://studio.example']})
    const answer = await send(base, READ_PATH, {headers: {origin: 'https://studio.example'}})
    expect(header(answer, 'access-control-allow-origin')).toBe('https://studio.example')
    expect(header(answer, 'access-control-allow-credentials')).toBe('true')
  })

  it('refuses to be configured with a wildcard allowlist', () => {
    /* The structural stand-in for "never emit credentials". This surface DOES
     * hold an ambient credential, so the header has to stay — which means the
     * allowlist is the whole of the containment, and a wildcard entry would
     * reinstate verbatim reflection with credentials attached. */
    expect(() => resolveProxyConfig({origins: ['*'], env: {}})).toThrow(/wildcard/i)
    expect(() => createProxyServer({origins: ['*'], env: {}, logPath: tempLog()})).toThrow(
      /wildcard/i,
    )
  })
})

describe('a caller with no Origin', () => {
  it('is served normally and is handed no grant at all', async () => {
    /* curl, a server-side client, the recorded-session replays: there is no
     * browser to protect, so there is nothing to grant. */
    for (const [label, answer] of await everyResponsePath(undefined)) {
      expect(header(answer, 'access-control-allow-origin'), label).toBeNull()
      expect(header(answer, 'access-control-allow-credentials'), label).toBeNull()
    }
    const base = await startProxy({blockWrites: true})
    expect((await send(base, READ_PATH)).status).toBe(200)
  })
})

/* ================================================================== *
 * 2. The invariant, swept across every path and every origin
 * ================================================================== */

describe('Access-Control-Allow-Credentials is never emitted without an allowlisted grant', () => {
  it('holds for every response path x every origin shape', async () => {
    const ORIGINS = [
      undefined,
      EVIL_ORIGIN,
      LOOKALIKE_ORIGIN,
      'null',
      STUDIO_ORIGIN,
      VITE_ORIGIN,
      IPV6_ORIGIN,
    ]
    const granted = new Set([STUDIO_ORIGIN, VITE_ORIGIN, IPV6_ORIGIN])
    for (const origin of ORIGINS) {
      for (const [label, answer] of await everyResponsePath(origin)) {
        const where = `${label} <- ${String(origin)}`
        const credentials = header(answer, 'access-control-allow-credentials')
        const allow = header(answer, 'access-control-allow-origin')
        if (origin !== undefined && granted.has(origin)) {
          expect(allow, where).toBe(origin)
          expect(credentials, where).toBe('true')
        } else {
          expect(allow, where).toBeNull()
          expect(credentials, where).toBeNull()
        }
      }
    }
  })
})

/* ================================================================== *
 * 3. The preflight must not promise what the request path refuses
 * ================================================================== */

/** The methods a preflight advertised, as a set. */
function advertised(answer: Answer): Set<string> {
  const value = header(answer, 'access-control-allow-methods')
  if (value === null) return new Set()
  return new Set(value.split(',').map((method) => method.trim().toUpperCase()))
}

const PROBE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

/**
 * What the REQUEST path really permits, measured rather than asserted: every
 * method is driven at a real allowlisted read URL and the ones that are not
 * refused are the answer. An independent oracle — the preflight string is
 * computed by `preflightHeaders`, this set is computed by the write guard
 * plus the transport, and nothing shared produces both.
 */
async function methodsThePathPermits(base: string): Promise<Set<string>> {
  const permitted = new Set<string>()
  for (const method of PROBE_METHODS) {
    const answer = await send(base, READ_PATH, {method, headers: {origin: STUDIO_ORIGIN}})
    if (answer.status !== 403) permitted.add(method)
  }
  return permitted
}

describe('the advertised method set matches what the request path permits', () => {
  it('with the write guard on, does not promise PUT/PATCH/DELETE', async () => {
    const base = await startProxy({blockWrites: true})
    const preflight = await send(base, READ_PATH, {
      method: 'OPTIONS',
      headers: {origin: STUDIO_ORIGIN, 'access-control-request-method': 'PUT'},
    })
    const promised = advertised(preflight)
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect([...promised], method).not.toContain(method)
    }
    /* Independently: the guard classifies each of those as a write on this very
     * URL, so a preflight naming them is a preflight that lies. */
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(isWriteRequest({method, url: READ_PATH}), method).toBe(true)
    }
    /* OPTIONS is answered locally and never reaches the request path, so it is
     * the one member of the advertised set with no probe behind it. */
    promised.delete('OPTIONS')
    expect([...promised].sort()).toEqual([...(await methodsThePathPermits(base))].sort())
  })

  it('with the write guard off, advertises the verbs it really does forward', async () => {
    const base = await startProxy({blockWrites: false})
    const preflight = await send(base, READ_PATH, {
      method: 'OPTIONS',
      headers: {origin: STUDIO_ORIGIN},
    })
    const promised = advertised(preflight)
    promised.delete('OPTIONS')
    expect([...promised].sort()).toEqual([...(await methodsThePathPermits(base))].sort())
    expect([...promised]).toContain('DELETE')
  })

  it('promises nothing at all to an origin it does not grant', async () => {
    const base = await startProxy({blockWrites: true})
    const preflight = await send(base, READ_PATH, {
      method: 'OPTIONS',
      headers: {
        origin: EVIL_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(preflight.status).toBe(204)
    expect(advertised(preflight).size).toBe(0)
    expect(header(preflight, 'access-control-allow-headers')).toBeNull()
    expect(header(preflight, 'access-control-max-age')).toBeNull()
  })
})

/* ================================================================== *
 * 4. Upstream response headers must not smuggle a grant through
 * ================================================================== */

describe('the proxy does not relay an upstream grant wholesale', () => {
  const CASES: Array<[string, string]> = [
    ['access-control-allow-origin', EVIL_ORIGIN],
    ['access-control-allow-credentials', 'true'],
    ['access-control-allow-methods', 'GET, DELETE'],
    ['access-control-allow-headers', '*'],
    ['access-control-expose-headers', '*'],
    ['access-control-max-age', '86400'],
    /* Chrome's Private Network Access grant: the header that lets a PUBLIC page
     * reach a LOOPBACK server at all. Upstream has no business issuing it on
     * this proxy's behalf, and it is not one of the six the old set covered. */
    ['access-control-allow-private-network', 'true'],
    /* Not an access grant, but it does hand a cross-origin page this response's
     * transfer size and timing, which it is otherwise not entitled to. */
    ['timing-allow-origin', '*'],
  ]

  for (const [name, value] of CASES) {
    it(`strips an upstream ${name}`, async () => {
      upstreamExtraHeaders = {[name]: value}
      const base = await startProxy({blockWrites: true})
      const answer = await send(base, READ_PATH, {headers: {origin: EVIL_ORIGIN}})
      expect(answer.status).toBe(200)
      expect(header(answer, name)).toBeNull()
    })
  }

  it('does not let an upstream grant survive alongside the proxy grant', async () => {
    upstreamExtraHeaders = {
      'access-control-allow-origin': EVIL_ORIGIN,
      'access-control-allow-credentials': 'true',
    }
    const base = await startProxy({blockWrites: true})
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    /* Exactly one value, and it is the proxy's own — two `Allow-Origin` lines
     * are a CORS failure in Chrome and a coin toss elsewhere. */
    expect(lines(answer, 'access-control-allow-origin')).toEqual([STUDIO_ORIGIN])
    expect(lines(answer, 'access-control-allow-credentials')).toEqual(['true'])
  })

  it('still relays the ordinary upstream headers it does not own', async () => {
    upstreamExtraHeaders = {'x-sanity-trace-id': 'trace-1', 'cache-control': 'no-store'}
    const base = await startProxy({blockWrites: true})
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    expect(header(answer, 'x-sanity-trace-id')).toBe('trace-1')
    expect(header(answer, 'cache-control')).toBe('no-store')
  })
})

/* ================================================================== *
 * 5. Vary — or the cache re-opens the hole the code just closed
 * ================================================================== */

describe('Vary names Origin on every response that can carry a grant', () => {
  for (const origin of [undefined, EVIL_ORIGIN, STUDIO_ORIGIN]) {
    it(`for ${String(origin)}, on every response path`, async () => {
      for (const [label, answer] of await everyResponsePath(origin)) {
        const vary = header(answer, 'vary')
        expect(vary, label).not.toBeNull()
        expect(
          vary!
            .split(',')
            .map((token) => token.trim().toLowerCase()),
          label,
        ).toContain('origin')
      }
    })
  }

  it('emits exactly one Vary line, never two that a cache may read either way', async () => {
    upstreamExtraHeaders = {vary: 'Accept-Encoding'}
    const base = await startProxy({blockWrites: true})
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    expect(lines(answer, 'vary')).toHaveLength(1)
  })

  it('keeps the upstream Vary tokens instead of overwriting them', async () => {
    /* Dropping `Vary: Accept-Encoding` would let a shared cache hand a gzip body
     * to a client that never asked for one — the same class of defect as
     * dropping `Vary: Origin`, one axis over. */
    upstreamExtraHeaders = {vary: 'Accept-Encoding, X-Sanity-Perspective'}
    const base = await startProxy({blockWrites: true})
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    const tokens = header(answer, 'vary')!
      .split(',')
      .map((token) => token.trim().toLowerCase())
    expect(tokens).toContain('accept-encoding')
    expect(tokens).toContain('x-sanity-perspective')
    expect(tokens).toContain('origin')
    /* No token twice: a cache keying on a duplicated field is merely wasteful,
     * but it is also the sign the merge was a concatenation. */
    expect(new Set(tokens).size).toBe(tokens.length)
  })
})

/* ================================================================== *
 * 6. Mode 2 — the paths `origin.mjs` cannot reach
 * ================================================================== */

describe('Mode 2 response paths owned by the transport', () => {
  /** An overlay handler that always fails, to reach `proxy.mjs`'s own 500. */
  const failingHandler = {
    dataset: DATASET,
    handle(): never {
      throw new Error('boom')
    },
  }

  it('attaches no grant to the transport-level 500', async () => {
    const base = await startProxy({
      origin: true,
      originHandler: failingHandler,
      bind: '127.0.0.1',
      env: {},
    })
    const answer = await send(base, READ_PATH, {headers: {origin: EVIL_ORIGIN}})
    expect(answer.status).toBe(500)
    expect(header(answer, 'access-control-allow-origin')).toBeNull()
    expect(header(answer, 'access-control-allow-credentials')).toBeNull()
  })

  it('still hands the local Studio a usable grant on that same path', async () => {
    const base = await startProxy({
      origin: true,
      originHandler: failingHandler,
      bind: '127.0.0.1',
      env: {},
    })
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    expect(answer.status).toBe(500)
    expect(header(answer, 'access-control-allow-origin')).toBe(STUDIO_ORIGIN)
  })
})

/* ================================================================== *
 * 6b. An injected callable that throws SYNCHRONOUSLY
 * ================================================================== *
 *
 * Found by the tests above rather than by reading: `handle()` is invoked as
 * `Promise.resolve(ORIGIN_HANDLER.handle(...))`, and the argument is evaluated
 * BEFORE `Promise.resolve` exists to catch anything — so a synchronous throw
 * skips the `.catch` entirely, reaches `uncaughtException`, and the client gets
 * no response at all rather than the 500 the code plainly intends.
 *
 * The instance is one call site. The class is "every callable this file is
 * HANDED and then invokes", so each one is driven here with a thrower.
 */
describe('a synchronous throw from an injected callable still produces a response', () => {
  it('the Mode 2 request handler', async () => {
    const base = await startProxy({
      origin: true,
      bind: '127.0.0.1',
      env: {},
      originHandler: {
        dataset: DATASET,
        handle(): never {
          throw new Error('synchronous boom')
        },
      },
    })
    const answer = await send(base, READ_PATH, {headers: {origin: STUDIO_ORIGIN}})
    expect(answer.status).toBe(500)
    expect(answer.body).toContain('OVERLAY_ORIGIN_ERROR')
  })

  it('the Mode 1 upgrade dial', async () => {
    /* `dialUpstream` is a test seam, but the upgrade handler calls it bare: a
     * throw there is an uncaught exception on a path that has already been
     * handed a raw socket, so the client hangs instead of being told. */
    const base = await startProxy({
      dialUpstream: () => {
        throw new Error('synchronous dial failure')
      },
    })
    const socketPath = '/v2022-06-30/socket/parity'
    const received = await rawUpgrade(base, socketPath, [
      `GET ${socketPath} HTTP/1.1`,
      `Host: ${new URL(base).host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ])
    expect(received).toContain('502 Bad Gateway')
  })
})

/* ================================================================== *
 * 7. The upgrade path
 * ================================================================== */

/** Raw bytes back from an `Upgrade:` request; the upgrade path has no ServerResponse. */
function rawUpgrade(
  base: string,
  target: string,
  requestLines: string[],
): Promise<string> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: url.hostname, port: Number(url.port)}, () => {
      socket.write(requestLines.join('\r\n') + '\r\n\r\n')
    })
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('close', () => resolve(received))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 2000).unref()
  })
}

describe('the upgrade path attaches no grant of its own', () => {
  it('refuses a write smuggled through an upgrade with no CORS headers at all', async () => {
    const base = await startProxy({blockWrites: true})
    const received = await rawUpgrade(base, BLOCKED_PATH, [
      `PUT ${BLOCKED_PATH} HTTP/1.1`,
      `Host: ${new URL(base).host}`,
      `Origin: ${EVIL_ORIGIN}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Content-Length: 0',
    ])
    expect(received).toContain('403 Forbidden')
    expect(received.toLowerCase()).not.toContain('access-control-allow-origin')
    expect(received.toLowerCase()).not.toContain('access-control-allow-credentials')
  })

  it('adds no grant when relaying an upstream handshake', async () => {
    /* THE ONE WHOLESALE RELAY IN THIS FILE, and it is deliberate: past the
     * request head an upgraded connection is an opaque byte stream, so the
     * handler must not parse it. That is safe here because no browser API
     * exposes these bytes to page script — `fetch` cannot set `Connection`/
     * `Upgrade` (forbidden request headers) and the `WebSocket` API exposes no
     * response headers — so a CORS grant on a 101 grants nothing to anyone.
     * What this test pins is the part that IS ours: the proxy must not ADD a
     * grant of its own for an origin it does not allowlist. */
    const wsUpstream = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Access-Control-Allow-Origin: ${EVIL_ORIGIN}\r\n\r\n`,
        )
      })
    })
    await new Promise<void>((resolve) => wsUpstream.listen(0, '127.0.0.1', resolve))
    teardowns.push(() => new Promise<void>((resolve) => wsUpstream.close(() => resolve())))
    const wsAddress = wsUpstream.address()
    if (wsAddress === null || typeof wsAddress === 'string') throw new Error('no ws address')

    const base = await startProxy({upstream: `http://127.0.0.1:${wsAddress.port}`})
    const socketPath = '/v2022-06-30/socket/parity'
    const received = await rawUpgrade(base, socketPath, [
      `GET ${socketPath} HTTP/1.1`,
      `Host: ${new URL(base).host}`,
      `Origin: ${EVIL_ORIGIN}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ])
    expect(received).toContain('101 Switching Protocols')
    /* Exactly the one line upstream wrote — the proxy neither added a second
     * nor rewrote it into a grant for this origin. */
    const grants = received
      .split('\r\n')
      .filter((line) => line.toLowerCase().startsWith('access-control-allow-origin'))
    expect(grants).toEqual([`Access-Control-Allow-Origin: ${EVIL_ORIGIN}`])
    expect(received.toLowerCase()).not.toContain('access-control-allow-credentials')
  })
})
