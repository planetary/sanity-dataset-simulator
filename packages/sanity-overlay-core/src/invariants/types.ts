/**
 * The Phase-2-scoped PRD §34 invariant identifiers and the structured violation
 * every check returns (plan docs/plans/phase-2-core-domain.md §8.3).
 */
import type {OverlayPath} from '../types/path'

/**
 * The twelve invariants plan §8.3 puts in Phase 2 scope, in PRD §34 order.
 *
 * §34.7 and §34.19 are Phase 4; §34.9, §34.18 and §34.20 are Phase 8; §34.10 is
 * partially covered by W4 and completes at publish/promotion; §34.15 is a Phase
 * 1/4 safety test; §34.16 is Phase 6. None are dropped — they are owned
 * elsewhere.
 */
export const OVERLAY_INVARIANT_IDS = [
  '34.1',
  '34.2',
  '34.3',
  '34.4',
  '34.5',
  '34.6',
  '34.8',
  '34.11',
  '34.12',
  '34.13',
  '34.14',
  '34.17',
] as const

export type OverlayInvariantId = (typeof OVERLAY_INVARIANT_IDS)[number]

/**
 * A single invariant breach.
 *
 * Structured rather than thrown so a caller can report every breach at once:
 * tests assert over the list, and runtime debug tooling renders it.
 */
export interface OverlayInvariantViolation {
  invariant: OverlayInvariantId
  message: string
  /** Logical document ID the breach belongs to, when the check knows one. */
  documentId?: string
  /** Path within the document, for the merge-side invariants. */
  path?: OverlayPath
}
