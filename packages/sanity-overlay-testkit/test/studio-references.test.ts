/**
 * `sanity-overlay-studio` — REFERENCE BEHAVIOUR (PRD §21.2 "reference field
 * selection", §21.6 "Reference target lookup" / "Incoming references", §19.4).
 *
 * HALF OF THIS FILE IS VERIFICATION, NOT NEW BEHAVIOUR — and that half is the
 * point. The overlay read path (`readPlan.ts`, `reads.ts`) was built for GROQ in
 * general, so which of Studio's *reference* paths it already answers exactly is
 * an empirical question, not a design one. Every query string below was read out
 * of the installed `sanity` 6.8.0 bundle, not invented:
 *
 *   reference autocomplete (groq2024)   lib/useBundleDocuments-BYW8M9LS.js:20156-20187
 *   reference autocomplete (groqLegacy) lib/useBundleDocuments-BYW8M9LS.js:20517-20565
 *   useReferringDocuments               lib/useBundleDocuments-BYW8M9LS.js:2854-2858
 *   ConfirmDeleteDialog                 lib/structureTool-EN0gOzyJ.js:817-826
 *   incoming-references pane            lib/structureTool-EN0gOzyJ.js:11896
 *   preview.document-paths              lib/datastores-DqFH7RLd.js:856-912
 *   preview.observe-document            lib/datastores-DqFH7RLd.js:379
 *
 * The other half is the one capability this session ADDS: `*[references($id)]`,
 * which the generic planner refuses because no `BaseCandidateRequest` shape can
 * select "every document that points at X". It CAN be planned — the base dataset
 * answers `references()` natively, and the branch is small enough to enumerate —
 * so the candidate set is (base hits ∪ branch documents that reference the
 * target), and `groq-js` re-evaluates the real predicate over it. That is what
 * makes a branch-created reference visible in "used by" instead of invisible.
 */
import {describe, expect, it, vi} from 'vitest'
import {deriveStudioReadPlan} from '../../sanity-overlay-studio/src/client/readPlan'
import {
  deriveIncomingReferenceTargets,
  incomingReferenceCandidateQuery,
  INCOMING_REFERENCE_TARGETS_PARAM,
} from '../../sanity-overlay-studio/src/client/incomingReferences'
import {createStudioReader} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

/* ─────────────────────────────────────────── the real Studio query shapes */

/** `[0...$__limit]` — a PARAMETERISED slice. groq-js rejects it outright. */
const REFERENCE_SEARCH_GROQ2024 =
  '// findability-mvi:5\n*[_type in $__types] | score(boost(_type in ["author"] && ' +
  'name match text::query($__query), 10), ([@, _id] match text::query($__query) || ' +
  'references($__rawQuery))) [_score > 0] {_type, _id, _originalId, "orderings": [_score]} | ' +
  'order(orderings[0] desc) [0...$__limit]'

const REFERENCE_SEARCH_LEGACY =
  '// findability-mvi:4\n*[_type in $__types && (name match $t0)] ' +
  '{_type, _id, _originalId} | order(_id asc) [0...$__limit]'

const REFERRING_DOCUMENTS = '*[references($docId)][0...101]{_id,_type}'

const CONFIRM_DELETE =
  '{"references":*[references($documentId)][0...100]{_id,_type},' +
  '"totalCount":count(*[references($documentId)])}'

const INCOMING_PANE = '*[references("author-1") && _type == "article"]._id'

const PREVIEW_PATHS =
  '[*[_id in ["author-1","drafts.author-1"]][0...2]{_id,_rev,_type,title}][0...1]'

const OBSERVE_DOCUMENT = '*[_id in $ids]'

const DEREFERENCE = '*[_id == $id][0]{title, author->{name}}'

/* ══════════════════════════ what already works, pinned as measurements ══ */

