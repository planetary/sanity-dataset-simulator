/**
 * The TLS upstream leg of the proxy's `upgrade` path (evidence review F5a).
 *
 * `test/proxy-ws.test.ts` is 35 tests of the upgrade handler, and every one of
 * them runs against a `node:net` mock upstream over plain HTTP. The branch that
 * actually executes in production — `tls.connect(...)` when the upstream origin
 * is `https:`, which it always is against `<project>.api.sanity.io` — had zero
 * coverage. So did the `secureConnect`-instead-of-`connect` event name that
 * goes with it, and the `ALPNProtocols: ['http/1.1']` pin whose entire job is
 * to stop ALPN negotiating h2 (an upgrade does not exist in HTTP/2).
 *
 * WHAT THIS FILE PROVES, AND HOW
 * ------------------------------
 * A self-signed X.509 certificate is built here at test time from `node:crypto`
 * primitives (`generateKeyPairSync` + a hand-rolled DER encoder + `crypto.sign`)
 * — no dependency, no fixture, no `openssl` in a shell. A real `tls.createServer`
 * then stands in for Sanity, and the proxy dials it three ways:
 *
 *   1. `upstreamDialSpec()` — the pure decision function, asserted directly:
 *      tls vs net, host, port, SNI servername, ALPN, and the fact that nothing
 *      switches certificate verification off.
 *   2. the REAL `tls.connect` with no injection at all, against a certificate
 *      no root store trusts. The proxy must answer 502 with a certificate
 *      error. That failure is only reachable through TLS, so it is the proof
 *      that the tls branch — not the net branch — ran; and it is the proof that
 *      the proxy verifies, because a `rejectUnauthorized: false` would 101.
 *   3. an injected dial that adds only `ca` to the spec the proxy produced, so
 *      the certificate verifies and the whole upgrade completes over genuine
 *      TLS: handshake, ALPN, request head, server frame, teardown.
 *
 * WHAT THIS FILE DOES *NOT* PROVE — SEE `proxy-tls-live.test.ts`
 * -------------------------------------------------------------
 * Three things below are asserted against the OBJECT `upstreamDialSpec()`
 * returns, never against a socket, and the descriptions above must not be read
 * as claiming otherwise:
 *
 *   - `dialFromSpec` — the production default `dialUpstream` — is never
 *     observed SUCCEEDING. Route 2 reaches only `tls.connect`'s failure path;
 *     route 3 injects a dial and so does not run `dialFromSpec` at all.
 *   - "SNI carries the hostname `resolveUpstreamHostname` DERIVED" is read off
 *     `spec.options.servername` in route 1. The live read in route 3 observes
 *     `localhost`, which is the configured upstream host — no derivation
 *     happens in that test, so it cannot be evidence that derivation reaches
 *     SNI.
 *   - `connectEvent: 'secureConnect'` is a string compared to a string. Both
 *     events fire on a real TLSSocket, and a pre-handshake write is buffered by
 *     the TLS layer rather than lost, so the distinction is invisible to every
 *     functional assertion here.
 *
 * `proxy-tls-live.test.ts` closes all three against live sockets, with no
 * `dialUpstream` injection anywhere.
 *
 * WHAT REMAINS UNPROVEN IN BOTH FILES
 * -----------------------------------
 * That `tls.connect` succeeds against the real `<project>.api.sanity.io:443`
 * with the public root store and Sanity's own ALPN behaviour. Only a live run
 * shows that, and no test in this repository can substitute for it.
 */
import {afterEach, describe, expect, it} from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer, upstreamDialSpec} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'

/* ------------------------------------------------------------------ *
 * a minimal DER encoder — just enough for one self-signed certificate
 * ------------------------------------------------------------------ */

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
  // DER integers are signed: a leading byte >= 0x80 needs a zero pad.
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
  // Chunked by slicing, NOT by `.replace(/(.{64})/g, '$1\n')`: that form emits a
  // trailing newline when the base64 length is an exact multiple of 64, and the
  // template then adds a second one. The resulting blank line makes OpenSSL's
  // PEM reader stop early and the certificate fails to parse with an ASN.1
  // "wrong tag". ECDSA signatures are 70-72 bytes depending on the random `r`
  // and `s`, so the total length — and therefore the bug — varies run to run.
  const base64 = der.toString('base64')
  const lines: string[] = []
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64))
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

