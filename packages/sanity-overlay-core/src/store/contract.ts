/**
 * The overlay store contract — one interface, every adapter.
 *
 * Home: `sanity-overlay-core/src/store/contract.ts` — PRD §10.1 "Store adapters
 * implement the same contract", plan §8.1 "Define the store contract interface".
 * Every adapter imports it from here: `MemoryOverlayStore` (core, plan §8.1),
 * `FsOverlayStore` (Phase 3) and the Phase 4 Blob adapter. Nothing in this file
 * touches `node:*` or a filesystem, which is why it can live in core at all.
 * `sanity-overlay-store-fs/src/contract.ts` is a re-export shim over this module.
 *
 * ## Method → PRD §35.7 mapping
 *
 * Every §35.7 "Every adapter must pass" line is satisfied by exactly one method:
 *
 * | §35.7 line                            | Method                                     |
 * |---------------------------------------|--------------------------------------------|
 * | Create overlay                        | {@link OverlayStore.createOverlay}          |
 * | Read empty overlay                    | {@link OverlayStore.readManifest}           |
 * | Conditional manifest write            | {@link OverlayStore.writeManifestConditional} |
 * | Store and read document revision      | {@link OverlayStore.putDocumentRevision} / {@link OverlayStore.getDocumentRevision} |
 * | Commit multi-document transaction     | {@link OverlayStore.commitTransaction}      |
 * | Idempotent transaction replay         | {@link OverlayStore.getTransaction} (+ `commitTransaction` replay) |
 * | Concurrent stale write rejection      | {@link OverlayStore.writeManifestConditional} |
 * | List changed documents                | {@link OverlayStore.listChangedDocuments}   |
 * | Read by logical ID                    | {@link OverlayStore.readDocumentByLogicalId}|
 * | Export canonical state                | {@link OverlayStore.exportCanonical}        |
 * | Import canonical state                | {@link OverlayStore.importCanonical}        |
 * | Mark closed                           | {@link OverlayStore.markClosed}             |
 * | Mark promoted                         | {@link OverlayStore.markPromoted}           |
 * | Retention metadata                    | {@link OverlayStore.setRetention}           |
 * | Delete overlay                        | {@link OverlayStore.deleteOverlay}          |
 * | Orphan revision cleanup               | {@link OverlayStore.collectOrphans}         |
 * | Checksum corruption detection         | {@link OverlayStore.verifyChecksums}        |
 *
 * ## Layering
 *
 * The store **persists**; it does not merge, validate against a schema, or apply
 * mutations. Applying an {@link OverlayMutation} to produce the next
 * {@link OverlayDocumentRecord} is the core mutation engine's job (plan §5, W2);
 * {@link OverlayCommitRequest} therefore carries both the mutations (for the
 * §13.10 audit record) and the records they produced (for persistence). That
 * split is what lets the identical §35.7 suite run against memory, filesystem
 * and Blob adapters.
 */
import {checksum as canonicalChecksum, syntheticRev} from '../checksum'
import type {
  OverlayActor,
  OverlayConflict,
  OverlayDocumentHead,
  OverlayDocumentRecord,
  OverlayDocumentState,
  OverlayFormatVersion,
  OverlayIdentityInput,
  OverlayManifest,
  OverlayMutation,
  OverlayStatus,
  OverlayTransactionRecord,
  SanityDocument,
} from '../types/index'
import type {CheckpointDocumentIntent, OverlayBaseSnapshot} from './intent'

export * from './errors'

/** Injected clock. Adapters must never call `Date.now()` themselves (plan §8.1). */
export type OverlayClock = () => string

/* ------------------------------------------------------------------ *
 * createOverlay — §35.7 "Create overlay"
 * ------------------------------------------------------------------ */

export interface CreateOverlayInput {
  /** Explicit overlay ID, or omit and supply {@link identity} to derive it (PRD §12.1). */
  overlayId?: string
  identity?: OverlayIdentityInput
  base: OverlayManifest['base']
  source: OverlayManifest['source']
  actor?: OverlayActor
  /** Initial lifecycle state; defaults to `active` (PRD §12.3). */
  status?: OverlayStatus
  expiresAt?: string
  /** Return the existing manifest instead of throwing when the overlay exists. */
  ifNotExists?: boolean
}

/* ------------------------------------------------------------------ *
 * Manifest writes — §35.7 "Conditional manifest write" / "Concurrent stale
 * write rejection"
 * ------------------------------------------------------------------ */

