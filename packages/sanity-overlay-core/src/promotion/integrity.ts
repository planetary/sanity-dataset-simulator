/**
 * Plan checksum, expiry and invalidation (PRD §30.2, §30.6, invariant §34.18,
 * §35.14 "Expired plan cannot apply" / "Changed target revision invalidates
 * plan").
 *
 * > §34.18 — "Promotion applies only the exact approved plan revision and
 * > checksum."
 *
 * ## Why this is structural rather than advisory
 *
 * A plan is only meaningful relative to the staging state it was computed
 * against. Three separate mechanisms make that relationship impossible to lose,
 * and each one is independently sufficient:
 *
 * 1. **The plan records what it observed.** `target.revisions` names the exact
 *    revision of every target document at plan time, and it is *inside* the
 *    checksum. {@link verifyPromotionPlan} re-reads the target and compares.
 * 2. **Every operation carries its own guard.** Each content operation holds a
 *    {@link PromotionPrecondition} — a revision, or `absent`. An executor that
 *    ignored the plan header entirely would still be carrying a per-document
 *    revision guard into every mutation, and
 *    {@link promotionPreconditionMismatches} can detect a moved target from the
 *    operations alone.
 * 3. **`expiresAt` cannot be extended.** It is inside the checksum too, so the
 *    only way to make an expired plan look fresh is to break its signature.
 *
 * That is the difference between "the plan says it expires at 10:30" and "a plan
 * that claims a later expiry is not this plan". The second is checkable; the
 * first is a comment.
 */
import {checksum} from '../checksum'
import type {OverlayPath} from '../types/path'
import {OverlayPromotionError} from './errors'
import type {PromotionTargetSnapshot} from './ports'
import {isDocumentOperation, type PromotionPlan} from './types'

/** The checksum a plan carries: SHA-256 over the plan **without** its own `checksum`. */
export function promotionPlanChecksum(plan: PromotionPlan): string {
  const {checksum: _ignored, ...rest} = plan
  return checksum(rest)
}

/** Stamp a plan with its own checksum. */
export function signPlan(plan: PromotionPlan): PromotionPlan {
  return {...plan, checksum: promotionPlanChecksum({...plan, checksum: ''})}
}

/**
 * `createdAt + ttl`, as an ISO-8601 instant.
 *
 * Pure: the instant comes from the caller's injected clock, never from
 * `Date.now()`. `Date` is used only as an ISO-8601 codec.
 */
export function planExpiry(createdAt: string, ttlMs: number): string {
  const start = Date.parse(createdAt)
  if (Number.isNaN(start)) {
    throw new Error(`Promotion plan createdAt "${createdAt}" is not an ISO-8601 instant`)
  }
  return new Date(start + ttlMs).toISOString()
}

/** Is the plan past its `expiresAt`? The boundary instant is already expired. */
export function isPlanExpired(plan: PromotionPlan, now: string): boolean {
  return Date.parse(now) >= Date.parse(plan.expiresAt)
}

export type PromotionPlanIssueCode =
  /** The plan is not the plan that was signed (§34.18). */
  | 'PLAN_CHECKSUM_MISMATCH'
  /** §30.6 "Verify plan is not expired". */
  | 'PLAN_EXPIRED'
  /** §30.6 "Verify overlay revision has not changed". */
  | 'OVERLAY_REVISION_CHANGED'
  /** §30.6 "Re-read target revisions immediately before apply". */
  | 'TARGET_REVISION_CHANGED'
  /** A `create` operation's target has appeared since planning. */
  | 'TARGET_EXISTS'
  /** §30.1 "Promotion blocks on unresolved hard conflicts". */
  | 'PLAN_BLOCKED'
  /** §17.4 — soft conflicts require acknowledgement or resolution. */
  | 'PLAN_UNACKNOWLEDGED'

export interface PromotionPlanIssue {
  code: PromotionPlanIssueCode
  message: string
  logicalId?: string
  path?: OverlayPath
  expected?: string | null
  actual?: string | null
}

export interface PromotionPlanPreconditions {
  /** Injected clock value at check time. */
  now: string
  /** The overlay revision **now** (§30.6). */
  overlayRevision: number
  /** Freshly observed target state (§30.6 "Re-read target revisions"). */
  targetRevisions: PromotionTargetSnapshot
  /** The publisher has signed off the §17.4 soft conflicts. */
  acknowledged?: boolean
}

export interface PromotionPlanVerification {
  ok: boolean
  issues: PromotionPlanIssue[]
}

/**
 * Check every §30.6 precondition that can be checked without touching a dataset.
 *
 * A checksum mismatch short-circuits: once the plan is not the signed plan,
 * nothing else it claims is evidence of anything.
 */