interface SelfSignedCert {
  keyPem: string
  certPem: string
}

/**
 * A self-signed P-256 certificate for `localhost`, valid for an hour, with
 * `basicConstraints: CA:TRUE` so it can also serve as its own trust anchor when
 * a test chooses to trust it.
 */
function selfSignedLocalhostCert(): SelfSignedCert {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'})
  const spki = publicKey.export({format: 'der', type: 'spki'}) as Buffer

  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'))
  const commonName = seq(set(seq(oid('2.5.4.3'), utf8('localhost'))))

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
    octets(
      seq(
        implicitPrimitive(2, Buffer.from('localhost', 'latin1')), // dNSName
        implicitPrimitive(7, Buffer.from([127, 0, 0, 1])), // iPAddress
      ),
    ),
  )

  // Serial: random, but with the top byte forced into 0x01-0x7f so the DER
  // INTEGER is both positive and minimally encoded without a pad byte.
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
    keyPem: privateKey.export({format: 'pem', type: 'pkcs8'}) as string,
    certPem: pem('CERTIFICATE', certificate),
  }
}

/* ------------------------------------------------------------------ *
 * a TLS upstream that speaks the RFC 6455 handshake
 * ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsAccept(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

interface TlsUpgradeRecord {
  requestLine: string
  headers: Record<string, string>
  /** The SNI name the client actually sent, or undefined when it sent none. */
  servername: string | undefined
  alpnProtocol: string | false
}

interface TlsUpstream {
  origin: string
  certPem: string
  upgrades: TlsUpgradeRecord[]
  close(): Promise<void>
}

/**
 * Deliberately raw: it parses the request head itself and answers 101, because
 * the point is to observe what the proxy's `tls.connect` put on the wire —
 * SNI, ALPN and the verbatim request line — not to be a correct HTTP server.
 */
