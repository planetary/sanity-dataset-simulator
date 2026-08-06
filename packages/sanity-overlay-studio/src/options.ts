/**
 * Configuration resolution for `sanity-overlay-studio` (PRD §11.1–§11.3).
 *
 * Everything the lab rig used to express as a `localStorage` flag typed into
 * devtools is expressed here as a plugin option or an environment variable, and
 * resolved once, deterministically, with no globals read.
 *
 * DEPENDENCY-FREE ON PURPOSE. This module is imported from the Studio browser
 * bundle, from Node (vitest, tooling) and from the config wrapper, so it must
 * not touch `window`, `process`, `sanity` or `@sanity/client`. The environment
 * is *passed in*.
 */

/** PRD §11.1 `SanityOverlayConfig.mode`. */
export const OVERLAY_MODES = ['off', 'fs', 'blob', 'memory'] as const

export type OverlayMode = (typeof OVERLAY_MODES)[number]

export interface OverlayStudioOptions {
  /**
   * `off` restores native Sanity behaviour. Anything else routes reads and
   * writes through the overlay. Defaults to `fs` — see {@link resolveOverlayOptions}.
   */
  mode?: OverlayMode
  /** Base URL of the overlay API (the overlay server, or a Next route group). */
  apiUrl?: string
  /**
   * Bare origin of a Track B proxy. When set it is injected as `apiHost` into
   * every `ClientConfig`, so the proxy — not the browser — is the enforcement
   * boundary (the "D13 hybrid"). `@sanity/client` builds
   * `<projectId>.<apiHost>`, so this must be an origin with no path.
   */
  apiHost?: string
  /** PRD §12.1 overlay id. Derived from the Vercel git identity when omitted. */
  overlayId?: string
  /** `leave` keeps Comments/Tasks/Releases/… enabled. Default is `disable`. */
  hostedFeatures?: 'disable' | 'leave'
  /** Refuse GROQ the overlay cannot answer exactly, instead of degrading. */
  strictQueries?: boolean
}

export interface ResolvedOverlayOptions {
  /** `false` only in `off` mode. */
  enabled: boolean
  mode: OverlayMode
  apiUrl: string
  apiHost: string | null
  overlayId: string | null
  strictQueries: boolean
  disableHostedFeatures: boolean
  /** Non-fatal problems the Studio should surface rather than swallow. */
  warnings: string[]
}

export type OverlayEnv = Record<string, string | undefined>

const DEFAULT_API_URL = 'http://localhost:3998'

/**
 * Read one setting under both spellings.
 *
 * A Studio is a Vite bundle and Vite only exposes `SANITY_STUDIO_*` to browser
 * code, so PRD §11.2's server spellings (`OVERLAY_MODE`, …) are simply absent in
 * the runtime that matters. Both are accepted and the browser-visible one wins,
 * so a value that is actually reachable is never shadowed by one that is not.
 */
function envValue(env: OverlayEnv, name: string): string | undefined {
  return blankToUndefined(env[`SANITY_STUDIO_${name}`]) ?? blankToUndefined(env[name])
}

/**
 * Blank is *unset*, not a value.
 *
 * Spike A's scar (`instrumentedClient.ts:157-174`): a blank flag read as
 * "configured" at the decision site and as falsy at the injection site, so
 * Studio ran with neither a proxy nor a facade. Whitespace was injected verbatim.
 */
function blankToUndefined(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function isOverlayMode(value: string): value is OverlayMode {
  return (OVERLAY_MODES as readonly string[]).includes(value)
}

/** Truthy flag spellings. Anything else — including blank — is unset. */
function envFlag(env: OverlayEnv, name: string): boolean | undefined {
  const raw = envValue(env, name)
  if (raw === undefined) return undefined
  const lower = raw.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true
  if (['0', 'false', 'no', 'off'].includes(lower)) return false
  return undefined
}

/**
 * PRD §11.3: "Throw at startup if `OVERLAY_MODE` is `fs` or `blob` and a general
 * Sanity write token is present in the application runtime."
 *
 * Widened to *any* overlay mode and to the Studio bundle specifically. A
 * `SANITY_STUDIO_`-prefixed token is compiled into JavaScript that ships to the
 * browser, so its presence is both a write-escape hazard and a credential leak;
 * neither is something to warn about and continue past.
 */
const WRITE_TOKEN_PATTERN = /WRITE_TOKEN$/

function assertNoWriteToken(env: OverlayEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!WRITE_TOKEN_PATTERN.test(key)) continue
    if (blankToUndefined(value) === undefined) continue
    throw new Error(
      `[sanity-overlay-studio] refusing to start: a write token is present in the Studio ` +
        `environment as \`${key}\`. In overlay mode no write-capable Sanity credential may ` +
        `exist in the browser bundle (PRD §11.3). Remove it, or set OVERLAY_MODE=off to run ` +
        `native Sanity.`,
    )
  }
}

