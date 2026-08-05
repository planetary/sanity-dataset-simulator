import {writeFileSync} from 'node:fs'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {type FixtureDocument, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'
import {OVERLAY_FIXTURES, type SpikeOverlay, applyOverlay} from '../spike-c/overlay'
import {
  REPRESENTATIVE_ARTICLE_COUNT,
  type WorkProfile,
  datasetBytes,
  percentile,
  profileQuery,
  scaleToRepresentative,
} from '../spike-c/latency'
import {type SpikeQueryDefinition, evaluateRegistered} from '../spike-c/planner'
import {REGISTRY, byId} from '../spike-c/registry'

// ===========================================================================
// SPIKE C — QUERY LATENCY AT REPRESENTATIVE SCALE (PRD §36.3 pass criterion 5,
// the last open Gate D criterion; §5.4 performance targets; §22.6).
//
// ---------------------------------------------------------------------------
// 1. THE BUDGET. PRD §5.4 "Performance targets", verbatim, rows that govern
//    query evaluation ("These targets apply to preview and local authoring,
//    not production traffic."):
//
//      | ID or slug preview query, warm    | p95 under 1.5 seconds |
//      | Type-constrained list query, warm | p95 under 3 seconds   |
//      | Preview refresh after edit        | p95 under 2 seconds   |
//
//    These are END-TO-END budgets for a warm preview query: base fetch over
//    the network, overlay resolution, groq-js evaluation, serialisation. This
//    suite runs entirely in-process, so what it measures is a STRICT SUBSET of
//    the budgeted path — every millisecond here is a millisecond unavailable
//    to the network. A local measurement can therefore FALSIFY the budget
//    (if it alone exceeds it) but can never CONFIRM it.
//
// ---------------------------------------------------------------------------
// 2. REPRESENTATIVE SCALE. PRD §35.16 "Performance tests" enumerates the
//    scales this project must measure at:
//
//      - Type candidate sets of 100, 1,000, 5,000, and configured maximum
//        documents.
//
//    The Phase 0 audit (docs/plans/evidence/phase-1/audit/repository-audit.md)
//    measured the base dataset at 41 documents — article 32 (avg 915 B, max
//    952 B), author 5, page 3, siteSettings 1 — which is a fixture, not a
//    production corpus. So the audit supplies the DOCUMENT SHAPE (~915-950 B
//    articles) and §35.16 supplies the COUNT. Top of the enumerated range is
//    5,000, so representative scale here is 5,000 `article` documents of
//    audit-measured size. `configured maximum` (§11.1 `maxCandidateDocuments`)
//    has no value in the PRD, so it cannot be tested against.
//
// ---------------------------------------------------------------------------
// 3. WHAT IS GATED, AND WHY IT IS NOT WALL CLOCK.
//
//    A wall-clock assertion is flaky by construction, and here it would be
//    unusually so: the worst query already consumes a large fraction of its
//    §5.4 budget in pure local evaluation on an idle machine, so a gate AT the
//    budget is a coin flip under CI load, and a gate at 3-5x the budget would
//    never fire before the work proxies do. Worse, this harness SIMULATES the
//    server-side filtered base fetch (§22.6 step 5) by running that filter
//    through groq-js over the whole base — work that Sanity answers from an
//    index in production. Its wall clock is an artefact of the simulator, not
//    a property of the system.
//
//    So the gate is deterministic work, which is causally upstream of time:
//      - `documentsMaterialized` — the candidate set handed to groq-js.
//      - `candidateBytes`        — its serialised size (catches "few but huge").
//      - `evaluatorInvocations`  — §22.6 allows one base fetch + one evaluate.
//      - `baseFetchDocuments`    — the wire shape of the base fetch.
//    Wall clock is recorded as evidence (p50/p95, printed below) and reported
//    in docs/plans/evidence/phase-1/spike-c-groq-corpus/latency-2026-08-04.md.
// ===========================================================================

/**
 * Per-test budget (ms).
 *
 * This is a RUNNER budget, not a gate. The deliberate absence of a wall-clock
 * *assertion* in this file stands — measured margins were too thin to gate on,
 * because a small query absorbs GC pauses from the 5 MiB candidate sets built in
 * the same process. Nothing below is reintroduced as a pass/fail time threshold;
 * the budget only decides when vitest gives up on a test that is still working.
 *
 * The work is genuine: every case runs groq-js over a 5 000-article corpus.
 * Measured worst case over six full-suite runs: 3.62 s against vitest's 5 s
 * default — 72 % of budget on an otherwise idle machine.
 */
vi.setConfig({testTimeout: 60_000, hookTimeout: 60_000})

const fixtureBase = publishedPerspective(loadFixtureDataset())
const representative = scaleToRepresentative(fixtureBase, REPRESENTATIVE_ARTICLE_COUNT)

const supported = REGISTRY.filter((d) => d.status !== 'unsupported')
const overlayNames = Object.keys(OVERLAY_FIXTURES)

const PARAMS: Record<string, Record<string, unknown>> = {
  'article-by-id': {id: 'article-05'},
  'object-spread': {id: 'article-05'},
  'article-with-author': {id: 'article-01'},
  'articles-by-author-name': {name: 'Author 2 (branch rename)'},
  'page-by-slug': {slug: 'legacy-page'},
  'article-by-slug': {slug: 'article-7'},
  'references-author': {authorId: 'author-1'},
  'pt-text': {id: 'article-03'},
}

/**
 * How many measured repetitions the p50/p95 evidence is taken over. Kept low
 * in the default suite run because every repetition materialises a
 * 5,000-document candidate set for five of the queries; the evidence document
 * quotes a high-repetition run taken with `SPIKE_C_LATENCY_REPS=31`.
 * Nearest-rank p95 over 3 samples is the maximum, i.e. conservative.
 */
const REPS = Number(process.env.SPIKE_C_LATENCY_REPS ?? 3)

// ---------------------------------------------------------------------------
// §5.4 class assignment — hand-written from the QUERY TEXT, never from the
// registered candidate plan. A query that names an `_id` or compares a slug
// is an "ID or slug preview query"; anything whose filter is a `_type`
// constraint over a whole type is a "type-constrained list query".
// ---------------------------------------------------------------------------

type BudgetClass = 'id-or-slug' | 'type-list'

const PRD_5_4: Record<BudgetClass, {row: string; p95Ms: number}> = {
  'id-or-slug': {row: 'ID or slug preview query, warm', p95Ms: 1500},
  'type-list': {row: 'Type-constrained list query, warm', p95Ms: 3000},
}

/**
 * PROPOSAL — not a PRD number. §5.4 budgets TIME; §22.6 bounds WORK; nothing
 * in the PRD converts between them. Deriving a document cap from a throughput
 * model would be vacuous (1.5 s of warm network buys megabytes), so the cap
 * below is instead structural: an ID or slug lookup resolves ONE document plus
 * whatever `maxReferenceDepth` (3) dereferences pull in. The largest such
 * fan-out in this corpus is 9 documents. 32 leaves 3.5x headroom for a richer
 * projection while still failing on the FIRST step toward a type scan, which
 * at representative scale is 5,000. Ratify or replace.
 */
const ID_SLUG_DOC_CAP = 32
const ID_SLUG_BYTE_CAP = 64 * 1024

/**
 * PROPOSAL — §22.6 step 5 is one base fetch and step 14 is one evaluation of
 * the original query, so two evaluator invocations is the structural maximum.
 * This is the N+1 guard: a planner that dereferences by re-querying, or that
 * probes the base per candidate, breaks it immediately.
 */
const MAX_EVALUATOR_INVOCATIONS = 2

const BUDGET_CLASS: Record<string, {klass: BudgetClass; why: string}> = {
  'article-by-id': {klass: 'id-or-slug', why: 'the query names exactly one _id'},
  'object-spread': {klass: 'id-or-slug', why: 'the query names exactly one _id'},
  'article-with-author': {klass: 'id-or-slug', why: 'one _id plus a dereference'},
  'pt-text': {klass: 'id-or-slug', why: 'one _id plus pt::text over its body'},
  'page-featured-refs': {klass: 'id-or-slug', why: 'the query names the literal _id "page-home"'},
  'page-by-slug': {klass: 'id-or-slug', why: 'slug equality, §5.4 "ID or slug preview query"'},
  'article-by-slug': {klass: 'id-or-slug', why: 'slug equality, §5.4 "ID or slug preview query"'},

  'article-type-list': {klass: 'type-list', why: '*[_type == "article"] — the whole type'},
  'multi-type-list': {klass: 'type-list', why: '*[_type in [...]] — two whole types'},
  'filter-by-tag': {klass: 'type-list', why: 'type constraint plus a local array predicate'},
  'references-author': {klass: 'type-list', why: 'type constraint plus references()'},
  'projection-rename': {klass: 'type-list', why: 'type-constrained ordered slice'},
  'articles-ordered-sliced': {klass: 'type-list', why: 'type-constrained ordered slice'},
  'recent-by-created-at': {klass: 'type-list', why: 'type-constrained ordered slice'},
  'article-count': {klass: 'type-list', why: 'count() over a whole type'},
  'stats-aggregate': {klass: 'type-list', why: 'math::sum over a whole type'},
  'articles-by-author-name': {klass: 'type-list', why: 'type constraint plus a filter through a reference'},
}

/**
 * The three queries `boundedness-2026-08-04.md` records as honestly unbounded
 * (`type-linear`). They materialise their whole type to answer a small
 * question, so at representative scale they are EXPECTED to blow any work
 * budget. Pinned here as admissions: if a planner improvement fixes one, this
 * list goes red and forces the Tier and the evidence document to be updated.
 */
const TYPE_LINEAR = ['article-count', 'articles-by-author-name', 'stats-aggregate']

// ---------------------------------------------------------------------------
// Independent answer-size oracles. Each re-implements the registered query's
// SEMANTICS by hand over the resolved virtual dataset; none reads
// `def.candidatePlan`, and none calls the planner. They exist so the
// result-proportional budget ("a planner may not materialise more than it
// returns, plus the branch delta") is measurable without paying a full groq-js
// evaluation per case. §"the hand oracles agree with groq-js" below proves
// them equivalent to the real thing at fixture scale.
// ---------------------------------------------------------------------------

const hasRefTo = (value: unknown, id: string): boolean => {
  if (Array.isArray(value)) return value.some((v) => hasRefTo(v, id))
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o._ref === id) return true
    return Object.values(o).some((v) => hasRefTo(v, id))
  }
  return false
}

