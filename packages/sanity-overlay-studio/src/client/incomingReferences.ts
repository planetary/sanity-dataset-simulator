/**
 * `*[references($id)]` — the one Studio read shape the generic planner cannot
 * answer, and the reason "used by" misses branch-created links (PRD §21.6
 * "Incoming references: Custom combined base plus overlay query", §19.4).
 *
 * WHY THE GENERIC PLANNER REFUSES IT, AND WHY THAT IS RIGHT.
 * `readPlan.ts` derives a candidate plan only when a `BaseCandidateRequest` can
 * select the matching documents *in full*, and the request vocabulary is `ids`,
 * `types`, `field-equality`. None of them expresses "every document that points
 * at X", so the derivation correctly gives up rather than answering a subset.
 *
 * WHY THIS ONE *CAN* BE PLANNED ANYWAY. The base dataset answers `references()`
 * natively — that is the query Studio was already sending — and the branch is
 * enumerable by construction. So the candidate set is
 *
 *     (documents staging says reference the target)
 *   ∪ (branch documents whose CURRENT body references the target)
 *
 * which is a provable superset of the answer, and bounded: one slice-capped base
 * fetch plus the branch. `groq-js` then re-evaluates the caller's own
 * `references()` predicate over the resolved candidates, so
 *
 *   - a branch-created referring document appears though staging never saw it,
 *   - a staging hit whose branch copy dropped the reference disappears,
 *   - a tombstoned referring document is suppressed by §22.6 step 7,
 *
 * without any of those three being special-cased here. §19.4's "apply local
 * tombstones and modifications before deciding integrity" falls out of
 * re-evaluating rather than of post-processing, which §22.2 forbids outright.
 *
 * THE BOUNDARY. This module claims a query ONLY when every `*[…]` in it is
 * reference-filtered and nothing else in it is locally unanswerable. A query
 * that also carries a `_type` constraint is left to the generic planner, whose
 * `types` plan is tighter; two plans for one query is one too many.
 */

import {parse as parseGroq} from 'groq-js'

import {extractReferences, toPublishedId} from '../../../sanity-overlay-core/src/index'
import type {SanityDocument} from '../../../sanity-overlay-core/src/index'
import type {BaseCandidateRequest} from '../../../sanity-overlay-query/src/baseSource'
import type {OverlaySource} from '../../../sanity-overlay-query/src/overlaySource'
import {planCandidateRequests} from '../../../sanity-overlay-query/src/planner'
import {
  defineOverlayQuery,
  queryTextChecksum,
} from '../../../sanity-overlay-query/src/registry'
import type {OverlayQueryDefinition} from '../../../sanity-overlay-query/src/types'
import {ID_PLAN_HEADROOM, STUDIO_MAX_REFERENCE_DEPTH, type StudioReadPlan} from './readPlan'

type Rec = Record<string, unknown>

/**
 * The reserved parameter the base reference fetch binds its targets to.
 *
 * Namespaced so it cannot collide with a caller's own parameter, and a
 * PARAMETER rather than an interpolation: the target ID arrives from a URL and
 * must never be spliced into GROQ text.
 */
export const INCOMING_REFERENCE_TARGETS_PARAM = '__overlayRefTargets'

/**
 * How many referring documents staging may return before the read is degraded.
 *
 * Studio's own callers ask for 100 or 101 rows; this ceiling is well above that
 * and exists for the case §22.9 cares about — a widely referenced document whose
 * incoming set is a large fraction of the dataset. Over the ceiling the read is
 * recorded as a passthrough rather than answered from a truncated pool.
 */
export const INCOMING_REFERENCE_MAX_CANDIDATES = 2048

/* ------------------------------------------------------------------ *
 * AST reading
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

function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (isNode(value)) visit(value)
  for (const child of Object.values(value as Rec)) walk(child, visit)
}

function conjunctsOf(node: unknown): Node[] {
  if (!isNode(node)) return []
  if (node.type === 'And') return [...conjunctsOf(node.left), ...conjunctsOf(node.right)]
  if (node.type === 'Group') return conjunctsOf(node.base)
  return [node]
}

function attributeName(node: unknown): string | null {
  if (!isNode(node) || node.type !== 'AccessAttribute') return null
  const base = node.base
  if (base !== undefined && !(isNode(base) && base.type === 'This')) return null
  return typeof node.name === 'string' ? node.name : null
}

/** A literal or a supplied parameter, resolved to a value. `null` if neither. */
function operandValue(node: unknown, params: Rec): {value: unknown} | null {
  if (!isNode(node)) return null
  if (node.type === 'Value') return {value: node.value}
  if (node.type === 'Group') return operandValue(node.base, params)
  if (node.type === 'Parameter') {
    const name = node.name
    if (typeof name !== 'string' || !(name in params)) return null
    return {value: params[name]}
  }
  return null
}

