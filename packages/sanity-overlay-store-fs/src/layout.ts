/**
 * Canonical filesystem layout — PRD §14.1, plus the path-containment guard the
 * §35.9 "Path traversal attempts fail" case requires.
 *
 * ```text
 * .sanity-overlay/
 *   manifest.json
 *   documents/<encoded-logical-id>/intent.json   canonical, review-facing (§14.2)
 *   snapshots/<sha256>.json                      immutable base captures (§14.3)
 *   assets/  migrations/  README.md  .gitattributes
 *   .runtime/materialized/                       generated, gitignored (§14.1)
 *   .runtime/transactions/
 *   .runtime/revisions/                          local runtime history (§37 Phase 2)
 *   .runtime/indexes/
 *   .locks/  .history/
 * ```
 */
import {isAbsolute, join, resolve, sep} from 'node:path'
import {
  encodeLogicalId,
  isEncodedLogicalId,
  isOverlayAssetDocumentId,
  toPublishedId,
} from '../../sanity-overlay-core/src/index'
import {OverlayInvalidRequestError, OverlayPathEscapeError} from './errors'

export const OVERLAY_DIR = '.sanity-overlay'
export const MANIFEST_FILE = 'manifest.json'
export const DOCUMENTS_DIR = 'documents'
export const INTENT_FILE = 'intent.json'
export const SNAPSHOTS_DIR = 'snapshots'
export const ASSETS_DIR = 'assets'
/** Content-addressed asset bytes: `assets/blobs/<sha256>.bin` (PRD §14.1, §24.3 step 3). */
export const ASSET_BLOBS_DIR = 'blobs'
/** Review-facing §24.2 records: `assets/records/<assetDocumentId>.json`. */
export const ASSET_RECORDS_DIR = 'records'
export const MIGRATIONS_DIR = 'migrations'
export const RUNTIME_DIR = '.runtime'
export const MATERIALIZED_DIR = 'materialized'
export const TRANSACTIONS_DIR = 'transactions'
export const REVISIONS_DIR = 'revisions'
export const INDEXES_DIR = 'indexes'
/** `.runtime/indexes/idempotency/` — the §34.6 deduplication ledger. */
export const IDEMPOTENCY_DIR = 'idempotency'
export const LOCKS_DIR = '.locks'
export const HISTORY_DIR = '.history'
export const GITATTRIBUTES_FILE = '.gitattributes'
export const GITIGNORE_FILE = '.gitignore'
export const README_FILE = 'README.md'

/** Suffix of the diagnostic copy written when a direct edit fails parsing (§14.3 SHOULD). */
export const BROKEN_SUFFIX = '.broken'

/** Prefix of the temporary file used by every atomic write (§14.3 MUST). */
export const TEMP_PREFIX = '.tmp-'

/**
 * PRD §14.1 recommended `.gitattributes`.
 *
 * The asset blob line is not cosmetic. `assets/blobs/**` holds opaque bytes
 * addressed by their SHA-256; marking it `binary` stops Git attempting a text
 * diff or a line-ending conversion on content whose checksum is its identity —
 * a CRLF rewrite would silently invalidate every record that names it.
 */
export const GITATTRIBUTES_CONTENT = `${OVERLAY_DIR}/${SNAPSHOTS_DIR}/** linguist-generated=true
${OVERLAY_DIR}/${RUNTIME_DIR}/** export-ignore
${OVERLAY_DIR}/${ASSETS_DIR}/${ASSET_BLOBS_DIR}/** binary
`

/** PRD §14.1 "Runtime-only files must be ignored", expressed relative to `.sanity-overlay/`. */
export const GITIGNORE_CONTENT = `${RUNTIME_DIR}/
${LOCKS_DIR}/
${HISTORY_DIR}/
*${BROKEN_SUFFIX}
${TEMP_PREFIX}*
`

