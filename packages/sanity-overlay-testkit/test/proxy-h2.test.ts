/**
 * SPIKE B PROXY — HTTP/2, and every control that has to survive the new
 * transport.
 *
 * WHY THE PROXY LEARNED TO SPEAK h2
 * ---------------------------------
 * Chromium allows six concurrent HTTP/1.1 connections per origin, and
 * `sanity@6.8.0` holds exactly six long-lived SSE listeners open against the
 * data host. The seventh request — the document pair's initial snapshot — is
 * queued and never issued, so no pane ever loads and no keystroke can be typed.
 * Real Content Lake is HTTP/2, where those six listeners are six streams on one
 * connection, so a proxy standing in for it over HTTP/1.1 is not a faithful
 * stand-in: it imposes a ceiling the real service does not have.
 * `proxy-h2-browser.test.ts` measures both halves of that in a real browser.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The browser file proves the ceiling is gone. This file proves nothing else
 * went with it. Every protocol-dependent path is exercised OVER h2 and given a
 * verdict, because h2 is not "HTTP/1.1 with a different framing":
 *
 *   plain request     — pseudo-headers must never reach the upstream, and
 *                       `:authority` is where the project host now comes from
 *   preflight         — same allowlist, same advertised methods, same `Vary`
 *   SSE               — no `Connection` header exists in h2 and Node REFUSES to
 *                       send one (`ERR_HTTP2_INVALID_CONNECTION_HEADERS`), and
 *                       `session.socket.setNoDelay()` THROWS
 *   WebSocket upgrade — RFC 9113 §8.1 removed `Upgrade:`; Chrome opens its own
 *                       HTTP/1.1 TLS connection, which the same listener serves
 *   101 relay         — unchanged, and the write guard still runs before it
 *   upstream dial     — unchanged: h1 downstream or h2 downstream, the hop to
 *                       Content Lake is the same HTTP/1.1 request
 *   Set-Cookie        — `Secure` is only unusable on the CLEARTEXT leg
 *
 * and the log — the project's evidence that nothing ever wrote to a real Sanity
 * dataset — must record an h2 request exactly as it records an h1 one. A
 * disposition that the h2 path forgot to set would make the request read as
 * `unknown` to `e2e/audit/predicates.mjs` A10.
 */
import {afterAll, afterEach, describe, expect, it} from 'vitest'
import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyStack} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {planTlsMaterial} from '../../../examples/kitchen-sink/spikeB-proxy/tlsMaterial.mjs'
import {WRITE_GUARD_CASES} from '../src/writeGuardContract'

const DATASET = 'parity'
const V = '/v2025-02-19'
const PROJECT_HOST = 'b1n03q3z.localhost'
const READ_PATH = `${V}/data/query/${DATASET}?query=${encodeURIComponent('*[_type=="article"]')}`
const LISTEN_PATH = `${V}/data/listen/${DATASET}`
const ACTIONS_PATH = `${V}/data/actions/${DATASET}`
const STUDIO_ORIGIN = 'http://localhost:3333'
const EVIL_ORIGIN = 'https://evil.example'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-h2-'))
let seq = 0

const teardowns: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})
afterAll(() => fs.rmSync(TMP, {recursive: true, force: true}))

/* ------------------------------------------------------------------ *
 * a mock Content Lake, and a record of exactly what reached it
 * ------------------------------------------------------------------ */

interface Received {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
}

interface MockUpstream {
  origin: string
  received: Received[]
  upgrades: Received[]
  /** Extra response headers, per test. */
  extraHeaders: Record<string, string | string[]>
  held: () => number
}

