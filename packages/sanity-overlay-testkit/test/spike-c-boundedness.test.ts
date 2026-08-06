import {describe, expect, it} from 'vitest'
import {type FixtureDocument, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'
import {OVERLAY_FIXTURES, type SpikeOverlay, applyOverlay} from '../spike-c/overlay'
import {type SpikeQueryDefinition, evaluateOracle, evaluateRegistered} from '../spike-c/planner'
import {REGISTRY, byId} from '../spike-c/registry'

// ===========================================================================
// SPIKE C — §22.6 BOUNDEDNESS, PROVEN AGAINST AN INDEPENDENT ORACLE
//
// Why this file exists (evidence review 2026-08-04, finding F6):
//
//   `mutation-gaps.test.ts` GAP 2 asserts a per-plan-type ceiling, but for the
//   9 `slug`/`types` queries that ceiling *restates the planner*: it recomputes
//   "every document of the candidate type", which is literally the loop in
//   `planner.ts`. `article-by-slug` scanned all 30 articles to return ONE
//   document and passed. A ceiling derived from the implementation cannot
//   falsify the implementation — the same defect as the first self-correction
//   (parity cannot detect over-fetching), one level up.
//
// The ceilings below are derived from TWO things only:
//   (a) the semantics of the registered query text, read by a human, and
//   (b) the fixture dataset, measured through groq-js.
// Nothing here reads `def.candidatePlan`, and no constant is copied from
// `planner.ts`. `K` is parsed out of the query's own `[0...K]` slice, not read
// from the registry. Every entry carries a `why` recording the argument for
// why no exact planner could do better.
//
// Three classes, assigned by hand (PRD §22.3 / §22.6):
//
//   constant            — the candidate set does not grow with the dataset.
//                         §22.6's actual claim. Proven by the 10x scale sweep.
//   result-proportional — the candidate set is bounded by the size of the
//                         ANSWER plus the branch delta. It grows only because
//                         the caller asked for that many documents; no planner
//                         can materialize fewer documents than it returns.
//   type-linear         — the candidate set grows with the TYPE while the
//                         answer stays small. This is NOT bounded in the §22.6
//                         sense. Recorded honestly, classified Tier B, and
//                         pinned as growing by the scale sweep so the
//                         classification cannot silently rot.
// ===========================================================================

const base = publishedPerspective(loadFixtureDataset())
const supported = REGISTRY.filter((d) => d.status !== 'unsupported')

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

interface Ctx {
  def: SpikeQueryDefinition
  dataset: FixtureDocument[]
  overlay: SpikeOverlay
  params: Record<string, unknown>
}

type BoundClass = 'constant' | 'result-proportional' | 'referrer-proportional' | 'type-linear'

interface BoundSpec {
  /** Hand-assigned. `type-linear` is an admission, not a pass. */
  klass: BoundClass
  /** Document types whose branch records can enter/leave/reorder the answer. */
  types: string[]
  /** Documents any EXACT planner must materialize, from query semantics only. */
  ceiling: (c: Ctx) => Promise<number>
  why: string
}

// --- independent measurements ----------------------------------------------

/** Branch delta: overlay records + tombstones that touch the given types. */
function branchDelta(c: Ctx, types: string[]): number {
  const baseById = new Map(c.dataset.map((d) => [d._id, d]))
  const ids = new Set<string>()
  for (const [id, d] of c.overlay.documents) {
    if (types.includes(d._type) || types.includes(baseById.get(id)?._type ?? '')) ids.add(id)
  }
  for (const id of c.overlay.tombstones) {
    if (types.includes(baseById.get(id)?._type ?? '')) ids.add(id)
  }
  return ids.size
}

/**
 * How many BASE documents a server-side filtered fetch would return. This is
 * the fetch Sanity itself can answer (PRD §22.7: "exact slug-filtered pages
 * plus all overlaid page documents"), so it is a legitimate lower bound on
 * what the planner must transfer — and an upper bound on what it may.
 */
async function baseFetch(c: Ctx, groq: string): Promise<number> {
  return (await runGroq<unknown[]>(groq, c.dataset, c.params)).length
}

/** Documents of the candidate types present in the resolved virtual dataset. */
function typeScan(c: Ctx, types: string[]): number {
  return applyOverlay(c.dataset, c.overlay).filter((d) => types.includes(d._type)).length
}

/** True when `value` holds a reference to `id` anywhere inside it. */
function hasRefTo(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasRefTo(v, id))
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (o._ref === id) return true
    return Object.values(o).some((v) => hasRefTo(v, id))
  }
  return false
}

