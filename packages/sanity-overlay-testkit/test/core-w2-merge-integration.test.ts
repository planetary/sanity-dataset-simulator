import {describe, expect, it} from 'vitest'
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  discardDraft,
  duplicate,
  edit,
  localWinsMerge,
  publish,
  resolveDraft,
  resolvePublished,
  restore,
  unpublish,
} from '../../sanity-overlay-core/src/index'
import type {
  ActionOptions,
  OverlayConflict,
  OverlayState,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

/**
 * W2 × W3 composition (acceptance-audit finding F-01).
 *
 * W3 built the three-way merge; W2 built the mutation engine and the §18.4-§18.9
 * document actions; nothing ever connected them. `mutations/ports.ts` defaulted to
 * `localWinsMerge`, which returns the local materialized document verbatim — PRD
 * §17.2 precedence rule 3 *without* rule 4's untouched-path inheritance, i.e. a
 * documented violation of invariant §34.12.
 *
 * Every test here moves the **base** on a path the branch never touched, after the
 * branch has already been anchored, and then asserts through a W2 surface. That is
 * the one shape `localWinsMerge` cannot answer: the ancestor is captured at first
 * touch, so a base field that never moved is already inside the local materialized
 * document and the stub looks correct.
 *
 * PRD §17.2 rules 3-4, §17.5, §17.6, §17.7, §18.4-§18.9, §34.11, §34.12, §34.13,
 * §35.5.
 */

/* ------------------------------------------------------------------ *
 * Deterministic harness
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const

let transactionCounter = 0
function tx(overrides: Partial<TransactionOptions> = {}): TransactionOptions {
  transactionCounter += 1
  return {
    transactionId: `01JMERGE${String(transactionCounter).padStart(6, '0')}`,
    idempotencyKey: `merge-key-${transactionCounter}`,
    actor: ACTOR,
    now: () => '2026-08-04T12:00:00.000Z',
    ...overrides,
  }
}

/** The base as it stood when the branch first touched the document (the ancestor). */
const ARTICLE_V1: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Base title',
  editor: 'Ada',
  hero: {heading: 'Base heading', subtitle: 'Base subtitle'},
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B'},
  ],
}

/**
 * The base *after* upstream moved on. Every difference is on a path the branch
 * never touches in these tests, so §17.2 rule 4 says every one of them must reach
 * the resolved document.
 */
const ARTICLE_V2: SanityDocument = {
  ...ARTICLE_V1,
  _rev: 'lake-rev-2',
  _updatedAt: '2026-02-01T00:00:00.000Z',
  editor: 'Grace',
  reviewer: 'Linus',
  hero: {heading: 'Moved heading', subtitle: 'Moved subtitle'},
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B (upstream)'},
    {_key: 'c', _type: 'section', title: 'Section C (upstream)'},
  ],
}

/** V2, plus an upstream change on the one path the branch *did* touch (§34.13). */
const ARTICLE_V2_TITLE_MOVED: SanityDocument = {...ARTICLE_V2, title: 'Upstream title'}

const baseV1 = createBaseSource([ARTICLE_V1])
const baseV2 = createBaseSource([ARTICLE_V2])
const baseV2TitleMoved = createBaseSource([ARTICLE_V2_TITLE_MOVED])

/* A document that exists upstream in *both* perspectives, so `publish` and
 * `unpublish` have a base draft and a base published version that disagree. */

const PAGE_PUBLISHED_V1: SanityDocument = {
  _id: 'page-1',
  _type: 'page',
  _rev: 'page-published-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Published page',
  owner: 'Ada',
}

const PAGE_DRAFT_V1: SanityDocument = {
  ...PAGE_PUBLISHED_V1,
  _id: 'drafts.page-1',
  _rev: 'page-draft-1',
  title: 'Draft page',
}

const PAGE_PUBLISHED_V2: SanityDocument = {
  ...PAGE_PUBLISHED_V1,
  _rev: 'page-published-2',
  title: 'Published page (upstream)',
  owner: 'Grace',
  reviewer: 'Linus',
}

/** The base draft moves too, but only on paths the branch never promoted. */
const PAGE_DRAFT_V2: SanityDocument = {
  ...PAGE_DRAFT_V1,
  _rev: 'page-draft-2',
  owner: 'Grace',
  reviewer: 'Linus',
}

const basePageV1 = createBaseSource([PAGE_PUBLISHED_V1, PAGE_DRAFT_V1])
const basePageV2 = createBaseSource([PAGE_PUBLISHED_V2, PAGE_DRAFT_V2])

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w2-merge'})
}

function options(overrides: Partial<ActionOptions> = {}): ActionOptions {
  return {...tx(), ...overrides}
}

