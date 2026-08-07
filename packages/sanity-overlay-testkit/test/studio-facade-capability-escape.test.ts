/**
 * `sanity-overlay-studio` — a client capability may not leave the facade
 * UNGUARDED, in EITHER direction (§5.5, security review P1-3).
 *
 * WHAT WAS ALREADY CLOSED, AND WHY IT WAS NOT ENOUGH.
 *
 * `SanityClient.config(newConfig)` mutates in place and returns `this`, handing
 * the caller the raw client. The fix was declared *structural*: `facade.ts`
 * re-wraps any method whose RETURN VALUE is a `@sanity/client`. That rule is
 * real, and it covers exactly one channel — outward, as a result.
 *
 * A capability can also leave as an ARGUMENT. `@sanity/client@7.26.0`:
 *
 *     patch(patchOrDocumentId, patchOps) {
 *       const isBuilder = typeof patchOps == "function"
 *       if (isBuilder) {
 *         const patch = patchOps(new Patch(patchOrDocumentId, {}, this.#client))
 *         …
 *
 * (`dist/index.js:631-641`, and `ObservableTransaction.patch` at `:668-678`.)
 * The callback receives a **freshly constructed `Patch` holding `#client`**, and
 * `#client` is the RAW client — the facade invokes `fn.apply(target, args)` with
 * `target` the raw `Transaction`. `p.commit()` inside that callback is
 * `rawClient.mutate(...)`: a live write to the Sanity API from inside Studio,
 * reaching neither the overlay nor the proxy. Nothing the facade did could see
 * it, because it never crossed a return value.
 *
 * THE ORACLE IS THE SINK, NOT THE SHAPE.
 *
 * These tests never ask "is this a Proxy?" — that is the same reasoning that let
 * P1-3 through, since the `Transaction` WAS a proxy and the `Patch` it handed
 * out was not. They ask the only question that matters: **did anything reach the
 * raw client?** The raw client's network sinks are replaced with recorders, so a
 * write that escapes is recorded rather than sent, and `reachedRawClient` is
 * asserted empty at the end of every case.
 *
 * AND THE SWEEP IS A SWEEP.
 *
 * `preview-write-impossibility.test.ts:237` announces "walk every callable on
 * the shipped `SanityClient` prototype" and then checks three names by hand,
 * never touching `Patch` or `Transaction`. That comment is why this class
 * shipped. The sweep below enumerates the REAL prototypes — read off live
 * instances, not from a list in this file — and drives every callable on the
 * builder prototypes with a probe in each argument slot.
 */
import {describe, expect, it} from 'vitest'

import {
  createClient,
  type ClientConfig,
  type SanityClient,
} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

function stubTransport(): OverlayTransport {
  const ok = async (): Promise<OverlayTransportResult> => ({outcome: 'ok', body: {ok: true}})
  return {
    apiUrl: 'http://127.0.0.1:3998',
    commit: ok,
    state: ok,
    resolve: ok,
    query: ok,
    operation: ok,
    events: () => () => undefined,
  } as unknown as OverlayTransport
}

/* ─────────────────────────────────────────────────────────────── the probe */

interface Probe {
  raw: SanityClient
  wrapped: SanityClient
  /** Every call that reached the RAW client's network sinks. Must stay empty. */
  reached: {sink: string; args: unknown[]}[]
}

/**
 * A real `@sanity/client` whose network sinks are recorders.
 *
 * `Patch.commit()` and `Transaction.commit()` both end in `#client.mutate(...)`
 * (`dist/index.js:517`, `:627`), so `mutate` is the sink an escape lands in.
 * Replacing it at INSTANCE level leaves `isSanityClientInstance` — which walks
 * the prototype — answering exactly as it does in production, so the facade
 * behaves the same as against an untouched client.
 */
function probe(): Probe {
  const reached: Probe['reached'] = []
  const raw = createClient(CONFIG)

  const record =
    (sink: string) =>
    (...args: unknown[]): unknown => {
      reached.push({sink, args})
      return Promise.resolve({})
    }

  for (const sink of ['mutate', 'request', 'dataRequest', 'action'] as const) {
    Object.defineProperty(raw, sink, {value: record(sink), writable: true, configurable: true})
    Object.defineProperty(raw.observable, sink, {
      value: record(`observable.${sink}`),
      writable: true,
      configurable: true,
    })
  }

  const wrapped = wrapWithOverlay(raw, {
    echo: createOverlayEcho(),
    transport: stubTransport(),
  }) as unknown as SanityClient

  return {raw, wrapped, reached}
}