/**
 * §22.6 step 10's blast radius: BASE documents of `types` that reference any id
 * the branch touched. Editing a reference TARGET can add or remove a referrer
 * from the answer, so no exact reverse-reference plan may fetch fewer than
 * these — and none needs to fetch more.
 */
function referrersOfTouched(c: Ctx, types: string[]): number {
  const touched = [...c.overlay.documents.keys(), ...c.overlay.tombstones]
  return c.dataset.filter((d) => types.includes(d._type) && touched.some((id) => hasRefTo(d, id)))
    .length
}

/** Size of the ANSWER, measured through the oracle (never through the plan). */
async function answerSize(c: Ctx): Promise<number> {
  const r = await evaluateOracle(c.def, c.dataset, c.overlay, c.params)
  if (Array.isArray(r)) return r.length
  return r == null ? 0 : 1
}

/** K, parsed out of the query's own slice — not read from the registry. */
function sliceEndFromQuery(query: string): number {
  const m = query.match(/\[\s*0\s*\.\.\.\s*(\d+)\s*\]/)
  if (!m) throw new Error(`no [0...K] slice in query text: ${query}`)
  return Number(m[1])
}

// --- the hand-written classification table ---------------------------------
// One entry per supported query. `ceiling` NEVER consults def.candidatePlan.

const idLookup = (why: string): BoundSpec => ({
  klass: 'constant',
  types: ['article', 'page'],
  ceiling: async () => 1,
  why,
})

const topK = (types: string[]): BoundSpec => ({
  klass: 'constant',
  types,
  // §22.6: requestedEnd + affectedCount. Any untouched base document below the
  // top (K) of the UNTOUCHED base order has K untouched documents ordered above
  // it, all of which keep their order in the merged set, so it cannot enter the
  // requested slice. Fetching K + 2*affected is therefore over-fetching.
  ceiling: async (c) => sliceEndFromQuery(c.def.query) + branchDelta(c, types),
  why: '§22.6 bounded top-K: K untouched base documents plus the branch delta',
})

