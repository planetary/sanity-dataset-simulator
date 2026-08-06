/**
 * `sanity-overlay-query` — §22.6 boundedness, against an oracle derived from
 * query semantics and fixture data ONLY.
 *
 * ==========================================================================
 * WHY THIS FILE IS WRITTEN THE WAY IT IS
 *
 * Two findings from the Spike C evidence govern its design, and both are
 * reproduced here as executable guards rather than as prose:
 *
 * 1. `report.md` (correction notice, 2026-08-04). Parity against a
 *    full-dataset oracle detects UNDER-fetching and is mathematically
 *    incapable of detecting OVER-fetching: a planner that loaded the entire
 *    dataset passed 463 parity tests, and 178 of 179 parity assertions still
 *    passed under a deliberately unbounded planner. Parity is therefore never
 *    boundedness evidence.
 *
 * 2. `boundedness-2026-08-04.md` (finding F6). A ceiling that restates the
 *    implementation cannot falsify the implementation. The previous ceiling
 *    for slug queries WAS "every document of the candidate type", so
 *    `article-by-slug` scanned 30 documents to return 1 and passed.
 *
 * So every ceiling below comes from exactly two sources:
 *
 *   (a) THE QUERY TEXT. The filter is lifted out of the registered query by
 *       bracket matching and re-run through `groq-js` against BASE. That
 *       measures "how many documents a base that understands this predicate
 *       returns" — the exact optimum for the base half of any planner, read
 *       off the query, never off the plan.
 *   (b) THE FIXTURE DATA. The branch delta is counted from the overlay, and
 *       the answer size is measured through a whole-dataset oracle.
 *
 * Nothing in this file reads `def.candidatePlan`, and no constant is copied
 * from the planner. The base-fetch measurement does not even trust the
 * package's diagnostics: the base source is wrapped in a recorder owned by
 * this file, so what the planner actually pulled is observed independently
 * and the diagnostics are then checked AGAINST that observation.
 *
 * Non-vacuity is proven, not asserted: unbounded and type-scanning plans are
 * run through the REAL evaluator and are required to break these ceilings.
 * ==========================================================================
 */
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  createMemoryBaseSource,
  createQueryRegistry,
  evaluateOverlayQuery,
} from '../../sanity-overlay-query/src/index'
import type {
  BaseCandidateRequest,
  OverlayQueryDefinition,
  OverlayQueryDiagnostics,
  OverlaySource,
  QueryBaseSource,
  QueryDocument,
} from '../../sanity-overlay-query/src/index'
import {M_LOCAL_PARITY_OVERLAYS} from '../../sanity-overlay-query/parity/index'
import {type FixtureDocument, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'

const base = publishedPerspective(loadFixtureDataset())
const registry = createQueryRegistry(M_LOCAL_QUERIES)
const supported = M_LOCAL_QUERIES.filter((d) => d.status !== 'unsupported')

/* ================================================================== *
 * A. Facts read out of the QUERY TEXT.
 * ================================================================== */

/**
 * The source text of the query's top-level filter: everything between `*[`
 * and its matching `]`. Bracket-matched rather than regex-matched so that
 * `_type in ["article", "page"]` survives.
 */
function topLevelFilterSource(query: string): string {
  const start = query.indexOf('*[')
  if (start === -1) throw new Error(`no top-level filter in ${query}`)
  let depth = 0
  let quote: string | undefined
  for (let i = start + 1; i < query.length; i++) {
    const c = query[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return query.slice(start + 2, i)
    }
  }
  throw new Error(`unterminated top-level filter in ${query}`)
}

/** Document types the query's own filter constrains to. Read by hand from §22.3. */
function typesFromFilter(filter: string): string[] {
  const single = filter.match(/_type\s*==\s*"([^"]+)"/)
  if (single) return [single[1]]
  const many = filter.match(/_type\s+in\s*\[([^\]]*)\]/)
  if (many) return [...many[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  return []
}

/**
 * `K` — the exclusive end of the query's own `[0...K]` slice, read out of the
 * QUERY TEXT and never out of the registration. This is the whole point for an
 * ordered slice: §22.6's bounded top-K rule says the candidate set is `K` plus
 * the branch delta, so a ceiling built from `K` is a statement about the query
 * and a ceiling built from `def.candidatePlan.sliceEnd` would be a statement
 * about the planner. `article-by-id` ends in `[0]`, which is NOT a slice; the
 * pattern requires the `...` form so a lookup cannot be mistaken for one.
 */
function sliceEndFromQuery(query: string): number {
  const match = query.match(/\[\s*0\s*\.\.\.\s*(\d+)\s*\]/)
  if (!match) throw new Error(`no [0...K] slice in ${query}`)
  return Number(match[1])
}

/** True when the query text contains a dereference at all (§22.6 step 8). */
const dereferences = (query: string): boolean => query.includes('->')

/* ================================================================== *
 * B. Facts measured from the FIXTURE DATA.
 * ================================================================== */

/**
 * How many BASE documents satisfy the query's own filter. This is what a base
 * that understands the predicate returns, so it is simultaneously a lower
 * bound on what any exact planner must transfer and an upper bound on what it
 * may. Measured through `groq-js`, from the query's own text.
 */
async function baseMatches(
  dataset: readonly FixtureDocument[],
  query: string,
  params: Record<string, unknown>,
): Promise<number> {
  const filter = topLevelFilterSource(query)
  const rows = await runGroq<unknown[]>(`*[${filter}]{_id}`, dataset as FixtureDocument[], params)
  return rows.length
}

/** Branch records and tombstones that touch the types the query constrains to. */
function branchDelta(
  dataset: readonly FixtureDocument[],
  overlay: OverlaySource,
  types: readonly string[],
): number {
  if (types.length === 0) return overlay.documents.size + overlay.tombstones.size
  const baseType = new Map(dataset.map((d) => [d._id, d._type]))
  const touched = new Set<string>()
  for (const [id, doc] of overlay.documents) {
    if (types.includes(doc._type) || types.includes(baseType.get(id) ?? '')) touched.add(id)
  }
  for (const id of overlay.tombstones) {
    if (types.includes(baseType.get(id) ?? '')) touched.add(id)
  }
  return touched.size
}

/** Resolved virtual dataset — the oracle input, written longhand (§22.6). */
function resolvedVirtualDataset(
  dataset: readonly FixtureDocument[],
  overlay: OverlaySource,
): FixtureDocument[] {
  const out: FixtureDocument[] = []
  const seen = new Set<string>()
  for (const doc of dataset) {
    if (overlay.tombstones.has(doc._id)) continue
    out.push((overlay.documents.get(doc._id) as FixtureDocument | undefined) ?? doc)
    seen.add(doc._id)
  }
  for (const [id, doc] of overlay.documents) {
    if (!seen.has(id) && !overlay.tombstones.has(id)) out.push(doc as FixtureDocument)
  }
  return out
}

/** Size of the ANSWER, measured through the oracle — never through the plan. */
async function answerSize(
  def: OverlayQueryDefinition,
  dataset: readonly FixtureDocument[],
  overlay: OverlaySource,
  params: Record<string, unknown>,
): Promise<number> {
  const value = await runGroq(def.query, resolvedVirtualDataset(dataset, overlay), params)
  if (Array.isArray(value)) return value.length
  return value === null || value === undefined ? 0 : 1
}

/* ================================================================== *
 * C. Observing the planner WITHOUT trusting it.
 * ================================================================== */

interface Recording {
  readonly requests: BaseCandidateRequest[]
  readonly returned: number[]
  readonly source: QueryBaseSource
}

/**
 * Wrap a base source so this file measures what the planner actually pulled.
 * `diagnostics.baseFetchDocuments` is then checked against this, which is why
 * a planner cannot pass by under-reporting its own work.
 */
function recordingBaseSource(documents: readonly QueryDocument[]): Recording {
  const inner = createMemoryBaseSource(documents)
  const requests: BaseCandidateRequest[] = []
  const returned: number[] = []
  return {
    requests,
    returned,
    source: {
      async fetchCandidates(request) {
        requests.push(request)
        const result = await inner.fetchCandidates(request)
        returned.push(result.length)
        return result
      },
    },
  }
}

interface Observation {
  readonly diagnostics: OverlayQueryDiagnostics
  /** Documents the FIRST base request returned — the plan's own selection. */
  readonly planBaseDocuments: number
  /** Documents every base request returned, expansion included. */
  readonly totalBaseDocuments: number
  readonly requestCount: number
}

async function observe(
  def: OverlayQueryDefinition,
  dataset: readonly FixtureDocument[],
  overlay: OverlaySource,
  params: Record<string, unknown>,
  activeRegistry = registry,
): Promise<Observation> {
  const recording = recordingBaseSource(dataset)
  const {diagnostics} = await evaluateOverlayQuery({
    registry: activeRegistry,
    queryId: def.id,
    query: def.query,
    params,
    base: recording.source,
    overlay,
    caller: 'test',
    perspective: 'published',
  })
  return {
    diagnostics,
    planBaseDocuments: recording.returned[0] ?? 0,
    totalBaseDocuments: recording.returned.reduce((a, b) => a + b, 0),
    requestCount: recording.requests.length,
  }
}

/* ================================================================== *
 * D. The hand-written classification. `why` records the argument.
 * ================================================================== */

type BoundClass = 'constant' | 'result-proportional' | 'type-linear'

/**
 * Where the independent ceiling comes from. Each one is a fact about the QUERY,
 * never about the plan:
 *
 *   `base-match` — how many BASE documents the query's own filter selects.
 *   `slice-k`    — the `K` of the query's own `[0...K]` slice (§22.6 top-K).
 *   `answer`     — how many documents the whole-dataset oracle returns.
 */
type CeilingSource = 'base-match' | 'slice-k' | 'answer'

interface BoundSpec {
  readonly klass: BoundClass
  readonly ceiling: CeilingSource
  /**
   * Hand-written absolute cap on the TOTAL materialised set (reference
   * expansion included) for `constant` entries. Structural, not throughput
   * derived — Spike C latency evidence §5.1 — and asserted non-vacuous below:
   * a type scan must break it at 10x scale.
   */
  readonly cap?: number
  readonly why: string
}

const LOOKUP_TOTAL_CAP = 32

const BOUNDS: Record<string, BoundSpec> = {
  'article-by-id': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'One ID in, at most one document out. No planner can do better and none may do worse.',
  },
  'article-object-spread': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'One ID in, one document out. `{...}` widens the PROJECTION, not the candidate set.',
  },
  'article-body-text': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'One ID in, one document out. `pt::text` reads a field of that document and nothing else.',
  },
  'article-with-author': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'One ID plus the targets its projection dereferences; neither grows with the dataset.',
  },
  'page-featured-refs': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'One literal ID plus a fixed-length reference array.',
  },
  'page-by-slug': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'Slug equality reads a LOCAL field, so the base answers it exactly (§22.7); the branch delta covers what the base could not know.',
  },
  'article-by-slug': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'As page-by-slug. This is the query F6 caught scanning 30 documents to return 1.',
  },
  'article-by-slug-with-author': {
    klass: 'constant',
    ceiling: 'base-match',
    cap: LOOKUP_TOTAL_CAP,
    why: 'As article-by-slug, plus the dereferenced author.',
  },
  'articles-ordered-sliced': {
    klass: 'constant',
    ceiling: 'slice-k',
    /* K = 20 plus the branch delta. The overlay fixtures touch at most 5
     * articles, and a preview branch that touches more than 12 documents of one
     * type is outside the workflow §5.4 budgets. A type scan is 30 at 1x and
     * 300 at 10x, so this cap is nowhere near a scan. */
    cap: 32,
    why: '§22.6 bounded top-K: K untouched base documents plus the branch records that can enter, leave or reorder. K is a constant of the query, so the candidate set does not grow with the dataset.',
  },
  'articles-recent-headlines': {
    klass: 'constant',
    ceiling: 'slice-k',
    cap: 32,
    why: 'As articles-ordered-sliced with K = 5; the ordering field is read through a projection alias, which changes the projection and not the plan.',
  },
  'articles-by-tag': {
    klass: 'result-proportional',
    ceiling: 'answer',
    why: 'Array membership is a LOCAL predicate, so the base answers it exactly; the answer is every matching article, so no planner can materialise fewer.',
  },
  'articles-referencing-author': {
    klass: 'result-proportional',
    ceiling: 'answer',
    why: 'references() over a finite ID reads the REFERRER, so the base answers it exactly. Bounded by the referrer count, which is the answer.',
  },
  'article-type-list': {
    klass: 'result-proportional',
    ceiling: 'answer',
    why: 'The answer IS the type, so no planner can materialise fewer documents than it returns. Not constant, and not claimed to be.',
  },
  'multi-type-list': {
    klass: 'result-proportional',
    ceiling: 'answer',
    why: 'As article-type-list, across two types.',
  },
}

