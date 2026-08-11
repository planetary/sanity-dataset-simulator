/**
 * The evaluator — PRD §22.6 candidate planning end to end, §22.2 engine
 * decision, §22.8 diagnostics, §22.9 error policy.
 *
 * `groq-js` is pinned (PRD §5.5 pins `2.0.0`) and is invoked exactly once, on
 * the ORIGINAL query over the resolved candidate set (§22.6 step 14). Nothing
 * here post-processes a filtered or sliced result, which §22.2 forbids
 * outright: a local change can alter filter membership, dereferenced values,
 * ordering, slice membership and aggregates, so the query must see a dataset
 * that already contains the resolved overlay state.
 *
 * CANDIDATE ORDER, stated because GROQ can observe it. The candidate set is
 * presented as: plan-selected base documents in base order, then branch-created
 * documents in overlay order, then reference-expanded documents. An unordered
 * `*[...][0]` returns the first match in dataset order, so this ordering is
 * only immaterial while at most one candidate matches the filter — which for a
 * registered ID or slug lookup means IDs and slugs are unique. That assumption
 * is a property of the data, not of this code, and a query whose predicate can
 * match two documents should register an explicit `order()`.
 */
import {evaluate as evaluateGroq, parse as parseGroq} from 'groq-js'
import type {QueryBaseSource} from './baseSource'
import {analyzeDerefPaths, collectReferenceTargets, derefChainDepth} from './derefPaths'
import {OverlayQueryError} from './errors'
import type {OverlaySource} from './overlaySource'
import {resolveVirtualDocument} from './overlaySource'
import {planCandidateRequests} from './planner'
import type {OverlayQueryRegistry} from './registry'
import type {
  OverlayQueryResult,
  QueryCaller,
  QueryDocument,
  QueryPerspective,
} from './types'

export interface EvaluateOverlayQueryOptions {
  readonly registry: OverlayQueryRegistry
  /** Stable query ID (PRD §22.5). */
  readonly queryId: string
  /**
   * The caller's own copy of the query text. When supplied it is verified
   * against the registered checksum, so a frontend whose `defineQuery` constant
   * drifted from the registry fails with `QUERY_CHANGED` instead of silently
   * running the registered text.
   */
  readonly query?: string
  readonly params?: Record<string, unknown>
  readonly base: QueryBaseSource
  readonly overlay: OverlaySource
  readonly caller: QueryCaller
  readonly perspective: QueryPerspective
  /** Serialise the candidate set to report its size. Off by default. */
  readonly measureBytes?: boolean
}

/**
 * Recombine the two halves of an additive aggregate.
 *
 * `math::sum` is `null` over a sequence holding a non-numeric value, and that
 * is a property of the WHOLE sequence — so a null in either half makes the
 * whole null. Coercing it to a number here would invent a value GROQ itself
 * would not return, which is the silent approximation §5.5 forbids.
 */
