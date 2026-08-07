/**
 * The `ci` checks that read OVERLAY STATE.
 *
 * Every one of them is a composition. Nothing in this file decides whether an
 * overlay is valid, whether a reference resolves, or whether a merge conflicts —
 * `sanity-overlay-core` already owns all three, and a second opinion living in a
 * CI gate would be a second implementation to keep in sync with the first.
 *
 * What this file adds is the part core deliberately does not have: a CI-shaped
 * result. Findings with a severity, and a `measured` map proving the check saw
 * real documents rather than an empty directory.
 */
import {
  OVERLAY_INVARIANT_IDS,
  checkOverlayInvariants,
  createBaseSource,
  createOverlayState,
  extractReferences,
  getSchemaType,
  mergeDocument,
  referenceValidationIssues,
  summarizeConflicts,
} from '../../../sanity-overlay-core/src/index'
import type {
  BaseDocumentSource,
  OverlayConflict,
  OverlayDocumentRecord,
  OverlayManifest,
  SanityDocument,
  SerializedSchemaArtifact,
} from '../../../sanity-overlay-core/src/index'
import type {LoadedRecords, OpenedOverlay} from '../overlay'
import {ancestorFor, ancestorRevisionFor, localVersion, primaryVersion, tombstoned} from '../records'
import {formatPath} from '../render'
import type {CiCheckResult, CiFinding} from './checks'
import {resultOf, skipped} from './checks'

export interface OverlayCheckInput {
  readonly opened: OpenedOverlay
  readonly loaded: LoadedRecords
  readonly schema?: SerializedSchemaArtifact
  readonly baseDocuments?: readonly SanityDocument[]
  readonly now: string
}

/** Records in logical-ID order — a CI log is read by diffing it. */
function orderedRecords(loaded: LoadedRecords): OverlayDocumentRecord[] {
  return Object.keys(loaded.records)
    .sort()
    .map((logicalId) => loaded.records[logicalId]!)
}

/* ------------------------------------------------------------------ *
 * "Validate overlay file schemas."
 * ------------------------------------------------------------------ */

/**
 * The same three sources of truth `validate` uses (PRD §34, §14.3): the twelve
 * executable invariants, the adapter's own checksum recomputation, and the
 * per-document read failures `loadRecords` collects.
 *
 * The §34.3 runtime-revision sub-check is exempted for the reason
 * `commands/validate.ts` documents at length: `head.checksum` is the checksum of
 * the §13.3 RECORD while the §13.9 synthetic `_rev` embeds the checksum of the
 * materialized DOCUMENT, so no manifest a real store wrote can satisfy it. It is
 * reported as a warning here rather than dropped.
 */
const KNOWN_RUNTIME_REVISION_ISSUE = /names runtime revision .* whose checksum prefix does not match/

export async function overlaySchemasCheck(input: OverlayCheckInput): Promise<CiCheckResult> {
  const {opened, loaded} = input
  const state = createOverlayState({
    overlayId: opened.overlayId,
    revision: opened.manifest.revision,
    documents: {...loaded.records},
  })

  const violations = checkOverlayInvariants({
    state,
    manifest: opened.manifest,
    knownRefs: loaded.heads
      .filter((head) => loaded.records[head.logicalId] !== undefined)
      .map((head) => head.storageRef),
  })
  const checksums = await opened.store.verifyChecksums(opened.overlayId)
  const findings: CiFinding[] = []

  for (const violation of violations) {
    const known =
      violation.invariant === '34.3' && KNOWN_RUNTIME_REVISION_ISSUE.test(violation.message)
    findings.push({
      severity: known ? 'warning' : 'error',
      ref: violation.documentId ?? opened.overlayId,
      message: `§${violation.invariant} ${violation.message}`,
    })
  }
  for (const entry of loaded.unreadable) {
    findings.push({
      severity: 'error',
      ref: entry.logicalId,
      message: `${entry.code}: ${entry.message}`,
    })
  }
  for (const issue of checksums.issues) {
    findings.push({
      severity: 'error',
      ref: issue.ref,
      message: `checksum mismatch: expected ${issue.expected}, got ${issue.actual}${
        issue.repairable ? ' (repairable — `normalize --repair-checksums`)' : ''
      }`,
    })
  }
  for (const ref of [...checksums.missing, ...loaded.missingSnapshots]) {
    findings.push({severity: 'error', ref: ref.ref, message: ref.reason})
  }

  return resultOf('overlay-schemas', findings, {
    documents: loaded.heads.length,
    invariants: OVERLAY_INVARIANT_IDS.length,
    checksums: checksums.checked,
    unreadable: loaded.unreadable.length,
  })
}

