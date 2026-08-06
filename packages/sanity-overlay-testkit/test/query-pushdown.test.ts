/**
 * `sanity-overlay-query` — the two PUSHDOWN candidate plans (PRD §22.6).
 *
 * These are the plans the Spike C latency evidence
 * (`docs/plans/evidence/phase-1/spike-c-groq-corpus/latency-2026-08-04.md`)
 * identified as the whole of Gate D's remaining latency gap:
 *
 *   - `aggregate`        §22.6 step 14 hands the ORIGINAL query to `groq-js`
 *                        over the candidate set, so an aggregate registered
 *                        under any document-returning plan must materialise
 *                        everything it aggregates — measured at 4.8 MiB
 *                        transferred to return one scalar (§4.1).
 *   - `reverse-reference` §22.6 step 10, for `author->name == $name`, whose
 *                        base candidates §22.7 specifies as "all articles" —
 *                        measured at p50 2.2 s / p95 12.7 s against a 3 s
 *                        budget (§4.1).
 *
 * WHAT THIS FILE PROVES, and in which direction:
 *
 *   1. EXACTNESS. Every case is checked against an oracle that evaluates the
 *      same query over the FULLY RESOLVED virtual dataset. The oracle is
 *      written longhand below from §22.6 steps 6, 7 and 13 and never calls the
 *      package's resolver, so agreement is evidence and not a tautology.
 *      Exactness is the non-negotiable: §5.5 forbids a plausible number.
 *
 *   2. BOUNDEDNESS. Parity alone cannot see over-fetching — any SUPERSET of the
 *      correct candidate set passes it. So each pushdown also carries a ceiling
 *      derived from the OVERLAY and the query's semantics (the branch delta of
 *      the aggregated type; the referrers of the touched documents), computed
 *      here without reading a planner constant. `query-boundedness.test.ts`
 *      states the same rule for the registry as a whole; this file states it for
 *      the two plans that have no registered query yet.
 *
 *   3. REFUSAL. Each plan is exact only inside a stated precondition — a local
 *      filter for the aggregate, a single dereference hop for the reverse
 *      reference. Outside it the evaluator must raise the structured
 *      `UNSUPPORTED_GROQ`, never return a recombined value. Those are asserted
 *      as loudly as the successes, because a silent approximation is the one
 *      failure mode §5.5 names.
 */
import {describe, expect, it} from 'vitest'
import {
  createMemoryBaseSource,
  createQueryRegistry,
  defineOverlayQuery,
  evaluateOverlayQuery,
  planCandidateRequests,
  queryTextChecksum,
} from '../../sanity-overlay-query/src/index'
import type {
  OverlayQueryDefinition,
  OverlaySource,
  QueryBaseSource,
} from '../../sanity-overlay-query/src/index'
import {M_LOCAL_PARITY_OVERLAYS} from '../../sanity-overlay-query/parity/index'
import {
  type FixtureDocument,
  draftsPerspective,
  loadFixtureDataset,
  publishedPerspective,
} from '../src/fixtures'
import {runGroq} from '../src/groq'

const raw = loadFixtureDataset()
const DATASETS = {
  published: publishedPerspective(raw),
  drafts: draftsPerspective(raw),
} as const

const OVERLAY_NAMES = Object.keys(M_LOCAL_PARITY_OVERLAYS)

/* ------------------------------------------------------------------ *
 * The oracle — longhand from PRD §22.6, never the package's resolver.
 * ------------------------------------------------------------------ */

function resolvedVirtualDataset(
  base: readonly FixtureDocument[],
  overlay: OverlaySource,
): FixtureDocument[] {
  const out: FixtureDocument[] = []
  const seen = new Set<string>()
  for (const doc of base) {
    if (overlay.tombstones.has(doc._id)) continue
    out.push((overlay.documents.get(doc._id) as FixtureDocument | undefined) ?? doc)
    seen.add(doc._id)
  }
  for (const [id, doc] of overlay.documents) {
    if (!seen.has(id) && !overlay.tombstones.has(id)) out.push(doc as FixtureDocument)
  }
  return out
}

