/**
 * THE STRUCTURAL FORM OF ONE RULE: **this system never writes to a real Sanity
 * dataset.** Owner ruling, 2026-08-05 — see the scope amendment at the top of
 * `docs/PRD-v1.md`.
 *
 * The rule was previously a promise made by several cooperating layers: the
 * Track B proxy is default-deny, the Studio facade intercepts every write plane
 * it can name, and origin mode serves writes from the overlay. Each of those is
 * a *classification* guard — it asks "is this request a write?" and can only be
 * as right as its endpoint inventory. Spike F's whole lesson was that such an
 * inventory is never complete.
 *
 * So this file adds the two guards that do not depend on knowing the endpoint:
 *
 *   (a) SUITE-LEVEL. A monitor installed by `vitest.setup.ts` into every test
 *       file in this package patches `https.request`, `http.request`, their
 *       `get` siblings and `globalThis.fetch`, and REFUSES any non-GET request
 *       addressed to a `sanity.io` host. It is enforcement, not observation: a
 *       test that tries to write to Sanity fails, wherever in the suite it
 *       lives. Its self-tests are in part 1.
 *
 *   (b) RUNTIME. `assertNoStagingWrite` / `createStagingSafeFetch`
 *       (`sanity-overlay-client/src/stagingHost.ts`) refuse the same thing in a
 *       *running* process, wired into the Studio overlay transport, the Studio
 *       client facade and the HTTP base source. Its tests are in part 2.
 *
 * Both are host-anchored rather than path-anchored on purpose. A path guard has
 * to have heard of `POST /projects/<p>/tokens`; a host guard does not.
 */
import http from 'node:http'
import https from 'node:https'
import type {AddressInfo} from 'node:net'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  OUTBOUND_REFUSAL_CODE,
  StagingWriteInTestError,
  isMonitoredSanityHost,
  isOutboundRequestMonitorInstalled,
  outboundAttempts,
} from '../src/outboundMonitor'
import {
  STAGING_WRITE_POLICY,
  StagingWriteRefusedError,
  assertNoStagingWrite,
  createStagingSafeFetch,
  isSanityApiHost,
  isStagingWrite,
} from '../../sanity-overlay-client/src/stagingHost'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const PID = 'b1n03q3z'
const DS = 'parity'

/* ══════════════════════════════════════════════════════════════ part 1 (a) */

/**
 * Every spelling of "a real Sanity host" this project can plausibly emit, with
 * the near-misses that must NOT be caught. Normalisation is where the historical
 * bugs lived (Spike F gaps 20/21), so the family is enumerated rather than
 * sampled — case, trailing dot, port, userinfo, protocol-relative, and the two
 * classic lookalikes (suffix-appended and query-string-embedded).
 */
const SANITY_HOSTS: ReadonlyArray<readonly [label: string, url: string]> = [
  ['project data plane', `https://${PID}.api.sanity.io/v2025-02-19/data/mutate/${DS}`],
  ['bare api host', 'https://api.sanity.io/v2025-02-19/data/mutate/parity'],
  ['resource-scoped', `https://api.sanity.io/v2025-02-19/projects/${PID}/datasets/${DS}/mutate`],
  ['asset upload', `https://${PID}.api.sanity.io/v2025-02-19/assets/images/${DS}`],
  ['asset upload (files)', `https://${PID}.api.sanity.io/v2025-02-19/assets/files/${DS}`],
  ['media library upload', 'https://api.sanity.io/v2025-02-19/media-libraries/ml-1/upload'],
  ['agent action', `https://${PID}.api.sanity.io/v2025-02-19/agent/action/patch/${DS}`],
  ['dataset admin', `https://api.sanity.io/v2025-02-19/datasets/${DS}`],
  ['token mint', `https://api.sanity.io/v2025-02-19/projects/${PID}/tokens`],
  ['cdn host', `https://${PID}.apicdn.sanity.io/v2025-02-19/data/mutate/${DS}`],
  ['uppercase', `HTTPS://${PID.toUpperCase()}.API.SANITY.IO/v2025-02-19/data/mutate/${DS}`],
  ['trailing dot', `https://${PID}.api.sanity.io./v2025-02-19/data/mutate/${DS}`],
  ['explicit port', `https://${PID}.api.sanity.io:443/v2025-02-19/data/mutate/${DS}`],
  ['userinfo prefix', `https://user:pw@${PID}.api.sanity.io/v2025-02-19/data/mutate/${DS}`],
]

