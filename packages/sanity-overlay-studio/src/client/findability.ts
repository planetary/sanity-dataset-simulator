/**
 * The findability query — making a list pane's own GROQ answerable (§5.5, §22.5).
 *
 * A structure list pane does NOT send `*[_type == "article"]`. It sends the
 * search service's *findability* query, built by `createSearchQuery` in
 * `sanity@6.8.0`:
 *
 *   *[_type in $__types && ([@, _id] match text::query($__query) ||
 *      references($__rawQuery)) && (_type == $type)] {
 *     _type, _id, _originalId, "orderings": [_updatedAt]
 *   } | order(orderings[0] desc) [0...$__limit]
 *
 * The hosted API accepts it. The pinned `groq-js@2.0.0` rejects two things in
 * it, and both were fatal — an unanswered list query means the pane falls
 * through to STAGING, so a branch-created document never appears and a
 * tombstoned one is never removed:
 *
 *   1. `[0...$__limit]` — "slicing must use constant numbers", thrown at PARSE.
 *      The whole query dies before planning.
 *   2. `text::query(...)` — parses, then throws "not implemented" during
 *      EVALUATION. It is Content Lake's hosted full-text index.
 *
 * WHAT THE PARAMETERS CARRY (from `createSearchQuery` + `prefixLast`):
 *
 *   unfiltered pane   the pane passes `searchQuery || ""`, and `prefixLast("")`
 *                     returns `"*"`.  -> `$__query = "*"`, `$__rawQuery = ""`
 *   typed term "nine" -> `$__query = "nine*"`, `$__rawQuery = "nine"`
 *   always            -> `$__limit = (limit ?? 1000) + 1`
 *
 * THE HONESTY LINE.
 *
 * For the unfiltered pane the predicate means *"match everything of these
 * types"*. Over a candidate set that already contains the resolved branch, that
 * is EXACT, and it is the case a list pane overwhelmingly uses. Returning
 * nothing was never the honest degradation; it was simply wrong.
 *
 * For a TYPED term there is no honest local answer, and this is measured rather
 * than assumed: under the pinned evaluator `[@, _id] match "nin*"` is `[]` even
 * for a document titled "nine lives", because `match` does not descend into the
 * document object on the left-hand side. Rewriting it anyway would answer a
 * strict SUBSET of the hosted result without saying so — the precise thing §5.5
 * forbids. So a typed term is REFUSED with a reason and the caller records a
 * passthrough. It is never answered empty.
 *
 * (`examples/kitchen-sink/spikeB-proxy/origin.mjs` resolves a typed term for
 * real, by evaluating each `match`'s left-hand side per document and probing it
 * with groq-js's own `match`. It can do that because in origin mode the corpus
 * IS the overlay and is in hand before evaluation. Here the corpus is a bounded
 * base fetch unioned with the branch, and it does not exist until the evaluator
 * asks for it — so the same trick would need a second, unbudgeted fetch. A
 * declared refusal is the honest answer until that is built.)
 */

import {parse as parseGroq} from 'groq-js'

type Rec = Record<string, unknown>

/** One declared departure from what the hosted API would have answered (§5.5). */
export interface OverlayApproximation {
  /** The GROQ construct that was approximated, e.g. `text::query`. */
  readonly function: string
  /** The search term, when the construct had one. */
  readonly term?: string
  /** Why an exact local answer was not possible. */
  readonly reason: string
}

export interface FindabilityRewrite {
  /** The GROQ the planner and the evaluator should use. */
  readonly query: string
  /** Empty when the answer is exact. Never silently non-empty. */
  readonly approximations: readonly OverlayApproximation[]
  /** Did the source change at all? Drives the ledger's `rewrittenQuery`. */
  readonly rewritten: boolean
}

export type FindabilityDerivation =
  | {readonly supported: true; readonly rewrite: FindabilityRewrite}
  | {readonly supported: false; readonly reason: string}

/**
 * `[0...$__limit]` and friends.
 *
 * `...` is listed before `..` because alternation is ordered: matching `..`
 * first would leave a stray `.` and produce `[0.10]`.
 */
const PARAMETERISED_SLICE =
  /\[\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*(\.\.\.|\.\.)\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*\]/g

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Replace `$param` slice endpoints with their integer values.
 *
 * Applied ONLY after groq-js has already refused the source, so a query the
 * parser accepts is never rewritten and this can introduce no behaviour of its
 * own.
 *
 * A `$param` that is not a safe integer is deliberately LEFT ALONE. The re-parse
 * then fails again and the caller gets the parse error — rather than a slice
 * whose bound was quietly dropped, which would turn a limited pane into an
 * unbounded dataset transfer.
 */
export function substituteSliceParameters(source: string, params: unknown): string {
  return source.replace(PARAMETERISED_SLICE, (whole, left: string, dots: string, right: string) => {
    const resolve = (side: string): string | null => {
      if (!side.startsWith('$')) return side
      const value = isRec(params) ? params[side.slice(1)] : undefined
      return Number.isSafeInteger(value) ? String(value) : null
    }
    const a = resolve(left)
    const b = resolve(right)
    if (a === null || b === null) return whole
    return `[${a}${dots}${b}]`
  })
}

/* ------------------------------------------------------------------ *
 * text::query
 * ------------------------------------------------------------------ */

function isTextQueryCall(node: unknown): node is Rec {
  return (
    isRec(node) && node.type === 'FuncCall' && node.namespace === 'text' && node.name === 'query'
  )
}

/** Every `text::query` node in the tree. */
function collectTextQueryCalls(node: unknown, found: Rec[] = []): Rec[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTextQueryCalls(item, found)
    return found
  }
  if (!isRec(node)) return found
  if (isTextQueryCall(node)) found.push(node)
  for (const value of Object.values(node)) collectTextQueryCalls(value, found)
  return found
}