const BOUNDS: Record<string, BoundSpec> = {
  'article-by-id': idLookup('the query names exactly one _id'),
  'object-spread': idLookup('the query names exactly one _id'),
  'article-with-author': idLookup('one _id; the author arrives by reference expansion'),
  'pt-text': idLookup('the query names exactly one _id'),
  'page-featured-refs': idLookup('the query names the literal _id "page-home"'),

  'page-by-slug': {
    klass: 'constant',
    types: ['page'],
    ceiling: async (c) =>
      (await baseFetch(c, `*[_type == "page" && slug.current == $slug]`)) +
      branchDelta(c, ['page']),
    why:
      'slug equality is a local-field predicate: Sanity can answer it with a filtered ' +
      'fetch, and only a branch page can newly match. A 1-document answer must not ' +
      'cost a scan of every page.',
  },
  'article-by-slug': {
    klass: 'constant',
    types: ['article'],
    ceiling: async (c) =>
      (await baseFetch(c, `*[_type == "article" && slug.current == $slug]`)) +
      branchDelta(c, ['article']),
    why:
      'same as page-by-slug. F6 names this query specifically: it returned 1 document ' +
      'and scanned 30.',
  },
  'filter-by-tag': {
    klass: 'result-proportional',
    types: ['article'],
    ceiling: async (c) =>
      (await baseFetch(c, `*[_type == "article" && "featured" in tags]`)) +
      branchDelta(c, ['article']),
    why:
      'array membership is a local-field predicate and pushes down to the base fetch; ' +
      'only branch articles can newly match.',
  },
  'references-author': {
    klass: 'result-proportional',
    types: ['article'],
    ceiling: async (c) =>
      (await baseFetch(c, `*[_type == "article" && references($authorId)]`)) +
      branchDelta(c, ['article']),
    why:
      'references() over a finite id is a base-answerable predicate (§22.3 Tier A). ' +
      'Membership depends on the referring document only, so tombstoning or editing ' +
      'the target cannot add referrers.',
  },

  'projection-rename': topK(['article']),
  'articles-ordered-sliced': topK(['article']),
  'recent-by-created-at': topK(['article']),

  'article-type-list': {
    klass: 'result-proportional',
    types: ['article'],
    ceiling: async (c) => (await answerSize(c)) + branchDelta(c, ['article']),
    why:
      'the answer IS every article; a planner cannot materialize fewer documents than ' +
      'it returns. Linear in the type only because the caller asked for the type.',
  },
  'multi-type-list': {
    klass: 'result-proportional',
    types: ['article', 'page'],
    ceiling: async (c) => (await answerSize(c)) + branchDelta(c, ['article', 'page']),
    why: 'as article-type-list, over two types',
  },

  // --- aggregate pushdown, 2026-08-06 (was `type-linear`) -------------------
  // The virtual dataset partitions exactly into {base documents the branch did
  // not touch} and {resolved touched documents}; count() and math::sum() are
  // additive over that partition. A base that aggregates the first half
  // server-side therefore leaves ONLY the branch delta to materialize, and the
  // answer stays exact because every document is aggregated in exactly one half.
  'article-count': {
    klass: 'constant',
    types: ['article'],
    ceiling: async (c) => branchDelta(c, ['article']),
    why:
      'an additive aggregate needs no document the base can aggregate itself. What is ' +
      'left is the branch delta, which does not grow with the dataset.',
  },
  'stats-aggregate': {
    klass: 'constant',
    types: ['article'],
    ceiling: async (c) => branchDelta(c, ['article']),
    why: 'as article-count: math::sum is additive over the same partition.',
  },

  // --- §22.6 step 10 reverse-reference expansion, 2026-08-06 ---------------
  'articles-by-author-name': {
    klass: 'referrer-proportional',
    types: ['article'],
    // Three terms, each measured from the query text and the fixture data:
    //   base matches         — referrers already matching in the BASE state;
    //   referrers-of-touched — the ONLY base non-matches a branch edit to a
    //                          target can turn into matches;
    //   branch delta         — branch records of the referrer type (step 6).
    // No fourth case exists, so this is the optimum for an exact planner, and
    // it is derived without reading `def.candidatePlan`.
    ceiling: async (c) =>
      (await baseFetch(c, `*[_type == "article" && author->name == $name]`)) +
      referrersOfTouched(c, ['article']) +
      branchDelta(c, ['article']),
    why:
      'BOUNDED BUT NOT CONSTANT. §22.6 step 10 replaces the §22.7-sanctioned type scan ' +
      'with the referrers of the touched targets. The bound is the branch blast radius, ' +
      'which is a property of the DATA — touching every author still pulls in every ' +
      'article — so the honest tier stays B.',
  },
}

const overlayNames = Object.keys(OVERLAY_FIXTURES)
/** [label, definition, overlay-fixture-name] — label keeps it.each titles readable. */
const CASES = supported.flatMap((def) =>
  overlayNames.map((ov) => [`${def.id} x ${ov}`, def, ov] as const),
)
const casesWhere = (pred: (id: string) => boolean) => CASES.filter(([, def]) => pred(def.id))

