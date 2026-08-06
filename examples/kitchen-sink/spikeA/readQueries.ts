// SPIKE A — turning the GROQ Studio actually writes into a `sanity-overlay-query`
// candidate plan, and letting that package answer.
//
// WHAT THIS MODULE IS *NOT* ANY MORE
// ──────────────────────────────────
// It used to be a second implementation of a decision `sanity-overlay-query`
// already owns: a lexical shape recogniser with its own plan type and its own
// mini-evaluator (`applyReadPlan`) that filtered and sliced a candidate set by
// hand. Two implementations of "which documents can this query observe, and what
// is the answer" is the defect, not a convenience:
//
//   - the ad-hoc one could not evaluate a projection, so it refused every Studio
//     list pane and the pane rendered pre-branch staging content;
//   - it re-derived tombstone suppression, branch-created admission and ordering
//     that §22.6 already specifies, so the two could drift silently.
//
// WHAT IS LEFT — the one decision the package genuinely does not make
// The package's registry is by design a **static, pre-registered, checksummed
// table** (PRD §22.5): a query is identified by a stable ID and its text is
// version controlled. Studio composes its queries at runtime and has no such ID.
// So this module derives a `CandidatePlan` from the parse tree, registers the
// query ephemerally through the package's own `defineOverlayQuery` (checksum and
// all), and hands the entire rest of the job over:
//
//   base request planning     planCandidateRequests   (§22.6 steps 4-5)
//   branch-created admission  evaluateOverlayQuery    (§22.6 step 6)
//   tombstone suppression     resolveVirtualDocument  (§22.6 step 7, 13)
//   reference expansion       evaluateOverlayQuery    (§22.6 steps 8-11)
//   boundedness               maxCandidates           (§22.9)
//   the answer itself         pinned groq-js          (§22.6 step 14)
//
// DERIVING A PLAN IS NOT THE SAME AS APPROXIMATING AN ANSWER. A plan is only
// derived when the candidate set is provably complete — every `*` in the query
// is constrained by a predicate whose matching documents a `BaseCandidateRequest`
// can select in full. Anything else is refused **with a reason a human can
// read**, and the caller passes it through to staging and records it (§22.5
// "[MUST] log unregistered queries", "[SHOULD] allow a warning mode") or, in
// strict mode, refuses outright (§22.5 "[MUST] reject in strict preview mode").
// §5.5's ban is on *silent* approximation; a recorded passthrough is not silent.
//
// WHERE THIS RUNS: NODE, NOT THE BROWSER — and that is deliberate, twice over.
//   1. `maxCandidates` is enforced inside `evaluateOverlayQuery`. Boundedness
//      decided in the browser is boundedness a page can be reloaded out of; it
//      belongs next to the overlay store, on the server (`overlayServer.mjs`).
//   2. `groq-js` is not resolvable from `examples/kitchen-sink` at all — the
//      Studio dev bundle has no path to it and installs are out of scope — so
//      the browser could not evaluate even if it should.
// `localEcho.ts` therefore imports NOTHING from here. It asks the server for a
// plan, executes the base requests it is handed (it is the only party holding
// Sanity credentials), and posts the documents back to be evaluated.
//
// Unit-tested by `packages/sanity-overlay-testkit/test/spike-a-read-queries.test.ts`.
import {parse as parseGroq} from 'groq-js'

import type {
  BaseCandidateRequest,
  QueryBaseSource,
} from '../../../packages/sanity-overlay-query/src/baseSource'
import {evaluateOverlayQuery} from '../../../packages/sanity-overlay-query/src/evaluate'
import type {OverlaySource} from '../../../packages/sanity-overlay-query/src/overlaySource'
import {planCandidateRequests} from '../../../packages/sanity-overlay-query/src/planner'
import {createQueryRegistry, defineOverlayQuery, queryTextChecksum} from '../../../packages/sanity-overlay-query/src/registry'
import type {
  CandidatePlan,
  OverlayQueryDefinition,
  OverlayQueryDiagnostics,
  QueryDocument,
  QueryPerspective,
} from '../../../packages/sanity-overlay-query/src/types'

type Rec = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * Registration constants
 * ------------------------------------------------------------------ */

