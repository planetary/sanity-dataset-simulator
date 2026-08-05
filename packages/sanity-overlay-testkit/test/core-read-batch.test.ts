/**
 * Batch virtual-document resolution — the read half of PRD §18.1/§18.2.
 *
 * WHY THIS EXISTS
 * Core could already answer "what is the virtual view of *this one* document"
 * (`resolvePerspective`, `resolveVersion`). Every read surface in Studio asks the
 * plural question instead: a list pane wants the virtual view of a hundred IDs, a
 * reference picker wants a handful, the pair listener's snapshot wants exactly
 * two. Answering it one document at a time is not just slower — it loses the two
 * facts that only exist at the set level:
 *
 *   1. a **tombstoned** document must be *absent from the set*, not present and
 *      stale, and
 *   2. a **branch-created** document must be *in the set* even though no base
 *      query would ever have returned its ID.
 *
 * This file pins both, plus the pure passthrough of untouched documents.
 *
 * ORACLE DISCIPLINE
 * The overlay records under test are not hand-written: they are produced by
 * core's own *write* engine (`applyTransaction`, `deleteDocument`) from base
 * documents declared here. So the expected values are the literals at the top of
 * each test — never a value the read module just computed.
 */
import {describe, expect, it} from 'vitest'
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  discardDraft,
  publish,
  type OverlayState,
  type SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {
  overlayDocumentIds,
  resolveDocumentBatch,
  resolveVersionBatch,
} from '../../sanity-overlay-core/src/read/index'

const NOW = '2026-08-04T09:00:00.000Z'
const ACTOR = {type: 'user', id: 'reader'} as const
const now = (): string => NOW

/* ------------------------------------------------------------------ *
 * Base dataset — the read-only staging content (PRD §16.1)
 * ------------------------------------------------------------------ */

const BASE_ARTICLE_1: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Base title one',
  slug: {_type: 'slug', current: 'base-one'},
}

const BASE_ARTICLE_2: SanityDocument = {
  _id: 'article-2',
  _type: 'article',
  _rev: 'lake-rev-2',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Base title two',
}

const BASE_ARTICLE_3_DRAFT: SanityDocument = {
  _id: 'drafts.article-3',
  _type: 'article',
  _rev: 'lake-rev-3d',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Base draft three',
}

const BASE_DOCUMENTS = [BASE_ARTICLE_1, BASE_ARTICLE_2, BASE_ARTICLE_3_DRAFT]
const base = createBaseSource(BASE_DOCUMENTS)

/* ------------------------------------------------------------------ *
 * Overlay states, built by core's write engine
 * ------------------------------------------------------------------ */

let sequence = 0
function commit(
  state: OverlayState,
  mutations: Parameters<typeof applyTransaction>[1],
): OverlayState {
  sequence += 1
  return applyTransaction(state, mutations, {
    transactionId: `tx-${String(sequence).padStart(4, '0')}`,
    idempotencyKey: `key-${sequence}`,
    actor: ACTOR,
    now,
    base,
  }).state
}

const EMPTY = createOverlayState({overlayId: 'read-batch'})

/** `article-1` renamed in the branch (draft only). */
function renamedDraft(): OverlayState {
  return commit(EMPTY, [
    {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'Branch title one'}]},
  ])
}

/** `article-2` fully deleted in the branch (PRD §18.8 — both tombstones). */
function deletedArticle2(): OverlayState {
  sequence += 1
  return deleteDocument(EMPTY, {id: 'article-2'}, {
    transactionId: `tx-del-${sequence}`,
    idempotencyKey: `key-del-${sequence}`,
    actor: ACTOR,
    now,
    base,
  }).state
}

/** A document the base dataset has never heard of. */
function branchCreated(): OverlayState {
  return commit(EMPTY, [
    {
      type: 'create',
      document: {_id: 'drafts.article-new', _type: 'article', title: 'Branch created'},
    },
  ])
}

/* ------------------------------------------------------------------ *
 * Perspective batch — the list-pane read
 * ------------------------------------------------------------------ */

describe('resolveDocumentBatch — untouched documents pass base through', () => {
  it('returns the base published document unchanged for an untouched ID', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1', 'article-2'],
      perspective: 'published',
      now: NOW,
      records: EMPTY.documents,
      base,
    })

    expect(result.entries.map((entry) => entry.document?.title)).toEqual([
      'Base title one',
      'Base title two',
    ])
    expect(result.entries.map((entry) => entry.origin)).toEqual(['untouched', 'untouched'])
    expect(result.entries.map((entry) => entry.source)).toEqual([
      'base-published',
      'base-published',
    ])
    expect(result.missing).toEqual([])
  })

  it('reports an ID neither base nor overlay holds as missing, not as null noise', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1', 'ghost'],
      perspective: 'published',
      now: NOW,
      records: EMPTY.documents,
      base,
    })

    expect(result.missing).toEqual(['ghost'])
    expect(result.documents.map((document) => document._id)).toEqual(['article-1'])
    expect(result.entries[1]?.absence).toBe('missing')
  })

  it('never hands back the caller’s base document by reference', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'published',
      now: NOW,
      records: EMPTY.documents,
      base,
    })

    expect(result.entries[0]?.document).not.toBe(BASE_ARTICLE_1)
    expect(result.entries[0]?.document).toEqual(BASE_ARTICLE_1)
  })
})

