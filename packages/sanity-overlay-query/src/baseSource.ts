/**
 * The base side of candidate planning — PRD §22.2 `[MUST]` "Fetch live base
 * candidates from Sanity", §22.6 step 5.
 *
 * The port is deliberately a small, closed set of REQUEST SHAPES rather than a
 * GROQ string. Two reasons:
 *
 * 1. §22.5 forbids dynamic query construction without a custom planner. A
 *    structured request cannot be assembled from user input into something the
 *    registry never approved.
 * 2. The set of shapes is exactly what the `[M-LOCAL]` planners need, so the
 *    boundedness of a plan is legible from its request: `ids` transfers |ids|
 *    documents, `field-equality` transfers the matches, `types` transfers the
 *    type. A `filter: string` port would hide that behind an opaque string.
 *
 * A hosted adapter turns these into `*[_id in $ids]`, `*[_type in $types &&
 * <path> == $value]` and `*[_type in $types]`; the in-memory adapter below does
 * the same selection in plain JavaScript, which is why it needs no evaluator.
 */
import type {CandidateOrderTerm, QueryDocument} from './types'

/**
 * The CORE request shapes. Every base adapter must serve all three.
 *
 * CLOSED ON PURPOSE — do not add a member here. Adapters outside this package
 * switch over this union exhaustively and close with
 * `const exhaustive: never = request`, so a new member is a compile error in
 * files this package does not own (`sanity-overlay-client/src/base.ts` and
 * `examples/kitchen-sink/spikeA/readQueries.ts` both do exactly that today).
 * New shapes go in {@link ExtendedCandidateRequest} instead, which is an
 * OPTIONAL capability and therefore purely additive. See
 * `query-diagnostics.test.ts` §1b, which compiles a core-only adapter and fails
 * if this union grows.
 */
export type BaseCandidateRequest =
  /** Documents with these exact IDs. */
  | {readonly kind: 'ids'; readonly ids: readonly string[]}
  /** Documents of these types whose local field at `path` equals `value`. */
  | {
      readonly kind: 'field-equality'
      readonly types: readonly string[]
      readonly path: readonly string[]
      readonly value: unknown
    }
  /** Every document of these types. */
  | {readonly kind: 'types'; readonly types: readonly string[]}

/**
 * Request shapes an adapter MAY serve, added after the port had implementors.
 *
 * Each one exists because a §22.6 plan cannot be bounded without it: expressing
 * `articles-by-tag`, `references($id)` or a top-K slice through the core shapes
 * would mean fetching the whole type and filtering locally, which is precisely
 * the over-fetch §22.6 exists to prevent and which no parity test can see.
 * An adapter that does not implement {@link QueryBaseSource.fetchExtendedCandidates}
 * gets `UNSUPPORTED_GROQ`, never a silent scan.
 */
export type ExtendedCandidateRequest =
  /** Documents of these types whose local ARRAY at `path` contains `value`. */
  | {
      readonly kind: 'field-contains'
      readonly types: readonly string[]
      readonly path: readonly string[]
      readonly value: unknown
    }
  /** Documents of these types that reference `id` anywhere (GROQ `references()`). */
  | {
      readonly kind: 'references'
      readonly types: readonly string[]
      readonly id: string
    }
  /**
   * The top `limit` documents of these types in `order`, ignoring `excludeIds`
   * — §22.6's bounded top-K base fetch. A hosted adapter issues
   * `*[_type in $types && !(_id in $exclude)] | order(...)[0...$limit]`.
   *
   * The exclusion is what makes the bound `K` rather than `K + affectedCount`:
   * a base document the branch has already replaced or removed is fetched from
   * the overlay, never from the base, so it must not consume one of the K slots
   * that the completeness proof reserves for UNTOUCHED documents.
   */
  | {
      readonly kind: 'order-slice'
      readonly types: readonly string[]
      readonly order: readonly CandidateOrderTerm[]
      readonly limit: number
      readonly excludeIds: readonly string[]
    }
  /**
   * §22.6 step 10's base half, in ONE request: documents of `types` whose
   * reference at `referencePath` resolves to a document whose `targetPath`
   * equals `value`, UNION documents of `types` that reference any of
   * `touchedIds`. A hosted adapter issues
   * `*[_type in $types && (<referencePath>-><targetPath> == $value ||
   *   references($touched))]`.
   *
   * The two disjuncts travel together on purpose. Asking for the matching
   * TARGETS and then for their referrers is two round trips for one candidate
   * set, and would take the query past §22.6's step 5 + step 14 evaluation
   * budget.
   */
  | {
      readonly kind: 'reverse-reference'
      readonly types: readonly string[]
      readonly referencePath: readonly string[]
      readonly targetPath: readonly string[]
      readonly value: unknown
      readonly touchedIds: readonly string[]
    }