export interface WriteManifestOptions {
  /** Stamp `updatedBy` on the written manifest (PRD §13.1). */
  actor?: OverlayActor
}

/* ------------------------------------------------------------------ *
 * Document revisions — §35.7 "Store and read document revision"
 * ------------------------------------------------------------------ */

export interface PutDocumentRevisionOptions {
  /** Overlay-level precondition (PRD §25.5 `expectedOverlayRevision`). */
  expectedOverlayRevision?: number
  /** Document-level precondition (PRD §25.5 `expectedDocumentRevisions`). */
  expectedDocumentRevision?: string
  actor?: OverlayActor
}

export interface OverlayDocumentWriteResult {
  head: OverlayDocumentHead
  manifest: OverlayManifest
  /** Adapter-opaque address of the immutable revision that was written (PRD §13.2). */
  storageRef: string
  checksum: string
  /** Content address of the base capture, when the record has a base block. */
  snapshotRef?: string
}

export interface OverlayDocumentReadResult {
  head: OverlayDocumentHead
  /**
   * The full §13.3 record, when the adapter still holds it.
   *
   * `null` means the immutable revision is gone but the canonical review state
   * survives — on the filesystem that is a fresh `git clone` where `.runtime/`
   * was never committed. Rebuilding a record from `intent` + `baseSnapshot`
   * requires the three-way merge engine and is not a store responsibility.
   */
  record: OverlayDocumentRecord | null
  /** Canonical review-facing intent (PRD §14.2). */
  intent: CheckpointDocumentIntent | null
  /** The content-addressed base capture referenced by `intent.base.snapshotRef`. */
  baseSnapshot: OverlayBaseSnapshot | null
  storageRef: string
}

/* ------------------------------------------------------------------ *
 * Transactions — §35.7 "Commit multi-document transaction" / "Idempotent
 * transaction replay"
 * ------------------------------------------------------------------ */

export interface OverlayCommitRequest {
  /** Deduplication authority — one key maps to one immutable result (PRD §13.10, §34.6). */
  idempotencyKey: string
  actor: OverlayActor
  /** Audit payload written into the §13.10 record. */
  mutations: OverlayMutation[]
  /** Post-state of every document the transaction touched. */
  records: OverlayDocumentRecord[]
  /** Logical IDs the transaction removes from the overlay entirely (PRD §29.8 reset). */
  removedDocumentIds?: string[]
  expectedOverlayRevision?: number
  expectedDocumentRevisions?: Record<string, string>
  requestedAt?: string
  requestId?: string
  /** Advisory correlation only; never a storage key (PRD §13.10). */
  clientTransactionId?: string
  /** Conflicts surfaced by this commit, folded into `manifest.conflictSummary`. */
  conflicts?: OverlayConflict[]
}

export interface OverlayCommitResult {
  transaction: OverlayTransactionRecord
  manifest: OverlayManifest
  heads: OverlayDocumentHead[]
  /** True when the idempotency key replayed a previously committed result (PRD §34.6). */
  replayed: boolean
}

export type OverlayTransactionSelector = {transactionId: string} | {idempotencyKey: string}

/* ------------------------------------------------------------------ *
 * Listing and reading — §35.7 "List changed documents" / "Read by logical ID"
 * ------------------------------------------------------------------ */

export interface ListChangedDocumentsOptions {
  /** Include heads in state `unchanged`; excluded by default (PRD §13.2). */
  includeUnchanged?: boolean
  /** Restrict to these §13.2 states. */
  states?: readonly OverlayDocumentState[]
}

/* ------------------------------------------------------------------ *
 * Export and import — §35.7 "Export canonical state" / "Import canonical state"
 * ------------------------------------------------------------------ */

/**
 * The portable canonical bundle (PRD §14.5 `export` / `import <bundle>`).
 *
 * Distinct from the Git working tree of §29.1: the tree is the *review* surface
 * (intent + snapshots, no runtime files), this bundle is the *transfer* surface
 * and is lossless, so an import reproduces the exporting store byte for byte.
 * Both are canonically serialized, so both are deterministic (PRD §34.17).
 */
export interface OverlayCanonicalBundle {
  formatVersion: OverlayFormatVersion
  overlayId: string
  exportedAt: string
  manifest: OverlayManifest
  documents: OverlayCanonicalBundleDocument[]
  /** Content address → base capture (PRD §14.1 `snapshots/<sha256>.json`). */
  snapshots: Record<string, OverlayBaseSnapshot>
  transactions: OverlayTransactionRecord[]
  /** SHA-256 over the canonical serialization of the bundle without this field. */
  checksum: string
}

