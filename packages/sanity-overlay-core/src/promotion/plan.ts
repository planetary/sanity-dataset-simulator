/**
 * The promotion planner (PRD §30.4).
 *
 * ```text
 *  1. Lock plan to overlay revision.
 *  2. Load canonical or runtime overlay state.
 *  3. Fetch current target draft and published documents.
 *  4. Compare target to captured ancestor and local intent.
 *  5. Recompute conflicts.
 *  6. Resolve branch asset mappings.
 *  7. Calculate minimal target patches where safe.
 *  8. Use full create or replace only when required.
 *  9. Build action and transaction groups.
 * 10. Check strong references and operation ordering.
 * 11. Validate target documents against target schema.
 * 12. Produce human-readable and machine-readable diff.
 * 13. Sign plan checksum.
 * ```
 *
 * Steps 3 and 6 are ports (`./ports`); steps 4-5 are the existing §17 merge
 * engine with **current staging as `currentBase`**; steps 7-8 are `./patch`;
 * step 10 is `./order`; step 11 is the §20.1 validation port; step 12 is `./diff`;
 * step 13 is `./integrity`.
 *
 * ## Why staging is the merge's `currentBase`
 *
 * This is the single decision the whole module turns on. A conflict recorded when
 * the branch edit was made answers "did staging move between first touch and
 * then". The question promotion has to answer is "has staging moved between first
 * touch and *now*", and §30.1 says so directly: "Promotion uses current staging
 * as the target." So the planner re-runs `mergeDocument` with the ancestor
 * captured at first touch and the target document observed a moment ago. Two
 * consequences fall straight out, and both are load-bearing:
 *
 * - A path staging changed and the branch never touched keeps the *staging*
 *   value, so promotion cannot silently revert a colleague's edit (§34.12).
 * - A path both sides changed produces a conflict now, whether or not one was
 *   recorded then, and the plan carries it (§30.2 `conflicts`).
 *
 * Nothing in this file performs IO. The plan it returns is data — see `./apply`
 * for what deliberately does not exist.
 */
import {checksum} from '../checksum'
import {DRAFTS_PREFIX} from '../encoding'
import {persistConflicts, unresolvedConflicts} from '../conflicts/persist'
import {mergeDocument} from '../merge/merge'
import {explicitUnsetPaths} from '../mutations/operations'
import type {OverlayState} from '../mutations/state'
import {extractReferences} from '../references/extract'
import {OVERLAY_FORMAT_VERSION} from '../types/format-version'
import type {OverlayActor} from '../types/actor'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {LocalDocumentVersion, OverlayDocumentRecord} from '../types/record'
import type {OverlayValidationIssue} from '../validation/validator'
import {planExpiry, signPlan} from './integrity'
import {orderPromotionOperations, promotionReferenceEdges} from './order'
import {
  DEFAULT_PLAN_TTL_MS,
  type BranchAssetInput,
  type PromotionPorts,
  type PromotionTargetDocumentState,
} from './ports'
import {diffDocuments, type DocumentDiff} from './patch'
import {
  isDocumentOperation,
  type AssetPromotionMapping,
  type PromotionBlocker,
  type PromotionDocumentPlan,
  type PromotionFieldChange,
  type PromotionOperation,
  type PromotionPlan,
  type PromotionReferenceImpact,
  type PromotionTargetRevisions,
  type PromotionVersion,
  type ValidationSummary,
} from './types'

export interface PromotionPlanRequest {
  /** PRD §30.4 step 2 — the loaded overlay state. */
  state: OverlayState
  overlayId: string
  /** PRD §30.4 step 1 — the plan is locked to exactly this overlay revision. */
  overlayRevision: number
  /** PRD §7 — the authorized publisher. Recorded, never checked here. */
  actor: OverlayActor
  target: {projectId: string; dataset: string}
  /** PRD §20.1 — defaults to the injected artifact's `schemaCommit`. */
  sourceSchemaCommitSha?: string
}

