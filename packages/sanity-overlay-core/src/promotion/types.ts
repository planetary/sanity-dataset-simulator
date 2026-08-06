/**
 * The promotion plan model (PRD §30.2, §30.3, §30.5).
 *
 * §30.2 gives the plan shape as a TypeScript snippet; this file is that snippet
 * plus the four things it references but never defines (`PromotionOperation`,
 * `AssetPromotionMapping`, `ValidationSummary`, and the §30.5 review projection),
 * plus the two fields §30.6 needs to be enforceable rather than advisory (the
 * observed target revisions, and a per-operation precondition).
 *
 * Everything is plain data. A plan can be serialized with the canonical
 * serializer (§14.3), stored, reviewed in a pull request, and re-checked — which
 * is the whole point of §30.1 "Promotion is dry-run first".
 */
import type {OverlayActor} from '../types/actor'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayFormatVersion} from '../types/format-version'
import type {OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import type {ReferenceStrength} from '../references/types'
import type {OverlayValidationIssue} from '../validation/validator'
import type {DocumentChange} from './patch'

/** Which concrete version of a document an operation addresses. */
export type PromotionVersion = 'draft' | 'published'

/**
 * PRD §30.3 — every promotion operation type, verbatim and in §30.3's order.
 *
 * §30.3's "Update references after ID or asset mapping" is `update-references`:
 * it is a patch whose *only* changed paths are reference rewrites, kept distinct
 * so a reviewer can see that no editorial content moved.
 */
export const PROMOTION_OPERATION_TYPES = [
  'create-draft',
  'create-published',
  'patch-draft',
  'patch-published',
  'publish',
  'unpublish',
  'delete',
  'update-references',
  'upload-asset',
  'noop',
] as const

export type PromotionOperationType = (typeof PROMOTION_OPERATION_TYPES)[number]

/**
 * The guard an operation carries into apply (PRD §30.6 "Use revision guards
 * where supported").
 *
 * This is on the *operation*, not only on the plan, so a stale plan cannot be
 * applied even by an executor that skipped every plan-level check: the mutation
 * itself names the revision it expects the target to still be at, and `absent`
 * names a target that must still not exist.
 */
export type PromotionPrecondition =
  | {kind: 'absent'}
  | {kind: 'revision'; revision: string}

/** PRD §30.7 ordering phases, numbered as §30.7 numbers them. */
export type PromotionPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7

interface PromotionOperationCommon {
  /** Deterministic identity: `<type>:<targetId>`. No ID source, no randomness. */
  id: string
  phase: PromotionPhase
}

interface PromotionDocumentOperationCommon extends PromotionOperationCommon {
  logicalId: string
  /** Concrete target document ID — `drafts.`-prefixed for the draft version. */
  targetId: string
  version: PromotionVersion
  schemaType: string
  precondition: PromotionPrecondition
}

export type PromotionDocumentOperation =
  | (PromotionDocumentOperationCommon & {
      type: 'create-draft' | 'create-published'
      document: SanityDocument
    })
  | (PromotionDocumentOperationCommon & {
      type: 'patch-draft' | 'patch-published' | 'update-references'
      operations: OverlayOperation[]
    })
  | (PromotionDocumentOperationCommon & {
      type: 'publish'
      /** Why the plan needs this target published (PRD §30.7 step 4). */
      reason: 'strong-reference-target' | 'branch-published'
    })
  | (PromotionDocumentOperationCommon & {type: 'unpublish' | 'delete'})
  | (PromotionDocumentOperationCommon & {type: 'noop'; reason: 'target-matches'})

/** PRD §30.7 step 1 — asset upload. Planned here; executed nowhere (see `./apply`). */
export interface PromotionAssetUploadOperation extends PromotionOperationCommon {
  type: 'upload-asset'
  assetId: string
  kind: 'image' | 'file'
}

export type PromotionOperation = PromotionDocumentOperation | PromotionAssetUploadOperation

/** Narrow a plan operation to the document-shaped members. */
export function isDocumentOperation(
  operation: PromotionOperation,
): operation is PromotionDocumentOperation {
  return operation.type !== 'upload-asset'
}

/**
 * PRD §30.2 `AssetPromotionMapping` — the branch asset → Sanity asset table
 * (§24.9 steps 2-5, invariant §34.20).
 */
export interface AssetPromotionMapping {
  overlayAssetId: string
  kind: 'image' | 'file'
  /** Present once the asset exists in the target dataset (§24.9 step 2). */
  sanityAssetId?: string
  /** True while `sanityAssetId` is unknown — §34.20 blocks content apply. */
  uploadRequired: boolean
  /** Every promoted reference to this asset, sorted (§24.9 step 3). */
  references: ReadonlyArray<{
    logicalId: string
    version: PromotionVersion
    path: OverlayPath
  }>
}

/** PRD §30.2 `ValidationSummary` (§20.5 `promotion` timing). */
export interface ValidationSummary {
  errors: number
  warnings: number
  documents: ReadonlyArray<{
    logicalId: string
    version: PromotionVersion
    issues: readonly OverlayValidationIssue[]
  }>
}

/** Why a plan cannot be applied, or cannot be applied without acknowledgement. */
export type PromotionBlockerCode =
  /** An unresolved hard conflict (§30.1, §17.4). */
  | 'HARD_CONFLICT'
  /** An unresolved soft conflict — §17.4 "requires acknowledgement or resolution". */
  | 'UNACKNOWLEDGED_CONFLICT'
  /** A §20.5 `promotion`-timing validation error (§17.4 row "Schema validation error"). */
  | 'VALIDATION_ERROR'
  /** Invariant §34.9 — a branch-created ID already exists in the target. */
  | 'BRANCH_ID_COLLISION'
  /** Invariant §34.10 / §19.5 — a strong reference would be dangling after apply. */
  | 'STRONG_REFERENCE_INVALID'
  /** Invariant §34.20 — a promoted document references an unuploaded branch asset. */
  | 'UNMAPPED_BRANCH_ASSET'
  /** §30.7 cannot be satisfied: the reference graph of new documents has a cycle. */
  | 'ORDERING_CYCLE'

/**
 * `block` stops apply outright (§30.1 "blocks on unresolved hard conflicts").
 * `acknowledge` is §17.4's softer promotion verdict — a human may sign it off, but
 * the plan must not present itself as clean.
 */
export type PromotionBlockerSeverity = 'block' | 'acknowledge'

export interface PromotionBlocker {
  code: PromotionBlockerCode
  severity: PromotionBlockerSeverity
  message: string
  logicalId?: string
  path?: OverlayPath
}

/** PRD §30.5 "Reference impacts". */
export interface PromotionReferenceImpact {
  version: PromotionVersion
  path: OverlayPath
  targetId: string
  strength: ReferenceStrength
  /**
   * Where the target stands *after* this plan applies:
   * `present` — already published in the target;
   * `created-by-plan` — this plan creates it;
   * `draft-only` — exists (or will exist) only as a draft, which §19.5 rejects
   *   for a strong reference;
   * `missing` — nothing in the target and nothing in the plan provides it.
   */
  status: 'present' | 'created-by-plan' | 'draft-only' | 'missing'
}

/** One field-level change on one version, for the §30.5 review surface. */
export interface PromotionFieldChange extends DocumentChange {
  version: PromotionVersion
}

/** PRD §30.5 — everything the review UI shows for one document. */
export interface PromotionDocumentPlan {
  logicalId: string
  schemaType: string
  /** §30.5 "Action type". */
  actions: PromotionOperationType[]
  /** §30.5 "Current target state". */
  current: {published: SanityDocument | null; draft: SanityDocument | null}
  /** §30.5 "Proposed state". */
  proposed: {published: SanityDocument | null; draft: SanityDocument | null}
  /** §30.5 "Field-level diff". */
  changes: PromotionFieldChange[]
  /** §30.5 "Base revision at first touch". */
  baseRevisionAtFirstTouch: {published: string | null; draft: string | null}
  /** §30.5 "Current target revision". */
  targetRevision: {published: string | null; draft: string | null}
  /** §30.5 "Local overlay revision". */
  overlayRevision: {published: string | null; draft: string | null}
  /** §30.5 "Validation errors and warnings". */
  validation: readonly OverlayValidationIssue[]
  /** §30.5 "Reference impacts". */
  references: PromotionReferenceImpact[]
  /** §30.5 "Asset uploads". */
  assetUploads: string[]
  /** §30.5 "Conflict resolution status". */
  conflicts: OverlayConflict[]
}

/** The target revisions observed at plan time, per logical ID (§30.4 step 3). */
export interface PromotionTargetRevisions {
  published: string | null
  draft: string | null
}

/**
 * PRD §30.2 `PromotionPlan`, extended with the four fields the PRD's own
 * safeguards need in order to be checkable:
 *
 * - `target.revisions` — §30.6 "Verify overlay revision has not changed" has a
 *   sibling requirement, "Re-read target revisions immediately before apply". A
 *   plan that does not *record* what it observed cannot support that check.
 * - `documents` — the §30.5 review projection.
 * - `blockers` / `blocked` / `requiresAcknowledgement` — §30.1 and §17.4.
 * - `formatVersion` — the same migration hook every other §13 record carries.
 */
export interface PromotionPlan {
  formatVersion: OverlayFormatVersion
  id: string
  overlayId: string
  overlayRevision: number
  sourceSchemaCommitSha: string
  target: {
    projectId: string
    dataset: string
    observedAt: string
    revisions: Record<string, PromotionTargetRevisions>
  }
  operations: PromotionOperation[]
  documents: PromotionDocumentPlan[]
  assetMappings: AssetPromotionMapping[]
  conflicts: OverlayConflict[]
  validation: ValidationSummary
  blockers: PromotionBlocker[]
  /** Any `block`-severity blocker. §30.1: promotion blocks. */
  blocked: boolean
  /** Any `acknowledge`-severity blocker. §17.4: a human must sign it off. */
  requiresAcknowledgement: boolean
  createdAt: string
  createdBy: OverlayActor
  /** SHA-256 over the canonical serialization of this plan without `checksum`. */
  checksum: string
  expiresAt: string
}
