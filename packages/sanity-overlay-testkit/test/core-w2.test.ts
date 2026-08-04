import {describe, expect, it} from 'vitest'
import {
  OverlayActionBlockedError,
  OverlayDiffMatchPatchError,
  OverlayMutationError,
  OverlayPathError,
  OverlayPreconditionError,
  applyDiffMatchPatch,
  applyMutation,
  applyOperation,
  applySyntheticSystemFields,
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  discardDraft,
  documentExists,
  duplicate,
  edit,
  encodeOverlayPath,
  explicitUnsetPaths,
  getAtPath,
  isPathTouched,
  isSyntheticRev,
  mergeTouchedPaths,
  parseDiffMatchPatch,
  publish,
  resolveDraft,
  resolvePublished,
  restore,
  setAtPath,
  touchedPathFor,
  unpublish,
} from '../../sanity-overlay-core/src/index'
import type {
  ActionOptions,
  DocumentValidator,
  OverlayMutation,
  OverlayOperation,
  OverlayPath,
  OverlayState,
  SanityDocument,
  StrongReferenceCheck,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

// Phase 2 workstream W2 (plan docs/plans/phase-2-core-domain.md §5, §8.4).
// PRD §13.7 operations and mutations, §13.9 synthetic system fields,
// §17.5-§17.11 mutation semantics, §18.4-§18.9 document actions,
// §34 invariants 5 and 6, §35.4 mutation tests, §35.5 draft and action tests.

/* ------------------------------------------------------------------ *
 * Deterministic harness (plan §8.6: deterministic clock, actor, IDs)
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const

/** A clock that always returns the same instant, so output is byte-stable. */
function fixedClock(instant = '2026-08-03T12:00:00.000Z'): () => string {
  return () => instant
}

let transactionCounter = 0
function tx(overrides: Partial<TransactionOptions> = {}): TransactionOptions {
  transactionCounter += 1
  return {
    transactionId: `01JTX${String(transactionCounter).padStart(6, '0')}`,
    idempotencyKey: `key-${transactionCounter}`,
    actor: ACTOR,
    now: fixedClock(),
    ...overrides,
  }
}

const BASE_ARTICLE: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'base-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Base title',
  hero: {heading: 'Base heading', subtitle: 'Base subtitle'},
  views: 10,
  body: 'the quick brown fox',
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B'},
  ],
  tags: ['one', 'two'],
}

const BASE_AUTHOR: SanityDocument = {
  _id: 'author-1',
  _type: 'author',
  _rev: 'base-rev-author',
  _createdAt: '2026-01-01T00:00:00.000Z',
  name: 'Base author',
}

const BASE_DRAFT_PAGE: SanityDocument = {
  _id: 'drafts.page-1',
  _type: 'page',
  _rev: 'base-draft-rev',
  _createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Base draft page',
}

const BASE_PUBLISHED_PAGE: SanityDocument = {
  _id: 'page-1',
  _type: 'page',
  _rev: 'base-published-rev',
  _createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Base published page',
}

const base = createBaseSource([BASE_ARTICLE, BASE_AUTHOR, BASE_DRAFT_PAGE, BASE_PUBLISHED_PAGE])

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w2'})
}

function encodedPaths(paths: readonly OverlayPath[]): string[] {
  return paths.map((path) => encodeOverlayPath(path))
}

function draftOf(state: OverlayState, logicalId: string) {
  const record = state.documents[logicalId]
  if (record === undefined) throw new Error(`no record for ${logicalId}`)
  return record.local.draft
}

function publishedOf(state: OverlayState, logicalId: string) {
  const record = state.documents[logicalId]
  if (record === undefined) throw new Error(`no record for ${logicalId}`)
  return record.local.published
}

/** Patch the draft of `id` in one transaction, against the shared base fixture. */
function patchDraft(
  state: OverlayState,
  id: string,
  operations: OverlayOperation[],
  options: Partial<TransactionOptions> = {},
) {
  return applyTransaction(
    state,
    [{type: 'patch', id: `drafts.${id}`, operations}],
    tx({base, ...options}),
  )
}

function actionOptions(overrides: Partial<ActionOptions> = {}): ActionOptions {
  return {...tx({base}), ...overrides}
}

/* ================================================================== *
 * PRD §35.4 — Mutation tests (18 cases)
 * ================================================================== */

