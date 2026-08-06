/**
 * MODE 2 (`--origin` / `OVERLAY_BASE=none`) — the safety boundary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Mode 2 turns the Spike B proxy from a *proxy* into an *origin*: there is no
 * upstream Sanity project, no login, no grants, and the identity it hands out
 * is a synthetic `local-dev` user with every permission. That is exactly what
 * makes local editing possible with no Sanity account — and exactly what makes
 * the server dangerous the moment it is reachable from anything but loopback.
 *
 * So Mode 2 carries three safety properties, and this suite is the thing that
 * says they hold:
 *
 *   1. LOOPBACK ONLY. Mode 2 refuses to start on a non-loopback interface, and
 *      "all interfaces" (the ordinary default, `bind: undefined` -> 0.0.0.0/::)
 *      counts as non-loopback. There is no flag that turns this off.
 *   2. EXPLICIT OPT-IN. Mode 2 is never *inferred*. A missing `SANITY_API_HOST`,
 *      an unreachable upstream, a 502 — none of them may quietly promote the
 *      proxy into an origin that answers `users/me` with a full-grant identity.
 *   3. THE WRITE GUARD IS NOT WEAKENED. `writeGuard.mjs` is default-deny and is
 *      the project's only security boundary (Spike F, PRD §35.14). It is not
 *      edited by Mode 2 and still runs first; the full contract against it lives
 *      in `write-guard.test.ts` and is untouched. What Mode 2 adds is a second
 *      question asked of the same verdict: is this one of the two endpoints the
 *      overlay owns (`POST /data/{mutate,actions}/<the one dataset>`)? If not,
 *      the 403 stands — including on the upgrade path.
 *
 * This file therefore states the property *differentially*: for every case in
 * the write-guard contract that is not one of those two routes, Mode 2's verdict
 * must equal Mode 1's, and the set of Spike F vectors that Mode 2 does serve is
 * pinned as an explicit list of attack numbers. Widening the origin allowlist
 * turns this file red before it turns anything else green.
 */
import {afterEach, describe, expect, it} from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer, resolveProxyConfig} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
import {
  OriginBindError,
  ORIGIN_WRITE_PATHS,
  isLoopbackBind,
  isOriginModeRequested,
  isOriginWriteRoute,
  // @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
} from '../../../examples/kitchen-sink/spikeB-proxy/originSafety.mjs'
// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {isWriteRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
import {
  SPIKE_F_ATTACK_NUMBERS,
  WRITE_GUARD_CASES,
  spikeFAttackVectors,
} from '../src/writeGuardContract'

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-safety-'))
  cleanups.push(() => fs.rmSync(dir, {recursive: true, force: true}))
  return path.join(dir, 'log.jsonl')
}

interface HandlerCall {
  method: string
  url: string
  kind: 'request' | 'upgrade'
}

/**
 * A stand-in for the real overlay handler.
 *
 * The safety boundary must hold *whatever* is behind it, so these tests do not
 * involve the overlay at all: the stub records every call it receives and
 * answers 200. A request that reaches it is, by definition, a request Mode 2
 * decided to serve — which is the fact under test.
 */
function recordingHandler(): {
  dataset: string
  calls: HandlerCall[]
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  handleUpgrade: (req: http.IncomingMessage, socket: net.Socket) => void
  close: () => Promise<void>
} {
  const calls: HandlerCall[] = []
  return {
    dataset: DATASET,
    calls,
    async handle(req, res) {
      calls.push({method: req.method || '', url: req.url || '', kind: 'request'})
      req.resume()
      const body = JSON.stringify({origin: true})
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    },
    handleUpgrade(req, socket) {
      calls.push({method: req.method || '', url: req.url || '', kind: 'upgrade'})
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    },
    async close() {
      /* nothing to release */
    },
  }
}

async function startOrigin(
  overrides: Record<string, unknown> = {},
): Promise<{url: string; handler: ReturnType<typeof recordingHandler>; server: http.Server}> {
  const handler = recordingHandler()
  const server: http.Server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: tempLog(),
    env: {},
    ...overrides,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {url: `http://127.0.0.1:${address.port}`, handler, server}
}

