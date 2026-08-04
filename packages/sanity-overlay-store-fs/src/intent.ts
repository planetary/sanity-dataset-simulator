/**
 * Review-facing document intent — PRD §14.2.
 *
 * `documents/<encoded-logical-id>/intent.json` is "the canonical file an agent
 * edits and a reviewer reads" (§14.2). It is *semantic intent*, not a resolved
 * document: the materialized branch document is generated into `.runtime/` and is
 * explicitly "not the primary review surface" (§14.2, §29.2 "Exclude generated
 * materialized documents from the normal PR diff").
 *
 * PRD ambiguities resolved here (both types are referenced by the §14.2 snippet
 * but never defined anywhere in the PRD):
 *
 * 1. `OverlayArrayOperation` — defined as the array-affecting member of the §13.7
 *    operation union, i.e. `insert`. §29.2 calls these "keyed array operations",
 *    and `insert` is the only §13.7 operation that carries keyed array anchors
 *    and positions; `set`/`unset` on an array path are already covered by
 *    `overrides`/`unsets`.
 * 2. `OverlayConflictSummary` — defined as the review projection of the §13.11
 *    `OverlayConflict`: identity, type, severity, path, and whether it has been
 *    resolved. §29.2 requires the checkpoint to "include conflicts and
 *    acknowledgements" but not the full ancestor/base/local value payloads, which
 *    would bloat every PR diff and can carry content §29.2 wants excluded.
 *
 * A third §14.2 ambiguity — `base.snapshotRef` is a single string while §13.3
 * captures *two* base versions (published and draft) — is resolved in
 * {@link baseSnapshotFrom}: one content-addressed snapshot holds the whole
 * captured base block, which is exactly §14.3's "one immutable content-addressed
 * snapshot for each distinct captured base state".
 */
import {
  OVERLAY_FORMAT_VERSION,
  checksum,
  encodeOverlayPath,
  isKeySegment,
} from '../../sanity-overlay-core/src/index'
import type {
  BaseDocumentVersion,
  OverlayConflict,
  OverlayConflictSeverity,
  OverlayConflictType,
  OverlayDocumentRecord,
  OverlayFormatVersion,
  OverlayOperation,
  OverlayPath,
  OverlayRecordBaseBlock,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'

/** PRD §14.2 — the keyed array operations preserved in a checkpoint (see header note 1). */
export type OverlayArrayOperation = Extract<OverlayOperation, {type: 'insert'}>

/** PRD §14.2 / §29.2 — conflict projection carried into the review surface (see header note 2). */
export interface OverlayConflictSummary {
  id: string
  type: OverlayConflictType
  severity: OverlayConflictSeverity
  path?: OverlayPath
  detectedAt: string
  resolved: boolean
}

/** PRD §14.2 — per-perspective intent state. */
export interface OverlayIntentState {
  mode: 'patch' | 'replace'
  overrides?: Array<{path: OverlayPath; value: unknown}>
  unsets?: OverlayPath[]
  arrayOperations?: OverlayArrayOperation[]
  replacement?: SanityDocument
}

/** PRD §14.2 — the canonical review-facing document intent. */
export interface CheckpointDocumentIntent {
  formatVersion: OverlayFormatVersion
  logicalId: string
  type: string
  base: {
    publishedRevision?: string
    draftRevision?: string
    snapshotRef?: string
  }
  draft?: OverlayIntentState
  published?: OverlayIntentState
  tombstones: {
    draft: boolean
    published: boolean
  }
  touchedPaths: OverlayPath[]
  conflicts: OverlayConflictSummary[]
  checksum: string
}

/**
 * The content-addressed base capture stored at `snapshots/<sha256>.json`
 * (PRD §14.1, §14.3 "One immutable content-addressed snapshot for each distinct
 * captured base state").
 *
 * It is the §13.3 `base` block verbatim plus a format stamp, so restoring a
 * record from `intent.json` + `snapshots/` is lossless for the merge ancestor —
 * which is what §14.2 needs it for ("stored once for deletion recovery and
 * three-way merge").
 */
export interface OverlayBaseSnapshot extends OverlayRecordBaseBlock {
  formatVersion: OverlayFormatVersion
}

/** Build the content-addressed snapshot object for a record's base block. */
export function baseSnapshotFrom(record: OverlayDocumentRecord): OverlayBaseSnapshot | null {
  if (record.base === null) return null
  return {formatVersion: OVERLAY_FORMAT_VERSION, ...record.base}
}

/* ------------------------------------------------------------------ *
 * Path reading
 * ------------------------------------------------------------------ */

/**
 * Read the value at an {@link OverlayPath} inside a document, or `undefined`.
 *
 * Only the read direction is needed here (intent compaction turns an operation
 * log into resolved override values); the write direction belongs to the core
 * mutation engine, not to a store adapter.
 */
export function valueAtPath(root: unknown, path: OverlayPath): unknown {
  let cursor: unknown = root
  for (const segment of path) {
    if (cursor === null || cursor === undefined) return undefined
    if (typeof segment === 'string') {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
      cursor = (cursor as Record<string, unknown>)[segment]
      continue
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[segment]
      continue
    }
    if (isKeySegment(segment)) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as {_key?: unknown})._key === segment._key,
      )
      continue
    }
    return undefined
  }
  return cursor
}

