/** Workstream W2 — mutation engine (plan §5; PRD §13.7, §17.5-§17.11, §34.5, §34.6). */

export {
  deepClone,
  getAtPath,
  hasAtPath,
  indexOfKey,
  isPathPrefix,
  isPathTouched,
  isPlainObject,
  mergeTouchedPaths,
  removeAtPath,
  segmentEquals,
  setAtPath,
  touchedPathFor,
  updateAtPath,
} from './paths'
export type {PathLookup, PathUpdate, PathUpdater, UpdateOptions} from './paths'

export {applyDiffMatchPatch, parseDiffMatchPatch} from './diff-match-patch'
export type {DiffMatchPatchHunk, DiffOp} from './diff-match-patch'

export {
  applyOperation,
  applyOperations,
  explicitUnsetPaths,
  PROTECTED_SYSTEM_FIELDS,
} from './operations'
export type {AppliedOperation, ApplyOperationOptions} from './operations'

export {
  applySyntheticSystemFields,
  createDocumentRecord,
  createLocalVersion,
  createOverlayState,
  currentRevisionOf,
  documentIdFor,
  emptyLocalBlock,
  getRecord,
  versionKindFor,
  withRecord,
} from './state'
export type {
  CreateOverlayStateOptions,
  NewRecordInput,
  OverlayState,
  SyntheticFieldInput,
  VersionKind,
} from './state'

export {
  createBaseSource,
  EMPTY_BASE_SOURCE,
  localWinsMerge,
  noopStrongReferenceCheck,
  noopValidator,
} from './ports'
export type {
  BaseDocumentSource,
  BaseSnapshot,
  DocumentValidator,
  MergeInput,
  MergeResolver,
  StrongReferenceCheck,
  StrongReferenceCheckInput,
  StrongReferenceIssue,
  ValidationContext,
  ValidationIssue,
} from './ports'

export {documentExists, resolveDraft, resolvePublished, resolveVersion} from './resolve'
export type {ResolveContext} from './resolve'

export {
  applyMutation,
  blockingStrongReferences,
  mutationTargetId,
  validateMutation,
} from './mutation'
export type {AppliedMutation, MutationContext} from './mutation'

export {applyTransaction, commitTransform, findByIdempotencyKey} from './transaction'
export type {TransactionCommit, TransactionOptions} from './transaction'