/* ================================================================== *
 * E. The matrix.
 * ================================================================== */

const PARAMS: Record<string, Record<string, unknown>> = {
  'article-by-id': {id: 'article-05'},
  'article-object-spread': {id: 'article-05'},
  'article-body-text': {id: 'article-01'},
  'article-with-author': {id: 'article-01'},
  'page-featured-refs': {},
  'page-by-slug': {slug: 'legacy-page'},
  'article-by-slug': {slug: 'article-7'},
  'article-by-slug-with-author': {slug: 'article-7'},
  'article-type-list': {},
  'multi-type-list': {},
  // `odd` matches half the articles: enough that a type scan is a materially
  // different number from the answer, which is what makes the ceiling bite.
  'articles-by-tag': {tag: 'odd'},
  'articles-referencing-author': {authorId: 'author-2'},
  'articles-ordered-sliced': {},
  'articles-recent-headlines': {},
}

const OVERLAY_NAMES = Object.keys(M_LOCAL_PARITY_OVERLAYS)

const CASES: Array<[label: string, def: OverlayQueryDefinition, overlayName: string]> = []
for (const def of supported) {
  for (const overlayName of OVERLAY_NAMES) CASES.push([`${def.id} x ${overlayName}`, def, overlayName])
}
const casesWhere = (predicate: (id: string) => boolean) => CASES.filter(([, def]) => predicate(def.id))

