// SPIKE C — representative-scale corpus + work/latency profiling
// (PRD §36.3 pass criterion 5 "Preview latency stays within budget on
// representative data", §5.4 performance targets, §35.16 performance scales).
//
// Deterministic by construction, in the style of `fixtures/generate.mjs`:
// no Date.now(), no Math.random(), no new dependencies. Every document this
// module produces is a pure function of the committed fixture dataset and the
// requested article count, so the measured numbers reproduce byte for byte.
import type {FixtureDocument} from '../src/fixtures'
import type {SpikeOverlay} from './overlay'
import {type SpikeQueryDefinition, evaluateRegistered} from './planner'

/**
 * Representative scale for Gate D.
 *
 * PRD §35.16 enumerates the scales this project must measure at: "Type
 * candidate sets of 100, 1,000, 5,000, and configured maximum documents."
 * 5,000 is the top of the enumerated range. `configured maximum` is §11.1's
 * `query.maxCandidateDocuments`, for which the PRD gives no value, so it
 * cannot be measured against.
 *
 * The Phase 0 audit (evidence/phase-1/audit/repository-audit.md) supplies the
 * document SHAPE rather than the count — it measured the base dataset at 41
 * documents, article avg 915 B / max 952 B — because the audited repository is
 * greenfield. So: audit-measured document size, §35.16 document count.
 */
export const REPRESENTATIVE_ARTICLE_COUNT = 5000

/** Fields any registered query orders by. Generated docs must sort below all originals. */
const ORDER_FIELDS = ['publishedAt', '_createdAt'] as const

/**
 * Every generated article carries a timestamp in this window, which is
 * strictly below every fixture timestamp (the generator emits 2026-01-01
 * onward). Keeping the added documents at the BOTTOM of every ordered field is
 * what makes a top-K answer byte-identical at 30 and at 5,000 articles: the
 * scale-up then changes the dataset without changing the answer, so a change in
 * candidate count can only come from the plan.
 */
const GENERATED_EPOCH_MS = Date.parse('2020-01-01T00:00:00Z')

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

const stampFor = (n: number): string =>
  new Date(GENERATED_EPOCH_MS + n * 1000).toISOString().replace('.000Z', 'Z')

/** Rewrite every `_ref` in a value through `remap`, in place. */
function repointRefs(value: unknown, remap: (id: string) => string | undefined): void {
  if (Array.isArray(value)) {
    for (const v of value) repointRefs(v, remap)
    return
  }
  if (!value || typeof value !== 'object') return
  const o = value as Record<string, unknown>
  if (typeof o._ref === 'string') {
    const to = remap(o._ref)
    if (to !== undefined) o._ref = to
  }
  for (const v of Object.values(o)) repointRefs(v, remap)
}

/**
 * Grow the committed fixture dataset to `articles` article documents, keeping
 * the Phase 0 audit's measured TYPE COMPOSITION (article 32 : author 5 :
 * page 3 : siteSettings 1) rather than inflating one type in isolation.
 *
 * Scaling articles alone would leave a 3-document `page` type, and a work
 * budget that a 3-page type scan cannot breach is not falsifiable for the page
 * queries — the same vacuity trap `boundedness-2026-08-04.md` §1 describes.
 *
 * Every hand-written fixture document survives untouched (the overlay fixtures
 * and the query params address `article-01`, `article-05`, `article-25`,
 * `author-2`, `page-home`, `legacy.page.v2` and `siteSettings` by id or slug),
 * and generated documents reference only generated documents. That separation
 * is deliberate: reference expansion from an ORIGINAL document then resolves
 * exactly the same targets at 30 articles and at 5,000, so a change in
 * materialized count can only come from the plan.
 */
