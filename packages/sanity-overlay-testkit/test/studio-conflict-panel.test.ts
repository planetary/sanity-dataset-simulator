/**
 * `sanity-overlay-studio` — the §28.2 conflict LIST and the §28.3 document
 * conflict PANEL, as a surface rather than as a model.
 *
 * The model already existed: core owns `applicableResolutionActions` and
 * `resolveConflict`, and `conflicts.ts` already turned an overlay `/state`
 * answer into `ConflictPanelModel`s. What did not exist was anything that lets a
 * human SEE the conflicts (§28.2's columns and filters, a per-document
 * indication) or DRIVE one of the seven §28.3 actions.
 *
 * Three rules this file exists to pin, because each is a place where a plausible
 * implementation would be wrong:
 *
 *  1. **§28.1 "conflicts are never hidden."** A filter that keys on a fact the
 *     overlay did not report must not hide the row. Unknown is not "no".
 *  2. **A resolution must actually resolve.** `rename-branch-id` to the same ID,
 *     an action core says does not apply, a second resolution of an
 *     already-resolved conflict — each produces a transaction that changes
 *     nothing while telling the editor their conflict is gone.
 *  3. **Destruction is confirmed, and what is lost is stated first.** Accepting
 *     staging throws the branch value away; accepting a base deletion throws the
 *     whole local document away. The CLI refuses without `--confirm` and prints
 *     the loss; the panel does the same thing with the same shape.
 */
import {describe, expect, it} from 'vitest'
import {
  CONFLICT_RESOLUTION_ACTIONS,
  applicableResolutionActions,
} from '../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../sanity-overlay-core/src/index'
import {
  conflictListRows,
  documentConflictIndicator,
  filterConflictRows,
  planConflictResolution,
  resolvedPreviewValue,
} from '../../sanity-overlay-studio/src/conflictPanel'
import {readConflictReport} from '../../sanity-overlay-studio/src/conflicts'

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

const COLLISION: OverlayConflict = {
  id: 'c3',
  documentId: 'article-3',
  severity: 'hard',
  type: 'LOCAL_ID_COLLISION',
  detectedAt: '2026-08-03T00:00:00.000Z',
  localValue: {_id: 'article-3', title: 'Mine'},
  baseValue: {_id: 'article-3', title: 'Theirs'},
}

const RESOLVED: OverlayConflict = {
  ...SAME_PATH,
  id: 'c4',
  documentId: 'article-4',
  resolution: {
    type: 'keep-local',
    resolvedAt: '2026-08-04T00:00:00.000Z',
    resolvedBy: {type: 'user', id: 'v'},
  },
}

/** An overlay `/state` answer carrying all four conflicts. */
const STATE = {
  documents: [
    {
      logicalId: 'article-1',
      schemaType: 'article',
      runtimeRevision: 'rev-local-1',
      baseRevisionAtFirstTouch: 'base-aaa',
      currentBaseRevision: 'base-bbb',
      touchedSinceCheckpoint: true,
      draft: {_id: 'drafts.article-1', _type: 'article', title: 'Branch value'},
      conflicts: [SAME_PATH],
    },
    {logicalId: 'article-2', schemaType: 'article', conflicts: [BASE_DELETED]},
    {logicalId: 'article-3', schemaType: 'author', conflicts: [COLLISION]},
    {logicalId: 'article-4', schemaType: 'article', conflicts: [RESOLVED]},
  ],
}

const REPORT = readConflictReport(STATE)

/* ══════════════════════════════════════════ §28.2 the conflict list ═══════ */