/* ------------------------------------------------------------------ *
 * "Validate branch schema."
 * ------------------------------------------------------------------ */

function countFields(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countFields(item), 0)
  if (value === null || typeof value !== 'object') return 0
  let total = 0
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    total += 1 + countFields(child)
  }
  return total
}

/**
 * PRD §20.5 "[SHOULD] In CI: validate canonical overlay files against the branch
 * schema", plus §20.1 "[MUST] Store schema commit SHA in the overlay manifest".
 *
 * Three rules, all of them from the artifact and none invented here:
 *
 * 1. The manifest's `source.schemaCommitSha` must exist and must equal the
 *    artifact's `schemaCommit`. Without it, "validated against the branch schema"
 *    names no particular schema.
 * 2. Every document's `_type` must be declared by the artifact.
 * 3. Every field the artifact marks `required` must be present.
 */
export function branchSchemaCheck(input: OverlayCheckInput): CiCheckResult {
  const {opened, loaded, schema} = input
  if (schema === undefined) {
    return skipped(
      'branch-schema',
      'no branch schema to validate against: pass --schema <artifact.json> (the PRD §20.1 serialized schema artifact). Nothing is assumed about a schema the run was not given.',
      {documents: loaded.heads.length, schemaTypes: 0},
    )
  }

  const findings: CiFinding[] = []
  const declared = opened.manifest.source.schemaCommitSha
  if (declared === undefined || declared.length === 0) {
    findings.push({
      severity: 'error',
      ref: opened.overlayId,
      message:
        `manifest.source.schemaCommitSha is absent, so the overlay does not record which branch ` +
        `schema its documents were written against and this check cannot bind the artifact ` +
        `(schemaCommit ${JSON.stringify(schema.schemaCommit)}) to it. PRD §20.1 requires it.`,
    })
  } else if (declared !== schema.schemaCommit) {
    findings.push({
      severity: 'error',
      ref: opened.overlayId,
      message:
        `manifest.source.schemaCommitSha is ${JSON.stringify(declared)} but the --schema artifact ` +
        `declares schemaCommit ${JSON.stringify(schema.schemaCommit)}. The overlay was written ` +
        `against a different branch schema than the one CI is validating with (PRD §20.1).`,
    })
  }

  let documents = 0
  let fieldsChecked = 0
  for (const record of orderedRecords(loaded)) {
    const kind = primaryVersion(record)
    const local = kind === null ? null : localVersion(record, kind)
    if (local === null) continue
    documents += 1
    const document = local.materialized
    fieldsChecked += countFields(document)

    const type = getSchemaType(schema, document._type)
    if (type === undefined || type === null) {
      findings.push({
        severity: 'error',
        ref: record.logicalId,
        message: `document type ${JSON.stringify(document._type)} is not declared by the branch schema artifact`,
      })
      continue
    }

    for (const field of type.fields ?? []) {
      if (field.required !== true || field.name === undefined) continue
      const value = (document as Record<string, unknown>)[field.name]
      if (value !== undefined && value !== null) continue
      findings.push({
        severity: 'error',
        ref: record.logicalId,
        message: `required field ${JSON.stringify(field.name)} of type ${JSON.stringify(document._type)} is absent`,
      })
    }
  }

  return resultOf('branch-schema', findings, {
    documents,
    schemaTypes: schema.types.length,
    fieldsChecked,
  })
}

