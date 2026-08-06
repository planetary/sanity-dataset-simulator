/**
 * Surfacing conflicts in the Studio — PRD §28.1–§28.3.
 *
 * Core already models all of this: it persists `OverlayConflict` records on the
 * document record, computes the manifest `conflictSummary`, and owns both
 * `applicableResolutionActions` and `resolveConflict` for the seven §28.3
 * actions. None of that is re-decided here.
 *
 * What this module owns is the Studio-facing half — turning what the overlay
 * API reports into a panel model, and enforcing §28.1's *"conflicts are never
 * hidden"*. That last rule has a sharp edge: an overlay that reports **no
 * conflict field at all** is a different fact from an overlay with **no
 * conflicts**, and collapsing the first into a reassuring zero is precisely the
 * kind of hiding §28.1 forbids. {@link readConflictReport} keeps them apart.
 */

import {
  applicableResolutionActions,
  CONFLICT_RESOLUTION_ACTION_TYPES,
  summarizeConflicts,
  type ConflictResolutionAction,
  type OverlayConflict,
  type OverlayConflictResolutionType,
  type OverlayConflictSeverity,
} from '../../sanity-overlay-core/src/index'

type Rec = Record<string, unknown>

export interface ConflictPanelValue {
  label: string
  value: unknown
}

export interface ConflictPanelAction {
  action: ConflictResolutionAction
  label: string
  resolution: OverlayConflictResolutionType
}

export interface ConflictPanelModel {
  id: string
  documentId: string
  severity: OverlayConflictSeverity
  type: string
  pathLabel: string
  resolved: boolean
  /** §28.3's four rows, in the order the PRD lists them. */
  values: ConflictPanelValue[]
  actions: ConflictPanelAction[]
  detectedAt: string
}

/** §28.3's action list, in the PRD's own words. */
const ACTION_LABELS: Readonly<Record<ConflictResolutionAction, string>> = Object.freeze({
  'keep-branch-value': 'Keep branch value',
  'accept-current-staging': 'Accept current staging value',
  'manual-edit': 'Manually edit resolved value',
  'remove-local-override': 'Remove local override and resume inheritance',
  'keep-as-branch-created': 'Keep document as branch-created',
  'accept-base-deletion': 'Accept base deletion',
  'rename-branch-id': 'Rename branch-created ID',
})

