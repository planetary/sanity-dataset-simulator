/**
 * WHAT HAPPENED TO THE BYTES — `disposition`, driven through the real writer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 *
 * Every proxy log record used to be exactly `{at, method, path, status, ms,
 * blocked}`, and the network audit (`e2e/audit/predicates.mjs` A3/A4) decided
 * "was this forwarded to Sanity?" by reading `record.blocked !== true`.
 *
 * `blocked: true` means ONE thing: the write guard refused it. A request refused
 * by any other gate records `blocked: false`, and the audit read that as
 * forwarded. The last E2E run therefore reported six ESCAPED writes —
 *
 *     POST /v2025-02-19/data/mutate/parity  → 415
 *     POST /v2025-02-19/data/actions/parity → 415
 *
 * — that never left the process at all. The 415 is `origin.mjs`'s
 * `assertWriteIsNotForged`, and Mode 2 serves the branch from local disk with no
 * upstream to dial. The audit cried wolf.
 *
 * The mirror image is why that is fatal rather than annoying: a REAL escape
 * answering anything other than 403 was modelled identically, in the direction
 * of a PASSING predicate. The audit is this project's primary evidence for its
 * central claim — *this system never writes to a real Sanity dataset* — and it
 * could neither prove nor disprove it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE DRIVES THE REAL PROXY AND NOT A FIXTURE
 *
 * `e2e/audit/predicates.test.mjs` proves the predicate reads the field
 * correctly. It cannot prove the field is WRITTEN correctly — it hand-builds its
 * records, so a proxy that recorded `local` for a request it relayed would sail
 * through it. So every test below starts `createProxyServer`, sends a real
 * request, and reads the JSONL BACK OFF DISK.
 *
 * BOTH DIRECTIONS, or the field is worthless:
 *
 *   1. refused locally must NOT be reported as forwarded  (§1)
 *   2. really forwarded MUST be reported as forwarded     (§2)
 *
 * §2's oracle is deliberately not the proxy: a fake upstream server records what
 * it actually received, and the assertion is on ITS list. Asserting that the
 * proxy's log agrees with the proxy's own belief would prove nothing.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'
// @ts-expect-error — the audit is plain ESM shared with `node --test`
import {auditProxyLog} from '../../../e2e/audit/predicates.mjs'
// @ts-expect-error — the audit is plain ESM shared with `node --test`
import {dispositionOf, readLog} from '../../../e2e/audit/logModel.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'
const MUTATE = `${V}/data/mutate/${DATASET}`
const SOCKET_PATH = '/v2022-06-30/socket/parity'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Well before any request in this file, so the freshness predicate is satisfied. */
const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString()

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-disposition-'))
let logSeq = 0
const teardowns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

interface LogRecord {
  method?: string
  path?: string
  status?: number
  blocked?: boolean
  disposition?: unknown
  gate?: unknown
  refusal?: unknown
  upstream?: unknown
  dialFailed?: unknown
  frame?: boolean
  rpc?: string
}

interface Proxy {
  port: number
  logPath: string
  /** The JSONL, read back OFF DISK — never from anything held in memory. */
  records: () => LogRecord[]
  requests: () => LogRecord[]
  frames: () => LogRecord[]
  audit: (options?: {expectNoUpstream?: boolean}) => Array<{id: string; pass: boolean; note: string}>
}

function verdict(results: Array<{id: string; pass: boolean; note: string}>, id: string) {
  const hit = results.find((result) => result.id === id)
  if (hit === undefined) throw new Error(`no predicate ${id} in the report`)
  return hit
}

async function startProxy(options: Record<string, unknown>): Promise<Proxy> {
  const logPath = path.join(SCRATCH, `proxy-${++logSeq}.jsonl`)
  const server = createProxyServer({env: {}, logPath, ...options})
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
  const records = (): LogRecord[] =>
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as LogRecord)
      : []
  return {
    port: (server.address() as net.AddressInfo).port,
    logPath,
    records,
    requests: () => records().filter((record) => record.frame !== true),
    frames: () => records().filter((record) => record.frame === true),
    audit: (auditOptions = {}) =>
      auditProxyLog({log: readLog(logPath), runStartedAt: RUN_STARTED_AT, ...auditOptions}),
  }
}

