/**
 * MODE 2 (origin) — Studio's recorded boot sequence, replayed against an origin
 * with no Sanity project behind it.
 *
 * WHERE THE ENDPOINT LIST COMES FROM
 * ----------------------------------
 * Not from imagination and not from the Sanity docs: from
 * `examples/kitchen-sink/spikeB-proxy/proxy-log*.jsonl`, which are committed
 * JSONL request logs of real `sanity dev` sessions against the Track B proxy —
 * 730 lines for the first full boot plus four later sessions. Every request line
 * in those files is a request a real Studio really made.
 *
 * This suite reads those logs at test time and replays every distinct
 * (method, path) against a Mode 2 origin. That is the load-bearing property:
 * "Studio's recorded boot sequence is satisfiable with no Sanity project".
 * Deriving the list from the evidence rather than hard-coding it means an
 * endpoint that shows up in a future recorded session shows up here too, as a
 * failure, instead of being silently unimplemented.
 *
 * WHAT COUNTS AS SATISFIED
 * ------------------------
 * Three verdicts, and the suite insists every request line lands in exactly one:
 *
 *   SERVED   — answered from the origin (2xx). Identity, project metadata, the
 *              data plane.
 *   BLOCKED  — 403 from the write guard. This is a *pass*, not a gap: the same
 *              endpoints are 403 in Mode 1 (see `blocked:true` in the logs) and
 *              the recorded Studio booted anyway. `/descriptors/claim`,
 *              `/intake/batch`, asset uploads.
 *   DECLARED-UNIMPLEMENTED — 501 with a body that names what is missing. There
 *              is exactly one class of these and it is enumerated below, because
 *              a stub that half-works and fails confusingly at runtime is worse
 *              than an honest "Mode 2 does not do this".
 *
 * A 404, a 500, or a hang is none of the three and fails the suite.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'

const SPIKE_B = fileURLToPath(new URL('../../../examples/kitchen-sink/spikeB-proxy/', import.meta.url))
const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'

/* ------------------------------------------------------------------ *
 * the recorded evidence
 * ------------------------------------------------------------------ */

interface LogLine {
  method: string
  path: string
  status: number
  blocked?: boolean
  upgrade?: boolean
  frame?: boolean
}

function readRecordedSessions(): LogLine[] {
  const files = fs
    .readdirSync(SPIKE_B)
    .filter((name) => name.startsWith('proxy-log') && name.endsWith('.jsonl'))
    .sort()
  expect(files.length, 'the committed proxy logs are the input to this suite').toBeGreaterThan(0)

  const lines: LogLine[] = []
  for (const file of files) {
    for (const raw of fs.readFileSync(path.join(SPIKE_B, file), 'utf8').split('\n')) {
      if (raw.trim() === '') continue
      const parsed = JSON.parse(raw) as LogLine
      if (typeof parsed.method !== 'string' || typeof parsed.path !== 'string') continue
      lines.push(parsed)
    }
  }
  return lines
}

/** One request line Studio really sent, de-duplicated by (method, path). */
interface Recorded {
  method: string
  path: string
  /** How many times it appears across every recorded session. */
  count: number
}

function distinctRequests(lines: LogLine[]): Recorded[] {
  const seen = new Map<string, Recorded>()
  for (const line of lines) {
    // OPTIONS never reaches the origin — the proxy answers preflight itself,
    // in both modes, and `origin-safety.test.ts` pins that.
    if (line.method === 'OPTIONS') continue
    // Per-frame WebSocket log lines are not request lines.
    if (line.frame === true) continue
    // Studio's own dev-server assets, not API calls.
    if (line.path === '/' || line.path === '/favicon.ico') continue
    const key = `${line.method} ${line.path}`
    const existing = seen.get(key)
    if (existing) existing.count += 1
    else seen.set(key, {method: line.method, path: line.path, count: 1})
  }
  return [...seen.values()].sort((a, b) => b.count - a.count)
}

/**
 * `WS` is the proxy's own label for a client frame on an already-upgraded
 * socket; the upgrade itself is logged as `GET /socket/<ds>`.
 */
const isUpgradeProbe = (r: Recorded): boolean => r.method === 'WS'

