/**
 * Checkpoint types — the Git-facing review surface (PRD §14.1, §14.2, §29.1).
 *
 * A checkpoint is *files*, not an object graph: `OverlayCheckpointFiles` maps a
 * relative POSIX path to the exact UTF-8 text of that file. Rendering and parsing
 * are pure functions over that map, so byte-identity (invariant §34.17) is
 * directly assertable and the same code serves a working tree, a zip and an HTTP
 * body.
 */
import type {OverlayFormatVersion} from '../types/format-version'
import type {OverlayManifest} from '../types/manifest'
import type {CheckpointDocumentIntent, OverlayBaseSnapshot} from '../store/intent'

/** Relative POSIX path → exact file text. Iteration order is path-sorted. */
export type OverlayCheckpointFiles = ReadonlyMap<string, string>

/** Anything a caller may hand in where a file set is expected. */
export type OverlayCheckpointFilesInput = OverlayCheckpointFiles | Readonly<Record<string, string>>

/**
 * The logical state a checkpoint carries.
 *
 * Deliberately *not* the whole `OverlayCanonicalBundle`: PRD §29.1 makes the
 * Git-facing form "semantic intent plus immutable recovery snapshots", and §29.2
 * requires generated materialized documents and the autosave transaction log to
 * stay out of the PR diff. Restoring a full §13.3 record from an intent plus its
 * base snapshot is the merge engine's job, and the store contract already allows
 * `readDocumentByLogicalId(...).record === null` for exactly this case — a fresh
 * `git clone` where `.runtime/` was never committed.
 */
export interface OverlayCheckpointState {
  manifest: OverlayManifest
  /** One per manifest head, sorted by logical ID (code-unit ascending). */
  documents: readonly CheckpointDocumentIntent[]
  /** Content address → base capture (PRD §14.1 `snapshots/<sha256>.json`). */
  snapshots: Readonly<Record<string, OverlayBaseSnapshot>>
}

/**
 * `checksums.json` — the checkpoint's tamper-evidence record (PRD §29.4
 * "Include manifest and checksums", §29.5 "Export checksum matches generated
 * bundle").
 *
 * `files` hashes the *exact bytes* of every other file, which is what catches a
 * truncated write that still happens to parse. `checksum` is SHA-256 over the
 * canonical serialization of this record without its own `checksum` field, so the
 * record cannot be quietly rewritten to bless tampered content.
 */
export interface OverlayCheckpointChecksums {
  formatVersion: OverlayFormatVersion
  overlayId: string
  algorithm: 'sha256'
  /** Relative path → SHA-256 of that file's bytes. Excludes `checksums.json`. */
  files: Record<string, string>
  checksum: string
}

/** How a checkpoint file diverged from what the checksum manifest claims. */
export type OverlayCheckpointIssueKind =
  /** A file the checksum manifest lists, or a manifest head requires, is absent. */
  | 'missing-file'
  /** Not valid JSON, or carrying a prototype-polluting key (PRD §35.14). */
  | 'unparseable'
  /** Parses, but is not a valid instance of what that path must hold. */
  | 'invalid-structure'
  /** A file named by its own hash no longer hashes to that name. Never repairable. */
  | 'content-address-mismatch'
  /** `checksums.json` fails its own root checksum, so nothing it claims is trustworthy. */
  | 'checksum-manifest-tampered'
  /** The recorded byte hash is stale on a file that still validates (PRD §14.3). */
  | 'stale-file-checksum'
  /** An intent's own embedded `checksum` field is stale (PRD §14.3). */
  | 'stale-intent-checksum'

export interface OverlayCheckpointIssue {
  ref: string
  kind: OverlayCheckpointIssueKind
  /**
   * `true` when this is stale *metadata* over content that still validates —
   * PRD §14.3 "Treat a stale stored checksum as repairable metadata when the
   * semantic file validates. Do not reject a valid manual merge solely because
   * its old checksum changed."
   *
   * `false` when the content itself is unusable or a content address is violated.
   * Rewriting the recorded checksum there would destroy the evidence.
   */
  repairable: boolean
  message: string
  expected?: string
  actual?: string
  logicalId?: string
}

export interface OverlayCheckpointVerification {
  ok: boolean
  /** Files whose content was read and validated. */
  checked: number
  issues: readonly OverlayCheckpointIssue[]
  /** `issues` where `repairable` is true — normalize and rewrite (PRD §29.2). */
  repairable: readonly OverlayCheckpointIssue[]
  /** `issues` where `repairable` is false — semantic corruption, reject (PRD §29.7). */
  corrupt: readonly OverlayCheckpointIssue[]
}

export interface ExportCheckpointOptions {
  /**
   * Extra files to carry alongside the canonical set, e.g. `.gitattributes`.
   * They are hashed into `checksums.json` but are not parsed or validated.
   */
  extraFiles?: Readonly<Record<string, string>>
}

export interface ImportCheckpointOptions {
  /**
   * What to do with *repairable* divergence.
   *
   * `'repair'` (default) follows PRD §29.7 step 3 "Recompute checksums and reject
   * only semantic corruption" and §14.3's manual-merge rule. `'reject'` is the
   * strict gate `sanity-overlay validate` wants, and raises `CHECKSUM_MISMATCH`
   * with `repairable: true` in its details.
   *
   * Corrupt divergence always throws, whichever mode is selected.
   */
  onDivergence?: 'repair' | 'reject'
  /** Raise `OVERLAY_IDENTITY_MISMATCH` when the checkpoint is a different overlay. */
  expectOverlayId?: string
}

export interface OverlayCheckpointImport {
  /** Normalized logical state: every checksum recomputed from content. */
  state: OverlayCheckpointState
  /** The normalized file set — byte-identical to `exportCheckpoint(state)`. */
  files: OverlayCheckpointFiles
  /** Paths whose stale checksum metadata was recomputed, sorted and deduplicated. */
  repaired: readonly string[]
  issues: readonly OverlayCheckpointIssue[]
}