const oracle = async (
  query: string,
  base: readonly FixtureDocument[],
  overlay: OverlaySource,
  params: Record<string, unknown> = {},
): Promise<unknown> => runGroq(query, resolvedVirtualDataset(base, overlay), params)

/* ------------------------------------------------------------------ *
 * Ad-hoc registrations.
 *
 * These three shapes are deliberately NOT in `M_LOCAL_QUERIES` — registering a
 * query is a §22.5 act that also needs parity fixtures and a ratified
 * `maxCandidates`, and `query-registry.test.ts` pins their absence. The PLAN,
 * though, is a capability of this package and is exercised here directly.
 * ------------------------------------------------------------------ */

const define = (
  partial: Omit<
    OverlayQueryDefinition,
    'queryChecksum' | 'allowedCallers' | 'perspectives' | 'systemTimestampPolicy'
  >,
): OverlayQueryDefinition =>
  defineOverlayQuery({
    ...partial,
    queryChecksum: queryTextChecksum(partial.query),
    allowedCallers: ['test'],
    perspectives: ['published', 'drafts'],
    systemTimestampPolicy: 'preserve-base',
  })

const ARTICLE_COUNT = define({
  id: 'article-count',
  description: 'count() over a type, pushed down to the base (§22.6 aggregate pushdown).',
  query: `count(*[_type == "article"])`,
  candidatePlan: {type: 'aggregate', aggregate: 'count', types: ['article']},
  maxCandidates: 4096,
  maxReferenceDepth: 3,
  status: 'tier-a',
})

const STATS_AGGREGATE = define({
  id: 'stats-aggregate',
  description: 'math::sum() over a type, pushed down to the base.',
  query: `math::sum(*[_type == "article"].sections[1].count)`,
  candidatePlan: {
    type: 'aggregate',
    aggregate: 'sum',
    types: ['article'],
    path: ['sections', '1', 'count'],
  },
  maxCandidates: 4096,
  maxReferenceDepth: 3,
  status: 'tier-a',
})

const BY_AUTHOR_NAME = define({
  id: 'articles-by-author-name',
  description: 'Filter through a reference — §22.6 step 10 reverse-reference expansion.',
  query: `*[_type == "article" && author->name == $name]{_id} | order(_id asc)`,
  candidatePlan: {
    type: 'reverse-reference',
    types: ['article'],
    referencePath: ['author'],
    targetPath: ['name'],
    valueFromParam: 'name',
  },
  maxCandidates: 4096,
  maxReferenceDepth: 3,
  status: 'tier-b',
})

const PUSHDOWNS = [ARTICLE_COUNT, STATS_AGGREGATE, BY_AUTHOR_NAME]
const registry = createQueryRegistry(PUSHDOWNS)

/** Author names present in the fixtures, plus one that matches nothing. */
const AUTHOR_NAMES = [
  {name: 'Author 2'},
  {name: 'Author 2 (branch rename)'},
  {name: 'Author 5'},
  {name: 'No Such Author'},
]

const PARAMS: Record<string, Array<Record<string, unknown>>> = {
  'article-count': [{}],
  'stats-aggregate': [{}],
  'articles-by-author-name': AUTHOR_NAMES,
}

const run = async (
  def: OverlayQueryDefinition,
  base: readonly FixtureDocument[],
  overlay: OverlaySource,
  params: Record<string, unknown>,
  base_?: QueryBaseSource,
) =>
  evaluateOverlayQuery({
    registry,
    queryId: def.id,
    params,
    base: base_ ?? createMemoryBaseSource(base),
    overlay,
    caller: 'test',
    perspective: 'published',
    measureBytes: true,
  })

