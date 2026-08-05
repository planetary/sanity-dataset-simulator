/**
 * The WebSocket frame guard (evidence review F5b).
 *
 * WHY THIS EXISTS — WHAT THE CHANNEL ACTUALLY CARRIES
 * ---------------------------------------------------
 * `writeGuard.mjs` allowlists `/socket` as a read namespace, and the upgrade
 * handler in `proxy.mjs` classifies the HANDSHAKE REQUEST LINE and then pipes
 * bytes opaquely in both directions. The review's finding F5b asked what an
 * allowlisted upgrade path is actually a tunnel to. The answer was read out of
 * the vendored source, not guessed:
 *
 * `sanity@6.8.0` builds the URL at
 * `lib/WorkspaceLoader-BRx2afZV.js:8300-8303`:
 *
 *     function getBifurClient(client, auth) {
 *       let {dataset, url: baseUrl, requestTagPrefix = "sanity.studio"} =
 *         client.withConfig({apiVersion: "2022-06-30"}).config()
 *       return fromUrl(`${...}/socket/${dataset}`.replace(/^http/, "ws") + `?tag=...`, ...)
 *     }
 *
 * `fromUrl` is `@sanity/bifur-client@1.0.0`, and it is **not** a subscribe-only
 * stream. It is a generic JSON-RPC 2.0 request/response channel. Its README
 * (`README.md:3`) says so, and `src/createClient.ts:42-49` shows the envelope:
 *
 *     function formatRequest(method, params, id) {
 *       return JSON.stringify({jsonrpc: '2.0', method, params: addApiVersion(params, 'v1'), id})
 *     }
 *
 * There are exactly two `ws.send()` sites in the library — `createClient.ts:137`
 * (every request and every subscribe) and `createClient.ts:174` (unsubscribe) —
 * and the first takes `method: string` from its caller. The public type union at
 * `@sanity/bifur-client/src/types.ts:6-15` is:
 *
 *     export type RequestMethod =
 *       | 'doc' | 'query' | 'mutate'
 *       | 'presence_rollcall' | 'presence_announce' | 'presence_disconnect'
 *       | 'authorization'
 *
 * **`'mutate'` is a declared client request method on this socket.** No shipped
 * code path in `sanity@6.8.0` calls it — Studio's document mutations go over
 * HTTP `POST /data/mutate/<ds>` (`lib/datastores-DqFH7RLd.js:1789`) — but the
 * bifur client is exposed on the Studio source as `__internal.bifur`
 * (`lib/datastores-DqFH7RLd.js:7958`), so page JS can call
 * `bifur.request('mutate', {...})` with no type error and no client-side check.
 *
 * So the channel could NOT be proven read-only, and per the brief the hole is
 * not left silent. The proxy now:
 *
 *   1. parses every client -> upstream frame (RFC 6455) past the 101,
 *   2. classifies its JSON-RPC method against a read allowlist — the same
 *      default-deny policy the HTTP guard applies, at the frame layer,
 *   3. writes a JSONL log line for EVERY frame, method name and id only, so an
 *      escape is server-side evidenced (the project's standing rule), and
 *   4. refuses to forward a frame that is not an allowlisted read, closing the
 *      connection with RFC 6455 code 1008.
 *
 * WHAT IS NEVER LOGGED: `params`. The very first frame the client sends is
 * `{"method":"authorization","params":{"authorization":"Bearer <token>"}}`
 * (`@sanity/bifur-client/src/createClient.ts:107-125`). A guard that logged
 * frame payloads would write the user's credential to disk on every connection.
 * There is a test below that asserts it does not.
 */
import {afterEach, describe, expect, it} from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {classifyRealtimeMethod, createRealtimeFrameGuard} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'

/* ------------------------------------------------------------------ *
 * RFC 6455 encoders — client frames, so always masked (§5.1)
 * ------------------------------------------------------------------ */

interface FrameOptions {
  opcode?: number
  fin?: boolean
  masked?: boolean
  /** Force a longer length encoding than the payload strictly needs. */
  lengthForm?: 7 | 16 | 64
}

