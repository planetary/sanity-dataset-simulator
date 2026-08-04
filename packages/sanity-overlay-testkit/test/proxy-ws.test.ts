/**
 * WebSocket upgrade through the Spike B proxy (PRD §36.1 Track B).
 *
 * Sanity Studio's listener does not only use `/data/listen` SSE: it also performs
 * an RFC 6455 upgrade to `/v2022-06-30/socket/<dataset>`. With no `upgrade`
 * handler the proxy destroys that socket, Studio logs
 * "No activity within 45000 milliseconds. Reconnecting." and document panes hang
 * on "Loading document…". This suite pins the upgrade path end to end.
 *
 * Everything here is hand-rolled on node built-ins (`node:net`, `node:crypto`):
 * a mock upstream that speaks the handshake itself, and a client that frames its
 * own payloads. No websocket dependency is introduced — the proxy is
 * dependency-free by design and so is its contract.
 */
import {afterEach, describe, expect, it} from 'vitest'
import crypto from 'node:crypto'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {isWriteRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'

/* ------------------------------------------------------------------ *
 * RFC 6455 primitives
 * ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsAccept(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

/** Server -> client: text frame, FIN set, never masked (RFC 6455 §5.1). */
function encodeTextFrame(text: string): Buffer {
  return encodeFrame(Buffer.from(text, 'utf8'), null)
}

/** Client -> server: text frame, FIN set, MUST be masked (RFC 6455 §5.3). */
function encodeMaskedTextFrame(text: string): Buffer {
  return encodeFrame(Buffer.from(text, 'utf8'), crypto.randomBytes(4))
}

function encodeFrame(payload: Buffer, mask: Buffer | null): Buffer {
  const length = payload.length
  const maskBit = mask ? 0x80 : 0x00
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x81, maskBit | length])
  } else if (length < 0x10000) {
    header = Buffer.from([0x81, maskBit | 126, (length >> 8) & 0xff, length & 0xff])
  } else {
    throw new Error('test frames stay under 64 KiB')
  }
  if (!mask) return Buffer.concat([header, payload])
  const masked = Buffer.from(payload)
  for (let i = 0; i < length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

interface DecodedFrame {
  opcode: number
  masked: boolean
  payload: Buffer
  consumed: number
}

/** Returns null when `buf` does not yet hold a complete frame. */
function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let length = buf[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buf.length < 4) return null
    length = buf.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return null
    length = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let mask: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + length) return null
  const payload = Buffer.from(buf.subarray(offset, offset + length))
  if (mask) for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4]
  return {opcode, masked, payload, consumed: offset + length}
}

/* ------------------------------------------------------------------ *
 * generic async helpers
 * ------------------------------------------------------------------ */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

/* ------------------------------------------------------------------ *
 * mock upstream (stands in for <project>.api.sanity.io)
 * ------------------------------------------------------------------ */

interface UpgradeRecord {
  url: string
  method: string
  headers: Record<string, string | string[] | undefined>
  /** Bytes the client pipelined behind its request head, as the upstream saw them. */
  head: string
  socket: net.Socket
  /** Upstream received the client's FIN — i.e. the proxy propagated the teardown. */
  ended: boolean
  closed: boolean
}

interface RequestRecord {
  method: string
  url: string
  body: string
}

interface MockUpstream {
  origin: string
  upgrades: UpgradeRecord[]
  /** Every ordinary (non-upgrade) request the upstream received. */
  requests: RequestRecord[]
  /** Resolves once at least `n` upgrade sockets have been observed. */
  waitForUpgrades(n: number): Promise<UpgradeRecord[]>
  /** Resolves once the upgrade socket at `index` has been torn down (FIN or close). */
  waitForUpgradeTeardown(index: number): Promise<void>
  close(): Promise<void>
}

