// SPIKE F — attack pass against the Spike A local-echo write-block facade
// (PRD §36.6 "safety and trust boundary", threat list §26.9, safety success §5.2,
// hard safety guards §11.3, stop criteria §0.6).
//
// WHAT THIS IS
// A self-contained, browser-executable attack suite. Every attack tries to get a
// mutation of the Sanity dataset `parity` (project b1n03q3z) past the facade
// installed by `spikeA/localEcho.ts`, using a different escape hatch. The report
// says which attacks succeeded — a success is a security hole, not a feature.
//
// HOW "BLOCKED" IS DECIDED (two independent signals, per the §36.6 pass criterion
// "every staging write fails BEFORE reaching an authorized endpoint"):
//   (a) the facade recorded the call in `window.__SPIKE_ECHO__.blocked`, and
//   (b) no HTTP request left the page for a write endpoint.
// (b) is authoritative and is measured twice over: a `window.fetch` tap installed
// for the duration of the run (records method + response status) AND
// `performance.getEntriesByType('resource')` deltas (catches any request that did
// not go through the tapped `fetch`). An attack that reaches the endpoint and is
// rejected 401/403 by the SERVER is still reported as NOT blocked — the guard
// under test is the client-side one, and "the server said no" is not a guard we
// control. The evidence string records the status so the two cases stay separable.
//
// SAFETY RAILS
//  - The suite refuses to run unless the facade is actually installed
//    (`localStorage.SPIKE_LOCAL_ECHO === '1'` and `__SPIKE_ECHO__.enabled`),
//    because without it EVERY attack would write for real. Override with
//    `window.__SPIKE_F_FORCE__ = true` only for a deliberate control run.
//  - No attack ever targets a pre-existing document. Every mutating payload uses
//    an id prefixed `spike-f-canary-`, so anything that does get written is
//    trivially identifiable and is listed in `report.cleanup`.
//  - The `config()` escape (attack 17) is demonstrated against a `clone()` of the
//    Studio client, never against the live client, so the Studio's own
//    configuration cannot be perturbed by the test.
//
// RUN IT — see spikeF/README.md. Short form, from the Studio page:
//   await import('/spikeF/attackPass.ts');
//   const report = await window.__SPIKE_F__.runAttackPass();
import {createClient, type ClientConfig, type SanityClient} from '@sanity/client'
import {spikeClientFactory} from '../spikeA/instrumentedClient'
import type {EchoLog} from '../spikeA/localEcho'

/* ---------------------------------------------------------------- public API */

export type AttackSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical' | 'architectural'

export type AttackCategory =
  /** the facade's own method interception surface */
  | 'facade-client'
  /** fluent builders (`patch()`, `transaction()`) that bind to the real client */
  | 'facade-builder'
  /** client copies: `withConfig`, `clone`, `config(newConfig)` */
  | 'facade-clone'
  /** raw endpoint access through `request`/`dataRequest` */
  | 'raw-endpoint'
  /** sub-clients hanging off the client object (`assets`, `agent`, `datasets`, …) */
  | 'sub-client'
  /** total bypass: new client / raw fetch — cannot be stopped by a facade */
  | 'bypass'
  /** credential reachability from page JS */
  | 'credential'
  /** post-run verification of what actually persisted */
  | 'verification'

export interface AttackResult {
  name: string
  category: AttackCategory
  /** false only when the attack could not even be launched (missing prerequisite) */
  attempted: boolean
  /** true = no write request reached the network. false = HOLE. */
  blocked: boolean
  /** true = we predicted this cannot be stopped by a client-side facade (§0.6) */
  expectedHole: boolean
  severity: AttackSeverity
  evidence: string
  error?: string
}

export interface AttackReport {
  ranAt: string
  attacks: AttackResult[]
  summary: {
    total: number
    blocked: number
    /** unexpected holes — these are the findings that must be fixed */
    holes: number
    /** holes we predicted and accept as architectural (argument for a network guard) */
    expectedHoles: number
  }
  /** write-capable credentials reachable from page JS, redacted to 6 chars */
  tokensFound: string[]
  /** document / asset ids that may have been created — delete these */
  cleanup: string[]
}

/* ---------------------------------------------------------------- constants */

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const API_VERSION = '2025-02-19'
const API_HOST = `https://${PROJECT_ID}.api.sanity.io`
const CANARY_PREFIX = 'spike-f-canary-'
const CANARY_TYPE = 'spikeFCanary'
const CANARY_TITLE = 'SPIKE F canary — safe to delete'

/** Endpoints that constitute "a staging write left the browser". */
const WRITE_PATTERNS: RegExp[] = [
  /\/data\/mutate\b/,
  /\/data\/actions\b/,
  /\/assets\//,
  /\/agent\/action\//,
]
/** Project-plane endpoints, used only by the sub-client reachability probe. */
const PROJECT_PATTERNS: RegExp[] = [/\/datasets\b/]

/** How long to wait after each attack for the response / resource entry to land. */
const SETTLE_MS = 450
/** Hard per-attack ceiling so one hung request cannot stall the suite. */
const ATTACK_TIMEOUT_MS = 15_000

/** 1x1 transparent PNG — the smallest thing that is unambiguously an image upload. */
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/* ------------------------------------------------------------------ globals */

declare global {
  interface Window {
    __SPIKE_F__?: {
      runAttackPass: () => Promise<AttackReport>
      lastReport?: AttackReport
    }
    /** optional: orchestrator can hand the suite the exact client to attack */
    __SPIKE_F_CLIENT__?: unknown
    /** optional: run the suite with the facade OFF (control run — WRITES FOR REAL) */
    __SPIKE_F_FORCE__?: boolean
  }
}

type Rec = Record<string, unknown>

/* ---------------------------------------------------------------- utilities */

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as unknown as Rec).statusCode
    const suffix = typeof status === 'number' ? ` [HTTP ${status}]` : ''
    return `${err.name}: ${err.message}${suffix}`.slice(0, 400)
  }
  if (isRec(err)) {
    try {
      return JSON.stringify(err).slice(0, 400)
    } catch {
      return String(err).slice(0, 400)
    }
  }
  return String(err).slice(0, 400)
}

/**
 * THE decisive signal, and the only transport-independent one: if the thrown
 * error carries an HTTP status, a Sanity error body or a traceId, then the
 * request demonstrably reached the endpoint and was answered there — no
 * client-side guard stopped it. `@sanity/client` throws ClientError/ServerError
 * with `statusCode` + `response`; `get-it` marks transport failures with
 * `isNetworkError`.
 */
