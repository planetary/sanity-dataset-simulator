/**
 * `sanity-overlay-core` — Workstreams W1 (types and serialization) and W2
 * (mutation engine and document actions).
 *
 * Pure, dependency-free domain foundations (roadmap Phase 2, plan §4 and §5):
 * PRD §13 data model, §14.3 canonical serializer, §13.2 checksums, §13.6 path
 * encoding, §14.3 logical-ID encoding, format version handling, the §13.7
 * operation and mutation engine, §17.5-§17.11 mutation semantics, §34.5/§34.6
 * transaction invariants and the §18.4-§18.9 document actions.
 *
 * Milestone note (plan §1, PRD §1.4): these are `[M-LOCAL]` foundations. No
 * milestone acceptance is claimed by this package.
 */

/* Types — PRD §13 canonical data model, §13.6 paths, §12 identity. */
export * from './types/index'

/* Errors — structured, code-carrying failures. */
export {
  OverlayError,
  OverlaySerializationError,
  OverlayPrototypeKeyError,
  OverlayEncodingError,
  OverlayFormatVersionError,
  OverlayMigrationError,
  OverlayPathError,
  OverlayMutationError,
  OverlayDiffMatchPatchError,
  OverlayPreconditionError,
  OverlayActionBlockedError,
} from './errors'
export type {OverlayErrorCode, OverlayErrorDetails} from './errors'

/* Canonical JSON serializer — PRD §14.3, §34.17. */
export {
  serialize,
  serializeCanonical,
  serializeCompact,
  parse,
  parseCanonical,
  roundTrip,
  canonicalize,
  canonicalEquals,
  isForbiddenKey,
  FORBIDDEN_KEYS,
} from './serialize'
export type {JsonPath} from './serialize'

/* Checksums and synthetic revisions — PRD §13.2, §13.9, §12.1. */
export {
  sha256Bytes,
  sha256Hex,
  toHex,
  checksum,
  recomputeChecksum,
  verifyChecksum,
  isChecksum,
  documentChecksumPrefix,
  syntheticRev,
  isSyntheticRev,
  parseSyntheticRev,
  assertContentLakeRevision,
  overlayIdFromIdentityInput,
  SYNTHETIC_REV_PREFIX,
} from './checksum'
export type {ParsedSyntheticRev} from './checksum'

/* Encoders — PRD §13.6 paths, §14.3 / §35.9 logical IDs. */
export {
  encodeOverlayPath,
  decodeOverlayPath,
  overlayPathEquals,
  encodeLogicalId,
  decodeLogicalId,
  isEncodedLogicalId,
  toPublishedId,
  toDraftId,
  isDraftId,
  OVERLAY_PATH_ROOT,
  MAX_ENCODED_ID_LENGTH,
  ID_ESCAPE,
  DRAFTS_PREFIX,
} from './encoding'

/* Format version and migration chain — PRD §13.1, §13.3, §13.10, §14.2. */
export {
  assertFormatVersion,
  assertRecordFormatVersion,
  isSupportedFormatVersion,
  createMigrationRegistry,
  registerMigration,
  migrate,
  migrations,
} from './version'
export type {
  MigrationRegistry,
  MigrationRegistryOptions,
  OverlayMigrationStep,
  RegisteredMigration,
} from './version'

/* UTF-8 codec (shared by checksum and ID encoding). */
export {utf8Encode, utf8Decode} from './utf8'

/* W2 — mutation engine (PRD §13.7, §17.5-§17.11, §34.5, §34.6). */
export * from './mutations/index'

/* W2 — document actions (PRD §18.4-§18.9). */
export {
  edit,
  publish,
  unpublish,
  discardDraft,
  deleteDocument,
  restore,
  duplicate,
} from './actions/index'
export type {
  ActionOptions,
  ActionResult,
  DocumentActionInput,
  DuplicateInput,
  EditInput,
  RestoreInput,
} from './actions/index'
