/**
 * Conflict persistence (PRD §13.3 `OverlayDocumentRecord.conflicts`, §13.1
 * `manifest.conflictSummary`, §17.4 severity, §17.11 "persisted only while
 * unresolved", §28.6 acknowledgement invalidation).
 *
 * The merge engine has always *detected* conflicts, but until now they only
 * reached an `onConflict` observer: nothing wrote them onto the §13.3 record,
 * nothing counted them into the §13.1 summary, and no caller of a §18.4-§18.9
 * action could see that its commit had disagreed with upstream. A conflict that
 * exists only in an observer callback cannot block promotion (§17.4), cannot be
 * resolved (§28.3) and cannot be acknowledged (§28.6).
 *
 * The contract asserted here:
 *
 * 1. every transaction that has a **current base view** re-detects the conflicts
 *    of the documents it touched and writes them onto `record.conflicts`;
 * 2. the caller sees them on the `TransactionCommit`/`ActionResult`, together
 *    with the overlay-wide §13.1 summary;
 * 3. a conflict is persisted **only while unresolved** — when the disagreement
 *    goes away the record stops carrying it (§17.11);
 * 4. a resolution or acknowledgement survives re-detection of the *same*
 *    disagreement, and is invalidated when base or local moves again (§28.6);
 * 5. without a base view nothing is detected and nothing is invented — core
 *    never fetches base (PRD §16.1), and "no base supplied" is not "base
 *    deleted" for the purpose of *persisting* a hard conflict.
 */
import {describe, expect, it} from 'vitest'
import {
  MemoryOverlayStorage,
  MemoryOverlayStore,
  applyTransaction,
  createBaseSource,
  compareOverlayHeads,
  createOverlayState,
  deleteDocument,
  discardDraft,
  edit,
  hasHardConflict,
  overlayConflictSummary,
  persistConflicts,
  publish,
  restore,
  summarizeConflicts,
  unresolvedConflicts,
} from '../../sanity-overlay-core/src/index'
import type {
  ActionOptions,
  OverlayConflict,
  OverlayDocumentRecord,
  OverlayState,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

/* ------------------------------------------------------------------ *
 * Deterministic harness
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const

let counter = 0
function options(overrides: Partial<ActionOptions> = {}): ActionOptions {
  counter += 1
  return {
    transactionId: `01JCONFLICT${String(counter).padStart(6, '0')}`,
    idempotencyKey: `conflict-key-${counter}`,
    actor: ACTOR,
    now: () => '2026-08-04T12:00:00.000Z',
    ...overrides,
  } as ActionOptions
}

const ARTICLE_V1: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Base title',
  editor: 'Ada',
  hero: {heading: 'Base heading'},
}

/** Upstream moved on the path the branch also touched → §17.4 SAME_PATH_CHANGED. */
const ARTICLE_TITLE_MOVED: SanityDocument = {
  ...ARTICLE_V1,
  _rev: 'lake-rev-2',
  title: 'Upstream title',
}

/** Upstream moved again, to a *different* value (§28.6 invalidation). */
const ARTICLE_TITLE_MOVED_AGAIN: SanityDocument = {
  ...ARTICLE_V1,
  _rev: 'lake-rev-3',
  title: 'Upstream title, second edition',
}

/** Upstream moved only on an untouched path → no conflict at all. */
const ARTICLE_EDITOR_MOVED: SanityDocument = {
  ...ARTICLE_V1,
  _rev: 'lake-rev-4',
  editor: 'Grace',
}

/** Upstream turned the touched object into a scalar → §17.4 hard conflict. */
const ARTICLE_HERO_FLATTENED: SanityDocument = {
  ...ARTICLE_V1,
  _rev: 'lake-rev-5',
  hero: 'now a string',
}

const OTHER_V1: SanityDocument = {
  _id: 'article-2',
  _type: 'article',
  _rev: 'other-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Other base title',
}

const OTHER_MOVED: SanityDocument = {...OTHER_V1, _rev: 'other-rev-2', title: 'Other upstream'}

const baseV1 = createBaseSource([ARTICLE_V1])
const baseTitleMoved = createBaseSource([ARTICLE_TITLE_MOVED])
const baseTitleMovedAgain = createBaseSource([ARTICLE_TITLE_MOVED_AGAIN])
const baseEditorMoved = createBaseSource([ARTICLE_EDITOR_MOVED])
const baseHeroFlattened = createBaseSource([ARTICLE_HERO_FLATTENED])
const basePairV1 = createBaseSource([ARTICLE_V1, OTHER_V1])
const basePairMoved = createBaseSource([ARTICLE_TITLE_MOVED, OTHER_MOVED])

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-conflicts'})
}

