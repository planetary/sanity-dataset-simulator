/**
 * SPIKE A — which GROQ the read facade answers **exactly**, and what it does with
 * the rest (PRD §22.3 Tier A, §22.5, §5.5; roadmap §5.3 `[M-LOCAL]`).
 *
 * WHAT CHANGED, AND WHY
 * ─────────────────────
 * This module used to hold a second, private implementation of the decision
 * `sanity-overlay-query` already owns: a lexical shape recogniser, its own plan
 * type, and its own mini-evaluator (`applyReadPlan`) that filtered and sliced a
 * candidate set by hand. Two implementations of "which documents can this query
 * observe, and what is the answer" is the defect, not a convenience — the ad-hoc
 * one could not evaluate a projection, so every Studio list pane fell through to
 * staging and rendered pre-branch content.
 *
 * What is left is the one decision the query package genuinely does not make:
 * turning **query text Studio wrote** into a `CandidatePlan`. The package's
 * registry is by design a static, pre-registered, checksummed table; Studio
 * composes its queries at runtime. So `deriveReadQuery` walks the `groq-js`
 * parse tree, derives a candidate plan when — and only when — the candidate set
 * is provably complete, and hands the whole rest of the job (planning the base
 * requests, admitting branch records, suppressing tombstones, expanding
 * references, enforcing `maxCandidates`, evaluating) to the package.
 *
 * THE POLICY THIS FILE STILL PINS, UNCHANGED
 * PRD §5.5 forbids *silent* approximation and §22.2 forbids patching an already
 * filtered or sliced result. §22.5 names the way out: "[MUST] Log unregistered
 * queries", "[MUST] Reject unregistered queries in strict preview mode",
 * "[SHOULD] Allow a local development warning mode during migration". So an
 * underivable query is `supported: false` **with a reason a human can read**,
 * and the caller passes it through and records it — or, in strict mode, refuses.
 */
import {describe, expect, it} from 'vitest'
import {
  SPIKE_A_MAX_REFERENCE_DEPTH,
  createCandidateSource,
  deriveReadQuery,
  evaluateReadQuery,
} from '../../../examples/kitchen-sink/spikeA/readQueries'
import type {OverlaySource} from '../../../packages/sanity-overlay-query/src/overlaySource'
import type {QueryDocument} from '../../../packages/sanity-overlay-query/src/types'

function derived(query: string, params?: Record<string, unknown>) {
  const derivation = deriveReadQuery(query, params)
  if (!derivation.supported) {
    throw new Error(`expected ${JSON.stringify(query)} to be supported: ${derivation.reason}`)
  }
  return derivation.plan
}

function reason(query: unknown, params?: Record<string, unknown>): string {
  const derivation = deriveReadQuery(query, params)
  if (derivation.supported) {
    throw new Error(`expected ${JSON.stringify(query)} to be unsupported`)
  }
  return derivation.reason
}

/* ================================================================== *
 * 1. Candidate plans — the one decision this module still makes
 * ================================================================== */

describe('deriveReadQuery — ID constraints become the package’s ID plans', () => {
  it('derives an ids plan from a parameterised single-document lookup', () => {
    const plan = derived('*[_id == $id][0]', {id: 'article-1'})
    expect(plan.definition.candidatePlan).toEqual({type: 'ids-literal', ids: ['article-1']})
    expect(plan.baseRequests).toEqual([{kind: 'ids', ids: ['article-1']}])
  })

  it('derives an ids plan from a literal lookup, both quote styles', () => {
    expect(derived('*[_id == "article-1"][0]').baseRequests).toEqual([
      {kind: 'ids', ids: ['article-1']},
    ])
    expect(derived("*[_id == 'article-1'][0]").baseRequests).toEqual([
      {kind: 'ids', ids: ['article-1']},
    ])
  })

  it('resolves an array-valued `in` parameter into literal candidate IDs', () => {
    /* `CandidatePlan.ids` takes one parameter NAME per ID, so `_id in $ids`
     * cannot be expressed as a template. Resolving it per call is what makes the
     * pair-shaped query answerable at all — see the reported gap at the foot of
     * this file. */
    const plan = derived('*[_id in $ids]', {ids: ['a', 'drafts.a']})
    expect(plan.definition.candidatePlan).toEqual({type: 'ids-literal', ids: ['a', 'drafts.a']})
  })

  it('keeps a drafts-prefixed ID verbatim — _id matching is raw', () => {
    expect(derived('*[_id == $id][0]', {id: 'drafts.article-1'}).baseRequests).toEqual([
      {kind: 'ids', ids: ['drafts.article-1']},
    ])
  })

  it('tolerates the whitespace Studio and defineQuery actually emit', () => {
    expect(derived('\n  *[ _id  ==  $id ] [0]\n', {id: 'article-1'}).baseRequests).toEqual([
      {kind: 'ids', ids: ['article-1']},
    ])
  })

  it('refuses when the parameter is missing or not a string', () => {
    expect(reason('*[_id == $id][0]', {})).toContain('$id')
    expect(reason('*[_id == $id][0]', {id: 42})).toContain('$id')
    expect(reason('*[_id in $ids]', {ids: ['a', 7]})).toContain('$ids')
  })
})

