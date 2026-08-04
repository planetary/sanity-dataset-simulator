/**
 * `sanity-overlay-store-fs` — the filesystem overlay store adapter
 * (roadmap Phase 3, PRD §14, §37 Phase 2 "Filesystem store tasks").
 *
 * Two things live here:
 *
 * 1. {@link OverlayStore} — the adapter-neutral store contract (PRD §35.7).
 *    ⚠️ Temporarily hosted by this package; it belongs in `sanity-overlay-core`.
 *    See the header of `contract.ts`.
 * 2. {@link FsOverlayStore} — the filesystem implementation of that contract
 *    against the §14.1 canonical layout.
 *
 * Milestone note (PRD §1.4): `[M-LOCAL]` foundations. No milestone acceptance is
 * claimed by this package.
 */

/* The store contract and its structured error set (PRD §35.7, §25.14). */
export * from './contract'

/* Review-facing document intent (PRD §14.2). */
export {
  baseSnapshotFrom,
  compactIntentState,
  dedupePaths,
  intentChecksum,
  intentFromRecord,
  valueAtPath,
} from './intent'
export type {
  CheckpointDocumentIntent,
  OverlayArrayOperation,
  OverlayBaseSnapshot,
  OverlayConflictSummary,
  OverlayIntentState,
} from './intent'

/* Canonical layout and path-containment guard (PRD §14.1, §35.9). */
export {
  ASSETS_DIR,
  BROKEN_SUFFIX,
  DOCUMENTS_DIR,
  GITATTRIBUTES_CONTENT,
  GITATTRIBUTES_FILE,
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
  HISTORY_DIR,
  INDEXES_DIR,
  INTENT_FILE,
  LOCKS_DIR,
  MANIFEST_FILE,
  MATERIALIZED_DIR,
  MIGRATIONS_DIR,
  OVERLAY_DIR,
  OverlayLayout,
  README_CONTENT,
  README_FILE,
  REVISIONS_DIR,
  RUNTIME_DIR,
  SNAPSHOTS_DIR,
  TEMP_PREFIX,
  TRANSACTIONS_DIR,
  assertSafeComponent,
  assertWithinRoot,
  documentKey,
} from './layout'

/* The adapter. */
export {FsOverlayStore, bundleChecksum} from './fsStore'
export type {
  FsOverlayStoreHooks,
  FsOverlayStoreOptions,
  MaterializedDocumentFile,
} from './fsStore'
