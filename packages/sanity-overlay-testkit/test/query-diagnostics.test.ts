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
import {spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
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

/**
 * Every parameter any registered query names, in one bag. Passing a superset is
 * safe — a plan reads only the parameters it registered — and it lets a test
 * sweep the whole registry without a per-query table to keep in sync.
 */
const PLANNABLE_PARAMS: Record<string, unknown> = {
  id: 'article-01',
  slug: 'article-7',
  tag: 'odd',
  authorId: 'author-2',
}

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

  it('every parameterised plan refuses an absent parameter — the whole family, not one member', () => {
    // Stated as a sweep because the failure mode ("nothing supplied, so fetch
    // everything") belongs to the plan KIND, not to any one registration.
    const missing: Array<[string, Record<string, unknown>]> = [
      ['article-by-id', {}],
      ['article-object-spread', {}],
      ['article-body-text', {}],
      ['article-with-author', {}],
      ['page-by-slug', {}],
      ['article-by-slug', {}],
      ['article-by-slug-with-author', {}],
      ['articles-by-tag', {}],
      ['articles-referencing-author', {}],
    ]
    for (const [id, params] of missing) {
      expect(() =>
        planCandidateRequests(registry.get(id), params, {affectedIds: []}),
        `${id} must refuse an absent parameter`,
      ).toThrowError(expect.objectContaining({code: 'UNSUPPORTED_GROQ'}))
    }
  })

  it('references() planning refuses anything that is not a finite document ID', () => {
    // §22.3 admits `references()` for FINITE ids. A null, a number or an array
    // has no finite base request, and guessing one would be an approximation.
    for (const authorId of [null, 42, [], {}, '']) {
      expect(() =>
        planCandidateRequests(registry.get('articles-referencing-author'), {authorId}),
        `authorId=${JSON.stringify(authorId)}`,
      ).toThrowError(expect.objectContaining({code: 'UNSUPPORTED_GROQ'}))
    }
  })

  it('a top-K plan refuses to be planned without the branch delta', () => {
    // §22.6's base fetch is defined in terms of the affected count. Defaulting
    // it to "nothing was touched" would silently under-fetch on every branch.
    expect(() => planCandidateRequests(registry.get('articles-ordered-sliced'), {})).toThrowError(
      expect.objectContaining({code: 'UNSUPPORTED_GROQ'}),
    )
  })

  it('a base adapter that cannot serve a planned fetch refuses, and does not degrade to a scan', async () => {
    // The predicate and ordered-slice plans need base capabilities beyond the
    // three original request shapes. An adapter that lacks them must fail with
    // the §22.9 code, because the tempting fallback — "ask for the type and
    // filter locally" — is exactly the over-fetch §22.6 exists to prevent, and
    // it would be invisible in every parity test.
    //
    // `coreOnly` implements the ORIGINAL port and nothing else. It is not a
    // hypothetical: `sanity-overlay-client/src/base.ts` is exactly this shape.
    const coreOnly: QueryBaseSource = {
      async fetchCandidates() {
        return []
      },
    }
    for (const [queryId, params] of [
      ['articles-by-tag', {tag: 'odd'}],
      ['articles-referencing-author', {authorId: 'author-2'}],
      ['articles-ordered-sliced', {}],
    ] as const) {
      const error = await rejectsWith(
        'UNSUPPORTED_GROQ',
        422,
        run({queryId, params, base: coreOnly}),
      )
      expect(error.message, queryId).toMatch(/base/i)
      // The refusal must name the shape the adapter lacked, or the operator
      // cannot tell which capability to implement.
      expect(error.details.requestKind, queryId).toBeTypeOf('string')
    }
    // The same queries succeed against an adapter that DOES serve them, so the
    // refusal above is about the adapter and not about the registration.
    const {result} = await run<Array<{_id: string}>>({
      queryId: 'articles-by-tag',
      params: {tag: 'odd'},
    })
    expect(result.length).toBeGreaterThan(0)
  })

  it('a top-K base request asks for K documents and excludes every touched ID', () => {
    const plan = planCandidateRequests(
      registry.get('articles-ordered-sliced'),
      {},
      {affectedIds: ['article-01', 'article-02']},
    )
    // The top-K fetch is an EXTENDED shape, so it must not appear in the core
    // `baseRequests` array — an adapter reading only that array would otherwise
    // silently issue no fetch at all and return an empty top-K.
    expect(plan.baseRequests).toHaveLength(0)
    expect(plan.extendedRequests).toHaveLength(1)
    const request = plan.extendedRequests[0]
    if (request.kind !== 'order-slice') throw new Error(`expected order-slice, got ${request.kind}`)
    expect(request.limit).toBe(20)
    expect(request.order).toEqual([{field: 'publishedAt', direction: 'desc'}])
    expect([...request.excludeIds].sort()).toEqual(['article-01', 'article-02'])
    // The branch records themselves still have to join the candidate set, or
    // excluding them from the base fetch would LOSE them (§22.6 step 6).
    expect(plan.overlayTypes).toEqual(['article'])
  })
})

