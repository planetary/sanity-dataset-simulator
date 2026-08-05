// SPIKE A — client facade injected through `unstable_clientFactory` (confirmed
// present in sanity 6.8.0).
//
// Three topologies come out of this one factory; `shouldInstrument()` below is
// the truth table and the only place the choice is made:
//
//   Track A  — wrap every client method, inventory the calls to window.__SPIKE_A__
//              for the §36.1 "client method inventory" evidence. Read-only
//              observation: calls pass through to the real client unchanged.
//   D13 hybrid — inject `apiHost` only, wrap nothing, and let the Track B proxy
//              be the sole enforcement boundary.
//   Local echo — `wrapWithLocalEcho` (localEcho.ts) additionally blocks and
//              echoes writes; it is its own Proxy and does not need `instrument`.
import {createClient, type ClientConfig, type SanityClient} from '@sanity/client'
import {isEchoEnabled, wrapWithLocalEcho} from './localEcho'

interface SpikeCall {
  path: string
  method: string
  arg0?: string
  at: number
}

interface SpikeLog {
  calls: SpikeCall[]
  configs: ClientConfig[]
  factoryInvocations: number
}

declare global {
  interface Window {
    __SPIKE_A__?: SpikeLog
  }
}

function spikeLog(): SpikeLog | null {
  if (typeof window === 'undefined') return null
  window.__SPIKE_A__ ??= {calls: [], configs: [], factoryInvocations: 0}
  return window.__SPIKE_A__
}

function summarize(arg: unknown): string | undefined {
  if (arg === undefined) return undefined
  if (typeof arg === 'string') return arg.slice(0, 120)
  if (typeof arg === 'object' && arg !== null) {
    const o = arg as Record<string, unknown>
    const keys = Object.keys(o).slice(0, 8).join(',')
    const id = typeof o._id === 'string' ? ` _id=${o._id}` : ''
    return `{${keys}}${id}`.slice(0, 120)
  }
  return String(arg).slice(0, 120)
}

const PASSTHROUGH_RESULT = new Set(['withConfig', 'clone'])
const MAX_LOG = 5000

// CRITICAL LESSON (Spike A finding): wrappers MUST be identity-stable.
// A naive Proxy returning a fresh function per property access gives Studio's
// reactive layer a new method identity on every render -> infinite
// resubscribe loop -> ~40k calls, saturated main thread, black screen.
// The mechanism, in one line of Studio 6.8.0
// (`sanity/lib/LiveQueries-rJao7vYj.js:36-45`):
//     useEffect(() => { client.live.events(...).subscribe(...) }, [client.live])
// a React effect whose dependency is read off the client on every render.
// Any real overlay facade must preserve method and client identity.
// This is no longer only a story: the bound is asserted at 20 000 renders in
// `packages/sanity-overlay-testkit/test/spike-a-client-identity.test.ts`, with
// a deliberately unstable wrapper as the negative control.
const instrumentedCache = new WeakMap<object, object>()
const wrapperCache = new WeakMap<object, Map<PropertyKey, unknown>>()

function pushCall(path: string, method: string, arg0: unknown): void {
  const log = spikeLog()
  if (!log) return
  if (log.calls.length >= MAX_LOG) log.calls.splice(0, MAX_LOG / 2) // ring-ish buffer
  log.calls.push({path, method, arg0: summarize(arg0), at: Math.round(performance.now())})
}

function instrument<T extends object>(target: T, path: string): T {
  const cached = instrumentedCache.get(target)
  if (cached) return cached as T
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver)
      const name = String(prop)
      if (name === 'observable' && value && typeof value === 'object') {
        return instrument(value as object, `${path}.observable`)
      }
      if (typeof value !== 'function') return value
      let perTarget = wrapperCache.get(t)
      if (!perTarget) {
        perTarget = new Map()
        wrapperCache.set(t, perTarget)
      }
      const existing = perTarget.get(prop)
      if (existing) return existing
      const wrapped = (...args: unknown[]) => {
        pushCall(path, name, args[0])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (value as any).apply(t, args)
        if (PASSTHROUGH_RESULT.has(name) && result && typeof result === 'object') {
          return instrument(result as object, `${path}.${name}()`)
        }
        return result
      }
      perTarget.set(prop, wrapped)
      return wrapped
    },
  }) as T
  instrumentedCache.set(target, proxy)
  return proxy
}