const ctxFor = (def: SpikeQueryDefinition, dataset: FixtureDocument[], ov: string): Ctx => ({
  def,
  dataset,
  overlay: OVERLAY_FIXTURES[ov](dataset),
  params: PARAMS[def.id] ?? {},
})

/** Documents the PLAN chose. Reference expansion is a separate mechanism. */
async function planSelected(c: Ctx): Promise<number> {
  const {diagnostics} = await evaluateRegistered(c.def, c.dataset, c.overlay, c.params)
  return diagnostics.candidateCount - diagnostics.referenceExpansions
}

/**
 * EVERY document the planner materialized, reference expansion included. This
 * is the quantity §22.6 is actually about — documents transferred — whereas
 * `planSelected` isolates the plan's own choice. Asserting only `planSelected`
 * would leave dereference free to be unbounded.
 */
async function totalMaterialized(c: Ctx): Promise<number> {
  const {diagnostics} = await evaluateRegistered(c.def, c.dataset, c.overlay, c.params)
  return diagnostics.candidateCount
}

// ===========================================================================
// 1. Every supported query is classified, and the table cannot rot silently.
// ===========================================================================

describe('§22.6: every registered query carries a hand-written bound classification', () => {
  it('the bound table covers exactly the supported registry', () => {
    expect(Object.keys(BOUNDS).sort()).toEqual(supported.map((d) => d.id).sort())
  })

  it('the classification split is pinned (a reclassification must be deliberate)', () => {
    const of = (k: BoundClass) =>
      Object.entries(BOUNDS)
        .filter(([, s]) => s.klass === k)
        .map(([id]) => id)
        .sort()
    expect(of('constant')).toEqual([
      'article-by-id',
      'article-by-slug',
      'article-count',
      'article-with-author',
      'articles-ordered-sliced',
      'object-spread',
      'page-by-slug',
      'page-featured-refs',
      'projection-rename',
      'pt-text',
      'recent-by-created-at',
      'stats-aggregate',
    ])
    expect(of('result-proportional')).toEqual([
      'article-type-list',
      'filter-by-tag',
      'multi-type-list',
      'references-author',
    ])
    expect(of('referrer-proportional')).toEqual(['articles-by-author-name'])
    // The 2026-08-04 admissions. Empty since 2026-08-06: aggregate pushdown
    // moved two entries to `constant` and §22.6 step 10 moved the third to
    // `referrer-proportional`. Growing this list again is a Tier regression and
    // the evidence document must record it.
    expect(of('type-linear')).toEqual([])
  })

  it('every type-linear query is registered Tier B, never Tier A', () => {
    for (const [id, spec] of Object.entries(BOUNDS)) {
      if (spec.klass !== 'type-linear') continue
      expect(byId(id).status, `${id} is type-linear (${spec.why})`).toBe('tier-b')
    }
  })

  it('the referrer-proportional query is registered Tier B: bounded is not constant', () => {
    // §22.6's claim is about candidate sets that do not grow with the dataset.
    // A bound whose size is the branch's referrer fan-out satisfies "not a type
    // scan" without satisfying that, so Tier A would overstate it.
    for (const [id, spec] of Object.entries(BOUNDS)) {
      if (spec.klass !== 'referrer-proportional') continue
      expect(byId(id).status, `${id} is referrer-proportional (${spec.why})`).toBe('tier-b')
    }
  })

  it('every constant-class aggregate is registered Tier A: §22.3 "aggregates over a proven finite candidate set"', () => {
    for (const id of ['article-count', 'stats-aggregate']) {
      expect(BOUNDS[id].klass).toBe('constant')
      expect(byId(id).status, `${id} materializes only the branch delta`).toBe('tier-a')
    }
  })
})

// ===========================================================================
// 2. The ceiling sweep: 17 queries x 6 overlays against the independent bound.
// ===========================================================================