describe('PRD §35.4 mutation tests', () => {
  it('§35.4 "Create." creates a branch document with origin branch and _createdAt set once', () => {
    const document: SanityDocument = {_id: 'note-1', _type: 'note', title: 'Fresh'}
    const {state, transaction} = applyTransaction(
      emptyState(),
      [{type: 'create', document}],
      tx({base, now: fixedClock('2026-08-03T09:00:00.000Z')}),
    )

    const record = state.documents['note-1']!
    expect(record.origin).toBe('branch')
    expect(record.base).toBeNull()
    expect(record.schemaType).toBe('note')
    // `create` with a bare ID targets the published version (PRD §18.1).
    expect(record.local.published?.materialized).toMatchObject({
      _id: 'note-1',
      _type: 'note',
      title: 'Fresh',
    })
    // PRD §13.9 — `_createdAt` set once at branch creation, `_updatedAt` = mutation time.
    expect(record.local.published?.materialized._createdAt).toBe('2026-08-03T09:00:00.000Z')
    expect(record.local.published?.materialized._updatedAt).toBe('2026-08-03T09:00:00.000Z')
    expect(record.local.published?.ancestorKind).toBe('branch-created')
    expect(transaction.affectedDocumentIds).toEqual(['note-1'])
    expect(state.revision).toBe(1)
  })

  it('§35.4 "Create." requires _type at creation (PRD §13.9) and rejects an existing document', () => {
    expect(() =>
      applyTransaction(
        emptyState(),
        [{type: 'create', document: {_id: 'note-2'} as unknown as SanityDocument}],
        tx({base}),
      ),
    ).toThrow(OverlayMutationError)

    expect(() =>
      applyTransaction(
        emptyState(),
        [{type: 'create', document: {_id: 'article-1', _type: 'article'}}],
        tx({base}),
      ),
    ).toThrow(/already exists/)
  })

  it('§35.4 "Create-if-not-exists against base and overlay." is a no-op against both, and creates otherwise', () => {
    // Against BASE: article-1 exists upstream, so nothing is written.
    const againstBase = applyTransaction(
      emptyState(),
      [{type: 'createIfNotExists', document: {_id: 'article-1', _type: 'article', title: 'New'}}],
      tx({base}),
    )
    expect(Object.keys(againstBase.state.documents)).toEqual([])
    expect(againstBase.transaction.affectedDocumentIds).toEqual([])

    // Against OVERLAY: a branch-created document already in the overlay.
    const created = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'note-3', _type: 'note', title: 'Original'}}],
      tx({base}),
    )
    const againstOverlay = applyTransaction(
      created.state,
      [{type: 'createIfNotExists', document: {_id: 'note-3', _type: 'note', title: 'Replacement'}}],
      tx({base}),
    )
    expect(publishedOf(againstOverlay.state, 'note-3')?.materialized.title).toBe('Original')

    // Absent from both: it is created.
    const fresh = applyTransaction(
      emptyState(),
      [{type: 'createIfNotExists', document: {_id: 'note-4', _type: 'note', title: 'Created'}}],
      tx({base}),
    )
    expect(publishedOf(fresh.state, 'note-4')?.materialized.title).toBe('Created')

    // A tombstone means the document does not exist virtually (PRD §34.2).
    const deleted = applyTransaction(created.state, [{type: 'delete', id: 'note-3'}], tx({base}))
    const afterTombstone = applyTransaction(
      deleted.state,
      [{type: 'createIfNotExists', document: {_id: 'note-3', _type: 'note', title: 'Revived'}}],
      tx({base}),
    )
    expect(publishedOf(afterTombstone.state, 'note-3')?.materialized.title).toBe('Revived')
  })

  it('§35.4 "Create-or-replace." stores the full replacement and marks all user fields touched (PRD §17.10)', () => {
    const replacement: SanityDocument = {
      _id: 'article-1',
      _type: 'article',
      title: 'Replaced title',
      summary: 'Only field left',
    }
    const {state} = applyTransaction(
      emptyState(),
      [{type: 'createOrReplace', document: replacement}],
      tx({base}),
    )

    const local = publishedOf(state, 'article-1')!
    expect(local.materialized.title).toBe('Replaced title')
    expect(local.materialized.summary).toBe('Only field left')
    expect(local.materialized.hero).toBeUndefined()
    // Protected system fields follow the §13.9 policy, not the payload.
    expect(local.materialized._createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(isSyntheticRev(local.materialized._rev)).toBe(true)
    // Every user field of both the old and the new shape is touched, so dropped
    // fields keep suppressing base (§17.10).
    expect(encodedPaths(local.touchedPaths).sort()).toEqual([
      '$.body',
      '$.hero',
      '$.sections',
      '$.summary',
      '$.tags',
      '$.title',
      '$.views',
    ])
    expect(local.operations.at(-1)?.type).toBe('replaceDocument')
  })

  it('§35.4 "Create-or-replace." requires explicit intent for a _type change (PRD §17.10)', () => {
    expect(() =>
      applyTransaction(
        emptyState(),
        [{type: 'createOrReplace', document: {_id: 'article-1', _type: 'story', title: 'X'}}],
        tx({base}),
      ),
    ).toThrow(/explicit intent/)

    const allowed = applyTransaction(
      emptyState(),
      [{type: 'createOrReplace', document: {_id: 'article-1', _type: 'story', title: 'X'}}],
      tx({base, allowTypeChange: true}),
    )
    expect(publishedOf(allowed.state, 'article-1')?.materialized._type).toBe('story')
  })

  it('§35.4 "Delete." sets both tombstones and preserves record metadata (PRD §18.8, §34.2)', () => {
    const edited = patchDraft(emptyState(), 'article-1', [
      {type: 'set', path: ['title'], value: 'Local title'},
    ])
    const {state} = applyTransaction(edited.state, [{type: 'delete', id: 'article-1'}], tx({base}))

    const record = state.documents['article-1']!
    expect(record.local.draftTombstone).toBe(true)
    expect(record.local.publishedTombstone).toBe(true)
    // Record metadata is preserved for diff, recovery and promotion (§18.8).
    expect(record.local.draft?.materialized.title).toBe('Local title')
    expect(record.base?.published?.revision).toBe('base-rev-1')
    // A tombstone suppresses inheritance from base (§34.2).
    expect(resolvePublished(state, 'article-1', {base})).toBeNull()
    expect(resolveDraft(state, 'article-1', {base})).toBeNull()
  })

  it('§35.4 "Set." writes the nested path and records it under the §17.6 object rules', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'set', path: ['hero', 'heading'], value: 'Local heading'},
    ])

    const local = draftOf(state, 'article-1')!
    expect(local.materialized.hero).toEqual({
      heading: 'Local heading',
      subtitle: 'Base subtitle',
    })
    // §17.6: the nested path is tracked, not the whole object, so new upstream
    // siblings under `hero` keep inheriting base.
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.hero.heading'])
    expect(isPathTouched(local.touchedPaths, ['hero', 'subtitle'])).toBe(false)
  })

  it('§35.4 "Set." creates missing intermediate objects and marks a full object replacement as a subtree touch', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'set', path: ['seo', 'meta', 'title'], value: 'Deep'},
      {type: 'set', path: ['hero'], value: {heading: 'Whole new hero'}},
    ])

    const local = draftOf(state, 'article-1')!
    expect(local.materialized.seo).toEqual({meta: {title: 'Deep'}})
    expect(local.materialized.hero).toEqual({heading: 'Whole new hero'})
    // §17.6: a full object replacement touches the entire subtree.
    expect(isPathTouched(local.touchedPaths, ['hero', 'subtitle'])).toBe(true)
  })

  it('§35.4 "Set-if-missing." writes when absent and records no touched path when present', () => {
    const missing = patchDraft(emptyState(), 'article-1', [
      {type: 'setIfMissing', path: ['subtitle'], value: 'Added'},
    ])
    expect(draftOf(missing.state, 'article-1')?.materialized.subtitle).toBe('Added')
    expect(encodedPaths(draftOf(missing.state, 'article-1')!.touchedPaths)).toEqual(['$.subtitle'])

    // Present in the resolved virtual document (base merged with overlay, §17.2),
    // so the operation is a no-op and the path keeps inheriting base (plan §5).
    const present = patchDraft(emptyState(), 'article-1', [
      {type: 'setIfMissing', path: ['title'], value: 'Should not win'},
    ])
    const local = draftOf(present.state, 'article-1')!
    expect(local.materialized.title).toBe('Base title')
    expect(local.touchedPaths).toEqual([])
    expect(isPathTouched(local.touchedPaths, ['title'])).toBe(false)
  })

  it('§35.4 "Unset." records an explicit tracked tombstone that keeps suppressing base (PRD §17.5, §34.11)', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'unset', path: ['hero', 'subtitle']},
      // A path absent from the document is still recorded, so a base value added
      // later stays suppressed (§17.5).
      {type: 'unset', path: ['notYetInBase']},
    ])

    const local = draftOf(state, 'article-1')!
    expect(local.materialized.hero).toEqual({heading: 'Base heading'})
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.hero.subtitle', '$.notYetInBase'])
    // The unset is tracked as an operation, not represented by mere absence.
    expect(local.operations.filter((operation) => operation.type === 'unset')).toHaveLength(2)
    expect(isPathTouched(local.touchedPaths, ['notYetInBase'])).toBe(true)
  })

  it('§35.4 "Unset." keeps suppressing until an explicit later write revives the path (PRD §17.5)', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'unset', path: ['hero', 'subtitle']},
      {type: 'unset', path: ['title']},
      // Writing the path again removes the suppression and resumes normal local
      // precedence; the base value is no longer held down by a field tombstone.
      {type: 'set', path: ['title'], value: 'Back'},
    ])

    const local = draftOf(state, 'article-1')!
    expect(encodedPaths(explicitUnsetPaths(local.operations))).toEqual(['$.hero.subtitle'])
    expect(local.materialized.title).toBe('Back')
  })

  it('§35.4 "Insert before." inserts at a _key anchor and tracks the inserted key (PRD §17.7)', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {
        type: 'insert',
        path: ['sections', {_key: 'b'}],
        position: 'before',
        items: [{_key: 'a2', _type: 'section', title: 'Inserted'}],
      },
    ])

    const local = draftOf(state, 'article-1')!
    expect((local.materialized.sections as {_key: string}[]).map((item) => item._key)).toEqual([
      'a',
      'a2',
      'b',
    ])
    // §17.7: insertion is tracked against the stable `_key` anchor, not as a
    // full-array touch, so independent upstream additions survive.
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.sections[_key=a2]'])
  })

  it('§35.4 "Insert after." inserts after a _key anchor', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {
        type: 'insert',
        path: ['sections', {_key: 'a'}],
        position: 'after',
        items: [{_key: 'a1', _type: 'section', title: 'After A'}],
      },
    ])

    const local = draftOf(state, 'article-1')!
    expect((local.materialized.sections as {_key: string}[]).map((item) => item._key)).toEqual([
      'a',
      'a1',
      'b',
    ])
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.sections[_key=a1]'])
  })

  it('§35.4 "Replace array segment." replaces the anchored item with the supplied items', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {
        type: 'insert',
        path: ['sections', {_key: 'a'}],
        position: 'replace',
        items: [
          {_key: 'a-x', _type: 'section', title: 'X'},
          {_key: 'a-y', _type: 'section', title: 'Y'},
        ],
      },
    ])

    const local = draftOf(state, 'article-1')!
    expect((local.materialized.sections as {_key: string}[]).map((item) => item._key)).toEqual([
      'a-x',
      'a-y',
      'b',
    ])
    // Both the removed anchor and the replacements are recorded.
    expect(encodedPaths(local.touchedPaths)).toEqual([
      '$.sections[_key=a]',
      '$.sections[_key=a-x]',
      '$.sections[_key=a-y]',
    ])
  })

  it('§35.4 "Increment." folds inc into a local value and retains the original operation (PRD §17.8)', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'inc', path: ['views'], amount: 5},
    ])

    const local = draftOf(state, 'article-1')!
    expect(local.materialized.views).toBe(15)
    // §17.8: the resulting local value is stored, with the original operation
    // retained as metadata.
    expect(local.operations).toContainEqual({type: 'inc', path: ['views'], amount: 5})
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.views'])
  })

  it('§35.4 "Decrement." folds dec into a local value', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'dec', path: ['views'], amount: 4},
    ])

    const local = draftOf(state, 'article-1')!
    expect(local.materialized.views).toBe(6)
    expect(local.operations).toContainEqual({type: 'dec', path: ['views'], amount: 4})
  })

  it('§35.4 "Diff-match-patch." applies the patch to the observed value and stores the string (PRD §17.9)', () => {
    const patch = ['@@ -7,13 +7,11 @@', ' ick ', '-brown', '+red', '  fox', ''].join('\n')
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'diffMatchPatch', path: ['body'], patch},
    ])

    const local = draftOf(state, 'article-1')!
    // §17.9: the resulting string is preserved; the diff is never replayed later.
    expect(local.materialized.body).toBe('the quick red fox')
    expect(local.operations).toContainEqual({
      type: 'diffMatchPatch',
      path: ['body'],
      patch,
    })
  })

  it('§35.4 "Multi-document transaction." commits atomically with exactly one revision increment (PRD §34.5)', () => {
    const start = emptyState()
    const {state, transaction} = applyTransaction(
      start,
      [
        {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'A'}]},
        {type: 'patch', id: 'drafts.author-1', operations: [{type: 'set', path: ['name'], value: 'B'}]},
        {type: 'create', document: {_id: 'note-10', _type: 'note', title: 'C'}},
      ],
      tx({base}),
    )

    expect(state.revision).toBe(start.revision + 1)
    expect(transaction.overlayRevisionBefore).toBe(0)
    expect(transaction.overlayRevisionAfter).toBe(1)
    expect(transaction.affectedDocumentIds).toEqual(['article-1', 'author-1', 'note-10'])
    expect(Object.keys(transaction.resultChecksums).sort()).toEqual([
      'article-1',
      'author-1',
      'note-10',
    ])
    expect(state.transactions).toHaveLength(1)
    // §17.11: one manifest commit is the single visibility point.
    expect(draftOf(state, 'article-1')?.materialized.title).toBe('A')
    expect(draftOf(state, 'author-1')?.materialized.name).toBe('B')
  })

  it('§35.4 "Multi-document transaction." applies nothing when any mutation fails (all-or-nothing)', () => {
    const start = emptyState()
    expect(() =>
      applyTransaction(
        start,
        [
          {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'A'}]},
          // No such document in the overlay or in base.
          {type: 'patch', id: 'drafts.missing-doc', operations: [{type: 'set', path: ['x'], value: 1}]},
        ],
        tx({base}),
      ),
    ).toThrow(/does not exist/)

    expect(start.documents).toEqual({})
    expect(start.revision).toBe(0)
    expect(start.transactions).toEqual([])
  })

  it('§35.4 "Revision precondition success." applies when ifRevision matches the current revision', () => {
    // Against an untouched base document the precondition is the base revision.
    const first = applyTransaction(
      emptyState(),
      [
        {
          type: 'patch',
          id: 'article-1',
          ifRevision: 'base-rev-1',
          operations: [{type: 'set', path: ['title'], value: 'Precondition ok'}],
        },
      ],
      tx({base}),
    )
    expect(publishedOf(first.state, 'article-1')?.materialized.title).toBe('Precondition ok')

    // Against a locally modified document the precondition is the synthetic `_rev`.
    const currentRev = publishedOf(first.state, 'article-1')!.materialized._rev!
    expect(isSyntheticRev(currentRev)).toBe(true)
    const second = applyTransaction(
      first.state,
      [
        {
          type: 'patch',
          id: 'article-1',
          ifRevision: currentRev,
          operations: [{type: 'set', path: ['title'], value: 'Second'}],
        },
      ],
      tx({base}),
    )
    expect(publishedOf(second.state, 'article-1')?.materialized.title).toBe('Second')
  })

  it('§35.4 "Revision precondition failure." raises a structured conflict and applies nothing', () => {
    const start = emptyState()
    let thrown: unknown
    try {
      applyTransaction(
        start,
        [
          {
            type: 'patch',
            id: 'article-1',
            ifRevision: 'stale-rev',
            operations: [{type: 'set', path: ['title'], value: 'Nope'}],
          },
        ],
        tx({base}),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(OverlayPreconditionError)
    const error = thrown as OverlayPreconditionError
    expect(error.code).toBe('OVERLAY_REVISION_PRECONDITION_FAILED')
    expect(error.expected).toBe('stale-rev')
    expect(error.actual).toBe('base-rev-1')
    expect(error.toJSON()).toMatchObject({code: 'OVERLAY_REVISION_PRECONDITION_FAILED'})
    expect(start.documents).toEqual({})
  })

  it('§35.4 "Duplicate idempotency key returns original result." without reapplying (PRD §34.6, §13.10)', () => {
    const first = applyTransaction(
      emptyState(),
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'Once'}]}],
      tx({base, transactionId: 'tx-original', idempotencyKey: 'idem-1'}),
    )

    // A retry carries the same idempotency key but a fresh (server-assigned)
    // transaction ID; the original result including its transactionId is returned.
    const replay = applyTransaction(
      first.state,
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'Twice'}]}],
      tx({base, transactionId: 'tx-retry', idempotencyKey: 'idem-1'}),
    )

    expect(replay.replayed).toBe(true)
    expect(replay.transaction.transactionId).toBe('tx-original')
    expect(replay.transaction).toEqual(first.transaction)
    expect(replay.state).toBe(first.state)
    expect(replay.state.revision).toBe(1)
    expect(draftOf(replay.state, 'article-1')?.materialized.title).toBe('Once')
    expect(replay.state.transactions).toHaveLength(1)
  })

  it('§35.4 "Retry does not duplicate increment or insert." under one idempotency key (PRD §17.8, §17.11)', () => {
    const mutations: OverlayMutation[] = [
      {
        type: 'patch',
        id: 'drafts.article-1',
        operations: [
          {type: 'inc', path: ['views'], amount: 5},
          {
            type: 'insert',
            path: ['sections', {_key: 'b'}],
            position: 'after',
            items: [{_key: 'c', _type: 'section', title: 'C'}],
          },
        ],
      },
    ]

    const first = applyTransaction(
      emptyState(),
      mutations,
      tx({base, transactionId: 'tx-1', idempotencyKey: 'idem-retry'}),
    )
    const retry = applyTransaction(
      first.state,
      mutations,
      tx({base, transactionId: 'tx-2', idempotencyKey: 'idem-retry'}),
    )

    const local = draftOf(retry.state, 'article-1')!
    // The increment was applied exactly once.
    expect(local.materialized.views).toBe(15)
    // The insert was applied exactly once — no duplicate `_key`.
    expect((local.materialized.sections as {_key: string}[]).map((item) => item._key)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(retry.replayed).toBe(true)
    expect(retry.transaction.transactionId).toBe('tx-1')
    // §34.5: exactly one increment of the overlay revision across both requests.
    expect(retry.state.revision).toBe(1)
  })
})

