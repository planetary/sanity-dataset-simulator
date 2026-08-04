/**
 * The §34 invariants that are observable on an {@link OverlayState} or a single
 * §13.3 document record: §34.1, §34.2, §34.4, §34.5 and §34.6 (plan §8.3).
 *
 * Every check is a pure function over state that returns structured violations,
 * so the same call serves a test assertion and a runtime debug endpoint. Each
 * re-derives its answer from the *content* — recomputing checksums, re-resolving
 * perspectives, re-walking the transaction log — rather than trusting the
 * bookkeeping the engine wrote alongside it. A check that consulted the same
 * field the engine wrote could not detect the engine writing it wrongly.
 */
import {canonicalEquals} from '../serialize'
import {checksum, documentChecksumPrefix, isSyntheticRev, parseSyntheticRev} from '../checksum'
import {isDraftId, toPublishedId} from '../encoding'
import {documentIdFor, type OverlayState} from '../mutations/state'
import {
  resolveDraftsPerspective,
  resolvePublishedPerspective,
  type PerspectiveBase,
  type PerspectiveRequest,
  type PerspectiveResolution,
} from '../perspectives/resolve'
import type {SanityDocument} from '../types/document'
import type {
  BaseDocumentVersion,
  LocalDocumentVersion,
  OverlayDocumentRecord,
} from '../types/record'
import type {OverlayInvariantViolation} from './types'

/* ------------------------------------------------------------------ *
 * §34.1 — one current local draft and one current local published state
 * ------------------------------------------------------------------ */

/**
 * PRD §34.1 — "One logical document has at most one current local draft and one
 * current local published state."
 *
 * The §13.3 record shape gives at most one `local.draft` and one
 * `local.published` *per record*, so the invariant reduces to two structural
 * facts the shape cannot enforce on its own:
 *
 * 1. one logical document is described by exactly one record — the record is
 *    filed under its own logical ID, and that ID is the published form, so
 *    `x` and `drafts.x` can never become two records for one document; and
 * 2. each local version is materialized under the document ID of *its own*
 *    perspective (§13.9), so a draft cannot present itself as a second current
 *    published state.
 */
export function checkSingleCurrentVersions(state: OverlayState): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const seen = new Map<string, string>()

  for (const [key, record] of Object.entries(state.documents)) {
    if (key !== record.logicalId) {
      violations.push({
        invariant: '34.1',
        documentId: record.logicalId,
        message: `Document record for ${JSON.stringify(record.logicalId)} is filed under key ${JSON.stringify(key)}: one logical document must be described by exactly one record`,
      })
    }

    if (isDraftId(record.logicalId)) {
      violations.push({
        invariant: '34.1',
        documentId: record.logicalId,
        message: `Document record ${JSON.stringify(record.logicalId)} uses a "drafts." ID as its logical ID; a logical ID is always the published form, so this doubles the logical document`,
      })
    }

    const logical = toPublishedId(record.logicalId)
    const previous = seen.get(logical)
    if (previous !== undefined) {
      violations.push({
        invariant: '34.1',
        documentId: logical,
        message: `Records ${JSON.stringify(previous)} and ${JSON.stringify(key)} both describe logical document ${JSON.stringify(logical)}`,
      })
    } else {
      seen.set(logical, key)
    }

    violations.push(...checkLocalVersionIdentity(record))
  }

  return violations
}

function checkLocalVersionIdentity(record: OverlayDocumentRecord): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const versions: Array<['draft' | 'published', LocalDocumentVersion | null]> = [
    ['draft', record.local.draft],
    ['published', record.local.published],
  ]

  for (const [kind, version] of versions) {
    if (version === null) continue
    const expected = documentIdFor(toPublishedId(record.logicalId), kind)
    const actual = version.materialized._id
    if (actual !== expected) {
      violations.push({
        invariant: '34.1',
        documentId: record.logicalId,
        message: `Local ${kind} of ${JSON.stringify(record.logicalId)} is materialized under _id ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}: it claims to be the current ${actual !== undefined && isDraftId(String(actual)) ? 'draft' : 'published'} state of another version`,
      })
    }
  }

  return violations
}