function recordOf(state: OverlayState, id = 'article-1'): OverlayDocumentRecord {
  const record = state.documents[id]
  if (record === undefined) throw new Error(`no record for ${id}`)
  return record
}

/** Anchor the branch against V1 with a local edit on `title`. */
function editTitle(state: OverlayState, base = baseV1, value = 'Local title'): OverlayState {
  return edit(
    state,
    {id: 'article-1', operations: [{type: 'set', path: ['title'], value}]},
    options({base}),
  ).state
}

/** Anchor the branch against V1 with a local edit inside the `hero` object. */
function editHero(state: OverlayState, base = baseV1): OverlayState {
  return edit(
    state,
    {id: 'article-1', operations: [{type: 'set', path: ['hero', 'heading'], value: 'Local heading'}]},
    options({base}),
  ).state
}

function shapeOf(conflicts: readonly OverlayConflict[]): unknown[] {
  return conflicts.map((conflict) => [conflict.type, conflict.severity, conflict.path])
}

/* ================================================================== *
 * 1 — detection lands on the record (§13.3)
 * ================================================================== */

describe('conflicts detected by a transaction are persisted on the §13.3 record', () => {
  it('edit against a base that moved on the touched path records SAME_PATH_CHANGED', () => {
    const anchored = editTitle(emptyState())
    // The branch edits again while upstream has since moved the same path.
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )

    expect(shapeOf(recordOf(result.state).conflicts)).toEqual([
      ['SAME_PATH_CHANGED', 'soft', ['title']],
    ])
    const [conflict] = recordOf(result.state).conflicts
    expect(conflict?.documentId).toBe('article-1')
    expect(conflict?.baseValue).toBe('Upstream title')
    expect(conflict?.localValue).toBe('Local title v2')
    expect(conflict?.ancestorValue).toBe('Base title')
    expect(conflict?.resolution).toBeUndefined()
  })

  it('records nothing when the base moved only on untouched paths', () => {
    const anchored = editTitle(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseEditorMoved}),
    )
    expect(recordOf(result.state).conflicts).toEqual([])
  })

  it('records the hard §17.4 conflict when the base flattens a touched object', () => {
    const anchored = editHero(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['hero', 'heading'], value: 'Local v2'}]},
      options({base: baseHeroFlattened}),
    )

    const conflicts = recordOf(result.state).conflicts
    expect(conflicts.map((entry) => entry.type)).toContain('PARENT_SHAPE_CHANGED')
    expect(hasHardConflict(conflicts)).toBe(true)
  })

  it('publish (§18.5) persists the conflict of the document it promoted', () => {
    const anchored = editTitle(emptyState())
    const result = publish(anchored, {id: 'article-1'}, options({base: baseTitleMoved}))
    expect(shapeOf(recordOf(result.state).conflicts)).toEqual([
      ['SAME_PATH_CHANGED', 'soft', ['title']],
    ])
  })

  it('a raw mutation transaction persists conflicts just as an action does', () => {
    const anchored = editTitle(emptyState())
    const result = applyTransaction(
      anchored,
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'X'}]}],
      options({base: baseTitleMoved}),
    )
    expect(shapeOf(recordOf(result.state).conflicts)).toEqual([
      ['SAME_PATH_CHANGED', 'soft', ['title']],
    ])
  })
})

/* ================================================================== *
 * 2 — the caller sees them (ActionResult / TransactionCommit)
 * ================================================================== */

