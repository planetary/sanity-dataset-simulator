/**
 * The host-level refusal — **this system never writes to a real Sanity dataset.**
 *
 * Owner ruling, 2026-08-05. Branch edits go to local files under
 * `.sanity-overlay/` or, later, to a private Vercel Blob namespace. Pushing
 * content back to staging ("promotion") is out of scope permanently, and so is
 * uploading branch assets to Sanity's asset API. See the scope amendment at the
 * top of `docs/PRD-v1.md`.
 *
 * WHY A HOST GUARD, WHEN THREE PATH GUARDS ALREADY EXIST
 * ─────────────────────────────────────────────────────
 * The Track B proxy (`writeGuard.mjs`) is default-deny, the Studio facade
 * refuses every write plane it can name (`../../sanity-overlay-studio/src/client/
 * writeGuard.ts`), and origin mode serves writes from the overlay. All three ask
 * the same question — *"is this path a write endpoint?"* — and can only be as
 * right as their endpoint inventory. Spike F's finding was that the inventory is
 * never complete: `POST /projects/<p>/tokens`, `PUT /users/me/keyvalue/<k>`,
 * `POST /schedules/<p>/<d>` and `POST /descriptors/claim` all sailed through,
 * none of them under a guarded prefix.
 *
 * This module asks a different question that needs no inventory: **is this
 * request about to leave for a real Sanity API host with a method that can
 * change something?** It composes with the path guards rather than replacing
 * them — the path guards still own the proxy topology, where the very same paths
 * are legitimate because the host is a local proxy.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ────────────────────────────────
 *   - A bare path with no base resolves to no host, and is NOT refused. Guessing
 *     a host would fail *open* under the proxy topology (where the same path is
 *     fine) or fail *closed* on every relative read. The path guards own that
 *     layer; this one answers only when it knows the destination.
 *   - GET / HEAD / OPTIONS to a Sanity host are allowed. Reading live staging is
 *     the entire premise of the product (PRD §0.2 "shared base"), and the
 *     credential-gated hosted read-parity suites depend on it.
 *
 * Dependency-free on purpose: imported from Node, from a browser bundle, and
 * from the test-suite monitor.
 */

/** The one sentence every refusal in this project quotes. */
export const STAGING_WRITE_POLICY =
  'this system never writes to a real Sanity dataset (owner ruling, 2026-08-05); ' +
  'branch edits belong in the overlay'

/**
 * `api.sanity.io` and `apicdn.sanity.io`, plus any subdomain of either — which
 * is how a project-hostname client addresses its dataset
 * (`https://<projectId>.api.sanity.io`).
 *
 * Anchored at both ends. `api.sanity.io.evil.example` must NOT match (suffix
 * append), and neither must `xapi.sanity.io` (prefix append): the boundary is a
 * label boundary, not a substring.
 */
const SANITY_API_HOST_RE = /(^|\.)(api|apicdn)\.sanity\.io$/

/** Methods that cannot change server state. Everything else is treated as a write. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface StagingWriteTarget {
  /** HTTP method. Missing is treated as `GET`, matching `fetch` and `@sanity/client`. */
  method?: unknown
  /** Absolute URL, protocol-relative URL, `URL`, `Request`, or a path plus `base`. */
  url?: unknown
  /** Resolves a relative `url`. The client's own configured API host, normally. */
  base?: unknown
}

export class StagingWriteRefusedError extends Error {
  readonly code = 'STAGING_WRITE_REFUSED'
  readonly method: string
  readonly host: string
  readonly url: string

  constructor(details: {method: string; host: string; url: string; context?: string}) {
    super(
      `[sanity-overlay] refusing ${details.method} ${details.url}: ${STAGING_WRITE_POLICY}. ` +
        `${details.host} is a real Sanity API host` +
        (details.context === undefined ? '' : ` (${details.context})`) +
        '.',
    )
    this.name = 'StagingWriteRefusedError'
    this.method = details.method
    this.host = details.host
    this.url = details.url
  }
}

/** Normalise a hostname: lower-cased, trailing root dot removed, port stripped. */
export function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') return ''
  let host = value.trim().toLowerCase()
  /* `host` headers and legacy `http.request` options carry `name:port`. IPv6
   * literals are bracketed, so the last colon is only a port when unbracketed. */
  if (!host.startsWith('[')) {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && !host.slice(colon + 1).includes('.')) host = host.slice(0, colon)
  }
  return host.replace(/\.+$/, '')
}

/** Is this hostname a real Sanity API host? */
export function isSanityApiHost(host: unknown): boolean {
  const normalized = normalizeHost(host)
  return normalized !== '' && SANITY_API_HOST_RE.test(normalized)
}

/**
 * The destination host of a request, or `''` when it cannot be determined.
 *
 * `''` is the honest answer for a bare path, not a failure — see the module note
 * on why a guess would be worse than an abstention.
 */
export function hostOfRequest(target: StagingWriteTarget): string {
  const raw = readUrl(target.url)
  if (raw === '') return ''

  /* Protocol-relative (`//host/path`) is a real spelling `fetch` accepts. */
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw
  const base = readUrl(target.base)

  try {
    return normalizeHost(new URL(candidate).hostname)
  } catch {
    /* Relative — only resolvable against a base. */
  }
  if (base === '') return ''
  try {
    return normalizeHost(new URL(candidate, base).hostname)
  } catch {
    return ''
  }
}

function readUrl(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof URL) return value.href
  if (typeof value === 'object' && value !== null) {
    const url = (value as {url?: unknown}).url
    if (typeof url === 'string') return url.trim()
  }
  return ''
}

/** Read a method, defaulting to `GET` exactly as `fetch` and `@sanity/client` do. */
export function normalizeMethod(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : 'GET'
}

/**
 * Would this request write to a real Sanity dataset?
 *
 * The conjunction is deliberate and both halves are load-bearing: an unsafe
 * method to a local proxy is fine (that is the whole Track B topology), and a
 * GET to Sanity is fine (that is the whole product).
 */
export function isStagingWrite(target: StagingWriteTarget): boolean {
  if (SAFE_METHODS.has(normalizeMethod(target.method))) return false
  return isSanityApiHost(hostOfRequest(target))
}

/** Refuse, loudly and with a code, if this request would write to Sanity. */
export function assertNoStagingWrite(target: StagingWriteTarget, context?: string): void {
  if (!isStagingWrite(target)) return
  throw new StagingWriteRefusedError({
    method: normalizeMethod(target.method),
    host: hostOfRequest(target),
    url: readUrl(target.url),
    ...(context === undefined ? {} : {context}),
  })
}

/**
 * Wrap any `fetch` so that a write to a Sanity host never reaches the network.
 *
 * The check happens *before* delegation, so the underlying implementation is
 * never called — which is what makes "no request left this process" assertable
 * rather than merely hoped for.
 *
 * It REJECTS rather than throwing synchronously. `fetch` never throws
 * synchronously, and a wrapper that did would escape every `.catch()` its caller
 * has — including `createOverlayTransport`'s, which would then report a totally
 * different failure than the one that happened.
 */
export function createStagingSafeFetch(impl: typeof fetch, context?: string): typeof fetch {
  return ((input: unknown, init?: {method?: unknown}) => {
    const method =
      init?.method ??
      (typeof input === 'object' && input !== null ? (input as {method?: unknown}).method : undefined)
    try {
      assertNoStagingWrite({method, url: input}, context)
    } catch (error) {
      return Promise.reject(error)
    }
    return (impl as unknown as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
  }) as unknown as typeof fetch
}
