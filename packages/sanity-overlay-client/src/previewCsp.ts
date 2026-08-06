/**
 * The Content-Security-Policy a deployed preview must serve, and the validator
 * that says whether a given policy actually closes the hole.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CSP, AND WHY IT IS NOT "BLOCK SANITY"
 *
 * A preview Studio runs in a browser holding the editor's own write-capable
 * credential (`localStorage.__studio_auth_token_<projectId>`, sent as
 * `Authorization: Bearer …`). No environment variable revokes that, and no
 * wrapper around `@sanity/client` survives a script that never uses the client.
 * The only layer that can stop page JS opening its own connection is the one
 * page JS does not implement: the browser.
 *
 * But `connect-src` is **origin-scoped, never method-scoped**. It cannot tell a
 * read from a write, so a policy that excluded `*.api.sanity.io` outright would
 * take reads and authentication down with it. That is not the requirement — the
 * requirement is that there is *no path to writing*, with reads and auth intact.
 *
 * So the shape is:
 *
 *   1. every Sanity request — reads and auth included — leaves through OUR OWN
 *      origin, the deployed equivalent of `spikeB-proxy/proxy.mjs`;
 *   2. the default-deny write guard runs there, server-side, where page JS
 *      cannot reach it (`previewWriteGuard.ts` is that classifier, packaged);
 *   3. `connect-src` then confines the page to our origin, so a script cannot
 *      open its own socket to `api.sanity.io` and go around step 2.
 *
 * Step 3 is what makes steps 1–2 non-optional rather than a suggestion. Without
 * it the guard is a speed bump; with it the guard is the only door.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS NOT
 *
 * It generates and checks a HEADER. It does not prove a browser honours it, and
 * nothing downstream may treat a passing assertion here as runtime evidence.
 * The standing rule in this project is that server-side logs are the only
 * trustworthy escape evidence; browser-side detection has produced a false
 * all-clear three times.
 *
 * Dependency-free on purpose: imported from Node (a route handler, a build
 * step), from a test, and potentially from a browser bundle.
 */

/** Directive name -> source list. Order is preserved when serialised. */
export type CspDirectives = Record<string, readonly string[]>

/**
 * Sanity-owned origins a browser could open a connection to, as concrete URLs
 * the validator can evaluate.
 *
 * DELIBERATELY WIDER THAN `stagingHost.ts`'s `isSanityApiHost`. That predicate
 * answers "would this request write to a dataset?" and is anchored narrowly at
 * `api`/`apicdn` so a GET to `www.sanity.io` is not swept up. This list answers
 * a different question — "which origins must a preview page be unable to open a
 * connection to?" — and erring wide costs nothing, because everything the
 * Studio legitimately needs is reached through our own origin instead.
 *
 * Sources: `@sanity/client` `initConfig` (`https://api.sanity.io`,
 * `https://apicdn.sanity.io`, and the `<projectId>.` project-hostname forms),
 * `sanity@6.8.0` `lib/index.js:1431` (`https://api.sanity.io/vX/intake/feedback`),
 * `lib/WorkspaceLoader-BRx2afZV.js:8300` (the `wss://…/socket/<ds>` bifur
 * channel), the auto-update module host `sanity-cdn.com`, the asset CDN
 * `cdn.sanity.io`, and the staging API host `api.sanity.work` that
 * `_createAuthStore` selects when `isStaging`.
 */
export const SANITY_BROWSER_ORIGINS: readonly string[] = Object.freeze([
  'https://api.sanity.io',
  'https://example.api.sanity.io',
  'https://apicdn.sanity.io',
  'https://example.apicdn.sanity.io',
  'https://cdn.sanity.io',
  'https://sanity-cdn.com',
  'https://core.sanity-cdn.com',
  'https://sanity.io',
  'https://www.sanity.io',
  'https://api.sanity.work',
  'wss://example.api.sanity.io',
  'wss://api.sanity.io',
])

export interface PreviewCspOptions {
  /**
   * The preview deployment's own origin, e.g. `https://my-app-git-x.vercel.app`.
   * Used to resolve `'self'` when validating, and reported in errors.
   */
  selfOrigin?: string
  /**
   * Extra `connect-src` sources. Refused if any of them would admit a Sanity
   * origin — see {@link previewCspDirectives}.
   */
  connectSrc?: readonly string[]
  /** Extra `img-src` sources. `https://cdn.sanity.io` is included by default. */
  imgSrc?: readonly string[]
  /** Extra `script-src` sources. */
  scriptSrc?: readonly string[]
  /** Extra `style-src` sources. */
  styleSrc?: readonly string[]
  /** Extra `font-src` sources. */
  fontSrc?: readonly string[]
}