/* ================================================================== *
 * 1. EXACTNESS — the answer equals the full-dataset oracle's answer.
 * ================================================================== */

describe('§22.6 pushdown plans return exactly what the full virtual dataset returns', () => {
  for (const def of PUSHDOWNS) {
    for (const perspective of ['published', 'drafts'] as const) {
      for (const overlayName of OVERLAY_NAMES) {
        for (const params of PARAMS[def.id]) {
          it(`${def.id} | ${perspective} | ${overlayName} | ${JSON.stringify(params)}`, async () => {
            const base = DATASETS[perspective]
            const overlay = M_LOCAL_PARITY_OVERLAYS[overlayName](base)
            const {result} = await evaluateOverlayQuery({
              registry,
              queryId: def.id,
              params,
              base: createMemoryBaseSource(base),
              overlay,
              caller: 'test',
              perspective,
              measureBytes: true,
            })
            expect(result).toEqual(await oracle(def.query, base, overlay, params))
          })
        }
      }
    }
  }
})

/* ================================================================== *
 * 2. BOUNDEDNESS — ceilings computed from the overlay and the query,
 *    never from a planner constant.
 * ================================================================== */

describe('§22.6 aggregate pushdown: the aggregated type is NOT materialised', () => {
  const AGGREGATES = [ARTICLE_COUNT, STATS_AGGREGATE]

  for (const def of AGGREGATES) {
    for (const overlayName of OVERLAY_NAMES) {
      it(`${def.id} | ${overlayName} materialises at most the branch delta of its type`, async () => {
        const base = DATASETS.published
        const overlay = M_LOCAL_PARITY_OVERLAYS[overlayName](base)

        /* The independent ceiling. A document can only be in the branch half of
         * the partition if the branch touched it AND it is an article in either
         * its base or its branch state. Derived here from the overlay and the
         * registered types — the planner is not consulted. */
        const baseById = new Map(base.map((d) => [d._id, d]))
        const touched = [...overlay.documents.keys(), ...overlay.tombstones]
        const ceiling = touched.filter(
          (id) =>
            overlay.documents.get(id)?._type === 'article' ||
            baseById.get(id)?._type === 'article',
        ).length

        const {diagnostics} = await run(def, base, overlay, {})
        expect(diagnostics.candidateCount).toBeLessThanOrEqual(ceiling)

        /* Not vacuous: the ceiling must be far below the type it aggregates,
         * or "bounded by the branch delta" would be indistinguishable from
         * "bounded by the type". */
        const typeSize = base.filter((d) => d._type === 'article').length
        expect(ceiling).toBeLessThan(typeSize)
        expect(diagnostics.baseFetchDocuments).toBe(0)
      })
    }
  }

  it('an empty branch transfers NO documents at all to answer either aggregate', async () => {
    const base = DATASETS.published
    const overlay = M_LOCAL_PARITY_OVERLAYS.empty(base)
    for (const def of AGGREGATES) {
      const {diagnostics} = await run(def, base, overlay, {})
      expect(diagnostics.candidateCount, def.id).toBe(0)
      expect(diagnostics.baseFetchDocuments, def.id).toBe(0)
      expect(diagnostics.candidateBytes, def.id).toBe(0)
    }
  })
})

