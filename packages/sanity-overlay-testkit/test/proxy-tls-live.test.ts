/**
 * The TLS upstream leg, proven against a LIVE SOCKET (evidence review F5a,
 * gate-review.md recorded risk 4).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `proxy-tls.test.ts`
 * -------------------------------------------------------
 * That file closed the first half of the gap: it builds a self-signed
 * certificate, stands up a real `tls.createServer`, and drives one genuine
 * handshake through the proxy. But three of its claims were only ever asserted
 * against the OBJECT `upstreamDialSpec()` returns — never against a socket:
 *
 *   1. `dialFromSpec` — the production default `dialUpstream` — has no
 *      success-path coverage at all. Every passing TLS test there injects a
 *      `dialUpstream`, so nothing observes the function that consumes the spec
 *      actually opening a socket from it. The one un-injected run reaches only
 *      `tls.connect`'s FAILURE path (untrusted certificate -> 502).
 *   2. "SNI must carry the hostname `resolveUpstreamHostname` derived" is read
 *      off `spec.options.servername`. The single live read observes `localhost`,
 *      which is the configured upstream host — not a derived name — so the
 *      derivation is not what that assertion is testing.
 *   3. "`secureConnect`, not `connect`" is a string compared to a string. The
 *      distinction is real (`connect` fires pre-handshake, on an UNAUTHORIZED
 *      socket) and cannot be established by reading a config field.
 *
 * HOW EACH IS PROVEN HERE
 * -----------------------
 * Nothing in this file injects `dialUpstream`. `createProxyServer` is left on
 * its production default, so `dialFromSpec` -> `tls.connect` is the code under
 * test in every case. Two node-built-in mechanisms make that possible:
 *
 *   - `tls.setDefaultCACertificates()` (Node >= 22.15) installs the
 *     test-generated certificates into the PROCESS-DEFAULT trust store for the
 *     duration of this file, so the un-injected `tls.connect` — which passes no
 *     `ca` of its own — verifies them. The original store is captured and
 *     restored in `afterAll`, and the certificates are ADDED to it rather than
 *     replacing it.
 *   - `tls.connect` is wrapped for the duration of a test by
 *     `observeTlsConnects()`. The wrapper calls the real `tls.connect`, returns
 *     the real socket, and only listens to it. Nothing is faked or substituted:
 *     `dialFromSpec` still runs, still builds the socket, and the handshake is
 *     a real one. This is what lets claim 3 be an ordering observation on a live
 *     socket instead of a string comparison.
 *
 * The certificates are self-signed with `node:crypto` at test time — no
 * dependency, no fixture, no `openssl`.
 *
 * WHAT IS STILL NOT PROVEN, AND CANNOT BE FROM HERE
 * ------------------------------------------------
 * That `tls.connect` succeeds against the real `<project>.api.sanity.io:443`
 * with the PUBLIC root store and Sanity's own ALPN behaviour. Every certificate
 * here is one this file minted; only a live run against Sanity shows the other.
 */
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'
import crypto from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'

/* ================================================================== *
 * a minimal DER encoder — just enough for self-signed certificates
 * ================================================================== *
 *
 * Deliberately duplicated from `proxy-tls.test.ts` rather than shared. That
 * file's builder is hard-wired to a single `localhost` certificate; this file
 * needs several, each with a DIFFERENT subject alternative name, because the
 * SNI proof below turns "which certificate did the upstream present?" into the
 * observable. Extracting a shared helper would mean a new module in a directory
 * this task does not own.
 */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts))
const derBool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'))
const utcTime = (value: string) => tlv(0x17, Buffer.from(value, 'latin1'))
const octets = (content: Buffer) => tlv(0x04, content)
/** BIT STRING with zero unused trailing bits. */
const bits = (content: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), content]))
/** `[n]` EXPLICIT, constructed. */
const explicit = (n: number, content: Buffer) => tlv(0xa0 | n, content)
/** `[n]` IMPLICIT, primitive. */
const implicitPrimitive = (n: number, content: Buffer) => tlv(0x80 | n, content)

function derInteger(value: Buffer): Buffer {
  const padded = value[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value
  return tlv(0x02, padded)
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f]
    let remaining = part >>> 7
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80)
      remaining >>>= 7
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function utcTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  )
}

function pem(label: string, der: Buffer): string {
  // Chunked by slicing, NOT by a regex replace: the regex form emits a trailing
  // newline when the base64 length is an exact multiple of 64, and the blank
  // line that produces makes OpenSSL's PEM reader stop early.
  const base64 = der.toString('base64')
  const lines: string[] = []
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64))
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

interface SelfSignedCert {
  names: string[]
  keyPem: string
  certPem: string
}

/**
 * A self-signed P-256 certificate for `names`, valid for an hour, with
 * `basicConstraints: CA:TRUE` so the certificate can also serve as its own
 * trust anchor once it is installed in the default CA store.
 *
 * `names[0]` becomes the CN; every name becomes a dNSName SAN. Two certificates
 * minted here with DISJOINT name sets are what makes the SNI proof below a real
 * test: the upstream picks between them using only the SNI the proxy sent, and
 * picking wrong makes Node's own identity check fail the handshake.
 */