export function verifyPromotionPlan(
  plan: PromotionPlan,
  input: PromotionPlanPreconditions,
): PromotionPlanVerification {
  const expected = promotionPlanChecksum({...plan, checksum: ''})
  if (expected !== plan.checksum) {
    return {
      ok: false,
      issues: [
        {
          code: 'PLAN_CHECKSUM_MISMATCH',
          message: `Promotion plan ${plan.id} does not match its signature (invariant §34.18)`,
          expected: plan.checksum,
          actual: expected,
        },
      ],
    }
  }

  const issues: PromotionPlanIssue[] = []

  if (isPlanExpired(plan, input.now)) {
    issues.push({
      code: 'PLAN_EXPIRED',
      message: `Promotion plan ${plan.id} expired at ${plan.expiresAt} (PRD §30.6)`,
      expected: plan.expiresAt,
      actual: input.now,
    })
  }

  if (plan.overlayRevision !== input.overlayRevision) {
    issues.push({
      code: 'OVERLAY_REVISION_CHANGED',
      message: `Overlay moved from revision ${plan.overlayRevision} to ${input.overlayRevision} since the plan was computed (PRD §30.6)`,
      expected: String(plan.overlayRevision),
      actual: String(input.overlayRevision),
    })
  }

  for (const logicalId of Object.keys(plan.target.revisions).sort()) {
    const planned = plan.target.revisions[logicalId]
    const observed = input.targetRevisions[logicalId] ?? {published: null, draft: null}
    for (const version of ['published', 'draft'] as const) {
      const before = planned?.[version] ?? null
      const after = observed[version]?.revision ?? null
      if (before === after) continue
      issues.push({
        code: 'TARGET_REVISION_CHANGED',
        message: `Target ${version} revision of ${logicalId} moved from ${before ?? 'absent'} to ${after ?? 'absent'} (PRD §30.6, §35.14)`,
        logicalId,
        expected: before,
        actual: after,
      })
    }
  }

  if (plan.blocked) {
    issues.push({
      code: 'PLAN_BLOCKED',
      message: `Promotion plan ${plan.id} carries ${plan.blockers.filter((blocker) => blocker.severity === 'block').length} blocking issue(s) (PRD §30.1)`,
    })
  }

  if (plan.requiresAcknowledgement && input.acknowledged !== true) {
    issues.push({
      code: 'PLAN_UNACKNOWLEDGED',
      message: `Promotion plan ${plan.id} has unresolved soft conflicts awaiting acknowledgement (PRD §17.4)`,
    })
  }

  return {ok: issues.length === 0, issues}
}

/**
 * The same target check, derived from the **operations** rather than from the
 * plan header.
 *
 * This is the second, independent guard described in the module header: it reads
 * each operation's own `precondition`, so it still works on a plan whose header
 * was stripped or rewritten, and it is what makes a per-mutation revision guard
 * (§30.6 "Use revision guards where supported") the structural mechanism rather
 * than a convention.
 */
export function promotionPreconditionMismatches(
  plan: PromotionPlan,
  observed: PromotionTargetSnapshot,
): PromotionPlanIssue[] {
  const issues: PromotionPlanIssue[] = []

  for (const operation of plan.operations) {
    if (!isDocumentOperation(operation)) continue
    const state = observed[operation.logicalId] ?? {published: null, draft: null}
    const current = (operation.version === 'draft' ? state.draft : state.published)?.revision ?? null

    if (operation.precondition.kind === 'absent') {
      if (current === null) continue
      issues.push({
        code: 'TARGET_EXISTS',
        message: `${operation.type} for ${operation.targetId} expects no target document, but one exists at revision ${current}`,
        logicalId: operation.logicalId,
        expected: null,
        actual: current,
      })
      continue
    }

    if (operation.precondition.revision === current) continue
    issues.push({
      code: 'TARGET_REVISION_CHANGED',
      message: `${operation.type} for ${operation.targetId} expects revision ${operation.precondition.revision}, target is at ${current ?? 'absent'}`,
      logicalId: operation.logicalId,
      expected: operation.precondition.revision,
      actual: current,
    })
  }

  return issues
}

/** {@link verifyPromotionPlan}, as an assertion. */
export function assertPromotionPlanApplicable(
  plan: PromotionPlan,
  input: PromotionPlanPreconditions,
): void {
  const {ok, issues} = verifyPromotionPlan(plan, input)
  if (ok) return
  throw new OverlayPromotionError(
    'PROMOTION_BLOCKED',
    `Promotion plan ${plan.id} cannot be applied: ${issues.map((issue) => issue.code).join(', ')}`,
    {issues, details: {planId: plan.id}},
  )
}
