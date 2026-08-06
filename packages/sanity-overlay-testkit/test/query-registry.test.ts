/**
 * `sanity-overlay-query` — registry model (PRD §22.4, §22.5, §22.9).
 *
 * The `[M-LOCAL]` slice (PRD §37 Phase 2 "Minimal Studio and query slice",
 * roadmap §5.3): a REDUCED registry containing only the ID and slug lookup
 * entries plus parity fixtures. The full audited corpus, the codemod and the
 * lint rule stay in PRD §37 Phase 5.
 *
 * Independence of the oracles used here:
 *
 * - The registered checksum is verified against `node:crypto`'s SHA-256, not
 *   against the package's own hash function. If both were the package's, the
 *   assertion would only prove the package agrees with itself.
 * - The inventory pins (id set, tier split, plan-kind split) are hand-written
 *   from PRD §22.3 / §37 Phase 2, so deleting or downgrading an entry is a
 *   test failure rather than a silent scope reduction. That defect is exactly
 *   what the Spike C evidence review found ("the registry was self-certifying").
 */
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  OverlayQueryError,
  createQueryRegistry,
  defineOverlayQuery,
  planCandidateRequests,
  queryTextChecksum,
} from '../../sanity-overlay-query/src/index'
import type {CandidatePlan} from '../../sanity-overlay-query/src/index'

/** Independent oracle: Node's own SHA-256, never the package's implementation. */
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const registry = createQueryRegistry(M_LOCAL_QUERIES)

/* ------------------------------------------------------------------ *
 * 1. Inventory — pinned by hand, so the registry cannot self-certify.
 * ------------------------------------------------------------------ */