/** Anchor the branch against V1 and record one local edit on `title`. */
function editedAgainstV1(title = 'Local title'): OverlayState {
  return edit(
    emptyState(),
    {id: 'article-1', operations: [{type: 'set', path: ['title'], value: title}]},
    options({base: baseV1}),
  ).state
}

function draftOf(state: OverlayState, logicalId = 'article-1') {
  const record = state.documents[logicalId]
  if (record === undefined) throw new Error(`no record for ${logicalId}`)
  return record.local.draft
}

function publishedOf(state: OverlayState, logicalId = 'article-1') {
  const record = state.documents[logicalId]
  if (record === undefined) throw new Error(`no record for ${logicalId}`)
  return record.local.published
}

function keysOf(value: unknown): string[] {
  return (value as {_key: string}[]).map((item) => item._key)
}

function titlesOf(value: unknown): string[] {
  return (value as {title: string}[]).map((item) => item.title)
}

/* ================================================================== *
 * The canonical case: publish must promote the *merged* document
 * ================================================================== */

describe('F-01 — the real three-way merge is the default merge resolver', () => {
  it('publish() promotes the merged draft, so base-only fields survive (§17.2 rule 4, §34.12)', () => {
    const edited = editedAgainstV1()
    const {state} = publish(edited, {id: 'article-1'}, options({base: baseV2}))

    const promoted = publishedOf(state)!.materialized
    // §17.2 rule 3 — the touched path keeps local intent.
    expect(promoted.title).toBe('Local title')
    // §17.2 rule 4 / §34.12 — every untouched path inherits the *current* base.
    expect(promoted.editor).toBe('Grace')
    expect(promoted.reviewer).toBe('Linus')
    expect(promoted.hero).toEqual({heading: 'Moved heading', subtitle: 'Moved subtitle'})
    // And the published perspective agrees.
    expect(resolvePublished(state, 'article-1', {base: baseV2})?.editor).toBe('Grace')
  })

  it('is the default, and the stub stays injectable for tests that want it', () => {
    const state = editedAgainstV1()

    // No `merge` in the context: production wiring.
    expect(resolveDraft(state, 'article-1', {base: baseV2})?.editor).toBe('Grace')
    expect(resolveDraft(state, 'article-1', {base: baseV2})?.reviewer).toBe('Linus')

    // The port is still a port: `localWinsMerge` can be asked for explicitly, and
    // it still drops every base-only field, which is exactly why it is not the
    // default any more.
    const stubbed = resolveDraft(state, 'article-1', {base: baseV2, merge: localWinsMerge})
    expect(stubbed?.editor).toBe('Ada')
    expect(stubbed?.reviewer).toBeUndefined()
  })

  it('leaves resolution unchanged when no base source is supplied', () => {
    const state = editedAgainstV1()
    // §16.4: with no current base the local document is the answer, byte for byte.
    expect(resolveDraft(state, 'article-1')).toEqual(draftOf(state)!.materialized)
  })
})

/* ================================================================== *
 * The class: untouched-path inheritance through every §18 action
 * ================================================================== */

