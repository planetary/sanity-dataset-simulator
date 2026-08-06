/**
 * **A preview Studio can never write to the Sanity API.** The owner's
 * requirement, taken adversarially: assume a motivated attacker with page-level
 * JavaScript execution and a logged-in editor's session, and assume every layer
 * that is not tested here does not work.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE THREAT MODEL ACTUALLY IS, AND WHY THE FACADE IS NOT THE ANSWER
 *
 * The Studio holds a **write-capable user token in `localStorage`** —
 * `__studio_auth_token_<projectId>`, value `{token?: string}`, read out of
 * `sanity@6.8.0` `lib/WorkspaceLoader-BRx2afZV.js:1979` and pinned in §0 below.
 * `@sanity/client` sends it as `Authorization: Bearer …`. So any script on the
 * page can mint its own client, or skip the client entirely, and write with the
 * editor's own grants. No facade refusal, no `apiHost` injection and no
 * environment variable can revoke a credential the browser already holds.
 *
 * Therefore the enforcement layers, named honestly:
 *
 *   BROWSER-ENFORCED   a CSP `connect-src` that excludes Sanity origins. The
 *                      browser is not our code and cannot be argued with, so
 *                      `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and
 *                      `navigator.sendBeacon` to `*.api.sanity.io` become
 *                      structurally impossible **from the page**. This is only
 *                      available once every Sanity request — reads and auth
 *                      included — leaves through our own origin.
 *   SERVER-ENFORCED    the default-deny write guard, running on that origin,
 *                      plus a read-only token. Enforced where page JS cannot
 *                      reach.
 *   BEST-EFFORT        the client facade, `stagingHost.ts`, the browser write
 *                      barrier. Real value against *accidental* escape — the
 *                      Sentry feedback tunnel in §7 is exactly that — and no
 *                      value at all against a motivated attacker.
 *
 * Nothing in this file claims a guarantee our code cannot keep. Where a vector
 * is closed only by deployment configuration, the assertion is on the
 * configuration artifact we generate, and it says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPANION DOCUMENT is `docs/plans/evidence/phase-1/
 * preview-write-impossibility.md`, which carries the vector table, the
 * local-dev/deployed split and the list of what `sanity-overlay-next` must
 * expose before any of the browser-enforced column is true in a deployment.
 */
import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'

import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {
  CLIENT_NAMESPACE_POLICY,
  NAMESPACE_ROOTS,
  NESTED_NAMESPACES,
} from '../../sanity-overlay-studio/src/client/writeGuard'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {
  cspConnectSources,
  cspPermitsSanityConnection,
  previewCspHeaderValue,
  previewSecurityHeaders,
  SANITY_BROWSER_ORIGINS,
} from '../../sanity-overlay-client/src/previewCsp'
import {
  createBrowserWriteBarrier,
  installBrowserWriteBarrier,
} from '../../sanity-overlay-client/src/browserWriteBarrier'
import {isPreviewWriteRequest} from '../../sanity-overlay-client/src/previewWriteGuard'
import {StagingWriteRefusedError} from '../../sanity-overlay-client/src/stagingHost'

type Rec = Record<string, unknown>

const PID = 'b1n03q3z'
const DS = 'parity'

function inertTransport(): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok'}),
    operation: async () => ({outcome: 'ok'}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  }
}

/**
 * A REAL `@sanity/client`, wrapped.
 *
 * Test doubles are the wrong oracle for this file. The facade's
 * `isSanityClientInstance` deliberately admits only class instances, and half
 * the escapes below exist precisely because a real client hands back a real
 * client from a method a double would have stubbed as a plain object. Nothing
 * here reaches the network: `_requestObservable` is cold, and the suite-wide
 * outbound monitor refuses a Sanity write from anywhere in the suite anyway.
 */