/** Deterministic path ordering: canonical encoded form, sorted by code unit. */
function sortPaths(paths: readonly OverlayPath[]): OverlayPath[] {
  return [...paths].sort((a, b) => {
    const left = encodeOverlayPath(a)
    const right = encodeOverlayPath(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** Deduplicate paths by canonical encoded form, preserving deterministic order. */
export function dedupePaths(paths: readonly OverlayPath[]): OverlayPath[] {
  const byEncoded = new Map<string, OverlayPath>()
  for (const path of paths) byEncoded.set(encodeOverlayPath(path), path)
  return sortPaths([...byEncoded.values()])
}

/* ------------------------------------------------------------------ *
 * Compaction (PRD §29.2 "Compact autosave operations into deterministic
 * overrides, unsets, keyed array operations, tombstones, or an explicit
 * replacement")
 * ------------------------------------------------------------------ */

function conflictSummary(conflict: OverlayConflict): OverlayConflictSummary {
  const summary: OverlayConflictSummary = {
    id: conflict.id,
    type: conflict.type,
    severity: conflict.severity,
    detectedAt: conflict.detectedAt,
    resolved: conflict.resolution !== undefined,
  }
  if (conflict.path !== undefined) summary.path = conflict.path
  return summary
}

/**
 * Compact one perspective's operation log into a §14.2 `OverlayIntentState`.
 *
 * The compaction is a pure function of `touchedPaths`, the operation log and the
 * materialized document, so re-running it on the same logical state produces
 * byte-identical output (PRD §34.17).
 *
 * - `replaceDocument` anywhere in the log, or a branch-created ancestor, selects
 *   `mode: 'replace'` and emits the whole document (§14.2 "Full replacement is
 *   allowed only when the user or migration explicitly chooses `mode: replace`",
 *   §17.10).
 * - Otherwise every touched path resolves to either an `unset` (when the last
 *   operation on that path removed it) or an `override` carrying the value the
 *   path now holds in the materialized document. `inc`, `dec`, `setIfMissing`
 *   and `diffMatchPatch` therefore collapse into plain overrides — §29.2 asks
 *   for *deterministic* overrides, and replaying a relative operation against a
 *   moved base is exactly the non-determinism §35.8 warns about.
 * - `insert` operations survive as keyed array operations so a reviewer sees the
 *   structural intent rather than a rewritten array.
 */
export function compactIntentState(
  version: {
    materialized: SanityDocument
    touchedPaths: OverlayPath[]
    operations: OverlayOperation[]
    ancestorKind: string
  } | null,
): OverlayIntentState | undefined {
  if (version === null) return undefined

  const replaces =
    version.ancestorKind === 'branch-created' ||
    version.operations.some((operation) => operation.type === 'replaceDocument')

  if (replaces) {
    return {mode: 'replace', replacement: version.materialized}
  }

  const arrayOperations = version.operations.filter(
    (operation): operation is OverlayArrayOperation => operation.type === 'insert',
  )
  const insertPaths = new Set(arrayOperations.map((operation) => encodeOverlayPath(operation.path)))

  // Last operation wins per path, so a set-then-unset ends as an unset and an
  // unset-then-set ends as an override.
  const lastOperationByPath = new Map<string, OverlayOperation>()
  for (const operation of version.operations) {
    if (operation.type === 'replaceDocument') continue
    lastOperationByPath.set(encodeOverlayPath(operation.path), operation)
  }

  const unsets: OverlayPath[] = []
  const overrides: Array<{path: OverlayPath; value: unknown}> = []

  for (const path of dedupePaths(version.touchedPaths)) {
    const encoded = encodeOverlayPath(path)
    if (insertPaths.has(encoded)) continue
    if (lastOperationByPath.get(encoded)?.type === 'unset') {
      unsets.push(path)
      continue
    }
    const value = valueAtPath(version.materialized, path)
    if (value === undefined) {
      // The path is touched but absent from the materialized document: the only
      // faithful representation is an unset (PRD §17.5).
      unsets.push(path)
      continue
    }
    overrides.push({path, value})
  }

  const state: OverlayIntentState = {mode: 'patch'}
  if (overrides.length > 0) state.overrides = overrides
  if (unsets.length > 0) state.unsets = sortPaths(unsets)
  if (arrayOperations.length > 0) state.arrayOperations = arrayOperations
  return state
}

/** Compute the checksum an intent carries: SHA-256 over the intent *without* its own checksum field. */
export function intentChecksum(intent: CheckpointDocumentIntent): string {
  const {checksum: _ignored, ...rest} = intent
  return checksum(rest)
}

/**
 * Project an {@link OverlayDocumentRecord} (§13.3) onto its review-facing intent
 * (§14.2). `snapshotRef` is the content address of {@link baseSnapshotFrom}.
 */
export function intentFromRecord(
  record: OverlayDocumentRecord,
  options: {snapshotRef?: string} = {},
): CheckpointDocumentIntent {
  const base: CheckpointDocumentIntent['base'] = {}
  const publishedRevision = baseRevision(record.base?.published, record.base?.lastObservedPublishedRevision)
  const draftRevision = baseRevision(record.base?.draft, record.base?.lastObservedDraftRevision)
  if (publishedRevision !== undefined) base.publishedRevision = publishedRevision
  if (draftRevision !== undefined) base.draftRevision = draftRevision
  if (options.snapshotRef !== undefined) base.snapshotRef = options.snapshotRef

  const touchedPaths = dedupePaths([
    ...(record.local.draft?.touchedPaths ?? []),
    ...(record.local.published?.touchedPaths ?? []),
  ])

  const intent: CheckpointDocumentIntent = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    logicalId: record.logicalId,
    type: record.schemaType,
    base,
    tombstones: {
      draft: record.local.draftTombstone,
      published: record.local.publishedTombstone,
    },
    touchedPaths,
    conflicts: record.conflicts.map(conflictSummary),
    checksum: '',
  }

  /* A tombstone wins over a local state for the same perspective: §34.2 makes the
   * tombstone the suppressing fact, and §34.1 allows at most one current local
   * state per perspective, so emitting both would be a contradictory intent. */
  const draft = record.local.draftTombstone ? undefined : compactIntentState(record.local.draft)
  const published = record.local.publishedTombstone
    ? undefined
    : compactIntentState(record.local.published)
  if (draft !== undefined) intent.draft = draft
  if (published !== undefined) intent.published = published

  intent.checksum = intentChecksum(intent)
  return intent
}

function baseRevision(
  version: BaseDocumentVersion | null | undefined,
  lastObserved: string | undefined,
): string | undefined {
  return version?.revision ?? lastObserved
}