describe('conflicts are surfaced to the caller of the action (§17.11 "surfaced at commit time")', () => {
  it('the ActionResult carries the conflicts the commit surfaced', () => {
    const anchored = editTitle(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    expect(shapeOf(result.conflicts)).toEqual([['SAME_PATH_CHANGED', 'soft', ['title']]])
    expect(result.conflicts).toEqual(recordOf(result.state).conflicts)
  })

  it('the ActionResult carries the overlay-wide §13.1 conflictSummary', () => {
    const anchored = editTitle(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    expect(result.conflictSummary).toEqual({total: 1, hard: 0, soft: 1})
  })

  it('the summary spans every document in the overlay, not only the one just written', () => {
    let state = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local one'}]},
      options({base: basePairV1}),
    ).state
    state = edit(
      state,
      {id: 'article-2', operations: [{type: 'set', path: ['title'], value: 'Local two'}]},
      options({base: basePairV1}),
    ).state

    // Both documents now disagree with upstream, but this commit touches only one.
    const result = edit(
      state,
      {id: 'article-2', operations: [{type: 'set', path: ['title'], value: 'Local two v2'}]},
      options({base: basePairMoved}),
    )

    // Surfaced *by this commit*: only article-2.
    expect(result.conflicts.map((conflict) => conflict.documentId)).toEqual(['article-2'])
    // But the §13.1 summary is overlay-wide, and article-1 was detected earlier…
    const summary = overlayConflictSummary(result.state)
    expect(result.conflictSummary).toEqual(summary)
    expect(summary.total).toBe(1)
  })

  it('an idempotent replay reports the persisted conflicts and changes nothing', () => {
    const anchored = editTitle(emptyState())
    const key = 'replay-conflict-key'
    const first = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved, idempotencyKey: key}),
    )
    const replay = edit(
      first.state,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved, idempotencyKey: key}),
    )

    expect(replay.replayed).toBe(true)
    expect(replay.state).toBe(first.state)
    expect(replay.conflicts).toEqual(first.conflicts)
    expect(replay.conflictSummary).toEqual({total: 1, hard: 0, soft: 1})
  })
})

/* ================================================================== *
 * 3 — persisted only while unresolved (§17.11)
 * ================================================================== */

describe('a conflict is persisted only while it is still a disagreement (§17.11)', () => {
  it('drops the conflict once the base stops disagreeing', () => {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    expect(conflicted.state.documents['article-1']?.conflicts).toHaveLength(1)

    // Upstream reverts: the same path no longer disagrees.
    const settled = edit(
      conflicted.state,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v3'}]},
      options({base: baseV1}),
    )
    expect(settled.state.documents['article-1']?.conflicts).toEqual([])
    expect(settled.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
  })

  it('keeps the same conflict identity and first detection time while it persists', () => {
    const anchored = editTitle(emptyState())
    const first = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved, now: () => '2026-08-04T12:00:00.000Z'}),
    )
    const second = edit(
      first.state,
      {id: 'article-1', operations: [{type: 'set', path: ['subtitle'], value: 'unrelated'}]},
      options({base: baseTitleMoved, now: () => '2026-09-09T09:09:09.000Z'}),
    )

    const before = first.state.documents['article-1']!.conflicts[0]!
    const after = second.state.documents['article-1']!.conflicts[0]!
    expect(after.id).toBe(before.id)
    // §13.11 `detectedAt` is when the disagreement was *first* seen.
    expect(after.detectedAt).toBe(before.detectedAt)
  })
})

/* ================================================================== *
 * 4 — resolution and acknowledgement survive, until invalidated (§28.6)
 * ================================================================== */