function selfSignedCert(names: string[]): SelfSignedCert {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'})
  const spki = publicKey.export({format: 'der', type: 'spki'}) as Buffer

  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'))
  const commonName = seq(set(seq(oid('2.5.4.3'), utf8(names[0]))))

  const now = new Date()
  const validity = seq(
    utcTime(utcTimeString(new Date(now.getTime() - 60_000))),
    utcTime(utcTimeString(new Date(now.getTime() + 3_600_000))),
  )

  const basicConstraints = seq(
    oid('2.5.29.19'),
    derBool(true), // critical
    octets(seq(derBool(true))), // CA:TRUE
  )
  const subjectAltName = seq(
    oid('2.5.29.17'),
    octets(seq(...names.map((name) => implicitPrimitive(2, Buffer.from(name, 'latin1'))))),
  )

  // Serial: random, top byte forced into 0x01-0x7f so the DER INTEGER is both
  // positive and minimally encoded without a pad byte.
  const serial = crypto.randomBytes(8)
  serial[0] = (serial[0] % 0x7f) + 1

  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([0x02]))), // version v3
    derInteger(serial),
    ecdsaWithSha256,
    commonName, // issuer
    validity,
    commonName, // subject
    spki,
    explicit(3, seq(basicConstraints, subjectAltName)),
  )

  const signature = crypto.sign('sha256', tbs, privateKey)
  const certificate = seq(tbs, ecdsaWithSha256, bits(signature))

  return {
    names,
    keyPem: privateKey.export({format: 'pem', type: 'pkcs8'}) as string,
    certPem: pem('CERTIFICATE', certificate),
  }
}

/* ------------------------------------------------------------------ *
 * the three identities this file needs
 * ------------------------------------------------------------------ */

/**
 * `<project>.localhost` is the shape `resolveUpstreamHostname` derives:
 * @sanity/client builds `https://<projectId>.<apiHost-host>`, and the proxy
 * rewrites the first label of the CONFIGURED upstream host onto the first label
 * of the incoming `Host`. So a configured upstream of `upstream.localhost` plus
 * an incoming `Host: b1n03q3z.localhost` derives `b1n03q3z.localhost` — a name
 * that is neither the configured host nor anything the test hard-codes into the
 * dial.
 */
const CONFIGURED_UPSTREAM_HOST = 'upstream.localhost'
const DERIVED_HOST = 'b1n03q3z.localhost'

/** For the plain (no-derivation) cases: the configured host IS the dialled host. */
const CERT_LOCALHOST = selfSignedCert(['localhost'])
/** Presented when SNI does NOT name the derived host. Does not cover it. */
const CERT_CONFIGURED = selfSignedCert([CONFIGURED_UPSTREAM_HOST])
/** Presented only when SNI names the derived host. Covers nothing else. */
const CERT_DERIVED = selfSignedCert([DERIVED_HOST])

/* ------------------------------------------------------------------ *
 * process-default trust, installed for this file only
 * ------------------------------------------------------------------ */

let originalCACertificates: string[] = []

beforeAll(() => {
  // ADD, never replace: the ~144 public roots stay in place, so nothing else
  // that happens to open a TLS connection in this worker changes behaviour.
  originalCACertificates = tls.getCACertificates()
  tls.setDefaultCACertificates([
    ...originalCACertificates,
    CERT_LOCALHOST.certPem,
    CERT_CONFIGURED.certPem,
    CERT_DERIVED.certPem,
  ])
})

afterAll(() => {
  tls.setDefaultCACertificates(originalCACertificates)
})

/* ================================================================== *
 * observing the REAL tls.connect
 * ================================================================== */

interface DialEvent {
  name: 'connect' | 'secureConnect'
  at: number
  authorized: boolean
  encrypted: boolean
}

interface DialRecord {
  options: Record<string, unknown>
  socket: tls.TLSSocket
  events: DialEvent[]
  /** The proxy's first `write()` on this socket — the request head. */
  firstWrite: {at: number; authorized: boolean; encrypted: boolean; head: string} | null
}

/**
 * Wrap `tls.connect` so every socket the proxy opens can be watched.
 *
 * This is OBSERVATION, not injection. `proxy.mjs` does `import tls from
 * 'node:tls'` and calls `tls.connect(spec.options)`, resolving the property at
 * call time on the builtin's module object — the same object this function
 * patches. So `dialFromSpec` runs unmodified, receives the spec the proxy built,
 * and gets back the socket the REAL `tls.connect` produced. The wrapper adds
 * listeners and records the timing of the first `write()`; it changes no option
 * and substitutes no transport.
 *
 * Timings are monotonic (`process.hrtime.bigint`) and relative to the moment
 * the socket was created, so they are comparable within one dial.
 */