function startMockUpstream(options: {refuseUpgrade?: boolean} = {}): Promise<MockUpstream> {
  const upgrades: UpgradeRecord[] = []
  const requests: RequestRecord[] = []
  const upgradeWaiters: Array<{n: number; resolve: () => void}> = []
  const closeWaiters: Array<{index: number; resolve: () => void}> = []

  const notifyUpgrade = () => {
    for (const waiter of upgradeWaiters.splice(0)) {
      if (upgrades.length >= waiter.n) waiter.resolve()
      else upgradeWaiters.push(waiter)
    }
  }
  const notifyTeardown = () => {
    for (const waiter of closeWaiters.splice(0)) {
      const record = upgrades[waiter.index]
      if (record?.ended || record?.closed) waiter.resolve()
      else closeWaiters.push(waiter)
    }
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method || '',
        url: req.url || '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
    })
    if ((req.url || '').includes('/ping')) {
      res.writeHead(200, {'Content-Type': 'text/plain', 'X-Upstream': 'mock'})
      res.end('PONG')
      return
    }
    res.writeHead(404, {'Content-Type': 'text/plain'})
    res.end('nope')
  })

  // Deliberately promiscuous: this upstream 101s ANY path. A proxy that leaks a
  // write-path upgrade therefore gets a working tunnel, which is exactly the
  // failure the composition suite below has to be able to observe.
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    const record: UpgradeRecord = {
      url: req.url || '',
      method: req.method || '',
      headers: req.headers as Record<string, string | string[] | undefined>,
      head: head && head.length ? head.toString('utf8') : '',
      socket,
      ended: false,
      closed: false,
    }
    upgrades.push(record)
    socket.on('end', () => {
      record.ended = true
      notifyTeardown()
      // `http.Server` sockets are allowHalfOpen: true and node stops managing FIN
      // once `upgrade` fires, so mirror what a normal server does with a FIN.
      socket.end()
    })
    socket.on('close', () => {
      record.closed = true
      notifyTeardown()
    })
    socket.on('error', () => {
      /* client-side teardown races are expected */
    })
    notifyUpgrade()

    if (options.refuseUpgrade) {
      const body = 'nope: no listener for you'
      socket.write(
        [
          'HTTP/1.1 403 Forbidden',
          'Content-Type: text/plain',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      )
      socket.end()
      return
    }

    const key = String(req.headers['sec-websocket-key'] || '')
    socket.setNoDelay(true)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAccept(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
    // Unsolicited server -> client push: the listener's `welcome` event.
    socket.write(encodeTextFrame(JSON.stringify({type: 'welcome', url: record.url})))

    let buffered = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
    const pump = () => {
      let frame = decodeFrame(buffered)
      while (frame) {
        buffered = buffered.subarray(frame.consumed)
        if (frame.opcode === 0x1) {
          socket.write(encodeTextFrame(`echo:${frame.payload.toString('utf8')}`))
        }
        frame = decodeFrame(buffered)
      }
    }
    pump()
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      pump()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        upgrades,
        requests,
        waitForUpgrades(n) {
          if (upgrades.length >= n) return Promise.resolve(upgrades)
          const d = deferred<void>()
          upgradeWaiters.push({n, resolve: d.resolve as () => void})
          return withTimeout(d.promise.then(() => upgrades), 2000, `${n} upstream upgrade(s)`)
        },
        waitForUpgradeTeardown(index) {
          const record = upgrades[index]
          if (record?.ended || record?.closed) return Promise.resolve()
          const d = deferred<void>()
          closeWaiters.push({index, resolve: d.resolve as () => void})
          return withTimeout(d.promise, 2000, `upstream upgrade socket ${index} to be torn down`)
        },
        close() {
          for (const record of upgrades) record.socket.destroy()
          return new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
        },
      })
    })
  })
}

/* ------------------------------------------------------------------ *
 * hand-rolled WebSocket client
 * ------------------------------------------------------------------ */

interface HttpHead {
  status: number
  headers: Record<string, string>
  rest: Buffer
}

function readHttpResponseHead(socket: net.Socket): Promise<HttpHead> {
  return withTimeout(
    new Promise<HttpHead>((resolve, reject) => {
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        cleanup()
        const raw = buffered.subarray(0, end).toString('latin1').split('\r\n')
        const statusLine = raw.shift() || ''
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
        if (!match) {
          reject(new Error(`malformed status line: ${JSON.stringify(statusLine)}`))
          return
        }
        const headers: Record<string, string> = {}
        for (const line of raw) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        resolve({status: Number(match[1]), headers, rest: buffered.subarray(end + 4)})
      }
      const onClose = () =>
        reject(
          new Error(
            `connection closed after ${buffered.length} byte(s) without a complete HTTP response ` +
              `(no upgrade handler => socket destroyed)`,
          ),
        )
      const onError = (err: Error) => reject(new Error(`socket error before response: ${err.message}`))
      const cleanup = () => {
        socket.off('data', onData)
        socket.off('close', onClose)
        socket.off('error', onError)
      }
      socket.on('data', onData)
      socket.once('close', onClose)
      socket.once('error', onError)
    }),
    2000,
    'an HTTP response head',
  )
}

