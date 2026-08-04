/**
 * §34.11-§34.14 — the merge-owned invariants, surfaced through the shared
 * {@link OverlayInvariantViolation} shape (plan §8.3).
 *
 * The checks themselves are **not** reimplemented here: `merge/invariants.ts`
 * owns them and re-derives its answers from the merge request rather than from
 * anything the merge computed. This module only widens `MergeInvariantId` to
 * `OverlayInvariantId` so all twelve invariants share one result type and one
 * entry point.
 */
import {
  checkBaseDeletionRecovery,
  checkMergeInvariants,
  checkTouchedPreservation,
  checkUnsetSuppression,
  checkUntouchedInheritance,
  type InvariantViolation as MergeViolation,
} from '../merge/invariants'
import type {MergeRequest, MergeResult} from '../merge/types'
import type {OverlayInvariantViolation} from './types'

function widen(violation: MergeViolation): OverlayInvariantViolation {
  return {
    invariant: violation.invariant,
    message: violation.message,
    ...(violation.path === undefined ? {} : {path: violation.path}),
  }
}

/** §34.11 — a local unset continues to suppress later base values. */
export function checkMergeUnsetSuppression(
  request: MergeRequest,
  result: MergeResult,
): OverlayInvariantViolation[] {
  return checkUnsetSuppression(request, result).map(widen)
}

/** §34.12 — untouched paths always inherit current base values. */
export function checkMergeUntouchedInheritance(
  request: MergeRequest,
  result: MergeResult,
): OverlayInvariantViolation[] {
  return checkUntouchedInheritance(request, result).map(widen)
}

/** §34.13 — touched paths preserve local intent after base change. */
export function checkMergeTouchedPreservation(
  request: MergeRequest,
  result: MergeResult,
): OverlayInvariantViolation[] {
  return checkTouchedPreservation(request, result).map(widen)
}

/** §34.14 — base deletion never destroys a touched materialized document. */
export function checkMergeBaseDeletionRecovery(
  request: MergeRequest,
  result: MergeResult,
): OverlayInvariantViolation[] {
  return checkBaseDeletionRecovery(request, result).map(widen)
}

/** §34.11-§34.14 over one merge request/result pair. */
export function checkMergeResultInvariants(
  request: MergeRequest,
  result: MergeResult,
): OverlayInvariantViolation[] {
  return checkMergeInvariants(request, result).map(widen)
}
