/**
 * `MemoryOverlayStore` — the in-memory overlay store adapter (PRD §11.1
 * `mode: 'off' | 'fs' | 'blob' | 'memory'`, plan §8.1).
 *
 * `memory` is a **configured runtime mode**, not test scaffolding, so this
 * adapter is held to the identical seventeen PRD §35.7 lines the filesystem and
 * Blob adapters must pass — run through the shared contract runner with no
 * adapter-specific relaxations (plan §8.2, quality target PRD §5.5 "100 percent
 * pass rate for store contract tests").
 *
 * ## Storage model
 *
 * All state lives in one flat {@link MemoryOverlayStorage} map of
 * `ref → canonical JSON text`. Nothing is cached as a parsed object beside it:
 * every read parses from the map and every write serializes into it, so the
 * store cannot serve state that diverges from its own bytes — which is what
 * makes the §35.7 "Checksum corruption detection" line meaningful here (the
 * suite corrupts bytes through the raw hooks and expects the store to notice).
 *
 * Ref strings mirror the PRD §14.1 filesystem layout *verbatim*
 * (`documents/<encoded-id>/intent.json`, `snapshots/<sha256>.json`,
 * `.runtime/revisions/<encoded-id>/<sha256>.json`, …). They are opaque keys
 * here, not paths, but keeping them byte-identical to the fs adapter means a
 * canonical bundle exported by one adapter imports into the other with its
 * `storageRef`s still resolving (PRD §35.7 export/import). The `.runtime/`
 * segment carries no meaning in memory beyond that portability.
 *
 * ## Commit model
 *
 * The manifest is the commit point, exactly as on the filesystem: immutable
 * content-addressed artifacts (base snapshots, document revisions, transaction
 * records) are written first and are unreachable until a manifest head names
 * them; replacing the manifest publishes the whole set at once (PRD §15.3,
 * §34.5). Regenerable projections (`intent.json`) are written last.
 *
 * The materialized-document projection the fs adapter writes under
 * `.runtime/materialized/` is deliberately absent: it exists so external tools
 * and a Git working tree can read a resolved document without the merge engine
 * (PRD §14.1, §14.2), and an in-process caller reads
 * `record.local.draft.materialized` directly. No §35.7 line observes it.
 *
 * ## Determinism
 *
 * The clock and the transaction-ID source are injected (plan §8.1 "injectable
 * clock and ID source so every test is deterministic"); the store never reads a
 * wall clock and never generates randomness. Two stores driven through the same
 * calls therefore export byte-identical bundles (PRD §34.17).
 */
import {checksum as canonicalChecksum, overlayIdFromIdentityInput} from '../checksum'
import {encodeLogicalId, isEncodedLogicalId, toPublishedId} from '../encoding'
import {canonicalize, parse, serialize} from '../serialize'
import {OVERLAY_FORMAT_VERSION} from '../types/index'
import {assertFormatVersion} from '../version'
import {
  DELETABLE_STATUSES,
  WRITABLE_STATUSES,
  bundleChecksum,
  defaultRetentionDays,
  documentHeadFromRecord,
} from './contract'
import {
  OverlayAlreadyExistsError,
  OverlayChecksumMismatchError,
  OverlayClosedError,
  OverlayDocumentRevisionConflictError,
  OverlayIdentityMismatchError,
  OverlayInvalidRequestError,
  OverlayNotFoundError,
  OverlayPathEscapeError,
  OverlayRetentionActiveError,
  OverlayStoreCorruptError,
  OverlayWriteConflictError,
} from './errors'
import {assertGenuineStoreReplay} from './replay'
import {baseSnapshotFrom, intentChecksum, intentFromRecord} from './intent'
import type {CheckpointDocumentIntent, OverlayBaseSnapshot} from './intent'
import type {
  CollectOrphansOptions,
  CreateOverlayInput,
  DeleteOverlayOptions,
  DeleteOverlayResult,
  ExportCanonicalOptions,
  ImportCanonicalOptions,
  ImportCanonicalResult,
  ListChangedDocumentsOptions,
  MarkClosedOptions,
  OverlayCanonicalBundle,
  OverlayCanonicalBundleDocument,
  OverlayChecksumIssue,
  OverlayChecksumReport,
  OverlayClock,
  OverlayCommitRequest,
  OverlayCommitResult,
  OverlayDocumentReadResult,
  OverlayDocumentWriteResult,
  OverlayOrphanRef,
  OverlayOrphanReport,
  OverlayPromotionInput,
  OverlayRetentionPolicy,
  OverlayStore,
  OverlayTransactionSelector,
  PutDocumentRevisionOptions,
  WriteManifestOptions,
} from './contract'
import type {
  OverlayDocumentHead,
  OverlayDocumentRecord,
  OverlayManifest,
  OverlayStatus,
  OverlayTransactionRecord,
} from '../types/index'

/* ------------------------------------------------------------------ *
 * Layout constants — PRD §14.1, mirrored so refs stay adapter-portable
 * ------------------------------------------------------------------ */

const MANIFEST_REF = 'manifest.json'
const DOCUMENTS_PREFIX = 'documents/'
const INTENT_FILE = 'intent.json'
const SNAPSHOTS_PREFIX = 'snapshots/'
const REVISIONS_PREFIX = '.runtime/revisions/'
const TRANSACTIONS_PREFIX = '.runtime/transactions/'
const IDEMPOTENCY_PREFIX = '.runtime/indexes/idempotency/'
const JSON_SUFFIX = '.json'

/**
 * A ref segment that can never traverse or collide: non-empty, no separator, no
 * relative component, no NUL. Refs are map keys rather than paths here, so this
 * is defence in depth against a caller-supplied `storageRef` or transaction ID
 * (PRD §35.9 "Path traversal attempts fail") rather than a filesystem guard.
 */