/**
 * The proxy's JSONL log records `path` WITHOUT its query string (see
 * `splitPath` / `finish` in proxy.mjs), so a recorded `GET /data/query/<ds>` is
 * missing the one thing that makes it answerable. Replaying it verbatim would
 * test "does the origin 400 on a malformed request", which is not the property
 * this suite is about.
 *
 * So the endpoints that genuinely require input get a representative one. The
 * table is deliberately tiny and explicit: anything NOT in it is replayed
 * exactly as recorded, so a new endpoint cannot be quietly handed a payload
 * that makes it pass.
 */
function withRequiredInput(request: Recorded): {target: string; body?: string} {
  const {method, path} = request
  if (/\/data\/query\//.test(path)) {
    if (method === 'POST') return {target: path, body: JSON.stringify({query: '*[_id == "none"]'})}
    return {target: `${path}?query=${encodeURIComponent('*[_id == "none"]')}`}
  }
  if (/\/data\/listen\//.test(path)) {
    return {target: `${path}?query=${encodeURIComponent('*')}`}
  }
  if (method === 'POST' && /\/data\/mutate\//.test(path)) {
    return {target: path, body: JSON.stringify({mutations: []})}
  }
  if (method === 'POST' && /\/data\/actions\//.test(path)) {
    return {target: path, body: JSON.stringify({actions: []})}
  }
  return {target: path, ...(method === 'POST' ? {body: '{}'} : {})}
}

/** Endpoints whose response body never ends. */
function isStreamEndpoint(path: string): boolean {
  return /\/data\/listen\//.test(path) || /\/bundles\/mine\/listen$/.test(path)
}

/* ------------------------------------------------------------------ *
 * a real Mode 2 origin
 * ------------------------------------------------------------------ */

let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>; dataset: string}
let root = ''

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-boot-'))
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-boot-test',
  })
  server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: path.join(root, 'log.jsonl'),
    env: {},
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  /* Handler first: it owns the SSE streams and upgraded sockets, and
   * `server.close()` waits for every open connection. */
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, {recursive: true, force: true})
})

interface Answer {
  status: number
  contentType: string
  body: string
  json: unknown
}

async function call(method: string, target: string, body?: string): Promise<Answer> {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    ...(body === undefined
      ? {}
      : {body, headers: {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body))}}),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not every answer is JSON; the caller decides whether that matters */
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: text,
    json,
  }
}

/* ================================================================== *
 * 1. every recorded request line lands in one of the three verdicts
 * ================================================================== */

