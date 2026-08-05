/**
 * SPIKE A — client-facade IDENTITY STABILITY and the D13 hybrid topology.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Two claims in the Phase-1 evidence had no test behind them:
 *
 *  1. "A naive wrapper caused a ~40,000-call resubscribe storm and a black
 *     screen" (`spike-a-studio-interception/report.md:10`, restated as a design
 *     rule in `instrumentedClient.ts:49-53`). The adversarial review lists it
 *     under "claims I could not check" — a historical browser observation with
 *     no artifact. The mitigation is visible in code; the failure it prevents
 *     was not reproducible from the repo.
 *
 *  2. D13's stated differentiator — "the factory injects `apiHost` only (no
 *     method wrapping ⇒ no identity hazard)" — was **false in the code**
 *     (evidence review F2): `spikeClientFactory` returned `instrument(base, …)`
 *     unconditionally.
 *
 * This file turns both into executable evidence.
 *
 * THE ORACLE IS NOT THE FACADE
 * ────────────────────────────
 * Every identity bound here is checked against two independent references:
 *
 *  - the REAL `@sanity/client` (`createClient`), whose identity semantics are
 *    measured, not assumed; and
 *  - `naivelyInstrument()` below — a deliberately identity-unstable wrapper of
 *    exactly the pre-fix shape (fresh function per property access, no memo).
 *    It is the negative control: every bound asserted for the real factory is
 *    ALSO asserted to be violated by the naive wrapper, at a specific number.
 *    If the oracle ever stops being able to see the storm, the control goes red.
 *
 * STUDIO'S REAL ACCESS PATTERNS (sanity 6.8.0, read out of the installed lib)
 * ──────────────────────────────────────────────────────────────────────────
 *  - `lib/LiveQueries-rJao7vYj.js:36-45`
 *        useEffect(() => { client.live.events(…).subscribe(…) }, [client.live])
 *    A React effect whose dependency is a property READ OFF THE CLIENT ON EVERY
 *    RENDER. This is the storm mechanism in one line: if that read is not
 *    identity-stable the effect tears down and re-subscribes every render, the
 *    subscription dispatches, the dispatch re-renders — unbounded.
 *  - `lib/WorkspaceLoader-BRx2afZV.js:8306`
 *        getClient = (o) => clients[o.apiVersion] ||= client.withConfig(o)
 *    Studio memoises `withConfig` per apiVersion. Reproduced verbatim below.
 *  - `lib/studioClient-Bqe3Wt6s.js:63-72`
 *        useClient(opts) -> source.getClient(opts)
 *    Callers pass a fresh `{apiVersion}` literal per render, so `getClient` is
 *    re-entered on every render and only the memo keeps identity stable.
 *  - `lib/WorkspaceLoader-BRx2afZV.js:8286-8298`
 *        clientFactory: (config) => _clientFactory({...config, _requestHandler})
 *    the `unstable_clientFactory` seam under test.
 *
 * NO BROWSER. Everything here is Node: `@sanity/client`'s observable API is
 * lazy (`localEcho.ts:374-378`), so building a request observable and dropping
 * it makes no network call.
 */
import {types} from 'node:util'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createClient, type ClientConfig, type SanityClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'

/**
 * The decisive oracle for "is a method wrapper in the way?". A Proxy is
 * transparent to every JS-level check — `typeof`, `instanceof`, the prototype
 * chain, `Object.keys` all forward — so an assertion like `client.fetch ===
 * createClient(cfg).fetch` is the only *portable* probe, and it cannot be used
 * across a `vi.resetModules()` boundary (the two module instances carry
 * different `SanityClient` classes). `util.types.isProxy` answers directly.
 */
const isProxy = types.isProxy

/* ───────────────────────────────────────────────────── browser-global stubs */

interface StubWindow {
  __SPIKE_A__?: {calls: unknown[]; configs: unknown[]; factoryInvocations: number}
  __SPIKE_ECHO__?: {blocked: {method: string; handled: boolean}[]; errors: string[]}
  localStorage: StubStorage
}

class StubStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new StubStorage()
const win: StubWindow = {localStorage: storage}
/* Installed before the first import of the spike modules: `localEcho.ts` reads
 * `window.localStorage` and `instrumentedClient.ts` reads the bare global. */
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).localStorage = storage

type FactoryModule = typeof import('../../../examples/kitchen-sink/spikeA/instrumentedClient')

