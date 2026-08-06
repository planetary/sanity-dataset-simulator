/**
 * Checkpoint export, verification and import — PRD §14.1, §14.3, §29.1, §29.2,
 * §29.7, invariant §34.17.
 *
 * ## What a checkpoint is
 *
 * The Git-facing form of overlay state: `manifest.json`, one
 * `documents/<encoded-id>/intent.json` per touched logical document, one
 * immutable `snapshots/<sha256>.json` per captured base state, and a
 * `checksums.json` tamper-evidence record over all of them.
 *
 * ## Why it is pure
 *
 * Nothing here reads a clock or a filesystem. A checkpoint is a *function of the
 * logical state alone*, which is what makes §34.17 ("checkpoint output is
 * deterministic for the same logical state") assertable at whole-checkpoint
 * granularity rather than only per file: two exports of one state are equal maps
 * of equal strings, and `exportCheckpoint(importCheckpoint(files).state)` is
 * byte-identical to `files`. A wall-clock `exportedAt` would break that, so the
 * format has none — the transfer bundle (`OverlayCanonicalBundle`) keeps one
 * because it is a shipment record, not a review surface.
 *
 * ## Repairable versus corrupt
 *
 * PRD §14.3 is explicit that a stale stored checksum after a valid direct edit or
 * Git merge is *repairable metadata, not a rejection*. Divergence is therefore
 * classified, not merely detected:
 *
 * - **Repairable** — the file parses and validates, and only a recorded checksum
 *   disagrees with it. A developer hand-editing `intent.json` produces exactly
 *   this. Import recomputes and rewrites.
 * - **Corrupt** — the file does not parse, does not validate, is referenced but
 *   absent, or is content-addressed and no longer hashes to its own name. There
 *   is no metadata to repair; rewriting the checksum would bless the damage.
 *   Import throws, having produced nothing, so a caller can never half-load.
 */
import {checksum as canonicalChecksum, isChecksum, sha256Hex} from '../checksum'
import {toPublishedId} from '../encoding'
import {parse, serialize} from '../serialize'
import {intentChecksum} from '../store/intent'
import type {CheckpointDocumentIntent, OverlayBaseSnapshot} from '../store/intent'
import {
  OverlayChecksumMismatchError,
  OverlayIdentityMismatchError,
  OverlayInvalidRequestError,
  OverlayStoreCorruptError,
} from '../store/errors'
import {OVERLAY_FORMAT_VERSION} from '../types/format-version'
import type {OverlayManifest} from '../types/manifest'
import {isSupportedFormatVersion} from '../version'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  CHECKPOINT_DOCUMENTS_DIR,
  CHECKPOINT_MANIFEST_FILE,
  CHECKPOINT_SNAPSHOTS_DIR,
  checkpointIntentPath,
  checkpointSnapshotPath,
  contentAddressFromSnapshotPath,
  isGovernedCheckpointPath,
  logicalIdFromIntentPath,
} from './paths'
import type {
  ExportCheckpointOptions,
  ImportCheckpointOptions,
  OverlayCheckpointChecksums,
  OverlayCheckpointFiles,
  OverlayCheckpointFilesInput,
  OverlayCheckpointImport,
  OverlayCheckpointIssue,
  OverlayCheckpointState,
  OverlayCheckpointVerification,
} from './types'

/* ------------------------------------------------------------------ *
 * File-set helpers
 * ------------------------------------------------------------------ */

/** Path-sorted plain object, for JSON transport and deep-equality assertions. */
export function checkpointFilesToRecord(files: OverlayCheckpointFilesInput): Record<string, string> {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files)
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Inverse of {@link checkpointFilesToRecord}. */
export function checkpointFilesFromRecord(
  record: Readonly<Record<string, string>>,
): OverlayCheckpointFiles {
  return toFileMap(record)
}

function toFileMap(files: OverlayCheckpointFilesInput): OverlayCheckpointFiles {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new Map(entries)
}

