/**
 * `sanity-overlay-query` — failure policy and diagnostics.
 *
 * PRD §22.9 gives a code and an HTTP status for every way a query can fail to
 * be exact. PRD §22.2 `[MUST]` "Return `UNSUPPORTED_GROQ` when exactness cannot
 * be proven" and "Never silently fall back to patching an already filtered or
 * sliced result". PRD §5.5 makes "No silent query approximation" a quality
 * target. §22.8 fixes the diagnostics shape.
 *
 * Every test here asserts that a query which cannot be answered exactly
 * PRODUCES NO RESULT AT ALL. A returned value with a warning attached would
 * satisfy a weaker reading and is exactly what §22.2 forbids, so the assertions
 * are written as "rejects", never as "reports".
 */
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  OverlayQueryError,
  createMemoryBaseSource,
  createQueryRegistry,
  defineOverlayQuery,
  emptyOverlaySource,
  evaluateOverlayQuery,
  planCandidateRequests,
  queryTextChecksum,
} from '../../sanity-overlay-query/src/index'
import type {
  OverlayQueryDefinition,
  OverlaySource,
  QueryBaseSource,
  QueryDocument,
} from '../../sanity-overlay-query/src/index'
import {M_LOCAL_PARITY_OVERLAYS} from '../../sanity-overlay-query/parity/index'
import {loadFixtureDataset, publishedPerspective} from '../src/fixtures'

const base = publishedPerspective(loadFixtureDataset())
const registry = createQueryRegistry(M_LOCAL_QUERIES)
const source = createMemoryBaseSource(base)

interface RunOptions {
  registry?: ReturnType<typeof createQueryRegistry>
  queryId: string
  query?: string
  params?: Record<string, unknown>
  overlay?: OverlaySource
  caller?: 'frontend' | 'studio' | 'agent' | 'test'
  perspective?: 'published' | 'drafts' | 'raw'
  base?: QueryBaseSource
  measureBytes?: boolean
}

const run = <T = unknown>(options: RunOptions) =>
  evaluateOverlayQuery<T>({
    registry: options.registry ?? registry,
    queryId: options.queryId,
    query: options.query,
    params: options.params ?? {},
    base: options.base ?? source,
    overlay: options.overlay ?? emptyOverlaySource(),
    caller: options.caller ?? 'test',
    perspective: options.perspective ?? 'published',
    measureBytes: options.measureBytes,
  })

/** Assert a rejection carries the given §22.9 code, and produced no result. */
async function rejectsWith(code: string, status: number, promise: Promise<unknown>) {
  let thrown: unknown
  let resolved = false
  try {
    await promise
    resolved = true
  } catch (error) {
    thrown = error
  }
  expect(resolved, `expected ${code}, but the query returned a result`).toBe(false)
  expect(thrown).toBeInstanceOf(OverlayQueryError)
  const error = thrown as OverlayQueryError
  expect(error.code).toBe(code)
  expect(error.httpStatus).toBe(status)
  return error
}

/* ------------------------------------------------------------------ *
 * 1. Tier C: structural refusal, never approximation.
 * ------------------------------------------------------------------ */

describe('§22.2/§5.5: an unsupported query fails structurally', () => {
  it('the registered Tier C entry is rejected with UNSUPPORTED_GROQ', async () => {
    const error = await rejectsWith(
      'UNSUPPORTED_GROQ',
      422,
      run({queryId: 'unconstrained-star', caller: 'test'}),
    )
    expect(error.details.queryId).toBe('unconstrained-star')
  })

  it('the refusal survives every overlay fixture — it is never conditional on branch state', async () => {
    for (const [name, build] of Object.entries(M_LOCAL_PARITY_OVERLAYS)) {
      await rejectsWith(
        'UNSUPPORTED_GROQ',
        422,
        run({queryId: 'unconstrained-star', overlay: build(base), caller: 'test'}),
      ).catch((error) => {
        throw new Error(`overlay ${name}: ${String(error)}`)
      })
    }
  })

  it('a plan-less definition cannot be registered as a supported tier', () => {
    const query = `*[_type == "article"]{_id}`
    expect(() =>
      defineOverlayQuery({
        id: 'planless',
        description: 'no plan',
        query,
        queryChecksum: queryTextChecksum(query),
        allowedCallers: ['test'],
        perspectives: ['published'],
        candidatePlan: {type: 'none', reason: 'none'},
        systemTimestampPolicy: 'preserve-base',
        maxCandidates: 10,
        maxReferenceDepth: 1,
        status: 'tier-a',
      }),
    ).toThrowError(expect.objectContaining({code: 'UNSUPPORTED_GROQ'}))
  })

  it('planning refuses a missing ID parameter instead of widening the candidate set', () => {
    // The dangerous failure mode is "no id supplied, so fetch everything".
    expect(() => planCandidateRequests(registry.get('article-by-id'), {})).toThrowError(
      expect.objectContaining({code: 'UNSUPPORTED_GROQ'}),
    )
    expect(() =>
      planCandidateRequests(registry.get('article-by-id'), {id: null}),
    ).toThrowError(expect.objectContaining({code: 'UNSUPPORTED_GROQ'}))
    expect(() => planCandidateRequests(registry.get('page-by-slug'), {})).toThrowError(
      expect.objectContaining({code: 'UNSUPPORTED_GROQ'}),
    )
  })
})