const HAND_ANSWER: Record<
  string,
  {groq: string; count: (docs: FixtureDocument[], params: Record<string, unknown>) => number}
> = {
  'article-type-list': {
    groq: `*[_type == "article"]`,
    count: (docs) => docs.filter((d) => d._type === 'article').length,
  },
  'multi-type-list': {
    groq: `*[_type in ["article", "page"]]`,
    count: (docs) => docs.filter((d) => d._type === 'article' || d._type === 'page').length,
  },
  'filter-by-tag': {
    groq: `*[_type == "article" && "featured" in tags]`,
    count: (docs) =>
      docs.filter((d) => d._type === 'article' && (d.tags as string[] | undefined)?.includes('featured'))
        .length,
  },
  'references-author': {
    groq: `*[_type == "article" && references($authorId)]`,
    count: (docs, params) =>
      docs.filter((d) => d._type === 'article' && hasRefTo(d, String(params.authorId))).length,
  },
}

/** Branch records + tombstones touching the given types (independent of the plan). */
function branchDelta(dataset: FixtureDocument[], overlay: SpikeOverlay, types: string[]): number {
  const baseById = new Map(dataset.map((d) => [d._id, d]))
  const ids = new Set<string>()
  for (const [id, d] of overlay.documents) {
    if (types.includes(d._type) || types.includes(baseById.get(id)?._type ?? '')) ids.add(id)
  }
  for (const id of overlay.tombstones) {
    if (types.includes(baseById.get(id)?._type ?? '')) ids.add(id)
  }
  return ids.size
}

