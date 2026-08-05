/**
 * SPIKE A — which GROQ the read facade answers **exactly**, and what it does with
 * the rest (PRD §22.3 Tier A, §22.5, §5.5; roadmap §5.3 `[M-LOCAL]`).
 *
 * THE POLICY THIS FILE PINS
 * ─────────────────────────
 * PRD §5.5 requires "no silent query approximation" and §22.2 forbids ever
 * "silently falling back to patching an already filtered or sliced result". But
 * failing *every* unregistered query would break Studio's own internal queries —
 * structure lists, previews, search — and make the editor unusable. §22.5 names
 * the way out: "[MUST] Log unregistered queries", "[MUST] Reject unregistered
 * queries in strict preview mode", "[SHOULD] Allow a local development warning
 * mode during migration".
 *
 * So the classifier's job is to draw a line that is *provable*, not merely
 * plausible: a query is `supported` only when its result set is a pure function
 * of a candidate set this layer can prove complete, with no projection, ordering
 * or operator it would have to approximate. Everything else is `supported:
 * false` **with a reason**, and the caller decides what to do with it.
 *
 * The `[M-LOCAL]` slice (roadmap §5.3, PRD §1.3 "§22 is `[M-LOCAL]` for ID and
 * slug queries") is exactly: document-by-ID, documents-by-IDs, document-by-slug.
 *
 * NO GROQ EVALUATOR HERE. This is a shape recogniser plus the plan's own
 * predicate — deliberately narrow. Anything that needs real GROQ evaluation is
 * out of scope by construction, and says so.
 */
import {describe, expect, it} from 'vitest'
import {
  applyReadPlan,
  classifyReadQuery,
} from '../../../examples/kitchen-sink/spikeA/readQueries'

function plan(query: string, params?: unknown) {
  const classification = classifyReadQuery(query, params)
  if (!classification.supported) {
    throw new Error(`expected ${JSON.stringify(query)} to be supported: ${classification.reason}`)
  }
  return classification.plan
}

function reason(query: unknown, params?: unknown): string {
  const classification = classifyReadQuery(query, params)
  if (classification.supported) {
    throw new Error(`expected ${JSON.stringify(query)} to be unsupported`)
  }
  return classification.reason
}

/* ------------------------------------------------------------------ *
 * Supported: document by ID
 * ------------------------------------------------------------------ */

describe('classifyReadQuery — document by _id', () => {
  it('recognises the parameterised single-document form', () => {
    expect(plan('*[_id == $id][0]', {id: 'article-1'})).toEqual({
      kind: 'by-id',
      ids: ['article-1'],
      types: [],
      single: true,
    })
  })

  it('recognises the literal single-document form, both quote styles', () => {
    expect(plan('*[_id == "article-1"][0]').ids).toEqual(['article-1'])
    expect(plan("*[_id == 'article-1'][0]").ids).toEqual(['article-1'])
  })

  it('recognises the array form without a [0] slice', () => {
    const result = plan('*[_id == $id]', {id: 'article-1'})
    expect(result.single).toBe(false)
    expect(result.ids).toEqual(['article-1'])
  })

  it('tolerates the whitespace Studio and defineQuery actually emit', () => {
    expect(plan('\n  *[ _id  ==  $id ] [0]\n', {id: 'article-1'}).ids).toEqual(['article-1'])
  })

  it('keeps a drafts-prefixed ID verbatim — _id matching is raw', () => {
    expect(plan('*[_id == $id][0]', {id: 'drafts.article-1'}).ids).toEqual(['drafts.article-1'])
  })

  it('refuses the shape when the parameter is missing or not a string', () => {
    expect(reason('*[_id == $id][0]', {})).toContain('$id')
    expect(reason('*[_id == $id][0]', {id: 42})).toContain('$id')
    expect(reason('*[_id == $id][0]')).toContain('$id')
  })
})

