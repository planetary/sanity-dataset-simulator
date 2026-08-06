/**
 * `sanity-overlay-studio` — surfacing conflicts (PRD §28.1–§28.3).
 *
 * Core already models conflicts and their resolutions: it persists
 * `OverlayConflict` records on the document, computes the manifest's
 * `conflictSummary`, and owns `applicableResolutionActions` + `resolveConflict`
 * for the seven §28.3 actions. Nothing about that is re-decided here.
 *
 * What this module owns is the *Studio-facing* half: turning what the overlay
 * API reports into a panel model, driving core's action set from it, and — the
 * part with teeth — §28.1's "conflicts are never hidden". An overlay server that
 * reports no conflict field at all is a *different fact* from an overlay with no
 * conflicts, and the difference must reach the user rather than be flattened
 * into a reassuring zero.
 */
import {describe, expect, it} from 'vitest'
import {CONFLICT_RESOLUTION_ACTIONS} from '../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../sanity-overlay-core/src/index'
import {
  conflictPanelModel,
  readConflictReport,
  summarizeConflictDocuments,
} from '../../sanity-overlay-studio/src/conflicts'

const SAME_PATH: OverlayConflict = {
  id: 'c1',
  documentId: 'article-1',
  severity: 'soft',
  type: 'SAME_PATH_CHANGED',
  path: ['title'],
  ancestorValue: 'Ancestor',
  baseValue: 'Current staging',
  localValue: 'Branch value',
  detectedAt: '2026-08-01T00:00:00.000Z',
}

const BASE_DELETED: OverlayConflict = {
  id: 'c2',
  documentId: 'article-2',
  severity: 'hard',
  type: 'BASE_DOCUMENT_DELETED',
  detectedAt: '2026-08-02T00:00:00.000Z',
}

const RESOLVED: OverlayConflict = {
  ...SAME_PATH,
  id: 'c3',
  documentId: 'article-3',
  resolution: {
    type: 'keep-local',
    resolvedAt: '2026-08-03T00:00:00.000Z',
    resolvedBy: {type: 'user', id: 'v'},
  },
}

describe('conflictPanelModel — the §28.3 document panel', () => {
  it('shows the four values §28.3 names', () => {
    const model = conflictPanelModel(SAME_PATH, {resolvedValue: 'Branch value'})
    expect(model.values).toEqual([
      {label: 'Ancestor', value: 'Ancestor'},
      {label: 'Current staging', value: 'Current staging'},
      {label: 'Branch value', value: 'Branch value'},
      {label: 'Resolved preview value', value: 'Branch value'},
    ])
  })

  it('offers exactly the actions core says apply to that conflict', () => {
    expect(conflictPanelModel(SAME_PATH).actions.map((action) => action.action)).toEqual([
      'keep-branch-value',
      'accept-current-staging',
      'manual-edit',
      'remove-local-override',
    ])
    expect(conflictPanelModel(BASE_DELETED).actions.map((action) => action.action)).toEqual([
      'keep-as-branch-created',
      'accept-base-deletion',
    ])
  })

  it('only ever offers actions from core’s own set', () => {
    for (const conflict of [SAME_PATH, BASE_DELETED]) {
      for (const action of conflictPanelModel(conflict).actions) {
        expect(CONFLICT_RESOLUTION_ACTIONS as readonly string[]).toContain(action.action)
      }
    }
  })

  it('gives every action a human label and the resolution type it records', () => {
    for (const action of conflictPanelModel(SAME_PATH).actions) {
      expect(action.label.length).toBeGreaterThan(3)
      expect(['keep-local', 'accept-base', 'manual', 'rename', 'delete-local']).toContain(
        action.resolution,
      )
    }
  })

  it('renders the path as dotted notation a human can read', () => {
    expect(conflictPanelModel({...SAME_PATH, path: ['body', 3, 'text']}).pathLabel).toBe(
      'body[3].text',
    )
    expect(conflictPanelModel(BASE_DELETED).pathLabel).toBe('(whole document)')
  })

  it('marks a resolved conflict as resolved and offers no further action', () => {
    const model = conflictPanelModel(RESOLVED)
    expect(model.resolved).toBe(true)
    expect(model.actions).toEqual([])
  })

  it('carries the severity through, since it governs whether publish is blocked', () => {
    expect(conflictPanelModel(SAME_PATH).severity).toBe('soft')
    expect(conflictPanelModel(BASE_DELETED).severity).toBe('hard')
  })
})

describe('summarizeConflictDocuments — the §28.2 list', () => {
  it('counts unresolved conflicts only', () => {
    const summary = summarizeConflictDocuments([SAME_PATH, BASE_DELETED, RESOLVED])
    expect(summary).toEqual({total: 2, soft: 1, hard: 1})
  })

  it('is zero for an empty list', () => {
    expect(summarizeConflictDocuments([])).toEqual({total: 0, soft: 0, hard: 0})
  })
})

describe('readConflictReport — "conflicts are never hidden" (§28.1)', () => {
  it('reads conflicts the overlay reports per document', () => {
    const report = readConflictReport({
      documents: [
        {logicalId: 'article-1', conflicts: [SAME_PATH]},
        {logicalId: 'article-2', conflicts: [BASE_DELETED]},
      ],
    })
    expect(report.available).toBe(true)
    expect(report.summary).toEqual({total: 2, soft: 1, hard: 1})
    expect(report.byDocument['article-1']).toHaveLength(1)
  })

  it('prefers an explicit conflictSummary from the manifest when the overlay sends one', () => {
    const report = readConflictReport({
      conflictSummary: {total: 5, soft: 3, hard: 2},
      documents: [],
    })
    expect(report.available).toBe(true)
    expect(report.summary).toEqual({total: 5, soft: 3, hard: 2})
  })

  it('distinguishes "no conflicts" from "the overlay does not report conflicts"', () => {
    const silent = readConflictReport({documents: [{logicalId: 'article-1'}]})
    expect(silent.available).toBe(false)
    expect(silent.summary).toEqual({total: 0, soft: 0, hard: 0})
    expect(silent.note).toMatch(/does not report|cannot be shown|no conflict/i)

    const explicit = readConflictReport({documents: [{logicalId: 'article-1', conflicts: []}]})
    expect(explicit.available).toBe(true)
    expect(explicit.note).toBeUndefined()
  })

  it('survives a malformed payload without throwing', () => {
    for (const value of [undefined, null, {}, {documents: 'nope'}, {documents: [null]}]) {
      expect(() => readConflictReport(value as never)).not.toThrow()
    }
    expect(readConflictReport(undefined as never).available).toBe(false)
  })

  it('ignores entries that are not conflict records rather than crashing the panel', () => {
    const report = readConflictReport({
      documents: [{logicalId: 'a', conflicts: [SAME_PATH, {nonsense: true}, null]}],
    })
    expect(report.byDocument.a).toHaveLength(1)
    expect(report.summary.total).toBe(1)
  })
})