function observeTlsConnects(): {records: DialRecord[]; restore: () => void} {
  const records: DialRecord[] = []
  const realConnect = tls.connect
  const patched = function (this: unknown, ...args: unknown[]) {
    const socket = (realConnect as (...a: unknown[]) => tls.TLSSocket).apply(this, args)
    const started = process.hrtime.bigint()
    const at = () => Number(process.hrtime.bigint() - started) / 1e6
    const record: DialRecord = {
      options: (args[0] || {}) as Record<string, unknown>,
      socket,
      events: [],
      firstWrite: null,
    }
    for (const name of ['connect', 'secureConnect'] as const) {
      socket.on(name, () => {
        record.events.push({
          name,
          at: at(),
          authorized: socket.authorized,
          encrypted: Boolean((socket as tls.TLSSocket & {encrypted?: boolean}).encrypted),
        })
      })
    }
    const realWrite = socket.write.bind(socket)
    ;(socket as unknown as {write: (...a: unknown[]) => boolean}).write = (...writeArgs: unknown[]) => {
      if (record.firstWrite === null) {
        const chunk = writeArgs[0]
        record.firstWrite = {
          at: at(),
          authorized: socket.authorized,
          encrypted: Boolean((socket as tls.TLSSocket & {encrypted?: boolean}).encrypted),
          head: Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk),
        }
      }
      return (realWrite as (...a: unknown[]) => boolean)(...writeArgs)
    }
    records.push(record)
    return socket
  }
  ;(tls as unknown as {connect: unknown}).connect = patched
  return {
    records,
    restore: () => {
      ;(tls as unknown as {connect: unknown}).connect = realConnect
    },
  }
}

