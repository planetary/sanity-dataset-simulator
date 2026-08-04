/** PRD §13 canonical data model, §13.6 paths, §12 identity types (plan §3). */

export type {SanityDocument} from './document'
export type {OverlayActor} from './actor'
export type {OverlayPath, OverlayPathSegment} from './path'
export {isKeySegment, isIndexSegment} from './path'
export {OVERLAY_FORMAT_VERSION} from './format-version'
export type {OverlayFormatVersion, OverlayVersionedRecord} from './format-version'
export type {OverlayIdentity, OverlayIdentityInput} from './identity'
export type {
  OverlayManifest,
  OverlayDocumentHead,
  OverlayStatus,
  OverlayDocumentState,
} from './manifest'
export {OVERLAY_STATUSES, OVERLAY_DOCUMENT_STATES} from './manifest'
export type {
  OverlayDocumentRecord,
  OverlayDocumentOrigin,
  OverlayRecordBaseBlock,
  OverlayRecordLocalBlock,
  OverlayBaseStatus,
  OverlayAncestorKind,
  BaseDocumentVersion,
  LocalDocumentVersion,
} from './record'
export {OVERLAY_ANCESTOR_KINDS} from './record'
export type {
  OverlayOperation,
  OverlayOperationType,
  OverlayMutation,
  OverlayMutationType,
  OverlayInsertPosition,
} from './operations'
export {
  OVERLAY_OPERATION_TYPES,
  OVERLAY_MUTATION_TYPES,
  OVERLAY_INSERT_POSITIONS,
} from './operations'
export type {OverlayTransactionRecord} from './transaction'
export type {
  OverlayConflict,
  OverlayConflictType,
  OverlayConflictSeverity,
  OverlayConflictResolution,
  OverlayConflictResolutionType,
  ConflictSeverityContext,
} from './conflict'
export {
  OVERLAY_CONFLICT_TYPES,
  OVERLAY_CONFLICT_RESOLUTION_TYPES,
  DEFAULT_CONFLICT_SEVERITY,
  defaultConflictSeverity,
} from './conflict'
export type {
  SyntheticSystemField,
  SyntheticSystemFieldPolicy,
  SyntheticFieldOrigin,
  SyntheticFieldRule,
} from './system-fields'
export {SYNTHETIC_SYSTEM_FIELD_POLICY, syntheticSystemFieldRule} from './system-fields'