describe('persisting respects an existing resolution (§28.1, §28.6)', () => {
  const detected: OverlayConflict = {
    id: 'article-1:SAME_PATH_CHANGED:title',
    documentId: 'article-1',
    severity: 'soft',
    type: 'SAME_PATH_CHANGED',
    path: ['title'],
    ancestorValue: 'Base title',
    baseValue: 'Upstream title',
    localValue: 'Local title',
    detectedAt: '2026-08-04T12:00:00.000Z',
  }

  function recordWith(conflicts: OverlayConflict[]): OverlayDocumentRecord {
    return {
      formatVersion: 1,
      overlayId: 'overlay-conflicts',
      logicalId: 'article-1',
      schemaType: 'article',
      origin: 'base',
      base: null,
      local: {published: null, draft: null, publishedTombstone: false, draftTombstone: false},
      conflicts,
      runtimeRevision: 'r1',
      createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    } as OverlayDocumentRecord
  }

  const resolved: OverlayConflict = {
    ...detected,
    resolution: {
      type: 'keep-local',
      resolvedAt: '2026-08-04T13:00:00.000Z',
      resolvedBy: {type: 'user', id: 'user-1'},
    },
  }

  it('keeps the resolution when the same disagreement is detected again', () => {
    const next = persistConflicts(recordWith([resolved]), [detected])
    expect(next.conflicts).toHaveLength(1)
    expect(next.conflicts[0]?.resolution).toEqual(resolved.resolution)
  })

  it('re-raises the conflict when base moved to a different value (§28.6 invalidation)', () => {
    const moved: OverlayConflict = {...detected, baseValue: 'Upstream title, second edition'}
    const next = persistConflicts(recordWith([resolved]), [moved])
    expect(next.conflicts).toHaveLength(1)
    expect(next.conflicts[0]?.resolution).toBeUndefined()
    expect(next.conflicts[0]?.baseValue).toBe('Upstream title, second edition')
  })

  it('re-raises the conflict when the local value moved (§28.6 invalidation)', () => {
    const moved: OverlayConflict = {...detected, localValue: 'Local title v9'}
    const next = persistConflicts(recordWith([resolved]), [moved])
    expect(next.conflicts[0]?.resolution).toBeUndefined()
  })

  it('drops a resolved conflict that is no longer detected at all', () => {
    expect(persistConflicts(recordWith([resolved]), []).conflicts).toEqual([])
  })

  it('a resolved conflict is not counted in the §13.1 summary', () => {
    const record = recordWith([resolved])
    expect(unresolvedConflicts(record)).toEqual([])
    expect(summarizeConflicts(unresolvedConflicts(record))).toEqual({total: 0, hard: 0, soft: 0})
  })

  it('does not mutate the record it was given', () => {
    const record = recordWith([resolved])
    const snapshot = JSON.stringify(record)
    persistConflicts(record, [{...detected, baseValue: 'moved'}])
    expect(JSON.stringify(record)).toBe(snapshot)
  })

  it('survives a real resolution round-trip through the engine', () => {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    const live = conflicted.state.documents['article-1']!.conflicts[0]!
    const acknowledged: OverlayConflict = {
      ...live,
      resolution: {
        type: 'keep-local',
        resolvedAt: '2026-08-04T13:00:00.000Z',
        resolvedBy: {type: 'user', id: 'user-1'},
      },
    }

    // Same disagreement re-detected → the resolution stands, so it no longer counts.
    const kept = persistConflicts(
      {...conflicted.state.documents['article-1']!, conflicts: [acknowledged]},
      [live],
    )
    expect(kept.conflicts[0]?.resolution).toBeDefined()
    expect(overlayConflictSummary({...conflicted.state, documents: {'article-1': kept}})).toEqual({
      total: 0,
      hard: 0,
      soft: 0,
    })
  })
})

/* ================================================================== *
 * 5 — no base view means nothing detected and nothing invented
 * ================================================================== */