const TYPES_OF: Record<string, string[]> = {
  'article-type-list': ['article'],
  'multi-type-list': ['article', 'page'],
  'filter-by-tag': ['article'],
  'references-author': ['article'],
}

// ---------------------------------------------------------------------------
// Measurement. Everything expensive happens once, in beforeAll; every `it`
// below is an assertion over the recorded profiles.
// ---------------------------------------------------------------------------

const key = (queryId: string, overlay: string) => `${queryId} × ${overlay}`

/** Representative-scale profile, one run per (query, overlay). */
const atScale = new Map<string, WorkProfile>()
/** Fixture-scale profile, same grid — the 1x column of the scale comparison. */
const atFixture = new Map<string, WorkProfile>()
/** REPS repeated runs at representative scale, empty overlay, for p50/p95. */
const samples = new Map<string, WorkProfile[]>()

const overlayFor = (dataset: FixtureDocument[], name: string): SpikeOverlay =>
  OVERLAY_FIXTURES[name](dataset)

beforeAll(async () => {
  for (const def of supported) {
    const params = PARAMS[def.id] ?? {}
    for (const ov of overlayNames) {
      atFixture.set(
        key(def.id, ov),
        await profileQuery(def, fixtureBase, overlayFor(fixtureBase, ov), params),
      )
      if (ov !== 'empty') {
        atScale.set(
          key(def.id, ov),
          await profileQuery(def, representative, overlayFor(representative, ov), params),
        )
      }
    }
    // The empty overlay carries the p50/p95 evidence as well as its guard row,
    // so it is run REPS + 1 times and the timing samples come from the same
    // runs the guard reads. The first run is discarded: first-touch costs (JIT,
    // groq-js parse cache) are not what §5.4's "warm" rows budget.
    const runs: WorkProfile[] = []
    for (let r = 0; r <= REPS; r++) {
      const p = await profileQuery(def, representative, overlayFor(representative, 'empty'), params)
      if (r > 0) runs.push(p)
    }
    samples.set(def.id, runs)
    atScale.set(key(def.id, 'empty'), runs[0])
  }
}, 1_800_000)