/* ------------------------------------------------------------------ *
 * Structural validation
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural check for `manifest.json`. Returns a reason, or `null` when valid. */
export function checkpointManifestProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'manifest must be a JSON object'
  if (!isSupportedFormatVersion(value.formatVersion)) {
    return `unsupported manifest formatVersion ${JSON.stringify(value.formatVersion)}`
  }
  if (typeof value.overlayId !== 'string' || value.overlayId.length === 0) {
    return 'manifest.overlayId must be a non-empty string'
  }
  if (typeof value.status !== 'string') return 'manifest.status must be a string'
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    return 'manifest.revision must be a non-negative integer'
  }
  if (!isRecord(value.base) || typeof value.base.projectId !== 'string') {
    return 'manifest.base must carry projectId, dataset and apiVersion'
  }
  if (!isRecord(value.source) || typeof value.source.branch !== 'string') {
    return 'manifest.source must carry repositoryId and branch'
  }
  if (!isRecord(value.documentHeads)) return 'manifest.documentHeads must be an object'
  if (!isRecord(value.conflictSummary)) return 'manifest.conflictSummary must be an object'
  return null
}

/** Structural check for `documents/<id>/intent.json` (PRD §14.2). */
export function checkpointIntentProblem(value: unknown, expectedLogicalId: string): string | null {
  if (!isRecord(value)) return 'intent must be a JSON object'
  if (!isSupportedFormatVersion(value.formatVersion)) {
    return `unsupported intent formatVersion ${JSON.stringify(value.formatVersion)}`
  }
  if (typeof value.logicalId !== 'string' || value.logicalId.length === 0) {
    return 'intent.logicalId must be a non-empty string'
  }
  if (toPublishedId(value.logicalId) !== expectedLogicalId) {
    return `intent.logicalId ${JSON.stringify(value.logicalId)} does not match its location ${JSON.stringify(expectedLogicalId)}`
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    return 'intent.type must be a non-empty string'
  }
  if (!isRecord(value.base)) return 'intent.base must be an object'
  const snapshotRef = value.base.snapshotRef
  if (snapshotRef !== undefined && (typeof snapshotRef !== 'string' || !isChecksum(snapshotRef))) {
    return 'intent.base.snapshotRef must be a SHA-256 content address'
  }
  if (
    !isRecord(value.tombstones) ||
    typeof value.tombstones.draft !== 'boolean' ||
    typeof value.tombstones.published !== 'boolean'
  ) {
    return 'intent.tombstones must carry boolean draft and published flags'
  }
  if (!Array.isArray(value.touchedPaths)) return 'intent.touchedPaths must be an array'
  if (!Array.isArray(value.conflicts)) return 'intent.conflicts must be an array'
  if (typeof value.checksum !== 'string') return 'intent.checksum must be a string'
  return null
}

/** Structural check for `snapshots/<sha256>.json` (PRD §14.1). */
export function checkpointSnapshotProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'snapshot must be a JSON object'
  if (!isSupportedFormatVersion(value.formatVersion)) {
    return `unsupported snapshot formatVersion ${JSON.stringify(value.formatVersion)}`
  }
  if (typeof value.firstTouchedAt !== 'string') return 'snapshot.firstTouchedAt must be a string'
  if (typeof value.baseStatus !== 'string') return 'snapshot.baseStatus must be a string'
  return null
}

function checksumsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'checksums.json must be a JSON object'
  if (!isSupportedFormatVersion(value.formatVersion)) {
    return `unsupported checksums formatVersion ${JSON.stringify(value.formatVersion)}`
  }
  if (typeof value.overlayId !== 'string' || value.overlayId.length === 0) {
    return 'checksums.overlayId must be a non-empty string'
  }
  if (value.algorithm !== 'sha256') {
    return `unsupported checksum algorithm ${JSON.stringify(value.algorithm)}`
  }
  if (!isRecord(value.files)) return 'checksums.files must be an object'
  for (const [path, digest] of Object.entries(value.files)) {
    if (typeof digest !== 'string' || !isChecksum(digest)) {
      return `checksums.files[${JSON.stringify(path)}] must be a SHA-256 digest`
    }
  }
  if (typeof value.checksum !== 'string') return 'checksums.checksum must be a string'
  return null
}

/** SHA-256 over the checksum record without its own `checksum` field. */
export function checkpointChecksumsChecksum(record: OverlayCheckpointChecksums): string {
  const {checksum: _ignored, ...rest} = record
  return canonicalChecksum(rest)
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/**
 * Build the checkpoint state a canonical transfer bundle carries.
 *
 * The bundle's `record` and `transactions` are dropped on purpose: PRD §29.1
 * keeps generated materialized documents and the autosave transaction log out of
 * the Git-facing form.
 */
export function checkpointStateFromBundle(bundle: {
  manifest: OverlayManifest
  documents: readonly {intent: CheckpointDocumentIntent}[]
  snapshots: Readonly<Record<string, OverlayBaseSnapshot>>
}): OverlayCheckpointState {
  return {
    manifest: bundle.manifest,
    documents: [...bundle.documents]
      .map((entry) => entry.intent)
      .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0)),
    snapshots: bundle.snapshots,
  }
}