/* ================================================================== *
 * a TLS upstream that speaks the RFC 6455 handshake
 * ================================================================== */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsAccept(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

/**
 * Decode masked client->server frames (RFC 6455 §5.2/§5.3), by hand.
 *
 * An INDEPENDENT oracle on purpose: reusing `createRealtimeFrameGuard` to check
 * what the frame guard forwarded would be asking the implementation to grade its
 * own homework.
 */
function decodeClientFrames(buffer: Buffer): {
  frames: Array<{opcode: number; payload: Buffer}>
  rest: Buffer
} {
  const frames: Array<{opcode: number; payload: Buffer}> = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    const lengthByte = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    let length = lengthByte
    if (lengthByte === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (lengthByte === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask: Buffer | null = null
    if (masked) {
      if (buffer.length - cursor < 4) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    frames.push({opcode, payload})
    offset = cursor + length
  }
  return {frames, rest: buffer.subarray(offset)}
}

/** A masked client->server text frame. */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length > 125) throw new Error('test frames stay in the 7-bit length form')
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
}

interface TlsUpgradeRecord {
  requestLine: string
  headers: Record<string, string>
  /** The SNI name the client sent, or undefined when it sent none. */
  servername: string | undefined
  alpnProtocol: string | false
  /** Proof the leg was TLS and not plain TCP. */
  encrypted: boolean
  tlsProtocol: string | null
  /** Which certificate the upstream ended up presenting, by CN. */
  presentedCertCN: string
  /** Client frames decoded on the upstream side of the proxy, in arrival order. */
  clientFrames: Array<{opcode: number; text: string}>
}

interface TlsUpstream {
  origin: (hostname: string) => string
  port: number
  upgrades: TlsUpgradeRecord[]
  close(): Promise<void>
}

interface UpstreamOptions {
  /** Extra SNI-selected certificates, keyed by the servername that selects them. */
  sniCertificates?: SelfSignedCert[]
  /** Push this text frame straight after the 101. */
  serverFrame?: string
}

/**
 * Deliberately raw: it parses the request head itself and answers 101, because
 * the point is to observe what the proxy's `tls.connect` put on the wire — SNI,
 * ALPN, the verbatim request line and the client frames — not to be a correct
 * HTTP server.
 */
function startTlsUpstream(
  defaultCert: SelfSignedCert,
  options: UpstreamOptions = {},
): Promise<TlsUpstream> {
  const upgrades: TlsUpgradeRecord[] = []
  const defaultContext = tls.createSecureContext({key: defaultCert.keyPem, cert: defaultCert.certPem})
  const sniContexts = new Map<string, tls.SecureContext>()
  for (const cert of options.sniCertificates || []) {
    for (const name of cert.names) {
      sniContexts.set(name, tls.createSecureContext({key: cert.keyPem, cert: cert.certPem}))
    }
  }

  const serverOptions: tls.TlsOptions = {
    key: defaultCert.keyPem,
    cert: defaultCert.certPem,
    // Offers h2 FIRST. The proxy pins `ALPNProtocols: ['http/1.1']`, so a
    // negotiated 'http/1.1' proves the pin held; drop the pin and the client
    // offers nothing and negotiates nothing.
    ALPNProtocols: ['h2', 'http/1.1'],
  }

  if (sniContexts.size > 0) {
    // SNICallback fires only when the client SENT an SNI extension. When it did
    // not, Node falls through to the default key/cert above — which is exactly
    // the failure mode the SNI proof relies on.
    serverOptions.SNICallback = (servername, callback) => {
      callback(null, sniContexts.get(servername) || defaultContext)
    }
  }

  const server = tls.createServer(serverOptions, (socket) => {
    socket.setNoDelay(true)
    socket.on('error', () => {
      /* teardown races are expected */
    })
    const peerCert = socket.getCertificate() as {subject?: {CN?: string}} | null
    const record: TlsUpgradeRecord = {
      requestLine: '',
      headers: {},
      servername: (socket as tls.TLSSocket & {servername?: string}).servername || undefined,
      alpnProtocol: socket.alpnProtocol as string | false,
      encrypted: Boolean(socket.encrypted),
      tlsProtocol: socket.getProtocol(),
      presentedCertCN: peerCert?.subject?.CN || '',
      clientFrames: [],
    }

    let buffered = Buffer.alloc(0)
    let head = false
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!head) {
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        const lines = buffered.subarray(0, end).toString('latin1').split('\r\n')
        record.requestLine = lines[0]
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          record.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        head = true
        upgrades.push(record)
        buffered = buffered.subarray(end + 4)
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${wsAccept(record.headers['sec-websocket-key'] || '')}`,
            '',
            '',
          ].join('\r\n'),
        )
        if (options.serverFrame) {
          const payload = Buffer.from(options.serverFrame, 'utf8')
          socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
        }
      }
      const decoded = decodeClientFrames(buffered)
      buffered = decoded.rest
      for (const frame of decoded.frames) {
        record.clientFrames.push({opcode: frame.opcode, text: frame.payload.toString('utf8')})
      }
    })
  })

  return new Promise((resolve) => {
    // No bind address: Node binds `::` with ipv6Only off, so both `localhost`
    // and `<label>.localhost` (which resolve to ::1) reach it.
    server.listen(0, () => {
      const address = server.address() as net.AddressInfo
      resolve({
        origin: (hostname: string) => `https://${hostname}:${address.port}`,
        port: address.port,
        upgrades,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/* ================================================================== *
 * harness
 * ================================================================== */

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tls-live-'))
let logSeq = 0
const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

async function startProxy(upstreamOrigin: string, options: Record<string, unknown> = {}) {
  const logPath = path.join(LOG_DIR, `proxy-${++logSeq}.jsonl`)
  // NOTE: no `dialUpstream`. Every test in this file runs the production
  // default, `dialFromSpec`.
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
  const address = server.address() as net.AddressInfo
  return {
    server,
    port: address.port,
    readLog: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
  }
}

async function useTlsUpstream(cert: SelfSignedCert, options: UpstreamOptions = {}) {
  const upstream = await startTlsUpstream(cert, options)
  teardowns.push(() => upstream.close())
  return upstream
}

/**
 * A plain-TCP relay that accepts instantly but holds the client's FIRST chunk —
 * the ClientHello — for `delayMs` before forwarding it.
 *
 * This is how CLAIM 3 gets a wide, reliable window between `connect` and
 * `secureConnect` WITHOUT depending on anything TLS-level. Stalling inside the
 * server's `SNICallback` would have worked too, but only for a client that sent
 * SNI — which would have made the ordering proof quietly co-dependent on the SNI
 * proof, and a mutation to one would have shown up as a failure of the other.
 * At this layer the delay is unconditional: TCP connects at once, the handshake
 * cannot start for `delayMs`, and nothing about the stall knows what TLS is.
 */
async function useHandshakeStallRelay(targetPort: number, delayMs: number): Promise<number> {
  const relay = net.createServer((client) => {
    client.on('error', () => {})
    const upstreamLeg = net.connect({host: '127.0.0.1', port: targetPort})
    upstreamLeg.on('error', () => client.destroy())
    let released = false
    client.on('data', (chunk: Buffer) => {
      if (released) {
        upstreamLeg.write(chunk)
        return
      }
      released = true
      client.pause()
      setTimeout(() => {
        upstreamLeg.write(chunk)
        client.resume()
      }, delayMs)
    })
    upstreamLeg.on('data', (chunk: Buffer) => {
      if (client.writable) client.write(chunk)
    })
    client.on('close', () => upstreamLeg.destroy())
    upstreamLeg.on('close', () => client.destroy())
  })
  // No bind address, like the TLS upstream: the proxy dials the name
  // `localhost`, which resolves to ::1 on this platform.
  await new Promise<void>((resolve) => relay.listen(0, () => resolve()))
  teardowns.push(() => new Promise<void>((resolve) => relay.close(() => resolve())))
  return (relay.address() as net.AddressInfo).port
}

function useTlsObserver() {
  const observer = observeTlsConnects()
  teardowns.push(() => observer.restore())
  return observer
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)),
      ms,
    )
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

/** Poll until `predicate` holds, so an assertion never races a socket. */
async function until(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`)
}

interface Attempt {
  socket: net.Socket
  status: number
  headers: Record<string, string>
  rest: Buffer
  body: string
  /** Everything the proxy sent back after the response head, appended live. */
  tail: () => Buffer
}

/**
 * Put one upgrade request head on the proxy and read the whole HTTP response.
 *
 * `hostHeader` is a parameter because the derived-hostname case is driven
 * entirely by it: the socket still goes to 127.0.0.1, but `Host:
 * <project>.localhost` is what makes `resolveUpstreamHostname` derive.
 */
function upgradeThroughProxy(
  port: number,
  requestPath: string,
  key: string,
  hostHeader?: string,
): Promise<Attempt> {
  return withTimeout(
    new Promise<Attempt>((resolve, reject) => {
      const socket = net.connect({host: '127.0.0.1', port})
      socket.setNoDelay(true)
      socket.on('error', reject)
      teardowns.push(() => {
        socket.destroy()
      })
      socket.once('connect', () => {
        socket.write(
          [
            `GET ${requestPath} HTTP/1.1`,
            `Host: ${hostHeader || `127.0.0.1:${port}`}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        )
      })
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        const lines = buffered.subarray(0, end).toString('latin1').split('\r\n')
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || '')
        if (!match) {
          reject(new Error(`malformed status line: ${JSON.stringify(lines[0])}`))
          return
        }
        const headers: Record<string, string> = {}
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        const rest = buffered.subarray(end + 4)
        const expected = Number(headers['content-length'] || 0)
        if (rest.length < expected) return
        socket.off('data', onData)
        // Keep collecting: close frames and relayed server frames arrive later.
        let tail = Buffer.from(rest)
        socket.on('data', (more: Buffer) => {
          tail = Buffer.concat([tail, more])
        })
        resolve({
          socket,
          status: Number(match[1]),
          headers,
          rest,
          body: rest.toString('utf8'),
          tail: () => tail,
        })
      }
      socket.on('data', onData)
    }),
    5000,
    'an HTTP response from the proxy upgrade path',
  )
}