// ===========================================================================
// 1. The representative-scale corpus is what it claims to be.
// ===========================================================================

describe('representative scale: the generated corpus matches §35.16 and the Phase 0 audit', () => {
  it('holds exactly 5,000 articles and preserves every hand-written fixture document', () => {
    expect(REPRESENTATIVE_ARTICLE_COUNT).toBe(5000)
    expect(representative.filter((d) => d._type === 'article')).toHaveLength(5000)
    // The overlay fixtures and query params address these by id/slug.
    for (const id of ['article-01', 'article-05', 'article-25', 'author-2', 'page-home', 'legacy.page.v2', 'siteSettings']) {
      expect(representative.some((d) => d._id === id), `missing fixture doc ${id}`).toBe(true)
    }
    expect(new Set(representative.map((d) => d._id)).size).toBe(representative.length)
    const slugs = representative
      .map((d) => (d.slug as {current?: string} | undefined)?.current)
      .filter((s): s is string => typeof s === 'string')
    expect(new Set(slugs).size, 'slugs must stay unique or slug lookups stop being single-match').toBe(
      slugs.length,
    )
  })

  it('keeps the Phase 0 audit type composition (article 32 : author 5 : page 3 : settings 1)', () => {
    // Scaling one type in isolation leaves a 3-document `page` type, against
    // which no work budget is falsifiable. The audit measured the mix; §35.16
    // supplies the count; the corpus honours both.
    const count = (t: string) => representative.filter((d) => d._type === t).length
    const fixtureRatio = (t: string) =>
      fixtureBase.filter((d) => d._type === t).length / fixtureBase.filter((d) => d._type === 'article').length
    for (const t of ['author', 'page']) {
      const expected = Math.round(fixtureRatio(t) * REPRESENTATIVE_ARTICLE_COUNT)
      expect(count(t), `${t}: expected ~${expected}, got ${count(t)}`).toBe(expected)
    }
    expect(count('siteSettings'), 'siteSettings is a singleton and must not be cloned').toBe(1)
    // Non-vacuity of the caps below depends on the page type being large.
    expect(count('page')).toBeGreaterThan(ID_SLUG_DOC_CAP)
  })

  it('generated articles match the audit-measured document size (article avg 915 B, max 952 B)', () => {
    const articles = representative.filter((d) => d._type === 'article')
    const mean = datasetBytes(articles) / articles.length
    // The audit band with 20 % tolerance for the wider synthetic ids/slugs.
    expect(mean).toBeGreaterThan(915 * 0.8)
    expect(mean).toBeLessThan(952 * 1.2)
  })

  it('every generated article sorts strictly below every original on every ordered field', () => {
    // Without this the scale-up changes the ANSWER as well as the dataset and
    // every top-K comparison measures two things at once. Same invariant, and
    // same reason, as spike-c-boundedness.test.ts §3.
    const originals = fixtureBase.filter((d) => d._type === 'article')
    const originalIds = new Set(originals.map((d) => d._id))
    const added = representative.filter((d) => d._type === 'article' && !originalIds.has(d._id))
    expect(added).toHaveLength(5000 - originals.length)
    for (const f of ['publishedAt', '_createdAt'] as const) {
      const ms = (d: FixtureDocument) => Date.parse(String(d[f]))
      expect(Math.max(...added.map(ms)), `field ${f}`).toBeLessThan(
        Math.min(...originals.map(ms)),
      )
    }
  })

  it('the parameterised lookups are still single-match at representative scale', async () => {
    const one = async (groq: string, params: Record<string, unknown>) =>
      (await runGroq<unknown[]>(groq, representative, params)).length
    expect(await one(`*[_type == "article" && slug.current == $slug]`, {slug: 'article-7'})).toBe(1)
    expect(await one(`*[_type == "page" && slug.current == $slug]`, {slug: 'legacy-page'})).toBe(1)
    expect(await one(`*[_id == $id]`, {id: 'article-05'})).toBe(1)
  })

  it('the hand-written answer oracles agree with groq-js at fixture scale', async () => {
    // The budget below is measured with the hand oracles (a full groq-js
    // evaluation per case at representative scale would dominate suite time).
    // This proves they are the same function.
    for (const [id, oracle] of Object.entries(HAND_ANSWER)) {
      const params = PARAMS[id] ?? {}
      for (const ov of overlayNames) {
        const resolved = applyOverlay(fixtureBase, overlayFor(fixtureBase, ov))
        const viaGroq = (await runGroq<unknown[]>(oracle.groq, resolved, params)).length
        expect(oracle.count(resolved, params), `${id} × ${ov}`).toBe(viaGroq)
      }
    }
  })
})

