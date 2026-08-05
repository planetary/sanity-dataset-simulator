/**
 * `sanity-overlay-query` — overlay parity (PRD §35.10 method, §22.1, §22.6).
 *
 * The claim: evaluating a registered query through the candidate planner
 * returns EXACTLY what evaluating the same query over the fully resolved
 * virtual dataset returns. That is candidate *completeness* — the planner never
 * misses a document that could enter, leave or reorder the answer.
 *
 * The oracle is written out longhand in this file, from PRD §22.6 steps 6, 7
 * and 13, and never calls the package's own resolver. It differs from the
 * system under test in the way that matters: it sees every document, the
 * planner sees only what it chose to fetch.
 *
 * WHAT PARITY CANNOT DO — recorded here because the Spike C evidence review
 * found it the hard way (`report.md`, correction notice 2026-08-04): parity is
 * preserved by any SUPERSET of the correct candidate set, so a planner that
 * loads the entire dataset passes every assertion in this file. Over-fetching
 * is the subject of `query-boundedness.test.ts`; nothing here may be read as
 * evidence for §22.6.
 */
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  createMemoryBaseSource,
  createQueryRegistry,
  evaluateOverlayQuery,
} from '../../sanity-overlay-query/src/index'
import type {OverlaySource} from '../../sanity-overlay-query/src/index'
import {M_LOCAL_PARITY_OVERLAYS} from '../../sanity-overlay-query/parity/index'
import {type FixtureDocument, draftsPerspective, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'

const raw = loadFixtureDataset()
const DATASETS = {
  published: publishedPerspective(raw),
  drafts: draftsPerspective(raw),
} as const

const registry = createQueryRegistry(M_LOCAL_QUERIES)
const supported = M_LOCAL_QUERIES.filter((d) => d.status !== 'unsupported')

/* ------------------------------------------------------------------ *
 * The oracle — written longhand from PRD §22.6, not imported.
 * ------------------------------------------------------------------ */

/**
 * Fully resolved virtual dataset: base in base order, with tombstoned
 * documents removed and branch records substituted in place, then
 * branch-created documents appended (§22.6 steps 6, 7, 13).
 *
 * Order is load-bearing, not cosmetic: an unordered `*[...][0]` returns the
 * first match in DATASET order, so an oracle that sorted differently would
 * disagree with a correct planner.
 */
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

const oracle = async (query: string, base: readonly FixtureDocument[], overlay: OverlaySource, params: Record<string, unknown>) =>
  runGroq(query, resolvedVirtualDataset(base, overlay), params)

/* ------------------------------------------------------------------ *
 * The matrix.
 * ------------------------------------------------------------------ */

/**
 * Parameter sets per query. Chosen to include, for every parameterised lookup:
 * a value that matches in base, a value that matches only because of the
 * branch, and a value that matches nothing.
 */
const PARAM_SETS: Record<string, Array<Record<string, unknown>>> = {
  'article-by-id': [{id: 'article-05'}, {id: 'article-01'}, {id: 'article-branch-1'}, {id: 'no-such-id'}],
  'article-with-author': [{id: 'article-01'}, {id: 'article-05'}, {id: 'article-branch-1'}, {id: 'no-such-id'}],
  'page-featured-refs': [{}],
  'page-by-slug': [{slug: 'legacy-page'}, {slug: 'home'}, {slug: 'branch-page'}, {slug: 'no-such-slug'}],
  'article-by-slug': [{slug: 'article-7'}, {slug: 'article-9'}, {slug: 'branch-article'}, {slug: 'no-such-slug'}],
  'article-by-slug-with-author': [{slug: 'article-7'}, {slug: 'branch-article'}, {slug: 'no-such-slug'}],
  'article-type-list': [{}],
  'multi-type-list': [{}],
}

const CASES: Array<
  [label: string, queryId: string, perspective: 'published' | 'drafts', overlayName: string, params: Record<string, unknown>]
> = []
for (const def of supported) {
  for (const perspective of ['published', 'drafts'] as const) {
    for (const overlayName of Object.keys(M_LOCAL_PARITY_OVERLAYS)) {
      for (const params of PARAM_SETS[def.id]) {
        CASES.push([
          `${def.id} | ${perspective} | ${overlayName} | ${JSON.stringify(params)}`,
          def.id,
          perspective,
          overlayName,
          params,
        ])
      }
    }
  }
}

describe('§35.10: planner result equals the whole-dataset oracle', () => {
  it('the matrix is the size the registry and fixtures imply', () => {
    const expected = supported.reduce(
      (n, d) => n + 2 * Object.keys(M_LOCAL_PARITY_OVERLAYS).length * PARAM_SETS[d.id].length,
      0,
    )
    expect(CASES.length).toBe(expected)
    expect(CASES.length).toBeGreaterThan(100)
  })

  it.each(CASES)('%s', async (_label, queryId, perspective, overlayName, params) => {
    const base = DATASETS[perspective]
    const overlay = M_LOCAL_PARITY_OVERLAYS[overlayName](base)
    const def = registry.get(queryId)

    const {result} = await evaluateOverlayQuery({
      registry,
      queryId,
      query: def.query,
      params,
      base: createMemoryBaseSource(base),
      overlay,
      caller: 'test',
      perspective,
    })
    const expected = await oracle(def.query, base, overlay, params)
    expect(result).toEqual(expected)
  })
})

/* ------------------------------------------------------------------ *
 * §35.11 behaviours, stated one by one rather than left implicit in the
 * sweep. Each asserts the OBSERVABLE overlay behaviour, and each is written
 * so that it fails if the planner drops the corresponding §22.6 step.
 * ------------------------------------------------------------------ */

const base = DATASETS.published
const evaluate = async <T>(queryId: string, params: Record<string, unknown>, overlay: OverlaySource) => {
  const def = registry.get(queryId)
  return evaluateOverlayQuery<T>({
    registry,
    queryId,
    query: def.query,
    params,
    base: createMemoryBaseSource(base),
    overlay,
    caller: 'test',
    perspective: 'published',
  })
}

describe('§35.11: the behaviours the overlay exists for', () => {
  it('a branch-created document is found by a slug the base has never seen', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['branch-create'](base)
    const {result} = await evaluate<{title: string} | null>('article-by-slug', {slug: 'branch-article'}, overlay)
    // §22.6 step 6: the base filter returns nothing for this slug, so only the
    // union of branch records of the candidate type can produce this answer.
    expect(result).toEqual({title: 'Branch article', slug: 'branch-article'})
  })

  it('a branch slug edit removes the base document from its own slug lookup', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['slug-edit'](base)
    const {result} = await evaluate('article-by-slug', {slug: 'article-7'}, overlay)
    expect(result).toBeNull()
  })

  it('a branch slug move hands the slug to a different document', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['slug-steal'](base)
    const {result} = await evaluate<{title: string}>('article-by-slug', {slug: 'article-7'}, overlay)
    expect(result.title).toBe('Article 9')
  })

  it('a tombstoned document leaves every result', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['tombstone'](base)
    expect((await evaluate('article-by-id', {id: 'article-01'}, overlay)).result).toBeNull()
    const list = (await evaluate<Array<{_id: string}>>('article-type-list', {}, overlay)).result
    expect(list.map((d) => d._id)).not.toContain('article-01')
  })

  it('a tombstoned reference target dereferences to null without rewriting the parent', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['tombstone'](base)
    const {result} = await evaluate<{sections: {articles: unknown[]}}>('page-featured-refs', {}, overlay)
    // page-home is untouched by the branch; article-01 is tombstoned, so the
    // dereference must yield null even though nothing rewrote the parent.
    expect(result.sections.articles).toEqual([null, {title: 'Article 15'}])
  })

  it('editing a reference target changes the dereferenced value with no parent edit', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['ref-target-change'](base)
    const {result} = await evaluate<{author: {name: string}}>('article-with-author', {id: 'article-01'}, overlay)
    expect(result.author.name).toBe('Author 2 (branch rename)')
  })

  it('a branch _type change moves a document out of one type list and into another', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['type-change'](base)
    // legacy.page.v2 is a page in base and an article in the branch.
    expect((await evaluate('page-by-slug', {slug: 'legacy-page'}, overlay)).result).toBeNull()
    const list = (await evaluate<Array<{_id: string; _type: string}>>('multi-type-list', {}, overlay)).result
    expect(list.find((d) => d._id === 'legacy.page.v2')?._type).toBe('article')
  })

  it('a branch-created document enters the type list', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['branch-create'](base)
    const list = (await evaluate<Array<{_id: string}>>('article-type-list', {}, overlay)).result
    expect(list.map((d) => d._id)).toContain('article-branch-1')
  })

  // Redundancy, added because a mutation audit found the "never silently
  // approximate" rule was killed by exactly ONE test file. A parity suite is
  // where an approximation would be most tempting — it is the file that would
  // go green if an unsupported query started returning "close enough" — so the
  // refusal is pinned here as well, across the whole parity matrix.
  it.each(
    Object.keys(M_LOCAL_PARITY_OVERLAYS).flatMap((overlayName) =>
      (['published', 'drafts'] as const).map((perspective) => [overlayName, perspective] as const),
    ),
  )(
    'the Tier C entry refuses to produce ANY result (%s | %s)',
    async (overlayName, perspective) => {
      const dataset = DATASETS[perspective]
      const def = registry.get('unconstrained-star')
      let resolved = false
      let thrown: unknown
      try {
        await evaluateOverlayQuery({
          registry,
          queryId: 'unconstrained-star',
          query: def.query,
          params: {},
          base: createMemoryBaseSource(dataset),
          overlay: M_LOCAL_PARITY_OVERLAYS[overlayName](dataset),
          caller: 'test',
          perspective: 'published',
        })
        resolved = true
      } catch (error) {
        thrown = error
      }
      expect(resolved, 'an unsupported query must never return a result').toBe(false)
      expect(thrown).toMatchObject({code: 'UNSUPPORTED_GROQ'})
    },
  )

  it('the empty overlay reproduces the base answer exactly', async () => {
    const overlay = M_LOCAL_PARITY_OVERLAYS['empty'](base)
    const {result} = await evaluate('article-type-list', {}, overlay)
    expect(result).toEqual(await runGroq(registry.get('article-type-list').query, base, {}))
  })
})