const SOCKET_PATH = '/v2022-06-30/socket/parity'
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

/* ================================================================== *
 * 0. the instruments this file depends on
 * ================================================================== */

describe('spikeB-proxy · live-TLS harness · the instruments', () => {
  /**
   * Everything below is meaningless if `<label>.localhost` does not resolve to
   * loopback: the derived hostname the proxy dials would go nowhere (or, far
   * worse, somewhere real). Asserted rather than assumed, so the failure names
   * itself instead of surfacing as a mystery ECONNREFUSED.
   */
  it('resolves the derived hostname to loopback, so the dialled name is reachable', async () => {
    const resolved = await new Promise<{address: string; family: number}>((resolve, reject) => {
      dns.lookup(DERIVED_HOST, (err, address, family) =>
        err ? reject(err) : resolve({address, family}),
      )
    })
    expect(['127.0.0.1', '::1']).toContain(resolved.address)
  })

  it('mints certificates Node parses, with disjoint names and no shared trust with the root store', () => {
    const configured = new crypto.X509Certificate(CERT_CONFIGURED.certPem)
    const derived = new crypto.X509Certificate(CERT_DERIVED.certPem)

    expect(configured.subjectAltName).toBe(`DNS:${CONFIGURED_UPSTREAM_HOST}`)
    expect(derived.subjectAltName).toBe(`DNS:${DERIVED_HOST}`)
    // Disjoint on purpose: the SNI proof below is "which one did the upstream
    // present?", which is only a question if neither covers the other's name.
    expect(configured.subjectAltName).not.toContain(DERIVED_HOST)
    expect(derived.subjectAltName).not.toContain(CONFIGURED_UPSTREAM_HOST)
    expect(new Date(derived.validTo).getTime()).toBeGreaterThan(Date.now())

    // They are trusted here ONLY because beforeAll installed them.
    expect(originalCACertificates).not.toContain(CERT_DERIVED.certPem)
    expect(tls.getCACertificates()).toContain(CERT_DERIVED.certPem)
  })

  /**
   * Non-vacuity for the SNI proof, established WITHOUT the proxy.
   *
   * The upstream presents `CERT_DERIVED` only to a ClientHello whose SNI names
   * the derived host, and `CERT_CONFIGURED` to everything else. Node's own
   * identity check then rejects the connection — so "the handshake completed"
   * IS "the right SNI was sent". This test is what tells that apart from an
   * upstream that would have accepted anything.
   */
  it('serves a certificate that only validates for the derived host when SNI names it', async () => {
    const upstream = await useTlsUpstream(CERT_CONFIGURED, {sniCertificates: [CERT_DERIVED]})

    const dial = (options: tls.ConnectionOptions) =>
      new Promise<{ok: boolean; cn?: string; code?: string}>((resolve) => {
        const socket = tls.connect(options)
        socket.once('secureConnect', () => {
          const cn = (socket.getPeerCertificate() as {subject?: {CN?: string}}).subject?.CN
          socket.destroy()
          resolve({ok: true, cn})
        })
        socket.once('error', (err: NodeJS.ErrnoException) => resolve({ok: false, code: err.code}))
      })

    // SNI suppressed (`servername: ''`): the upstream falls back to the
    // configured-host certificate, which does not cover the derived name.
    expect(
      await dial({host: DERIVED_HOST, port: upstream.port, servername: ''}),
    ).toMatchObject({ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID'})

    // SNI naming the derived host: the upstream can answer for it.
    expect(await dial({host: DERIVED_HOST, port: upstream.port, servername: DERIVED_HOST})).toEqual({
      ok: true,
      cn: DERIVED_HOST,
    })
  })
})

/* ================================================================== *
 * CLAIM 1 — dialFromSpec's SUCCESS path, with nothing injected
 * ================================================================== */

describe('spikeB-proxy · CLAIM 1 · dialFromSpec opens a real socket from the spec', () => {
  /**
   * The production default `dialUpstream` is `dialFromSpec`, and until now its
   * only executed path was `tls.connect` FAILING on an untrusted certificate.
   * Here the certificate is trusted (process default CA store, installed in
   * `beforeAll`), so the function runs all the way through: it reads
   * `spec.transport`, calls `tls.connect(spec.options)`, and the socket that
   * comes back carries the whole upgrade.
   *
   * Every assertion is made on the UPSTREAM side of a genuine handshake — the
   * option object the proxy built is never inspected.
   */
  it('completes an upgrade over a socket dialled by the production default', async () => {
    const upstream = await useTlsUpstream(CERT_LOCALHOST, {serverFrame: 'welcome-over-tls'})
    const observer = useTlsObserver()
    const proxy = await startProxy(upstream.origin('localhost'))

    const attempt = await upgradeThroughProxy(proxy.port, `${SOCKET_PATH}?query=*`, WS_KEY)

    expect(attempt.status).toBe(101)
    expect(attempt.headers['sec-websocket-accept']).toBe(wsAccept(WS_KEY))

    // The upstream saw ONE connection, and it was encrypted.
    expect(upstream.upgrades).toHaveLength(1)
    const [seen] = upstream.upgrades
    expect(seen.encrypted).toBe(true)
    expect(seen.tlsProtocol).toMatch(/^TLSv1\.[23]$/)
    expect(seen.requestLine).toBe(`GET ${SOCKET_PATH}?query=* HTTP/1.1`)

    // Options that only reach the wire if `dialFromSpec` passed `spec.options`
    // to `tls.connect` verbatim. `servername` is not defaulted from `host` by
    // Node — drop the field and the upstream sees no SNI at all.
    expect(seen.servername).toBe('localhost')
    // The upstream offered h2 FIRST and still negotiated http/1.1, because the
    // proxy's pin was the only thing on offer.
    expect(seen.alpnProtocol).toBe('http/1.1')

    // And it really was `tls.connect`, called exactly once, by the proxy.
    expect(observer.records).toHaveLength(1)
    expect(observer.records[0].socket.encrypted).toBe(true)
    expect(observer.records[0].socket.authorized).toBe(true)

    // Bytes past the 101 flow in the upstream -> client direction.
    await until(() => attempt.tail().length >= 18, 2000, 'the welcome frame over TLS')
    expect(attempt.tail().subarray(2, 18).toString('utf8')).toBe('welcome-over-tls')

    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      path: SOCKET_PATH,
      status: 101,
      blocked: false,
    })
  })

  /**
   * The other half of `dialFromSpec`'s branch, also on a live socket: an `http:`
   * upstream must produce a PLAIN TCP connection. Asserted by the absence of any
   * `tls.connect` at all plus an unencrypted upstream leg — a `tls.connect` here
   * would hang forever against a plain listener.
   */
  it('opens a plain TCP socket for an http upstream, calling tls.connect zero times', async () => {
    const upgrades: Array<{requestLine: string; encrypted: boolean}> = []
    const plain = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', (chunk: Buffer) => {
        upgrades.push({
          requestLine: chunk.toString('latin1').split('\r\n')[0],
          encrypted: Boolean((socket as net.Socket & {encrypted?: boolean}).encrypted),
        })
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${wsAccept(WS_KEY)}`,
            '',
            '',
          ].join('\r\n'),
        )
      })
    })
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', () => resolve()))
    teardowns.push(() => new Promise<void>((resolve) => plain.close(() => resolve())))
    const plainPort = (plain.address() as net.AddressInfo).port

    const observer = useTlsObserver()
    const proxy = await startProxy(`http://127.0.0.1:${plainPort}`)

    const attempt = await upgradeThroughProxy(proxy.port, SOCKET_PATH, WS_KEY)

    expect(attempt.status).toBe(101)
    expect(upgrades).toEqual([{requestLine: `GET ${SOCKET_PATH} HTTP/1.1`, encrypted: false}])
    expect(observer.records).toEqual([])
  })
})