const NOT_SANITY_HOSTS: ReadonlyArray<readonly [label: string, url: string]> = [
  ['loopback overlay API', 'http://localhost:3998/commit'],
  ['loopback proxy', 'http://127.0.0.1:3999/v2025-02-19/data/mutate/parity'],
  ['suffix lookalike', 'https://b1n03q3z.api.sanity.io.evil.example/v1/data/mutate/parity'],
  ['query-string lookalike', 'https://evil.example/v1/data/mutate/parity?h=api.sanity.io'],
  ['path lookalike', 'https://evil.example/api.sanity.io/data/mutate/parity'],
]

/**
 * Hosts the two predicates deliberately DISAGREE about, and the disagreement is
 * the design: the monitor sweeps all of `sanity.io`, the runtime guard names
 * only the API hosts. `xapi.sanity.io` is not `api.sanity.io` — a label
 * boundary, not a substring — so the runtime guard must not match it, while the
 * monitor errs wide because erring wide inside a test suite costs nothing.
 */
const MONITOR_ONLY_HOSTS: ReadonlyArray<readonly [label: string, url: string]> = [
  ['prefix lookalike', 'https://xapi.sanity.io/v1/data/mutate/parity'],
  ['studio host', 'https://www.sanity.io/manage'],
]

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'Put'] as const

describe('(a) suite-level · the outbound-request monitor is installed everywhere', () => {
  it('is installed in this test file, which proves vitest.setup.ts ran', () => {
    expect(isOutboundRequestMonitorInstalled()).toBe(true)
  })

  it('has already observed outbound requests, or can observe them', () => {
    /* The array exists and is readable; the enforcement tests below add to it. */
    expect(Array.isArray(outboundAttempts())).toBe(true)
  })
})

describe('(a) suite-level · a non-GET request to a Sanity host is refused', () => {
  it.each(SANITY_HOSTS)('https.request %s is refused', (_label, url) => {
    expect(() => https.request(url, {method: 'POST'})).toThrow(StagingWriteInTestError)
  })

  it.each(SANITY_HOSTS)('fetch %s is refused', async (_label, url) => {
    await expect(fetch(url, {method: 'POST'})).rejects.toThrow(StagingWriteInTestError)
  })

  it.each(UNSAFE_METHODS)('refuses %s, not merely POST', (method) => {
    expect(() => https.request(`https://${PID}.api.sanity.io/v1/data/mutate/${DS}`, {method})).toThrow(
      StagingWriteInTestError,
    )
  })

  it('refuses a request whose host arrives through the legacy options form', () => {
    expect(() =>
      https.request({hostname: `${PID}.api.sanity.io`, path: `/v1/data/mutate/${DS}`, method: 'POST'}),
    ).toThrow(StagingWriteInTestError)
  })

  it('refuses a request whose host arrives as `host` with a port attached', () => {
    expect(() =>
      https.request({host: `${PID}.api.sanity.io:443`, path: `/v1/assets/images/${DS}`, method: 'POST'}),
    ).toThrow(StagingWriteInTestError)
  })

  it('refuses through https.get too, which does not route via https.request', () => {
    expect(() =>
      https.get({hostname: `${PID}.api.sanity.io`, path: '/v1/data/mutate/parity', method: 'DELETE'}),
    ).toThrow(StagingWriteInTestError)
  })

  it('carries a code and names the policy, so a failure explains itself', () => {
    let caught: unknown
    try {
      https.request(`https://${PID}.api.sanity.io/v1/data/mutate/${DS}`, {method: 'POST'})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StagingWriteInTestError)
    expect((caught as {code: string}).code).toBe(OUTBOUND_REFUSAL_CODE)
    expect(String((caught as Error).message)).toMatch(/never writes to a real Sanity dataset/i)
  })

  it('records the attempt before refusing it, so the evidence survives the throw', () => {
    const before = outboundAttempts().length
    try {
      https.request(`https://${PID}.api.sanity.io/v1/data/actions/${DS}`, {method: 'POST'})
    } catch {
      /* expected */
    }
    const added = outboundAttempts().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({method: 'POST', refused: true})
    expect(added[0].host).toBe(`${PID}.api.sanity.io`)
  })
})