/**
 * Read a `localStorage` flag, normalising blank to *unset*.
 *
 * Not cosmetic: a blank `SPIKE_API_HOST` used to be truthy enough to read as
 * "hybrid configured" (so instrumentation was skipped) while being falsy at the
 * injection site (so no `apiHost` was set) — Studio would then run with no proxy
 * AND no facade, silently. Whitespace was worse still: `'   '` was injected as
 * the API host verbatim.
 */
function readFlag(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    const trimmed = raw === null ? '' : raw.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  }
}

/**
 * SPIKE A — D13 HYBRID (see track-b-proxy.md).
 * `localStorage.SPIKE_API_HOST` puts the factory in hybrid mode: `apiHost` is
 * injected into every ClientConfig so all client-derived URLs — data plane,
 * assets, `/users/me`, and the `<url>/socket/<dataset>` WebSocket Studio builds
 * from `config().url` — resolve to the Track B proxy. Enforcement then lives
 * entirely in the proxy.
 *
 * Note @sanity/client builds `<projectId>.<apiHost>`, so pass the bare proxy
 * origin (`http://localhost:3999`); a value that already contains the project id
 * produces `b1n03q3z.b1n03q3z.localhost` — pinned in
 * `test/spike-a-client-identity.test.ts`.
 */
function hybridApiHost(): string | null {
  return readFlag('SPIKE_API_HOST')
}

/**
 * Should the returned client be wrapped in the `instrument` Proxy?
 *
 * This used to be "always", which made D13's stated differentiator — *"the
 * factory injects `apiHost` only (no method wrapping ⇒ no identity hazard)"* —
 * false in the code (evidence review F2: no code path existed that injected
 * `apiHost` without wrapping, so the topology the decision describes had never
 * run). The rule is now explicit, exported, and pinned as a truth table.
 *
 * | SPIKE_API_HOST | SPIKE_LOCAL_ECHO | SPIKE_INSTRUMENT | wrapped |
 * |---|---|---|---|
 * | unset | off | unset | **yes** — Track A: the facade IS the interception layer |
 * | unset | on  | unset | **yes** — echo wraps anyway; keep the call inventory |
 * | set   | off | unset | **no**  — the D13 hybrid: the proxy is the sole boundary |
 * | set   | on  | unset | **yes** — `wrapWithLocalEcho` wraps regardless (below) |
 * | any   | any | `'1'`  | **yes** — force on, e.g. to re-gather the §36.1 inventory under the hybrid |
 * | any   | any | `'0'`  | **no**  — force off |
 *
 * Why echo forces it back on: `wrapWithLocalEcho` is its own Proxy over every
 * method — that is *how* it intercepts and echoes writes. "No method wrapping"
 * is therefore unobtainable whenever the echo is on, and since something is
 * wrapping either way the §36.1 call inventory costs nothing extra. Removing
 * `instrument` does not weaken the write block; it only empties `__SPIKE_A__`.
 */
export function shouldInstrument(input: {
  apiHost: string | null
  echo: boolean
  flag: string | null
}): boolean {
  if (input.flag === '1') return true
  if (input.flag === '0') return false
  return !(input.apiHost !== null && !input.echo)
}

export function spikeClientFactory(options: ClientConfig): SanityClient {
  const apiHost = hybridApiHost()
  if (apiHost) options = {...options, apiHost}
  const log = spikeLog()
  if (log) {
    log.factoryInvocations += 1
    log.configs.push({...options, token: options.token ? '<redacted>' : undefined})
  }
  const real = createClient(options)
  // ORDERING: logging OUTSIDE, echo INSIDE — instrument(wrapWithLocalEcho(real)).
  // Studio -> instrument (pushCall -> __SPIKE_A__) -> echo (block + record to
  // __SPIKE_ECHO__ + synthetic result) -> never reaches `real`.
  // The reverse order (echo outside) would short-circuit before pushCall, so
  // __SPIKE_A__ would lose the `action`/`mutate` calls entirely. Blocking is
  // unaffected by the order because the echo layer simply never delegates to the
  // real client for writes. Bonus: the echo layer's own internal calls to the
  // real client (upstream listen, snapshot fetch) stay out of the __SPIKE_A__ log.
  const echo = isEchoEnabled()
  const base = echo ? wrapWithLocalEcho(real) : real
  if (!shouldInstrument({apiHost, echo, flag: readFlag('SPIKE_INSTRUMENT')})) return base
  return instrument(base, `client#${log?.factoryInvocations ?? 0}`)
}