export function scaleToRepresentative(
  base: FixtureDocument[],
  articles: number = REPRESENTATIVE_ARTICLE_COUNT,
): FixtureDocument[] {
  const origArticles = base.filter((d) => d._type === 'article')
  const origAuthors = base.filter((d) => d._type === 'author')
  const origPages = base.filter((d) => d._type === 'page')
  if (articles < origArticles.length) {
    throw new Error(`cannot scale down: fixture already has ${origArticles.length} articles`)
  }
  const ratio = articles / origArticles.length
  const authors = Math.round(origAuthors.length * ratio)
  const pages = Math.round(origPages.length * ratio)
  const addedArticles = articles - origArticles.length

  const out = [...base]

  // --- authors -------------------------------------------------------------
  for (let n = 1; n <= authors - origAuthors.length; n++) {
    const d = clone(origAuthors[(n - 1) % origAuthors.length])
    d._id = `author-r${n}`
    d._rev = `fixture-rev-author-r${n}`
    d.name = `Author r${n}`
    d.slug = {_type: 'slug', current: `author-r${n}`}
    const stamp = stampFor(n)
    for (const f of ORDER_FIELDS) d[f] = stamp
    d._updatedAt = stamp
    // author-1's weak `favoriteArticle` cycle is preserved in generated form.
    repointRefs(d, () => (addedArticles > 0 ? 'article-r1' : undefined))
    out.push(d)
  }
  const generatedAuthors = Math.max(1, authors - origAuthors.length)

  // --- articles ------------------------------------------------------------
  for (let n = 1; n <= addedArticles; n++) {
    const d = clone(origArticles[(n - 1) % origArticles.length])
    // The `r` prefix keeps generated ids outside the `article-NN` namespace
    // the fixtures and the 10x boundedness harness both use.
    d._id = `article-r${n}`
    d._rev = `fixture-rev-article-r${n}`
    d.title = `Article r${n}`
    d.slug = {_type: 'slug', current: `article-r${n}`}
    const stamp = stampFor(n)
    for (const f of ORDER_FIELDS) d[f] = stamp
    d._updatedAt = stamp
    d.author = {_type: 'reference', _ref: `author-r${((n - 1) % generatedAuthors) + 1}`}
    d.related =
      n > 1 ? [{_type: 'reference', _ref: `article-r${n - 1}`, _weak: true, _key: `rel-r${n}`}] : []
    out.push(d)
  }

  // --- pages ---------------------------------------------------------------
  for (let n = 1; n <= pages - origPages.length; n++) {
    const d = clone(origPages[(n - 1) % origPages.length])
    d._id = `page-r${n}`
    d._rev = `fixture-rev-page-r${n}`
    d.title = `Page r${n}`
    d.slug = {_type: 'slug', current: `page-r${n}`}
    const stamp = stampFor(n)
    for (const f of ORDER_FIELDS) d[f] = stamp
    d._updatedAt = stamp
    let seen = 0
    repointRefs(d, () => {
      seen++
      return addedArticles > 0 ? `article-r${((n + seen) % addedArticles) + 1}` : undefined
    })
    out.push(d)
  }

  return out
}

/** Serialised size of a document set, in bytes. */
export function datasetBytes(docs: FixtureDocument[]): number {
  return docs.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d), 'utf8'), 0)
}

/**
 * One measured run of the whole §22.6 pipeline: plan -> base fetch shape ->
 * evaluate. The four count fields are deterministic (identical on every run,
 * on every machine); the three time fields are not, and are evidence only.
 */
export interface WorkProfile {
  queryId: string
  /** Documents handed to groq-js in §22.6 step 14, reference expansion included. */
  documentsMaterialized: number
  /** The plan's own choice: materialized minus dereferenced. */
  planSelected: number
  referenceExpansions: number
  /** Documents returned by the simulated server-side filtered base fetch (step 5). */
  baseFetchDocuments: number
  /** groq-js evaluations. §22.6 permits step 5 and step 14 — no more. */
  evaluatorInvocations: number
  /** Serialised size of the candidate set. */
  candidateBytes: number
  /** In production this is a network round trip, not local CPU. */
  baseFetchMs: number
  planMs: number
  evaluateMs: number
  /** baseFetchMs + planMs + evaluateMs; excludes byte-measurement overhead. */
  totalMs: number
}

export async function profileQuery(
  def: SpikeQueryDefinition,
  dataset: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown> = {},
): Promise<WorkProfile> {
  const {diagnostics: d} = await evaluateRegistered(def, dataset, overlay, params, 3, {
    measureBytes: true,
  })
  return {
    queryId: d.queryId,
    documentsMaterialized: d.candidateCount,
    planSelected: d.candidateCount - d.referenceExpansions,
    referenceExpansions: d.referenceExpansions,
    baseFetchDocuments: d.baseFetchDocuments,
    evaluatorInvocations: d.evaluatorInvocations,
    candidateBytes: d.candidateBytes,
    baseFetchMs: d.baseFetchMs,
    planMs: d.planMs,
    evaluateMs: d.evaluateMs,
    totalMs: d.baseFetchMs + d.planMs + d.evaluateMs,
  }
}

/**
 * Nearest-rank percentile: the smallest sample at or above the requested rank.
 * No interpolation, so `percentile(xs, 0.95)` is always an observed value.
 * With few samples this is conservative — at 5 samples p95 IS the maximum.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error('percentile of an empty sample')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}
