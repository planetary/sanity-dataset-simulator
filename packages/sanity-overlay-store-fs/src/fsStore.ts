/**
 * `FsOverlayStore` — the filesystem overlay store adapter (PRD §14, §37 Phase 2
 * "Filesystem store tasks").
 *
 * ## Durability model
 *
 * Three rules give the store crash safety and multi-writer safety.
 *
 * 1. **Every write is temp-file + rename** (§14.3 MUST). A reader therefore never
 *    observes a partially written file; it sees either the old bytes or the new
 *    ones.
 * 2. **The manifest is the commit point.** Immutable, content-addressed artifacts
 *    (base snapshots, document revisions, transaction records) are written first
 *    and are unreachable until a manifest head names them; the manifest rename
 *    publishes the whole set at once. Derived projections (`intent.json`,
 *    `.runtime/materialized/`) are written last because they are regenerable.
 *
 *    A crash therefore lands in one of three states, none of them corrupt:
 *    before the manifest write → unreachable artifacts only, reclaimed by
 *    {@link FsOverlayStore.collectOrphans} (§15.3, §34.8); after the manifest
 *    write but before the projections → stale or absent `intent.json`, rebuilt by
 *    {@link FsOverlayStore.revalidate}; after everything → committed.
 * 3. **One writer at a time, across processes** (§35.7 "Concurrent stale write
 *    rejection"). Rules 1 and 2 make a *crash* safe; they do nothing about two
 *    writers, because `read manifest → check precondition → rename manifest` is a
 *    read-modify-write and rename is only atomic with respect to *itself*. Two
 *    stores on one root — two Studio tabs, a CLI beside a dev server, two
 *    invocations on one volume — both passed the precondition and both renamed,
 *    and the loser's head vanished from the manifest while its revision file
 *    survived as an orphan. Every manifest-mutating entry point therefore runs
 *    inside {@link FsOverlayStore.withOverlayLock}, an exclusive `.locks/` file
 *    lock (§14.1 reserves the directory), and `#writeManifest` re-reads the
 *    manifest immediately before its rename so a writer that never took the lock
 *    — an agent editing files directly, per §14.4 — still cannot be overwritten
 *    silently.
 *
 * ## Direct edits
 *
 * §14.3 requires the store to tolerate an agent or a Git merge rewriting
 * `intent.json` underneath it: refuse malformed JSON, retain the last valid
 * in-memory state, write a `.broken` diagnostic copy, revalidate before serving,
 * and treat a stale checksum on a semantically valid file as repairable metadata.
 * {@link FsOverlayStore.revalidate} and {@link FsOverlayStore.repairChecksums}
 * implement the §14.4 workflow; a live `fs.watch` is a thin trigger on top and is
 * deliberately not part of the store, so the behaviour stays testable.
 *
 * ## Determinism
 *
 * Every file is written through core's canonical serializer (sorted keys, two
 * space indent, trailing newline) so a Git diff shows semantic change only
 * (§14.3, §34.17), and the clock is injected (`now`) so no wall-clock read hides
 * inside the store.
 */
import {randomUUID} from 'node:crypto'
import {mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {dirname, join, resolve as resolvePath} from 'node:path'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  OVERLAY_FORMAT_VERSION,
  assertFormatVersion,
  checksum as canonicalChecksum,
  canonicalize,
  encodeOverlayPath,
  exportCheckpoint as renderCheckpoint,
  importCheckpoint as parseCheckpoint,
  isChecksum,
  overlayIdFromIdentityInput,
  parse,
  serialize,
  toPublishedId,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayCheckpointChecksums,
  OverlayCheckpointIssue,
  OverlayCheckpointState,
  OverlayDocumentHead,
  OverlayDocumentRecord,
  OverlayManifest,
  OverlayStatus,
  OverlayTransactionRecord,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {readCheckpointDir} from './checkpointIo'
import {watchOverlay, type OverlayWatchHandle, type OverlayWatchOptions} from './watch'
import {
  DELETABLE_STATUSES,
  WRITABLE_STATUSES,
  bundleChecksum,
  defaultRetentionDays,
  documentHeadFromRecord,
} from './contract'
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
  OverlayDirectEditStore,
  OverlayDocumentReadResult,
  OverlayDocumentWriteResult,
  OverlayOrphanRef,
  OverlayOrphanReport,
  OverlayPromotionInput,
  OverlayResetResult,
  OverlayResettableStore,
  OverlayRetentionPolicy,
  OverlayRevalidationFailure,
  OverlayArtifactKind,
  OverlayRevalidationReport,
  OverlayStore,
  OverlayTransactionSelector,
  PutDocumentRevisionOptions,
  RepairChecksumsResult,
  ResetOverlayOptions,
  RevalidateOptions,
  WriteManifestOptions,
} from './contract'
import {
  OverlayAlreadyExistsError,
  OverlayChecksumMismatchError,
  OverlayClosedError,
  OverlayDocumentRevisionConflictError,
  OverlayIdentityMismatchError,
  OverlayInvalidRequestError,
  OverlayNotFoundError,
  OverlayRetentionActiveError,
  OverlayStoreCorruptError,
  OverlayStoreError,
  OverlayWriteConflictError,
} from './errors'
import {
  baseSnapshotFrom,
  intentChecksum,
  intentFromRecord,
  type CheckpointDocumentIntent,
  type OverlayBaseSnapshot,
  type OverlayIntentState,
} from './intent'
import {
  BROKEN_SUFFIX,
  assertSafeComponent,
  assertWithinRoot,
  GITATTRIBUTES_CONTENT,
  GITATTRIBUTES_FILE,
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
  LOCKS_DIR,
  OverlayLayout,
  README_CONTENT,
  README_FILE,
  TEMP_PREFIX,
  documentKey,
} from './layout'

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * The writer lock, inside the `.locks/` directory PRD §14.1 reserves and
 * `.gitignore`s. One lock for the whole overlay rather than one per document:
 * the contended resource is `manifest.json`, which every commit rewrites.
 */
export const OVERLAY_LOCK_FILE = 'overlay.lock'

export interface FsOverlayStoreHooks {
  /**
   * Called after the temporary file holds the complete new bytes and before it is
   * renamed over the target. Exists so the §35.9 "Atomic temporary write and
   * rename" case can observe the window directly; production code leaves it unset.
   */
  beforeRename?(info: {tempPath: string; targetPath: string}): void | Promise<void>
}

export interface FsOverlayStoreOptions {
  /**
   * Absolute path of the directory that *contains* `.sanity-overlay/` — normally
   * the repository root (PRD §14.1).
   */
  root: string
  /** Injected clock returning an ISO-8601 timestamp. Required: the store never reads a wall clock. */
  now: OverlayClock
  /**
   * Transaction ID factory. Must be unique within the overlay and lexicographically
   * ordered by commit time (PRD §13.10 MUST). The default derives one from the
   * injected clock plus a per-store sequence, so it is deterministic.
   */
  newTransactionId?: (context: {overlayId: string; timestamp: string; sequence: number}) => string
  hooks?: FsOverlayStoreHooks
  /**
   * `fsync` the staging file before renaming it.
   *
   * Off by default. PRD §14.3 requires *atomicity* ("temporary file plus
   * rename"), which the rename alone provides — a reader always sees whole old
   * bytes or whole new bytes. `fsync` adds *durability across a power loss*,
   * which costs an F_FULLFSYNC per file on APFS and is not what local branch
   * state needs. Turn it on where the overlay is the system of record.
   */
  fsync?: boolean
  /**
   * How long a writer waits for the `.locks/` critical section before giving up
   * with a retryable `OVERLAY_STORE_UNAVAILABLE`.
   *
   * A bound rather than an unbounded wait: a caller that can never proceed must
   * be told so, not hang. Default 10 s — far longer than any commit, far shorter
   * than a request timeout.
   */
  lockTimeoutMs?: number
  /**
   * Age at which a held lock is treated as abandoned and broken.
   *
   * A process killed inside its critical section cannot release its own lock
   * (that is the definition of `SIGKILL`), so without this the overlay would be
   * wedged until a human deleted a file. The window must exceed the longest
   * legitimate critical section by a wide margin: breaking a live holder's lock
   * reintroduces exactly the lost update the lock exists to prevent. Default 30 s.
   *
   * The age check is only the fallback. A lock written by a process on THIS host
   * is probed by pid first, so the common case — a killed dev server, a `^C`d
   * CLI — is recovered immediately and exactly rather than after a timeout.
   */
  staleLockMs?: number
  /**
   * Age at which `collectOrphans` reclaims a `.tmp-` staging file.
   *
   * A process killed mid-write cannot unlink its own staging file, so real
   * crashes leave litter that nothing else reclaims. It must never be reclaimed
   * eagerly: a file young enough to belong to a writer that is still running
   * would turn a healthy commit into an `ENOENT` at its rename — cleanup causing
   * the corruption it exists to prevent. Default 60 s.
   */
  staleTempMs?: number
}

/* ------------------------------------------------------------------ *
 * Checkpoint I/O (PRD §14.1, §29.1, §29.7)
 * ------------------------------------------------------------------ */

export interface ExportCheckpointToDirOptions {
  /**
   * Directory to write, absolute or relative to the process cwd. Defaults to the
   * store's own `.sanity-overlay/` — PRD §29.4's
   * `sanity-overlay export --output .sanity-overlay`. Exporting in place rewrites
   * the canonical files with identical bytes and adds `checksums.json`.
   */
  dir?: string
  /** Extra files to carry alongside the canonical set; hashed but not validated. */
  extraFiles?: Record<string, string>
}

export interface FsCheckpointExportResult {
  overlayId: string
  /** Absolute path of the directory written. */
  dir: string
  /** Relative POSIX paths written, sorted. */
  files: string[]
  checksums: OverlayCheckpointChecksums
}

export interface ImportCheckpointToStoreOptions {
  /** Replace an existing overlay instead of failing (PRD §29.7). */
  overwrite?: boolean
  /**
   * `'repair'` (default) normalizes stale checksum metadata per PRD §14.3 and
   * §29.7 step 3; `'reject'` refuses any divergence, for a strict validate gate.
   * Semantic corruption always throws, before a single byte is written.
   */
  onDivergence?: 'repair' | 'reject'
  expectOverlayId?: string
}

/** A regenerable artifact that could not be written. Never a reason to fail a commit. */
export interface OverlayProjectionFailure {
  /** Path relative to `.sanity-overlay/`. */
  ref: string
  logicalId?: string
  /** `errno` code where the OS supplied one. */
  code?: string
  message: string
}

/**
 * `commitTransaction`'s result, widened with what happened AFTER the commit point.
 *
 * PRD §33 "Local disk write fails" pairs an OS error with a *save failure
 * banner*, and a banner is only honest if the save really did not happen. Once
 * `manifest.json` has been renamed the transaction is durable and visible: a
 * later `EACCES` writing `documents/<id>/intent.json` has not un-committed it,
 * and reporting that as a failed save would tell the editor to retry work that
 * is already saved — which the idempotency pointer would then refuse to redo.
 *
 * So the store draws the line at the commit point. Everything before it can
 * fail the call; nothing after it does. What did fail is named here instead, and
 * every artifact after the commit point is regenerable — `revalidate` and the
 * document read path rebuild a missing `intent.json` from the head's immutable
 * revision (§34.2: deleting a local file is not a content change).
 */
export interface FsOverlayCommitResult extends OverlayCommitResult {
  /** Empty on a fully clean commit. */
  projectionFailures: OverlayProjectionFailure[]
}

