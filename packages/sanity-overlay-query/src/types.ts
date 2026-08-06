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

/** One term of a registered ordering (PRD §22.4 `orderFields`, plus direction). */
export interface CandidateOrderTerm {
  readonly field: string
  /**
   * PRD §22.4 writes `orderFields: string[]` with no direction. Exactness needs
   * it: the bounded top-K proof is "the base top K in the SAME order as the
   * query", and `order(publishedAt desc)` and `order(publishedAt asc)` have
   * disjoint top-K sets. Carrying the direction is therefore a deliberate
   * addition, not a divergence of behaviour.
   */
  readonly direction: 'asc' | 'desc'
}

/**
 * Candidate plans implemented by this package.
 *
 * Each one exists because a REAL planner implements it (`planner.ts`) and a
 * boundedness ceiling derived from query semantics holds for it. PRD §22.4's
 * `custom` is deliberately absent: a named external planner cannot be proven
 * bounded from the registration alone.
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
  /**
   * §22.3 Tier A "Basic array membership": `$value in <path>`. Exact for the
   * same reason `slug` is — the predicate reads a LOCAL array of the candidate
   * document, so the base can answer it and a branch edit is covered by the
   * union of branch records of those types.
   */
  | {
      type: 'field-contains'
      types: readonly string[]
      path: readonly string[]
      valueFromParam: string
    }
  /**
   * §22.3 Tier A "`references()` for finite IDs". Membership depends only on
   * the REFERRER's own fields, so this is a local predicate like the two above
   * — editing the target cannot add or remove a referrer. That is exactly the
   * property `author->name == $name` lacks, which is why filter-through-
   * reference is not registered anywhere in this package.
   */
  | {type: 'references'; types: readonly string[]; idFromParam: string}
  /**
   * §22.6 bounded top-K, for `*[<type>] | order(...)[0...K]`.
   *
   * The base fetch is the top `sliceEnd` of the UNTOUCHED base order, and every
   * branch record of the candidate types joins it (§22.6 step 6). Exactness
   * argument, which is the reason this may be registered Tier A at all:
   *
   *   An untouched base document with `K` untouched documents ordered above it
   *   cannot enter `[0...K]` after resolution. Those `K` documents are
   *   untouched, so they are neither tombstoned nor re-ordered by the branch;
   *   they therefore remain above it in the resolved dataset and hold it at
   *   rank `K + 1` or worse.
   *
   * This is PRD §22.6's `requestedEnd + affectedCount` with the affected set
   * excluded from the base fetch rather than added to its size — the same
   * bound, reached without fetching a base document the branch has already
   * replaced.
   *
   * Assumes the ordering is a TOTAL order over the candidate type. Ties at the
   * slice boundary are resolved by dataset order, which the base preserves for
   * untouched documents; a query whose ordering field ties across documents
   * should register a second order term.
   */
  | {
      type: 'top-k'
      types: readonly string[]
      order: readonly CandidateOrderTerm[]
      /** Exclusive end of the query's own `[0...K]` slice. */
      sliceEnd: number
    }
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
