/**
 * Environment-driven configuration — PRD §11.1 `overlay.mode`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VOCABULARY, AND NO SILENT DEFAULT. Both halves of that were bugs.
 *
 * THREE SPELLINGS WERE IN USE. `SANITY_STUDIO_OVERLAY_MODE` (the only prefix
 * Vite exposes to a browser bundle, so the only one a Studio can actually read),
 * `OVERLAY_MODE` (PRD §11.2's server spelling) and `SANITY_OVERLAY_MODE` (this
 * package's own). A deployment that set one and was read by a package expecting
 * another configured nothing at all.
 *
 * AND AN ABSENT KEY PICKED A MODE. This module used to read
 * `env.SANITY_OVERLAY_MODE ?? 'off'`. `off` reads the BASE dataset — staging —
 * so a misspelled, unset or unpropagated variable silently put a reader on
 * staging while every other signal in the deployment said "branch". That is the
 * precise failure this package exists to prevent, and because it was silent it
 * cost a full browser cycle to find.
 *
 * So: every spelling is accepted, two spellings that DISAGREE are refused rather
 * than resolved by an invisible precedence rule, and an absent mode is refused
 * outright. `off` remains a perfectly good setting — it simply has to be chosen.
 *
 * {@link overlayEnvValue} is the single reader, and `sanity-overlay-studio`'s
 * `options.ts` imports it rather than reimplementing it. That is what makes "one
 * vocabulary" a fact about the code rather than a convention.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {OVERLAY_CLIENT_MODES, type OverlayClientMode} from './types'
import type {QueryPerspective} from '../../sanity-overlay-query/src/index'

export interface OverlayClientEnvConfig {
  readonly mode: OverlayClientMode
  /** Directory containing `.sanity-overlay/`. Present only for `mode: 'fs'`. */
  readonly overlayRoot?: string
  readonly perspective: QueryPerspective
}

const PERSPECTIVES: readonly QueryPerspective[] = ['published', 'drafts', 'raw']

/**
 * Accepted prefixes, in precedence order.
 *
 * `SANITY_STUDIO_` leads because it is the only prefix a Vite-built Studio
 * bundle can see: a value that is actually REACHABLE must never be shadowed by
 * one that is not.
 *
 * DIVERGENT VALUES ARE NOT A MISCONFIGURATION, so this does not refuse them.
 * The prefixes address different runtimes — the bare spelling is read by the
 * server and the CLI, `SANITY_STUDIO_` by the browser bundle — and a deployment
 * that deliberately runs them differently is coherent. The bug this module was
 * fixed for was never "two spellings disagree"; it was a package that read only
 * ONE spelling and then silently defaulted when it was absent.
 */
export const OVERLAY_ENV_PREFIXES = ['SANITY_STUDIO_', 'SANITY_', ''] as const

/** Every spelling of one setting, e.g. `OVERLAY_MODE`. */
export function overlayEnvKeys(name: string): string[] {
  return OVERLAY_ENV_PREFIXES.map((prefix) => `${prefix}${name}`)
}

/**
 * Blank is *unset*, not a value.
 *
 * Spike A's scar (`instrumentedClient.ts:157-174`): a blank flag read as
 * "configured" at the decision site and as falsy at the injection site, so
 * Studio ran with neither a proxy nor a facade. Whitespace was injected verbatim.
 */
export function blankToUndefined(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read one overlay setting under every accepted spelling, most reachable first.
 *
 * Blank is unset at every spelling, so a variable that is present-but-empty
 * falls through to the next rather than resolving to `""`.
 */
export function overlayEnvValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  for (const key of overlayEnvKeys(name)) {
    const value = blankToUndefined(env[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** `NAME (or SANITY_NAME, or SANITY_STUDIO_NAME)`, for an error message. */
function spellingList(name: string): string {
  const [studio, sanity, bare] = overlayEnvKeys(name)
  return `${bare} (or ${sanity}, or ${studio})`
}

export function overlayClientConfigFromEnv(
  env: Record<string, string | undefined>,
): OverlayClientEnvConfig {
  const rawMode = overlayEnvValue(env, 'OVERLAY_MODE')
  /*
   * NO DEFAULT. See the header: `?? 'off'` here put readers on staging without
   * anyone asking for it.
   */
  if (rawMode === undefined) {
    throw new Error(
      `[sanity-overlay] no overlay mode is configured. Set ${spellingList('OVERLAY_MODE')} to ` +
        `one of: ${OVERLAY_CLIENT_MODES.join(', ')} (PRD §11.1). "off" reads the base dataset ` +
        `and is a valid choice — but it has to be a choice, because defaulting to it silently ` +
        `serves staging content to a reader that believes it is on a branch.`,
    )
  }
  if (!(OVERLAY_CLIENT_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(
      `[sanity-overlay] OVERLAY_MODE=${JSON.stringify(rawMode)} is not a supported mode. ` +
        `Supported: ${OVERLAY_CLIENT_MODES.join(', ')} (PRD §11.1).`,
    )
  }
  const mode = rawMode as OverlayClientMode

  /*
   * Perspective DOES keep a default, and the asymmetry is deliberate: `drafts`
   * is a view within whichever dataset `mode` already settled, so getting it
   * wrong shows an editor the wrong revision of a document. It cannot put them
   * on staging while they believe they are on a branch, which is the only
   * failure the mode default was capable of.
   */
  const rawPerspective = overlayEnvValue(env, 'OVERLAY_PERSPECTIVE') ?? 'drafts'
  if (!PERSPECTIVES.includes(rawPerspective as QueryPerspective)) {
    throw new Error(
      `[sanity-overlay] OVERLAY_PERSPECTIVE=${JSON.stringify(rawPerspective)} is not a ` +
        `perspective. Supported: ${PERSPECTIVES.join(', ')} (PRD §22.4).`,
    )
  }
  const perspective = rawPerspective as QueryPerspective

  if (mode === 'off') return {mode, perspective}

  const overlayRoot = overlayEnvValue(env, 'OVERLAY_ROOT')
  if (overlayRoot === undefined) {
    throw new Error(
      `[sanity-overlay] ${spellingList('OVERLAY_ROOT')} must name the directory containing ` +
        `\`.sanity-overlay/\` when the overlay mode is ${JSON.stringify(mode)} (PRD §14.1).`,
    )
  }

  return {mode, overlayRoot, perspective}
}