/* ------------------------------------------------------------------ *
 * "Validate strong references."
 * ------------------------------------------------------------------ */

/**
 * PRD §19.5 and invariant §34.10, through core's `referenceValidationIssues`.
 *
 * `--base` is required for the same reason `rebase` requires it: fs mode has no
 * Content Lake connection, and a reference check run against an assumed-empty
 * base would report every reference into the base dataset as dangling. That is
 * not a conservative default, it is a false positive generator, and a gate that
 * cries wolf is switched off within a week.
 */
export function strongReferencesCheck(input: OverlayCheckInput): CiCheckResult {
  const {loaded, schema, baseDocuments} = input
  if (baseDocuments === undefined) {
    return skipped(
      'strong-references',
      'no base dataset to resolve reference targets against: pass --base <file.json>. In fs mode the CLI has no connection to the Content Lake, and assuming an empty base would report every reference into the base dataset as dangling.',
      {documents: Object.keys(loaded.records).length, references: 0},
    )
  }

  const base: BaseDocumentSource = createBaseSource(baseDocuments)
  const state = createOverlayState({
    overlayId: 'ci',
    revision: 0,
    documents: {...loaded.records},
  })

  const findings: CiFinding[] = []
  let documents = 0
  let references = 0
  let strong = 0
  let weak = 0

  for (const record of orderedRecords(loaded)) {
    const kind = primaryVersion(record)
    const local = kind === null ? null : localVersion(record, kind)
    if (local === null) continue
    documents += 1

    for (const reference of extractReferences(local.materialized, {
      ...(schema === undefined ? {} : {schema}),
    })) {
      references += 1
      if (reference.strength === 'strong') strong += 1
      else weak += 1
    }

    for (const issue of referenceValidationIssues(state, record.logicalId, {
      base,
      ...(schema === undefined ? {} : {schema}),
    })) {
      findings.push({
        severity: issue.level === 'error' ? 'error' : 'warning',
        ref: `${record.logicalId}${issue.path === undefined ? '' : `#${formatPath(issue.path)}`}`,
        message: `${issue.ruleId}: ${issue.message}`,
      })
    }
  }

  return resultOf('strong-references', findings, {
    documents,
    references,
    strong,
    weak,
    baseDocuments: baseDocuments.length,
  })
}

/* ------------------------------------------------------------------ *
 * "Check checkpoint status policy."
 * ------------------------------------------------------------------ */

export const CHECKPOINT_POLICIES = ['required', 'warn', 'off'] as const
export type CheckpointPolicy = (typeof CHECKPOINT_POLICIES)[number]

/**
 * PRD §29.6: "Manifest shows `checkpoint.overlayRevision < manifest.revision` …
 * CI can choose whether uncheckpointed runtime state is acceptable."
 *
 * The default is `required`, which is decision D05's *default when unanswered*
 * — "Block merge when uncheckpointed revisions exist". A project that has
 * answered D05 differently passes `--checkpoint-policy warn`; `off` does not
 * report success, it reports a skip, because a policy switched off is not a
 * policy that passed.
 */
