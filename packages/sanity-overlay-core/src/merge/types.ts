/** Inputs and outputs of the three-way merge (PRD §17.1, §17.3). */
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'
import type {OverlayBaseStatus, OverlayDocumentOrigin} from '../types/record'
import type {MergeValidationIssue, MergeValidator} from './validation'

/**
 * PRD §17.1 merge inputs, plus the four pieces §17.3 and §16.4 need but §17.1's
 * pseudo-code leaves implicit: which paths are held down by an explicit unset
 * (§17.5), whether the document is branch-created (§17.2 precedence rule 2),
 * whether an absent base is *deleted* or merely never fetched (§16.4), and the
 * injected clock and validator (§17.3 step 9).
 */
export interface MergeRequest {
  /** Logical (or perspective) document ID; stamped on every conflict record. */
  documentId: string
  /** Injected clock value used as `OverlayConflict.detectedAt` (§13.11). */
  now: string
  /** Base snapshot captured at first touch (§16.3, §17.1). */
  ancestor: SanityDocument | null
  /** Latest base document for the relevant perspective (§17.1). */
  currentBase: SanityDocument | null
  /** Current complete branch document, or `null` when the branch has no version. */
  localMaterialized: SanityDocument | null
  localTouchedPaths?: readonly OverlayPath[]
  localTombstone?: boolean
  /** Paths suppressed by an explicit unset (§17.5, invariant §34.11). */
  unsetPaths?: readonly OverlayPath[]
  /** `branch` outranks base entirely (§17.2 precedence rule 2). */
  origin?: OverlayDocumentOrigin
  /** Distinguishes "base deleted" from "base not present" (§16.4). */
  baseStatus?: OverlayBaseStatus
  /** PRD §17.3 step 9. Defaults to {@link noopMergeValidator}. */
  validate?: MergeValidator
  /** `MergeValidationContext.action`; defaults to `'merge'` (§20.5 timing). */
  validationAction?: string
}

/** Why a merge resolved to no document at all. */
export type MergeAbsence =
  /** An applicable local tombstone (§17.2 precedence rule 1). */
  | 'tombstone'
  /** The base document was deleted and nothing local survives it (§16.4 row 1). */
  | 'base-deleted'
  /** Neither base nor branch has a version of this document. */
  | 'missing'

export interface MergeResult {
  /** The resolved document, or `null` when the merge resolves to no document. */
  document: SanityDocument | null
  absence: MergeAbsence | null
  conflicts: OverlayConflict[]
  /** PRD §17.3 step 10 — deterministic checksum of the resolved document. */
  checksum: string | null
  /** Touched paths that still carry local intent after the merge. */
  touchedPaths: OverlayPath[]
  /** Touches dropped because the local value equals the ancestor (§17.3 step 5). */
  removedTouchedPaths: OverlayPath[]
  /** Issues returned by the injected validator (§17.3 step 9). */
  validation: readonly MergeValidationIssue[]
}