function serverAnswer(err: unknown): {status?: number; networkFailure: boolean} {
  if (!isRec(err)) return {networkFailure: false}
  const record = err as Rec
  const direct = record.statusCode
  if (typeof direct === 'number' && direct > 0) return {status: direct, networkFailure: false}
  const response = record.response
  if (isRec(response) && typeof (response as Rec).statusCode === 'number') {
    return {status: (response as Rec).statusCode as number, networkFailure: false}
  }
  const details = record.details
  if (isRec(details) && typeof (details as Rec).statusCode === 'number') {
    return {status: (details as Rec).statusCode as number, networkFailure: false}
  }
  if (record.isNetworkError === true) return {networkFailure: true}
  // Last resort: a Sanity API error body leaked into the message.
  const message = typeof record.message === 'string' ? record.message : ''
  if (/traceId:|Insufficient permissions|was not found|Unauthorized/.test(message)) {
    return {status: -2, networkFailure: false}
  }
  return {networkFailure: false}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms)
  })
  // Promise.race attaches a rejection handler to `promise`, so a late rejection
  // cannot surface as an unhandled rejection.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

interface ObservableLike {
  subscribe: (observer: {
    next?: (value: unknown) => void
    error?: (err: unknown) => void
    complete?: () => void
  }) => {unsubscribe: () => void} | void
}

function isObservableLike(value: unknown): value is ObservableLike {
  return isRec(value) && typeof (value as Rec).subscribe === 'function'
}

/**
 * Subscribe to an observable and resolve with its first value. Subscribing is
 * what actually triggers the request on the observable client, so an attack on
 * `client.observable.*` is only a real attack once this runs.
 */
function firstFromObservable(source: unknown, label: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!isObservableLike(source)) {
      reject(new Error(`${label}: value is not observable (got ${typeof source})`))
      return
    }
    let settled = false
    let sub: {unsubscribe: () => void} | void
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      setTimeout(() => {
        try {
          if (sub) sub.unsubscribe()
        } catch {
          /* ignore */
        }
      }, 0)
    }
    try {
      sub = source.subscribe({
        next: (value) => finish(() => resolve(value)),
        error: (err) => finish(() => reject(err)),
        complete: () => finish(() => resolve(undefined)),
      })
    } catch (err) {
      finish(() => reject(err))
    }
  })
}

function canaryDoc(id: string): Rec {
  return {_id: id, _type: CANARY_TYPE, title: CANARY_TITLE, spikeF: true}
}

function stripQuery(url: string): string {
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)).slice(0, 160)
}

/* ------------------------------------------------------- network observation */

interface NetHit {
  via: 'fetch' | 'xhr' | 'resource'
  url: string
  method?: string
  /** -1 = the request threw (network error / blocked by the browser) */
  status?: number
  at: number
}

/** Requests observed by the transport taps (fetch + XHR). */
const tapHits: NetHit[] = []
let tappedFetch: typeof window.fetch | null = null
let originalFetch: typeof window.fetch | null = null
type XhrOpen = XMLHttpRequest['open']
type XhrSend = XMLHttpRequest['send']
let originalXhrOpen: XhrOpen | null = null
let originalXhrSend: XhrSend | null = null

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init && typeof init.method === 'string') return init.method.toUpperCase()
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase()
  return 'GET'
}

/**
 * Tap `window.fetch` for the duration of the run. NOTE: `spikeA/eventSourceTap.ts`
 * has already replaced `window.fetch`; we chain onto whatever is installed and
 * restore it afterwards, so the listen-stream tap keeps working.
 */
function installFetchTap(): void {
  if (typeof window === 'undefined' || tappedFetch) return
  const previous = window.fetch
  const forward = previous.bind(window)
  const tap: typeof window.fetch = async (input, init) => {
    const hit: NetHit = {
      via: 'fetch',
      url: requestUrl(input),
      method: requestMethod(input, init),
      at: performance.now(),
    }
    if (tapHits.length < 1000) tapHits.push(hit)
    try {
      const response = await forward(input, init)
      hit.status = response.status
      return response
    } catch (err) {
      hit.status = -1
      throw err
    }
  }
  originalFetch = previous
  tappedFetch = tap
  window.fetch = tap
}

/**
 * FINDING (load-bearing for any network-layer guard): in a real browser
 * `@sanity/client` does NOT use `fetch` for mutations. `get-it`'s browser adapter
 * picks `XMLHttpRequest` whenever it exists (`adapter = typeof XMLHttpRequest ===
 * 'function' ? 'xhr' : 'fetch'`) and only falls back to a fetch-based XHR shim.
 * A guard — or an evidence tap — that only wraps `window.fetch` therefore sees
 * `/data/listen` (which @sanity/client streams over fetch) and nothing else.
 */
function installXhrTap(): void {
  if (typeof XMLHttpRequest === 'undefined' || originalXhrOpen) return
  const proto = XMLHttpRequest.prototype
  const pending = new WeakMap<XMLHttpRequest, NetHit>()
  originalXhrOpen = proto.open
  originalXhrSend = proto.send

  const openTap = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const method = String(args[0] ?? 'GET').toUpperCase()
    const url = String(args[1] ?? '')
    pending.set(this, {via: 'xhr', url, method, at: performance.now()})
    ;(originalXhrOpen as unknown as (...a: unknown[]) => void).apply(this, args)
  }
  const sendTap = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const hit = pending.get(this)
    if (hit) {
      hit.at = performance.now()
      if (tapHits.length < 1000) tapHits.push(hit)
      this.addEventListener('loadend', () => {
        // status 0 == the browser refused / aborted the request
        hit.status = this.status === 0 ? -1 : this.status
      })
    }
    ;(originalXhrSend as unknown as (...a: unknown[]) => void).apply(this, args)
  }

  ;(proto as unknown as Rec).open = openTap
  ;(proto as unknown as Rec).send = sendTap
}

function installNetTap(): void {
  installFetchTap()
  installXhrTap()
}

function removeNetTap(): void {
  if (typeof window !== 'undefined' && tappedFetch && originalFetch) {
    if (window.fetch === tappedFetch) window.fetch = originalFetch
  }
  tappedFetch = null
  originalFetch = null
  if (typeof XMLHttpRequest !== 'undefined' && originalXhrOpen && originalXhrSend) {
    ;(XMLHttpRequest.prototype as unknown as Rec).open = originalXhrOpen
    ;(XMLHttpRequest.prototype as unknown as Rec).send = originalXhrSend
  }
  originalXhrOpen = null
  originalXhrSend = null
}

function resourceStatus(entry: PerformanceEntry): number | undefined {
  const status = (entry as unknown as Rec).responseStatus
  return typeof status === 'number' ? status : undefined
}