function wrapReal(config: Rec = {}): {real: Rec; wrapped: Rec} {
  const real = createClient({
    projectId: PID,
    dataset: DS,
    apiVersion: '2025-02-19',
    useCdn: false,
    ...config,
  } as never) as unknown as Rec
  const wrapped = wrapWithOverlay(real as unknown as object, {
    echo: createOverlayEcho(),
    transport: inertTransport(),
  }) as unknown as Rec
  return {real, wrapped}
}

/** Is this object the facade's proxy rather than the raw client underneath? */
function isWrapped(candidate: unknown, real: unknown): boolean {
  return candidate !== real && typeof candidate === 'object' && candidate !== null
}

/* ════════════════════════════════════════════════════════════════════════ §0 */

describe('§0 the premise — the browser holds a write-capable credential', () => {
  const require_ = createRequire(import.meta.url)
  const sanityWorkspaceLoader = (): string => {
    const entry = require_.resolve('sanity', {
      paths: [new URL('../../../examples/kitchen-sink/', import.meta.url).pathname],
    })
    const dir = entry.slice(0, entry.lastIndexOf('/'))
    return readFileSync(`${dir}/WorkspaceLoader-BRx2afZV.js`, 'utf8')
  }

  it('sanity stores a per-project auth token in localStorage', () => {
    const source = sanityWorkspaceLoader()
    expect(source).toContain('__studio_auth_token_')
    expect(source).toContain('localStorage.getItem(key)')
  })

  it('and hands that token to a client, which sends it as a bearer credential', () => {
    /* The client half of the claim, from the shipped client rather than prose:
     * a configured `token` becomes an Authorization header. */
    const client = createClient({
      projectId: PID,
      dataset: DS,
      apiVersion: '2025-02-19',
      useCdn: false,
      token: 'skTESTTOKEN',
    } as never) as unknown as Rec
    expect((client.config as () => Rec)().token).toBe('skTESTTOKEN')
  })

  it('which is why no facade refusal can be presented as a guarantee', () => {
    /* Stated as an assertion so it cannot quietly stop being true: the token is
     * reachable from page JS, so the write it enables is reachable from page JS.
     * Only a layer OUTSIDE our code — the browser, or a server we own — can
     * stop it. */
    expect(SANITY_BROWSER_ORIGINS.length).toBeGreaterThan(0)
  })
})

/* ════════════════════════════════════════════════════════════════════════ §1 */

