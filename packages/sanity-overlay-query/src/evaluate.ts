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
import {analyzeDerefPaths, collectReferenceTargets} from './derefPaths'
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

  /* 5. Fetch base candidates. */
  const baseById = new Map<string, QueryDocument>()
  let baseRequestCount = 0
  let baseFetchDocuments = 0
  const fetched: QueryDocument[] = []
  for (const request of plan.baseRequests) {
    baseRequestCount++
    const documents = await base.fetchCandidates(request)
    baseFetchDocuments += documents.length
    for (const doc of documents) {
      baseById.set(doc._id, doc)
      fetched.push(doc)
    }
  }

  const candidates = new Map<string, QueryDocument>()
  const admit = (id: string): QueryDocument | undefined => {
    if (candidates.has(id)) return undefined
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

  /* 14. Evaluate the ORIGINAL query over the resolved candidate set. */
  let result: T
  try {
    const value = await evaluateGroq(tree, {dataset, params})
    result = (await value.get()) as T
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