function encodeClientFrame(payload: Buffer, options: FrameOptions = {}): Buffer {
  const {opcode = 0x1, fin = true, masked = true} = options
  const length = payload.length
  const form = options.lengthForm ?? (length < 126 ? 7 : length < 65536 ? 16 : 64)

  const header: number[] = [(fin ? 0x80 : 0x00) | opcode]
  const maskBit = masked ? 0x80 : 0x00
  let extended = Buffer.alloc(0)
  if (form === 7) {
    header.push(maskBit | length)
  } else if (form === 16) {
    header.push(maskBit | 126)
    extended = Buffer.alloc(2)
    extended.writeUInt16BE(length)
  } else {
    header.push(maskBit | 127)
    extended = Buffer.alloc(8)
    extended.writeBigUInt64BE(BigInt(length))
  }

  if (!masked) return Buffer.concat([Buffer.from(header), extended, payload])

  const key = crypto.randomBytes(4)
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4]
  return Buffer.concat([Buffer.from(header), extended, key, body])
}

function rpcFrame(method: string, params: Record<string, unknown> = {}, id = 'abc123'): Buffer {
  return encodeClientFrame(
    Buffer.from(JSON.stringify({jsonrpc: '2.0', method, params: {...params, apiVersion: 'v1'}, id})),
  )
}

/** The real first frame `@sanity/bifur-client` sends, token and all. */
const SECRET_TOKEN = 'skTESTtokenNEVERlogMe0123456789'
const AUTH_FRAME = rpcFrame('authorization', {authorization: `Bearer ${SECRET_TOKEN}`}, 'auth-1')

/** The real presence write, from `lib/datastores-DqFH7RLd.js:7350-7352`. */
const PRESENCE_FRAME = rpcFrame(
  'presence_announce',
  {data: {locations: [{documentId: 'article-01', path: ['title']}], sessionId: 's-1'}},
  'pres-1',
)

/** The escape this whole file exists for. */
const MUTATE_FRAME = rpcFrame(
  'mutate',
  {mutations: [{patch: {id: 'article-01', set: {title: 'pwned'}}}]},
  'evil-1',
)

/* ------------------------------------------------------------------ *
 * 1. the method policy, on its own
 * ------------------------------------------------------------------ */

interface MethodVerdict {
  write: boolean
  reason: string
}

describe('writeGuard · JSON-RPC method policy for the bifur socket', () => {
  /**
   * Every base method in `@sanity/bifur-client/src/types.ts:6-25` that is a
   * read or an ephemeral session signal, plus the `_subscribe`/`_unsubscribe`
   * wire forms `createClient.ts:157,174` derive from `SubscribeMethods`.
   */
  const ALLOWED = [
    'authorization', //           createClient.ts:114 — the auth handshake frame
    'authorization_subscribe', // token-expiry events
    'authorization_unsubscribe',
    'presence', //                SubscribeMethods; datastores-DqFH7RLd.js:7349
    'presence_subscribe',
    'presence_unsubscribe',
    'presence_rollcall', //       datastores-DqFH7RLd.js:7350 — ephemeral session ping
    'presence_announce', //       :7351 — cursor/field location, never Content Lake
    'presence_disconnect', //     :7353
    'listen', //                  SubscribeMethods — the read subscription
    'listen_subscribe',
    'listen_unsubscribe',
    'doc', //                     RequestMethod — a document read
    'query', //                   RequestMethod — a GROQ read
  ]

  const BLOCKED = [
    'mutate', //                  types.ts:9 — THE write. Declared, reachable, blocked.
    'mutate_subscribe', //        the suffix rule must not launder it
    'mutate_unsubscribe',
    'MUTATE', //                  case games, as on the HTTP side
    'Mutate',
    'doc_subscribe', //           not a real wire method; default-deny
    'actions',
    'createOrReplace',
    'transaction',
    'patch',
    'delete',
    'upload',
    'eval',
    '',
    '  mutate  ',
    'presence_announce_evil',
    'unsubscribe',
  ]

  it.each(ALLOWED)('allows %s', (method) => {
    const verdict = classifyRealtimeMethod(method) as MethodVerdict
    expect(verdict.write).toBe(false)
  })

  it.each(BLOCKED)('blocks %s', (method) => {
    const verdict = classifyRealtimeMethod(method) as MethodVerdict
    expect(verdict.write).toBe(true)
    expect(verdict.reason.length).toBeGreaterThan(0)
  })

  it.each([null, undefined, 42, {}, []])('blocks the non-string method %s', (method) => {
    expect((classifyRealtimeMethod(method) as MethodVerdict).write).toBe(true)
  })

  it('is neither an allow-all nor a deny-all policy', () => {
    // Non-vacuity, both directions — the same guard the write-guard contract
    // applies to the HTTP classifier.
    const allowed = ALLOWED.filter((m) => !(classifyRealtimeMethod(m) as MethodVerdict).write)
    const blocked = BLOCKED.filter((m) => (classifyRealtimeMethod(m) as MethodVerdict).write)
    expect(allowed.length).toBe(ALLOWED.length)
    expect(blocked.length).toBe(BLOCKED.length)
  })
})

