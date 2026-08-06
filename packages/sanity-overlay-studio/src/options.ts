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

import {
  blankToUndefined,
  overlayEnvKeys,
  overlayEnvValue,
} from '../../sanity-overlay-client/src/env'
import {hostOfRequest, isSanityApiHost} from '../../sanity-overlay-client/src/stagingHost'

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
 * Read one setting under EVERY accepted spelling.
 *
 * A Studio is a Vite bundle and Vite only exposes `SANITY_STUDIO_*` to browser
 * code, so PRD §11.2's server spellings (`OVERLAY_MODE`, …) are simply absent in
 * the runtime that matters. All three prefixes are accepted, and two that
 * disagree are refused rather than ranked.
 *
 * IMPORTED, NOT REIMPLEMENTED. This is the same function
 * `sanity-overlay-client`'s `overlayClientConfigFromEnv` reads with. Three
 * divergent private copies of this logic is what produced a deployment that set
 * one spelling and was read by a package expecting another. The import keeps
 * "one vocabulary" a fact about the code rather than a convention; it costs the
 * bundle nothing but a two-element array, and this module stays free of
 * `window`, `process`, `sanity` and `@sanity/client` as its header requires.
 */
const envValue = overlayEnvValue

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
 * ───────────────────────────────────────────────────────────────────────────
 * PRD §11.3: "Throw at startup if `OVERLAY_MODE` is `fs` or `blob` and a general
 * Sanity write token is present in the application runtime." Widened to *any*
 * overlay mode and to the Studio bundle specifically: a `SANITY_STUDIO_`-prefixed
 * credential is compiled into JavaScript that ships to the browser, so it is
 * both a write-escape hazard and a credential leak.
 *
 * THE FAIL-OPEN THIS REPLACES. The check used to be `/WRITE_TOKEN$/`, which
 * tests a naming CONVENTION rather than a capability — and tested the wrong half
 * of it. Measured against the real spellings:
 *
 *     CAUGHT   SANITY_WRITE_TOKEN, SANITY_STUDIO_WRITE_TOKEN, SANITY_API_WRITE_TOKEN
 *     MISSED   SANITY_API_TOKEN, SANITY_TOKEN, SANITY_DEPLOY_TOKEN
 *
 * `SANITY_API_TOKEN` is the name Sanity's own documentation uses most, so the
 * single likeliest way a write-capable credential reaches a preview was exactly
 * the spelling the check could not see.
 *
 * WHY IT IS STILL NAME-BASED, DELIBERATELY. Capability cannot be read off a
 * name; establishing it means asking Sanity, which is a network call at startup.
 * A probe that fails open when the network is down would answer "no write token"
 * for precisely the reason it could not tell — worse than no probe, because it
 * looks like evidence. It would also put a boot-time round trip on the critical
 * path of every Studio load. So: name-based, and FAIL CLOSED. A Sanity-scoped
 * credential whose name does not positively say "read-only" is treated as
 * write-capable. The cost is a false positive on an oddly-named read token,
 * which fails loudly at startup and is one rename from fixed.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** The credential nouns. Anchored at the end: `SANITY_API_VERSION` is not one. */
const CREDENTIAL_NOUN = /(?:^|_)(?:TOKEN|SECRET|API_?KEY|CREDENTIALS?|PASSWORD|PAT)$/

/**
 * `SANITY` as a NAME LABEL, never a substring — `INSANITY_TOKEN` and
 * `SANITYX_TOKEN` are somebody else's credentials and refusing them would make
 * this check a nuisance that gets disabled.
 */
const SANITY_SCOPED = /(?:^|_)SANITY(?:$|_)/

/**
 * A name that positively asserts read-only. Label-matched for the same reason:
 * `SANITY_ALREADY_TOKEN` and `SANITY_BREADCRUMB_TOKEN` contain the letters
 * "read" and assert nothing.
 */
const READ_ONLY_SCOPED = /(?:^|_)(?:READ|READONLY|READ_ONLY|VIEWER|VIEWERONLY)(?:$|_)/

/** Prefixes a Vite Studio build inlines into the browser bundle. */
const BROWSER_REACHABLE = /^(?:SANITY_STUDIO|NEXT_PUBLIC|VITE|PUBLIC)_/

export type TokenEnvVerdict = 'not-a-credential' | 'read-only' | 'write-capable-or-unknown'

/**
 * What kind of credential, if any, does this environment variable NAME describe?
 *
 * Exported so a deployment check, a CI scan and the Studio all ask one question
 * rather than three that drift.
 */
export function classifyTokenEnvKey(key: string): TokenEnvVerdict {
  const name = key.toUpperCase()
  if (!CREDENTIAL_NOUN.test(name)) return 'not-a-credential'
  /* `WRITE_TOKEN` with no Sanity scoping is kept from the previous check: it is
   * the spelling this project's own docs and scripts used. */
  if (!SANITY_SCOPED.test(name) && !name.endsWith('WRITE_TOKEN')) return 'not-a-credential'
  if (READ_ONLY_SCOPED.test(name)) return 'read-only'
  return 'write-capable-or-unknown'
}

/** Is this variable inlined into JavaScript that ships to a browser? */
export function isBrowserReachableEnvKey(key: string): boolean {
  return BROWSER_REACHABLE.test(key.toUpperCase())
}