class FrameReader {
  private buffered: Buffer
  private queue: DecodedFrame[] = []
  private waiter: ((frame: DecodedFrame) => void) | null = null
  private failure: Error | null = null
  private failWaiter: ((err: Error) => void) | null = null

  constructor(socket: net.Socket, initial: Buffer) {
    this.buffered = Buffer.from(initial)
    this.drain()
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      this.drain()
    })
    socket.on('close', () => {
      this.failure = new Error('socket closed while waiting for a frame')
      this.failWaiter?.(this.failure)
    })
  }

  private drain() {
    let frame = decodeFrame(this.buffered)
    while (frame) {
      this.buffered = this.buffered.subarray(frame.consumed)
      if (this.waiter) {
        const resolve = this.waiter
        this.waiter = null
        this.failWaiter = null
        resolve(frame)
      } else {
        this.queue.push(frame)
      }
      frame = decodeFrame(this.buffered)
    }
  }

  next(label = 'a websocket frame'): Promise<DecodedFrame> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return withTimeout(
      new Promise<DecodedFrame>((resolve, reject) => {
        this.waiter = resolve
        this.failWaiter = reject
      }),
      2000,
      label,
    )
  }

  async nextText(label?: string): Promise<string> {
    const frame = await this.next(label)
    return frame.payload.toString('utf8')
  }
}

interface WsClient {
  socket: net.Socket
  status: number
  headers: Record<string, string>
  key: string
  frames: FrameReader
  send(text: string): void
}

interface UpgradeAttempt {
  socket: net.Socket
  status: number
  headers: Record<string, string>
  rest: Buffer
  /** Reads the response body implied by Content-Length, if any. */
  body(): Promise<string>
}

/**
 * The low-level primitive: put ONE request head carrying `Upgrade`/`Connection:
 * Upgrade` on the wire and read whatever HTTP response comes back.
 *
 * Deliberately not WebSocket-specific — the composition suite needs to attempt an
 * upgrade with an arbitrary method against an arbitrary path, which is precisely
 * the shape a write-guard bypass takes.
 */