function combineAdditive(baseHalf: unknown, branchHalf: unknown): number | null {
  if (typeof baseHalf !== 'number' || typeof branchHalf !== 'number') return null
  return baseHalf + branchHalf
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

export async function evaluateOverlayQuery<T = unknown>(
  options: EvaluateOverlayQueryOptions,
): Promise<OverlayQueryResult<T>> {
  const startedAt = now()
  const {registry, queryId, base, overlay, caller, perspective} = options
  const params = options.params ?? {}

  /* 2-3. Registry lookup and checksum verification. */
  const def = registry.resolve(queryId, options.query)
  registry.assertCallerAllowed(def, caller)
  registry.assertPerspectiveRegistered(def, perspective)

  /* PRD §22.2: an unsupported query fails structurally, never approximately. */
  if (def.status === 'unsupported') {
    throw new OverlayQueryError(
      'UNSUPPORTED_GROQ',
      `Query ${def.id} is registered as unsupported and cannot be evaluated exactly. ` +
        `Returning an approximate result is forbidden (PRD §22.2, §5.5).`,
      {queryId: def.id, status: def.status},
    )
  }

  /* 1. Parse. */
  let tree: ReturnType<typeof parseGroq>
  try {
    tree = parseGroq(def.query)
  } catch (cause) {
    throw new OverlayQueryError(
      'INVALID_GROQ',
      `Query ${def.id} failed to parse: ${(cause as Error).message}`,
      {queryId: def.id, cause: String(cause)},
    )
  }

  /* 4. Select the registered candidate strategy.
   *
   * The branch delta is handed to the planner, not the overlay itself: §22.6's
   * bounded top-K base fetch is defined in terms of the affected count, and a
   * plan that could read the overlay directly could also read a document out of
   * it and call that a candidate. */
  const affectedIds = [...overlay.documents.keys(), ...overlay.tombstones]
  const plan = planCandidateRequests(def, params, {affectedIds})
  const derefPaths = analyzeDerefPaths(tree)

  /* 4b. The exactness PRECONDITIONS of the two pushdown plans.
   *
   * Both are checked against the parsed query rather than the registration,
   * because the registration is a claim and the query text is the fact. Both
   * refuse structurally; neither degrades into a wider fetch. */
  if (plan.aggregateRequest && derefPaths.dereferences) {
    // The base half decides membership from the BASE state while the branch is
    // invisible to it. That is exact only while the filter reads LOCAL fields:
    // a filter that traverses a reference gains and loses members when a TARGET
    // is edited, so the two halves stop partitioning the virtual dataset and
    // the sum is no longer the answer.
    throw new OverlayQueryError(
      'UNSUPPORTED_GROQ',
      `Query ${def.id} is registered for aggregate pushdown but its filter dereferences. The ` +
        `base half of the partition decides membership from the base state, so editing a ` +
        `reference TARGET would move documents between the halves without the base knowing. ` +
        `Refused rather than returning a recombined number that is not the answer (PRD §5.5).`,
      {queryId: def.id, plan: 'aggregate', reason: 'filter-traverses-reference'},
    )
  }
  if (def.candidatePlan.type === 'reverse-reference') {
    const depth = derefChainDepth(tree)
    if (depth > 1) {
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} chains ${depth} dereference hops, but reverse-reference expansion ` +
          `(§22.6 step 10) bounds the candidate set by the referrers of the touched documents, ` +
          `which is complete for a SINGLE hop. A document whose ancestor at depth ${depth} was ` +
          `edited references nothing the base half can see and would be missed. Refused rather ` +
          `than returning an incomplete candidate set (PRD §5.5).`,
        {queryId: def.id, plan: 'reverse-reference', reason: 'multi-hop-deref', derefDepth: depth},
      )
    }
  }

  /* 5. Fetch base candidates.
   *
   * Core requests every adapter serves; extended requests only an adapter that
   * opted in does. When it has not, the query is REFUSED. The alternative — ask
   * for the candidate types and apply the predicate locally — returns the right
   * answer while transferring the whole type, so no parity test could ever see
   * it, and §22.2 forbids that class of silent degradation outright. */
  const baseById = new Map<string, QueryDocument>()
  let baseRequestCount = 0
  let baseFetchDocuments = 0
  const fetched: QueryDocument[] = []
  const absorb = (documents: readonly QueryDocument[]): void => {
    baseFetchDocuments += documents.length
    for (const doc of documents) {
      baseById.set(doc._id, doc)
      fetched.push(doc)
    }
  }
  for (const request of plan.baseRequests) {
    baseRequestCount++
    absorb(await base.fetchCandidates(request))
  }
  /* 5a. The base half of an aggregate pushdown: ONE scalar, no documents.
   *
   * Refused when the adapter cannot serve it. The tempting fallback — fetch the
   * type and aggregate locally — returns the RIGHT ANSWER while transferring
   * everything, so no parity test could ever detect it, and that is exactly the
   * silent degradation §22.2 forbids. */
  let baseAggregate: number | null = null
  if (plan.aggregateRequest) {
    if (typeof base.fetchAggregate !== 'function') {
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} plans an aggregate pushdown, which this base source does not implement ` +
          `(QueryBaseSource.fetchAggregate is absent). Fetching the aggregated type and summing ` +
          `it locally would return the right answer by transferring everything, which PRD §22.2 ` +
          `forbids.`,
        {queryId: def.id, aggregate: plan.aggregateRequest.aggregate},
      )
    }
    baseRequestCount++
    baseAggregate = await base.fetchAggregate(plan.aggregateRequest)
  }

  for (const request of plan.extendedRequests) {
    if (typeof base.fetchExtendedCandidates !== 'function') {
      throw new OverlayQueryError(
        'UNSUPPORTED_GROQ',
        `Query ${def.id} plans a ${JSON.stringify(request.kind)} base fetch, which this base ` +
          `source does not implement (QueryBaseSource.fetchExtendedCandidates is absent). ` +
          `Falling back to a broader fetch filtered locally would return the right answer by ` +
          `over-fetching, which PRD §22.2 forbids.`,
        {queryId: def.id, requestKind: request.kind},
      )
    }
    baseRequestCount++
    absorb(await base.fetchExtendedCandidates(request))
  }

  const candidates = new Map<string, QueryDocument>()
  const admit = (id: string): QueryDocument | undefined => {
    if (candidates.has(id)) return undefined
    /* §18.2/§18.8 address-space rule (2026-08-11): a DRAFT-addressed row the
     * overlay itself does not hold is admissible only while the overlay has no
     * opinion about its logical twin. A logical-keyed overlay (every
     * published/drafts reader) that holds a body or tombstone for `X` has
     * superseded the base's `drafts.X` — admitting it would resurface a stale
     * base draft alongside the branch answer. A versioned overlay view keys
     * its own draft addresses and is untouched by this check. */
    if (id.startsWith('drafts.') && !overlay.documents.has(id) && !overlay.tombstones.has(id)) {
      const logicalId = id.slice('drafts.'.length)
      if (overlay.documents.has(logicalId) || overlay.tombstones.has(logicalId)) return undefined
    }
    /* 7 + 13. Tombstones suppress; branch records win over base. */
    const doc = resolveVirtualDocument(id, baseById, overlay)
    if (!doc) return undefined
    candidates.set(doc._id, doc)
    return doc
  }

  for (const doc of fetched) admit(doc._id)
  /* 6a. A branch-created document at a requested ID has no base row to fetch. */
  for (const id of plan.explicitIds) admit(id)
  /* 6b. Any branch record of a candidate type can newly enter the answer. */
  if (plan.overlayTypes.length > 0) {
    const types = new Set(plan.overlayTypes)
    for (const [id, doc] of overlay.documents) {
      if (types.has(doc._type)) admit(id)
    }
  }

  const planSelectedCount = candidates.size

  /* 8-11. Dereference expansion, only along paths the query actually derefs. */
  let referenceDepth = 0
  let referenceExpansions = 0
  let frontier = [...candidates.values()]
  for (let depth = 1; ; depth++) {
    const targets = new Set<string>()
    for (const doc of frontier) collectReferenceTargets(doc, derefPaths, targets)
    const missing = [...targets].filter((id) => !candidates.has(id))
    if (missing.length === 0) break
    if (depth > def.maxReferenceDepth) {
      throw new OverlayQueryError(
        'REFERENCE_DEPTH_EXCEEDED',
        `Query ${def.id} still has unexpanded references after ${def.maxReferenceDepth} ` +
          `levels; the candidate set cannot be proven complete (PRD §22.6 step 11).`,
        {queryId: def.id, maxReferenceDepth: def.maxReferenceDepth, pending: missing},
      )
    }
    baseRequestCount++
    const documents = await base.fetchCandidates({kind: 'ids', ids: missing})
    baseFetchDocuments += documents.length
    for (const doc of documents) baseById.set(doc._id, doc)
    const added: QueryDocument[] = []
    for (const id of missing) {
      const doc = admit(id)
      if (doc) {
        added.push(doc)
        referenceExpansions++
      }
    }
    referenceDepth = depth
    if (added.length === 0) break
    frontier = added
  }

  /* 12. Capacity check (§22.9 `CANDIDATE_LIMIT_EXCEEDED`). */
  if (candidates.size > def.maxCandidates) {
    throw new OverlayQueryError(
      'CANDIDATE_LIMIT_EXCEEDED',
      `Query ${def.id} planned ${candidates.size} candidates, above its registered ` +
        `maxCandidates of ${def.maxCandidates}.`,
      {queryId: def.id, candidateCount: candidates.size, maxCandidates: def.maxCandidates},
    )
  }

  const dataset = [...candidates.values()]
  const candidateBytes = options.measureBytes
    ? dataset.reduce((total, doc) => total + JSON.stringify(doc).length, 0)
    : 0

  /* 14. Evaluate the ORIGINAL query over the resolved candidate set.
   *
   * Under an aggregate plan that candidate set is the BRANCH HALF of an exact
   * partition, so the answer is the two halves ADDED. That is not
   * post-processing a filtered result — which §22.2 forbids outright — because
   * every document is aggregated in exactly one half and neither half is an
   * approximation of the other. */
  let result: T
  try {
    const value = await evaluateGroq(tree, {dataset, params})
    const branchHalf = (await value.get()) as T
    result = plan.aggregateRequest
      ? (combineAdditive(baseAggregate, branchHalf) as T)
      : branchHalf
  } catch (cause) {
    throw new OverlayQueryError(
      'GROQ_EVALUATION_FAILED',
      `Query ${def.id} failed during local evaluation: ${(cause as Error).message}`,
      {queryId: def.id, cause: String(cause)},
    )
  }

  const conflicts = overlay.conflicts
  return {
    result,
    /* 15. Result plus overlay diagnostics. */
    diagnostics: {
      queryId: def.id,
      candidateCount: dataset.length,
      baseRequestCount,
      referenceDepth,
      durationMs: now() - startedAt,
      conflictsTouched: conflicts ? dataset.filter((d) => conflicts.has(d._id)).map((d) => d._id) : [],
      unsupportedFeatures: [],
      /* A registered Tier A/B query is exact by construction: the paths that
       * cannot be proven exact throw above rather than degrading this flag. */
      exact: true,
      planSelectedCount,
      baseFetchDocuments,
      referenceExpansions,
      evaluatorInvocations: 1,
      candidateBytes,
      candidateIds: dataset.map((d) => d._id),
    },
  }
}
