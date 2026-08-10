/**
 * `FsOverlayAssetStore` — the filesystem provider for branch-local assets
 * (PRD §24.3 steps 2-3, §24.5, §24.6; §14.1 layout; §14.3 atomicity).
 *
 * ```text
 * .sanity-overlay/assets/
 *   blobs/<sha256>.bin                  opaque bytes, addressed by content
 *   records/<assetDocumentId>.json      canonical §24.2 record, review-facing
 * ```
 *
 * ## Why two directories rather than `assets/<assetId>/`
 *
 * PRD §24.3 step 3 sketches a per-asset directory. Splitting bytes from metadata
 * buys the property the whole feature rests on: **the blob is addressed by what it
 * contains, the record by what it is called.** Two uploads of the same picture
 * under different filenames produce one blob *and* one record, because both
 * addresses are functions of the bytes (SHA-256 and SHA-1 respectively — see
 * `core/assets/upload.ts`). Deduplication is therefore structural, not a pass that
 * runs afterwards and can be skipped.
 *
 * It also keeps the review surface honest: `records/` is canonical JSON a reviewer
 * reads and Git diffs; `blobs/` is marked `binary` in `.gitattributes` so Git never
 * line-ending-converts content whose checksum is its identity.
 *
 * ## Ordering and crash safety
 *
 * The same two rules as {@link FsOverlayStore}:
 *
 * 1. every write is temp-file + rename (§14.3 MUST), so a reader sees whole old
 *    bytes or whole new bytes and never a half-written image;
 * 2. **the record is the commit point.** The blob is written first and is
 *    unreachable until a record names it. A crash between the two leaves an
 *    orphan blob — reclaimable, and invisible to every reader — rather than a
 *    record pointing at bytes that do not exist.
 *
 * ## What it will not do
 *
 * Nothing here uploads to Sanity (owner ruling 2026-08-05, PRD §0.0). The
 * provider abstraction exists for the §24.4 private-Vercel-Blob path, which is
 * designed for and not built: it would implement the same `put`/`readBlob`
 * surface against a signed, private namespace, and `OverlayAssetRecord.provider`
 * already distinguishes the two.
 */
import {randomUUID} from 'node:crypto'
import {mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {
  OVERLAY_FORMAT_VERSION,
  OverlayAssetError,
  assertAssetDeletable,
  isOverlayAssetDocumentId,
  parse,
  planAssetUpload,
  serialize,
  sha256Hex,
  synthesizeAssetDocument,
} from 'sanity-overlay-core'
import type {
  OverlayActor,
  OverlayAssetProvider,
  OverlayAssetRecord,
  OverlayFormatVersion,
  OverlayState,
  SanityDocument,
} from 'sanity-overlay-core'
import {GITATTRIBUTES_CONTENT, GITATTRIBUTES_FILE, OverlayLayout, TEMP_PREFIX} from './layout'

/** Injected clock, exactly as {@link FsOverlayStore} takes one (PRD §14.3). */
export type OverlayClock = () => string

export interface FsOverlayAssetStoreHooks {
  /**
   * Called after the staging file is written and before it is renamed over the
   * target. Exists so the §35.9 "atomic temporary write and rename" case can
   * observe the window directly; production code leaves it unset.
   */
  beforeRename?: (info: {tempPath: string; targetPath: string}) => void | Promise<void>
}

export interface FsOverlayAssetStoreOptions {
  /** Absolute path of the directory *containing* `.sanity-overlay`. */
  root: string
  now: OverlayClock
  /** `fsync` the staging file before renaming. Off by default, as in the document store. */
  fsync?: boolean
  hooks?: FsOverlayAssetStoreHooks
  /** PRD §24.5 size limit. Defaults to core's `DEFAULT_MAX_ASSET_BYTES`. */
  maxBytes?: number
  /** PRD §24.5 MIME allow-list, matched against the *sniffed* type. */
  allowedContentTypes?: readonly string[]
  /** Mount point of the delivery route, for the document's `url` (PRD §24.7). */
  basePath?: string
  /** Recorded on the §24.2 record. `filesystem` unless a caller says otherwise. */
  provider?: OverlayAssetProvider
}

export interface PutAssetInput {
  overlayId: string
  bytes: Uint8Array
  filename?: string
  contentType?: string
  actor?: OverlayActor
}

export interface PutAssetResult {
  record: OverlayAssetRecord
  /** The §24.3 step-5 document, ready to be `create`d in a transaction. */
  document: SanityDocument
  /** True when these exact bytes were already stored — nothing was rewritten. */
  deduplicated: boolean
  /** Absolute path of the blob, for diagnostics. */
  blobPath: string
}

export interface ReadBlobOptions {
  /** Re-hash the bytes and refuse a mismatch (PRD §13.2). Off by default. */
  verify?: boolean
}

export interface RemoveAssetOptions {
  /**
   * Overlay state to check incoming strong references against (§18.8, §24.6).
   * Omit only when the caller has already established the asset is unused.
   */
  state?: OverlayState
}

export interface RemoveAssetResult {
  removed: boolean
  /** False when another record still names the same content-addressed blob. */
  removedBlob: boolean
}

export interface AssetIntegrityReport {
  checked: number
  /** Records whose blob is absent. */
  missing: string[]
  /** Records whose blob no longer hashes to `checksum`. */
  corrupt: string[]
  ok: boolean
}

/** One row of {@link FsOverlayAssetStore.assetCheckpointManifest}. */
export interface OverlayAssetCheckpointEntry {
  assetDocumentId: string
  checksum: string
  contentType: string
  size: number
  storageRef: string
}

/**
 * What a checkpoint says about assets — PRD §29.
 *
 * `bytesIncluded: false` is the honest statement of an unresolved design
 * question, not an oversight. See the module note in `index.ts`.
 */
export interface OverlayAssetCheckpointManifest {
  formatVersion: OverlayFormatVersion
  overlayId: string
  bytesIncluded: false
  assets: OverlayAssetCheckpointEntry[]
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: unknown}).code === 'ENOENT'
  )
}

