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
 * 2c. P1-2 — bytes are released past a JUDGED boundary, or not at all
 * ------------------------------------------------------------------ *
 * The security review of 2026-08-06 falsified the invariant this module states
 * at its own `createRealtimeFrameGuard` header — *"Bytes are only released once
 * the frame they belong to has been parsed AND classified"*.
 *
 * `releaseUpTo` was advanced by any frame that was not itself a fragment. A
 * control frame is classified `{write: false, reason: 'control frame'}`, so a
 * PING arriving in the middle of a fragmented message advanced the release
 * marker past **every byte scanned so far** — including the held fragment,
 * which had never been judged. RFC 6455 §5.4 explicitly permits control frames
 * to be interleaved into a fragmented message, so this costs an attacker one
 * two-byte PING. A new final TEXT frame did the same thing by a different
 * route: it reset `fragment = null`, judged only its own payload, and its
 * allowlisted verdict flushed the discarded chain.
 *
 * The latch is not the defect and is not touched here — in most of these
 * vectors the guard *does* latch, and the FIN continuation never leaves. What
 * leaves is the prefix, and a prefix carrying the whole `mutate` body is the
 * thing the invariant promised could not happen.
 *
 * THE ORACLE IS THE UPSTREAM'S VIEW, NOT THE GUARD'S. Every assertion below
 * decodes the bytes in `forward` with a reader written for this file and asks
 * what a compliant peer would see. Asserting on `frames` would only re-read the
 * guard's own opinion of what it did.
 */

interface DecodedFrame {
  fin: boolean
  opcode: number
  payload: string
}

/** An independent RFC 6455 reader: what does the upstream socket actually see? */
function decodeUpstream(buffer: Buffer): DecodedFrame[] {
  const out: DecodedFrame[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const fin = (buffer[offset] & 0x80) !== 0
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let key = Buffer.alloc(0)
    if (masked) {
      key = Buffer.from(buffer.subarray(cursor, cursor + 4))
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]
    out.push({fin, opcode, payload: payload.toString('utf8')})
    offset = cursor + length
  }
  return out
}

const MUTATE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  method: 'mutate',
  params: {mutations: [{createOrReplace: {_id: 'article-01', _type: 'article', title: 'pwned'}}]},
  id: 'frag-evil',
})

const QUERY_BODY = JSON.stringify({
  jsonrpc: '2.0',
  method: 'query',
  params: {query: '*[_type=="article"]'},
  id: 'q-1',
})

const PING_FRAME = encodeClientFrame(Buffer.from('hi'), {opcode: 0x9})
const PONG_FRAME = encodeClientFrame(Buffer.from('yo'), {opcode: 0xa})

/**
 * Assert nothing of an unjudged message escaped: neither the exact bytes of the
 * frames that carried it, nor a decoded payload that mentions the method.
 */
function expectNoLeak(forwarded: Buffer, heldFrames: Buffer[], label: string): void {
  for (const held of heldFrames) {
    expect(forwarded.includes(held), `${label}: the raw bytes of a held frame reached upstream`).toBe(
      false,
    )
  }
  for (const frame of decodeUpstream(forwarded)) {
    expect(frame.payload.includes('mutate'), `${label}: upstream saw "${frame.payload}"`).toBe(false)
    expect(frame.payload.includes('createOrReplace'), `${label}: upstream saw a mutation body`).toBe(
      false,
    )
  }
}