/**
 * `revalidate`'s report, widened with the projections it rebuilt.
 *
 * A missing `intent.json` behind a live manifest head is recoverable — the head
 * names an immutable revision and the intent is a pure function of it — so it is
 * repaired rather than reported as corruption. It is still *named*: silent
 * self-healing would hide a disk that is quietly failing every projection write.
 */
export interface FsOverlayRevalidationReport extends OverlayRevalidationReport {
  /** Paths, relative to `.sanity-overlay/`, rebuilt from a manifest head. */
  regenerated: string[]
}

export interface FsCheckpointImportResult {
  overlayId: string
  /** Absolute path of the directory read. */
  dir: string
  manifest: OverlayManifest
  importedDocuments: number
  importedSnapshots: number
  /** Paths whose stale checksum metadata was recomputed (PRD §14.3, §29.2). */
  repaired: string[]
  issues: OverlayCheckpointIssue[]
}

/* ------------------------------------------------------------------ *
 * Local runtime history (PRD §13.10, §14.1 `.runtime/transactions/`,
 * §37 Phase 2 "Local runtime history")
 * ------------------------------------------------------------------ */

export interface ReadHistoryOptions {
  /** Only transactions that touched this logical document. `drafts.` normalizes away. */
  documentId?: string
  /** Only transactions that committed *after* this overlay revision. */
  sinceRevision?: number
  /** `'newest'` (default) or `'oldest'` first. */
  order?: 'newest' | 'oldest'
  /** Cap the result, applied after filtering and ordering. */
  limit?: number
}

/** One immutable §13.3 revision a transaction produced. */
export interface OverlayHistoryArtifact {
  logicalId: string
  /** The content address recorded in the transaction's `resultChecksums`. */
  checksum: string
  /**
   * Adapter-relative path of the revision file, or `''` when the stored checksum
   * is not a valid content address (a corrupt log entry, which
   * {@link FsOverlayStore.verifyChecksums} is the place to diagnose).
   */
  ref: string
  /** The immutable revision file is still on disk and can be read back. */
  present: boolean
  /** The manifest's current head still names this exact revision. */
  current: boolean
}

/**
 * One step of the branch's local history.
 *
 * This is the *overlay's own* log, not Sanity's. It answers "what did this branch
 * do, in order, and can each step still be read back" — it is not a Content Lake
 * mendoza stream, it carries no per-keystroke document timeline, and it does not
 * survive a checkpoint (PRD §29.1, §29.2 deliberately exclude the transaction log
 * from the Git-facing tree, and §14.1 keeps `.runtime/` out of version control).
 */
export interface OverlayHistoryEntry {
  transaction: OverlayTransactionRecord
  /** One per document the transaction WROTE, ordered by logical ID. */
  artifacts: OverlayHistoryArtifact[]
  /** Documents the transaction affected without writing a revision — a §29.8 removal. */
  removedDocumentIds: string[]
  /**
   * Every revision this transaction produced is still readable.
   *
   * `false` for a transaction that only removed documents: a removal produced no
   * artifact, so there is nothing to read back. This is a statement about the
   * *content*, never about the log entry — the record of what happened survives
   * either way.
   */
  recoverable: boolean
}

/* ------------------------------------------------------------------ *
 * Local cleanup of `.runtime/` growth (PRD §15.7, §37 Phase 2 "Local cleanup")
 * ------------------------------------------------------------------ */

export interface PruneRuntimeHistoryOptions {
  /**
   * Retain the N most recent transactions and prune the rest.
   *
   * Omit to prune no transaction record at all — a dangling idempotency pointer
   * is still removed, because it is broken state rather than retained state.
   */
  keepLast?: number
  /** Retain every transaction whose `overlayRevisionAfter` is greater than this. */
  keepAfterRevision?: number
  /** Report without deleting. */
  dryRun?: boolean
}

export interface PrunedTransactionRef {
  transactionId: string
  /** Adapter-relative path of the removed `.runtime/transactions/<id>.json`. */
  ref: string
  overlayRevisionAfter: number
}

export interface PrunedPointerRef {
  /** Adapter-relative path of the removed `.runtime/indexes/idempotency/<key>.json`. */
  ref: string
  /** The transaction the pointer named, or `null` when the file could not be read. */
  transactionId: string | null
  /**
   * `'dangling'` — the pointer already named no readable transaction, so
   * {@link FsOverlayStore.getTransaction} answered `null` for it before this ran.
   * `'pruned-transaction'` — removed together with the transaction it named.
   */
  reason: 'dangling' | 'pruned-transaction'
}

/**
 * PRD §15.7 "Record cleanup results and failures", for the runtime log.
 *
 * Read the `pointers` list as a safety statement: every entry with reason
 * `'pruned-transaction'` is a §34.6 idempotency key that will no longer replay.
 * A retried request older than the prune horizon therefore APPLIES AGAIN rather
 * than returning its original result. That is the price of pruning the log and
 * it is why pruning is opt-in.
 */
export interface RuntimeHistoryPruneReport {
  overlayId: string
  dryRun: boolean
  scannedTransactions: number
  scannedPointers: number
  /** Removed transaction records, oldest first. */
  transactions: PrunedTransactionRef[]
  pointers: PrunedPointerRef[]
  /**
   * The transaction the manifest still names as `transactionHead`, which is
   * retained regardless of the retention window so the manifest never points at
   * a record that is gone.
   */
  retainedHead: string | null
  failures: Array<{ref: string; reason: string}>
}

/** Generated artifact written to `.runtime/materialized/<key>.json` (PRD §14.2, §14.4 step 6). */
export interface MaterializedDocumentFile {
  formatVersion: typeof OVERLAY_FORMAT_VERSION
  logicalId: string
  schemaType: string
  runtimeRevision: string
  generatedAt: string
  draft: SanityDocument | null
  published: SanityDocument | null
}

interface ImmutableWrite {
  logicalId: string
  record: OverlayDocumentRecord
  storageRef: string
  checksum: string
  snapshotRef?: string
  head: OverlayDocumentHead
}

interface SoftRead<T> {
  ok: boolean
  value?: T
  raw?: string
  error?: {code: string; message: string}
  missing: boolean
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export class FsOverlayStore implements OverlayStore, OverlayDirectEditStore, OverlayResettableStore {
  readonly layout: OverlayLayout

  readonly #now: OverlayClock
  readonly #hooks: FsOverlayStoreHooks
  readonly #fsync: boolean
  readonly #lockTimeoutMs: number
  readonly #staleLockMs: number
  readonly #staleTempMs: number
  readonly #newTransactionId: NonNullable<FsOverlayStoreOptions['newTransactionId']>

  /**
   * In-process serialization of the critical section.
   *
   * The `.locks/` file excludes other PROCESSES; it cannot exclude two concurrent
   * calls on one store instance, because `open(…, 'wx')` from the process that
   * already holds the lock fails with `EEXIST` and the second caller would spin
   * against itself until it timed out. This queue makes same-instance callers
   * wait their turn instead. Rejections are swallowed here and only here: the
   * chain is a scheduler, and the caller still receives its own error.
   */
  #critical: Promise<unknown> = Promise.resolve()
  /**
   * Revision the manifest held when the in-flight critical section read it.
   *
   * `#writeManifest` compares this against disk immediately before its rename, so
   * a manifest that moved underneath an unlocked external writer is refused
   * rather than clobbered. `null` outside a manifest-mutating call.
   */
  #manifestBaseRevision: number | null = null

  /** Last valid parse of each canonical file, retained across malformed edits (§14.3). */
  #lastValidManifest: OverlayManifest | null = null
  #lastValidManifestBytes: string | null = null
  readonly #lastValidIntents = new Map<string, {intent: CheckpointDocumentIntent; bytes: string}>()
  /** Unresolved conflict counts per logical ID, for `manifest.conflictSummary` (§13.1). */
  readonly #conflictCounts = new Map<string, {hard: number; soft: number}>()
  /** `<path>\0<sha256>` of content already copied to `.broken`, so a poll loop writes it once. */
  readonly #diagnosed = new Set<string>()
  #sequence = 0

  constructor(options: FsOverlayStoreOptions) {
    if (typeof options?.now !== 'function') {
      throw new OverlayInvalidRequestError('FsOverlayStore requires an injected `now` clock')
    }
    this.layout = new OverlayLayout(options.root)
    this.#now = options.now
    this.#hooks = options.hooks ?? {}
    this.#fsync = options.fsync ?? false
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000
    this.#staleLockMs = options.staleLockMs ?? 30_000
    this.#staleTempMs = options.staleTempMs ?? 60_000
    this.#newTransactionId = options.newTransactionId ?? defaultTransactionId
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Concurrent stale write rejection" — the writer critical section
   * ---------------------------------------------------------------- */

  /**
   * Run `body` as the overlay's only writer, excluding other processes.
   *
   * Public because a caller that composes several store calls into one logical
   * change — read the manifest, decide, then commit — needs the same exclusion
   * across the whole sequence, and re-deriving it outside the store would produce
   * a second, differently-shaped lock over the same file.
   *
   * Not re-entrant, and deliberately so: a nested acquire would deadlock against
   * the queue, and making it silently re-entrant would hand the lock to an
   * unrelated concurrent caller that happened to run while it was held. No store
   * method calls another locked store method.
   */
  async withOverlayLock<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#critical.then(
      () => this.#runLocked(body),
      () => this.#runLocked(body),
    )
    this.#critical = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #runLocked<T>(body: () => Promise<T>): Promise<T> {
    const release = await this.#acquireLock()
    this.#manifestBaseRevision = null
    try {
      return await body()
    } finally {
      this.#manifestBaseRevision = null
      await release()
    }
  }

