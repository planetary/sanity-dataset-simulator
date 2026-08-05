/**
 * Workstream W3 — merge engine (plan §6; PRD §17, §16.4, §28.4, §28.5).
 *
 * Everything here is pure: no IO, no clock, no ID source. Time and identity
 * arrive as `now` and `documentId`; schema validation arrives as an injected
 * {@link MergeValidator} port with a no-op default (PRD §17.3 step 9, §20.1).
 */

export {mergeDocument, createMergeResolver, sortConflicts, hasDuplicateKeys} from './merge'
export type {MergeResolverOptions} from './merge'
export type {MergeAbsence, MergeRequest, MergeResult} from './types'

export {noopMergeValidator, hasValidationError} from './validation'
export type {MergeValidationContext, MergeValidationIssue, MergeValidator} from './validation'

export {AUTO_REBASE_PRECONDITIONS, REBASE_MODES, applyRebaseMode, autoRebase} from './rebase'
export type {
  AutoRebasePrecondition,
  AutoRebasePreconditionId,
  AutoRebaseRequest,
  AutoRebaseResult,
  RebaseAuditTransaction,
  RebaseMode,
  RebaseModeRequest,
  RebaseModeResult,
} from './rebase'

export {BASE_DELETION_MATRIX, classifyBaseDeletion} from './base-deletion'
export type {
  BaseDeletionInput,
  BaseDeletionOutcome,
  BaseDeletionResult,
  BaseDeletionRow,
  BaseDeletionState,
} from './base-deletion'

export {
  changedPaths,
  checkBaseDeletionRecovery,
  checkMergeInvariants,
  checkTouchedPreservation,
  checkUnsetSuppression,
  checkUntouchedInheritance,
} from './invariants'
export type {InvariantViolation, MergeInvariantId} from './invariants'

export {buildTouchTree, childKind, segmentKey} from './touch-tree'
export type {TouchChildKind, TouchTreeChild, TouchTreeNode} from './touch-tree'

export {isKeyedArray, itemKey, keyMap, valueEquals} from './context'

/* PRD §17.11 — overlay-vs-overlay race handling (plan §6 scope boundary). */
export {compareOverlayHeads} from './overlay-heads'
export type {
  OverlayHead,
  OverlayHeadComparison,
  OverlayHeadComparisonRequest,
} from './overlay-heads'