function assertNoWriteToken(env: OverlayEnv, warnings: string[]): void {
  for (const [key, value] of Object.entries(env)) {
    if (blankToUndefined(value) === undefined) continue
    const verdict = classifyTokenEnvKey(key)
    if (verdict === 'not-a-credential') continue

    if (verdict === 'read-only') {
      /* A read token cannot write, so it is not a §11.3 refusal — it is the
       * recommended server-side architecture. In the BROWSER bundle it is still
       * a credential handed to every visitor, which must not pass in silence. */
      if (isBrowserReachableEnvKey(key)) {
        warnings.push(
          `[sanity-overlay-studio] \`${key}\` names a read-only Sanity credential but carries a ` +
            `browser-reachable prefix, so its value is compiled into the bundle and served to ` +
            `every visitor. It cannot write, so the overlay still starts — but move it to a ` +
            `server-only variable.`,
        )
      }
      continue
    }

    throw new Error(
      `[sanity-overlay-studio] refusing to start: \`${key}\` names a Sanity credential whose ` +
        `capability cannot be established from its name, so it is treated as write-capable. In ` +
        `overlay mode no write-capable Sanity credential may exist in the application runtime ` +
        `(PRD §11.3) — the browser already holds the editor's own token, and a second one that ` +
        `outlives their session is a write path nothing here can revoke. Remove it, rename it to ` +
        `say read-only (e.g. \`SANITY_API_READ_TOKEN\`), or set OVERLAY_MODE=off for native Sanity.`,
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
      `[sanity-overlay-studio] no mode configured; defaulting to "fs". Set one of ` +
        `${overlayEnvKeys('OVERLAY_MODE').join(', ')} explicitly — "off" restores native ` +
        `Sanity behaviour.`,
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

  if (mode !== 'off') assertNoWriteToken(env, warnings)

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
    /*
     * A FAIL-OPEN, CLOSED. `apiHost` is the whole point of the D13 hybrid: it
     * moves the enforcement boundary off the browser and onto a proxy we own.
     * An `apiHost` that IS Sanity configures a "proxy" that is the thing being
     * proxied — every write-blocking control downstream then classifies traffic
     * that is already on its way to the Content Lake, and the deployment looks
     * correctly configured while enforcing nothing.
     *
     * Host-anchored, so every spelling of the same destination is refused at
     * once: case, trailing dot, explicit port, userinfo and the project-hostname
     * form `<projectId>.api.sanity.io` (which is also what @sanity/client builds
     * from a bare `https://api.sanity.io`). This throws rather than warns —
     * `resolveOverlayOptions`'s warnings are surfaced in a banner nobody reads
     * before the first edit, and by then the write has happened.
     */
    if (isSanityApiHost(hostOfRequest({url: apiHost}))) {
      throw new Error(
        `[sanity-overlay-studio] refusing to start: apiHost ${JSON.stringify(apiHost)} is a real ` +
          `Sanity API host. apiHost exists to point the Studio at a proxy that can refuse writes; ` +
          `pointing it at Sanity disables the only boundary the browser cannot talk its way past. ` +
          `Set it to the origin serving the overlay API, or leave it unset for native routing.`,
      )
    }

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
  } else if (mode !== 'off') {
    /*
     * NOT AN ERROR — it is the correct configuration for local development
     * against a Studio that talks to Sanity directly for reads. But it is the
     * difference between "a proxy enforces this" and "our own client code
     * enforces this", and that difference is invisible from the running Studio,
     * so it is stated rather than assumed. In a DEPLOYED preview this is the
     * setting under which every control is best-effort.
     */
    warnings.push(
      `[sanity-overlay-studio] no apiHost is configured, so the browser talks to Sanity ` +
        `directly and no proxy can refuse a write. Every write control is then client-side and ` +
        `best-effort: page JavaScript holding the editor's token can bypass all of it. Set ` +
        `${overlayEnvKeys('OVERLAY_API_HOST').join(', ')} to an origin you control for a ` +
        `deployed preview.`,
    )
  }

  const hostedFeatures =
    options.hostedFeatures ?? (envFlag(env, 'OVERLAY_HOSTED_FEATURES') === true ? 'leave' : undefined)

  return {
    enabled: mode !== 'off',
    mode,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiHost,
    overlayId: blankToUndefined(options.overlayId) ?? deriveOverlayId(env),
    /*
     * Default `false` (warn mode) — changed from `true` on 2026-08-05.
     *
     * PRD §22.5 makes warn mode the `[SHOULD]`: log unregistered queries, allow
     * a warning mode during migration, and reject only in strict mode. §5.5
     * forbids *silent* approximation, which warn mode is not — every refusal is
     * still recorded and logged once per distinct query shape.
     *
     * Strict-by-default was measured against the shipped `sanity` package, not
     * against the PRD, and it breaks the Studio on the first branch edit: with a
     * non-empty branch it throws `OverlayReadRefusedError` for the structure
     * tool's document list (`*[!(_id in path("drafts.**"))]`), asset-upload
     * dedup, and every file/image input preview. The last two refuse on a
     * *runtime parameter value* rather than query text — the identical GROQ is
     * answered for `article` and refused for `sanity.fileAsset` — so the failure
     * is neither predictable from the query nor visible before it happens.
     * `reads.ts` names that outcome and rejects it; it was shipping on anyway.
     *
     * Strict remains one line away (`strictQueries: true`, or
     * `SANITY_STUDIO_OVERLAY_STRICT_QUERIES=1`) and is the right setting for a
     * preview frontend, where an unplannable query should fail loudly rather
     * than serve base data.
     */
    strictQueries: options.strictQueries ?? envFlag(env, 'OVERLAY_STRICT_QUERIES') ?? false,
    disableHostedFeatures: mode !== 'off' && hostedFeatures !== 'leave',
    warnings,
  }
}