/** Poll until `check` is satisfied — the log is appended after the response. */
async function waitFor<T>(check: () => T | undefined, label: string, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The one request record for `path`, once the proxy has written it. */
function recordFor(proxy: Proxy, target: string, method = 'POST') {
  return waitFor(
    () => proxy.requests().find((record) => record.path === target && record.method === method),
    `a ${method} ${target} record in ${proxy.logPath}`,
  )
}

/* ------------------------------------------------------------------ *
 * Mode 2 — the origin, which has no upstream at all
 * ------------------------------------------------------------------ */

let originRoot = ''
let handler: {close: () => Promise<void>; dataset: string}

beforeAll(async () => {
  originRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-disposition-origin-'))
  handler = await createOriginHandler({
    root: originRoot,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'proxy-disposition-test',
  })
})

afterAll(async () => {
  await handler.close()
  fs.rmSync(SCRATCH, {recursive: true, force: true})
  fs.rmSync(originRoot, {recursive: true, force: true})
})

const startOrigin = () => startProxy({origin: true, originHandler: handler})

/* ------------------------------------------------------------------ *
 * a fake upstream that RECORDS what it received — the independent oracle
 * ------------------------------------------------------------------ */

interface FakeUpstream {
  origin: string
  hostPort: string
  /** Everything this server was really asked for. Nothing computes it but itself. */
  received: Array<{method: string; url: string; body: string}>
  upgrades: string[]
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const received: Array<{method: string; url: string; body: string}> = []
  const upgrades: string[] = []
  const upgraded = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: String(req.method),
        url: String(req.url),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const payload = JSON.stringify({transactionId: 'upstream-accepted-the-write'})
      res.writeHead(200, {'content-type': 'application/json', 'content-length': payload.length})
      res.end(payload)
    })
  })

  server.on('upgrade', (req, socket: net.Socket) => {
    upgrades.push(String(req.url))
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    socket.on('error', () => {})
    socket.setNoDelay(true)
    const accept = crypto
      .createHash('sha1')
      .update(String(req.headers['sec-websocket-key'] ?? '') + WS_GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const {port} = server.address() as net.AddressInfo
  teardowns.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  return {origin: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}`, received, upgrades}
}

/* ------------------------------------------------------------------ *
 * raw-socket helpers for the upgrade leg
 * ------------------------------------------------------------------ */

function handshake(port: number, target = SOCKET_PATH, method = 'GET'): net.Socket {
  const socket = net.connect({host: '127.0.0.1', port})
  socket.setNoDelay(true)
  socket.on('error', () => {})
  socket.once('connect', () => {
    socket.write(
      `${method} ${target} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    )
  })
  teardowns.push(() => {
    socket.destroy()
  })
  return socket
}

/** A masked client text frame — the only shape the frame guard parses. */
function clientFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const key = crypto.randomBytes(4)
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4]
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), key, masked])
}