/**
 * §22.6 step 11. Mirrors every `[M-LOCAL]` registration; a deeper graph is a
 * `REFERENCE_DEPTH_EXCEEDED` rather than an unbounded walk.
 */
export const SPIKE_A_MAX_REFERENCE_DEPTH = 3

/**
 * Per-plan candidate ceilings (PRD §11.1 `query.maxCandidateDocuments`, §22.9).
 * Per-plan rather than global for the reason the Spike C latency evidence
 * (§1.1) records: one number cannot serve a lookup and a list at once.
 *
 * `ids`  — the answer is the named documents plus whatever the dereference
 *          walk pulls in. The largest fan-out measured in the Spike C corpus
 *          was 9, so 64 of headroom on top of the named set fails long before
 *          anything resembling a scan.
 * `slug` — the base fetch returns the matches, but §22.6 step 6 unions in every
 *          BRANCH record of the type, because an edit can make a document newly
 *          match. That is bounded by the size of the branch, not the dataset.
 * `types`— the answer IS the type, so the candidate set cannot be smaller than
 *          the response. Not constant-bounded and not claimed to be; the
 *          boundedness suite classifies this shape `result-proportional`.
 */
const ID_PLAN_HEADROOM = 64
const SLUG_MAX_CANDIDATES = 512
const TYPE_LIST_MAX_CANDIDATES = 4096

/**
 * The synthetic parameter a derived slug plan reads its value from.
 *
 * `CandidatePlan.slug` names a PARAMETER, not a value, so a query with a literal
 * slug (`slug.current == "about"`) has nowhere to put it. Lifting the value into
 * a reserved parameter keeps the package's planner in charge instead of
 * special-casing literals here. The name is namespaced so it cannot collide with
 * a caller's own parameter, and groq-js ignores parameters the query never reads.
 */
const SLUG_PLAN_PARAM = '__spikeAFieldValue'

/** The shapes a refusal message can point at as the alternative. */
export const SUPPORTED_READ_SHAPES =
  'a filter naming `_id` (== / in), a `sanity::versionOf(<id>)` version set, or a `_type` ' +
  'constraint optionally with a local field equality — projections, slices, array wrappers ' +
  'and dereferences are then free'

/**
 * The note a version-set plan carries into `/query/plan` (PRD §22.5 wants the
 * caller able to record what it is trusting). See {@link releaseNamespaceReason}
 * for why the boundary sits where it does.
 */
export const VERSION_SET_NOTE =
  'sanity::versionOf is resolved exactly for the draft/published version set — `<id>` and ' +
  '`drafts.<id>`, both of which the overlay knows authoritatively, branch-created drafts ' +
  'and tombstones included. Release versions (`versions.<release>.<id>`) are outside it: ' +
  'PRD §32 degrades Releases in overlay mode, so the overlay holds none, and a query that ' +
  'names that namespace is refused rather than half-answered.'

/* ------------------------------------------------------------------ *
 * Result types
 * ------------------------------------------------------------------ */

export interface ReadQueryPlan {
  /** The ephemeral registration the package validates and evaluates against. */
  definition: OverlayQueryDefinition
  /**
   * Parameters the CANDIDATE PLAN resolves against — the caller's own, plus any
   * value this module had to lift out of the query text (see
   * {@link SLUG_PLAN_PARAM}). Never the other way round: a caller parameter is
   * never rewritten.
   */
  planParams: Record<string, unknown>
  /** What the credential holder must fetch from base (§22.6 step 5). */
  baseRequests: readonly BaseCandidateRequest[]
}

export type ReadQueryDerivation =
  | {supported: true; plan: ReadQueryPlan}
  | {supported: false; reason: string}

export interface ReadQueryEvaluation {
  result: unknown
  diagnostics: OverlayQueryDiagnostics
}

/* ------------------------------------------------------------------ *
 * AST helpers
 * ------------------------------------------------------------------ */

type Node = Rec & {type: string}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Rec).type === 'string'
  )
}

/** Visit every AST node, in no particular order. */
function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (isNode(value)) visit(value)
  for (const child of Object.values(value as Rec)) walk(child, visit)
}

/** `a && b && c` as a flat list; anything else is a single conjunct. */
function conjunctsOf(node: unknown): Node[] {
  if (!isNode(node)) return []
  if (node.type === 'And') return [...conjunctsOf(node.left), ...conjunctsOf(node.right)]
  if (node.type === 'Group') return conjunctsOf(node.base)
  return [node]
}