// ===========================================================================
// 2. THE GUARD. Deterministic work budgets, every query × every overlay, at
//    representative scale.
// ===========================================================================

const CASES = supported.flatMap((def) => overlayNames.map((ov) => [key(def.id, ov), def, ov] as const))
const casesWhere = (pred: (id: string) => boolean) => CASES.filter(([, def]) => pred(def.id))

describe('§5.4 budget guard: every registered query is classified', () => {
  it('the class table covers exactly the supported registry', () => {
    expect(Object.keys(BUDGET_CLASS).sort()).toEqual(supported.map((d) => d.id).sort())
  })

  it('the class split is pinned', () => {
    const of = (k: BudgetClass) =>
      Object.entries(BUDGET_CLASS)
        .filter(([, v]) => v.klass === k)
        .map(([id]) => id)
        .sort()
    expect(of('id-or-slug')).toEqual([
      'article-by-id',
      'article-by-slug',
      'article-with-author',
      'object-spread',
      'page-by-slug',
      'page-featured-refs',
      'pt-text',
    ])
    expect(of('type-list')).toEqual([
      'article-count',
      'article-type-list',
      'articles-by-author-name',
      'articles-ordered-sliced',
      'filter-by-tag',
      'multi-type-list',
      'projection-rename',
      'recent-by-created-at',
      'references-author',
      'stats-aggregate',
    ])
  })
})

describe('§22.6 guard: at most one base fetch and one evaluation per query', () => {
  it.each(CASES)('%s', (_label, def, ov) => {
    const p = atScale.get(key(def.id, ov))!
    expect(
      p.evaluatorInvocations,
      `${def.id} × ${ov}: ${p.evaluatorInvocations} groq-js invocations — §22.6 allows step 5 (base fetch) and step 14 (evaluate original query)`,
    ).toBeLessThanOrEqual(MAX_EVALUATOR_INVOCATIONS)
  })

  it('the cap is tight: some registered plan actually uses both invocations', () => {
    const max = Math.max(...[...atScale.values()].map((p) => p.evaluatorInvocations))
    expect(max, 'a cap above every observed value would be vacuous').toBe(MAX_EVALUATOR_INVOCATIONS)
  })
})

describe('§5.4 "ID or slug preview query, warm" (p95 under 1.5 s): constant work at any scale', () => {
  const idSlug = casesWhere((id) => BUDGET_CLASS[id].klass === 'id-or-slug')

  it.each(idSlug)('%s materialises the same documents at 30 and at 5,000 articles', (_l, def, ov) => {
    const small = atFixture.get(key(def.id, ov))!
    const big = atScale.get(key(def.id, ov))!
    expect(
      big.documentsMaterialized,
      `${def.id} × ${ov}: 30 articles -> ${small.documentsMaterialized} docs, 5,000 articles -> ${big.documentsMaterialized}. ${BUDGET_CLASS[def.id].why}`,
    ).toBe(small.documentsMaterialized)
  })

  it.each(idSlug)('%s stays under the proposed constant-work cap', (_l, def, ov) => {
    const p = atScale.get(key(def.id, ov))!
    expect(p.documentsMaterialized, `${def.id} × ${ov}: ${p.documentsMaterialized} docs`).toBeLessThanOrEqual(
      ID_SLUG_DOC_CAP,
    )
    expect(p.candidateBytes, `${def.id} × ${ov}: ${p.candidateBytes} bytes`).toBeLessThanOrEqual(
      ID_SLUG_BYTE_CAP,
    )
  })

  it.each(idSlug)('%s fetches a constant number of base documents', (_l, def, ov) => {
    const small = atFixture.get(key(def.id, ov))!
    const big = atScale.get(key(def.id, ov))!
    expect(
      big.baseFetchDocuments,
      `${def.id} × ${ov}: base fetch returned ${small.baseFetchDocuments} at 30 articles, ${big.baseFetchDocuments} at 5,000`,
    ).toBe(small.baseFetchDocuments)
  })
})

