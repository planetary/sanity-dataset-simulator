// SPIKE C candidate planner prototypes (PRD §36.3, §22.6).
// System under test for the §35.10 overlay-parity method: the planner sees a
// BOUNDED candidate set; the oracle sees the full virtual dataset. Equality
// proves candidate completeness.
import {parse} from 'groq-js'
import {
  analyzeDerefPaths,
  collectReferenceTargets,
} from '../../sanity-overlay-query/src/derefPaths'
import type {FixtureDocument} from '../src/fixtures'
import {runGroq} from '../src/groq'
import {applyOverlay, type SpikeOverlay} from './overlay'

/**
 * The parameter every pushdown plan uses to hand the base the set of ids the
 * branch has touched. Named with a reserved prefix so it cannot collide with a
 * caller's own parameter.
 */
export const TOUCHED_IDS_PARAM = '__touched'

export type CandidatePlan =
  | {type: 'ids'; idsFromParams: string[]}
  | {type: 'ids-literal'; ids: string[]}
  /**
   * PRD §22.7 "exact slug-filtered pages plus all overlaid page documents":
   * `filter` is the GROQ a real implementation issues to Sanity, so only the
   * documents it RETURNS enter the candidate set. Exact only when the filter
   * reads local fields of `types` — a predicate that traverses a reference can
   * gain matches when the TARGET is edited, and needs §22.6 step 10 instead.
   */
  | {type: 'base-filter'; types: string[]; filter: string}
  /**
   * §22.6 step 10 — REVERSE-REFERENCE EXPANSION, for a filter that traverses a
   * reference (`author->name == $name`). One base fetch, two disjuncts:
   *
   *   `author->name == $name`      every referrer that matches in the BASE state
   *   `references($__touched)`     every referrer of a document the branch touched
   *
   * Completeness argument, which is the whole reason this may replace the scan
   * §22.7 sanctions. Take any virtual article A in the answer:
   *   - A is touched          -> a branch record of `types`, admitted by step 6.
   *   - A untouched, target untouched -> A resolves to its base row and its
   *     target resolves to its base row, so the LEFT disjunct selects it.
   *   - A untouched, target touched   -> A references a touched id, so the
   *     RIGHT disjunct selects it.
   * No fourth case exists, so nothing in the answer is missed. What it costs is
   * the referrer count of the touched targets, which is data-dependent — bounded
   * by the branch's blast radius rather than by the type, and NOT constant.
   *
   * Exact only for a SINGLE dereference hop: with `a->b->name`, an untouched
   * referrer whose grandchild was edited references neither the edited document
   * nor anything the base filter can see. Deeper chains are REFUSED rather than
   * approximated (PRD §5.5) — see `assertSingleHopDeref`.
   */
  | {type: 'reverse-reference'; types: string[]; filter: string}
  /**
   * AGGREGATE PUSHDOWN. §22.6 step 14 hands the ORIGINAL query to `groq-js`
   * over the candidate set, so an aggregate registered under any other plan must
   * materialise every document it aggregates — 4.8 MiB to return one scalar
   * (`latency-2026-08-04.md` §4.1).
   *
   * The fix is a partition, not an estimate. The virtual dataset is exactly
   *
   *     {base documents the branch did not touch} ∪ {resolved touched documents}
   *
   * and `count()` / `math::sum()` are ADDITIVE over a partition. So the base
   * evaluates `baseAggregate` — the same aggregate with `!(_id in $__touched)`
   * added — and returns ONE NUMBER, the candidate set is the branch delta, and
   * the two halves are added. The answer is exact, not approximated: every
   * document is counted in exactly one half.
   *
   * Registering a non-additive aggregate here would be a silent approximation,
   * so it is REFUSED at evaluation time (`assertAdditiveAggregate`).
   */
  | {type: 'aggregate'; types: string[]; baseAggregate: string}
  | {type: 'slug'; docType: string}
  | {type: 'types'; types: string[]}
  | {type: 'top-k'; docType: string; orderField: string; sliceEnd: number}

export interface SpikeQueryDefinition {
  id: string
  query: string
  candidatePlan: CandidatePlan | {type: 'none'}
  status: 'tier-a' | 'tier-b' | 'unsupported'
  systemTimestampPolicy?: 'preserve-base' | 'preview-diverges' | 'unsupported'
  notes?: string
}