describe('detection requires a current base view (PRD §16.1 — core never fetches)', () => {
  it('invents no conflict when the transaction carries no base source', () => {
    const anchored = editTitle(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options(),
    )
    // Without a base view "gone" is indistinguishable from "not supplied", and a
    // hard BASE_DOCUMENT_DELETED must not be manufactured from an omitted option.
    expect(result.conflicts).toEqual([])
    expect(recordOf(result.state).conflicts).toEqual([])
  })

  it('leaves an existing conflict in place when a later transaction has no base view', () => {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    const blind = edit(
      conflicted.state,
      {id: 'article-1', operations: [{type: 'set', path: ['note'], value: 'x'}]},
      options(),
    )
    // Untouched: same conflict, not replaced by a manufactured BASE_DOCUMENT_DELETED.
    expect(recordOf(blind.state).conflicts).toEqual(recordOf(conflicted.state).conflicts)
    expect(blind.conflicts.map((conflict) => conflict.type)).toEqual(['SAME_PATH_CHANGED'])
  })

  /**
   * REVERSED 2026-08-11 — this test used to pin the OPPOSITE: that an empty
   * base source at commit time detects BASE_DOCUMENT_DELETED. That reading is
   * the exact inference that manufactured two hard conflicts in a live Mode 2
   * session: the Studio facade sends `baseDocuments: []` whenever it observed
   * nothing from the base plane (captured on the wire), and Content-free "[]"
   * is byte-identical between "I looked and it is gone" and "I could not
   * look". §16.1 makes DIRECT BASE READS the source of truth for deletion, so
   * the commit boundary — which only ever relays what a client happened to
   * carry — may never conclude deletion from an absent document in its view.
   * The explicit `baseStatus: 'deleted'` signal (a §16.6 drift-scan or
   * first-touch §16.3 assertion) is the only path to the conflict now, and
   * the merge suite pins that signal working with and without an ancestor.
   */
  it('does NOT manufacture BASE_DOCUMENT_DELETED from an empty commit-time base view', () => {
    const anchored = editTitle(emptyState())
    const result = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: createBaseSource([])}),
    )
    expect(result.conflicts).toEqual([])
    expect(result.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    /* And the branch edit itself landed untouched. */
    expect(recordOf(result.state).local.draft?.materialized.title).toBe('Local title v2')
  })
})

/* ================================================================== *
 * 6 — the §12 O2 sentence, end to end
 * ================================================================== */

describe('OVERLAY_SAME_PATH_CHANGED follows the §12 O2 / §17.4 sentence exactly', () => {
  /**
   * Plan §12 resolution O2: the conflict "is first surfaced to the writing client
   * at commit time (§17.11), persisted only when it remains unresolved, and a
   * persisted instance is soft and counted in `conflictSummary.soft`".
   *
   * The three clauses live in three modules — `compareOverlayHeads` surfaces,
   * `persistConflicts` persists, `overlayConflictSummary` counts — so only a
   * composed test can show the sentence is true.
   */
  const observed: SanityDocument = {
    _id: 'drafts.article-1',
    _type: 'article',
    _rev: 'overlay-rev-1',
    title: 'Observed title',
  }
  const otherHead: SanityDocument = {...observed, _rev: 'overlay-rev-2', title: 'Other head title'}

  function race(): ReturnType<typeof compareOverlayHeads> {
    return compareOverlayHeads({
      documentId: 'article-1',
      now: '2026-08-04T12:00:00.000Z',
      clientObserved: {revision: 'overlay-rev-1', document: observed},
      currentOverlay: {revision: 'overlay-rev-2', document: otherHead},
      requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}],
    })
  }

  function bareRecord(conflicts: OverlayConflict[] = []): OverlayDocumentRecord {
    return {
      formatVersion: 1,
      overlayId: 'overlay-conflicts',
      logicalId: 'article-1',
      schemaType: 'article',
      origin: 'base',
      base: null,
      local: {published: null, draft: null, publishedTombstone: false, draftTombstone: false},
      conflicts,
      runtimeRevision: 'overlay-rev-2',
      createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
    } as OverlayDocumentRecord
  }

  it('is surfaced at commit time, persists while unresolved, and counts as soft', () => {
    const surfaced = race()
    expect(surfaced.conflicts.map((conflict) => conflict.type)).toEqual([
      'OVERLAY_SAME_PATH_CHANGED',
    ])

    const persisted = persistConflicts(bareRecord(), surfaced.conflicts)
    expect(persisted.conflicts).toHaveLength(1)
    expect(persisted.conflicts[0]?.severity).toBe('soft')

    const state = {documents: {'article-1': persisted}}
    expect(overlayConflictSummary(state)).toEqual({total: 1, hard: 0, soft: 1})
  })

  it('stops being persisted once it is resolved and no longer raised', () => {
    const surfaced = race()
    const persisted = persistConflicts(bareRecord(), surfaced.conflicts)
    // The client retried against the current head; the race is over.
    expect(persistConflicts(persisted, []).conflicts).toEqual([])
  })
})