describe('§37 Phase 2: the [M-LOCAL] reduced registry inventory is pinned', () => {
  it('contains exactly the registered ids', () => {
    expect(M_LOCAL_QUERIES.map((d) => d.id).sort()).toEqual([
      'article-body-text',
      'article-by-id',
      'article-by-slug',
      'article-by-slug-with-author',
      'article-object-spread',
      'article-type-list',
      'article-with-author',
      'articles-by-tag',
      'articles-ordered-sliced',
      'articles-recent-headlines',
      'articles-referencing-author',
      'multi-type-list',
      'page-by-slug',
      'page-featured-refs',
      'unconstrained-star',
    ])
  })

  /**
   * The corpus this registry is being grown towards is the Spike C inventory
   * (`docs/plans/evidence/phase-1/spike-c-groq-corpus/report.md`). Three of its
   * shapes are deliberately ABSENT rather than registered:
   *
   *   - `article-count` / `stats-aggregate` — aggregate pushdown.
   *   - `articles-by-author-name` — §22.6 step 10 reverse-reference expansion.
   *
   * UPDATED 2026-08-06. The original reason for the absence was that this
   * package had no planner for any of the three, so registering one would have
   * claimed an exactness the candidate plan could not deliver. That reason is
   * GONE: both plans now exist (`planner.ts`, `evaluate.ts`), are served by the
   * memory base source, and are proven exact against a full-dataset oracle
   * across every parity overlay in `query-pushdown.test.ts`.
   *
   * What still keeps them out is §22.5, not §22.6: registering a query also
   * pins a parity FIXTURE and a `maxCandidates`, and for the reverse-reference
   * shape that limit is a branch blast-radius number nobody has ratified (see
   * `latency-2026-08-04.md` §1.1, still open). So the absence is now a
   * REGISTRATION decision rather than a capability gap, and the assertion below
   * pins both halves — the queries stay out, and the planners stay in, so the
   * two cannot drift apart silently.
   */
  it('the three known-hard Spike C shapes are absent, not registered', () => {
    const registered = new Set(M_LOCAL_QUERIES.map((d) => d.id))
    for (const id of ['article-count', 'stats-aggregate', 'articles-by-author-name']) {
      expect(registered.has(id), `${id} must not be registered without its planner`).toBe(false)
    }
    // Stated as query SHAPES too, so renaming the entry does not smuggle it in.
    const texts = M_LOCAL_QUERIES.map((d) => d.query)
    for (const shape of ['count(', 'math::sum(', '->name ==', '->name==']) {
      expect(
        texts.filter((t) => t.includes(shape)),
        `no registered query may contain ${shape}`,
      ).toEqual([])
    }
  })

  /**
   * The other half of the pin above. If a future change deletes the pushdown
   * planners, the absence assertion would keep passing while the stated reason
   * for it silently reverted to "no planner exists". This makes the planners'
   * existence executable, so the two facts move together.
   */
  it('the pushdown planners the absent shapes need DO exist and are exercised', () => {
    const plans: CandidatePlan[] = [
      {type: 'aggregate', aggregate: 'count', types: ['article']},
      {
        type: 'reverse-reference',
        types: ['article'],
        referencePath: ['author'],
        targetPath: ['name'],
        valueFromParam: 'name',
      },
    ]
    for (const candidatePlan of plans) {
      const def = {...M_LOCAL_QUERIES[0], id: `probe-${candidatePlan.type}`, candidatePlan}
      const requests = planCandidateRequests(def, {name: 'Author 2'}, {affectedIds: ['author-2']})
      // A real plan, not the unknown-plan refusal: it asks the base for
      // something, and it admits the branch records of its type (§22.6 step 6).
      expect(
        requests.aggregateRequest !== undefined || requests.extendedRequests.length > 0,
        candidatePlan.type,
      ).toBe(true)
      expect(requests.overlayTypes, candidatePlan.type).toEqual(['article'])
    }
  })

  it('every id is unique', () => {
    expect(new Set(M_LOCAL_QUERIES.map((d) => d.id)).size).toBe(M_LOCAL_QUERIES.length)
  })

  it('the tier split is pinned (a downgrade must be deliberate)', () => {
    const of = (status: string) =>
      M_LOCAL_QUERIES.filter((d) => d.status === status)
        .map((d) => d.id)
        .sort()
    expect(of('tier-a')).toEqual([
      'article-body-text',
      'article-by-id',
      'article-by-slug',
      'article-by-slug-with-author',
      'article-object-spread',
      'article-type-list',
      'article-with-author',
      'articles-by-tag',
      'articles-ordered-sliced',
      'articles-recent-headlines',
      'articles-referencing-author',
      'multi-type-list',
      'page-by-slug',
      'page-featured-refs',
    ])
    // §22.3 Tier C: unconstrained `*` without a finite candidate plan. Kept in
    // the registry deliberately so "must fail structurally" is executable.
    expect(of('unsupported')).toEqual(['unconstrained-star'])
    // Still no Tier B entry: every registered shape has a candidate plan that
    // is bounded by the query's own semantics. The Spike C Tier B shapes are
    // absent (see above), not downgraded into this registry.
    expect(of('tier-b')).toEqual([])
  })

  it('the candidate-plan kinds are pinned to the [M-LOCAL] planners', () => {
    const of = (kind: string) =>
      M_LOCAL_QUERIES.filter((d) => d.candidatePlan.type === kind)
        .map((d) => d.id)
        .sort()
    expect(of('ids')).toEqual([
      'article-body-text',
      'article-by-id',
      'article-object-spread',
      'article-with-author',
    ])
    expect(of('ids-literal')).toEqual(['page-featured-refs'])
    expect(of('slug')).toEqual([
      'article-by-slug',
      'article-by-slug-with-author',
      'page-by-slug',
    ])
    expect(of('types')).toEqual(['article-type-list', 'multi-type-list'])
    expect(of('field-contains')).toEqual(['articles-by-tag'])
    expect(of('references')).toEqual(['articles-referencing-author'])
    expect(of('top-k')).toEqual(['articles-ordered-sliced', 'articles-recent-headlines'])
    expect(of('none')).toEqual(['unconstrained-star'])
  })

  /**
   * §22.6's bounded top-K rule is stated over a slice with an exclusive end.
   * The registration carries `sliceEnd`; the QUERY carries `[0...K]`. If those
   * two disagree the plan fetches the wrong number of documents and the
   * boundedness ceiling (which is parsed from the query text) is meaningless,
   * so the agreement is asserted rather than assumed.
   */
  it('every top-k registration agrees with the slice in its own query text', () => {
    const topK = M_LOCAL_QUERIES.filter((d) => d.candidatePlan.type === 'top-k')
    expect(topK.length).toBeGreaterThan(0)
    for (const def of topK) {
      const plan = def.candidatePlan
      if (plan.type !== 'top-k') throw new Error('unreachable')
      const match = def.query.match(/\[\s*0\s*\.\.\.\s*(\d+)\s*\]/)
      expect(match, `${def.id}: a top-k registration needs a [0...K] slice`).toBeTruthy()
      expect(plan.sliceEnd, `${def.id}: registered sliceEnd`).toBe(Number(match![1]))
      expect(plan.order.length, `${def.id}: an ordered slice needs an order`).toBeGreaterThan(0)
      for (const term of plan.order) {
        expect(['asc', 'desc']).toContain(term.direction)
      }
    }
  })

  it('every supported entry carries limits, a parity fixture and a timestamp policy', () => {
    for (const def of M_LOCAL_QUERIES) {
      if (def.status === 'unsupported') continue
      expect(def.maxCandidates, def.id).toBeGreaterThan(0)
      expect(def.maxReferenceDepth, def.id).toBeGreaterThan(0)
      expect(def.parityFixture, def.id).toBeTruthy()
      expect(def.systemTimestampPolicy, def.id).toBe('preserve-base')
      expect(def.perspectives.length, def.id).toBeGreaterThan(0)
      expect(def.allowedCallers.length, def.id).toBeGreaterThan(0)
      expect(def.description.length, def.id).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 2. Registered checksum (§22.5 "query text is version controlled",
 *    §22.9 `QUERY_CHANGED`).
 * ------------------------------------------------------------------ */

describe('§22.5: the registered checksum is a pinned artifact', () => {
  it('every registered checksum is SHA-256 of the query text, per node:crypto', () => {
    for (const def of M_LOCAL_QUERIES) {
      expect(def.queryChecksum, def.id).toBe(sha256(def.query))
    }
  })

  it('queryTextChecksum agrees with node:crypto', () => {
    expect(queryTextChecksum('*[_id == $id][0]')).toBe(sha256('*[_id == $id][0]'))
  })

  it('registering a definition whose checksum does not match its text is QUERY_CHANGED', () => {
    expect(() =>
      defineOverlayQuery({
        id: 'tampered',
        description: 'tampered',
        query: '*[_id == $id][0]',
        queryChecksum: sha256('*[_id == $other][0]'),
        allowedCallers: ['test'],
        perspectives: ['published'],
        candidatePlan: {type: 'ids', idsFromParams: ['id']},
        systemTimestampPolicy: 'preserve-base',
        maxCandidates: 32,
        maxReferenceDepth: 3,
        status: 'tier-a',
        parityFixture: 'empty',
      }),
    ).toThrowError(
      expect.objectContaining({code: 'QUERY_CHANGED'}),
    )
  })

  // Redundancy at the second entry point, added because a mutation audit found
  // checksum enforcement was killed by exactly one test. `defineOverlayQuery`
  // and `createQueryRegistry` are both public, and a registry assembled from
  // raw objects must not bypass the check.
  it('a tampered entry is rejected when the registry is constructed, not only when defined', () => {
    const tampered = {
      ...registry.get('article-by-slug'),
      query: '*[_type == "article"]{_id}',
    }
    expect(() => createQueryRegistry([tampered])).toThrowError(
      expect.objectContaining({code: 'QUERY_CHANGED'}),
    )
  })

  it('resolving with query text that differs from the registration is QUERY_CHANGED', () => {
    expect(() => registry.resolve('article-by-id', '*[_id == $id][0]{title}')).toThrowError(
      expect.objectContaining({code: 'QUERY_CHANGED'}),
    )
  })

  it('resolving with the exact registered text succeeds', () => {
    const def = registry.get('article-by-id')
    expect(registry.resolve('article-by-id', def.query)).toBe(def)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Unregistered queries (§22.5, §22.9 `QUERY_NOT_REGISTERED`).
 * ------------------------------------------------------------------ */

describe('§22.9: unregistered queries are rejected, never approximated', () => {
  it('an unknown query id is QUERY_NOT_REGISTERED', () => {
    expect(() => registry.get('no-such-query')).toThrowError(
      expect.objectContaining({code: 'QUERY_NOT_REGISTERED'}),
    )
  })

  it('the error is an OverlayQueryError carrying the id and a serializable form', () => {
    try {
      registry.get('no-such-query')
      expect.unreachable('registry.get must throw for an unregistered id')
    } catch (error) {
      expect(error).toBeInstanceOf(OverlayQueryError)
      const e = error as OverlayQueryError
      expect(e.code).toBe('QUERY_NOT_REGISTERED')
      expect(e.httpStatus).toBe(422)
      expect(e.details.queryId).toBe('no-such-query')
      expect(JSON.parse(JSON.stringify(e))).toMatchObject({
        code: 'QUERY_NOT_REGISTERED',
        httpStatus: 422,
      })
    }
  })

  it('has() reports membership without throwing', () => {
    expect(registry.has('article-by-id')).toBe(true)
    expect(registry.has('no-such-query')).toBe(false)
  })

  it('a duplicate id is rejected at registry construction', () => {
    const one = registry.get('article-by-id')
    expect(() => createQueryRegistry([one, one])).toThrowError(/duplicate/i)
  })
})

/* ------------------------------------------------------------------ *
 * 4. The §22.9 error-code table is complete and each code has one status.
 * ------------------------------------------------------------------ */

describe('§22.9: the error table is implemented in full', () => {
  it('every code in the PRD table maps to its documented HTTP status', () => {
    const expected: Record<string, number> = {
      QUERY_NOT_REGISTERED: 422,
      QUERY_CHANGED: 422,
      UNSUPPORTED_GROQ: 422,
      CANDIDATE_LIMIT_EXCEEDED: 413,
      REFERENCE_DEPTH_EXCEEDED: 422,
      INVALID_GROQ: 400,
      GROQ_EVALUATION_FAILED: 500,
    }
    for (const [code, status] of Object.entries(expected)) {
      expect(new OverlayQueryError(code as never, 'x').httpStatus, code).toBe(status)
    }
  })
})