describe('(a) suite-level · legitimate traffic is not blocked', () => {
  let server: http.Server
  let port = 0

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('lets a loopback POST through and records it — the overlay API is not Sanity', async () => {
    const before = outboundAttempts().length
    const response = await fetch(`http://127.0.0.1:${port}/commit`, {
      method: 'POST',
      body: '{}',
    })
    expect(await response.json()).toEqual({ok: true})
    const added = outboundAttempts().slice(before)
    expect(added.some((a) => a.method === 'POST' && a.refused === false)).toBe(true)
  })

  it('lets a loopback GET through via http.request', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request({hostname: '127.0.0.1', port, path: '/state'}, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('end', () => resolve(text))
      })
      request.on('error', reject)
      request.end()
    })
    expect(body).toBe('{"ok":true}')
  })

  it('classifies a GET to a Sanity host as allowed — hosted read parity stays legitimate', () => {
    for (const [, url] of SANITY_HOSTS) {
      expect(isMonitoredSanityHost(url)).toBe(true)
    }
    /* The refusal is the conjunction of host AND unsafe method; a GET is neither
     * refused nor exempted from being recorded. */
    expect(isStagingWrite({method: 'GET', url: `https://${PID}.api.sanity.io/v1/data/query/${DS}`})).toBe(
      false,
    )
  })

  it.each(NOT_SANITY_HOSTS)('does not treat %s as a Sanity host', (_label, url) => {
    expect(isMonitoredSanityHost(url)).toBe(false)
  })

  it.each(MONITOR_ONLY_HOSTS)('sweeps %s, which the runtime guard deliberately does not', (_l, url) => {
    expect(isMonitoredSanityHost(url)).toBe(true)
    expect(isSanityApiHost(hostOf(url))).toBe(false)
  })
})

describe('(a) suite-level · the monitor is a real oracle, not a copy of the guard', () => {
  /**
   * The monitor deliberately uses its OWN, broader host predicate (any
   * `sanity.io` host) rather than importing the runtime guard's. If both read
   * the same predicate, a bug in it blinds the guard and its own oracle at the
   * same instant. Broader is the safe direction, and this pins the relationship:
   * everything the runtime guard calls a Sanity API host, the monitor also sees.
   */
  it('is at least as strict as the runtime guard over the whole host corpus', () => {
    for (const [label, url] of [...SANITY_HOSTS, ...NOT_SANITY_HOSTS]) {
      if (isSanityApiHost(hostOf(url))) {
        expect(`${label}: ${isMonitoredSanityHost(url)}`).toBe(`${label}: true`)
      }
    }
  })

  it('a method-only guard — the degenerate implementation — misses the whole corpus', () => {
    /* Kept as the RED baseline: a guard that only looks at the method would call
     * every one of these a write and every hosted read a write too, so it is
     * useless in the other direction. This asserts the corpus is non-trivial. */
    expect(SANITY_HOSTS.length).toBeGreaterThanOrEqual(14)
    expect(NOT_SANITY_HOSTS.length + MONITOR_ONLY_HOSTS.length).toBeGreaterThanOrEqual(7)
  })
})

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/\.$/, '').toLowerCase()
  } catch {
    return ''
  }
}

/* ══════════════════════════════════════════════════════════════ part 2 (b) */

