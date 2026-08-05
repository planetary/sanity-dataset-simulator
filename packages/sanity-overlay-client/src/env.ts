/**
 * Environment-driven configuration — PRD §11.1 `overlay.mode`.
 *
 * The default is `off`. That is the safe default and the honest one: a project
 * that has not asked for the overlay gets the base dataset, exactly as if this
 * package were not installed (PRD §9.2).
 *
 * Nothing here silently falls back. An unrecognised mode, or `fs` without a
 * root, is a configuration error — a client that quietly served staging content
 * because a variable was misspelled is the bug this whole package exists to fix.
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

export function overlayClientConfigFromEnv(
  env: Record<string, string | undefined>,
): OverlayClientEnvConfig {
  const rawMode = env.SANITY_OVERLAY_MODE ?? 'off'
  if (!(OVERLAY_CLIENT_MODES as readonly string[]).includes(rawMode)) {
    throw new Error(
      `SANITY_OVERLAY_MODE=${JSON.stringify(rawMode)} is not a supported mode. ` +
        `Supported: ${OVERLAY_CLIENT_MODES.join(', ')} (PRD §11.1).`,
    )
  }
  const mode = rawMode as OverlayClientMode

  const rawPerspective = env.SANITY_OVERLAY_PERSPECTIVE ?? 'drafts'
  if (!PERSPECTIVES.includes(rawPerspective as QueryPerspective)) {
    throw new Error(
      `SANITY_OVERLAY_PERSPECTIVE=${JSON.stringify(rawPerspective)} is not a perspective. ` +
        `Supported: ${PERSPECTIVES.join(', ')} (PRD §22.4).`,
    )
  }
  const perspective = rawPerspective as QueryPerspective

  if (mode === 'off') return {mode, perspective}

  const overlayRoot = env.SANITY_OVERLAY_ROOT
  if (overlayRoot === undefined || overlayRoot.length === 0) {
    throw new Error(
      'SANITY_OVERLAY_ROOT must name the directory containing `.sanity-overlay/` ' +
        'when SANITY_OVERLAY_MODE=fs (PRD §14.1).',
    )
  }

  return {mode, overlayRoot, perspective}
}
