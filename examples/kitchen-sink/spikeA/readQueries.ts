// SPIKE A — which GROQ the read facade answers EXACTLY, and what it refuses.
//
// THE JUDGEMENT CALL, WRITTEN DOWN
// ────────────────────────────────
// PRD §5.5 requires "no silent query approximation" and §22.2 requires "never
// silently fall back to patching an already filtered or sliced result". Taken
// alone those say: fail every query you cannot evaluate. But Studio issues its
// own queries constantly — structure lists, previews, reference search — and
// failing them all produces an editor that cannot open a pane. That is not a
// safer failure, it is a different one.
//
// §22.5 is where the PRD resolves it:
//
//     [MUST]   Log unregistered queries.
//     [MUST]   Reject unregistered queries in strict preview mode.
//     [SHOULD] Allow a local development warning mode during migration.
//
// So the rule this module enforces is **provable exactness or an explicit
// refusal, never an approximation presented as an answer**:
//
//   supported  — the result set is a pure function of a candidate set the read
//                layer can prove complete, and the only work left is a predicate
//                and a slice. Those get overlay-resolved answers.
//   refused    — everything else, WITH A REASON. The caller logs it, counts it,
//                and (in warning mode) passes the query through to base
//                untouched, having recorded that it did so. Strict mode turns
//                the same refusal into an error.
//
// The supported set is exactly the PRD's `[M-LOCAL]` slice (§1.3 "§22 is
// `[M-LOCAL]` for ID and slug queries", roadmap §5.3): document by ID, documents
// by ID list, document by slug.
//
// WHY A SHAPE RECOGNISER AND NOT `groq-js`
// A projection or an `order()` needs a real evaluator over a real candidate set —
// that is the query package's job (PRD §22.6 planner, §22.7 evaluator). Trying it
// here would mean guessing at a candidate set, which is the one thing §22.2
// forbids. Refusing is the honest answer, and refusing *with a reason a human can
// read* is what makes the gap visible instead of silent.
//
// Everything here is pure: no DOM, no network, no clock. It is unit-tested by
// `packages/sanity-overlay-testkit/test/spike-a-read-queries.test.ts`.

type Rec = Record<string, unknown>

export type ReadPlanKind = 'by-id' | 'by-ids' | 'by-slug'

export interface ReadPlan {
  kind: ReadPlanKind
  /** The document IDs the shape names. Empty for a slug lookup. */
  ids: string[]
  /** `_type` constraint. Empty means "any type" — an unconstrained slug lookup. */
  types: string[]
  /** The slug value a `by-slug` plan matches. */
  slug?: string
  /** `[0]` was written: the answer is one document or `null`, not an array. */
  single: boolean
  /** Exclusive end of a written `[0...n]` slice. */
  limit?: number
}

export type ReadQueryClassification =
  | {supported: true; plan: ReadPlan}
  | {supported: false; reason: string}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(reason: string): ReadQueryClassification {
  return {supported: false, reason}
}

/**
 * The shapes this layer can answer, spelled out for a refusal message.
 *
 * Kept as one string so the reason a user sees names the alternative rather than
 * only the problem — "unsupported" with no exit is a dead end.
 */
export const SUPPORTED_READ_SHAPES =
  '*[_id == $id][0] · *[_id in $ids] · *[_type == "t" && slug.current == $slug][0]'

/* ------------------------------------------------------------------ *
 * Lexical helpers
 * ------------------------------------------------------------------ */

/**
 * Collapse the whitespace `defineQuery` and Studio's own template literals leave
 * behind, so one recogniser covers every indentation a caller might use.
 *
 * String literals are left alone: a slug containing a double space would
 * otherwise be silently rewritten, and this function's answer feeds a value
 * comparison.
 */
function normalizeQuery(query: string): string {
  let out = ''
  let quote: string | null = null
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index] as string
    if (quote !== null) {
      out += char
      if (char === quote && query[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      continue
    }
    if (/\s/.test(char)) {
      if (!out.endsWith(' ')) out += ' '
      continue
    }
    out += char
  }
  return out.trim()
}