/**
 * Load a FRESH copy of the factory under a given flag set.
 *
 * `localEcho.isEchoEnabled()` caches its answer for the lifetime of the module
 * (by design — a mid-session flip would leave the revision chain half
 * synthetic), and `instrument`'s caches are module-level WeakMaps. So a flag
 * combination can only be exercised on a module instance that has never seen
 * another one.
 */
async function loadFactory(flags: Record<string, string> = {}): Promise<FactoryModule> {
  storage.clear()
  for (const [key, value] of Object.entries(flags)) storage.setItem(key, value)
  win.__SPIKE_A__ = undefined
  win.__SPIKE_ECHO__ = undefined
  vi.resetModules()
  /* Literal specifier on purpose — Vite only rewrites dynamic imports it can
   * see, and `vi.resetModules()` guarantees this re-evaluates the module. */
  return import('../../../examples/kitchen-sink/spikeA/instrumentedClient')
}

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

/* ─────────────────────────────────────────── the negative control (unstable) */

/**
 * The pre-fix wrapper, reconstructed: a Proxy that mints a NEW function on
 * every property access and a NEW sub-proxy for `observable`. Nothing else
 * about it is wrong — it forwards correctly and logs correctly. Identity is the
 * only defect, and identity alone is enough to produce the storm.
 */
function naivelyInstrument<T extends object>(target: T, meter: {calls: number}): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop)
      if (prop === 'observable' && typeof value === 'object' && value !== null) {
        return naivelyInstrument(value as object, meter)
      }
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        meter.calls += 1
        return (value as (...a: unknown[]) => unknown).apply(t, args)
      }
    },
  }) as T
}

/* ───────────────────────────────────────────────── the render/resubscribe oracle */

/**
 * How many renders the storm simulation runs. Chosen so the negative control
 * reproduces the historically observed magnitude: the pair listener issues two
 * client calls per subscribe (`getDocuments` for the snapshot, then `listen` —
 * `localEcho.ts:21-28`), so 20 000 unstable renders ⇒ 40 000 client calls, the
 * "~40k" of `report.md:10`.
 */
const RENDERS = 20_000

/** The bound. One subscribe for the mount, none after. Not "few" — one. */
const MAX_RESUBSCRIBES = 1
/** Two client calls per subscribe, so one subscribe ⇒ exactly two calls. */
const MAX_CLIENT_CALLS = 2

interface StormResult {
  resubscribes: number
  clientCalls: number
}

/**
 * React's effect semantics, modelled literally: an effect re-runs when ANY
 * entry of its dependency array fails `Object.is` against the previous render.
 * `readDeps` is re-evaluated per render, exactly as `[client.live]` is.
 *
 * `subscribe` is the effect body; it performs the two pair-listener calls so
 * the result carries a call count, not just a render count.
 */
function simulateStudio(
  readDeps: () => readonly unknown[],
  subscribe: () => void,
  renders = RENDERS,
): StormResult {
  let previous: readonly unknown[] | null = null
  let resubscribes = 0
  let calls = 0
  for (let i = 0; i < renders; i++) {
    const deps = readDeps()
    const changed =
      previous === null ||
      deps.length !== previous.length ||
      deps.some((dep, index) => !Object.is(dep, (previous as readonly unknown[])[index]))
    if (changed) {
      resubscribes += 1
      const before = calls
      subscribe()
      calls = before + 2
    }
    previous = deps
  }
  return {resubscribes, clientCalls: calls}
}

/** The two calls Studio's pair listener makes on every (re)subscribe. */
function pairListenerSubscribe(client: SanityClient): void {
  /* Both are cold observables — constructed and dropped, never subscribed. */
  client.observable.getDocuments(['article-11', 'drafts.article-11'])
  client.observable.listen('*[_id in $ids]', {ids: ['article-11']})
}

/** The widest dependency tuple any Studio effect can form from one client. */
function studioDeps(client: SanityClient): readonly unknown[] {
  return [
    client,
    (client as unknown as Record<string, unknown>).live,
    client.observable,
    client.observable.listen,
    client.observable.getDocuments,
    client.fetch,
  ]
}