/* ------------------------------------------------------------------ *
 * §34.2 — a tombstone suppresses inheritance
 * ------------------------------------------------------------------ */

export interface TombstoneSuppressionInput {
  record: OverlayDocumentRecord
  /** Current base documents for this logical ID (PRD §16.1, read-only). */
  base: PerspectiveBase
  /** Injected clock for the resolution; defaults to the record's `updatedAt`. */
  now?: string
}

/**
 * Perspective resolvers, injectable so runtime tooling can feed in what it
 * *actually served* instead of what the pure resolver would serve.
 */
export interface TombstoneSuppressionOptions {
  resolvePublished?: (request: PerspectiveRequest) => PerspectiveResolution
  resolveDrafts?: (request: PerspectiveRequest) => PerspectiveResolution
}

function inheritsBase(resolution: PerspectiveResolution, base: PerspectiveBase): boolean {
  const document = resolution.document
  if (document === null) return false
  if (resolution.source === 'base-published' || resolution.source === 'base-draft') return true
  return equalsBase(document, base.published) || equalsBase(document, base.draft)
}

function equalsBase(document: SanityDocument, base: SanityDocument | null): boolean {
  return base !== null && canonicalEquals(document, base)
}

/**
 * PRD §34.2 — "A tombstone suppresses inheritance; deleting a local file alone
 * does not represent a content delete."
 *
 * Both halves are checked:
 *
 * - **Suppression.** Where a tombstone is set, the perspective must not answer
 *   with the current base document. A tombstone that still lets base content
 *   through is a delete that did not delete.
 * - **Recording.** A branch-created document whose local content has simply
 *   disappeared, with no tombstone, is the "deleted the file" failure the second
 *   clause names: nothing records the delete, so nothing can replay it.
 */
export function checkTombstoneSuppression(
  input: TombstoneSuppressionInput,
  options: TombstoneSuppressionOptions = {},
): OverlayInvariantViolation[] {
  const {record} = input
  const violations: OverlayInvariantViolation[] = []
  const request: PerspectiveRequest = {
    logicalId: record.logicalId,
    now: input.now ?? record.updatedAt,
    record,
    base: input.base,
  }

  if (record.local.publishedTombstone) {
    const resolution = (options.resolvePublished ?? resolvePublishedPerspective)(request)
    if (inheritsBase(resolution, input.base)) {
      violations.push({
        invariant: '34.2',
        documentId: record.logicalId,
        message: `Published tombstone on ${JSON.stringify(record.logicalId)} did not suppress inheritance: the published perspective still resolved to the current base document (source ${JSON.stringify(resolution.source)})`,
      })
    }
  }

  if (record.local.draftTombstone) {
    const resolution = (options.resolveDrafts ?? resolveDraftsPerspective)(request)
    if (inheritsBase(resolution, input.base)) {
      violations.push({
        invariant: '34.2',
        documentId: record.logicalId,
        message: `Draft tombstone on ${JSON.stringify(record.logicalId)} did not suppress inheritance: the drafts perspective still resolved to the current base document (source ${JSON.stringify(resolution.source)})`,
      })
    }
  }

  const local = record.local
  const hasLocalContent = local.published !== null || local.draft !== null
  const hasTombstone = local.publishedTombstone || local.draftTombstone
  if (record.origin === 'branch' && !hasLocalContent && !hasTombstone) {
    violations.push({
      invariant: '34.2',
      documentId: record.logicalId,
      message: `Branch-created document ${JSON.stringify(record.logicalId)} has no local content and no tombstone: removing the local version alone does not represent a content delete`,
    })
  }

  return violations
}

/* ------------------------------------------------------------------ *
 * §34.4 — every document record checksum matches its serialized content
 * ------------------------------------------------------------------ */

function contentChecksum(document: SanityDocument): string {
  // The synthetic `_rev` is derived from the document *without* `_rev` (§13.9,
  // `applySyntheticSystemFields`), so the recomputation must drop it too.
  const withoutRev: SanityDocument = {...document}
  delete withoutRev._rev
  return checksum(withoutRev)
}