describe('resolveDocumentBatch — overlay edits are visible', () => {
  it('returns the branch title in the drafts perspective', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'drafts',
      now: NOW,
      records: renamedDraft().documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch title one')
    expect(result.entries[0]?.origin).toBe('overlay')
    expect(result.entries[0]?.source).toBe('local-draft')
  })

  it('inherits an untouched field from base rather than freezing the first snapshot', () => {
    /* §17.2 rule 4: `slug` was never touched, so a later base change to it must
     * still be visible through the branch's own draft. */
    const movedBase = createBaseSource([
      {...BASE_ARTICLE_1, _rev: 'lake-rev-1b', slug: {_type: 'slug', current: 'moved'}},
      BASE_ARTICLE_2,
      BASE_ARTICLE_3_DRAFT,
    ])

    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'drafts',
      now: NOW,
      records: renamedDraft().documents,
      base: movedBase,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch title one')
    expect(result.entries[0]?.document?.slug).toEqual({_type: 'slug', current: 'moved'})
  })

  it('leaves the published perspective on base while only the draft is edited', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'published',
      now: NOW,
      records: renamedDraft().documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Base title one')
    expect(result.entries[0]?.source).toBe('base-published')
  })

  it('promotes the branch title into published once the branch publishes', () => {
    sequence += 1
    const published = publish(renamedDraft(), {id: 'article-1'}, {
      transactionId: `tx-pub-${sequence}`,
      idempotencyKey: `key-pub-${sequence}`,
      actor: ACTOR,
      now,
      base,
    }).state

    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'published',
      now: NOW,
      records: published.documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch title one')
    expect(result.entries[0]?.source).toBe('local-published')
  })
})

describe('resolveDocumentBatch — tombstones remove, they do not staleness-preserve', () => {
  it('drops a locally deleted document from both perspectives', () => {
    const records = deletedArticle2().documents

    for (const perspective of ['published', 'drafts'] as const) {
      const result = resolveDocumentBatch({
        ids: ['article-1', 'article-2'],
        perspective,
        now: NOW,
        records,
        base,
      })

      expect(result.entries[1]?.document).toBeNull()
      expect(result.entries[1]?.absence).toBe('tombstone')
      expect(result.missing).toEqual(['article-2'])
      /* The point of the whole exercise: the base title must NOT come back. */
      expect(result.documents.map((document) => document._id)).toEqual(['article-1'])
      expect(JSON.stringify(result.documents)).not.toContain('Base title two')
    }
  })

  it('restores base visibility once the tombstone is gone', () => {
    const result = resolveDocumentBatch({
      ids: ['article-2'],
      perspective: 'published',
      now: NOW,
      records: EMPTY.documents,
      base,
    })
    expect(result.entries[0]?.document?.title).toBe('Base title two')
  })

  it('suppresses the base draft when only the draft is discarded, keeping published', () => {
    /* A branch draft on top of base, then discarded: §18.7 leaves the published
     * version alone, so the drafts perspective falls back to it. */
    sequence += 1
    const discarded = discardDraft(renamedDraft(), {id: 'article-1'}, {
      transactionId: `tx-dis-${sequence}`,
      idempotencyKey: `key-dis-${sequence}`,
      actor: ACTOR,
      now,
      base,
    }).state

    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'drafts',
      now: NOW,
      records: discarded.documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Base title one')
  })
})