describe('(b) runtime · the host policy', () => {
  it.each(SANITY_HOSTS)('%s is a Sanity API host', (_label, url) => {
    expect(isSanityApiHost(hostOf(url))).toBe(true)
  })

  it.each(NOT_SANITY_HOSTS)('%s is not a Sanity API host', (_label, url) => {
    expect(isSanityApiHost(hostOf(url))).toBe(false)
  })

  it.each(SANITY_HOSTS)('a POST to %s is a staging write', (_label, url) => {
    expect(isStagingWrite({method: 'POST', url})).toBe(true)
  })

  it.each(UNSAFE_METHODS)('%s to a Sanity host is a staging write', (method) => {
    expect(isStagingWrite({method, url: `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`})).toBe(true)
  })

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('%s to a Sanity host is not a staging write', (method) => {
    expect(isStagingWrite({method, url: `https://${PID}.api.sanity.io/v1/data/query/${DS}`})).toBe(false)
  })

  it.each(NOT_SANITY_HOSTS)('a POST to %s is not a staging write', (_label, url) => {
    expect(isStagingWrite({method: 'POST', url})).toBe(false)
  })

  it('resolves a relative URL against a base before judging it', () => {
    expect(
      isStagingWrite({
        method: 'POST',
        url: `/v1/data/mutate/${DS}`,
        base: `https://${PID}.api.sanity.io`,
      }),
    ).toBe(true)
    expect(
      isStagingWrite({method: 'POST', url: `/v1/data/mutate/${DS}`, base: 'http://localhost:3999'}),
    ).toBe(false)
  })

  it('cannot judge a bare path with no base, and says so by not refusing', () => {
    /* Documented limitation: the path-anchored guards (writeGuard.ts, the proxy)
     * own that layer. A host guard that guessed a host would fail OPEN on the
     * proxy topology, where the very same path is legitimate. */
    expect(isStagingWrite({method: 'POST', url: `/v1/data/mutate/${DS}`})).toBe(false)
  })

  it('throws a coded, policy-naming error', () => {
    let caught: unknown
    try {
      assertNoStagingWrite({method: 'POST', url: `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StagingWriteRefusedError)
    expect((caught as {code: string}).code).toBe('STAGING_WRITE_REFUSED')
    expect((caught as Error).message).toContain(STAGING_WRITE_POLICY)
    expect((caught as {host: string}).host).toBe(`${PID}.api.sanity.io`)
  })
})

describe('(b) runtime · createStagingSafeFetch', () => {
  it('refuses a write to a Sanity host without calling the underlying fetch', async () => {
    const calls: string[] = []
    const guarded = createStagingSafeFetch((async (input: unknown, init?: Rec) => {
      calls.push(`${String((init as Rec | undefined)?.method ?? 'GET')} ${String(input)}`)
      return {ok: true} as unknown as Response
    }) as unknown as typeof fetch)

    await expect(
      guarded(`https://${PID}.api.sanity.io/v1/data/mutate/${DS}`, {method: 'POST'}),
    ).rejects.toThrow(StagingWriteRefusedError)
    expect(calls).toEqual([])
  })

  it.each(SANITY_HOSTS)('refuses an upload/mutate to %s', async (_label, url) => {
    const guarded = createStagingSafeFetch((async () => ({ok: true}) as unknown as Response) as typeof fetch)
    await expect(guarded(url, {method: 'POST'})).rejects.toThrow(/never writes to a real Sanity dataset/i)
  })

  it('reads the method off a Request object, not only off init', async () => {
    const guarded = createStagingSafeFetch((async () => ({ok: true}) as unknown as Response) as typeof fetch)
    const request = new Request(`https://${PID}.api.sanity.io/v1/data/mutate/${DS}`, {method: 'POST'})
    await expect(guarded(request)).rejects.toThrow(StagingWriteRefusedError)
  })

  it('delegates a GET to a Sanity host — hosted reads are legitimate', async () => {
    const calls: string[] = []
    const guarded = createStagingSafeFetch((async (input: unknown) => {
      calls.push(String(input))
      return {ok: true} as unknown as Response
    }) as unknown as typeof fetch)
    await guarded(`https://${PID}.api.sanity.io/v1/data/query/${DS}?query=*`, {method: 'GET'})
    expect(calls).toHaveLength(1)
  })

  it('delegates a POST to the loopback overlay API', async () => {
    const calls: string[] = []
    const guarded = createStagingSafeFetch((async (input: unknown) => {
      calls.push(String(input))
      return {ok: true} as unknown as Response
    }) as unknown as typeof fetch)
    await guarded('http://localhost:3998/commit', {method: 'POST', body: '{}'})
    expect(calls).toEqual(['http://localhost:3998/commit'])
  })
})

describe('(b) runtime · the Studio overlay transport cannot be pointed at Sanity', () => {
  it('refuses to construct against a Sanity API host', () => {
    expect(() => createOverlayTransport({apiUrl: `https://${PID}.api.sanity.io/v2025-02-19/data`})).toThrow(
      StagingWriteRefusedError,
    )
  })

  it.each(SANITY_HOSTS)('refuses to construct against %s', (_label, url) => {
    expect(() => createOverlayTransport({apiUrl: url})).toThrow(/never writes to a real Sanity dataset/i)
  })

  it('still constructs against the loopback overlay API', () => {
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998'})
    expect(transport.apiUrl).toBe('http://localhost:3998')
  })

  it('refuses at construction, not at commit — a degraded outcome would read as "saved"', async () => {
    /* `call()` converts a throwing fetch into `degraded`, which the editor shows
     * as "saved, loudly". A staging write must never be reported that way, so
     * the refusal has to happen before any transport exists. */
    let constructed = true
    try {
      createOverlayTransport({apiUrl: `https://${PID}.api.sanity.io`})
    } catch {
      constructed = false
    }
    expect(constructed).toBe(false)
  })
})

/* ---------------------------------------------------------------- facade */

function nullTransport(): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok'}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  }
}

/**
 * A client whose `getUrl` resolves the way `@sanity/client` does for a default
 * project-hostname configuration, and which records anything that escapes.
 */
function hostedFakeClient(): Rec & {escaped: string[]} {
  const escaped: string[] = []
  const base = `https://${PID}.api.sanity.io/v2025-02-19`
  const escape =
    (name: string) =>
    (...args: unknown[]): unknown => {
      escaped.push(name)
      return Promise.resolve({escaped: name, args})
    }
  const self: Rec & {escaped: string[]} = {
    escaped,
    fetch: escape('fetch'),
    getDocument: escape('getDocument'),
    getDocuments: escape('getDocuments'),
    request: escape('request'),
    listen: () => ({subscribe: () => ({unsubscribe: () => {}})}),
    config: () => ({projectId: PID, dataset: DS, apiVersion: '2025-02-19', useCdn: false}),
    getUrl: (uri: string) => `${base}/${String(uri).replace(/^\//, '')}`,
    withConfig: (): unknown => self,
    clone: (): unknown => self,
    assets: {upload: escape('assets.upload')},
  }
  return self
}

function wrapHosted(): {client: Rec & {escaped: string[]}; wrapped: Rec; errors: string[]} {
  const errors: string[] = []
  const echo = createOverlayEcho({onError: (message) => errors.push(message)})
  const client = hostedFakeClient()
  const wrapped = wrapWithOverlay(client as unknown as object, {
    echo,
    transport: nullTransport(),
    onError: (message) => errors.push(message),
  }) as unknown as Rec
  return {client, wrapped, errors}
}

/**
 * The endpoints the write-guard contract's default-deny rationale names as the
 * ones NOBODY had heard of — none of them is under a guarded path prefix, so
 * before this guard each was delegated straight to `*.api.sanity.io`.
 */
const UNCLASSIFIED_WRITES: ReadonlyArray<readonly [method: string, uri: string]> = [
  ['POST', `/projects/${PID}/tokens`],
  ['PUT', '/users/me/keyvalue/studio-prefs'],
  ['POST', `/schedules/${PID}/${DS}`],
  ['POST', '/descriptors/claim'],
  ['DELETE', `/projects/${PID}/members/u1`],
  ['PATCH', `/projects/${PID}`],
]

describe('(b) runtime · the Studio facade refuses a write bound for a Sanity host', () => {
  it.each(UNCLASSIFIED_WRITES)(
    '%s %s — an endpoint no path guard has heard of — never reaches the client',
    async (method, uri) => {
      const {client, wrapped} = wrapHosted()
      await expect(
        (wrapped.request as (o: Rec) => Promise<unknown>)({uri, method, body: {}}),
      ).rejects.toThrow(/never writes to a real Sanity dataset/i)
      expect(client.escaped).toEqual([])
    },
  )

  it('refuses an asset upload issued as a raw request, on host grounds', async () => {
    const {client, wrapped} = wrapHosted()
    await expect(
      (wrapped.request as (o: Rec) => Promise<unknown>)({
        uri: `assets/images/${DS}`,
        method: 'POST',
        body: {},
      }),
    ).rejects.toThrow()
    expect(client.escaped).toEqual([])
  })

  it('still refuses client.assets.upload — no asset ever reaches Sanity', async () => {
    const {client, wrapped} = wrapHosted()
    await expect(
      ((wrapped.assets as Rec).upload as (a: string, b: string) => Promise<unknown>)('image', 'x'),
    ).rejects.toThrow()
    expect(client.escaped).toEqual([])
  })

  it('does NOT weaken the logout passthrough — the token must still be destroyed', async () => {
    const {client, wrapped} = wrapHosted()
    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/auth/logout', method: 'POST'})
    expect(client.escaped).toEqual(['request'])
  })

  it('does NOT weaken read delegation — a GET still reaches the client', async () => {
    const {client, wrapped} = wrapHosted()
    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: `/data/query/${DS}?query=*`})
    expect(client.escaped).toEqual(['request'])
  })

  it('does NOT refuse a write when the client points at a local proxy', async () => {
    /* Track B topology: `apiHost` is the proxy, so the very same path is not a
     * staging write. A host guard that ignored configuration would break it. */
    const errors: string[] = []
    const echo = createOverlayEcho({onError: (m) => errors.push(m)})
    const client = hostedFakeClient()
    client.getUrl = (uri: string) => `http://localhost:3999/v2025-02-19/${String(uri).replace(/^\//, '')}`
    const wrapped = wrapWithOverlay(client as unknown as object, {
      echo,
      transport: nullTransport(),
      onError: (m) => errors.push(m),
    }) as unknown as Rec

    await (wrapped.request as (o: Rec) => Promise<unknown>)({
      uri: '/users/me/keyvalue/studio-prefs',
      method: 'PUT',
      body: {},
    })
    expect(client.escaped).toEqual(['request'])
  })
})