/**
 * The base half of an aggregate pushdown. Answered with ONE NUMBER, which is
 * why it is not a {@link ExtendedCandidateRequest}: the entire point is that no
 * document crosses the wire.
 *
 * `excludeIds` is every ID the branch touched. Excluding them is what makes the
 * base half and the branch half a PARTITION of the virtual dataset rather than
 * two overlapping views of it, so that adding the two results is exact.
 */
export interface AggregateRequest {
  readonly aggregate: 'count' | 'sum'
  readonly types: readonly string[]
  /** Path to the summed value; numeric segments index arrays. Unused by `count`. */
  readonly path?: readonly string[]
  readonly excludeIds: readonly string[]
}

/** Anything a planner can ask for: core plus extended. */
export type PlannedCandidateRequest = BaseCandidateRequest | ExtendedCandidateRequest

export interface QueryBaseSource {
  /**
   * Resolve one core base request. Implementations MUST return documents in
   * stable base order and MUST NOT return documents the request did not select
   * — over-returning silently defeats §22.6.
   */
  fetchCandidates(request: BaseCandidateRequest): Promise<readonly QueryDocument[]>
  /**
   * Resolve one extended base request, under the same contract.
   *
   * OPTIONAL. Absent means "this adapter cannot serve these shapes", and the
   * evaluator refuses the query rather than widening the fetch.
   */
  fetchExtendedCandidates?(request: ExtendedCandidateRequest): Promise<readonly QueryDocument[]>
  /**
   * Aggregate over the base, returning a scalar.
   *
   * OPTIONAL, and the evaluator refuses an aggregate query when it is absent
   * rather than fetching the type and aggregating locally — that returns the
   * right answer by transferring everything, which is exactly the degradation
   * §22.2 forbids and which no parity test can see.
   *
   * `null` is a legitimate answer: GROQ's `math::sum` is null over a sequence
   * holding a non-numeric value, and an adapter must reproduce that rather than
   * substituting 0.
   */
  fetchAggregate?(request: AggregateRequest): Promise<number | null>
}

/** Read `path` out of a document, following plain objects only. */
function readPath(doc: QueryDocument, path: readonly string[]): unknown {
  let cursor: unknown = doc
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Read `path` allowing NUMERIC segments to index arrays (`sections.1.count`).
 *
 * Separate from {@link readPath} rather than folded into it: `field-equality`
 * and `field-contains` register object paths only, and widening their reader
 * would change which documents those plans select.
 */
function readIndexedPath(doc: QueryDocument, path: readonly string[]): unknown {
  let cursor: unknown = doc
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      cursor = cursor[index]
    } else {
      cursor = (cursor as Record<string, unknown>)[segment]
    }
  }
  return cursor
}

/** True when `value` contains a reference to `id` anywhere inside it. */
function referencesId(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesId(item, id))
  if (typeof value !== 'object' || value === null) return false
  const object = value as Record<string, unknown>
  if (object._ref === id) return true
  return Object.values(object).some((child) => referencesId(child, id))
}

/**
 * GROQ's `math::sum`, as pinned `groq-js` implements it and as this adapter must
 * reproduce for the pushdown to be exact: `null` and absent members are SKIPPED,
 * an empty sequence sums to 0, and any non-numeric member makes the whole sum
 * `null`. Measured against `groq-js` 2.0.0, not assumed.
 */
function groqSum(values: readonly unknown[]): number | null {
  let total = 0
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value !== 'number') return null
    total += value
  }
  return total
}

/**
 * GROQ's value ordering, as pinned `groq-js` implements it, measured rather
 * than assumed: `order(v desc)` over one document per type returns
 * `[missing, boolean, string, number]`, so ascending order is
 * numbers < strings < booleans < null/absent. Values of other kinds (objects,
 * arrays) are not orderable and tie.
 */