/* ══════════════════════════════════════════════════════════════════ §1 ══ *
 * A request refused locally must NEVER be reported as forwarded.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('§1 a write refused by a Mode 2 gate never left the process', () => {
  it('the 415 CSRF refusal is recorded local, with the refusing gate’s own code', async () => {
    const proxy = await startOrigin()
    const response = await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'POST',
      /* CORS-safelisted, so `assertWriteIsNotForged` answers 415. */
      headers: {'content-type': 'text/plain'},
      body: JSON.stringify({mutations: [{createOrReplace: {_id: 'x', _type: 'article'}}]}),
    })
    expect(response.status).toBe(415)

    const record = await recordFor(proxy, MUTATE)
    expect(record.status).toBe(415)
    /* `blocked` keeps its narrow meaning: the WRITE GUARD did not refuse this. */
    expect(record.blocked).toBe(false)
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('origin')
    expect(record.refusal).toBe('OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE')
    expect(record.upstream).toBeUndefined()
  })

  it('and the audit PASSES A3/A4 on that log — the wolf cry is gone', async () => {
    const proxy = await startOrigin()
    await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'POST',
      headers: {'content-type': 'text/plain'},
      body: '{}',
    })
    await recordFor(proxy, MUTATE)

    const results = proxy.audit()
    expect(verdict(results, 'A3').pass, verdict(results, 'A3').note).toBe(true)
    expect(verdict(results, 'A4').pass, verdict(results, 'A4').note).toBe(true)
  })

  it('the same is true of `/data/actions`, the route Studio really writes through', async () => {
    const proxy = await startOrigin()
    const target = `${V}/data/actions/${DATASET}`
    const response = await fetch(`http://127.0.0.1:${proxy.port}${target}`, {
      method: 'POST',
      headers: {'content-type': 'text/plain'},
      body: '{}',
    })
    expect(response.status).toBe(415)

    const record = await recordFor(proxy, target)
    expect(record.disposition).toBe('local')
    expect(record.refusal).toBe('OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE')
    expect(verdict(proxy.audit(), 'A4').pass).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 ══ *
 * A request that really was forwarded must be reported as forwarded.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('§2 a write that really was relayed is recorded as relayed', () => {
  it('names the destination, and the FAKE UPSTREAM confirms it got the bytes', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: false})

    const response = await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({mutations: [{createOrReplace: {_id: 'escaped', _type: 'article'}}]}),
    })
    expect(response.status).toBe(200)

    /* THE INDEPENDENT ORACLE. Not the proxy's log, not the proxy's belief: the
     * server on the other end of the socket, saying what it was handed. */
    expect(upstream.received.map((entry) => `${entry.method} ${entry.url}`)).toContain(
      `POST ${MUTATE}`,
    )
    expect(upstream.received[0]?.body).toContain('escaped')

    const record = await recordFor(proxy, MUTATE)
    expect(record.disposition).toBe('upstream')
    /* "Forwarded" with no destination cannot tell a test double from
     * api.sanity.io, so the destination is part of the record. */
    expect(record.upstream).toBe(upstream.hostPort)
    expect(record.gate).toBeUndefined()
  })

  it('and the audit FAILS A3/A4 on that log, saying RELAYED and where to', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: false})
    await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"mutations":[]}',
    })
    await recordFor(proxy, MUTATE)

    const results = proxy.audit()
    for (const id of ['A3', 'A4']) {
      expect(verdict(results, id).pass, `${id} must catch a real escape`).toBe(false)
      expect(verdict(results, id).note).toMatch(/RELAYED/)
      expect(verdict(results, id).note).toContain(upstream.hostPort)
      expect(verdict(results, id).note).not.toMatch(/UNPROVEN/)
    }
  })

  it('an ATTEMPTED egress that failed to dial is still recorded upstream, and flagged', async () => {
    /* Conservative on purpose. A dial that ECONNREFUSED still put this request
     * on the network path; recording it as `local` would be the one direction
     * this field must never be wrong in. */
    const dead = await startFakeUpstream()
    const deadPort = Number(dead.hostPort.split(':')[1])
    for (const teardown of teardowns.splice(-1)) await teardown()

    const proxy = await startProxy({
      upstream: `http://127.0.0.1:${deadPort}`,
      blockWrites: false,
    })
    const response = await fetch(`http://127.0.0.1:${proxy.port}${V}/ping`)
    expect(response.status).toBe(502)

    const record = await recordFor(proxy, `${V}/ping`, 'GET')
    expect(record.disposition).toBe('upstream')
    expect(record.upstream).toBe(`127.0.0.1:${deadPort}`)
    expect(record.dialFailed).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 ══ *
 * Every other point at which the proxy DECIDES.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('§3 every decision point records its own answer', () => {
  it('an ordinary Mode 2 read that succeeds is local', async () => {
    const proxy = await startOrigin()
    const target = `${V}/users/me`
    const response = await fetch(`http://127.0.0.1:${proxy.port}${target}`)
    expect(response.status).toBe(200)

    const record = await recordFor(proxy, target, 'GET')
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('origin')
    expect(record.refusal).toBeUndefined()
  })

  it('a CORS preflight is local — the proxy answers it and Sanity never sees it', async () => {
    const proxy = await startOrigin()
    const response = await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'OPTIONS',
      headers: {origin: 'http://localhost:3333', 'access-control-request-method': 'POST'},
    })
    expect(response.status).toBe(204)

    const record = await recordFor(proxy, MUTATE, 'OPTIONS')
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('preflight')
  })

  it('a preflight is local in Mode 1 too, where an upstream exists but is not dialled', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'OPTIONS',
      headers: {origin: 'http://localhost:3333', 'access-control-request-method': 'POST'},
    })

    const record = await recordFor(proxy, MUTATE, 'OPTIONS')
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('preflight')
    expect(upstream.received).toEqual([])
  })

  it('a write-guard 403 is local, gated by the write guard, and says so', async () => {
    const proxy = await startOrigin()
    /* Not one of the two routes the overlay owns, so the guard's 403 stands. */
    const target = `${V}/assets/images/${DATASET}`
    const response = await fetch(`http://127.0.0.1:${proxy.port}${target}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    })
    expect(response.status).toBe(403)

    const record = await recordFor(proxy, target)
    expect(record.blocked).toBe(true)
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('write-guard')
    expect(record.refusal).toBe('OVERLAY_WRITE_BLOCKED')
  })

  it('the write guard 403 in MODE 1 is local as well — nothing was dialled', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    const response = await fetch(`http://127.0.0.1:${proxy.port}${MUTATE}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    })
    expect(response.status).toBe(403)
    expect(upstream.received, 'the guard must refuse BEFORE any socket exists').toEqual([])

    const record = await recordFor(proxy, MUTATE)
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('write-guard')
  })

  it('an origin handler that throws is local, with its own gate', async () => {
    const proxy = await startProxy({
      origin: true,
      originHandler: {
        dataset: DATASET,
        handle() {
          throw new Error('the overlay origin fell over')
        },
      },
    })
    const target = `${V}/ping`
    const response = await fetch(`http://127.0.0.1:${proxy.port}${target}`)
    expect(response.status).toBe(500)

    const record = await recordFor(proxy, target, 'GET')
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('origin-error')
  })
})