function assertAssetId(assetDocumentId: string): string {
  if (!isOverlayAssetDocumentId(assetDocumentId)) {
    throw new OverlayAssetError(
      'OVERLAY_ASSET_REJECTED',
      `${JSON.stringify(assetDocumentId)} is not an overlay asset document ID (PRD §24.2)`,
      {assetDocumentId},
    )
  }
  return assetDocumentId
}

export class FsOverlayAssetStore {
  readonly layout: OverlayLayout

  readonly #now: OverlayClock
  readonly #fsync: boolean
  readonly #hooks: FsOverlayAssetStoreHooks
  readonly #maxBytes: number | undefined
  readonly #allowedContentTypes: readonly string[] | undefined
  readonly #basePath: string | undefined
  readonly #provider: OverlayAssetProvider

  constructor(options: FsOverlayAssetStoreOptions) {
    if (typeof options?.now !== 'function') {
      throw new OverlayAssetError(
        'OVERLAY_ASSET_REJECTED',
        'FsOverlayAssetStore requires an injected `now` clock (PRD §14.3)',
        {},
      )
    }
    this.layout = new OverlayLayout(options.root)
    this.#now = options.now
    this.#fsync = options.fsync ?? false
    this.#hooks = options.hooks ?? {}
    this.#maxBytes = options.maxBytes
    this.#allowedContentTypes = options.allowedContentTypes
    this.#basePath = options.basePath
    this.#provider = options.provider ?? 'filesystem'
  }

  /* ---------------------------------------------------------------- *
   * §24.3 steps 2-5 — accept, validate, store, describe
   * ---------------------------------------------------------------- */

