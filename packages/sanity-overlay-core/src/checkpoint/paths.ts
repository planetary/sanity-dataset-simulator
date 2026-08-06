/**
 * Checkpoint file naming — PRD §14.1 / §29.1 canonical layout.
 *
 * Paths are POSIX-relative to the checkpoint directory (normally
 * `.sanity-overlay/`) and are pure strings: this module never touches a
 * filesystem, so the same names address a Git working tree, a zip entry list and
 * an in-memory transfer map alike.
 */
import {decodeLogicalId, encodeLogicalId, toPublishedId} from '../encoding'
import {isChecksum} from '../checksum'

/** The checksum manifest — PRD §29.4 "Include manifest and checksums". */
export const CHECKPOINT_CHECKSUMS_FILE = 'checksums.json'

/** The overlay manifest (PRD §13.1). */
export const CHECKPOINT_MANIFEST_FILE = 'manifest.json'

export const CHECKPOINT_DOCUMENTS_DIR = 'documents'
export const CHECKPOINT_INTENT_FILE = 'intent.json'
export const CHECKPOINT_SNAPSHOTS_DIR = 'snapshots'

/**
 * `documents/<encoded-logical-id>/intent.json`.
 *
 * `drafts.` prefixes normalize away first: draft and published state of one
 * logical document share a record (PRD §13.3), so they share an intent file.
 */
export function checkpointIntentPath(logicalId: string): string {
  return `${CHECKPOINT_DOCUMENTS_DIR}/${encodeLogicalId(toPublishedId(logicalId))}/${CHECKPOINT_INTENT_FILE}`
}

/** `snapshots/<sha256>.json` — the content address *is* the filename (PRD §14.1). */
export function checkpointSnapshotPath(contentAddress: string): string {
  return `${CHECKPOINT_SNAPSHOTS_DIR}/${contentAddress}.json`
}

/** Logical ID an intent path addresses, or `null` when the path is not one. */
export function logicalIdFromIntentPath(path: string): string | null {
  const segments = path.split('/')
  if (segments.length !== 3) return null
  if (segments[0] !== CHECKPOINT_DOCUMENTS_DIR || segments[2] !== CHECKPOINT_INTENT_FILE) return null
  try {
    return decodeLogicalId(segments[1]!)
  } catch {
    return null
  }
}

/** Content address a snapshot path addresses, or `null` when the path is not one. */
export function contentAddressFromSnapshotPath(path: string): string | null {
  const segments = path.split('/')
  if (segments.length !== 2) return null
  if (segments[0] !== CHECKPOINT_SNAPSHOTS_DIR) return null
  const name = segments[1]!
  if (!name.endsWith('.json')) return null
  const address = name.slice(0, -'.json'.length)
  return isChecksum(address) ? address : null
}

/**
 * True when a path is one this format governs, i.e. one whose content the
 * checkpoint verifier parses and validates.
 *
 * Everything else a repository may keep beside it — `README.md`,
 * `.gitattributes`, `assets/`, `migrations/` (PRD §14.1) — is carried by Git, not
 * by this format, and is neither required nor rejected.
 */
export function isGovernedCheckpointPath(path: string): boolean {
  if (path === CHECKPOINT_MANIFEST_FILE) return true
  if (path.startsWith(`${CHECKPOINT_DOCUMENTS_DIR}/`)) return true
  if (path.startsWith(`${CHECKPOINT_SNAPSHOTS_DIR}/`)) return true
  return false
}