function matchesAny(url: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(url))
}

/**
 * Every request to a write endpoint observed since `since` (a `performance.now()`
 * timestamp), merged across both detectors and de-duplicated by URL.
 */
function netHitsSince(since: number, patterns: RegExp[]): NetHit[] {
  const merged = new Map<string, NetHit>()

  for (const hit of tapHits) {
    if (hit.at < since - 1) continue
    if (!matchesAny(hit.url, patterns)) continue
    merged.set(stripQuery(hit.url), {...hit, url: stripQuery(hit.url)})
  }

  let entries: PerformanceEntry[] = []
  try {
    entries = performance.getEntriesByType('resource')
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.startTime < since - 1) continue
    if (!matchesAny(entry.name, patterns)) continue
    const key = stripQuery(entry.name)
    const existing = merged.get(key)
    if (existing) {
      if (existing.status === undefined) existing.status = resourceStatus(entry)
      continue
    }
    merged.set(key, {
      via: 'resource',
      url: key,
      status: resourceStatus(entry),
      at: entry.startTime,
    })
  }
  return Array.from(merged.values())
}

function describeHits(hits: NetHit[]): string {
  if (hits.length === 0) return 'no write request left the page'
  return hits
    .map((hit) => {
      const method = hit.method ?? '?'
      const status =
        hit.status === undefined
          ? 'status unknown'
          : hit.status === -1
            ? 'transport failure (CORS/CSP/offline)'
            : `HTTP ${hit.status}`
      return `${method} ${hit.url} -> ${status} (via ${hit.via})`
    })
    .join(' | ')
}

/**
 * A hit whose status is -1 was refused by the browser (CORS preflight, CSP,
 * offline) rather than by anything under test, so it is reported separately:
 * the facade still did not stop it, but the request did not reach the endpoint.
 */
function isTransportFailure(hit: NetHit): boolean {
  return hit.status === -1
}

/* ---------------------------------------------------------- facade observation */

function echoLog(): EchoLog | undefined {
  return typeof window === 'undefined' ? undefined : window.__SPIKE_ECHO__
}

function blockedCount(): number {
  return echoLog()?.blocked.length ?? 0
}

function blockedSince(index: number): string {
  const entries = echoLog()?.blocked.slice(index) ?? []
  if (entries.length === 0) return 'facade recorded nothing'
  return `facade recorded ${entries.length}: ${entries
    .map((entry) => `${entry.method}(handled=${entry.handled})`)
    .join(', ')}`
}

/* -------------------------------------------------------- credential discovery */

interface FoundToken {
  source: string
  value: string
}

const TOKEN_RE = /^sk[A-Za-z0-9._-]{16,}$/

function looksLikeToken(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 20) return false
  if (TOKEN_RE.test(value)) return true
  return /token|secret|credential/i.test(key) && value.length >= 40 && !value.includes(' ')
}

function scanValue(source: string, key: string, value: unknown, out: FoundToken[], depth: number): void {
  if (out.length >= 20 || depth > 3) return
  if (typeof value === 'string') {
    if (looksLikeToken(key, value)) out.push({source: `${source}:${key}`, value})
    // A stored JSON blob may hide the token one level down (`{"token":"sk..."}`).
    if (depth < 3 && value.length < 20_000 && /[{[]/.test(value.charAt(0))) {
      try {
        scanValue(source, key, JSON.parse(value) as unknown, out, depth + 1)
      } catch {
        /* not JSON */
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) scanValue(source, key, item, out, depth + 1)
    return
  }
  if (isRec(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      scanValue(source, `${key}.${childKey}`, childValue, out, depth + 1)
    }
  }
}

function scanStorage(storage: Storage | undefined, label: string, out: FoundToken[]): void {
  if (!storage) return
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key === null) continue
      scanValue(label, key, storage.getItem(key), out, 0)
    }
  } catch {
    /* storage inaccessible */
  }
}