/* ================================================================== *
 * CLAIM 2 — SNI carries the DERIVED hostname, read off the live socket
 * ================================================================== */

describe('spikeB-proxy · CLAIM 2 · SNI on the live socket carries the derived hostname', () => {
  /**
   * The claim in `proxy.mjs` is that SNI must carry the hostname
   * `resolveUpstreamHostname` derived, "or the handshake asks for a certificate
   * the upstream cannot present". This test makes that literal:
   *
   *   - the proxy is configured with upstream `https://upstream.localhost:<p>`
   *   - the client sends `Host: b1n03q3z.localhost:<proxy port>`
   *   - so the derived hostname is `b1n03q3z.localhost`, which appears NOWHERE
   *     in the proxy's configuration
   *   - the upstream presents a certificate for the derived host ONLY to a
   *     ClientHello whose SNI names it, and a certificate for the CONFIGURED
   *     host otherwise — which Node's identity check rejects
   *
   * A 101 is therefore only reachable if the derived name reached SNI, and the
   * servername read below is read off the server's own TLSSocket.
   */
  it('sends the derived name as SNI, and the upstream answers with the matching certificate', async () => {
    const upstream = await useTlsUpstream(CERT_CONFIGURED, {sniCertificates: [CERT_DERIVED]})
    const observer = useTlsObserver()
    const proxy = await startProxy(upstream.origin(CONFIGURED_UPSTREAM_HOST))

    const attempt = await upgradeThroughProxy(
      proxy.port,
      SOCKET_PATH,
      WS_KEY,
      `${DERIVED_HOST}:${proxy.port}`,
    )

    expect(attempt.status).toBe(101)
    expect(upstream.upgrades).toHaveLength(1)
    const [seen] = upstream.upgrades

    // THE CLAIM: SNI, read off the live server-side TLSSocket.
    expect(seen.servername).toBe(DERIVED_HOST)
    // Non-vacuity: the derived name is NOT the configured upstream host, so this
    // cannot pass by the proxy simply forwarding what it was configured with.
    expect(seen.servername).not.toBe(CONFIGURED_UPSTREAM_HOST)
    expect(proxy.server.proxyConfig.upstream.hostname).toBe(CONFIGURED_UPSTREAM_HOST)

    // And the SNI is what selected the certificate: the upstream's default
    // certificate does not cover the derived name, so a wrong or missing SNI
    // would have failed Node's identity check instead of reaching a 101.
    expect(seen.presentedCertCN).toBe(DERIVED_HOST)
    expect(observer.records[0].socket.authorized).toBe(true)
    expect(
      (observer.records[0].socket.getPeerCertificate() as {subject?: {CN?: string}}).subject?.CN,
    ).toBe(DERIVED_HOST)

    // The forwarded Host header follows the same derivation.
    expect(seen.headers.host).toBe(`${DERIVED_HOST}:${upstream.port}`)
  })

  /**
   * The complement, so the test above cannot pass by deriving unconditionally:
   * with derivation switched off, the SNI on the wire is the CONFIGURED host and
   * the upstream answers with the configured-host certificate.
   */
  it('sends the configured host as SNI when derivation is disabled', async () => {
    const upstream = await useTlsUpstream(CERT_CONFIGURED, {sniCertificates: [CERT_DERIVED]})
    useTlsObserver()
    const proxy = await startProxy(upstream.origin(CONFIGURED_UPSTREAM_HOST), {
      deriveProjectHost: false,
    })

    const attempt = await upgradeThroughProxy(
      proxy.port,
      SOCKET_PATH,
      WS_KEY,
      `${DERIVED_HOST}:${proxy.port}`,
    )

    expect(attempt.status).toBe(101)
    expect(upstream.upgrades).toHaveLength(1)
    expect(upstream.upgrades[0].servername).toBe(CONFIGURED_UPSTREAM_HOST)
    expect(upstream.upgrades[0].presentedCertCN).toBe(CONFIGURED_UPSTREAM_HOST)
  })
})