describe('§5.4 "Type-constrained list query, warm" (p95 under 3 s): work proportional to the answer', () => {
  const proportional = casesWhere((id) => id in HAND_ANSWER)

  it.each(proportional)('%s materialises no more than it returns, plus the branch delta', (_l, def, ov) => {
    const p = atScale.get(key(def.id, ov))!
    const overlay = overlayFor(representative, ov)
    const resolved = applyOverlay(representative, overlay)
    const answer = HAND_ANSWER[def.id].count(resolved, PARAMS[def.id] ?? {})
    const delta = branchDelta(representative, overlay, TYPES_OF[def.id])
    const budget = answer + delta
    expect(
      p.planSelected,
      `${def.id} × ${ov}: plan selected ${p.planSelected}, answer ${answer} + branch delta ${delta} = ${budget}`,
    ).toBeLessThanOrEqual(budget)
  })

  const topK = casesWhere((id) =>
    ['projection-rename', 'articles-ordered-sliced', 'recent-by-created-at'].includes(id),
  )

  it.each(topK)('%s is a bounded top-K: constant work at 30 and at 5,000 articles', (_l, def, ov) => {
    // §22.6's bounded top-K rule is what keeps an ordered slice off the
    // "type-constrained list" cost curve entirely.
    const small = atFixture.get(key(def.id, ov))!
    const big = atScale.get(key(def.id, ov))!
    expect(
      big.documentsMaterialized,
      `${def.id} × ${ov}: 30 articles -> ${small.documentsMaterialized}, 5,000 -> ${big.documentsMaterialized}`,
    ).toBe(small.documentsMaterialized)
  })
})

describe('§22.6 admissions: the three type-linear queries are over budget at representative scale', () => {
  // Not a failure to hide. Recorded, pinned, and tied to its Tier so it cannot
  // rot in either direction: if a planner improvement bounds one of these, the
  // test goes red and the registry + evidence document must be updated.
  it.each(TYPE_LINEAR.map((id) => [id] as const))(
    '%s materialises its whole type and is registered Tier B',
    (id) => {
      const p = atScale.get(key(id, 'empty'))!
      expect(byId(id).status, `${id} scans its type; Tier A would be dishonest`).toBe('tier-b')
      expect(
        p.planSelected,
        `${id}: selected ${p.planSelected} of ${REPRESENTATIVE_ARTICLE_COUNT} articles`,
      ).toBeGreaterThanOrEqual(REPRESENTATIVE_ARTICLE_COUNT)
      expect(
        p.documentsMaterialized,
        `${id}: ${p.documentsMaterialized} docs vs the id/slug cap of ${ID_SLUG_DOC_CAP}`,
      ).toBeGreaterThan(ID_SLUG_DOC_CAP * 100)
    },
  )

  it('§22.6 step 8 ("analyze dereference paths") is not implemented: dereference-free queries still expand', () => {
    // `article-type-list` is `*[_type == "article"]{_id, title}` — it does not
    // dereference anything, yet the spike planner expands references
    // unconditionally and materialises every author. At representative scale
    // that is ~14 % of the candidate set and ~0.7 MiB transferred for nothing.
    // Recorded as an admission so it cannot rot: implementing step 8 turns this
    // red and the evidence document must be updated with the improvement.
    const p = atScale.get(key('article-type-list', 'empty'))!
    const authors = representative.filter((d) => d._type === 'author').length
    expect(byId('article-type-list').query).not.toContain('->')
    expect(
      p.referenceExpansions,
      `article-type-list dereferences nothing but expanded ${p.referenceExpansions} documents`,
    ).toBe(authors)
  })

  it('their cost grows with the dataset, not with the answer', () => {
    for (const id of TYPE_LINEAR) {
      const small = atFixture.get(key(id, 'empty'))!
      const big = atScale.get(key(id, 'empty'))!
      expect(
        big.planSelected / small.planSelected,
        `${id}: ${small.planSelected} -> ${big.planSelected} while the answer stayed the same size`,
      ).toBeGreaterThan(100)
    }
  })
})