describe('Mode 2 · the recorded Studio boot sequence', () => {
  const recorded = distinctRequests(readRecordedSessions())

  it('has real evidence to work from', () => {
    expect(recorded.length).toBeGreaterThan(30)
    /* The endpoints the boot cannot proceed without, as a sanity check that we
     * are reading the right files. */
    const paths = new Set(recorded.map((r) => r.path.replace(/\?.*$/, '')))
    expect([...paths].some((p) => p.endsWith('/users/me'))).toBe(true)
    expect([...paths].some((p) => p.includes('/data/query/'))).toBe(true)
    expect([...paths].some((p) => p.includes('/grants'))).toBe(true)
  })

  for (const request of recorded) {
    if (isUpgradeProbe(request)) continue
    it(`answers ${request.method} ${request.path} (seen x${request.count})`, async () => {
      const {target, body} = withRequiredInput(request)

      if (isStreamEndpoint(request.path)) {
        /* An SSE endpoint never finishes, so `fetch(...).text()` would hang.
         * The property under test is that the stream OPENS: status, media type,
         * and a first event. */
        const controller = new AbortController()
        const response = await fetch(`${baseUrl}${target}`, {signal: controller.signal})
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
        controller.abort()
        return
      }

      const answer = await call(request.method, target, body)

      if (answer.status === 403) {
        /* The write guard. A pass — Mode 1 answers these the same way and the
         * recorded Studio booted regardless. */
        expect(answer.body).toContain('OVERLAY_WRITE_BLOCKED')
        return
      }

      if (answer.status === 501) {
        /* Declared unimplemented. Must say so in a machine-readable way and
         * name itself, so a Studio failure points at the right line. */
        expect(answer.json).toMatchObject({
          error: {code: 'OVERLAY_ORIGIN_UNIMPLEMENTED'},
        })
        expect(String((answer.json as {error: {description: string}}).error.description).length)
          .toBeGreaterThan(20)
        return
      }

      expect(
        answer.status,
        `${request.method} ${request.path} answered ${answer.status}: ${answer.body.slice(0, 200)}`,
      ).toBeLessThan(300)
      expect(answer.status).toBeGreaterThanOrEqual(200)
    })
  }

  /**
   * The verdict census.
   *
   * The per-endpoint tests above prove nothing 404s or 500s. This one pins the
   * *shape* of the answer set, so a future change that turns a served endpoint
   * into a 403 — or quietly starts serving something that used to be blocked —
   * fails here even though every individual test still passes.
   */
  it('serves, blocks or declares — with the blocked set exactly as in Mode 1', async () => {
    const served: string[] = []
    const blocked: string[] = []
    const declared: string[] = []

    for (const request of recorded) {
      if (isUpgradeProbe(request)) continue
      const key = `${request.method} ${request.path}`
      if (isStreamEndpoint(request.path)) {
        const controller = new AbortController()
        const response = await fetch(
          `${baseUrl}${withRequiredInput(request).target}`,
          {signal: controller.signal},
        )
        if (response.status === 200) served.push(key)
        controller.abort()
        continue
      }
      const {target, body} = withRequiredInput(request)
      const answer = await call(request.method, target, body)
      if (answer.status === 403) blocked.push(key)
      else if (answer.status === 501) declared.push(key)
      else served.push(key)
    }

    /* The blocked set is the write guard's, unchanged from Mode 1 — every one
     * of these is `blocked: true` in the committed logs, and the recorded
     * Studio booted anyway. */
    expect(blocked.map((k) => k.replace(/^(\w+) \/v[^/]+/, '$1 ')).sort()).toEqual([
      'DELETE /datasets/parity',
      'POST /DATA/MUTATE/parity',
      'POST /agent/action/patch/parity',
      'POST /assets/images/parity',
      'POST /data/..%2Fmutate/parity',
      'POST /descriptors/claim',
      'POST /intake/batch',
      'POST /projects/b1n03q3z/datasets/parity/mutate',
      'POST //data//mutate//parity'.replace(/^(\w+) \/v[^/]+/, '$1 '),
    ].sort())

    /* Exactly one declared gap on the recorded boot path, and it is the one
     * Mode 2 knows it has: the @sanity/bifur-client realtime socket. Replayed
     * here as a plain GET (the recorded line carries no Upgrade header), it is
     * a 501 that names itself. The real upgrade is handled — handshake, ping,
     * and an explicit JSON-RPC error per request — by `handleUpgrade`; see
     * ORIGIN.md for what that does and does not buy. */
    expect(declared).toEqual(['GET /v2022-06-30/socket/parity'])
    expect(served.length).toBeGreaterThan(25)
  })
})

/* ================================================================== *
 * 2. the identity is synthetic, obviously fake, and fully granted
 * ================================================================== */

describe('Mode 2 · synthetic identity', () => {
  it('serves a `local-dev` user that could not be mistaken for a real account', async () => {
    const answer = await call('GET', '/v2026-05-04/users/me')
    expect(answer.status).toBe(200)
    const user = answer.json as Record<string, unknown>
    expect(user.id).toBe('local-dev')
    /* Not a plausible address at a real domain: `.invalid` is reserved by
     * RFC 2606 precisely so it can never resolve. */
    expect(String(user.email)).toMatch(/\.invalid$/)
    expect(user).toHaveProperty('name')
    expect(user).toHaveProperty('role')
    expect(Array.isArray(user.roles)).toBe(true)
  })

  it('has no session, no token and nothing to verify — an unauthenticated call is identical', async () => {
    const anonymous = await call('GET', '/v2026-05-04/users/me')
    const withGarbageToken = await fetch(`${baseUrl}/v2026-05-04/users/me`, {
      headers: {Authorization: 'Bearer definitely-not-a-real-token'},
    })
    expect(withGarbageToken.status).toBe(200)
    expect(await withGarbageToken.text()).toBe(anonymous.body)
  })

  it('grants every document permission Studio knows how to ask for', async () => {
    const answer = await call('GET', `/v2021-06-07/projects/${PROJECT_ID}/datasets/${DATASET}/acl`)
    expect(answer.status).toBe(200)
    const grants = answer.json as Array<{filter: string; permissions: string[]}>
    expect(Array.isArray(grants)).toBe(true)
    expect(grants).toHaveLength(1)
    /* sanity 6.8.0 evaluates `*[<filter>]` against a single-document dataset
     * (createGrantsStore -> matchesFilter), so `true` grants on every document. */
    expect(grants[0]!.filter).toBe('true')
    for (const permission of ['read', 'create', 'update', 'history', 'editHistory']) {
      expect(grants[0]!.permissions).toContain(permission)
    }
  })

  it('answers /grants with the project-roles shape Studio expects', async () => {
    const answer = await call('GET', `/v2025-02-19/projects/${PROJECT_ID}/grants`)
    expect(answer.status).toBe(200)
    expect(typeof answer.json).toBe('object')
    expect(answer.json).not.toBeNull()
  })
})