describe('conflictListRows — the §28.2 columns', () => {
  it('emits one row per conflict, ordered by document then detection time', () => {
    const rows = conflictListRows(REPORT)
    expect(rows.map((row) => row.conflictId)).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('carries every column §28.2 names', () => {
    const row = conflictListRows(REPORT)[0]!
    expect(row.severity).toBe('soft')
    expect(row.documentId).toBe('article-1')
    expect(row.schemaType).toBe('article')
    expect(row.conflictType).toBe('SAME_PATH_CHANGED')
    expect(row.pathLabel).toBe('title')
    expect(row.baseRevisionAtFirstTouch).toBe('base-aaa')
    expect(row.currentBaseRevision).toBe('base-bbb')
    expect(row.lastLocalRevision).toBe('rev-local-1')
    expect(row.detectedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(row.resolutionState).toBe('unresolved')
  })

  it('reports the resolution type once a conflict is resolved', () => {
    const row = conflictListRows(REPORT).find((entry) => entry.conflictId === 'c4')!
    expect(row.resolutionState).toBe('keep-local')
    expect(row.resolved).toBe(true)
  })

  it('names the columns the overlay did NOT report rather than inventing them', () => {
    /* article-2 carries no revision fields at all. §5.5 forbids silent
     * approximation, so an unreported revision is `undefined` AND announced. */
    const row = conflictListRows(REPORT).find((entry) => entry.documentId === 'article-2')!
    expect(row.baseRevisionAtFirstTouch).toBeUndefined()
    expect(row.currentBaseRevision).toBeUndefined()
    expect(row.lastLocalRevision).toBeUndefined()
    expect(row.unavailableColumns).toEqual(
      expect.arrayContaining([
        'baseRevisionAtFirstTouch',
        'currentBaseRevision',
        'lastLocalRevision',
      ]),
    )
    /* And the row that DID have them announces nothing missing. */
    const complete = conflictListRows(REPORT).find((entry) => entry.documentId === 'article-1')!
    expect(complete.unavailableColumns).toEqual([])
  })

  it('prefers a document title over the bare ID when one can be read', () => {
    const row = conflictListRows(REPORT)[0]!
    expect(row.documentTitle).toBe('Branch value')
    const untitled = conflictListRows(REPORT).find((entry) => entry.documentId === 'article-2')!
    expect(untitled.documentTitle).toBeUndefined()
  })

  it('is empty when the overlay does not report conflicts at all', () => {
    expect(conflictListRows(readConflictReport({documents: [{logicalId: 'a'}]}))).toEqual([])
  })
})

describe('filterConflictRows — the §28.2 filters', () => {
  const rows = conflictListRows(REPORT)

  it('filters by severity', () => {
    expect(filterConflictRows(rows, {severity: 'hard'}).map((row) => row.conflictId)).toEqual([
      'c2',
      'c3',
    ])
    expect(filterConflictRows(rows, {severity: 'soft'}).map((row) => row.conflictId)).toEqual([
      'c1',
      'c4',
    ])
  })

  it('filters by document type', () => {
    expect(filterConflictRows(rows, {schemaType: 'author'}).map((row) => row.conflictId)).toEqual([
      'c3',
    ])
  })

  it('filters by conflict type', () => {
    expect(
      filterConflictRows(rows, {conflictType: 'BASE_DOCUMENT_DELETED'}).map((r) => r.conflictId),
    ).toEqual(['c2'])
  })

  it('filters by resolution state', () => {
    expect(filterConflictRows(rows, {resolved: false}).map((row) => row.conflictId)).toEqual([
      'c1',
      'c2',
      'c3',
    ])
    expect(filterConflictRows(rows, {resolved: true}).map((row) => row.conflictId)).toEqual(['c4'])
  })

  it('returns every row when no filter is given', () => {
    expect(filterConflictRows(rows, {})).toHaveLength(4)
  })

  /**
   * §28.1 — "Conflicts are never hidden." Three of the four documents never told
   * the overlay whether they were touched since the checkpoint. A filter that
   * treated silence as `false` would hide two hard conflicts behind a checkbox.
   */
  it('never hides a row on a fact the overlay did not report', () => {
    const kept = filterConflictRows(rows, {touchedSinceCheckpoint: true})
    expect(kept.map((row) => row.conflictId)).toEqual(['c1', 'c2', 'c3', 'c4'])
    /* Non-vacuous: a row that explicitly says `false` IS filtered out. */
    const known = conflictListRows(
      readConflictReport({
        documents: [
          {logicalId: 'a', touchedSinceCheckpoint: false, conflicts: [{...SAME_PATH, documentId: 'a'}]},
          {logicalId: 'b', touchedSinceCheckpoint: true, conflicts: [{...BASE_DELETED, documentId: 'b'}]},
        ],
      }),
    )
    expect(
      filterConflictRows(known, {touchedSinceCheckpoint: true}).map((row) => row.documentId),
    ).toEqual(['b'])
  })

  it('combines filters with AND', () => {
    expect(
      filterConflictRows(rows, {severity: 'hard', schemaType: 'article'}).map((r) => r.conflictId),
    ).toEqual(['c2'])
  })
})

/* ═══════════════════════════════ §28.3 per-document indication ═══════════ */

describe('documentConflictIndicator — the per-document indication', () => {
  it('reports nothing for a document with no conflict', () => {
    const indicator = documentConflictIndicator(REPORT, 'article-99')
    expect(indicator.state).toBe('none')
    expect(indicator.total).toBe(0)
    expect(indicator.blocksBranchPublish).toBe(false)
  })

  it('reports a soft conflict as a warning that still allows editing', () => {
    const indicator = documentConflictIndicator(REPORT, 'article-1')
    expect(indicator.state).toBe('soft')
    expect(indicator.soft).toBe(1)
    expect(indicator.hard).toBe(0)
    /* §21.3 "Soft conflict … Editing allowed"; §28.1 soft allows branch publish. */
    expect(indicator.blocksBranchPublish).toBe(false)
    expect(indicator.label).toMatch(/soft/i)
  })

  it('reports a hard conflict as blocking branch publish (§28.1)', () => {
    const indicator = documentConflictIndicator(REPORT, 'article-2')
    expect(indicator.state).toBe('hard')
    expect(indicator.hard).toBe(1)
    expect(indicator.blocksBranchPublish).toBe(true)
  })

  it('ignores resolved conflicts when deciding the indication', () => {
    const indicator = documentConflictIndicator(REPORT, 'article-4')
    expect(indicator.state).toBe('none')
    expect(indicator.resolved).toBe(1)
  })

  it('says "unknown", not "none", when the overlay reports no conflict field', () => {
    /* The distinction §28.1 forces. A green badge on a document whose conflict
     * state was never reported is the exact lie the rule forbids. */
    const silent = documentConflictIndicator(readConflictReport({documents: [{logicalId: 'a'}]}), 'a')
    expect(silent.state).toBe('unknown')
    expect(silent.label).toMatch(/not report|unknown|cannot/i)
    expect(silent.blocksBranchPublish).toBe(false)
  })

  it('resolves a draft address to its logical document', () => {
    expect(documentConflictIndicator(REPORT, 'drafts.article-1').state).toBe('soft')
  })
})

/* ══════════════════════════ §28.3 the four values, per candidate action ══ */

describe('resolvedPreviewValue — §28.3’s fourth row, per action', () => {
  it('keeps the branch value', () => {
    expect(resolvedPreviewValue(SAME_PATH, {action: 'keep-branch-value'})).toEqual({
      kind: 'value',
      value: 'Branch value',
    })
  })

  it('adopts the current staging value', () => {
    expect(resolvedPreviewValue(SAME_PATH, {action: 'accept-current-staging'})).toEqual({
      kind: 'value',
      value: 'Current staging',
    })
  })

  it('inherits base again when the local override is removed', () => {
    expect(resolvedPreviewValue(SAME_PATH, {action: 'remove-local-override'})).toEqual({
      kind: 'inherited',
      value: 'Current staging',
    })
  })

  it('shows the operator’s own value for a manual edit', () => {
    expect(resolvedPreviewValue(SAME_PATH, {action: 'manual-edit', value: 'Merged'})).toEqual({
      kind: 'value',
      value: 'Merged',
    })
    expect(resolvedPreviewValue(SAME_PATH, {action: 'manual-edit', value: undefined})).toEqual({
      kind: 'removed',
      value: undefined,
    })
  })

  it('shows a deletion for accept-base-deletion and a survival for keep-as-branch-created', () => {
    expect(resolvedPreviewValue(BASE_DELETED, {action: 'accept-base-deletion'}).kind).toBe('deleted')
    expect(resolvedPreviewValue(BASE_DELETED, {action: 'keep-as-branch-created'})).toEqual({
      kind: 'branch-created',
      value: undefined,
    })
  })

  it('shows the new ID for a rename', () => {
    expect(resolvedPreviewValue(COLLISION, {action: 'rename-branch-id', newId: 'article-3-b'})).toEqual(
      {kind: 'renamed', value: 'article-3-b'},
    )
  })
})

/* ════════════════════════════ §28.3 driving the seven actions ═══════════ */

describe('planConflictResolution — driving each §28.3 action', () => {
  it('produces a command for every action core says applies, for every conflict', () => {
    for (const conflict of [SAME_PATH, BASE_DELETED, COLLISION]) {
      for (const action of applicableResolutionActions(conflict)) {
        const input: Record<string, unknown> = {action, confirmed: true}
        if (action === 'manual-edit') input.value = 'Merged'
        if (action === 'rename-branch-id') input.newId = `${conflict.documentId}-renamed`
        const plan = planConflictResolution(conflict, input as never)
        expect(plan.ok, `${conflict.type}/${action}`).toBe(true)
        if (!plan.ok) continue
        expect(plan.command.kind).toBe('conflictResolution')
        expect(plan.command.conflictId).toBe(conflict.id)
        expect(plan.command.documentId).toBe(conflict.documentId)
        expect(plan.command.action).toBe(action)
        /* The §13.11 resolution type core would stamp, not a second mapping. */
        expect(['keep-local', 'accept-base', 'manual', 'rename', 'delete-local']).toContain(
          plan.command.resolution,
        )
      }
    }
  })

  it('only ever emits an action from core’s own set', () => {
    const plan = planConflictResolution(SAME_PATH, {action: 'keep-branch-value'})
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(CONFLICT_RESOLUTION_ACTIONS as readonly string[]).toContain(plan.command.action)
  })

  it('refuses an action core says does not apply to that conflict', () => {
    /* `accept-current-staging` is a PATH action; a whole-document base deletion
     * has no path, and core would throw. */
    const plan = planConflictResolution(BASE_DELETED, {action: 'accept-current-staging'} as never)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/does not apply|BASE_DOCUMENT_DELETED|not one of/i)
  })

  it('refuses to resolve an already-resolved conflict a second time', () => {
    const plan = planConflictResolution(RESOLVED, {action: 'keep-branch-value'})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/already resolved/i)
  })

  /* ---- "a resolution that does not actually resolve" ---- */

  it('refuses a rename to the ID the document already has', () => {
    const plan = planConflictResolution(COLLISION, {
      action: 'rename-branch-id',
      newId: 'article-3',
      confirmed: true,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/already|same id|would not rename/i)
  })

  it('refuses a rename with no new ID at all', () => {
    for (const newId of [undefined, '', '   ']) {
      const plan = planConflictResolution(COLLISION, {
        action: 'rename-branch-id',
        ...(newId === undefined ? {} : {newId}),
        confirmed: true,
      } as never)
      expect(plan.ok, JSON.stringify(newId)).toBe(false)
    }
  })

  it('refuses a manual edit that never supplied a value key', () => {
    /* `value: undefined` is a real instruction — "remove the field" — so the KEY
     * has to be present. A missing key is an unfinished form, and committing it
     * would silently unset the field the editor was trying to merge. */
    const missing = planConflictResolution(SAME_PATH, {action: 'manual-edit', confirmed: true} as never)
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).toMatch(/value/i)

    const explicit = planConflictResolution(SAME_PATH, {
      action: 'manual-edit',
      value: undefined,
      confirmed: true,
    })
    expect(explicit.ok).toBe(true)
  })

  it('refuses a manual edit whose value is already the branch value', () => {
    const plan = planConflictResolution(SAME_PATH, {
      action: 'manual-edit',
      value: 'Branch value',
      confirmed: true,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/identical|unchanged|change nothing/i)
    /* …and it points at the action that expresses the intent. */
    expect(plan.reason).toMatch(/keep branch value/i)
  })

  /* ---- destruction is confirmed, and the loss is stated ---- */

  it.each([
    ['accept-current-staging', SAME_PATH],
    ['remove-local-override', SAME_PATH],
    ['accept-base-deletion', BASE_DELETED],
  ] as const)('refuses %s until it is confirmed, and says what is lost', (action, conflict) => {
    const unconfirmed = planConflictResolution(conflict, {action} as never)
    expect(unconfirmed.ok).toBe(false)
    if (unconfirmed.ok) return
    expect(unconfirmed.needsConfirmation).toBe(true)
    expect(unconfirmed.loss).toBeDefined()
    expect(unconfirmed.loss!.destructive).toBe(true)
    expect(unconfirmed.loss!.summary.length).toBeGreaterThan(20)

    const confirmed = planConflictResolution(conflict, {action, confirmed: true} as never)
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    /* The same loss report travels with the command, so a caller that shows it
     * and a caller that sends it cannot disagree about what was destroyed. */
    expect(confirmed.loss?.summary).toBe(unconfirmed.loss!.summary)
  })

  it.each(['keep-branch-value', 'keep-as-branch-created'] as const)(
    'needs no confirmation for %s, which destroys nothing',
    (action) => {
      const conflict = action === 'keep-branch-value' ? SAME_PATH : BASE_DELETED
      const plan = planConflictResolution(conflict, {action})
      expect(plan.ok).toBe(true)
      if (!plan.ok) return
      expect(plan.loss?.destructive ?? false).toBe(false)
    },
  )

  it('names the branch value that accept-current-staging throws away', () => {
    const plan = planConflictResolution(SAME_PATH, {action: 'accept-current-staging'})
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.loss!.losing).toEqual([
      {path: 'title', value: 'Branch value', replacedBy: 'Current staging'},
    ])
  })

  it('carries the §28.3 preview of what the resolution will produce', () => {
    const plan = planConflictResolution(SAME_PATH, {
      action: 'accept-current-staging',
      confirmed: true,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.preview).toEqual({kind: 'value', value: 'Current staging'})
  })
})
