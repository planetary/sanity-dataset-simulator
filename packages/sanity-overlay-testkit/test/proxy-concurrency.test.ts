/**
 * HTTP/1.1 connection-pool starvation through the Spike B proxy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A live Studio session on 2026-08-04 hung the structure tool with
 *
 *     Socket timed out on request to
 *     http://b1n03q3z.localhost:3999/v2025-02-19/data/doc/parity/drafts.author-2
 *
 * and `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` shows exactly the
 * shape of a starved request rather than a broken one: the CORS preflight for
 * that path answered `204` twice (20:47:43.655, 20:47:43.660) and the GET has
 * **no completed row at all**. Rows are written on completion, so a request with
 * no row never finished. Nine minutes later, once the page had settled, the same
 * endpoint answered `200` in 184 ms — the endpoint was never broken.
 *
 * THE HYPOTHESIS UNDER TEST
 * -------------------------
 * The proxy speaks plain HTTP/1.1. Chrome opens at most **6 TCP connections per
 * (scheme, host, port)** for HTTP/1.1. Studio holds one long-lived connection per
 * listener — `/data/listen/<ds>` SSE, plus `/agent/<id>/bundles/mine/listen` —
 * and in that session it held six or more of them at once. Six long-lived
 * streams exhaust the whole per-host budget, so every subsequent request queues
 * in the browser and never reaches the proxy. Real Sanity does not have this
 * failure mode because it is HTTPS + HTTP/2, where every one of those listeners
 * is a *stream* multiplexed over a single TCP connection.
 *
 * If that is right, three things must be true, and each is a test below:
 *
 *   1. the constraint is CLIENT-side — with an unbounded connection pool the
 *      very same six streams do not delay an ordinary request by the same proxy;
 *   2. the constraint bites at exactly the browser's budget — with a pool capped
 *      at 6, six open streams starve an ordinary request indefinitely;
 *   3. HTTP/2 removes it — the same six concurrent streams over one h2
 *      connection leave an ordinary request completing normally.
 *
 * The proxy's own header already claims "no request timeouts, keep-alive
 * upstream agent" with `maxSockets: Infinity`, so test 1 is what turns that
 * claim into evidence: it rules the upstream agent OUT as the bottleneck.
 *
 * Everything is hand-rolled on node built-ins. No dependency is introduced.
 */
import {afterEach, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'

/**
 * Chrome, Firefox and Safari all cap HTTP/1.1 at six connections per host. This
 * is not a tunable of ours — it is the browser-side constant the whole finding
 * turns on, so it is named once and used everywhere.
 */
const BROWSER_MAX_SOCKETS_PER_HOST = 6

const DATASET = 'parity'
const LISTEN_PATH = `/v2025-02-19/data/listen/${DATASET}`
const ORDINARY_PATH = `/v2025-02-19/data/doc/${DATASET}/drafts.author-2`

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-concurrency-'))
let logSeq = 0

const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

/* ------------------------------------------------------------------ *
 * a mock Content Lake that streams
 * ------------------------------------------------------------------ */

interface MockUpstream {
  origin: string
  /** Long-lived responses currently held open by the upstream. */
  openStreams: () => number
  close: () => Promise<void>
}

/**
 * Answers `/data/listen/*` with an SSE stream that never ends, and everything
 * else with an immediate 200. Deliberately has NO connection limit of its own,
 * so nothing it does can be mistaken for the effect under test.
 */
async function startMockUpstream(): Promise<MockUpstream> {
  const held = new Set<http.ServerResponse>()

  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('/data/listen/')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      // One event immediately so the client is certain the stream is live, then
      // silence — exactly how a quiet Sanity listener behaves.
      res.write(': welcome\n\n')
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    const body = JSON.stringify({documents: [{_id: 'drafts.author-2'}]})
    res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)})
    res.end(body)
  })

  // `maxConnections` is deliberately LEFT UNSET. Node v22 rejects a connection
  // when `maxConnections >= 0 && _connections >= maxConnections` (lib/net.js),
  // so assigning `0` — the intuitive spelling of "unlimited" — makes the
  // upstream refuse every connection and the proxy answer 502. The
  // `openStreams()` assertions below are what caught that; keep them.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const {port} = server.address() as net.AddressInfo

  const close = () =>
    new Promise<void>((resolve) => {
      for (const res of held) res.destroy()
      server.closeAllConnections?.()
      server.close(() => resolve())
    })

  const upstream: MockUpstream = {
    origin: `http://127.0.0.1:${port}`,
    openStreams: () => held.size,
    close,
  }
  teardowns.push(close)
  return upstream
}