/* ══════════════════════════════════════════════════════════════════ §4 ══ *
 * The upgrade leg, which goes around the request handler entirely.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('§4 the upgrade leg records the same distinction', () => {
  it('a Mode 2 upgrade terminates here and is local', async () => {
    const proxy = await startOrigin()
    handshake(proxy.port)
    const record = await recordFor(proxy, SOCKET_PATH, 'GET')
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('origin-upgrade')
  })

  it('a write smuggled through the upgrade path is refused locally', async () => {
    /* `Connection: Upgrade` routes a POST to the `upgrade` handler, around the
     * request-path guard. The guard runs there too, and its refusal is local. */
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    handshake(proxy.port, MUTATE, 'POST')

    const record = await recordFor(proxy, MUTATE)
    expect(record.blocked).toBe(true)
    expect(record.disposition).toBe('local')
    expect(record.gate).toBe('write-guard')
    expect(upstream.upgrades).toEqual([])
  })

  it('a Mode 1 tunnel is upstream, and names the host it tunnelled to', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    handshake(proxy.port)

    const record = await recordFor(proxy, SOCKET_PATH, 'GET')
    expect(upstream.upgrades, 'the upstream must confirm it saw the upgrade').toContain(SOCKET_PATH)
    expect(record.status).toBe(101)
    expect(record.disposition).toBe('upstream')
    expect(record.upstream).toBe(upstream.hostPort)
  })

  it('a frame on a Mode 1 tunnel inherits the socket’s disposition', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    const socket = handshake(proxy.port)
    await recordFor(proxy, SOCKET_PATH, 'GET')

    socket.write(clientFrame(JSON.stringify({jsonrpc: '2.0', id: '1', method: 'query'})))
    const frame = await waitFor(
      () => proxy.frames().find((record) => record.rpc === 'query'),
      'a frame record',
    )
    expect(frame.disposition).toBe('upstream')
    expect(frame.upstream).toBe(upstream.hostPort)
  })
})

/* ══════════════════════════════════════════════════════════════════ §5 ══ *
 * The whole log, through the whole audit — including the structural control.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('§5 a complete Mode 2 session satisfies the audit’s new predicates', () => {
  it('A10/A11/A12 all pass over a real Mode 2 log', async () => {
    const proxy = await startOrigin()
    const base = `http://127.0.0.1:${proxy.port}`

    await fetch(`${base}${V}/users/me`)
    await fetch(`${base}${V}/data/query/${DATASET}?query=${encodeURIComponent('*[_id=="none"]')}`)
    await fetch(`${base}${MUTATE}`, {
      method: 'OPTIONS',
      headers: {origin: 'http://localhost:3333', 'access-control-request-method': 'POST'},
    })
    await fetch(`${base}${V}/assets/images/${DATASET}`, {method: 'POST', body: '{}'})
    await fetch(`${base}${MUTATE}`, {
      method: 'POST',
      headers: {'content-type': 'text/plain'},
      body: '{}',
    })
    await waitFor(
      () => (proxy.requests().length >= 5 ? true : undefined),
      'five request records',
    )

    const results = proxy.audit({expectNoUpstream: true})
    for (const id of ['A3', 'A4', 'A10', 'A11', 'A12']) {
      expect(verdict(results, id).pass, `${id}: ${verdict(results, id).note}`).toBe(true)
    }
    expect(proxy.records().every((record) => dispositionOf(record) === 'local')).toBe(true)
  })

  it('A12 goes red the moment a run that claimed no upstream produced one', async () => {
    const upstream = await startFakeUpstream()
    const proxy = await startProxy({upstream: upstream.origin, blockWrites: true})
    /* A READ. Not a write — A3/A4 are untroubled, and A12 still fails, which is
     * the whole reason it exists as a separate predicate. */
    await fetch(`http://127.0.0.1:${proxy.port}${V}/users/me`)
    await recordFor(proxy, `${V}/users/me`, 'GET')

    const results = proxy.audit({expectNoUpstream: true})
    expect(verdict(results, 'A3').pass).toBe(true)
    expect(verdict(results, 'A12').pass).toBe(false)
    expect(verdict(results, 'A12').note).toContain(upstream.hostPort)
  })
})