/** Everything a page script can reach that would let it write to Content Lake. */
function findCredentials(studio: SanityClient | null): FoundToken[] {
  const found: FoundToken[] = []
  if (typeof window === 'undefined') return found

  scanStorage(window.localStorage, 'localStorage', found)
  scanStorage(window.sessionStorage, 'sessionStorage', found)

  // Targeted window scan: a broad enumeration of `window` triggers deprecation
  // warnings on unrelated properties, so only look at plausible carriers.
  try {
    for (const key of Object.keys(window)) {
      if (!/sanity|studio|token|client|auth/i.test(key)) continue
      try {
        scanValue('window', key, (window as unknown as Rec)[key], found, 1)
      } catch {
        /* one hostile getter must not end the scan */
      }
    }
  } catch {
    /* ignore */
  }

  // The facade itself hands out the token: `config()` returns a copy of the
  // client configuration, token included.
  if (studio) {
    try {
      const config = studio.config() as unknown as Rec
      if (typeof config.token === 'string' && config.token.length > 0) {
        found.push({source: 'facadeClient.config().token', value: config.token})
      }
      if (config.withCredentials === true) {
        found.push({source: 'facadeClient.config().withCredentials=cookie-auth', value: 'cookie'})
      }
    } catch {
      /* ignore */
    }
  }

  // Cookie auth reachable from JS (i.e. not HttpOnly) is equally write-capable.
  try {
    const cookies = document.cookie
    if (cookies && /sanity|session/i.test(cookies)) {
      const names = cookies
        .split(';')
        .map((part) => part.split('=')[0]?.trim() ?? '')
        .filter((name) => /sanity|session/i.test(name))
      for (const name of names) found.push({source: `document.cookie:${name}`, value: 'cookie'})
    }
  } catch {
    /* ignore */
  }

  const seen = new Set<string>()
  return found.filter((token) => {
    const key = `${token.source}|${token.value.slice(0, 12)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function redact(token: FoundToken): string {
  if (token.value === 'cookie') return `${token.source} (cookie credential, no bearer token)`
  return `${token.source} = ${token.value.slice(0, 6)}… (len ${token.value.length})`
}

/* ------------------------------------------------------- studio client discovery */

function isClientLike(value: unknown): value is SanityClient {
  if (!isRec(value)) return false
  const candidate = value as Rec
  return (
    typeof candidate.fetch === 'function' &&
    typeof candidate.listen === 'function' &&
    typeof candidate.config === 'function' &&
    typeof candidate.withConfig === 'function' &&
    typeof candidate.mutate === 'function' &&
    typeof candidate.observable === 'object'
  )
}

/**
 * Shallow-inspect an arbitrary value for a client. Guarded: reading React fiber
 * props can invoke getters (Sanity's config-context client is built out of
 * deprecation-warning getters), so every access is wrapped.
 */
function probeForClient(value: unknown, depth: number): SanityClient | null {
  if (depth > 2 || !isRec(value)) return null
  // DOM nodes carry React-internal keys that would send us back into the fiber
  // tree, and touching `window`/`document` properties trips deprecation getters.
  if (typeof Node !== 'undefined' && value instanceof Node) return null
  if ((value as unknown) === window || (value as unknown) === document) return null
  try {
    if (isClientLike(value)) return value
  } catch {
    return null
  }
  if (depth === 2) return null
  let keys: string[] = []
  try {
    keys = Object.keys(value).slice(0, 24)
  } catch {
    return null
  }
  for (const key of keys) {
    let child: unknown
    try {
      child = (value as Rec)[key]
    } catch {
      continue
    }
    const hit = probeForClient(child, depth + 1)
    if (hit) return hit
  }
  return null
}

interface FiberLike {
  child?: FiberLike | null
  sibling?: FiberLike | null
  memoizedProps?: unknown
  memoizedState?: unknown
  stateNode?: unknown
  dependencies?: {firstContext?: {memoizedValue?: unknown; next?: unknown} | null} | null
}

/**
 * Walk the React fiber tree looking for the Studio's own client. This is the
 * realistic "malicious plugin / injected script" path: nothing is exported, but
 * the live client is reachable from any page script through React internals.
 */
function findClientInFibers(budgetMs: number): SanityClient | null {
  if (typeof document === 'undefined') return null
  const roots: FiberLike[] = []
  const hosts: Element[] = [document.body, ...Array.from(document.body?.children ?? [])]
  for (const host of hosts) {
    if (!host) continue
    for (const key of Object.keys(host)) {
      if (!key.startsWith('__reactContainer$') && !key.startsWith('__reactFiber$')) continue
      const fiber = (host as unknown as Rec)[key]
      if (isRec(fiber)) roots.push(fiber as FiberLike)
    }
  }
  if (roots.length === 0) return null

  const started = performance.now()
  const queue: FiberLike[] = [...roots]
  let visited = 0
  while (queue.length > 0 && visited < 40_000) {
    if (visited % 32 === 0 && performance.now() - started > budgetMs) break
    const fiber = queue.shift()
    if (!fiber) continue
    visited += 1

    const candidates: unknown[] = [fiber.memoizedProps, fiber.stateNode]
    // hook chain (useState / useMemo / useRef values)
    let hook: unknown = fiber.memoizedState
    for (let i = 0; i < 60 && isRec(hook); i += 1) {
      const state = (hook as Rec).memoizedState
      candidates.push(state)
      if (isRec(state) && 'current' in state) candidates.push((state as Rec).current)
      hook = (hook as Rec).next
    }
    // consumed context values (the Studio source/workspace context holds `client`)
    let context: unknown = fiber.dependencies?.firstContext ?? null
    for (let i = 0; i < 20 && isRec(context); i += 1) {
      candidates.push((context as Rec).memoizedValue)
      context = (context as Rec).next
    }

    for (const candidate of candidates) {
      const hit = probeForClient(candidate, 0)
      if (hit) return hit
    }

    if (fiber.child) queue.push(fiber.child)
    if (fiber.sibling) queue.push(fiber.sibling)
  }
  return null
}

function factoryConfig(token: string | undefined): ClientConfig {
  const base: ClientConfig = {
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    useCdn: false,
    ignoreBrowserTokenWarning: true,
  }
  return token ? {...base, token} : {...base, withCredentials: true}
}

interface ClientHandle {
  client: SanityClient
  source: string
}

/**
 * Obtain the client to attack. Preference order:
 *  1. an explicit handle the orchestrator parked on `window.__SPIKE_F_CLIENT__`
 *  2. the LIVE Studio client, dug out of the React fiber tree
 *  3. a fresh client built through `spikeClientFactory` — the exact construction
 *     path the Studio uses (`unstable_clientFactory`), so it carries the same
 *     instrumentation + local-echo facade. Attacks against it are still valid
 *     tests of the facade, but they do not prove reachability of Studio's own
 *     instance; the report records which path was used.
 */
function obtainClient(token: string | undefined): ClientHandle {
  const injected = typeof window === 'undefined' ? undefined : window.__SPIKE_F_CLIENT__
  if (isClientLike(injected)) return {client: injected, source: 'window.__SPIKE_F_CLIENT__'}

  try {
    const fromFiber = findClientInFibers(2000)
    if (fromFiber) return {client: fromFiber, source: 'react-fiber-walk (live Studio client)'}
  } catch {
    /* fall through to the factory path */
  }

  const client = spikeClientFactory(factoryConfig(token))
  return {
    client,
    source: 'spikeClientFactory() (factory path — NOT the live Studio instance)',
  }
}

/* ------------------------------------------------------------- attack harness */

interface AttackCtx {
  studio: SanityClient
  studioSource: string
  token?: string
  /** stable per-run id, e.g. `spike-f-canary-1754308800000` */
  canaryBase: string
  canary: (label: string) => string
}

interface AttackSpec {
  name: string
  category: AttackCategory
  /** documented prediction; drives the expected-hole vs real-failure split */
  expectedHole: boolean
  /** severity to report IF the attack gets through */
  holeSeverity: AttackSeverity
  /** what the attack proves, prepended to the evidence string */
  claim: string
  /** endpoints that count as egress for this attack (default: write endpoints) */
  netPatterns?: RegExp[]
  /** canary ids this attack may have created; added to cleanup when not blocked */
  canaryIds?: (ctx: AttackCtx) => string[]
  run: (ctx: AttackCtx) => Promise<unknown>
  /** pull created ids (e.g. asset ids) out of a successful response */
  createdIds?: (value: unknown) => string[]
}

async function runOne(spec: AttackSpec, ctx: AttackCtx, cleanup: Set<string>): Promise<AttackResult> {
  const patterns = spec.netPatterns ?? WRITE_PATTERNS
  const echoBefore = blockedCount()
  const since = performance.now()

  let value: unknown
  let thrown: unknown
  let error: string | undefined
  try {
    value = await withTimeout(Promise.resolve(spec.run(ctx)), ATTACK_TIMEOUT_MS, spec.name)
  } catch (err) {
    thrown = err
    error = errText(err)
  }

  await delay(SETTLE_MS)

  const hits = netHitsSince(since, patterns)
  const facadeNote = blockedSince(echoBefore)
  const facadeRecorded = blockedCount() > echoBefore
  const answer = thrown === undefined ? {networkFailure: false} : serverAnswer(thrown)
  const answered = answer.status !== undefined
  const transportOnly = hits.length > 0 && hits.every(isTransportFailure)

  // "Reached an authorized endpoint" (§36.6) is true if EITHER a transport tap
  // saw a completed request OR the server itself answered the caller.
  const reached = hits.some((hit) => !isTransportFailure(hit)) || answered
  const escaped = reached || hits.length > 0 || answer.networkFailure
  const blocked = !escaped

  let severity: AttackSeverity
  let verdict: string
  if (reached) {
    severity = spec.holeSeverity
    verdict = answered
      ? `HOLE — the request reached the endpoint and the SERVER answered (HTTP ${answer.status === -2 ? 'unknown, Sanity error body present' : answer.status})`
      : 'HOLE — request reached the network'
  } else if (escaped) {
    severity = spec.holeSeverity
    verdict = transportOnly
      ? 'HOLE — the facade did not stop the call; the request was refused by the browser transport, not by the guard'
      : 'HOLE — the request left the client and failed at the transport layer'
  } else if (facadeRecorded) {
    severity = 'none'
    verdict = 'blocked by the facade'
  } else if (error) {
    // No egress, but nothing guarded it either: the call failed locally. If the
    // local failure were repaired the write might well escape, so this is not a
    // clean pass.
    severity = 'low'
    verdict = 'no egress, but the facade did not record it — the call failed client-side'
  } else {
    severity = 'medium'
    verdict = 'no egress and no facade record — unexplained, verify manually'
  }

  if (escaped) {
    for (const id of spec.canaryIds?.(ctx) ?? []) cleanup.add(id)
    for (const id of spec.createdIds?.(value) ?? []) cleanup.add(id)
  }

  const evidence = [
    spec.claim,
    verdict,
    describeHits(hits),
    facadeNote,
    `result=${summarizeValue(value)}`,
  ].join(' | ')

  return {
    name: spec.name,
    category: spec.category,
    attempted: true,
    blocked,
    expectedHole: spec.expectedHole,
    severity,
    evidence: evidence.slice(0, 900),
    ...(error ? {error} : {}),
  }
}

function summarizeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return String(value).slice(0, 120)
  try {
    return JSON.stringify(value).slice(0, 220)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/* ------------------------------------------------------------------- attacks */

function buildAttacks(): AttackSpec[] {
  const specs: AttackSpec[] = []

  /* --- 1-4: the write methods, straight through the facade ---------------- */

  specs.push({
    name: '01.client.create',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'PRD §36.6 "attempt client.create through facade"',
    canaryIds: (ctx) => [ctx.canary('create')],
    run: (ctx) => ctx.studio.create(canaryDoc(ctx.canary('create')) as never),
  })

  specs.push({
    name: '02.client.createOrReplace',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'createOrReplace is a distinct method on the write allowlist',
    canaryIds: (ctx) => [ctx.canary('cor')],
    run: (ctx) => ctx.studio.createOrReplace(canaryDoc(ctx.canary('cor')) as never),
  })

  specs.push({
    name: '03.client.createIfNotExists',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'createIfNotExists is a distinct method on the write allowlist',
    canaryIds: (ctx) => [ctx.canary('cine')],
    run: (ctx) => ctx.studio.createIfNotExists(canaryDoc(ctx.canary('cine')) as never),
  })

  specs.push({
    name: '04.client.delete',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'delete() must not reach /data/mutate (a destructive write)',
    run: (ctx) => ctx.studio.delete(ctx.canary('delete')),
  })

  /* --- 5-6: mutate, promise and observable -------------------------------- */

  specs.push({
    name: '05.client.mutate.promise',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'raw mutation array through the promise client',
    canaryIds: (ctx) => [ctx.canary('mutate')],
    run: (ctx) =>
      ctx.studio.mutate([{createOrReplace: canaryDoc(ctx.canary('mutate'))}] as never),
  })

  specs.push({
    name: '06.client.observable.mutate',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'the observable client is a separate object; subscribing is what fires the request',
    canaryIds: (ctx) => [ctx.canary('obsmutate')],
    run: (ctx) =>
      firstFromObservable(
        ctx.studio.observable.mutate([
          {createOrReplace: canaryDoc(ctx.canary('obsmutate'))},
        ] as never),
        'observable.mutate',
      ),
  })

  /* --- 7-8: fluent builders ----------------------------------------------- */

  specs.push({
    name: '07.client.patch.commit',
    category: 'facade-builder',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'patch() builders bind to the REAL client — commit() must be intercepted',
    run: (ctx) => ctx.studio.patch(ctx.canary('patch')).set({title: CANARY_TITLE}).commit(),
  })

  specs.push({
    name: '08.client.transaction.commit',
    category: 'facade-builder',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'transaction() builders bind to the REAL client — commit() must be intercepted',
    canaryIds: (ctx) => [ctx.canary('trx')],
    run: (ctx) =>
      ctx.studio
        .transaction()
        .createOrReplace(canaryDoc(ctx.canary('trx')) as never)
        .commit(),
  })

  /* --- 9-10: the Actions API ---------------------------------------------- */

  specs.push({
    name: '09.client.action.publish',
    category: 'facade-client',
    expectedHole: false,
    holeSeverity: 'critical',
    claim:
      'publish actions are blocked-but-not-echoed by the facade (multi-doc transactions) — verify they are still blocked',
    canaryIds: (ctx) => [ctx.canary('publish')],
    run: (ctx) =>
      ctx.studio.action({
        actionType: 'sanity.action.document.publish',
        draftId: `drafts.${ctx.canary('publish')}`,
        publishedId: ctx.canary('publish'),
      } as never),
  })

  specs.push({
    name: '10.client.withConfig.observable.action',
    category: 'facade-clone',
    expectedHole: false,
    holeSeverity: 'critical',
    claim:
      "Studio's own write path: client.withConfig({apiVersion}).observable.action(...) — the clone must stay wrapped",
    canaryIds: (ctx) => [ctx.canary('wcaction')],
    run: (ctx) =>
      firstFromObservable(
        ctx.studio.withConfig({apiVersion: API_VERSION}).observable.action({
          actionType: 'sanity.action.document.publish',
          draftId: `drafts.${ctx.canary('wcaction')}`,
          publishedId: ctx.canary('wcaction'),
        } as never),
        'withConfig.observable.action',
      ),
  })

  /* --- 11-13: raw endpoint access ----------------------------------------- */

  specs.push({
    name: '11.client.request.dataMutate',
    category: 'raw-endpoint',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'raw request() escape to /data/mutate',
    canaryIds: (ctx) => [ctx.canary('request')],
    run: (ctx) =>
      (ctx.studio as unknown as {request: (options: Rec) => Promise<unknown>}).request({
        url: `/data/mutate/${DATASET}`,
        method: 'POST',
        body: {mutations: [{createOrReplace: canaryDoc(ctx.canary('request'))}]},
      }),
  })

  specs.push({
    name: '12.client.dataRequest.mutate',
    category: 'raw-endpoint',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: "dataRequest('mutate') — Studio's live-edit path",
    canaryIds: (ctx) => [ctx.canary('datareq')],
    run: (ctx) =>
      (
        ctx.studio as unknown as {
          dataRequest: (endpoint: string, body: Rec, options?: Rec) => Promise<unknown>
        }
      ).dataRequest('mutate', {
        mutations: [{createOrReplace: canaryDoc(ctx.canary('datareq'))}],
      }),
  })

  specs.push({
    name: '13.client.dataRequest.actions',
    category: 'raw-endpoint',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: "dataRequest('actions') — the Actions API one level below client.action()",
    canaryIds: (ctx) => [ctx.canary('datareqact')],
    run: (ctx) =>
      (
        ctx.studio as unknown as {
          dataRequest: (endpoint: string, body: Rec, options?: Rec) => Promise<unknown>
        }
      ).dataRequest('actions', {
        actions: [
          {
            actionType: 'sanity.action.document.create',
            publishedId: ctx.canary('datareqact'),
            attributes: canaryDoc(ctx.canary('datareqact')),
            ifExists: 'ignore',
          },
        ],
      }),
  })

  /* --- 14-16: client copies ----------------------------------------------- */

  specs.push({
    name: '14.client.withConfig.datasetOverride',
    category: 'facade-clone',
    expectedHole: false,
    holeSeverity: 'critical',
    claim:
      'PRD §11.3 "overlay mutation endpoints accept only configured dataset" — does a dataset-swapped clone escape?',
    canaryIds: (ctx) => [ctx.canary('dsoverride')],
    run: (ctx) =>
      ctx.studio
        .withConfig({dataset: 'scratch'})
        .create(canaryDoc(ctx.canary('dsoverride')) as never),
  })

  specs.push({
    name: '15.client.withConfig.apiVersion.mutate',
    category: 'facade-clone',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'clone via config change — the facade must re-wrap withConfig() results',
    canaryIds: (ctx) => [ctx.canary('wcapiver')],
    run: (ctx) =>
      ctx.studio
        .withConfig({apiVersion: '2021-03-25'})
        .mutate([{createOrReplace: canaryDoc(ctx.canary('wcapiver'))}] as never),
  })

  specs.push({
    name: '16.client.clone.mutate',
    category: 'facade-clone',
    expectedHole: false,
    holeSeverity: 'critical',
    claim: 'clone() returns a new SanityClient — the facade must re-wrap it',
    canaryIds: (ctx) => [ctx.canary('clone')],
    run: (ctx) =>
      ctx.studio.clone().mutate([{createOrReplace: canaryDoc(ctx.canary('clone'))}] as never),
  })

  /* --- 17-19: gaps found by reading localEcho.ts -------------------------- */

  specs.push({
    name: '17.client.config.reconfigureEscape',
    category: 'facade-clone',
    expectedHole: false,
    holeSeverity: 'critical',
    claim:
      'GAP: SanityClient.config(newConfig) returns `this` — the RAW client — and localEcho does not re-wrap it. ' +
      'Demonstrated against a clone() so the live Studio client is never reconfigured',
    canaryIds: (ctx) => [ctx.canary('cfgescape')],
    run: async (ctx) => {
      const wrapped = ctx.studio.clone()
      const raw = wrapped.config({}) as unknown as SanityClient
      const identity = raw === wrapped ? 'config() returned the proxy (re-wrapped)' : 'config() returned an UNWRAPPED client'
      const result = await raw.create(canaryDoc(ctx.canary('cfgescape')) as never)
      return {identity, result}
    },
  })

  specs.push({
    name: '18.patch.clone.commit',
    category: 'facade-builder',
    expectedHole: false,
    holeSeverity: 'high',
    claim:
      'GAP: blockFluentCommit only re-wraps returns that are `this`. Patch.clone() returns a NEW Patch still bound to the real client',
    run: (ctx) =>
      (
        ctx.studio.patch(ctx.canary('patchclone')).set({title: CANARY_TITLE}) as unknown as {
          clone: () => {commit: () => Promise<unknown>}
        }
      )
        .clone()
        .commit(),
  })

  specs.push({
    name: '19.transaction.clone.commit',
    category: 'facade-builder',
    expectedHole: false,
    holeSeverity: 'high',
    claim: 'GAP: Transaction.clone() escapes blockFluentCommit for the same reason',
    canaryIds: (ctx) => [ctx.canary('trxclone')],
    run: (ctx) =>
      (
        ctx.studio.transaction().createOrReplace(canaryDoc(ctx.canary('trxclone')) as never) as unknown as {
          clone: () => {commit: () => Promise<unknown>}
        }
      )
        .clone()
        .commit(),
  })

  /* --- 20-21: request() URL allowlist gaps -------------------------------- */

  specs.push({
    name: '20.client.request.relativeUrlBypass',
    category: 'raw-endpoint',
    expectedHole: false,
    holeSeverity: 'high',
    claim:
      "GAP: localEcho's WRITE_URL_RE requires a leading slash (/\\/data\\/(mutate|actions)\\b/) but @sanity/client's _getUrl strips it — 'data/mutate/parity' is the same endpoint",
    canaryIds: (ctx) => [ctx.canary('relurl')],
    run: (ctx) =>
      (ctx.studio as unknown as {request: (options: Rec) => Promise<unknown>}).request({
        url: `data/mutate/${DATASET}`,
        method: 'POST',
        body: {mutations: [{createOrReplace: canaryDoc(ctx.canary('relurl'))}]},
      }),
  })

  specs.push({
    name: '21.client.request.assetsEndpoint',
    category: 'raw-endpoint',
    expectedHole: false,
    holeSeverity: 'high',
    claim:
      "GAP: WRITE_URL_RE covers only /data/mutate and /data/actions — the asset endpoint is not guarded at all. " +
      'Deliberately sends a text body so the upload cannot succeed: reaching the endpoint is the finding, creating an asset is not needed',
    createdIds: (value) => {
      const doc = isRec(value) ? (value as Rec).document : undefined
      const id = isRec(doc) ? (doc as Rec)._id : undefined
      return typeof id === 'string' ? [id] : []
    },
    run: (ctx) =>
      (ctx.studio as unknown as {request: (options: Rec) => Promise<unknown>}).request({
        url: `/assets/images/${DATASET}?filename=${ctx.canary('rawasset')}.txt`,
        method: 'POST',
        headers: {'Content-Type': 'image/png'},
        body: 'spike-f-canary-not-an-image',
      }),
  })

  /* --- 22-24: sub-clients (not functions -> never wrapped) ---------------- */

  specs.push({
    name: '22.client.assets.upload',
    category: 'sub-client',
    expectedHole: true,
    holeSeverity: 'high',
    claim:
      'PRD §36.6 "attempt asset direct upload". `client.assets` is an OBJECT property, so the facade returns it untouched and AssetsClient holds the real httpRequest (write-block-validation.md finding 8)',
    createdIds: (value) => {
      const id = isRec(value) ? (value as Rec)._id : undefined
      return typeof id === 'string' ? [id] : []
    },
    run: (ctx) =>
      ctx.studio.assets.upload('image', pngBlob(), {
        filename: `${ctx.canary('asset')}.png`,
      }),
  })

  specs.push({
    name: '23.client.agent.action.patch',
    category: 'sub-client',
    expectedHole: false,
    holeSeverity: 'high',
    claim:
      'GAP: `client.agent.action.patch` writes documents via POST /agent/action/patch/<dataset>, calls the module-level _request directly, and is covered by neither the facade nor the Spike B proxy allowlist (which lets /agent/* through)',
    canaryIds: (ctx) => [ctx.canary('agent')],
    run: (ctx) => {
      const agent = (
        ctx.studio as unknown as {
          agent?: {action?: {patch?: (request: Rec) => Promise<unknown>}}
        }
      ).agent
      const patch = agent?.action?.patch
      if (typeof patch !== 'function') throw new Error('client.agent.action.patch not available')
      return patch.call(agent?.action, {
        schemaId: 'sanity.workspace.schema.kitchen-sink',
        documentId: ctx.canary('agent'),
        forcePublishedWrite: true,
        target: {operation: 'set', path: 'title', value: CANARY_TITLE},
      })
    },
  })

  specs.push({
    name: '24.client.datasets.reachable',
    category: 'sub-client',
    expectedHole: false,
    holeSeverity: 'medium',
    claim:
      'GAP (non-destructive probe): `client.datasets` is an object property and is never wrapped. A GET reaching the network proves datasets.create()/.delete() would too — a project-plane mutation the facade cannot see',
    netPatterns: PROJECT_PATTERNS,
    run: (ctx) => ctx.studio.datasets.list(),
  })

  /* --- 25-26: total bypass (expected architectural holes) ----------------- */

  specs.push({
    name: '25.freshClient.create',
    category: 'bypass',
    expectedHole: true,
    holeSeverity: 'architectural',
    claim:
      'PRD §0.6 / §5.2: a NEW createClient() built from a credential reachable in page JS never touches the facade. This is the argument for a network-layer guard and a token-free preview',
    canaryIds: (ctx) => [ctx.canary('fresh')],
    run: (ctx) => {
      const fresh = createClient(factoryConfig(ctx.token))
      return fresh.create(canaryDoc(ctx.canary('fresh')) as never)
    },
  })

  specs.push({
    name: '26.rawFetch.dataMutate',
    category: 'bypass',
    expectedHole: true,
    holeSeverity: 'architectural',
    claim:
      'PRD §26.9 "preview calls native Sanity mutation endpoint" / "cross-site mutation request": raw fetch with whatever credential the page can reach',
    canaryIds: (ctx) => [ctx.canary('rawfetch')],
    run: async (ctx) => {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`
      const response = await fetch(`${API_HOST}/v${API_VERSION}/data/mutate/${DATASET}`, {
        method: 'POST',
        headers,
        credentials: ctx.token ? 'omit' : 'include',
        body: JSON.stringify({
          mutations: [{createOrReplace: canaryDoc(ctx.canary('rawfetch'))}],
        }),
      })
      const text = await response.text()
      return {status: response.status, body: text.slice(0, 200)}
    },
  })

  return specs
}

