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

interface BoundSpec {
  readonly klass: BoundClass
  readonly why: string
}

const BOUNDS: Record<string, BoundSpec> = {
  'article-by-id': {
    klass: 'constant',
    why: 'One ID in, at most one document out. No planner can do better and none may do worse.',
  },
  'article-with-author': {
    klass: 'constant',
    why: 'One ID plus the targets its projection dereferences; neither grows with the dataset.',
  },
  'page-featured-refs': {
    klass: 'constant',
    why: 'One literal ID plus a fixed-length reference array.',
  },
  'page-by-slug': {
    klass: 'constant',
    why: 'Slug equality reads a LOCAL field, so the base answers it exactly (§22.7); the branch delta covers what the base could not know.',
  },
  'article-by-slug': {
    klass: 'constant',
    why: 'As page-by-slug. This is the query F6 caught scanning 30 documents to return 1.',
  },
  'article-by-slug-with-author': {
    klass: 'constant',
    why: 'As article-by-slug, plus the dereferenced author.',
  },
  'article-type-list': {
    klass: 'result-proportional',
    why: 'The answer IS the type, so no planner can materialise fewer documents than it returns. Not constant, and not claimed to be.',
  },
  'multi-type-list': {
    klass: 'result-proportional',
    why: 'As article-type-list, across two types.',
  },
}

/**
 * Structural cap for lookups, from the Spike C latency evidence §5.1: an ID or
 * slug lookup resolves one document plus what `maxReferenceDepth` pulls in.
 * Deliberately loose enough for a richer projection and deliberately far below
 * a type scan, which at 10x scale is 300. It is asserted non-vacuous below.
 */
const LOOKUP_TOTAL_CAP = 32

/* ================================================================== *
 * E. The matrix.
 * ================================================================== */

const PARAMS: Record<string, Record<string, unknown>> = {
  'article-by-id': {id: 'article-05'},
  'article-with-author': {id: 'article-01'},
  'page-featured-refs': {},
  'page-by-slug': {slug: 'legacy-page'},
  'article-by-slug': {slug: 'article-7'},
  'article-by-slug-with-author': {slug: 'article-7'},
  'article-type-list': {},
  'multi-type-list': {},
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
      'article-by-id',
      'article-by-slug',
      'article-by-slug-with-author',
      'article-with-author',
      'page-by-slug',
      'page-featured-refs',
    ])
    expect(of('result-proportional')).toEqual(['article-type-list', 'multi-type-list'])
    // The [M-LOCAL] slice registers nothing type-linear. Spike C found three
    // (`article-count`, `stats-aggregate`, `articles-by-author-name`); none is
    // registered here, because their planners are Phase 5 work. If this list
    // ever becomes non-empty the entry must be Tier B and the evidence updated.
    expect(of('type-linear')).toEqual([])
  })

  it('no supported entry is registered Tier B, because none is type-linear', () => {
    for (const def of supported) expect(def.status, def.id).toBe('tier-a')
  })
})

/* ================================================================== *
 * 2. The base fetch — measured by this file, bounded by the query text.
 * ================================================================== */

describe('§22.6 step 5: the base fetch returns no more than the query predicate selects', () => {
  it.each(CASES)('%s', async (_label, def, overlayName) => {
    const overlay = overlayFor(overlayName, base)
    const params = PARAMS[def.id]
    const ceiling = await baseMatches(base, def.query, params)
    const observation = await observe(def, base, overlay, params)
    expect(
      observation.planBaseDocuments,
      `${def.id} x ${overlayName}: the plan pulled ${observation.planBaseDocuments} base ` +
        `documents; the query's own filter selects ${ceiling} of them. ${BOUNDS[def.id].why}`,
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
  const spec = BOUNDS[def.id]
  if (spec.klass === 'result-proportional') {
    // A planner cannot materialise fewer documents than it returns, plus the
    // branch records it had to consider to know that.
    return (await answerSize(def, dataset, overlay, params)) + branchDelta(dataset, overlay, types)
  }
  return (await baseMatches(dataset, def.query, params)) + branchDelta(dataset, overlay, types)
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
 * 6. Scale. At 41 documents a constant bound and a linear one are
 *    indistinguishable (evidence review F6).
 * ================================================================== */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Deterministic 10x fixture: articles and pages both multiplied, so a planner
 * that is linear in EITHER type is caught. Added documents get fresh IDs and
 * fresh slugs, so no lookup answer changes: the sweep must vary the dataset
 * size and nothing else.
 */
function scale(dataset: readonly FixtureDocument[], factor: number): FixtureDocument[] {
  const out = [...dataset]
  const growable = dataset.filter((d) => d._type === 'article' || d._type === 'page')
  for (let copy = 1; copy < factor; copy++) {
    for (const doc of growable) {
      const scaled = clone(doc)
      scaled._id = `scale-${copy}-${doc._id}`
      scaled._rev = `scale-rev-${copy}-${doc._id}`
      scaled.title = `${String(doc.title)} (copy ${copy})`
      scaled.slug = {_type: 'slug', current: `scale-${copy}-${doc._id}`}
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
    '%s stays under the structural lookup cap at 10x',
    async (_label, def, overlayName) => {
      const at10 = await observe(def, scaled, overlayFor(overlayName, scaled), PARAMS[def.id])
      expect(at10.diagnostics.candidateCount).toBeLessThanOrEqual(LOOKUP_TOTAL_CAP)
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