describe('resolveDocumentBatch — branch-created documents exist without a base', () => {
  it('returns a document base has never seen', () => {
    const result = resolveDocumentBatch({
      ids: ['article-new'],
      perspective: 'drafts',
      now: NOW,
      records: branchCreated().documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch created')
    expect(result.entries[0]?.origin).toBe('branch-created')
    expect(result.entries[0]?.document?._id).toBe('drafts.article-new')
    expect(result.missing).toEqual([])
  })

  it('reports the branch-created document as absent from the published perspective', () => {
    const result = resolveDocumentBatch({
      ids: ['article-new'],
      perspective: 'published',
      now: NOW,
      records: branchCreated().documents,
      base,
    })

    expect(result.entries[0]?.document).toBeNull()
    expect(result.missing).toEqual(['article-new'])
  })
})

describe('resolveDocumentBatch — request contract', () => {
  it('answers in request order and normalizes a drafts-prefixed ID to its logical ID', () => {
    const result = resolveDocumentBatch({
      ids: ['article-2', 'drafts.article-1'],
      perspective: 'drafts',
      now: NOW,
      records: renamedDraft().documents,
      base,
    })

    expect(result.entries.map((entry) => entry.requestedId)).toEqual([
      'article-2',
      'drafts.article-1',
    ])
    expect(result.entries.map((entry) => entry.logicalId)).toEqual(['article-2', 'article-1'])
    expect(result.entries[1]?.document?.title).toBe('Branch title one')
  })

  it('answers a repeated ID once per request slot', () => {
    const result = resolveDocumentBatch({
      ids: ['article-1', 'article-1'],
      perspective: 'published',
      now: NOW,
      records: EMPTY.documents,
      base,
    })
    expect(result.entries).toHaveLength(2)
    expect(result.documents).toHaveLength(2)
  })

  it('resolves with no base source at all — overlay-only reads still work', () => {
    const result = resolveDocumentBatch({
      ids: ['article-new', 'article-1'],
      perspective: 'drafts',
      now: NOW,
      records: branchCreated().documents,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch created')
    expect(result.entries[1]?.document).toBeNull()
  })

  it('is pure — it mutates neither the records nor the requested ID list', () => {
    const state = renamedDraft()
    const before = JSON.stringify(state.documents)
    const ids = ['article-1', 'article-2']

    resolveDocumentBatch({ids, perspective: 'drafts', now: NOW, records: state.documents, base})

    expect(JSON.stringify(state.documents)).toBe(before)
    expect(ids).toEqual(['article-1', 'article-2'])
  })

  it('is deterministic — the same request twice gives byte-identical answers', () => {
    const request = {
      ids: ['article-1', 'article-2', 'article-new'],
      perspective: 'drafts' as const,
      now: NOW,
      records: renamedDraft().documents,
      base,
    }
    expect(JSON.stringify(resolveDocumentBatch(request))).toBe(
      JSON.stringify(resolveDocumentBatch(request)),
    )
  })

  it('surfaces merge conflicts instead of swallowing them', () => {
    /* Base moved the same path the branch touched: §17.4 OVERLAY_SAME_PATH_CHANGED. */
    const divergedBase = createBaseSource([
      {...BASE_ARTICLE_1, _rev: 'lake-rev-1c', title: 'Base moved on'},
      BASE_ARTICLE_2,
      BASE_ARTICLE_3_DRAFT,
    ])

    const result = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'drafts',
      now: NOW,
      records: renamedDraft().documents,
      base: divergedBase,
    })

    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(result.conflicts).toEqual(result.entries[0]?.conflicts)
    expect(result.conflicts[0]?.detectedAt).toBe(NOW)
  })

  it('reports one conflict once, however many request slots surface it', () => {
    /* A repeated ID resolves twice and legitimately raises the same conflict
     * twice. A caller that counts conflicts — the §22.8 `conflictsTouched`
     * diagnostic does exactly that — must not see it doubled. */
    const divergedBase = createBaseSource([
      {...BASE_ARTICLE_1, _rev: 'lake-rev-1c', title: 'Base moved on'},
      BASE_ARTICLE_2,
      BASE_ARTICLE_3_DRAFT,
    ])
    const records = renamedDraft().documents

    const once = resolveDocumentBatch({
      ids: ['article-1'],
      perspective: 'drafts',
      now: NOW,
      records,
      base: divergedBase,
    })
    const twice = resolveDocumentBatch({
      ids: ['article-1', 'article-1'],
      perspective: 'drafts',
      now: NOW,
      records,
      base: divergedBase,
    })

    expect(once.conflicts.length).toBeGreaterThan(0)
    expect(twice.conflicts.map((conflict) => conflict.id)).toEqual(
      once.conflicts.map((conflict) => conflict.id),
    )
    /* …while the per-entry view still reports it on both entries. */
    expect(twice.entries[0]?.conflicts).toEqual(twice.entries[1]?.conflicts)
  })
})

/* ------------------------------------------------------------------ *
 * Version batch — the `getDocument` / `getDocuments` read
 * ------------------------------------------------------------------ */

describe('resolveVersionBatch — concrete versions, no perspective fallback', () => {
  it('returns null for a draft the branch never created, exactly as hosted Sanity does', () => {
    const result = resolveVersionBatch({
      ids: ['article-2', 'drafts.article-2'],
      now: NOW,
      records: EMPTY.documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Base title two')
    /* The published document must NOT be handed back as if it were a draft:
     * Studio would render an "unpublished changes" badge for a draft that does
     * not exist. */
    expect(result.entries[1]?.document).toBeNull()
  })

  it('returns the branch draft for a drafts-prefixed ID', () => {
    const result = resolveVersionBatch({
      ids: ['drafts.article-1'],
      now: NOW,
      records: renamedDraft().documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch title one')
    expect(result.entries[0]?.document?._id).toBe('drafts.article-1')
  })

  it('returns the base draft when the branch has not touched it', () => {
    const result = resolveVersionBatch({
      ids: ['drafts.article-3'],
      now: NOW,
      records: EMPTY.documents,
      base,
    })
    expect(result.entries[0]?.document?.title).toBe('Base draft three')
  })

  it('returns null for both versions of a locally deleted document', () => {
    const result = resolveVersionBatch({
      ids: ['article-2', 'drafts.article-2'],
      now: NOW,
      records: deletedArticle2().documents,
      base,
    })

    expect(result.entries.map((entry) => entry.document)).toEqual([null, null])
    expect(result.entries.map((entry) => entry.absence)).toEqual(['tombstone', 'tombstone'])
    expect(result.missing).toEqual(['article-2', 'drafts.article-2'])
  })

  it('returns the branch-created draft and a null published version', () => {
    const result = resolveVersionBatch({
      ids: ['drafts.article-new', 'article-new'],
      now: NOW,
      records: branchCreated().documents,
      base,
    })

    expect(result.entries[0]?.document?.title).toBe('Branch created')
    expect(result.entries[0]?.origin).toBe('branch-created')
    expect(result.entries[1]?.document).toBeNull()
  })

  it('reports one conflict once when both versions of a document are requested', () => {
    const divergedBase = createBaseSource([
      {...BASE_ARTICLE_1, _rev: 'lake-rev-1c', title: 'Base moved on'},
      BASE_ARTICLE_2,
      BASE_ARTICLE_3_DRAFT,
    ])
    const result = resolveVersionBatch({
      ids: ['drafts.article-1', 'drafts.article-1'],
      now: NOW,
      records: renamedDraft().documents,
      base: divergedBase,
    })

    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(new Set(result.conflicts.map((conflict) => conflict.id)).size).toBe(
      result.conflicts.length,
    )
  })

  it('keeps one entry per requested slot so positional reads stay aligned', () => {
    const result = resolveVersionBatch({
      ids: ['article-1', 'drafts.article-1', 'ghost', 'drafts.ghost'],
      now: NOW,
      records: renamedDraft().documents,
      base,
    })

    expect(result.entries.map((entry) => entry.requestedId)).toEqual([
      'article-1',
      'drafts.article-1',
      'ghost',
      'drafts.ghost',
    ])
    expect(result.entries.map((entry) => entry.document === null)).toEqual([
      false,
      false,
      true,
      true,
    ])
  })
})

/* ------------------------------------------------------------------ *
 * Candidate discovery — how a list pane learns a branch document exists
 * ------------------------------------------------------------------ */

describe('overlayDocumentIds', () => {
  it('lists every logical ID the overlay holds, sorted', () => {
    const state = commit(branchCreated(), [
      {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'x'}]},
    ])
    expect(overlayDocumentIds(state.documents)).toEqual(['article-1', 'article-new'])
  })

  it('filters by schema type, so a list pane only widens with its own type', () => {
    const state = commit(branchCreated(), [
      {type: 'create', document: {_id: 'drafts.author-1', _type: 'author', name: 'A'}},
    ])

    expect(overlayDocumentIds(state.documents, {types: ['article']})).toEqual(['article-new'])
    expect(overlayDocumentIds(state.documents, {types: ['author']})).toEqual(['author-1'])
    expect(overlayDocumentIds(state.documents, {types: ['article', 'author']})).toEqual([
      'article-new',
      'author-1',
    ])
  })

  it('omits a fully tombstoned document — it can never widen a result set', () => {
    /* `article-1` is present alongside it, so an implementation that simply
     * returned nothing could not pass this. */
    const state = commit(deletedArticle2(), [
      {type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'x'}]},
    ])
    expect(overlayDocumentIds(state.documents)).toEqual(['article-1'])
  })

  it('keeps a document tombstoned in only one perspective', () => {
    sequence += 1
    const discarded = discardDraft(renamedDraft(), {id: 'article-1'}, {
      transactionId: `tx-dis2-${sequence}`,
      idempotencyKey: `key-dis2-${sequence}`,
      actor: ACTOR,
      now,
      base,
    }).state
    expect(overlayDocumentIds(discarded.documents)).toEqual(['article-1'])
  })

  it('returns an empty list for an empty overlay', () => {
    expect(overlayDocumentIds(EMPTY.documents)).toEqual([])
  })
})
