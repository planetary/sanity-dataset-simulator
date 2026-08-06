/**
 * The apply half of PRD §30 — **deliberately not implemented**.
 *
 * Computing a promotion plan is offline, reversible and reviewable. Applying one
 * writes to a shared staging dataset, and that decision belongs to a human who is
 * awake and looking at the diff. So this package stops at the plan: there is no
 * HTTP client here, no token handling, no write path, and
 * {@link applyPromotionPlan} exists only to make the boundary loud rather than
 * silent. An absent function looks like an oversight; a function that throws with
 * a code cannot be mistaken for one.
 *
 * What *is* here is the **data** the apply side will need, so that the executor —
 * when someone writes it, under §26.7's separate publisher permission and §30.1's
 * separate privileged service — inherits a shape rather than inventing one:
 *
 * - {@link PromotionApplyReceipt}: §30.6 "Record Sanity transaction IDs and
 *   resulting revisions" and §30.9 "Store target transaction IDs and revisions".
 * - {@link PromotionApplyProgress}: §30.8 "Record completed steps" — the ledger
 *   that makes apply idempotent and makes a recovery plan derivable.
 * - {@link PromotionRecoveryPlan}: §30.8 "Generate a recovery plan".
 * - {@link PromotionCompletion}: §30.9 "Mark overlay `promoted`", which the store
 *   contract already exposes as `markPromoted` and the §13.1 manifest already has
 *   a `promotion` block for.
 *
 * The §30.6 preconditions themselves are *not* deferred: they are pure checks
 * over a plan and a fresh observation, and they live in `./integrity`
 * ({@link verifyPromotionPlan}, {@link promotionPreconditionMismatches}). An
 * executor should call them; nothing here can call them for it.
 */
import type {OverlayActor} from '../types/actor'
import {OverlayPromotionError} from './errors'
import type {PromotionOperation, PromotionPlan} from './types'

/** One PRD §30 requirement this package models but does not execute. */
export interface PromotionApplyGap {
  /** PRD section, e.g. `§30.6`. */
  section: string
  /** The requirement, in the PRD's own words. */
  requirement: string
  /** What exists here instead — the type or function that models its data. */
  modelled: string
}

/**
 * Every apply-side PRD §30 clause, as inspectable data.
 *
 * A test asserts this table is non-empty and covers §30.6, §30.8 and §30.9, so
 * the boundary cannot quietly erode: adding an apply path without updating this
 * table leaves the table lying, and removing the table breaks the test.
 */
export const PROMOTION_APPLY_GAPS: readonly PromotionApplyGap[] = Object.freeze([
  Object.freeze({
    section: '§30.6',
    requirement: 'Re-read target revisions immediately before apply.',
    modelled: 'verifyPromotionPlan / promotionPreconditionMismatches (pure checks, implemented)',
  }),
  Object.freeze({
    section: '§30.6',
    requirement: 'Require explicit publisher permission.',
    modelled: 'PromotionPlan.createdBy; authorization is §26.7 and lives outside core',
  }),
  Object.freeze({
    section: '§30.6',
    requirement: 'Group operations transactionally where valid.',
    modelled: 'PromotionOperation.phase (PRD §30.7 grouping); execution unimplemented',
  }),
  Object.freeze({
    section: '§30.6',
    requirement: 'Record Sanity transaction IDs and resulting revisions.',
    modelled: 'PromotionApplyReceipt',
  }),
  Object.freeze({
    section: '§30.6',
    requirement: 'Verify final target documents.',
    modelled: 'PromotionApplyReceipt.verified',
  }),
  Object.freeze({
    section: '§30.8',
    requirement: 'Record completed steps. Make apply idempotent.',
    modelled: 'PromotionApplyProgress',
  }),
  Object.freeze({
    section: '§30.8',
    requirement: 'Generate a recovery plan.',
    modelled: 'PromotionRecoveryPlan',
  }),
  Object.freeze({
    section: '§30.9',
    requirement: 'Mark overlay promoted; store target transaction IDs and revisions.',
    modelled: 'PromotionCompletion; OverlayManifest.promotion; OverlayStore.markPromoted',
  }),
])

/** PRD §30.6 / §30.9 — what one applied operation produced. */
export interface PromotionApplyReceipt {
  operationId: string
  /** Sanity transaction ID the operation landed in (§30.6). */
  transactionId: string
  /** Resulting Content Lake revision of the written document (§30.9). */
  resultingRevision?: string
  appliedAt: string
  /** §30.6 "Verify final target documents" — set once the read-back matched. */
  verified: boolean
}

/** PRD §30.8 — the ledger that makes a partially applied plan recoverable. */
export interface PromotionApplyProgress {
  planId: string
  planChecksum: string
  /** Receipts in the order the operations completed. */
  completed: readonly PromotionApplyReceipt[]
  /** Operation IDs that failed, with the error each raised. */
  failed: ReadonlyArray<{operationId: string; code: string; message: string}>
  startedAt: string
  finishedAt?: string
}

/** PRD §30.8 "Generate a recovery plan". */
export interface PromotionRecoveryPlan {
  planId: string
  /** The subset of the original plan that has not been confirmed applied. */
  remaining: readonly PromotionOperation[]
  /** Why recovery is needed, for the audit record (§31). */
  reason: string
}

/** PRD §30.9 — post-promotion bookkeeping. */
export interface PromotionCompletion {
  planId: string
  overlayId: string
  promotedAt: string
  promotedBy: OverlayActor
  /** §30.9 "Store target transaction IDs and revisions". */
  transactionIds: readonly string[]
  resultingRevisions: Readonly<Record<string, string>>
}

/**
 * Not implemented, and not an oversight.
 *
 * `sanity-overlay-core` plans promotions. Executing one is a write to a shared
 * dataset under a privileged credential (PRD §26.4, §30.1), which belongs to a
 * separate service. This function exists so that calling it fails loudly with a
 * code instead of being quietly absent.
 */
export function applyPromotionPlan(plan: PromotionPlan): never {
  throw new OverlayPromotionError(
    'PROMOTION_APPLY_NOT_IMPLEMENTED',
    `sanity-overlay-core plans promotions and does not apply them. Plan ${plan.id} targets ${plan.target.projectId}/${plan.target.dataset}; applying it requires the separate privileged promotion service (PRD §30.1, §30.6).`,
    {details: {planId: plan.id, gaps: PROMOTION_APPLY_GAPS}},
  )
}
