/**
 * The suite-wide outbound-request monitor — promoted from the throwaway
 * `recordOutboundRequests()` in `test/spike-a-client-identity.test.ts` into a
 * permanent, always-installed guard.
 *
 * WHY IT EXISTS
 * ─────────────
 * The suite exercises a REAL `@sanity/client` in several files. Most of that is
 * safe because the client's observable API is lazy — an observable built and
 * dropped opens no socket. `client.assets.upload(...)` is not in that family: it
 * returns a promise and issues `POST /assets/images/<dataset>` immediately. That
 * made the suite perform a real write against a real project on every run, and
 * it was harmless only by the accident of the ambient token's permissions (it
 * 403s). A token that happened to be allowed to write would have uploaded an
 * asset from a unit test.
 *
 * The spike version proved the interception technique and then threw it away
 * after one file. This version is installed by `vitest.setup.ts` into **every**
 * test file in the package, so "no test writes to Sanity" is a property of the
 * suite rather than of one file's discipline.
 *
 * OBSERVE VS ENFORCE
 * ──────────────────
 * The spike version *blocked everything*, which is why it could only run inside
 * one `run()` callback. This one **passes traffic through** — the suite really
 * does talk to loopback servers, and the credential-gated hosted read-parity
 * tests really do GET `*.api.sanity.io` — and refuses exactly one class:
 *
 *     a non-GET/HEAD/OPTIONS request addressed to a `sanity.io` host.
 *
 * INDEPENDENCE FROM THE RUNTIME GUARD
 * ───────────────────────────────────
 * `isMonitoredSanityHost` is deliberately NOT `isSanityApiHost` from
 * `sanity-overlay-client/src/stagingHost.ts`, even though the two answer almost
 * the same question. If the monitor imported the guard's predicate, one bug
 * would blind the guard and its own oracle in the same instant. So the monitor
 * keeps its own, deliberately BROADER rule — any `sanity.io` host at all — which
 * is the safe direction, and `no-staging-writes.test.ts` pins the relationship:
 * everything the runtime guard calls a Sanity API host, the monitor also sees.
 *
 * WHAT IT CANNOT SEE
 * ──────────────────
 *   - `node:http2` and raw `net`/`tls` sockets. Nothing in this project uses
 *     them for Sanity traffic; the Spike B proxy's TLS work is loopback-only.
 *   - A test that replaces `globalThis.fetch` wholesale after setup runs. Such a
 *     test is by definition not making a real request.
 *   - `undici`'s `request`/`stream` APIs, if a dependency ever used them
 *     directly instead of `fetch`.
 */
import http from 'node:http'
import https from 'node:https'

export const OUTBOUND_REFUSAL_CODE = 'STAGING_WRITE_IN_TEST'

/** One outbound request the suite attempted. */
export interface OutboundAttempt {
  method: string
  url: string
  host: string
  transport: 'https' | 'http' | 'fetch'
  /** Did the monitor refuse it? */
  refused: boolean
}

export class StagingWriteInTestError extends Error {
  readonly code = OUTBOUND_REFUSAL_CODE
  readonly method: string
  readonly host: string
  readonly url: string

  constructor(attempt: OutboundAttempt) {
    super(
      `[testkit] blocked ${attempt.method} ${attempt.url}: this system never writes to a real ` +
        `Sanity dataset (owner ruling, 2026-08-05), and the test suite is held to the same rule. ` +
        `${attempt.host} is a Sanity host and ${attempt.method} is not a read. If this is a ` +
        `legitimate hosted READ, use GET; there is no legitimate hosted write.`,
    )
    this.name = 'StagingWriteInTestError'
    this.method = attempt.method
    this.host = attempt.host
    this.url = attempt.url
  }
}

/** Any `sanity.io` host, deliberately broader than the runtime guard's rule. */
const SANITY_SUFFIX_RE = /(^|\.)sanity\.io$/

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const attempts: OutboundAttempt[] = []
let installed = false

/** Every outbound request this test file has attempted, in order. */
export function outboundAttempts(): readonly OutboundAttempt[] {
  return attempts
}

export function isOutboundRequestMonitorInstalled(): boolean {
  return installed
}

/** Strip a port and a trailing root dot; lower-case. */
function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase()
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close !== -1) host = host.slice(1, close)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && /^\d*$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  }
  return host.replace(/\.+$/, '')
}