/** PRD §12.1 — stable across preview redeployments; PR id beats branch name. */
function deriveOverlayId(env: OverlayEnv): string | null {
  const pr = envValue(env, 'VERCEL_GIT_PULL_REQUEST_ID')
  if (pr !== undefined) return `pr-${pr}`
  const ref = envValue(env, 'VERCEL_GIT_COMMIT_REF')
  if (ref !== undefined) return `branch-${ref}`
  return null
}

function assertApiUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      `[sanity-overlay-studio] the overlay API URL must be absolute, got ${JSON.stringify(value)}. ` +
        `The Studio runs in a browser and has no base to resolve a relative URL against.`,
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[sanity-overlay-studio] the overlay API URL must be http or https, got ` +
        `${JSON.stringify(value)}.`,
    )
  }
}

/**
 * Resolve plugin options plus environment into the one settled configuration
 * every other module in this package reads.
 *
 * THE DEFAULT MODE IS THE SAFETY DECISION. It is `fs`, not `off`. Installing
 * this plugin is the opt-in; defaulting to `off` would mean a consumer who added
 * the one line and forgot the env var would keep editing staging while believing
 * they were on a branch — the exact failure the product exists to prevent.
 */
export function resolveOverlayOptions(
  options: OverlayStudioOptions = {},
  env: OverlayEnv = {},
): ResolvedOverlayOptions {
  const warnings: string[] = []

  const modeSource = options.mode ?? envValue(env, 'OVERLAY_MODE')
  if (modeSource === undefined) {
    warnings.push(
      `[sanity-overlay-studio] no mode configured; defaulting to "fs". Set OVERLAY_MODE (or ` +
        `SANITY_STUDIO_OVERLAY_MODE) explicitly — "off" restores native Sanity behaviour.`,
    )
  }
  const modeRaw = modeSource ?? 'fs'
  if (!isOverlayMode(modeRaw)) {
    throw new Error(
      `[sanity-overlay-studio] unknown overlay mode ${JSON.stringify(modeRaw)}. ` +
        `Expected one of: ${OVERLAY_MODES.join(', ')}.`,
    )
  }
  const mode: OverlayMode = modeRaw

  if (mode !== 'off') assertNoWriteToken(env)

  if (mode === 'blob') {
    throw new Error(
      `[sanity-overlay-studio] mode "blob" is configured but no Blob store adapter ships yet. ` +
        `Use "fs" for local branch editing, or "off" for native Sanity.`,
    )
  }

  const apiUrl = options.apiUrl ?? envValue(env, 'OVERLAY_API_URL') ?? DEFAULT_API_URL
  assertApiUrl(apiUrl)

  const apiHostRaw = blankToUndefined(options.apiHost) ?? envValue(env, 'OVERLAY_API_HOST')
  const apiHost = apiHostRaw ?? null
  if (apiHost !== null) {
    let parsed: URL | null = null
    try {
      parsed = new URL(apiHost)
    } catch {
      warnings.push(
        `[sanity-overlay-studio] apiHost ${JSON.stringify(apiHost)} is not a URL; ` +
          `@sanity/client builds "<projectId>.<apiHost>" and will produce a broken host.`,
      )
    }
    if (parsed !== null && parsed.pathname !== '/' && parsed.pathname !== '') {
      warnings.push(
        `[sanity-overlay-studio] apiHost ${JSON.stringify(apiHost)} carries a path. ` +
          `@sanity/client expects a bare origin — the path will be dropped.`,
      )
    }
  }

  const hostedFeatures =
    options.hostedFeatures ?? (envFlag(env, 'OVERLAY_HOSTED_FEATURES') === true ? 'leave' : undefined)

  return {
    enabled: mode !== 'off',
    mode,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiHost,
    overlayId: blankToUndefined(options.overlayId) ?? deriveOverlayId(env),
    strictQueries: options.strictQueries ?? envFlag(env, 'OVERLAY_STRICT_QUERIES') ?? true,
    disableHostedFeatures: mode !== 'off' && hostedFeatures !== 'leave',
    warnings,
  }
}