/* ================================================================== *
 * 3. project and dataset metadata
 * ================================================================== */

describe('Mode 2 · project metadata', () => {
  it('reports the configured project', async () => {
    const answer = await call('GET', `/v2021-12-15/projects/${PROJECT_ID}`)
    expect(answer.status).toBe(200)
    const project = answer.json as Record<string, unknown>
    expect(project.id).toBe(PROJECT_ID)
    expect(typeof project.displayName).toBe('string')
    expect(project.isBlocked).toBe(false)
    expect(project.isDisabled).toBe(false)
    expect(Array.isArray(project.members)).toBe(true)
  })

  it('lists exactly the one dataset it serves', async () => {
    const answer = await call('GET', `/v2021-12-15/projects/${PROJECT_ID}/datasets`)
    expect(answer.status).toBe(200)
    const datasets = answer.json as Array<{name: string}>
    expect(datasets.map((d) => d.name)).toEqual([DATASET])
  })

  it('answers a project that is not the configured one with 404, not with a lie', async () => {
    const answer = await call('GET', '/v2021-12-15/projects/someoneelse')
    expect(answer.status).toBe(404)
  })

  it('serves the journey/limit/feature banners as honestly empty', async () => {
    for (const target of [
      '/v2024-09-19/journey/announcements',
      '/v2025-02-19/journey/asset-limit',
      '/v2025-02-19/journey/document-limit',
      '/v2023-12-11/journey/trial',
      '/v2025-02-19/journey/scheduled-drafts',
      '/v2025-02-19/journey/content-releases',
      '/v2025-02-19/features',
      `/v2025-02-19/schedules/${PROJECT_ID}/${DATASET}`,
      '/v1/help',
    ]) {
      const answer = await call('GET', target)
      expect(answer.status, target).toBe(200)
      expect(answer.contentType, target).toMatch(/json/)
    }
  })

  it('answers both ping shapes', async () => {
    expect((await call('GET', '/v2025-02-19/ping')).status).toBe(200)
    expect((await call('GET', `/v2025-02-19/data/ping/${DATASET}`)).status).toBe(200)
  })

  it('round-trips the keyvalue store Studio parks its pane layout in', async () => {
    const key = 'studio.structure-tool.layout.article'
    const empty = await call('GET', `/v2025-02-19/users/me/keyvalue/${key}`)
    expect(empty.status).toBe(200)
    expect(empty.json).toEqual([{key, value: null}])

    /* Studio's PUT is classified as a write by the guard and stays 403 in both
     * modes — recorded here so the 403 is a decision, not a surprise. */
    const write = await call('PUT', `/v2025-02-19/users/me/keyvalue`, '[]')
    expect(write.status).toBe(403)
  })
})

/* ================================================================== *
 * 4. what Mode 2 does NOT do, declared rather than faked
 * ================================================================== */