export interface OverlayCanonicalBundleDocument {
  intent: CheckpointDocumentIntent
  record: OverlayDocumentRecord | null
  storageRef: string
}

export interface ExportCanonicalOptions {
  /** Include the runtime transaction log; on by default. */
  includeTransactions?: boolean
}

export interface ImportCanonicalOptions {
  /** Replace an existing overlay instead of failing (PRD §29.7 import on preview init). */
  overwrite?: boolean
  /** Verify the bundle checksum before writing anything; on by default (PRD §34.4). */
  verifyChecksum?: boolean
}

export interface ImportCanonicalResult {
  manifest: OverlayManifest
  importedDocuments: number
  importedSnapshots: number
  importedTransactions: number
}

/* ------------------------------------------------------------------ *
 * Lifecycle — §35.7 "Mark closed" / "Mark promoted" / "Retention metadata" /
 * "Delete overlay"
 * ------------------------------------------------------------------ */

/** PRD §15.7 retention policy input. */
export interface OverlayRetentionPolicy {
  /** Absolute expiry; `null` clears it (PRD §13.1 `expiresAt`). */
  expiresAt?: string | null
  /** Relative expiry in days from `now()`, used when `expiresAt` is absent. */
  ttlDays?: number
  reason?: string
}

export interface MarkClosedOptions {
  actor?: OverlayActor
  /** Retention to apply at close; defaults to the §15.7 table via {@link defaultRetentionDays}. */
  retention?: OverlayRetentionPolicy
  reason?: string
}

export interface OverlayPromotionInput {
  planId?: string
  targetDataset?: string
  promotedAt?: string
  resultingTransactionId?: string
  actor?: OverlayActor
  retention?: OverlayRetentionPolicy
}

export interface DeleteOverlayOptions {
  /**
   * Bypass the §15.7 guards ("Mark overlay closed before deletion", "Never
   * delete an overlay with an active promotion"). Reserved for operator tooling.
   */
  force?: boolean
}

export interface DeleteOverlayResult {
  overlayId: string
  deleted: boolean
  /** Refs removed, relative to the adapter's root, for the §15.7 cleanup record. */
  removedRefs: string[]
}

/**
 * PRD §15.7 `[SHOULD]` default retention, in days. `null` means "no expiration".
 * Named per lifecycle state rather than per storage backend: the table is a
 * product policy, not a Blob detail.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<string, number | null>> = Object.freeze({
  /** Active PR: no expiration. */
  active: null,
  checkpointed: null,
  conflicted: null,
  /** Closed and checkpointed: 14 days; closed and uncheckpointed: 30 days. */
  'closed-checkpointed': 14,
  'closed-uncheckpointed': 30,
  promoted: 14,
  /** Orphan immutable objects: 7 days. */
  orphan: 7,
})

