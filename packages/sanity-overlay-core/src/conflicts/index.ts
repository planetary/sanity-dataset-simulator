/**
 * Workstream W3 — conflicts (plan §6; PRD §13.11 taxonomy, §17.4 severity,
 * §28.1/§28.3 resolution operations, §28.6 acknowledgement).
 *
 * Conflict identity is derived from `documentId`, `type` and the encoded path, so
 * the merge engine stays a pure function with no ID source; severity comes from
 * the §17.4 table held as data in `../types/conflict`.
 */

export {conflictId, createConflict, hasHardConflict, summarizeConflicts} from './create'
export type {CreateConflictInput} from './create'

/* Persistence onto the §13.3 record and the §13.1 summary (§17.11, §28.6). */
export {
  describesSameDisagreement,
  overlayConflictSummary,
  persistConflicts,
  unresolvedConflicts,
} from './persist'

export {
  CONFLICT_RESOLUTION_ACTIONS,
  CONFLICT_RESOLUTION_ACTION_TYPES,
  acknowledgeConflict,
  applicableResolutionActions,
  isAcknowledgementValid,
  resolveConflict,
  resolveRecordConflict,
} from './resolve'
export type {
  AcknowledgeConflictRequest,
  AcknowledgeConflictResult,
  ConflictAcknowledgement,
  ConflictResolutionAction,
  ConflictResolutionResult,
  ConflictResolutionTransaction,
  ResolveConflictRequest,
  ResolveRecordConflictRequest,
  ResolveRecordConflictResult,
} from './resolve'