describe('§22.6 step 10: reverse-reference expansion is bounded by referrers, not by the type', () => {
  for (const overlayName of OVERLAY_NAMES) {
    for (const params of AUTHOR_NAMES) {
      it(`${overlayName} | ${params.name}: candidates stay within the referrer ceiling`, async () => {
        const base = DATASETS.published
        const overlay = M_LOCAL_PARITY_OVERLAYS[overlayName](base)
        const virtual = resolvedVirtualDataset(base, overlay)

        /* The independent ceiling, from §22.6 step 10's own completeness
         * argument rather than from the planner: an article is a legitimate
         * candidate only if it matches in the BASE state, or it is touched, or
         * it references something touched. Computed over the fixtures. */
        const touched = new Set([...overlay.documents.keys(), ...overlay.tombstones])
        const baseById = new Map(base.map((d) => [d._id, d]))
        const refsAnyTouched = (value: unknown): boolean => {
          if (Array.isArray(value)) return value.some(refsAnyTouched)
          if (!value || typeof value !== 'object') return false
          const o = value as Record<string, unknown>
          if (typeof o._ref === 'string' && touched.has(o._ref)) return true
          return Object.values(o).some(refsAnyTouched)
        }
        const matchesInBase = (doc: FixtureDocument): boolean => {
          const ref = (doc.author as {_ref?: string} | undefined)?._ref
          const target = ref ? baseById.get(ref) : undefined
          return target?.name === params.name
        }
        const ceiling = new Set<string>()
        for (const doc of base) {
          if (doc._type !== 'article') continue
          if (matchesInBase(doc) || touched.has(doc._id) || refsAnyTouched(doc)) {
            ceiling.add(doc._id)
          }
        }
        for (const [id, doc] of overlay.documents) {
          if (doc._type === 'article' || baseById.get(id)?._type === 'article') ceiling.add(id)
        }

        const {diagnostics} = await run(BY_AUTHOR_NAME, base, overlay, params)
        /* Reference expansion legitimately adds the authors the query derefs,
         * so the ceiling applies to what the PLAN chose. */
        expect(diagnostics.planSelectedCount).toBeLessThanOrEqual(ceiling.size)

        /* Not vacuous: the ceiling must be well under the article type, or
         * "bounded by the referrers" is just "bounded by the type" restated. */
        const articles = virtual.filter((d) => d._type === 'article').length
        expect(ceiling.size).toBeLessThan(articles)
      })
    }
  }

  it('the plan issues ONE base request carrying both disjuncts, not two round trips', async () => {
    const base = DATASETS.published
    const overlay = M_LOCAL_PARITY_OVERLAYS.mixed(base)
    const {diagnostics} = await run(BY_AUTHOR_NAME, base, overlay, {name: 'Author 2'})
    /* §22.6 budgets step 5 and step 14. A base fetch per matching target would
     * be the N+1 this plan exists to avoid; reference expansion of the derefed
     * `author` attribute is a separate, analysed step. */
    expect(diagnostics.evaluatorInvocations).toBe(1)
    expect(diagnostics.baseRequestCount).toBeLessThanOrEqual(2)
  })
})

/* ================================================================== *
 * 3. REFUSAL — outside the stated precondition, structurally, never a
 *    recombined guess.
 * ================================================================== */

