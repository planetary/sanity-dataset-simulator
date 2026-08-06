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

/** True when `value` contains a reference to `id` anywhere inside it. */
function referencesId(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesId(item, id))
  if (typeof value !== 'object' || value === null) return false
  const object = value as Record<string, unknown>
  if (object._ref === id) return true
  return Object.values(object).some((child) => referencesId(child, id))
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
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled extended request ${JSON.stringify(exhaustive)}`)
        }
      }
    },
  }
}