const overlayFor = (name: string, dataset: readonly FixtureDocument[]) =>
  M_LOCAL_PARITY_OVERLAYS[name](dataset)

/* ================================================================== *
 * 1. The classification cannot rot silently.
 * ================================================================== */

describe('§22.6: every supported query carries a hand-written bound classification', () => {
  it('the bound table covers exactly the supported registry', () => {
    expect(Object.keys(BOUNDS).sort()).toEqual(supported.map((d) => d.id).sort())
  })

  it('the classification split is pinned', () => {
    const of = (klass: BoundClass) =>
      Object.entries(BOUNDS)
        .filter(([, spec]) => spec.klass === klass)
        .map(([id]) => id)
        .sort()
    expect(of('constant')).toEqual([
      'article-body-text',
      'article-by-id',
      'article-by-slug',
      'article-by-slug-with-author',
      'article-object-spread',
      'article-with-author',
      'articles-ordered-sliced',
      'articles-recent-headlines',
      'page-by-slug',
      'page-featured-refs',
    ])
    expect(of('result-proportional')).toEqual([
      'article-type-list',
      'articles-by-tag',
      'articles-referencing-author',
      'multi-type-list',
    ])
    // The [M-LOCAL] slice registers nothing type-linear. Spike C found three
    // (`article-count`, `stats-aggregate`, `articles-by-author-name`); none is
    // registered here, because their planners are Phase 5 work. If this list
    // ever becomes non-empty the entry must be Tier B and the evidence updated.
    expect(of('type-linear')).toEqual([])
  })

  it('every constant entry carries an absolute cap and every other entry does not', () => {
    for (const [id, spec] of Object.entries(BOUNDS)) {
      if (spec.klass === 'constant') expect(spec.cap, id).toBeGreaterThan(0)
      else expect(spec.cap, id).toBeUndefined()
    }
  })

  it('the K parser reads the query, and refuses a lookup that merely ends in [0]', () => {
    // Non-vacuity of the parser itself: if it silently returned a default, the
    // slice ceiling would be a constant this file invented rather than a fact
    // about the query.
    expect(sliceEndFromQuery(registry.get('articles-ordered-sliced').query)).toBe(20)
    expect(sliceEndFromQuery(registry.get('articles-recent-headlines').query)).toBe(5)
    expect(() => sliceEndFromQuery(registry.get('article-by-id').query)).toThrow(/no \[0\.\.\.K\]/)
    expect(() => sliceEndFromQuery(registry.get('article-type-list').query)).toThrow()
  })

  it('no supported entry is registered Tier B, because none is type-linear', () => {
    for (const def of supported) expect(def.status, def.id).toBe('tier-a')
  })
})