/* ================================================================== *
 * PRD §35.5 — Draft and action tests (11 cases)
 * ================================================================== */

describe('PRD §35.5 draft and action tests', () => {
  it('§35.5 "Edit base published creates local draft."', () => {
    const {state} = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Edited'}]},
      actionOptions(),
    )

    const record = state.documents['article-1']!
    // §18.4: editing a published document creates or updates a local draft, and
    // never touches local published.
    expect(record.local.draft).not.toBeNull()
    expect(record.local.published).toBeNull()
    expect(record.local.draft?.materialized._id).toBe('drafts.article-1')
    expect(record.local.draft?.materialized.title).toBe('Edited')
    expect(record.local.draft?.ancestorKind).toBe('base-published')
    expect(record.local.draft?.ancestorRevision).toBe('base-rev-1')
    expect(record.origin).toBe('base')
    expect(state.revision).toBe(1)
  })

  it('§35.5 "Edit base draft creates local draft anchored correctly."', () => {
    const {state} = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'set', path: ['title'], value: 'Edited draft'}]},
      actionOptions(),
    )

    const draft = draftOf(state, 'page-1')!
    // Anchored to the base *draft*, not the base published version (PRD §13.5).
    expect(draft.ancestorKind).toBe('base-draft')
    expect(draft.ancestorRevision).toBe('base-draft-rev')
    expect(draft.materialized.title).toBe('Edited draft')
    const record = state.documents['page-1']!
    expect(record.base?.draft?.revision).toBe('base-draft-rev')
    expect(record.base?.published?.revision).toBe('base-published-rev')
    expect(record.base?.firstTouchedAt).toBe('2026-08-03T12:00:00.000Z')
  })

  it('§35.5 "Branch publish creates local published and removes local draft."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Ready'}]},
      actionOptions(),
    )
    const {state, transaction} = publish(edited.state, {id: 'article-1'}, actionOptions())

    const record = state.documents['article-1']!
    // §18.5: copy the resolved draft into local published, remove the local
    // draft, clear the published tombstone, emit one branch transaction.
    expect(record.local.published?.materialized.title).toBe('Ready')
    expect(record.local.published?.materialized._id).toBe('article-1')
    expect(record.local.draft).toBeNull()
    expect(record.local.publishedTombstone).toBe(false)
    expect(state.transactions).toHaveLength(2)
    expect(transaction.overlayRevisionAfter).toBe(2)
    expect(resolvePublished(state, 'article-1', {base})?.title).toBe('Ready')
  })

  it('§35.5 "Branch unpublish creates draft and published tombstone."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Live'}]},
      actionOptions(),
    )
    const published = publish(edited.state, {id: 'article-1'}, actionOptions())
    const {state} = unpublish(published.state, {id: 'article-1'}, actionOptions())

    const record = state.documents['article-1']!
    // §18.6: a draft holding the resolved published document is preserved, and
    // local published is removed only behind the tombstone.
    expect(record.local.draft?.materialized.title).toBe('Live')
    expect(record.local.draft?.materialized._id).toBe('drafts.article-1')
    expect(record.local.publishedTombstone).toBe(true)
    expect(record.local.published).toBeNull()
    expect(resolvePublished(state, 'article-1', {base})).toBeNull()
    expect(resolveDraft(state, 'article-1', {base})?.title).toBe('Live')
  })

  it('§35.5 "Branch unpublish creates draft and published tombstone." on an untouched base document', () => {
    // No prior overlay record: the §13.3 base block is captured at first touch.
    const {state} = unpublish(emptyState(), {id: 'article-1'}, actionOptions())

    const record = state.documents['article-1']!
    expect(record.origin).toBe('base')
    expect(record.base?.published?.revision).toBe('base-rev-1')
    expect(record.local.draft?.materialized.title).toBe('Base title')
    expect(record.local.publishedTombstone).toBe(true)
    expect(resolvePublished(state, 'article-1', {base})).toBeNull()
  })

  it('§35.5 "Branch publish creates local published and removes local draft." from an untouched base draft', () => {
    // page-1 has a base draft and a base published version; publishing without a
    // prior local edit promotes the resolved base draft (§18.2 → §18.5).
    const {state} = publish(emptyState(), {id: 'page-1'}, actionOptions())

    const record = state.documents['page-1']!
    expect(record.local.published?.materialized.title).toBe('Base draft page')
    expect(record.local.draft).toBeNull()
    expect(record.local.published?.materialized._id).toBe('page-1')
    expect(resolvePublished(state, 'page-1', {base})?.title).toBe('Base draft page')
  })

  it('§35.5 "Discard local draft preserves local published."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Published copy'}]},
      actionOptions(),
    )
    const published = publish(edited.state, {id: 'article-1'}, actionOptions())
    const draftedAgain = edit(
      published.state,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Draft only'}]},
      actionOptions(),
    )
    expect(draftOf(draftedAgain.state, 'article-1')?.materialized.title).toBe('Draft only')

    const {state} = discardDraft(draftedAgain.state, {id: 'article-1'}, actionOptions())
    const record = state.documents['article-1']!
    // §18.7: delete local draft state and its draft-only touched paths and
    // operations; do not remove local published.
    expect(record.local.draft).toBeNull()
    expect(record.local.published?.materialized.title).toBe('Published copy')
    // Fallback follows §18.2: the drafts perspective now resolves local published.
    expect(resolveDraft(state, 'article-1', {base})?.title).toBe('Published copy')
  })

  it('§35.5 "Delete sets both tombstones."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Doomed'}]},
      actionOptions(),
    )
    const {state} = deleteDocument(edited.state, {id: 'article-1'}, actionOptions())

    const record = state.documents['article-1']!
    expect(record.local.draftTombstone).toBe(true)
    expect(record.local.publishedTombstone).toBe(true)
    expect(record.local.draft?.materialized.title).toBe('Doomed')
    expect(documentExists(state, 'article-1', {base})).toBe(false)
    expect(documentExists(state, 'drafts.article-1', {base})).toBe(false)
  })

  it('§35.5 "Restore clears intended tombstones and restores state."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Recoverable'}]},
      actionOptions(),
    )
    const deleted = deleteDocument(edited.state, {id: 'article-1'}, actionOptions())

    const draftOnly = restore(deleted.state, {id: 'article-1', target: 'draft'}, actionOptions())
    expect(draftOnly.state.documents['article-1']!.local.draftTombstone).toBe(false)
    expect(draftOnly.state.documents['article-1']!.local.publishedTombstone).toBe(true)
    expect(resolveDraft(draftOnly.state, 'article-1', {base})?.title).toBe('Recoverable')

    const both = restore(deleted.state, {id: 'article-1'}, actionOptions())
    expect(both.state.documents['article-1']!.local.draftTombstone).toBe(false)
    expect(both.state.documents['article-1']!.local.publishedTombstone).toBe(false)
    expect(resolvePublished(both.state, 'article-1', {base})?.title).toBe('Base title')
  })

  it('§35.5 "Duplicate creates branch draft with new ID."', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Source'}]},
      actionOptions(),
    )
    const {state} = duplicate(
      edited.state,
      {
        id: 'article-1',
        newId: 'article-copy',
        transform: (document) => ({...document, title: `${String(document.title)} (copy)`}),
      },
      actionOptions(),
    )

    const record = state.documents['article-copy']!
    // §18.9: new logical ID, base revision metadata removed, origin branch,
    // content and `_type` preserved, transforms applied, starts as local draft.
    expect(record.origin).toBe('branch')
    expect(record.base).toBeNull()
    expect(record.local.draft).not.toBeNull()
    expect(record.local.published).toBeNull()
    expect(record.local.draft?.materialized._id).toBe('drafts.article-copy')
    expect(record.local.draft?.materialized._type).toBe('article')
    expect(record.local.draft?.materialized.title).toBe('Source (copy)')
    expect(record.local.draft?.ancestorKind).toBe('branch-created')
    expect(isSyntheticRev(record.local.draft?.materialized._rev)).toBe(true)
    // The source document is untouched.
    expect(draftOf(state, 'article-1')?.materialized.title).toBe('Source')
  })

  it('§35.5 "Publish blocks on schema error." via the injected validator', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: ''}]},
      actionOptions(),
    )

    const validate: DocumentValidator = (document) =>
      document.title === ''
        ? [{level: 'error', message: 'title is required', path: ['title']}]
        : []

    let thrown: unknown
    try {
      publish(edited.state, {id: 'article-1'}, actionOptions({validate}))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OverlayActionBlockedError)
    expect((thrown as OverlayActionBlockedError).reason).toBe('schema-validation-error')
    // Nothing was committed.
    expect(edited.state.documents['article-1']!.local.published).toBeNull()

    // A warning-level issue does not block (PRD §17.4).
    const warn: DocumentValidator = () => [{level: 'warning', message: 'short title'}]
    const ok = publish(edited.state, {id: 'article-1'}, actionOptions({validate: warn}))
    expect(ok.state.documents['article-1']!.local.published).not.toBeNull()
  })

  it('§35.5 "Publish blocks on strong reference to draft-only target." via the injected check', () => {
    const edited = edit(
      emptyState(),
      {
        id: 'article-1',
        operations: [
          {type: 'set', path: ['author'], value: {_type: 'reference', _ref: 'author-draft-only'}},
        ],
      },
      actionOptions(),
    )

    // W4 owns reference-graph traversal; W2 only consumes this port (§19.4, §19.5).
    const checkStrongReferences: StrongReferenceCheck = (input) =>
      input.action === 'publish'
        ? [
            {
              referringDocumentId: 'article-1',
              path: ['author'],
              targetId: 'author-draft-only',
              strength: 'strong',
              reason: 'target-draft-only',
            },
          ]
        : []

    let thrown: unknown
    try {
      publish(edited.state, {id: 'article-1'}, actionOptions({checkStrongReferences}))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OverlayActionBlockedError)
    expect((thrown as OverlayActionBlockedError).reason).toBe('strong-reference-invalid')
    // Invariant §34.10: strong references must resolve to a published virtual
    // target before branch publish.
    expect((thrown as OverlayActionBlockedError).details.references).toHaveLength(1)

    // A weak reference does not block (§19.5).
    const weak: StrongReferenceCheck = () => [
      {
        referringDocumentId: 'article-1',
        path: ['author'],
        targetId: 'author-draft-only',
        strength: 'weak',
        reason: 'target-draft-only',
      },
    ]
    const ok = publish(edited.state, {id: 'article-1'}, actionOptions({checkStrongReferences: weak}))
    expect(ok.state.documents['article-1']!.local.published).not.toBeNull()
  })

  it('§35.5 "Unpublish reports affected strong references." without blocking (PRD §18.6)', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Live'}]},
      actionOptions(),
    )
    const published = publish(edited.state, {id: 'article-1'}, actionOptions())

    const checkStrongReferences: StrongReferenceCheck = (input) =>
      input.action === 'unpublish'
        ? [
            {
              referringDocumentId: 'page-9',
              path: ['featured'],
              targetId: 'article-1',
              strength: 'strong',
              reason: 'target-unpublished',
            },
          ]
        : []

    const result = unpublish(
      published.state,
      {id: 'article-1'},
      actionOptions({checkStrongReferences}),
    )

    // §18.6 re-evaluates strong references and reports them; only publish and
    // delete block on them.
    expect(result.affectedStrongReferences).toEqual([
      {
        referringDocumentId: 'page-9',
        path: ['featured'],
        targetId: 'article-1',
        strength: 'strong',
        reason: 'target-unpublished',
      },
    ])
    expect(result.state.documents['article-1']!.local.publishedTombstone).toBe(true)
  })
})