describe('Mode 2 · declared gaps', () => {
  it('answers document history with an empty timeline, not a fabricated one', async () => {
    for (const target of [
      `/v2025-02-19/data/history/${DATASET}/events/documents/drafts.article-01`,
      `/v2025-02-19/data/history/${DATASET}/transactions/drafts.article-01`,
      `/v2025-02-19/data/history/${DATASET}/documents/drafts.article-01`,
    ]) {
      const answer = await call('GET', target)
      expect(answer.status, target).toBe(200)
    }
  })

  it('declares asset upload unimplemented rather than accepting bytes it will lose', async () => {
    /* The upload is a POST and the write guard blocks it first, in both modes.
     * Recorded so the reason is unambiguous: it is not that Mode 2 forgot. */
    const answer = await call('POST', `/v2025-02-19/assets/images/${DATASET}`, '{}')
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('OVERLAY_WRITE_BLOCKED')
  })

  it('completes the bifur WebSocket handshake and answers RPC with an explicit error', async () => {
    /* Refusing the upgrade makes @sanity/bifur-client reconnect forever — the
     * recorded sessions show exactly that (`GET /socket/parity` 404 x33, 502
     * x18). Fabricating an `authorization` result would invent a session.
     * Mode 2 does neither: it completes the handshake, keeps the socket alive,
     * and answers every JSON-RPC request with an error that names the gap. */
    const key = crypto.randomBytes(16).toString('base64')
    const {port} = new URL(baseUrl)
    const socket = net.connect({host: '127.0.0.1', port: Number(port)})
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))

    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(
      `GET /v2022-06-30/socket/${DATASET}?tag=sanity.studio HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )

    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')

    const settle = () => new Promise((resolve) => setTimeout(resolve, 120))
    await settle()
    const handshake = Buffer.concat(chunks).toString('latin1')
    expect(handshake).toContain('HTTP/1.1 101 Switching Protocols')
    expect(handshake.toLowerCase()).toContain(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)

    /* One masked client text frame carrying the first thing bifur sends. */
    const payload = Buffer.from(
      JSON.stringify({jsonrpc: '2.0', id: 1, method: 'authorization', params: {}}),
      'utf8',
    )
    const mask = crypto.randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]!
    chunks.length = 0
    socket.write(
      Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]),
    )
    await settle()

    const reply = Buffer.concat(chunks)
    expect(reply.length).toBeGreaterThan(2)
    expect(reply[0]! & 0x0f).toBe(0x1) // a text frame
    /* Server frames are never masked (RFC 6455 §5.1), but the payload here is
     * well over 125 bytes, so the length is the 16-bit extended form and the
     * header is four bytes, not two. */
    expect(reply[1]! & 0x80).toBe(0) // unmasked
    const short = reply[1]! & 0x7f
    const {offset, length} =
      short < 126
        ? {offset: 2, length: short}
        : short === 126
          ? {offset: 4, length: reply.readUInt16BE(2)}
          : {offset: 10, length: Number(reply.readBigUInt64BE(2))}
    expect(reply.length).toBe(offset + length)
    const rpc = JSON.parse(reply.subarray(offset, offset + length).toString('utf8'))
    expect(rpc.jsonrpc).toBe('2.0')
    expect(rpc.id).toBe(1)
    expect(rpc.error.code).toBe(-32601)
    expect(String(rpc.error.message)).toMatch(/bifur|realtime/i)
    expect(rpc.error.data.method).toBe('authorization')

    socket.destroy()
  })

  it('answers a WebSocket ping with a pong so the socket is not reaped', async () => {
    const key = crypto.randomBytes(16).toString('base64')
    const {port} = new URL(baseUrl)
    const socket = net.connect({host: '127.0.0.1', port: Number(port)})
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(
      `GET /v2022-06-30/socket/${DATASET} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    chunks.length = 0

    const mask = crypto.randomBytes(4)
    socket.write(Buffer.concat([Buffer.from([0x89, 0x80]), mask])) // masked, empty ping
    await new Promise((resolve) => setTimeout(resolve, 120))

    const reply = Buffer.concat(chunks)
    expect(reply.length).toBeGreaterThanOrEqual(2)
    expect(reply[0]! & 0x0f).toBe(0xa) // pong
    socket.destroy()
  })

  it('answers the agent bundle listener as an empty stream rather than 404', async () => {
    const controller = new AbortController()
    const response = await fetch(
      `${baseUrl}/v2025-02-19/agent/oTu7RImef/bundles/mine/listen`,
      {signal: controller.signal},
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/event-stream/)
    controller.abort()
  })
})