/* ================================================================== *
 * 2. The base fetch — measured by this file, bounded by the query text.
 * ================================================================== */

/**
 * What the FIRST base request may return, from the query text alone.
 *
 * For an ordered slice that is `K`, not "everything the filter selects": a
 * top-K plan whose base fetch returned the whole type would satisfy the filter
 * bound trivially, and §22.6's last requirement is "never fetch every document
 * of a large type merely because the query is type-constrained".
 */
async function baseFetchCeiling(
  def: OverlayQueryDefinition,
  dataset: readonly FixtureDocument[],
  params: Record<string, unknown>,
): Promise<number> {
  const matches = await baseMatches(dataset, def.query, params)
  if (BOUNDS[def.id].ceiling !== 'slice-k') return matches
  return Math.min(matches, sliceEndFromQuery(def.query))
}

describe('§22.6 step 5: the base fetch returns no more than the query predicate selects', () => {
  it.each(CASES)('%s', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, base)
    const params = PARAMS[def.id]
    const ceiling = await baseFetchCeiling(def, base, params)
    const observation = await observe(def, base, overlay, params)
    expect(
      observation.planBaseDocuments,
      `${def.id} x ${overlayName}: the plan pulled ${observation.planBaseDocuments} base ` +
        `documents; the query's own text allows ${ceiling}. ${BOUNDS[def.id].why}`,
    ).toBeLessThanOrEqual(ceiling)
  })

  it.each(CASES)('%s at 10x scale', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, scaled)
    const params = PARAMS[def.id]
    const ceiling = await baseFetchCeiling(def, scaled, params)
    const observation = await observe(def, scaled, overlay, params)
    expect(
      observation.planBaseDocuments,
      `${def.id} x ${overlayName} @10x: the plan pulled ${observation.planBaseDocuments} base ` +
        `documents; the query's own text allows ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling)
  })
})

/* ================================================================== *
 * 3. Plan-selected candidates against the independent ceiling.
 * ================================================================== */

async function independentCeiling(
  def: OverlayQueryDefinition,
  dataset: readonly FixtureDocument[],
  overlay: OverlaySource,
  params: Record<string, unknown>,
): Promise<number> {
  const types = typesFromFilter(topLevelFilterSource(def.query))
  const delta = branchDelta(dataset, overlay, types)
  switch (BOUNDS[def.id].ceiling) {
    case 'answer':
      // A planner cannot materialise fewer documents than it returns, plus the
      // branch records it had to consider to know that.
      return (await answerSize(def, dataset, overlay, params)) + delta
    case 'slice-k':
      // §22.6: `requestedEnd + affectedCount`, with `requestedEnd` parsed from
      // the query's own slice and `affectedCount` counted from the overlay.
      return sliceEndFromQuery(def.query) + delta
    case 'base-match':
      return (await baseMatches(dataset, def.query, params)) + delta
  }
}

describe('§22.6: plan-selected candidates stay within the independent ceiling', () => {
  it.each(CASES)('%s', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, base)
    const params = PARAMS[def.id]
    const ceiling = await independentCeiling(def, base, overlay, params)
    const {diagnostics} = await observe(def, base, overlay, params)
    expect(
      diagnostics.planSelectedCount,
      `${def.id} x ${overlayName}: plan selected ${diagnostics.planSelectedCount}, ` +
        `independent ceiling ${ceiling} (${BOUNDS[def.id].klass}) — ${BOUNDS[def.id].why}`,
    ).toBeLessThanOrEqual(ceiling)
  })
})

/* ================================================================== *
 * 4. Diagnostics honesty. A planner must not pass by under-reporting.
 * ================================================================== */

describe('§22.8: reported work matches the work this file observed', () => {
  it.each(CASES)('%s', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, base)
    const observation = await observe(def, base, overlay, PARAMS[def.id])
    const d = observation.diagnostics
    expect(d.baseFetchDocuments, `${def.id}: reported base documents`).toBe(
      observation.totalBaseDocuments,
    )
    expect(d.baseRequestCount, `${def.id}: reported base requests`).toBe(observation.requestCount)
    expect(d.candidateIds).toHaveLength(d.candidateCount)
    expect(new Set(d.candidateIds).size, `${def.id}: candidates must be distinct`).toBe(
      d.candidateCount,
    )
    expect(
      d.planSelectedCount + d.referenceExpansions,
      `${def.id}: candidate accounting must add up`,
    ).toBe(d.candidateCount)
    // §22.6 permits step 5 and step 14; step 5 is a base fetch, not a local
    // evaluation, so exactly one local evaluation is the whole budget.
    expect(d.evaluatorInvocations, `${def.id}: no N+1 evaluation`).toBe(1)
    expect(d.baseRequestCount, `${def.id}: no N+1 base round trip`).toBeLessThanOrEqual(
      1 + def.maxReferenceDepth,
    )
    expect(d.exact).toBe(true)
    // Redundancy for the §22.9 capacity gate, added because a mutation audit
    // found it was killed by exactly one test in one file. Every case in this
    // sweep must respect the limit the registration declares.
    expect(d.candidateCount, `${def.id}: registered maxCandidates`).toBeLessThanOrEqual(
      def.maxCandidates,
    )
  })

  it('the capacity gate is reachable, not merely respected', async () => {
    // A limit no registered query can approach would make the assertion above
    // vacuous. Proven by shrinking the limit and requiring the refusal.
    const tight: OverlayQueryDefinition = {...registry.get('article-type-list'), maxCandidates: 2}
    await expect(
      evaluateOverlayQuery({
        registry: createQueryRegistry([tight]),
        queryId: tight.id,
        query: tight.query,
        params: {},
        base: createMemoryBaseSource(base),
        overlay: overlayFor('empty', base),
        caller: 'test',
        perspective: 'published',
      }),
    ).rejects.toMatchObject({code: 'CANDIDATE_LIMIT_EXCEEDED', httpStatus: 413})
  })
})

/* ================================================================== *
 * 5. Every candidate is explained. Closes the reference-expansion loophole
 *    that `boundedness-2026-08-04.md` §5 records as unpoliced.
 * ================================================================== */

describe('§22.6: no candidate is unexplained', () => {
  it.each(CASES)('%s', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, base)
    const params = PARAMS[def.id]
    const types = typesFromFilter(topLevelFilterSource(def.query))
    const filter = topLevelFilterSource(def.query)
    const matched = new Set(
      (await runGroq<Array<{_id: string}>>(`*[${filter}]{_id}`, base, params)).map((d) => d._id),
    )
    const {diagnostics} = await observe(def, base, overlay, params)
    const resolved = new Map(
      resolvedVirtualDataset(base, overlay).map((d) => [d._id, d] as const),
    )
    const candidates = new Set(diagnostics.candidateIds)

    // Every `_ref` value reachable from the candidate set: an id that is
    // referenced by a candidate is legitimately expandable.
    const referenced = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect)
      if (typeof value !== 'object' || value === null) return
      const object = value as Record<string, unknown>
      if (typeof object._ref === 'string') referenced.add(object._ref)
      Object.values(object).forEach(collect)
    }
    for (const id of candidates) collect(resolved.get(id))

    for (const id of diagnostics.candidateIds) {
      const isBaseMatch = matched.has(id)
      const isBranchRecord =
        overlay.documents.has(id) &&
        (types.length === 0 || types.includes(overlay.documents.get(id)!._type))
      const isReferenced = referenced.has(id)
      expect(
        isBaseMatch || isBranchRecord || isReferenced,
        `${def.id} x ${overlayName}: candidate ${id} is neither a base match of the query's ` +
          `own filter, nor a branch record of a constrained type, nor referenced by another ` +
          `candidate — the planner fetched it for no reason the query can justify`,
      ).toBe(true)
    }
  })
})

