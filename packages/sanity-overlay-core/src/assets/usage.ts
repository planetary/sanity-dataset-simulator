/**
 * PRD §24.6 "support remove and replace" and §24.8, expressed through the §18.8
 * strong-reference rule and invariant §34.10.
 *
 * There is nothing asset-specific about the *question* "who points at this
 * document" — a synthetic asset document is an ordinary overlay document with an
 * ordinary `_id`, which is the whole reason §24.3 step 6 works at all. So this
 * module is a thin, named projection of W4's reverse scan rather than a second
 * implementation: if the two ever disagreed, the delete action and the asset UI
 * would disagree about whether an image is in use, and one of them would be
 * wrong. Delete protection here and `deleteDocument`'s
 * `checkStrongReferences` therefore resolve to the same rows.
 *
 * Weak references are reported but never block, matching §19.5.
 */
import {incomingReferenceGraph, type ReferenceIntegrityContext} from '../references/integrity'
import type {ReverseReference} from '../references/reverse'
import type {OverlayState} from '../mutations/state'
import {OverlayAssetError} from './errors'

/** One place a branch asset is used: the referring document, path and strength. */
export type OverlayAssetUsage = ReverseReference

/**
 * Every reference pointing at `assetDocumentId` in the virtual dataset.
 *
 * Scanned under both perspectives by default (§18.8 says *the virtual dataset*,
 * not one view): an image used only by a referrer's published version is just as
 * much in use as one used by its draft.
 */
export function assetUsage(
  state: OverlayState,
  assetDocumentId: string,
  options: ReferenceIntegrityContext = {},
): OverlayAssetUsage[] {
  return incomingReferenceGraph(state, assetDocumentId, options)
}

/**
 * Refuse to delete a branch asset that something still references (§24.6, §18.8).
 *
 * @throws {OverlayAssetError} `OVERLAY_ASSET_IN_USE`, carrying `usedBy` — the
 * distinct referring document IDs — so the UI can list them (§24.6 "show upload
 * and metadata extraction failures" applies to removal failures too).
 */
export function assertAssetDeletable(
  state: OverlayState,
  assetDocumentId: string,
  options: ReferenceIntegrityContext = {},
): void {
  const blocking = assetUsage(state, assetDocumentId, options).filter(
    (usage) => usage.strength === 'strong',
  )
  if (blocking.length === 0) return

  const usedBy: string[] = []
  for (const usage of blocking) {
    if (!usedBy.includes(usage.referringDocumentId)) usedBy.push(usage.referringDocumentId)
  }
  usedBy.sort()

  throw new OverlayAssetError(
    'OVERLAY_ASSET_IN_USE',
    `Asset ${JSON.stringify(assetDocumentId)} is referenced by ${usedBy.length} document(s): ${usedBy
      .map((id) => JSON.stringify(id))
      .join(', ')}. Remove the references first (PRD §24.6, §18.8, §34.10).`,
    {assetDocumentId, usedBy, references: blocking},
  )
}