export interface SpikeDiagnostics {
  queryId: string
  candidateCount: number
  fullDatasetCount: number
  referenceExpansions: number
  durationMs: number
  // --- latency instrumentation (§36.3 pass criterion 5, §5.4) --------------
  // Additive only: nothing above changes, and nothing below is consulted by
  // the planning logic. These make the §22.6 pipeline measurable phase by
  // phase — plan (steps 1-13) -> base fetch shape (step 5) -> evaluate (14).
  /** groq-js evaluations performed. §22.6 permits step 5 and step 14 only. */
  evaluatorInvocations: number
  /** Documents the simulated server-side filtered base fetch returned (step 5). */
  baseFetchDocuments: number
  /** Wall clock inside that simulated base fetch — a network call in production. */
  baseFetchMs: number
  /** Candidate selection + reference expansion + ordering, excluding the base fetch. */
  planMs: number
  /** Step 14: the original query through groq-js over the candidate set. */
  evaluateMs: number
  /** Serialised size of the candidate set. 0 unless `options.measureBytes`. */
  candidateBytes: number
}

export interface EvaluateOptions {
  /**
   * Serialise the candidate set to measure its size. Off by default because it
   * costs a full JSON round trip; the latency harness turns it on.
   */
  measureBytes?: boolean
}

export class UnsupportedGroqError extends Error {
  code = 'UNSUPPORTED_GROQ' as const
  constructor(public queryId: string, reason: string) {
    super(`UNSUPPORTED_GROQ (${queryId}): ${reason}`)
  }
}

/**
 * The aggregates whose value over a partition is the sum of its values over the
 * parts. `count()` trivially; `math::sum()` because addition is associative and
 * `math::sum([])` is 0. Anything else — `math::avg`, `math::min`, `math::max`,
 * `array::unique` — either needs a second scalar to recombine or cannot be
 * recombined at all, and is REFUSED rather than approximated.
 */
