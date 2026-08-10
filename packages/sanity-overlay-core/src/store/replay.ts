/**
 * The DURABLE ledger's own safety check (PRD §13.10, §34.6).
 *
 * `mutations/idempotency.ts` explains why a reused key is detectable; this is
 * where every store adapter applies it. It lives in core so the memory adapter
 * and `sanity-overlay-store-fs` cannot answer the same question two different
 * ways — the divergence that would let a defect be fixed in one and survive in
 * the other.
 *
 * Called from the replay branch of `commitTransaction`, BEFORE the stored record
 * is returned. That branch runs ahead of every precondition on purpose (a retry
 * of a committed transaction must never be rejected by a precondition it already
 * satisfied), which is exactly why it needed a check of its own: it was the one
 * path that could return a success without looking at the request at all.
 */
import {idempotencyReplayMismatch, idempotencyReuseMessage} from '../mutations/idempotency'
import {toPublishedId} from '../encoding'
import type {OverlayTransactionRecord} from '../types/transaction'
import type {OverlayCommitRequest} from './contract'
import {OverlayIdempotencyKeyReuseError} from './errors'

/**
 * The logical ids a commit request would write or remove.
 *
 * Both are normalized with `toPublishedId`, because that is the id space
 * `OverlayTransactionRecord.affectedDocumentIds` is recorded in — comparing a
 * `drafts.` address against it would report every draft write as a mismatch.
 */
export function commitRequestTargets(request: OverlayCommitRequest): string[] {
  const targets: string[] = []
  for (const record of request.records ?? []) {
    if (typeof record?.logicalId === 'string') targets.push(toPublishedId(record.logicalId))
  }
  for (const id of request.removedDocumentIds ?? []) {
    if (typeof id === 'string') targets.push(toPublishedId(id))
  }
  return targets
}

/**
 * Throw unless `replayed` really is a replay of `request`.
 *
 * A no-op for a genuine retry, which is the overwhelmingly common case, so the
 * §34.6 guarantee is untouched: one key still maps to one immutable result.
 */
export function assertGenuineStoreReplay(
  request: OverlayCommitRequest,
  replayed: OverlayTransactionRecord,
): void {
  const outside = idempotencyReplayMismatch(
    replayed.affectedDocumentIds,
    commitRequestTargets(request),
  )
  if (outside.length === 0) return
  throw new OverlayIdempotencyKeyReuseError(
    request.idempotencyKey,
    replayed.transactionId,
    replayed.affectedDocumentIds,
    outside,
    idempotencyReuseMessage(
      request.idempotencyKey,
      replayed.transactionId,
      replayed.affectedDocumentIds,
      outside,
    ),
  )
}