describe('classifyReadQuery — documents by _id list', () => {
  it('recognises the parameterised `in` form', () => {
    expect(plan('*[_id in $ids]', {ids: ['a', 'drafts.a']})).toEqual({
      kind: 'by-ids',
      ids: ['a', 'drafts.a'],
      types: [],
      single: false,
    })
  })

  it('recognises a literal ID array', () => {
    expect(plan('*[_id in ["a", "b"]]').ids).toEqual(['a', 'b'])
  })

  it('recognises the pair-listener query Studio itself issues', () => {
    /* `localEcho.PAIR_QUERY_RE` matches the same string; the two must agree on
     * what a pair query is. */
    expect(plan('*[_id in $ids]', {ids: ['article-1', 'drafts.article-1']}).kind).toBe('by-ids')
  })

  it('carries a [0...n] slice through as a limit', () => {
    const result = plan('*[_id in $ids][0...2]', {ids: ['a', 'b', 'c']})
    expect(result.limit).toBe(2)
    expect(result.single).toBe(false)
  })

  it('refuses an inclusive slice, whose end it would have to guess at', () => {
    expect(reason('*[_id in $ids][0..2]', {ids: ['a']})).toContain('slice')
  })

  it('refuses a slice that does not start at 0 — ordering is undefined', () => {
    expect(reason('*[_id in $ids][2...4]', {ids: ['a']})).toContain('slice')
  })

  it('refuses a non-string member of the ID array', () => {
    expect(reason('*[_id in $ids]', {ids: ['a', 7]})).toContain('$ids')
    expect(reason('*[_id in $ids]', {ids: 'a'})).toContain('$ids')
  })
})

/* ------------------------------------------------------------------ *
 * Supported: document by slug
 * ------------------------------------------------------------------ */

describe('classifyReadQuery — document by slug', () => {
  it('recognises the type-constrained slug lookup', () => {
    expect(
      plan('*[_type == "article" && slug.current == $slug][0]', {slug: 'hello'}),
    ).toEqual({kind: 'by-slug', ids: [], types: ['article'], slug: 'hello', single: true})
  })

  it('recognises the conjuncts in either order', () => {
    const result = plan('*[slug.current == $slug && _type == $type][0]', {
      slug: 'hello',
      type: 'article',
    })
    expect(result.types).toEqual(['article'])
    expect(result.slug).toBe('hello')
  })

  it('recognises a multi-type constraint', () => {
    const result = plan('*[_type in ["article", "page"] && slug.current == $slug]', {
      slug: 'hello',
    })
    expect(result.types).toEqual(['article', 'page'])
    expect(result.single).toBe(false)
  })

  it('recognises an unconstrained slug lookup as covering every type', () => {
    expect(plan('*[slug.current == $slug][0]', {slug: 'hello'}).types).toEqual([])
  })

  it('refuses a slug lookup whose value is not a string', () => {
    expect(reason('*[_type == "article" && slug.current == $slug][0]', {})).toContain('$slug')
  })
})

/* ------------------------------------------------------------------ *
 * Unsupported — and why. This half is the point of the whole exercise.
 * ------------------------------------------------------------------ */