describe('untouched-path inheritance survives every document action (PRD §18.4-§18.9, §35.5)', () => {
  it('edit (§18.4): a second local edit does not freeze the base at first touch', () => {
    const first = editedAgainstV1()
    const {state} = edit(
      first,
      {id: 'article-1', operations: [{type: 'set', path: ['hero', 'heading'], value: 'Local heading'}]},
      options({base: baseV2}),
    )

    const resolved = resolveDraft(state, 'article-1', {base: baseV2})
    expect(resolved?.title).toBe('Local title')
    expect((resolved?.hero as Record<string, unknown>).heading).toBe('Local heading')
    // The untouched sibling still inherits the moved base value (§17.6).
    expect((resolved?.hero as Record<string, unknown>).subtitle).toBe('Moved subtitle')
    expect(resolved?.editor).toBe('Grace')
  })

  it('publish (§18.5): the local published version resolves against the moved base', () => {
    const {state} = publish(editedAgainstV1(), {id: 'article-1'}, options({base: baseV2}))
    expect(publishedOf(state)!.materialized.reviewer).toBe('Linus')
    expect(resolvePublished(state, 'article-1', {base: baseV2})?.editor).toBe('Grace')
  })

  it('unpublish (§18.6): the preserved draft carries the merged published document', () => {
    const published = publish(editedAgainstV1(), {id: 'article-1'}, options({base: baseV1})).state
    const {state} = unpublish(published, {id: 'article-1'}, options({base: baseV2}))

    const preserved = draftOf(state)!.materialized
    expect(preserved.title).toBe('Local title')
    expect(preserved.editor).toBe('Grace')
    expect(preserved.reviewer).toBe('Linus')
    expect(state.documents['article-1']!.local.publishedTombstone).toBe(true)
  })

  it('discardDraft (§18.7): the surviving local published still inherits from base', () => {
    const published = publish(editedAgainstV1(), {id: 'article-1'}, options({base: baseV1})).state
    const redrafted = edit(
      published,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Draft only'}]},
      options({base: baseV1}),
    ).state
    const {state} = discardDraft(redrafted, {id: 'article-1'}, options({base: baseV1}))

    // §18.2 fallback: the drafts perspective now answers from local published.
    const resolved = resolveDraft(state, 'article-1', {base: baseV2})
    expect(resolved?.title).toBe('Local title')
    expect(resolved?.editor).toBe('Grace')
    expect(resolved?.reviewer).toBe('Linus')
  })

  it('delete then restore (§18.8): the recovered draft inherits the moved base', () => {
    const deleted = deleteDocument(editedAgainstV1(), {id: 'article-1'}, options({base: baseV1})).state
    expect(resolveDraft(deleted, 'article-1', {base: baseV2})).toBeNull()

    const {state} = restore(deleted, {id: 'article-1'}, options({base: baseV1}))
    const resolved = resolveDraft(state, 'article-1', {base: baseV2})
    expect(resolved?.title).toBe('Local title')
    expect(resolved?.editor).toBe('Grace')
    expect(resolved?.reviewer).toBe('Linus')
  })

  it('duplicate (§18.9): the copy is taken from the merged source document', () => {
    const {state} = duplicate(
      editedAgainstV1(),
      {id: 'article-1', newId: 'article-copy'},
      options({base: baseV2}),
    )

    const copy = draftOf(state, 'article-copy')!.materialized
    expect(copy._id).toBe('drafts.article-copy')
    expect(copy.title).toBe('Local title')
    expect(copy.editor).toBe('Grace')
    expect(copy.reviewer).toBe('Linus')
  })
})

/* ================================================================== *
 * An action that promotes a *resolved* document must record its intent,
 * or §17.2 rule 4 erases the action on the next read.
 * ================================================================== */

describe('an action that promotes a resolved document records its intent (§13.5, §17.2 rule 4)', () => {
  it('publish of an untouched base draft stays published (§18.5, §35.5 case 3)', () => {
    // No prior local edit: the promoted content comes entirely from the base
    // *draft*, which disagrees with the base *published* version.
    const {state} = publish(emptyState(), {id: 'page-1'}, options({base: basePageV1}))

    expect(publishedOf(state, 'page-1')!.materialized.title).toBe('Draft page')
    // §18.5 — the published perspective must show what the branch published, not
    // the upstream published document the branch replaced.
    expect(resolvePublished(state, 'page-1', {base: basePageV1})?.title).toBe('Draft page')
  })

  it('publish of an untouched base draft holds its ground when base publishes something else', () => {
    const {state} = publish(emptyState(), {id: 'page-1'}, options({base: basePageV1}))
    const conflicts: OverlayConflict[] = []

    const resolved = resolvePublished(state, 'page-1', {
      base: basePageV2,
      onConflict: (conflict) => conflicts.push(conflict),
    })

    // The promoted path is local intent: it survives the upstream change…
    expect(resolved?.title).toBe('Draft page')
    expect(conflicts.map((conflict) => [conflict.type, conflict.path])).toEqual([
      ['SAME_PATH_CHANGED', ['title']],
    ])
    // …and the paths the branch never promoted still inherit (§34.12).
    expect(resolved?.owner).toBe('Grace')
    expect(resolved?.reviewer).toBe('Linus')
  })

  it('unpublish of an untouched base document keeps the published body in the draft (§18.6)', () => {
    const {state} = unpublish(emptyState(), {id: 'page-1'}, options({base: basePageV1}))

    expect(draftOf(state, 'page-1')!.materialized.title).toBe('Published page')
    // §18.6 — the preserved draft holds the *published* document. Falling back to
    // the base draft here would silently discard what was unpublished.
    expect(resolveDraft(state, 'page-1', {base: basePageV1})?.title).toBe('Published page')
  })

  it('unpublish keeps the preserved draft when base moves afterwards', () => {
    const {state} = unpublish(emptyState(), {id: 'page-1'}, options({base: basePageV1}))

    const resolved = resolveDraft(state, 'page-1', {base: basePageV2})
    expect(resolved?.title).toBe('Published page')
    expect(resolved?.owner).toBe('Grace')
    expect(resolved?.reviewer).toBe('Linus')
  })
})

