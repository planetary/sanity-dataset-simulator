/**
 * Checkpoint export and import — the Git-facing review surface (PRD §14.1,
 * §14.3, §29, invariant §34.17).
 *
 * Pure: a checkpoint is a deterministic function of overlay state alone. The
 * filesystem half — writing the rendered set to a directory, reading one back,
 * watching it for direct edits — lives in `sanity-overlay-store-fs`.
 */
export {
  CHECKPOINT_CHECKSUMS_FILE,
  CHECKPOINT_DOCUMENTS_DIR,
  CHECKPOINT_INTENT_FILE,
  CHECKPOINT_MANIFEST_FILE,
  CHECKPOINT_SNAPSHOTS_DIR,
  checkpointIntentPath,
  checkpointSnapshotPath,
  contentAddressFromSnapshotPath,
  isGovernedCheckpointPath,
  logicalIdFromIntentPath,
} from './paths'

export {
  checkpointChecksumsChecksum,
  checkpointFilesFromRecord,
  checkpointFilesToRecord,
  checkpointIntentProblem,
  checkpointManifestProblem,
  checkpointSnapshotProblem,
  checkpointStateFromBundle,
  exportCheckpoint,
  importCheckpoint,
  verifyCheckpoint,
} from './checkpoint'

export type {
  ExportCheckpointOptions,
  ImportCheckpointOptions,
  OverlayCheckpointChecksums,
  OverlayCheckpointFiles,
  OverlayCheckpointFilesInput,
  OverlayCheckpointImport,
  OverlayCheckpointIssue,
  OverlayCheckpointIssueKind,
  OverlayCheckpointState,
  OverlayCheckpointVerification,
} from './types'