function pngBlob(): Blob {
  const binary = atob(PNG_1X1_B64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], {type: 'image/png'})
}

/* ------------------------------------------------- credential + persistence checks */

function credentialAttack(tokens: FoundToken[]): AttackResult {
  const bearer = tokens.filter((token) => token.value !== 'cookie')
  const cookies = tokens.filter((token) => token.value === 'cookie')
  const reachable = bearer.length > 0 || cookies.length > 0
  return {
    name: '27.credentials.exfiltration',
    category: 'credential',
    attempted: true,
    // "blocked" here means: no write-capable credential is reachable from page JS.
    blocked: !reachable,
    expectedHole: true,
    severity: reachable ? 'architectural' : 'none',
    evidence:
      `PRD §5.2 "preview deployments contain no Sanity write token" / §36.6 "remove write token from preview environment". ` +
      (reachable
        ? `A write-capable credential IS reachable from page JS: ${bearer.length} bearer token(s), ${cookies.length} cookie credential(s). ` +
          `Sources: ${tokens.map((token) => token.source).join(', ')}. ` +
          `In the Studio this is by design (localStorage __studio_auth_token_<projectId>), which is exactly why a facade cannot be the safety boundary — see attacks 25/26.`
        : 'No bearer token or JS-readable session cookie found; the page would have to rely on cookie auth marked HttpOnly.'),
  }
}

