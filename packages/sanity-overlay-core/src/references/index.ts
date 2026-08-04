/**
 * Workstream W4 — references (plan docs/plans/phase-2-core-domain.md §7).
 *
 * PRD §19.1 core rule, §19.2 resolver, §19.4 reverse scan, §19.5 strong/weak
 * integrity, §19.6 ID migration, §19.7 type migration, §18.6/§18.8 action
 * integrity, invariant §34.10.
 */

export {OverlayReferenceError} from './types'
export type {
  ExtractedReference,
  OverlayReferenceErrorCode,
  ReferencePerspective,
  ReferenceStrength,
  ReferenceVersion,
} from './types'

export {extractReferences, isReferenceValue} from './extract'
export type {ExtractReferencesOptions} from './extract'

export {
  assertReverseScanComplete,
  createBaseReverseSource,
  scanReverseReferences,
  DEFAULT_MAX_REFERENCE_DEPTH,
} from './reverse'
export type {
  BaseReverseReferenceHit,
  BaseReverseReferenceSource,
  ReverseReference,
  ReverseReferenceSource,
  ReverseScanOptions,
  ReverseScanResult,
} from './reverse'

export {
  createStrongReferenceCheck,
  incomingReferenceGraph,
  incomingReferences,
  publishReferenceIssues,
  referenceValidationIssues,
} from './integrity'
export type {
  IncomingReferenceOptions,
  IncomingReferenceReason,
  ReferenceIntegrityContext,
} from './integrity'

export {
  applyMigration,
  assertIdImmutable,
  assertMigrationValid,
  migrationMutations,
  planIdMigration,
  planTypeMigration,
} from './migration'
export type {
  IdMigrationInput,
  IdMigrationPlan,
  MigrationPlanContext,
  OverlayMigration,
  OverlayMigrationOperation,
  OverlayMigrationPlan,
  TypeMigrationIncompatibility,
  TypeMigrationInput,
  TypeMigrationPlan,
} from './migration'

export {createStateTargetResolver, dereference, resolveReferenceTarget} from './resolve'
export type {
  MissingReferenceMetadata,
  ReferenceResolutionContext,
  ReferenceTargetOrigin,
  ResolveTargetRequest,
  ResolvedReferenceTarget,
  VirtualTargetResolver,
} from './resolve'