function assertSafeComponent(component: string, kind: string): string {
  if (
    typeof component !== 'string' ||
    component.length === 0 ||
    component === '.' ||
    component === '..' ||
    component.includes('/') ||
    component.includes('\\') ||
    component.includes('\0')
  ) {
    throw new OverlayPathEscapeError(String(component), kind, {kind})
  }
  return component
}

/**
 * Storage key for a logical document ID.
 *
 * `drafts.` prefixes normalize away first: draft and published state of one
 * logical document share a record (PRD §13.3), so `drafts.article` and `article`
 * must land under the same key (§35.9 "File path encoding handles IDs with dots
 * and draft prefixes").
 */
function documentKey(logicalId: string): string {
  const encoded = encodeLogicalId(toPublishedId(logicalId))
  assertSafeComponent(encoded, 'document key')
  /* istanbul ignore next -- defence in depth against an encoder regression. */
  if (!isEncodedLogicalId(encoded)) {
    throw new OverlayPathEscapeError(encoded, 'document key', {logicalId})
  }
  return encoded
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * The addressable byte store behind {@link MemoryOverlayStore}.
 *
 * Separate from the store so it can be supplied from outside and inspected or
 * corrupted directly — the same role the filesystem plays for `FsOverlayStore`,
 * and what the §35.7 "Checksum corruption detection" line needs in order to
 * write bad bytes without going through the store's own front door.
 */
export class MemoryOverlayStorage {
  readonly #entries = new Map<string, string>()

  /** Stored bytes at `ref`, or `null` when nothing is stored there. */
  read(ref: string): string | null {
    return this.#entries.get(this.#assertRef(ref)) ?? null
  }

  write(ref: string, contents: string): void {
    if (typeof contents !== 'string') {
      throw new OverlayInvalidRequestError('MemoryOverlayStorage stores text, not objects', {ref})
    }
    this.#entries.set(this.#assertRef(ref), contents)
  }

  /** Remove `ref`; returns whether anything was stored there. */
  delete(ref: string): boolean {
    return this.#entries.delete(this.#assertRef(ref))
  }

  has(ref: string): boolean {
    return this.#entries.has(this.#assertRef(ref))
  }

  /** Every stored ref (optionally under `prefix`), ascending by code unit. */
  refs(prefix = ''): string[] {
    const found: string[] = []
    for (const ref of this.#entries.keys()) if (ref.startsWith(prefix)) found.push(ref)
    return found.sort()
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }

  #assertRef(ref: string): string {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new OverlayInvalidRequestError('A storage ref must be a non-empty string', {ref})
    }
    return ref
  }
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

/** Ref construction for one overlay, mirroring the PRD §14.1 filesystem layout. */
export class MemoryOverlayLayout {
  readonly manifestRef = MANIFEST_REF
  readonly documentsPrefix = DOCUMENTS_PREFIX
  readonly snapshotsPrefix = SNAPSHOTS_PREFIX
  readonly revisionsPrefix = REVISIONS_PREFIX
  readonly transactionsPrefix = TRANSACTIONS_PREFIX
  readonly idempotencyPrefix = IDEMPOTENCY_PREFIX

  documentKey(logicalId: string): string {
    return documentKey(logicalId)
  }

  /** Ref of a document's canonical review-facing intent (PRD §14.2). */
  intentRef(logicalId: string): string {
    return `${DOCUMENTS_PREFIX}${documentKey(logicalId)}/${INTENT_FILE}`
  }

  /** Ref of a content-addressed base capture (PRD §14.1, §14.3). */
  snapshotRef(contentAddress: string): string {
    assertSafeComponent(contentAddress, 'snapshot ref')
    return `${SNAPSHOTS_PREFIX}${contentAddress}${JSON_SUFFIX}`
  }

  /** Ref of one immutable document revision, addressed by its own checksum. */
  revisionRef(logicalId: string, revisionChecksum: string): string {
    assertSafeComponent(revisionChecksum, 'revision checksum')
    return `${REVISIONS_PREFIX}${documentKey(logicalId)}/${revisionChecksum}${JSON_SUFFIX}`
  }

  /** Prefix under which every revision of one logical document is stored. */
  revisionPrefix(logicalId: string): string {
    return `${REVISIONS_PREFIX}${documentKey(logicalId)}/`
  }

  transactionRef(transactionId: string): string {
    assertSafeComponent(transactionId, 'transaction id')
    return `${TRANSACTIONS_PREFIX}${transactionId}${JSON_SUFFIX}`
  }

  idempotencyRef(idempotencyKey: string): string {
    const key = encodeLogicalId(idempotencyKey)
    assertSafeComponent(key, 'idempotency key')
    return `${IDEMPOTENCY_PREFIX}${key}${JSON_SUFFIX}`
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export interface MemoryOverlayStoreOptions {
  /** Injected clock returning an ISO-8601 timestamp. Required (plan §8.1). */
  now: OverlayClock
  /** Byte store to hold state in. Defaults to a fresh, private one. */
  storage?: MemoryOverlayStorage
  /**
   * Transaction ID factory. Must be unique within the overlay and
   * lexicographically ordered by commit time (PRD §13.10 MUST). Defaults to
   * {@link defaultOverlayTransactionId}, which derives one from the injected
   * clock plus a per-store sequence and is therefore deterministic.
   */
  newTransactionId?: (context: {overlayId: string; timestamp: string; sequence: number}) => string
}

/** Soft read result: distinguishes "absent" from "present but unparseable". */
interface SoftRead<T> {
  missing: boolean
  ok: boolean
  raw?: string
  value?: T
  error?: string
}

interface ImmutableWrite {
  logicalId: string
  record: OverlayDocumentRecord
  storageRef: string
  checksum: string
  snapshotRef?: string
  head: OverlayDocumentHead
}

export class MemoryOverlayStore implements OverlayStore {
  readonly storage: MemoryOverlayStorage
  readonly layout: MemoryOverlayLayout

  readonly #now: OverlayClock
  readonly #newTransactionId: NonNullable<MemoryOverlayStoreOptions['newTransactionId']>
  #sequence = 0

  constructor(options: MemoryOverlayStoreOptions) {
    if (typeof options?.now !== 'function') {
      throw new OverlayInvalidRequestError('MemoryOverlayStore requires an injected `now` clock')
    }
    this.storage = options.storage ?? new MemoryOverlayStorage()
    this.layout = new MemoryOverlayLayout()
    this.#now = options.now
    this.#newTransactionId = options.newTransactionId ?? defaultOverlayTransactionId
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Create overlay"
   * ---------------------------------------------------------------- */

  async createOverlay(input: CreateOverlayInput): Promise<OverlayManifest> {
    const existing = this.#readManifestEntry()
    if (!existing.missing) {
      if (input.ifNotExists === true && existing.value !== undefined) {
        return clone(existing.value)
      }
      throw new OverlayAlreadyExistsError(existing.value?.overlayId ?? '<unreadable>')
    }

    const overlayId =
      input.overlayId ??
      (input.identity === undefined ? undefined : overlayIdFromIdentityInput(input.identity))
    if (typeof overlayId !== 'string' || overlayId.length === 0) {
      throw new OverlayInvalidRequestError(
        'createOverlay requires `overlayId` or `identity` to derive one (PRD §12.1)',
      )
    }

    const timestamp = this.#now()
    const manifest: OverlayManifest = {
      formatVersion: OVERLAY_FORMAT_VERSION,
      overlayId,
      status: input.status ?? 'active',
      base: {...input.base},
      source: {...input.source},
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      documentHeads: {},
      conflictSummary: {total: 0, hard: 0, soft: 0},
    }
    if (input.actor !== undefined) {
      manifest.createdBy = input.actor
      manifest.updatedBy = input.actor
    }
    if (input.expiresAt !== undefined) manifest.expiresAt = input.expiresAt

    this.#writeManifest(manifest)
    return clone(manifest)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Read empty overlay"
   * ---------------------------------------------------------------- */

  async readManifest(overlayId: string): Promise<OverlayManifest> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    return clone(manifest)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Conditional manifest write" / "Concurrent stale write rejection"
   * ---------------------------------------------------------------- */

  async writeManifestConditional(
    overlayId: string,
    next: OverlayManifest,
    expectedRevision: number,
    options: WriteManifestOptions = {},
  ): Promise<OverlayManifest> {
    const current = this.#loadManifest()
    this.#assertIdentity(overlayId, current)

    if (current.revision !== expectedRevision) {
      throw new OverlayWriteConflictError(overlayId, expectedRevision, current.revision)
    }
    if (next.overlayId !== current.overlayId) {
      throw new OverlayIdentityMismatchError(next.overlayId, current.overlayId)
    }
    if (next.revision !== expectedRevision + 1) {
      throw new OverlayInvalidRequestError(
        `A conditional manifest write is the overlay's revision increment (PRD §34.5): expected revision ${
          expectedRevision + 1
        }, received ${next.revision}`,
        {expectedRevision, receivedRevision: next.revision},
      )
    }

    const written: OverlayManifest = {...clone(next), updatedAt: this.#now()}
    if (options.actor !== undefined) written.updatedBy = options.actor
    this.#writeManifest(written)
    return clone(written)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Store and read document revision"
   * ---------------------------------------------------------------- */

  async putDocumentRevision(
    overlayId: string,
    record: OverlayDocumentRecord,
    options: PutDocumentRevisionOptions = {},
  ): Promise<OverlayDocumentWriteResult> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    this.#assertWritable(manifest)

    if (
      options.expectedOverlayRevision !== undefined &&
      manifest.revision !== options.expectedOverlayRevision
    ) {
      throw new OverlayWriteConflictError(
        overlayId,
        options.expectedOverlayRevision,
        manifest.revision,
      )
    }

    const logicalId = toPublishedId(record.logicalId)
    if (options.expectedDocumentRevision !== undefined) {
      const actual = manifest.documentHeads[logicalId]?.runtimeRevision ?? null
      if (actual !== options.expectedDocumentRevision) {
        throw new OverlayDocumentRevisionConflictError(
          logicalId,
          options.expectedDocumentRevision,
          actual,
        )
      }
    }

    /* Step 1 — immutable artifacts, unreachable until a head names them. */
    const write = this.#writeImmutable(overlayId, record)

    /* Step 2 — the commit point. */
    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    next.documentHeads = {...manifest.documentHeads, [logicalId]: write.head}
    if (options.actor !== undefined) next.updatedBy = options.actor
    next.conflictSummary = this.#conflictSummary(next.documentHeads, [write.record])
    this.#writeManifest(next)

    /* Step 3 — regenerable projections. */
    this.#writeIntent(write)

    const result: OverlayDocumentWriteResult = {
      head: clone(write.head),
      manifest: clone(next),
      storageRef: write.storageRef,
      checksum: write.checksum,
    }
    if (write.snapshotRef !== undefined) result.snapshotRef = write.snapshotRef
    return result
  }

  async getDocumentRevision(
    overlayId: string,
    storageRef: string,
  ): Promise<OverlayDocumentRecord | null> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    return this.#readRecordByRef(storageRef)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Commit multi-document transaction" / "Idempotent transaction replay"
   * ---------------------------------------------------------------- */

  async commitTransaction(
    overlayId: string,
    request: OverlayCommitRequest,
  ): Promise<OverlayCommitResult> {
    if (typeof request?.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
      throw new OverlayInvalidRequestError(
        'commitTransaction requires a non-empty idempotencyKey (PRD §13.10, §34.6)',
      )
    }
    if (!Array.isArray(request.records)) {
      throw new OverlayInvalidRequestError('commitTransaction requires a `records` array')
    }
    if (request.actor === undefined) {
      throw new OverlayInvalidRequestError('commitTransaction requires an actor (PRD §13.10)')
    }

    /* §34.6 — one idempotency key maps to one immutable transaction result. The
     * replay is resolved before any precondition, so a retry of a committed
     * transaction can never be rejected by a precondition it already satisfied. */
    const replayed = await this.getTransaction(overlayId, {
      idempotencyKey: request.idempotencyKey,
    })
    if (replayed !== null) {
      /* …but a replay must be a replay OF THIS REQUEST. See `store/replay.ts`. */
      assertGenuineStoreReplay(request, replayed)
      const current = this.#loadManifest()
      return {
        transaction: replayed,
        manifest: clone(current),
        heads: replayed.affectedDocumentIds
          .map((id) => current.documentHeads[toPublishedId(id)])
          .filter((head): head is OverlayDocumentHead => head !== undefined)
          .map(clone),
        replayed: true,
      }
    }

    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    this.#assertWritable(manifest)

    if (
      request.expectedOverlayRevision !== undefined &&
      manifest.revision !== request.expectedOverlayRevision
    ) {
      throw new OverlayWriteConflictError(
        overlayId,
        request.expectedOverlayRevision,
        manifest.revision,
      )
    }
    for (const [documentId, expected] of Object.entries(request.expectedDocumentRevisions ?? {})) {
      const actual = manifest.documentHeads[toPublishedId(documentId)]?.runtimeRevision ?? null
      if (actual !== expected) {
        throw new OverlayDocumentRevisionConflictError(toPublishedId(documentId), expected, actual)
      }
    }

    const removed = (request.removedDocumentIds ?? []).map(toPublishedId)

    /* Step 1 — immutable artifacts. */
    const writes = request.records.map((record) => this.#writeImmutable(overlayId, record))

    /* Step 2 — the immutable transaction record (PRD §13.10). */
    const revisionBefore = manifest.revision
    const revisionAfter = revisionBefore + 1
    const committedAt = this.#now()
    const transactionId = this.#allocateTransactionId(overlayId, committedAt)

    const affected = [...new Set([...writes.map((write) => write.logicalId), ...removed])].sort()
    const resultChecksums: Record<string, string> = {}
    for (const write of writes) resultChecksums[write.logicalId] = write.checksum

    const transaction: OverlayTransactionRecord = {
      formatVersion: OVERLAY_FORMAT_VERSION,
      transactionId,
      overlayId,
      overlayRevisionBefore: revisionBefore,
      overlayRevisionAfter: revisionAfter,
      actor: request.actor,
      requestedAt: request.requestedAt ?? committedAt,
      committedAt,
      mutations: request.mutations ?? [],
      affectedDocumentIds: affected,
      resultChecksums,
      idempotencyKey: request.idempotencyKey,
    }
    if (request.requestId !== undefined) transaction.requestId = request.requestId
    this.#writeJson(this.layout.transactionRef(transactionId), transaction)

    /* Step 3 — the commit point. One manifest replacement publishes every artifact. */
    const next = clone(manifest)
    next.revision = revisionAfter
    next.updatedAt = committedAt
    next.updatedBy = request.actor
    next.transactionHead = transactionId
    const heads = {...manifest.documentHeads}
    for (const write of writes) heads[write.logicalId] = write.head
    for (const id of removed) delete heads[id]
    next.documentHeads = heads
    next.conflictSummary = this.#conflictSummary(
      heads,
      writes.map((write) => write.record),
    )
    this.#writeManifest(next)

    /* Step 4 — the idempotency pointer, written after the commit so it can never
     * name an uncommitted transaction. */
    this.#writeJson(this.layout.idempotencyRef(request.idempotencyKey), {
      formatVersion: OVERLAY_FORMAT_VERSION,
      idempotencyKey: request.idempotencyKey,
      transactionId,
      committedAt,
    })

    /* Step 5 — regenerable projections. */
    for (const write of writes) this.#writeIntent(write)
    for (const id of removed) this.#removeDocumentArtifacts(id)

    return {
      transaction: clone(transaction),
      manifest: clone(next),
      heads: writes.map((write) => clone(write.head)),
      replayed: false,
    }
  }

  async getTransaction(
    overlayId: string,
    selector: OverlayTransactionSelector,
  ): Promise<OverlayTransactionRecord | null> {
    let transactionId: string
    if ('transactionId' in selector) {
      transactionId = selector.transactionId
    } else {
      const pointer = this.#readJsonSoft<{transactionId?: unknown}>(
        this.layout.idempotencyRef(selector.idempotencyKey),
      )
      if (pointer.missing || typeof pointer.value?.transactionId !== 'string') return null
      transactionId = pointer.value.transactionId
    }

    const ref = this.layout.transactionRef(transactionId)
    const read = this.#readJsonSoft<OverlayTransactionRecord>(ref)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(ref, read.error ?? 'unreadable transaction record')
    }
    assertFormatVersion(read.value.formatVersion)
    if (read.value.overlayId !== overlayId) {
      throw new OverlayIdentityMismatchError(overlayId, read.value.overlayId)
    }
    return read.value
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "List changed documents" / "Read by logical ID"
   * ---------------------------------------------------------------- */

  async listChangedDocuments(
    overlayId: string,
    options: ListChangedDocumentsOptions = {},
  ): Promise<OverlayDocumentHead[]> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    return Object.values(manifest.documentHeads)
      .filter((head) => {
        if (options.states !== undefined) return options.states.includes(head.state)
        return options.includeUnchanged === true || head.state !== 'unchanged'
      })
      .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0))
      .map(clone)
  }

  async readDocumentByLogicalId(
    overlayId: string,
    logicalId: string,
  ): Promise<OverlayDocumentReadResult | null> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const normalized = toPublishedId(logicalId)
    const head = manifest.documentHeads[normalized]
    if (head === undefined) return null

    const intent = this.#readIntent(normalized)
    const snapshotRef = intent?.base.snapshotRef
    const baseSnapshot = snapshotRef === undefined ? null : this.#readSnapshot(snapshotRef)

    return {
      head: clone(head),
      record: this.#readRecordByRef(head.storageRef),
      intent: intent === null ? null : clone(intent),
      baseSnapshot,
      storageRef: head.storageRef,
    }
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Export canonical state" / "Import canonical state"
   * ---------------------------------------------------------------- */

  async exportCanonical(
    overlayId: string,
    options: ExportCanonicalOptions = {},
  ): Promise<OverlayCanonicalBundle> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const documents: OverlayCanonicalBundleDocument[] = []
    const snapshots: Record<string, OverlayBaseSnapshot> = {}

    for (const logicalId of Object.keys(manifest.documentHeads).sort()) {
      const head = manifest.documentHeads[logicalId]!
      const intent = this.#readIntent(logicalId)
      if (intent === null) {
        throw new OverlayStoreCorruptError(
          this.layout.intentRef(logicalId),
          'manifest head has no readable intent (PRD §34.3)',
        )
      }
      documents.push({
        intent: clone(intent),
        record: this.#readRecordByRef(head.storageRef),
        storageRef: head.storageRef,
      })
      const ref = intent.base.snapshotRef
      if (ref !== undefined && snapshots[ref] === undefined) {
        const snapshot = this.#readSnapshot(ref)
        if (snapshot === null) {
          throw new OverlayStoreCorruptError(
            this.layout.snapshotRef(ref),
            'intent references a base snapshot that is not stored',
          )
        }
        snapshots[ref] = snapshot
      }
    }

    const bundle: OverlayCanonicalBundle = {
      formatVersion: OVERLAY_FORMAT_VERSION,
      overlayId,
      exportedAt: this.#now(),
      manifest: clone(manifest),
      documents,
      snapshots,
      transactions: options.includeTransactions === false ? [] : this.#readAllTransactions(),
      checksum: '',
    }
    bundle.checksum = bundleChecksum(bundle)
    return bundle
  }

  async importCanonical(
    bundle: OverlayCanonicalBundle,
    options: ImportCanonicalOptions = {},
  ): Promise<ImportCanonicalResult> {
    assertFormatVersion(bundle?.formatVersion)

    /* §34.4 — verified before a single byte is written, so a tampered bundle
     * cannot half-land. */
    if (options.verifyChecksum !== false) {
      const actual = bundleChecksum(bundle)
      if (actual !== bundle.checksum) {
        throw new OverlayChecksumMismatchError(
          `bundle:${bundle.overlayId}`,
          bundle.checksum,
          actual,
          {repairable: false},
        )
      }
    }

    const existing = this.#readManifestEntry()
    if (!existing.missing) {
      if (options.overwrite !== true) {
        throw new OverlayAlreadyExistsError(existing.value?.overlayId ?? '<unreadable>', {
          hint: 'pass {overwrite: true} to replace the stored overlay (PRD §29.7)',
        })
      }
      this.storage.clear()
    }

    for (const [ref, snapshot] of Object.entries(bundle.snapshots)) {
      this.#writeJson(this.layout.snapshotRef(ref), snapshot)
    }

    for (const document of bundle.documents) {
      const logicalId = toPublishedId(document.intent.logicalId)
      this.#writeJson(this.layout.intentRef(logicalId), document.intent)
      if (document.record !== null) {
        /* The revision ref is *derived*, never taken from the bundle: a
         * content-addressed artifact is addressed by its own bytes. */
        const recordChecksum = canonicalChecksum(document.record)
        this.#writeJson(this.layout.revisionRef(logicalId, recordChecksum), document.record)
      }
    }

    for (const transaction of bundle.transactions) {
      this.#writeJson(this.layout.transactionRef(transaction.transactionId), transaction)
      this.#writeJson(this.layout.idempotencyRef(transaction.idempotencyKey), {
        formatVersion: OVERLAY_FORMAT_VERSION,
        idempotencyKey: transaction.idempotencyKey,
        transactionId: transaction.transactionId,
        committedAt: transaction.committedAt,
      })
    }

    this.#writeManifest(clone(bundle.manifest))

    return {
      manifest: clone(bundle.manifest),
      importedDocuments: bundle.documents.length,
      importedSnapshots: Object.keys(bundle.snapshots).length,
      importedTransactions: bundle.transactions.length,
    }
  }

  /* ---------------------------------------------------------------- *
   * §35.7 lifecycle: "Mark closed" / "Mark promoted" / "Retention metadata" /
   * "Delete overlay"
   * ---------------------------------------------------------------- */

  async markClosed(overlayId: string, options: MarkClosedOptions = {}): Promise<OverlayManifest> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const next = clone(manifest)
    next.status = 'closed'
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    if (options.actor !== undefined) next.updatedBy = options.actor

    applyRetention(
      next,
      options.retention ?? {ttlDays: defaultRetentionDays(next) ?? undefined},
    )

    this.#writeManifest(next)
    return clone(next)
  }

  async markPromoted(
    overlayId: string,
    promotion: OverlayPromotionInput,
  ): Promise<OverlayManifest> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    /* PRD §12.3: the only edge into `promoted` starts at `closed`. */
    if (manifest.status !== 'closed' && manifest.status !== 'promoted') {
      throw new OverlayInvalidRequestError(
        `Overlay ${JSON.stringify(overlayId)} must be closed before promotion, current status is ${manifest.status} (PRD §12.3)`,
        {overlayId, status: manifest.status},
      )
    }

    const next = clone(manifest)
    next.status = 'promoted'
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    if (promotion.actor !== undefined) next.updatedBy = promotion.actor

    const block: NonNullable<OverlayManifest['promotion']> = {}
    if (promotion.planId !== undefined) block.planId = promotion.planId
    if (promotion.targetDataset !== undefined) block.targetDataset = promotion.targetDataset
    block.promotedAt = promotion.promotedAt ?? next.updatedAt
    if (promotion.resultingTransactionId !== undefined) {
      block.resultingTransactionId = promotion.resultingTransactionId
    }
    next.promotion = block

    applyRetention(
      next,
      promotion.retention ?? {ttlDays: defaultRetentionDays(next) ?? undefined},
    )

    this.#writeManifest(next)
    return clone(next)
  }

  async setRetention(
    overlayId: string,
    retention: OverlayRetentionPolicy,
  ): Promise<OverlayManifest> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    applyRetention(next, retention)

    this.#writeManifest(next)
    return clone(next)
  }

  async deleteOverlay(
    overlayId: string,
    options: DeleteOverlayOptions = {},
  ): Promise<DeleteOverlayResult> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    if (options.force !== true) {
      /* PRD §15.7 "Mark overlay closed before deletion". */
      if (!DELETABLE_STATUSES.includes(manifest.status)) {
        throw new OverlayRetentionActiveError(
          overlayId,
          `overlay must be closed, promoted or expired before deletion, current status is ${manifest.status}`,
          {status: manifest.status},
        )
      }
      /* PRD §15.7 "Never delete an overlay with an active promotion". */
      if (manifest.promotion !== undefined && manifest.promotion.promotedAt === undefined) {
        throw new OverlayRetentionActiveError(overlayId, 'a promotion is in flight', {
          promotion: manifest.promotion,
        })
      }
    }

    const removedRefs = this.storage.refs()
    this.storage.clear()
    return {overlayId, deleted: true, removedRefs}
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Orphan revision cleanup"
   * ---------------------------------------------------------------- */

  async collectOrphans(
    overlayId: string,
    options: CollectOrphansOptions = {},
  ): Promise<OverlayOrphanReport> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const heads = Object.values(manifest.documentHeads)
    const reachableRevisions = new Set(heads.map((head) => head.storageRef))
    const reachableIntents = new Set(heads.map((head) => this.layout.intentRef(head.logicalId)))
    const reachableSnapshots = new Set<string>()
    for (const head of heads) {
      const ref = this.#readIntent(head.logicalId)?.base.snapshotRef
      if (ref !== undefined) reachableSnapshots.add(ref)
    }

    const orphans: OverlayOrphanRef[] = []
    let scanned = 0

    /* Immutable document revisions — the §34.8 "orphan revision" case proper. */
    for (const ref of this.storage.refs(REVISIONS_PREFIX)) {
      scanned += 1
      if (reachableRevisions.has(ref)) continue
      orphans.push({
        kind: 'revision',
        ref,
        reason: 'no manifest head references this revision',
      })
    }

    if (options.includeSnapshots !== false) {
      for (const ref of this.storage.refs(SNAPSHOTS_PREFIX)) {
        scanned += 1
        const address = ref.slice(SNAPSHOTS_PREFIX.length, -JSON_SUFFIX.length)
        if (reachableSnapshots.has(address)) continue
        orphans.push({
          kind: 'snapshot',
          ref,
          reason: 'no intent references this base snapshot',
        })
      }
    }

    if (options.includeDocuments !== false) {
      for (const ref of this.storage.refs(DOCUMENTS_PREFIX)) {
        scanned += 1
        if (reachableIntents.has(ref)) continue
        orphans.push({
          kind: 'document',
          ref,
          reason: 'no manifest head references this document',
        })
      }
    }

    const deleted: OverlayOrphanRef[] = []
    const failures: Array<{ref: string; reason: string}> = []
    if (options.dryRun !== true) {
      for (const orphan of orphans) {
        try {
          this.storage.delete(orphan.ref)
          deleted.push(orphan)
        } catch (error) {
          /* istanbul ignore next -- a Map delete only throws on an invalid ref. */
          failures.push({ref: orphan.ref, reason: (error as Error).message})
        }
      }
    }

    return {overlayId, dryRun: options.dryRun === true, scanned, orphans, deleted, failures}
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Checksum corruption detection"
   * ---------------------------------------------------------------- */

  async verifyChecksums(overlayId: string): Promise<OverlayChecksumReport> {
    const manifest = this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const issues: OverlayChecksumIssue[] = []
    const missing: OverlayOrphanRef[] = []
    let checked = 0

    for (const logicalId of Object.keys(manifest.documentHeads).sort()) {
      const head = manifest.documentHeads[logicalId]!

      /* Content-addressed revision: the stored bytes must hash to the head's checksum. */
      const revision = this.#readJsonSoft<OverlayDocumentRecord>(head.storageRef)
      let revisionPresent = false
      if (!revision.missing) {
        revisionPresent = true
        checked += 1
        const actual =
          revision.ok && revision.value !== undefined
            ? canonicalChecksum(revision.value)
            : '<unparseable>'
        if (actual !== head.checksum) {
          issues.push({
            kind: 'revision',
            ref: head.storageRef,
            logicalId,
            expected: head.checksum,
            actual,
            repairable: false,
          })
        }
      }

      /* Review-facing intent: a stale checksum here is repairable metadata (§14.3). */
      const intentRef = this.layout.intentRef(logicalId)
      const intentRead = this.#readJsonSoft<CheckpointDocumentIntent>(intentRef)
      if (!intentRead.missing) {
        checked += 1
        if (!intentRead.ok || intentRead.value === undefined) {
          issues.push({
            kind: 'intent',
            ref: intentRef,
            logicalId,
            expected: head.checksum,
            actual: '<unparseable>',
            repairable: false,
          })
        } else {
          const actual = intentChecksum(intentRead.value)
          if (actual !== intentRead.value.checksum) {
            issues.push({
              kind: 'intent',
              ref: intentRef,
              logicalId,
              expected: intentRead.value.checksum,
              actual,
              repairable: true,
            })
          }
        }
      } else if (!revisionPresent) {
        /* §34.3 — a head must reach an immutable revision *or* a valid canonical
         * record. Both are gone. */
        missing.push({
          kind: 'manifest-head',
          ref: head.storageRef,
          logicalId,
          reason: 'neither the immutable revision nor the canonical intent exists',
        })
      }
    }

    /* Content-addressed base snapshots: the address *is* the identity, so a
     * mismatch is corruption, never repairable metadata. */
    for (const ref of this.storage.refs(SNAPSHOTS_PREFIX)) {
      checked += 1
      const address = ref.slice(SNAPSHOTS_PREFIX.length, -JSON_SUFFIX.length)
      const read = this.#readJsonSoft<OverlayBaseSnapshot>(ref)
      const actual =
        read.ok && read.value !== undefined ? canonicalChecksum(read.value) : '<unparseable>'
      if (actual !== address) {
        issues.push({kind: 'snapshot', ref: address, expected: address, actual, repairable: false})
      }
    }

    return {
      overlayId,
      ok: issues.length === 0 && missing.length === 0,
      checked,
      issues,
      missing,
    }
  }

  /* ================================================================ *
   * Internals
   * ================================================================ */

  #assertIdentity(requested: string, manifest: OverlayManifest): void {
    if (manifest.overlayId !== requested) {
      throw new OverlayIdentityMismatchError(requested, manifest.overlayId)
    }
  }

  #assertWritable(manifest: OverlayManifest): void {
    if (!WRITABLE_STATUSES.includes(manifest.status as OverlayStatus)) {
      throw new OverlayClosedError(manifest.overlayId, manifest.status)
    }
  }

  #readJsonSoft<T>(ref: string): SoftRead<T> {
    const raw = this.storage.read(ref)
    if (raw === null) return {missing: true, ok: false}
    try {
      return {missing: false, ok: true, raw, value: parse(raw) as T}
    } catch (error) {
      return {missing: false, ok: false, raw, error: (error as Error).message}
    }
  }

  #writeJson(ref: string, value: unknown): void {
    this.storage.write(ref, serialize(value))
  }

  #writeManifest(manifest: OverlayManifest): void {
    this.#writeJson(this.layout.manifestRef, manifest)
  }

  #readManifestEntry(): SoftRead<OverlayManifest> {
    const read = this.#readJsonSoft<OverlayManifest>(this.layout.manifestRef)
    if (read.missing || !read.ok || read.value === undefined) return read
    const problem = validateManifestShape(read.value)
    if (problem !== null) return {missing: false, ok: false, raw: read.raw, error: problem}
    return read
  }

  #loadManifest(): OverlayManifest {
    const read = this.#readManifestEntry()
    if (read.missing) {
      throw new OverlayNotFoundError('Overlay manifest', {ref: this.layout.manifestRef})
    }
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(
        this.layout.manifestRef,
        read.error ?? 'manifest is not valid overlay state',
      )
    }
    return read.value
  }

  #readIntent(logicalId: string): CheckpointDocumentIntent | null {
    const read = this.#readJsonSoft<CheckpointDocumentIntent>(this.layout.intentRef(logicalId))
    if (read.missing || !read.ok || read.value === undefined) return null
    assertFormatVersion(read.value.formatVersion)
    return read.value
  }

  #readSnapshot(contentAddress: string): OverlayBaseSnapshot | null {
    const ref = this.layout.snapshotRef(contentAddress)
    const read = this.#readJsonSoft<OverlayBaseSnapshot>(ref)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(ref, read.error ?? 'snapshot is not valid JSON')
    }
    return read.value
  }

  #readRecordByRef(storageRef: string): OverlayDocumentRecord | null {
    if (typeof storageRef !== 'string' || storageRef.length === 0) {
      throw new OverlayInvalidRequestError('storageRef must be a non-empty string', {storageRef})
    }
    const read = this.#readJsonSoft<OverlayDocumentRecord>(storageRef)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(
        storageRef,
        read.error ?? 'document revision is not valid JSON',
      )
    }
    assertFormatVersion(read.value.formatVersion)
    return read.value
  }

  #readAllTransactions(): OverlayTransactionRecord[] {
    const transactions: OverlayTransactionRecord[] = []
    for (const ref of this.storage.refs(TRANSACTIONS_PREFIX)) {
      const read = this.#readJsonSoft<OverlayTransactionRecord>(ref)
      if (read.ok && read.value !== undefined) transactions.push(read.value)
    }
    return transactions.sort((a, b) =>
      a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
    )
  }

  /**
   * Write the immutable artifacts for one record and derive its head.
   *
   * Nothing here is reachable until a manifest head names the returned
   * `storageRef`, which is what makes the manifest write the commit point.
   */
  #writeImmutable(overlayId: string, record: OverlayDocumentRecord): ImmutableWrite {
    if (typeof record?.logicalId !== 'string' || record.logicalId.length === 0) {
      throw new OverlayInvalidRequestError('Document record requires a logicalId (PRD §13.3)')
    }
    assertFormatVersion(record.formatVersion)
    if (record.overlayId !== overlayId) {
      throw new OverlayIdentityMismatchError(record.overlayId, overlayId)
    }

    const logicalId = toPublishedId(record.logicalId)
    const normalized = clone({...record, logicalId})

    const snapshot = baseSnapshotFrom(normalized)
    const snapshotRef = snapshot === null ? undefined : canonicalChecksum(snapshot)
    const recordChecksum = canonicalChecksum(normalized)
    const storageRef = this.layout.revisionRef(logicalId, recordChecksum)

    /* Both artifacts are content-addressed and therefore immutable: an existing
     * entry already holds identical bytes (PRD §14.3 "one immutable snapshot per
     * captured base state"). */
    if (snapshot !== null) {
      const ref = this.layout.snapshotRef(snapshotRef!)
      if (!this.storage.has(ref)) this.#writeJson(ref, snapshot)
    }
    if (!this.storage.has(storageRef)) this.#writeJson(storageRef, normalized)

    const write: ImmutableWrite = {
      logicalId,
      record: normalized,
      storageRef,
      checksum: recordChecksum,
      head: documentHeadFromRecord(normalized, {storageRef, checksum: recordChecksum}),
    }
    if (snapshotRef !== undefined) write.snapshotRef = snapshotRef
    return write
  }

  /** The regenerable review-facing projection (PRD §14.2). */
  #writeIntent(write: ImmutableWrite): void {
    const options = write.snapshotRef === undefined ? {} : {snapshotRef: write.snapshotRef}
    this.#writeJson(
      this.layout.intentRef(write.logicalId),
      intentFromRecord(write.record, options),
    )
  }

  #removeDocumentArtifacts(logicalId: string): string[] {
    const removed = [
      this.layout.intentRef(logicalId),
      ...this.storage.refs(this.layout.revisionPrefix(logicalId)),
    ]
    for (const ref of removed) this.storage.delete(ref)
    return removed
  }

  /**
   * Recompute `manifest.conflictSummary` across every current head (PRD §13.1).
   *
   * Records written by the in-flight call are counted from the record itself —
   * their projected intent is not stored yet, because projections follow the
   * commit — and every other head is counted from its stored intent.
   */
  #conflictSummary(
    documentHeads: Record<string, OverlayDocumentHead>,
    updated: readonly OverlayDocumentRecord[],
  ): OverlayManifest['conflictSummary'] {
    const inFlight = new Map<string, {hard: number; soft: number}>()
    for (const record of updated) {
      let hard = 0
      let soft = 0
      for (const conflict of record.conflicts) {
        if (conflict.resolution !== undefined) continue
        if (conflict.severity === 'hard') hard += 1
        else soft += 1
      }
      inFlight.set(toPublishedId(record.logicalId), {hard, soft})
    }

    let hard = 0
    let soft = 0
    for (const logicalId of Object.keys(documentHeads)) {
      const counts = inFlight.get(logicalId) ?? countIntentConflicts(this.#readIntent(logicalId))
      hard += counts.hard
      soft += counts.soft
    }
    return {total: hard + soft, hard, soft}
  }

  #allocateTransactionId(overlayId: string, timestamp: string): string {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const sequence = this.#sequence
      this.#sequence += 1
      const transactionId = this.#newTransactionId({overlayId, timestamp, sequence})
      if (!this.storage.has(this.layout.transactionRef(transactionId))) return transactionId
    }
    /* istanbul ignore next -- unreachable without a pathological ID factory. */
    throw new OverlayInvalidRequestError('Could not allocate a unique transaction ID')
  }
}