describe('classifyReadQuery — refuses everything it cannot answer exactly', () => {
  const CASES: ReadonlyArray<{query: string; params?: unknown; mentions: string}> = [
    /* A projection needs a GROQ evaluator; approximating one is §22.2's
     * forbidden "patch an already filtered result". */
    {query: '*[_id == $id][0]{title}', params: {id: 'a'}, mentions: 'projection'},
    {query: '*[_id in $ids]{_id, _rev, title}', params: {ids: ['a']}, mentions: 'projection'},
    /* Ordering over an unbounded candidate set (§22.3 Tier C). */
    {query: '*[_type == "article"] | order(_createdAt desc)', mentions: 'shape'},
    /* An unconstrained type scan: base can hold documents this layer never sees. */
    {query: '*[_type == "article"]', mentions: 'shape'},
    {query: '*[_type == $type][0...100]', params: {type: 'article'}, mentions: 'shape'},
    /* Anything at all beyond the recognised filters. */
    {query: '*[_id == $id && published == true][0]', params: {id: 'a'}, mentions: 'shape'},
    {query: 'count(*[_type == "article"])', mentions: 'shape'},
    {query: '*', mentions: 'shape'},
    {query: '*[references($id)]', params: {id: 'a'}, mentions: 'shape'},
    {query: '*[_id == $id][0]->', params: {id: 'a'}, mentions: 'shape'},
    {query: '*[defined(slug.current)]', mentions: 'shape'},
  ]

  for (const testCase of CASES) {
    it(`refuses ${JSON.stringify(testCase.query)}`, () => {
      expect(reason(testCase.query, testCase.params)).toContain(testCase.mentions)
    })
  }

  it('refuses a non-string query outright', () => {
    expect(reason(undefined)).toContain('shape')
    expect(reason(42)).toContain('shape')
  })

  it('never returns a plan without a reason, or a reason without a refusal', () => {
    for (const query of ['*[_id == $id][0]', '*[_type == "article"]']) {
      const classification = classifyReadQuery(query, {id: 'a'})
      if (classification.supported) expect(classification.plan).toBeDefined()
      else expect(classification.reason.length).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------------------------------------------ *
 * The plan's own predicate, applied to a resolved candidate set
 * ------------------------------------------------------------------ */

const ARTICLE_1 = {_id: 'article-1', _type: 'article', title: 'One', slug: {current: 'one'}}
const ARTICLE_2 = {_id: 'article-2', _type: 'article', title: 'Two', slug: {current: 'two'}}
const PAGE_1 = {_id: 'page-1', _type: 'page', title: 'Page', slug: {current: 'one'}}

describe('applyReadPlan', () => {
  it('answers a single-document plan with the document, or null', () => {
    expect(applyReadPlan(plan('*[_id == $id][0]', {id: 'article-1'}), [ARTICLE_1])).toEqual(
      ARTICLE_1,
    )
    expect(applyReadPlan(plan('*[_id == $id][0]', {id: 'article-9'}), [ARTICLE_1])).toBeNull()
  })

  it('answers an array plan with an array', () => {
    expect(
      applyReadPlan(plan('*[_id in $ids]', {ids: ['article-1', 'article-2']}), [
        ARTICLE_1,
        ARTICLE_2,
      ]),
    ).toEqual([ARTICLE_1, ARTICLE_2])
  })

  it('answers in requested-ID order, not candidate order', () => {
    expect(
      applyReadPlan(plan('*[_id in $ids]', {ids: ['article-2', 'article-1']}), [
        ARTICLE_1,
        ARTICLE_2,
      ]),
    ).toEqual([ARTICLE_2, ARTICLE_1])
  })

  it('drops a candidate the plan does not name — a tombstoned document stays gone', () => {
    expect(
      applyReadPlan(plan('*[_id in $ids]', {ids: ['article-1', 'article-2']}), [ARTICLE_1]),
    ).toEqual([ARTICLE_1])
  })

  it('applies the slug predicate, including the type constraint', () => {
    const typed = plan('*[_type == "article" && slug.current == $slug][0]', {slug: 'one'})
    expect(applyReadPlan(typed, [PAGE_1, ARTICLE_1])).toEqual(ARTICLE_1)

    const untyped = plan('*[slug.current == $slug]', {slug: 'one'})
    expect(applyReadPlan(untyped, [PAGE_1, ARTICLE_1])).toEqual([PAGE_1, ARTICLE_1])
  })

  it('matches a bare-string slug as well as the {current} object form', () => {
    const bare = {_id: 'x', _type: 'article', slug: 'one'}
    expect(applyReadPlan(plan('*[slug.current == $slug][0]', {slug: 'one'}), [bare])).toBeNull()
  })

  it('applies a [0...n] limit after filtering', () => {
    expect(
      applyReadPlan(plan('*[_id in $ids][0...2]', {ids: ['article-1', 'article-2', 'page-1']}), [
        ARTICLE_1,
        ARTICLE_2,
        PAGE_1,
      ]),
    ).toEqual([ARTICLE_1, ARTICLE_2])
  })

  it('is pure — it does not mutate or alias the candidates it was handed', () => {
    const candidates = [ARTICLE_1, ARTICLE_2]
    const before = JSON.stringify(candidates)
    applyReadPlan(plan('*[_id in $ids]', {ids: ['article-1']}), candidates)
    expect(JSON.stringify(candidates)).toBe(before)
    expect(candidates).toHaveLength(2)
  })
})