/**
 * Render logical state to the deterministic checkpoint file set.
 *
 * Every intent's own `checksum` is recomputed from its content first (PRD §29.2
 * "Recompute every checksum after export"), so an export normalizes whatever it
 * is handed and the output depends only on the logical state.
 */
export function exportCheckpoint(
  state: OverlayCheckpointState,
  options: ExportCheckpointOptions = {},
): OverlayCheckpointFiles {
  if (!isRecord(state) || !isRecord(state.manifest)) {
    throw new OverlayInvalidRequestError('exportCheckpoint requires a manifest')
  }
  const manifestProblem = checkpointManifestProblem(state.manifest)
  if (manifestProblem !== null) {
    throw new OverlayStoreCorruptError(CHECKPOINT_MANIFEST_FILE, manifestProblem)
  }
  const manifest = state.manifest
  const overlayId = manifest.overlayId

  const documents = [...(state.documents ?? [])]
  const snapshots = state.snapshots ?? {}

  const heads = Object.keys(manifest.documentHeads).map(toPublishedId).sort()
  const seen = new Set<string>()
  const files = new Map<string, string>()

  for (const intent of documents) {
    const logicalId = toPublishedId(intent?.logicalId ?? '')
    const problem = checkpointIntentProblem(intent, logicalId)
    if (problem !== null) {
      throw new OverlayStoreCorruptError(checkpointIntentPath(logicalId || 'unknown'), problem)
    }
    if (seen.has(logicalId)) {
      throw new OverlayInvalidRequestError(
        `Checkpoint state carries two intents for ${JSON.stringify(logicalId)}`,
        {logicalId},
      )
    }
    seen.add(logicalId)
    if (!heads.includes(logicalId)) {
      throw new OverlayStoreCorruptError(
        checkpointIntentPath(logicalId),
        'intent has no manifest head (PRD §34.3)',
        {logicalId},
      )
    }
    const ref = intent.base.snapshotRef
    if (ref !== undefined && snapshots[ref] === undefined) {
      throw new OverlayStoreCorruptError(
        checkpointIntentPath(logicalId),
        'intent references a base snapshot that is not in the checkpoint',
        {logicalId, snapshotRef: ref},
      )
    }
    /* §29.2 — recompute rather than trust. */
    const normalized: CheckpointDocumentIntent = {...intent, logicalId, checksum: ''}
    normalized.checksum = intentChecksum(normalized)
    files.set(checkpointIntentPath(logicalId), serialize(normalized))
  }

  for (const head of heads) {
    if (!seen.has(head)) {
      throw new OverlayStoreCorruptError(
        checkpointIntentPath(head),
        'manifest head has no intent in the checkpoint state (PRD §34.3)',
        {logicalId: head},
      )
    }
  }

  for (const [address, snapshot] of Object.entries(snapshots)) {
    const problem = checkpointSnapshotProblem(snapshot)
    if (problem !== null) {
      throw new OverlayStoreCorruptError(checkpointSnapshotPath(address), problem)
    }
    const actual = canonicalChecksum(snapshot)
    if (actual !== address) {
      /* The filename is the identity: a mislabelled snapshot must never be
       * written under a name it does not hash to. */
      throw new OverlayChecksumMismatchError(checkpointSnapshotPath(address), address, actual, {
        repairable: false,
      })
    }
    files.set(checkpointSnapshotPath(address), serialize(snapshot))
  }

  files.set(CHECKPOINT_MANIFEST_FILE, serialize(manifest))

  for (const [path, text] of Object.entries(options.extraFiles ?? {})) {
    if (path === CHECKPOINT_CHECKSUMS_FILE || isGovernedCheckpointPath(path)) {
      throw new OverlayInvalidRequestError(
        `extraFiles may not overwrite the canonical path ${JSON.stringify(path)}`,
        {path},
      )
    }
    files.set(path, text)
  }

  const digests: Record<string, string> = {}
  for (const [path, text] of files) digests[path] = sha256Hex(text)

  const record: OverlayCheckpointChecksums = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId,
    algorithm: 'sha256',
    files: digests,
    checksum: '',
  }
  record.checksum = checkpointChecksumsChecksum(record)
  files.set(CHECKPOINT_CHECKSUMS_FILE, serialize(record))

  return toFileMap(files)
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

