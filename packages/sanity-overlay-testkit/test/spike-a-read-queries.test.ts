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

/* ================================================================== *
 * 1b. `sanity::versionOf` — the draft/published version set
 * ================================================================== *
 *
 * WHY THIS IS THE ONE THAT MATTERS. Traced on a live Studio session
 * (2026-08-04): the Article list pane does not ask for drafts by ID. It first
 * asks *which logical documents have a version at all*, with the probe below,
 * and only then fetches the IDs it was told about. While that probe fell
 * through to staging, staging answered "no draft for article-01" — because the
 * draft only exists in the branch — so the pane never asked for the branch
 * draft and rendered the published title. Everything downstream already worked.
 *
 * WHY THE CANDIDATE SET IS PROVABLE. `groq-js@2.0.0` matches
 * `sanity::versionOf(X)` against exactly three ID shapes: `X`, `drafts.X`, and
 * `versions.<release>.X`. The first two are a two-element ID set that a `{kind:
 * 'ids'}` base request selects in full, and that the overlay knows
 * authoritatively — including a branch-created draft staging has never seen,
 * and including tombstones. The third is the release-version namespace, which
 * the PRD degrades in overlay mode (§32; Releases is disabled), so it is
 * excluded as a product boundary — and any query that actually names that
 * namespace is refused outright rather than answered partially. See the
 * boundary section below.
 */

/** The exact draft-discovery probe a live Studio Article list pane issues. */
const VERSION_PROBE =
  '[*[sanity::versionOf("article-01")]._id, *[sanity::versionOf("article-02")]._id]'

describe('deriveReadQuery — sanity::versionOf plans the draft/published version set', () => {
  it('plans both addresses of the logical ID, and nothing else', () => {
    const plan = derived('*[sanity::versionOf("article-01")]._id')
    expect(plan.definition.candidatePlan).toEqual({
      type: 'ids-literal',
      ids: ['article-01', 'drafts.article-01'],
    })
    expect(plan.baseRequests).toEqual([
      {kind: 'ids', ids: ['article-01', 'drafts.article-01']},
    ])
  })

  it('plans the multi-document probe as one union of version sets', () => {
    expect(derived(VERSION_PROBE).baseRequests).toEqual([
      {
        kind: 'ids',
        ids: ['article-01', 'drafts.article-01', 'article-02', 'drafts.article-02'],
      },
    ])
  })

  it('resolves the logical ID from a parameter', () => {
    expect(derived('*[sanity::versionOf($id)]._id', {id: 'article-01'}).baseRequests).toEqual([
      {kind: 'ids', ids: ['article-01', 'drafts.article-01']},
    ])
  })

  it('unions a version set with a plain `_id` set in the same query', () => {
    expect(
      derived('[*[sanity::versionOf("a")]._id, *[_id == "b"]{_id}]').definition.candidatePlan,
    ).toEqual({type: 'ids-literal', ids: ['a', 'drafts.a', 'b']})
  })

  it('refuses when the argument is not a resolvable document ID', () => {
    expect(reason('*[sanity::versionOf($id)]._id', {})).toMatch(/\$id/)
    expect(reason('*[sanity::versionOf($id)]._id', {id: 42})).toMatch(/sanity::versionOf/)
    expect(reason('*[sanity::versionOf(_id)]._id')).toMatch(/sanity::versionOf/)
  })

  it('refuses a versionOf the planner never reads — a disjunct', () => {
    /* `constraintOf` only reads top-level conjuncts, so a versionOf under `||`
     * contributes nothing to the plan. Planning the OTHER branch alone would
     * answer a strict subset of the hosted result without saying so. */
    expect(reason('*[sanity::versionOf("a") || sanity::versionOf("b")]._id')).toMatch(
      /sanity::versionOf/,
    )
  })

  it('refuses a versionOf whose argument is a sibling row, not a plannable value', () => {
    expect(reason('*[_type == "article"]{ "v": *[sanity::versionOf(^._id)]._id }')).toMatch(
      /sanity::versionOf/,
    )
  })
})