function distinct<T>(read: () => T, times: number): Set<T> {
  const seen = new Set<T>()
  for (let i = 0; i < times; i++) seen.add(read())
  return seen
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('spike A · the oracle can see the storm (negative control)', () => {
  it('reports one subscribe for a dependency tuple that never changes', () => {
    const frozen = [Symbol('client'), Symbol('live')]
    const result = simulateStudio(
      () => frozen,
      () => {},
    )
    expect(result.resubscribes).toBe(1)
    expect(result.clientCalls).toBe(2)
  })

  it('reports one subscribe PER RENDER when a dependency is freshly allocated', () => {
    const result = simulateStudio(
      () => [{}],
      () => {},
    )
    expect(result.resubscribes).toBe(RENDERS)
  })

  it(
    'reproduces the ~40k-call storm against an identity-unstable wrapper',
    {timeout: 120_000},
    () => {
      const meter = {calls: 0}
      const unstable = naivelyInstrument(createClient(CONFIG), meter)

      const result = simulateStudio(
        () => studioDeps(unstable),
        () => pairListenerSubscribe(unstable),
      )

      /* Every render tears the effect down and re-subscribes. */
      expect(result.resubscribes).toBe(RENDERS)
      /* 20 000 subscribes x 2 pair-listener calls = the historical figure. */
      expect(result.clientCalls).toBe(40_000)
      /* Independent of the model: the wrapper's own meter counts the calls it
       * really forwarded to the real client, deps included. */
      expect(meter.calls).toBeGreaterThanOrEqual(40_000)
    },
  )

  it('shows the instability is per-property-access, not per-client', () => {
    const meter = {calls: 0}
    const unstable = naivelyInstrument(createClient(CONFIG), meter)
    expect(distinct(() => unstable.fetch, 500).size).toBe(500)
    expect(distinct(() => unstable.observable, 500).size).toBe(500)
  })
})

describe('spike A · spikeClientFactory is identity-stable (Track A / echo topologies)', () => {
  let factory: FactoryModule
  let client: SanityClient

  beforeEach(async () => {
    factory = await loadFactory({SPIKE_INSTRUMENT: '1'})
    client = factory.spikeClientFactory({...CONFIG})
  })

  it('survives 20 000 renders with exactly one subscribe and two client calls', () => {
    const result = simulateStudio(
      () => studioDeps(client),
      () => pairListenerSubscribe(client),
    )
    expect(result.resubscribes).toBe(MAX_RESUBSCRIBES)
    expect(result.clientCalls).toBe(MAX_CLIENT_CALLS)
    /* Independent oracle: the instrumentation log the browser evidence reads.
     * One subscribe means two logged calls, not 40 000. */
    expect(win.__SPIKE_A__?.calls).toHaveLength(MAX_CLIENT_CALLS)
  })

  it.each([
    'fetch',
    'listen',
    'patch',
    'transaction',
    'mutate',
    'create',
    'createOrReplace',
    'createIfNotExists',
    'delete',
    'getDocument',
    'getDocuments',
    'action',
    'dataRequest',
    'request',
    'withConfig',
    'clone',
    'config',
    'getUrl',
    'getDataUrl',
  ])('returns one identity for repeated access to client.%s', (member) => {
    const source = client as unknown as Record<string, unknown>
    expect(typeof source[member]).toBe('function')
    expect(distinct(() => source[member], 5_000).size).toBe(1)
  })

  it.each(['listen', 'fetch', 'action', 'getDocuments', 'request', 'mutate'])(
    'returns one identity for repeated access to client.observable.%s',
    (member) => {
      expect(distinct(() => client.observable, 5_000).size).toBe(1)
      const source = client.observable as unknown as Record<string, unknown>
      expect(typeof source[member]).toBe('function')
      expect(distinct(() => source[member], 5_000).size).toBe(1)
    },
  )

  it.each([
    ['live', 'events'],
    ['assets', 'upload'],
    ['datasets', 'create'],
    ['releases', 'get'],
    ['projects', 'list'],
    ['users', 'getById'],
  ])('leaves the client.%s namespace un-instrumented', (member, method) => {
    const source = client as unknown as Record<string, unknown>
    expect(typeof source[member]).toBe('object')
    expect(distinct(() => source[member], 5_000).size).toBe(1)
    /* `instrument` descends into `observable` and nothing else, so these
     * namespaces are raw objects with raw methods. That is why
     * `client.assets.upload` sits OUTSIDE the facade — the open item recorded
     * against D01, and Spike F gap 21. Pinned, not endorsed.
     *
     * Oracle: an instrumented method is the closure named `wrapped`
     * (`instrumentedClient.ts:82`); a raw one keeps its own name. */
    expect(isProxy(source[member])).toBe(false)
    const namespace = source[member] as Record<string, unknown>
    expect(typeof namespace[method]).toBe('function')
    expect((namespace[method] as {name: string}).name).not.toBe('wrapped')
    /* Contrast, so the oracle is not vacuous: the client's own methods ARE. */
    expect((client.fetch as unknown as {name: string}).name).toBe('wrapped')
    expect(isProxy(client)).toBe(true)
  })

  it('is stable through the withConfig chain Studio uses for the Actions API', () => {
    /* `localEcho.ts:1145-1148`: Studio reaches the Actions API through
     * `client.withConfig({apiVersion}).observable.action(...)`. */
    const versioned = client.withConfig({apiVersion: '2025-02-19'})
    expect(distinct(() => versioned.observable, 5_000).size).toBe(1)
    expect(distinct(() => versioned.observable.action, 5_000).size).toBe(1)
    expect(distinct(() => versioned.fetch, 5_000).size).toBe(1)
  })

  it("is stable through Studio's memoised getClient (WorkspaceLoader:8306)", () => {
    /* Verbatim reproduction of Studio's per-apiVersion memo. */
    const clients: Record<string, SanityClient> = {}
    const getClient = (options: {apiVersion: string}): SanityClient => {
      if (!options || !options.apiVersion) throw new Error('Missing required `apiVersion` option')
      clients[options.apiVersion] ||= client.withConfig(options)
      return clients[options.apiVersion] as SanityClient
    }
    /* `useClient` passes a FRESH literal every render (studioClient:70), so the
     * memo is re-entered 20 000 times. */
    const result = simulateStudio(
      () => studioDeps(getClient({apiVersion: '2025-02-19'})),
      () => pairListenerSubscribe(getClient({apiVersion: '2025-02-19'})),
    )
    expect(result.resubscribes).toBe(MAX_RESUBSCRIBES)
    expect(result.clientCalls).toBe(MAX_CLIENT_CALLS)
  })

  it('keeps clone() results identity-stable', () => {
    const cloned = client.clone()
    expect(distinct(() => cloned.fetch, 5_000).size).toBe(1)
    expect(distinct(() => cloned.observable.listen, 5_000).size).toBe(1)
  })

  it('stays identity-stable with the local-echo facade underneath', async () => {
    const echoFactory = await loadFactory({SPIKE_INSTRUMENT: '1', SPIKE_LOCAL_ECHO: '1'})
    const echoed = echoFactory.spikeClientFactory({...CONFIG})
    const result = simulateStudio(
      () => studioDeps(echoed),
      () => pairListenerSubscribe(echoed),
    )
    expect(result.resubscribes).toBe(MAX_RESUBSCRIBES)
    expect(result.clientCalls).toBe(MAX_CLIENT_CALLS)
    expect(distinct(() => echoed.observable.action, 5_000).size).toBe(1)
  })
})

describe('spike A · the identity guarantee the facade does NOT restore', () => {
  /**
   * Measured, not assumed: the real client's methods live on
   * `SanityClient.prototype`, so method identity is GLOBAL — every instance,
   * and every `withConfig` result, shares one function object. Wrapping
   * downgrades that to per-instance, because each wrapper closes over its own
   * target.
   *
   * This is safe today only because every client Studio puts in a dependency
   * array comes from the memoised `getClient` (WorkspaceLoader:8306) — pinned
   * green above. It stops being safe the moment a Studio path reads a method
   * off an UNMEMOISED `withConfig` result into a dep array; `versionedClient`
   * (studioClient:83) is exactly that shape, and today its callers only use it
   * inside observable factories (datastores-DqFH7RLd.js:745, 749, 909).
   *
   * Recorded here so the gap is a number in the suite rather than a paragraph
   * in a report, and so a future change to the wrapper is forced to confront it.
   */
  it('real @sanity/client method identity is prototype-global', () => {
    const a = createClient(CONFIG)
    const b = createClient(CONFIG)
    expect(a.fetch).toBe(b.fetch)
    expect(a.withConfig({apiVersion: '2025-02-19'}).fetch).toBe(
      a.withConfig({apiVersion: '2025-02-19'}).fetch,
    )
    expect(a.observable.listen).toBe(b.observable.listen)
    /* `observable` itself is a per-instance own property even unwrapped. */
    expect(a.observable).not.toBe(b.observable)
  })

  it('the instrumented facade narrows that to per-instance', async () => {
    const mod = await loadFactory({SPIKE_INSTRUMENT: '1'})
    const a = mod.spikeClientFactory({...CONFIG})
    const b = mod.spikeClientFactory({...CONFIG})
    expect(a.fetch).not.toBe(b.fetch)
    expect(a.withConfig({apiVersion: '2025-02-19'}).fetch).not.toBe(
      a.withConfig({apiVersion: '2025-02-19'}).fetch,
    )
    /* …but within one instance it is absolute, which is the property Studio
     * actually depends on. */
    expect(a.fetch).toBe(a.fetch)
  })
})

describe('spike A · D13 hybrid — apiHost-only injection (evidence review F2)', () => {
  const PROXY = 'http://localhost:3999'

  it('exposes the instrumentation decision as a table, not a hidden branch', async () => {
    const {shouldInstrument} = await loadFactory()
    /* apiHost set + echo off === the D13 hybrid: the proxy is the only thing
     * between Studio and Content Lake, so nothing needs wrapping. */
    expect(shouldInstrument({apiHost: PROXY, echo: false, flag: null})).toBe(false)
    /* Track A: no proxy, so the facade IS the interception layer. */
    expect(shouldInstrument({apiHost: null, echo: false, flag: null})).toBe(true)
    /* Echo on: `wrapWithLocalEcho` wraps regardless, so "no wrapping" is not
     * available and the call inventory is worth having. */
    expect(shouldInstrument({apiHost: PROXY, echo: true, flag: null})).toBe(true)
    expect(shouldInstrument({apiHost: null, echo: true, flag: null})).toBe(true)
    /* Explicit overrides win in both directions. */
    expect(shouldInstrument({apiHost: PROXY, echo: false, flag: '1'})).toBe(true)
    expect(shouldInstrument({apiHost: null, echo: false, flag: '0'})).toBe(false)
    expect(shouldInstrument({apiHost: null, echo: true, flag: '0'})).toBe(false)
    /* Neither flag is a boolean. Anything that is not the exact opt-in string
     * must fall through to the default, never flip it. */
    expect(shouldInstrument({apiHost: null, echo: false, flag: 'true'})).toBe(true)
    expect(shouldInstrument({apiHost: null, echo: false, flag: 'yes'})).toBe(true)
    expect(shouldInstrument({apiHost: null, echo: false, flag: ''})).toBe(true)
  })

  it.each(['', '   '])(
    'treats an empty SPIKE_API_HOST (%j) as "unset", not as "hybrid"',
    async (blank) => {
      /* The failure mode this pins: a blank flag would skip apiHost injection
       * (`if (apiHost)`) AND read as "hybrid configured" — leaving Studio with
       * no proxy AND no facade, i.e. no interception at all, silently. */
      const mod = await loadFactory({SPIKE_API_HOST: blank})
      const client = mod.spikeClientFactory({...CONFIG})
      expect(client.config().apiHost).toBe('https://api.sanity.io')
      expect(isProxy(client)).toBe(true)
    },
  )

  it('treats a blank SPIKE_INSTRUMENT as "unset", not as "off"', async () => {
    const mod = await loadFactory({SPIKE_INSTRUMENT: '  '})
    expect(isProxy(mod.spikeClientFactory({...CONFIG}))).toBe(true)
  })

  it('returns a bare, unwrapped client in the hybrid topology', async () => {
    const mod = await loadFactory({SPIKE_API_HOST: PROXY})
    const client = mod.spikeClientFactory({...CONFIG})

    /* THE load-bearing assertion for D13. No Proxy anywhere on the object graph
     * Studio touches. */
    expect(isProxy(client)).toBe(false)
    expect(isProxy(client.observable)).toBe(false)
    expect(isProxy(client.withConfig({apiVersion: '2025-02-19'}))).toBe(false)

    /* Corroboration from a second, independent angle: prototype-global method
     * identity is INTACT across separately-built clients, which is impossible
     * once per-instance wrappers are in the way (pinned as the contrast in
     * "the identity guarantee the facade does NOT restore" above). */
    const sibling = mod.spikeClientFactory({...CONFIG})
    expect(client.fetch).toBe(sibling.fetch)
    expect(client.observable.listen).toBe(sibling.observable.listen)
    expect(client.withConfig({apiVersion: '2025-02-19'}).fetch).toBe(client.fetch)
    expect((client.fetch as unknown as {name: string}).name).not.toBe('wrapped')

    /* …and nothing is logged, because nothing is intercepted. */
    pairListenerSubscribe(client)
    expect(win.__SPIKE_A__?.calls).toHaveLength(0)
    /* The factory still records WHAT it was asked to build — that half needs no
     * wrapping and is what `hybrid-validation.md` actually reads. */
    expect(win.__SPIKE_A__?.factoryInvocations).toBe(2)
    expect(win.__SPIKE_A__?.configs).toHaveLength(2)
  })

  it('still returns a wrapped client in the Track A topology (no proxy configured)', async () => {
    /* Non-vacuity for the assertion above: `isProxy` must be able to say yes. */
    const mod = await loadFactory()
    const client = mod.spikeClientFactory({...CONFIG})
    expect(isProxy(client)).toBe(true)
    expect(client.config().apiHost).toBe('https://api.sanity.io')
  })

  it('routes every client-derived URL through the injected apiHost', async () => {
    const mod = await loadFactory({SPIKE_API_HOST: PROXY})
    const client = mod.spikeClientFactory({...CONFIG, useCdn: true})
    const config = client.config()

    const expectedHost = 'http://b1n03q3z.localhost:3999'
    expect(config.apiHost).toBe(PROXY)
    expect(config.url).toBe(`${expectedHost}/v2025-02-19`)
    /* `useCdn` must not open a second egress path: with apiHost overridden the
     * CDN URL collapses onto the same host. */
    expect(config.cdnUrl).toBe(`${expectedHost}/v2025-02-19`)
    expect(client.getDataUrl('mutate')).toBe('/data/mutate/parity')
    expect(client.getUrl(client.getDataUrl('mutate'))).toBe(
      `${expectedHost}/v2025-02-19/data/mutate/parity`,
    )
    /* `canUseCdn = true` is the one path that could pick a different origin. */
    expect(client.getUrl('/data/query/parity', true)).toBe(
      `${expectedHost}/v2025-02-19/data/query/parity`,
    )

    /* The WebSocket URL Studio derives for the pair listener
     * (WorkspaceLoader-BRx2afZV.js:8299) is built from `config().url`, so it
     * follows apiHost too — the proxy must therefore terminate the upgrade. */
    const bifur = `${config.url.replace(/\/+$/, '')}/socket/parity`.replace(/^http/, 'ws')
    expect(bifur).toBe('ws://b1n03q3z.localhost:3999/v2025-02-19/socket/parity')
  })

  it('double-labels the project id when apiHost already carries it', async () => {
    /* Pins the warning in `instrumentedClient.ts`: @sanity/client builds
     * `<projectId>.<apiHost>`, so a value that already contains the project id
     * produces `b1n03q3z.b1n03q3z.…`. Recorded as a test so the proxy's
     * sub-label mapping is anchored to observed behaviour. */
    const client = createClient({...CONFIG, apiHost: 'http://b1n03q3z.localhost:3999'})
    expect(client.config().url).toBe('http://b1n03q3z.b1n03q3z.localhost:3999/v2025-02-19')
  })

  it('keeps the echo facade working when instrumentation is off', async () => {
    /* The dependency question F2 raises: does stripping `instrument` break the
     * local echo? It does not — `wrapWithLocalEcho` is its own Proxy and does
     * its own write interception. What is lost is the `__SPIKE_A__` call
     * inventory (§36.1 evidence), nothing else. */
    const mod = await loadFactory({SPIKE_INSTRUMENT: '0', SPIKE_LOCAL_ECHO: '1'})
    const client = mod.spikeClientFactory({...CONFIG})

    const result = (await client.action(
      [{actionType: 'sanity.action.document.edit', draftId: 'drafts.article-11', publishedId: 'article-11', patch: {set: {title: 'x'}}}] as never,
      {transactionId: 'txn-identity-test'} as never,
    )) as {transactionId: string}

    /* A synthetic success, produced without a network call. */
    expect(result.transactionId).toBe('txn-identity-test')
    expect(win.__SPIKE_ECHO__?.blocked.map((entry) => entry.method)).toContain('action')
    /* …and the inventory really is empty, which is what "no instrumentation"
     * has to mean. */
    expect(win.__SPIKE_A__?.calls).toHaveLength(0)
  })
})