// ===========================================================================
// 3. NON-VACUITY. A budget that a materially worse planner would still satisfy
//    is not a budget. These run the REAL planner with the candidate plan
//    swapped for a whole-type scan and require the guard to reject it.
// ===========================================================================

describe('non-vacuity: a planner that scans the type must break the id/slug budget', () => {
  const scan = (def: SpikeQueryDefinition, types: string[]): SpikeQueryDefinition => ({
    ...def,
    candidatePlan: {type: 'types', types},
  })

  it.each(supported.filter((d) => BUDGET_CLASS[d.id].klass === 'id-or-slug').map((d) => [d.id, d] as const))(
    '%s: a type-scanning plan exceeds the cap',
    async (id, def) => {
      const types = id.startsWith('page') ? ['page'] : ['article']
      const mutant = await profileQuery(
        scan(def, types),
        representative,
        overlayFor(representative, 'empty'),
        PARAMS[id] ?? {},
      )
      expect(
        mutant.documentsMaterialized,
        `${id}: a ${types.join('/')} scan materialised ${mutant.documentsMaterialized}, cap ${ID_SLUG_DOC_CAP} — if this passes the cap is vacuous`,
      ).toBeGreaterThan(ID_SLUG_DOC_CAP)
      expect(mutant.candidateBytes).toBeGreaterThan(ID_SLUG_BYTE_CAP)
    },
    120_000,
  )

  it('the constancy check would also reject it (5,000-article scan is not 30-article scan)', async () => {
    const def = byId('article-by-slug')
    const small = await profileQuery(scan(def, ['article']), fixtureBase, overlayFor(fixtureBase, 'empty'), PARAMS['article-by-slug'])
    const big = await profileQuery(scan(def, ['article']), representative, overlayFor(representative, 'empty'), PARAMS['article-by-slug'])
    expect(small.documentsMaterialized).toBeLessThan(big.documentsMaterialized)
  }, 120_000)
})

// ===========================================================================
// 4. WALL CLOCK — EVIDENCE, NOT A GATE. The only assertion here is that the
//    work profile is REPRODUCIBLE across repetitions, which is why the printed
//    numbers can be quoted in an evidence document at all.
// ===========================================================================