describe('what the overlay read path already answers for references', () => {
  it('plans the reference PREVIEW paths exactly', () => {
    for (const [query, params] of [
      [PREVIEW_PATHS, {}],
      [OBSERVE_DOCUMENT, {ids: ['author-1']}],
    ] as const) {
      const derived = deriveStudioReadPlan(query, params)
      expect(derived.supported, query).toBe(true)
    }
  })

  it('plans a DEREFERENCE, so a branch-created target resolves through it', () => {
    const derived = deriveStudioReadPlan(DEREFERENCE, {id: 'article-1'})
    expect(derived.supported).toBe(true)
    if (!derived.supported) return
    expect(derived.plan.definition.candidatePlan).toEqual({
      type: 'ids-literal',
      ids: ['article-1'],
    })
    /* The walk that reaches the referenced document is bounded, not unbounded. */
    expect(derived.plan.definition.maxReferenceDepth).toBeGreaterThan(0)
  })

  it('plans the TYPED incoming-references pane through the ordinary type plan', () => {
    const derived = deriveStudioReadPlan(INCOMING_PANE, {})
    expect(derived.supported).toBe(true)
    if (!derived.supported) return
    expect(derived.plan.definition.candidatePlan).toEqual({type: 'types', types: ['article']})
  })
})

describe('what the overlay read path does NOT answer, and exactly why', () => {
  /**
   * GAP CLOSED. `[0...$__limit]` is not GROQ that `groq-js@2.0.0` accepts —
   * "slicing must use constant numbers" — so reference SEARCH used to die at
   * PARSE under either strategy and never reached the planner at all. A
   * branch-created document therefore never appeared in a reference
   * autocomplete.
   *
   * `findability.ts` now substitutes integer parameters into slice endpoints,
   * but ONLY after the pinned parser has already refused the source, so a query
   * groq-js accepts is never rewritten.
   */
  it('now plans an UNFILTERED reference autocomplete, under both strategies', () => {
    for (const query of [REFERENCE_SEARCH_GROQ2024, REFERENCE_SEARCH_LEGACY]) {
      const derived = deriveStudioReadPlan(query, {
        __types: ['author'],
        __limit: 102,
        __query: '*',
      })
      expect(derived.supported, query).toBe(true)
      if (!derived.supported) continue
      expect(derived.plan.definition.candidatePlan).toEqual({type: 'types', types: ['author']})
    }
  })

  /**
   * The legacy strategy carries no `text::query` at all — only the slice stood
   * between it and a plan — so it needs no search term to be answerable.
   */
  it('plans the legacy strategy with no search term at all', () => {
    const derived = deriveStudioReadPlan(REFERENCE_SEARCH_LEGACY, {
      __types: ['author'],
      __limit: 102,
    })
    expect(derived.supported).toBe(true)
  })

  /** What is still refused, and now for the HONEST reason rather than at parse. */
  it('refuses a search term it cannot know before evaluation, by name', () => {
    const derived = deriveStudioReadPlan(REFERENCE_SEARCH_GROQ2024, {
      __types: ['author'],
      __limit: 102,
    })
    expect(derived.supported).toBe(false)
    if (derived.supported) return
    expect(derived.reason).toMatch(/text::query/)
    expect(derived.reason).not.toMatch(/slicing/i)
  })

  it('refuses text::query even with the slice removed, because no index exists locally', () => {
    const derived = deriveStudioReadPlan(
      '*[_type in $__types && name match text::query($__query)][0...100]',
      {__types: ['author'], __query: 'a*'},
    )
    expect(derived.supported).toBe(false)
    if (derived.supported) return
    expect(derived.reason).toMatch(/text::/)
  })

  it('refuses a bare references($id) through the GENERIC planner', () => {
    /* Which is why `incomingReferences.ts` exists — see below. */
    for (const [query, params] of [
      [REFERRING_DOCUMENTS, {docId: 'author-1'}],
      [CONFIRM_DELETE, {documentId: 'author-1'}],
    ] as const) {
      const derived = deriveStudioReadPlan(query, params)
      expect(derived.supported, query).toBe(false)
    }
  })
})

/* ══════════════════════════════ the added capability: incoming references */