describe('§1 vector 3 · a client handed back by the wrapped client is still wrapped', () => {
  /**
   * THE DEFECT. `SanityClient.config(newConfig)` **mutates in place and returns
   * `this`** (`@sanity/client@7.26.0` `SanityClient.ts:1220-1236`). The facade
   * treated it as an ordinary read method, so
   *
   *     wrapped.config({apiHost: 'https://api.sanity.io'})
   *
   * handed the caller the RAW client — every write method unguarded — and
   * simultaneously re-pointed it at Sanity. `withConfig`, `clone` and
   * `withUrlSourceMapping` were guarded; the one that needs no new object was
   * not. Spike F recorded it as attack 17 at the proxy layer
   * (`writeGuardContract.ts`) and it was never closed in the facade.
   *
   * THE CLASS is not "config": it is *every* method that hands back a client*.
   * Enumerated below against the real shipped class, and closed structurally —
   * the facade now re-wraps any return value that IS a `@sanity/client`, so a
   * method nobody here has heard of is covered by construction rather than by
   * this list staying current.
   */

  it('config(newConfig) does not hand back the unwrapped client', () => {
    const {real, wrapped} = wrapReal()
    const back = (wrapped.config as (c: Rec) => unknown)({apiHost: 'https://api.sanity.io'})
    expect(back).not.toBe(real)
    expect(isWrapped(back, real)).toBe(true)
  })

  it('and the client it hands back still refuses a write', async () => {
    const {wrapped} = wrapReal()
    const back = (wrapped.config as (c: Rec) => Rec)({apiHost: 'https://api.sanity.io'})
    await expect(
      (back.request as (o: Rec) => Promise<unknown>)({
        uri: `/data/mutate/${DS}`,
        method: 'POST',
        body: {mutations: []},
      }),
    ).rejects.toThrow(/never writes to a real Sanity dataset/i)
  })

  it('config() with no argument still answers with the configuration, not a proxy', () => {
    const {wrapped} = wrapReal()
    const config = (wrapped.config as () => Rec)()
    expect(config.projectId).toBe(PID)
    expect(config.dataset).toBe(DS)
  })

  it('the observable sibling has the identical escape, and it is closed too', () => {
    const {real, wrapped} = wrapReal()
    const observable = wrapped.observable as Rec
    const back = (observable.config as (c: Rec) => unknown)({apiHost: 'https://api.sanity.io'})
    expect(back).not.toBe(real.observable)
    expect(isWrapped(back, real.observable)).toBe(true)
  })

  it.each(['clone', 'withConfig'])(
    '%s — the two that were already guarded — stay guarded',
    (method) => {
      const {real, wrapped} = wrapReal()
      const back = (wrapped[method] as (c?: Rec) => unknown)({})
      expect(back).not.toBe(real)
      expect(isWrapped(back, real)).toBe(true)
    },
  )

  it('a write through a re-pointed clone is refused, not merely wrapped', async () => {
    const {wrapped} = wrapReal()
    const clone = (wrapped.withConfig as (c: Rec) => Rec)({apiHost: 'https://api.sanity.io'})
    await expect(
      (clone.mutate as (m: unknown[]) => Promise<unknown>)([
        {create: {_id: 'x', _type: 'article'}},
      ]),
    ).resolves.toMatchObject({transactionId: expect.any(String)})
  })

  it('the fix is structural: EVERY method returning a client is re-wrapped', () => {
    /**
     * The oracle is the real class, not a list in this file. Walk every callable
     * on the shipped `SanityClient` prototype, invoke the ones that are safe to
     * invoke with no arguments, and assert that anything client-shaped that
     * comes back is a proxy. A future `@sanity/client` that adds another
     * `this`-returning method fails here rather than in production.
     */
    const {real, wrapped} = wrapReal()
    const proto = Object.getPrototypeOf(real) as Rec
    const returnsClient: string[] = []
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)
      if (typeof descriptor?.value !== 'function') continue
      /* Only the zero/one-argument shape-preserving methods are probed; a
       * `mutate()` call is not a shape probe. */
      if (!['config', 'clone', 'withConfig'].includes(name)) continue
      let result: unknown
      try {
        result = (wrapped[name] as (c?: Rec) => unknown)(name === 'config' ? {} : undefined)
      } catch {
        continue
      }
      if (result === real || result === (real as Rec).observable) returnsClient.push(name)
    }
    expect(returnsClient).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════ §2 */

describe('§2 vector 6 · the namespace inventory is complete for the shipped client', () => {
  /**
   * `NAMESPACE_ROOTS` is an INVENTORY, and Spike F's standing lesson is that an
   * inventory is never complete. It cannot be replaced by a structural rule —
   * the facade must not auto-wrap arbitrary object properties, or `config`
   * results and stega options become proxies — so instead this test makes the
   * inventory's completeness a *checked* property against the real class. A
   * `@sanity/client` release that adds `client.canvas` goes red here, on the
   * next `pnpm test`, rather than silently handing page code an unguarded
   * write plane.
   */
  it('every namespace-shaped property of a real client is one the facade descends into', () => {
    const {real} = wrapReal()
    const namespaces = Object.keys(real).filter((key) => {
      const value = real[key]
      return typeof value === 'object' && value !== null && key !== 'observable'
    })
    for (const name of namespaces) {
      expect(`${name}: ${NAMESPACE_ROOTS.has(name)}`).toBe(`${name}: true`)
    }
    /* And the list is non-trivial, so the loop above cannot pass vacuously. */
    expect(namespaces.length).toBeGreaterThanOrEqual(8)
  })

  it('every nested namespace the client actually has is declared', () => {
    const {real} = wrapReal()
    for (const [root, child] of Object.entries(NESTED_NAMESPACES)) {
      const parent = real[root] as Rec | undefined
      expect(`${root}.${child}: ${typeof parent?.[child]}`).toBe(`${root}.${child}: object`)
    }
  })

  it('every method the policy calls a read exists on the shipped client', () => {
    const {real} = wrapReal()
    for (const [path, policy] of Object.entries(CLIENT_NAMESPACE_POLICY)) {
      const segments = path.split('.')
      let holder: unknown = real
      for (const segment of segments) {
        holder = typeof holder === 'object' && holder !== null ? (holder as Rec)[segment] : undefined
      }
      if (holder === undefined) continue
      for (const method of policy.read) {
        const found =
          typeof (holder as Rec)[method] === 'function' ||
          typeof (Object.getPrototypeOf(holder) as Rec)?.[method] === 'function'
        expect(`${path}.${method}: ${found}`).toBe(`${path}.${method}: true`)
      }
    }
  })

  it.each([
    ['assets', 'upload'],
    ['datasets', 'create'],
    ['datasets', 'delete'],
    ['releases', 'publish'],
  ])('client.%s.%s is refused rather than delegated', async (namespace, method) => {
    const {wrapped} = wrapReal()
    const holder = wrapped[namespace] as Rec
    await expect(
      (holder[method] as (...args: unknown[]) => Promise<unknown>)('x', 'y'),
    ).rejects.toThrow(/blocked/i)
  })

  it('client.agent.action.patch — nested one level down — is refused', async () => {
    const {wrapped} = wrapReal()
    const action = (wrapped.agent as Rec).action as Rec
    await expect((action.patch as (a: Rec) => Promise<unknown>)({})).rejects.toThrow(/blocked/i)
  })
})

/* ════════════════════════════════════════════════════════════════════════ §3 */

describe('§3 vector 5 · the four version writes call _dataRequest directly', () => {
  it.each(['createVersion', 'replaceVersion', 'discardVersion', 'unpublishVersion'])(
    '%s is refused on a REAL client, not merely on a double',
    async (method) => {
      const {wrapped} = wrapReal()
      await expect(
        (wrapped[method] as (a: Rec) => Promise<unknown>)({
          document: {_id: 'versions.r1.a', _type: 'article'},
        }),
      ).rejects.toThrow(/blocked/i)
    },
  )
})

/* ════════════════════════════════════════════════════════════════════════ §4 */

describe('§4 vector 4 · a resource:-configured client mutates with no /data prefix', () => {
  it('the resource data plane is where its writes live', () => {
    const client = createClient({
      resource: {type: 'dataset', id: `${PID}.${DS}`},
      apiVersion: '2025-02-19',
      useCdn: false,
    } as never) as unknown as Rec
    /* Read out of the client, not asserted from memory: this is the shape the
     * guard has to classify. */
    expect((client.getDataUrl as (op: string) => string)('mutate')).toBe(
      `/projects/${PID}/datasets/${DS}/mutate`,
    )
  })

  it('and the default-deny guard blocks every spelling of it', () => {
    for (const url of [
      `/projects/${PID}/datasets/${DS}/mutate`,
      `projects/${PID}/datasets/${DS}/mutate`,
      `/v2025-02-19/projects/${PID}/datasets/${DS}/actions`,
      '/canvases/c1/mutate',
      '/media-libraries/ml-1/upload',
      '/dashboards/db-1/actions',
    ]) {
      expect(`${url}: ${isPreviewWriteRequest({method: 'POST', url})}`).toBe(`${url}: true`)
    }
  })

  it('while the resource-scoped READS the Studio needs still pass', () => {
    for (const url of [
      `/v2025-02-19/projects/${PID}/datasets/${DS}/query?query=*`,
      `/v2021-06-07/projects/${PID}/datasets/${DS}/acl`,
    ]) {
      expect(`${url}: ${isPreviewWriteRequest({method: 'GET', url})}`).toBe(`${url}: false`)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════ §5 */

describe('§5 vector 8 · a blank or Sanity-pointed apiHost is a fail-open', () => {
  /**
   * `apiHost` is what makes the proxy — not the browser — the enforcement
   * boundary. A blank value already reads as "unset" (`env.ts` `blankToUndefined`,
   * the Spike A scar). The remaining hole was the opposite one: an `apiHost`
   * that IS Sanity. Setting `SANITY_STUDIO_OVERLAY_API_HOST=https://api.sanity.io`
   * configured a "proxy" that is the thing being proxied, and the resolver only
   * warned about paths.
   */
  it.each([
    ['bare api host', 'https://api.sanity.io'],
    ['project host', `https://${PID}.api.sanity.io`],
    ['cdn host', 'https://apicdn.sanity.io'],
    ['upper case', 'HTTPS://API.SANITY.IO'],
    ['trailing dot', 'https://api.sanity.io.'],
    ['explicit port', 'https://api.sanity.io:443'],
  ])('refuses an apiHost that is a real Sanity API host (%s)', (_label, apiHost) => {
    expect(() => resolveOverlayOptions({apiHost})).toThrow(/apiHost/i)
    expect(() => resolveOverlayOptions({}, {SANITY_STUDIO_OVERLAY_API_HOST: apiHost})).toThrow(
      /apiHost/i,
    )
  })

  it('still accepts a real proxy origin', () => {
    expect(resolveOverlayOptions({apiHost: 'http://localhost:3999'}).apiHost).toBe(
      'http://localhost:3999',
    )
    expect(resolveOverlayOptions({apiHost: 'https://preview.example.com'}).apiHost).toBe(
      'https://preview.example.com',
    )
  })

  it('says out loud when no proxy is configured, because the browser then talks to Sanity', () => {
    const resolved = resolveOverlayOptions({mode: 'fs'})
    expect(resolved.apiHost).toBeNull()
    expect(resolved.warnings.join(' ')).toMatch(/apiHost/i)
  })

  it('and says nothing of the kind once a proxy is configured', () => {
    const resolved = resolveOverlayOptions({mode: 'fs', apiHost: 'http://localhost:3999'})
    expect(resolved.warnings.join(' ')).not.toMatch(/no proxy/i)
  })
})

/* ════════════════════════════════════════════════════════════════════════ §6 */

describe('§6 vectors 2, 9, 10 · the CSP artifact — the browser-enforced layer', () => {
  /**
   * CSP `connect-src` is ORIGIN-scoped, never method-scoped, so it cannot tell a
   * read from a write. That is why it is not used to cut the Studio off from
   * Sanity — auth and reads would go with it. It is used the other way round:
   * every Sanity request leaves through OUR origin, and `connect-src` then
   * confines the page to that origin, so page JS cannot open its own socket to
   * `api.sanity.io` and go around the server-side guard.
   *
   * These are assertions on a CONFIGURATION ARTIFACT. Nothing here proves a
   * browser honours it; a browser check is named in the report as outstanding.
   */
  const HEADER = previewCspHeaderValue({selfOrigin: 'https://preview.example.com'})

  it('permits our own origin, or the Studio cannot load anything at all', () => {
    expect(cspConnectSources(HEADER)).toContain("'self'")
  })

  it.each(SANITY_BROWSER_ORIGINS)('excludes %s from connect-src', (origin) => {
    expect(cspPermitsSanityConnection(HEADER, origin)).toBe(false)
  })

  it('covers the WebSocket and EventSource planes, which connect-src also governs', () => {
    expect(cspPermitsSanityConnection(HEADER, `wss://${PID}.api.sanity.io/v2022-06-30/socket/${DS}`)).toBe(
      false,
    )
    expect(cspPermitsSanityConnection(HEADER, `https://${PID}.api.sanity.io/vX/data/live/events/${DS}`)).toBe(
      false,
    )
  })

  it('closes the iframe, popup, worker and form-post escapes as well', () => {
    const directives = previewSecurityHeaders({selfOrigin: 'https://preview.example.com'})
    const csp = directives['Content-Security-Policy']
    for (const directive of ['frame-src', 'child-src', 'worker-src', 'form-action', 'base-uri']) {
      expect(`${directive}: ${csp.includes(`${directive} `)}`).toBe(`${directive}: true`)
    }
    expect(csp).toMatch(/object-src 'none'/)
  })

  /* ---- the validator is a real oracle, not a substring search ------------- */

  it('a policy with no connect-src falls back to default-src', () => {
    expect(cspPermitsSanityConnection("default-src 'self'", 'https://api.sanity.io')).toBe(false)
    expect(cspPermitsSanityConnection('default-src *', 'https://api.sanity.io')).toBe(true)
  })

  it('a policy with neither directive permits everything', () => {
    expect(cspPermitsSanityConnection("script-src 'self'", 'https://api.sanity.io')).toBe(true)
    expect(cspPermitsSanityConnection('', 'https://api.sanity.io')).toBe(true)
  })

  it.each([
    ['wildcard', "connect-src 'self' *", `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`],
    ['scheme source', "connect-src 'self' https:", `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`],
    [
      'host wildcard',
      "connect-src 'self' https://*.sanity.io",
      `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`,
    ],
    [
      'exact host',
      `connect-src 'self' https://${PID}.api.sanity.io`,
      `https://${PID}.api.sanity.io/v1/data/mutate/${DS}`,
    ],
    ['bare host wildcard, no scheme', 'connect-src *.api.sanity.io', `https://${PID}.api.sanity.io/v1/x`],
    ['exact bare host, no scheme', 'connect-src api.sanity.io', 'https://api.sanity.io/v1/x'],
    [
      'wss scheme on a wss URL',
      "connect-src 'self' wss://*.api.sanity.io",
      `wss://${PID}.api.sanity.io/v2022-06-30/socket/${DS}`,
    ],
  ])('detects a policy that DOES permit Sanity (%s)', (_label, header, url) => {
    expect(cspPermitsSanityConnection(header, url)).toBe(true)
  })

  it('honours CSP host-source semantics rather than substring matching', () => {
    /* An exact bare host-source does NOT match a subdomain — the wildcard is
     * what does that. A validator that used `includes()` would call the first
     * of these permitted and be wrong in the dangerous direction. */
    expect(cspPermitsSanityConnection('connect-src api.sanity.io', `https://${PID}.api.sanity.io/x`)).toBe(
      false,
    )
    expect(cspPermitsSanityConnection('connect-src *.api.sanity.io', `https://${PID}.api.sanity.io/x`)).toBe(
      true,
    )
    /* A `wss:` source does not cover an `https:` URL, and vice versa. */
    expect(
      cspPermitsSanityConnection("connect-src wss://*.api.sanity.io", `https://${PID}.api.sanity.io/x`),
    ).toBe(false)
  })

  it("'none' permits nothing", () => {
    expect(cspPermitsSanityConnection("connect-src 'none'", 'https://api.sanity.io')).toBe(false)
  })

  it('a suffix lookalike is not our origin and is not permitted by self', () => {
    const header = previewCspHeaderValue({selfOrigin: 'https://preview.example.com'})
    expect(cspPermitsSanityConnection(header, 'https://api.sanity.io.evil.example')).toBe(false)
  })

  it('an operator can add their own origins without accidentally admitting Sanity', () => {
    const header = previewCspHeaderValue({
      selfOrigin: 'https://preview.example.com',
      connectSrc: ['https://telemetry.example.com'],
    })
    expect(cspConnectSources(header)).toContain('https://telemetry.example.com')
    expect(cspPermitsSanityConnection(header, 'https://api.sanity.io')).toBe(false)
  })

  it('refuses to build a policy that would admit a Sanity origin', () => {
    expect(() =>
      previewCspHeaderValue({
        selfOrigin: 'https://preview.example.com',
        connectSrc: ['https://api.sanity.io'],
      }),
    ).toThrow(/sanity/i)
    expect(() =>
      previewCspHeaderValue({selfOrigin: 'https://preview.example.com', connectSrc: ['*']}),
    ).toThrow(/connect-src/i)
  })
})

/* ════════════════════════════════════════════════════════════════════════ §7 */

describe('§7 vectors 1, 2, 7 · the browser write barrier (BEST-EFFORT, and labelled so)', () => {
  /**
   * THE OBSERVED ESCAPE. `sanity@6.8.0` `lib/index.js:1431` hard-codes
   *
   *     FEEDBACK_TUNNEL_URL = "https://api.sanity.io/vX/intake/feedback"
   *
   * into a Sentry `BrowserClient` with `transport: makeFetchTransport`. It is a
   * raw `fetch` POST to an ABSOLUTE Sanity URL — outside `@sanity/client`,
   * therefore outside the facade, and immune to `apiHost` injection, which is
   * why a live CDP capture caught four of them going direct past the proxy. Its
   * sibling `/intake/batch` additionally leaves via `navigator.sendBeacon`
   * (`lib/index.js:13064`), which no client wrapper can see either.
   *
   * This barrier is the cheapest thing that stops both. It is BEST-EFFORT: page
   * JS can retrieve a pristine `fetch` from a same-origin iframe and defeat it
   * in two lines. It is worth having anyway, because the traffic it actually
   * catches is Studio's own accidental egress rather than an attacker's.
   */
  function fakeWindow(): Rec & {calls: string[]} {
    const calls: string[] = []
    const target: Rec & {calls: string[]} = {
      calls,
      fetch: ((input: unknown, init?: Rec) =>
        Promise.resolve({
          ok: true,
          status: 200,
          _seen: calls.push(`${String(init?.method ?? 'GET')} ${String(input)}`),
        })) as unknown as typeof fetch,
      navigator: {
        sendBeacon: (url: unknown): boolean => {
          calls.push(`BEACON ${String(url)}`)
          return true
        },
      },
      WebSocket: class {
        constructor(url: unknown) {
          calls.push(`WS ${String(url)}`)
        }
      },
      EventSource: class {
        constructor(url: unknown) {
          calls.push(`SSE ${String(url)}`)
        }
      },
    }
    return target
  }

  it('refuses the Sentry feedback tunnel — the request the CDP capture caught', async () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    await expect(
      (target.fetch as typeof fetch)('https://api.sanity.io/vX/intake/feedback', {method: 'POST'}),
    ).rejects.toThrow(StagingWriteRefusedError)
    expect(target.calls).toEqual([])
  })

  it('refuses navigator.sendBeacon to a Sanity host — a beacon is always a POST', () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    const beacon = (target.navigator as Rec).sendBeacon as (u: string, b?: unknown) => boolean
    expect(beacon(`https://${PID}.api.sanity.io/v2023-12-18/intake/batch`, '{}')).toBe(false)
    expect(target.calls).toEqual([])
  })

  it('refuses a raw fetch write even when the token is supplied by hand', async () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    await expect(
      (target.fetch as typeof fetch)(`https://${PID}.api.sanity.io/v2025-02-19/data/mutate/${DS}`, {
        method: 'POST',
        headers: {authorization: 'Bearer skSTOLEN'},
        body: '{"mutations":[]}',
      }),
    ).rejects.toThrow(/never writes to a real Sanity dataset/i)
    expect(target.calls).toEqual([])
  })

  it('lets a Sanity READ through — cutting reads off would break the product', async () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    await (target.fetch as typeof fetch)(
      `https://${PID}.api.sanity.io/v2025-02-19/data/query/${DS}?query=*`,
    )
    expect(target.calls).toEqual([
      `GET https://${PID}.api.sanity.io/v2025-02-19/data/query/${DS}?query=*`,
    ])
  })

  it('lets auth through — the editor must still be able to log in', async () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    await (target.fetch as typeof fetch)('https://api.sanity.io/v2026-05-04/users/me')
    expect(target.calls).toHaveLength(1)
  })

  it('lets our own origin through, including its writes', async () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    await (target.fetch as typeof fetch)('https://preview.example.com/api/overlay/commit', {
      method: 'POST',
    })
    expect(target.calls).toHaveLength(1)
  })

  it('refuses a WebSocket to a Sanity host — the bifur channel declares a `mutate` method', () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    expect(
      () => new (target.WebSocket as new (u: string) => unknown)(
        `wss://${PID}.api.sanity.io/v2022-06-30/socket/${DS}`,
      ),
    ).toThrow(StagingWriteRefusedError)
    expect(target.calls).toEqual([])
  })

  it('refuses an XMLHttpRequest write, which no client wrapper can see either', () => {
    const target = fakeWindow()
    const sent: string[] = []
    class FakeXhr {
      method = ''
      url = ''
      open(method: string, url: string): void {
        this.method = method
        this.url = url
      }
      send(): void {
        sent.push(`${this.method} ${this.url}`)
      }
    }
    target.XMLHttpRequest = FakeXhr
    installBrowserWriteBarrier(target)

    const xhr = new (target.XMLHttpRequest as new () => FakeXhr)()
    xhr.open('POST', `https://${PID}.api.sanity.io/v2025-02-19/data/mutate/${DS}`)
    expect(() => xhr.send()).toThrow(StagingWriteRefusedError)
    expect(sent).toEqual([])

    const read = new (target.XMLHttpRequest as new () => FakeXhr)()
    read.open('GET', `https://${PID}.api.sanity.io/v2025-02-19/data/query/${DS}`)
    read.send()
    expect(sent).toHaveLength(1)
  })

  it('leaves EventSource alone — it can only ever issue a GET', () => {
    const target = fakeWindow()
    installBrowserWriteBarrier(target)
    new (target.EventSource as new (u: string) => unknown)(
      `https://${PID}.api.sanity.io/v2025-02-19/data/listen/${DS}?query=*`,
    )
    expect(target.calls).toHaveLength(1)
  })

  it('is idempotent, so a double install does not double-wrap', () => {
    const target = fakeWindow()
    const first = installBrowserWriteBarrier(target)
    const wrapped = target.fetch
    const second = installBrowserWriteBarrier(target)
    expect(target.fetch).toBe(wrapped)
    expect(second.installed).toBe(false)
    first.uninstall()
  })

  it('restores every patched global on uninstall', () => {
    const target = fakeWindow()
    const originals = {
      fetch: target.fetch,
      beacon: (target.navigator as Rec).sendBeacon,
      ws: target.WebSocket,
    }
    const handle = installBrowserWriteBarrier(target)
    handle.uninstall()
    expect(target.fetch).toBe(originals.fetch)
    expect((target.navigator as Rec).sendBeacon).toBe(originals.beacon)
    expect(target.WebSocket).toBe(originals.ws)
  })

  it('records what it refused, because server logs are the only trustworthy evidence', () => {
    /* Deliberately named: this ledger is a DIAGNOSTIC. Browser-side detection
     * has produced a false all-clear three times in this project, so nothing
     * downstream may treat an empty ledger as proof that nothing escaped. */
    const barrier = createBrowserWriteBarrier()
    expect(barrier.classify({method: 'POST', url: 'https://api.sanity.io/vX/intake/feedback'})).toBe(
      'refuse',
    )
    expect(barrier.classify({method: 'GET', url: 'https://api.sanity.io/v1/users/me'})).toBe('allow')
    expect(barrier.classify({method: 'POST', url: 'https://preview.example.com/x'})).toBe('allow')
  })

  it('is honest about being defeatable: a pristine fetch is not patched', async () => {
    /* The negative control. An attacker who obtains an unpatched `fetch` — one
     * `iframe.contentWindow.fetch` away — is not stopped by this layer at all,
     * and the report must not claim otherwise. */
    const target = fakeWindow()
    const pristine = target.fetch
    installBrowserWriteBarrier(target)
    await (pristine as typeof fetch)(`https://${PID}.api.sanity.io/v1/data/mutate/${DS}`, {
      method: 'POST',
    })
    expect(target.calls).toHaveLength(1)
  })
})