const orderRank = (value: unknown): number => {
  if (typeof value === 'number') return 0
  if (typeof value === 'string') return 1
  if (typeof value === 'boolean') return 2
  return 3
}

function compareOrdered(a: unknown, b: unknown): number {
  const rankA = orderRank(a)
  const rankB = orderRank(b)
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 3) return 0
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (a === b) return 0
  return (a as number | string) < (b as number | string) ? -1 : 1
}

/**
 * Sort a candidate pool by the registered order. `Array.prototype.sort` is
 * stable in every engine this runs on, so documents that tie keep their DATASET
 * order — which is what `groq-js` does too, and what makes the top-K selection
 * agree with the whole-dataset oracle when the ordering field is not unique.
 */
function sortByOrder(
  documents: readonly QueryDocument[],
  order: readonly CandidateOrderTerm[],
): QueryDocument[] {
  return [...documents].sort((left, right) => {
    for (const term of order) {
      const comparison = compareOrdered(left[term.field], right[term.field])
      if (comparison !== 0) return term.direction === 'desc' ? -comparison : comparison
    }
    return 0
  })
}

/**
 * In-memory base source over an already perspective-resolved dataset — the
 * `memory` mode of PRD §9.2 and the substrate for fixture parity tests.
 */
export function createMemoryBaseSource(documents: readonly QueryDocument[]): QueryBaseSource {
  return {
    async fetchCandidates(request) {
      switch (request.kind) {
        case 'ids': {
          const wanted = new Set(request.ids)
          // Base order, not request order: §22.6 step 13 resolves into a dataset
          // whose order GROQ can observe through an unordered `[0]`.
          return documents.filter((d) => wanted.has(d._id))
        }
        case 'field-equality': {
          const types = new Set(request.types)
          return documents.filter(
            (d) => types.has(d._type) && readPath(d, request.path) === request.value,
          )
        }
        case 'types': {
          const types = new Set(request.types)
          return documents.filter((d) => types.has(d._type))
        }
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled base request ${JSON.stringify(exhaustive)}`)
        }
      }
    },

    async fetchExtendedCandidates(request) {
      switch (request.kind) {
        case 'field-contains': {
          const types = new Set(request.types)
          return documents.filter((d) => {
            if (!types.has(d._type)) return false
            const value = readPath(d, request.path)
            return Array.isArray(value) && value.includes(request.value)
          })
        }
        case 'references': {
          const types = new Set(request.types)
          return documents.filter((d) => types.has(d._type) && referencesId(d, request.id))
        }
        case 'order-slice': {
          const types = new Set(request.types)
          const excluded = new Set(request.excludeIds)
          const pool = documents.filter((d) => types.has(d._type) && !excluded.has(d._id))
          const top = new Set(
            sortByOrder(pool, request.order)
              .slice(0, request.limit)
              .map((d) => d._id),
          )
          // Base order, not sorted order: the port contract is "stable base
          // order" for every request kind, and §22.6 step 13 resolves into a
          // dataset whose order GROQ can observe through a tie.
          return pool.filter((d) => top.has(d._id))
        }
        case 'reverse-reference': {
          const types = new Set(request.types)
          const byId = new Map(documents.map((d) => [d._id, d]))
          const touched = request.touchedIds
          return documents.filter((doc) => {
            if (!types.has(doc._type)) return false
            // Disjunct 1: matches in the BASE state.
            const reference = readPath(doc, request.referencePath) as
              | {_ref?: unknown}
              | undefined
            const ref = reference && typeof reference._ref === 'string' ? reference._ref : undefined
            const target = ref === undefined ? undefined : byId.get(ref)
            if (target && readPath(target, request.targetPath) === request.value) return true
            // Disjunct 2: could BECOME a match because a target was touched.
            return touched.some((id) => referencesId(doc, id))
          })
        }
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled extended request ${JSON.stringify(exhaustive)}`)
        }
      }
    },

    async fetchAggregate(request) {
      const types = new Set(request.types)
      const excluded = new Set(request.excludeIds)
      const pool = documents.filter((d) => types.has(d._type) && !excluded.has(d._id))
      if (request.aggregate === 'count') return pool.length
      const path = request.path
      if (!path) throw new Error('a sum aggregate request must carry a path')
      return groqSum(pool.map((d) => readIndexedPath(d, path)))
    },
  }
}