/* ================================================================== *
 * Supporting behaviour the §35.4/§35.5 lists depend on
 * ================================================================== */

describe('W2 operations: paths and §17.6/§17.7 touch rules', () => {
  it('reads and writes keyed array paths without inventing identity (PRD §13.6)', () => {
    const document = {_id: 'x', _type: 't', items: [{_key: 'k1', label: 'one'}]} as SanityDocument
    expect(getAtPath(document, ['items', {_key: 'k1'}, 'label'])).toEqual({
      exists: true,
      value: 'one',
    })
    expect(getAtPath(document, ['items', {_key: 'nope'}])).toEqual({exists: false, value: undefined})
    expect(() => setAtPath(document, ['items', {_key: 'nope'}, 'label'], 'x')).toThrow(
      OverlayPathError,
    )
  })

  it('treats a numeric index path as a full-array touch (PRD §13.6, §17.7)', () => {
    expect(encodeOverlayPath(touchedPathFor(['tags', 2, 'label']))).toBe('$.tags')
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'set', path: ['tags', 1], value: 'TWO'},
    ])
    const local = draftOf(state, 'article-1')!
    expect(local.materialized.tags).toEqual(['one', 'TWO'])
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.tags'])
  })

  it('treats an insert into a non-keyed array as a full-array touch (PRD §17.7)', () => {
    const {state} = patchDraft(emptyState(), 'article-1', [
      {type: 'insert', path: ['tags', 0], position: 'after', items: ['one-and-a-half']},
    ])
    const local = draftOf(state, 'article-1')!
    expect(local.materialized.tags).toEqual(['one', 'one-and-a-half', 'two'])
    expect(encodedPaths(local.touchedPaths)).toEqual(['$.tags'])
  })

  it('rejects an insert that would produce a duplicate _key (PRD §17.7)', () => {
    expect(() =>
      patchDraft(emptyState(), 'article-1', [
        {
          type: 'insert',
          path: ['sections', {_key: 'a'}],
          position: 'after',
          items: [{_key: 'b', _type: 'section'}],
        },
      ]),
    ).toThrow(/duplicate _key/)
  })

  it('rejects an insert against a missing _key anchor rather than guessing (PRD §17.7)', () => {
    expect(() =>
      patchDraft(emptyState(), 'article-1', [
        {
          type: 'insert',
          path: ['sections', {_key: 'ghost'}],
          position: 'after',
          items: [{_key: 'z', _type: 'section'}],
        },
      ]),
    ).toThrow(OverlayPathError)
  })

  it('refuses to patch protected system fields, which follow the §13.9 policy', () => {
    const document: SanityDocument = {_id: 'x', _type: 't'}
    expect(() => applyOperation(document, {type: 'set', path: ['_id'], value: 'y'})).toThrow(
      /protected system field/,
    )
    expect(() => applyOperation(document, {type: 'set', path: ['_rev'], value: 'y'})).toThrow(
      /protected system field/,
    )
  })

  it('collapses touched paths under a recorded ancestor (PRD §17.6 subtree rule)', () => {
    const merged = mergeTouchedPaths(
      [['hero', 'heading'], ['title']],
      [['hero'], ['title'], ['sections', {_key: 'a'}]],
    )
    expect(encodedPaths(merged)).toEqual(['$.title', '$.hero', '$.sections[_key=a]'])
  })

  it('never mutates the document it is given', () => {
    const document: SanityDocument = {_id: 'x', _type: 't', hero: {heading: 'a'}}
    const snapshot = JSON.stringify(document)
    applyOperation(document, {type: 'set', path: ['hero', 'heading'], value: 'b'})
    expect(JSON.stringify(document)).toBe(snapshot)
  })
})