describe('§22.6: plan-selected candidates stay within the independent ceiling', () => {
  it.each(CASES)('%s', async (_label, def, ov) => {
    const c = ctxFor(def, base, ov)
    const spec = BOUNDS[def.id]
    const ceiling = await spec.ceiling(c)
    const selected = await planSelected(c)
    expect(
      selected,
      `${def.id} x ${ov}: plan selected ${selected}, independent ceiling ${ceiling} (${spec.klass}) — ${spec.why}`,
    ).toBeLessThanOrEqual(ceiling)
  })
})

// ===========================================================================
// 3. The 10x scale sweep — the only way to tell a constant bound from a linear
// one (evidence review F6: "at 41 documents they are indistinguishable").
// ===========================================================================

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/**
 * Deterministic 10x fixture: 300 articles, same pages/authors/settings.
 *
 * INVARIANT — the added documents must sort strictly BELOW every original on
 * EVERY field the registry orders by (`publishedAt` and `_createdAt`), so that
 * every top-K answer is byte-identical at 1x and 10x. Otherwise scaling changes
 * the ANSWER as well as the dataset and the sweep measures two things at once.
 * Missing `_createdAt` here is what made the first run of the total-materialized
 * test go red: ten clones tied on each original timestamp, the top-5 `_createdAt`
 * window drew from the tie group, and it dereferenced a different set of authors.
 */
const ORDER_FIELDS = ['publishedAt', '_createdAt'] as const

function scaleArticles(dataset: FixtureDocument[], factor: number): FixtureDocument[] {
  const out = [...dataset]
  const articles = dataset.filter((d) => d._type === 'article')
  for (let copy = 1; copy < factor; copy++) {
    for (const a of articles) {
      const n = copy * 1000 + Number(a._id.slice('article-'.length))
      const d = clone(a)
      d._id = `article-${n}`
      d._rev = `fixture-rev-article-${n}`
      d.title = `Article ${n}`
      d.slug = {_type: 'slug', current: `article-scale-${n}`}
      const stamp = `2025-01-01T12:00:${String(n % 60).padStart(2, '0')}Z`
      for (const f of ORDER_FIELDS) d[f] = stamp
      d._updatedAt = stamp
      out.push(d)
    }
  }
  return out
}

const scaled = scaleArticles(base, 10)

