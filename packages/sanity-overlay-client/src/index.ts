/**
 * `sanity-overlay-client` — the environment-aware read client (roadmap Phase 3
 * "local API and client", PRD §37 Phase 2, §9.2, §11.1, §22).
 *
 * The missing half of the loop: the Studio writes a branch overlay to disk, and
 * this is what a site reads it back through. One factory, whose behaviour is set
 * by configuration — `off` goes straight to base, `fs` resolves
 * `.sanity-overlay/` layered over base.
 *
 * LAYERING. This package owns no semantics. Merge, perspectives and batch
 * virtual reads are `sanity-overlay-core`; candidate planning, boundedness and
 * the single pinned `groq-js` evaluation are `sanity-overlay-query`; the
 * canonical on-disk layout is `sanity-overlay-store-fs`. What lives here is the
 * wiring, the cache and its revalidation trigger.
 *
 * Milestone note (PRD §1.4): `[M-LOCAL]` foundations. No milestone acceptance is
 * claimed by this package.
 */

export {OVERLAY_CACHE_TAG, createOverlayClient} from './client'

export {createDocumentBaseSource, createHttpBaseSource} from './base'
export type {HttpBaseSourceOptions} from './base'

/**
 * The host-level staging-write refusal (owner ruling, 2026-08-05): this system
 * never writes to a real Sanity dataset, including its asset API. Exported so
 * every enforcement point in the project quotes one policy rather than three.
 */
export {
  SAFE_METHODS,
  STAGING_WRITE_POLICY,
  StagingWriteRefusedError,
  assertNoStagingWrite,
  createStagingSafeFetch,
  hostOfRequest,
  isSanityApiHost,
  isStagingWrite,
  normalizeHost,
  normalizeMethod,
} from './stagingHost'
export type {StagingWriteTarget} from './stagingHost'

/**
 * The preview write-impossibility controls, labelled by the layer that enforces
 * them (see `docs/plans/evidence/phase-1/preview-write-impossibility.md`):
 *
 *   SERVER-ENFORCED   `previewWriteGuard` — the default-deny classifier, as a
 *                     package export rather than an example-only `.mjs`, so a
 *                     deployment's own origin can run the identical policy.
 *   BROWSER-ENFORCED  `previewCsp` — the `connect-src` policy that confines the
 *                     page to our origin, plus the validator that says whether
 *                     a given policy actually closes the bypass.
 *   BEST-EFFORT       `browserWriteBarrier` — patches the browser globals the
 *                     Studio's own out-of-client egress uses. Defeatable in two
 *                     lines; useful against accidents, not attackers.
 */
export {
  ALLOWED_REALTIME_RPC_METHODS,
  classifyPreviewRequest,
  classifyRealtimeRpcMethod,
  isPreviewWriteRequest,
  normalizePreviewPath,
} from './previewWriteGuard'
export type {PreviewGuardRequest, PreviewGuardVerdict} from './previewWriteGuard'

export {
  SANITY_BROWSER_ORIGINS,
  cspConnectSources,
  cspPermitsSanityConnection,
  parseCspDirectives,
  previewCspDirectives,
  previewCspHeaderValue,
  previewSecurityHeaders,
  serializeCspDirectives,
} from './previewCsp'
export type {CspDirectives, PreviewCspOptions} from './previewCsp'

export {createBrowserWriteBarrier, installBrowserWriteBarrier} from './browserWriteBarrier'
export type {
  BrowserWriteBarrier,
  BrowserWriteBarrierHandle,
  BrowserWriteBarrierRequest,
  BrowserWriteRefusal,
} from './browserWriteBarrier'

/* Branch-local asset delivery — the §24.7 route, transport-neutral (PRD §24.3 step 7). */
export {createOverlayAssetDelivery} from './assets'
export type {
  CreateOverlayAssetDeliveryOptions,
  OverlayAssetDeliveryRequestInit,
  OverlayAssetDeliveryResponse,
  OverlayAssetSource,
} from './assets'

export {createFsOverlayStateLoader} from './fsLoader'
export type {FsOverlayStateLoader, FsOverlayStateLoaderOptions} from './fsLoader'

export {buildOverlaySource} from './overlaySource'
export type {BuildOverlaySourceInput} from './overlaySource'

export {OVERLAY_REVALIDATE_MODES, overlayClientConfigFromEnv} from './env'
export type {OverlayClientEnvConfig, OverlayRevalidateMode} from './env'

export {OVERLAY_CLIENT_MODES} from './types'
export type {
  OverlayClient,
  OverlayClientBaseSource,
  OverlayClientMode,
  OverlayClientOptions,
  OverlayFetchOptions,
  OverlayStateLoader,
  OverlayStateSnapshot,
} from './types'

/* Development utility — writes an overlay the way the Studio would. */
export {seedOverlay} from './dev/seedOverlay'
export type {SeedEdit, SeedOverlayOptions, SeedOverlayResult} from './dev/seedOverlay'