/**
 * PRD §34.4 — "Every document record checksum matches its serialized content."
 *
 * Two stored digests exist per §13.3 record and both are recomputed here:
 * the §13.4 base snapshot `checksum`, and the §13.9 synthetic `_rev` carried by
 * each materialized local version (`overlay.<revision>.<12-hex prefix>`).
 */
export function checkRecordChecksums(
  record: OverlayDocumentRecord,
): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []

  const baseVersions: Array<[string, BaseDocumentVersion | null]> = [
    ['base published', record.base?.published ?? null],
    ['base draft', record.base?.draft ?? null],
  ]
  for (const [label, version] of baseVersions) {
    if (version === null) continue
    const actual = checksum(version.snapshot)
    if (actual !== version.checksum) {
      violations.push({
        invariant: '34.4',
        documentId: record.logicalId,
        message: `Stored ${label} checksum ${JSON.stringify(version.checksum)} of ${JSON.stringify(record.logicalId)} does not match the serialized snapshot (${actual})`,
      })
    }
  }

  const localVersions: Array<[string, LocalDocumentVersion | null]> = [
    ['local published', record.local.published],
    ['local draft', record.local.draft],
  ]
  for (const [label, version] of localVersions) {
    if (version === null) continue
    const rev = version.materialized._rev
    if (typeof rev !== 'string' || !isSyntheticRev(rev)) continue
    const parsed = parseSyntheticRev(rev)
    if (parsed === null) continue
    const expected = documentChecksumPrefix(contentChecksum(version.materialized))
    if (parsed.documentChecksumPrefix !== expected) {
      violations.push({
        invariant: '34.4',
        documentId: record.logicalId,
        message: `Synthetic _rev ${JSON.stringify(rev)} on the ${label} version of ${JSON.stringify(record.logicalId)} no longer matches its serialized content (expected checksum prefix ${expected})`,
      })
    }
  }

  return violations
}

/**
 * §34.4 across a whole overlay state: every record's own digests, plus the
 * `resultChecksums` the most recent transaction recorded, which by definition
 * still describe the current records.
 */
export function checkStateChecksums(state: OverlayState): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  for (const record of Object.values(state.documents)) {
    violations.push(...checkRecordChecksums(record))
  }

  const last = state.transactions[state.transactions.length - 1]
  if (last === undefined) return violations

  for (const [documentId, stored] of Object.entries(last.resultChecksums)) {
    const record = state.documents[documentId]
    if (record === undefined) {
      violations.push({
        invariant: '34.4',
        documentId,
        message: `Transaction ${JSON.stringify(last.transactionId)} recorded a result checksum for ${JSON.stringify(documentId)}, which has no record in the current state`,
      })
      continue
    }
    const actual = checksum(record)
    if (actual !== stored) {
      violations.push({
        invariant: '34.4',
        documentId,
        message: `Transaction ${JSON.stringify(last.transactionId)} recorded checksum ${JSON.stringify(stored)} for ${JSON.stringify(documentId)}, but the committed record serializes to ${actual}`,
      })
    }
  }

  return violations
}

/* ------------------------------------------------------------------ *
 * §34.5 — one revision increment per successful transaction
 * ------------------------------------------------------------------ */

/**
 * PRD §34.5 — "Every successful transaction increments overlay revision exactly
 * once."
 *
 * Checked as three properties of the committed log: each record moves the
 * revision by exactly one, consecutive records leave no gap, and the state's own
 * counter agrees with the last commit. Transaction IDs are required to be unique
 * within the overlay (§13.10) because a duplicated ID would hide a second commit
 * inside the first.
 */