/* ------------------------------------------------------------------ *
 * 2. the frame reader
 * ------------------------------------------------------------------ */

interface InspectedFrame {
  opcode: number
  rpcMethod: string | null
  rpcId: string | null
  write: boolean
  reason: string
}

interface Inspection {
  frames: InspectedFrame[]
  forward: Buffer
  blocked: InspectedFrame | null
}

type FrameGuard = {inspect(chunk: Buffer): Inspection}

describe('writeGuard · RFC 6455 client frame reader', () => {
  it('extracts the JSON-RPC method from a masked text frame and forwards it', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(PRESENCE_FRAME)
    expect(result.blocked).toBeNull()
    expect(result.frames).toHaveLength(1)
    expect(result.frames[0].rpcMethod).toBe('presence_announce')
    expect(result.frames[0].rpcId).toBe('pres-1')
    expect(result.frames[0].write).toBe(false)
    // Forwarded byte-for-byte: the proxy must relay the ORIGINAL masked frame,
    // not a re-encoding of what it parsed.
    expect(result.forward.equals(PRESENCE_FRAME)).toBe(true)
  })

  it('blocks a mutate frame and forwards none of it', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(MUTATE_FRAME)
    expect(result.blocked).not.toBeNull()
    expect(result.blocked!.rpcMethod).toBe('mutate')
    expect(result.forward).toHaveLength(0)
  })

  it('forwards the allowed frames that precede a blocked one, and nothing after', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const trailing = rpcFrame('presence_rollcall', {session: 's-2'}, 'after-1')
    const result = guard.inspect(Buffer.concat([AUTH_FRAME, MUTATE_FRAME, trailing]))
    expect(result.blocked!.rpcMethod).toBe('mutate')
    expect(result.forward.equals(AUTH_FRAME)).toBe(true)
    expect(result.frames.map((f) => f.rpcMethod)).toEqual(['authorization', 'mutate'])
  })

  it('latches shut: nothing is forwarded after a block, ever', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    guard.inspect(MUTATE_FRAME)
    const after = guard.inspect(PRESENCE_FRAME)
    expect(after.forward).toHaveLength(0)
    expect(after.blocked).not.toBeNull()
  })

  it('detects a frame split across TCP segments', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    // Byte by byte is the pathological case; a real split is coarser.
    let seen: InspectedFrame[] = []
    let forwarded = Buffer.alloc(0)
    for (const byte of MUTATE_FRAME) {
      const result = guard.inspect(Buffer.from([byte]))
      seen = seen.concat(result.frames)
      forwarded = Buffer.concat([forwarded, result.forward])
      if (result.blocked) break
    }
    expect(seen.map((f) => f.rpcMethod)).toEqual(['mutate'])
    expect(forwarded).toHaveLength(0)
  })

  it('holds back a partial frame rather than forwarding it early', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const half = MUTATE_FRAME.subarray(0, MUTATE_FRAME.length - 4)
    const result = guard.inspect(half)
    // Nothing may go upstream until the guard has seen the whole frame — a
    // reader that forwarded optimistically would leak the mutation's prefix and
    // could never take it back.
    expect(result.forward).toHaveLength(0)
    expect(result.frames).toHaveLength(0)
    expect(result.blocked).toBeNull()
  })

  it('reassembles a fragmented message (continuation frames)', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const json = JSON.stringify({jsonrpc: '2.0', method: 'mutate', params: {}, id: 'frag-1'})
    const cut = 12
    const first = encodeClientFrame(Buffer.from(json.slice(0, cut)), {opcode: 0x1, fin: false})
    const rest = encodeClientFrame(Buffer.from(json.slice(cut)), {opcode: 0x0, fin: true})
    const result = guard.inspect(Buffer.concat([first, rest]))
    // A `mutate` smuggled across two frames is still a `mutate`.
    expect(result.blocked).not.toBeNull()
    expect(result.blocked!.rpcMethod).toBe('mutate')
    expect(result.forward).toHaveLength(0)
  })

  it.each([16, 64] as const)('handles the %s-bit extended length form', (lengthForm) => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const payload = Buffer.from(
      JSON.stringify({jsonrpc: '2.0', method: 'mutate', params: {pad: 'x'.repeat(200)}, id: 'x'}),
    )
    const result = guard.inspect(encodeClientFrame(payload, {lengthForm}))
    expect(result.blocked!.rpcMethod).toBe('mutate')
  })

  it('blocks an unmasked client frame (RFC 6455 §5.1 requires masking)', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(
      encodeClientFrame(Buffer.from(JSON.stringify({method: 'presence_announce'})), {
        masked: false,
      }),
    )
    // An unmasked client frame is a protocol violation, and a guard that
    // tolerated it would have to guess where the payload starts.
    expect(result.blocked).not.toBeNull()
    expect(result.forward).toHaveLength(0)
  })

  it('blocks a binary frame — the bifur protocol is JSON text only', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(encodeClientFrame(Buffer.from([1, 2, 3, 4]), {opcode: 0x2}))
    expect(result.blocked).not.toBeNull()
  })

  it.each([
    ['ping', 0x9],
    ['pong', 0xa],
    ['close', 0x8],
  ])('allows the %s control frame', (_name, opcode) => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const frame = encodeClientFrame(Buffer.alloc(0), {opcode})
    const result = guard.inspect(frame)
    expect(result.blocked).toBeNull()
    expect(result.forward.equals(frame)).toBe(true)
    expect(result.frames[0].rpcMethod).toBeNull()
  })

  it('blocks a text frame that is not JSON', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(encodeClientFrame(Buffer.from('not json at all')))
    expect(result.blocked).not.toBeNull()
  })

  it('blocks a JSON text frame with no method (default-deny)', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const result = guard.inspect(encodeClientFrame(Buffer.from(JSON.stringify({jsonrpc: '2.0'}))))
    expect(result.blocked).not.toBeNull()
  })

  it('blocks an over-large frame rather than buffering it', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    // Only the header is sent: a guard that waited for the declared payload
    // would buffer 4 GiB on the attacker's say-so.
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(4 * 1024 * 1024 * 1024), 2)
    const result = guard.inspect(header)
    expect(result.blocked).not.toBeNull()
    expect(result.blocked!.reason.toLowerCase()).toContain('large')
  })
})

