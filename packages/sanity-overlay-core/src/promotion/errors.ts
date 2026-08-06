/**
 * Promotion-specific structured errors.
 *
 * The codes are PRD §25.13's promotion codes (`PROMOTION_BLOCKED`,
 * `PROMOTION_FAILED`) plus one this implementation adds for the half of §30 it
 * deliberately does not implement. They are declared here rather than in
 * `../errors` for the same reason `OverlayReferenceError` declares its own: the
 * shared code union is another workstream's file, and a promotion feature should
 * not require editing it.
 */
import {OverlayError, type OverlayErrorCode, type OverlayErrorDetails} from '../errors'
import type {PromotionPlanIssue} from './integrity'

export type OverlayPromotionErrorCode =
  /** PRD §25.13 — a plan cannot be applied as it stands. */
  | 'PROMOTION_BLOCKED'
  /** PRD §25.13 — an apply attempt failed. */
  | 'PROMOTION_FAILED'
  /** This package plans promotions and does not apply them. See `./apply`. */
  | 'PROMOTION_APPLY_NOT_IMPLEMENTED'

export class OverlayPromotionError extends OverlayError {
  readonly promotionCode: OverlayPromotionErrorCode
  /** The §30.6 precondition failures behind a `PROMOTION_BLOCKED`. */
  readonly issues: readonly PromotionPlanIssue[]

  constructor(
    promotionCode: OverlayPromotionErrorCode,
    message: string,
    options: {issues?: readonly PromotionPlanIssue[]; details?: OverlayErrorDetails} = {},
  ) {
    super(promotionCode as OverlayErrorCode, message, options.details ?? {})
    this.name = 'OverlayPromotionError'
    this.promotionCode = promotionCode
    this.issues = options.issues ?? []
  }
}