describe('W2 diffMatchPatch subset (PRD §17.9)', () => {
  const text1 = 'The quick brown fox jumps over the lazy dog.'

  it('applies a multi-hunk patch produced by patch_toText', () => {
    const patch = [
      '@@ -1,7 +1,8 @@',
      ' Th',
      '-e',
      '+at',
      '  qui',
      '@@ -21,18 +22,17 @@',
      ' jump',
      '-s',
      '+ed',
      '  over ',
      '-the',
      '+a',
      '  laz',
      '',
    ].join('\n')
    expect(applyDiffMatchPatch(text1, patch)).toBe(
      'That quick brown fox jumped over a lazy dog.',
    )
  })

  it('parses the shorthand header forms exactly as patch_fromText does', () => {
    // Omitted length means 1 with a 1-based start.
    expect(parseDiffMatchPatch('@@ -3 +3 @@\n-e\n+E\n')[0]).toMatchObject({
      start1: 2,
      length1: 1,
      start2: 2,
      length2: 1,
    })
    // An explicit length of 0 is an insertion point with a 0-based start.
    expect(parseDiffMatchPatch('@@ -0,0 +1,3 @@\n+abc\n')[0]).toMatchObject({
      start1: 0,
      length1: 0,
      start2: 0,
      length2: 3,
    })
    expect(applyDiffMatchPatch('def', '@@ -0,0 +1,3 @@\n+abc\n')).toBe('abcdef')
  })

  it('decodes percent-escaped payloads (encodeURI on write, decodeURI on read)', () => {
    // "a\nb" -> "a\nB": the newline is written as %0A.
    const patch = '@@ -1,3 +1,3 @@\n a%0A\n-b\n+B\n'
    expect(applyDiffMatchPatch('a\nb', patch)).toBe('a\nB')
  })

  it('throws on a malformed header, an unknown line prefix and a bad escape', () => {
    expect(() => parseDiffMatchPatch('@@ nonsense @@\n a\n')).toThrow(/Malformed hunk header/)
    expect(() => parseDiffMatchPatch('@@ -1,1 +1,1 @@\n?a\n')).toThrow(/Unknown patch line prefix/)
    expect(() => parseDiffMatchPatch('@@ -1,1 +1,1 @@\n %zz\n')).toThrow(/percent-escape/)
    expect(() => parseDiffMatchPatch(' a\n')).toThrow(/before any hunk header/)
  })

  it('throws OVERLAY_DMP_PATCH_UNSUPPORTED on unified-diff framing outside the subset', () => {
    let thrown: unknown
    try {
      parseDiffMatchPatch('--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OverlayDiffMatchPatchError)
    expect((thrown as OverlayDiffMatchPatchError).code).toBe('OVERLAY_DMP_PATCH_UNSUPPORTED')

    expect(() => parseDiffMatchPatch('@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline\n')).toThrow(
      /No newline/,
    )
  })

  it('throws rather than fuzzily relocating a hunk whose context does not match', () => {
    let thrown: unknown
    try {
      // Correct patch, wrong source text: upstream would Bitap-search for the
      // context; this engine refuses (PRD §17.9 stores the resulting string).
      applyDiffMatchPatch('a completely different string', '@@ -7,13 +7,11 @@\n ick \n-brown\n+red\n  fox\n')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OverlayDiffMatchPatchError)
    expect((thrown as OverlayDiffMatchPatchError).code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })

  it('rejects a hunk whose declared length disagrees with its payload', () => {
    expect(() => parseDiffMatchPatch('@@ -1,99 +1,1 @@\n-a\n+b\n')).toThrow(/length1/)
    expect(() => parseDiffMatchPatch('@@ -1,1 +1,99 @@\n-a\n+b\n')).toThrow(/length2/)
  })

  it('rejects a diffMatchPatch operation whose target is not an existing string', () => {
    expect(() =>
      patchDraft(emptyState(), 'article-1', [
        {type: 'diffMatchPatch', path: ['views'], patch: '@@ -1,1 +1,1 @@\n-a\n+b\n'},
      ]),
    ).toThrow(/must be an existing string/)
  })
})

describe('W2 synthetic system fields (PRD §13.9, §35.2)', () => {
  it('produces a deterministic overlay _rev and _updatedAt for the same logical state', () => {
    const document: SanityDocument = {_id: 'article-1', _type: 'article', title: 'T'}
    const first = applySyntheticSystemFields({
      document,
      documentId: 'article-1',
      overlayRevision: 3,
      now: '2026-08-03T12:00:00.000Z',
    })
    const second = applySyntheticSystemFields({
      // Same logical state, different key insertion order.
      document: {_type: 'article', title: 'T', _id: 'article-1'} as SanityDocument,
      documentId: 'article-1',
      overlayRevision: 3,
      now: '2026-08-03T12:00:00.000Z',
    })

    expect(first._rev).toBe(second._rev)
    expect(first._rev).toMatch(/^overlay\.3\.[0-9a-f]{12}$/)
    expect(isSyntheticRev(first._rev)).toBe(true)
    expect(first._updatedAt).toBe('2026-08-03T12:00:00.000Z')
  })

  it('changes the synthetic _rev when the overlay revision or the content changes', () => {
    const document: SanityDocument = {_id: 'a', _type: 't', title: 'T'}
    const revision3 = applySyntheticSystemFields({
      document,
      documentId: 'a',
      overlayRevision: 3,
      now: 'T0',
    })
    const revision4 = applySyntheticSystemFields({
      document,
      documentId: 'a',
      overlayRevision: 4,
      now: 'T0',
    })
    const changed = applySyntheticSystemFields({
      document: {...document, title: 'U'},
      documentId: 'a',
      overlayRevision: 3,
      now: 'T0',
    })
    expect(revision3._rev).not.toBe(revision4._rev)
    expect(revision3._rev).not.toBe(changed._rev)
  })

  it('stamps the draft ID form on a draft version and the published form on a published version', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'X'}]},
      actionOptions(),
    )
    expect(draftOf(edited.state, 'article-1')?.materialized._id).toBe('drafts.article-1')
    const published = publish(edited.state, {id: 'article-1'}, actionOptions())
    expect(publishedOf(published.state, 'article-1')?.materialized._id).toBe('article-1')
  })
})