async function startMockUpstream(): Promise<MockUpstream> {
  const received: Received[] = []
  const upgrades: Received[] = []
  const held = new Set<http.ServerResponse>()
  const state: MockUpstream = {
    origin: '',
    received,
    upgrades,
    extraHeaders: {},
    held: () => held.size,
  }

  const server = http.createServer((req, res) => {
    received.push({method: req.method || '', url: req.url || '', headers: req.headers})
    req.resume()
    if ((req.url || '').includes('/data/listen/')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...state.extraHeaders,
      })
      res.write('event: welcome\ndata: {}\n\n')
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    const body = JSON.stringify({ok: true, saw: req.url})
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...state.extraHeaders,
    })
    res.end(body)
  })

  /* An upgraded socket is DETACHED from the server: `closeAllConnections()` no
   * longer knows about it, so `close()` waits for it forever unless the test
   * keeps its own list. */
  const upgraded = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    upgrades.push({method: req.method || '', url: req.url || '', headers: req.headers})
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
    if (head?.length) socket.write(head)
    socket.on('data', (chunk: Buffer) => socket.write(chunk))
  })

  server.timeout = 0
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  state.origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
  teardowns.push(
    () =>
      new Promise<void>((resolve) => {
        for (const res of held) res.destroy()
        for (const socket of upgraded) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  return state
}

/* ------------------------------------------------------------------ *
 * the stack under test
 * ------------------------------------------------------------------ */

interface Stack {
  port: number
  logPath: string
  cert: string
  rows: () => Record<string, unknown>[]
  stack: {
    listener: net.Server
    secure: http2.Http2SecureServer
    plain: http.Server
    tls: {cert: Buffer; key: Buffer; source: string; certPath: string}
    close: () => Promise<void>
  }
}

async function startStack(
  upstreamOrigin: string,
  options: Record<string, unknown> = {},
): Promise<Stack> {
  const logPath = path.join(TMP, `log-${(seq += 1)}.jsonl`)
  const stack = createProxyStack({
    env: {},
    upstream: upstreamOrigin,
    logPath,
    tlsDir: path.join(TMP, `tls-${seq}`),
    tlsCertSource: 'self-signed',
    /* The mock upstream is an IP; the `<project>.localhost` rewrite would turn
     * `127.0.0.1` into `b1n03q3z.0.0.1`. The derivation has its own test below,
     * which is the only place it is left on. */
    deriveProjectHost: false,
    ...options,
  })
  const {port} = await stack.listen(0, '127.0.0.1')
  teardowns.push(() => stack.close())
  return {
    port,
    logPath,
    cert: String(stack.tls.cert),
    stack,
    rows: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  }
}

/** An h2 client that really verifies the certificate the proxy presented. */
function connectH2(stack: Stack): http2.ClientHttp2Session {
  const client = http2.connect(`https://127.0.0.1:${stack.port}`, {ca: stack.cert})
  teardowns.push(() => new Promise<void>((resolve) => client.close(() => resolve())))
  return client
}

interface H2Response {
  status: number
  headers: http2.IncomingHttpHeaders
  body: string
}

function h2Request(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  body?: string,
): Promise<H2Response> {
  return new Promise((resolve, reject) => {
    const stream = client.request({':authority': `${PROJECT_HOST}:443`, ...headers})
    const chunks: Buffer[] = []
    stream.on('response', (responseHeaders) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () =>
        resolve({
          status: Number(responseHeaders[':status']),
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    stream.on('error', reject)
    if (body === undefined) stream.end()
    else stream.end(body)
  })
}

/** A cleartext HTTP/1.1 request to the SAME port — the compatibility oracle. */
function h1Request(
  port: number,
  options: {method?: string; path: string; headers?: Record<string, string>; body?: string} = {
    path: '/',
  },
): Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method || 'GET',
        path: options.path,
        headers: {host: `${PROJECT_HOST}:${port}`, ...options.headers},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

/* ══════════════════════════════════════════════════════════════════ *
 * 1. the listener — both protocols, one port
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · the listener', () => {
  it('negotiates ALPN h2 over TLS', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    const alpn = await new Promise<string | false | null>((resolve, reject) => {
      const socket = tls.connect(
        {host: '127.0.0.1', port: stack.port, ca: [stack.cert], ALPNProtocols: ['h2', 'http/1.1']},
        () => {
          const negotiated = socket.alpnProtocol
          socket.destroy()
          resolve(negotiated)
        },
      )
      socket.on('error', reject)
    })

    /* The independent oracle for "this is HTTP/2": what the TLS handshake
     * agreed on, read from the client's own socket. */
    expect(alpn).toBe('h2')
  })

  it('serves cleartext HTTP/1.1 on the very same port, so nothing that works today stops', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    const response = await h1Request(stack.port, {path: READ_PATH})

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).ok).toBe(true)
    /* h2 is ADDITIVE. The existing CLI, `curl http://…`, and the E2E harness's
     * HTTP/1.1 relay all keep working against the address they already use. */
    expect(upstream.received.at(-1)?.url).toBe(READ_PATH)
  })

  it('presents a certificate that covers `<projectId>.localhost`, which is the name the browser asks for', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    /* `@sanity/client` builds `<projectId>.<apiHost-host>`, so a certificate
     * for `localhost` alone is one the browser refuses before a single byte of
     * HTTP is exchanged. Parsed with node:crypto rather than asked of the code
     * that minted it. */
    const certificate = new X509Certificate(stack.cert)
    expect(certificate.checkHost(PROJECT_HOST)).toBe(PROJECT_HOST)
    expect(certificate.checkHost('localhost')).toBe('localhost')
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1')
  })

  it('binds where it was asked to, and reports it', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)
    const address = stack.stack.listener.address() as net.AddressInfo
    expect(address.address).toBe('127.0.0.1')
  })

  /* --- the loopback control, on the socket the stack actually binds --------
   *
   * Mode 2 serves a fabricated fully-granted `local-dev` identity. It refused a
   * non-loopback bind in TWO places — at construction, from the config, and at
   * `listening`, from the socket — because `listen()` takes its own host
   * argument and never consults the config. The stack binds a DIFFERENT socket
   * from `createProxyServer`, so both halves have to be re-established here or
   * the control silently applies to a server nobody starts any more. */
  const originHandler = {
    dataset: DATASET,
    handle: async (_req: unknown, res: {statusCode: number; end: (body: string) => void}) => {
      res.statusCode = 200
      res.end('{}')
    },
  }

  it('MODE 2: refuses a non-loopback bind at construction', async () => {
    const upstream = await startMockUpstream()
    expect(() =>
      createProxyStack({
        env: {},
        upstream: upstream.origin,
        logPath: path.join(TMP, 'never-bind.jsonl'),
        tlsDir: path.join(TMP, 'never-bind-tls'),
        tlsCertSource: 'self-signed',
        origin: true,
        originHandler,
        bind: '0.0.0.0',
      }),
    ).toThrow(/loopback/i)
  })

  it('MODE 2: refuses a non-loopback bind again, from the socket, when `listen` disagrees', async () => {
    const upstream = await startMockUpstream()
    const stack = createProxyStack({
      env: {},
      upstream: upstream.origin,
      logPath: path.join(TMP, `late-bind-${(seq += 1)}.jsonl`),
      tlsDir: path.join(TMP, `late-bind-tls-${seq}`),
      tlsCertSource: 'self-signed',
      origin: true,
      originHandler,
      /* Config says loopback, so construction is satisfied… */
      bind: '127.0.0.1',
    })
    teardowns.push(() => stack.close())

    /* …and then the launcher asks for every interface anyway. */
    await expect(stack.listen(0, '0.0.0.0')).rejects.toThrow(/loopback/i)
    expect(stack.listener.address()).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 2. plain requests over h2
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · plain requests', () => {
  it('forwards, relays the body, and never leaks an h2 pseudo-header upstream', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    const response = await h2Request(client, {':method': 'GET', ':path': READ_PATH})

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).ok).toBe(true)
    const sent = upstream.received.at(-1)!
    /* `:method`, `:path`, `:scheme` and `:authority` have no HTTP/1.1 spelling.
     * Forwarded verbatim they are not merely wrong — `http.request` throws
     * ERR_INVALID_HTTP_TOKEN and the request dies. */
    expect(Object.keys(sent.headers).filter((name) => name.startsWith(':'))).toEqual([])
    expect(sent.headers.host).toMatch(/^127\.0\.0\.1:\d+$/)
  })

  it('derives the upstream project host from `:authority`, which is where h2 puts it', async () => {
    /* An upstream that cannot resolve, on purpose: the derived hostname is
     * recorded in the log BEFORE the dial, so the failure is the evidence and
     * no packet has to leave the machine to collect it. */
    const stack = await startStack('http://b1n03q3z.api.sanity.invalid:9', {
      deriveProjectHost: true,
    })
    const client = connectH2(stack)

    await h2Request(client, {
      ':method': 'GET',
      ':path': READ_PATH,
      ':authority': `otherproj.localhost:${stack.port}`,
    })
    await settle()

    /* h2 has no `Host` header. A proxy that only read `req.headers.host` would
     * silently stop deriving the project host and send every browser's traffic
     * to the configured default instead. */
    const row = stack.rows().at(-1)!
    expect(row.upstream).toBe('otherproj.api.sanity.invalid:9')
  })

  it('records the request in the log exactly as the h1 path does', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    await h2Request(client, {':method': 'GET', ':path': READ_PATH})
    await settle()

    const row = stack.rows().find((entry) => entry.path === READ_PATH.split('?')[0])!
    expect(row).toBeDefined()
    expect(row.method).toBe('GET')
    expect(row.status).toBe(200)
    expect(row.blocked).toBe(false)
    expect(row.disposition).toBe('upstream')
    /* The real destination as host:port — "forwarded" with no destination
     * cannot distinguish a test double from api.sanity.io. */
    expect(String(row.upstream)).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(typeof row.at).toBe('string')
    expect(typeof row.ms).toBe('number')
    /* The one addition: which listener served it. Additive, so every existing
     * record shape is unchanged, and an h1 row still has no `h2` key at all. */
    expect(row.h2).toBe(true)
  })

  it('records a failed dial as an attempted egress, not as a local answer', async () => {
    const dead = await startMockUpstream()
    const stack = await startStack(dead.origin)
    /* Kill the upstream, keep the proxy. */
    await teardowns.shift()!()
    const client = connectH2(stack)

    const response = await h2Request(client, {':method': 'GET', ':path': READ_PATH})
    await settle()

    expect(response.status).toBe(502)
    const row = stack.rows().at(-1)!
    expect(row.disposition).toBe('upstream')
    expect(row.dialFailed).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 3. the preflight
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · preflight', () => {
  it('is answered locally with the guarded method set and the preflight `Vary`', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})
    const client = connectH2(stack)

    const response = await h2Request(client, {
      ':method': 'OPTIONS',
      ':path': ACTIONS_PATH,
      origin: STUDIO_ORIGIN,
      'access-control-request-method': 'POST',
    })
    await settle()

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe(STUDIO_ORIGIN)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    /* A preflight that promised DELETE and then 403'd would tell a browser a
     * capability exists. The advertised set is the guarded one. */
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, OPTIONS')
    expect(String(response.headers.vary)).toContain('Origin')
    expect(String(response.headers.vary)).toContain('Access-Control-Request-Method')
    expect(upstream.received).toEqual([])

    const row = stack.rows().at(-1)!
    expect(row.disposition).toBe('local')
    expect(row.gate).toBe('preflight')
  })

  it('advertises nothing at all to an origin off the allowlist', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})
    const client = connectH2(stack)

    const response = await h2Request(client, {
      ':method': 'OPTIONS',
      ':path': READ_PATH,
      origin: EVIL_ORIGIN,
      'access-control-request-method': 'GET',
    })

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-allow-methods']).toBeUndefined()
    /* Refused or granted, the answer still depends on `Origin` and must never
     * be replayed by a shared cache to the next origin that asks. */
    expect(response.headers.vary).toBe('Origin')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 4. SSE over h2 — the framing that has no `Connection` header
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · server-sent events', () => {
  it('streams incrementally and emits no connection-specific header', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    const first = await new Promise<{headers: http2.IncomingHttpHeaders; chunk: string}>(
      (resolve, reject) => {
        const stream = client.request({
          ':method': 'GET',
          ':path': LISTEN_PATH,
          ':authority': `${PROJECT_HOST}:443`,
          accept: 'text/event-stream',
        })
        let headers: http2.IncomingHttpHeaders = {}
        stream.on('response', (responseHeaders) => {
          headers = responseHeaders
        })
        stream.on('data', (chunk: Buffer) => {
          /* Arrived BEFORE the response ended, which is the whole requirement:
           * a listener that only delivers on `end` never delivers at all. */
          resolve({headers, chunk: chunk.toString('utf8')})
          stream.close()
        })
        stream.on('error', reject)
        stream.end()
      },
    )

    expect(first.chunk).toContain('event: welcome')
    expect(first.headers['content-type']).toContain('text/event-stream')
    expect(first.headers['cache-control']).toBe('no-cache, no-transform')
    expect(first.headers['x-accel-buffering']).toBe('no')
    /* HTTP/2 forbids these outright — Node throws
     * ERR_HTTP2_INVALID_CONNECTION_HEADERS rather than sending them, so the h1
     * path's explicit `Connection: keep-alive` would have killed every listener
     * stream with a 500. */
    expect(first.headers.connection).toBeUndefined()
    expect(first.headers['keep-alive']).toBeUndefined()
    expect(first.headers['transfer-encoding']).toBeUndefined()
  })

  it('still sets `Connection: keep-alive` on the cleartext HTTP/1.1 leg', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: stack.port,
          path: LISTEN_PATH,
          headers: {host: `${PROJECT_HOST}:${stack.port}`, accept: 'text/event-stream'},
        },
        (res) => {
          res.on('data', () => {
            resolve(res.headers)
            req.destroy()
          })
        },
      )
      req.on('error', () => {})
      setTimeout(() => reject(new Error('no SSE chunk arrived')), 4000)
      req.end()
    })

    /* The h1 leg is unchanged: what h2 forbids, h1 requires. */
    expect(headers.connection).toBe('keep-alive')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 5. the write guard, over h2
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · the write guard', () => {
  it('refuses the Actions API before any upstream socket exists, and says so in the log', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})
    const client = connectH2(stack)

    const response = await h2Request(
      client,
      {':method': 'POST', ':path': ACTIONS_PATH, 'content-type': 'application/json'},
      JSON.stringify({actions: []}),
    )
    await settle()

    expect(response.status).toBe(403)
    expect(JSON.parse(response.body).error.code).toBe('OVERLAY_WRITE_BLOCKED')
    expect(upstream.received).toEqual([])

    const row = stack.rows().at(-1)!
    expect(row.blocked).toBe(true)
    expect(row.disposition).toBe('local')
    expect(row.gate).toBe('write-guard')
    expect(row.refusal).toBe('OVERLAY_WRITE_BLOCKED')
  })

  it('classifies the whole encoded-delimiter and dot-segment class identically over h2', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})
    const client = connectH2(stack)

    /* The transport must not be a way to ask for a different verdict. These are
     * the vectors from the 2026-08-06 security review, driven over h2 rather
     * than restated: a percent-encoded `?` or `#` truncates a naive classifier
     * to an allowlisted read while the raw request line still resolves to the
     * Mutation or Actions API. */
    const vectors = WRITE_GUARD_CASES.filter(
      (testCase) =>
        (testCase.group === 'encoded-delimiter' || testCase.group === 'spike-f-attacks') &&
        testCase.write &&
        testCase.url.startsWith('/'),
    ).slice(0, 40)
    expect(vectors.length).toBeGreaterThan(20)

    const statuses = new Set<number>()
    for (const vector of vectors) {
      const response = await h2Request(client, {
        ':method': vector.method,
        ':path': vector.url,
      })
      statuses.add(response.status)
    }

    expect([...statuses]).toEqual([403])
    expect(upstream.received).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 6. the CORS allowlist and `Vary`, over h2
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · the CORS allowlist', () => {
  it('grants an allowlisted origin and refuses one off the list, on a forwarded response', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    const granted = await h2Request(client, {
      ':method': 'GET',
      ':path': READ_PATH,
      origin: STUDIO_ORIGIN,
    })
    const refused = await h2Request(client, {
      ':method': 'GET',
      ':path': READ_PATH,
      origin: EVIL_ORIGIN,
    })

    expect(granted.headers['access-control-allow-origin']).toBe(STUDIO_ORIGIN)
    expect(granted.headers['access-control-allow-credentials']).toBe('true')
    expect(refused.headers['access-control-allow-origin']).toBeUndefined()
    expect(refused.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('strips a cross-origin grant the upstream tried to issue, and merges `Vary`', async () => {
    const upstream = await startMockUpstream()
    upstream.extraHeaders = {
      'access-control-allow-origin': EVIL_ORIGIN,
      'access-control-allow-private-network': 'true',
      'timing-allow-origin': '*',
      vary: 'Accept-Encoding',
    }
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    const response = await h2Request(client, {
      ':method': 'GET',
      ':path': READ_PATH,
      origin: STUDIO_ORIGIN,
    })

    expect(response.headers['access-control-allow-origin']).toBe(STUDIO_ORIGIN)
    expect(response.headers['access-control-allow-private-network']).toBeUndefined()
    expect(response.headers['timing-allow-origin']).toBeUndefined()
    /* Both axes, not one: replacing the upstream `Vary` is the same cache
     * defect one field over. */
    expect(String(response.headers.vary)).toContain('Accept-Encoding')
    expect(String(response.headers.vary)).toContain('Origin')
  })

  it('still refuses `origins: [\'*\']` at construction', async () => {
    const upstream = await startMockUpstream()
    expect(() =>
      createProxyStack({
        env: {},
        upstream: upstream.origin,
        logPath: path.join(TMP, 'never.jsonl'),
        tlsDir: path.join(TMP, 'never-tls'),
        tlsCertSource: 'self-signed',
        origins: ['*'],
      }),
    ).toThrow(/\*/)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 7. Set-Cookie — the one rewrite that is genuinely transport-dependent
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · Set-Cookie rewriting', () => {
  const UPSTREAM_COOKIE = 'sanitySession=abc; Domain=.sanity.io; Path=/; Secure; HttpOnly; SameSite=None'

  it('keeps `Secure` on the TLS leg, where `SameSite=None` requires it', async () => {
    const upstream = await startMockUpstream()
    upstream.extraHeaders = {'set-cookie': [UPSTREAM_COOKIE] as unknown as string}
    const stack = await startStack(upstream.origin)
    const client = connectH2(stack)

    const response = await h2Request(client, {':method': 'GET', ':path': READ_PATH})
    const cookie = String((response.headers['set-cookie'] as string[])[0])

    /* `Domain=.sanity.io` is rejected outright by a localhost origin, on any
     * transport. */
    expect(cookie).not.toContain('Domain=')
    /* `Secure` is only unusable over cleartext. Over TLS, stripping it would
     * make Chrome DROP the cookie, because `SameSite=None` without `Secure` is
     * rejected — so the strip that fixes the h1 leg breaks the h2 one. */
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=None')
  })

  it('still strips `Secure` on the cleartext leg, where the browser cannot use it', async () => {
    const upstream = await startMockUpstream()
    upstream.extraHeaders = {'set-cookie': [UPSTREAM_COOKIE] as unknown as string}
    const stack = await startStack(upstream.origin)

    const response = await h1Request(stack.port, {path: READ_PATH})
    const cookie = String((response.headers['set-cookie'] as string[])[0])

    expect(cookie).not.toContain('Domain=')
    expect(cookie).not.toContain('Secure')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 8. the WebSocket upgrade — RFC 9113 §8.1 removed `Upgrade:`
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · the realtime socket', () => {
  it('relays a TLS HTTP/1.1 upgrade on the same port, because that is how Chrome opens a WebSocket', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    /* Chrome does not tunnel WebSockets over h2 unless the server advertises
     * SETTINGS_ENABLE_CONNECT_PROTOCOL (RFC 8441), which this one deliberately
     * does not: the `Upgrade:` handshake is the shape the write guard, the
     * frame guard and the 101 relay all understand, and WebSockets have their
     * own far larger connection budget, so this leg was never the ceiling. */
    const status = await new Promise<string>((resolve, reject) => {
      const socket = tls.connect(
        {host: '127.0.0.1', port: stack.port, ca: [stack.cert], ALPNProtocols: ['http/1.1']},
        () => {
          socket.write(
            `GET ${V}/socket/${DATASET} HTTP/1.1\r\n` +
              `Host: ${PROJECT_HOST}\r\n` +
              'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
              'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
          )
        },
      )
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('latin1').split('\r\n')[0])
        socket.destroy()
      })
      socket.on('error', reject)
    })
    await settle()

    expect(status).toContain('101')
    expect(upstream.upgrades).toHaveLength(1)
    const row = stack.rows().find((entry) => entry.upgrade === true)!
    expect(row.status).toBe(101)
    expect(row.disposition).toBe('upstream')
  })

  it('still refuses a write wearing two extra headers on the TLS leg', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})

    const status = await new Promise<string>((resolve, reject) => {
      const socket = tls.connect(
        {host: '127.0.0.1', port: stack.port, ca: [stack.cert], ALPNProtocols: ['http/1.1']},
        () => {
          socket.write(
            `POST ${ACTIONS_PATH} HTTP/1.1\r\n` +
              `Host: ${PROJECT_HOST}\r\n` +
              'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
              'Content-Length: 0\r\n\r\n',
          )
        },
      )
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('latin1').split('\r\n')[0])
        socket.destroy()
      })
      socket.on('error', reject)
    })
    await settle()

    expect(status).toContain('403')
    expect(upstream.upgrades).toEqual([])
    const row = stack.rows().at(-1)!
    expect(row.blocked).toBe(true)
    expect(row.gate).toBe('write-guard')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 9. the certificate ladder, as a decision rather than a side effect
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · how a developer gets a certificate', () => {
  it('prefers an explicitly supplied certificate over anything it could mint', () => {
    const plan = planTlsMaterial({
      explicit: {certPath: '/etc/dev/cert.pem', keyPath: '/etc/dev/key.pem'},
      hasMkcert: true,
      mkcertInstalled: true,
      hasOpenssl: true,
    })
    expect(plan.source).toBe('explicit')
    expect(plan.trusted).toBe('assumed')
  })

  it('uses mkcert when it is present AND its root is installed — the only no-interstitial path', () => {
    const plan = planTlsMaterial({hasMkcert: true, mkcertInstalled: true, hasOpenssl: true})
    expect(plan.source).toBe('mkcert')
    expect(plan.trusted).toBe('yes')
  })

  it('does not pretend mkcert is trusted when its root was never installed', () => {
    /* `mkcert -install` writes to the system and NSS trust stores and prompts
     * for a password. Running it unasked is not this proxy's business, so it is
     * reported as the one manual step instead. */
    const plan = planTlsMaterial({hasMkcert: true, mkcertInstalled: false, hasOpenssl: true})
    expect(plan.source).toBe('mkcert')
    expect(plan.trusted).toBe('no')
    expect(plan.manualStep).toMatch(/mkcert -install/)
  })

  it('falls back to a self-signed certificate and says out loud that it is not trusted', () => {
    const plan = planTlsMaterial({hasMkcert: false, hasOpenssl: true})
    expect(plan.source).toBe('self-signed')
    expect(plan.trusted).toBe('no')
    expect(plan.manualStep).toBeTruthy()
  })

  it('turns the placeholder into the URL the developer actually has to visit', async () => {
    const {trustVisitUrl} = await import(
      // @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
      '../../../examples/kitchen-sink/spikeB-proxy/tlsMaterial.mjs'
    )
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin)

    /* "open https://<projectId>.localhost:<port>" is not advice anyone can
     * follow without knowing which project and which port. */
    expect(trustVisitUrl(stack.stack.tls, stack.port)).toBe(
      `https://${PROJECT_HOST}:${stack.port}/`,
    )
  })

  it('refuses rather than silently serving HTTP/1.1 when it can mint nothing', () => {
    const plan = planTlsMaterial({hasMkcert: false, hasOpenssl: false})
    expect(plan.source).toBe('none')
    /* Silently falling back to h1-only is the defect this whole change exists
     * to remove: the proxy would start, look healthy, and be unusable in a
     * browser at the seventh request. */
    expect(plan.reason).toMatch(/openssl|mkcert/)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 10. completeness — the audit's A10 over the h2 path
 * ══════════════════════════════════════════════════════════════════ */

describe('spikeB-proxy · h2 · the log the network audit reads', () => {
  it('satisfies the REAL audit predicates on a log written entirely by the h2 path', async () => {
    const upstream = await startMockUpstream()
    const stack = await startStack(upstream.origin, {blockWrites: true})
    const client = connectH2(stack)
    const runStartedAt = new Date().toISOString()

    /* One of each kind of answer: a preflight (local/preflight), a forward
     * (upstream), a guard refusal (local/write-guard). */
    await h2Request(client, {':method': 'OPTIONS', ':path': READ_PATH, origin: STUDIO_ORIGIN})
    await h2Request(client, {':method': 'GET', ':path': READ_PATH})
    await h2Request(client, {':method': 'POST', ':path': ACTIONS_PATH}, '{}')
    await settle()

    /* THE AUDIT ITSELF, not a restatement of it. `e2e/audit/predicates.mjs` is
     * what grades a live run and is the project's evidence that nothing wrote
     * to a real Sanity dataset; a log written by the h2 path has to pass the
     * same predicates, read by the same code, or the transport is a hole in the
     * evidence chain rather than a feature. */
    const {readLog} = await import('../../../e2e/audit/logModel.mjs')
    const {auditProxyLog} = await import('../../../e2e/audit/predicates.mjs')
    const results = auditProxyLog({log: readLog(stack.logPath), runStartedAt}) as Array<{
      id: string
      pass: boolean | null
      note: string
    }>
    const verdict = (id: string) => results.find((result) => result.id === id)!

    /* A10 — COMPLETENESS: every request record says what happened to its bytes.
     * An h2 path that forgot its disposition makes every request it served read
     * as `unknown`, and A3/A4 then have nothing to grade. */
    expect(verdict('A10').note).toContain('3')
    expect(verdict('A10').pass).toBe(true)
    /* A1/A2 — the record is still well-formed; A3/A4 — nothing that classifies
     * as a write left the machine; A11 — `blocked` still means the write guard
     * and nothing wider. */
    for (const id of ['A0', 'A1', 'A2', 'A3', 'A4', 'A11']) {
      expect(verdict(id).pass, `${id}: ${verdict(id)?.note}`).toBe(true)
    }
  })
})