async function verifyPersistence(
  ctx: AttackCtx,
  cleanup: Set<string>,
): Promise<AttackResult> {
  const query = `*[_id match $pattern]._id`
  const params = {pattern: `${CANARY_PREFIX}*`}
  const assetQuery = `*[_type in ["sanity.imageAsset","sanity.fileAsset"] && originalFilename match $pattern]._id`
  let ids: string[] = []
  let error: string | undefined
  let via = 'fresh client'

  const readers: Array<{label: string; client: SanityClient}> = []
  try {
    readers.push({label: 'fresh client', client: createClient(factoryConfig(ctx.token))})
  } catch {
    /* ignore */
  }
  readers.push({label: 'facade client (read path passes through)', client: ctx.studio})

  for (const reader of readers) {
    try {
      const docs = (await withTimeout(
        reader.client.fetch<string[]>(query, params),
        ATTACK_TIMEOUT_MS,
        'verify.documents',
      )) as string[]
      const assets = (await withTimeout(
        reader.client.fetch<string[]>(assetQuery, params),
        ATTACK_TIMEOUT_MS,
        'verify.assets',
      )) as string[]
      ids = [...(docs ?? []), ...(assets ?? [])]
      via = reader.label
      error = undefined
      break
    } catch (err) {
      error = errText(err)
    }
  }

  for (const id of ids) cleanup.add(id)

  return {
    name: '28.verify.persistedCanaries',
    category: 'verification',
    attempted: true,
    // blocked = nothing persisted = the dataset is untouched.
    blocked: ids.length === 0,
    expectedHole: true,
    severity: ids.length > 0 ? 'architectural' : 'none',
    evidence:
      `Read-back over ${via} for ids matching "${CANARY_PREFIX}*". ` +
      (ids.length === 0
        ? 'Nothing persisted — no attack in this run reached Content Lake with write authority.'
        : `${ids.length} canary object(s) EXIST in ${DATASET}: ${ids.slice(0, 20).join(', ')}. ` +
          'This is server-side proof that a write landed; all ids are in report.cleanup.'),
    ...(error ? {error} : {}),
  }
}