/* ================================================================== *
 * CLAIM 3 — the proxy writes only after `secureConnect`
 * ================================================================== */

describe('spikeB-proxy · CLAIM 3 · the request head waits for the handshake', () => {
  /**
   * WHY THIS NEEDS A LIVE SOCKET AND A SLOW HANDSHAKE.
   *
   * `tls.connect` returns a TLSSocket that emits BOTH events: `connect` when the
   * TCP connection is up, `secureConnect` when the handshake finishes. Between
   * them the socket is `encrypted` but NOT `authorized` — the peer certificate
   * has not been verified yet. A `write()` in that window is buffered by the TLS
   * layer and flushed after the handshake, so a proxy that listened for
   * `connect` would still LOOK correct end-to-end: the bytes arrive, the 101
   * comes back, every functional assertion passes. The difference is only ever
   * visible as an ordering, which is why `connectEvent: 'secureConnect'` could
   * previously be checked only as a string on a config object.
   *
   * So: a plain-TCP relay stalls the ClientHello, opening a ~250ms window in
   * which `connect` has fired and `secureConnect` has not, and the proxy's first
   * `write()` is timed against both on the real socket it dialled.
   */
  it('writes the request head after secureConnect, on an authorized socket', async () => {
    const upstream = await useTlsUpstream(CERT_LOCALHOST)
    const stalledPort = await useHandshakeStallRelay(upstream.port, 250)
    const observer = useTlsObserver()
    const proxy = await startProxy(`https://localhost:${stalledPort}`)

    const attempt = await upgradeThroughProxy(proxy.port, SOCKET_PATH, WS_KEY)
    expect(attempt.status).toBe(101)

    expect(observer.records).toHaveLength(1)
    const [dial] = observer.records

    // Both events fired, in this order, on the socket the proxy is using.
    expect(dial.events.map((event) => event.name)).toEqual(['connect', 'secureConnect'])
    const [connected, secured] = dial.events

    // Non-vacuity: `connect` was a real, EARLIER opportunity the proxy declined.
    // Without the stall these two can land in the same millisecond and the
    // ordering assertion below would prove nothing.
    expect(secured.at - connected.at).toBeGreaterThan(100)

    // The window is exactly the one that matters: pre-handshake the peer is
    // unverified, post-handshake it is verified.
    expect(connected.authorized).toBe(false)
    expect(secured.authorized).toBe(true)

    // THE CLAIM: the first byte the proxy wrote went out AFTER the handshake,
    // onto a socket whose peer certificate had been verified. This is the whole
    // security content of `connectEvent: 'secureConnect'` — the request head
    // carries the user's `Authorization: Bearer`.
    expect(dial.firstWrite).not.toBeNull()
    expect(dial.firstWrite!.head).toMatch(/^GET \/v2022-06-30\/socket\/parity HTTP\/1\.1\r\n/)
    expect(dial.firstWrite!.at).toBeGreaterThanOrEqual(secured.at)
    expect(dial.firstWrite!.authorized).toBe(true)
    expect(dial.firstWrite!.encrypted).toBe(true)

    // Restated as a pure ordering, independent of the clock.
    const timeline = [...dial.events.map((e) => e.name), 'write'].sort(
      (a, b) =>
        (a === 'write' ? dial.firstWrite!.at : dial.events.find((e) => e.name === a)!.at) -
        (b === 'write' ? dial.firstWrite!.at : dial.events.find((e) => e.name === b)!.at),
    )
    expect(timeline).toEqual(['connect', 'secureConnect', 'write'])
  }, 15_000)
})

