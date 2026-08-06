import {describe, expect, it} from 'vitest'
import {type FixtureDocument, draftsPerspective, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {OVERLAY_FIXTURES, type SpikeOverlay, emptyOverlay} from '../spike-c/overlay'
import {type CandidatePlan, type SpikeQueryDefinition, evaluateOracle, evaluateRegistered} from '../spike-c/planner'
import {REGISTRY, byId} from '../spike-c/registry'
import {type SchemaArtifact, clone, loadBaseArtifact} from '../spike-d/artifact'
import {type Finding, type FindingCode, scan} from '../spike-d/scanner'
import * as variants from '../spike-d/variants'

// ---------------------------------------------------------------------------
// MUTATION-GAP REGRESSION TESTS
//
// Every test in this file exists because a deliberate mutation of spike-c or
// spike-d produced ZERO failures in the pre-existing suite. Each `describe`
// block names the mutation(s) it makes detectable. Do not weaken an assertion
// here without re-running the mutation it was written to catch.
// ---------------------------------------------------------------------------

const raw = loadFixtureDataset()
const base = publishedPerspective(raw)
const draftsBase = draftsPerspective(raw)

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

const supported = REGISTRY.filter((d) => d.status !== 'unsupported')

const tombstoneOverlay = (...ids: string[]): SpikeOverlay => {
  const o = emptyOverlay()
  for (const id of ids) o.tombstones.add(id)
  return o
}

/** planner === oracle for one (query, overlay, perspective) triple. */
async function expectParity(
  def: SpikeQueryDefinition,
  dataset: FixtureDocument[],
  overlay: SpikeOverlay,
): Promise<unknown> {
  const params = PARAMS[def.id] ?? {}
  const oracle = await evaluateOracle(def, dataset, overlay, params)
  const {result} = await evaluateRegistered(def, dataset, overlay, params)
  expect(result).toEqual(oracle)
  return result
}

// ===========================================================================
// GAP 1 — registry inventory is unpinned.
// Mutations M8 (flip a Tier A entry's status to 'unsupported') and E1 (delete a
// Tier A entry outright) both went GREEN: the parity suite derives its own
// case list from REGISTRY, so shrinking REGISTRY silently shrinks coverage
// (314 -> 308 tests) instead of failing. A "all Tier A queries reach parity"
// claim is worthless if the Tier A set is whatever the file happens to say.
// ===========================================================================

// Tier reclassification 2026-08-04 (evidence review F6): article-count,
// stats-aggregate and articles-by-author-name moved tier-a -> tier-b, each
// materializing EVERY document of its type to answer a small question.
//
// Tier reclassification 2026-08-06 (latency-2026-08-04.md §8): two of those
// three moved BACK to tier-a because the planner stopped doing that.
// article-count and stats-aggregate now push the aggregate down to the base and
// materialize only the branch delta, which is §22.3 Tier A's "aggregates over a
// proven finite candidate set". articles-by-author-name stays tier-b: §22.6
// step 10 replaced its type scan with the referrers of the touched targets,
// which is bounded by the branch's blast radius rather than constant. The
// reasoning is recorded per entry in registry.ts and swept by
// test/spike-c-boundedness.test.ts.
const EXPECTED_TIER_A = [
  'article-by-id',
  'page-by-slug',
  'article-by-slug',
  'article-type-list',
  'multi-type-list',
  'projection-rename',
  'object-spread',
  'articles-ordered-sliced',
  'filter-by-tag',
  'article-with-author',
  'page-featured-refs',
  'references-author',
  'pt-text',
  'article-count',
  'stats-aggregate',
]
const EXPECTED_TIER_B = ['articles-by-author-name', 'recent-by-created-at']
const EXPECTED_UNSUPPORTED = ['unconstrained-star']
const EXPECTED_OVERLAY_FIXTURES = [
  'empty',
  'filter-change',
  'sort-change',
  'branch-create',
  'tombstone',
  'ref-target-change',
]

describe('GAP 1: registry inventory + coverage matrix are pinned (M8, E1)', () => {
  it('the Tier A inventory is exactly the registered Tier A queries', () => {
    expect(REGISTRY.filter((d) => d.status === 'tier-a').map((d) => d.id).sort()).toEqual(
      [...EXPECTED_TIER_A].sort(),
    )
  })

  it('the Tier B and unsupported inventories are exactly as classified', () => {
    expect(REGISTRY.filter((d) => d.status === 'tier-b').map((d) => d.id).sort()).toEqual(
      [...EXPECTED_TIER_B].sort(),
    )
    expect(REGISTRY.filter((d) => d.status === 'unsupported').map((d) => d.id)).toEqual(
      EXPECTED_UNSUPPORTED,
    )
  })

  it('the registry holds exactly 18 entries with unique ids', () => {
    expect(REGISTRY).toHaveLength(
      EXPECTED_TIER_A.length + EXPECTED_TIER_B.length + EXPECTED_UNSUPPORTED.length,
    )
    expect(new Set(REGISTRY.map((d) => d.id)).size).toBe(REGISTRY.length)
  })

  it.each(EXPECTED_TIER_A)('Tier A query %s is still classified tier-a and stays executable', async (id) => {
    const def = byId(id)
    expect(def.status).toBe('tier-a')
    expect(def.candidatePlan.type).not.toBe('none')
    // Must not throw UNSUPPORTED_GROQ: a Tier A query downgraded to
    // 'unsupported' would otherwise just vanish from the parity sweep.
    await expect(evaluateRegistered(def, base, emptyOverlay())).resolves.toBeDefined()
  })

  it('the overlay fixture inventory is exactly the six §35.11 behaviors', () => {
    expect(Object.keys(OVERLAY_FIXTURES).sort()).toEqual([...EXPECTED_OVERLAY_FIXTURES].sort())
  })

  it('the parity sweep covers exactly 17 x 6 = 102 (query, overlay) pairs', () => {
    expect(supported).toHaveLength(17)
    expect(Object.keys(OVERLAY_FIXTURES)).toHaveLength(6)
    expect(supported.length * Object.keys(OVERLAY_FIXTURES).length).toBe(102)
  })
})

// ===========================================================================
// GAP 2 — TYPE-BOUNDARY guard (NOT the §22.6 boundedness proof).
//
// Mutations E2/E3/E4 made the ids, slug/types and top-k plans UNBOUNDED (each
// pulling the whole dataset into the candidate set) and all three went GREEN.
// Parity with the oracle is preserved by any SUPERSET of the correct candidate
// set, so the pre-existing suite proved completeness only.
//
// HONEST SCOPE (evidence review 2026-08-04, F6): the ceilings below are derived
// from the PLAN, so for type-scanning plans the ceiling IS the scan and the
// assertion cannot falsify over-fetching within a type. What this block proves
// is exactly one thing — a plan never crosses a type boundary, which is what
// kills E2/E3/E4. The §22.6 claim (candidate sets that do not grow with the
// dataset) is proven in `test/spike-c-boundedness.test.ts` against ceilings
// derived from query semantics plus a 10x scale sweep. Do not cite this block
// as boundedness evidence.
//
// planSelected = candidateCount - referenceExpansions is the portion the plan
// chose; reference expansion is a separate, legitimately unbounded mechanism.
// ===========================================================================

function planUpperBound(
  plan: CandidatePlan,
  dataset: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown>,
): number {
  switch (plan.type) {
    case 'ids':
      return plan.idsFromParams.map((p) => String(params[p])).length
    case 'ids-literal':
      return plan.ids.length
    // `aggregate` and `reverse-reference` both fetch a SUBSET of their candidate
    // types — the branch delta, and the referrers of the touched targets. This
    // block's stated scope is the type BOUNDARY only, so the ceiling here is the
    // type; the tight, semantics-derived ceilings for both live in
    // test/spike-c-boundedness.test.ts and test/spike-c-latency.test.ts.
    case 'aggregate':
    case 'reverse-reference':
    case 'base-filter':
    case 'slug':
    case 'types': {
      const types =
        plan.type === 'slug' ? [plan.docType] : (plan.types as string[])
      const inBase = dataset.filter((d) => types.includes(d._type)).length
      const inOverlay = [...overlay.documents.values()].filter(
        (d) => types.includes(d._type) && !dataset.some((b) => b._id === d._id),
      ).length
      return inBase + inOverlay
    }
    case 'top-k': {
      const byIdIndex = new Map(dataset.map((d) => [d._id, d]))
      const affected = new Set<string>()
      for (const [id, d] of overlay.documents) if (d._type === plan.docType) affected.add(id)
      for (const id of overlay.tombstones) {
        if (byIdIndex.get(id)?._type === plan.docType) affected.add(id)
      }
      // §22.6: fetch sliceEnd + affected from base, then union the affected docs.
      return plan.sliceEnd + 2 * affected.size
    }
  }
}

describe('GAP 2: candidate plans never cross a type boundary (E2, E3, E4)', () => {
  it.each(supported.map((d) => [d.id, d] as const))(
    '%s keeps planSelected within its plan ceiling under every overlay',
    async (_id, def) => {
      const params = PARAMS[def.id] ?? {}
      for (const [ovName, makeOverlay] of Object.entries(OVERLAY_FIXTURES)) {
        const overlay = makeOverlay(base)
        const {diagnostics} = await evaluateRegistered(def, base, overlay, params)
        const planSelected = diagnostics.candidateCount - diagnostics.referenceExpansions
        const ceiling = planUpperBound(def.candidatePlan as CandidatePlan, base, overlay, params)
        expect(
          planSelected,
          `${def.id} x ${ovName}: plan selected ${planSelected} docs, ceiling ${ceiling}`,
        ).toBeLessThanOrEqual(ceiling)
      }
    },
  )

  it('a single-id plan never grows with the dataset', async () => {
    const {diagnostics} = await evaluateRegistered(byId('article-by-id'), base, emptyOverlay(), {
      id: 'article-05',
    })
    // One requested id; everything else must arrive via reference expansion.
    expect(diagnostics.candidateCount - diagnostics.referenceExpansions).toBe(1)
    expect(diagnostics.candidateCount).toBeLessThan(diagnostics.fullDatasetCount)
  })

  it('a type plan never pulls in documents of unrelated types', async () => {
    // 30 articles exist; the plan may select those (plus reference expansion),
    // never the 3 pages / 5 authors / siteSettings as plan hits.
    const {diagnostics} = await evaluateRegistered(byId('article-type-list'), base, emptyOverlay())
    expect(diagnostics.candidateCount - diagnostics.referenceExpansions).toBe(
      base.filter((d) => d._type === 'article').length,
    )
  })

  it('a top-K plan fetches on the order of K, not the whole type', async () => {
    const {diagnostics} = await evaluateRegistered(
      byId('articles-ordered-sliced'),
      base,
      emptyOverlay(),
    )
    // sliceEnd is 20 and no overlay doc is affected, so exactly 20 plan hits.
    expect(diagnostics.candidateCount - diagnostics.referenceExpansions).toBe(20)
    expect(diagnostics.candidateCount - diagnostics.referenceExpansions).toBeLessThan(
      base.filter((d) => d._type === 'article').length,
    )
  })
})

// ===========================================================================
// GAP 3 — the tombstone fixture matrix only ever tombstones ONE article.
// Mutation E5 made tombstones effective for `_type === 'article'` ONLY and went
// GREEN: the sole tombstone fixture removes `article-03`, so tombstoning a
// page, an author (a reference target), or anything reached by the slug /
// ids-literal plans was never exercised, and neither perspective other than
// `published` was ever tombstoned.
// ===========================================================================

const TOMBSTONE_CASES: Array<[string, SpikeOverlay]> = [
  ['article (top of the publishedAt order)', tombstoneOverlay('article-01')],
  ['page (slug + ids-literal plan targets)', tombstoneOverlay('page-home', 'legacy.page.v2')],
  ['author (a pure reference target)', tombstoneOverlay('author-2')],
  ['mixed article + page + author', tombstoneOverlay('article-07', 'page-about', 'author-3')],
]

describe('GAP 3a: planner/oracle parity holds for tombstones of every type (E5)', () => {
  for (const [label, overlay] of TOMBSTONE_CASES) {
    describe(`tombstoned ${label}`, () => {
      it.each(supported.map((d) => [d.id, d] as const))('%s', async (_id, def) => {
        await expectParity(def, base, overlay)
      })
    })
  }
})

describe('GAP 3b: tombstones remove documents through every plan type (E5)', () => {
  it('ids plan: tombstoning the requested id yields null', async () => {
    const overlay = tombstoneOverlay('article-05')
    const result = await expectParity(byId('article-by-id'), base, overlay)
    expect(result).toBeNull()
  })

  it('ids-literal plan: tombstoning the literal id yields null', async () => {
    const overlay = tombstoneOverlay('page-home')
    const result = await expectParity(byId('page-featured-refs'), base, overlay)
    expect(result).toBeNull()
  })

  it('slug plan (page): tombstoning the matched page yields null', async () => {
    const overlay = tombstoneOverlay('legacy.page.v2')
    const result = await expectParity(byId('page-by-slug'), base, overlay)
    expect(result).toBeNull()
  })

  it('slug plan (article): tombstoning the matched article yields null', async () => {
    const overlay = tombstoneOverlay('article-07')
    const result = await expectParity(byId('article-by-slug'), base, overlay)
    expect(result).toBeNull()
  })

  it('types plan: a tombstoned page leaves a multi-type list', async () => {
    const overlay = tombstoneOverlay('page-about')
    const result = (await expectParity(byId('multi-type-list'), base, overlay)) as {_id: string}[]
    expect(result.some((r) => r._id === 'page-about')).toBe(false)
    expect(result.some((r) => r._id === 'page-home')).toBe(true)
  })

  it('top-k plan: tombstoning the newest article promotes the runner-up', async () => {
    const overlay = tombstoneOverlay('article-01')
    const result = (await expectParity(byId('articles-ordered-sliced'), base, overlay)) as {
      title: string
    }[]
    expect(result[0].title).toBe('Article 2')
    expect(result).toHaveLength(20)
  })

  it('reference target: tombstoning the referenced author nulls the dereference', async () => {
    const overlay = tombstoneOverlay('author-2')
    const result = (await expectParity(byId('article-with-author'), base, overlay)) as {
      author: unknown
    }
    // article-01 references author-2, which no longer resolves.
    expect(result.author).toBeNull()
  })

  it('reference target: tombstoning an author drops it from name-matched parents', async () => {
    const overlay = tombstoneOverlay('author-1')
    const result = (await expectParity(byId('articles-by-author-name'), base, overlay)) as unknown[]
    // No document is named 'Author 2 (branch rename)' here, so both sides agree
    // on the empty set; the point is that the planner agrees with the oracle.
    expect(result).toEqual([])
  })
})

describe('GAP 3c: tombstone parity also holds under the drafts perspective (E5)', () => {
  const draftsTombstones = tombstoneOverlay('article-02', 'page-about', 'author-3')

  it('the drafts perspective is a genuinely different dataset', () => {
    expect(draftsBase.length).not.toBe(base.length)
    expect(draftsBase.some((d) => d._id === 'article-99')).toBe(true)
  })

  it.each(supported.map((d) => [d.id, d] as const))(
    '%s under drafts perspective + mixed tombstones',
    async (_id, def) => {
      await expectParity(def, draftsBase, draftsTombstones)
    },
  )
})

// ===========================================================================
// GAP 4 — spike-d finding severity and the array-member code are unasserted.
// E7 (TYPE_MISMATCH hard -> soft), E9 (DISALLOWED_REFERENCE_TARGET hard ->
// soft) and E6 (never emit INVALID_ARRAY_MEMBER) all went GREEN. Severity is
// the blocking/advisory gate, so a silent downgrade turns a branch-blocking
// incompatibility into a warning; and no §36.4 variant ever exercised array
// member validation at all.
// ===========================================================================

const artifact = loadBaseArtifact()
const docs = publishedPerspective(loadFixtureDataset())

const EXPECTED_SEVERITY: Record<FindingCode, 'hard' | 'soft'> = {
  UNKNOWN_TYPE: 'hard',
  MISSING_REQUIRED_FIELD: 'hard',
  TYPE_MISMATCH: 'hard',
  INVALID_ARRAY_MEMBER: 'hard',
  DISALLOWED_REFERENCE_TARGET: 'hard',
  UNKNOWN_FIELD: 'soft',
}

/** Branch variant: article.tags becomes an array of numbers. */
function tagsBecomeNumbers(baseArtifact: SchemaArtifact): SchemaArtifact {
  const a = clone(baseArtifact)
  const article = a.find((t) => t.name === 'article')
  if (!article?.attributes) throw new Error('no article type')
  article.attributes.tags = {
    type: 'objectAttribute',
    value: {type: 'array', of: {type: 'number'}},
    optional: true,
  }
  return a
}

describe('GAP 4: finding severity + array-member validation (E6, E7, E9)', () => {
  it('TYPE_MISMATCH is a hard (branch-blocking) finding', () => {
    const f = scan(variants.changeScalarType(artifact), docs).filter(
      (x) => x.code === 'TYPE_MISMATCH',
    )
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity === 'hard')).toBe(true)
  })

  it('DISALLOWED_REFERENCE_TARGET is a hard (branch-blocking) finding', () => {
    const f = scan(variants.changeReferenceTargets(artifact), docs).filter(
      (x) => x.code === 'DISALLOWED_REFERENCE_TARGET',
    )
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.severity === 'hard')).toBe(true)
  })

  it('an array whose member type changed is reported as INVALID_ARRAY_MEMBER', () => {
    const f = scan(tagsBecomeNumbers(artifact), docs)
    const bad = f.filter((x) => x.code === 'INVALID_ARRAY_MEMBER')
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((x) => x.severity === 'hard')).toBe(true)
    expect(bad.every((x) => /^tags\[\d+\]$/.test(x.path))).toBe(true)
    expect(bad.every((x) => docs.some((d) => d._id === x.documentId))).toBe(true)
  })

  it('every finding any §36.4 variant emits carries its documented severity', () => {
    const all: Finding[] = [
      ...scan(artifact, docs),
      ...scan(variants.addOptionalField(artifact), docs),
      ...scan(variants.addRequiredField(artifact), docs),
      ...scan(variants.renameField(artifact), docs),
      ...scan(variants.changeScalarType(artifact), docs),
      ...scan(variants.changeNestedShape(artifact), docs),
      ...scan(variants.changeReferenceTargets(artifact), docs),
      ...scan(variants.addDocumentType(artifact), docs),
      ...scan(variants.removeDocumentType(artifact), docs),
      ...scan(tagsBecomeNumbers(artifact), docs),
    ]
    expect(all.length).toBeGreaterThan(0)
    for (const f of all) {
      expect(EXPECTED_SEVERITY[f.code], `unknown finding code ${f.code}`).toBeDefined()
      expect(f.severity, `${f.code} at ${f.documentId}/${f.path}`).toBe(EXPECTED_SEVERITY[f.code])
    }
    // All six documented codes must be reachable by the variant set, or the
    // scanner has dead branches nothing verifies.
    const seen = new Set(all.map((f) => f.code))
    for (const code of Object.keys(EXPECTED_SEVERITY) as FindingCode[]) {
      expect(seen.has(code), `finding code ${code} is never exercised`).toBe(true)
    }
  })
})
