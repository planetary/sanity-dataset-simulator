/**
 * The human-readable promotion diff (PRD §30.4 step 12, §30.5).
 *
 * > 12. Produce human-readable and machine-readable diff.
 *
 * The machine-readable half is the {@link PromotionPlan} itself. This is the
 * other half: the text a publisher reads immediately before deciding to write to
 * a dataset other people depend on. It is therefore optimized for one thing —
 * being able to tell, per document and per path, exactly what would change — and
 * it shows the §30.5 review fields around each change rather than only the change.
 *
 * Determinism is not cosmetic here. Values are rendered through the canonical
 * serializer (§14.3), so two objects that differ only in key insertion order
 * render identically and a diff of two plan renderings shows only real
 * differences (§34.17).
 */
import {encodeOverlayPath} from '../encoding'
import {serializeCompact} from '../serialize'
import type {OverlayConflict} from '../types/conflict'
import type {OverlayValidationIssue} from '../validation/validator'
import {
  isDocumentOperation,
  type PromotionDocumentPlan,
  type PromotionFieldChange,
  type PromotionOperation,
  type PromotionPlan,
} from './types'

export interface RenderPromotionDiffOptions {
  /** Values longer than this are truncated with `…`. Default 200. */
  maxValueLength?: number
}

const DEFAULT_MAX_VALUE_LENGTH = 200

/** Canonical JSON on one line: sorted keys, no incidental whitespace. */
function renderValue(value: unknown, maxLength: number): string {
  const text = serializeCompact(value).replace(/\n\s*/g, ' ')
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

function label(name: string, value: string): string {
  return `  ${name.padEnd(12)}${value}`
}

function versionPair(pair: {published: string | null; draft: string | null}): string {
  const parts: string[] = []
  if (pair.published !== null) parts.push(`published ${pair.published}`)
  if (pair.draft !== null) parts.push(`draft ${pair.draft}`)
  return parts.length === 0 ? 'absent' : parts.join(', ')
}

const CHANGE_MARKER: Readonly<Record<PromotionFieldChange['kind'], string>> = Object.freeze({
  add: '+',
  remove: '-',
  change: '~',
})

function operationLabel(operation: PromotionOperation): string {
  return isDocumentOperation(operation) ? operation.targetId : operation.assetId
}

function summarize(operations: readonly PromotionOperation[]): string {
  if (operations.length === 0) return 'no operations'
  const counts = new Map<string, number>()
  for (const operation of operations) {
    counts.set(operation.type, (counts.get(operation.type) ?? 0) + 1)
  }
  const parts = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([type, count]) => `${type} ${count}`)
  const noun = operations.length === 1 ? 'operation' : 'operations'
  return `${operations.length} ${noun} (${parts.join(', ')})`
}

function statusOf(plan: PromotionPlan): string {
  if (plan.blocked) return 'BLOCKED'
  if (plan.requiresAcknowledgement) return 'NEEDS ACKNOWLEDGEMENT'
  return 'ready'
}

function renderChange(change: PromotionFieldChange, maxLength: number): string[] {
  const lines = [`    ${CHANGE_MARKER[change.kind]} ${change.version} ${encodeOverlayPath(change.path)}`]
  if (change.kind !== 'add') lines.push(`        - ${renderValue(change.before, maxLength)}`)
  if (change.kind !== 'remove') lines.push(`        + ${renderValue(change.after, maxLength)}`)
  return lines
}

function renderDocument(
  entry: PromotionDocumentPlan,
  maxLength: number,
): string[] {
  const lines = [
    `${entry.logicalId} (${entry.schemaType})`,
    label('action', entry.actions.join(', ')),
    label('target rev', versionPair(entry.targetRevision)),
    label('base rev', versionPair(entry.baseRevisionAtFirstTouch)),
    label('overlay rev', versionPair(entry.overlayRevision)),
  ]

  if (entry.assetUploads.length > 0) {
    lines.push(label('assets', entry.assetUploads.join(', ')))
  }
  for (const reference of entry.references) {
    lines.push(
      label(
        'reference',
        `${encodeOverlayPath(reference.path)} -> ${reference.targetId} (${reference.strength}, ${reference.status})`,
      ),
    )
  }

  lines.push('  changes')
  if (entry.changes.length === 0) {
    lines.push('    (no field changes — target already matches)')
  } else {
    for (const change of entry.changes) lines.push(...renderChange(change, maxLength))
  }
  return lines
}

function renderConflict(conflict: OverlayConflict): string {
  const path = conflict.path === undefined ? '$' : encodeOverlayPath(conflict.path)
  const status =
    conflict.resolution === undefined ? 'unresolved' : `resolved (${conflict.resolution.type})`
  return `  ! ${conflict.severity} ${conflict.type} ${conflict.documentId} ${path} ${status}`
}

function renderValidation(
  logicalId: string,
  issue: OverlayValidationIssue,
): string {
  const path = issue.path === undefined ? '$' : encodeOverlayPath(issue.path)
  return `  ${issue.level} ${logicalId} ${path} ${issue.message}`
}

/** Render a promotion plan as reviewable text. Pure and deterministic. */
export function renderPromotionDiff(
  plan: PromotionPlan,
  options: RenderPromotionDiffOptions = {},
): string {
  const maxLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH
  const lines: string[] = [
    `Promotion plan ${plan.id}`,
    label('overlay', `${plan.overlayId} revision ${plan.overlayRevision}`),
    label('target', `${plan.target.projectId}/${plan.target.dataset} observed ${plan.target.observedAt}`),
    label('expires', plan.expiresAt),
    label('status', statusOf(plan)),
    label('summary', summarize(plan.operations)),
  ]

  for (const entry of plan.documents) {
    lines.push('', ...renderDocument(entry, maxLength))
  }

  if (plan.conflicts.length > 0) {
    lines.push('', 'conflicts')
    for (const conflict of plan.conflicts) lines.push(renderConflict(conflict))
  }

  if (plan.validation.documents.length > 0) {
    lines.push('', 'validation')
    for (const entry of plan.validation.documents) {
      for (const issue of entry.issues) lines.push(renderValidation(entry.logicalId, issue))
    }
  }

  if (plan.blockers.length > 0) {
    lines.push('', 'blockers')
    for (const blocker of plan.blockers) {
      const scope = blocker.logicalId === undefined ? '' : ` ${blocker.logicalId}`
      lines.push(`  [${blocker.severity}] ${blocker.code}${scope} ${blocker.message}`)
    }
  }

  lines.push('', 'operations (PRD §30.7 order)')
  if (plan.operations.length === 0) {
    lines.push('  (none)')
  } else {
    plan.operations.forEach((operation, index) => {
      lines.push(
        `  ${index + 1}. phase ${operation.phase}  ${operation.type}  ${operationLabel(operation)}`,
      )
    })
  }

  return `${lines.join('\n')}\n`
}