describe('writeGuard · a held fragment cannot be released by anything but its own verdict', () => {
  /** The review's vector C, and the whole shape of the finding. */
  it('C. TEXT(fin=0, full mutate) + PING + CONT(fin=1) leaks nothing', () => {
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const first = encodeClientFrame(Buffer.from(MUTATE_BODY), {opcode: 0x1, fin: false})
    const last = encodeClientFrame(Buffer.alloc(0), {opcode: 0x0, fin: true})
    const result = guard.inspect(Buffer.concat([first, PING_FRAME, last]))
    expectNoLeak(result.forward, [first, last], 'vector C')
    expect(result.blocked, 'the reassembled mutate must still latch').not.toBeNull()
  })

  it('D. TEXT(fin=0, full mutate) + TEXT(fin=1, query) leaks nothing', () => {
    // A data frame arriving while a message is in progress is an RFC 6455 §5.4
    // protocol violation. The guard previously treated it as a reset and judged
    // only the newcomer — whose method was `query` — so its verdict released
    // both frames and the guard never saw a write at all.
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const first = encodeClientFrame(Buffer.from(MUTATE_BODY), {opcode: 0x1, fin: false})
    const second = encodeClientFrame(Buffer.from(QUERY_BODY), {opcode: 0x1, fin: true})
    const result = guard.inspect(Buffer.concat([first, second]))
    expectNoLeak(result.forward, [first, second], 'vector D')
    expect(result.blocked, 'a TEXT frame mid-message must latch, not reset').not.toBeNull()
  })

  it('E. the same bytes split across inspect() calls leak nothing either', () => {
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const first = encodeClientFrame(Buffer.from(MUTATE_BODY), {opcode: 0x1, fin: false})
    const last = encodeClientFrame(Buffer.alloc(0), {opcode: 0x0, fin: true})
    let forwarded = Buffer.alloc(0)
    for (const chunk of [first, PING_FRAME, last]) {
      forwarded = Buffer.concat([forwarded, guard.inspect(chunk).forward])
    }
    expectNoLeak(forwarded, [first, last], 'vector E')
  })

  it('F. TEXT(fin=0) + PONG + CONT(fin=0) + PONG + CONT(fin=1) leaks nothing, once or twice', () => {
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const cut = Math.floor(MUTATE_BODY.length / 3)
    const p1 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(0, cut)), {opcode: 0x1, fin: false})
    const p2 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(cut, cut * 2)), {
      opcode: 0x0,
      fin: false,
    })
    const p3 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(cut * 2)), {opcode: 0x0, fin: true})
    const result = guard.inspect(Buffer.concat([p1, PONG_FRAME, p2, PONG_FRAME, p3]))
    expectNoLeak(result.forward, [p1, p2, p3], 'vector F')
    expect(result.blocked).not.toBeNull()
  })

  /**
   * The class, generated: ANY control frame at ANY position inside a fragmented
   * mutate message. Enumerating C and F would leave `close`, and the head and
   * tail positions, uncovered — and the defect had nothing to do with which
   * control frame it was.
   */
  const CONTROL_FRAMES: ReadonlyArray<readonly [string, number]> = [
    ['ping', 0x9],
    ['pong', 0xa],
    ['close', 0x8],
  ]

  const INTERLEAVINGS: ReadonlyArray<readonly [string, number]> = [
    ['before the first fragment', 0],
    ['between the two fragments', 1],
    ['immediately before the FIN continuation', 2],
  ]

  for (const [controlName, controlOpcode] of CONTROL_FRAMES) {
    for (const [where, position] of INTERLEAVINGS) {
      it(`a ${controlName} frame ${where} releases no fragment bytes`, () => {
        const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
        const cut = Math.floor(MUTATE_BODY.length / 2)
        const p1 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(0, cut)), {
          opcode: 0x1,
          fin: false,
        })
        const p2 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(cut)), {opcode: 0x0, fin: true})
        const control = encodeClientFrame(Buffer.alloc(0), {opcode: controlOpcode})
        const parts = [p1, p2]
        parts.splice(position, 0, control)
        const result = guard.inspect(Buffer.concat(parts))
        expectNoLeak(result.forward, [p1, p2], `${controlName} at ${position}`)
      })
    }
  }

  /**
   * The D class, generated: a DATA frame of any shape, at any point in an open
   * chain. Enumerating only `TEXT(fin=1)` would leave the guard free to keep
   * treating `TEXT(fin=0)` as a reset — the same defect, one flag away.
   */
  const INTERRUPTING_DATA_FRAMES: ReadonlyArray<readonly [string, number, boolean]> = [
    ['a final TEXT frame', 0x1, true],
    ['a non-final TEXT frame', 0x1, false],
    ['a binary frame', 0x2, true],
  ]

  for (const [label, opcode, fin] of INTERRUPTING_DATA_FRAMES) {
    for (const [where, afterFragments] of [
      ['right after the opening fragment', 1],
      ['after a continuation', 2],
    ] as ReadonlyArray<readonly [string, number]>) {
      it(`${label} arriving ${where} leaks nothing and latches`, () => {
        const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
        const cut = Math.floor(MUTATE_BODY.length / 2)
        const chain = [
          encodeClientFrame(Buffer.from(MUTATE_BODY.slice(0, cut)), {opcode: 0x1, fin: false}),
          encodeClientFrame(Buffer.from(MUTATE_BODY.slice(cut)), {opcode: 0x0, fin: false}),
        ].slice(0, afterFragments)
        const interrupter = encodeClientFrame(Buffer.from(QUERY_BODY), {opcode, fin})
        const result = guard.inspect(Buffer.concat([...chain, interrupter]))
        expectNoLeak(result.forward, chain, `${label} ${where}`)
        expect(result.blocked, 'an interrupted message has no single meaning').not.toBeNull()
      })
    }
  }

  it('a fragmented mutate spread over one inspect() call per frame leaks nothing', () => {
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const cut = Math.floor(MUTATE_BODY.length / 2)
    const p1 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(0, cut)), {opcode: 0x1, fin: false})
    const p2 = encodeClientFrame(Buffer.from(MUTATE_BODY.slice(cut)), {opcode: 0x0, fin: true})
    let forwarded = Buffer.alloc(0)
    for (const chunk of [p1, PING_FRAME, PONG_FRAME, p2]) {
      forwarded = Buffer.concat([forwarded, guard.inspect(chunk).forward])
    }
    expectNoLeak(forwarded, [p1, p2], 'per-frame chunks')
  })
})

