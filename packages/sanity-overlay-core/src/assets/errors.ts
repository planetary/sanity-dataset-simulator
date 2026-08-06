/**
 * Structured failures for branch-local assets (PRD §24).
 *
 * Every one of these is a *refusal*, never a degradation: §24.8 says branch
 * assets lose Sanity's derived metadata, and the only honest way to express that
 * is to omit a field or to fail, never to synthesize a plausible value. So
 * `OVERLAY_ASSET_METADATA_UNAVAILABLE` exists precisely so that "we could not
 * read the dimensions" cannot be quietly rounded to `0x0`.
 */
import {OverlayError, type OverlayErrorCode, type OverlayErrorDetails} from '../errors'

/** The §24 subset of {@link OverlayErrorCode}. */
export type OverlayAssetErrorCode =
  /** A field Sanity would compute cannot be read from the container (§24.3 step 4). */
  | 'OVERLAY_ASSET_METADATA_UNAVAILABLE'
  /** Delete blocked by an incoming strong reference (§24.6, §18.8, §34.10). */
  | 'OVERLAY_ASSET_IN_USE'
  /** Bytes, filename, MIME type or size failed validation (§24.3 step 2, §24.5). */
  | 'OVERLAY_ASSET_REJECTED'
  /** The blob or its record is absent, or its bytes no longer hash to the record. */
  | 'OVERLAY_ASSET_NOT_FOUND'
  | 'OVERLAY_ASSET_CHECKSUM_MISMATCH'

/** A branch-local asset operation failed (PRD §24). */
export class OverlayAssetError extends OverlayError {
  readonly assetCode: OverlayAssetErrorCode

  constructor(
    assetCode: OverlayAssetErrorCode,
    message: string,
    details: OverlayErrorDetails = {},
  ) {
    super(assetCode as OverlayErrorCode, message, details)
    this.name = 'OverlayAssetError'
    this.assetCode = assetCode
  }
}