/* -------------------------------------------------------------- preflight + run */

function preflight(): string | null {
  if (typeof window === 'undefined') return 'not running in a browser'
  if (window.__SPIKE_F_FORCE__ === true) return null
  let flag: string | null = null
  try {
    flag = window.localStorage.getItem('SPIKE_LOCAL_ECHO')
  } catch {
    flag = null
  }
  if (flag !== '1') {
    return (
      'localStorage.SPIKE_LOCAL_ECHO !== "1" — the write-block facade is NOT installed. ' +
      'Refusing to run: every attack would write to the dataset for real. ' +
      'Set the flag and reload the Studio, or set window.__SPIKE_F_FORCE__ = true for a deliberate control run.'
    )
  }
  if (window.__SPIKE_ECHO__?.enabled !== true) {
    return (
      'window.__SPIKE_ECHO__.enabled is not true — the facade flag is set but no client has been wrapped yet. ' +
      'Open a document pane so the Studio constructs its client, then re-run.'
    )
  }
  return null
}

function emptyReport(reason: string): AttackReport {
  return {
    ranAt: new Date().toISOString(),
    attacks: [
      {
        name: '00.preflight',
        category: 'verification',
        attempted: false,
        blocked: true,
        expectedHole: false,
        severity: 'none',
        evidence: reason,
      },
    ],
    summary: {total: 0, blocked: 0, holes: 0, expectedHoles: 0},
    tokensFound: [],
    cleanup: [],
  }
}

