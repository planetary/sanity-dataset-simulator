/**
 * The READ POLICY — what happens to a `client.fetch` the moment a branch exists
 * (PRD §22.5 registration, §22.6 candidate planning, §22.9 boundedness, §5.5 no
 * silent approximation).
 *
 * THREE OUTCOMES, NO FOURTH.
 *
 *   `overlay`     the candidate set is provably complete, so the query is
 *                 answered over resolved branch state and the answer is EXACT.
 *   `passthrough` no bounded candidate plan could be derived, so the caller's
 *                 own GROQ goes to staging — and the fact is RECORDED and
 *                 logged. §5.5 forbids *silent* approximation; §22.5 requires
 *                 logging an unregistered query. A recorded passthrough is
 *                 neither silent nor forbidden.
 *   `refused`     strict mode. §22.5 "[MUST] reject unregistered queries in
 *                 strict preview mode".
 *
 * WHY THE DEFAULT IS PASSTHROUGH AND NOT REFUSAL. Studio composes GROQ at
 * runtime, everywhere, for its own plumbing: search, the structure tool, asset
 * pickers, reference inputs, schema probes. Refusing every query the planner
 * cannot prove complete does not make the Studio safer — it makes it not boot.
 * That is a different failure, not a smaller one. So the honest default is to
 * delegate and say so, loudly, in a surface a human reads.
 *
 * WHAT STRICT MODE REFUSES, AND WHAT IT DELIBERATELY DOES NOT. An empty branch
 * cannot have changed any answer: with no branch document and no tombstone,
 * staging's result IS the hosted result, and delegating to it is correct rather
 * than approximate. So strict refuses only once the branch actually holds state
 * that a passthrough could be wrong about. This is not a softening of §22.5 —
 * it is the difference between "unregistered" and "unregistered AND capable of
 * being wrong".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EVALUATION RUNS: IN THE STUDIO, IN THE BROWSER.
 *
 * The alternative was `POST /query` on the overlay API, which the transport
 * already declares. It was not taken, for one reason that decides it: the
 * overlay server has no Sanity credential. Candidate documents must come from
 * the Content Lake, and in this architecture the ONLY holder of a working
 * credential is the Studio session itself — every request it makes is already
 * authenticated as the logged-in editor. Sending the query to a server that
 * would then have to be given a dataset token to answer it re-introduces the
 * exact credential the plugin exists to keep out of the deployment (§11.3).
 *
 * So the Studio fetches its own candidates through the client it already holds,
 * and `sanity-overlay-query` evaluates over them locally. `maxCandidates` stays
 * meaningful because the base fetch is bounded BEFORE it is issued — see
 * {@link baseCandidateQuery}, which carries the plan's ceiling into the GROQ as
 * a literal slice, so an over-budget query costs one bounded round trip and
 * raises `CANDIDATE_LIMIT_EXCEEDED` rather than pulling a dataset into a tab.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  BaseCandidateRequest,
  QueryBaseSource,
} from '../../../sanity-overlay-query/src/baseSource'
import type {OverlaySource} from '../../../sanity-overlay-query/src/overlaySource'
import type {QueryDocument} from '../../../sanity-overlay-query/src/types'
import {markOverlayRefusal} from './echo'
import type {OverlayApproximation} from './findability'
import {
  deriveIncomingReferenceTargets,
  incomingReferenceReadPlan,
} from './incomingReferences'
import {
  perspectiveBaseSource,
  perspectiveOverlaySource,
  perspectivePlanRefusal,
  readPerspective,
} from './perspective'
import {deriveStudioReadPlan, evaluateStudioRead, type StudioReadPlan} from './readPlan'
import {createBranchCandidateSource} from './readSource'

type Rec = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

export type StudioReadOutcome = 'overlay' | 'passthrough' | 'refused'

/** One read, as the diagnostic surface sees it (PRD §22.8). */
export interface StudioReadRecord {
  /** The caller's GROQ, verbatim. */
  readonly query: string
  readonly outcome: StudioReadOutcome
  /** Why the overlay did not answer exactly. Absent on `overlay`. */
  readonly reason?: string
  /** Candidates the answer was evaluated over. Absent unless `overlay`. */
  readonly candidateCount?: number
  /**
   * The GROQ that was actually EVALUATED, when it is not {@link query}.
   *
   * A list pane's own query is rewritten before it can be planned at all — see
   * `findability.ts`. §5.5 forbids silent approximation, and evaluating a
   * different string from the one the caller wrote is exactly the kind of thing
   * an operator must be able to see rather than deduce.
   */
  readonly rewrittenQuery?: string
  /** Declared departures from the hosted answer. Absent when the answer is exact. */
  readonly approximations?: readonly OverlayApproximation[]
  readonly at: number
}

