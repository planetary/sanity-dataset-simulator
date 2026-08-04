/** PRD §13.10 — Transaction record. */
import type {OverlayActor} from './actor'
import type {OverlayFormatVersion} from './format-version'
import type {OverlayMutation} from './operations'

/**
 * PRD §13.10.
 *
 * `idempotencyKey` is the deduplication authority: one key maps to one immutable
 * transaction result (§34 invariant 6), and a retried request with the same key
 * returns the original result including its `transactionId`. `transactionId` is
 * server-assigned, unique within the overlay and lexicographically ordered by
 * commit time (for example a ULID); it never participates in deduplication.
 */
export interface OverlayTransactionRecord {
  formatVersion: OverlayFormatVersion
  transactionId: string
  overlayId: string
  overlayRevisionBefore: number
  overlayRevisionAfter: number
  actor: OverlayActor
  requestedAt: string
  committedAt: string
  mutations: OverlayMutation[]
  affectedDocumentIds: string[]
  /** Logical document ID → SHA-256 hex checksum of the committed canonical record. */
  resultChecksums: Record<string, string>
  requestId?: string
  idempotencyKey: string
}