/** Functions whose local answer would be a silent subset. Mirrors `readPlan.ts`. */
function callsSomethingUnanswerable(tree: unknown): boolean {
  let found = false
  walk(tree, (node) => {
    if (node.type !== 'FuncCall') return
    const namespace = typeof node.namespace === 'string' ? node.namespace : 'global'
    if (node.name === 'path') found = true
    if (namespace === 'text' || namespace === 'releases' || namespace === 'sanity') found = true
  })
  return found
}

function isReferencesCall(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === 'FuncCall' &&
    node.name === 'references' &&
    (node.namespace === undefined || node.namespace === 'global')
  )
}

/** The target IDs one `references(…)` call names, or `null` if not resolvable. */
function targetsOf(node: Node, params: Rec): string[] | null {
  const args = Array.isArray(node.args) ? node.args : []
  if (args.length === 0) return null
  const out: string[] = []
  for (const arg of args) {
    const resolved = operandValue(arg, params)
    if (resolved === null) return null
    const values = Array.isArray(resolved.value) ? resolved.value : [resolved.value]
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) return null
      out.push(toPublishedId(value))
    }
  }
  return out.length === 0 ? null : out
}

/** Does this filter carry an `_id` / `_type` constraint the generic planner reads? */
function hasGenericConstraint(expr: unknown): boolean {
  for (const conjunct of conjunctsOf(expr)) {
    if (conjunct.type !== 'OpCall') continue
    if (conjunct.op !== '==' && conjunct.op !== 'in') continue
    const name = attributeName(conjunct.left)
    if (name === '_id' || name === '_type') return true
  }
  return false
}

export type IncomingReferenceDerivation =
  | {supported: true; targetIds: string[]}
  | {supported: false; reason: string}

function decline(reason: string): IncomingReferenceDerivation {
  return {supported: false, reason}
}

/**
 * Read a query as "who references these documents", or say why it is not one.
 *
 * Every `*[…]` in the query must carry a top-level `references(…)` conjunct
 * whose target is resolvable BEFORE the base fetch. A query with one such filter
 * and one without has no bounded plan for the second, and answering the first
 * exactly would produce a result that is partly exact and partly a subset — the
 * silent approximation §5.5 rules out.
 */
export function deriveIncomingReferenceTargets(
  query: unknown,
  params: unknown,
): IncomingReferenceDerivation {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return decline('not a GROQ string')
  }
  const callParams: Rec =
    typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Rec) : {}

  let tree: unknown
  try {
    tree = parseGroq(query)
  } catch {
    return decline('the query does not parse as GROQ')
  }

  if (callsSomethingUnanswerable(tree)) {
    return decline(
      'the query also calls a function with no local answer (text::, releases::, sanity:: or ' +
        'path()), so a locally evaluated result would be a silent subset',
    )
  }

  const filters: unknown[] = []
  walk(tree, (node) => {
    if (node.type === 'Filter' && isNode(node.base) && node.base.type === 'Everything') {
      filters.push(node.expr)
    }
  })

  let unconstrained = false
  const filtered = new Set<unknown>()
  walk(tree, (node) => {
    if (node.type === 'Filter' && isNode(node.base) && node.base.type === 'Everything') {
      filtered.add(node.base)
    }
  })
  walk(tree, (node) => {
    if (node.type === 'Everything' && !filtered.has(node)) unconstrained = true
  })
  if (unconstrained) return decline('the query reaches an unconstrained `*`')
  if (filters.length === 0) return decline('the query selects no documents')

  const targets: string[] = []
  for (const expr of filters) {
    const conjuncts = conjunctsOf(expr)
    const call = conjuncts.find(isReferencesCall)
    if (call === undefined) {
      return decline(
        'not every `*[…]` in this query filters by `references(…)`, so at least one of them has ' +
          'no bounded candidate plan',
      )
    }
    if (hasGenericConstraint(expr)) {
      return decline(
        'this filter also names `_id` or `_type`, which the ordinary candidate planner selects ' +
          'more tightly — it is planned there instead',
      )
    }
    const found = targetsOf(call, callParams)
    if (found === null) {
      return decline(
        'the `references(…)` target cannot be resolved before the base fetch — it must be a ' +
          'literal or a supplied query parameter, not a value read off the row being filtered',
      )
    }
    targets.push(...found)
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target)) continue
    seen.add(target)
    unique.push(target)
  }

  return {supported: true, targetIds: unique}
}