describe('deriveIncomingReferenceTargets', () => {
  it('recognises the two shapes Studio actually issues', () => {
    expect(deriveIncomingReferenceTargets(REFERRING_DOCUMENTS, {docId: 'author-1'})).toEqual({
      supported: true,
      targetIds: ['author-1'],
    })
    expect(deriveIncomingReferenceTargets(CONFIRM_DELETE, {documentId: 'author-1'})).toEqual({
      supported: true,
      targetIds: ['author-1'],
    })
  })

  it('accepts a literal target as well as a parameter', () => {
    expect(deriveIncomingReferenceTargets('*[references("author-1")]', {})).toEqual({
      supported: true,
      targetIds: ['author-1'],
    })
  })

  it('normalises a draft address to the logical document', () => {
    expect(
      deriveIncomingReferenceTargets('*[references($id)]', {id: 'drafts.author-1'}),
    ).toEqual({supported: true, targetIds: ['author-1']})
  })

  it('does not claim a query that only SOMETIMES filters by references', () => {
    /* One filter with `references()` and one without: the second has no bounded
     * candidate set, so answering the first exactly and the second from a
     * reference-shaped pool would be a silent subset. */
    expect(
      deriveIncomingReferenceTargets('{"a": *[references($id)], "b": *[defined(title)]}', {
        id: 'author-1',
      }).supported,
    ).toBe(false)
  })

  it('declines a query the ordinary planner already handles', () => {
    /* The typed pane has a `_type` constraint, so the generic `types` plan is
     * both available and tighter. Two plans for one query is one too many. */
    expect(deriveIncomingReferenceTargets(INCOMING_PANE, {}).supported).toBe(false)
  })

  it('declines when the target cannot be resolved before the base fetch', () => {
    expect(deriveIncomingReferenceTargets('*[references(^._id)]', {}).supported).toBe(false)
    expect(deriveIncomingReferenceTargets('*[references($id)]', {}).supported).toBe(false)
  })

  it('declines anything that also calls a function with no local answer', () => {
    expect(
      deriveIncomingReferenceTargets('*[references($id) && title match text::query($q)]', {
        id: 'a',
        q: 'x',
      }).supported,
    ).toBe(false)
  })

  it('builds a bounded base query that binds the target as a parameter', () => {
    const built = incomingReferenceCandidateQuery(['author-1', 'author-2'], 500)
    expect(built.query).toBe(`*[references($${INCOMING_REFERENCE_TARGETS_PARAM})][0...501]{_id}`)
    expect(built.params).toEqual({[INCOMING_REFERENCE_TARGETS_PARAM]: ['author-1', 'author-2']})
  })
})

/* ─────────────────────────────────────────── end to end through the reader */

const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-new',
    schemaType: 'article',
    /* Branch-CREATED, and it points at the target. Staging has never seen it, so
     * `references($id)` against staging cannot possibly return it. */
    draft: {
      _id: 'drafts.article-new',
      _type: 'article',
      title: 'Branch-created article',
      author: {_type: 'reference', _ref: 'author-1'},
    },
  },
  {
    logicalId: 'article-dropped',
    schemaType: 'article',
    /* Staging says this one references the target. The branch removed the
     * reference, so it must NOT appear in the answer. */
    draft: {_id: 'drafts.article-dropped', _type: 'article', title: 'No longer linked'},
  },
  {
    logicalId: 'article-gone',
    schemaType: 'article',
    draftTombstone: true,
    publishedTombstone: true,
  },
]

/** Staging's own answer: two documents reference `author-1`, one is tombstoned. */
const STAGING_HITS = [
  {_id: 'drafts.article-dropped', _type: 'article', author: {_type: 'reference', _ref: 'author-1'}},
  {_id: 'article-gone', _type: 'article', author: {_type: 'reference', _ref: 'author-1'}},
  {_id: 'article-kept', _type: 'article', author: {_type: 'reference', _ref: 'author-1'}},
]