/**
 * The mirror property. Everything above would also be satisfied by a guard that
 * forwarded nothing at all, so the legitimate cases are pinned just as hard:
 * an allowlisted fragmented message, control frames and all, must reach the
 * upstream byte-for-byte, in order, exactly once.
 */
describe('writeGuard · holding is a delay, not a drop', () => {
  it('releases the whole chain — control frames included — once the method is known', () => {
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const cut = Math.floor(QUERY_BODY.length / 2)
    const p1 = encodeClientFrame(Buffer.from(QUERY_BODY.slice(0, cut)), {opcode: 0x1, fin: false})
    const p2 = encodeClientFrame(Buffer.from(QUERY_BODY.slice(cut)), {opcode: 0x0, fin: true})
    const sent = Buffer.concat([p1, PING_FRAME, p2])
    const result = guard.inspect(sent)
    expect(result.blocked).toBeNull()
    expect(result.forward.equals(sent)).toBe(true)
  })

  it('releases exactly once when the chain arrives in separate chunks', () => {
    // "Released twice" is the other half of an offset-based release: bytes held
    // in `pending` and then re-scanned on the next chunk can be emitted again.
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const third = Math.floor(QUERY_BODY.length / 3)
    const p1 = encodeClientFrame(Buffer.from(QUERY_BODY.slice(0, third)), {opcode: 0x1, fin: false})
    const p2 = encodeClientFrame(Buffer.from(QUERY_BODY.slice(third, third * 2)), {
      opcode: 0x0,
      fin: false,
    })
    const p3 = encodeClientFrame(Buffer.from(QUERY_BODY.slice(third * 2)), {opcode: 0x0, fin: true})
    const chunks = [p1, PING_FRAME, p2, PONG_FRAME, p3]
    let forwarded = Buffer.alloc(0)
    for (const chunk of chunks) forwarded = Buffer.concat([forwarded, guard.inspect(chunk).forward])
    expect(forwarded.equals(Buffer.concat(chunks))).toBe(true)
  })

  it('a control frame outside any fragmented message is forwarded immediately', () => {
    // Holding must be scoped to an in-progress message; a keepalive on an idle
    // connection cannot be made to wait for a message that may never come.
    const guard = createRealtimeFrameGuard({enforce: true}) as FrameGuard
    const result = guard.inspect(PING_FRAME)
    expect(result.forward.equals(PING_FRAME)).toBe(true)
  })

  it('observation mode stays byte-transparent through the same interleaving', () => {
    // PROXY_BLOCK_WRITES=0 promises the tunnel is not filtered. The fix must not
    // start holding bytes there, or the two modes stop meaning the same thing.
    const guard = createRealtimeFrameGuard({enforce: false}) as FrameGuard
    const first = encodeClientFrame(Buffer.from(MUTATE_BODY), {opcode: 0x1, fin: false})
    const last = encodeClientFrame(Buffer.alloc(0), {opcode: 0x0, fin: true})
    const sent = Buffer.concat([first, PING_FRAME, last])
    const result = guard.inspect(sent)
    expect(result.forward.equals(sent)).toBe(true)
    expect(result.blocked).toBeNull()
    expect(result.frames.some((f) => f.write)).toBe(true) // still classified, still reported
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

  it('a mutate hidden in a fragment behind a PING never reaches the upstream socket', async () => {
    // P1-2 end to end. The unit tests above prove `forward` is empty; this
    // proves the proxy's own plumbing agrees, because `forwardFromClient`
    // writes whatever the guard hands back and nothing else re-derives it.
    const upstream = await useUpstream()
    const proxy = await startProxy(upstream.origin, {blockWrites: true})
    const {socket} = await openSocket(proxy.port)

    const first = encodeClientFrame(Buffer.from(MUTATE_BODY), {opcode: 0x1, fin: false})
    const last = encodeClientFrame(Buffer.alloc(0), {opcode: 0x0, fin: true})
    socket.write(Buffer.concat([first, PING_FRAME, last]))

    await until(
      () => proxy.readLog().some((row) => row.frame === true && row.blocked === true),
      'a blocked frame row for the fragmented mutate',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(Buffer.concat(upstream.received)).toHaveLength(0)
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