/** Anything with a `commit` is a capability: try to fire it and see where it lands. */
function fireIfCommittable(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  const commit = (value as Rec).commit
  if (typeof commit !== 'function') return
  try {
    const result = (commit as () => unknown).call(value)
    /* An observable commit is lazy; subscribing is what would send. */
    if (
      typeof result === 'object' &&
      result !== null &&
      typeof (result as Rec).subscribe === 'function'
    ) {
      ;(result as {subscribe: (o: unknown) => {unsubscribe: () => void}})
        .subscribe({next: () => {}, error: () => {}, complete: () => {}})
        .unsubscribe()
    }
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    /* A refusal is a pass: the point is that nothing reached the raw client. */
  }
}

/* ══════════════════════════════════════════════════ P1-3, the named instance */

describe('a builder handed to a callback cannot reach the raw client', () => {
  it('Transaction.patch(id, builderFn) — the P1-3 vector', () => {
    const {wrapped, reached} = probe()

    wrapped.transaction().patch('article-01', (p) => {
      p.set({title: 'owned'})
      fireIfCommittable(p)
      return p
    })

    expect(reached).toEqual([])
  })

  it('ObservableTransaction.patch(id, builderFn) — the same hole one level down', () => {
    const {wrapped, reached} = probe()

    wrapped.observable.transaction().patch('article-01', (p) => {
      p.set({title: 'owned'})
      fireIfCommittable(p)
      return p
    })

    expect(reached).toEqual([])
  })

  it('still builds the transaction it was asked for', () => {
    /* The guard must not cost the caller the feature. `serialize()` is
     * @sanity/client's own accessor, so the operation list is read from the
     * library rather than from anything this package computed. */
    const {wrapped} = probe()

    const transaction = wrapped.transaction().patch('article-01', (p) => p.set({title: 'kept'}))

    expect(transaction.serialize()).toEqual([
      {patch: {id: 'article-01', set: {title: 'kept'}}},
    ])
  })

  it('a patch the callback CLONES is guarded too', () => {
    /* `Patch.clone()` constructs `new Patch(…, this.#client)` — a second
     * client-bearing object from inside the same callback. */
    const {wrapped, reached} = probe()

    wrapped.transaction().patch('article-01', (p) => {
      const twin = p.set({title: 'owned'}).clone()
      fireIfCommittable(twin)
      return twin
    })

    expect(reached).toEqual([])
  })

  it('the guarded patch is still a Patch, which the library insists on', () => {
    /* `if (!(patch instanceof Patch)) throw new Error("function passed to
     * `patch()` must return the patch")` — `dist/index.js:638`. A guard that
     * broke `instanceof` would turn every builder call into a throw. */
    const {wrapped} = probe()
    expect(() =>
      wrapped.transaction().patch('article-01', (p) => p.set({title: 'ok'})),
    ).not.toThrow()
  })
})

/* ══════════════════════════════════════════════════════════ the class sweep */

/**
 * The prototypes, read off LIVE INSTANCES.
 *
 * A list of class names written here would rot the moment @sanity/client added
 * one — which is the failure mode the hand-written `['config','clone',
 * 'withConfig']` list already demonstrated.
 */
function builderPrototypes(client: SanityClient): {name: string; make: () => object}[] {
  return [
    {name: 'Transaction', make: () => client.transaction()},
    {name: 'ObservableTransaction', make: () => client.observable.transaction()},
    {name: 'Patch', make: () => client.patch('article-01')},
    {name: 'ObservablePatch', make: () => client.observable.patch('article-01')},
  ]
}

/**
 * Every callable on the prototype CHAIN, up to but excluding `Object`.
 *
 * The chain, not one level: `Patch.prototype` owns only `clone` and `commit` —
 * `set`, `unset`, `inc`, `insert` and the rest live on `BasePatch.prototype`
 * one step up. A sweep that stopped at the first level would have declared
 * "every callable" while missing most of them, which is the exact shape of the
 * oracle that let P1-3 through.
 *
 * Descriptors are read rather than the values, so a getter is never invoked
 * just by being enumerated.
 */