describe('W2 transactions and idempotency (PRD §34.5, §34.6)', () => {
  it('rejects a transaction with no idempotency key or no server transaction ID', () => {
    expect(() =>
      applyTransaction(emptyState(), [{type: 'delete', id: 'x'}], {
        ...tx({base}),
        idempotencyKey: '',
      }),
    ).toThrow(/idempotencyKey/)
    expect(() =>
      applyTransaction(emptyState(), [{type: 'delete', id: 'x'}], {
        ...tx({base}),
        transactionId: '',
      }),
    ).toThrow(/transactionId/)
    expect(() => applyTransaction(emptyState(), [], tx({base}))).toThrow(/at least one mutation/)
  })

  it('validates every mutation before applying any (all-or-nothing)', () => {
    const start = emptyState()
    expect(() =>
      applyTransaction(
        start,
        [
          {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['t'], value: 1}]},
          {type: 'patch', id: 'drafts.author-1', operations: []},
        ],
        tx({base}),
      ),
    ).toThrow(/non-empty `operations`/)
    expect(start.documents).toEqual({})
  })

  it('records the §13.10 transaction envelope, keeping transactionId out of deduplication', () => {
    const {transaction} = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'note-20', _type: 'note'}}],
      tx({base, transactionId: 'tx-abc', idempotencyKey: 'idem-abc', requestId: 'req-1'}),
    )
    expect(transaction).toMatchObject({
      formatVersion: 1,
      transactionId: 'tx-abc',
      idempotencyKey: 'idem-abc',
      requestId: 'req-1',
      overlayId: 'overlay-w2',
      actor: ACTOR,
    })
    expect(transaction.resultChecksums['note-20']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('applyMutation is the step function and leaves the revision to the commit boundary', () => {
    const start = emptyState()
    const result = applyMutation(
      start,
      {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'S'}]},
      {now: fixedClock(), actor: ACTOR, base},
    )
    expect(result.state.revision).toBe(0)
    expect(draftOf(result.state, 'article-1')?.overlayRevision).toBe('1')
    expect(start.documents).toEqual({})
  })

  it('blocks a delete on a strong reference unless the same transaction covers the referrer (PRD §18.8)', () => {
    const checkStrongReferences: StrongReferenceCheck = () => [
      {
        referringDocumentId: 'page-1',
        path: ['featured'],
        targetId: 'article-1',
        strength: 'strong',
        reason: 'target-deleted',
      },
    ]

    expect(() =>
      applyTransaction(
        emptyState(),
        [{type: 'delete', id: 'article-1'}],
        tx({base, checkStrongReferences}),
      ),
    ).toThrow(OverlayActionBlockedError)

    // The same transaction also deletes the referring document, so it is legal.
    const both = applyTransaction(
      emptyState(),
      [
        {type: 'delete', id: 'article-1'},
        {type: 'delete', id: 'page-1'},
      ],
      tx({base, checkStrongReferences}),
    )
    expect(both.state.documents['article-1']!.local.publishedTombstone).toBe(true)
    expect(both.state.documents['page-1']!.local.publishedTombstone).toBe(true)
    expect(both.state.revision).toBe(1)
  })
})