/**
 * Is this URL — or bare hostname — addressed to Sanity?
 *
 * Parsed with `URL` rather than pattern-matched over the raw string, because the
 * historical escapes were all *spelling* bugs: a hostname that appears in a
 * query string or a path segment is not a destination.
 */
export function isMonitoredSanityHost(value: string): boolean {
  const raw = value.trim()
  if (raw === '') return false
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw
  let host: string
  try {
    host = normalizeHost(new URL(candidate).hostname)
  } catch {
    /* Not a URL — treat it as a bare hostname, which is how the legacy
     * `http.request({hostname})` form arrives. */
    host = normalizeHost(raw)
    if (host.includes('/')) return false
  }
  return host !== '' && SANITY_SUFFIX_RE.test(host)
}

function describeNodeArgs(scheme: 'https' | 'http', args: unknown[]): {method: string; url: string} {
  const [first, second] = args as [unknown, {method?: unknown} | undefined]

  if (typeof first === 'string' || first instanceof URL) {
    const method =
      typeof second === 'object' && second !== null && typeof second.method === 'string'
        ? second.method
        : 'GET'
    return {method: method.toUpperCase(), url: String(first)}
  }

  const options = (first ?? {}) as {
    method?: unknown
    hostname?: unknown
    host?: unknown
    port?: unknown
    path?: unknown
    protocol?: unknown
  }
  const host = String(options.hostname ?? options.host ?? '')
  const protocol = typeof options.protocol === 'string' ? options.protocol.replace(':', '') : scheme
  const port = options.port === undefined ? '' : `:${String(options.port)}`
  const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET'
  return {method, url: `${protocol}://${host}${port}${String(options.path ?? '')}`}
}

/**
 * Record an attempt and refuse it if it is a write to Sanity.
 *
 * The attempt is pushed BEFORE the throw on purpose: a refusal that erases its
 * own evidence makes the failure much harder to trace back to the call site.
 */
function judge(
  transport: OutboundAttempt['transport'],
  method: string,
  url: string,
  hostHint?: string,
): void {
  const host = hostHint ?? hostFromUrl(url)
  const refused = !READ_METHODS.has(method) && isMonitoredSanityHost(host === '' ? url : host)
  attempts.push({method, url, host, transport, refused})
  if (refused) throw new StagingWriteInTestError({method, url, host, transport, refused})
}

function hostFromUrl(url: string): string {
  const candidate = url.startsWith('//') ? `https:${url}` : url
  try {
    return normalizeHost(new URL(candidate).hostname)
  } catch {
    return ''
  }
}

function methodOfFetchInput(input: unknown, init?: {method?: unknown}): string {
  const raw =
    (init as {method?: unknown} | undefined)?.method ??
    (typeof input === 'object' && input !== null ? (input as {method?: unknown}).method : undefined)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toUpperCase() : 'GET'
}

function urlOfFetchInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null) {
    const url = (input as {url?: unknown}).url
    if (typeof url === 'string') return url
  }
  return String(input)
}

/**
 * Patch the four Node entry points and `fetch`. Idempotent, so a setup file that
 * runs more than once in a worker does not stack wrappers.
 *
 * `https.get` is patched separately from `https.request` because Node's `get`
 * calls the module-internal `request`, not `module.exports.request` — patching
 * only `request` therefore leaves `get` wide open. That is exactly the kind of
 * near-miss the spike version would not have caught.
 */
export function installOutboundRequestMonitor(): void {
  if (installed) return
  installed = true

  const patchNode = (
    module: typeof https | typeof http,
    key: 'request' | 'get',
    scheme: 'https' | 'http',
  ): void => {
    const real = module[key] as (...args: unknown[]) => unknown
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      const {method, url} = describeNodeArgs(scheme, args)
      judge(scheme, method, url)
      return Reflect.apply(real, this, args)
    }
    ;(module as unknown as Record<string, unknown>)[key] = patched
  }

  patchNode(https, 'request', 'https')
  patchNode(https, 'get', 'https')
  patchNode(http, 'request', 'http')
  patchNode(http, 'get', 'http')

  const realFetch = globalThis.fetch
  if (typeof realFetch === 'function') {
    globalThis.fetch = ((input: unknown, init?: {method?: unknown}) => {
      const url = urlOfFetchInput(input)
      const method = methodOfFetchInput(input, init)
      try {
        judge('fetch', method, url)
      } catch (error) {
        /* `fetch` rejects; it does not throw synchronously. */
        return Promise.reject(error)
      }
      return (realFetch as unknown as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
    }) as unknown as typeof fetch
  }
}
