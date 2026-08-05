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
import type {QueryDocument} from './types'

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

export interface QueryBaseSource {
  /**
   * Resolve one base request. Implementations MUST return documents in stable
   * base order and MUST NOT return documents the request did not select —
   * over-returning silently defeats §22.6.
   */
  fetchCandidates(request: BaseCandidateRequest): Promise<readonly QueryDocument[]>
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
  }
}