describe('W2 perspective resolution used by the mutation engine (PRD §18.1, §18.2)', () => {
  it('falls back through the §18.2 chain when no local draft exists', () => {
    const state = emptyState()
    // No overlay record: base draft wins over base published for `drafts`.
    expect(resolveDraft(state, 'page-1', {base})?.title).toBe('Base draft page')
    expect(resolvePublished(state, 'page-1', {base})?.title).toBe('Base published page')
    // No base draft: the drafts perspective falls back to base published.
    expect(resolveDraft(state, 'article-1', {base})?.title).toBe('Base title')
  })

  it('answers existence against base plus overlay plus tombstones (PRD §35.4)', () => {
    const state = emptyState()
    expect(documentExists(state, 'article-1', {base})).toBe(true)
    expect(documentExists(state, 'drafts.article-1', {base})).toBe(false)
    expect(documentExists(state, 'drafts.page-1', {base})).toBe(true)
    expect(documentExists(state, 'nothing', {base})).toBe(false)
  })

  it('lets a local draft take precedence in the drafts perspective', () => {
    const {state} = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'set', path: ['title'], value: 'Local draft'}]},
      actionOptions(),
    )
    expect(resolveDraft(state, 'page-1', {base})?.title).toBe('Local draft')
    expect(resolvePublished(state, 'page-1', {base})?.title).toBe('Base published page')
  })
})
