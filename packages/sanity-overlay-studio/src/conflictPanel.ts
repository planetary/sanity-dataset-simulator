/**
 * The §28.2 conflict LIST and the §28.3 document conflict PANEL — the surface,
 * not the model.
 *
 * `conflicts.ts` turns an overlay `/state` answer into conflict records and
 * `ConflictPanelModel`s; core owns `applicableResolutionActions`,
 * `CONFLICT_RESOLUTION_ACTION_TYPES` and `resolveConflict`. This module owns the
 * three things a human needs on top of that and nothing else:
 *
 *   1. **A list** with §28.2's columns and filters.
 *   2. **A per-document indication**, so an editor sees a conflict without
 *      going looking for one.
 *   3. **A way to drive** each of the seven §28.3 actions — validated here,
 *      applied by the overlay API, which is the only party holding the §13.3
 *      record (`base` block, `touchedPaths`, `unsetPaths`) that
 *      `resolveConflict` needs. The Studio sends an *intent*, in core's own
 *      vocabulary; it does not compute the next record and it does not
 *      re-implement the resolution.
 *
 * THREE RULES WITH TEETH, because each is where a plausible implementation is
 * wrong:
 *
 *   - **§28.1 "conflicts are never hidden."** A filter keyed on a fact the
 *     overlay did not report must not hide the row. Unknown is not "no".
 *   - **A resolution must actually resolve.** Renaming to the ID the document
 *     already has, "manually editing" to the value that is already there, or
 *     re-resolving a resolved conflict each writes a transaction that changes
 *     nothing while telling the editor the disagreement is settled.
 *   - **Destruction is confirmed, and the loss is stated first**, exactly as
 *     `sanity-overlay rebase|reset` refuse without `--confirm` after printing
 *     what would go.
 */

import {
  applicableResolutionActions,
  canonicalEquals,
  CONFLICT_RESOLUTION_ACTION_TYPES,
  toPublishedId,
  type ConflictResolutionAction,
  type OverlayConflict,
  type OverlayConflictResolutionType,
  type OverlayConflictSeverity,
  type OverlayConflictType,
} from '../../sanity-overlay-core/src/index'

import {formatConflictPath, type ConflictDocumentFacts, type OverlayConflictReport} from './conflicts'

/* ------------------------------------------------------------------ *
 * §28.2 — the conflict list
 * ------------------------------------------------------------------ */

/** The §28.2 columns whose value the overlay API may simply not have sent. */
export const OPTIONAL_CONFLICT_COLUMNS = [
  'documentTitle',
  'schemaType',
  'baseRevisionAtFirstTouch',
  'currentBaseRevision',
  'lastLocalRevision',
] as const

export type OptionalConflictColumn = (typeof OPTIONAL_CONFLICT_COLUMNS)[number]

/** One row of the `Overlay Conflicts` tool (PRD §28.2). */
export interface ConflictRow {
  conflictId: string
  severity: OverlayConflictSeverity
  documentId: string
  documentTitle?: string
  schemaType?: string
  conflictType: OverlayConflictType
  pathLabel: string
  baseRevisionAtFirstTouch?: string
  currentBaseRevision?: string
  lastLocalRevision?: string
  detectedAt: string
  resolved: boolean
  /** `'unresolved'`, or the §13.11 resolution type that settled it. */
  resolutionState: 'unresolved' | OverlayConflictResolutionType
  /** §28.2 "Touched since checkpoint" — `undefined` when the overlay did not say. */
  touchedSinceCheckpoint?: boolean
  /**
   * Columns §28.2 requires that this overlay did not report.
   *
   * Named rather than blank-filled: a "current base revision" the overlay never
   * stated is exactly the silent approximation §5.5 forbids, and an operator
   * deciding whether to promote needs to know the difference between "unchanged"
   * and "unknown".
   */
  unavailableColumns: OptionalConflictColumn[]
}

const NO_FACTS: ConflictDocumentFacts = {logicalId: ''}

/** §28.2 column → the `/state` field it is read from. */
const COLUMN_SOURCE: Readonly<Record<OptionalConflictColumn, keyof ConflictDocumentFacts>> =
  Object.freeze({
    documentTitle: 'title',
    schemaType: 'schemaType',
    baseRevisionAtFirstTouch: 'baseRevisionAtFirstTouch',
    currentBaseRevision: 'currentBaseRevision',
    lastLocalRevision: 'lastLocalRevision',
  })