/** Every `text::query` that sits as the right-hand side of a `match`. */
function collectMatchRightHandSides(node: unknown, found: Set<unknown> = new Set()): Set<unknown> {
  if (Array.isArray(node)) {
    for (const item of node) collectMatchRightHandSides(item, found)
    return found
  }
  if (!isRec(node)) return found
  if (node.type === 'OpCall' && node.op === 'match' && isTextQueryCall(node.right)) {
    found.add(node.right)
  }
  for (const value of Object.values(node)) collectMatchRightHandSides(value, found)
  return found
}

/** A constant string argument, or `null` when it cannot be known before evaluation. */
function constantString(node: unknown, params: unknown): string | null {
  if (!isRec(node)) return null
  if (node.type === 'Parameter') {
    const value = isRec(params) ? params[String(node.name)] : undefined
    return typeof value === 'string' ? value : null
  }
  if (node.type === 'Value' && typeof node.value === 'string') return node.value
  return null
}

const AS_A_VALUE_REASON =
  'this query uses `text::query()` somewhere other than the right-hand side of a `match` ' +
  "predicate. There it is a handle into Content Lake's hosted full-text index, which the " +
  'Studio does not have and will not fake'

const COMPUTED_TERM_REASON =
  'this query calls `text::query()` with a search term that cannot be known before ' +
  'evaluation. Studio passes the term as a parameter (`$__query`); a computed one would ' +
  'need the hosted index'

function typedTermReason(term: string): string {
  return (
    `this query calls \`text::query(${JSON.stringify(term)})\`, which Content Lake answers ` +
    'from its hosted full-text index — stemming, language analysis and relevance ranking — ' +
    'and which has no local equivalent. Under the pinned evaluator the same predicate ' +
    'matches nothing at all, because `match` does not descend into the document on its ' +
    'left-hand side, so answering locally would hand back a strict subset of the hosted ' +
    'result without saying so (PRD §5.5). The read is sent to the base dataset instead'
  )
}

/**
 * Replace every `text::query(<arg>)` with `<arg>`.
 *
 * A scanner rather than a regex because the argument may itself contain
 * parentheses or a string holding one. The result is re-parsed and re-walked by
 * the caller, so a scan that went wrong is caught rather than shipped.
 */
function stripTextQueryCalls(source: string): string {
  const NEEDLE = 'text::query('
  let out = ''
  let index = 0

  for (;;) {
    const at = source.indexOf(NEEDLE, index)
    if (at === -1) {
      out += source.slice(index)
      return out
    }
    out += source.slice(index, at)

    let depth = 1
    let cursor = at + NEEDLE.length
    const start = cursor
    let quote: string | null = null
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor]
      if (quote !== null) {
        if (ch === '\\') cursor += 1
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    /* Unbalanced: leave the rest verbatim. The caller's re-parse rejects it. */
    if (depth !== 0) {
      out += source.slice(at)
      return out
    }
    out += source.slice(start, cursor).trim()
    index = cursor + 1
  }
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Make one Studio-issued GROQ string answerable, or explain why it is not.
 *
 * Both rewrites are conservative and both are verified: the slice substitution
 * runs only after the parser has refused, and the `text::query` strip is
 * re-parsed and re-walked before it is returned.
 */
export function prepareFindabilityQuery(source: string, params: unknown): FindabilityDerivation {
  /* 1. Parse, with one narrowly-scoped retry for the parameterised slice. */
  let working = source
  let rewritten = false
  let tree: unknown
  try {
    tree = parseGroq(source)
  } catch (cause) {
    const substituted = substituteSliceParameters(source, params)
    if (substituted === source) {
      return {supported: false, reason: (cause as Error).message}
    }
    try {
      tree = parseGroq(substituted)
    } catch {
      /* The original error is the more informative one. */
      return {supported: false, reason: (cause as Error).message}
    }
    working = substituted
    rewritten = true
  }

  /* 2. `text::query`, if any. */
  const calls = collectTextQueryCalls(tree)
  if (calls.length === 0) {
    return {supported: true, rewrite: {query: working, approximations: [], rewritten}}
  }

  const asMatchRhs = collectMatchRightHandSides(tree)
  for (const call of calls) {
    if (!asMatchRhs.has(call)) return {supported: false, reason: AS_A_VALUE_REASON}
  }

  for (const call of calls) {
    const args = Array.isArray(call.args) ? call.args : []
    const term = constantString(args[0], params)
    if (term === null) return {supported: false, reason: COMPUTED_TERM_REASON}
    /*
     * `"*"` is `prefixLast("")` — "everything". Stripping the wrapper leaves
     * `<lhs> match "*"`, which the pinned evaluator answers true for every
     * document, so the predicate becomes "everything of these types". That is
     * exact, and it is not reported as an approximation.
     */
    if (term.trim() !== '*') return {supported: false, reason: typedTermReason(term)}
  }

  /* 3. Strip, then PROVE the strip was sound rather than assume it. */
  const stripped = stripTextQueryCalls(working)
  let strippedTree: unknown
  try {
    strippedTree = parseGroq(stripped)
  } catch (cause) {
    return {
      supported: false,
      reason:
        `\`text::query\` could not be rewritten into a locally answerable form: the result ` +
        `does not parse (${(cause as Error).message})`,
    }
  }
  if (collectTextQueryCalls(strippedTree).length > 0) {
    return {
      supported: false,
      reason: '`text::query` could not be fully rewritten out of this query',
    }
  }

  return {supported: true, rewrite: {query: stripped, approximations: [], rewritten: true}}
}