/* ================================================================== *
 * 7 — the persisted conflicts reach `manifest.conflictSummary` (§13.1)
 * ================================================================== */

describe('persisted conflicts reach the manifest through the memory adapter (§13.1)', () => {
  /**
   * The §13.1 field is recomputed by the store from the records it is handed, so
   * the loop only closes when the *engine* puts conflicts on those records. This
   * is the composition: a conflicted commit in core, committed through the W5
   * memory adapter, read back off the manifest.
   */
  async function commitConflicted(): Promise<{
    summary: {total: number; hard: number; soft: number}
    manifestSummary: {total: number; hard: number; soft: number}
  }> {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )

    const store = new MemoryOverlayStore({
      storage: new MemoryOverlayStorage(),
      now: () => '2026-08-04T12:00:00.000Z',
    })
    await store.createOverlay({
      overlayId: 'overlay-conflicts',
      base: {projectId: 'p', dataset: 'staging', apiVersion: '2024-11-12'},
      source: {repositoryId: 'r', branch: 'main'},
    })
    const committed = await store.commitTransaction('overlay-conflicts', {
      idempotencyKey: 'store-key-1',
      actor: ACTOR,
      mutations: [...conflicted.transaction.mutations],
      records: [recordOf(conflicted.state)],
      conflicts: conflicted.conflicts,
    })

    return {
      summary: conflicted.conflictSummary,
      manifestSummary: committed.manifest.conflictSummary,
    }
  }

  it('the manifest summary equals the summary the commit reported', async () => {
    const {summary, manifestSummary} = await commitConflicted()
    expect(summary).toEqual({total: 1, hard: 0, soft: 1})
    expect(manifestSummary).toEqual(summary)
  })
})

/* ================================================================== *
 * 8 — an unresolvable record keeps what it knew
 * ================================================================== */

describe('a record with no resolvable local version keeps its conflicts (§34.2)', () => {
  it('delete does not erase the conflicts the document had', () => {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    const deleted = deleteDocument(conflicted.state, {id: 'article-1'}, options({base: baseTitleMoved}))
    expect(recordOf(deleted.state).conflicts).toHaveLength(1)
  })

  it('discarding the last local version clears them, because the branch now owns nothing', () => {
    // A tombstone and an empty local block are *not* the same thing. A tombstone
    // is branch intent that a restore can bring back, so its conflicts survive.
    // An empty local block means §17.2 rule 4 inherits everything: there is no
    // local intent left for the base to disagree with, so nothing is unresolved.
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    expect(recordOf(conflicted.state).conflicts).toHaveLength(1)

    const discarded = discardDraft(conflicted.state, {id: 'article-1'}, options({base: baseTitleMoved}))
    expect(recordOf(discarded.state).local.draft).toBeNull()
    expect(recordOf(discarded.state).local.published).toBeNull()
    expect(recordOf(discarded.state).conflicts).toEqual([])
    expect(discarded.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
  })

  it('restore re-detects against the current base', () => {
    const anchored = editTitle(emptyState())
    const conflicted = edit(
      anchored,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Local title v2'}]},
      options({base: baseTitleMoved}),
    )
    const deleted = deleteDocument(conflicted.state, {id: 'article-1'}, options({base: baseTitleMoved}))
    const restored = restore(deleted.state, {id: 'article-1'}, options({base: baseTitleMovedAgain}))

    expect(recordOf(restored.state).conflicts).toHaveLength(1)
    expect(recordOf(restored.state).conflicts[0]?.baseValue).toBe('Upstream title, second edition')
  })
})