export const README_CONTENT = `# Sanity branch overlay

This directory is the canonical, review-facing state of a Sanity branch overlay
(PRD section 14.1).

- \`manifest.json\` — overlay identity, lifecycle state, revision and document heads.
- \`documents/<encoded-id>/intent.json\` — the file an agent edits and a reviewer reads.
- \`snapshots/<sha256>.json\` — immutable base captures, kept for deletion recovery
  and three-way merge. Generated recovery artifacts, not a review surface.
- \`.runtime/\` — generated materialized documents, the transaction log and local
  runtime history. Not committed.

Edit \`intent.json\` directly if you want; the store revalidates, recomputes
checksums and refuses malformed JSON while retaining the last valid state.
`

/* ------------------------------------------------------------------ *
 * Path containment (PRD §35.9, §26.7)
 * ------------------------------------------------------------------ */

/**
 * Assert that `candidate` resolves inside `root` and return the resolved path.
 *
 * Every path this adapter opens goes through here. The check is on the *resolved*
 * path, so `..` segments, absolute inputs and symlink-free traversal are all
 * caught regardless of how the name was assembled.
 */
export function assertWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new OverlayPathEscapeError(candidate, resolvedRoot, {resolved})
  }
  return resolved
}

/** A single path component that can never traverse: no separator, not `.`/`..`, non-empty. */
export function assertSafeComponent(component: string, kind: string): string {
  if (
    component.length === 0 ||
    component === '.' ||
    component === '..' ||
    component.includes('/') ||
    component.includes('\\') ||
    component.includes('\0') ||
    isAbsolute(component)
  ) {
    throw new OverlayPathEscapeError(component, kind, {kind})
  }
  return component
}

/**
 * Storage key for a logical document ID.
 *
 * `drafts.` prefixes are normalized away first: draft and published state of one
 * logical document share a record (§13.3), so `drafts.article` and `article`
 * must land in the same directory (§35.9 "File path encoding handles IDs with
 * dots and draft prefixes"). The encoder itself is core's — it is reversible and
 * emits no path separators — and the result is re-asserted here as a single safe
 * component so a future encoder change cannot silently open a traversal.
 */
export function documentKey(logicalId: string): string {
  const normalized = toPublishedId(logicalId)
  const encoded = encodeLogicalId(normalized)
  assertSafeComponent(encoded, 'document key')
  /* istanbul ignore next -- defence in depth against an encoder regression. */
  if (!isEncodedLogicalId(encoded)) {
    throw new OverlayPathEscapeError(encoded, 'document key', {logicalId})
  }
  return encoded
}

/** Resolved paths for one overlay root (the directory *containing* `.sanity-overlay`). */
export class OverlayLayout {
  readonly workspaceRoot: string
  readonly root: string

  constructor(workspaceRoot: string) {
    if (!isAbsolute(workspaceRoot)) {
      throw new OverlayInvalidRequestError(
        `FsOverlayStore root must be an absolute path, received ${JSON.stringify(workspaceRoot)}`,
        {root: workspaceRoot},
      )
    }
    this.workspaceRoot = resolve(workspaceRoot)
    this.root = join(this.workspaceRoot, OVERLAY_DIR)
  }

  /** Resolve a path relative to `.sanity-overlay/`, asserting containment. */
  resolve(...segments: string[]): string {
    return assertWithinRoot(this.root, join(...segments))
  }

  get manifestPath(): string {
    return this.resolve(MANIFEST_FILE)
  }

  get documentsDir(): string {
    return this.resolve(DOCUMENTS_DIR)
  }

  get snapshotsDir(): string {
    return this.resolve(SNAPSHOTS_DIR)
  }

  get assetsDir(): string {
    return this.resolve(ASSETS_DIR)
  }

  get assetBlobsDir(): string {
    return this.resolve(ASSETS_DIR, ASSET_BLOBS_DIR)
  }

  get assetRecordsDir(): string {
    return this.resolve(ASSETS_DIR, ASSET_RECORDS_DIR)
  }

  get runtimeDir(): string {
    return this.resolve(RUNTIME_DIR)
  }