/* ------------------------------------------------------------------ *
 * Free helpers
 * ------------------------------------------------------------------ */

/**
 * Deep copy through the canonical serializer, so every value the store hands out
 * is detached, canonically ordered and free of prototype-polluting keys.
 */
function clone<T>(value: T): T {
  return canonicalize(value)
}

function countIntentConflicts(intent: CheckpointDocumentIntent | null): {
  hard: number
  soft: number
} {
  let hard = 0
  let soft = 0
  for (const conflict of intent?.conflicts ?? []) {
    if (conflict.resolved) continue
    if (conflict.severity === 'hard') hard += 1
    else soft += 1
  }
  return {hard, soft}
}

/** PRD §13.1 `expiresAt`, §15.7 retention. `expiresAt: null` clears it. */
function applyRetention(manifest: OverlayManifest, retention: OverlayRetentionPolicy): void {
  if (retention.expiresAt === null) {
    delete manifest.expiresAt
    return
  }
  if (typeof retention.expiresAt === 'string') {
    manifest.expiresAt = retention.expiresAt
    return
  }
  if (typeof retention.ttlDays === 'number') {
    manifest.expiresAt = addDays(manifest.updatedAt, retention.ttlDays)
  }
}

/** Add whole days to an ISO timestamp without reading a clock. */
function addDays(isoTimestamp: string, days: number): string {
  const base = Date.parse(isoTimestamp)
  if (Number.isNaN(base)) {
    throw new OverlayInvalidRequestError(
      `Cannot apply a relative retention to the non-ISO timestamp ${JSON.stringify(isoTimestamp)}`,
      {timestamp: isoTimestamp},
    )
  }
  return new Date(base + days * 86_400_000).toISOString()
}