/** Send a raw request line so unnormalised URLs survive to the server. */
function rawRequest(
  url: string,
  method: string,
  target: string,
  extraHeaders: string[] = [],
): Promise<{status: number; body: string}> {
  const {hostname, port} = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: hostname, port: Number(port)}, () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          extraHeaders.map((h) => `${h}\r\n`).join('') +
          'Content-Length: 0\r\nConnection: close\r\n\r\n',
      )
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text)
      const split = text.indexOf('\r\n\r\n')
      resolve({
        status: match ? Number(match[1]) : 0,
        body: split === -1 ? '' : text.slice(split + 4),
      })
    })
  })
}

/* ================================================================== *
 * 1. loopback only
 * ================================================================== */

describe('Mode 2 safety · loopback only', () => {
  describe('isLoopbackBind classifies the whole address family', () => {
    const loopback = [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ]
    for (const value of loopback) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        expect(isLoopbackBind(value)).toBe(true)
      })
    }

    const routable = [
      // "all interfaces" — the ordinary default, and the dangerous one.
      undefined,
      '',
      '0.0.0.0',
      '::',
      '[::]',
      '::ffff:0.0.0.0',
      // private ranges are still reachable from the LAN
      '10.0.0.1',
      '192.168.1.10',
      '172.16.0.1',
      '169.254.1.1',
      // public
      '203.0.113.7',
      '2001:db8::1',
      // hostnames that are not localhost
      'example.com',
      'localhost.evil.test',
      'notlocalhost',
      // the loopback *label* smuggled into another position
      '10.127.0.0.1',
      '::ffff:192.168.0.1',
    ]
    for (const value of routable) {
      it(`refuses ${JSON.stringify(value)}`, () => {
        expect(isLoopbackBind(value)).toBe(false)
      })
    }
  })

  it('defaults the bind address to loopback rather than all interfaces', () => {
    const config = resolveProxyConfig({origin: true, env: {}})
    expect(config.origin).toBe(true)
    expect(isLoopbackBind(config.bind)).toBe(true)
  })

  it('refuses to build a Mode 2 server bound to all interfaces', () => {
    expect(() =>
      createProxyServer({origin: true, bind: '0.0.0.0', originHandler: recordingHandler(), env: {}}),
    ).toThrow(OriginBindError)
  })

  it('refuses to build a Mode 2 server bound to a LAN address', () => {
    expect(() =>
      createProxyServer({
        origin: true,
        bind: '192.168.1.10',
        originHandler: recordingHandler(),
        env: {},
      }),
    ).toThrow(/loopback/i)
  })

  it('refuses a non-loopback PROXY_BIND from the environment', () => {
    expect(() =>
      createProxyServer({
        origin: true,
        originHandler: recordingHandler(),
        env: {PROXY_BIND: '0.0.0.0'},
      }),
    ).toThrow(OriginBindError)
  })

  it('still refuses at listen() time, after the socket really bound', async () => {
    const handler = recordingHandler()
    const server: http.Server = createProxyServer({
      origin: true,
      originHandler: handler,
      logPath: tempLog(),
      env: {},
    })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))

    /* Bypass the construction-time check the way a mis-wired launcher would:
     * listen() takes its own host argument and does not consult the config. */
    const error = await new Promise<Error | null>((resolve) => {
      server.once('error', (err: Error) => resolve(err))
      server.listen(0, '0.0.0.0', () => resolve(null))
    })
    expect(error).toBeInstanceOf(Error)
    expect(String(error?.message)).toMatch(/loopback/i)
    expect(server.listening).toBe(false)
  })

  it('Mode 1 is free to bind whatever it likes — the restriction is Mode 2 only', () => {
    expect(() =>
      createProxyServer({bind: '0.0.0.0', logPath: tempLog(), env: {}}),
    ).not.toThrow()
  })
})

/* ================================================================== *
 * 2. explicit opt-in
 * ================================================================== */