  /**
   * Store bytes and return the record plus the synthetic asset document.
   *
   * Validation happens **before** any filesystem work (`planAssetUpload` throws),
   * so a refused upload leaves the store byte-for-byte as it was — there is no
   * partially written asset to clean up.
   */
  async put(input: PutAssetInput): Promise<PutAssetResult> {
    const plan = planAssetUpload({
      bytes: input.bytes,
      overlayId: input.overlayId,
      createdAt: this.#now(),
      provider: this.#provider,
      ...(input.filename === undefined ? {} : {filename: input.filename}),
      ...(input.contentType === undefined ? {} : {contentType: input.contentType}),
      ...(input.actor === undefined ? {} : {actor: input.actor}),
      ...(this.#maxBytes === undefined ? {} : {maxBytes: this.#maxBytes}),
      ...(this.#allowedContentTypes === undefined
        ? {}
        : {allowedContentTypes: this.#allowedContentTypes}),
      ...(this.#basePath === undefined ? {} : {basePath: this.#basePath}),
    })

    await this.#ensureScaffold()

    const blobPath = this.layout.assetBlobPath(plan.checksum)
    /* Content addressing: the path already *is* the digest of these bytes, so an
     * existing file of the same length is these bytes. Writing it again would
     * change nothing except the mtime — and would be indistinguishable, on disk,
     * from a store that had no deduplication at all. */
    const existingBlob = await statOrNull(blobPath)
    const deduplicated = existingBlob !== null && existingBlob.size === plan.record.size
    if (!deduplicated) {
      await this.#writeBytes(blobPath, plan.record.size === 0 ? new Uint8Array(0) : input.bytes)
    }

    /* The record is the commit point: written last, so a crash leaves an orphan
     * blob rather than a record naming bytes that are not there. */
    const recordPath = this.layout.assetRecordPath(plan.record.assetDocumentId)
    const existingRecord = await this.#readRecordFile(recordPath)
    const record = existingRecord ?? plan.record
    if (existingRecord === null) {
      await this.#writeText(recordPath, serialize(plan.record))
    }

    return {
      record,
      document: synthesizeAssetDocument(record, {
        ...(this.#basePath === undefined ? {} : {basePath: this.#basePath}),
      }),
      deduplicated,
      blobPath,
    }
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  /** The §24.2 record, or `null` when this overlay holds no such asset. */
  async getRecord(assetDocumentId: string): Promise<OverlayAssetRecord | null> {
    assertAssetId(assetDocumentId)
    return this.#readRecordFile(this.layout.assetRecordPath(assetDocumentId))
  }

  /** Every record this overlay holds, ordered by asset document ID. */
  async listRecords(): Promise<OverlayAssetRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.layout.assetRecordsDir)
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }

    const records: OverlayAssetRecord[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const record = await this.#readRecordFile(join(this.layout.assetRecordsDir, name))
      if (record !== null) records.push(record)
    }
    return records
  }

  /** The stored bytes, addressed through the record's `checksum` (PRD §24.3 step 7). */
  async readBlob(assetDocumentId: string, options: ReadBlobOptions = {}): Promise<Uint8Array> {
    assertAssetId(assetDocumentId)
    const record = await this.getRecord(assetDocumentId)
    if (record === null) {
      throw new OverlayAssetError(
        'OVERLAY_ASSET_NOT_FOUND',
        `No overlay asset record for ${JSON.stringify(assetDocumentId)}`,
        {assetDocumentId},
      )
    }

    let bytes: Buffer
    try {
      bytes = await readFile(this.layout.assetBlobPath(record.checksum))
    } catch (error) {
      if (!isEnoent(error)) throw error
      throw new OverlayAssetError(
        'OVERLAY_ASSET_NOT_FOUND',
        `Asset ${JSON.stringify(assetDocumentId)} has a record but its blob ${JSON.stringify(
          record.storageRef,
        )} is missing`,
        {assetDocumentId, storageRef: record.storageRef},
      )
    }

    if (options.verify === true) {
      const actual = sha256Hex(new Uint8Array(bytes))
      if (actual !== record.checksum) {
        throw new OverlayAssetError(
          'OVERLAY_ASSET_CHECKSUM_MISMATCH',
          `Asset ${JSON.stringify(assetDocumentId)} hashes to ${actual}, but its record claims ${
            record.checksum
          } (PRD §13.2)`,
          {assetDocumentId, expected: record.checksum, actual},
        )
      }
    }

    return new Uint8Array(bytes)
  }

  /* ---------------------------------------------------------------- *
   * §24.6 remove, §18.8 delete protection
   * ---------------------------------------------------------------- */

  /**
   * Remove a branch asset, refusing while anything still references it.
   *
   * The refusal comes from the *same* function the delete action's
   * `checkStrongReferences` port resolves to (`assertAssetDeletable` →
   * `incomingReferenceGraph`), so the asset UI and `deleteDocument` can never
   * disagree about whether an image is in use.
   */
  async remove(
    assetDocumentId: string,
    options: RemoveAssetOptions = {},
  ): Promise<RemoveAssetResult> {
    assertAssetId(assetDocumentId)
    if (options.state !== undefined) assertAssetDeletable(options.state, assetDocumentId)

    const record = await this.getRecord(assetDocumentId)
    if (record === null) return {removed: false, removedBlob: false}

    await rm(this.layout.assetRecordPath(assetDocumentId), {force: true})

    /* The blob is shared by construction: two records can name the same content.
     * It only goes when the last record naming it has gone. */
    const stillReferenced = (await this.listRecords()).some(
      (other) => other.checksum === record.checksum,
    )
    if (!stillReferenced) {
      await rm(this.layout.assetBlobPath(record.checksum), {force: true})
    }

    return {removed: true, removedBlob: !stillReferenced}
  }

  /* ---------------------------------------------------------------- *
   * Integrity and checkpoint description
   * ---------------------------------------------------------------- */

  /** Re-hash every stored blob against its record (PRD §13.2, §34.4). */
  async verifyBlobs(): Promise<AssetIntegrityReport> {
    const records = await this.listRecords()
    const missing: string[] = []
    const corrupt: string[] = []

    for (const record of records) {
      let bytes: Buffer
      try {
        bytes = await readFile(this.layout.assetBlobPath(record.checksum))
      } catch (error) {
        if (!isEnoent(error)) throw error
        missing.push(record.assetDocumentId)
        continue
      }
      if (sha256Hex(new Uint8Array(bytes)) !== record.checksum) {
        corrupt.push(record.assetDocumentId)
      }
    }

    return {
      checked: records.length,
      missing,
      corrupt,
      ok: missing.length === 0 && corrupt.length === 0,
    }
  }

  /**
   * What a checkpoint can say about this overlay's assets — PRD §29.
   *
   * Every field is text a reviewer can read and Git can diff. `bytesIncluded` is
   * `false` and always will be from this method: whether, and how, binary payloads
   * travel inside a reviewable checkpoint is an open question (§29), and encoding
   * megabytes of base64 into a canonical JSON bundle would answer it badly and
   * irreversibly. The bytes travel *beside* the checkpoint, in
   * `.sanity-overlay/assets/blobs/`, and `checksum` is what proves a delivered
   * blob is the one the record means.
   */
  async assetCheckpointManifest(overlayId: string): Promise<OverlayAssetCheckpointManifest> {
    const records = await this.listRecords()
    return {
      formatVersion: OVERLAY_FORMAT_VERSION,
      overlayId,
      bytesIncluded: false,
      assets: records.map((record) => ({
        assetDocumentId: record.assetDocumentId,
        checksum: record.checksum,
        contentType: record.contentType,
        size: record.size,
        storageRef: record.storageRef,
      })),
    }
  }

  /* ================================================================ *
   * Internals
   * ================================================================ */

  async #ensureScaffold(): Promise<void> {
    await Promise.all([
      mkdir(this.layout.assetBlobsDir, {recursive: true}),
      mkdir(this.layout.assetRecordsDir, {recursive: true}),
    ])
    const attributes = this.layout.resolve(GITATTRIBUTES_FILE)
    if ((await statOrNull(attributes)) === null) {
      await this.#writeText(attributes, GITATTRIBUTES_CONTENT)
    }
  }

  async #readRecordFile(path: string): Promise<OverlayAssetRecord | null> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isEnoent(error)) return null
      throw error
    }
    return parse(raw) as OverlayAssetRecord
  }