const STRING_LITERAL = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/

/** A quoted GROQ string literal's value, or `undefined` when it is not one. */
function stringLiteral(token: string): string | undefined {
  const match = STRING_LITERAL.exec(token.trim())
  if (match === null) return undefined
  return (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1')
}

/** A `$name` reference's parameter name, or `undefined`. */
function parameterName(token: string): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(token.trim())
  return match === null ? undefined : (match[1] as string)
}

/**
 * Resolve one operand to a string: a literal, or a `$param` looked up in `params`.
 *
 * A missing or non-string parameter is a refusal, not a `null` match. The query
 * *shape* was recognised; what failed is that the call did not supply a value
 * this layer can resolve — and answering it as "matches nothing" would be an
 * approximation with a straight face.
 */
function resolveStringOperand(
  token: string,
  params: unknown,
): {value: string} | {refusal: string} {
  const literal = stringLiteral(token)
  if (literal !== undefined) return {value: literal}

  const name = parameterName(token)
  if (name === undefined) {
    return {refusal: `unsupported query shape: ${token} is neither a string literal nor a parameter`}
  }
  const value = isRec(params) ? params[name] : undefined
  if (typeof value !== 'string') {
    return {refusal: `parameter $${name} is not a string, so the query cannot be resolved exactly`}
  }
  return {value}
}

/** Resolve an operand to a string array: `$param`, or a literal `["a", "b"]`. */
function resolveStringArrayOperand(
  token: string,
  params: unknown,
): {value: string[]} | {refusal: string} {
  const trimmed = token.trim()

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner.length === 0) return {value: []}
    const parts = inner.split(',')
    const values: string[] = []
    for (const part of parts) {
      const literal = stringLiteral(part)
      if (literal === undefined) {
        return {refusal: `unsupported query shape: ${part.trim()} is not a string literal`}
      }
      values.push(literal)
    }
    return {value: values}
  }

  const name = parameterName(trimmed)
  if (name === undefined) {
    return {refusal: `unsupported query shape: ${trimmed} is neither an array literal nor a parameter`}
  }
  const value = isRec(params) ? params[name] : undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return {
      refusal: `parameter $${name} is not an array of strings, so the query cannot be resolved exactly`,
    }
  }
  return {value: value as string[]}
}

/* ------------------------------------------------------------------ *
 * The recogniser
 * ------------------------------------------------------------------ */

/**
 * Split `*[ FILTER ] TAIL` into its filter and whatever follows it.
 *
 * Scanned rather than matched with a regex: `*[_id in ["a"]][0]` contains nested
 * brackets, and a greedy `\[(.+)\]` swallows the slice into the filter while a
 * lazy one stops inside the array. Depth-and-quote-aware scanning is the only
 * correct reading, and getting it wrong is silent — the mis-parse still produces
 * *a* plan.
 */