function rowFor(conflict: OverlayConflict, facts: ConflictDocumentFacts): ConflictRow {
  const unavailable: OptionalConflictColumn[] = []
  for (const column of OPTIONAL_CONFLICT_COLUMNS) {
    if (facts[COLUMN_SOURCE[column]] === undefined) unavailable.push(column)
  }
  const resolution = conflict.resolution
  return {
    conflictId: conflict.id,
    severity: conflict.severity,
    documentId: conflict.documentId,
    ...(facts.title === undefined ? {} : {documentTitle: facts.title}),
    ...(facts.schemaType === undefined ? {} : {schemaType: facts.schemaType}),
    conflictType: conflict.type,
    pathLabel: formatConflictPath(conflict.path as readonly (string | number)[] | undefined),
    ...(facts.baseRevisionAtFirstTouch === undefined
      ? {}
      : {baseRevisionAtFirstTouch: facts.baseRevisionAtFirstTouch}),
    ...(facts.currentBaseRevision === undefined
      ? {}
      : {currentBaseRevision: facts.currentBaseRevision}),
    ...(facts.lastLocalRevision === undefined
      ? {}
      : {lastLocalRevision: facts.lastLocalRevision}),
    detectedAt: conflict.detectedAt,
    resolved: resolution !== undefined,
    resolutionState: resolution === undefined ? 'unresolved' : resolution.type,
    ...(facts.touchedSinceCheckpoint === undefined
      ? {}
      : {touchedSinceCheckpoint: facts.touchedSinceCheckpoint}),
    unavailableColumns: unavailable,
  }
}

/**
 * Every conflict the overlay reported, as §28.2 rows.
 *
 * Ordered by document ID then detection time, so the list is a deterministic
 * function of the overlay state rather than of the order `/state` happened to
 * serialize its documents in.
 */
export function conflictListRows(report: OverlayConflictReport): ConflictRow[] {
  const rows: ConflictRow[] = []
  for (const logicalId of Object.keys(report.byDocument).sort()) {
    const conflicts = [...(report.byDocument[logicalId] ?? [])].sort((left, right) =>
      left.detectedAt < right.detectedAt ? -1 : left.detectedAt > right.detectedAt ? 1 : 0,
    )
    const facts = report.documents[logicalId] ?? {...NO_FACTS, logicalId}
    for (const conflict of conflicts) rows.push(rowFor(conflict, facts))
  }
  return rows
}

/** The §28.2 filter set. Every field is optional; omitted means "do not filter". */
export interface ConflictRowFilters {
  severity?: OverlayConflictSeverity
  schemaType?: string
  conflictType?: OverlayConflictType
  resolved?: boolean
  touchedSinceCheckpoint?: boolean
}

/**
 * Apply the §28.2 filters.
 *
 * `touchedSinceCheckpoint` is the one that needs stating: a row whose value is
 * UNKNOWN is never removed. §28.1 says conflicts are never hidden, and reading
 * "the overlay did not tell us" as "no" would hide real conflicts behind a
 * checkbox — the failure mode `readConflictReport` already refuses to make at
 * the summary level.
 */
export function filterConflictRows(
  rows: readonly ConflictRow[],
  filters: ConflictRowFilters,
): ConflictRow[] {
  return rows.filter((row) => {
    if (filters.severity !== undefined && row.severity !== filters.severity) return false
    if (filters.schemaType !== undefined && row.schemaType !== filters.schemaType) return false
    if (filters.conflictType !== undefined && row.conflictType !== filters.conflictType) return false
    if (filters.resolved !== undefined && row.resolved !== filters.resolved) return false
    if (
      filters.touchedSinceCheckpoint !== undefined &&
      row.touchedSinceCheckpoint !== undefined &&
      row.touchedSinceCheckpoint !== filters.touchedSinceCheckpoint
    ) {
      return false
    }
    return true
  })
}

/* ------------------------------------------------------------------ *
 * The per-document indication
 * ------------------------------------------------------------------ */

export type ConflictIndicatorState = 'unknown' | 'none' | 'soft' | 'hard'

export interface ConflictIndicator {
  documentId: string
  state: ConflictIndicatorState
  /** Unresolved conflicts only — a settled one is history, not a warning. */
  total: number
  soft: number
  hard: number
  resolved: number
  label: string
  /** §28.1 — "Hard conflicts block branch publish". */
  blocksBranchPublish: boolean
}

/**
 * The conflict state of one document, for a badge in the document pane.
 *
 * Accepts any address — `drafts.x`, `x`, `versions.r.x` — because the pane knows
 * the address it is showing and the overlay keys conflicts by logical ID.
 */