describe('§5.5: a pushdown outside its exactness precondition is refused, not approximated', () => {
  it('an aggregate whose filter traverses a reference is refused', async () => {
    /* The base half decides membership from the BASE state. A filter that
     * dereferences can gain and lose members when a TARGET is edited, which the
     * base cannot see, so the partition stops being a partition. */
    const def = define({
      id: 'aggregate-through-reference',
      description: 'An aggregate whose filter dereferences — not exactly pushdown-able.',
      query: `count(*[_type == "article" && author->name == $name])`,
      candidatePlan: {type: 'aggregate', aggregate: 'count', types: ['article']},
      maxCandidates: 4096,
      maxReferenceDepth: 3,
      status: 'tier-a',
    })
    const local = createQueryRegistry([def])
    const base = DATASETS.published
    await expect(
      evaluateOverlayQuery({
        registry: local,
        queryId: def.id,
        params: {name: 'Author 2'},
        base: createMemoryBaseSource(base),
        overlay: M_LOCAL_PARITY_OVERLAYS.mixed(base),
        caller: 'test',
        perspective: 'published',
      }),
      /* The REASON is asserted, not just the code. Before the planner existed
       * this same call raised UNSUPPORTED_GROQ from the unknown-plan branch, so
       * asserting the code alone would have passed for the wrong reason. */
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_GROQ',
      details: {reason: 'filter-traverses-reference'},
    })
  })

  it('a reverse-reference filter with more than one dereference hop is refused', async () => {
    /* With `a->b->name`, editing the grandchild changes a referrer's membership
     * without that referrer referencing anything the base half can see, so
     * `references($touched)` misses it. */
    const def = define({
      id: 'articles-by-grandparent',
      description: 'Two dereference hops — §22.6 step 10 is complete for one.',
      query: `*[_type == "article" && author->favoriteArticle->title == $title]{_id}`,
      candidatePlan: {
        type: 'reverse-reference',
        types: ['article'],
        referencePath: ['author'],
        targetPath: ['favoriteArticle', 'title'],
        valueFromParam: 'title',
      },
      maxCandidates: 4096,
      maxReferenceDepth: 3,
      status: 'tier-b',
    })
    const local = createQueryRegistry([def])
    const base = DATASETS.published
    await expect(
      evaluateOverlayQuery({
        registry: local,
        queryId: def.id,
        params: {title: 'Article 1'},
        base: createMemoryBaseSource(base),
        overlay: M_LOCAL_PARITY_OVERLAYS.mixed(base),
        caller: 'test',
        perspective: 'published',
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_GROQ',
      details: {reason: 'multi-hop-deref', derefDepth: 2},
    })
  })

  it('a base source without fetchAggregate is refused, never served by a local scan', async () => {
    /* Fetching the type and aggregating locally returns the RIGHT ANSWER by
     * transferring everything — the degradation §22.2 forbids and that no
     * parity test could ever see. */
    const base = DATASETS.published
    const memory = createMemoryBaseSource(base)
    const withoutAggregate: QueryBaseSource = {
      fetchCandidates: memory.fetchCandidates.bind(memory),
      fetchExtendedCandidates: memory.fetchExtendedCandidates?.bind(memory),
    }
    await expect(
      run(ARTICLE_COUNT, base, M_LOCAL_PARITY_OVERLAYS.empty(base), {}, withoutAggregate),
    ).rejects.toMatchObject({code: 'UNSUPPORTED_GROQ'})
  })

  it('a base source without fetchExtendedCandidates cannot serve a reverse reference', async () => {
    const base = DATASETS.published
    const memory = createMemoryBaseSource(base)
    const coreOnly: QueryBaseSource = {fetchCandidates: memory.fetchCandidates.bind(memory)}
    await expect(
      run(BY_AUTHOR_NAME, base, M_LOCAL_PARITY_OVERLAYS.empty(base), {name: 'Author 2'}, coreOnly),
    ).rejects.toMatchObject({code: 'UNSUPPORTED_GROQ'})
  })

  it('a reverse-reference query with an absent parameter is refused, not widened', async () => {
    const base = DATASETS.published
    await expect(
      run(BY_AUTHOR_NAME, base, M_LOCAL_PARITY_OVERLAYS.empty(base), {}),
    ).rejects.toMatchObject({code: 'UNSUPPORTED_GROQ'})
  })
})

/* ================================================================== *
 * 4. THE PLAN ITSELF — inspected without a dataset.
 * ================================================================== */

