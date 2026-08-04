/**
 * PRD §16.4 base deletion rules, as data plus a classifier.
 *
 * The four rows the merge engine owns are transcribed verbatim. The two
 * reference rows of the §16.4 table ("Referenced but untouched target",
 * "Referenced and touched target") are the same two document states seen from a
 * referring document, and belong to the W4 reference resolver (§19.2), not here.
 */
import type {OverlayConflictType} from '../types/conflict'
import type {OverlayDocumentOrigin} from '../types/record'

export type BaseDeletionState =
  | 'untouched'
  | 'touched-and-modified'
  | 'branch-created'
  | 'locally-tombstoned'

/** What the virtual result is when the base document is gone. */
export type BaseDeletionResult = 'absent' | 'preserve-local'

export interface BaseDeletionRow {
  state: BaseDeletionState
  result: BaseDeletionResult
  conflict: OverlayConflictType | null
  /** The §16.4 "Virtual result" cell, verbatim. */
  virtualResult: string
}

export const BASE_DELETION_MATRIX: readonly BaseDeletionRow[] = Object.freeze([
  {
    state: 'untouched',
    result: 'absent',
    conflict: null,
    virtualResult: 'Document disappears, matching live base behavior',
  },
  {
    state: 'touched-and-modified',
    result: 'preserve-local',
    conflict: 'BASE_DOCUMENT_DELETED',
    virtualResult: 'Preserve materialized local document; mark hard conflict',
  },
  {
    state: 'branch-created',
    result: 'preserve-local',
    conflict: null,
    virtualResult: 'Preserve local document',
  },
  {
    state: 'locally-tombstoned',
    result: 'absent',
    conflict: null,
    virtualResult: 'Remain absent; no new conflict required',
  },
])

export interface BaseDeletionInput {
  /** The branch holds a local version of this document. */
  touched: boolean
  origin: OverlayDocumentOrigin
  tombstoned: boolean
}

export interface BaseDeletionOutcome {
  state: BaseDeletionState
  result: BaseDeletionResult
  conflict: OverlayConflictType | null
}

/**
 * Classify a document against the §16.4 matrix.
 *
 * Precedence is tombstone → branch-created → touched → untouched: a tombstoned
 * document stays absent whatever its origin (§17.2 precedence rule 1), and a
 * branch-created document has no base to lose (§16.4 "Not applicable").
 */
export function classifyBaseDeletion(input: BaseDeletionInput): BaseDeletionOutcome {
  const state: BaseDeletionState = input.tombstoned
    ? 'locally-tombstoned'
    : input.origin === 'branch'
      ? 'branch-created'
      : input.touched
        ? 'touched-and-modified'
        : 'untouched'
  const row = BASE_DELETION_MATRIX.find((entry) => entry.state === state)!
  return {state: row.state, result: row.result, conflict: row.conflict}
}