describe('measured latency at representative scale (evidence)', () => {
  it('every registered query produced a measurement', () => {
    expect([...samples.keys()].sort()).toEqual(supported.map((d) => d.id).sort())
    for (const runs of samples.values()) expect(runs).toHaveLength(REPS)
  })

  it('the work profile is identical across every repetition (the numbers reproduce)', () => {
    for (const [id, runs] of samples) {
      const first = runs[0]
      for (const r of runs) {
        expect(r.documentsMaterialized, `${id}: candidate count varied between runs`).toBe(
          first.documentsMaterialized,
        )
        expect(r.candidateBytes, `${id}: candidate bytes varied between runs`).toBe(first.candidateBytes)
        expect(r.evaluatorInvocations, `${id}: invocation count varied between runs`).toBe(
          first.evaluatorInvocations,
        )
      }
    }
  })

  it('emits the p50/p95 evidence table', () => {
    const head = [
      'query', 'tier', '§5.4 row', 'docs', 'sel', 'refs', 'KiB', 'inv', 'baseFetch docs',
      'sim fetch p50', 'overlay p50', 'overlay p95', 'spread', 'total p50', 'total p95', '§5.4 p95', 'overlay share',
    ]
    const rows = supported.map((def) => {
      const runs = samples.get(def.id)!
      const p = runs[0]
      const overlayMs = runs.map((r) => r.planMs + r.evaluateMs)
      const totals = runs.map((r) => r.totalMs)
      const budget = PRD_5_4[BUDGET_CLASS[def.id].klass].p95Ms
      const overlayP95 = percentile(overlayMs, 0.95)
      return [
        def.id,
        byId(def.id).status === 'tier-a' ? 'A' : 'B',
        BUDGET_CLASS[def.id].klass,
        String(p.documentsMaterialized),
        String(p.planSelected),
        String(p.referenceExpansions),
        (p.candidateBytes / 1024).toFixed(1),
        String(p.evaluatorInvocations),
        String(p.baseFetchDocuments),
        percentile(runs.map((r) => r.baseFetchMs), 0.5).toFixed(1),
        percentile(overlayMs, 0.5).toFixed(1),
        overlayP95.toFixed(1),
        `${(Math.max(...overlayMs) / Math.max(Math.min(...overlayMs), 0.001)).toFixed(0)}x`,
        percentile(totals, 0.5).toFixed(1),
        percentile(totals, 0.95).toFixed(1),
        String(budget),
        `${((overlayP95 / budget) * 100).toFixed(0)}%`,
      ]
    })
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`
    const report = [
      `Spike C latency @ ${REPRESENTATIVE_ARTICLE_COUNT} articles ` +
        `(${representative.length} docs, ${(datasetBytes(representative) / 1024 / 1024).toFixed(2)} MiB), ` +
        `empty overlay, ${REPS} reps, milliseconds.`,
      '',
      '- `overlay` = planMs + evaluateMs: the work the overlay itself adds (§22.6 steps 1-4, 6-14).',
      '- `sim fetch` = the harness SIMULATING §22.6 step 5 by running the base filter through',
      '  groq-js over the whole base. In production Sanity answers this from an index and it is a',
      '  network round trip, so this column is a harness artefact and is excluded from `overlay share`.',
      '- `total` = sim fetch + overlay, i.e. everything this process did. Reported for completeness.',
      '- `spread` = slowest overlay run / fastest overlay run, same input, same process. This column',
      '  is why nothing here is gated on wall clock: the work is byte-identical across repetitions',
      '  while the time is not, because the small queries absorb the GC pauses caused by the 5 MiB',
      '  candidate sets the type-list queries allocate in the same process.',
      '- `overlay share` = overlay p95 against the §5.4 END-TO-END budget, of which the network,',
      '  serialisation and transport are not measured here. A share near 100 % means the budget is',
      '  already spent before anything leaves the process.',
      '',
      line(head),
      line(head.map(() => '---')),
      ...rows.map(line),
    ].join('\n')
    // Vitest swallows console output under a non-TTY reporter, so the evidence
    // run captures the table through SPIKE_C_LATENCY_OUT instead.
    const out = process.env.SPIKE_C_LATENCY_OUT
    if (out) writeFileSync(out, `${report}\n`)
    // eslint-disable-next-line no-console
    else console.log(`\n${report}`)
    expect(rows).toHaveLength(supported.length)
  })

  it('there is deliberately NO wall-clock gate, and the measurements show why', () => {
    // An earlier draft of this file gated the `id-or-slug` class at half its
    // §5.4 budget (750 ms) on the grounds that those queries evaluate single
    // digit document counts and measure ~1 ms — a claimed 700x margin.
    // Measurement refuted it: in a 31-repetition run `pt-text` (SIX candidate
    // documents, p50 5.4 ms) recorded a p95 of 348.9 ms, because the same
    // process is allocating 5 MiB candidate sets for the type-list queries and
    // the small queries absorb the garbage collector's pauses. The margin was
    // 2x, not 700x, and on a loaded CI machine that gate would flake.
    //
    // So the gate is the deterministic work above, and wall clock is evidence.
    // The assertion here is the reason that split is sound: work has ZERO
    // spread across repetitions while time does not.
    let timeVaried = false
    for (const [id, runs] of samples) {
      if (runs.length < 2) continue
      const work = new Set(runs.map((r) => r.documentsMaterialized))
      expect(work.size, `${id}: work must be perfectly reproducible`).toBe(1)
      const ms = runs.map((r) => r.planMs + r.evaluateMs)
      if (Math.max(...ms) > Math.min(...ms)) timeVaried = true
    }
    expect(timeVaried, 'if wall clock were reproducible it could be gated; it is not').toBe(true)
  })
})

// The unsupported query never reaches an evaluator at all: no work, no budget.
describe('Tier C', () => {
  it('unconstrained-star is rejected before any candidate is materialised', async () => {
    await expect(
      evaluateRegistered(byId('unconstrained-star'), representative, overlayFor(representative, 'empty')),
    ).rejects.toThrow(/UNSUPPORTED_GROQ/)
  })
})
