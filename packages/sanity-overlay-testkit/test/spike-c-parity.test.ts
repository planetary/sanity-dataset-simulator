import {describe, expect, it} from 'vitest'
import {loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {OVERLAY_FIXTURES} from '../spike-c/overlay'
import {UnsupportedGroqError, evaluateOracle, evaluateRegistered} from '../spike-c/planner'
import {REGISTRY, byId} from '../spike-c/registry'

// SPIKE C (PRD §36.3): bounded planner (system under test) vs full-dataset
// oracle (§35.10 steps 6-9), for every registered query under every overlay
// fixture. Equality proves candidate completeness — the load-bearing claim.

const base = publishedPerspective(loadFixtureDataset())

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
const diagnostics: Array<{queryId: string; overlay: string; candidates: number; full: number}> = []

describe('Spike C: planner vs oracle across overlay fixtures', () => {
  for (const def of supported) {
    for (const [ovName, makeOverlay] of Object.entries(OVERLAY_FIXTURES)) {
      it(`${def.id} × ${ovName}`, async () => {
        const overlay = makeOverlay(base)
        const params = PARAMS[def.id] ?? {}
        const oracle = await evaluateOracle(def, base, overlay, params)
        const {result, diagnostics: d} = await evaluateRegistered(def, base, overlay, params)
        expect(result).toEqual(oracle)
        diagnostics.push({queryId: def.id, overlay: ovName, candidates: d.candidateCount, full: d.fullDatasetCount})
      })
    }
  }
})

describe('Spike C: §35.11 behavioral assertions', () => {
  it('filter changed by local scalar: article-05 enters the featured filter', async () => {
    const overlay = OVERLAY_FIXTURES['filter-change'](base)
    const {result} = await evaluateRegistered<{_id: string}[]>(byId('filter-by-tag'), base, overlay)
    expect(result.map((r) => r._id)).toEqual(['article-05'])
  })

  it('sort changed by local scalar: article-25 enters the top of the slice', async () => {
    const overlay = OVERLAY_FIXTURES['sort-change'](base)
    const {result} = await evaluateRegistered<{title: string}[]>(byId('articles-ordered-sliced'), base, overlay)
    expect(result[0].title).toBe('Article 25')
    expect(result).toHaveLength(20)
  })

  it('branch-created document enters result and tops the order', async () => {
    const overlay = OVERLAY_FIXTURES['branch-create'](base)
    const list = await evaluateRegistered<{_id: string}[]>(byId('article-type-list'), base, overlay)
    expect(list.result.some((r) => r._id === 'article-branch-1')).toBe(true)
    const sliced = await evaluateRegistered<{title: string}[]>(byId('articles-ordered-sliced'), base, overlay)
    expect(sliced.result[0].title).toBe('Branch article')
  })

  it('tombstoned document leaves results and count drops', async () => {
    const overlay = OVERLAY_FIXTURES['tombstone'](base)
    const count = await evaluateRegistered<number>(byId('article-count'), base, overlay)
    expect(count.result).toBe(29)
    const list = await evaluateRegistered<{_id: string}[]>(byId('article-type-list'), base, overlay)
    expect(list.result.some((r) => r._id === 'article-03')).toBe(false)
  })

  it('dereference changed by target overlay without touching the parent', async () => {
    const overlay = OVERLAY_FIXTURES['ref-target-change'](base)
    const {result} = await evaluateRegistered<{author: {name: string}}>(
      byId('article-with-author'), base, overlay, {id: 'article-01'},
    )
    expect(result.author.name).toBe('Author 2 (branch rename)')
    expect(overlay.documents.has('article-01')).toBe(false) // parent unrewritten
  })

  it('parent query membership changed by target overlay', async () => {
    const overlay = OVERLAY_FIXTURES['ref-target-change'](base)
    const {result} = await evaluateRegistered<{_id: string}[]>(
      byId('articles-by-author-name'), base, overlay, {name: 'Author 2 (branch rename)'},
    )
    // author-2 is referenced by articles where (i % 5) + 1 === 2
    expect(result.length).toBeGreaterThan(0)
  })

  it('timestamp-ordered query is registered tier-b with an explicit policy (§13.9)', () => {
    const def = byId('recent-by-created-at')
    expect(def.status).toBe('tier-b')
    expect(def.systemTimestampPolicy).toBe('preview-diverges')
  })

  it('unsupported unconstrained query returns a structured error, never an approximation', async () => {
    const def = byId('unconstrained-star')
    await expect(evaluateRegistered(def, base, OVERLAY_FIXTURES['empty'](base))).rejects.toSatisfy(
      (e: unknown) => e instanceof UnsupportedGroqError && e.code === 'UNSUPPORTED_GROQ',
    )
  })

  it('top-K plan is genuinely bounded (candidates < full dataset)', async () => {
    const overlay = OVERLAY_FIXTURES['sort-change'](base)
    const {diagnostics: d} = await evaluateRegistered(byId('articles-ordered-sliced'), base, overlay)
    expect(d.candidateCount).toBeLessThan(d.fullDatasetCount)
  })
})