/**
 * Refusal in strict mode. Carries the planner's own reason, because a refusal
 * whose message is "unsupported" tells the person hitting it nothing about
 * which query to change or how.
 */
export class OverlayReadRefusedError extends Error {
  readonly code = 'UNSUPPORTED_GROQ'
  readonly query: string

  constructor(query: string, reason: string) {
    super(
      `[sanity-overlay-studio] refusing to answer a GROQ read in strict mode: ${reason}. ` +
        `Query: ${query}`,
    )
    this.name = 'OverlayReadRefusedError'
    this.query = query
    /* This refusal travels back through `client.fetch`, and the facade observes
     * every read error for a 401/403. It is OUR "no", not Sanity's — see
     * `echo.ts` {@link isOverlayRefusal}. */
    markOverlayRefusal(this)
  }
}

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

export interface StudioReadRequest {
  readonly query: unknown
  readonly params: unknown
  /** The third argument of `client.fetch`, if the caller passed one. */
  readonly options?: unknown
  /**
   * Run GROQ against STAGING, through the unwrapped client this read arrived
   * on. The reader never constructs a client and never holds a credential; it
   * borrows the session's.
   */
  baseFetch(query: string, params: Rec): Promise<unknown>
}

export type StudioReadAnswer =
  | {readonly answered: true; readonly result: unknown}
  /** Delegate: the caller re-issues its own query through the real client. */
  | {readonly answered: false; readonly reason: string}

export type StudioReadRouter = (request: StudioReadRequest) => Promise<StudioReadAnswer>

export interface StudioReaderOptions {
  /** The branch as a query source, read fresh on every call. */
  overlay(): OverlaySource
  /** PRD §22.5 strict preview mode. Defaults to off. */
  strict?(): boolean
  onRecord?(record: StudioReadRecord): void
  /** Where §22.5's "[MUST] log unregistered queries" goes. */
  onLog?(message: string): void
  now?(): number
}

/* ------------------------------------------------------------------ *
 * Base candidate fetching
 * ------------------------------------------------------------------ */

/** The reserved parameter names a candidate fetch binds. Namespaced, so a
 * caller's own parameters cannot collide with them. */
export const OVERLAY_IDS_PARAM = '__overlayIds'
export const OVERLAY_TYPES_PARAM = '__overlayTypes'
export const OVERLAY_VALUE_PARAM = '__overlayValue'

/** A GROQ attribute name that needs no quoting and cannot inject syntax. */
const SAFE_ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * One {@link BaseCandidateRequest} as GROQ, or `null` when it cannot be
 * expressed safely.
 *
 * NEVER STRING-INTERPOLATED FROM CALLER DATA. Every value travels as a bound
 * parameter; only attribute NAMES are interpolated, and only after
 * {@link SAFE_ATTRIBUTE} has proved they are bare identifiers. §22.5 forbids
 * dynamic query construction without a planner — this is the planner's output
 * rendered, not a query assembled from input.
 *
 * `limit` is the plan's registered ceiling. The slice is one document ABOVE it
 * so an over-budget result is detectable: the evaluator sees `ceiling + 1`
 * candidates and raises `CANDIDATE_LIMIT_EXCEEDED` (§22.9) instead of the
 * Studio silently answering over a truncated dataset.
 */