describe('Mode 2 safety · explicit opt-in', () => {
  it('is off by default', () => {
    expect(resolveProxyConfig({env: {}}).origin).toBe(false)
  })

  it('is off when only an upstream is configured', () => {
    expect(
      resolveProxyConfig({env: {SANITY_API_HOST: 'https://b1n03q3z.api.sanity.io'}}).origin,
    ).toBe(false)
  })

  it('is NOT inferred from a missing upstream', () => {
    /* The dangerous inference: "no SANITY_API_HOST, so the user must want an
     * origin". That would turn a typo into a full-grant identity server. */
    expect(resolveProxyConfig({env: {SANITY_API_HOST: ''}}).origin).toBe(false)
    expect(resolveProxyConfig({env: {PROXY_PORT: '3999'}}).origin).toBe(false)
  })

  it('is NOT inferred from a blank or unrelated OVERLAY_BASE', () => {
    for (const value of ['', 'staging', 'dataset', 'NONE ', ' none', 'null', '0', 'false']) {
      expect(isOriginModeRequested({}, {OVERLAY_BASE: value})).toBe(false)
    }
  })

  it('turns on for OVERLAY_BASE=none exactly', () => {
    expect(isOriginModeRequested({}, {OVERLAY_BASE: 'none'})).toBe(true)
    expect(resolveProxyConfig({env: {OVERLAY_BASE: 'none'}}).origin).toBe(true)
  })

  it('turns on for an explicit option, which is what --origin sets', () => {
    expect(isOriginModeRequested({origin: true}, {})).toBe(true)
    expect(resolveProxyConfig({origin: true, env: {}}).origin).toBe(true)
  })

  it('lets an explicit `origin: false` beat the environment', () => {
    expect(resolveProxyConfig({origin: false, env: {OVERLAY_BASE: 'none'}}).origin).toBe(false)
  })

  it('refuses to build Mode 2 with no handler behind it', () => {
    expect(() => createProxyServer({origin: true, env: {}})).toThrow(/originHandler/i)
  })
})

/* ================================================================== *
 * 3. the write guard is not weakened
 * ================================================================== */

/** The one dataset the Mode 2 origin in these tests serves. */
const DATASET = 'parity'

/**
 * The composite Mode 2 policy.
 *
 * "Blocked in Mode 2" = the guard says write AND the request is not one of the
 * two overlay-owned routes. Anything the guard already calls a read is a read
 * in both modes.
 */
const blockedInOriginMode = (req: {method: string; url: string}): boolean =>
  isWriteRequest(req) && !isOriginWriteRoute(req.method, req.url, DATASET)

/**
 * WHAT MODE 2 DELIBERATELY SERVES THAT MODE 1 BLOCKS — stated as data, not
 * discovered at review time.
 *
 * Mode 1's guard answers one question: *does this write to Content Lake?* In
 * Mode 2 there is no Content Lake, and `POST /data/{mutate,actions}/<ds>` is the
 * endpoint the whole mode exists to serve — Studio cannot save without it. So
 * every Spike F vector whose request line IS that endpoint is answered from the
 * overlay in Mode 2. That is not a weakened guard; it is a different
 * destination. The overlay is a local file tree the user owns, under the §14
 * checkpoint model, with nothing upstream behind it.
 *
 * Eighteen of the twenty-seven attacks are exactly that request line (1-13,
 * 15-19: every way `@sanity/client` can be persuaded to reach its own mutation
 * endpoint). They are enumerated here so that any *change* to the set — one
 * more endpoint quietly added to the origin allowlist — turns this list red
 * before it turns anything else green.
 *
 * Everything else stays 403, including the shapes that are only *nearly* this
 * endpoint: attack 14 (`/data/mutate/scratch`, a different dataset), 20 (no
 * leading slash), 21/22 (assets), 23 (agent actions), 24 (datasets), and 25/26
 * (absolute URLs pointed at `<project>.api.sanity.io` itself).
 */
const OVERLAY_SERVED_ATTACKS: readonly number[] = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19,
])

