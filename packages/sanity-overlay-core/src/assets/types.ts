/**
 * The branch-local asset vocabulary — PRD §24.2, as amended by the owner ruling
 * of 2026-08-05 (PRD §0.0).
 *
 * Two fields of the published §24.2 interface are deliberately absent:
 *
 * - `promotedSanityAssetId` — §24.9 asset promotion is out of scope permanently.
 *   There is no code path that uploads to Sanity, so a field whose only meaning
 *   is "this was uploaded to Sanity" would be dead weight that invites someone to
 *   fill it in.
 * - a bare `metadata.width?` with no way to say *why* it is missing. §24.8 makes
 *   absence routine, so {@link OverlayAssetMetadata.omitted} names every field
 *   that was not produced. A consumer can then tell "no alpha channel" from "we
 *   never looked".
 *
 * Two fields are added:
 *
 * - `assetDocumentId` — the `image-…` / `file-…` ID minted by
 *   {@link overlayAssetDocumentId}. `assetId` stays the bare SHA-1, matching
 *   Sanity's own `sanity.imageAsset.assetId`.
 * - `sha1hash` — the same SHA-1, under the name Sanity's asset document uses.
 */
import type {OverlayActor} from '../types/actor'
import type {OverlayFormatVersion} from '../types/format-version'

/** PRD §24.2. `image` gets a `sanity.imageAsset`; everything else a `sanity.fileAsset`. */
export type OverlayAssetKind = 'image' | 'file'

/**
 * PRD §24.2 / §24.4. `filesystem` is `.sanity-overlay/assets/`; `vercel-blob` is
 * the private-Blob preview equivalent, designed for and not built.
 */
export type OverlayAssetProvider = 'filesystem' | 'vercel-blob'

/** Pixel geometry, only ever from what the container itself states (§24.3 step 4). */
export interface OverlayAssetDimensions {
  width: number
  height: number
  /** `width / height`, the field name Sanity's `sanity.imageDimensions` uses. */
  aspectRatio: number
}

/**
 * What the probe could establish, plus an explicit inventory of what it could not.
 *
 * `hasAlpha` is `true`/`false` only where the container states it outright (a PNG
 * colour type, a `tRNS` chunk, a WebP `VP8X` flag) and absent otherwise; GIF, for
 * instance, carries transparency per frame and this probe decodes no frames.
 */
export interface OverlayAssetMetadata {
  /** Lowercase, no leading dot — the ID's trailing segment. */
  extension: string
  width?: number
  height?: number
  aspectRatio?: number
  hasAlpha?: boolean
  /**
   * Dotted paths of every asset-document field this pipeline does not produce,
   * verbatim as they would appear on a real `sanity.imageAsset`
   * (`metadata.lqip`, `metadata.palette`, …). Never a guess: a field named here
   * is absent from the synthetic document, and a field absent from the synthetic
   * document is named here.
   */
  omitted: readonly string[]
}

/** PRD §24.2 — the immutable record of one branch-local upload. */
export interface OverlayAssetRecord {
  formatVersion: OverlayFormatVersion
  overlayId: string
  /** `image-<sha1>-<w>x<h>-<ext>` or `file-<sha1>-<ext>` (PRD §24.2 identity). */
  assetDocumentId: string
  /** The bare SHA-1, matching Sanity's `sanity.imageAsset.assetId`. */
  assetId: string
  kind: OverlayAssetKind
  provider: OverlayAssetProvider
  /** Provider-relative location of the bytes, e.g. `assets/blobs/<sha256>.bin`. */
  storageRef: string
  /** SHA-256 of the bytes (PRD §13.2) — the content address on disk. */
  checksum: string
  /** SHA-1 of the same bytes, under Sanity's field name. */
  sha1hash: string
  originalFilename: string
  contentType: string
  size: number
  metadata: OverlayAssetMetadata
  createdAt: string
  createdBy?: OverlayActor
}

/** What {@link probeBinary} could read out of the container, and nothing more. */
export interface OverlayBinaryProbe {
  kind: OverlayAssetKind
  /** `png` | `jpeg` | `gif` | `webp`, or `null` when the bytes are not a known image. */
  format: string | null
  mimeType: string
  extension: string
  dimensions: OverlayAssetDimensions | null
  /** `null` means "the container does not say", never "no". */
  hasAlpha: boolean | null
}