  /** Temp file, optional fsync, rename — the §14.3 MUST, for text. */
  async #writeText(targetPath: string, contents: string): Promise<void> {
    await this.#writeAtomic(targetPath, contents, 'utf8')
  }

  /** The same primitive for opaque bytes. */
  async #writeBytes(targetPath: string, contents: Uint8Array): Promise<void> {
    await this.#writeAtomic(targetPath, contents, null)
  }

  async #writeAtomic(
    targetPath: string,
    contents: string | Uint8Array,
    encoding: 'utf8' | null,
  ): Promise<void> {
    const dir = dirname(targetPath)
    await mkdir(dir, {recursive: true})
    /* Random staging name so concurrent writers of the same target cannot clobber
     * each other's temporary file; the rename is the atomic step. */
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`)
    try {
      if (this.#fsync) {
        const handle = await open(tempPath, 'wx', 0o644)
        try {
          await handle.writeFile(contents as never, encoding === null ? undefined : encoding)
          try {
            await handle.sync()
          } catch {
            /* Some filesystems reject fsync on a regular file; the rename still
             * gives atomicity, only durability across a power loss weakens. */
          }
        } finally {
          await handle.close()
        }
      } else if (encoding === null) {
        await writeFile(tempPath, contents as Uint8Array, {mode: 0o644, flag: 'wx'})
      } else {
        await writeFile(tempPath, contents as string, {encoding, mode: 0o644, flag: 'wx'})
      }

      if (this.#hooks.beforeRename !== undefined) {
        await this.#hooks.beforeRename({tempPath, targetPath})
      }
      await rename(tempPath, targetPath)
    } catch (error) {
      await rm(tempPath, {force: true}).catch(() => undefined)
      throw error
    }
  }
}

async function statOrNull(path: string): Promise<{size: number} | null> {
  try {
    return await stat(path)
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}