/* ------------------------------------------------------------------ parse */

interface HostSource {
  scheme: string | null
  host: string
  port: string | null
}

/** Split a CSP header value into its directives. */
export function parseCspDirectives(header: unknown): CspDirectives {
  const out: Record<string, string[]> = {}
  if (typeof header !== 'string') return out
  for (const chunk of header.split(';')) {
    const tokens = chunk.trim().split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0) continue
    const name = tokens[0].toLowerCase()
    /* First declaration wins, matching CSP §2.2.1 "the user agent MUST ignore
     * occurrences after the first". A validator that took the LAST one would
     * report a policy the browser never applies. */
    if (out[name] === undefined) out[name] = tokens.slice(1)
  }
  return out
}

/**
 * The sources that actually govern `fetch` / `XHR` / `WebSocket` /
 * `EventSource` / `sendBeacon` for this policy.
 *
 * `connect-src` if present, otherwise `default-src`, otherwise `undefined` —
 * and `undefined` means **unrestricted**, which is a very different answer from
 * "an empty list".
 */
export function cspConnectSources(header: unknown): readonly string[] | undefined {
  const directives = parseCspDirectives(header)
  return directives['connect-src'] ?? directives['default-src']
}

function parseHostSource(source: string): HostSource | null {
  let rest = source.trim()
  if (rest === '') return null
  let scheme: string | null = null

  const withScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest)
  if (withScheme) {
    scheme = withScheme[1].toLowerCase()
    rest = rest.slice(withScheme[0].length)
  }

  /* Path and query are irrelevant to a connection check. */
  rest = rest.split('/')[0].split('?')[0].split('#')[0]
  if (rest === '') return null

  let port: string | null = null
  const colon = rest.lastIndexOf(':')
  if (colon > 0 && !rest.slice(colon + 1).includes('.')) {
    port = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  return {scheme, host: rest.toLowerCase().replace(/\.+$/, ''), port}
}

/** CSP host-source matching: `*.a.b` matches one **or more** leading labels. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) /* keeps the leading dot */
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return pattern === host
}

/**
 * `http:` also covers `https:`, and `ws:` also covers `wss:` — CSP §6.6.2.6
 * "scheme-part match", the upgrade allowance. The reverse is NOT true.
 */
function schemeMatches(source: string | null, target: string): boolean {
  if (source === null) return true
  if (source === target) return true
  if (source === 'http' && target === 'https') return true
  if (source === 'ws' && target === 'wss') return true
  return false
}

function originOf(url: string): {scheme: string; host: string; port: string} | null {
  try {
    const parsed = new URL(url)
    return {
      scheme: parsed.protocol.replace(/:$/, '').toLowerCase(),
      host: parsed.hostname.toLowerCase().replace(/\.+$/, ''),
      port: parsed.port,
    }
  } catch {
    return null
  }
}

function sourceAdmits(source: string, url: string, selfOrigin: string | undefined): boolean {
  const token = source.trim()
  if (token === '') return false
  const lower = token.toLowerCase()

  /* Keyword sources. `'none'`, `'unsafe-inline'`, nonces and hashes cannot
   * admit a network connection. `'self'` can, but only to our own origin —
   * which is never a Sanity origin, unless an operator literally deployed
   * onto one, which `selfOrigin` lets the caller state. */
  if (lower.startsWith("'")) {
    if (lower !== "'self'") return false
    if (selfOrigin === undefined) return false
    const self = originOf(selfOrigin)
    const target = originOf(url)
    if (self === null || target === null) return false
    return self.scheme === target.scheme && self.host === target.host && self.port === target.port
  }

  const target = originOf(url)
  if (target === null) return false

  /* A bare scheme source: `https:`, `data:`, `blob:`. */
  if (/^[a-z][a-z0-9+.-]*:$/i.exec(lower)) {
    return schemeMatches(lower.replace(/:$/, ''), target.scheme)
  }

  if (lower === '*') return true

  const pattern = parseHostSource(token)
  if (pattern === null) return false
  if (!schemeMatches(pattern.scheme, target.scheme)) return false
  if (!hostMatches(pattern.host, target.host)) return false
  if (pattern.port !== null && pattern.port !== '*' && pattern.port !== target.port) return false
  return true
}

