/**
 * The GROQ read endpoints (PRD §22).
 *
 * `/query/plan` answers "what must be fetched from base to answer this query
 * exactly, if it can be answered exactly at all?".
 * `/query` answers the query itself, given those documents.
 *
 * WHY THE WORK IS SPLIT ACROSS TWO PARTIES
 * Only the caller holds a Sanity credential, so only the caller can fetch base
 * candidates. Only this process holds the overlay and — decisively — only this
 * process should decide HOW MANY candidates a query may materialise:
 * `sanity-overlay-query` enforces §22.9 `CANDIDATE_LIMIT_EXCEEDED` inside
 * `evaluateOverlayQuery`, and a limit enforced in a browser tab is a limit a
 * reload can lose. So the plan is derived here, the fetch happens there, and the
 * evaluation happens back here.
 *
 * THE REGISTRY IS THE AUTHORITY, NOT A LEXICAL RECOGNISER.
 * `examples/kitchen-sink/spikeA/readQueries.ts` derives a candidate plan from an
 * arbitrary parse tree and registers it ephemerally, because Studio composes its
 * queries at runtime and has no stable ID. That was the right move for a spike
 * and is the wrong contract to ship: PRD §22.5 requires a static,
 * pre-registered, checksummed table, and §22.9 gives `QUERY_NOT_REGISTERED` a
 * meaning. So this module looks a query up — by ID, or by the SHA-256 of its
 * text — and refuses anything absent, WITH A REASON A HUMAN CAN READ.
 *
 * A refusal is DATA on `/query/plan` and a 4xx on `/query`. That asymmetry is
 * deliberate. §22.5 lets the caller pass an unsupported query through to staging
 * and record it; that licence belongs to the party holding the credential, and
 * it is only exercisable when "the overlay refused this" is distinguishable from
 * "the overlay is down". A 4xx on the plan endpoint would erase the distinction
 * the whole read policy rests on.
 */
import {
  createMemoryBaseSource,
  evaluateOverlayQuery,
  planCandidateRequests,
  queryTextChecksum,
} from '../../sanity-overlay-query/src/index'
import type {
  OverlayQueryDefinition,
  OverlayQueryRegistry,
  OverlaySource,
  QueryCaller,
  QueryDocument,
  QueryPerspective,
} from '../../sanity-overlay-query/src/index'
import {OverlayApiError} from './errors'

type Rec = Record<string, unknown>

const CALLERS: readonly QueryCaller[] = ['frontend', 'studio', 'agent', 'test']
const PERSPECTIVES: readonly QueryPerspective[] = ['published', 'drafts', 'raw']

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ReadRequest {
  queryId?: string
  query?: string
  params: Rec
  caller: QueryCaller
  perspective: QueryPerspective
}

function parseRequest(body: unknown, label: string): ReadRequest {
  if (!isRec(body)) {
    throw new OverlayApiError(400, 'INVALID_REQUEST', `${label} body must be a JSON object`)
  }
  const queryId = typeof body.queryId === 'string' && body.queryId.length > 0 ? body.queryId : undefined
  const query = typeof body.query === 'string' && body.query.trim().length > 0 ? body.query : undefined
  if (queryId === undefined && query === undefined) {
    throw new OverlayApiError(
      400,
      'INVALID_REQUEST',
      `${label} requires a \`queryId\` or a non-empty \`query\` string`,
    )
  }
  const caller = CALLERS.includes(body.caller as QueryCaller)
    ? (body.caller as QueryCaller)
    : 'studio'
  const perspective = PERSPECTIVES.includes(body.perspective as QueryPerspective)
    ? (body.perspective as QueryPerspective)
    : 'drafts'
  return {queryId, query, params: isRec(body.params) ? body.params : {}, caller, perspective}
}

/**
 * Resolve a request to a registered definition.
 *
 * By ID when one is supplied — that path also verifies the caller's own copy of
 * the text against the pinned checksum, so a frontend whose `defineQuery`
 * constant drifted fails loudly instead of silently running the registered text.
 * By checksum otherwise, which is how a Studio-composed query with no ID of its
 * own can still be recognised as one of the registered entries.
 *
 * Returns `null` rather than throwing: an unregistered query is a §22.5 outcome
 * each endpoint reports in its own vocabulary.
 */