/**
 * Run the full attack pass. Never throws: every attack is individually guarded,
 * and a failure of one attack cannot abort the suite.
 */
export async function runAttackPass(): Promise<AttackReport> {
  const blocker = preflight()
  if (blocker) {
    const report = emptyReport(blocker)
    if (typeof window !== 'undefined') {
      window.__SPIKE_F__ = {runAttackPass, lastReport: report}
    }
    return report
  }

  const ranAt = new Date().toISOString()
  const cleanup = new Set<string>()
  const attacks: AttackResult[] = []

  installNetTap()
  try {
    // Credential discovery first: attacks 25/26 use whatever it finds.
    let handle: ClientHandle
    let tokens: FoundToken[] = []
    try {
      tokens = findCredentials(null)
    } catch {
      tokens = []
    }
    const preToken = tokens.find((token) => token.value !== 'cookie')?.value

    try {
      handle = obtainClient(preToken)
    } catch (err) {
      const report = emptyReport(`could not obtain a client to attack: ${errText(err)}`)
      if (typeof window !== 'undefined') window.__SPIKE_F__ = {runAttackPass, lastReport: report}
      return report
    }

    // Re-scan now that we hold a client — config().token is itself an exfil path.
    try {
      tokens = findCredentials(handle.client)
    } catch {
      /* keep the earlier scan */
    }
    const token = tokens.find((entry) => entry.value !== 'cookie')?.value

    const canaryBase = `${CANARY_PREFIX}${Date.now()}`
    const ctx: AttackCtx = {
      studio: handle.client,
      studioSource: handle.source,
      ...(token ? {token} : {}),
      canaryBase,
      canary: (label: string) => `${canaryBase}-${label}`,
    }

    attacks.push({
      name: '00.clientDiscovery',
      category: 'verification',
      attempted: true,
      blocked: handle.source.startsWith('spikeClientFactory'),
      expectedHole: true,
      severity: handle.source.startsWith('spikeClientFactory') ? 'none' : 'architectural',
      evidence:
        `Client under attack obtained via: ${handle.source}. ` +
        (handle.source.startsWith('spikeClientFactory')
          ? "The live Studio instance was NOT reachable from page JS; attacks run against an identically-constructed client, so they test the facade but not Studio-instance reachability."
          : "The LIVE Studio client is reachable from page JS (React internals), so any injected script or plugin can drive it directly."),
    })

    for (const spec of buildAttacks()) {
      try {
        attacks.push(await runOne(spec, ctx, cleanup))
      } catch (err) {
        // runOne is already guarded; this is belt-and-braces so the suite is total.
        attacks.push({
          name: spec.name,
          category: spec.category,
          attempted: true,
          blocked: false,
          expectedHole: spec.expectedHole,
          severity: 'medium',
          evidence: `harness failure — result indeterminate, treat as unproven`,
          error: errText(err),
        })
      }
    }

    attacks.push(credentialAttack(tokens))

    try {
      attacks.push(await verifyPersistence(ctx, cleanup))
    } catch (err) {
      attacks.push({
        name: '28.verify.persistedCanaries',
        category: 'verification',
        attempted: true,
        blocked: false,
        expectedHole: true,
        severity: 'medium',
        evidence: 'read-back failed — persistence unverified, clean up manually',
        error: errText(err),
      })
    }

    const scored = attacks.filter((attack) => attack.attempted && attack.category !== 'verification')
    const report: AttackReport = {
      ranAt,
      attacks,
      summary: {
        total: scored.length,
        blocked: scored.filter((attack) => attack.blocked).length,
        holes: scored.filter((attack) => !attack.blocked && !attack.expectedHole).length,
        expectedHoles: scored.filter((attack) => !attack.blocked && attack.expectedHole).length,
      },
      tokensFound: tokens.map(redact),
      cleanup: Array.from(cleanup).sort(),
    }

    if (typeof window !== 'undefined') window.__SPIKE_F__ = {runAttackPass, lastReport: report}
    return report
  } finally {
    removeNetTap()
  }
}

/* ------------------------------------------------------------ self-registration */

if (typeof window !== 'undefined') {
  window.__SPIKE_F__ = {runAttackPass, ...(window.__SPIKE_F__?.lastReport ? {lastReport: window.__SPIKE_F__.lastReport} : {})}
}
