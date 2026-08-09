/**
 * Branch-local assets — PRD §24, under the owner ruling of 2026-08-05 (PRD §0.0).
 *
 * **Scope, stated once here so no module below has to hedge.** Nothing in this
 * directory uploads to Sanity. §24.9 asset promotion is out of scope permanently:
 * there is no `promotedSanityAssetId`, no asset mapping and no reference rewrite,
 * and none of that is "deferred". What is in scope is everything a branch needs
 * to *contain* a new image at all — local storage, a synthetic asset document the
 * Sanity ecosystem recognises, honest metadata, usage tracking, delete protection
 * and a local delivery route.
 *
 * This half is pure: no `node:fs`, no clock, no network (plan §3). The bytes are
 * written by the provider — `sanity-overlay-store-fs` today, private Vercel Blob
 * in the §24.4 design — and served by `sanity-overlay-client`.
 */

export {OverlayAssetError} from './errors'
export type {OverlayAssetErrorCode} from './errors'

export {sha1Bytes, sha1Hex} from './sha1'

export type {
  OverlayAssetDimensions,
  OverlayAssetKind,
  OverlayAssetMetadata,
  OverlayAssetProvider,
  OverlayAssetRecord,
  OverlayBinaryProbe,
} from './types'

export {extensionFromFilename, probeBinary} from './probe'
export type {ProbeBinaryOptions} from './probe'

export {
  isOverlayAssetDocumentId,
  overlayAssetDocumentId,
  parseOverlayAssetDocumentId,
} from './identity'
export type {MintAssetDocumentIdInput, ParsedOverlayAssetDocumentId} from './identity'

export {
  OMITTED_ASSET_METADATA_FIELDS,
  OVERLAY_ASSET_BASE_PATH,
  OVERLAY_ASSET_MARKER_FIELD,
  OVERLAY_FILE_ASSET_TYPE,
  OVERLAY_IMAGE_ASSET_TYPE,
  overlayAssetUrl,
  synthesizeAssetDocument,
} from './document'
export type {SynthesizeAssetDocumentOptions} from './document'

export {
  OVERLAY_ASSET_FILENAME_HEADER,
  OVERLAY_ASSET_ROUTE_SEGMENT,
  OVERLAY_ASSET_UPLOAD_HEADER,
  SANITY_CDN_ORIGIN,
} from './transport'

export {assertAssetDeletable, assetUsage} from './usage'
export type {OverlayAssetUsage} from './usage'

export {
  DEFAULT_MAX_ASSET_BYTES,
  OVERLAY_ASSET_BLOBS_PREFIX,
  overlayAssetBlobRef,
  planAssetUpload,
  sanitizeOriginalFilename,
} from './upload'
export type {AssetUploadPlan, PlanAssetUploadInput} from './upload'

export {
  overlayFileDeliveryPath,
  overlayImageDeliveryPath,
  overlayImageFilename,
  parseOverlayAssetDeliveryPath,
  parseOverlayAssetRequest,
  parseOverlayFileDeliveryPath,
  parseOverlayImageDeliveryPath,
} from './delivery'
export type {OverlayAssetDeliveryRequest} from './delivery'