/* ================================================================== *
 * 5b. §22.6 step 8, "Analyze dereference paths".
 *
 * The Spike C latency evidence (§4.3) records the spike planner running
 * reference expansion unconditionally: `article-type-list` dereferences
 * NOTHING and still materialised 833 author documents — 14 % of its candidate
 * set — on the query already thinnest against its budget. It was pinned as
 * unimplemented there.
 *
 * The oracle here is the QUERY TEXT: a query with no `->` cannot observe a
 * reference target, so materialising one is transfer for nothing. Stated as a
 * sweep over every registered query rather than as one example, because the
 * defect is a property of the planner and not of one query.
 * ================================================================== */

describe('§22.6 step 8: a query that dereferences nothing expands nothing', () => {
  it('the registry contains queries on BOTH sides of this, or the sweep is vacuous', () => {
    const withDeref = supported.filter((d) => dereferences(d.query))
    const without = supported.filter((d) => !dereferences(d.query))
    expect(withDeref.length).toBeGreaterThan(0)
    expect(without.length).toBeGreaterThan(0)
  })

  it.each(CASES.filter(([, def]) => !dereferences(def.query)))(
    '%s materialises no reference target at all',
    async (_label, def, overlayName) => {
      const observation = await observe(def, base, overlayFor(overlayName, base), PARAMS[def.id])
      expect(
        observation.diagnostics.referenceExpansions,
        `${def.id} has no \`->\`, so every expanded document is transferred for nothing`,
      ).toBe(0)
      expect(observation.diagnostics.referenceDepth).toBe(0)
      // No second round trip either: expansion that fetches nothing must not
      // still cost a base request.
      expect(observation.diagnostics.baseRequestCount).toBeLessThanOrEqual(1)
    },
  )

  it.each(CASES.filter(([, def]) => !dereferences(def.query)))(
    '%s expands nothing at 10x either',
    async (_label, def, overlayName) => {
      const observation = await observe(
        def,
        scaled,
        overlayFor(overlayName, scaled),
        PARAMS[def.id],
      )
      expect(observation.diagnostics.referenceExpansions).toBe(0)
    },
  )

  it('a query that DOES dereference still expands, so the sweep above is not trivially true', async () => {
    const observation = await observe(
      registry.get('article-with-author'),
      base,
      overlayFor('empty', base),
      PARAMS['article-with-author'],
    )
    expect(observation.diagnostics.referenceExpansions).toBeGreaterThan(0)
  })
})