export function baseCandidateQuery(
  request: BaseCandidateRequest,
  limit: number,
): {query: string; params: Rec} | null {
  switch (request.kind) {
    case 'ids':
      /* Bounded by construction: the request names the ids. */
      return {
        query: `*[_id in $${OVERLAY_IDS_PARAM}]`,
        params: {[OVERLAY_IDS_PARAM]: [...request.ids]},
      }
    case 'types':
      return {
        query: `*[_type in $${OVERLAY_TYPES_PARAM}][0...${limit + 1}]`,
        params: {[OVERLAY_TYPES_PARAM]: [...request.types]},
      }
    case 'field-equality': {
      if (request.path.length === 0) return null
      if (!request.path.every((segment) => SAFE_ATTRIBUTE.test(segment))) return null
      const path = request.path.join('.')
      return {
        query:
          `*[_type in $${OVERLAY_TYPES_PARAM} && ${path} == $${OVERLAY_VALUE_PARAM}]` +
          `[0...${limit + 1}]`,
        params: {
          [OVERLAY_TYPES_PARAM]: [...request.types],
          [OVERLAY_VALUE_PARAM]: request.value,
        },
      }
    }
    default: {
      const exhaustive: never = request
      throw new Error(`unhandled base request ${JSON.stringify(exhaustive)}`)
    }
  }
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whatever staging answered, read as documents. Anything else is dropped. */
function documentsOf(value: unknown): QueryDocument[] {
  if (!Array.isArray(value)) return []
  const out: QueryDocument[] = []
  for (const entry of value) {
    if (!isRec(entry)) continue
    if (typeof entry._id !== 'string' || typeof entry._type !== 'string') continue
    out.push(entry as QueryDocument)
  }
  return out
}

/**
 * The candidate pool, fetched per request from staging and unioned with the
 * branch by {@link createBranchCandidateSource}.
 *
 * PER REQUEST, not once up front, because the evaluator issues more than the
 * plan's opening fetch: §22.6 steps 8-11 walk dereferences by asking for ids
 * that no plan could have named. A source built from a fixed array would answer
 * those with nothing, and a dereferenced title would come back `null` — which
 * looks like data rather than like a bug.
 */
function stagingBackedSource(
  overlay: OverlaySource,
  limit: number,
  baseFetch: (query: string, params: Rec) => Promise<unknown>,
): QueryBaseSource {
  return {
    async fetchCandidates(request) {
      const built = baseCandidateQuery(request, limit)
      /* Unrenderable request shape: refuse rather than widen the fetch. The
       * caller turns this into a recorded passthrough. */
      if (built === null) {
        throw new Error(
          `the candidate request ${JSON.stringify(request.kind)} names a field path GROQ ` +
            `cannot address as a bare attribute chain, so it cannot be fetched exactly`,
        )
      }
      const answered = await baseFetch(built.query, built.params)
      return await createBranchCandidateSource({
        baseDocuments: documentsOf(answered),
        overlay,
      }).fetchCandidates(request)
    },
  }
}

/* ------------------------------------------------------------------ *
 * Fetch options
 * ------------------------------------------------------------------ */

/**
 * Why this `client.fetch(…, …, options)` cannot be answered locally, or `null`.
 *
 * Each of these is a capability the hosted API has and the overlay does not, so
 * answering anyway would hand back a result of the wrong SHAPE or from the
 * wrong perspective. Both are worse than a recorded passthrough.
 */
function optionsRefusal(options: unknown): string | null {
  if (options === undefined || options === null) return null
  if (!isRec(options)) return null

  /* `perspective` is NOT here any more. It used to refuse outright, and because
   * sanity 6.8.0 attaches one to every content read the structure tool makes
   * (`PaneContainer-Bp8RN3ON.js:883`, `datastores-DqFH7RLd.js:910-913`) that
   * refusal made the whole Studio branch-blind. `perspective.ts` answers the
   * two collapsible perspectives exactly and refuses the rest. */
  if (options.resultSourceMap !== undefined && options.resultSourceMap !== false) {
    return (
      'the read asks for a Content Source Map, which the hosted API derives while it evaluates ' +
      'and which a local evaluation cannot produce'
    )
  }
  if (options.stega !== undefined && options.stega !== false) {
    return 'the read asks for stega-encoded output, which is derived from a Content Source Map'
  }
  return null
}

/** `{query, ms, result}` — the envelope `filterResponse: false` asks for. */
function envelopeFor(options: unknown, query: string, ms: number, result: unknown): unknown {
  if (!isRec(options) || options.filterResponse !== false) return result
  return options.returnQuery === false ? {ms, result} : {query, ms, result}
}

/* ------------------------------------------------------------------ *
 * The reader
 * ------------------------------------------------------------------ */

/** Does the branch hold anything a passthrough could be wrong about? */
function branchHasState(overlay: OverlaySource): boolean {
  return overlay.documents.size > 0 || overlay.tombstones.size > 0
}

export function createStudioReader(options: StudioReaderOptions): StudioReadRouter {
  const clock = options.now ?? ((): number => Date.now())
  const isStrict = options.strict ?? ((): boolean => false)
  /* Logged once per distinct query text. The ledger counts every occurrence;
   * the log is for a human, and a list pane re-running its query on every
   * keystroke would otherwise bury everything else in it. */
  const logged = new Set<string>()

  function record(entry: StudioReadRecord): void {
    options.onRecord?.(entry)
  }

  function log(query: string, reason: string): void {
    if (logged.has(query)) return
    logged.add(query)
    options.onLog?.(
      `[sanity-overlay-studio] this GROQ read could not be answered from the branch, so it was ` +
        `sent to the base dataset and may not reflect overlay edits: ${reason}. Query: ${query}`,
    )
  }

  /**
   * The one place a non-exact read is decided, so there is exactly one thing to
   * delete in order to make the diagnostic disappear.
   */
  function degrade(query: string, reason: string, overlay: OverlaySource): StudioReadAnswer {
    log(query, reason)
    if (isStrict() && branchHasState(overlay)) {
      record({query, outcome: 'refused', reason, at: clock()})
      throw new OverlayReadRefusedError(query, reason)
    }
    record({query, outcome: 'passthrough', reason, at: clock()})
    return {answered: false, reason}
  }

  return async function answer(request: StudioReadRequest): Promise<StudioReadAnswer> {
    const query = typeof request.query === 'string' ? request.query : String(request.query)
    const overlay = options.overlay()
    const params: Rec = isRec(request.params) ? request.params : {}

    const optionsReason = optionsRefusal(request.options)
    if (optionsReason !== null) return degrade(query, optionsReason, overlay)

    const reading = readPerspective(isRec(request.options) ? request.options.perspective : undefined)
    if ('refusal' in reading) return degrade(query, reading.refusal, overlay)
    const {perspective} = reading

    /* PRD §21.6 "Incoming references: Custom combined base plus overlay query".
     * Tried FIRST, because the generic planner refuses this shape by design and
     * would send it to staging — where a branch-created referring document does
     * not exist. `incomingReferences.ts` states the boundary: it claims a query
     * only when every `*[…]` in it is reference-filtered and nothing else in it
     * is locally unanswerable, so nothing the generic planner handles better is
     * taken away from it. */
    const startedAt = clock()
    const incoming = deriveIncomingReferenceTargets(request.query, params)
    let plan: StudioReadPlan
    if (incoming.supported) {
      try {
        plan = await incomingReferenceReadPlan({
          query,
          targetIds: incoming.targetIds,
          overlay,
          baseFetch: request.baseFetch,
        })
      } catch (error) {
        return degrade(query, (error as Error).message, overlay)
      }
    } else {
      const derivation = deriveStudioReadPlan(request.query, params)
      if (!derivation.supported) return degrade(query, derivation.reason, overlay)
      plan = derivation.plan
    }

    const planReason = perspectivePlanRefusal(plan.definition.candidatePlan.type, perspective)
    if (planReason !== null) return degrade(query, planReason, overlay)

    /* Both halves collapse, or neither does. `resolveVirtualDocument` (§22.6
     * steps 7, 13) reads the branch view and the candidate pool in the SAME
     * address space, so a perspective applied to one and not the other would
     * make a tombstone stop matching the row it suppresses. */
    const readOverlay = perspectiveOverlaySource(overlay, perspective)

    try {
      const {result, diagnostics} = await evaluateStudioRead({
        plan,
        params,
        overlay: readOverlay,
        perspective,
        base: perspectiveBaseSource(
          stagingBackedSource(overlay, plan.definition.maxCandidates, request.baseFetch),
          overlay,
          perspective,
        ),
      })
      record({
        query,
        outcome: 'overlay',
        candidateCount: diagnostics.candidateCount,
        ...(plan.sourceQuery === undefined ? {} : {rewrittenQuery: plan.definition.query}),
        ...(plan.approximations === undefined ? {} : {approximations: plan.approximations}),
        at: clock(),
      })
      return {
        answered: true,
        result: envelopeFor(request.options, query, clock() - startedAt, result),
      }
    } catch (error) {
      if (error instanceof OverlayReadRefusedError) throw error
      /* §22.9's own errors land here — `CANDIDATE_LIMIT_EXCEEDED`,
       * `REFERENCE_DEPTH_EXCEEDED` — as does a base fetch that failed. Each is
       * a read the overlay could not answer exactly, which is the one category
       * this function has. */
      return degrade(query, (error as Error).message, overlay)
    }
  }
}