const EMPTY_TARGET_STATE: PromotionTargetDocumentState = {published: null, draft: null}

function targetIdFor(logicalId: string, version: PromotionVersion): string {
  return version === 'draft' ? `${DRAFTS_PREFIX}${logicalId}` : logicalId
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Records the plan considers at all: anything the branch gave a local state. */
function plannableRecords(state: OverlayState): OverlayDocumentRecord[] {
  return Object.values(state.documents)
    .filter(
      (record) =>
        record.local.published !== null ||
        record.local.draft !== null ||
        record.local.publishedTombstone ||
        record.local.draftTombstone,
    )
    .sort((a, b) => compareStrings(a.logicalId, b.logicalId))
}

interface VersionOutcome {
  version: PromotionVersion
  /** The document promotion wants the target to hold, or `null` for a removal. */
  proposed: SanityDocument | null
  current: SanityDocument | null
  currentRevision: string | null
  ancestorRevision: string | null
  overlayRevision: string | null
  conflicts: OverlayConflict[]
  diff: DocumentDiff | null
  tombstoned: boolean
}

/**
 * PRD §30.4 steps 4-5 for one version of one document: three-way merge with the
 * *current target* standing in for `currentBase`.
 */
function resolveVersionOutcome(
  record: OverlayDocumentRecord,
  version: PromotionVersion,
  targetState: PromotionTargetDocumentState,
  now: string,
): VersionOutcome {
  const local: LocalDocumentVersion | null =
    version === 'draft' ? record.local.draft : record.local.published
  const tombstoned =
    version === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone
  const targetVersion = version === 'draft' ? targetState.draft : targetState.published
  const current = targetVersion?.document ?? null

  const baseBlock = record.base
  const ancestorVersion =
    baseBlock === null ? null : version === 'draft' ? baseBlock.draft : baseBlock.published
  // A draft-version merge falls back to the captured published ancestor, exactly
  // as the §18.2 resolution chain does.
  const ancestor =
    ancestorVersion?.snapshot ?? (version === 'draft' ? (baseBlock?.published?.snapshot ?? null) : null)

  const outcome: VersionOutcome = {
    version,
    proposed: null,
    current,
    currentRevision: targetVersion?.revision ?? null,
    ancestorRevision: ancestorVersion?.revision ?? null,
    overlayRevision: local?.overlayRevision ?? null,
    conflicts: [],
    diff: null,
    tombstoned,
  }

  if (tombstoned || local === null) return outcome

  const merged = mergeDocument({
    documentId: record.logicalId,
    now,
    ancestor,
    currentBase: current,
    localMaterialized: local.materialized,
    localTouchedPaths: local.touchedPaths,
    localTombstone: false,
    unsetPaths: explicitUnsetPaths(local.operations),
    origin: record.origin,
    // An ancestor that exists with no current target document means staging
    // deleted it since first touch (§16.4 row 2), which is a hard conflict.
    baseStatus: current === null && ancestor !== null ? 'deleted' : (baseBlock?.baseStatus ?? 'unknown'),
  })

  outcome.conflicts = merged.conflicts
  outcome.proposed = merged.document
  if (merged.document !== null) outcome.diff = diffDocuments(current, merged.document)
  return outcome
}

function operationsFor(
  record: OverlayDocumentRecord,
  outcome: VersionOutcome,
): PromotionOperation[] {
  const targetId = targetIdFor(record.logicalId, outcome.version)
  const common = {
    logicalId: record.logicalId,
    targetId,
    version: outcome.version,
    schemaType: record.schemaType,
    phase: 3 as const,
  }
  const guard = outcome.currentRevision === null
    ? ({kind: 'absent'} as const)
    : ({kind: 'revision', revision: outcome.currentRevision} as const)

  if (outcome.tombstoned) {
    // Nothing in the target: the branch removed a document staging never had.
    if (outcome.currentRevision === null) return []
    const isUnpublish =
      outcome.version === 'published' &&
      !record.local.draftTombstone &&
      record.local.draft !== null
    const type = isUnpublish ? ('unpublish' as const) : ('delete' as const)
    return [{...common, id: `${type}:${targetId}`, type, precondition: guard}]
  }

  if (outcome.proposed === null || outcome.diff === null) return []

  if (outcome.diff.identical) {
    return [
      {
        ...common,
        id: `noop:${targetId}`,
        type: 'noop',
        precondition: guard,
        reason: 'target-matches',
      },
    ]
  }

  if (outcome.current === null) {
    const type = outcome.version === 'draft' ? ('create-draft' as const) : ('create-published' as const)
    return [
      {
        ...common,
        id: `${type}:${targetId}`,
        type,
        precondition: guard,
        document: {...outcome.proposed, _id: targetId},
      },
    ]
  }

  const type = outcome.version === 'draft' ? ('patch-draft' as const) : ('patch-published' as const)
  return [
    {
      ...common,
      id: `${type}:${targetId}`,
      type,
      precondition: guard,
      operations: outcome.diff.operations,
    },
  ]
}

function referenceImpacts(
  outcomes: readonly VersionOutcome[],
  schema: PromotionPorts['schema'],
  targetHasPublished: (logicalId: string) => boolean,
  planCreatesPublished: (logicalId: string) => boolean,
  planCreatesDraft: (logicalId: string) => boolean,
): PromotionReferenceImpact[] {
  const impacts: PromotionReferenceImpact[] = []
  for (const outcome of outcomes) {
    if (outcome.proposed === null) continue
    for (const reference of extractReferences(outcome.proposed, {
      ...(schema === undefined ? {} : {schema}),
    })) {
      const status: PromotionReferenceImpact['status'] = targetHasPublished(reference.targetId)
        ? 'present'
        : planCreatesPublished(reference.targetId)
          ? 'created-by-plan'
          : planCreatesDraft(reference.targetId)
            ? 'draft-only'
            : 'missing'
      impacts.push({
        version: outcome.version,
        path: reference.path,
        targetId: reference.targetId,
        strength: reference.strength,
        status,
      })
    }
  }
  return impacts
}

function assetMappingsFor(
  entries: readonly {logicalId: string; outcomes: readonly VersionOutcome[]}[],
  assets: readonly BranchAssetInput[],
): AssetPromotionMapping[] {
  if (assets.length === 0) return []
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]))
  const mappings = new Map<string, AssetPromotionMapping>()

  for (const entry of entries) {
    for (const outcome of entry.outcomes) {
      if (outcome.proposed === null) continue
      for (const reference of extractReferences(outcome.proposed)) {
        const asset = byId.get(reference.targetId)
        if (asset === undefined) continue
        const existing =
          mappings.get(asset.assetId) ??
          ({
            overlayAssetId: asset.assetId,
            kind: asset.kind,
            uploadRequired: asset.promotedSanityAssetId === undefined,
            references: [],
            ...(asset.promotedSanityAssetId === undefined
              ? {}
              : {sanityAssetId: asset.promotedSanityAssetId}),
          } satisfies AssetPromotionMapping)
        ;(existing.references as Array<{logicalId: string; version: PromotionVersion; path: typeof reference.path}>).push({
          logicalId: entry.logicalId,
          version: outcome.version,
          path: reference.path,
        })
        mappings.set(asset.assetId, existing)
      }
    }
  }

  return [...mappings.values()].sort((a, b) => compareStrings(a.overlayAssetId, b.overlayAssetId))
}