/* ------------------------------------------------------------------ *
 * 1b. Port compatibility — the blast radius of a widened request union.
 *
 * `BaseCandidateRequest` is a discriminated union that TWO adapters outside
 * this package switch over exhaustively, each closing with
 * `const exhaustive: never = request`:
 *
 *   packages/sanity-overlay-client/src/base.ts   (the hosted HTTP adapter)
 *   examples/kitchen-sink/spikeA/readQueries.ts  (the spike's in-memory one)
 *
 * That pattern makes ADDING a member to the union a compile error in both
 * files. Neither is owned by this package, and CI's typecheck job
 * (.github/workflows/ci.yml) is disabled pending a specific, enumerated list
 * of remaining errors — silently adding two more would push that gate further
 * away rather than closer.
 *
 * So the new §22.6 request shapes are additive: the core union keeps exactly
 * its three original members, extended shapes live in their own union, and an
 * adapter serves them through an OPTIONAL method. An adapter that does not
 * implement it refuses (the test above) instead of over-fetching.
 *
 * The oracle below is the TypeScript compiler itself, not a reading of the
 * source: it compiles a core-only adapter and requires the exhaustiveness
 * check to hold. Nothing else in the suite would catch the regression, because
 * vitest does not typecheck.
 * ------------------------------------------------------------------ */

describe('§10.1: the core base-source port stays compatible with existing adapters', () => {
  const QUERY_SRC = fileURLToPath(new URL('../../sanity-overlay-query/src/index.ts', import.meta.url))
  const TSC = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url))

  /** Typecheck one throwaway module against the real package types. */
  function typecheck(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'query-port-'))
    try {
      const file = join(dir, 'adapter.ts')
      writeFileSync(file, source)
      const result = spawnSync(
        TSC,
        [
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'bundler',
          '--skipLibCheck',
          file,
        ],
        {encoding: 'utf8'},
      )
      if (result.error) throw result.error
      return `${result.stdout ?? ''}${result.stderr ?? ''}`
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  }

  it(
    'an adapter that handles the three original request kinds is still exhaustive',
    {timeout: 60_000},
    () => {
      // Character-for-character the shape of `sanity-overlay-client/src/base.ts`
      // and of spikeA's `createCandidateSource`. If this stops compiling, both
      // of those files have stopped compiling too.
      const output = typecheck(
        `import type {QueryBaseSource} from ${JSON.stringify(QUERY_SRC)}\n` +
          `export const coreOnly: QueryBaseSource = {\n` +
          `  async fetchCandidates(request) {\n` +
          `    switch (request.kind) {\n` +
          `      case 'ids':\n` +
          `      case 'types':\n` +
          `      case 'field-equality':\n` +
          `        return []\n` +
          `      default: {\n` +
          `        const exhaustive: never = request\n` +
          `        throw new Error(String(exhaustive))\n` +
          `      }\n` +
          `    }\n` +
          `  },\n` +
          `}\n`,
      )
      expect(output, 'a core-only adapter must still typecheck').toBe('')
    },
  )

  it(
    'the same check is not vacuous: an adapter missing one core kind fails to compile',
    {timeout: 60_000},
    () => {
      // Drop `field-equality` and the exhaustiveness check must go red. Without
      // this, the test above would pass even if `never` had stopped meaning
      // anything (e.g. if the port were typed `any`).
      const output = typecheck(
        `import type {QueryBaseSource} from ${JSON.stringify(QUERY_SRC)}\n` +
          `export const partial: QueryBaseSource = {\n` +
          `  async fetchCandidates(request) {\n` +
          `    switch (request.kind) {\n` +
          `      case 'ids':\n` +
          `      case 'types':\n` +
          `        return []\n` +
          `      default: {\n` +
          `        const exhaustive: never = request\n` +
          `        throw new Error(String(exhaustive))\n` +
          `      }\n` +
          `    }\n` +
          `  },\n` +
          `}\n`,
      )
      expect(output).toMatch(/not assignable to type 'never'/)
      expect(output).toMatch(/field-equality/)
    },
  )

  it('the extended shapes are reachable through the optional capability', () => {
    // The planner must be able to emit them, or the additive split would just
    // be a way of never using the new shapes at all.
    const kinds = M_LOCAL_QUERIES.filter((d) => d.status !== 'unsupported').flatMap((def) => {
      try {
        return planCandidateRequests(def, PLANNABLE_PARAMS, {affectedIds: []}).extendedRequests.map(
          (r) => r.kind,
        )
      } catch {
        return []
      }
    })
    expect(new Set(kinds)).toEqual(new Set(['field-contains', 'references', 'order-slice']))
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