/* ------------------------------------------------------------------ *
 * 2. Registration failures at call time.
 * ------------------------------------------------------------------ */

describe('§22.9: registration failures', () => {
  it('an unregistered id is QUERY_NOT_REGISTERED', async () => {
    await rejectsWith('QUERY_NOT_REGISTERED', 422, run({queryId: 'not-a-query'}))
  })

  it('drifted caller query text is QUERY_CHANGED', async () => {
    await rejectsWith(
      'QUERY_CHANGED',
      422,
      run({queryId: 'article-by-id', query: `*[_id == $id][0]{title}`, params: {id: 'article-01'}}),
    )
  })

  it('a caller outside allowedCallers is rejected', async () => {
    await rejectsWith(
      'QUERY_CALLER_NOT_ALLOWED',
      403,
      run({queryId: 'unconstrained-star', caller: 'frontend'}),
    )
  })

  it('a perspective outside the registration is rejected', async () => {
    await rejectsWith(
      'QUERY_PERSPECTIVE_NOT_REGISTERED',
      422,
      run({queryId: 'article-by-id', params: {id: 'article-01'}, perspective: 'raw'}),
    )
  })
})

/* ------------------------------------------------------------------ *
 * 3. Capacity and depth limits.
 * ------------------------------------------------------------------ */

const withOverrides = (
  id: string,
  overrides: Partial<OverlayQueryDefinition>,
): OverlayQueryDefinition => ({...registry.get(id), ...overrides})