export function checkpointPolicyCheck(
  manifest: OverlayManifest,
  policy: CheckpointPolicy,
): CiCheckResult {
  const checkpointRevision = manifest.checkpoint?.overlayRevision ?? 0
  const uncheckpointed = Math.max(0, manifest.revision - checkpointRevision)
  const measured = {
    revision: manifest.revision,
    checkpointRevision,
    uncheckpointedRevisions: uncheckpointed,
    hasCheckpoint: manifest.checkpoint === undefined ? 0 : 1,
  }

  if (policy === 'off') {
    return skipped(
      'checkpoint-policy',
      'disabled by --checkpoint-policy off. PRD §29.6 lets a project decide whether uncheckpointed runtime state is acceptable; this run made no assertion about it.',
      measured,
    )
  }

  const findings: CiFinding[] = []
  if (uncheckpointed > 0) {
    findings.push({
      severity: policy === 'required' ? 'error' : 'warning',
      ref: manifest.overlayId,
      message:
        manifest.checkpoint === undefined
          ? `overlay is at revision ${manifest.revision} and has never been checkpointed, so ${uncheckpointed} runtime revision(s) exist only in the store and not in Git (PRD §29.2, §29.6). Run \`sanity-overlay export --output .sanity-overlay\` and commit.`
          : `overlay is at revision ${manifest.revision} but the last checkpoint is revision ${checkpointRevision}: ${uncheckpointed} uncheckpointed revision(s) (PRD §29.6).`,
    })
  }
  if (manifest.status === 'conflicted') {
    findings.push({
      severity: policy === 'required' ? 'error' : 'warning',
      ref: manifest.overlayId,
      message: `overlay status is "conflicted"; a conflicted overlay must not be checkpointed as-is (PRD §12.3, §17.4).`,
    })
  }

  return resultOf('checkpoint-policy', findings, measured)
}

/* ------------------------------------------------------------------ *
 * "Report conflict summary on PR."
 * ------------------------------------------------------------------ */

export interface ConflictSummaryDetail {
  readonly documentId: string
  readonly type: string
  readonly severity: string
  readonly path: string | null
  readonly resolved: boolean
}

export interface ConflictSummaryCheck {
  readonly result: CiCheckResult
  readonly summary: {total: number; hard: number; soft: number}
  readonly manifestSummary: OverlayManifest['conflictSummary']
  readonly conflicts: readonly ConflictSummaryDetail[]
}

/**
 * The §13.1 `conflictSummary` and the §13.3 per-document conflicts.
 *
 * Only UNRESOLVED HARD conflicts fail: §17.4 is what blocks, and a resolved or
 * soft conflict that failed CI would make the resolution actions in §28.3
 * pointless. Everything is reported either way — the point of this check is the
 * report, and the exit code is the smaller half of it.
 */