function lookup(registry: OverlayQueryRegistry, request: ReadRequest): OverlayQueryDefinition | null {
  if (request.queryId !== undefined) {
    if (!registry.has(request.queryId)) return null
    return registry.resolve(request.queryId, request.query)
  }
  const checksum = queryTextChecksum(request.query!)
  return registry.definitions.find((def) => def.queryChecksum === checksum) ?? null
}

function unregisteredReason(request: ReadRequest): string {
  const what =
    request.queryId !== undefined
      ? `Query ${JSON.stringify(request.queryId)}`
      : 'This query text'
  return (
    `${what} is not in the overlay query registry. Unregistered queries are refused, ` +
    `never approximated (PRD §22.5, §5.5) — register it, or pass it through to the ` +
    `base dataset and record that you did.`
  )
}

/** `POST /query/plan` — §22.6 steps 4-5, reported rather than executed. */
export function planRegisteredQuery(registry: OverlayQueryRegistry, body: unknown): Rec {
  const request = parseRequest(body, 'query/plan')
  const def = lookup(registry, request)

  if (def === null || def.status === 'unsupported') {
    return {
      ok: true,
      supported: false,
      reason: def === null ? unregisteredReason(request) : `Query ${def.id} is registered as unsupported.`,
      ...(def === null ? {} : {queryId: def.id}),
    }
  }

  const {baseRequests, extendedRequests} = planCandidateRequests(def, request.params)
  return {
    ok: true,
    supported: true,
    queryId: def.id,
    queryChecksum: def.queryChecksum,
    candidatePlan: def.candidatePlan,
    maxCandidates: def.maxCandidates,
    maxReferenceDepth: def.maxReferenceDepth,
    /* §22.5 wants the caller able to record what it is trusting. A plan can
     * carry a boundary that is exact-by-product-decision rather than
     * exact-by-proof, and the caller is the party about to believe the answer. */
    ...(def.notes === undefined ? {} : {notes: def.notes}),
    baseRequests,
    extendedRequests,
  }
}

export interface EvaluateInput {
  /** Base candidates the caller fetched, having executed the plan. */
  baseDocuments: readonly QueryDocument[]
  /**
   * The branch, as §22.6 steps 6, 7 and 13 consume it.
   *
   * A FACTORY of the perspective, not a value, because an `OverlaySource` is a
   * perspective-applied view: `published` and `drafts` are keyed by the logical
   * ID while `raw` is keyed by the addressed one, and a source built for the
   * wrong one silently fails to overlay anything.
   */
  overlayFor: (perspective: QueryPerspective) => OverlaySource
}

/** `POST /query` — §22.6 step 14, through pinned `groq-js`. */
export async function evaluateRegisteredQuery(
  registry: OverlayQueryRegistry,
  body: unknown,
  input: EvaluateInput,
): Promise<Rec> {
  const request = parseRequest(body, 'query')
  const def = lookup(registry, request)

  /* §22.2: what cannot be evaluated exactly fails STRUCTURALLY. The §22.5
   * passthrough licence belongs to the caller — it holds the credential and can
   * ask the base dataset itself — and is not this endpoint's to grant. */
  if (def === null) {
    throw new OverlayApiError(400, 'UNSUPPORTED_QUERY', unregisteredReason(request))
  }

  const evaluated = await evaluateOverlayQuery({
    registry,
    queryId: def.id,
    ...(request.query === undefined ? {} : {query: request.query}),
    params: request.params,
    base: createMemoryBaseSource(input.baseDocuments),
    overlay: input.overlayFor(request.perspective),
    caller: request.caller,
    perspective: request.perspective,
  })

  return {
    ok: true,
    queryId: def.id,
    result: evaluated.result,
    diagnostics: evaluated.diagnostics,
  }
}
