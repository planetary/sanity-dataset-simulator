/**
 * Injection points the promotion planner depends on and does not implement.
 *
 * Core is dependency-free and networkless (PRD §10.1, plan §3), and promotion is
 * the one place where that constraint does real safety work: the planner cannot
 * reach a Sanity dataset because there is no code path from here to a socket. The
 * caller — a separate privileged service, per §30.1 "Promotion uses a separate
 * privileged service" — fetches the current staging state and hands it in as a
 * value. Everything downstream is a pure function of that value.
 *
 * The same reasoning makes {@link TargetRevisionSource} synchronous. An async
 * port would put an await inside the planner and invite an IO-shaped
 * implementation to grow there; a synchronous snapshot cannot. Fetching happens
 * before `planPromotion` is called, never during it.
 */
import type {SanityDocument} from '../types/document'
import type {SerializedSchemaArtifact} from '../validation/schema'
import type {OverlayDocumentValidator} from '../validation/validator'

/** One version of a target document as staging currently holds it. */
export interface PromotionTargetVersion {
  /** Content Lake revision. Never a synthetic overlay `_rev` (PRD §13.9). */
  revision: string
  document: SanityDocument
}

/** The current state of one logical document in the target dataset. */
export interface PromotionTargetDocumentState {
  published: PromotionTargetVersion | null
  draft: PromotionTargetVersion | null
}

export type PromotionTargetSnapshot = Readonly<Record<string, PromotionTargetDocumentState>>

/**
 * PRD §30.4 step 3 — "Fetch current target draft and published documents."
 *
 * The planner calls this **once**, with every logical ID it intends to plan, and
 * treats the answer as the observation the whole plan is pinned to.
 */
export type TargetRevisionSource = (logicalIds: readonly string[]) => PromotionTargetSnapshot

/** A target that holds nothing: every document absent. */
export const EMPTY_TARGET_SOURCE: TargetRevisionSource = () => ({})

/**
 * Build a {@link TargetRevisionSource} over a fixed set of target documents.
 *
 * A document with no `_rev` is rejected rather than defaulted: PRD §30.6 requires
 * revision guards, and a guard built from a missing revision is not a guard.
 */
export function createTargetRevisionSource(
  documents: readonly SanityDocument[],
): TargetRevisionSource {
  const states = new Map<string, {published: PromotionTargetVersion | null; draft: PromotionTargetVersion | null}>()

  for (const document of documents) {
    if (typeof document._rev !== 'string' || document._rev.length === 0) {
      throw new Error(
        `Target document ${document._id} requires a "_rev" to build a promotion revision guard (PRD §30.6)`,
      )
    }
    const isDraft = document._id.startsWith('drafts.')
    const logicalId = isDraft ? document._id.slice('drafts.'.length) : document._id
    const existing = states.get(logicalId) ?? {published: null, draft: null}
    const version: PromotionTargetVersion = {revision: document._rev, document}
    if (isDraft) existing.draft = version
    else existing.published = version
    states.set(logicalId, existing)
  }

  return (logicalIds) => {
    const snapshot: Record<string, PromotionTargetDocumentState> = {}
    for (const logicalId of logicalIds) {
      snapshot[logicalId] = states.get(logicalId) ?? {published: null, draft: null}
    }
    return snapshot
  }
}

/** A branch-only asset the plan may have to carry to the target (PRD §24.2, §24.9). */
export interface BranchAssetInput {
  assetId: string
  kind: 'image' | 'file'
  /** §24.2 `promotedSanityAssetId` — set once the asset exists in the target. */
  promotedSanityAssetId?: string
}

/**
 * The branch asset inventory (PRD §24.9 step 5 "Include asset mapping in
 * promotion plan"). Injected for the same reason as the target snapshot: core
 * has no storage adapter and no uploader.
 */
export type BranchAssetSource = () => readonly BranchAssetInput[]

/** Input a caller-supplied plan-ID function receives. */
export interface PromotionPlanIdInput {
  overlayId: string
  overlayRevision: number
  /** SHA-256 over everything in the plan except its own `id` and `checksum`. */
  digest: string
}

export type PromotionPlanIdSource = (input: PromotionPlanIdInput) => string

/** Default plan lifetime — 30 minutes from `createdAt` (PRD §30.2 `expiresAt`). */
export const DEFAULT_PLAN_TTL_MS = 30 * 60 * 1000

export interface PromotionPorts {
  /** PRD §30.4 step 3. Required: a plan with no observed target is not a plan. */
  targetRevisions: TargetRevisionSource
  /** Injected clock. Core never calls `Date.now()` (plan §8.1). */
  now: () => string
  /** Defaults to a digest-derived ID, so plans stay deterministic (PRD §38.4). */
  planId?: PromotionPlanIdSource
  /** PRD §20.1 serialized schema artifact. Never Studio code. */
  schema?: SerializedSchemaArtifact
  /** PRD §30.4 step 11, run at the §20.5 `promotion` timing. */
  validate?: OverlayDocumentValidator
  /** PRD §24.9. Absent means "the branch created no assets". */
  assets?: BranchAssetSource
  /** Plan lifetime in milliseconds. Defaults to {@link DEFAULT_PLAN_TTL_MS}. */
  ttlMs?: number
}