export function checkRevisionIncrements(state: OverlayState): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const seenIds = new Set<string>()

  state.transactions.forEach((transaction, index) => {
    const {overlayRevisionBefore: before, overlayRevisionAfter: after} = transaction
    if (after !== before + 1) {
      violations.push({
        invariant: '34.5',
        message: `Transaction ${JSON.stringify(transaction.transactionId)} moved the overlay revision from ${before} to ${after}; a successful transaction increments it exactly once`,
      })
    }

    const previous = state.transactions[index - 1]
    if (previous !== undefined && before !== previous.overlayRevisionAfter) {
      violations.push({
        invariant: '34.5',
        message: `Transaction ${JSON.stringify(transaction.transactionId)} starts at overlay revision ${before}, but the previous transaction committed revision ${previous.overlayRevisionAfter}: the log has a gap`,
      })
    }

    if (seenIds.has(transaction.transactionId)) {
      violations.push({
        invariant: '34.5',
        message: `Transaction ID ${JSON.stringify(transaction.transactionId)} is committed twice; §13.10 requires it to be unique within the overlay`,
      })
    }
    seenIds.add(transaction.transactionId)
  })

  const last = state.transactions[state.transactions.length - 1]
  if (last !== undefined && state.revision !== last.overlayRevisionAfter) {
    violations.push({
      invariant: '34.5',
      message: `Overlay revision is ${state.revision}, but the last committed transaction ${JSON.stringify(last.transactionId)} ended at ${last.overlayRevisionAfter}`,
    })
  }

  return violations
}

/* ------------------------------------------------------------------ *
 * §34.6 — one idempotency key maps to one immutable transaction result
 * ------------------------------------------------------------------ */

/**
 * PRD §34.6 — "One idempotency key maps to one immutable transaction result."
 *
 * The key is the deduplication authority (§13.10), so three things must hold:
 * no key is committed twice, every committed transaction is recoverable from the
 * ledger, and the ledger entry is still byte-identical to the transaction it
 * recorded — "immutable result" is the half a replay depends on.
 */
export function checkIdempotencyLedger(state: OverlayState): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const byKey = new Map<string, string>()

  for (const transaction of state.transactions) {
    const previous = byKey.get(transaction.idempotencyKey)
    if (previous !== undefined) {
      violations.push({
        invariant: '34.6',
        message: `Transactions ${JSON.stringify(previous)} and ${JSON.stringify(transaction.transactionId)} were both committed under idempotency key ${JSON.stringify(transaction.idempotencyKey)}`,
      })
    } else {
      byKey.set(transaction.idempotencyKey, transaction.transactionId)
    }
  }

  for (const transaction of state.transactions) {
    const entry = state.idempotencyLedger[transaction.idempotencyKey]
    if (entry === undefined) {
      violations.push({
        invariant: '34.6',
        message: `Committed transaction ${JSON.stringify(transaction.transactionId)} has no entry for its idempotency key ${JSON.stringify(transaction.idempotencyKey)}; a replay could not return the original result`,
      })
      continue
    }
    if (entry.transactionId !== transaction.transactionId) {
      // A later commit under the same key legitimately owns the ledger entry
      // only if the duplicate-key check above already reported it.
      if (byKey.get(transaction.idempotencyKey) === transaction.transactionId) {
        violations.push({
          invariant: '34.6',
          message: `Idempotency key ${JSON.stringify(transaction.idempotencyKey)} maps to transaction ${JSON.stringify(entry.transactionId)}, not to the transaction ${JSON.stringify(transaction.transactionId)} it committed`,
        })
      }
      continue
    }
    if (!canonicalEquals(entry, transaction)) {
      violations.push({
        invariant: '34.6',
        message: `Ledger entry for idempotency key ${JSON.stringify(transaction.idempotencyKey)} no longer equals the committed transaction ${JSON.stringify(transaction.transactionId)}: a transaction result is immutable`,
      })
    }
  }

  for (const [key, entry] of Object.entries(state.idempotencyLedger)) {
    if (entry.idempotencyKey !== key) {
      violations.push({
        invariant: '34.6',
        message: `Ledger entry filed under idempotency key ${JSON.stringify(key)} records key ${JSON.stringify(entry.idempotencyKey)}`,
      })
    }
  }

  return violations
}