/**
 * The attribute path an `AccessAttribute` chain names, rooted at the document.
 *
 * `slug.current` is `AccessAttribute{base: AccessAttribute{name:'slug'}, name:'current'}`.
 * A chain rooted at anything other than the document itself (a `Parent`, a
 * dereference) is not a local field and returns `null` — the base fetch could
 * not push such a predicate down, and §22.6 step 10 is out of scope here.
 */
function attributePath(node: unknown): string[] | null {
  if (!isNode(node) || node.type !== 'AccessAttribute') return null
  const name = node.name
  if (typeof name !== 'string') return null
  const base = node.base
  if (base === undefined || (isNode(base) && base.type === 'This')) return [name]
  const parent = attributePath(base)
  return parent === null ? null : [...parent, name]
}

/** A `Value` literal or a `Parameter` looked up in `params`. */
function operandValue(node: unknown, params: Rec): {value: unknown} | {missing: string} | null {
  if (!isNode(node)) return null
  if (node.type === 'Value') return {value: node.value}
  if (node.type === 'Group') return operandValue(node.base, params)
  if (node.type === 'Parameter') {
    const name = node.name
    if (typeof name !== 'string') return null
    if (!(name in params)) return {missing: name}
    return {value: params[name]}
  }
  if (node.type === 'Array') {
    const elements = node.elements
    if (!Array.isArray(elements)) return null
    const values: unknown[] = []
    for (const element of elements) {
      if (!isNode(element) || element.isSplat === true) return null
      const resolved = operandValue(element.value, params)
      if (resolved === null) return null
      if ('missing' in resolved) return resolved
      values.push(resolved.value)
    }
    return {value: values}
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

function refuse(reason: string): ReadQueryDerivation {
  return {supported: false, reason}
}

/**
 * An ID — or an ID pattern — inside the hosted Releases namespace.
 *
 * THE ONE PRODUCT BOUNDARY THIS MODULE DRAWS, stated once so it is auditable.
 * `groq-js@2.0.0` matches `sanity::versionOf(X)` against exactly three ID shapes:
 * `X`, `drafts.X` and `versions.<release>.X`. The first two are a two-element ID
 * set a `{kind: 'ids'}` base request selects in full, so a version set over them
 * is *provably* complete. The third is not enumerable by any request shape in
 * `baseSource.ts` — it needs an ID-PATTERN selection, which is exactly the
 * request kind `path()` is refused for.
 *
 * Excluding it is nonetheless sound rather than an approximation, because PRD
 * §32 degrades Releases in overlay mode (the Studio plugin disables the tool),
 * so the overlay holds no release-version document and none can be created
 * through it. What would NOT be sound is answering a query that actually names
 * the namespace: the result would be a silent subset of the hosted one, which
 * §5.5 forbids. So the boundary is one-sided — excluded when unmentioned,
 * refused when mentioned.
 */
const RELEASE_VERSION_ID = /^versions\./

function releaseNamespaceReason(what: string): string {
  return (
    `${what} names the release-version namespace \`versions.<release>.<id>\`. Releases are ` +
    'degraded in overlay mode (PRD §32), so the overlay holds no release-version document, ' +
    'and no base request shape can enumerate that namespace — selecting it needs an ' +
    'ID-pattern request. Answering the rest would hand back a silent subset of the hosted ' +
    'result (PRD §5.5), so the query is refused instead'
  )
}

/**
 * `sanity::versionOf(…)`, wherever it sits in the tree.
 *
 * Deliberately NOT a type predicate: callers pass an already-`Node` conjunct,
 * and `node is Node` would narrow the negative branch to `never` and hide every
 * subsequent field access behind a type error.
 */
function isVersionOfCall(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === 'FuncCall' &&
    node.namespace === 'sanity' &&
    node.name === 'versionOf'
  )
}

/**
 * Functions whose evaluation or whose selection this layer cannot honour.
 *
 * These are refusals of *completeness*, not of syntax — each one names a set of
 * documents no `BaseCandidateRequest` can enumerate, so a locally evaluated
 * answer would be missing rows without saying so.
 *
 * `sanity::versionOf` is deliberately absent: its draft/published version set IS
 * enumerable, so it is planned by {@link versionSetOf} instead. A `versionOf`
 * the planner cannot read is caught in `deriveReadQuery`, not here.
 */
function deniedFunction(node: Node): string | null {
  const namespace = typeof node.namespace === 'string' ? node.namespace : 'global'
  const name = typeof node.name === 'string' ? node.name : '?'

  if (name === 'path') {
    return (
      'path() selects documents by ID pattern across the whole dataset, including the ' +
      'system namespaces (`_.releases.*`) that no `*[_type == …]` or `*[_id in …]` base ' +
      'fetch returns, so the candidate set cannot be proven complete'
    )
  }
  if (namespace === 'text') {
    return (
      `text::${name} is answered by the hosted search index, which has no local ` +
      'equivalent — evaluating it over a candidate set would silently drop every match ' +
      'the index would have found'
    )
  }
  if (namespace === 'releases') {
    return releaseNamespaceReason(`releases::${name}, which enumerates release documents,`)
  }
  if (namespace === 'sanity') {
    if (name === 'versionOf') return null
    if (name === 'partOfRelease') return releaseNamespaceReason(`sanity::${name}`)
    return `sanity::${name} is a hosted dataset function with no local candidate plan`
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Constraint derivation
 * ------------------------------------------------------------------ */

type Constraint =
  | {kind: 'ids'; ids: string[]}
  | {kind: 'types'; types: string[]}
  | {kind: 'field'; types: string[]; path: string[]; value: unknown}

const SYSTEM_TYPE = /^(system|sanity)\./
const SYSTEM_ID = /^_\./

function stringsOf(value: unknown): string[] | null {
  if (typeof value === 'string') return value.length === 0 ? null : [value]
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return null
    out.push(item)
  }
  return out
}

/** A refusal produced while reading a filter — carried out of the recursion. */
class DeriveRefusal extends Error {}

function fail(reason: string): never {
  throw new DeriveRefusal(reason)
}

/** Describe an operand for a refusal message: `$name` when it came from one. */
function operandLabel(node: unknown): string {
  return isNode(node) && node.type === 'Parameter' && typeof node.name === 'string'
    ? `$${node.name}`
    : 'the value'
}

/**
 * The version set of one `sanity::versionOf(X)` conjunct: `X` and `drafts.X`.
 *
 * PROVABLY COMPLETE, and this is the whole argument. The predicate's matching
 * IDs are `X`, `drafts.X` and `versions.<release>.X` (see
 * {@link RELEASE_VERSION_ID}). The pair returned here is selected in full by one
 * `{kind: 'ids'}` base request, and — decisively — the OVERLAY knows both
 * addresses authoritatively rather than inferring them: `evaluate.ts` admits
 * them through `explicitIds`, so a branch-created `drafts.X` staging has never
 * held is a candidate, and `resolveVirtualDocument` drops a tombstoned one. The
 * release third is the documented boundary above.
 *
 * The pair is a candidate SET, not an answer: `groq-js` re-evaluates the real
 * `versionOf` predicate over it at step 14, so a query naming two logical
 * documents does not leak one's versions into the other's row.
 */
function versionSetOf(node: Node, params: Rec): string[] {
  const args = node.args
  const resolved = operandValue(Array.isArray(args) ? args[0] : undefined, params)

  if (resolved === null) {
    fail(
      'sanity::versionOf(…) needs a document ID resolvable *before* the base fetch — a ' +
        'literal or a query parameter. An argument read off the row being filtered ' +
        '(`_id`, `^._id`) is only known during evaluation, so the version set cannot be ' +
        'planned and the candidate request would have to be the whole dataset',
    )
  }
  if ('missing' in resolved) {
    fail(
      `parameter $${resolved.missing} was not supplied, so the sanity::versionOf version set ` +
        'cannot be resolved — guessing one would be a silent approximation',
    )
  }

  const logicalId = resolved.value
  if (typeof logicalId !== 'string' || logicalId.length === 0) {
    fail(
      `sanity::versionOf was given ${JSON.stringify(logicalId ?? null)}, which is not a ` +
        'document ID, so its version set cannot be resolved exactly',
    )
  }
  if (RELEASE_VERSION_ID.test(logicalId)) {
    fail(releaseNamespaceReason('the sanity::versionOf argument'))
  }
  if (SYSTEM_ID.test(logicalId)) {
    fail(`document ID ${JSON.stringify(logicalId)} is in a system namespace no base fetch returns`)
  }

  return [logicalId, `drafts.${logicalId}`]
}

/**
 * `_id match "versions.*"` and friends.
 *
 * A `match` only ever NARROWS, so the planner is otherwise free to ignore it —
 * but a pattern aimed at the release-version namespace is a query asking for
 * documents the overlay has decided not to hold. Answering it would be the
 * silent subset {@link releaseNamespaceReason} exists to prevent.
 */
function guardIdPattern(node: Node, params: Rec): void {
  const path = attributePath(node.left)
  if (path === null || path.length !== 1 || path[0] !== '_id') return
  const resolved = operandValue(node.right, params)
  if (resolved === null || 'missing' in resolved) return
  const patterns = stringsOf(resolved.value)
  if (patterns === null) return
  const release = patterns.find((pattern) => RELEASE_VERSION_ID.test(pattern))
  if (release !== undefined) {
    fail(releaseNamespaceReason(`the \`_id match ${JSON.stringify(release)}\` pattern`))
  }
}

/**
 * Read one `*[…]` filter as a candidate constraint.
 *
 * Only top-level conjuncts are read, and only to *narrow*: an unread conjunct
 * can shrink the answer but never widen it, so ignoring it keeps the candidate
 * set a superset of the result — which is what completeness means here. A filter
 * that is a disjunction, or whose conjuncts name nothing bounded, yields `null`
 * and is refused.
 */
function constraintOf(expr: unknown, params: Rec): Constraint | null {
  const conjuncts = conjunctsOf(expr)

  let ids: string[] | null = null
  let types: string[] | null = null
  let field: {path: string[]; value: unknown} | null = null

  for (const conjunct of conjuncts) {
    /* §22.6 step 4 for the version set. Read as an ID constraint, so it composes
     * with a plain `_id` set in the same query and needs no second plan type. */
    if (isVersionOfCall(conjunct)) {
      const versions = versionSetOf(conjunct, params)
      ids = ids === null ? versions : [...ids, ...versions]
      continue
    }

    if (conjunct.type !== 'OpCall') continue
    const op = conjunct.op
    if (op === 'match') {
      guardIdPattern(conjunct, params)
      continue
    }
    if (op !== '==' && op !== 'in') continue

    const path = attributePath(conjunct.left)
    if (path === null) continue
    const resolved = operandValue(conjunct.right, params)
    if (resolved === null) continue
    if ('missing' in resolved) {
      fail(
        `parameter $${resolved.missing} was not supplied, so the candidate set for ` +
          `${path.join('.')} cannot be resolved — guessing one would be a silent approximation`,
      )
    }

    if (path.length === 1 && path[0] === '_id') {
      const values = stringsOf(resolved.value)
      if (values === null) {
        fail(
          `${operandLabel(conjunct.right)} is not a document ID (or list of them), so the ` +
            '`_id` candidate set cannot be resolved exactly',
        )
      }
      const release = values.find((id) => RELEASE_VERSION_ID.test(id))
      if (release !== undefined) {
        fail(releaseNamespaceReason(`document ID ${JSON.stringify(release)}`))
      }
      const system = values.find((id) => SYSTEM_ID.test(id))
      if (system !== undefined) {
        fail(`document ID ${JSON.stringify(system)} is in a system namespace no base fetch returns`)
      }
      ids = ids === null ? values : [...ids, ...values]
      continue
    }

    if (path.length === 1 && path[0] === '_type') {
      const values = stringsOf(resolved.value)
      if (values === null) {
        fail(
          `${operandLabel(conjunct.right)} is not a schema type (or list of them), so the ` +
            '`_type` candidate set cannot be resolved exactly',
        )
      }
      const system = values.find((type) => SYSTEM_TYPE.test(type))
      if (system !== undefined) {
        fail(
          `type ${JSON.stringify(system)} is a hosted system type; a plain \`*[_type == …]\` ` +
            'fetch does not return its documents, so the candidate set cannot be proven complete',
        )
      }
      types = types === null ? values : [...types, ...values]
      continue
    }

    /* A local field equality is only useful WITH a type constraint — it becomes
     * the §22.7 "exact slug-filtered pages plus all overlaid pages" plan. Kept
     * as the first one seen: a second one would need an intersection the base
     * request shape cannot express. */
    if (op === '==' && field === null && resolved.value !== null && typeof resolved.value !== 'object') {
      field = {path, value: resolved.value}
    }
  }

  if (ids !== null) return {kind: 'ids', ids}
  if (types !== null && field !== null) {
    return {kind: 'field', types, path: field.path, value: field.value}
  }
  if (types !== null) return {kind: 'types', types}
  if (field !== null) {
    fail(
      `a \`${field.path.join('.')} ==\` filter with no \`_type\` constraint has no bounded ` +
        'candidate plan: no base request can select "every document with this field value"',
    )
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Fold every `*[…]` in one query into the single plan the registry model allows. */
function combine(constraints: readonly Constraint[]): CandidatePlan {
  if (constraints.length === 1 && constraints[0]?.kind === 'field') {
    const only = constraints[0]
    return {
      type: 'slug',
      types: dedupe(only.types),
      path: only.path,
      valueFromParam: SLUG_PLAN_PARAM,
    }
  }

  if (constraints.every((constraint) => constraint.kind === 'ids')) {
    return {
      type: 'ids-literal',
      ids: dedupe(constraints.flatMap((constraint) => (constraint as {ids: string[]}).ids)),
    }
  }

  if (constraints.every((constraint) => constraint.kind === 'types')) {
    return {
      type: 'types',
      types: dedupe(constraints.flatMap((constraint) => (constraint as {types: string[]}).types)),
    }
  }

  fail(
    'this query needs more than one candidate plan (an ID set and a type scan, or two ' +
      'different field filters). PRD §22.4 registers exactly one candidate plan per query, ' +
      'so the candidate set cannot be planned exactly',
  )
}

function ceilingFor(plan: CandidatePlan): number {
  if (plan.type === 'ids-literal') return plan.ids.length + ID_PLAN_HEADROOM
  if (plan.type === 'ids') return plan.idsFromParams.length + ID_PLAN_HEADROOM
  if (plan.type === 'slug') return SLUG_MAX_CANDIDATES
  return TYPE_LIST_MAX_CANDIDATES
}

/**
 * Derive the candidate plan for one `(query, params)` pair, or say why not.
 *
 * PER CALL, not per query text, and that is forced rather than chosen:
 * `CandidatePlan.ids` names one PARAMETER per ID (`planner.ts` rejects anything
 * that is not a non-empty string), so `*[_id in $ids]` — the single most common
 * Studio shape — has no template form. Resolving the parameter here turns it
 * into an exact `ids-literal`. See the reported gap in
 * `spike-a-read-queries.test.ts` §6.
 */
export function deriveReadQuery(query: unknown, params?: unknown): ReadQueryDerivation {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return refuse('not a GROQ string, so there is nothing to plan')
  }
  const callParams: Rec =
    typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Rec) : {}

  let tree: unknown
  try {
    tree = parseGroq(query)
  } catch (cause) {
    return refuse(`the query does not parse as GROQ: ${(cause as Error).message}`)
  }

  /* Pass 1: which `Everything` nodes are the subject of a filter, and does the
   * query call anything whose selection cannot be enumerated locally. */
  const filtered = new Set<unknown>()
  const filters: unknown[] = []
  /* Every `sanity::versionOf` the planner will actually READ. `constraintOf`
   * reads top-level conjuncts of a `*[…]` filter and nothing else, so a
   * versionOf anywhere else contributes no candidates — and planning around it
   * would answer a strict subset of the hosted result without saying so. */
  const plannableVersionOf = new Set<unknown>()
  let denied: string | null = null
  walk(tree, (node) => {
    if (node.type === 'Filter' && isNode(node.base) && node.base.type === 'Everything') {
      filtered.add(node.base)
      filters.push(node.expr)
      for (const conjunct of conjunctsOf(node.expr)) {
        if (isVersionOfCall(conjunct)) plannableVersionOf.add(conjunct)
      }
    }
    if (node.type === 'FuncCall' && denied === null) denied = deniedFunction(node)
  })
  if (denied !== null) return refuse(denied)

  let strayVersionOf = false
  walk(tree, (node) => {
    if (isVersionOfCall(node) && !plannableVersionOf.has(node)) strayVersionOf = true
  })
  if (strayVersionOf) {
    return refuse(
      'this query calls `sanity::versionOf` somewhere the candidate planner does not read it ' +
        '— under a `||`, or nested so it is not a top-level conjunct of its `*[…]` filter. ' +
        'The version set would then contribute no candidates and the answer would be a ' +
        'silent subset of the hosted one. Answerable instead: ' +
        SUPPORTED_READ_SHAPES,
    )
  }

  /* Pass 2: an `Everything` that is not filtered is the whole dataset. */
  let unconstrained = false
  walk(tree, (node) => {
    if (node.type === 'Everything' && !filtered.has(node)) unconstrained = true
  })
  if (unconstrained) {
    return refuse(
      'the query reaches an unconstrained `*`: the whole dataset is its candidate set, ' +
        'which no base request can transfer and no local evaluation can prove complete ' +
        `(PRD §22.3 Tier C). Answerable instead: ${SUPPORTED_READ_SHAPES}`,
    )
  }
  if (filters.length === 0) {
    return refuse('the query selects no documents, so there is nothing for the overlay to answer')
  }

  let plan: CandidatePlan
  let constraints: Constraint[]
  try {
    constraints = filters.map((expr) => {
      const constraint = constraintOf(expr, callParams)
      if (constraint === null) {
        fail(
          'no bounded candidate plan can be derived from this filter: it names neither `_id` ' +
            'nor `_type` in a form a base request can select. Answerable instead: ' +
            SUPPORTED_READ_SHAPES,
        )
      }
      return constraint
    })
    plan = combine(constraints)
  } catch (error) {
    if (error instanceof DeriveRefusal) return refuse(error.message)
    throw error
  }

  const planParams: Rec = {...callParams}
  if (plan.type === 'slug') {
    const only = constraints[0] as {value: unknown}
    planParams[SLUG_PLAN_PARAM] = only.value
  }

  const checksum = queryTextChecksum(query)
  let definition: OverlayQueryDefinition
  try {
    definition = defineOverlayQuery({
      id: `spike-a:${checksum.slice(0, 16)}`,
      description: 'Studio-issued read, planned at call time by spikeA.',
      query,
      queryChecksum: checksum,
      /* Studio is the only caller that reaches this path; `test` is here so the
       * suite can exercise the same registration without a second definition. */
      allowedCallers: ['studio', 'test'],
      /* spikeA addresses documents by their raw `_id` (`drafts.x` vs `x`), which
       * is §18.3's raw view; `published`/`drafts` are registered so a caller that
       * asks for a perspective read is not rejected by the registry. */
      perspectives: ['raw', 'published', 'drafts'],
      candidatePlan: plan,
      systemTimestampPolicy: 'preserve-base',
      maxCandidates: ceilingFor(plan),
      maxReferenceDepth: SPIKE_A_MAX_REFERENCE_DEPTH,
      status: 'tier-a',
      /* Only a plan that actually resolved a version set makes the release
       * claim. A note stamped on every plan is a note nobody reads. */
      ...(plannableVersionOf.size > 0 ? {notes: VERSION_SET_NOTE} : {}),
    })
  } catch (error) {
    return refuse(`the query could not be registered: ${(error as Error).message}`)
  }

  let baseRequests: readonly BaseCandidateRequest[]
  try {
    baseRequests = planCandidateRequests(definition, planParams).baseRequests
  } catch (error) {
    return refuse(`the candidate plan could not be resolved: ${(error as Error).message}`)
  }

  return {supported: true, plan: {definition, planParams, baseRequests}}
}

/* ------------------------------------------------------------------ *
 * The candidate source
 * ------------------------------------------------------------------ */

function readPath(document: QueryDocument, path: readonly string[]): unknown {
  let cursor: unknown = document
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Rec)[segment]
  }
  return cursor
}