interface ParsedFile<T> {
  value?: T
  issue?: OverlayCheckpointIssue
}

function parseFile<T>(ref: string, text: string): ParsedFile<T> {
  try {
    return {value: parse(text) as T}
  } catch (error) {
    return {
      issue: {
        ref,
        kind: 'unparseable',
        repairable: false,
        message: (error as Error).message,
      },
    }
  }
}

function corruptIssue(
  ref: string,
  kind: OverlayCheckpointIssue['kind'],
  message: string,
  extra: Partial<OverlayCheckpointIssue> = {},
): OverlayCheckpointIssue {
  return {ref, kind, repairable: false, message, ...extra}
}

function report(issues: OverlayCheckpointIssue[], checked: number): OverlayCheckpointVerification {
  const sorted = [...issues].sort((a, b) =>
    a.ref === b.ref ? (a.kind < b.kind ? -1 : 1) : a.ref < b.ref ? -1 : 1,
  )
  const corrupt = sorted.filter((issue) => !issue.repairable)
  const repairable = sorted.filter((issue) => issue.repairable)
  return {ok: sorted.length === 0, checked, issues: sorted, repairable, corrupt}
}

/**
 * Classify every divergence between a checkpoint's files and what its checksum
 * manifest claims, without throwing.
 *
 * The same call serves `sanity-overlay validate`, `sanity-overlay status` and the
 * pre-write gate inside {@link importCheckpoint}.
 */