export function documentConflictIndicator(
  report: OverlayConflictReport,
  documentId: string,
): ConflictIndicator {
  const logicalId = toPublishedId(documentId)

  if (!report.available) {
    return {
      documentId: logicalId,
      state: 'unknown',
      total: 0,
      soft: 0,
      hard: 0,
      resolved: 0,
      label:
        'This overlay API does not report conflicts, so this document’s conflict state is ' +
        'unknown — which is not the same as clean.',
      /* Not "blocked": an unknown state is not evidence of a hard conflict, and
       * blocking on ignorance would make an overlay server that predates the
       * conflict field unusable. It is announced instead. */
      blocksBranchPublish: false,
    }
  }

  const conflicts = report.byDocument[logicalId] ?? []
  const unresolved = conflicts.filter((conflict) => conflict.resolution === undefined)
  const soft = unresolved.filter((conflict) => conflict.severity === 'soft').length
  const hard = unresolved.length - soft
  const resolved = conflicts.length - unresolved.length

  const state: ConflictIndicatorState = hard > 0 ? 'hard' : soft > 0 ? 'soft' : 'none'
  const label =
    state === 'hard'
      ? `${hard} hard conflict${hard === 1 ? '' : 's'} — branch publish is blocked until it is resolved`
      : state === 'soft'
        ? `${soft} soft conflict${soft === 1 ? '' : 's'} — editing continues; resolve or acknowledge before promoting`
        : 'No unresolved conflicts on this document'

  return {
    documentId: logicalId,
    state,
    total: unresolved.length,
    soft,
    hard,
    resolved,
    label,
    blocksBranchPublish: hard > 0,
  }
}

/* ------------------------------------------------------------------ *
 * §28.3 — the resolved preview value
 * ------------------------------------------------------------------ */

export type ResolvedPreviewKind =
  | 'value'
  | 'inherited'
  | 'removed'
  | 'deleted'
  | 'branch-created'
  | 'renamed'

export interface ResolvedPreview {
  kind: ResolvedPreviewKind
  value: unknown
}

export interface ConflictResolutionInput {
  action: ConflictResolutionAction
  /**
   * `manual-edit` only. The KEY must be present — `undefined` is the real
   * instruction "remove this field", so a missing key is an unfinished form and
   * is refused rather than read as one.
   */
  value?: unknown
  /** `rename-branch-id` only. */
  newId?: string
  /** Required for a destructive action. See {@link planConflictResolution}. */
  confirmed?: boolean
}

/**
 * §28.3's fourth row — "Resolved preview value" — for one candidate action.
 *
 * Derived from the conflict record alone, so the panel can show what each button
 * would produce *before* anything is sent. The overlay still computes the real
 * next state through core's `resolveConflict`; this is the promise the panel
 * makes, and the two are the same function of the same three values.
 */