/**
 * Could a page under this policy open a connection to `url`?
 *
 * **`true` is the alarming answer**: it means the policy does not close the
 * bypass. The function is deliberately built so that every uncertainty resolves
 * toward `true` — an absent directive is unrestricted, an unparseable source is
 * simply not counted as a restriction on anything else, and `'self'` only
 * matches when the caller has stated its own origin.
 */
export function cspPermitsSanityConnection(
  header: unknown,
  url: string,
  options: {selfOrigin?: string} = {},
): boolean {
  const sources = cspConnectSources(header)
  /* No governing directive at all: the browser applies no restriction. */
  if (sources === undefined) return true
  return sources.some((source) => sourceAdmits(source, url, options.selfOrigin))
}

/* ------------------------------------------------------------------ build */

function assertNoSanityAdmission(sources: readonly string[], selfOrigin: string | undefined): void {
  const header = `connect-src ${sources.join(' ')}`
  for (const origin of SANITY_BROWSER_ORIGINS) {
    if (!cspPermitsSanityConnection(header, origin, {selfOrigin})) continue
    throw new Error(
      `[sanity-overlay] refusing to build a preview CSP: the connect-src source list ` +
        `${JSON.stringify(sources.join(' '))} would permit a connection to the Sanity origin ` +
        `${origin}. A preview page must reach Sanity only through this deployment's own ` +
        `origin, where the default-deny write guard runs — a page that can open its own ` +
        `socket to Sanity can write with the editor's token and no server-side control sees it.`,
    )
  }
}

/**
 * The directives a deployed preview should serve.
 *
 * `connect-src` is the load-bearing one; everything else exists so the *other*
 * ways a page can reach an origin are closed too:
 *
 *   `frame-src` / `child-src`  an iframe or popup to a sanity.io origin would
 *                              run with its own, unrestricted policy
 *   `worker-src`               a service worker or shared worker likewise
 *   `form-action`              a form POST is not governed by `connect-src`
 *   `base-uri`                 a rewritten `<base>` re-targets relative URLs
 *   `object-src 'none'`        plugin content bypasses the lot
 *
 * `img-src` keeps `https://cdn.sanity.io`: an image load is a GET that cannot
 * carry a mutation body, and blocking it would blank every asset preview.
 */
export function previewCspDirectives(options: PreviewCspOptions = {}): CspDirectives {
  const connectSrc = ["'self'", ...(options.connectSrc ?? [])]
  assertNoSanityAdmission(connectSrc, options.selfOrigin)

  return {
    'default-src': ["'self'"],
    'connect-src': connectSrc,
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...(options.scriptSrc ?? [])],
    'style-src': ["'self'", "'unsafe-inline'", ...(options.styleSrc ?? [])],
    'img-src': ["'self'", 'data:', 'blob:', 'https://cdn.sanity.io', ...(options.imgSrc ?? [])],
    'font-src': ["'self'", 'data:', ...(options.fontSrc ?? [])],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ["'self'"],
    'child-src': ["'self'"],
    'frame-ancestors': ["'self'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
  }
}

/** Serialise directives into a `Content-Security-Policy` header value. */
export function serializeCspDirectives(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(' ')}`))
    .join('; ')
}

/** The header value itself. Throws rather than emit a policy that fails open. */
export function previewCspHeaderValue(options: PreviewCspOptions = {}): string {
  return serializeCspDirectives(previewCspDirectives(options))
}

/**
 * Every response header a preview deployment should set.
 *
 * `Content-Security-Policy` is the enforcement; the rest reduce the ways a
 * credential or a request can be induced to leave.
 */
export function previewSecurityHeaders(options: PreviewCspOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': previewCspHeaderValue(options),
    /* A cross-origin write is issued *by* the page, so `Referrer-Policy` does
     * not stop it — but it stops the preview URL itself (which names the branch)
     * leaking to any third party the page does reach. */
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    /* Turns off the browser APIs a hostile script could otherwise use to open a
     * side channel out of the preview. */
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  }
}