/** `['body', 3, 'text']` → `body[3].text`. */
export function formatConflictPath(path: readonly (string | number)[] | undefined): string {
  if (path === undefined || path.length === 0) return '(whole document)'
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`
  }, '')
}

export function conflictPanelModel(
  conflict: OverlayConflict,
  context: {resolvedValue?: unknown} = {},
): ConflictPanelModel {
  const resolved = conflict.resolution !== undefined
  return {
    id: conflict.id,
    documentId: conflict.documentId,
    severity: conflict.severity,
    type: conflict.type,
    pathLabel: formatConflictPath(conflict.path as readonly (string | number)[] | undefined),
    resolved,
    values: [
      {label: 'Ancestor', value: conflict.ancestorValue},
      {label: 'Current staging', value: conflict.baseValue},
      {label: 'Branch value', value: conflict.localValue},
      {
        label: 'Resolved preview value',
        value: 'resolvedValue' in context ? context.resolvedValue : conflict.localValue,
      },
    ],
    /* A resolved conflict is history, not a decision waiting to be made.
     * Re-offering the actions would let one click quietly create a second
     * resolution transaction for the same disagreement. */
    actions: resolved
      ? []
      : applicableResolutionActions(conflict).map((action) => ({
          action,
          label: ACTION_LABELS[action],
          resolution: CONFLICT_RESOLUTION_ACTION_TYPES[action],
        })),
    detectedAt: conflict.detectedAt,
  }
}

/** §28.2's counters. Unresolved only, exactly as core counts them. */
export function summarizeConflictDocuments(conflicts: readonly OverlayConflict[]): {
  total: number
  soft: number
  hard: number
} {
  return summarizeConflicts(conflicts.filter((conflict) => conflict.resolution === undefined))
}

/**
 * What the overlay said about one document, for the §28.2 columns.
 *
 * Every field is optional and every absence is reported rather than filled in —
 * see {@link OverlayConflictReport.documents} and `conflictPanel.ts`.
 */
export interface ConflictDocumentFacts {
  logicalId: string
  schemaType?: string
  title?: string
  lastLocalRevision?: string
  baseRevisionAtFirstTouch?: string
  currentBaseRevision?: string
  touchedSinceCheckpoint?: boolean
}

export interface OverlayConflictReport {
  /**
   * `false` means the overlay API did not report conflicts at all — NOT that
   * there are none. §28.1 forbids showing the second when only the first is
   * known.
   */
  available: boolean
  summary: {total: number; soft: number; hard: number}
  byDocument: Record<string, OverlayConflict[]>
  /** Per-document metadata for the §28.2 list, keyed by logical ID. */
  documents: Record<string, ConflictDocumentFacts>
  note?: string
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConflict(value: unknown): value is OverlayConflict {
  return (
    isRec(value) &&
    typeof value.id === 'string' &&
    typeof value.documentId === 'string' &&
    (value.severity === 'soft' || value.severity === 'hard') &&
    typeof value.type === 'string'
  )
}

const NO_SUMMARY = {total: 0, soft: 0, hard: 0} as const

/**
 * Read whatever the overlay API's `/state` answered into a conflict report.
 *
 * Tolerant by design: the overlay server is a moving target and a malformed
 * payload must degrade the panel, never crash the Studio around it.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A human-readable title for the §28.2 "Document title" column.
 *
 * Read off the materialized body the overlay already sent, never fetched: the
 * conflict list must render from one `/state` answer. When no candidate field is
 * present the column stays `undefined` and the list falls back to the ID —
 * inventing a title is the kind of plausible filler §5.5 rules out.
 */
function documentTitle(entry: Rec): string | undefined {
  for (const body of [entry.draft, entry.published]) {
    if (!isRec(body)) continue
    for (const key of ['title', 'name', 'label']) {
      const value = optionalString(body[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

function documentFacts(logicalId: string, entry: Rec): ConflictDocumentFacts {
  const title = documentTitle(entry)
  const schemaType = optionalString(entry.schemaType)
  const lastLocalRevision = optionalString(entry.runtimeRevision)
  const baseRevisionAtFirstTouch = optionalString(entry.baseRevisionAtFirstTouch)
  const currentBaseRevision = optionalString(entry.currentBaseRevision)
  return {
    logicalId,
    ...(schemaType === undefined ? {} : {schemaType}),
    ...(title === undefined ? {} : {title}),
    ...(lastLocalRevision === undefined ? {} : {lastLocalRevision}),
    ...(baseRevisionAtFirstTouch === undefined ? {} : {baseRevisionAtFirstTouch}),
    ...(currentBaseRevision === undefined ? {} : {currentBaseRevision}),
    ...(typeof entry.touchedSinceCheckpoint === 'boolean'
      ? {touchedSinceCheckpoint: entry.touchedSinceCheckpoint}
      : {}),
  }
}

export function readConflictReport(state: unknown): OverlayConflictReport {
  if (!isRec(state)) {
    return {
      available: false,
      summary: {...NO_SUMMARY},
      byDocument: {},
      documents: {},
      note: 'the overlay API returned no state, so conflicts cannot be shown',
    }
  }

  const byDocument: Record<string, OverlayConflict[]> = {}
  const facts: Record<string, ConflictDocumentFacts> = {}
  let sawConflictField = false

  const documents = Array.isArray(state.documents) ? state.documents : []
  for (const entry of documents) {
    if (!isRec(entry)) continue
    const logicalId = typeof entry.logicalId === 'string' ? entry.logicalId : undefined
    if (logicalId === undefined) continue
    facts[logicalId] = documentFacts(logicalId, entry)
    if (!Array.isArray(entry.conflicts)) continue
    sawConflictField = true
    const conflicts = entry.conflicts.filter(isConflict)
    if (conflicts.length > 0) byDocument[logicalId] = conflicts
  }

  const declared = isRec(state.conflictSummary) ? state.conflictSummary : undefined
  if (declared !== undefined) {
    const total = typeof declared.total === 'number' ? declared.total : 0
    const soft = typeof declared.soft === 'number' ? declared.soft : 0
    const hard = typeof declared.hard === 'number' ? declared.hard : 0
    return {available: true, summary: {total, soft, hard}, byDocument, documents: facts}
  }

  if (!sawConflictField) {
    return {
      available: false,
      summary: {...NO_SUMMARY},
      byDocument: {},
      documents: facts,
      note:
        'this overlay API does not report conflicts, so none can be shown here. That is not ' +
        'the same as there being none — check the overlay manifest directly before promoting.',
    }
  }

  const all = Object.values(byDocument).flat()
  return {
    available: true,
    summary: summarizeConflictDocuments(all),
    byDocument,
    documents: facts,
  }
}