describe('§22.6: boundedness at 10x dataset scale', () => {
  it('the scaled fixture really is 10x the articles and keeps the fixtures unique', () => {
    expect(scaled.filter((d) => d._type === 'article')).toHaveLength(300)
    expect(scaled.filter((d) => d._type === 'page')).toHaveLength(3)
    expect(new Set(scaled.map((d) => d._id)).size).toBe(scaled.length)
    // The parameterised lookups must still be single-match at scale.
    expect(
      scaled.filter((d) => (d.slug as {current?: string} | undefined)?.current === 'article-7'),
    ).toHaveLength(1)
  })

  it('every added article sorts strictly below every original on every ordered field', () => {
    // Guards the invariant above. Without it the 10x sweep silently changes the
    // ANSWER as well as the dataset, and a "grew by 2" reads as a planner bug.
    const originals = base.filter((d) => d._type === 'article')
    const originalIds = new Set(originals.map((d) => d._id))
    const added = scaled.filter((d) => d._type === 'article' && !originalIds.has(d._id))
    expect(added).toHaveLength(270)
    for (const f of ORDER_FIELDS) {
      const ms = (d: FixtureDocument) => Date.parse(String(d[f]))
      const lowestOriginal = Math.min(...originals.map(ms))
      const highestAdded = Math.max(...added.map(ms))
      expect(highestAdded, `field ${f}: added must sort strictly below originals`).toBeLessThan(
        lowestOriginal,
      )
    }
  })

  it.each(CASES)('%s stays within its ceiling at 10x', async (_label, def, ov) => {
    const c = ctxFor(def, scaled, ov)
    const spec = BOUNDS[def.id]
    const ceiling = await spec.ceiling(c)
    const selected = await planSelected(c)
    expect(
      selected,
      `${def.id} x ${ov} @10x: selected ${selected}, ceiling ${ceiling} (${spec.klass})`,
    ).toBeLessThanOrEqual(ceiling)
  })

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s selects the SAME number of candidates at 1x and 10x',
    async (_label, def, ov) => {
      const at1 = await planSelected(ctxFor(def, base, ov))
      const at10 = await planSelected(ctxFor(def, scaled, ov))
      expect(at10, `${def.id} x ${ov}: 1x selected ${at1}, 10x selected ${at10}`).toBe(at1)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'result-proportional'))(
    '%s grows at 10x only as far as its answer does',
    async (_label, def, ov) => {
      const c1 = ctxFor(def, base, ov)
      const c10 = ctxFor(def, scaled, ov)
      const [sel1, sel10, ans1, ans10] = [
        await planSelected(c1),
        await planSelected(c10),
        await answerSize(c1),
        await answerSize(c10),
      ]
      expect(
        sel10 - sel1,
        `${def.id} x ${ov}: candidates grew ${sel10 - sel1}, answer grew ${ans10 - ans1}`,
      ).toBeLessThanOrEqual(ans10 - ans1 + branchDelta(c10, BOUNDS[def.id].types))
    },
  )

  // Reference expansion is the one mechanism `planSelected` deliberately does
  // not police. If it grew with the dataset, a "constant" plan would still
  // transfer a linear number of documents and §22.6 would be unproven — so the
  // TOTAL is pinned too, not just the plan's own choice.
  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s materializes the SAME total (reference expansion included) at 1x and 10x',
    async (_label, def, ov) => {
      const at1 = await totalMaterialized(ctxFor(def, base, ov))
      const at10 = await totalMaterialized(ctxFor(def, scaled, ov))
      expect(at10, `${def.id} x ${ov}: 1x total ${at1}, 10x total ${at10}`).toBe(at1)
    },
  )

  it.each(
    supported.filter((d) => BOUNDS[d.id].klass === 'type-linear').map((d) => [d.id, d] as const),
  )('%s is HONESTLY UNBOUNDED: it grows with the type at 10x', async (_id, def) => {
    const at1 = await planSelected(ctxFor(def, base, 'empty'))
    const at10 = await planSelected(ctxFor(def, scaled, 'empty'))
    // If this ever fails because the planner improved, promote the query's
    // class in BOUNDS and its status in the registry — do not delete the test.
    expect(
      at10,
      `${def.id}: 1x ${at1} -> 10x ${at10}. ${BOUNDS[def.id].why}`,
    ).toBeGreaterThanOrEqual(at1 * 5)
  })

  it('no query is type-linear any more, and the 10x sweep is what proves it', async () => {
    // The `it.each` above is now empty, and an empty parameterised block proves
    // nothing. This is the positive form: every supported query is either
    // bounded by its own answer or does not grow at all.
    expect(supported.filter((d) => BOUNDS[d.id].klass === 'type-linear')).toHaveLength(0)
    for (const def of supported) {
      if (BOUNDS[def.id].klass !== 'constant') continue
      const at1 = await planSelected(ctxFor(def, base, 'empty'))
      const at10 = await planSelected(ctxFor(def, scaled, 'empty'))
      expect(at10, `${def.id}: 1x ${at1} -> 10x ${at10}`).toBe(at1)
    }
  })
})

// ===========================================================================
// 4. NON-VACUITY. The first self-correction happened because nothing proved an
// unbounded planner would fail. These tests are that proof, permanently.
// ===========================================================================