/**
 * Compute a promotion plan (PRD §30.4). Pure: no IO, no clock, no ID source
 * beyond the injected ports.
 */
export function planPromotion(
  request: PromotionPlanRequest,
  ports: PromotionPorts,
): PromotionPlan {
  const now = ports.now()
  const records = plannableRecords(request.state)
  const logicalIds = records.map((record) => record.logicalId)

  /* Step 3 — one observation, for the whole plan. */
  const snapshot = ports.targetRevisions(logicalIds)

  const revisions: Record<string, PromotionTargetRevisions> = {}
  const entries: Array<{record: OverlayDocumentRecord; outcomes: VersionOutcome[]}> = []
  const conflicts: OverlayConflict[] = []
  const blockers: PromotionBlocker[] = []
  const validationDocuments: Array<{
    logicalId: string
    version: PromotionVersion
    issues: readonly OverlayValidationIssue[]
  }> = []
  let errors = 0
  let warnings = 0

  for (const record of records) {
    const targetState = snapshot[record.logicalId] ?? EMPTY_TARGET_STATE
    revisions[record.logicalId] = {
      published: targetState.published?.revision ?? null,
      draft: targetState.draft?.revision ?? null,
    }

    /* Steps 4-5 — recompute against current staging. */
    const outcomes: VersionOutcome[] = (['published', 'draft'] as const).map((version) =>
      resolveVersionOutcome(record, version, targetState, now),
    )

    /* §17.11 / §28.6 — carry an existing acknowledgement forward, but only while
     * the disagreement it acknowledged is unchanged. */
    const detected = outcomes.flatMap((outcome) => outcome.conflicts)
    const folded = persistConflicts(record, detected).conflicts
    conflicts.push(...folded)

    /* Invariant §34.9 — a branch-created ID must not already exist upstream. */
    if (
      record.origin === 'branch' &&
      (targetState.published !== null || targetState.draft !== null)
    ) {
      blockers.push({
        code: 'BRANCH_ID_COLLISION',
        severity: 'block',
        message: `Branch-created document ${record.logicalId} already exists in the target dataset (invariant §34.9)`,
        logicalId: record.logicalId,
      })
    }

    entries.push({record, outcomes})
  }

  /* Steps 7-9 — minimal patches, then operations. */
  const documentOperations: PromotionOperation[] = []
  for (const entry of entries) {
    for (const outcome of entry.outcomes) {
      documentOperations.push(...operationsFor(entry.record, outcome))
    }
  }

  /* Step 6 — branch asset mappings, and §34.20's pre-apply gate. */
  const assets = ports.assets?.() ?? []
  const assetMappings = assetMappingsFor(
    entries.map((entry) => ({logicalId: entry.record.logicalId, outcomes: entry.outcomes})),
    assets,
  )
  const assetOperations: PromotionOperation[] = assetMappings
    .filter((mapping) => mapping.uploadRequired)
    .map((mapping) => ({
      id: `upload-asset:${mapping.overlayAssetId}`,
      type: 'upload-asset',
      phase: 1,
      assetId: mapping.overlayAssetId,
      kind: mapping.kind,
    }))
  for (const mapping of assetMappings) {
    if (!mapping.uploadRequired) continue
    blockers.push({
      code: 'UNMAPPED_BRANCH_ASSET',
      severity: 'block',
      message: `Branch asset ${mapping.overlayAssetId} has no Sanity asset ID; content apply is blocked until it is uploaded (invariant §34.20)`,
    })
  }

  /* Step 10 — strong references, then ordering.
   *
   * The two are one step in §30.4 for a reason: the same graph decides whether a
   * reference survives promotion at all and in which order the operations that
   * write it have to run. */
  const createdPublished = new Set<string>()
  const createdDraft = new Set<string>()
  for (const operation of documentOperations) {
    if (!isDocumentOperation(operation)) continue
    if (operation.type === 'create-published') createdPublished.add(operation.logicalId)
    if (operation.type === 'create-draft') createdDraft.add(operation.logicalId)
  }
  const targetHasPublished = (logicalId: string): boolean =>
    (snapshot[logicalId]?.published ?? null) !== null

  const impactsByDocument = new Map<string, PromotionReferenceImpact[]>()
  for (const entry of entries) {
    impactsByDocument.set(
      entry.record.logicalId,
      referenceImpacts(
        entry.outcomes,
        ports.schema,
        targetHasPublished,
        (id) => createdPublished.has(id),
        (id) => createdDraft.has(id),
      ),
    )
  }

  /* §30.7 step 4 — a strong reference to a target that will exist only as a draft
   * is not a failure, it is a missing publish. A strong reference to a target that
   * exists nowhere is a failure (§19.5, invariant §34.10). */
  const publishTargets = new Set<string>()
  const missingStrongTargets = new Map<string, PromotionReferenceImpact & {from: string}>()
  for (const [logicalId, impacts] of impactsByDocument) {
    for (const impact of impacts) {
      if (impact.strength !== 'strong') continue
      if (impact.status === 'draft-only') publishTargets.add(impact.targetId)
      if (impact.status === 'missing' && !missingStrongTargets.has(impact.targetId)) {
        missingStrongTargets.set(impact.targetId, {...impact, from: logicalId})
      }
    }
  }

  for (const [targetId, impact] of [...missingStrongTargets].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    blockers.push({
      code: 'STRONG_REFERENCE_INVALID',
      severity: 'block',
      message: `${impact.from} holds a strong reference to ${targetId}, which is neither in the target dataset nor created by this plan (PRD §19.5, invariant §34.10)`,
      logicalId: impact.from,
      path: impact.path,
    })
  }

  const publishOperations: PromotionOperation[] = [...publishTargets]
    .sort(compareStrings)
    .map((logicalId) => {
      const record = entries.find((entry) => entry.record.logicalId === logicalId)?.record
      return {
        id: `publish:${logicalId}`,
        type: 'publish',
        logicalId,
        targetId: logicalId,
        version: 'published',
        schemaType: record?.schemaType ?? '',
        phase: 4,
        precondition:
          snapshot[logicalId]?.published?.revision === undefined
            ? {kind: 'absent'}
            : {kind: 'revision', revision: snapshot[logicalId]?.published?.revision as string},
        reason: 'strong-reference-target',
      } satisfies PromotionOperation
    })

  const edges = promotionReferenceEdges(
    entries.flatMap((entry) =>
      entry.outcomes.map((outcome) => ({
        logicalId: entry.record.logicalId,
        document: outcome.proposed,
      })),
    ),
    ports.schema,
  )

  const {operations, issues: orderingIssues} = orderPromotionOperations(
    [...assetOperations, ...documentOperations, ...publishOperations],
    {edges, strongReferenceTargets: [...publishTargets]},
  )

  for (const issue of orderingIssues) {
    blockers.push({
      code: 'ORDERING_CYCLE',
      severity: 'block',
      message: issue.message,
    })
  }

  /* Steps 11-12 — validation and the review projection. */
  const documents: PromotionDocumentPlan[] = []
  for (const entry of entries) {
    const operationsHere = operations.filter(
      (operation) => isDocumentOperation(operation) && operation.logicalId === entry.record.logicalId,
    )
    if (operationsHere.length === 0) continue

    const issues: OverlayValidationIssue[] = []
    for (const outcome of entry.outcomes) {
      if (outcome.proposed === null) continue
      const found =
        ports.validate?.(outcome.proposed, {
          logicalId: entry.record.logicalId,
          timing: 'promotion',
          typeName: entry.record.schemaType,
          ...(ports.schema === undefined ? {} : {schemaCommit: ports.schema.schemaCommit}),
        }) ?? []
      if (found.length === 0) continue
      issues.push(...found)
      validationDocuments.push({
        logicalId: entry.record.logicalId,
        version: outcome.version,
        issues: found,
      })
      for (const issue of found) {
        if (issue.level === 'error') errors += 1
        else warnings += 1
      }
    }

    const changes: PromotionFieldChange[] = entry.outcomes.flatMap((outcome) =>
      (outcome.diff?.changes ?? []).map((change) => ({version: outcome.version, ...change})),
    )

    const published = entry.outcomes.find((outcome) => outcome.version === 'published')
    const draft = entry.outcomes.find((outcome) => outcome.version === 'draft')

    documents.push({
      logicalId: entry.record.logicalId,
      schemaType: entry.record.schemaType,
      actions: operationsHere.map((operation) => operation.type),
      current: {published: published?.current ?? null, draft: draft?.current ?? null},
      proposed: {published: published?.proposed ?? null, draft: draft?.proposed ?? null},
      changes,
      baseRevisionAtFirstTouch: {
        published: published?.ancestorRevision ?? null,
        draft: draft?.ancestorRevision ?? null,
      },
      targetRevision: {
        published: published?.currentRevision ?? null,
        draft: draft?.currentRevision ?? null,
      },
      overlayRevision: {
        published: published?.overlayRevision ?? null,
        draft: draft?.overlayRevision ?? null,
      },
      validation: issues,
      references: impactsByDocument.get(entry.record.logicalId) ?? [],
      assetUploads: assetMappings
        .filter((mapping) =>
          mapping.references.some((reference) => reference.logicalId === entry.record.logicalId),
        )
        .map((mapping) => mapping.overlayAssetId),
      conflicts: entry.record.conflicts.length === 0 && entry.outcomes.every((o) => o.conflicts.length === 0)
        ? []
        : persistConflicts(entry.record, entry.outcomes.flatMap((o) => o.conflicts)).conflicts,
    })
  }

  if (errors > 0) {
    blockers.push({
      code: 'VALIDATION_ERROR',
      severity: 'block',
      message: `${errors} schema validation error(s) block promotion (PRD §17.4, §20.5)`,
    })
  }

  const sortedConflicts = [...conflicts].sort((a, b) => compareStrings(a.id, b.id))
  const live = unresolvedConflicts({conflicts: sortedConflicts})
  for (const conflict of live) {
    blockers.push(
      conflict.severity === 'hard'
        ? {
            code: 'HARD_CONFLICT',
            severity: 'block',
            message: `Unresolved hard conflict ${conflict.type} on ${conflict.documentId} (PRD §30.1)`,
            logicalId: conflict.documentId,
            ...(conflict.path === undefined ? {} : {path: conflict.path}),
          }
        : {
            code: 'UNACKNOWLEDGED_CONFLICT',
            severity: 'acknowledge',
            message: `Unacknowledged ${conflict.type} on ${conflict.documentId} (PRD §17.4)`,
            logicalId: conflict.documentId,
            ...(conflict.path === undefined ? {} : {path: conflict.path}),
          },
    )
  }

  const validation: ValidationSummary = {errors, warnings, documents: validationDocuments}

  const body: Omit<PromotionPlan, 'id' | 'checksum'> = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId: request.overlayId,
    overlayRevision: request.overlayRevision,
    sourceSchemaCommitSha: request.sourceSchemaCommitSha ?? ports.schema?.schemaCommit ?? '',
    target: {
      projectId: request.target.projectId,
      dataset: request.target.dataset,
      observedAt: now,
      revisions,
    },
    operations,
    documents,
    assetMappings,
    conflicts: sortedConflicts,
    validation,
    blockers,
    blocked: blockers.some((blocker) => blocker.severity === 'block'),
    requiresAcknowledgement: blockers.some((blocker) => blocker.severity === 'acknowledge'),
    createdAt: now,
    createdBy: request.actor,
    expiresAt: planExpiry(now, ports.ttlMs ?? DEFAULT_PLAN_TTL_MS),
  }

  /* Step 13 — a plan ID derived from the plan body, then the signature over it. */
  const digest = checksum(body)
  const id =
    ports.planId?.({
      overlayId: request.overlayId,
      overlayRevision: request.overlayRevision,
      digest,
    }) ?? `plan-${digest.slice(0, 16)}`

  return signPlan({...body, id, checksum: ''})
}