const ADDITIVE_AGGREGATE = /^\s*(count|math::sum)\s*\(/

function assertAdditiveAggregate(def: SpikeQueryDefinition): void {
  if (!ADDITIVE_AGGREGATE.test(def.query)) {
    throw new UnsupportedGroqError(
      def.id,
      `aggregate pushdown recombines the base half and the branch half by ADDITION, which is ` +
        `exact only for count() and math::sum(). ${JSON.stringify(def.query)} is neither, and ` +
        `returning a recombined value anyway would be a silent approximation (PRD §5.5).`,
    )
  }
  if (def.query.includes('->')) {
    throw new UnsupportedGroqError(
      def.id,
      `aggregate pushdown asks the base which documents match while the base cannot see the ` +
        `branch. That is exact only while the aggregate's filter reads LOCAL fields: a filter ` +
        `that traverses a reference gains and loses members when a TARGET is edited, which the ` +
        `base-side half cannot know about. Refused rather than approximated (PRD §5.5).`,
    )
  }
}

/** Deepest chain of `->` applied to the result of another `->` (`a->b->c` = 2). */
function derefChainDepth(node: unknown, inside = 0): number {
  if (Array.isArray(node)) return Math.max(0, ...node.map((n) => derefChainDepth(n, inside)))
  if (!node || typeof node !== 'object') return 0
  const o = node as Record<string, unknown>
  const here = o.type === 'Deref' ? inside + 1 : inside
  const children = Object.entries(o)
    .filter(([k]) => k !== 'type' && k !== 'name')
    .map(([, v]) => derefChainDepth(v, here))
  return Math.max(here, 0, ...children)
}

/**
 * §22.6 step 10 bounds the candidate set by the referrers of the touched
 * targets, which is complete for ONE hop only. With `a->b->name`, editing the
 * grandchild changes membership of a referrer that references neither it nor
 * anything else the base filter selects, so `references($touched)` misses it.
 * Refuse instead of returning a plausible-looking subset.
 */
function assertSingleHopDeref(def: SpikeQueryDefinition): void {
  const depth = derefChainDepth(parse(def.query))
  if (depth > 1) {
    throw new UnsupportedGroqError(
      def.id,
      `reverse-reference expansion (§22.6 step 10) bounds the candidate set by the referrers of ` +
        `the touched targets, which is complete for a single dereference hop. This query chains ` +
        `${depth}, so a document whose ancestor at depth ${depth} was edited would be missed. ` +
        `Refused rather than returning an incomplete candidate set (PRD §5.5).`,
    )
  }
}

/**
 * Recombine the base-side and branch-side halves of an additive aggregate.
 *
 * `math::sum` returns `null` when the sequence holds a non-numeric value, and
 * that is a property of the WHOLE sequence — so if either half is null the
 * whole is null. Anything else here would invent a number GROQ would not.
 */
function combineAdditive(baseHalf: unknown, branchHalf: unknown): unknown {
  if (typeof baseHalf !== 'number' || typeof branchHalf !== 'number') return null
  return baseHalf + branchHalf
}

/** Virtual-resolve one logical id against base + overlay. */
function resolveVirtual(
  id: string,
  baseById: Map<string, FixtureDocument>,
  overlay: SpikeOverlay,
): FixtureDocument | undefined {
  if (overlay.tombstones.has(id)) return undefined
  return overlay.documents.get(id) ?? baseById.get(id)
}

export async function evaluateRegistered<T = unknown>(
  def: SpikeQueryDefinition,
  base: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown> = {},
  maxReferenceDepth = 3,
  options: EvaluateOptions = {},
): Promise<{result: T; diagnostics: SpikeDiagnostics}> {
  const started = performance.now()
  let evaluatorInvocations = 0
  let baseFetchDocuments = 0
  let baseFetchMs = 0
  if (def.status === 'unsupported' || def.candidatePlan.type === 'none') {
    throw new UnsupportedGroqError(def.id, 'no finite exact candidate plan is registered')
  }
  const plan = def.candidatePlan
  const baseById = new Map(base.map((d) => [d._id, d]))
  const candidates = new Map<string, FixtureDocument>()
  const add = (id: string) => {
    const d = resolveVirtual(id, baseById, overlay)
    if (d) candidates.set(d._id, d)
  }
  /** §22.6 step 6's input: every id whose resolved value can differ from base. */
  const touched = [...overlay.documents.keys(), ...overlay.tombstones]
  /** Branch records of `types`, in either their base or their branch `_type`. */
  const addBranchRecordsOfTypes = (types: string[]) => {
    for (const [id, d] of overlay.documents) {
      if (types.includes(d._type) || types.includes(baseById.get(id)?._type ?? '')) add(id)
    }
  }
  /** The base half of an aggregate pushdown: one scalar, never documents. */
  let baseAggregate: unknown

  if (plan.type === 'ids' || plan.type === 'ids-literal') {
    const ids = plan.type === 'ids' ? plan.idsFromParams.map((p) => String(params[p])) : plan.ids
    for (const id of ids) add(id)
    // an overlay doc may have been created at a requested id — covered by add()
  } else if (plan.type === 'base-filter') {
    // Server-side filtered fetch (§22.6 step 5). Only the returned documents
    // are candidates: this is what makes the plan bounded rather than a scan.
    const fetchStarted = performance.now()
    const matched = await runGroq<Array<{_id: string}>>(plan.filter, base, params)
    baseFetchMs = performance.now() - fetchStarted
    evaluatorInvocations++
    baseFetchDocuments = matched.length
    for (const d of matched) add(d._id)
    // Step 6: any branch record of the candidate types can newly match.
    addBranchRecordsOfTypes(plan.types)
  } else if (plan.type === 'reverse-reference') {
    // §22.6 step 10. ONE base fetch carrying both disjuncts, so the N+1 bound
    // (step 5 + step 14) still holds: asking the base for the matching TARGETS
    // and then for their referrers would be two round trips for the same set.
    assertSingleHopDeref(def)
    const fetchStarted = performance.now()
    const matched = await runGroq<Array<{_id: string}>>(plan.filter, base, {
      ...params,
      [TOUCHED_IDS_PARAM]: touched,
    })
    baseFetchMs = performance.now() - fetchStarted
    evaluatorInvocations++
    baseFetchDocuments = matched.length
    for (const d of matched) add(d._id)
    addBranchRecordsOfTypes(plan.types)
  } else if (plan.type === 'aggregate') {
    // The base aggregates every document the branch did not touch and returns a
    // NUMBER; the candidate set is the branch delta. `baseFetchDocuments` stays
    // 0 on purpose — that is the measurable difference between transferring
    // 4.8 MiB and transferring a scalar.
    assertAdditiveAggregate(def)
    const fetchStarted = performance.now()
    baseAggregate = await runGroq<unknown>(plan.baseAggregate, base, {
      ...params,
      [TOUCHED_IDS_PARAM]: touched,
    })
    baseFetchMs = performance.now() - fetchStarted
    evaluatorInvocations++
    // Only a touched document of the candidate types can contribute to the
    // branch half. Every OTHER touched id is excluded from the base half by
    // `!(_id in $__touched)` and contributes nothing here either, because the
    // aggregate's own `_type` predicate rejects it — so the partition is still
    // exhaustive without materialising it.
    for (const id of touched) {
      const resolved = resolveVirtual(id, baseById, overlay)
      const base_ = baseById.get(id)
      if (
        (resolved && plan.types.includes(resolved._type)) ||
        (base_ && plan.types.includes(base_._type))
      ) {
        add(id)
      }
    }
  } else if (plan.type === 'slug' || plan.type === 'types') {
    const types = plan.type === 'slug' ? [plan.docType] : plan.types
    for (const d of base) if (types.includes(d._type)) add(d._id)
    for (const [id, d] of overlay.documents) if (types.includes(d._type)) add(id)
  } else if (plan.type === 'top-k') {
    // §22.6 bounded top-K. `affected` is every id whose membership or order in
    // the candidate type can differ from base — including a branch record that
    // moves a document OUT of the type, which the base `_type` reveals and the
    // overlay `_type` hides.
    const affected = new Set<string>()
    for (const [id, d] of overlay.documents) {
      if (d._type === plan.docType || baseById.get(id)?._type === plan.docType) affected.add(id)
    }
    for (const id of overlay.tombstones) {
      if (baseById.get(id)?._type === plan.docType) affected.add(id)
    }
    // Fetch the top K of the UNTOUCHED base order, then union the affected
    // records: an untouched base document with K untouched documents ordered
    // above it keeps them all above it after resolution, so it cannot enter the
    // requested slice. That makes `sliceEnd + affected.size` exact — fetching
    // sliceEnd + affected and THEN adding affected on top over-fetches.
    const baseTop = base
      .filter((d) => d._type === plan.docType && !affected.has(d._id))
      .sort((a, b) => String(b[plan.orderField]).localeCompare(String(a[plan.orderField])))
      .slice(0, plan.sliceEnd)
    for (const d of baseTop) add(d._id)
    for (const id of affected) add(id)
  }

  // Reference expansion — §22.6 steps 8 to 11.
  //
  // Step 8 is "analyze dereference paths", and skipping it is what made
  // `article-type-list` materialise 833 author documents it never dereferences
  // (`latency-2026-08-04.md` §4.3). The analysis is the one already written and
  // tested in `sanity-overlay-query/src/derefPaths.ts`, reused here rather than
  // re-implemented so this evidence measures the shipping behaviour: it reads
  // the parsed query, reports the attributes a `->` is applied to, and reports
  // "follow everything" when it cannot resolve one. Over-approximating costs
  // candidates; under-approximating would lose documents the answer depends on.
  const derefPaths = analyzeDerefPaths(parse(def.query))
  let expansions = 0
  let frontier = [...candidates.values()]
  for (let depth = 0; depth < maxReferenceDepth && frontier.length > 0; depth++) {
    const refs = new Set<string>()
    for (const d of frontier) collectReferenceTargets(d, derefPaths, refs)
    const next: FixtureDocument[] = []
    for (const id of refs) {
      if (candidates.has(id)) continue
      const d = resolveVirtual(id, baseById, overlay)
      if (d) {
        candidates.set(d._id, d)
        next.push(d)
        expansions++
      }
    }
    frontier = next
  }

  // Candidate sets are unordered, but GROQ document order is NOT: an unordered
  // `*[...][0]` returns the first document in DATASET order. The candidate set
  // must therefore be presented in the same order `applyOverlay` produces —
  // base order first, then branch-created documents — or a plan that happens to
  // discover matches in a different order silently returns a different document.
  const baseIndex = new Map(base.map((d, i) => [d._id, i]))
  const overlayIndex = new Map([...overlay.documents.keys()].map((id, i) => [id, i]))
  const dataset = [...candidates.values()].sort((a, b) => {
    const ai = baseIndex.get(a._id)
    const bi = baseIndex.get(b._id)
    if (ai !== undefined && bi !== undefined) return ai - bi
    if (ai !== undefined) return -1
    if (bi !== undefined) return 1
    return (overlayIndex.get(a._id) ?? 0) - (overlayIndex.get(b._id) ?? 0)
  })
  const planMs = performance.now() - started - baseFetchMs
  const candidateBytes = options.measureBytes
    ? dataset.reduce((n, d) => n + JSON.stringify(d).length, 0)
    : 0
  const evaluateStarted = performance.now()
  const branchHalf = await runGroq<T>(def.query, dataset, params)
  // §22.6 step 14 evaluated the ORIGINAL query over the candidate set. Under an
  // aggregate plan that candidate set is the branch half of an exact partition,
  // so the answer is the two halves added — not a post-processed approximation
  // of a filtered result, which §22.2 forbids.
  const result =
    plan.type === 'aggregate' ? (combineAdditive(baseAggregate, branchHalf) as T) : branchHalf
  const evaluateMs = performance.now() - evaluateStarted
  evaluatorInvocations++
  return {
    result,
    diagnostics: {
      queryId: def.id,
      candidateCount: dataset.length,
      fullDatasetCount: applyOverlay(base, overlay).length,
      referenceExpansions: expansions,
      durationMs: performance.now() - started,
      evaluatorInvocations,
      baseFetchDocuments,
      baseFetchMs,
      planMs,
      evaluateMs,
      candidateBytes,
    },
  }
}

/** Oracle side: original query over the FULL resolved virtual dataset. */
export async function evaluateOracle<T = unknown>(
  def: SpikeQueryDefinition,
  base: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown> = {},
): Promise<T> {
  return runGroq<T>(def.query, applyOverlay(base, overlay), params)
}