/**
 * Default transaction ID: `tx-<compacted timestamp>-<sequence>-<digest>`.
 *
 * Lexicographically ordered by commit time and then by sequence, as PRD §13.10
 * MUSTs, and derived only from the injected clock so it stays deterministic.
 * Shared by every adapter so the §13.10 ordering guarantee cannot drift between
 * backends.
 */
export function defaultOverlayTransactionId(context: {
  overlayId: string
  timestamp: string
  sequence: number
}): string {
  const time = context.timestamp.replace(/[^0-9]/g, '').slice(0, 17).padEnd(17, '0')
  const sequence = String(context.sequence).padStart(6, '0')
  const digest = canonicalChecksum(context).slice(0, 8)
  return `tx-${time}-${sequence}-${digest}`
}

function validateManifestShape(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'manifest must be an object'
  const manifest = value as Partial<OverlayManifest>
  if (manifest.formatVersion !== OVERLAY_FORMAT_VERSION) {
    return `unsupported formatVersion ${JSON.stringify(manifest.formatVersion)}`
  }
  if (typeof manifest.overlayId !== 'string' || manifest.overlayId.length === 0) {
    return 'overlayId must be a non-empty string'
  }
  if (typeof manifest.revision !== 'number' || !Number.isInteger(manifest.revision)) {
    return 'revision must be an integer'
  }
  if (typeof manifest.documentHeads !== 'object' || manifest.documentHeads === null) {
    return 'documentHeads must be an object'
  }
  if (typeof manifest.status !== 'string') return 'status must be a string'
  return null
}