/* ------------------------------------------------------------------ *
 * 2b. the latch, for the whole class of ways it is set and probed
 * ------------------------------------------------------------------ *
 * A mutation check on 2026-08-04 removed the `if (latched) return …` line at
 * the top of `inspect()` and only ONE assertion in this file went red — the
 * latch was a single-test claim. Worse, the end-to-end leg cannot cover it: on
 * a refusal `proxy.mjs` writes a 1008 close and destroys the client socket, so
 * no second chunk ever reaches the guard through a real connection. The latch
 * is therefore in-process defence-in-depth, and the unit tests are the only
 * place it can be enforced at all.
 *
 * So the property is stated over the whole class rather than at one point:
 * `latched` is set from three different places, and every kind of later chunk —
 * including a control frame, which is otherwise unconditionally allowed — must
 * be refused once it is.
 */

/** The header of a frame declaring 4 GiB of payload: unparseable, never buffered. */
function oversizeHeader(): Buffer {
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(4 * 1024 * 1024 * 1024), 2)
  return header
}

const UNMASKED_FRAME = encodeClientFrame(
  Buffer.from(JSON.stringify({jsonrpc: '2.0', method: 'presence_announce', id: 'u-1'})),
  {masked: false},
)

const CLOSE_FRAME = encodeClientFrame(Buffer.alloc(0), {opcode: 0x8})