/** Resolve the §15.7 default retention for a manifest's current state. */
export function defaultRetentionDays(manifest: OverlayManifest): number | null {
  if (manifest.status === 'promoted') return DEFAULT_RETENTION_DAYS.promoted ?? null
  if (manifest.status === 'closed') {
    return manifest.checkpoint
      ? (DEFAULT_RETENTION_DAYS['closed-checkpointed'] ?? null)
      : (DEFAULT_RETENTION_DAYS['closed-uncheckpointed'] ?? null)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Cleanup and integrity — §35.7 "Orphan revision cleanup" / "Checksum
 * corruption detection"
 * ------------------------------------------------------------------ */

export type OverlayArtifactKind =
  | 'revision'
  | 'snapshot'
  | 'document'
  | 'materialized'
  | 'intent'
  | 'manifest-head'
  | 'manifest'

export interface OverlayOrphanRef {
  kind: OverlayArtifactKind
  /** Adapter-relative reference (a path for fs, a blob key for Blob). */
  ref: string
  logicalId?: string
  reason: string
}

export interface CollectOrphansOptions {
  /** Report without deleting. */
  dryRun?: boolean
  /** Also collect unreferenced content-addressed base snapshots; on by default. */
  includeSnapshots?: boolean
  /** Also collect document directories with no manifest head; on by default. */
  includeDocuments?: boolean
}

/** PRD §15.7 "Record cleanup results and failures". */
export interface OverlayOrphanReport {
  overlayId: string
  dryRun: boolean
  scanned: number
  orphans: OverlayOrphanRef[]
  deleted: OverlayOrphanRef[]
  failures: Array<{ref: string; reason: string}>
}

export interface OverlayChecksumIssue {
  kind: OverlayArtifactKind
  ref: string
  logicalId?: string
  expected: string
  actual: string
  /**
   * `true` when the *stored checksum metadata* is stale on a file that is still
   * semantically valid — PRD §14.3 "Treat a stale stored checksum as repairable
   * metadata when the semantic file validates. Do not reject a valid manual merge
   * solely because its old checksum changed." Repair with
   * {@link OverlayDirectEditStore.repairChecksums}.
   *
   * `false` when the *content address* itself is violated (a file whose name is
   * its own hash no longer hashes to that name). That is corruption, not stale
   * metadata, and rewriting the checksum would destroy evidence.
   */
  repairable: boolean
}

export interface OverlayChecksumReport {
  overlayId: string
  ok: boolean
  checked: number
  issues: OverlayChecksumIssue[]
  /** Refs a head names but that no longer exist (PRD §34.3). */
  missing: OverlayOrphanRef[]
}

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

/**
 * The store surface every adapter implements (memory, filesystem, Blob).
 *
 * All methods are async so a network-backed adapter fits without wrapping.
 * All methods take `overlayId` explicitly even where an adapter holds exactly one
 * overlay: a single-overlay adapter raises `OVERLAY_IDENTITY_MISMATCH` rather
 * than silently serving the wrong branch (PRD §12.2, §35.8 "Different PR cannot
 * access overlay").
 */
export interface OverlayStore {
  /** §35.7 "Create overlay" — write a fresh manifest at revision 0, status `active`. */
  createOverlay(input: CreateOverlayInput): Promise<OverlayManifest>

  /**
   * §35.7 "Read empty overlay" — read the current manifest.
   *
   * Throws `OVERLAY_NOT_FOUND` when nothing is stored. A freshly created overlay
   * reads back at revision 0 with empty `documentHeads` and a zeroed
   * `conflictSummary` — that is the "empty overlay" the §35.7 line means.
   */
  readManifest(overlayId: string): Promise<OverlayManifest>

  /**
   * §35.7 "Conditional manifest write" and "Concurrent stale write rejection";
   * PRD §14.3 "Use expected manifest revision to prevent accidental stale local
   * writes", §35.9 "Concurrent expected revision conflict".
   *
   * `next.revision` must equal `expectedRevision + 1` — a conditional write *is*
   * the overlay's exactly-once revision increment (PRD §34.5). A mismatch between
   * `expectedRevision` and the stored revision raises `OVERLAY_WRITE_CONFLICT`
   * (retryable) and leaves storage untouched.
   */
  writeManifestConditional(
    overlayId: string,
    next: OverlayManifest,
    expectedRevision: number,
    options?: WriteManifestOptions,
  ): Promise<OverlayManifest>

  /**
   * §35.7 "Store and read document revision" (write half).
   *
   * Writes the record as an immutable, content-addressed revision, then publishes
   * it by conditionally replacing the manifest. A crash between the two leaves an
   * unreachable revision and nothing else (PRD §15.3, §34.8) — {@link collectOrphans}
   * reclaims it.
   */
  putDocumentRevision(
    overlayId: string,
    record: OverlayDocumentRecord,
    options?: PutDocumentRevisionOptions,
  ): Promise<OverlayDocumentWriteResult>

  /**
   * §35.7 "Store and read document revision" (read half) — read a specific
   * immutable revision by its `storageRef`, independent of the current head.
   */
  getDocumentRevision(overlayId: string, storageRef: string): Promise<OverlayDocumentRecord | null>

  /**
   * §35.7 "Commit multi-document transaction" — persist every record in one
   * atomic step and increment the overlay revision exactly once (PRD §34.5).
   *
   * Atomicity is manifest replacement: immutable artifacts are written first and
   * are invisible until a head names them, then a single atomic manifest write
   * commits the whole set (PRD §15.3, mirrored on the filesystem).
   *
   * Replaying a committed `idempotencyKey` returns the original
   * {@link OverlayTransactionRecord} with `replayed: true` and applies nothing
   * (PRD §34.6).
   */
  commitTransaction(overlayId: string, request: OverlayCommitRequest): Promise<OverlayCommitResult>

  /** §35.7 "Idempotent transaction replay" — look a transaction up by ID or idempotency key. */
  getTransaction(
    overlayId: string,
    selector: OverlayTransactionSelector,
  ): Promise<OverlayTransactionRecord | null>

  /**
   * §35.7 "List changed documents" — heads in a deterministic order (logical ID,
   * code-unit ascending), excluding `unchanged` by default.
   */
  listChangedDocuments(
    overlayId: string,
    options?: ListChangedDocumentsOptions,
  ): Promise<OverlayDocumentHead[]>

  /**
   * §35.7 "Read by logical ID" — resolve head, record and review intent for a
   * logical document. `drafts.` prefixes normalize to the same logical document
   * (PRD §13.3, §18.2); returns `null` when the overlay does not touch it.
   */
  readDocumentByLogicalId(
    overlayId: string,
    logicalId: string,
  ): Promise<OverlayDocumentReadResult | null>

  /** §35.7 "Export canonical state" — a deterministic, checksummed portable bundle. */
  exportCanonical(
    overlayId: string,
    options?: ExportCanonicalOptions,
  ): Promise<OverlayCanonicalBundle>

  /** §35.7 "Import canonical state" — restore a bundle, verifying its checksum first. */
  importCanonical(
    bundle: OverlayCanonicalBundle,
    options?: ImportCanonicalOptions,
  ): Promise<ImportCanonicalResult>

  /**
   * §35.7 "Mark closed" — move to `closed` (PRD §12.3) and apply retention.
   * Writes are refused afterwards ("Writes allowed: No by default").
   */
  markClosed(overlayId: string, options?: MarkClosedOptions): Promise<OverlayManifest>

  /** §35.7 "Mark promoted" — record the §13.1 `promotion` block and move to `promoted`. */
  markPromoted(overlayId: string, promotion: OverlayPromotionInput): Promise<OverlayManifest>

  /** §35.7 "Retention metadata" — set or clear `expiresAt` (PRD §13.1, §15.7). */
  setRetention(overlayId: string, retention: OverlayRetentionPolicy): Promise<OverlayManifest>

  /**
   * §35.7 "Delete overlay" — remove all state.
   *
   * Guarded by PRD §15.7: the overlay must be closed, promoted or expired, and an
   * in-flight promotion blocks deletion. Both guards raise
   * `OVERLAY_RETENTION_ACTIVE` and are bypassable only with `force`.
   */
  deleteOverlay(overlayId: string, options?: DeleteOverlayOptions): Promise<DeleteOverlayResult>

  /**
   * §35.7 "Orphan revision cleanup" — delete immutable artifacts no manifest head
   * or checkpoint reaches (PRD §15.7, §34.8).
   */
  collectOrphans(overlayId: string, options?: CollectOrphansOptions): Promise<OverlayOrphanReport>

  /**
   * §35.7 "Checksum corruption detection" — recompute every stored checksum and
   * report mismatches, classified `repairable` per PRD §14.3.
   */
  verifyChecksums(overlayId: string): Promise<OverlayChecksumReport>
}

/* ------------------------------------------------------------------ *
 * Optional extensions
 * ------------------------------------------------------------------ */

export interface RevalidateOptions {
  /** Recompute stale metadata checksums as part of revalidation; on by default (PRD §14.3 MUST). */
  repairChecksums?: boolean
  /** Restrict to these logical IDs. */
  logicalIds?: readonly string[]
}

export interface OverlayRevalidationFailure {
  kind: OverlayArtifactKind
  ref: string
  logicalId?: string
  code: string
  message: string
  /** Path of the `.broken` diagnostic copy written for this failure (PRD §14.3 SHOULD). */
  brokenCopyRef?: string
}

/** PRD §14.4 direct agent edit workflow, steps 2-7 and 10. */
export interface OverlayRevalidationReport {
  overlayId: string
  ok: boolean
  checked: number
  /** Logical IDs whose canonical file changed since the store last saw it (step 8: `document.changed`). */
  changed: string[]
  /** Refs whose checksum metadata was stale and has been rewritten (PRD §14.3, §29.2). */
  repairedChecksums: string[]
  /** Files that failed parsing or validation and are therefore not served (step 10). */
  invalid: OverlayRevalidationFailure[]
  manifestChanged: boolean
}

export interface RepairChecksumsResult {
  overlayId: string
  repaired: string[]
  /** Content-address violations, which checksum repair must not paper over. */
  unrepairable: OverlayChecksumIssue[]
}

/**
 * Adapters whose canonical state can be edited out from under them — the
 * filesystem, where an agent or a Git merge rewrites `intent.json` directly
 * (PRD §14.3 "Watch ... for direct agent edits", "Revalidate directly edited
 * files before serving them"; §14.4).
 *
 * Exposed as explicit methods rather than a live watcher so the behaviour is
 * directly testable; a watcher is a thin trigger on top of {@link revalidate}.
 */
export interface OverlayDirectEditStore {
  revalidate(overlayId: string, options?: RevalidateOptions): Promise<OverlayRevalidationReport>
  repairChecksums(overlayId: string): Promise<RepairChecksumsResult>
}

export interface ResetOverlayOptions {
  /** PRD §29.8 "Reset all documents after confirmation" — must be `true`. */
  confirm: true
  actor?: OverlayActor
}

export interface OverlayResetResult {
  manifest: OverlayManifest
  removedDocumentIds: string[]
  removedRefs: string[]
}

/** PRD §29.8 reset behaviour. Not part of §35.7, so it is a separate interface. */
export interface OverlayResettableStore {
  resetDocument(
    overlayId: string,
    logicalId: string,
    options?: {actor?: OverlayActor},
  ): Promise<OverlayResetResult>
  resetOverlay(overlayId: string, options: ResetOverlayOptions): Promise<OverlayResetResult>
}

/* ------------------------------------------------------------------ *
 * Adapter-neutral helpers
 * ------------------------------------------------------------------ */

/**
 * Derive the §13.2 document state from a §13.3 record.
 *
 * Order matters: a fully tombstoned document is `deleted` regardless of origin,
 * and a published tombstone that still has a local draft is `unpublished`
 * (PRD §18.6), not `deleted`.
 */
export function deriveDocumentState(record: OverlayDocumentRecord): OverlayDocumentState {
  const {publishedTombstone, draftTombstone, published, draft} = record.local
  if (publishedTombstone && draftTombstone) return 'deleted'
  if (publishedTombstone) return 'unpublished'
  if (record.origin === 'branch') return 'created'
  if (published !== null || draft !== null || draftTombstone) return 'modified'
  return 'unchanged'
}

/**
 * Build the §13.2 head for a record. Shared by every adapter so `state`,
 * `hasDraft`, `hasPublished` and `hasConflict` cannot drift between backends.
 */
export function documentHeadFromRecord(
  record: OverlayDocumentRecord,
  options: {storageRef: string; checksum: string},
): OverlayDocumentHead {
  const head: OverlayDocumentHead = {
    logicalId: record.logicalId,
    schemaType: record.schemaType,
    runtimeRevision: record.runtimeRevision,
    storageRef: options.storageRef,
    checksum: options.checksum,
    updatedAt: record.updatedAt,
    state: deriveDocumentState(record),
    hasDraft: record.local.draft !== null && !record.local.draftTombstone,
    hasPublished: record.local.published !== null && !record.local.publishedTombstone,
    hasConflict: record.conflicts.some((conflict) => conflict.resolution === undefined),
  }
  if (record.updatedBy !== undefined) head.updatedBy = record.updatedBy
  return head
}

/**
 * SHA-256 over the canonical bundle *without* its own `checksum` field.
 *
 * Lives on the contract rather than inside an adapter because it is the identity
 * of the transfer format itself: a bundle exported by one adapter must verify in
 * another (PRD §35.7 "Export canonical state" / "Import canonical state"), which
 * only holds if every adapter computes it the same way.
 */
export function bundleChecksum(bundle: OverlayCanonicalBundle): string {
  const {checksum: _ignored, ...rest} = bundle
  return canonicalChecksum(rest)
}

/**
 * The synthetic `_rev` a materialized document carries (PRD §13.9), re-exported
 * through the contract so adapters agree on how a runtime revision is spelled.
 */
export function runtimeRevisionFor(overlayRevision: number, documentChecksum: string): string {
  return syntheticRev(overlayRevision, documentChecksum)
}

/** Lifecycle states in which the store accepts writes (PRD §12.3 "Writes allowed"). */
export const WRITABLE_STATUSES: readonly OverlayStatus[] = Object.freeze([
  'active',
  'checkpointed',
  'conflicted',
])

/** Lifecycle states in which cleanup and deletion may run (PRD §12.3 "Cleanup allowed", §15.7). */
export const DELETABLE_STATUSES: readonly OverlayStatus[] = Object.freeze([
  'closed',
  'promoted',
  'expired',
])

export type {SanityDocument}