  /**
   * Take `.locks/overlay.lock`, waiting for a current holder.
   *
   * `open(path, 'wx')` is the primitive: exclusive create is atomic on every
   * filesystem this runs on, including APFS and the network mounts a shared
   * volume implies, and unlike an advisory `flock` it survives across processes
   * that never opened the same descriptor.
   *
   * Staleness is measured from the lock file's own mtime with the WALL clock, not
   * the injected `now`. The injected clock exists so file CONTENT is
   * deterministic; a test that freezes it must not thereby make every lock look
   * infinitely old and disable the exclusion under test.
   */
  async #acquireLock(): Promise<() => Promise<void>> {
    const lockPath = this.layout.resolve(LOCKS_DIR, OVERLAY_LOCK_FILE)
    await mkdir(dirname(lockPath), {recursive: true})
    const deadline = Date.now() + this.#lockTimeoutMs

    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o644)
        try {
          await handle.writeFile(
            serialize({
              acquiredAt: new Date().toISOString(),
              host: hostname(),
              pid: process.pid,
            }),
            'utf8',
          )
        } finally {
          await handle.close()
        }
        let released = false
        return async () => {
          if (released) return
          released = true
          await rm(lockPath, {force: true}).catch(() => undefined)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      const age = await stat(lockPath)
        .then((stats) => Date.now() - stats.mtimeMs)
        .catch(() => null)
      if (age === null) continue /* The holder released between the two calls. */
      if (age > this.#staleLockMs || (await this.#holderIsGone(lockPath))) {
        /* An abandoned lock. Removed by path, then retried through `wx`, so two
         * breakers cannot both conclude they now hold it. */
        await rm(lockPath, {force: true}).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) {
        throw new OverlayStoreError(
          'OVERLAY_STORE_UNAVAILABLE',
          `Another writer has held the overlay lock at ${this.layout.relative(lockPath)} for ${this.#lockTimeoutMs} ms`,
          {retryable: true, details: {lockPath: this.layout.relative(lockPath), ageMs: age}},
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }

  /**
   * Is the process that wrote this lock provably no longer running?
   *
   * `kill(pid, 0)` sends no signal; it asks the kernel whether the pid exists.
   * That turns crash recovery from a 30-second guess into an exact answer for
   * the case that actually happens — a killed dev server, an interrupted CLI,
   * a test runner torn down mid-commit — which is worth having, because until
   * the lock is broken the overlay accepts no writes at all.
   *
   * Answered only for a lock this host wrote. On a shared volume another host's
   * pid is meaningless and could collide with a live local one, so those fall
   * through to the age threshold. `EPERM` counts as ALIVE: the process exists
   * and merely belongs to another user.
   */
  async #holderIsGone(lockPath: string): Promise<boolean> {
    const read = await readFile(lockPath, 'utf8').catch(() => null)
    if (read === null) return false
    let holder: {host?: unknown; pid?: unknown}
    try {
      holder = parse(read) as {host?: unknown; pid?: unknown}
    } catch {
      /* A lock file that is not parseable was never written by this store, or
       * was written partially. Age is the only safe judge of it. */
      return false
    }
    if (holder.host !== hostname() || typeof holder.pid !== 'number') return false
    if (holder.pid === process.pid) return false
    try {
      process.kill(holder.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Create overlay"
   * ---------------------------------------------------------------- */

  async createOverlay(input: CreateOverlayInput): Promise<OverlayManifest> {
    return this.withOverlayLock(() => this.#createOverlayLocked(input))
  }

  async #createOverlayLocked(input: CreateOverlayInput): Promise<OverlayManifest> {
    const existing = await this.#readManifestFile()
    if (!existing.missing) {
      const stored = existing.value
      if (input.ifNotExists && stored) {
        this.#cacheManifest(stored, existing.raw ?? null)
        return clone(stored)
      }
      throw new OverlayAlreadyExistsError(stored?.overlayId ?? '<unreadable>', {
        root: this.layout.root,
      })
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

    await this.#scaffold()
    await this.#writeManifest(manifest)
    return clone(manifest)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Read empty overlay"
   * ---------------------------------------------------------------- */

  async readManifest(overlayId: string): Promise<OverlayManifest> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    return clone(manifest)
  }

  /** Read the manifest without an identity assertion — useful for `inspect` tooling (§14.5). */
  async inspect(): Promise<OverlayManifest> {
    return clone(await this.#loadManifest())
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
    return this.withOverlayLock(() =>
      this.#writeManifestConditionalLocked(overlayId, next, expectedRevision, options),
    )
  }

  async #writeManifestConditionalLocked(
    overlayId: string,
    next: OverlayManifest,
    expectedRevision: number,
    options: WriteManifestOptions,
  ): Promise<OverlayManifest> {
    const current = await this.#loadManifest()
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
    await this.#writeManifest(written)
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
    return this.withOverlayLock(() =>
      this.#putDocumentRevisionLocked(overlayId, record, options),
    )
  }

  async #putDocumentRevisionLocked(
    overlayId: string,
    record: OverlayDocumentRecord,
    options: PutDocumentRevisionOptions,
  ): Promise<OverlayDocumentWriteResult> {
    const manifest = await this.#loadManifest()
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

    const write = await this.#writeImmutable(overlayId, record)

    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    next.documentHeads = {...manifest.documentHeads, [logicalId]: write.head}
    if (options.actor !== undefined) next.updatedBy = options.actor
    await this.#applyConflictSummary(next, [write.record])
    await this.#writeManifest(next)

    await this.#writeProjections(write)

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
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    return this.#readRecordByRef(storageRef)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Commit multi-document transaction" / "Idempotent transaction replay"
   * ---------------------------------------------------------------- */

  async commitTransaction(
    overlayId: string,
    request: OverlayCommitRequest,
  ): Promise<FsOverlayCommitResult> {
    return this.withOverlayLock(() => this.#commitTransactionLocked(overlayId, request))
  }

  async #commitTransactionLocked(
    overlayId: string,
    request: OverlayCommitRequest,
  ): Promise<FsOverlayCommitResult> {
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

    /* §34.6 — one idempotency key maps to one immutable transaction result. */
    const replayed = await this.getTransaction(overlayId, {
      idempotencyKey: request.idempotencyKey,
    })
    if (replayed !== null) {
      const manifest = await this.#loadManifest()
      return {
        transaction: replayed,
        manifest: clone(manifest),
        heads: replayed.affectedDocumentIds
          .map((id) => manifest.documentHeads[toPublishedId(id)])
          .filter((head): head is OverlayDocumentHead => head !== undefined)
          .map(clone),
        replayed: true,
        projectionFailures: [],
      }
    }

    const manifest = await this.#loadManifest()
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

    /* Step 1 — immutable artifacts. Unreachable until the manifest names them,
     * and mutually independent, so they are written concurrently. */
    const writes: ImmutableWrite[] = await Promise.all(
      request.records.map((record) => this.#writeImmutable(overlayId, record)),
    )

    /* Step 2 — the immutable transaction record (PRD §13.10). */
    const revisionBefore = manifest.revision
    const revisionAfter = revisionBefore + 1
    const committedAt = this.#now()
    const transactionId = await this.#allocateTransactionId(overlayId, committedAt)

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
    await this.#writeJson(this.layout.transactionPath(transactionId), transaction)

    /* Step 3 — the commit point. One atomic rename publishes every artifact. */
    const next = clone(manifest)
    next.revision = revisionAfter
    next.updatedAt = committedAt
    next.updatedBy = request.actor
    next.transactionHead = transactionId
    const heads = {...manifest.documentHeads}
    for (const write of writes) heads[write.logicalId] = write.head
    for (const id of removed) delete heads[id]
    next.documentHeads = heads
    for (const id of removed) this.#conflictCounts.delete(id)
    await this.#applyConflictSummary(
      next,
      writes.map((write) => write.record),
    )
    await this.#writeManifest(next)

    /* ─────────────── PAST THE COMMIT POINT — NOTHING BELOW THROWS ─────────────
     * The rename above made the transaction durable and visible. Every write
     * that follows is regenerable, so a failure in one is a degraded projection,
     * not a failed save, and is reported rather than raised: a caller told
     * "failed" would retry a commit that already landed, and step 4 would then
     * replay it away without ever repairing what actually broke.
     * ───────────────────────────────────────────────────────────────────────── */
    const projectionFailures: OverlayProjectionFailure[] = []

    /* Step 4 — the idempotency pointer. Written after the commit so it can never
     * name an uncommitted transaction; the crash window between the two costs at
     * most one replayed apply of byte-identical content-addressed artifacts. */
    await this.#tolerate(
      projectionFailures,
      this.layout.idempotencyPath(request.idempotencyKey),
      undefined,
      () =>
        this.#writeJson(this.layout.idempotencyPath(request.idempotencyKey), {
          formatVersion: OVERLAY_FORMAT_VERSION,
          idempotencyKey: request.idempotencyKey,
          transactionId,
          committedAt,
        }),
    )

    /* Step 5 — regenerable projections. */
    for (const write of writes) {
      await this.#tolerate(
        projectionFailures,
        this.layout.intentPath(write.logicalId),
        write.logicalId,
        () => this.#writeProjections(write),
      )
    }
    for (const id of removed) {
      await this.#tolerate(projectionFailures, this.layout.documentDir(id), id, () =>
        this.#removeDocumentArtifacts(id).then(() => undefined),
      )
    }

    return {
      transaction: clone(transaction),
      manifest: clone(next),
      heads: writes.map((write) => clone(write.head)),
      replayed: false,
      projectionFailures,
    }
  }

  /** Run a post-commit-point write, recording rather than raising any failure. */
  async #tolerate(
    into: OverlayProjectionFailure[],
    path: string,
    logicalId: string | undefined,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write()
    } catch (error) {
      const failure: OverlayProjectionFailure = {
        ref: this.layout.relative(path),
        message: (error as Error).message,
      }
      if (logicalId !== undefined) failure.logicalId = logicalId
      const code = (error as NodeJS.ErrnoException).code
      if (code !== undefined) failure.code = code
      into.push(failure)
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
      const pointer = await this.#readJsonSoft<{transactionId?: unknown}>(
        this.layout.idempotencyPath(selector.idempotencyKey),
      )
      if (pointer.missing || typeof pointer.value?.transactionId !== 'string') return null
      transactionId = pointer.value.transactionId
    }

    const path = this.layout.transactionPath(transactionId)
    const read = await this.#readJsonSoft<OverlayTransactionRecord>(path)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(
        this.layout.relative(path),
        read.error?.message ?? 'unreadable transaction record',
      )
    }
    assertFormatVersion(read.value.formatVersion)
    if (read.value.overlayId !== overlayId) {
      throw new OverlayIdentityMismatchError(overlayId, read.value.overlayId)
    }
    return read.value
  }

  /* ---------------------------------------------------------------- *
   * Local runtime history — PRD §13.10, §37 Phase 2
   * ---------------------------------------------------------------- */

  /**
   * Read the branch's own transaction log back (PRD §14.1
   * `.runtime/transactions/`).
   *
   * `getTransaction` is a point lookup; this is the ordered log, which is what
   * "local runtime history" in §37 Phase 2 asks for. Ordering is by
   * `transactionId`, which §13.10 MUSTs to be lexicographically ordered by commit
   * time — so the log order is the commit order without a separate index.
   *
   * Scope, stated plainly: this is not Sanity's History. It records overlay
   * transactions, not a Content Lake revision stream, and it lives entirely under
   * `.runtime/`, which §14.1 keeps out of Git and §29.2 keeps out of a
   * checkpoint. A fresh clone, or an overlay restored from a checkpoint tree, has
   * no history at all — and reports exactly that, rather than an empty-looking
   * branch.
   */
  async readHistory(
    overlayId: string,
    options: ReadHistoryOptions = {},
  ): Promise<OverlayHistoryEntry[]> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    /* Ascending, i.e. commit order (§13.10). */
    const all = await this.#readAllTransactions()

    const wanted = options.documentId === undefined ? null : toPublishedId(options.documentId)
    const matching = all.filter((transaction) => {
      if (
        options.sinceRevision !== undefined &&
        transaction.overlayRevisionAfter <= options.sinceRevision
      ) {
        return false
      }
      if (wanted === null) return true
      /* Element-wise. A joined key would make `k` and `k+separator+k`
       * indistinguishable, and a substring test would match a strict prefix. */
      return transaction.affectedDocumentIds.some((id) => toPublishedId(id) === wanted)
    })

    const ordered = options.order === 'oldest' ? matching : [...matching].reverse()
    const limited =
      typeof options.limit === 'number' ? ordered.slice(0, Math.max(0, options.limit)) : ordered

    const entries: OverlayHistoryEntry[] = []
    for (const transaction of limited) {
      const checksums = transaction.resultChecksums ?? {}
      const artifacts: OverlayHistoryArtifact[] = []
      for (const logicalId of Object.keys(checksums).sort()) {
        const artifactChecksum = checksums[logicalId]!
        let ref = ''
        let present = false
        if (isChecksum(artifactChecksum)) {
          const path = this.layout.revisionPath(logicalId, artifactChecksum)
          ref = this.layout.relative(path)
          present = await exists(path)
        }
        artifacts.push({
          logicalId,
          checksum: artifactChecksum,
          ref,
          present,
          current: ref !== '' && manifest.documentHeads[logicalId]?.storageRef === ref,
        })
      }

      const written = new Set(artifacts.map((artifact) => artifact.logicalId))
      entries.push({
        transaction: clone(transaction),
        artifacts,
        removedDocumentIds: transaction.affectedDocumentIds.filter((id) => !written.has(id)),
        recoverable: artifacts.length > 0 && artifacts.every((artifact) => artifact.present),
      })
    }
    return entries
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "List changed documents" / "Read by logical ID"
   * ---------------------------------------------------------------- */

  async listChangedDocuments(
    overlayId: string,
    options: ListChangedDocumentsOptions = {},
  ): Promise<OverlayDocumentHead[]> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    const heads = Object.values(manifest.documentHeads).filter((head) => {
      if (options.states !== undefined) return options.states.includes(head.state)
      return options.includeUnchanged === true || head.state !== 'unchanged'
    })
    return heads
      .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0))
      .map(clone)
  }

  async readDocumentByLogicalId(
    overlayId: string,
    logicalId: string,
  ): Promise<OverlayDocumentReadResult | null> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const normalized = toPublishedId(logicalId)
    const head = manifest.documentHeads[normalized]
    if (head === undefined) return null

    const record = await this.#readRecordByRef(head.storageRef)
    const intent = await this.#loadIntent(normalized, head)
    const snapshotRef = intent?.base.snapshotRef
    const baseSnapshot =
      snapshotRef === undefined ? null : await this.#readSnapshot(snapshotRef)

    return {
      head: clone(head),
      record,
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
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const documents: OverlayCanonicalBundleDocument[] = []
    const snapshots: Record<string, OverlayBaseSnapshot> = {}

    for (const logicalId of Object.keys(manifest.documentHeads).sort()) {
      const head = manifest.documentHeads[logicalId]!
      /* An absent intent is regenerated from the head's immutable revision
       * before it is called corruption: a projection that failed to write, or a
       * file a human deleted, is recoverable and must not block an export. */
      const intent = await this.#loadIntent(logicalId, head)
      if (intent === null) {
        throw new OverlayStoreCorruptError(
          this.layout.relative(this.layout.intentPath(logicalId)),
          'manifest head has no readable intent file (PRD §34.3)',
        )
      }
      documents.push({
        intent: clone(intent),
        record: await this.#readRecordByRef(head.storageRef),
        storageRef: head.storageRef,
      })
      const ref = intent.base.snapshotRef
      if (ref !== undefined && snapshots[ref] === undefined) {
        const snapshot = await this.#readSnapshot(ref)
        if (snapshot === null) {
          throw new OverlayStoreCorruptError(
            this.layout.relative(this.layout.snapshotPath(ref)),
            'intent references a base snapshot that is not stored',
          )
        }
        snapshots[ref] = snapshot
      }
    }

    const transactions =
      options.includeTransactions === false ? [] : await this.#readAllTransactions()

    const bundle: OverlayCanonicalBundle = {
      formatVersion: OVERLAY_FORMAT_VERSION,
      overlayId,
      exportedAt: this.#now(),
      manifest: clone(manifest),
      documents,
      snapshots,
      transactions,
      checksum: '',
    }
    bundle.checksum = bundleChecksum(bundle)
    return bundle
  }

  async importCanonical(
    bundle: OverlayCanonicalBundle,
    options: ImportCanonicalOptions = {},
  ): Promise<ImportCanonicalResult> {
    return this.withOverlayLock(() => this.#importCanonicalLocked(bundle, options))
  }

  async #importCanonicalLocked(
    bundle: OverlayCanonicalBundle,
    options: ImportCanonicalOptions,
  ): Promise<ImportCanonicalResult> {
    assertFormatVersion(bundle?.formatVersion)
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

    const existing = await this.#readManifestFile()
    if (!existing.missing) {
      if (options.overwrite !== true) {
        throw new OverlayAlreadyExistsError(existing.value?.overlayId ?? '<unreadable>', {
          hint: 'pass {overwrite: true} to replace the stored overlay (PRD §29.7)',
        })
      }
      await rm(this.layout.root, {recursive: true, force: true})
      this.#resetCaches()
    }

    await this.#scaffold()

    for (const [ref, snapshot] of Object.entries(bundle.snapshots)) {
      await this.#writeJson(this.layout.snapshotPath(ref), snapshot)
    }

    for (const document of bundle.documents) {
      const logicalId = toPublishedId(document.intent.logicalId)
      await this.#writeJson(this.layout.intentPath(logicalId), document.intent)
      if (document.record !== null) {
        const recordChecksum = canonicalChecksum(document.record)
        await this.#writeJson(this.layout.revisionPath(logicalId, recordChecksum), document.record)
        await this.#writeMaterialized(document.record)
      }
    }

    for (const transaction of bundle.transactions) {
      await this.#writeJson(this.layout.transactionPath(transaction.transactionId), transaction)
      await this.#writeJson(this.layout.idempotencyPath(transaction.idempotencyKey), {
        formatVersion: OVERLAY_FORMAT_VERSION,
        idempotencyKey: transaction.idempotencyKey,
        transactionId: transaction.transactionId,
        committedAt: transaction.committedAt,
      })
    }

    await this.#writeManifest(clone(bundle.manifest))

    return {
      manifest: clone(bundle.manifest),
      importedDocuments: bundle.documents.length,
      importedSnapshots: Object.keys(bundle.snapshots).length,
      importedTransactions: bundle.transactions.length,
    }
  }

  /* ---------------------------------------------------------------- *
   * Checkpoint export and import — PRD §14.1, §14.5, §29.1, §29.4, §29.7
   *
   * `exportCanonical` above produces the *transfer* bundle: lossless, including
   * runtime records and the transaction log. A checkpoint is the *review*
   * surface: semantic intent plus immutable recovery snapshots, and nothing that
   * PRD §29.1 keeps out of a PR diff. Rendering and parsing live in core, so the
   * format is identical whatever writes it; only the bytes-to-disk step is here.
   * ---------------------------------------------------------------- */

  /** The §29.1 logical state: manifest, one intent per head, referenced snapshots. */
  async #checkpointState(overlayId: string): Promise<OverlayCheckpointState> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const documents: CheckpointDocumentIntent[] = []
    const snapshots: Record<string, OverlayBaseSnapshot> = {}

    for (const logicalId of Object.keys(manifest.documentHeads).sort()) {
      const intent = await this.#loadIntent(logicalId)
      if (intent === null) {
        throw new OverlayStoreCorruptError(
          this.layout.relative(this.layout.intentPath(logicalId)),
          'manifest head has no readable intent file (PRD §34.3)',
        )
      }
      documents.push(clone(intent))
      const ref = intent.base.snapshotRef
      if (ref !== undefined && snapshots[ref] === undefined) {
        const snapshot = await this.#readSnapshot(ref)
        if (snapshot === null) {
          throw new OverlayStoreCorruptError(
            this.layout.relative(this.layout.snapshotPath(ref)),
            'intent references a base snapshot that is not stored',
          )
        }
        snapshots[ref] = snapshot
      }
    }

    return {manifest: clone(manifest), documents, snapshots}
  }

  /**
   * Write the deterministic checkpoint tree (PRD §14.5 `sanity-overlay export`).
   *
   * Every file goes through the same temp-file-plus-rename primitive as live
   * state, and the returned promise settles only once the last rename has
   * completed — a caller that reports success on this promise is reporting a
   * durable fact.
   */
  async exportCheckpoint(
    overlayId: string,
    options: ExportCheckpointToDirOptions = {},
  ): Promise<FsCheckpointExportResult> {
    const state = await this.#checkpointState(overlayId)
    const files = renderCheckpoint(
      state,
      options.extraFiles === undefined ? {} : {extraFiles: options.extraFiles},
    )

    const dir = resolvePath(options.dir ?? this.layout.root)
    for (const [path, text] of files) {
      /* Containment is asserted against the *target* directory, so a crafted
       * logical ID cannot write outside it (PRD §35.9). */
      await this.#writeText(assertWithinRoot(dir, path), text)
    }

    return {
      overlayId,
      dir,
      files: [...files.keys()],
      checksums: parse(files.get(CHECKPOINT_CHECKSUMS_FILE)!) as OverlayCheckpointChecksums,
    }
  }

  /**
   * Load a committed checkpoint tree into this store (PRD §14.5
   * `sanity-overlay import`, §29.7 "Import on preview initialization").
   *
   * Verification happens over the whole tree in memory before anything is
   * written, so semantic corruption leaves the target store exactly as it was
   * rather than half-loaded. Pointing this at the store's own root normalizes it
   * in place — PRD §14.5 `normalize --repair-checksums`.
   */
  async importCheckpoint(
    dir: string,
    options: ImportCheckpointToStoreOptions = {},
  ): Promise<FsCheckpointImportResult> {
    return this.withOverlayLock(() => this.#importCheckpointLocked(dir, options))
  }

  async #importCheckpointLocked(
    dir: string,
    options: ImportCheckpointToStoreOptions,
  ): Promise<FsCheckpointImportResult> {
    const source = resolvePath(dir)
    const files = await readCheckpointDir(source)
    const parsed = parseCheckpoint(files, {
      ...(options.onDivergence === undefined ? {} : {onDivergence: options.onDivergence}),
      ...(options.expectOverlayId === undefined ? {} : {expectOverlayId: options.expectOverlayId}),
    })

    const existing = await this.#readManifestFile()
    if (!existing.missing) {
      if (options.overwrite !== true) {
        throw new OverlayAlreadyExistsError(existing.value?.overlayId ?? '<unreadable>', {
          hint: 'pass {overwrite: true} to replace the stored overlay (PRD §29.7)',
        })
      }
      await rm(this.layout.root, {recursive: true, force: true})
      this.#resetCaches()
    }

    await this.#scaffold()

    for (const [address, snapshot] of Object.entries(parsed.state.snapshots)) {
      await this.#writeJson(this.layout.snapshotPath(address), snapshot)
    }
    for (const intent of parsed.state.documents) {
      const logicalId = toPublishedId(intent.logicalId)
      const bytes = serialize(intent)
      await this.#writeText(this.layout.intentPath(logicalId), bytes)
      this.#lastValidIntents.set(logicalId, {intent, bytes})
      this.#conflictCounts.set(logicalId, countConflicts(intent))
    }
    await this.#writeManifest(clone(parsed.state.manifest))

    return {
      overlayId: parsed.state.manifest.overlayId,
      dir: source,
      manifest: clone(parsed.state.manifest),
      importedDocuments: parsed.state.documents.length,
      importedSnapshots: Object.keys(parsed.state.snapshots).length,
      repaired: [...parsed.repaired],
      issues: [...parsed.issues],
    }
  }

  /**
   * Watch the canonical files for direct agent edits (PRD §14.3, §14.4).
   *
   * A thin trigger over {@link FsOverlayStore.revalidate}; see `watch.ts` for why
   * it polls and why a subscriber is never notified before the work is durable.
   */
  watch(overlayId: string, options: OverlayWatchOptions = {}): OverlayWatchHandle {
    return watchOverlay(this, overlayId, options)
  }

  /* ---------------------------------------------------------------- *
   * §35.7 lifecycle: "Mark closed" / "Mark promoted" / "Retention metadata" /
   * "Delete overlay"
   * ---------------------------------------------------------------- */

  async markClosed(overlayId: string, options: MarkClosedOptions = {}): Promise<OverlayManifest> {
    return this.withOverlayLock(() => this.#markClosedLocked(overlayId, options))
  }

  async #markClosedLocked(overlayId: string, options: MarkClosedOptions): Promise<OverlayManifest> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const next = clone(manifest)
    next.status = 'closed'
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    if (options.actor !== undefined) next.updatedBy = options.actor

    const retention =
      options.retention ?? ({ttlDays: defaultRetentionDays(next) ?? undefined} as OverlayRetentionPolicy)
    this.#applyRetention(next, retention)

    await this.#writeManifest(next)
    return clone(next)
  }

  async markPromoted(
    overlayId: string,
    promotion: OverlayPromotionInput,
  ): Promise<OverlayManifest> {
    return this.withOverlayLock(() => this.#markPromotedLocked(overlayId, promotion))
  }

  async #markPromotedLocked(
    overlayId: string,
    promotion: OverlayPromotionInput,
  ): Promise<OverlayManifest> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    /* PRD §12.3: the only edge into `promoted` is from `closed`. */
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

    this.#applyRetention(
      next,
      promotion.retention ??
        ({ttlDays: defaultRetentionDays(next) ?? undefined} as OverlayRetentionPolicy),
    )

    await this.#writeManifest(next)
    return clone(next)
  }

  async setRetention(
    overlayId: string,
    retention: OverlayRetentionPolicy,
  ): Promise<OverlayManifest> {
    return this.withOverlayLock(() => this.#setRetentionLocked(overlayId, retention))
  }

  async #setRetentionLocked(
    overlayId: string,
    retention: OverlayRetentionPolicy,
  ): Promise<OverlayManifest> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    this.#applyRetention(next, retention)

    await this.#writeManifest(next)
    return clone(next)
  }

  async deleteOverlay(
    overlayId: string,
    options: DeleteOverlayOptions = {},
  ): Promise<DeleteOverlayResult> {
    return this.withOverlayLock(() => this.#deleteOverlayLocked(overlayId, options))
  }

  async #deleteOverlayLocked(
    overlayId: string,
    options: DeleteOverlayOptions,
  ): Promise<DeleteOverlayResult> {
    const manifest = await this.#loadManifest()
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

    const removedRefs = (await readdirSafe(this.layout.root))
      .map((entry) => entry.name)
      .sort()
    await rm(this.layout.root, {recursive: true, force: true})
    this.#resetCaches()

    return {overlayId, deleted: true, removedRefs}
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Orphan revision cleanup"
   * ---------------------------------------------------------------- */

  async collectOrphans(
    overlayId: string,
    options: CollectOrphansOptions = {},
  ): Promise<OverlayOrphanReport> {
    return this.withOverlayLock(() => this.#collectOrphansLocked(overlayId, options))
  }

  async #collectOrphansLocked(
    overlayId: string,
    options: CollectOrphansOptions,
  ): Promise<OverlayOrphanReport> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const heads = Object.values(manifest.documentHeads)
    const reachableRevisions = new Set(heads.map((head) => head.storageRef))
    const reachableKeys = new Set(heads.map((head) => documentKey(head.logicalId)))
    const reachableSnapshots = new Set<string>()
    for (const head of heads) {
      const intent = await this.#loadIntent(head.logicalId, head)
      if (intent?.base.snapshotRef !== undefined) reachableSnapshots.add(intent.base.snapshotRef)
    }

    const orphans: OverlayOrphanRef[] = []
    let scanned = 0

    /* Immutable document revisions — the §34.8 "orphan revision" case proper. */
    for (const dir of await readdirSafe(this.layout.revisionsDir)) {
      if (!dir.isDirectory()) continue
      const revisionDir = join(this.layout.revisionsDir, dir.name)
      for (const file of await readdirSafe(revisionDir)) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        scanned += 1
        const ref = this.layout.relative(join(revisionDir, file.name))
        if (reachableRevisions.has(ref)) continue
        orphans.push({
          kind: 'revision',
          ref,
          reason: 'no manifest head references this revision',
        })
      }
    }

    if (options.includeSnapshots !== false) {
      for (const file of await readdirSafe(this.layout.snapshotsDir)) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        scanned += 1
        const ref = file.name.slice(0, -'.json'.length)
        if (reachableSnapshots.has(ref)) continue
        orphans.push({
          kind: 'snapshot',
          ref: this.layout.relative(this.layout.snapshotPath(ref)),
          reason: 'no intent references this base snapshot',
        })
      }
    }

    if (options.includeDocuments !== false) {
      for (const dir of await readdirSafe(this.layout.documentsDir)) {
        if (!dir.isDirectory()) continue
        scanned += 1
        if (reachableKeys.has(dir.name)) continue
        orphans.push({
          kind: 'document',
          ref: this.layout.relative(join(this.layout.documentsDir, dir.name)),
          reason: 'no manifest head references this document directory',
        })
      }
      for (const file of await readdirSafe(this.layout.materializedDir)) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        scanned += 1
        if (reachableKeys.has(file.name.slice(0, -'.json'.length))) continue
        orphans.push({
          kind: 'materialized',
          ref: this.layout.relative(join(this.layout.materializedDir, file.name)),
          reason: 'no manifest head references this materialized document',
        })
      }
    }

    /* Staging files a killed process could not unlink (§35.15 "Process stops
     * during local temporary write"). Nothing else reclaims them: the revision
     * and snapshot scans above only look at `.json`, and `documents/` only at
     * directories, so litter is invisible rather than misread — but it is still
     * disk that grows with every crash. */
    for (const stale of await this.#staleStagingFiles()) {
      scanned += 1
      orphans.push(stale)
    }

    const deleted: OverlayOrphanRef[] = []
    const failures: Array<{ref: string; reason: string}> = []
    if (options.dryRun !== true) {
      for (const orphan of orphans) {
        try {
          await rm(this.layout.resolve(orphan.ref), {recursive: true, force: true})
          deleted.push(orphan)
        } catch (error) {
          failures.push({ref: orphan.ref, reason: (error as Error).message})
        }
      }
    }

    return {
      overlayId,
      dryRun: options.dryRun === true,
      scanned,
      orphans,
      deleted,
      failures,
    }
  }

  /* ---------------------------------------------------------------- *
   * Local cleanup of `.runtime/` growth — PRD §15.7, §37 Phase 2
   * ---------------------------------------------------------------- */

  /**
   * Prune the runtime transaction log and its idempotency ledger.
   *
   * Deliberately NOT part of {@link FsOverlayStore.collectOrphans}. An orphan is
   * something nothing reaches; a transaction record is reachable forever by
   * design, and an idempotency pointer is the §34.6 deduplication authority.
   * Collecting either as garbage would silently trade an audit trail — and
   * exactly-once replay — for disk space. So the caller states a retention window
   * and is told, in the report, what that costs.
   *
   * The one removal that needs no window: a pointer naming a transaction file
   * that does not exist. `getTransaction` already answers `null` for it, so the
   * key already re-applies; deleting the file changes no behaviour and stops the
   * directory growing with records of nothing.
   *
   * Order of deletion is pointer, then record. A pointer that outlives its record
   * is the broken state; a record without a pointer is merely no longer
   * addressable by key, which is what pruning means.
   */
  async pruneRuntimeHistory(
    overlayId: string,
    options: PruneRuntimeHistoryOptions = {},
  ): Promise<RuntimeHistoryPruneReport> {
    return this.withOverlayLock(() => this.#pruneRuntimeHistoryLocked(overlayId, options))
  }

  async #pruneRuntimeHistoryLocked(
    overlayId: string,
    options: PruneRuntimeHistoryOptions,
  ): Promise<RuntimeHistoryPruneReport> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const transactionEntries = (await readdirSafe(this.layout.transactionsDir)).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    )
    /* Ascending by transaction ID, i.e. commit order (§13.10). */
    const log = await this.#readAllTransactions()
    const head = manifest.transactionHead ?? null

    const prunable = new Set<string>()
    if (options.keepLast !== undefined || options.keepAfterRevision !== undefined) {
      const cutoffIndex =
        options.keepLast === undefined
          ? log.length
          : Math.max(0, log.length - Math.max(0, options.keepLast))
      for (const [index, transaction] of log.entries()) {
        /* Both windows must agree before anything is removed: two retention
         * rules narrow what is pruned, they never widen it. */
        const byCount = options.keepLast === undefined || index < cutoffIndex
        const byRevision =
          options.keepAfterRevision === undefined ||
          transaction.overlayRevisionAfter <= options.keepAfterRevision
        if (byCount && byRevision) prunable.add(transaction.transactionId)
      }
    }
    /* §13.1: the manifest's `transactionHead` must keep naming a readable
     * record, so it survives any window. */
    if (head !== null) prunable.delete(head)

    const pointersDir = this.layout.idempotencyDir
    const pointerEntries = (await readdirSafe(pointersDir)).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    )

    const pointers: PrunedPointerRef[] = []
    const doomedPointerPaths: string[] = []
    for (const entry of pointerEntries) {
      assertSafeComponent(entry.name, 'idempotency pointer')
      const path = join(pointersDir, entry.name)
      const ref = this.layout.relative(path)
      const read = await this.#readJsonSoft<{transactionId?: unknown}>(path)
      const transactionId =
        read.ok && typeof read.value?.transactionId === 'string' ? read.value.transactionId : null

      if (transactionId === null) {
        pointers.push({ref, transactionId: null, reason: 'dangling'})
        doomedPointerPaths.push(path)
        continue
      }
      /* Existence, not parseability: a transaction file this store cannot parse
       * is corruption for `validate` to report, not a pointer to nothing. */
      if (!(await exists(this.layout.transactionPath(transactionId)))) {
        pointers.push({ref, transactionId, reason: 'dangling'})
        doomedPointerPaths.push(path)
        continue
      }
      if (prunable.has(transactionId)) {
        pointers.push({ref, transactionId, reason: 'pruned-transaction'})
        doomedPointerPaths.push(path)
      }
    }

    const transactions: PrunedTransactionRef[] = []
    for (const transaction of log) {
      if (!prunable.has(transaction.transactionId)) continue
      transactions.push({
        transactionId: transaction.transactionId,
        ref: this.layout.relative(this.layout.transactionPath(transaction.transactionId)),
        overlayRevisionAfter: transaction.overlayRevisionAfter,
      })
    }

    const failures: Array<{ref: string; reason: string}> = []
    if (options.dryRun !== true) {
      for (const [index, path] of doomedPointerPaths.entries()) {
        try {
          await rm(path, {force: true})
        } catch (error) {
          failures.push({ref: pointers[index]!.ref, reason: (error as Error).message})
        }
      }
      for (const entry of transactions) {
        try {
          await rm(this.layout.transactionPath(entry.transactionId), {force: true})
        } catch (error) {
          failures.push({ref: entry.ref, reason: (error as Error).message})
        }
      }
    }

    return {
      overlayId,
      dryRun: options.dryRun === true,
      scannedTransactions: transactionEntries.length,
      scannedPointers: pointerEntries.length,
      transactions,
      pointers,
      retainedHead: head,
      failures,
    }
  }

  /* ---------------------------------------------------------------- *
   * §35.7 "Checksum corruption detection"
   * ---------------------------------------------------------------- */

  async verifyChecksums(overlayId: string): Promise<OverlayChecksumReport> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)

    const issues: OverlayChecksumIssue[] = []
    const missing: OverlayOrphanRef[] = []
    let checked = 0

    for (const logicalId of Object.keys(manifest.documentHeads).sort()) {
      const head = manifest.documentHeads[logicalId]!

      /* Content-addressed revision: filename and head checksum must both match. */
      const revisionPath = this.layout.resolve(head.storageRef)
      const revision = await this.#readJsonSoft<OverlayDocumentRecord>(revisionPath)
      let revisionPresent = false
      if (!revision.missing) {
        revisionPresent = true
        checked += 1
        if (!revision.ok || revision.value === undefined) {
          issues.push({
            kind: 'revision',
            ref: head.storageRef,
            logicalId,
            expected: head.checksum,
            actual: '<unparseable>',
            repairable: false,
          })
        } else {
          const actual = canonicalChecksum(revision.value)
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
      }

      /* Review-facing intent: a stale checksum here is repairable metadata (§14.3). */
      const intentPath = this.layout.intentPath(logicalId)
      const intentRead = await this.#readJsonSoft<CheckpointDocumentIntent>(intentPath)
      if (!intentRead.missing) {
        checked += 1
        if (!intentRead.ok || intentRead.value === undefined) {
          issues.push({
            kind: 'intent',
            ref: this.layout.relative(intentPath),
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
              ref: this.layout.relative(intentPath),
              logicalId,
              expected: intentRead.value.checksum,
              actual,
              repairable: true,
            })
          }
        }
      } else if (!revisionPresent) {
        /* §34.3 — a head must reach an immutable revision *or* a valid canonical
         * filesystem record. Both are gone. */
        missing.push({
          kind: 'manifest-head',
          ref: head.storageRef,
          logicalId,
          reason: 'neither the immutable revision nor the canonical intent file exists',
        })
      }
    }

    /* Content-addressed base snapshots: the filename is the identity. */
    for (const file of await readdirSafe(this.layout.snapshotsDir)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      checked += 1
      const ref = file.name.slice(0, -'.json'.length)
      const path = join(this.layout.snapshotsDir, file.name)
      const read = await this.#readJsonSoft<OverlayBaseSnapshot>(path)
      if (!read.ok || read.value === undefined) {
        issues.push({
          kind: 'snapshot',
          ref,
          expected: ref,
          actual: '<unparseable>',
          repairable: false,
        })
        continue
      }
      const actual = canonicalChecksum(read.value)
      if (actual !== ref) {
        issues.push({kind: 'snapshot', ref, expected: ref, actual, repairable: false})
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

  /* ---------------------------------------------------------------- *
   * Direct edits — PRD §14.3, §14.4, §35.9
   * ---------------------------------------------------------------- */

  async revalidate(
    overlayId: string,
    options: RevalidateOptions = {},
  ): Promise<FsOverlayRevalidationReport> {
    const invalid: OverlayRevalidationFailure[] = []
    const changed: string[] = []
    const repairedChecksums: string[] = []
    const regenerated: string[] = []

    /* Step 2-3 for the manifest itself. */
    const manifestRead = await this.#readManifestFile()
    let manifestChanged = false
    if (manifestRead.missing) {
      throw new OverlayNotFoundError(`Overlay ${JSON.stringify(overlayId)}`, {
        root: this.layout.root,
      })
    }
    if (!manifestRead.ok || manifestRead.value === undefined) {
      const brokenCopyRef = await this.#writeBrokenCopy(
        this.layout.manifestPath,
        manifestRead.raw ?? '',
      )
      const failure: OverlayRevalidationFailure = {
        kind: 'manifest',
        ref: this.layout.relative(this.layout.manifestPath),
        code: manifestRead.error?.code ?? 'OVERLAY_STORE_CORRUPT',
        message: manifestRead.error?.message ?? 'manifest is not valid JSON',
      }
      if (brokenCopyRef !== null) failure.brokenCopyRef = brokenCopyRef
      invalid.push(failure)
    } else {
      manifestChanged = manifestRead.raw !== this.#lastValidManifestBytes
      this.#cacheManifest(manifestRead.value, manifestRead.raw ?? null)
    }

    const manifest = this.#lastValidManifest
    if (manifest === null) {
      return {
        overlayId,
        ok: false,
        checked: 0,
        changed,
        repairedChecksums,
        regenerated,
        invalid,
        manifestChanged,
      }
    }
    this.#assertIdentity(overlayId, manifest)

    const logicalIds =
      options.logicalIds !== undefined
        ? [...options.logicalIds].map(toPublishedId)
        : Object.keys(manifest.documentHeads).sort()

    let checked = 0
    for (const logicalId of logicalIds) {
      const path = this.layout.intentPath(logicalId)
      let read = await this.#readJsonSoft<CheckpointDocumentIntent>(path)
      if (read.missing) {
        /* Recovery, and it is reported rather than performed silently: a review
         * surface that reappeared without explanation is indistinguishable from
         * one that was never lost. `regenerated` names every file rebuilt. */
        const head = manifest.documentHeads[logicalId]
        const rebuilt = head === undefined ? null : await this.#regenerateIntent(head)
        if (rebuilt === null) {
          invalid.push({
            kind: 'intent',
            ref: this.layout.relative(path),
            logicalId,
            code: 'OVERLAY_NOT_FOUND',
            message: 'manifest head has no intent file and no revision to rebuild it from',
          })
          continue
        }
        regenerated.push(this.layout.relative(path))
        read = await this.#readJsonSoft<CheckpointDocumentIntent>(path)
        if (read.missing) {
          invalid.push({
            kind: 'intent',
            ref: this.layout.relative(path),
            logicalId,
            code: 'OVERLAY_NOT_FOUND',
            message: 'manifest head has no intent file and it could not be rewritten',
          })
          continue
        }
      }
      checked += 1

      if (!read.ok || read.value === undefined) {
        /* §14.3 — refuse, retain the last valid in-memory state, write `.broken`. */
        const brokenCopyRef = await this.#writeBrokenCopy(path, read.raw ?? '')
        const failure: OverlayRevalidationFailure = {
          kind: 'intent',
          ref: this.layout.relative(path),
          logicalId,
          code: read.error?.code ?? 'OVERLAY_STORE_CORRUPT',
          message: read.error?.message ?? 'intent.json is not valid JSON',
        }
        if (brokenCopyRef !== null) failure.brokenCopyRef = brokenCopyRef
        invalid.push(failure)
        continue
      }

      /* Step 3-4 — structural validation, including the snapshot reference. */
      const problem = await this.#validateIntent(read.value, logicalId)
      if (problem !== null) {
        invalid.push({
          kind: 'intent',
          ref: this.layout.relative(path),
          logicalId,
          code: 'OVERLAY_STORE_CORRUPT',
          message: problem,
        })
        continue
      }

      if (read.raw !== this.#lastValidIntents.get(logicalId)?.bytes) changed.push(logicalId)

      /* Step 7 — recompute checksums (§14.3 MUST; stale is repairable, not fatal). */
      let intent = read.value
      const recomputed = intentChecksum(intent)
      if (recomputed !== intent.checksum && options.repairChecksums !== false) {
        intent = {...intent, checksum: recomputed}
        await this.#writeJson(path, intent)
        repairedChecksums.push(this.layout.relative(path))
      }
      this.#lastValidIntents.set(logicalId, {intent, bytes: serialize(intent)})
      this.#conflictCounts.set(logicalId, countConflicts(intent))
    }

    return {
      overlayId,
      ok: invalid.length === 0,
      checked,
      changed,
      repairedChecksums,
      regenerated,
      invalid,
      manifestChanged,
    }
  }

  async repairChecksums(overlayId: string): Promise<RepairChecksumsResult> {
    return this.withOverlayLock(() => this.#repairChecksumsLocked(overlayId))
  }

  async #repairChecksumsLocked(overlayId: string): Promise<RepairChecksumsResult> {
    const report = await this.verifyChecksums(overlayId)
    const repaired: string[] = []
    const unrepairable: OverlayChecksumIssue[] = []

    for (const issue of report.issues) {
      if (!issue.repairable || issue.kind !== 'intent' || issue.logicalId === undefined) {
        unrepairable.push(issue)
        continue
      }
      const path = this.layout.intentPath(issue.logicalId)
      const read = await this.#readJsonSoft<CheckpointDocumentIntent>(path)
      if (!read.ok || read.value === undefined) {
        unrepairable.push(issue)
        continue
      }
      const problem = await this.#validateIntent(read.value, issue.logicalId)
      if (problem !== null) {
        /* §14.3 only makes a *semantically valid* file's checksum repairable. */
        unrepairable.push(issue)
        continue
      }
      const intent = {...read.value, checksum: intentChecksum(read.value)}
      await this.#writeJson(path, intent)
      this.#lastValidIntents.set(issue.logicalId, {intent, bytes: serialize(intent)})
      repaired.push(this.layout.relative(path))
    }

    return {overlayId, repaired, unrepairable}
  }

  /* ---------------------------------------------------------------- *
   * Reset — PRD §29.8, §14.5 `sanity-overlay reset [documentId]`
   * ---------------------------------------------------------------- */

  async resetDocument(
    overlayId: string,
    logicalId: string,
    options: {actor?: OverlayActor} = {},
  ): Promise<OverlayResetResult> {
    return this.withOverlayLock(() => this.#resetDocumentLocked(overlayId, logicalId, options))
  }

  async #resetDocumentLocked(
    overlayId: string,
    logicalId: string,
    options: {actor?: OverlayActor},
  ): Promise<OverlayResetResult> {
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    this.#assertWritable(manifest)

    const normalized = toPublishedId(logicalId)
    if (manifest.documentHeads[normalized] === undefined) {
      throw new OverlayNotFoundError(`Document ${JSON.stringify(normalized)}`, {overlayId})
    }

    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    if (options.actor !== undefined) next.updatedBy = options.actor
    const heads = {...manifest.documentHeads}
    delete heads[normalized]
    next.documentHeads = heads
    this.#conflictCounts.delete(normalized)
    this.#lastValidIntents.delete(normalized)
    await this.#applyConflictSummary(next, [])
    await this.#writeManifest(next)

    const removedRefs = await this.#removeDocumentArtifacts(normalized)
    return {manifest: clone(next), removedDocumentIds: [normalized], removedRefs}
  }

  async resetOverlay(
    overlayId: string,
    options: ResetOverlayOptions,
  ): Promise<OverlayResetResult> {
    return this.withOverlayLock(() => this.#resetOverlayLocked(overlayId, options))
  }

  async #resetOverlayLocked(
    overlayId: string,
    options: ResetOverlayOptions,
  ): Promise<OverlayResetResult> {
    if (options?.confirm !== true) {
      throw new OverlayInvalidRequestError(
        'resetOverlay requires {confirm: true} (PRD §29.8 "Reset all documents after confirmation")',
      )
    }
    const manifest = await this.#loadManifest()
    this.#assertIdentity(overlayId, manifest)
    this.#assertWritable(manifest)

    const removedDocumentIds = Object.keys(manifest.documentHeads).sort()

    const next = clone(manifest)
    next.revision = manifest.revision + 1
    next.updatedAt = this.#now()
    if (options.actor !== undefined) next.updatedBy = options.actor
    next.documentHeads = {}
    next.conflictSummary = {total: 0, hard: 0, soft: 0}
    await this.#writeManifest(next)

    /* The transaction log and idempotency index survive: §34.6 keeps one key
     * bound to one immutable result even across a reset. */
    const removedRefs: string[] = []
    for (const dir of [
      this.layout.documentsDir,
      this.layout.snapshotsDir,
      this.layout.materializedDir,
      this.layout.revisionsDir,
    ]) {
      removedRefs.push(this.layout.relative(dir))
      await rm(dir, {recursive: true, force: true})
      await mkdir(dir, {recursive: true})
    }
    this.#conflictCounts.clear()
    this.#lastValidIntents.clear()

    return {manifest: clone(next), removedDocumentIds, removedRefs}
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

  #resetCaches(): void {
    this.#lastValidManifest = null
    this.#lastValidManifestBytes = null
    this.#lastValidIntents.clear()
    this.#conflictCounts.clear()
    this.#diagnosed.clear()
  }

  #cacheManifest(manifest: OverlayManifest, bytes: string | null): void {
    this.#lastValidManifest = manifest
    this.#lastValidManifestBytes = bytes
  }

  async #scaffold(): Promise<void> {
    await Promise.all(
      [
        this.layout.documentsDir,
        this.layout.snapshotsDir,
        this.layout.materializedDir,
        this.layout.transactionsDir,
        this.layout.revisionsDir,
        this.layout.indexesDir,
        /* §14.1 reserves `.locks/` and `.gitignore`s it; the writer critical
         * section needs it to exist, so it is scaffolded rather than conjured on
         * first contention. */
        this.layout.resolve(LOCKS_DIR),
      ].map((dir) => mkdir(dir, {recursive: true})),
    )
    await Promise.all([
      this.#writeIfAbsent(this.layout.resolve(GITATTRIBUTES_FILE), GITATTRIBUTES_CONTENT),
      this.#writeIfAbsent(this.layout.resolve(GITIGNORE_FILE), GITIGNORE_CONTENT),
      this.#writeIfAbsent(this.layout.resolve(README_FILE), README_CONTENT),
    ])
  }

  async #writeIfAbsent(path: string, contents: string): Promise<void> {
    if (await exists(path)) return
    await this.#writeText(path, contents)
  }

  /**
   * The one write primitive: temp file, fsync, rename (PRD §14.3 MUST).
   *
   * The temporary name is random so two processes writing the same target cannot
   * clobber each other's staging file; the rename itself is the atomic step. On
   * any failure the temporary file is removed, so a failed write leaves neither a
   * partial target nor litter.
   */
  async #writeText(
    targetPath: string,
    contents: string,
    guard?: () => Promise<void>,
  ): Promise<void> {
    const dir = dirname(targetPath)
    await mkdir(dir, {recursive: true})
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`)
    try {
      if (this.#fsync) {
        const handle = await open(tempPath, 'wx', 0o644)
        try {
          await handle.writeFile(contents, 'utf8')
          try {
            await handle.sync()
          } catch {
            /* Some filesystems reject fsync on a regular file; the rename still
             * gives atomicity, only the durability guarantee weakens. */
          }
        } finally {
          await handle.close()
        }
      } else {
        await writeFile(tempPath, contents, {encoding: 'utf8', mode: 0o644, flag: 'wx'})
      }
      if (this.#hooks.beforeRename !== undefined) {
        await this.#hooks.beforeRename({tempPath, targetPath})
      }
      /* Last statement before the atomic step, deliberately: a precondition
       * checked any earlier is a precondition something can invalidate in the
       * gap. Running it after the hook is what lets the §35.9 injection point
       * script the very interleaving the guard exists to catch. */
      if (guard !== undefined) await guard()
      await rename(tempPath, targetPath)
    } catch (error) {
      await rm(tempPath, {force: true}).catch(() => undefined)
      throw error
    }
  }

  /** Canonical JSON write (PRD §14.3 determinism rules) through the atomic primitive. */
  async #writeJson(targetPath: string, value: unknown): Promise<string> {
    const text = serialize(value)
    await this.#writeText(targetPath, text)
    return text
  }

  /**
   * Publish a new manifest, refusing to overwrite one that moved underneath us.
   *
   * The `.locks/` critical section excludes every writer that goes through this
   * store. It cannot exclude the writer PRD §14.4 explicitly invites — an agent
   * or a Git merge rewriting the files directly — and it cannot exclude a process
   * from an older build. So the revision the caller based its work on is
   * re-read from disk here, immediately before the rename, and a mismatch is a
   * write conflict rather than a silent overwrite.
   *
   * `#manifestBaseRevision` is set by `#loadManifest` inside a locked call and
   * cleared when the lock is released, so an unlocked write path (there are none
   * today) simply skips the check rather than comparing against a stale number.
   */
  async #writeManifest(manifest: OverlayManifest): Promise<void> {
    const expected = this.#manifestBaseRevision
    const text = serialize(manifest)
    await this.#writeText(this.layout.manifestPath, text, async () => {
      if (expected === null) return
      const current = await this.#readManifestFile()
      if (current.missing || !current.ok || typeof current.value?.revision !== 'number') return
      if (current.value.revision !== expected) {
        throw new OverlayWriteConflictError(manifest.overlayId, expected, current.value.revision)
      }
    })
    this.#manifestBaseRevision = manifest.revision
    this.#cacheManifest(clone(manifest), text)
  }

  async #readManifestFile(): Promise<SoftRead<OverlayManifest>> {
    const read = await this.#readJsonSoft<OverlayManifest>(this.layout.manifestPath)
    if (read.missing || !read.ok || read.value === undefined) return read
    const problem = validateManifestShape(read.value)
    if (problem !== null) {
      return {
        ok: false,
        missing: false,
        raw: read.raw,
        error: {code: 'OVERLAY_STORE_CORRUPT', message: problem},
      }
    }
    return read
  }

  /**
   * Load the manifest, honouring §14.3 "Refuse malformed JSON and retain the last
   * valid in-memory state": a malformed file never becomes current state, and the
   * last valid parse keeps serving reads while the diagnostic copy is written.
   */
  async #loadManifest(): Promise<OverlayManifest> {
    const read = await this.#readManifestFile()
    if (read.missing) {
      this.#resetCaches()
      throw new OverlayNotFoundError('Overlay manifest', {path: this.layout.manifestPath})
    }
    if (!read.ok || read.value === undefined) {
      await this.#writeBrokenCopy(this.layout.manifestPath, read.raw ?? '')
      if (this.#lastValidManifest !== null) return this.#lastValidManifest
      throw new OverlayStoreCorruptError(
        this.layout.relative(this.layout.manifestPath),
        read.error?.message ?? 'manifest is not valid JSON',
      )
    }
    this.#cacheManifest(read.value, read.raw ?? null)
    this.#manifestBaseRevision = read.value.revision
    return read.value
  }

  /**
   * Rebuild `documents/<id>/intent.json` from the head's immutable revision.
   *
   * The intent is a projection: `intentFromRecord` is a pure function of the
   * content-addressed record the manifest head already names, so regenerating it
   * cannot invent content. This is the recovery half of the commit-point rule —
   * a projection write that failed, or a file a human deleted, is repaired from
   * durable state rather than reported as corruption (§34.2 "deleting a local
   * file alone does not represent a content delete").
   *
   * Only ever called when the file is ABSENT. A file that is present but
   * different is a direct edit (§14.4) and belongs to `revalidate`, not here;
   * overwriting it would silently discard an agent's work.
   */
  async #regenerateIntent(head: OverlayDocumentHead): Promise<CheckpointDocumentIntent | null> {
    const record = await this.#readRecordByRef(head.storageRef).catch(() => null)
    if (record === null) return null
    const snapshot = baseSnapshotFrom(record)
    const intent = intentFromRecord(
      record,
      snapshot === null ? {} : {snapshotRef: canonicalChecksum(snapshot)},
    )
    const logicalId = toPublishedId(record.logicalId)
    const bytes = serialize(intent)
    /* Best effort: a read must still answer if the disk is still unwritable. */
    await this.#writeText(this.layout.intentPath(logicalId), bytes).catch(() => undefined)
    this.#lastValidIntents.set(logicalId, {intent, bytes})
    this.#conflictCounts.set(logicalId, countConflicts(intent))
    return intent
  }

  /** Same last-valid-state rule for the review-facing intent files. */
  async #loadIntent(
    logicalId: string,
    head?: OverlayDocumentHead,
  ): Promise<CheckpointDocumentIntent | null> {
    const normalized = toPublishedId(logicalId)
    const path = this.layout.intentPath(normalized)
    const read = await this.#readJsonSoft<CheckpointDocumentIntent>(path)
    if (read.missing) {
      if (head !== undefined) {
        const regenerated = await this.#regenerateIntent(head)
        if (regenerated !== null) return regenerated
      }
      return this.#lastValidIntents.get(normalized)?.intent ?? null
    }
    if (!read.ok || read.value === undefined) {
      await this.#writeBrokenCopy(path, read.raw ?? '')
      return this.#lastValidIntents.get(normalized)?.intent ?? null
    }
    assertFormatVersion(read.value.formatVersion)
    this.#lastValidIntents.set(normalized, {intent: read.value, bytes: read.raw ?? ''})
    this.#conflictCounts.set(normalized, countConflicts(read.value))
    return read.value
  }

  async #readSnapshot(ref: string): Promise<OverlayBaseSnapshot | null> {
    const path = this.layout.snapshotPath(ref)
    const read = await this.#readJsonSoft<OverlayBaseSnapshot>(path)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(
        this.layout.relative(path),
        read.error?.message ?? 'snapshot is not valid JSON',
      )
    }
    return read.value
  }

  async #readRecordByRef(storageRef: string): Promise<OverlayDocumentRecord | null> {
    if (typeof storageRef !== 'string' || storageRef.length === 0) {
      throw new OverlayInvalidRequestError('storageRef must be a non-empty string', {storageRef})
    }
    /* `resolve` asserts containment: a `..` in a storage ref never opens a file
     * outside the overlay root (PRD §35.9). */
    const path = this.layout.resolve(storageRef)
    const read = await this.#readJsonSoft<OverlayDocumentRecord>(path)
    if (read.missing) return null
    if (!read.ok || read.value === undefined) {
      throw new OverlayStoreCorruptError(
        this.layout.relative(path),
        read.error?.message ?? 'document revision is not valid JSON',
      )
    }
    assertFormatVersion(read.value.formatVersion)
    return read.value
  }

  async #readJsonSoft<T>(path: string): Promise<SoftRead<T>> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {ok: false, missing: true}
      throw error
    }
    try {
      return {ok: true, missing: false, raw, value: parse(raw) as T}
    } catch (error) {
      return {
        ok: false,
        missing: false,
        raw,
        error: {
          code: (error as {code?: string}).code ?? 'OVERLAY_CANONICAL_JSON_INVALID',
          message: (error as Error).message,
        },
      }
    }
  }

  /**
   * PRD §14.3 SHOULD — "Write a `.broken` diagnostic copy when direct edits fail
   * parsing." Written once per distinct broken content so a polling caller does
   * not rewrite it on every read.
   */
  async #writeBrokenCopy(path: string, contents: string): Promise<string | null> {
    const key = `${path}\0${canonicalChecksum(contents)}`
    if (this.#diagnosed.has(key)) return `${this.layout.relative(path)}${BROKEN_SUFFIX}`
    const brokenPath = `${path}${BROKEN_SUFFIX}`
    try {
      await writeFile(brokenPath, contents, 'utf8')
      this.#diagnosed.add(key)
      return `${this.layout.relative(path)}${BROKEN_SUFFIX}`
    } catch {
      return null
    }
  }

  /**
   * Write the immutable artifacts for one record and derive its head.
   *
   * Nothing here is reachable until a manifest head names the returned
   * `storageRef`, which is what makes the manifest rename the commit point.
   */
  async #writeImmutable(overlayId: string, record: OverlayDocumentRecord): Promise<ImmutableWrite> {
    if (record?.logicalId === undefined || typeof record.logicalId !== 'string') {
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
    const revisionPath = this.layout.revisionPath(logicalId, recordChecksum)
    const storageRef = this.layout.relative(revisionPath)

    /* Both artifacts are content-addressed and therefore immutable: an existing
     * file already holds identical bytes, so writing is skipped rather than
     * repeated (PRD §14.3 "one immutable snapshot per captured base state"). */
    await Promise.all([
      snapshot === null
        ? undefined
        : this.#writeIfAbsent(this.layout.snapshotPath(snapshotRef!), serialize(snapshot)),
      this.#writeIfAbsent(revisionPath, serialize(normalized)),
    ])

    const head = documentHeadFromRecord(normalized, {storageRef, checksum: recordChecksum})

    const write: ImmutableWrite = {
      logicalId,
      record: normalized,
      storageRef,
      checksum: recordChecksum,
      head,
    }
    if (snapshotRef !== undefined) write.snapshotRef = snapshotRef
    return write
  }

  /** Regenerable projections: the review-facing intent and the materialized document. */
  async #writeProjections(write: ImmutableWrite): Promise<void> {
    const options = write.snapshotRef === undefined ? {} : {snapshotRef: write.snapshotRef}
    const intent = intentFromRecord(write.record, options)
    const path = this.layout.intentPath(write.logicalId)
    const bytes = serialize(intent)
    await Promise.all([this.#writeText(path, bytes), this.#writeMaterialized(write.record)])
    /* Cached only once the bytes are on disk. Seeding the cache first would make
     * the writing process serve an intent that no cold reader can see — the
     * longest possible fuse on a projection that failed to write. */
    this.#lastValidIntents.set(write.logicalId, {intent, bytes})
    this.#conflictCounts.set(write.logicalId, countConflicts(intent))
  }

  async #writeMaterialized(record: OverlayDocumentRecord): Promise<void> {
    const logicalId = toPublishedId(record.logicalId)
    const file: MaterializedDocumentFile = {
      formatVersion: OVERLAY_FORMAT_VERSION,
      logicalId,
      schemaType: record.schemaType,
      runtimeRevision: record.runtimeRevision,
      generatedAt: this.#now(),
      draft: record.local.draftTombstone ? null : (record.local.draft?.materialized ?? null),
      published: record.local.publishedTombstone
        ? null
        : (record.local.published?.materialized ?? null),
    }
    await this.#writeJson(this.layout.materializedPath(logicalId), file)
  }

  async #removeDocumentArtifacts(logicalId: string): Promise<string[]> {
    const targets = [
      this.layout.documentDir(logicalId),
      this.layout.materializedPath(logicalId),
      this.layout.revisionDir(logicalId),
    ]
    const removed: string[] = []
    for (const target of targets) {
      removed.push(this.layout.relative(target))
      await rm(target, {recursive: true, force: true})
    }
    this.#lastValidIntents.delete(logicalId)
    this.#conflictCounts.delete(logicalId)
    return removed
  }

  /**
   * Every `.tmp-` staging file old enough to be certain no writer still holds it.
   *
   * Two guards, not one. The `.locks/` critical section this runs inside already
   * excludes every writer that goes through a store, so a surviving staging file
   * is almost certainly abandoned; the age threshold covers what the lock cannot
   * — a writer from an older build, or one whose lock was broken as stale. The
   * cost of being wrong is an `ENOENT` at a live writer's rename, so the check
   * is deliberately conservative.
   *
   * The reported `kind` is the kind of artifact the file was on its way to
   * becoming, which is what its directory says.
   */
  async #staleStagingFiles(): Promise<OverlayOrphanRef[]> {
    const cutoff = Date.now() - this.#staleTempMs
    const found: OverlayOrphanRef[] = []

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdirSafe(dir)) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          /* `.locks/` holds the live lock this very call is standing on. */
          if (path === this.layout.resolve(LOCKS_DIR)) continue
          await walk(path)
          continue
        }
        if (!entry.name.startsWith(TEMP_PREFIX)) continue
        const stats = await stat(path).catch(() => null)
        if (stats === null || stats.mtimeMs > cutoff) continue
        found.push({
          kind: stagingArtifactKind(this.layout, path),
          ref: this.layout.relative(path),
          reason: 'staging file left by an interrupted atomic write',
        })
      }
    }

    await walk(this.layout.root)
    return found
  }

  /** Recompute `manifest.conflictSummary` from every current document (PRD §13.1). */
  async #applyConflictSummary(
    manifest: OverlayManifest,
    updated: readonly OverlayDocumentRecord[],
  ): Promise<void> {
    for (const record of updated) {
      const logicalId = toPublishedId(record.logicalId)
      let hard = 0
      let soft = 0
      for (const conflict of record.conflicts) {
        if (conflict.resolution !== undefined) continue
        if (conflict.severity === 'hard') hard += 1
        else soft += 1
      }
      this.#conflictCounts.set(logicalId, {hard, soft})
    }

    let hard = 0
    let soft = 0
    for (const logicalId of Object.keys(manifest.documentHeads)) {
      let counts = this.#conflictCounts.get(logicalId)
      if (counts === undefined) {
        const intent = await this.#loadIntent(logicalId)
        counts = intent === null ? {hard: 0, soft: 0} : countConflicts(intent)
        this.#conflictCounts.set(logicalId, counts)
      }
      hard += counts.hard
      soft += counts.soft
    }
    manifest.conflictSummary = {total: hard + soft, hard, soft}
  }

  #applyRetention(manifest: OverlayManifest, retention: OverlayRetentionPolicy): void {
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

  async #allocateTransactionId(overlayId: string, timestamp: string): Promise<string> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const sequence = this.#sequence
      this.#sequence += 1
      const transactionId = this.#newTransactionId({overlayId, timestamp, sequence})
      if (!(await exists(this.layout.transactionPath(transactionId)))) return transactionId
    }
    /* istanbul ignore next -- unreachable without a pathological ID factory. */
    throw new OverlayInvalidRequestError('Could not allocate a unique transaction ID')
  }

  async #readAllTransactions(): Promise<OverlayTransactionRecord[]> {
    const entries = await readdirSafe(this.layout.transactionsDir)
    const transactions: OverlayTransactionRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const read = await this.#readJsonSoft<OverlayTransactionRecord>(
        join(this.layout.transactionsDir, entry.name),
      )
      if (read.ok && read.value !== undefined) transactions.push(read.value)
    }
    return transactions.sort((a, b) =>
      a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
    )
  }

  /** PRD §14.4 step 3-4: validate IDs, type, paths, draft/published consistency, snapshot ref. */
  async #validateIntent(
    intent: CheckpointDocumentIntent,
    expectedLogicalId: string,
  ): Promise<string | null> {
    if (intent.formatVersion !== OVERLAY_FORMAT_VERSION) {
      return `unsupported formatVersion ${JSON.stringify(intent.formatVersion)}`
    }
    if (typeof intent.logicalId !== 'string' || intent.logicalId.length === 0) {
      return 'logicalId must be a non-empty string'
    }
    if (toPublishedId(intent.logicalId) !== expectedLogicalId) {
      return `logicalId ${JSON.stringify(intent.logicalId)} does not match its directory (${expectedLogicalId})`
    }
    if (typeof intent.type !== 'string' || intent.type.length === 0) {
      return 'type must be a non-empty string'
    }
    if (
      typeof intent.tombstones !== 'object' ||
      intent.tombstones === null ||
      typeof intent.tombstones.draft !== 'boolean' ||
      typeof intent.tombstones.published !== 'boolean'
    ) {
      return 'tombstones must carry boolean `draft` and `published` flags'
    }
    if (!Array.isArray(intent.touchedPaths)) return 'touchedPaths must be an array'
    for (const path of intent.touchedPaths) {
      if (!Array.isArray(path)) return 'every touched path must be an array of segments'
      try {
        encodeOverlayPath(path)
      } catch (error) {
        return `invalid touched path: ${(error as Error).message}`
      }
    }
    if (!Array.isArray(intent.conflicts)) return 'conflicts must be an array'
    if (typeof intent.checksum !== 'string') return 'checksum must be a string'

    /* §34.1 — at most one current local state per perspective, so a tombstone and
     * a local state for the same perspective cannot both be present. */
    if (intent.tombstones.draft && intent.draft !== undefined) {
      return 'a draft tombstone cannot coexist with a local draft state'
    }
    if (intent.tombstones.published && intent.published !== undefined) {
      return 'a published tombstone cannot coexist with a local published state'
    }

    for (const [perspective, state] of [
      ['draft', intent.draft],
      ['published', intent.published],
    ] as Array<[string, OverlayIntentState | undefined]>) {
      if (state === undefined) continue
      if (state.mode !== 'patch' && state.mode !== 'replace') {
        return `${perspective}.mode must be "patch" or "replace"`
      }
      if (state.mode === 'replace') {
        const replacement = state.replacement
        if (
          typeof replacement !== 'object' ||
          replacement === null ||
          typeof replacement._type !== 'string'
        ) {
          return `${perspective} uses mode "replace" but carries no replacement document`
        }
      }
      if (state.overrides !== undefined) {
        if (!Array.isArray(state.overrides)) return `${perspective}.overrides must be an array`
        for (const override of state.overrides) {
          if (
            typeof override !== 'object' ||
            override === null ||
            !Array.isArray((override as {path?: unknown}).path)
          ) {
            return `${perspective}.overrides entries must be {path, value}`
          }
        }
      }
      if (state.unsets !== undefined && !Array.isArray(state.unsets)) {
        return `${perspective}.unsets must be an array`
      }
    }

    if (intent.base.snapshotRef !== undefined) {
      if (!isChecksum(intent.base.snapshotRef)) {
        return `base.snapshotRef ${JSON.stringify(intent.base.snapshotRef)} is not a SHA-256 content address`
      }
      if (!(await exists(this.layout.snapshotPath(intent.base.snapshotRef)))) {
        return `base.snapshotRef ${intent.base.snapshotRef} names a snapshot that is not stored`
      }
    }

    return null
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

function countConflicts(intent: CheckpointDocumentIntent): {hard: number; soft: number} {
  let hard = 0
  let soft = 0
  for (const conflict of intent.conflicts) {
    if (conflict.resolved) continue
    if (conflict.severity === 'hard') hard += 1
    else soft += 1
  }
  return {hard, soft}
}

/**
 * SHA-256 over the canonical bundle without its own `checksum` field.
 *
 * Re-exported, not redefined: the bundle checksum is part of the transfer format
 * (PRD §35.7 export/import), so every adapter must compute it identically.
 */
export {bundleChecksum} from './contract'

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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readdirSafe(
  path: string,
): Promise<Array<{name: string; isFile(): boolean; isDirectory(): boolean}>> {
  try {
    return await readdir(path, {withFileTypes: true})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * What a staging file was on its way to becoming, from where it sits.
 *
 * `OverlayArtifactKind` has no `temp` member and adding one would break every
 * exhaustive consumer of the contract for a purely cosmetic gain, so litter is
 * reported as the kind of the artifact it belongs to; the `reason` string is
 * what says it is a staging file.
 */
function stagingArtifactKind(layout: OverlayLayout, path: string): OverlayArtifactKind {
  if (path.startsWith(layout.revisionsDir)) return 'revision'
  if (path.startsWith(layout.snapshotsDir)) return 'snapshot'
  if (path.startsWith(layout.materializedDir)) return 'materialized'
  if (path.startsWith(layout.documentsDir)) return 'document'
  return 'manifest'
}

/**
 * Default transaction ID: `tx-<compacted timestamp>-<sequence>-<digest>`.
 *
 * Lexicographically ordered by commit time and then by sequence, as PRD §13.10
 * MUSTs, and derived only from the injected clock so it stays deterministic.
 */
function defaultTransactionId(context: {
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
