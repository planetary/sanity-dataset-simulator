/**
 * Query-layer data model — PRD §22.4 (query registry), §22.8 (diagnostics).
 *
 * Node-safe and browser-safe (PRD §10.1 `[MUST]` "Query package can run in
 * Node.js without browser globals"): this module declares types only.
 */

/**
 * A dataset document as the query layer sees it. Deliberately structural rather
 * than a Sanity import — PRD §10.1 keeps hosted client types out of the
 * evaluable core.
 */
export interface QueryDocument {
  _id: string
  _type: string
  [field: string]: unknown
}

/** PRD §22.3 tiers. `unsupported` is Tier C: registered so it fails loudly. */
export type QueryTier = 'tier-a' | 'tier-b' | 'unsupported'

/** PRD §22.4 `allowedCallers`. */
export type QueryCaller = 'frontend' | 'studio' | 'agent' | 'test'

/** PRD §22.4 `perspectives`. */
export type QueryPerspective = 'published' | 'drafts' | 'raw'

/** PRD §22.4 / §13.9. */
export type SystemTimestampPolicy = 'preserve-base' | 'preview-diverges' | 'unsupported'

/**
 * Candidate plans implemented by the `[M-LOCAL]` slice (PRD §37 Phase 2:
 * "ID and slug candidate planners evaluated through pinned `groq-js`").
 *
 * `top-k` and `custom` from PRD §22.4 are deliberately absent: an ordered slice
 * needs the §22.6 bounded top-K proof, which is Phase 5 work, and registering
 * the shape without the planner would let a query claim support it does not have.
 */
export type CandidatePlan =
  /** Document lookup by ID, IDs taken from named query parameters. */
  | {type: 'ids'; idsFromParams: readonly string[]}
  /** Document lookup by ID, IDs fixed at registration (singleton documents). */
  | {type: 'ids-literal'; ids: readonly string[]}
  /**
   * PRD §22.7 "exact slug-filtered pages plus all overlaid page documents": a
   * field-equality predicate over LOCAL fields of `types` is pushed down to the
   * base fetch, then every branch record of those types is unioned in (§22.6
   * step 6) because a branch edit can make a document newly match.
   *
   * Exact only while the predicate reads local fields. A predicate that
   * traverses a reference can gain matches when the TARGET is edited and needs
   * §22.6 step 10 instead — which is why no such query is registered here.
   */
  | {type: 'slug'; types: readonly string[]; path: readonly string[]; valueFromParam: string}
  /** Whole type(s). Exact, and answer-proportional only when the answer IS the type. */
  | {type: 'types'; types: readonly string[]}
  /** No finite exact plan exists. Evaluating it MUST raise `UNSUPPORTED_GROQ`. */
  | {type: 'none'; reason: string}

/** PRD §22.4 `OverlayQueryDefinition`, plus the registered checksum of §22.5. */
export interface OverlayQueryDefinition {
  readonly id: string
  readonly description: string
  readonly query: string
  /**
   * SHA-256 of {@link OverlayQueryDefinition.query}, pinned at registration.
   * PRD §22.5 requires query text to be version controlled and CI to fail when
   * a query changes without refreshed parity tests; a pinned literal makes an
   * unreviewed edit a build failure rather than a silent behavioural change.
   */
  readonly queryChecksum: string
  readonly allowedCallers: readonly QueryCaller[]
  readonly perspectives: readonly QueryPerspective[]
  readonly candidatePlan: CandidatePlan
  readonly systemTimestampPolicy: SystemTimestampPolicy
  /** PRD §11.1 `query.maxCandidateDocuments`; §22.9 `CANDIDATE_LIMIT_EXCEEDED`. */
  readonly maxCandidates: number
  /** §22.6 step 11; §22.9 `REFERENCE_DEPTH_EXCEEDED`. */
  readonly maxReferenceDepth: number
  readonly status: QueryTier
  /** Name of the overlay parity fixture this entry is proven against (§35.10). */
  readonly parityFixture?: string
  readonly notes?: string
}

/**
 * PRD §22.8 diagnostics, plus the deterministic work counts the Spike C
 * latency evidence (`latency-2026-08-04.md` §5.2) put in place of wall-clock
 * gates: work is causally upstream of time and has zero spread across runs,
 * so it is what the suite may assert on. `durationMs` is emitted as evidence
 * and is deliberately never a pass/fail gate.
 */
export interface OverlayQueryDiagnostics {
  readonly queryId: string
  readonly candidateCount: number
  readonly baseRequestCount: number
  readonly referenceDepth: number
  readonly durationMs: number
  readonly conflictsTouched: readonly string[]
  readonly unsupportedFeatures: readonly string[]
  readonly exact: boolean
  /* --- deterministic work counts ------------------------------------- */
  /** Candidates the plan itself chose, before reference expansion. */
  readonly planSelectedCount: number
  /** Documents the base fetch returned (§22.6 step 5). */
  readonly baseFetchDocuments: number
  /** Documents added by dereference expansion (§22.6 steps 8-11). */
  readonly referenceExpansions: number
  /** `groq-js` evaluations. §22.6 permits step 5 and step 14 only. */
  readonly evaluatorInvocations: number
  /** Serialised size of the candidate set; 0 unless `measureBytes`. */
  readonly candidateBytes: number
  /**
   * Every candidate document ID, in evaluation order. Emitted so a caller can
   * check the candidate set structurally instead of trusting the counts above.
   */
  readonly candidateIds: readonly string[]
}

export interface OverlayQueryResult<T> {
  readonly result: T
  readonly diagnostics: OverlayQueryDiagnostics
}
