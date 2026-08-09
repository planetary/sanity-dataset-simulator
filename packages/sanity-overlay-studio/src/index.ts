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

import {createClient} from '@sanity/client'

import {
  defineOverlayConfig as defineOverlayConfigInternal,
  overlayWorkspacePatch as overlayWorkspacePatchInternal,
  type DefineOverlayConfigOptions,
} from './config'

/*
 * The banner, the conflict panel and the three §21.7 actions, bound to the
 * host's React. RE-EXPORTED, not rebuilt: `config.ts` defaults to these same
 * objects, and a second binding here would give the two paths two sets of
 * components with different identities — which Studio compares by reference.
 */
export {
  HOST_REACT,
  OverlayConflictPanel,
  OverlayDocumentActions,
  OverlayStatusLayout,
} from './bindings'

/**
 * The one thing this entry point still supplies that `config.ts` cannot:
 * `@sanity/client`.
 *
 * The banner and the actions moved down into `bindings.ts` because omitting them
 * was silent. Omitting `createClient` is not — `config.ts` installs a factory
 * that throws with the reason — so it stays here, where the peer dependency is.
 */
function withDefaults(options: DefineOverlayConfigOptions): DefineOverlayConfigOptions {
  return {
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
/* The §11.3 credential check, as data. Exported so a deployment check and a CI
 * scan ask the same question the Studio asks at startup rather than three that
 * drift — the previous check missed `SANITY_API_TOKEN`, the name Sanity's own
 * documentation uses most. */
export {classifyTokenEnvKey, isBrowserReachableEnvKey} from './options'
export type {TokenEnvVerdict} from './options'

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
  overlayDocumentActionsResolver,
  resolveOverlayDocumentActions,
} from './actions'

export {OVERLAY_BANNER_STATES, deriveOverlayStatus} from './status'
export type {OverlayBannerState, OverlayStatus, OverlayStatusInput} from './status'

export {conflictPanelModel, readConflictReport, summarizeConflictDocuments} from './conflicts'
export type {ConflictPanelModel, OverlayConflictReport} from './conflicts'

/* ── The conflict panel (PRD §28.2 the list and the per-document indication,
 * §28.3 driving each resolution action). Pure: no rendering, no transport, so a
 * host can build its own surface on the same decisions. */
export {
  OPTIONAL_CONFLICT_COLUMNS,
  conflictListRows,
  documentConflictIndicator,
  filterConflictRows,
  planConflictResolution,
  resolvedPreviewValue,
} from './conflictPanel'
export type {
  ConflictIndicator,
  ConflictIndicatorState,
  ConflictLoss,
  ConflictLossEntry,
  ConflictResolutionCommand,
  ConflictResolutionInput,
  ConflictResolutionPlan,
  ConflictRow,
  ConflictRowFilters,
  OptionalConflictColumn,
  ResolvedPreview,
  ResolvedPreviewKind,
} from './conflictPanel'

/* ── The overlay operations (PRD §28.4 rebase modes, §28.5 preconditions, §29
 * checkpoint). `planRebase` and `planCheckpoint` decide; they never send. */
export {
  OVERLAY_OPERATION_KINDS,
  STUDIO_REBASE_MODES,
  planCheckpoint,
  planRebase,
  readRebaseOutcome,
} from './operations'
export type {
  CheckpointCommand,
  CheckpointPlan,
  CheckpointRequest,
  OperationLoss,
  OperationLossDocument,
  OverlayOperationCommand,
  OverlayOperationKind,
  RebaseBlockage,
  RebaseCommand,
  RebaseOutcome,
  RebasePlan,
  RebaseRequest,
  StudioRebaseMode,
} from './operations'

/* ── The document actions themselves: rebase, resolve conflict, checkpoint. */
export {createOverlayActionController} from './documentActions'
export type {
  ConflictResolutionOutcome,
  OverlayActionContext,
  OverlayActionController,
  OverlayActionControllerOptions,
  OverlayActionDescription,
  OverlayActionKind,
  OverlayActionState,
  OverlayActionTone,
  OverlayConfirmDialog,
  OverlayCustomDialog,
} from './documentActions'

export {
  clearOverlayRuntimes,
  createOverlayRuntime,
  getOverlayRuntime,
  registerOverlayRuntime,
} from './runtime'
export type {OverlayBranchView, OverlayRuntime} from './runtime'

/* `window.__SANITY_OVERLAY__` — the read ledger, the branch view and the §21.3
 * status, reachable from a browser console. See `devtools.ts`. */
export {
  OVERLAY_DEVTOOLS_GLOBAL,
  createOverlayDevtools,
  installOverlayDevtools,
} from './devtools'
export type {OverlayDevtools, OverlayDevtoolsSession} from './devtools'

export {createOverlayEcho} from './client/echo'
export type {OverlayEcho, OverlayMutationEvent} from './client/echo'
/* A refusal this system issued is not a failure of the user's Sanity session.
 * Exported so a host that funnels client errors through its own session
 * observer can apply the same rule rather than re-deriving it. */
export {
  OVERLAY_REFUSAL_CODES,
  OVERLAY_REFUSAL_FLAG,
  authStatusOf,
  isOverlayRefusal,
  markOverlayRefusal,
} from './client/echo'
export {createOverlayTransport} from './client/transport'
export type {OverlayTransport} from './client/transport'
export {wrapWithOverlay} from './client/facade'
export type {OverlayWriteRecord} from './client/facade'

/* Branch-local assets (PRD §24). `assetOriginFor` is exported alongside the
 * uploader because the two are one decision: where the bytes go, and where the
 * image pipeline is told to look for them. A host that mounts the overlay API
 * under a path prefix needs the refusal it returns, not a guess. */
export {
  DEFAULT_UPLOAD_TIMEOUT_MS,
  OVERLAY_ASSET_TYPES,
  assetOriginFor,
  createOverlayAssetUploader,
  uploadContentTypeOf,
  uploadFilenameOf,
} from './client/assets'
export type {
  CreateOverlayAssetUploaderOptions,
  OverlayAssetOrigin,
  OverlayAssetType,
  OverlayAssetUploadOutcome,
  OverlayAssetUploadRequest,
  OverlayAssetUploader,
} from './client/assets'

/* The overlay-aware GROQ read path (PRD §22). Exported so a host can build its
 * own reader — the same three outcomes, its own policy for strict mode. */
export {createStudioReader, OverlayReadRefusedError} from './client/reads'
export type {
  StudioReadOutcome,
  StudioReadRecord,
  StudioReadRequest,
  StudioReadRouter,
  StudioReaderOptions,
} from './client/reads'
/* PRD §21.6 incoming references — a combined base-plus-overlay read, so a
 * branch-created referring document is not invisible to the delete check. */
export {
  INCOMING_REFERENCE_MAX_CANDIDATES,
  INCOMING_REFERENCE_TARGETS_PARAM,
  branchReferringAddresses,
  deriveIncomingReferenceTargets,
  incomingReferenceCandidateQuery,
  incomingReferenceReadPlan,
} from './client/incomingReferences'
export type {
  IncomingReferenceDerivation,
  IncomingReferencePlanRequest,
} from './client/incomingReferences'

export {deriveStudioReadPlan, evaluateStudioRead} from './client/readPlan'
export type {StudioReadDerivation, StudioReadPlan} from './client/readPlan'
export {createBranchCandidateSource, overlaySourceFromBranch} from './client/readSource'
export {classifyWriteEndpoint, normalizeRequestPath} from './client/writeGuard'
export {createOverlayStatusLayout, overlayBannerViewModel} from './ui/statusLayout'
export type {OverlayBannerViewModel, OverlayLayoutProps, ReactLike} from './ui/statusLayout'

/* ── The §28.3 panel, rendered. `conflictPanelView` is the pure half: a host
 * that wants its own surface builds it on the same decisions rather than
 * re-deriving which button is enabled and why. */
export {
  EMPTY_CONFLICT_PANEL_UI,
  confirmKey,
  conflictPanelView,
  createOverlayConflictPanel,
  parseManualEditSource,
} from './ui/conflictPanel'
export type {
  ConflictPanelActionView,
  ConflictPanelRowView,
  ConflictPanelUiState,
  ConflictPanelView,
  ConflictPanelViewInput,
  ManualEditParse,
  OverlayConflictPanelProps,
} from './ui/conflictPanel'

/* ── The §21.7 actions as components, plus the React-free controller wiring. */
export {
  OVERLAY_ACTION_NAMES,
  createOverlayActionControllers,
  createOverlayDocumentActions,
} from './ui/documentActions'
export type {
  CreateOverlayDocumentActionsOptions,
  OverlayActionControllersOptions,
  OverlayControllerSet,
  OverlayDocumentActionComponent,
  OverlayDocumentActionProps,
} from './ui/documentActions'

export type {DefineOverlayConfigOptions} from './config'
