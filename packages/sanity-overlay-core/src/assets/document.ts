/**
 * PRD §24.3 step 5 — the synthetic overlay asset document, plus §24.6 labelling.
 *
 * ## What Studio actually needs, established from the installed packages
 *
 * `sanity@6.8.0` observes exactly these paths on an asset document
 * (`observeAssetDoc`, `lib/useBundleDocuments-*.js`):
 *
 * ```js
 * ['originalFilename', 'url', 'metadata', 'label', 'title', 'description',
 *  'creditLine', 'source', 'size']
 * ```
 *
 * `label`, `title`, `description` and `creditLine` are user-entered fields that
 * are absent on a freshly uploaded Sanity asset too, so they are absent here — an
 * unset field, not a missing one.
 *
 * The image *preview* does not come from `url`. `sanity` builds it with
 * `imageUrlBuilder.image(value.asset).url()`, and `@sanity/image-url@2.1.1`
 * constructs that URL from the asset **ID** alone
 * (`${baseUrl}/images/${projectId}/${dataset}/${id}-${w}x${h}.${format}`). See
 * `deliveryPathForAsset` and the delivery notes in `delivery.ts`: the `url` field
 * below serves everything that reads `asset->url` (file downloads, GROQ
 * projections, the asset dialog), while the preview needs the CDN-shaped route.
 *
 * ## The omission contract
 *
 * §24.8 is explicit that branch assets have "no automatic Sanity palette, LQIP,
 * EXIF, blur hash, or metadata unless reimplemented". Reimplementing them means
 * decoding pixels, which this pipeline does not do. So those fields are **absent**
 * and {@link OMITTED_ASSET_METADATA_FIELDS} names each one on
 * `overlayAsset.omittedMetadata`. A consumer can therefore distinguish "this
 * image is opaque" from "nobody looked", which a fabricated default would destroy.
 */
import {OverlayAssetError} from './errors'
import {parseOverlayAssetDocumentId} from './identity'
import type {SanityDocument} from '../types/document'
import type {OverlayAssetRecord} from './types'

/** `_type` of the synthetic image asset document — Sanity's own type name. */
export const OVERLAY_IMAGE_ASSET_TYPE = 'sanity.imageAsset'
/** `_type` of the synthetic file asset document — Sanity's own type name. */
export const OVERLAY_FILE_ASSET_TYPE = 'sanity.fileAsset'

/** PRD §24.7 — the local delivery route branch asset URLs point at. */
export const OVERLAY_ASSET_BASE_PATH = '/api/sanity-overlay/assets'

/** §24.6 — the marker field that makes a branch-only asset identifiable. */
export const OVERLAY_ASSET_MARKER_FIELD = 'overlayAsset'

/**
 * Every `sanity.imageAsset` field this pipeline does not produce, spelled exactly
 * as it appears on a hosted asset document.
 *
 * All of them require decoding the image, which needs an image codec this package
 * is not allowed to depend on (plan §3 — core is dependency-free and browser-safe).
 * Listing them is the honest alternative to defaulting them.
 */
export const OMITTED_ASSET_METADATA_FIELDS: readonly string[] = Object.freeze([
  'metadata.blurHash',
  'metadata.exif',
  'metadata.isOpaque',
  'metadata.location',
  'metadata.lqip',
  'metadata.palette',
  'metadata.thumbHash',
])

export interface SynthesizeAssetDocumentOptions {
  /**
   * Where the host app mounted the delivery route. Defaults to
   * {@link OVERLAY_ASSET_BASE_PATH} (PRD §24.7).
   */
  basePath?: string
}

/** `/api/sanity-overlay/assets/<assetDocumentId>` — §24.7 `resolveOverlayAssetUrl`. */
export function overlayAssetUrl(assetDocumentId: string, basePath?: string): string {
  const prefix = (basePath ?? OVERLAY_ASSET_BASE_PATH).replace(/\/+$/, '')
  return `${prefix}/${assetDocumentId}`
}

/**
 * Render the `sanity.imageAsset` / `sanity.fileAsset` shaped document for a record.
 *
 * Pure and total: it reads the record, never the bytes. The only failure is a
 * record that claims to be an image without the dimensions its own ID must embed,
 * which is a corrupt record rather than a missing metadata field.
 */
export function synthesizeAssetDocument(
  record: OverlayAssetRecord,
  options: SynthesizeAssetDocumentOptions = {},
): SanityDocument {
  const parsed = parseOverlayAssetDocumentId(record.assetDocumentId)
  if (parsed === null) {
    throw new OverlayAssetError(
      'OVERLAY_ASSET_REJECTED',
      `${JSON.stringify(record.assetDocumentId)} is not an overlay asset document ID (PRD §24.2)`,
      {assetDocumentId: record.assetDocumentId},
    )
  }

  const isImage = record.kind === 'image'
  const metadata: Record<string, unknown> = {}

  if (isImage) {
    const {width, height, aspectRatio} = record.metadata
    if (typeof width !== 'number' || typeof height !== 'number') {
      throw new OverlayAssetError(
        'OVERLAY_ASSET_METADATA_UNAVAILABLE',
        `Image asset ${JSON.stringify(
          record.assetDocumentId,
        )} has no dimensions; refusing to emit a sanity.imageAsset with invented ones (PRD §24.3 step 4)`,
        {assetDocumentId: record.assetDocumentId},
      )
    }
    metadata._type = 'sanity.imageMetadata'
    metadata.dimensions = {
      _type: 'sanity.imageDimensions',
      width,
      height,
      aspectRatio: aspectRatio ?? width / height,
    }
    /* Present only where the container stated it. GIF never does. */
    if (typeof record.metadata.hasAlpha === 'boolean') {
      metadata.hasAlpha = record.metadata.hasAlpha
    }
  }

  return {
    _id: record.assetDocumentId,
    _type: isImage ? OVERLAY_IMAGE_ASSET_TYPE : OVERLAY_FILE_ASSET_TYPE,
    _createdAt: record.createdAt,
    _updatedAt: record.createdAt,
    assetId: record.assetId,
    sha1hash: record.sha1hash,
    size: record.size,
    mimeType: record.contentType,
    extension: record.metadata.extension,
    originalFilename: record.originalFilename,
    /* §24.7. Never a `cdn.sanity.io` URL: these bytes were never uploaded there. */
    url: overlayAssetUrl(record.assetDocumentId, options.basePath),
    /* Sanity's `path` is the CDN-relative location; ours is the overlay-relative
     * one, which is the same claim about the same bytes. */
    path: record.storageRef,
    source: {
      _type: 'sanity.assetSourceData',
      name: 'sanity-branch-overlay',
      id: record.assetDocumentId,
    },
    metadata,
    /* §24.6 "label branch-only assets clearly", as data rather than as a UI string. */
    [OVERLAY_ASSET_MARKER_FIELD]: {
      branchOnly: true,
      overlayId: record.overlayId,
      provider: record.provider,
      blobRef: record.checksum,
      omittedMetadata: [...record.metadata.omitted],
    },
  }
}