function splitRoot(normalized: string): {filter: string; tail: string} | null {
  if (!normalized.startsWith('*[')) return null

  let depth = 0
  let quote: string | null = null
  for (let index = 1; index < normalized.length; index += 1) {
    const char = normalized[index] as string
    if (quote !== null) {
      if (char === quote && normalized[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[' || char === '(') depth += 1
    else if (char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) {
        return {
          filter: normalized.slice(2, index),
          tail: normalized.slice(index + 1).trim(),
        }
      }
    }
  }
  return null
}

interface Tail {
  single: boolean
  limit?: number
}

function parseTail(tail: string): Tail | {refusal: string} {
  if (tail.length === 0) return {single: false}
  if (!tail.startsWith('[') || !tail.endsWith(']')) {
    return {refusal: `unsupported query shape: trailing ${JSON.stringify(tail)}`}
  }
  const inner = tail.slice(1, -1).trim()
  if (inner === '0') return {single: true}
  const exclusive = /^0\s*\.\.\.\s*(\d+)$/.exec(inner)
  if (exclusive !== null) return {single: false, limit: Number(exclusive[1])}
  return {
    refusal:
      `unsupported slice ${tail}: only [0] and [0...n] can be answered without ` +
      'ordering the whole dataset first',
  }
}

/**
 * Split a filter on top-level `&&`.
 *
 * Depth-aware so `_type in ["a", "b"] && …` is not cut inside its array, and
 * quote-aware so a `&&` inside a string literal is not a separator.
 */
function splitConjuncts(filter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (let index = 0; index < filter.length; index += 1) {
    const char = filter[index] as string
    if (quote !== null) {
      current += char
      if (char === quote && filter[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '(') depth += 1
    if (char === ']' || char === ')') depth -= 1
    if (depth === 0 && char === '&' && filter[index + 1] === '&') {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

interface Comparison {
  field: string
  operator: '==' | 'in'
  operand: string
}

/** `field == operand` / `field in operand`, or `null` when it is something else. */
function parseComparison(conjunct: string): Comparison | null {
  const equality = /^([A-Za-z_][A-Za-z0-9_.]*)\s*==\s*(.+)$/.exec(conjunct)
  if (equality !== null) {
    return {field: equality[1] as string, operator: '==', operand: (equality[2] as string).trim()}
  }
  const membership = /^([A-Za-z_][A-Za-z0-9_.]*)\s+in\s+(.+)$/.exec(conjunct)
  if (membership !== null) {
    return {field: membership[1] as string, operator: 'in', operand: (membership[2] as string).trim()}
  }
  return null
}

/**
 * Classify a GROQ query against the `[M-LOCAL]` exact slice.
 *
 * Returns a plan the caller can resolve against the overlay, or a refusal with a
 * human-readable reason. It never returns a partial or best-effort plan: the
 * point of the whole module is that "supported" is a claim about exactness.
 */
export function classifyReadQuery(query: unknown, params?: unknown): ReadQueryClassification {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return refuse('unsupported query shape: not a GROQ string')
  }

  const normalized = normalizeQuery(query)

  /* A projection turns the answer into something only a GROQ evaluator can
   * produce (§22.2). Checked first, so the reason names the real obstacle rather
   * than a generic "shape" — the difference between a user who knows to register
   * the query with the query layer and one who does not. */
  if (normalized.includes('{')) {
    return refuse(
      'unsupported projection: evaluating a projection needs the GROQ evaluator, and ' +
        'approximating one would be a silently patched result (PRD §22.2)',
    )
  }

  const root = splitRoot(normalized)
  if (root === null) {
    return refuse(`unsupported query shape: only ${SUPPORTED_READ_SHAPES} are answered exactly`)
  }

  const tail = parseTail(root.tail)
  if ('refusal' in tail) return refuse(tail.refusal)

  const conjuncts = splitConjuncts(root.filter)
  if (conjuncts.length === 0 || conjuncts.length > 2) {
    return refuse(`unsupported query shape: only ${SUPPORTED_READ_SHAPES} are answered exactly`)
  }

  const comparisons: Comparison[] = []
  for (const conjunct of conjuncts) {
    const comparison = parseComparison(conjunct)
    if (comparison === null) {
      return refuse(
        `unsupported query shape: ${JSON.stringify(conjunct)} is not an == or in comparison`,
      )
    }
    comparisons.push(comparison)
  }

  const byField = new Map(comparisons.map((comparison) => [comparison.field, comparison]))
  if (byField.size !== comparisons.length) {
    return refuse('unsupported query shape: the same field is constrained twice')
  }

  const idComparison = byField.get('_id')
  const slugComparison = byField.get('slug.current')
  const typeComparison = byField.get('_type')

  /* ---- document(s) by _id ---- */
  if (idComparison !== undefined) {
    if (comparisons.length !== 1) {
      return refuse(
        'unsupported query shape: an _id filter combined with another constraint is not in the exact slice',
      )
    }
    if (idComparison.operator === '==') {
      const resolved = resolveStringOperand(idComparison.operand, params)
      if ('refusal' in resolved) return refuse(resolved.refusal)
      return {
        supported: true,
        plan: {
          kind: 'by-id',
          ids: [resolved.value],
          types: [],
          single: tail.single,
          ...(tail.limit === undefined ? {} : {limit: tail.limit}),
        },
      }
    }
    const resolved = resolveStringArrayOperand(idComparison.operand, params)
    if ('refusal' in resolved) return refuse(resolved.refusal)
    return {
      supported: true,
      plan: {
        kind: 'by-ids',
        ids: resolved.value,
        types: [],
        single: tail.single,
        ...(tail.limit === undefined ? {} : {limit: tail.limit}),
      },
    }
  }

  /* ---- document by slug ---- */
  if (slugComparison !== undefined) {
    if (slugComparison.operator !== '==') {
      return refuse('unsupported query shape: slug.current must be compared with ==')
    }
    if (comparisons.length === 2 && typeComparison === undefined) {
      return refuse(
        'unsupported query shape: a slug filter may only be combined with a _type constraint',
      )
    }

    const slug = resolveStringOperand(slugComparison.operand, params)
    if ('refusal' in slug) return refuse(slug.refusal)

    let types: string[] = []
    if (typeComparison !== undefined) {
      if (typeComparison.operator === '==') {
        const resolved = resolveStringOperand(typeComparison.operand, params)
        if ('refusal' in resolved) return refuse(resolved.refusal)
        types = [resolved.value]
      } else {
        const resolved = resolveStringArrayOperand(typeComparison.operand, params)
        if ('refusal' in resolved) return refuse(resolved.refusal)
        types = resolved.value
      }
    }

    return {
      supported: true,
      plan: {
        kind: 'by-slug',
        ids: [],
        types,
        slug: slug.value,
        single: tail.single,
        ...(tail.limit === undefined ? {} : {limit: tail.limit}),
      },
    }
  }

  return refuse(`unsupported query shape: only ${SUPPORTED_READ_SHAPES} are answered exactly`)
}

/* ------------------------------------------------------------------ *
 * Evaluating the plan over a resolved candidate set
 * ------------------------------------------------------------------ */

/** `slug.current`, only in the object form Sanity's `slug` type actually stores. */
function slugCurrentOf(document: Rec): unknown {
  const slug = document.slug
  return isRec(slug) ? slug.current : undefined
}

function matchesPlan(plan: ReadPlan, document: Rec): boolean {
  if (plan.kind === 'by-slug') {
    if (plan.types.length > 0 && !plan.types.includes(String(document._type))) return false
    return slugCurrentOf(document) === plan.slug
  }
  return typeof document._id === 'string' && plan.ids.includes(document._id)
}

/**
 * Apply the plan's own predicate and slice to an already **virtually resolved**
 * candidate set.
 *
 * The candidates must already be the overlay's answer — tombstoned documents
 * absent, branch-created documents present, edits applied. This function only
 * filters and slices, which is exactly the part that is safe to do outside a GROQ
 * evaluator once the candidate set is proven complete.
 *
 * ID order comes from the plan, not from the candidate list: `*[_id in $ids]`
 * has no defined order in hosted Sanity either, and answering in the order the
 * caller asked is the one choice that is stable across a base fetch and an
 * overlay resolution.
 */
export function applyReadPlan(plan: ReadPlan, documents: readonly Rec[]): unknown {
  const matched = documents.filter((document) => isRec(document) && matchesPlan(plan, document))

  let ordered = matched
  if (plan.kind !== 'by-slug') {
    const byId = new Map<string, Rec>()
    for (const document of matched) {
      const id = document._id
      if (typeof id === 'string' && !byId.has(id)) byId.set(id, document)
    }
    ordered = plan.ids
      .map((id) => byId.get(id))
      .filter((document): document is Rec => document !== undefined)
  }

  if (plan.single) return ordered[0] ?? null
  return plan.limit === undefined ? [...ordered] : ordered.slice(0, plan.limit)
}
