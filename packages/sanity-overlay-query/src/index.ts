/**
 * `sanity-overlay-query` — the GROQ query layer (PRD §10 package layout, §22).
 *
 * Scope of this package as it stands: the `[M-LOCAL]` slice defined by PRD §37
 * Phase 2 and roadmap §5.3 — a reduced registry of ID and slug lookups with
 * their candidate planners, a pinned `groq-js` evaluator, and structured
 * diagnostics. Ordered slices, aggregates and filter-through-reference planning
 * remain PRD §37 Phase 5.
 *
 * PRD §10.1 `[MUST]`: this package runs in Node.js without browser globals, and
 * it is also free of Node-only globals so it can run in a browser. It takes no
 * dependency on Next.js, Vercel, `node:fs` or the hosted Sanity client; the
 * base dataset arrives through the {@link QueryBaseSource} port.
 *
 * Milestone note (PRD §1.4): landing this slice does not complete PRD §37
 * Phase 5 and claims no `[M-PROD]` acceptance.
 */

export type {
  CandidateOrderTerm,
  CandidatePlan,
  OverlayQueryDefinition,
  OverlayQueryDiagnostics,
  OverlayQueryResult,
  QueryCaller,
  QueryDocument,
  QueryPerspective,
  QueryTier,
  SystemTimestampPolicy,
} from './types'

export {OverlayQueryError, httpStatusForQueryErrorCode} from './errors'
export type {OverlayQueryErrorCode, OverlayQueryErrorDetails} from './errors'

export {createQueryRegistry, defineOverlayQuery, queryTextChecksum} from './registry'
export type {OverlayQueryRegistry} from './registry'

export {M_LOCAL_QUERIES} from './mLocalRegistry'

export {createMemoryBaseSource} from './baseSource'
export type {
  BaseCandidateRequest,
  ExtendedCandidateRequest,
  PlannedCandidateRequest,
  QueryBaseSource,
} from './baseSource'

export {emptyOverlaySource, resolveVirtualDocument} from './overlaySource'
export type {OverlaySource} from './overlaySource'

export {planCandidateRequests} from './planner'
export type {CandidatePlanContext, CandidatePlanRequests} from './planner'

export {analyzeDerefPaths, collectReferenceTargets} from './derefPaths'
export type {DerefPaths} from './derefPaths'

export {evaluateOverlayQuery} from './evaluate'
export type {EvaluateOverlayQueryOptions} from './evaluate'

/* The static half of §22.5: find unregistered GROQ in a codebase before it
 * runs. Pure and dependency free, so it is callable from CI (see
 * `lint/check-queries.mjs`), from the CLI package, or from an ESLint rule. */
export {
  checkSourceForUnregisteredQueries,
  checkSourcesForUnregisteredQueries,
  formatQueryLintReport,
  looksLikeGroq,
  scanStringLiterals,
} from './lint/queryLint'
export type {
  QueryLintCode,
  QueryLintFinding,
  QueryLintMode,
  QueryLintOptions,
  QueryLintReport,
  QueryLintSeverity,
  QueryLintSourceInput,
  RegisteredQuerySummary,
  SourceLiteral,
} from './lint/queryLint'