/* ================================================================== *
 * 6. Scale. At 41 documents a constant bound and a linear one are
 *    indistinguishable (evidence review F6).
 * ================================================================== */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Every field the registry orders by, read out of the registered query texts. */
const ORDERED_FIELDS = ['publishedAt', '_createdAt']

/**
 * Deterministic 10x fixture: articles and pages both multiplied, so a planner
 * that is linear in EITHER type is caught. Added documents get fresh IDs and
 * fresh slugs, so no lookup answer changes: the sweep must vary the dataset
 * size and nothing else.
 *
 * TIMESTAMPS ARE NOT CLONED VERBATIM, and that is the whole reason this comment
 * exists. The Spike C latency evidence (`latency-2026-08-04.md` §6, "a red
 * found along the way") records a copy that cloned `_createdAt` unchanged: ten
 * documents then tied on every ordering key, the top-K window drew from the tie
 * group, and scaling silently changed the ANSWER as well as the dataset size —
 * which makes every "same at 1x and 10x" assertion meaningless. Copies are
 * therefore dated strictly below every original on every ordered field, with a
 * unique value per copy so the copies do not tie with each other either. The
 * invariant is asserted below rather than trusted.
 */
function scale(dataset: readonly FixtureDocument[], factor: number): FixtureDocument[] {
  const out = [...dataset]
  const growable = dataset.filter((d) => d._type === 'article' || d._type === 'page')
  let ordinal = 0
  for (let copy = 1; copy < factor; copy++) {
    for (const doc of growable) {
      const scaled = clone(doc)
      // Any `19xx` stamp sorts below every original, which are all `2026`.
      const unique = `1900-01-01T00:00:00.${String(ordinal).padStart(6, '0')}Z`
      ordinal++
      scaled._id = `scale-${copy}-${doc._id}`
      scaled._rev = `scale-rev-${copy}-${doc._id}`
      scaled.title = `${String(doc.title)} (copy ${copy})`
      scaled.slug = {_type: 'slug', current: `scale-${copy}-${doc._id}`}
      scaled._createdAt = unique
      scaled._updatedAt = unique
      if (doc.publishedAt !== undefined) scaled.publishedAt = unique
      out.push(scaled)
    }
  }
  return out
}

