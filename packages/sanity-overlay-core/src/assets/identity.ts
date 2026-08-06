/**
 * The identity of a branch-local asset document (PRD §24.2).
 *
 * A synthetic asset document is only worth synthesizing if the rest of the Sanity
 * ecosystem recognises its ID. Two installed packages decide that, and both were
 * read rather than guessed:
 *
 * `@sanity/asset-utils@2.3.0` (which `sanity@6.8.0` uses to parse asset IDs)
 * ```js
 * imageAssetIdPattern = /^image-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-\d+x\d+-[a-z0-9]+$/
 * fileAssetIdPattern  = /^file-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-[a-z0-9]+$/
 * ```
 *
 * `@sanity/image-url@2.1.1` (which builds every image preview `src` in Studio)
 * ```js
 * const [, id, dimensionString, format] = ref.split('-')
 * ```
 *
 * Three consequences the implementation cannot argue with:
 *
 * 1. The digest segment is 40 hex characters — a SHA-1. Sanity's own `sha1hash`
 *    field holds exactly that, so the choice is forced. Content addressing on
 *    disk is separate and stays SHA-256 (§13.2).
 * 2. An image ID embeds `<width>x<height>`, so an image whose dimensions could
 *    not be read has no representable ID. {@link overlayAssetDocumentId} throws
 *    rather than invent them.
 * 3. `image-url` splits on `-`, so no segment may contain one. A 40-hex digest
 *    and a `[a-z0-9]+` extension satisfy that by construction.
 *
 * The recognisers below are deliberately **stricter** than the upstream patterns:
 * upstream would accept an uppercase digest via its `[a-zA-Z0-9_]{24,40}`
 * alternative, and accepting two spellings of one file would break content
 * addressing. Every ID this module mints still matches upstream — a subset, never
 * a superset.
 */
import {OverlayAssetError} from './errors'
import type {OverlayAssetDimensions, OverlayAssetKind} from './types'

/** `image-<40 hex>-<w>x<h>-<ext>`, lowercase digest only. */
const IMAGE_ID_RE = /^image-([a-f0-9]{40})-(\d+)x(\d+)-([a-z0-9]+)$/
/** `file-<40 hex>-<ext>`, lowercase digest only. */
const FILE_ID_RE = /^file-([a-f0-9]{40})-([a-z0-9]+)$/

const SHA1_RE = /^[a-f0-9]{40}$/
const EXTENSION_RE = /^[a-z0-9]+$/

export interface MintAssetDocumentIdInput {
  kind: OverlayAssetKind
  /** Lowercase hex SHA-1 of the bytes. */
  sha1: string
  /** Lowercase alphanumeric, no leading dot. */
  extension: string
  /** Required for `image`; ignored for `file`. */
  dimensions?: OverlayAssetDimensions | null
}

/** The decomposition of a recognised asset document ID. */
export type ParsedOverlayAssetDocumentId =
  | {kind: 'image'; sha1: string; extension: string; width: number; height: number}
  | {kind: 'file'; sha1: string; extension: string}

function reject(field: string, value: unknown, expectation: string): never {
  throw new OverlayAssetError(
    'OVERLAY_ASSET_REJECTED',
    `Cannot mint an overlay asset document ID: ${field} ${JSON.stringify(
      value,
    )} ${expectation} (PRD §24.2)`,
    {field, value},
  )
}

/**
 * Mint the `_id` of a synthetic asset document.
 *
 * @throws {OverlayAssetError} `OVERLAY_ASSET_METADATA_UNAVAILABLE` when an image's
 * dimensions are unknown. This is the load-bearing refusal of §24: the ID format
 * has nowhere to put "unknown", so the alternative to failing is fabricating.
 */
export function overlayAssetDocumentId(input: MintAssetDocumentIdInput): string {
  if (!SHA1_RE.test(input.sha1)) {
    reject('sha1', input.sha1, 'must be 40 lowercase hex characters')
  }
  if (!EXTENSION_RE.test(input.extension)) {
    reject('extension', input.extension, 'must match /^[a-z0-9]+$/')
  }

  if (input.kind === 'file') return `file-${input.sha1}-${input.extension}`

  const dimensions = input.dimensions ?? null
  if (dimensions === null) {
    throw new OverlayAssetError(
      'OVERLAY_ASSET_METADATA_UNAVAILABLE',
      'An image asset ID embeds <width>x<height>, and the container did not state them. ' +
        'Refusing to mint an ID with invented dimensions (PRD §24.3 step 4, §24.8).',
      {sha1: input.sha1, extension: input.extension},
    )
  }
  if (
    !Number.isInteger(dimensions.width) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    reject('dimensions', dimensions, 'must be positive integers')
  }

  return `image-${input.sha1}-${dimensions.width}x${dimensions.height}-${input.extension}`
}

/** Decompose an overlay asset document ID, or `null` when it is not one. */
export function parseOverlayAssetDocumentId(id: string): ParsedOverlayAssetDocumentId | null {
  if (typeof id !== 'string') return null

  const image = IMAGE_ID_RE.exec(id)
  if (image !== null) {
    return {
      kind: 'image',
      sha1: image[1],
      extension: image[4],
      width: Number(image[2]),
      height: Number(image[3]),
    }
  }

  const file = FILE_ID_RE.exec(id)
  if (file !== null) return {kind: 'file', sha1: file[1], extension: file[2]}

  return null
}

/** Is this document ID one this module minted? */
export function isOverlayAssetDocumentId(id: string): boolean {
  return parseOverlayAssetDocumentId(id) !== null
}