describe('Mode 2 safety · the write guard still classifies identically', () => {
  it('exposes exactly two overlay-owned write routes', () => {
    expect([...ORIGIN_WRITE_PATHS].sort()).toEqual(['/data/actions', '/data/mutate'])
  })

  it('still classifies both overlay-owned routes as writes — the guard is untouched', () => {
    expect(isWriteRequest({method: 'POST', url: '/v2025-02-19/data/mutate/parity'})).toBe(true)
    expect(isWriteRequest({method: 'POST', url: '/v2025-02-19/data/actions/parity'})).toBe(true)
  })

  describe('the origin route allowlist only accepts an already-canonical request line', () => {
    const accepted = [
      ['POST', '/v2025-02-19/data/mutate/parity'],
      ['POST', '/v2025-02-19/data/actions/parity'],
      ['POST', '/data/mutate/parity'],
      ['POST', '/v2025-02-19/data/mutate/parity?returnDocuments=true'],
      ['POST', '/vX/data/actions/parity'],
    ]
    for (const [method, url] of accepted) {
      it(`accepts ${method} ${url}`, () => {
        expect(isOriginWriteRoute(method, url)).toBe(true)
      })
    }

    /* Every historical Spike F normalisation escape, re-asked of the allowlist.
     * A canonicalising allowlist would accept these and make Mode 2 reachable
     * by shapes Mode 1 blocks. */
    const refused = [
      ['POST', 'data/mutate/parity', 'no leading slash (Spike F gap 20)'],
      ['POST', '/DATA/MUTATE/parity', 'upper case'],
      ['POST', '//data//mutate//parity', 'duplicated separators'],
      ['POST', '/v2025-02-19//data/mutate/parity', 'duplicated separator after version'],
      ['POST', '/data/../data/mutate/parity', 'dot segments'],
      ['POST', '/x/../data/mutate/parity', 'dot segments'],
      ['POST', '/data/..%2Fmutate/parity', 'percent-encoded traversal'],
      ['POST', '/data%2Fmutate/parity', 'percent-encoded separator'],
      ['POST', '/data/mutate/parity/', 'trailing slash'],
      ['POST', '/v1/v1/data/mutate/parity', 'stacked version prefixes'],
      ['GET', '/v2025-02-19/data/mutate/parity', 'wrong method'],
      ['PUT', '/v2025-02-19/data/mutate/parity', 'wrong method'],
      ['DELETE', '/v2025-02-19/data/actions/parity', 'wrong method'],
      ['POST', '/data/mutate', 'no dataset'],
      ['POST', '/data/mutate/parity/extra', 'trailing segment'],
      ['POST', '/projects/b1n03q3z/datasets/parity/mutate', 'resource-scoped mutate'],
      ['POST', '/data/query/parity', 'not a write route'],
      ['POST', '/agent/action/patch/parity', 'agent write'],
      ['POST', '/assets/images/parity', 'asset upload'],
      ['POST', '/descriptors/claim', 'descriptors'],
      ['POST', '/intake/batch', 'telemetry'],
    ]
    for (const [method, url, why] of refused) {
      it(`refuses ${method} ${url} — ${why}`, () => {
        expect(isOriginWriteRoute(method, url)).toBe(false)
      })
    }
  })

  it('never accepts a route the guard already treats as a read', () => {
    for (const c of WRITE_GUARD_CASES) {
      if (c.write) continue
      expect(
        isOriginWriteRoute(c.method, c.url),
        `${c.method} ${c.url} is a read; the origin write allowlist must not claim it`,
      ).toBe(false)
    }
  })

  it('serves exactly the enumerated Spike F vectors and blocks all the rest', () => {
    const vectors = spikeFAttackVectors()
    expect(SPIKE_F_ATTACK_NUMBERS).toHaveLength(27)
    expect(vectors.length).toBeGreaterThan(0)

    const served = new Set<number>()
    for (const vector of vectors) {
      if (isOriginWriteRoute(vector.method, vector.url, DATASET)) {
        /* Anything the overlay serves must have been a WRITE in Mode 1. A read
         * being routed to the write path would be a different bug entirely. */
        expect(vector.write, `${vector.attackName} is a read; it must not be an origin write route`)
          .toBe(true)
        served.add(vector.attack as number)
        continue
      }
      expect(
        blockedInOriginMode({method: vector.method, url: vector.url}),
        `Spike F attack ${vector.attack ?? '?'} (${vector.attackName ?? vector.why}) changed verdict in Mode 2`,
      ).toBe(vector.write)
    }

    expect([...served].sort((a, b) => a - b)).toEqual([...OVERLAY_SERVED_ATTACKS])
  })

  it('keeps the near-miss vectors 403 — they are the ones that look servable', () => {
    const nearMiss = spikeFAttackVectors().filter(
      (v) => v.write && !isOriginWriteRoute(v.method, v.url, DATASET),
    )
    /* 14 (other dataset), 20 (no leading slash), 21/22 (assets), 23 (agent),
     * 24 x3 (datasets), 25/26 (absolute URL at api.sanity.io). */
    expect(nearMiss.map((v) => v.attackName).sort()).toEqual([
      '14.client.withConfig.datasetOverride',
      '20.client.request.relativeUrlBypass',
      '21.client.request.assetsEndpoint',
      '22.client.assets.upload',
      '23.client.agent.action.patch',
      '24.client.datasets.reachable (copy)',
      '24.client.datasets.reachable (create)',
      '24.client.datasets.reachable (delete)',
      '25.freshClient.create',
      '26.rawFetch.dataMutate',
    ])
    for (const vector of nearMiss) {
      expect(blockedInOriginMode({method: vector.method, url: vector.url})).toBe(true)
    }
  })

  it('gives every non-origin-route contract case the identical Mode 1 verdict', () => {
    /* The differential statement of "the guard is not weakened": for every case
     * in the contract that is NOT one of the two overlay-owned routes, Mode 2's
     * composite policy must return exactly what Mode 1's guard returns. */
    let compared = 0
    let skipped = 0
    for (const c of WRITE_GUARD_CASES) {
      if (isOriginWriteRoute(c.method, c.url, DATASET)) {
        skipped += 1
        continue
      }
      compared += 1
      expect(
        blockedInOriginMode({method: c.method, url: c.url}),
        `${c.method} ${c.url} — ${c.why}`,
      ).toBe(isWriteRequest({method: c.method, url: c.url}))
      expect(blockedInOriginMode({method: c.method, url: c.url})).toBe(c.write)
    }
    /* Everything in the contract is accounted for: compared, or one of the two
     * overlay-owned routes. Nothing is quietly dropped. */
    expect(compared + skipped).toBe(WRITE_GUARD_CASES.length)
    expect(compared).toBeGreaterThan(100)
    expect(skipped).toBeGreaterThan(0)
  })
})