async function startProxy(upstreamOrigin: string, options: Record<string, unknown> = {}) {
  const logPath = path.join(LOG_DIR, `proxy-${++logSeq}.jsonl`)
  const server = createProxyServer({
    // `env: {}` so a stray PROXY_* variable in the developer's shell cannot
    // change what this suite is testing.
    env: {},
    upstream: upstreamOrigin,
    logPath,
    ...options,
  })
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  teardowns.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  const address = server.address() as net.AddressInfo
  return {
    server,
    port: address.port,
    logPath,
    /** How many TCP connections the browser-equivalent client is holding. */
    liveSockets: () => sockets.size,
  }
}

/* ------------------------------------------------------------------ *
 * a client with a browser's connection budget
 * ------------------------------------------------------------------ */

interface HeldStream {
  response: http.IncomingMessage
  close: () => void
}

/**
 * Open a long-lived stream and resolve once its RESPONSE HEADERS have arrived —
 * i.e. once the connection is genuinely occupied, not merely requested.
 */
function openStream(port: number, agent: http.Agent, requestPath: string): Promise<HeldStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {host: '127.0.0.1', port, path: requestPath, method: 'GET', agent, headers: {Accept: 'text/event-stream'}},
      (res) => {
        // Consume so the socket is not paused; the stream stays open regardless.
        res.on('data', () => {})
        resolve({response: res, close: () => req.destroy()})
      },
    )
    req.on('error', reject)
    req.end()
  })
}

interface Attempt {
  completed: boolean
  status?: number
  ms: number
}

/**
 * Issue one ordinary request and report whether it completed inside `budgetMs`.
 *
 * Returns a verdict instead of throwing, because both outcomes are meaningful
 * here: "completed" is the invariant we want, "did not complete" is the defect
 * we are pinning. A helper that threw would force one of them to be an error.
 */
function attemptOrdinaryRequest(port: number, agent: http.Agent, budgetMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const finish = (attempt: Omit<Attempt, 'ms'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({...attempt, ms: Date.now() - startedAt})
    }

    const req = http.request(
      {host: '127.0.0.1', port, path: ORDINARY_PATH, method: 'GET', agent},
      (res) => {
        res.resume()
        res.on('end', () => finish({completed: true, status: res.statusCode}))
      },
    )
    req.on('error', () => finish({completed: false}))

    const timer = setTimeout(() => {
      req.destroy()
      finish({completed: false})
    }, budgetMs)

    req.end()
  })
}

function browserLikeAgent(maxSockets: number): http.Agent {
  const agent = new http.Agent({keepAlive: true, maxSockets})
  teardowns.push(() => agent.destroy())
  return agent
}

/** How long to wait before calling a request starved. */
const STARVATION_BUDGET_MS = 1500