export function resolvedPreviewValue(
  conflict: OverlayConflict,
  input: ConflictResolutionInput,
): ResolvedPreview {
  switch (input.action) {
    case 'keep-branch-value':
      return {kind: 'value', value: conflict.localValue}
    case 'accept-current-staging':
      return {kind: 'value', value: conflict.baseValue}
    case 'remove-local-override':
      /* Structurally distinct from accepting the value: the local member is
       * removed, so the merge projects base from now on rather than pinning
       * today's base value into the branch document. */
      return {kind: 'inherited', value: conflict.baseValue}
    case 'manual-edit':
      return input.value === undefined
        ? {kind: 'removed', value: undefined}
        : {kind: 'value', value: input.value}
    case 'accept-base-deletion':
      return {kind: 'deleted', value: undefined}
    case 'keep-as-branch-created':
      return {kind: 'branch-created', value: undefined}
    case 'rename-branch-id':
      return {kind: 'renamed', value: input.newId}
    default: {
      const exhaustive: never = input.action
      throw new Error(`unhandled §28.3 action ${JSON.stringify(exhaustive)}`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * §28.3 — driving an action
 * ------------------------------------------------------------------ */

/** One thing a destructive resolution throws away. */
export interface ConflictLossEntry {
  path: string
  value: unknown
  replacedBy?: unknown
}

export interface ConflictLoss {
  destructive: boolean
  summary: string
  losing: ConflictLossEntry[]
}

/** The intent sent to the overlay API. Core's vocabulary, verbatim. */
export interface ConflictResolutionCommand {
  kind: 'conflictResolution'
  documentId: string
  conflictId: string
  action: ConflictResolutionAction
  /** The §13.11 `resolution.type` core will stamp. Sent so the API cannot drift. */
  resolution: OverlayConflictResolutionType
  /** Present only for `manual-edit`, where `undefined` means "remove the field". */
  value?: unknown
  /** Present only for `rename-branch-id`. */
  newId?: string
}

export type ConflictResolutionPlan =
  | {ok: true; command: ConflictResolutionCommand; preview: ResolvedPreview; loss?: ConflictLoss}
  | {ok: false; reason: string; needsConfirmation?: true; loss?: ConflictLoss}

/** The three §28.3 actions that end with a branch value gone. */
const DESTRUCTIVE_ACTIONS: readonly ConflictResolutionAction[] = [
  'accept-current-staging',
  'remove-local-override',
  'accept-base-deletion',
]

function lossFor(conflict: OverlayConflict, action: ConflictResolutionAction): ConflictLoss | undefined {
  if (!DESTRUCTIVE_ACTIONS.includes(action)) return undefined
  const path = formatConflictPath(conflict.path as readonly (string | number)[] | undefined)

  if (action === 'accept-base-deletion') {
    return {
      destructive: true,
      summary:
        `Accepting the base deletion removes the branch copy of ${conflict.documentId} entirely. ` +
        'Every local edit to it is discarded and the document stops existing in this branch.',
      losing: [{path: '(whole document)', value: conflict.localValue}],
    }
  }

  const replacement =
    action === 'accept-current-staging'
      ? 'the current staging value'
      : 'whatever the base holds, now and in future'
  return {
    destructive: true,
    summary:
      `This discards the branch value at ${path} on ${conflict.documentId} and replaces it with ` +
      `${replacement}. The branch value is not recoverable from the overlay afterwards.`,
    losing: [{path, value: conflict.localValue, replacedBy: conflict.baseValue}],
  }
}

/**
 * Validate one §28.3 panel action and turn it into the command the overlay API
 * applies.
 *
 * The overlay API — not this function — runs core's `resolveConflict`: the §13.3
 * record it needs (`base` block, `touchedPaths`, `unsetPaths`, `origin`) lives
 * there, and reconstructing it in the browser from a hydration answer would be a
 * second, weaker copy of the store.
 */
export function planConflictResolution(
  conflict: OverlayConflict,
  input: ConflictResolutionInput,
): ConflictResolutionPlan {
  const {action} = input

  if (conflict.resolution !== undefined) {
    return {
      ok: false,
      reason:
        `Conflict ${conflict.id} was already resolved as "${conflict.resolution.type}" at ` +
        `${conflict.resolution.resolvedAt}. Resolving it again would create a second overlay ` +
        'transaction for a disagreement that is already settled (PRD §28.1).',
    }
  }

  const applicable = applicableResolutionActions(conflict)
  if (!applicable.includes(action)) {
    return {
      ok: false,
      reason:
        `"${action}" does not apply to a ${conflict.type} conflict. The actions core offers for ` +
        `it are: ${applicable.join(', ')} (PRD §28.3).`,
    }
  }

  if (action === 'manual-edit') {
    if (!('value' in input)) {
      return {
        ok: false,
        reason:
          'A manual edit needs an explicit resolved value. Pass `value: undefined` to remove the ' +
          'field — an absent key is an unfinished form, and committing it would silently unset ' +
          'the very field being merged.',
      }
    }
    if (canonicalEquals(input.value, conflict.localValue)) {
      return {
        ok: false,
        reason:
          'The manual value is identical to the branch value, so this resolution would change ' +
          'nothing. Use "Keep branch value" if that is the intent.',
      }
    }
  }

  if (action === 'rename-branch-id') {
    const newId = typeof input.newId === 'string' ? input.newId.trim() : ''
    if (newId.length === 0) {
      return {
        ok: false,
        reason: 'Renaming a branch-created document needs a new ID (PRD §28.3, §19.6).',
      }
    }
    if (newId === conflict.documentId) {
      return {
        ok: false,
        reason:
          `The new ID is the ID the document already has (${conflict.documentId}), so this would ` +
          'not rename anything while recording the collision as resolved.',
      }
    }
  }

  const loss = lossFor(conflict, action)
  if (loss !== undefined && input.confirmed !== true) {
    return {
      ok: false,
      reason: `${loss.summary} Confirm the loss before this can be applied.`,
      needsConfirmation: true,
      loss,
    }
  }

  const command: ConflictResolutionCommand = {
    kind: 'conflictResolution',
    documentId: conflict.documentId,
    conflictId: conflict.id,
    action,
    resolution: CONFLICT_RESOLUTION_ACTION_TYPES[action],
    ...(action === 'manual-edit' ? {value: input.value} : {}),
    ...(action === 'rename-branch-id' ? {newId: (input.newId as string).trim()} : {}),
  }

  return {
    ok: true,
    command,
    preview: resolvedPreviewValue(conflict, input),
    ...(loss === undefined ? {} : {loss}),
  }
}
