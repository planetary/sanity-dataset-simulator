/**
 * Executable PRD §34 invariants (plan docs/plans/phase-2-core-domain.md §8.3).
 *
 * Twelve invariants are in Phase 2 scope. Each is a pure function over the
 * relevant state that returns structured {@link OverlayInvariantViolation}s
 * instead of throwing, so the identical call site serves a test assertion and a
 * runtime debug endpoint. {@link checkOverlayInvariants} runs every check whose
 * inputs are present.
 *
 * §34.11-§34.14 are **not** reimplemented here: `merge/invariants.ts` owns them
 * and this module composes them, so there is exactly one definition of each.
 */
export {OVERLAY_INVARIANT_IDS} from './types'
export type {OverlayInvariantId, OverlayInvariantViolation} from './types'

export {
  checkIdempotencyLedger,
  checkRecordChecksums,
  checkRevisionIncrements,
  checkSingleCurrentVersions,
  checkStateChecksums,
  checkTombstoneSuppression,
} from './state'
export type {TombstoneSuppressionInput, TombstoneSuppressionOptions} from './state'

export {checkManifestHeads, checkOrphanVisibility} from './manifest'
export type {ManifestHeadInventory, OrphanVisibilityInput} from './manifest'

export {checkCheckpointDeterminism} from './checkpoint'

export {
  checkMergeBaseDeletionRecovery,
  checkMergeResultInvariants,
  checkMergeTouchedPreservation,
  checkMergeUnsetSuppression,
  checkMergeUntouchedInheritance,
} from './merge'

export {checkOverlayInvariants} from './check'
export type {OverlayInvariantInput} from './check'