describe('§22.6: the pushdown planners emit the requests their proofs require', () => {
  it('an aggregate plan asks the base for a SCALAR and for no documents', () => {
    const requests = planCandidateRequests(ARTICLE_COUNT, {}, {affectedIds: ['a', 'b']})
    expect(requests.baseRequests).toEqual([])
    expect(requests.extendedRequests).toEqual([])
    expect(requests.aggregateRequest).toEqual({
      aggregate: 'count',
      types: ['article'],
      path: undefined,
      excludeIds: ['a', 'b'],
    })
    /* Step 6: a branch record of the type must still join the candidate set —
     * it is the branch half of the partition. */
    expect(requests.overlayTypes).toEqual(['article'])
  })

  it('the aggregate excludes EVERY touched id, which is what makes the halves a partition', () => {
    const requests = planCandidateRequests(STATS_AGGREGATE, {}, {affectedIds: ['x']})
    expect(requests.aggregateRequest?.excludeIds).toEqual(['x'])
    expect(requests.aggregateRequest?.path).toEqual(['sections', '1', 'count'])
  })

  it('a reverse-reference plan carries both disjuncts in one extended request', () => {
    const requests = planCandidateRequests(
      BY_AUTHOR_NAME,
      {name: 'Author 2'},
      {affectedIds: ['author-2']},
    )
    expect(requests.baseRequests).toEqual([])
    expect(requests.extendedRequests).toEqual([
      {
        kind: 'reverse-reference',
        types: ['article'],
        referencePath: ['author'],
        targetPath: ['name'],
        value: 'Author 2',
        touchedIds: ['author-2'],
      },
    ])
    expect(requests.overlayTypes).toEqual(['article'])
  })

  it('both plans refuse to be planned without the branch delta', () => {
    /* Defaulting the touched set to empty would silently under-fetch the moment
     * a branch existed — the one failure mode candidate planning must not have. */
    for (const def of [ARTICLE_COUNT, BY_AUTHOR_NAME]) {
      expect(() => planCandidateRequests(def, {name: 'Author 2'}), def.id).toThrow(
        /cannot be planned without/,
      )
      try {
        planCandidateRequests(def, {name: 'Author 2'})
        throw new Error('unreachable')
      } catch (error) {
        expect((error as {code?: string}).code, def.id).toBe('UNSUPPORTED_GROQ')
      }
    }
  })
})

/* ================================================================== *
 * 5. NON-VACUITY — the exactness assertions above must be able to fail.
 * ================================================================== */

describe('non-vacuity: a broken pushdown must break these tests', () => {
  it('a base source that ignores excludeIds double-counts, and exactness catches it', async () => {
    const base = DATASETS.published
    const overlay = M_LOCAL_PARITY_OVERLAYS.mixed(base)
    const memory = createMemoryBaseSource(base)
    const doubleCounting: QueryBaseSource = {
      fetchCandidates: memory.fetchCandidates.bind(memory),
      fetchExtendedCandidates: memory.fetchExtendedCandidates?.bind(memory),
      /* The mutation: aggregate the whole type, so every touched article is
       * counted in BOTH halves. */
      fetchAggregate: (request) =>
        memory.fetchAggregate!({...request, excludeIds: []}),
    }
    const {result} = await run(ARTICLE_COUNT, base, overlay, {}, doubleCounting)
    const truth = await oracle(ARTICLE_COUNT.query, base, overlay, {})
    expect(result).not.toEqual(truth)
  })

  it('a reverse-reference base that drops the touched disjunct misses a document', async () => {
    /* The `ref-target-change` overlay renames author-2, so every article that
     * referenced author-2 leaves the answer for "Author 2" and enters it for
     * the new name. A base half that only asked the BASE-state disjunct would
     * never see the second group. */
    const base = DATASETS.published
    const overlay = M_LOCAL_PARITY_OVERLAYS['ref-target-change'](base)
    const params = {name: 'Author 2 (branch rename)'}
    const memory = createMemoryBaseSource(base)
    const halfBlind: QueryBaseSource = {
      fetchCandidates: memory.fetchCandidates.bind(memory),
      fetchExtendedCandidates: (request) =>
        memory.fetchExtendedCandidates!(
          request.kind === 'reverse-reference' ? {...request, touchedIds: []} : request,
        ),
    }
    const {result} = await run(BY_AUTHOR_NAME, base, overlay, params, halfBlind)
    const truth = await oracle(BY_AUTHOR_NAME.query, base, overlay, params)
    expect(truth).not.toEqual([])
    expect(result).not.toEqual(truth)
  })
})