function readerRig(branch: OverlayHydrationDocument[] = BRANCH) {
  const records: {query: string; outcome: string; reason?: string}[] = []
  const baseQueries: {query: string; params: Record<string, unknown>}[] = []
  const overlay = overlaySourceFromBranch(branch)

  const baseFetch = vi.fn(async (query: string, params: Record<string, unknown>) => {
    baseQueries.push({query, params})
    if (query.includes('references(')) return STAGING_HITS.map((doc) => ({_id: doc._id}))
    /* The candidate re-fetch by id. */
    const wanted = new Set(
      (params.__overlayIds as string[] | undefined) ?? (params.ids as string[] | undefined) ?? [],
    )
    return STAGING_HITS.filter((doc) => wanted.has(doc._id))
  })

  const read = createStudioReader({
    overlay: () => overlay,
    onRecord: (record) => records.push(record as never),
  })

  return {read, records, baseQueries, baseFetch}
}

describe('incoming references, answered over the branch', () => {
  it('includes a branch-created referring document staging has never seen', async () => {
    const {read, baseFetch} = readerRig()
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    const ids = (answer.result as {_id: string}[]).map((row) => row._id)
    expect(ids).toContain('drafts.article-new')
  })

  it('drops a staging hit whose branch copy no longer holds the reference', async () => {
    const {read, baseFetch} = readerRig()
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    const ids = (answer.result as {_id: string}[]).map((row) => row._id)
    expect(ids).not.toContain('drafts.article-dropped')
  })

  it('drops a staging hit the branch tombstoned', async () => {
    const {read, baseFetch} = readerRig()
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    const ids = (answer.result as {_id: string}[]).map((row) => row._id)
    expect(ids).not.toContain('article-gone')
  })

  it('keeps a staging hit the branch never touched', async () => {
    const {read, baseFetch} = readerRig()
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    const ids = (answer.result as {_id: string}[]).map((row) => row._id)
    expect(ids).toContain('article-kept')
  })

  it('asks staging for the reference hits with a bounded query', async () => {
    const {read, baseQueries, baseFetch} = readerRig()
    await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    const referenceFetch = baseQueries.find((entry) => entry.query.includes('references('))
    expect(referenceFetch).toBeDefined()
    expect(referenceFetch!.query).toMatch(/\[0\.\.\.\d+\]/)
    /* The target travels as a bound parameter — never interpolated into GROQ. */
    expect(referenceFetch!.params).toEqual({
      [INCOMING_REFERENCE_TARGETS_PARAM]: ['author-1'],
    })
  })

  it('records the read as answered by the overlay, not as a passthrough', async () => {
    const {read, records, baseFetch} = readerRig()
    await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(records.at(-1)?.outcome).toBe('overlay')
  })

  it('answers the ConfirmDelete envelope, count included', async () => {
    const {read, baseFetch} = readerRig()
    const answer = await read({query: CONFIRM_DELETE, params: {documentId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    const result = answer.result as {references: {_id: string}[]; totalCount: number}
    expect(result.totalCount).toBe(result.references.length)
    expect(result.references.map((row) => row._id)).toContain('drafts.article-new')
  })

  it('degrades rather than truncating when staging returns more hits than the ceiling', async () => {
    const {records} = readerRig()
    const flood = Array.from({length: 5000}, (_unused, index) => ({_id: `doc-${index}`}))
    const baseFetch = vi.fn(async () => flood)
    const read = createStudioReader({
      overlay: () => overlaySourceFromBranch(BRANCH),
      onRecord: (record) => records.push(record as never),
    })
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(false)
    if (answer.answered) return
    expect(answer.reason).toMatch(/too many|ceiling|bound|limit/i)
  })

  it('degrades when the base reference query itself fails', async () => {
    const baseFetch = vi.fn(async () => {
      throw new Error('staging is unreachable')
    })
    const read = createStudioReader({overlay: () => overlaySourceFromBranch(BRANCH)})
    const answer = await read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch})
    expect(answer.answered).toBe(false)
  })

  it('refuses in strict mode rather than passing an unanswerable one through', async () => {
    const baseFetch = vi.fn(async () => {
      throw new Error('staging is unreachable')
    })
    const read = createStudioReader({
      overlay: () => overlaySourceFromBranch(BRANCH),
      strict: () => true,
    })
    await expect(
      read({query: REFERRING_DOCUMENTS, params: {docId: 'author-1'}, baseFetch}),
    ).rejects.toThrow(/refusing/i)
  })
})