/* ------------------------------------------------------------------ *
 * 1. the control — the proxy itself is not the bottleneck
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · concurrency · where the constraint actually lives', () => {
  it('serves an ordinary request while six streams are open, given an unbounded client pool', async () => {
    // This is the oracle for the whole file. The proxy's own docstring claims an
    // unbounded keep-alive upstream agent with `maxSockets: Infinity`; if that
    // claim were false, THIS test would starve too and the finding below would
    // be about the proxy rather than about the browser. It is what licenses the
    // conclusion "client-side" in test 2.
    const upstream = await startMockUpstream()
    const proxy = await startProxy(upstream.origin)
    const agent = browserLikeAgent(Infinity)

    const streams = await Promise.all(
      Array.from({length: BROWSER_MAX_SOCKETS_PER_HOST}, () => openStream(proxy.port, agent, LISTEN_PATH)),
    )
    expect(streams).toHaveLength(BROWSER_MAX_SOCKETS_PER_HOST)
    expect(upstream.openStreams()).toBe(BROWSER_MAX_SOCKETS_PER_HOST)

    const attempt = await attemptOrdinaryRequest(proxy.port, agent, STARVATION_BUDGET_MS)

    expect(attempt.completed).toBe(true)
    expect(attempt.status).toBe(200)
    // Not merely "eventually": it is not even slow. Anything near the budget
    // would mean the proxy was queueing rather than serving concurrently.
    expect(attempt.ms).toBeLessThan(500)

    for (const stream of streams) stream.close()
  })

  it('serves an ordinary request while the pool has a slot to spare', async () => {
    // The same proxy, the same streams, a real browser budget — but one fewer
    // listener. This is the boundary: five open streams leave one connection
    // free and everything works. It is what makes test 2 a statement about the
    // BUDGET rather than about long-lived streams being poison in general.
    const upstream = await startMockUpstream()
    const proxy = await startProxy(upstream.origin)
    const agent = browserLikeAgent(BROWSER_MAX_SOCKETS_PER_HOST)

    const streams = await Promise.all(
      Array.from({length: BROWSER_MAX_SOCKETS_PER_HOST - 1}, () =>
        openStream(proxy.port, agent, LISTEN_PATH),
      ),
    )
    expect(upstream.openStreams()).toBe(BROWSER_MAX_SOCKETS_PER_HOST - 1)

    const attempt = await attemptOrdinaryRequest(proxy.port, agent, STARVATION_BUDGET_MS)
    expect(attempt.completed).toBe(true)
    expect(attempt.status).toBe(200)

    for (const stream of streams) stream.close()
  })
})

/* ------------------------------------------------------------------ *
 * 2. the defect itself, pinned
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · concurrency · the HTTP/1.1 starvation defect', () => {
  it('starves an ordinary request once the browser holds its full budget of listener streams', async () => {
    // THE REGRESSION TEST FOR THE CLASS: N concurrent long-lived streams through
    // the proxy plus one new ordinary request. The invariant we WANT is that the
    // ordinary request still completes. Over plain HTTP/1.1 it does not, and
    // this test pins that as a known defect rather than pretending otherwise.
    //
    // Read it together with the two tests above, which are what make it a
    // statement about the transport:
    //   - unbounded pool, same six streams  -> completes in < 500 ms
    //   - pool of 6, five streams           -> completes
    //   - pool of 6, six streams            -> never completes   <- HERE
    //
    // This is the live failure of 2026-08-04 reproduced exactly: six listeners
    // open, `GET /data/doc/parity/drafts.author-2` never answered, no row in
    // proxy-log.jsonl because the request never reached the proxy at all.
    //
    // WHEN THE PROXY LEARNS TO SPEAK HTTP/2 THIS ASSERTION FLIPS RED. That is
    // deliberate and is the point of pinning it: the fix cannot land silently,
    // and whoever lands it must come here, flip this to `toBe(true)`, and move
    // it into the invariant block. A `skip` would let the whole finding
    // evaporate; a literal cannot.
    const upstream = await startMockUpstream()
    const proxy = await startProxy(upstream.origin)
    const agent = browserLikeAgent(BROWSER_MAX_SOCKETS_PER_HOST)

    const streams = await Promise.all(
      Array.from({length: BROWSER_MAX_SOCKETS_PER_HOST}, () => openStream(proxy.port, agent, LISTEN_PATH)),
    )
    // Non-vacuity: the streams really are established end to end. Without this
    // the test would also "pass" if the upstream refused every connection.
    expect(upstream.openStreams()).toBe(BROWSER_MAX_SOCKETS_PER_HOST)

    const attempt = await attemptOrdinaryRequest(proxy.port, agent, STARVATION_BUDGET_MS)

    expect(attempt.completed).toBe(false)
    expect(attempt.status).toBeUndefined()

    // And the proxy never saw it: the request died in the browser's queue, which
    // is why the live log has a preflight for `drafts.author-2` and no GET row.
    const rows = fs.existsSync(proxy.logPath)
      ? fs
          .readFileSync(proxy.logPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as {path: string})
      : []
    expect(rows.some((row) => row.path === ORDINARY_PATH)).toBe(false)

    for (const stream of streams) stream.close()
  })

  it('recovers the moment a listener slot frees, exactly as the live session did', async () => {
    // The other half of the live evidence: nine minutes later the same endpoint
    // answered 200 in 184 ms. Load-dependent starvation, not a broken route. A
    // permanent break would fail this test, and the diagnosis would be wrong.
    const upstream = await startMockUpstream()
    const proxy = await startProxy(upstream.origin)
    const agent = browserLikeAgent(BROWSER_MAX_SOCKETS_PER_HOST)

    const streams = await Promise.all(
      Array.from({length: BROWSER_MAX_SOCKETS_PER_HOST}, () => openStream(proxy.port, agent, LISTEN_PATH)),
    )
    expect((await attemptOrdinaryRequest(proxy.port, agent, 400)).completed).toBe(false)

    // Close one listener — the page "settling".
    streams[0].close()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const afterSettling = await attemptOrdinaryRequest(proxy.port, agent, STARVATION_BUDGET_MS)
    expect(afterSettling.completed).toBe(true)
    expect(afterSettling.status).toBe(200)

    for (const stream of streams.slice(1)) stream.close()
  })
})

/* ------------------------------------------------------------------ *
 * 3. the recommendation, validated
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · concurrency · HTTP/2 multiplexing is the fix', () => {
  /**
   * Evidence for the Gate A recommendation, not a test of proxy.mjs — the proxy
   * does not speak HTTP/2 today, which is the whole finding. What this pins is
   * the CLAIM the recommendation rests on: that the same six long-lived streams
   * plus an ordinary request are not a connection-budget problem at all once the
   * transport multiplexes, because they are streams on ONE connection rather
   * than six separate ones.
   *
   * Cleartext h2 (`h2c`) is used so the test needs no certificate. Browsers do
   * NOT speak h2c — they require TLS with ALPN `h2` — so a real deployment of
   * this recommendation needs a certificate the browser trusts. That constraint
   * is stated in the README, and it is the reason this is a recommendation
   * rather than a patch.
   */
  it('serves an ordinary request with six long-lived streams open on a single connection', async () => {
    const held = new Set<http2.ServerHttp2Stream>()
    let sessions = 0

    const server = http2.createServer()
    server.on('session', () => {
      sessions += 1
    })
    server.on('stream', (stream, headers) => {
      const requestPath = String(headers[':path'] || '')
      if (requestPath.includes('/data/listen/')) {
        stream.respond({':status': 200, 'content-type': 'text/event-stream'})
        stream.write(': welcome\n\n')
        held.add(stream)
        stream.on('close', () => held.delete(stream))
        return
      }
      stream.respond({':status': 200, 'content-type': 'application/json'})
      stream.end(JSON.stringify({documents: []}))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const {port} = server.address() as net.AddressInfo
    const client = http2.connect(`http://127.0.0.1:${port}`)
    teardowns.push(
      () =>
        new Promise<void>((resolve) => {
          for (const stream of held) stream.destroy()
          client.close(() => server.close(() => resolve()))
        }),
    )

    // Six long-lived streams — the count that starves HTTP/1.1 above.
    const streams = await Promise.all(
      Array.from(
        {length: BROWSER_MAX_SOCKETS_PER_HOST},
        () =>
          new Promise<http2.ClientHttp2Stream>((resolve, reject) => {
            const stream = client.request({':path': LISTEN_PATH})
            stream.on('data', () => {})
            stream.on('error', reject)
            stream.on('response', () => resolve(stream))
          }),
      ),
    )
    expect(streams).toHaveLength(BROWSER_MAX_SOCKETS_PER_HOST)
    expect(held.size).toBe(BROWSER_MAX_SOCKETS_PER_HOST)

    const startedAt = Date.now()
    const status = await new Promise<number>((resolve, reject) => {
      const stream = client.request({':path': ORDINARY_PATH})
      const timer = setTimeout(() => reject(new Error('h2 request starved')), STARVATION_BUDGET_MS)
      stream.on('response', (headers) => {
        clearTimeout(timer)
        resolve(Number(headers[':status']))
      })
      stream.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      stream.resume()
    })

    expect(status).toBe(200)
    expect(Date.now() - startedAt).toBeLessThan(500)

    // THE LOAD-BEARING ASSERTION. Seven concurrent requests, ONE TCP connection.
    // This is precisely what the browser's six-per-host HTTP/1.1 budget counts,
    // and why the budget stops being reachable under h2.
    expect(sessions).toBe(1)

    for (const stream of streams) stream.close()
  })
})