export function conflictSummaryCheck(input: OverlayCheckInput): ConflictSummaryCheck {
  const {loaded, opened} = input
  const collected: OverlayConflict[] = []
  for (const record of orderedRecords(loaded)) collected.push(...(record.conflicts ?? []))
  collected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const unresolved = collected.filter((conflict) => conflict.resolution === undefined)
  const findings: CiFinding[] = unresolved.map((conflict) => ({
    severity: conflict.severity === 'hard' ? 'error' : 'warning',
    ref: conflict.documentId,
    message: `${conflict.severity} conflict ${conflict.type}${
      conflict.path === undefined ? '' : ` at ${formatPath(conflict.path)}`
    } is unresolved (PRD §17.4, §28.3)`,
  }))

  const summary = summarizeConflicts(collected)
  return {
    result: resultOf('conflict-summary', findings, {
      documents: Object.keys(loaded.records).length,
      conflicts: collected.length,
      unresolved: unresolved.length,
      hard: summary.hard,
      soft: summary.soft,
    }),
    summary,
    manifestSummary: opened.manifest.conflictSummary,
    conflicts: collected.map((conflict) => ({
      documentId: conflict.documentId,
      type: conflict.type,
      severity: conflict.severity,
      path: conflict.path === undefined ? null : formatPath(conflict.path),
      resolved: conflict.resolution !== undefined,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * "Schedule recurring base drift scan for open overlays."
 * ------------------------------------------------------------------ */

export interface BaseDriftCheck {
  readonly result: CiCheckResult
  /** Recomputed §13.1 summary. Never written — §16.6 forbids changing intent. */
  readonly recomputed: {total: number; hard: number; soft: number}
  readonly previous: OverlayManifest['conflictSummary']
  readonly changed: boolean
  readonly driftedDocuments: readonly string[]
}

/**
 * PRD §16.6 — the scan half of the scheduled base drift scan.
 *
 * "Batch-read current draft and published revisions for touched logical IDs.
 * Recompute conflict summaries **without changing local intent**."
 *
 * So this function reads and computes and returns; it never touches the store.
 * Drift is detected by comparing the merge ancestor's revision (PRD §13.3,
 * captured at first touch) with the `_rev` of the current base document, and the
 * consequence is computed by re-running core's §17.3 merge with the new base.
 *
 * KNOWN NARROWING: the re-run passes `localTouchedPaths` but not the §17.5
 * `unsetPaths`, which the §13.3 record stores as operations rather than as a
 * path list. An unset held down over a base value that came back can therefore
 * be under-reported. It is a scan whose output is a *report*, and the authority
 * for blocking remains the persisted §13.11 conflicts on the record.
 */
export function baseDriftCheck(input: OverlayCheckInput): BaseDriftCheck {
  const {loaded, opened, baseDocuments, now} = input
  const previous = opened.manifest.conflictSummary

  if (baseDocuments === undefined) {
    return {
      result: skipped(
        'base-drift',
        'no current base to compare against: pass --base <file.json>. PRD §16.6 requires the scan to "treat direct base reads as authoritative"; in fs mode the CLI has no base connection and will not assume the base has not moved.',
        {documents: Object.keys(loaded.records).length, drifted: 0},
      ),
      recomputed: {total: 0, hard: 0, soft: 0},
      previous,
      changed: false,
      driftedDocuments: [],
    }
  }

  const baseById = new Map<string, SanityDocument>()
  for (const document of baseDocuments) {
    if (typeof document._id === 'string') baseById.set(document._id, document)
  }

  const conflicts: OverlayConflict[] = []
  const drifted: string[] = []
  let documents = 0

  for (const record of orderedRecords(loaded)) {
    const kind = primaryVersion(record)
    const local = kind === null ? null : localVersion(record, kind)
    if (local === null) continue
    documents += 1

    const currentBase = baseById.get(record.logicalId) ?? null
    const ancestorRevision = ancestorRevisionFor(record, local)
    const currentRevision = typeof currentBase?._rev === 'string' ? currentBase._rev : null
    const hasDrifted =
      record.base !== null && ancestorRevision !== null && currentRevision !== ancestorRevision
    if (hasDrifted) drifted.push(record.logicalId)

    const merged = mergeDocument({
      documentId: record.logicalId,
      now,
      ancestor: ancestorFor(record, local),
      currentBase,
      localMaterialized: local.materialized,
      localTouchedPaths: local.touchedPaths,
      localTombstone: tombstoned(record, kind!),
      origin: record.origin,
      ...(record.base?.baseStatus === undefined ? {} : {baseStatus: record.base.baseStatus}),
    })
    conflicts.push(...merged.conflicts)
  }

  const recomputed = summarizeConflicts(conflicts)
  const changed =
    recomputed.total !== previous.total ||
    recomputed.hard !== previous.hard ||
    recomputed.soft !== previous.soft

  const findings: CiFinding[] = []
  for (const logicalId of drifted) {
    findings.push({
      severity: 'warning',
      ref: logicalId,
      message: `base moved since first touch: the merge ancestor revision no longer matches the current base revision (PRD §16.6)`,
    })
  }
  if (changed) {
    findings.push({
      severity: 'error',
      ref: opened.overlayId,
      message:
        `base drift changed the conflict summary: manifest records ` +
        `total=${previous.total} hard=${previous.hard} soft=${previous.soft}, the scan recomputes ` +
        `total=${recomputed.total} hard=${recomputed.hard} soft=${recomputed.soft}. PRD §16.6 ` +
        `requires the pull request status check and conflict summary to be refreshed.`,
    })
  }

  return {
    result: resultOf('base-drift', findings, {
      documents,
      drifted: drifted.length,
      conflictsAfterScan: recomputed.total,
      hardAfterScan: recomputed.hard,
      summaryChanged: changed ? 1 : 0,
    }),
    recomputed,
    previous,
    changed,
    driftedDocuments: drifted,
  }
}