function startTlsUpstream(cert: SelfSignedCert): Promise<TlsUpstream> {
  const upgrades: TlsUpgradeRecord[] = []
  const server = tls.createServer(
    {
      key: cert.keyPem,
      cert: cert.certPem,
      // Offers h2 FIRST. The proxy pins ALPNProtocols: ['http/1.1'], so a
      // negotiated 'http/1.1' proves the pin held; drop the pin and the client
      // offers nothing and negotiates nothing.
      ALPNProtocols: ['h2', 'http/1.1'],
    },
    (socket) => {
      socket.setNoDelay(true)
      socket.on('error', () => {
        /* teardown races are expected */
      })
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.off('data', onData)
        const lines = buffered.subarray(0, end).toString('latin1').split('\r\n')
        const headers: Record<string, string> = {}
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        upgrades.push({
          requestLine: lines[0],
          headers,
          servername: (socket as tls.TLSSocket & {servername?: string}).servername || undefined,
          alpnProtocol: socket.alpnProtocol as string | false,
        })
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${wsAccept(headers['sec-websocket-key'] || '')}`,
            '',
            '',
          ].join('\r\n'),
        )
        // A server text frame, unmasked (RFC 6455 §5.1): the `welcome` push.
        const payload = Buffer.from('welcome-over-tls', 'utf8')
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
      }
      socket.on('data', onData)
    },
  )

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      resolve({
        // `localhost`, not `127.0.0.1`: SNI is not sent for IP literals, and SNI
        // is one of the things this file exists to observe.
        origin: `https://localhost:${address.port}`,
        certPem: cert.certPem,
        upgrades,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tls-'))
let logSeq = 0
const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

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

async function useTlsUpstream(cert: SelfSignedCert) {
  const upstream = await startTlsUpstream(cert)
  teardowns.push(() => upstream.close())
  return upstream
}

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

interface Attempt {
  socket: net.Socket
  status: number
  headers: Record<string, string>
  rest: Buffer
  body: string
}

/** Put one upgrade request head on the proxy and read the whole HTTP response. */
function upgradeThroughProxy(port: number, requestPath: string, key: string): Promise<Attempt> {
  return withTimeout(
    new Promise<Attempt>((resolve, reject) => {
      const socket = net.connect({host: '127.0.0.1', port})
      socket.setNoDelay(true)
      socket.on('error', reject)
      socket.once('connect', () => {
        socket.write(
          [
            `GET ${requestPath} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
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
      socket.on('data', (chunk: Buffer) => {
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
        socket.removeAllListeners('data')
        resolve({socket, status: Number(match[1]), headers, rest, body: rest.toString('utf8')})
      })
    }),
    5000,
    'an HTTP response from the proxy upgrade path',
  )
}

const SOCKET_PATH = '/v2022-06-30/socket/parity'
const CERT = selfSignedLocalhostCert()

/* ------------------------------------------------------------------ *
 * 0. the test's own instrument
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · the self-signed certificate this file builds', () => {
  /**
   * Non-vacuity for the harness itself. Everything below depends on a real
   * TLS handshake happening; a certificate that silently failed to parse would
   * turn "the proxy answered 502" from a proof of the tls branch into an
   * artifact of broken test infrastructure. This assertion is what tells the
   * two apart, and it is what caught the `pem()` line-wrapping bug.
   */
  it('is a certificate Node can actually parse, with the SANs the tests rely on', () => {
    const parsed = new crypto.X509Certificate(CERT.certPem)
    expect(parsed.subject).toContain('CN=localhost')
    expect(parsed.subjectAltName).toContain('DNS:localhost')
    expect(parsed.subjectAltName).toContain('127.0.0.1')
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(Date.now())
    // And it is genuinely untrusted, which is what test 2 below turns into
    // proof that the proxy verifies.
    expect(tls.rootCertificates).not.toContain(CERT.certPem)
  })
})

/* ------------------------------------------------------------------ *
 * 1. the dial decision, on its own
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · upstreamDialSpec (the branch production takes)', () => {
  it('dials TLS for an https upstream, with SNI, the port and the ALPN pin', () => {
    const spec = upstreamDialSpec({tls: true, hostname: 'b1n03q3z.api.sanity.io', port: 443})
    expect(spec.transport).toBe('tls')
    expect(spec.connectEvent).toBe('secureConnect')
    expect(spec.options.host).toBe('b1n03q3z.api.sanity.io')
    expect(spec.options.port).toBe(443)
    // SNI must carry the DERIVED hostname, not the configured upstream: the
    // proxy rewrites `<project>.localhost` onto `<project>.api.sanity.io`, and
    // a stale servername means the TLS handshake asks for the wrong certificate.
    expect(spec.options.servername).toBe('b1n03q3z.api.sanity.io')
    // An upgrade does not exist in HTTP/2 (RFC 9113 §8.1 removed it), so ALPN
    // must never be allowed to negotiate h2.
    expect(spec.options.ALPNProtocols).toEqual(['http/1.1'])
  })

  it('never switches certificate verification off', () => {
    const spec = upstreamDialSpec({tls: true, hostname: 'b1n03q3z.api.sanity.io', port: 443})
    // Absent means Node's default, which is `true`. Explicit `false` here would
    // make the proxy accept any certificate for the API host — a proxy that
    // holds the user's token must not.
    expect(spec.options.rejectUnauthorized).not.toBe(false)
    expect(spec.options.checkServerIdentity).toBeUndefined()
  })

  it('dials plain TCP for an http upstream, and asks for no TLS options at all', () => {
    const spec = upstreamDialSpec({tls: false, hostname: '127.0.0.1', port: 8080})
    expect(spec.transport).toBe('net')
    expect(spec.connectEvent).toBe('connect')
    expect(spec.options).toEqual({host: '127.0.0.1', port: 8080})
  })
})

/* ------------------------------------------------------------------ *
 * 2. the real tls.connect, unmodified
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · the production TLS dial, with nothing injected', () => {
  it('refuses an upstream certificate no root store trusts, and says so', async () => {
    const upstream = await useTlsUpstream(CERT)
    const proxy = await startProxy(upstream.origin)

    const attempt = await upgradeThroughProxy(proxy.port, SOCKET_PATH, 'dGhlIHNhbXBsZSBub25jZQ==')

    // 502, not 101: the proxy dialled with `tls.connect` and Node rejected the
    // certificate. A `net.connect` would never produce a certificate error, and
    // a `rejectUnauthorized: false` would have produced a 101 — so this single
    // assertion pins BOTH the branch and the verification.
    expect(attempt.status).toBe(502)
    const parsed = JSON.parse(attempt.body)
    expect(parsed.error.code).toBe('OVERLAY_PROXY_UPSTREAM')
    expect(parsed.error.message.toLowerCase()).toMatch(/self[- ]signed|certificate/)
    expect(upstream.upgrades).toEqual([])

    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      path: SOCKET_PATH,
      status: 502,
    })
  })
})

/* ------------------------------------------------------------------ *
 * 3. the whole upgrade, over genuine TLS
 * ------------------------------------------------------------------ */

describe('spikeB-proxy · a complete upgrade over genuine TLS', () => {
  /**
   * The ONLY thing injected is the trust anchor. Everything else — transport
   * choice, host, port, SNI, ALPN, the `secureConnect` event, the request head,
   * the byte pipe — is whatever `createProxyServer` decided, and is asserted on
   * the upstream side.
   */
  function trustingDial(spec: {transport: string; options: Record<string, unknown>}) {
    if (spec.transport !== 'tls') throw new Error(`expected a tls dial, got ${spec.transport}`)
    return tls.connect({...spec.options, ca: [CERT.certPem]} as tls.ConnectionOptions)
  }

  it('completes the handshake and relays the first frame', async () => {
    const upstream = await useTlsUpstream(CERT)
    const proxy = await startProxy(upstream.origin, {dialUpstream: trustingDial})

    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    const attempt = await upgradeThroughProxy(proxy.port, `${SOCKET_PATH}?query=*`, key)

    expect(attempt.status).toBe(101)
    expect(attempt.headers['sec-websocket-accept']).toBe(wsAccept(key))

    // The upstream saw a real TLS connection carrying the verbatim request line.
    expect(upstream.upgrades).toHaveLength(1)
    const [seen] = upstream.upgrades
    expect(seen.requestLine).toBe(`GET ${SOCKET_PATH}?query=* HTTP/1.1`)
    expect(seen.headers['sec-websocket-key']).toBe(key)
    expect(seen.headers.upgrade?.toLowerCase()).toBe('websocket')
    expect(seen.headers.connection?.toLowerCase()).toBe('upgrade')

    // SNI: sent, and equal to the CONFIGURED upstream hostname. This is not the
    // derived-hostname case — `resolveUpstreamHostname` returns the base host
    // unchanged here, because the request's `Host` is `127.0.0.1:<port>` and the
    // configured upstream (`localhost`) has only one label. The claim that SNI
    // carries a DERIVED name is proven in `proxy-tls-live.test.ts` (CLAIM 2),
    // where the upstream presents a certificate that only validates when SNI
    // names the derived host.
    expect(seen.servername).toBe('localhost')
    // ALPN: the upstream offered h2 first and got http/1.1 anyway, because the
    // proxy offered nothing else. Remove the pin and this becomes `false`.
    expect(seen.alpnProtocol).toBe('http/1.1')

    // And the bytes past the 101 flow: the unsolicited server frame arrived.
    const frame = await withTimeout(
      new Promise<Buffer>((resolve) => {
        if (attempt.rest.length > 0) {
          resolve(attempt.rest)
          return
        }
        attempt.socket.once('data', (chunk: Buffer) => resolve(chunk))
      }),
      2000,
      'the welcome frame over TLS',
    )
    expect(frame.subarray(2).toString('utf8')).toBe('welcome-over-tls')

    expect(proxy.readLog().find((entry) => entry.upgrade === true)).toMatchObject({
      path: SOCKET_PATH,
      status: 101,
      blocked: false,
    })
  })

  it('applies the write guard before the TLS socket is ever dialled', async () => {
    const upstream = await useTlsUpstream(CERT)
    let dialled = 0
    const proxy = await startProxy(upstream.origin, {
      blockWrites: true,
      dialUpstream: (spec: {transport: string; options: Record<string, unknown>}) => {
        dialled += 1
        return trustingDial(spec)
      },
    })

    const attempt = await upgradeThroughProxy(
      proxy.port,
      '/v2025-02-19/data/actions/parity',
      'dGhlIHNhbXBsZSBub25jZQ==',
    )

    expect(attempt.status).toBe(403)
    expect(JSON.parse(attempt.body).error.code).toBe('OVERLAY_WRITE_BLOCKED')
    // No TLS session is opened at all — the token never leaves the machine.
    expect(dialled).toBe(0)
    expect(upstream.upgrades).toEqual([])
  })
})
