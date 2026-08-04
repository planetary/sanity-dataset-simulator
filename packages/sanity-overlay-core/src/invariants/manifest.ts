/**
 * The §34 invariants observable on a §13.1 manifest plus a storage inventory:
 * §34.3 (heads point at something that exists) and §34.8 (orphans are never
 * visible). Plan §8.3.
 *
 * Both take the inventory as data — a list of refs — rather than reading a
 * store, so core stays free of adapters and the same check runs against memory,
 * filesystem and Blob layouts.
 */
import {documentChecksumPrefix, isChecksum, isSyntheticRev, parseSyntheticRev} from '../checksum'
import type {OverlayManifest} from '../types/manifest'
import type {OverlayInvariantViolation} from './types'

export interface ManifestHeadInventory {
  /**
   * Storage refs that exist. Omit when the inventory is unknown: the structural
   * checks still run, the existence check is skipped rather than guessed.
   */
  knownRefs?: readonly string[]
}

/**
 * PRD §34.3 — "Every manifest document head points to an existing immutable
 * revision or a valid canonical filesystem record."
 */
export function checkManifestHeads(
  manifest: OverlayManifest,
  inventory: ManifestHeadInventory = {},
): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const known = inventory.knownRefs === undefined ? null : new Set(inventory.knownRefs)

  for (const [key, head] of Object.entries(manifest.documentHeads)) {
    if (key !== head.logicalId) {
      violations.push({
        invariant: '34.3',
        documentId: head.logicalId,
        message: `Document head for ${JSON.stringify(head.logicalId)} is filed under key ${JSON.stringify(key)}, so the head cannot be looked up by logical ID`,
      })
    }

    if (head.storageRef.trim().length === 0) {
      violations.push({
        invariant: '34.3',
        documentId: head.logicalId,
        message: `Document head ${JSON.stringify(head.logicalId)} has an empty storageRef and therefore points at no stored revision or record`,
      })
    } else if (known !== null && !known.has(head.storageRef)) {
      violations.push({
        invariant: '34.3',
        documentId: head.logicalId,
        message: `Document head ${JSON.stringify(head.logicalId)} points at ${JSON.stringify(head.storageRef)}, which is not present in storage`,
      })
    }

    if (!isChecksum(head.checksum)) {
      violations.push({
        invariant: '34.3',
        documentId: head.logicalId,
        message: `Document head ${JSON.stringify(head.logicalId)} carries checksum ${JSON.stringify(head.checksum)}, which is not a SHA-256 hex digest`,
      })
      continue
    }

    // A synthetic runtime revision embeds the head checksum's prefix (§13.9), so
    // a head whose revision and checksum disagree names a revision that no
    // stored record can satisfy.
    if (isSyntheticRev(head.runtimeRevision)) {
      const parsed = parseSyntheticRev(head.runtimeRevision)
      const expected = documentChecksumPrefix(head.checksum)
      if (parsed !== null && parsed.documentChecksumPrefix !== expected) {
        violations.push({
          invariant: '34.3',
          documentId: head.logicalId,
          message: `Document head ${JSON.stringify(head.logicalId)} names runtime revision ${JSON.stringify(head.runtimeRevision)}, whose checksum prefix does not match the head checksum prefix ${expected}`,
        })
      }
    }
  }

  return violations
}

export interface OrphanVisibilityInput {
  manifest: OverlayManifest
  /** Every revision or record present in storage. */
  storedRefs?: readonly string[]
  /** Every revision or record a reader can currently observe. */
  visibleRefs: readonly string[]
  /** Refs held alive by a checkpoint (§14.1, §34.8's second clause). */
  checkpointRefs?: readonly string[]
}

/**
 * PRD §34.8 — "Orphan revisions are never visible without a manifest or
 * checkpoint reference."
 *
 * A superseded revision may remain *stored* — that is retention, not a breach.
 * The invariant is about visibility: anything a reader can observe must be
 * anchored by a manifest head or a checkpoint.
 */
export function checkOrphanVisibility(
  input: OrphanVisibilityInput,
): OverlayInvariantViolation[] {
  const referenced = new Set<string>()
  for (const head of Object.values(input.manifest.documentHeads)) {
    referenced.add(head.storageRef)
  }
  for (const ref of input.checkpointRefs ?? []) referenced.add(ref)

  const violations: OverlayInvariantViolation[] = []
  for (const ref of input.visibleRefs) {
    if (referenced.has(ref)) continue
    violations.push({
      invariant: '34.8',
      message: `Revision ${JSON.stringify(ref)} is visible but no manifest document head or checkpoint references it`,
    })
  }
  return violations
}