describe('deriveReadQuery — the Studio list-pane shapes', () => {
  /* Observed on a live Studio session, 2026-08-04: the Article list pane does
   * NOT issue `*[_type == "article"]{…}`. It issues a literal ID set with a
   * projection, a slice, and an outer array wrapper. */
  const LIST_PANE =
    '[*[_id in ["article-01","article-02","article-03"]][0...23]' +
    '{_id,_rev,_type,title,_createdAt,_updatedAt}][0...1]'

  it('derives a literal ID plan through a projection, a slice and an array wrapper', () => {
    const plan = derived(LIST_PANE)
    expect(plan.definition.candidatePlan).toEqual({
      type: 'ids-literal',
      ids: ['article-01', 'article-02', 'article-03'],
    })
    expect(plan.baseRequests).toEqual([
      {kind: 'ids', ids: ['article-01', 'article-02', 'article-03']},
    ])
  })

  it('derives the drafts-folded variant the same way', () => {
    const plan = derived(
      '[*[_id in ["article-01","drafts.article-02"]][0...25]{_id,_rev,_type,_system}][0...1]',
    )
    expect(plan.definition.candidatePlan).toEqual({
      type: 'ids-literal',
      ids: ['article-01', 'drafts.article-02'],
    })
  })

  it('unions the ID sets of several `*` filters in one query', () => {
    const plan = derived('[*[_id == "a"]{_id}, *[_id in ["b","c"]]{_id}]')
    expect(plan.definition.candidatePlan).toEqual({type: 'ids-literal', ids: ['a', 'b', 'c']})
  })
})

describe('deriveReadQuery — type-list and slug plans', () => {
  it('derives a types plan from a single `_type ==` constraint', () => {
    const plan = derived('*[_type == "article"]{_id, title}')
    expect(plan.definition.candidatePlan).toEqual({type: 'types', types: ['article']})
    expect(plan.baseRequests).toEqual([{kind: 'types', types: ['article']}])
  })

  it('derives a types plan from a `_type in [...]` constraint', () => {
    const plan = derived('*[_type in ["article", "page"]]{_id}')
    expect(plan.definition.candidatePlan).toEqual({type: 'types', types: ['article', 'page']})
  })

  it('keeps extra narrowing conjuncts out of the plan — they can only shrink the answer', () => {
    const plan = derived('*[_type == "article" && defined(title)]{_id}')
    expect(plan.definition.candidatePlan).toEqual({type: 'types', types: ['article']})
  })

  it('derives the package’s slug plan, lifting the value into a plan parameter', () => {
    const plan = derived('*[_type == "article" && slug.current == $slug][0]{title}', {
      slug: 'hello',
    })
    expect(plan.definition.candidatePlan).toMatchObject({
      type: 'slug',
      types: ['article'],
      path: ['slug', 'current'],
    })
    expect(plan.baseRequests).toEqual([
      {kind: 'field-equality', types: ['article'], path: ['slug', 'current'], value: 'hello'},
    ])
  })

  it('derives the slug plan with the conjuncts in either order, and from a literal', () => {
    expect(
      derived('*[slug.current == "hello" && _type == "article"][0]').baseRequests,
    ).toEqual([
      {kind: 'field-equality', types: ['article'], path: ['slug', 'current'], value: 'hello'},
    ])
  })

  it('refuses a slug lookup with no `_type` constraint — no base request can select it', () => {
    expect(reason('*[slug.current == $slug][0]', {slug: 'hello'})).toMatch(/_type/)
  })
})

/* ================================================================== *
 * 2. Refusals — the half that keeps §5.5 true
 * ================================================================== */