async function upgradeRequest(
  port: number,
  requestPath: string,
  options: {
    method?: string
    headers?: Record<string, string>
    /** Bytes written in the SAME segment as the head, so they land in `head`. */
    pipelined?: Buffer
  } = {},
): Promise<UpgradeAttempt> {
  const socket = net.connect({host: '127.0.0.1', port})
  socket.setNoDelay(true)
  socket.on('error', () => {
    /* surfaced through readHttpResponseHead / FrameReader */
  })
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    }),
    2000,
    'a TCP connection to the proxy',
  )

  const lines = [
    `${options.method || 'GET'} ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    ...Object.entries(options.headers || {}).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ]
  socket.write(
    options.pipelined
      ? Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), options.pipelined])
      : Buffer.from(lines.join('\r\n'), 'latin1'),
  )

  const head = await readHttpResponseHead(socket)
  return {
    socket,
    status: head.status,
    headers: head.headers,
    rest: head.rest,
    body() {
      const expected = Number(head.headers['content-length'] || 0)
      if (head.rest.length >= expected) return Promise.resolve(head.rest.toString('utf8'))
      return withTimeout(
        new Promise<string>((resolve) => {
          let buffered = Buffer.from(head.rest)
          const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk])
            if (buffered.length >= expected) {
              socket.off('data', onData)
              resolve(buffered.toString('utf8'))
            }
          }
          socket.on('data', onData)
        }),
        2000,
        'the response body',
      )
    },
  }
}

async function wsHandshake(
  port: number,
  requestPath: string,
  extraHeaders: Record<string, string> = {},
  pipelined?: string,
): Promise<WsClient> {
  const key = crypto.randomBytes(16).toString('base64')
  // `pipelined` rides in the same write as the request head, so it lands in the
  // `head` buffer of the server's `upgrade` event rather than on the socket.
  const attempt = await upgradeRequest(port, requestPath, {
    headers: {
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...extraHeaders,
    },
    pipelined: pipelined === undefined ? undefined : encodeMaskedTextFrame(pipelined),
  })
  return {
    socket: attempt.socket,
    status: attempt.status,
    headers: attempt.headers,
    key,
    frames: new FrameReader(attempt.socket, attempt.rest),
    send(text: string) {
      attempt.socket.write(encodeMaskedTextFrame(text))
    },
  }
}

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ws-'))
let logSeq = 0

const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

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
  return {server, port: address.port, logPath, readLog: () => readLog(logPath)}
}

function readLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function useUpstream(options: {refuseUpgrade?: boolean} = {}) {
  const upstream = await startMockUpstream(options)
  teardowns.push(() => upstream.close())
  return upstream
}

const SOCKET_PATH = '/v2022-06-30/socket/parity'

/* ------------------------------------------------------------------ *
 * the contract
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · WebSocket upgrade', () => {
  it('completes the RFC 6455 handshake through the proxy (101, not 404/reset)', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)

    expect(client.status).toBe(101)
    expect(client.headers.upgrade?.toLowerCase()).toBe('websocket')
    expect(client.headers.connection?.toLowerCase()).toBe('upgrade')
    // Proves the key reached the upstream unmodified and its accept came back.
    expect(client.headers['sec-websocket-accept']).toBe(wsAccept(client.key))
  })

  it('replays the request line and the WebSocket headers upstream verbatim', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, `${SOCKET_PATH}?query=*&tag=pane`, {
      Authorization: 'Bearer test-token',
      Cookie: 'sanitySession=abc',
      'Sec-WebSocket-Protocol': 'sanity-listener',
    })
    expect(client.status).toBe(101)

    const [upgrade] = await upstream.waitForUpgrades(1)
    expect(upgrade.url).toBe(`${SOCKET_PATH}?query=*&tag=pane`)
    expect(upgrade.headers['sec-websocket-key']).toBe(client.key)
    expect(upgrade.headers['sec-websocket-version']).toBe('13')
    expect(upgrade.headers['sec-websocket-protocol']).toBe('sanity-listener')
    expect(String(upgrade.headers.upgrade).toLowerCase()).toBe('websocket')
    expect(String(upgrade.headers.connection).toLowerCase()).toContain('upgrade')
    // Credentials must survive: Studio authenticates the listener socket.
    expect(upgrade.headers.authorization).toBe('Bearer test-token')
    expect(upgrade.headers.cookie).toBe('sanitySession=abc')
  })

  it('pipes data frames in both directions', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(101)

    // server -> client (the unsolicited `welcome` push)
    const welcome = await client.frames.nextText('the welcome frame')
    expect(JSON.parse(welcome)).toEqual({type: 'welcome', url: SOCKET_PATH})

    // client -> server -> client
    client.send('mutation-1')
    const echoed = await client.frames.next('the echoed frame')
    expect(echoed.opcode).toBe(0x1)
    expect(echoed.masked).toBe(false) // server frames are never masked
    expect(echoed.payload.toString('utf8')).toBe('echo:mutation-1')

    client.send('mutation-2')
    expect(await client.frames.nextText()).toBe('echo:mutation-2')
  })

  it('forwards bytes pipelined with the handshake (the `head` buffer)', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    // A client is allowed to put its first frame in the same segment as the
    // request head; node hands those bytes to `upgrade` as `head`, and a proxy
    // that only pipes the socket silently drops them.
    const client = await wsHandshake(proxy.port, SOCKET_PATH, {}, 'pipelined-frame')
    expect(client.status).toBe(101)

    expect(await client.frames.nextText('the welcome frame')).toContain('welcome')
    expect(await client.frames.nextText('the echo of the pipelined frame')).toBe(
      'echo:pipelined-frame',
    )
  })

  it('propagates a non-101 upstream refusal to the client', async () => {
    const upstream = await useUpstream({refuseUpgrade: true})
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)

    expect(client.status).toBe(403)
    expect(client.headers['content-type']).toContain('text/plain')
    // The refusal is a real HTTP response, not a dropped connection.
    expect(client.headers['content-length']).toBe('25')
  })

  it('answers 502 when the upstream cannot be dialled at all', async () => {
    // Port 1 on loopback: reserved, nothing listens, connect fails immediately.
    const proxy = await startProxy('http://127.0.0.1:1')

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(502)
    // Pinned on the log too: a 502 from the ordinary HTTP path would satisfy the
    // status assertion alone, so this is what forces the *upgrade* path to own it.
    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      path: SOCKET_PATH,
      status: 502,
    })
  })

  it('tears down the upstream socket when the client closes', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(101)
    await upstream.waitForUpgrades(1)
    expect(upstream.upgrades[0].ended).toBe(false)
    expect(upstream.upgrades[0].closed).toBe(false)

    client.socket.destroy()

    await upstream.waitForUpgradeTeardown(0)
    // The upstream leg is not merely dropped locally: the teardown reaches Sanity,
    // so the listener is unsubscribed instead of being left to time out.
    expect(upstream.upgrades[0].ended).toBe(true)
  })

  it('tears down the client socket when the upstream closes', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(101)
    const [upgrade] = await upstream.waitForUpgrades(1)

    const closed = withTimeout(
      new Promise<void>((resolve) => client.socket.once('close', () => resolve())),
      2000,
      'the client socket to close',
    )
    upgrade.socket.destroy()
    await closed
  })

  it('supports two concurrent WebSocket connections', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const first = await wsHandshake(proxy.port, '/v2022-06-30/socket/parity')
    const second = await wsHandshake(proxy.port, '/v2022-06-30/socket/other')
    expect(first.status).toBe(101)
    expect(second.status).toBe(101)

    await first.frames.nextText('welcome #1')
    await second.frames.nextText('welcome #2')

    first.send('a')
    second.send('b')
    expect(await first.frames.nextText()).toBe('echo:a')
    expect(await second.frames.nextText()).toBe('echo:b')

    const upgrades = await upstream.waitForUpgrades(2)
    expect(upgrades.map((u) => u.url)).toEqual([
      '/v2022-06-30/socket/parity',
      '/v2022-06-30/socket/other',
    ])

    // Closing one must not disturb the other.
    first.socket.destroy()
    await upstream.waitForUpgradeTeardown(0)
    second.send('c')
    expect(await second.frames.nextText()).toBe('echo:c')
  })

  it('logs the upgrade to the JSONL request log', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(101)
    await client.frames.nextText('the welcome frame')

    const entries = proxy.readLog()
    const upgradeEntry = entries.find((entry) => entry.upgrade === true)
    expect(upgradeEntry).toMatchObject({
      method: 'GET',
      path: SOCKET_PATH,
      status: 101,
      blocked: false,
      upgrade: true,
    })
  })

  it('does not block the listener socket when the write guard is on', async () => {
    // The upgrade is a GET on a read-only listener channel; the guard classifies
    // it as a read. Pinned so the guard can never start eating the listener.
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const client = await wsHandshake(proxy.port, SOCKET_PATH)
    expect(client.status).toBe(101)
  })

  it('still proxies plain HTTP (smoke — upgrade support must not regress it)', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin)

    const response = await fetch(`http://127.0.0.1:${proxy.port}/v2025-02-19/ping`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PONG')
    expect(response.headers.get('x-upstream')).toBe('mock')

    const entries = proxy.readLog()
    expect(entries.some((entry) => entry.path === '/v2025-02-19/ping' && entry.status === 200)).toBe(
      true,
    )
  })

  it('still blocks writes over plain HTTP with the guard on (smoke)', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const response = await fetch(`http://127.0.0.1:${proxy.port}/v2025-02-19/data/actions/parity`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('OVERLAY_WRITE_BLOCKED')
  })
})

