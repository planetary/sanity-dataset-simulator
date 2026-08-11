import {describe, expect, it} from 'vitest'
import {
  OverlayMutationError,
  applyMutation,
  createBaseSource,
  createOverlayState,
  documentExists,
  edit,
  publish,
  resolveDocumentBatch,
  resolveDraft,
} from '../../sanity-overlay-core/src/index'
import type {
  ActionOptions,
  OverlayState,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

/*
 * ═══════════════════════════════════════════════════════════════════
 * R5 SUPERSESSION — the write-path half of the 2026-08-11 live defect.
 *
 * §18.5 publish leaves a record in the shape {published: <body>, draft: null,
 * draftTombstone: false}. §18.2 orders every fallthrough: local draft →
 * LOCAL PUBLISHED → base draft. A base draft that still exists upstream is
 * SUPERSEDED by the branch publish and must never resurface.
 *
 * Observed live over the real parity dataset: the editor published a title
 * ("Well?"), then typed again — and the next save re-materialized the stale
 * upstream draft ("Article 2 (DRAFT: retitled)") as the new local draft,
 * because `baselineFor` anchored the patch on base-draft before local-published,
 * the inverse of both §18.2 and its own docstring.
 * ═══════════════════════════════════════════════════════════════════
 */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const

function fixedClock(instant = '2026-08-11T12:00:00.000Z'): () => string {
  return () => instant
}

let counter = 0
function tx(overrides: Partial<TransactionOptions> = {}): TransactionOptions {
  counter += 1
  return {
    transactionId: `01JR5X${String(counter).padStart(5, '0')}`,
    idempotencyKey: `r5-key-${counter}`,
    actor: ACTOR,
    now: fixedClock(),
    ...overrides,
  }
}

/** The live shape: base holds BOTH a published doc and a stale upstream draft. */
const BASE_PUBLISHED: SanityDocument = {
  _id: 'article-2',
  _type: 'article',
  _rev: 'base-pub-rev',
  _createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Article 2',
  body: 'base body',
}

const BASE_STALE_DRAFT: SanityDocument = {
  _id: 'drafts.article-2',
  _type: 'article',
  _rev: 'base-draft-rev',
  _createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Article 2 (DRAFT: retitled)',
  body: 'base body',
}

const base = createBaseSource([BASE_PUBLISHED, BASE_STALE_DRAFT])

function actionOptions(overrides: Partial<ActionOptions> = {}): ActionOptions {
  return {...tx({base}), ...overrides}
}

/** Drive the branch into the R5 shape exactly the way the live session did. */
function publishedNoDraft(): OverlayState {
  const edited = edit(
    createOverlayState({overlayId: 'overlay-r5'}),
    {id: 'article-2', operations: [{type: 'set', path: ['title'], value: 'Well?'}]},
    actionOptions(),
  )
  const {state} = publish(edited.state, {id: 'article-2'}, actionOptions())
  const record = state.documents['article-2']!
  /* Preconditions of every test below — the §18.5 output shape, pinned. */
  expect(record.local.published?.materialized.title).toBe('Well?')
  expect(record.local.draft).toBeNull()
  expect(record.local.draftTombstone).toBe(false)
  return state
}

describe('§18.2 on the WRITE path — the edit after a branch publish', () => {
  it('anchors the new draft on LOCAL PUBLISHED, never on the superseded base draft', () => {
    const {state} = edit(
      publishedNoDraft(),
      {id: 'article-2', operations: [{type: 'set', path: ['body'], value: 'typed after publish'}]},
      actionOptions(),
    )

    const draft = state.documents['article-2']!.local.draft!
    /* The live symptom: title reverted to "Article 2 (DRAFT: retitled)". */
    expect(draft.materialized.title).toBe('Well?')
    expect(draft.materialized.body).toBe('typed after publish')
    expect(draft.ancestorKind).toBe('local-published')
  })

  it('the drafts-perspective resolution agrees with the write anchor', () => {
    const state = publishedNoDraft()
    /* The read side already answers "Well?" (core resolveDraftsPerspective).
     * The write side must anchor on the same document — a write baseline the
     * read path would never show is exactly the 2026-08-11 defect. */
    expect(resolveDraft(state, 'article-2', {base})?.title).toBe('Well?')

    const {state: after} = edit(
      state,
      {id: 'article-2', operations: [{type: 'set', path: ['body'], value: 'x'}]},
      actionOptions(),
    )
    expect(resolveDraft(after, 'article-2', {base})?.title).toBe('Well?')

    /* The perspectives resolver — the batch every reader consumes — must agree. */
    const batch = resolveDocumentBatch({
      ids: ['article-2'],
      perspective: 'drafts',
      now: '2026-08-11T12:00:00.000Z',
      records: after.documents,
      base,
    })
    expect(batch.entries[0]?.document?.title).toBe('Well?')
    expect(batch.entries[0]?.document?.body).toBe('x')
  })

  it('a raw patch mutation on the drafts address anchors the same way', () => {
    const {state} = applyMutation(
      publishedNoDraft(),
      {
        type: 'patch',
        id: 'drafts.article-2',
        operations: [{type: 'set', path: ['body'], value: 'patched after publish'}],
      },
      tx({base}),
    )
    const draft = state.documents['article-2']!.local.draft!
    expect(draft.materialized.title).toBe('Well?')
    expect(draft.ancestorKind).toBe('local-published')
  })

  it('boundary: with NO local published, editing still anchors on the base draft (§18.4)', () => {
    const {state} = edit(
      createOverlayState({overlayId: 'overlay-r5-b'}),
      {id: 'article-2', operations: [{type: 'set', path: ['body'], value: 'first touch'}]},
      actionOptions(),
    )
    const draft = state.documents['article-2']!.local.draft!
    expect(draft.materialized.title).toBe('Article 2 (DRAFT: retitled)')
    expect(draft.ancestorKind).toBe('base-draft')
  })
})

describe('§18.2 existence — the superseded draft address does not exist', () => {
  it('documentExists answers false for drafts.<id> in the published-no-draft shape', () => {
    /* resolveVersionBatch already answers null for this address in this shape;
     * documentExists answering true is the same-package disagreement. */
    expect(documentExists(publishedNoDraft(), 'drafts.article-2', {base})).toBe(false)
  })

  it('createIfNotExists on the superseded draft address CREATES, not silently no-ops', () => {
    const doc: SanityDocument = {_id: 'drafts.article-2', _type: 'article', title: 'fresh draft'}
    const {state} = applyMutation(
      publishedNoDraft(),
      {type: 'createIfNotExists', document: doc},
      tx({base}),
    )
    expect(state.documents['article-2']!.local.draft?.materialized.title).toBe('fresh draft')
  })

  it('create on the superseded draft address succeeds instead of ALREADY_EXISTS', () => {
    const doc: SanityDocument = {_id: 'drafts.article-2', _type: 'article', title: 'fresh draft'}
    const {state} = applyMutation(publishedNoDraft(), {type: 'create', document: doc}, tx({base}))
    expect(state.documents['article-2']!.local.draft?.materialized.title).toBe('fresh draft')
  })

  it('boundary: with NO local published the base draft still exists (§35.4 hosted parity)', () => {
    const untouched = createOverlayState({overlayId: 'overlay-r5-c'})
    expect(documentExists(untouched, 'drafts.article-2', {base})).toBe(true)
    expect(() =>
      applyMutation(
        untouched,
        {type: 'create', document: {_id: 'drafts.article-2', _type: 'article', title: 'dupe'}},
        tx({base}),
      ),
    ).toThrow(OverlayMutationError)
  })

  it('boundary: a live local draft exists, whatever the published layer holds', () => {
    const state = publishedNoDraft()
    const {state: redrafted} = edit(
      state,
      {id: 'article-2', operations: [{type: 'set', path: ['body'], value: 'y'}]},
      actionOptions(),
    )
    expect(documentExists(redrafted, 'drafts.article-2', {base})).toBe(true)
  })
})