/* ================================================================== *
 * §17.5 / §34.11 — an explicit unset still suppresses a later base value
 * ================================================================== */

describe('explicit unset suppression composed with inheritance (PRD §17.5, §34.11)', () => {
  it('keeps the unset path suppressed while its untouched siblings still inherit', () => {
    const state = applyTransaction(
      emptyState(),
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'unset', path: ['hero', 'subtitle']}]}],
      tx({base: baseV1}),
    ).state

    const resolved = resolveDraft(state, 'article-1', {base: baseV2})
    // §17.5: absence alone is not the representation — the tracked unset keeps
    // suppressing the value base set *after* the branch recorded it (§34.11).
    expect(resolved?.hero).toEqual({heading: 'Moved heading'})
    // …and the rest of the document still inherits (§34.12).
    expect(resolved?.editor).toBe('Grace')
    expect(resolved?.reviewer).toBe('Linus')
  })

  it('carries the suppression through publish', () => {
    const unset = applyTransaction(
      emptyState(),
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'unset', path: ['hero', 'subtitle']}]}],
      tx({base: baseV1}),
    ).state
    const {state} = publish(unset, {id: 'article-1'}, options({base: baseV2}))

    expect(publishedOf(state)!.materialized.hero).toEqual({heading: 'Moved heading'})
    expect(publishedOf(state)!.materialized.reviewer).toBe('Linus')
  })
})

/* ================================================================== *
 * §34.13 — touched paths keep local intent, and the conflict is reported
 * ================================================================== */

describe('touched-path preservation and same-path conflicts (PRD §17.3 step 6, §34.13)', () => {
  it('keeps local intent on the touched path and reports SAME_PATH_CHANGED', () => {
    const state = editedAgainstV1()
    const conflicts: OverlayConflict[] = []

    const resolved = resolveDraft(state, 'article-1', {
      base: baseV2TitleMoved,
      onConflict: (conflict) => conflicts.push(conflict),
    })

    // §34.13: local intent survives on the touched path…
    expect(resolved?.title).toBe('Local title')
    // …and the untouched paths still inherit.
    expect(resolved?.editor).toBe('Grace')
    // …and the collision is *reported*, not silently swallowed (§17.4).
    expect(
      conflicts.map((conflict) => [conflict.type, conflict.severity, conflict.path]),
    ).toEqual([['SAME_PATH_CHANGED', 'soft', ['title']]])
    expect(conflicts[0]?.baseValue).toBe('Upstream title')
    expect(conflicts[0]?.localValue).toBe('Local title')
    expect(conflicts[0]?.ancestorValue).toBe('Base title')
  })

  it('reports nothing when the base did not move on the touched path', () => {
    const state = editedAgainstV1()
    const conflicts: OverlayConflict[] = []
    resolveDraft(state, 'article-1', {base: baseV2, onConflict: (c) => conflicts.push(c)})
    expect(conflicts).toEqual([])
  })
})

/* ================================================================== *
 * §17.7 / §35.3 — keyed arrays merge, they do not flatten
 * ================================================================== */

describe('keyed-array merges survive a document action (PRD §17.7, §35.3)', () => {
  it('publish keeps the local item edit, the upstream item edit and the upstream insertion', () => {
    const edited = edit(
      emptyState(),
      {
        id: 'article-1',
        operations: [{type: 'set', path: ['sections', {_key: 'a'}, 'title'], value: 'Section A (local)'}],
      },
      options({base: baseV1}),
    ).state

    const {state} = publish(edited, {id: 'article-1'}, options({base: baseV2}))
    const sections = publishedOf(state)!.materialized.sections

    // §35.3 case 1 + case 2 composed through an action: the locally edited keyed
    // item survives, the upstream edit to a *different* keyed item is inherited,
    // and the upstream insertion is not dropped. No duplicate `_key` (§17.7).
    expect(keysOf(sections)).toEqual(['a', 'b', 'c'])
    expect(titlesOf(sections)).toEqual([
      'Section A (local)',
      'Section B (upstream)',
      'Section C (upstream)',
    ])
  })

  it('duplicate copies the merged array rather than the frozen local one', () => {
    const edited = edit(
      emptyState(),
      {
        id: 'article-1',
        operations: [{type: 'set', path: ['sections', {_key: 'a'}, 'title'], value: 'Section A (local)'}],
      },
      options({base: baseV1}),
    ).state

    const {state} = duplicate(
      edited,
      {id: 'article-1', newId: 'article-copy'},
      options({base: baseV2}),
    )

    expect(keysOf(draftOf(state, 'article-copy')!.materialized.sections)).toEqual(['a', 'b', 'c'])
  })
})