const scaled = scale(base, 10)

describe('§22.6: boundedness at 10x dataset scale', () => {
  it('the scaled fixture is 10x in both growable types and changes no lookup answer', async () => {
    expect(scaled.filter((d) => d._type === 'article')).toHaveLength(300)
    expect(scaled.filter((d) => d._type === 'page')).toHaveLength(30)
    expect(new Set(scaled.map((d) => d._id)).size).toBe(scaled.length)
    for (const def of supported) {
      if (BOUNDS[def.id].klass !== 'constant') continue
      const at1 = await runGroq(def.query, base, PARAMS[def.id])
      const at10 = await runGroq(def.query, scaled, PARAMS[def.id])
      expect(at10, `${def.id}: scaling must not change the answer`).toEqual(at1)
    }
  })

  it('every added document sorts strictly below every original on every ordered field', () => {
    // Without this the "same candidate count at 1x and 10x" assertions below
    // could pass while the query returned a different top-K at each scale.
    const added = scaled.filter((d) => d._id.startsWith('scale-'))
    const original = scaled.filter((d) => !d._id.startsWith('scale-'))
    expect(added).toHaveLength(scaled.length - base.length)
    for (const field of ORDERED_FIELDS) {
      const values = (docs: FixtureDocument[]) =>
        docs.map((d) => d[field]).filter((v): v is string => typeof v === 'string')
      const maxAdded = values(added).reduce((a, b) => (a > b ? a : b), '')
      const minOriginal = values(original).reduce((a, b) => (a < b ? a : b), '9999')
      expect(values(added).length, `${field}: copies must carry it`).toBeGreaterThan(0)
      expect(maxAdded < minOriginal, `${field}: ${maxAdded} must sort below ${minOriginal}`).toBe(
        true,
      )
      expect(new Set(values(added)).size, `${field}: copies must not tie with each other`).toBe(
        values(added).length,
      )
    }
  })

  it.each(CASES)('%s stays within its ceiling at 10x', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, scaled)
    const params = PARAMS[def.id]
    const ceiling = await independentCeiling(def, scaled, overlay, params)
    const {diagnostics} = await observe(def, scaled, overlay, params)
    expect(
      diagnostics.planSelectedCount,
      `${def.id} x ${overlayName} @10x: selected ${diagnostics.planSelectedCount}, ceiling ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling)
  })

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s selects the SAME number of candidates at 1x and 10x',
    async (_label, def, overlayName) => {
      const at1 = await observe(def, base, overlayFor(overlayName, base), PARAMS[def.id])
      const at10 = await observe(def, scaled, overlayFor(overlayName, scaled), PARAMS[def.id])
      expect(
        at10.diagnostics.planSelectedCount,
        `${def.id} x ${overlayName}: 1x ${at1.diagnostics.planSelectedCount}, 10x ${at10.diagnostics.planSelectedCount}`,
      ).toBe(at1.diagnostics.planSelectedCount)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s materialises the SAME total, reference expansion included, at 1x and 10x',
    async (_label, def, overlayName) => {
      // Reference expansion is the one mechanism plan-selection does not
      // police. If it grew with the dataset, a "constant" plan would still
      // transfer a linear number of documents and §22.6 would be unproven.
      const at1 = await observe(def, base, overlayFor(overlayName, base), PARAMS[def.id])
      const at10 = await observe(def, scaled, overlayFor(overlayName, scaled), PARAMS[def.id])
      expect(at10.diagnostics.candidateCount).toBe(at1.diagnostics.candidateCount)
      expect(at10.totalBaseDocuments).toBe(at1.totalBaseDocuments)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s stays under its structural cap at 10x',
    async (_label, def, overlayName) => {
      const at10 = await observe(def, scaled, overlayFor(overlayName, scaled), PARAMS[def.id])
      expect(at10.diagnostics.candidateCount).toBeLessThanOrEqual(BOUNDS[def.id].cap!)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'result-proportional'))(
    '%s grows at 10x only as far as its answer does',
    async (_label, def, overlayName) => {
      const params = PARAMS[def.id]
      const overlay1 = overlayFor(overlayName, base)
      const overlay10 = overlayFor(overlayName, scaled)
      const at1 = await observe(def, base, overlay1, params)
      const at10 = await observe(def, scaled, overlay10, params)
      const answer1 = await answerSize(def, base, overlay1, params)
      const answer10 = await answerSize(def, scaled, overlay10, params)
      const types = typesFromFilter(topLevelFilterSource(def.query))
      expect(
        at10.diagnostics.planSelectedCount - at1.diagnostics.planSelectedCount,
        `${def.id} x ${overlayName}: candidates grew by ` +
          `${at10.diagnostics.planSelectedCount - at1.diagnostics.planSelectedCount}, answer grew by ${answer10 - answer1}`,
      ).toBeLessThanOrEqual(answer10 - answer1 + branchDelta(scaled, overlay10, types))
    },
  )
})

/* ================================================================== *
 * 7. NON-VACUITY, EXECUTED. Arguing arithmetically about what an unbounded
 *    planner WOULD select is not the same as running one. These run one,
 *    through the real evaluator, and require the ceilings above to reject it.
 * ================================================================== */

const ALL_TYPES = [...new Set(base.map((d) => d._type))]

/** The same registration with its candidate plan replaced by a scan. */
const withScanPlan = (def: OverlayQueryDefinition, types: readonly string[]): OverlayQueryDefinition => ({
  ...def,
  candidatePlan: {type: 'types', types},
  maxCandidates: 100000,
})

describe('non-vacuity: a deliberately unbounded planner must fail this suite', () => {
  it('the mutant plans are distinct from anything registered', () => {
    expect(ALL_TYPES.length).toBeGreaterThan(2)
    expect(ALL_TYPES).toEqual(expect.arrayContaining(['article', 'page', 'author', 'siteSettings']))
  })

  it.each(CASES)(
    '%s: a whole-dataset plan run through the REAL evaluator exceeds the ceiling',
    async (_label, def, overlayName) => {
      const overlay = overlayFor(overlayName, base)
      const params = PARAMS[def.id]
      const ceiling = await independentCeiling(def, base, overlay, params)
      const mutant = withScanPlan(def, ALL_TYPES)
      const observation = await observe(
        mutant,
        base,
        overlay,
        params,
        createQueryRegistry([mutant]),
      )
      expect(
        observation.diagnostics.planSelectedCount,
        `${def.id} x ${overlayName}: an unbounded planner selected ` +
          `${observation.diagnostics.planSelectedCount} against ceiling ${ceiling}. If this ` +
          `passes, the ceiling is vacuous.`,
      ).toBeGreaterThan(ceiling)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s: a full scan of the query\'s own type also exceeds the ceiling',
    async (_label, def, overlayName) => {
      // This is finding F6 exactly: `article-by-slug` fetching 30 documents to
      // return 1, under a ceiling that used to say "fine".
      const overlay = overlayFor(overlayName, base)
      const params = PARAMS[def.id]
      const types = typesFromFilter(topLevelFilterSource(def.query))
      const scanTypes = types.length > 0 ? types : ALL_TYPES
      const ceiling = await independentCeiling(def, base, overlay, params)
      const mutant = withScanPlan(def, scanTypes)
      const observation = await observe(
        mutant,
        base,
        overlay,
        params,
        createQueryRegistry([mutant]),
      )
      expect(
        observation.diagnostics.planSelectedCount,
        `${def.id} x ${overlayName}: a full ${scanTypes.join('/')} scan selected ` +
          `${observation.diagnostics.planSelectedCount}, ceiling ${ceiling}`,
      ).toBeGreaterThan(ceiling)
    },
  )

  it('at 10x a type scan breaks the structural lookup cap by an order of magnitude', async () => {
    const def = registry.get('article-by-slug')
    const mutant = withScanPlan(def, ['article'])
    const observation = await observe(
      mutant,
      scaled,
      overlayFor('empty', scaled),
      PARAMS['article-by-slug'],
      createQueryRegistry([mutant]),
    )
    expect(observation.diagnostics.planSelectedCount).toBe(300)
    expect(observation.diagnostics.planSelectedCount).toBeGreaterThan(LOOKUP_TOTAL_CAP)
  })

  it('the ceilings are strictly below a type scan for every constant case, at 10x', async () => {
    // If a ceiling were satisfied BY a type scan it would be vacuous — the
    // exact defect finding F6 identified in the previous suite.
    //
    // Asserted at 10x rather than 1x, and that is the F6 lesson rather than a
    // convenience: the fixture has THREE pages, so under the `type-change`
    // overlay a whole-page scan is 2 documents and the ceiling is also 2. At
    // 41 documents a constant bound and a linear one are not distinguishable,
    // which is why the scale sweep exists at all. At 10x a page scan is 30.
    for (const [, def, overlayName] of casesWhere((id) => BOUNDS[id].klass === 'constant')) {
      const overlay = overlayFor(overlayName, scaled)
      const types = typesFromFilter(topLevelFilterSource(def.query))
      const scanTypes = types.length > 0 ? types : ALL_TYPES
      const scan = resolvedVirtualDataset(scaled, overlay).filter((d) =>
        scanTypes.includes(d._type),
      ).length
      const ceiling = await independentCeiling(def, scaled, overlay, PARAMS[def.id])
      expect(
        scan,
        `${def.id} x ${overlayName}: a ${scanTypes.join('/')} scan is ${scan} documents and the ` +
          `ceiling is ${ceiling}; a ceiling a scan satisfies proves nothing`,
      ).toBeGreaterThan(ceiling)
    }
  })
})
