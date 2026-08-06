/**
 * Phase 8 — promotion **planning** (PRD §30, roadmap Phase 8).
 *
 * ## What this module is, and what it deliberately is not
 *
 * Computing a promotion plan is pure, offline and reviewable: it reads overlay
 * state and an injected snapshot of the target dataset and produces data.
 * *Applying* one mutates a shared staging dataset. Those are different risk
 * classes, so they are different code — and only the first exists here.
 *
 * Nothing in `promotion/` performs IO, holds a token, or knows a URL. The current
 * staging revisions arrive through the injected {@link TargetRevisionSource} port;
 * the clock and plan-ID source are injected the same way the rest of core injects
 * them. The apply half is declared in `./apply` as types plus a function that
 * throws — see that file for exactly which PRD §30 clauses are unimplemented.
 */

/* Plan model — PRD §30.2, §30.3, §30.5. */
export {PROMOTION_OPERATION_TYPES, isDocumentOperation} from './types'
export type {
  AssetPromotionMapping,
  PromotionAssetUploadOperation,
  PromotionBlocker,
  PromotionBlockerCode,
  PromotionBlockerSeverity,
  PromotionDocumentOperation,
  PromotionDocumentPlan,
  PromotionFieldChange,
  PromotionOperation,
  PromotionOperationType,
  PromotionPhase,
  PromotionPlan,
  PromotionPrecondition,
  PromotionReferenceImpact,
  PromotionTargetRevisions,
  PromotionVersion,
  ValidationSummary,
} from './types'

/* Injected ports — PRD §30.4 step 3, §24.9, §20.1. */
export {
  DEFAULT_PLAN_TTL_MS,
  EMPTY_TARGET_SOURCE,
  createTargetRevisionSource,
} from './ports'
export type {
  BranchAssetInput,
  BranchAssetSource,
  PromotionPlanIdInput,
  PromotionPlanIdSource,
  PromotionPorts,
  PromotionTargetDocumentState,
  PromotionTargetSnapshot,
  PromotionTargetVersion,
  TargetRevisionSource,
} from './ports'

/* Minimal patch generation — PRD §30.4 steps 7-8. */
export {PROMOTION_IGNORED_FIELDS, diffDocuments} from './patch'
export type {DiffDocumentsOptions, DocumentChange, DocumentDiff} from './patch'

/* Operation ordering — PRD §30.7, §18.8. */
export {
  PROMOTION_PHASE_BY_TYPE,
  checkOperationOrdering,
  orderPromotionOperations,
  promotionReferenceEdges,
} from './order'
export type {
  OrderPromotionOptions,
  PromotionOrdering,
  PromotionOrderingIssue,
  PromotionOrderingIssueCode,
  PromotionReferenceEdge,
} from './order'

/* Plan checksum, expiry and invalidation — PRD §30.2, §30.6, §34.18. */
export {
  assertPromotionPlanApplicable,
  isPlanExpired,
  planExpiry,
  promotionPlanChecksum,
  promotionPreconditionMismatches,
  signPlan,
  verifyPromotionPlan,
} from './integrity'
export type {
  PromotionPlanIssue,
  PromotionPlanIssueCode,
  PromotionPlanPreconditions,
  PromotionPlanVerification,
} from './integrity'

/* Structured errors — PRD §25.13. */
export {OverlayPromotionError} from './errors'
export type {OverlayPromotionErrorCode} from './errors'

/* The apply half, which deliberately does not exist — PRD §30.6, §30.8, §30.9. */
export {PROMOTION_APPLY_GAPS, applyPromotionPlan} from './apply'
export type {
  PromotionApplyGap,
  PromotionApplyProgress,
  PromotionApplyReceipt,
  PromotionCompletion,
  PromotionRecoveryPlan,
} from './apply'

/* The human-readable diff — PRD §30.4 step 12, §30.5. */
export {renderPromotionDiff} from './diff'
export type {RenderPromotionDiffOptions} from './diff'

/* The planner — PRD §30.4. */
export {planPromotion} from './plan'
export type {PromotionPlanRequest} from './plan'