export interface CandidateSourceInput {
  readonly baseDocuments: readonly QueryDocument[]
  readonly overlay: OverlaySource
}

/**
 * The `QueryBaseSource` spikeA hands the evaluator — and the answer to the
 * candidate-order caveat `evaluate.ts` states in its own header.
 *
 * THE CAVEAT. The evaluator admits candidates base-fetch → branch-created →
 * reference-expanded, and GROQ can observe that order: an unordered `*[…]`
 * answers in dataset order. `evaluate.ts` calls it immaterial "while at most one
 * candidate can match", which holds for an ID or slug lookup and does NOT hold
 * for a list. Left alone, a list pane would answer with every branch-created
 * document appended after every base one — an order that is a property of *where
 * a document came from*, which is exactly what an overlay must not leak.
 *
 * THE ANSWER. Establish the order here, where the candidate set is assembled,
 * instead of inheriting it: the source answers every request from the union of
 * base and branch documents, **sorted by `_id`**. The evaluator then admits them
 * in that order, so dataset order is a total order that is a pure function of
 * the answer — identical whether a document came from staging or the branch.
 * Nothing post-processes an evaluated result, which §22.2 forbids outright, and
 * which would in any case be wrong for the real list-pane shape, whose documents
 * sit inside a projection inside a slice inside an array wrapper.
 *
 * WHY THE UNION HAPPENS HERE AND NOT ONLY IN §22.6 STEP 6. Returning branch
 * records from this port widens `ids`/`types` selections to documents base does
 * not hold — the same documents step 6 would have unioned in a moment later, so
 * the candidate SET is unchanged and only its order differs. `field-equality` is
 * widened the same way and for the same reason step 6 does it: a branch edit can
 * make a document newly match a predicate the base fetch evaluated against
 * pre-branch content.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: suppress tombstones. That is §22.6 step 7
 * and it stays in `resolveVirtualDocument`, one implementation, so that removing
 * it is falsifiable by a test.
 */