export function verifyCheckpoint(input: OverlayCheckpointFilesInput): OverlayCheckpointVerification {
  const files = toFileMap(input)
  const issues: OverlayCheckpointIssue[] = []
  let checked = 0

  /* --- 1. The checksum manifest itself. ------------------------------- */
  const checksumsText = files.get(CHECKPOINT_CHECKSUMS_FILE)
  if (checksumsText === undefined) {
    return report(
      [
        corruptIssue(
          CHECKPOINT_CHECKSUMS_FILE,
          'missing-file',
          'checkpoint has no checksum manifest (PRD §29.4)',
        ),
      ],
      0,
    )
  }
  checked += 1
  const checksumsRead = parseFile<OverlayCheckpointChecksums>(
    CHECKPOINT_CHECKSUMS_FILE,
    checksumsText,
  )
  if (checksumsRead.value === undefined) return report([checksumsRead.issue!], checked)

  const structural = checksumsProblem(checksumsRead.value)
  if (structural !== null) {
    return report(
      [corruptIssue(CHECKPOINT_CHECKSUMS_FILE, 'invalid-structure', structural)],
      checked,
    )
  }
  const checksums = checksumsRead.value
  const rootChecksum = checkpointChecksumsChecksum(checksums)
  if (rootChecksum !== checksums.checksum) {
    /* Nothing this record claims can be trusted, so no other comparison is even
     * meaningful. Never repairable: recomputing it would bless the edit. */
    return report(
      [
        corruptIssue(
          CHECKPOINT_CHECKSUMS_FILE,
          'checksum-manifest-tampered',
          'checksum manifest does not match its own recorded checksum',
          {expected: checksums.checksum, actual: rootChecksum},
        ),
      ],
      checked,
    )
  }

  /* --- 2. Presence: listed ⇄ actual. ---------------------------------- */
  for (const path of Object.keys(checksums.files).sort()) {
    if (!files.has(path)) {
      issues.push(
        corruptIssue(path, 'missing-file', 'listed in the checksum manifest but not present'),
      )
    }
  }
  for (const path of files.keys()) {
    if (path === CHECKPOINT_CHECKSUMS_FILE) continue
    if (!isGovernedCheckpointPath(path)) continue
    if (checksums.files[path] === undefined) {
      issues.push(
        corruptIssue(path, 'invalid-structure', 'present but absent from the checksum manifest'),
      )
    }
  }

  /* --- 3. The overlay manifest. --------------------------------------- */
  const manifestText = files.get(CHECKPOINT_MANIFEST_FILE)
  if (manifestText === undefined) {
    issues.push(
      corruptIssue(CHECKPOINT_MANIFEST_FILE, 'missing-file', 'checkpoint has no manifest.json'),
    )
    return report(issues, checked)
  }
  checked += 1
  const manifestRead = parseFile<OverlayManifest>(CHECKPOINT_MANIFEST_FILE, manifestText)
  if (manifestRead.value === undefined) {
    issues.push(manifestRead.issue!)
    return report(issues, checked)
  }
  const manifestProblem = checkpointManifestProblem(manifestRead.value)
  if (manifestProblem !== null) {
    issues.push(corruptIssue(CHECKPOINT_MANIFEST_FILE, 'invalid-structure', manifestProblem))
    return report(issues, checked)
  }
  const manifest = manifestRead.value
  if (manifest.overlayId !== checksums.overlayId) {
    issues.push(
      corruptIssue(
        CHECKPOINT_MANIFEST_FILE,
        'invalid-structure',
        `manifest overlay ${JSON.stringify(manifest.overlayId)} is not the checksum manifest's ${JSON.stringify(checksums.overlayId)}`,
      ),
    )
    return report(issues, checked)
  }

  /* --- 4. Snapshots: the filename is the identity. --------------------- */
  /* `present` is keyed on the filename alone. A snapshot that is present but
   * damaged is the snapshot's fault, not the referring intent's — attributing a
   * second "missing snapshot" issue to the intent would bury the root cause. */
  const presentAddresses = new Set<string>()
  for (const path of files.keys()) {
    if (!path.startsWith(`${CHECKPOINT_SNAPSHOTS_DIR}/`)) continue
    checked += 1
    const address = contentAddressFromSnapshotPath(path)
    if (address !== null) presentAddresses.add(address)
    if (address === null) {
      issues.push(
        corruptIssue(path, 'invalid-structure', 'snapshot filename is not a SHA-256 content address'),
      )
      continue
    }
    const read = parseFile<OverlayBaseSnapshot>(path, files.get(path)!)
    if (read.value === undefined) {
      issues.push(read.issue!)
      continue
    }
    const problem = checkpointSnapshotProblem(read.value)
    if (problem !== null) {
      issues.push(corruptIssue(path, 'invalid-structure', problem))
      continue
    }
    const actual = canonicalChecksum(read.value)
    if (actual !== address) {
      issues.push(
        corruptIssue(
          path,
          'content-address-mismatch',
          'snapshot bytes no longer hash to their own filename',
          {expected: address, actual},
        ),
      )
      continue
    }
  }

  /* --- 5. Intents: one per manifest head, none orphaned. --------------- */
  const headIds = Object.keys(manifest.documentHeads).map(toPublishedId).sort()
  const headSet = new Set(headIds)

  for (const path of files.keys()) {
    if (!path.startsWith(`${CHECKPOINT_DOCUMENTS_DIR}/`)) continue
    const logicalId = logicalIdFromIntentPath(path)
    if (logicalId === null) {
      issues.push(
        corruptIssue(path, 'invalid-structure', 'not a decodable documents/<id>/intent.json path'),
      )
      continue
    }
    if (!headSet.has(toPublishedId(logicalId))) {
      issues.push(
        corruptIssue(path, 'invalid-structure', 'intent file that no manifest head reaches (PRD §34.3)', {
          logicalId,
        }),
      )
    }
  }

  for (const logicalId of headIds) {
    const path = checkpointIntentPath(logicalId)
    const text = files.get(path)
    if (text === undefined) {
      issues.push(
        corruptIssue(path, 'missing-file', 'manifest head has no intent file (PRD §34.3)', {
          logicalId,
        }),
      )
      continue
    }
    checked += 1
    const read = parseFile<CheckpointDocumentIntent>(path, text)
    if (read.value === undefined) {
      issues.push({...read.issue!, logicalId})
      continue
    }
    const problem = checkpointIntentProblem(read.value, logicalId)
    if (problem !== null) {
      issues.push(corruptIssue(path, 'invalid-structure', problem, {logicalId}))
      continue
    }
    const intent = read.value
    const ref = intent.base.snapshotRef
    if (ref !== undefined && !presentAddresses.has(ref)) {
      issues.push(
        corruptIssue(
          path,
          'missing-file',
          `intent references base snapshot ${ref} which the checkpoint does not carry`,
          {logicalId},
        ),
      )
      continue
    }
    /* §14.3 — the intent validates, so a stale embedded checksum is metadata. */
    const recomputed = intentChecksum(intent)
    if (recomputed !== intent.checksum) {
      issues.push({
        ref: path,
        kind: 'stale-intent-checksum',
        repairable: true,
        message: 'intent carries a stale checksum after a direct edit or Git merge (PRD §14.3)',
        expected: intent.checksum,
        actual: recomputed,
        logicalId,
      })
    }
  }

  /* --- 6. Byte hashes: stale metadata over content that validated. ----- */
  const corruptRefs = new Set(issues.filter((issue) => !issue.repairable).map((issue) => issue.ref))
  for (const [path, digest] of Object.entries(checksums.files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const text = files.get(path)
    if (text === undefined || corruptRefs.has(path)) continue
    const actual = sha256Hex(text)
    if (actual !== digest) {
      issues.push({
        ref: path,
        kind: 'stale-file-checksum',
        repairable: true,
        message:
          'recorded byte checksum is stale on a file that still validates (PRD §14.3, §29.2)',
        expected: digest,
        actual,
      })
    }
  }

  return report(issues, checked)
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

function describeIssues(issues: readonly OverlayCheckpointIssue[]): string {
  return issues.map((issue) => `${issue.ref} (${issue.kind}): ${issue.message}`).join('; ')
}

/**
 * Parse a checkpoint file set back to logical state (PRD §29.7 "Import on preview
 * initialization").
 *
 * Corrupt input throws before any value is produced, so a caller can never
 * observe a partially loaded checkpoint. Repairable divergence is normalized by
 * default (§29.7 step 3, §14.3) and reported in `repaired`.
 */
export function importCheckpoint(
  input: OverlayCheckpointFilesInput,
  options: ImportCheckpointOptions = {},
): OverlayCheckpointImport {
  const files = toFileMap(input)
  const verification = verifyCheckpoint(files)

  if (verification.corrupt.length > 0) {
    const first = verification.corrupt[0]!
    if (verification.corrupt.every((issue) => issue.kind === 'content-address-mismatch')) {
      throw new OverlayChecksumMismatchError(first.ref, first.expected ?? '', first.actual ?? '', {
        repairable: false,
        details: {issues: verification.corrupt},
      })
    }
    throw new OverlayStoreCorruptError(first.ref, describeIssues(verification.corrupt), {
      issues: verification.corrupt,
    })
  }

  if (verification.repairable.length > 0 && options.onDivergence === 'reject') {
    const first = verification.repairable[0]!
    throw new OverlayChecksumMismatchError(first.ref, first.expected ?? '', first.actual ?? '', {
      repairable: true,
      details: {issues: verification.repairable},
    })
  }

  /* Verification proved every governed file parses and validates, so these
   * parses cannot fail. */
  const manifest = parse(files.get(CHECKPOINT_MANIFEST_FILE)!) as OverlayManifest
  if (options.expectOverlayId !== undefined && options.expectOverlayId !== manifest.overlayId) {
    throw new OverlayIdentityMismatchError(options.expectOverlayId, manifest.overlayId)
  }

  const documents: CheckpointDocumentIntent[] = []
  for (const logicalId of Object.keys(manifest.documentHeads).map(toPublishedId).sort()) {
    const intent = parse(files.get(checkpointIntentPath(logicalId))!) as CheckpointDocumentIntent
    const normalized: CheckpointDocumentIntent = {...intent, checksum: ''}
    normalized.checksum = intentChecksum(normalized)
    documents.push(normalized)
  }

  const snapshots: Record<string, OverlayBaseSnapshot> = {}
  for (const path of files.keys()) {
    const address = contentAddressFromSnapshotPath(path)
    if (address === null) continue
    snapshots[address] = parse(files.get(path)!) as OverlayBaseSnapshot
  }

  const state: OverlayCheckpointState = {manifest, documents, snapshots}
  const extraFiles: Record<string, string> = {}
  for (const [path, text] of files) {
    if (path === CHECKPOINT_CHECKSUMS_FILE || isGovernedCheckpointPath(path)) continue
    extraFiles[path] = text
  }

  const repaired = [...new Set(verification.repairable.map((issue) => issue.ref))].sort()

  return {
    state,
    files: exportCheckpoint(state, {extraFiles}),
    repaired,
    issues: verification.issues,
  }
}