  get materializedDir(): string {
    return this.resolve(RUNTIME_DIR, MATERIALIZED_DIR)
  }

  get transactionsDir(): string {
    return this.resolve(RUNTIME_DIR, TRANSACTIONS_DIR)
  }

  get revisionsDir(): string {
    return this.resolve(RUNTIME_DIR, REVISIONS_DIR)
  }

  get indexesDir(): string {
    return this.resolve(RUNTIME_DIR, INDEXES_DIR)
  }

  documentDir(logicalId: string): string {
    return this.resolve(DOCUMENTS_DIR, documentKey(logicalId))
  }

  intentPath(logicalId: string): string {
    return this.resolve(DOCUMENTS_DIR, documentKey(logicalId), INTENT_FILE)
  }

  snapshotPath(snapshotRef: string): string {
    assertSafeComponent(snapshotRef, 'snapshot ref')
    return this.resolve(SNAPSHOTS_DIR, `${snapshotRef}.json`)
  }

  /**
   * `assets/blobs/<sha256>.bin` — PRD §14.1 content addressing.
   *
   * The digest is validated before it is joined, so the only strings that can
   * ever reach the filesystem are 64 lowercase hex characters. There is no
   * sanitizing step to get wrong: a traversal attempt is simply not a SHA-256.
   */
  assetBlobPath(checksum: string): string {
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new OverlayPathEscapeError(checksum, 'asset checksum', {kind: 'asset checksum'})
    }
    return this.resolve(ASSETS_DIR, ASSET_BLOBS_DIR, `${checksum}.bin`)
  }

  /**
   * `assets/records/<assetDocumentId>.json`.
   *
   * Same argument as {@link assetBlobPath}: an overlay asset document ID is
   * `image-<40 hex>-<w>x<h>-<ext>` or `file-<40 hex>-<ext>`, a grammar with no
   * `/`, no `.` and no `%`, so containment is a property of the identifier rather
   * than of a filter applied to it.
   */
  assetRecordPath(assetDocumentId: string): string {
    if (!isOverlayAssetDocumentId(assetDocumentId)) {
      throw new OverlayPathEscapeError(assetDocumentId, 'asset document id', {
        kind: 'asset document id',
      })
    }
    return this.resolve(ASSETS_DIR, ASSET_RECORDS_DIR, `${assetDocumentId}.json`)
  }

  materializedPath(logicalId: string): string {
    return this.resolve(RUNTIME_DIR, MATERIALIZED_DIR, `${documentKey(logicalId)}.json`)
  }

  revisionPath(logicalId: string, revisionChecksum: string): string {
    assertSafeComponent(revisionChecksum, 'revision checksum')
    return this.resolve(RUNTIME_DIR, REVISIONS_DIR, documentKey(logicalId), `${revisionChecksum}.json`)
  }

  revisionDir(logicalId: string): string {
    return this.resolve(RUNTIME_DIR, REVISIONS_DIR, documentKey(logicalId))
  }

  transactionPath(transactionId: string): string {
    assertSafeComponent(transactionId, 'transaction id')
    return this.resolve(RUNTIME_DIR, TRANSACTIONS_DIR, `${transactionId}.json`)
  }

  idempotencyPath(idempotencyKey: string): string {
    const key = encodeLogicalId(idempotencyKey)
    assertSafeComponent(key, 'idempotency key')
    return this.resolve(RUNTIME_DIR, INDEXES_DIR, IDEMPOTENCY_DIR, `${key}.json`)
  }

  get idempotencyDir(): string {
    return this.resolve(RUNTIME_DIR, INDEXES_DIR, IDEMPOTENCY_DIR)
  }

  /** Path relative to `.sanity-overlay/`, for stable refs in reports and errors. */
  relative(absolutePath: string): string {
    const resolved = resolve(absolutePath)
    if (resolved === this.root) return ''
    return resolved.startsWith(this.root + sep)
      ? resolved.slice(this.root.length + 1).split(sep).join('/')
      : resolved
  }
}