export function createCandidateSource(input: CandidateSourceInput): QueryBaseSource {
  const byId = new Map<string, QueryDocument>()
  for (const document of input.baseDocuments) {
    if (typeof document?._id === 'string') byId.set(document._id, document)
  }
  /* §22.6 step 13: the branch record wins over the base row at the same ID. */
  for (const [id, document] of input.overlay.documents) byId.set(id, {...document, _id: id})

  const all = [...byId.values()].sort((left, right) =>
    left._id < right._id ? -1 : left._id > right._id ? 1 : 0,
  )

  return {
    async fetchCandidates(request) {
      switch (request.kind) {
        case 'ids': {
          const wanted = new Set(request.ids)
          return all.filter((document) => wanted.has(document._id))
        }
        case 'types': {
          const types = new Set(request.types)
          return all.filter((document) => types.has(document._type))
        }
        case 'field-equality': {
          const types = new Set(request.types)
          return all.filter(
            (document) =>
              types.has(document._type) &&
              (readPath(document, request.path) === request.value ||
                input.overlay.documents.has(document._id)),
          )
        }
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled base request ${JSON.stringify(exhaustive)}`)
        }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export interface EvaluateReadQueryOptions {
  readonly plan: ReadQueryPlan
  readonly params: Record<string, unknown>
  /** What the credential holder fetched for {@link ReadQueryPlan.baseRequests}. */
  readonly baseDocuments: readonly QueryDocument[]
  readonly overlay: OverlaySource
  readonly perspective?: QueryPerspective
}

/**
 * Evaluate one derived plan through the package.
 *
 * The registry is built per call from the ephemeral definition, which is what
 * makes the package's own guarantees apply unchanged: the checksum is verified,
 * the caller and perspective are checked, `maxCandidates` is enforced, and
 * `groq-js` runs exactly once on the ORIGINAL query text over a candidate set
 * that already contains the resolved branch state (§22.6 step 14).
 */
export async function evaluateReadQuery(
  options: EvaluateReadQueryOptions,
): Promise<ReadQueryEvaluation> {
  const {definition} = options.plan
  const registry = createQueryRegistry([definition])

  const {result, diagnostics} = await evaluateOverlayQuery({
    registry,
    queryId: definition.id,
    query: definition.query,
    params: {...options.params, ...options.plan.planParams},
    base: createCandidateSource({
      baseDocuments: options.baseDocuments,
      overlay: options.overlay,
    }),
    overlay: options.overlay,
    caller: 'studio',
    perspective: options.perspective ?? 'raw',
  })

  return {result, diagnostics}
}