/* ================================================================== *
 * 4. end to end through a running Mode 2 server
 * ================================================================== */

describe('Mode 2 safety · a running origin server', () => {
  it('forces the write guard on even when PROXY_BLOCK_WRITES says otherwise', () => {
    const config = resolveProxyConfig({origin: true, env: {PROXY_BLOCK_WRITES: '0'}})
    expect(config.blockWrites).toBe(true)
    expect(resolveProxyConfig({origin: true, blockWrites: false, env: {}}).blockWrites).toBe(true)
  })

  it('routes the two overlay-owned writes to the overlay', async () => {
    const {url, handler} = await startOrigin()
    for (const route of ['/v2025-02-19/data/mutate/parity', '/v2025-02-19/data/actions/parity']) {
      const response = await rawRequest(url, 'POST', route)
      expect(response.status, route).toBe(200)
    }
    expect(handler.calls.map((c) => c.url)).toEqual([
      '/v2025-02-19/data/mutate/parity',
      '/v2025-02-19/data/actions/parity',
    ])
  })

  it('403s every Spike F vector that is not an overlay route, without reaching the overlay', async () => {
    const {url, handler} = await startOrigin()
    const blocked = spikeFAttackVectors().filter(
      (v) => v.write && !isOriginWriteRoute(v.method, v.url, DATASET),
    )
    expect(blocked).toHaveLength(10)
    for (const vector of blocked) {
      const response = await rawRequest(url, vector.method, vector.url)
      /* 403 is the guard. 400 is Node's own HTTP parser refusing a request line
       * that is neither origin-form nor absolute-form (`data/mutate/<ds>`, the
       * gap-20 shape) — an even earlier rejection, and still not a request the
       * overlay ever sees. Both are "did not reach the overlay"; a 200 is not. */
      expect([400, 403], `${vector.method} ${vector.url} -> ${response.status}`).toContain(
        response.status,
      )
      if (response.status === 403) expect(response.body).toContain('OVERLAY_WRITE_BLOCKED')
    }
    expect(handler.calls).toEqual([])
  })

  it('403s a write smuggled through the upgrade path', async () => {
    const {url, handler} = await startOrigin()
    const response = await rawRequest(url, 'POST', '/v2025-02-19/data/mutate/parity', [
      'Connection: Upgrade',
      'Upgrade: websocket',
    ])
    expect(response.status).toBe(403)
    expect(response.body).toContain('OVERLAY_WRITE_BLOCKED')
    expect(handler.calls).toEqual([])
  })

  it('never dials an upstream, whatever the request', async () => {
    let dials = 0
    const {url, handler} = await startOrigin({
      dialUpstream: () => {
        dials += 1
        throw new Error('Mode 2 must never dial an upstream')
      },
      upstream: 'https://b1n03q3z.api.sanity.io',
    })
    for (const target of [
      '/v2026-05-04/users/me',
      '/v2025-02-19/data/query/parity?query=*',
      '/v2025-02-19/projects/b1n03q3z',
      '/v2025-02-19/data/mutate/parity',
    ]) {
      const method = target.includes('mutate') ? 'POST' : 'GET'
      const response = await rawRequest(url, method, target)
      expect(response.status, target).toBe(200)
    }
    expect(dials).toBe(0)
    expect(handler.calls).toHaveLength(4)
  })

  it('answers CORS preflight locally, before the guard and before the overlay', async () => {
    const {url, handler} = await startOrigin()
    const response = await rawRequest(url, 'OPTIONS', '/v2025-02-19/data/mutate/parity', [
      'Origin: http://localhost:3333',
      'Access-Control-Request-Method: POST',
    ])
    expect(response.status).toBe(204)
    expect(handler.calls).toEqual([])
  })
})