describe('§22.9: capacity and depth', () => {
  it('exceeding maxCandidates is CANDIDATE_LIMIT_EXCEEDED with status 413', async () => {
    const tight = withOverrides('article-type-list', {maxCandidates: 5})
    const error = await rejectsWith(
      'CANDIDATE_LIMIT_EXCEEDED',
      413,
      run({registry: createQueryRegistry([tight]), queryId: 'article-type-list'}),
    )
    expect(error.details.maxCandidates).toBe(5)
    expect(Number(error.details.candidateCount)).toBeGreaterThan(5)
  })

  it('a chained dereference beyond maxReferenceDepth is REFERENCE_DEPTH_EXCEEDED', async () => {
    // article-05 -> author-1 -> favoriteArticle -> article-01 -> author-2.
    const query = `*[_id == $id][0]{title, author->{name, favoriteArticle->{title}}}`
    const shallow = defineOverlayQuery({
      id: 'chained-deref',
      description: 'two dereference levels',
      query,
      queryChecksum: queryTextChecksum(query),
      allowedCallers: ['test'],
      perspectives: ['published'],
      candidatePlan: {type: 'ids', idsFromParams: ['id']},
      systemTimestampPolicy: 'preserve-base',
      maxCandidates: 64,
      maxReferenceDepth: 1,
      status: 'tier-a',
    })
    await rejectsWith(
      'REFERENCE_DEPTH_EXCEEDED',
      422,
      run({
        registry: createQueryRegistry([shallow]),
        queryId: 'chained-deref',
        params: {id: 'article-05'},
      }),
    )
  })

  it('the same query succeeds once the registered depth covers the chain', async () => {
    const query = `*[_id == $id][0]{title, author->{name, favoriteArticle->{title}}}`
    const deep = defineOverlayQuery({
      id: 'chained-deref',
      description: 'two dereference levels',
      query,
      queryChecksum: queryTextChecksum(query),
      allowedCallers: ['test'],
      perspectives: ['published'],
      candidatePlan: {type: 'ids', idsFromParams: ['id']},
      systemTimestampPolicy: 'preserve-base',
      maxCandidates: 64,
      maxReferenceDepth: 4,
      status: 'tier-a',
    })
    const {result, diagnostics} = await run<{author: {favoriteArticle: {title: string}}}>({
      registry: createQueryRegistry([deep]),
      queryId: 'chained-deref',
      params: {id: 'article-05'},
    })
    expect(result.author.favoriteArticle.title).toBe('Article 1')
    expect(diagnostics.referenceDepth).toBeGreaterThanOrEqual(2)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Parse and evaluation failures.
 * ------------------------------------------------------------------ */

describe('§22.9: parse and evaluation failures', () => {
  it('unparseable registered text is INVALID_GROQ with status 400', async () => {
    const query = `*[_id == ]{`
    const broken = defineOverlayQuery({
      id: 'broken-groq',
      description: 'does not parse',
      query,
      queryChecksum: queryTextChecksum(query),
      allowedCallers: ['test'],
      perspectives: ['published'],
      candidatePlan: {type: 'ids-literal', ids: ['article-01']},
      systemTimestampPolicy: 'preserve-base',
      maxCandidates: 8,
      maxReferenceDepth: 1,
      status: 'tier-a',
    })
    await rejectsWith(
      'INVALID_GROQ',
      400,
      run({registry: createQueryRegistry([broken]), queryId: 'broken-groq'}),
    )
  })

  it('an evaluator failure is GROQ_EVALUATION_FAILED with status 500', async () => {
    // A document whose field access throws models a local evaluator failure
    // without needing an unparseable query.
    const hostile: QueryBaseSource = {
      async fetchCandidates() {
        const doc = {_id: 'article-01', _type: 'article', tags: []} as QueryDocument
        Object.defineProperty(doc, 'title', {
          enumerable: true,
          get() {
            throw new Error('exploding field')
          },
        })
        return [doc]
      },
    }
    await rejectsWith(
      'GROQ_EVALUATION_FAILED',
      500,
      run({queryId: 'article-by-id', params: {id: 'article-01'}, base: hostile}),
    )
  })
})

/* ------------------------------------------------------------------ *
 * 5. §22.8 diagnostics shape and content.
 * ------------------------------------------------------------------ */

describe('§22.8: diagnostics', () => {
  it('carry every documented field', async () => {
    const {diagnostics} = await run({queryId: 'article-by-id', params: {id: 'article-01'}})
    expect(Object.keys(diagnostics).sort()).toEqual(
      [
        'baseFetchDocuments',
        'baseRequestCount',
        'candidateBytes',
        'candidateCount',
        'candidateIds',
        'conflictsTouched',
        'durationMs',
        'evaluatorInvocations',
        'exact',
        'planSelectedCount',
        'queryId',
        'referenceDepth',
        'referenceExpansions',
        'unsupportedFeatures',
      ].sort(),
    )
    expect(diagnostics.queryId).toBe('article-by-id')
    expect(diagnostics.exact).toBe(true)
    expect(diagnostics.unsupportedFeatures).toEqual([])
  })

  it('report zero reference expansion for a query that dereferences nothing', async () => {
    const {diagnostics} = await run({queryId: 'article-by-id', params: {id: 'article-01'}})
    // article-01 references author-2. A planner that expanded every reference
    // regardless of the projection would report 1 or more here, and would
    // transfer documents the query can never observe (§22.6 step 8).
    expect(diagnostics.referenceExpansions).toBe(0)
    expect(diagnostics.referenceDepth).toBe(0)
    expect(diagnostics.candidateIds).toEqual(['article-01'])
  })

  it('report the expansion a query that DOES dereference performs', async () => {
    const {diagnostics} = await run({queryId: 'article-with-author', params: {id: 'article-01'}})
    expect(diagnostics.candidateIds).toEqual(['article-01', 'author-2'])
    expect(diagnostics.referenceExpansions).toBe(1)
    expect(diagnostics.referenceDepth).toBe(1)
  })

  it('measure candidate bytes only when asked', async () => {
    const off = await run({queryId: 'article-by-id', params: {id: 'article-01'}})
    const on = await run({queryId: 'article-by-id', params: {id: 'article-01'}, measureBytes: true})
    expect(off.diagnostics.candidateBytes).toBe(0)
    expect(on.diagnostics.candidateBytes).toBeGreaterThan(0)
  })

  it('report the conflicted documents a query touched', async () => {
    const overlay: OverlaySource = {
      documents: new Map(),
      tombstones: new Set(),
      conflicts: new Set(['article-01', 'article-99']),
    }
    const {diagnostics} = await run({
      queryId: 'article-by-id',
      params: {id: 'article-01'},
      overlay,
    })
    expect(diagnostics.conflictsTouched).toEqual(['article-01'])
  })

  it('emit durationMs as evidence, never as a gate', async () => {
    const {diagnostics} = await run({queryId: 'article-by-id', params: {id: 'article-01'}})
    expect(typeof diagnostics.durationMs).toBe('number')
    expect(diagnostics.durationMs).toBeGreaterThanOrEqual(0)
  })
})