function callablesOf(instance: object): string[] {
  const names = new Set<string>()
  let proto: object | null = Object.getPrototypeOf(instance) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)
      if (typeof descriptor?.value === 'function') names.add(name)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return [...names]
}

describe('every callable on every builder prototype is swept', () => {
  it('names more than a handful of methods — a sweep that found nothing swept nothing', () => {
    const {wrapped} = probe()
    const counted = builderPrototypes(wrapped).map(({name, make}) => ({
      name,
      methods: callablesOf(make()),
    }))

    /* The negative control for the sweep itself. If @sanity/client is ever
     * resolved to something that answers with empty prototypes, every
     * assertion below would pass vacuously — this is what notices. */
    for (const entry of counted) {
      expect(entry.methods.length, entry.name).toBeGreaterThan(2)
      expect(entry.methods, entry.name).toContain('commit')
    }
    expect(counted).toHaveLength(4)
  })

  it('no method hands a live capability to a callback, whichever slot it is in', () => {
    const {wrapped, reached} = probe()
    const handedOut: unknown[] = []

    /* A probe that grabs whatever it is given and tries to fire it. Placed in
     * BOTH argument slots because which slot a library reads is its business,
     * not ours — `Transaction.patch` reads the second, and the next method
     * @sanity/client ships may read the first. */
    const grab = (...args: unknown[]): unknown => {
      for (const arg of args) {
        handedOut.push(arg)
        fireIfCommittable(arg)
      }
      return args[0]
    }

    for (const {make} of builderPrototypes(wrapped)) {
      for (const method of callablesOf(make())) {
        if (method === 'commit') continue /* has its own interception + test */
        for (const args of [[grab], ['article-01', grab], [grab, grab]]) {
          const builder = make() as Rec
          try {
            ;(builder[method] as (...a: unknown[]) => unknown).apply(builder, args)
          } catch {
            /* Wrong arity or a refusal — neither is an escape. */
          }
        }
      }
    }

    /* The sweep must actually have exercised the channel it claims to cover. */
    expect(handedOut.length).toBeGreaterThan(0)
    expect(reached).toEqual([])
  })

  it('no method hands a live capability back as a return value', () => {
    const {wrapped, reached} = probe()

    for (const {make} of builderPrototypes(wrapped)) {
      for (const method of callablesOf(make())) {
        if (method === 'commit') continue
        const builder = make() as Rec
        for (const args of [[], ['article-01'], ['article-01', {title: 'x'}]]) {
          try {
            fireIfCommittable(
              (builder[method] as (...a: unknown[]) => unknown).apply(builder, args),
            )
          } catch {
            /* as above */
          }
        }
      }
    }

    expect(reached).toEqual([])
  })

  it('no callable on either client prototype is handed through unguarded', () => {
    /*
     * The client prototypes are swept STRUCTURALLY rather than by invocation:
     * calling `getDocument` or `fetch` for real would leave for the network, and
     * a test that did that would be a worse defect than the one it looks for. So
     * the assertion is the one that can be made without firing: every callable
     * the shipped prototype defines is replaced by the facade — none is the raw
     * function — and each is identity-stable, which sanity 6.8.0 depends on for
     * its effect dependency arrays.
     */
    const {raw, wrapped} = probe()

    for (const [label, rawSide, wrappedSide] of [
      ['SanityClient', raw, wrapped],
      ['ObservableSanityClient', raw.observable, wrapped.observable],
    ] as const) {
      const names = callablesOf(rawSide as object)
      expect(names.length, label).toBeGreaterThan(5)

      for (const name of names) {
        const throughFacade = (wrappedSide as unknown as Rec)[name]
        const direct = (rawSide as unknown as Rec)[name]
        expect(typeof throughFacade, `${label}.${name}`).toBe('function')
        expect(throughFacade, `${label}.${name} is the raw function`).not.toBe(direct)
        expect(throughFacade, `${label}.${name} identity`).toBe(
          (wrappedSide as unknown as Rec)[name],
        )
      }
    }
  })
})