/* ================================================================== *
 * 5. Mode 1 is preserved
 * ================================================================== */

describe('Mode 1 is unchanged', () => {
  it('keeps every default it had', () => {
    const config = resolveProxyConfig({env: {}})
    expect(config.origin).toBe(false)
    expect(config.originHandler).toBe(null)
    expect(config.blockWrites).toBe(false)
    expect(config.bind).toBeUndefined()
    expect(config.deriveProjectHost).toBe(true)
    expect(config.forwardOrigin).toBe(false)
    expect(config.rewriteCookies).toBe(true)
    expect(config.upstream.origin).toBe('https://b1n03q3z.api.sanity.io')
  })

  it('still honours PROXY_BLOCK_WRITES both ways', () => {
    expect(resolveProxyConfig({env: {PROXY_BLOCK_WRITES: '1'}}).blockWrites).toBe(true)
    expect(resolveProxyConfig({env: {PROXY_BLOCK_WRITES: '0'}}).blockWrites).toBe(false)
    expect(resolveProxyConfig({env: {}}).blockWrites).toBe(false)
  })

  it('never consults an origin handler', async () => {
    const handler = recordingHandler()
    /* An upstream that refuses every connection: in Mode 1 the proxy must try it
     * and report 502, NOT quietly fall back to serving from the overlay. */
    const server: http.Server = createProxyServer({
      origin: false,
      originHandler: handler,
      upstream: 'http://127.0.0.1:1',
      logPath: tempLog(),
      env: {},
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')

    const response = await rawRequest(`http://127.0.0.1:${address.port}`, 'GET', '/v2025-02-19/ping')
    expect(response.status).toBe(502)
    expect(handler.calls).toEqual([])
  })
})