/* ------------------------------------------------------------------ *
 * upgrade x write-guard composition
 * ------------------------------------------------------------------ *
 * Two features that are individually correct can compose into a hole, and this
 * pair does: `http.Server` routes a request to `upgrade` INSTEAD OF `request`
 * whenever it carries `Connection: Upgrade` + `Upgrade: <x>`, and the ordinary
 * `request` handler is where the write guard lives. Anything that reaches the
 * `upgrade` handler has therefore skipped the guard by construction.
 *
 * That is not a WebSocket-shaped exemption. Node hands a POST with an
 * `Upgrade` header to the same event, and its body arrives as the `head`
 * buffer — so two extra request headers turn `POST /data/actions/<ds>` into an
 * unguarded tunnel that delivers the mutation body verbatim to Content Lake and
 * streams the reply back. Every Spike F gap class is reachable this way; the
 * classifier being right about the request line is irrelevant if nothing asks it.
 *
 * RULING: the guard is transport-independent. `upgrade` consults exactly the
 * same predicate as `request`, before dialling upstream, and answers the same
 * 403 — written by hand onto the raw socket, because at this point in the
 * lifecycle there is no `ServerResponse` to write it with.
 */
describe('spikeB-proxy · upgrade x write-guard composition', () => {
  /**
   * One vector per Spike F gap class, each spelled as an upgrade attempt.
   * `write: true` is the classifier's own verdict, re-asserted below so the two
   * layers cannot drift apart silently.
   */
  const BYPASS_VECTORS: Array<{gapClass: string; method: string; path: string; why: string}> = [
    {
      gapClass: '1 · agent actions',
      method: 'GET',
      path: '/v2025-02-19/agent/action/patch/parity',
      why: 'the endpoint Spike F gap 23 rode in on, now wearing an Upgrade header',
    },
    {
      gapClass: '2 · assets',
      method: 'POST',
      path: '/v2025-02-19/assets/images/parity?filename=canary.png',
      why: 'asset upload as an upgrade',
    },
    {
      gapClass: '3 · path normalisation',
      method: 'POST',
      path: '/v2025-02-19/x/../%64ata//mutate/parity/',
      why: 'the whole gap-20 spelling class must be normalised on this path too',
    },
    {
      gapClass: '4 · resource-scoped write plane',
      method: 'POST',
      path: '/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate',
      why: 'resource-configured clients mutate with no /data prefix',
    },
    {
      gapClass: '5 · dataset admin',
      method: 'DELETE',
      path: '/v2025-02-19/datasets/parity',
      why: 'deleting a dataset through a tunnel is still deleting a dataset',
    },
    {
      gapClass: '6 · unrecognised path, write verb',
      method: 'PUT',
      path: '/v2025-02-19/some/future/api',
      why: 'default-deny does not stop applying because the request asked to upgrade',
    },
    {
      gapClass: 'the Mutation API itself',
      method: 'GET',
      path: '/v2025-02-19/data/mutate/parity',
      why: 'a GET probe at /data/mutate is a write on the HTTP path and must stay one here',
    },
    {
      gapClass: 'the listener path, wrong verb',
      method: 'POST',
      path: '/v2022-06-30/socket/parity',
      why: '/socket is allowlisted for GET/HEAD; a POST upgrade to it is not a read',
    },
  ]

  it.each(BYPASS_VECTORS)(
    'the classifier already calls $method $path a write (gap class $gapClass)',
    ({method, path: requestPath}) => {
      // Pins the premise of every test below: these are not novel policy, they
      // are the guard's existing verdict, which the upgrade path was ignoring.
      expect(isWriteRequest({method, url: requestPath})).toBe(true)
    },
  )

  it.each(BYPASS_VECTORS)(
    'blocks an upgrade to $path ($method) with the guard on — gap class $gapClass',
    async ({method, path: requestPath}) => {
      const upstream = await useUpstream()
      const proxy = await startProxy(upstream.origin, {blockWrites: true})

      const attempt = await upgradeRequest(proxy.port, requestPath, {method})

      expect(attempt.status).toBe(403)
      expect(JSON.parse(await attempt.body()).error.code).toBe('OVERLAY_WRITE_BLOCKED')
      // The decisive assertion: the proxy must not have dialled upstream at all.
      // A 403 synthesised after a successful upstream tunnel would still be a breach.
      expect(upstream.upgrades).toEqual([])
      expect(upstream.requests).toEqual([])
    },
  )

  it('never forwards the body a POST upgrade pipelines behind its head', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    // Node hands these bytes to the `upgrade` event as `head`; a proxy that
    // replays the head upstream delivers the mutation verbatim.
    const mutation = '{"mutations":[{"createOrReplace":{"_id":"canary","_type":"article"}}]}'
    const attempt = await upgradeRequest(proxy.port, '/v2025-02-19/data/actions/parity', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': String(mutation.length)},
      pipelined: Buffer.from(mutation, 'utf8'),
    })

    expect(attempt.status).toBe(403)
    expect(upstream.upgrades).toEqual([])
    expect(upstream.requests).toEqual([])
    expect(JSON.stringify(upstream.upgrades)).not.toContain('createOrReplace')
  })

  it('closes the connection after a blocked upgrade instead of leaving a tunnel open', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const attempt = await upgradeRequest(proxy.port, '/v2025-02-19/data/mutate/parity', {
      method: 'POST',
    })
    expect(attempt.status).toBe(403)
    expect(attempt.headers.connection?.toLowerCase()).toBe('close')

    await withTimeout(
      new Promise<void>((resolve) => attempt.socket.once('close', () => resolve())),
      2000,
      'the blocked upgrade socket to close',
    )
  })

  it('logs a blocked upgrade as blocked, on the upgrade path', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const attempt = await upgradeRequest(proxy.port, '/v2025-02-19/data/actions/parity', {
      method: 'POST',
    })
    expect(attempt.status).toBe(403)

    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      method: 'POST',
      path: '/v2025-02-19/data/actions/parity',
      status: 403,
      blocked: true,
      upgrade: true,
    })
  })

  it('survives a client that dies before the 403 can be written', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    // Node hands `upgrade` a BARE socket — one with no error handling of its own.
    // A client that RSTs the moment its head is on the wire makes the 403 write
    // fail, and an 'error' with no listener is thrown, not logged: it would take
    // the proxy process down on a request an attacker fully controls.
    const dead = new EventEmitter() as EventEmitter & Record<string, unknown>
    dead.writable = true
    dead.destroyed = false
    dead.end = () => {
      dead.emit('error', Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}))
    }
    dead.destroy = () => {
      dead.destroyed = true
    }
    dead.setNoDelay = () => {}
    dead.setTimeout = () => {}

    const req = {
      method: 'POST',
      url: '/v2025-02-19/data/mutate/parity',
      headers: {host: `127.0.0.1:${proxy.port}`},
    }
    expect(() => proxy.server.emit('upgrade', req, dead, Buffer.alloc(0))).not.toThrow()
    expect(upstream.upgrades).toEqual([])
    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      status: 403,
      blocked: true,
    })
  })

  it('forwards those same upgrades when the guard is OFF', async () => {
    // Proves the 403 is the guard speaking and not a blanket restriction on
    // non-socket upgrades — i.e. the block is policy, and the policy is one switch.
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: false})

    const attempt = await upgradeRequest(proxy.port, '/v2025-02-19/data/mutate/parity', {
      method: 'POST',
    })
    expect(attempt.status).toBe(101)

    const [upgrade] = await upstream.waitForUpgrades(1)
    expect(upgrade.url).toBe('/v2025-02-19/data/mutate/parity')
  })

  it('still lets the real listener socket through with the guard on', async () => {
    // The other half of the ruling: guarding this path must not cost the feature
    // it exists for. Without this, "block every upgrade" would pass everything above.
    //
    // The payload is a REAL @sanity/bifur-client frame rather than an arbitrary
    // string, because since evidence review F5b the proxy also classifies the
    // frames themselves (see test/proxy-ws-frames.test.ts). An arbitrary string
    // is not JSON-RPC and is now correctly refused — this test asserts the
    // Studio's actual traffic survives, which is the property that matters.
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const client = await wsHandshake(proxy.port, `${SOCKET_PATH}?query=*`)
    expect(client.status).toBe(101)

    expect(await client.frames.nextText('the welcome frame')).toContain('welcome')
    const presence = JSON.stringify({
      jsonrpc: '2.0',
      method: 'presence_announce',
      params: {data: {locations: [], sessionId: 's-1'}, apiVersion: 'v1'},
      id: 'p1',
    })
    client.send(presence)
    expect(await client.frames.nextText()).toBe(`echo:${presence}`)

    const [upgrade] = await upstream.waitForUpgrades(1)
    expect(upgrade.url).toBe(`${SOCKET_PATH}?query=*`)
  })
})
