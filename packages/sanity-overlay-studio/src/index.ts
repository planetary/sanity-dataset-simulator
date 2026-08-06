/**
 * `sanity-overlay-studio` — public entry point.
 *
 * The one line a consumer writes:
 *
 *     import {defineOverlayConfig} from 'sanity-overlay-studio'
 *
 *     export default defineOverlayConfig({
 *       name: 'default',
 *       projectId: 'xxxxxxxx',
 *       dataset: 'staging',
 *       plugins: [structureTool()],
 *       schema: {types: schemaTypes},
 *     })
 *
 * This module is the *only* one in the package that imports the peer
 * dependencies. It wires `@sanity/client`'s `createClient` into the runtime and
 * React into the status banner, then delegates to the dependency-free modules
 * underneath — which is why every behaviour in this package is unit-testable in
 * plain Node with no DOM.
 *
 * `overlay()` is also exported, for a consumer who wants the plugin-reachable
 * subset without the config wrapper. It cannot install the client interception;
 * see `plugin.ts`.
 */

import {createElement, useEffect, useState} from 'react'
import {createClient} from '@sanity/client'

import {
  defineOverlayConfig as defineOverlayConfigInternal,
  overlayWorkspacePatch as overlayWorkspacePatchInternal,
  type DefineOverlayConfigOptions,
} from './config'
import {createOverlayStatusLayout} from './ui/statusLayout'

/** The banner, bound to the host Studio's React. */
export const OverlayStatusLayout = createOverlayStatusLayout({createElement, useEffect, useState})

function withDefaults(options: DefineOverlayConfigOptions): DefineOverlayConfigOptions {
  return {
    layout: OverlayStatusLayout,
    createClient: (clientOptions) => createClient(clientOptions as never) as unknown as object,
    ...options,
  }
}

/** Wrap a Studio config so every read and write goes through the branch overlay. */
export function defineOverlayConfig<T>(config: T, options: DefineOverlayConfigOptions = {}): T {
  return defineOverlayConfigInternal(config, withDefaults(options))
}

/** The same patch, applied to a single workspace object. */
export function overlayWorkspacePatch(
  workspace: Record<string, unknown>,
  options: DefineOverlayConfigOptions = {},
): ReturnType<typeof overlayWorkspacePatchInternal> {
  return overlayWorkspacePatchInternal(workspace, withDefaults(options))
}

export {overlay, OVERLAY_PLUGIN_NAME} from './plugin'
export type {OverlayPluginOptions, OverlayPluginResult} from './plugin'

export {OVERLAY_MODES, resolveOverlayOptions} from './options'
export type {
  OverlayEnv,
  OverlayMode,
  OverlayStudioOptions,
  ResolvedOverlayOptions,
} from './options'

export {
  DISABLED_HOSTED_INSPECTOR_NAMES,
  DISABLED_HOSTED_TOOL_NAMES,
  HISTORY_INSPECTOR_NAME,
  HOSTED_FEATURES,
  filterHostedInspectors,
  filterHostedTools,
  hostedFeatureReport,
  hostedFeatureReports,
  overlayDocumentPluginOptions,
  overlayWorkspaceFeatureFlags,
} from './features'
export type {HostedFeature, HostedFeatureReport} from './features'

export {
  OVERLAY_BLOCKED_ACTIONS,
  OVERLAY_ROUTED_ACTIONS,
  overlayActionDecision,
  resolveOverlayDocumentActions,
} from './actions'

export {OVERLAY_BANNER_STATES, deriveOverlayStatus} from './status'
export type {OverlayBannerState, OverlayStatus, OverlayStatusInput} from './status'

export {conflictPanelModel, readConflictReport, summarizeConflictDocuments} from './conflicts'
export type {ConflictPanelModel, OverlayConflictReport} from './conflicts'

export {
  clearOverlayRuntimes,
  createOverlayRuntime,
  getOverlayRuntime,
  registerOverlayRuntime,
} from './runtime'
export type {OverlayRuntime} from './runtime'

export {createOverlayEcho} from './client/echo'
export type {OverlayEcho, OverlayMutationEvent} from './client/echo'
export {createOverlayTransport} from './client/transport'
export type {OverlayTransport} from './client/transport'
export {wrapWithOverlay} from './client/facade'
export type {OverlayWriteRecord} from './client/facade'
export {classifyWriteEndpoint, normalizeRequestPath} from './client/writeGuard'
export {createOverlayStatusLayout, overlayBannerViewModel} from './ui/statusLayout'
export type {DefineOverlayConfigOptions} from './config'