describe('deriveReadQuery — refuses everything it cannot prove complete', () => {
  const CASES: ReadonlyArray<{
    label: string
    query: string
    params?: Record<string, unknown>
    mentions: RegExp
  }> = [
    {
      label: 'the global preview listener’s unconstrained star',
      query: '*',
      mentions: /unconstrained/i,
    },
    {label: 'an unfiltered `*[]`', query: '*[]{_id}', mentions: /unconstrained/i},
    {
      label: 'a predicate naming no bounded attribute',
      query: '*[defined(slug.current)]',
      mentions: /candidate/i,
    },
    {
      label: 'a reference-membership scan',
      query: '*[references($id)]',
      params: {id: 'a'},
      mentions: /candidate/i,
    },
    {
      label: 'Studio’s search query — text::query needs a hosted search index',
      query:
        '*[_type in $__types && ([@, _id] match text::query($__query)) && (_type == $type)]{_id}',
      params: {__types: ['article'], __query: 'x', type: 'article'},
      mentions: /text::query/,
    },
    {
      label: 'the hosted releases system query — path() selects a system namespace',
      query: '*[_type == "system.release" && _id in path("_.releases.*")]{_id}',
      mentions: /path\(\)|system/,
    },
    {
      label: 'sanity::versionOf — the release-version namespace is not enumerable',
      query: '[*[sanity::versionOf("article-01")]._id]',
      mentions: /sanity::versionOf/,
    },
    {label: 'GROQ that does not parse', query: '*[_id ==', mentions: /parse/i},
  ]

  for (const testCase of CASES) {
    it(`refuses ${testCase.label}`, () => {
      expect(reason(testCase.query, testCase.params)).toMatch(testCase.mentions)
    })
  }

  it('refuses a non-string query outright', () => {
    expect(reason(undefined)).toMatch(/GROQ/)
    expect(reason(42)).toMatch(/GROQ/)
  })

  it('refuses a query that mixes an ID plan and a type plan — no single plan spans both', () => {
    expect(reason('[*[_id == "a"]{_id}, *[_type == "page"]{_id}]')).toMatch(/one candidate plan/)
  })

  it('never returns a plan without a reason, or a reason without a refusal', () => {
    for (const query of ['*[_id == $id][0]', '*']) {
      const derivation = deriveReadQuery(query, {id: 'a'})
      if (derivation.supported) expect(derivation.plan.definition.queryChecksum).toHaveLength(64)
      else expect(derivation.reason.length).toBeGreaterThan(0)
    }
  })
})

/* ================================================================== *
 * 3. The registration the package validates
 * ================================================================== */

describe('deriveReadQuery — the ephemeral registration is a real one', () => {
  it('pins the query text with the package’s own checksum', () => {
    const plan = derived('*[_type == "article"]{_id}')
    expect(plan.definition.query).toBe('*[_type == "article"]{_id}')
    /* `defineOverlayQuery` throws QUERY_CHANGED unless this matches, so the fact
     * that we got a plan at all is the proof; assert the shape too. */
    expect(plan.definition.queryChecksum).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.definition.status).toBe('tier-a')
  })

  it('bounds a lookup far below a type scan, and says so in maxCandidates', () => {
    const lookup = derived('*[_id == $id][0]', {id: 'a'})
    const list = derived('*[_type == "article"]{_id}')
    expect(lookup.definition.maxCandidates).toBeLessThan(list.definition.maxCandidates)
    expect(lookup.definition.maxReferenceDepth).toBe(SPIKE_A_MAX_REFERENCE_DEPTH)
  })
})

/* ================================================================== *
 * 4. Candidate order — the package’s documented caveat, answered
 * ================================================================== */

const BASE_A: QueryDocument = {_id: 'article-b', _type: 'article', title: 'BASE B'}
const BASE_C: QueryDocument = {_id: 'article-d', _type: 'article', title: 'BASE D'}

function overlayOf(
  documents: Record<string, QueryDocument>,
  tombstones: string[] = [],
): OverlaySource {
  return {documents: new Map(Object.entries(documents)), tombstones: new Set(tombstones)}
}

describe('createCandidateSource — a total order, not base-then-branch', () => {
  it('interleaves branch-created documents into `_id` order', async () => {
    /* `evaluate.ts` documents that candidates arrive base-fetch → branch-created
     * → reference-expanded, so an unordered type list would answer with every
     * branch-created document appended at the end. That is candidate order
     * leaking into a result; this pins the total order instead. */
    const source = createCandidateSource({
      baseDocuments: [BASE_C, BASE_A],
      overlay: overlayOf({
        'article-a': {_id: 'article-a', _type: 'article', title: 'BRANCH A'},
        'article-c': {_id: 'article-c', _type: 'article', title: 'BRANCH C'},
      }),
    })

    const candidates = await source.fetchCandidates({kind: 'types', types: ['article']})
    expect(candidates.map((doc) => doc._id)).toEqual([
      'article-a',
      'article-b',
      'article-c',
      'article-d',
    ])
  })

  it('lets the branch record win over the base row at the same ID', async () => {
    const source = createCandidateSource({
      baseDocuments: [BASE_A],
      overlay: overlayOf({'article-b': {...BASE_A, title: 'BRANCH B'}}),
    })
    const candidates = await source.fetchCandidates({kind: 'ids', ids: ['article-b']})
    expect(candidates.map((doc) => doc.title)).toEqual(['BRANCH B'])
  })

  it('does NOT suppress tombstones itself — that stays the package’s step 7', async () => {
    /* Two implementations of tombstone suppression would make the mutation check
     * for it un-falsifiable. The source hands the base row over and
     * `resolveVirtualDocument` drops it. */
    const source = createCandidateSource({
      baseDocuments: [BASE_A],
      overlay: overlayOf({}, ['article-b']),
    })
    const candidates = await source.fetchCandidates({kind: 'ids', ids: ['article-b']})
    expect(candidates.map((doc) => doc._id)).toEqual(['article-b'])
  })
})