describe('non-vacuity: deliberately unbounded planners must fail this suite', () => {
  it('a planner that returns the whole virtual dataset violates every ceiling', async () => {
    let violations = 0
    for (const [, def, ov] of CASES) {
      const c = ctxFor(def, base, ov)
      const unbounded = applyOverlay(c.dataset, c.overlay).length
      const ceiling = await BOUNDS[def.id].ceiling(c)
      if (unbounded > ceiling) violations++
    }
    expect(violations, 'a whole-dataset planner must break all 102 cases').toBe(CASES.length)
  })

  it('a planner that scans the whole candidate TYPE still violates every constant ceiling', async () => {
    // This is finding F6 exactly: the old GAP-2 ceiling WAS the type scan, so a
    // full type scan passed it. Under these ceilings it must not.
    const constant = casesWhere((id) => BOUNDS[id].klass === 'constant')
    expect(constant.length).toBeGreaterThan(0)
    for (const [, def, ov] of constant) {
      const c = ctxFor(def, base, ov)
      const spec = BOUNDS[def.id]
      const scan = typeScan(c, spec.types)
      const ceiling = await spec.ceiling(c)
      expect(
        scan,
        `${def.id} x ${ov}: a full ${spec.types.join('/')} scan is ${scan}, ceiling ${ceiling} — the ceiling would be satisfied by a scan, i.e. vacuous`,
      ).toBeGreaterThan(ceiling)
    }
  })

  it('at 10x, a type scan violates the constant ceilings by an order of magnitude', async () => {
    const c = ctxFor(byId('article-by-slug'), scaled, 'empty')
    const ceiling = await BOUNDS['article-by-slug'].ceiling(c)
    expect(ceiling).toBe(1)
    expect(typeScan(c, ['article'])).toBe(300)
  })
})

// ===========================================================================
// 5. NON-VACUITY, END TO END. Section 4 argues arithmetically about what an
// unbounded planner WOULD select. That is not the same as running one: the
// numbers could be right while `diagnostics.candidateCount` under-reports, or
// while `planSelected` subtracts away the over-fetch as "reference expansion".
//
// So these two run the REAL `evaluateRegistered` with the plan swapped for a
// deliberately unbounded one, and require the ceiling sweep above to reject it.
// The first self-correction happened because nothing like this existed.
// ===========================================================================

const ALL_TYPES = [...new Set(base.map((d) => d._type))]

/** The same def with its candidate plan replaced by an unbounded scan. */
const withPlan = (def: SpikeQueryDefinition, types: string[]): SpikeQueryDefinition => ({
  ...def,
  candidatePlan: {type: 'types', types},
})

describe('non-vacuity (executed): a deliberately unbounded planner fails the ceiling sweep', () => {
  it('the mutant plans really are distinct from the registered ones', () => {
    expect(ALL_TYPES.length).toBeGreaterThan(1)
    // A `types`-over-every-type plan is the E2/E3/E4 mutation in plan form.
    expect(ALL_TYPES).toContain('article')
    expect(ALL_TYPES).toContain('page')
  })

  it.each(CASES)(
    '%s: a whole-dataset plan run through the real planner exceeds the ceiling',
    async (_label, def, ov) => {
      const c = ctxFor(def, base, ov)
      const ceiling = await BOUNDS[def.id].ceiling(c)
      const mutant = await planSelected({...c, def: withPlan(def, ALL_TYPES)})
      expect(
        mutant,
        `${def.id} x ${ov}: unbounded planner selected ${mutant}, ceiling ${ceiling} — if this passes, the ceiling is vacuous`,
      ).toBeGreaterThan(ceiling)
    },
  )

  it.each(casesWhere((id) => BOUNDS[id].klass === 'constant'))(
    '%s: the PRE-F6 plan (scan the candidate type) exceeds the ceiling',
    async (_label, def, ov) => {
      // This is precisely what `article-by-slug` used to do: 30 documents in,
      // 1 document out, and the old GAP-2 ceiling said fine.
      const c = ctxFor(def, base, ov)
      const spec = BOUNDS[def.id]
      const ceiling = await spec.ceiling(c)
      const mutant = await planSelected({...c, def: withPlan(def, spec.types)})
      expect(
        mutant,
        `${def.id} x ${ov}: a full ${spec.types.join('/')} scan selected ${mutant}, ceiling ${ceiling}`,
      ).toBeGreaterThan(ceiling)
    },
  )
})