describe('writeGuard · the latch holds for every way it can be set', () => {
  const latchedBy: ReadonlyArray<readonly [string, Buffer]> = [
    ['a refused RPC method', MUTATE_FRAME],
    ['an unmasked frame (RFC 6455 §5.1)', UNMASKED_FRAME],
    ['an over-large frame declaration', oversizeHeader()],
  ]

  it.each(latchedBy)('%s latches, and a later allowlisted frame is not forwarded', (_why, chunk) => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const first = guard.inspect(chunk)
    expect(first.blocked).not.toBeNull()

    const after = guard.inspect(PRESENCE_FRAME)
    expect(after.forward).toHaveLength(0)
    expect(after.frames).toEqual([])
    expect(after.blocked).not.toBeNull()
  })

  it.each(latchedBy)('%s latches, and a later CONTROL frame is not forwarded', (_why, chunk) => {
    // Control frames are the sharpest probe: `classifyFrame` returns
    // `write: false` for them unconditionally, so they are the one input that
    // sails straight through a latch that has stopped working.
    const guard = createRealtimeFrameGuard() as FrameGuard
    guard.inspect(chunk)
    const after = guard.inspect(CLOSE_FRAME)
    expect(after.forward).toHaveLength(0)
    expect(after.blocked).not.toBeNull()
  })

  it('returns the same latched verdict on every later chunk, not a fresh one', () => {
    const guard = createRealtimeFrameGuard() as FrameGuard
    const blocked = guard.inspect(MUTATE_FRAME).blocked
    expect(blocked!.rpcMethod).toBe('mutate')
    for (const chunk of [PRESENCE_FRAME, CLOSE_FRAME, AUTH_FRAME, Buffer.alloc(0)]) {
      const after = guard.inspect(chunk)
      // Identity, not just truthiness: a guard that re-derived a verdict from
      // the LATEST chunk would report `presence_announce` as the reason the
      // connection died, and the audit trail would name the wrong frame.
      expect(after.blocked).toBe(blocked)
      expect(after.forward).toHaveLength(0)
    }
  })

  it('observation mode does not latch on a refused RPC frame', () => {
    // Non-vacuity for the whole block: the latch is what ENFORCEMENT adds. With
    // `enforce: false` the tunnel stays byte-transparent — every frame is still
    // classified and reported, and nothing is held back. Without this, "nothing
    // is forwarded after a block" would also be satisfied by a guard that
    // forwards nothing at all.
    const guard = createRealtimeFrameGuard({enforce: false}) as FrameGuard
    const first = guard.inspect(MUTATE_FRAME)
    expect(first.blocked).toBeNull()
    expect(first.frames[0].write).toBe(true) // still classified, still reported
    expect(first.forward.equals(MUTATE_FRAME)).toBe(true)

    const after = guard.inspect(PRESENCE_FRAME)
    expect(after.forward.equals(PRESENCE_FRAME)).toBe(true)
    expect(after.blocked).toBeNull()
  })

  it.each([
    ['an unmasked frame', UNMASKED_FRAME],
    ['an over-large frame declaration', oversizeHeader()],
  ])('observation mode still latches on %s — framing it cannot parse', (_why, chunk) => {
    // The one thing observation mode does NOT relax. There is no safe offset at
    // which to resume reading a stream whose frame boundaries are unknown, so
    // the reader stops in both modes: it can report what it saw, but it must not
    // go on claiming to have seen the rest.
    const guard = createRealtimeFrameGuard({enforce: false}) as FrameGuard
    expect(guard.inspect(chunk).blocked).not.toBeNull()
    const after = guard.inspect(PRESENCE_FRAME)
    expect(after.forward).toHaveLength(0)
    expect(after.blocked).not.toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * 3. end to end through the proxy
 * ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const wsAccept = (key: string) =>
  crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ws-frames-'))
let logSeq = 0
const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

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

interface Upstream {
  origin: string
  /** Every byte the upstream received on the upgraded socket, in order. */
  received: Buffer[]
  close(): Promise<void>
}

function startUpstream(): Promise<Upstream> {
  const received: Buffer[] = []
  // Upgraded sockets are detached from `http.Server`, so `closeAllConnections()`
  // does not reap them and `server.close()` would wait forever.
  const upgraded = new Set<net.Socket>()
  const server = http.createServer((_req, res) => res.end('nope'))
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    socket.setNoDelay(true)
    socket.on('error', () => {})
    if (head?.length) received.push(head)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAccept(String(req.headers['sec-websocket-key'] || ''))}`,
        '',
        '',
      ].join('\r\n'),
    )
    socket.on('data', (chunk: Buffer) => received.push(chunk))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        received,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of upgraded) socket.destroy()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

async function useUpstream() {
  const upstream = await startUpstream()
  teardowns.push(() => upstream.close())
  return upstream
}

async function startProxy(upstreamOrigin: string, options: Record<string, unknown> = {}) {
  const logPath = path.join(LOG_DIR, `proxy-${++logSeq}.jsonl`)
  const server = createProxyServer({env: {}, upstream: upstreamOrigin, logPath, ...options})
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
  return {
    port: (server.address() as net.AddressInfo).port,
    logPath,
    readLog: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
    rawLog: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''),
  }
}

const SOCKET_PATH = '/v2022-06-30/socket/parity'

/** Open a real upgrade through the proxy and hand back the live socket. */
async function openSocket(port: number): Promise<{socket: net.Socket; rest: Buffer}> {
  const socket = net.connect({host: '127.0.0.1', port})
  socket.setNoDelay(true)
  socket.on('error', () => {})
  await withTimeout(
    new Promise<void>((resolve) => socket.once('connect', () => resolve())),
    2000,
    'a TCP connection to the proxy',
  )
  const key = 'dGhlIHNhbXBsZSBub25jZQ=='
  socket.write(
    [
      `GET ${SOCKET_PATH} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  )
  const rest = await withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.off('data', onData)
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, 32).toString('latin1'))
        if (!status || status[1] !== '101') {
          reject(new Error(`expected 101, got ${status?.[1]}`))
          return
        }
        resolve(buffered.subarray(end + 4))
      }
      socket.on('data', onData)
    }),
    2000,
    'a 101 from the proxy',
  )
  return {socket, rest}
}

