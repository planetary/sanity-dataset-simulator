/**
 * `overlay()` — the Studio plugin, for the subset a plugin can genuinely do.
 *
 * Returns a plain `PluginOptions` object. `definePlugin` is sugar over exactly
 * this shape, and not importing it keeps this module dependency-free (so it is
 * testable in plain Node, and so the package does not pull `sanity` into a
 * context that may not have it resolved).
 *
 * WHAT THIS CANNOT DO, and why the shipped one-liner is `defineOverlayConfig`:
 *
 *   - `unstable_clientFactory` is on `SourceOptions`, not `PluginOptions`, and
 *     is read by direct property access off the source config. Setting it here
 *     would type-error and be ignored at runtime — so the entire write-blocking
 *     guarantee is unreachable from a plugin.
 *   - `tasks` / `scheduledPublishing` are not `PluginOptions` keys at all;
 *     `releases.enabled` is a key but is ignored for both registration and
 *     `Source.releases`; `scheduledDrafts.enabled` flips a runtime flag but does
 *     not stop the tool being installed.
 *   - hosted plugins are appended *after* every user plugin, so the resolvers
 *     below never see what they contribute. They still help when the consumer
 *     declares `overlay()` after `structureTool()` — which is why they are here
 *     — but the authoritative copies run at the root.
 *
 * Rather than pretend, this plugin sets only what works and says so.
 */

import {resolveOverlayDocumentActions} from './actions'
import {
  filterHostedInspectors,
  filterHostedTools,
  overlayDocumentPluginOptions,
} from './features'
import {resolveOverlayOptions, type OverlayEnv, type OverlayStudioOptions} from './options'

export const OVERLAY_PLUGIN_NAME = 'sanity-overlay-studio'

export interface OverlayPluginOptions extends OverlayStudioOptions {
  env?: OverlayEnv
}

/** The subset of `PluginOptions` this plugin populates. */
export interface OverlayPluginResult {
  name: string
  document?: {
    comments: {enabled: false}
    actions: <T extends {action?: string}>(prev: readonly T[]) => T[]
    inspectors: <T extends {name: string}>(prev: readonly T[]) => T[]
  }
  tools?: <T extends {name: string}>(prev: readonly T[]) => T[]
}

export function overlay(options: OverlayPluginOptions = {}): OverlayPluginResult {
  const {env, ...studioOptions} = options
  const resolved = resolveOverlayOptions(studioOptions, env ?? {})

  if (!resolved.enabled) return {name: OVERLAY_PLUGIN_NAME}

  return {
    name: OVERLAY_PLUGIN_NAME,
    document: {
      ...overlayDocumentPluginOptions(),
      actions: (prev) => resolveOverlayDocumentActions(prev),
      inspectors: (prev) => filterHostedInspectors(prev),
    },
    tools: (prev) => filterHostedTools(prev),
  }
}