describe('deriveReadQuery — the release-version namespace is refused, never half-answered', () => {
  /* The boundary, stated once: the draft/published version set is provable, the
   * release-version set is not (its members need an ID-pattern request no base
   * shape expresses). PRD §32 degrades Releases in overlay mode, so excluding
   * them is a documented product boundary — but a query that ACTUALLY names the
   * namespace would be answered with a silent subset, and §5.5 forbids that. */
  const CASES: ReadonlyArray<{
    label: string
    query: string
    params?: Record<string, unknown>
    mentions: RegExp
  }> = [
    {
      label: 'sanity::partOfRelease, which selects the release namespace outright',
      query: '*[sanity::partOfRelease("summer")]._id',
      mentions: /partOfRelease|release/,
    },
    {
      label: 'releases::all(), which enumerates every release document',
      query: 'releases::all(){_id}',
      mentions: /releases::/,
    },
    {
      label: 'a versionOf whose logical ID is itself a release version',
      query: '*[sanity::versionOf("versions.summer.article-01")]._id',
      mentions: /release-version/,
    },
    {
      label: 'a versionOf beside an ID-pattern match on the versions namespace',
      query: '*[sanity::versionOf("article-01") && _id match "versions.*"]._id',
      mentions: /release-version/,
    },
    {
      label: 'a literal `_id` inside the versions namespace',
      query: '*[_id == "versions.summer.article-01"][0]',
      mentions: /release-version/,
    },
    {
      label: 'a versions-namespace ID arriving through a parameter',
      query: '*[_id in $ids]',
      params: {ids: ['article-01', 'versions.summer.article-01']},
      mentions: /release-version/,
    },
  ]

  for (const testCase of CASES) {
    it(`refuses ${testCase.label}`, () => {
      expect(reason(testCase.query, testCase.params)).toMatch(testCase.mentions)
    })
  }

  it('records the boundary on the registration, so the caller is told what it is trusting', () => {
    /* "Excluded as a product boundary" is only honest if it is legible where the
     * plan is. The note travels with the ephemeral registration, so `/query/plan`
     * can hand it to the party that is about to believe the answer. */
    const versionSet = derived('*[sanity::versionOf("article-01")]._id')
    expect(versionSet.definition.notes).toMatch(/versions\.<release>\.<id>/)
    expect(versionSet.definition.notes).toMatch(/§32/)
  })

  it('does not stamp the release note on a plan that claims nothing about versions', () => {
    /* A note on every plan is a note nobody reads. Only a query that actually
     * resolved a version set makes the release claim. */
    expect(derived('*[_id == $id][0]', {id: 'article-01'}).definition.notes).toBeUndefined()
    expect(derived('*[_type == "article"]{_id}').definition.notes).toBeUndefined()
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
      label: 'a hosted sanity:: function with no local candidate plan',
      query: '*[sanity::partOfRelease($release)]._id',
      params: {release: 'summer'},
      mentions: /release/,
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
 * 5b. versionOf end to end — the list pane, answered from the BRANCH
 * ================================================================== *
 *
 * These are the load-bearing ones. Each fails if the version set is answered
 * from staging alone, which is precisely what the live pane was doing.
 */

const PUBLISHED_01: QueryDocument = {_id: 'article-01', _type: 'article', title: 'Article 1'}
const STAGING_DRAFT_01: QueryDocument = {
  _id: 'drafts.article-01',
  _type: 'article',
  title: 'Article 1',
}

describe('evaluateReadQuery — versionOf answers with BRANCH state, not staging', () => {
  async function probe(
    overlay: OverlaySource,
    baseDocuments: QueryDocument[],
    logicalId = 'article-01',
  ): Promise<string[]> {
    const plan = derived(`*[sanity::versionOf("${logicalId}")]._id`)
    const {result} = await evaluateReadQuery({plan, params: {}, baseDocuments, overlay})
    return result as string[]
  }

  it('includes a branch draft staging has never seen', async () => {
    /* THE defect, in one assertion. Staging holds only the published document;
     * the branch holds the edit. Before this, the probe answered
     * `["article-01"]`, Studio concluded there was no draft, and the pane
     * rendered the published title. */
    const ids = await probe(
      overlayOf({
        'drafts.article-01': {
          _id: 'drafts.article-01',
          _type: 'article',
          title: 'Article 1 — OVERLAY EDIT ✅ 日本語',
        },
      }),
      [PUBLISHED_01],
    )
    expect(ids).toEqual(['article-01', 'drafts.article-01'])
  })

  it('carries the branch title, not staging’s, into the same answer', async () => {
    const plan = derived('*[sanity::versionOf("article-01")]{_id, title}')
    const {result} = await evaluateReadQuery({
      plan,
      params: {},
      baseDocuments: [PUBLISHED_01, STAGING_DRAFT_01],
      overlay: overlayOf({
        'drafts.article-01': {...STAGING_DRAFT_01, title: 'OVERLAY EDIT ✅'},
      }),
    })
    expect(result).toEqual([
      {_id: 'article-01', title: 'Article 1'},
      {_id: 'drafts.article-01', title: 'OVERLAY EDIT ✅'},
    ])
  })

  it('surfaces a branch-created document with no staging row at all', async () => {
    const ids = await probe(
      overlayOf({
        'drafts.article-99': {_id: 'drafts.article-99', _type: 'article', title: 'NEW IN BRANCH'},
      }),
      [],
      'article-99',
    )
    expect(ids).toEqual(['drafts.article-99'])
  })

  it('drops a version the branch tombstoned, though staging still holds it', async () => {
    const ids = await probe(overlayOf({}, ['drafts.article-01']), [
      PUBLISHED_01,
      STAGING_DRAFT_01,
    ])
    expect(ids).toEqual(['article-01'])
  })

  it('answers staging’s own version set unchanged when the branch is empty', async () => {
    /* The negative control: with nothing overlaid the answer must be exactly
     * what the hosted dataset would say, or the version set is inventing rows. */
    const ids = await probe(overlayOf({}), [PUBLISHED_01, STAGING_DRAFT_01])
    expect(ids).toEqual(['article-01', 'drafts.article-01'])
  })

  it('keeps each probe entry to its OWN logical document', async () => {
    /* The independent oracle. The plan deliberately over-fetches — one merged
     * candidate set for both filters — and `groq-js` evaluates `versionOf`
     * itself over it. If this file had reimplemented the predicate the split
     * would be its own answer echoed back. */
    const plan = derived(VERSION_PROBE)
    const {result} = await evaluateReadQuery({
      plan,
      params: {},
      baseDocuments: [PUBLISHED_01, {_id: 'article-02', _type: 'article', title: 'Article 2'}],
      overlay: overlayOf({
        'drafts.article-02': {_id: 'drafts.article-02', _type: 'article', title: 'BRANCH 2'},
      }),
    })
    expect(result).toEqual([['article-01'], ['article-02', 'drafts.article-02']])
  })

  it('reports the version set as exact, with the candidate IDs it used', async () => {
    const plan = derived('*[sanity::versionOf("article-01")]._id')
    const {diagnostics} = await evaluateReadQuery({
      plan,
      params: {},
      baseDocuments: [PUBLISHED_01],
      overlay: overlayOf({'drafts.article-01': {...STAGING_DRAFT_01, title: 'BRANCH'}}),
    })
    expect(diagnostics.candidateIds).toEqual(['article-01', 'drafts.article-01'])
    expect(diagnostics.evaluatorInvocations).toBe(1)
    expect(diagnostics.exact).toBe(true)
  })
})

/* ================================================================== *
 * 6. IDs from an array parameter — the gap, now closed in the package
 * ================================================================== */

describe('sanity-overlay-query can express IDs from an array parameter', () => {
  it('planCandidateRequests accepts an array-valued ID parameter', async () => {
    /* `CandidatePlan.ids` used to name one PARAMETER per ID and `planner.ts`
     * rejected anything that was not a non-empty *string*, so the extremely
     * common `*[_id in $ids]` had no template form and spikeA could only bake
     * the set in per call. An array of document IDs is exactly as enumerable as
     * a list of single-ID parameters — the base request transfers |ids|
     * documents either way — so the restriction bought no boundedness. */
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
    expect(requests.explicitIds).toEqual(['a', 'b'])
  })

  it('mixes array and scalar ID parameters in one plan', async () => {
    const {planCandidateRequests} = await import(
      '../../../packages/sanity-overlay-query/src/planner'
    )
    const requests = planCandidateRequests(
      {
        id: 'mixed-param',
        candidatePlan: {type: 'ids', idsFromParams: ['one', 'many']},
      } as never,
      {one: 'a', many: ['b', 'c']},
    )
    expect(requests.baseRequests).toEqual([{kind: 'ids', ids: ['a', 'b', 'c']}])
  })

  it('still refuses an absent parameter, and an array holding a non-ID', async () => {
    /* The guard that mattered stays: "no ID supplied, so fetch everything" is
     * the dangerous failure mode, not "the IDs arrived in one array". */
    const {planCandidateRequests} = await import(
      '../../../packages/sanity-overlay-query/src/planner'
    )
    const plan = {id: 'array-param', candidatePlan: {type: 'ids', idsFromParams: ['ids']}} as never
    expect(() => planCandidateRequests(plan, {})).toThrow(/ids/)
    expect(() => planCandidateRequests(plan, {ids: ['a', 7]})).toThrow(/ids/)
    expect(() => planCandidateRequests(plan, {ids: ['a', '']})).toThrow(/ids/)
    expect(() => planCandidateRequests(plan, {ids: null})).toThrow(/ids/)
  })
})
