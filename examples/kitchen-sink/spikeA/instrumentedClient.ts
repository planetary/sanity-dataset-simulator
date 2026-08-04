// SPIKE A — Track A (PRD §36.1): instrumented client facade injected through
// `unstable_clientFactory` (confirmed present in sanity 6.8.0).
// Every client method call is inventoried to window.__SPIKE_A__ so browser
// automation can extract the §36.1 "client method inventory" evidence.
// Read-only observation: calls pass through to the real client unchanged.
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
// Any real overlay facade must preserve method and client identity.
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

export function spikeClientFactory(options: ClientConfig): SanityClient {
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
  const base = isEchoEnabled() ? wrapWithLocalEcho(real) : real
  return instrument(base, `client#${log?.factoryInvocations ?? 0}`)
}