/** Wait until `predicate` holds, polling — the log is written synchronously. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('spikeB-proxy · the upgraded tunnel is audited, not opaque', () => {
  it('relays an allowlisted frame and records it server-side', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    socket.write(AUTH_FRAME)
    socket.write(PRESENCE_FRAME)

    await until(
      () => Buffer.concat(upstream.received).length >= AUTH_FRAME.length + PRESENCE_FRAME.length,
      'both frames at the upstream',
    )
    // Byte-identical relay: the masked frames arrive exactly as sent.
    expect(Buffer.concat(upstream.received).equals(Buffer.concat([AUTH_FRAME, PRESENCE_FRAME]))).toBe(
      true,
    )

    await until(() => proxy.readLog().filter((row) => row.frame === true).length >= 2, 'two frame rows')
    const frames = proxy.readLog().filter((row) => row.frame === true)
    expect(frames.map((row) => row.rpc)).toEqual(['authorization', 'presence_announce'])
    expect(frames.every((row) => row.blocked === false)).toBe(true)
    expect(frames[0].path).toBe(SOCKET_PATH)
  })

  it('NEVER writes the bearer token in the authorization frame to the log', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    socket.write(AUTH_FRAME)
    await until(() => proxy.readLog().some((row) => row.rpc === 'authorization'), 'the auth row')

    // The whole log file, not just the parsed fields: a `params` dump anywhere
    // in the line would put the user's credential on disk.
    expect(proxy.rawLog()).not.toContain(SECRET_TOKEN)
    expect(proxy.rawLog()).not.toContain('Bearer')
    // The params KEY, i.e. a serialised `params` object. The method NAME
    // `"rpc":"authorization"` is fine and is asserted present below.
    expect(proxy.rawLog()).not.toContain('"authorization":')
    expect(proxy.rawLog()).not.toContain('"params"')
    expect(proxy.rawLog()).toContain('"rpc":"authorization"')
  })

  it('refuses a mutate frame: nothing reaches upstream, and the log proves it', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    socket.write(MUTATE_FRAME)

    await until(
      () => proxy.readLog().some((row) => row.frame === true && row.blocked === true),
      'a blocked frame row',
    )
    const blocked = proxy.readLog().find((row) => row.blocked === true && row.frame === true)!
    expect(blocked.rpc).toBe('mutate')
    expect(blocked.path).toBe(SOCKET_PATH)
    expect(blocked.status).toBe(1008)

    // THE point of the whole exercise: the bytes never left this machine.
    expect(Buffer.concat(upstream.received)).toHaveLength(0)
  })

  it('closes the client connection with RFC 6455 policy-violation 1008', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    const closeFrame = withTimeout(
      new Promise<Buffer>((resolve) => {
        let buffered = Buffer.alloc(0)
        socket.on('data', (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk])
          if (buffered.length >= 4) resolve(buffered)
        })
      }),
      2000,
      'a close frame from the proxy',
    )
    socket.write(MUTATE_FRAME)

    const frame = await closeFrame
    expect(frame[0] & 0x0f).toBe(0x8) // close opcode
    expect(frame.readUInt16BE(2)).toBe(1008) // policy violation
  })

  it('a frame sent after a blocked one still never reaches upstream', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    socket.write(MUTATE_FRAME)
    socket.write(PRESENCE_FRAME)

    await until(
      () => proxy.readLog().some((row) => row.frame === true && row.blocked === true),
      'a blocked frame row',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(Buffer.concat(upstream.received)).toHaveLength(0)
  })

  it('leaves the tunnel unfiltered when the guard is off, but still logs every frame', async () => {
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: false})
    const {socket} = await openSocket(proxy.port)

    socket.write(MUTATE_FRAME)

    // PROXY_BLOCK_WRITES=0 is observation mode — it is documented as "writes
    // still reach Content Lake", and that must stay true on this leg too, or
    // the two modes stop meaning the same thing. The audit trail is NOT
    // conditional on the policy, though: the escape is evidenced either way.
    await until(
      () => Buffer.concat(upstream.received).length >= MUTATE_FRAME.length,
      'the mutate frame at the upstream',
    )
    const frames = proxy.readLog().filter((row) => row.frame === true)
    expect(frames.map((row) => row.rpc)).toEqual(['mutate'])
    expect(frames[0].blocked).toBe(false)
    expect(frames[0].wouldBlock).toBe(true)
  })

  it('a frame arriving in the same segment as the handshake is still inspected', async () => {
    // `head` — bytes the client pipelined behind its request line, handed to the
    // upgrade handler by Node. If those bypassed the frame guard, an attacker
    // would only have to put the mutate frame in the same TCP segment as the
    // GET, which costs nothing.
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})

    const socket = net.connect({host: '127.0.0.1', port: proxy.port})
    socket.setNoDelay(true)
    socket.on('error', () => {})
    await withTimeout(
      new Promise<void>((resolve) => socket.once('connect', () => resolve())),
      2000,
      'a TCP connection to the proxy',
    )
    socket.write(
      Buffer.concat([
        Buffer.from(
          [
            `GET ${SOCKET_PATH} HTTP/1.1`,
            `Host: 127.0.0.1:${proxy.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        ),
        MUTATE_FRAME,
      ]),
    )

    await until(
      () => proxy.readLog().some((row) => row.frame === true && row.blocked === true),
      'a blocked frame row for the pipelined head',
    )
    expect(Buffer.concat(upstream.received)).toHaveLength(0)
    socket.destroy()
  })
})