/* ================================================================== *
 * CLAIM 4 — a CLIENT frame crosses real TLS, and the guard rules on it
 * ================================================================== */

describe('spikeB-proxy · CLAIM 4 · the frame guard on the TLS transport', () => {
  /**
   * `proxy-ws-frames.test.ts` exercises the frame guard thoroughly — over
   * `node:net`. In production the guard's client leg sits on top of a TLS
   * socket, and no test had ever put a CLIENT frame on that transport: the one
   * live-TLS frame assertion in `proxy-tls.test.ts` reads a frame the SERVER
   * pushed, which never touches the guard at all.
   *
   * Here both directions run over the same genuine TLS upstream, dialled by the
   * production default: an allowlisted frame must arrive upstream byte-for-byte,
   * and `mutate` must not arrive at all.
   */
  it('forwards an allowlisted client frame upstream and blocks mutate, over genuine TLS', async () => {
    const upstream = await useTlsUpstream(CERT_LOCALHOST)
    const observer = useTlsObserver()
    const proxy = await startProxy(upstream.origin('localhost'), {blockWrites: true})

    const attempt = await upgradeThroughProxy(proxy.port, SOCKET_PATH, WS_KEY)
    expect(attempt.status).toBe(101)
    expect(upstream.upgrades).toHaveLength(1)
    const [seen] = upstream.upgrades
    expect(seen.encrypted).toBe(true)
    expect(observer.records[0].socket.encrypted).toBe(true)

    // 1. An allowlisted read frame must cross the TLS leg intact.
    const listen = JSON.stringify({
      jsonrpc: '2.0',
      id: 'f1',
      method: 'listen_subscribe',
      params: {query: '*'},
    })
    attempt.socket.write(maskedTextFrame(listen))
    await until(() => seen.clientFrames.length >= 1, 3000, 'the listen frame to reach the upstream')
    expect(seen.clientFrames).toEqual([{opcode: 0x1, text: listen}])

    // 2. `mutate` is a declared bifur client method and must not.
    const mutate = JSON.stringify({
      jsonrpc: '2.0',
      id: 'f2',
      method: 'mutate',
      params: {mutations: []},
    })
    attempt.socket.write(maskedTextFrame(mutate))

    // The proxy answers with an RFC 6455 §5.5.1 close, code 1008 (policy
    // violation), and tears the pair down.
    await until(
      () => attempt.tail().some((byte, index) => byte === 0x88 && index + 3 < attempt.tail().length),
      3000,
      'a close frame back from the proxy',
    )
    const tail = attempt.tail()
    const closeAt = tail.indexOf(0x88)
    expect(tail[closeAt + 1]).toBe(2)
    expect(tail.readUInt16BE(closeAt + 2)).toBe(1008)

    // Nothing more reached the upstream: still just the listen frame.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen.clientFrames.map((frame) => frame.text)).toEqual([listen])

    // Server-side evidence, over TLS, for both verdicts.
    const frames = proxy.readLog().filter((entry) => entry.frame === true)
    expect(frames.map((entry) => entry.rpc)).toEqual(['listen_subscribe', 'mutate'])
    expect(frames[0]).toMatchObject({rpcId: 'f1', wouldBlock: false, blocked: false, status: 101})
    expect(frames[1]).toMatchObject({rpcId: 'f2', wouldBlock: true, blocked: true, status: 1008})
  }, 15_000)
})