/* ------------------------------------------------------------------ *
 * The candidate fetch
 * ------------------------------------------------------------------ */

/**
 * The base-side half of §19.4 bullet 1, as GROQ.
 *
 * The slice is one row ABOVE the ceiling so an over-budget answer is
 * *detectable* rather than silently truncated — the same trick
 * `baseCandidateQuery` uses for the generic plans.
 */
export function incomingReferenceCandidateQuery(
  targetIds: readonly string[],
  limit: number,
): {query: string; params: Rec} {
  return {
    query: `*[references($${INCOMING_REFERENCE_TARGETS_PARAM})][0...${limit + 1}]{_id}`,
    params: {[INCOMING_REFERENCE_TARGETS_PARAM]: [...targetIds]},
  }
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    if (typeof entry === 'object' && entry !== null && typeof (entry as Rec)._id === 'string') {
      out.push((entry as Rec)._id as string)
    }
  }
  return out
}

/** Branch addresses whose CURRENT body references one of the targets (§19.4). */
export function branchReferringAddresses(
  overlay: OverlaySource,
  targetIds: readonly string[],
): string[] {
  const wanted = new Set(targetIds)
  const out: string[] = []
  for (const [address, document] of overlay.documents) {
    const references = extractReferences(document as unknown as SanityDocument)
    if (references.some((reference) => wanted.has(reference.targetId))) out.push(address)
  }
  return out
}

export interface IncomingReferencePlanRequest {
  query: string
  targetIds: readonly string[]
  overlay: OverlaySource
  baseFetch: (query: string, params: Rec) => Promise<unknown>
  limit?: number
}

/**
 * Build the exact-answer plan for one incoming-reference read.
 *
 * Throws when the base fetch fails or over-runs the ceiling; the caller turns
 * that into a recorded passthrough (or, in strict mode, a refusal), which is the
 * same treatment every other unanswerable read gets.
 */
export async function incomingReferenceReadPlan(
  request: IncomingReferencePlanRequest,
): Promise<StudioReadPlan> {
  const limit = request.limit ?? INCOMING_REFERENCE_MAX_CANDIDATES
  const built = incomingReferenceCandidateQuery(request.targetIds, limit)
  const answered = await request.baseFetch(built.query, built.params)
  const baseIds = idsOf(answered)

  if (baseIds.length > limit) {
    throw new Error(
      `the base dataset holds more than ${limit} documents referencing ` +
        `${request.targetIds.join(', ')}, which is above the candidate ceiling for an ` +
        'incoming-reference read (PRD §22.9). Answering over the truncated set would drop ' +
        'referring documents without saying so',
    )
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of [...baseIds, ...branchReferringAddresses(request.overlay, request.targetIds)]) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  ids.sort()

  const checksum = queryTextChecksum(request.query)
  const definition: OverlayQueryDefinition = defineOverlayQuery({
    id: `studio:refs:${checksum.slice(0, 16)}`,
    description:
      'Studio incoming-reference read (PRD §21.6, §19.4), planned at call time from the base ' +
      'reference hits unioned with the branch documents that reference the target.',
    query: request.query,
    queryChecksum: checksum,
    allowedCallers: ['studio', 'test'],
    perspectives: ['raw', 'published', 'drafts'],
    candidatePlan: {type: 'ids-literal', ids},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: ids.length + ID_PLAN_HEADROOM,
    maxReferenceDepth: STUDIO_MAX_REFERENCE_DEPTH,
    status: 'tier-a',
    notes:
      'The candidate set is the base `references()` answer unioned with every branch document ' +
      'whose current body references the target. groq-js re-evaluates the caller’s own ' +
      '`references()` predicate over the resolved candidates, so a locally removed reference ' +
      'drops out and a branch-created one appears — neither is post-processed.',
  })

  const baseRequests: readonly BaseCandidateRequest[] =
    planCandidateRequests(definition, {}).baseRequests

  return {definition, planParams: {}, baseRequests}
}
