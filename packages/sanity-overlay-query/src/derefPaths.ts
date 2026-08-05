/**
 * Dereference-path analysis — PRD §22.6 step 8, "Analyze dereference paths".
 *
 * Why this exists rather than "follow every `_ref`":
 *
 * Expanding every reference in every candidate makes an ID lookup that
 * dereferences NOTHING transfer its author, that author's favourite article,
 * that article's author, and so on to the depth limit. The Spike C evidence
 * (`boundedness-2026-08-04.md` §5) records reference expansion as the one
 * mechanism its boundedness proof did not police, precisely because it was
 * unanalysed. Reading the query first turns that into a bound: a query with no
 * `->` performs no expansion at all.
 *
 * The analysis is deliberately CONSERVATIVE. It reports the attribute names a
 * `->` is applied to, and when it cannot resolve one it reports
 * `allAttributes`, which makes the caller follow every reference. Over-
 * approximating costs candidates; under-approximating would lose documents the
 * answer depends on, so the failure direction is chosen on purpose.
 */

interface AstNode {
  readonly type?: string
  readonly name?: string
  readonly base?: unknown
  readonly [key: string]: unknown
}

export interface DerefPaths {
  /** Attribute names a `->` is applied to. */
  readonly attributes: ReadonlySet<string>
  /** True when some `->` could not be traced to an attribute: follow everything. */
  readonly allAttributes: boolean
  /** False when the query contains no `->` at all: expand nothing. */
  readonly dereferences: boolean
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The attribute name a value expression ultimately reads, given the attribute
 * context established by an enclosing traversal (`articles[]->` puts `This`
 * inside a `Map` whose base is `articles`).
 */
function attributeOf(node: unknown, context: string | undefined): string | undefined {
  if (!isNode(node)) return undefined
  switch (node.type) {
    case 'AccessAttribute':
      return typeof node.name === 'string' ? node.name : undefined
    case 'This':
      return context
    case 'ArrayCoerce':
    case 'Filter':
    case 'AccessElement':
    case 'Slice':
    case 'Map':
    case 'Projection':
    case 'FlatMap':
      return attributeOf(node.base, context)
    default:
      return undefined
  }
}

/** Walk a parsed GROQ tree and collect the attributes `->` is applied to. */
export function analyzeDerefPaths(tree: unknown): DerefPaths {
  const attributes = new Set<string>()
  let allAttributes = false
  let dereferences = false

  const walk = (node: unknown, context: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, context)
      return
    }
    if (!isNode(node)) return

    if (node.type === 'Deref') {
      dereferences = true
      const attribute = attributeOf(node.base, context)
      if (attribute === undefined) allAttributes = true
      else attributes.add(attribute)
      walk(node.base, context)
      return
    }

    // Entering the body of a traversal rebinds `This` to the traversal's base.
    const inner = 'base' in node ? attributeOf(node.base, context) : context
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'name') continue
      walk(value, key === 'base' ? context : inner)
    }
  }

  walk(tree, undefined)
  return {attributes, allAttributes, dereferences}
}

/**
 * Collect the reference targets of one document that the query can actually
 * dereference. Returns nothing when the query contains no `->`.
 */
export function collectReferenceTargets(
  value: unknown,
  paths: DerefPaths,
  into: Set<string>,
  inDerefAttribute = false,
): void {
  if (!paths.dereferences) return
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceTargets(item, paths, into, inDerefAttribute)
    return
  }
  if (typeof value !== 'object' || value === null) return

  const object = value as Record<string, unknown>
  if ((inDerefAttribute || paths.allAttributes) && typeof object._ref === 'string') {
    into.add(object._ref)
  }
  for (const [key, child] of Object.entries(object)) {
    collectReferenceTargets(
      child,
      paths,
      into,
      inDerefAttribute || paths.allAttributes || paths.attributes.has(key),
    )
  }
}