/* ================================================================== *
 * 5. End to end through the package's evaluator
 * ================================================================== */

describe('evaluateReadQuery — the package answers, over a resolved candidate set', () => {
  const query = '*[_type == "article"]{_id, title}'

  async function run(overlay: OverlaySource, baseDocuments: QueryDocument[] = [BASE_A, BASE_C]) {
    const plan = derived(query)
    return evaluateReadQuery({plan, params: {}, baseDocuments, overlay})
  }

  it('renders the BRANCH title for a document the branch renamed', async () => {
    const {result} = await run(
      overlayOf({'article-b': {...BASE_A, title: 'BRANCH TITLE'}}),
    )
    expect(result).toEqual([
      {_id: 'article-b', title: 'BRANCH TITLE'},
      {_id: 'article-d', title: 'BASE D'},
    ])
  })

  it('includes a branch-created document, in `_id` order rather than appended', async () => {
    const {result} = await run(
      overlayOf({'article-a': {_id: 'article-a', _type: 'article', title: 'BRANCH CREATED'}}),
    )
    expect(result).toEqual([
      {_id: 'article-a', title: 'BRANCH CREATED'},
      {_id: 'article-b', title: 'BASE B'},
      {_id: 'article-d', title: 'BASE D'},
    ])
  })

  it('drops a tombstoned document from the list', async () => {
    const {result} = await run(overlayOf({}, ['article-b']))
    expect(result).toEqual([{_id: 'article-d', title: 'BASE D'}])
  })

  it('evaluates the projection, slice and array wrapper of the real list-pane shape', async () => {
    const plan = derived(
      '[*[_id in ["article-b","article-d"]][0...23]{_id,title}][0...1]',
    )
    const {result} = await evaluateReadQuery({
      plan,
      params: {},
      baseDocuments: [BASE_A, BASE_C],
      overlay: overlayOf({'article-b': {...BASE_A, title: 'BRANCH B'}}),
    })
    expect(result).toEqual([
      [
        {_id: 'article-b', title: 'BRANCH B'},
        {_id: 'article-d', title: 'BASE D'},
      ],
    ])
  })

  it('reports the package’s own diagnostics, including the candidate IDs', async () => {
    const {diagnostics} = await run(
      overlayOf({'article-a': {_id: 'article-a', _type: 'article', title: 'X'}}),
    )
    expect(diagnostics.candidateIds).toEqual(['article-a', 'article-b', 'article-d'])
    expect(diagnostics.evaluatorInvocations).toBe(1)
    expect(diagnostics.exact).toBe(true)
  })

  it('raises the package’s boundedness error rather than answering over-budget', async () => {
    const plan = derived('*[_type == "article"]{_id}')
    const many = Array.from({length: 40}, (_, index) => ({
      _id: `article-${String(index).padStart(3, '0')}`,
      _type: 'article',
    }))
    const shrunk = {...plan, definition: {...plan.definition, maxCandidates: 8}}
    await expect(
      evaluateReadQuery({plan: shrunk, params: {}, baseDocuments: many, overlay: overlayOf({})}),
    ).rejects.toThrow(/maxCandidates/)
  })
})

/* ================================================================== *
 * 6. A capability `sanity-overlay-query` is missing — reported, not patched
 * ================================================================== */

describe('REPORTED GAP — sanity-overlay-query cannot express IDs from an array parameter', () => {
  it.fails('planCandidateRequests should accept an array-valued ID parameter', async () => {
    /* `CandidatePlan.ids` is `{idsFromParams: string[]}` and `planner.ts:37`
     * rejects any parameter that is not a non-empty *string*, so the extremely
     * common `*[_id in $ids]` has no template plan: the ID set can only be
     * baked in per call, which is why `deriveReadQuery` resolves it to
     * `ids-literal` and why a spikeA plan cannot be cached by query text alone.
     *
     * Marked `.fails` deliberately: this is a report against a package this
     * spike does not own (it must not be edited from here), and it flips red the
     * day the capability lands — which is exactly when this workaround should go.
     */
    const {planCandidateRequests} = await import(
      '../../../packages/sanity-overlay-query/src/planner'
    )
    const requests = planCandidateRequests(
      {
        id: 'array-param',
        candidatePlan: {type: 'ids', idsFromParams: ['ids']},
      } as never,
      {ids: ['a', 'b']},
    )
    expect(requests.baseRequests).toEqual([{kind: 'ids', ids: ['a', 'b']}])
  })
})
