import {createHash} from 'node:crypto'
import {evaluate, parse} from 'groq-js'
import {SimError} from './errors.js'
import {resolvePerspective} from './perspective.js'

/** GROQ functions groq-js 2.x does not implement; answered with a clear 400 instead of a crash. */
const UNSUPPORTED_FUNCTIONS = ['text::semanticSimilarity', 'documents::incomingGlobalDocumentReferenceCount', 'user::attributes']

export function parseGroq(query, params) {
  try {
    return parse(query, {params})
  } catch (error) {
    /* groq-js refuses `$param` slice endpoints (`[0...$__limit]`), which Studio's
     * list and search queries use. Substitute integer values and retry once. */
    const substituted = substituteSliceParameters(query, params)
    if (substituted !== query) {
      try {
        return parse(substituted, {params})
      } catch {
        /* fall through to the original error */
      }
    }
    const position = typeof error.position === 'number' ? error.position : 0
    throw new SimError(400, 'queryParseError', error.message, {
      query,
      start: position,
      end: position + 1,
    })
  }
}

/**
 * Evaluate `query` against `dataset` as seen through `perspective`.
 * Returns the Content Lake response body (minus `query` when `returnQuery` is false).
 */
export async function runQuery({dataset, query, params = {}, perspective, projectId, returnQuery = true}) {
  for (const name of UNSUPPORTED_FUNCTIONS) {
    if (query.includes(name)) {
      throw new SimError(400, 'queryParseError', `${name}() is not supported by sanity-sim (groq-js does not implement it)`, {query})
    }
  }
  const parsed = parseGroq(query, params)
  const documents = resolvePerspective(dataset.documents(), perspective)
  const started = performance.now()
  const options = {dataset: documents, sanity: {projectId, dataset: dataset.name}}
  let result
  let approximations = []
  try {
    const prepared = await resolveTextQueries(parsed, params, documents, options)
    approximations = prepared.approximations
    const value = await evaluate(prepared.tree, {...options, params: {...params, ...prepared.params}})
    result = await value.get()
  } catch (error) {
    if (error instanceof SimError) throw error
    throw new SimError(400, 'queryExecutionError', String(error?.message ?? error), {query})
  }
  const body = {ms: Math.round(performance.now() - started), result, syncTags: [syncTagFor(dataset.name)]}
  if (returnQuery) body.query = query
  if (approximations.length > 0) body.simApproximations = approximations
  return body
}

/* ------------------------------------------------------------------ text::query
 *
 * groq-js parses `text::query(...)` but cannot evaluate it: it is Content
 * Lake's hosted full-text index. Studio 6 uses it everywhere (the groq2024
 * search strategy), including every document list:
 *
 *   *[_type in $__types && ([@, _id] match text::query($__query) || ...)]
 *
 * with `$__query = "*"` for an unfiltered list and `"term*"` for a typed search.
 * Each `<expr> match text::query(<string>)` is resolved ahead of evaluation: the
 * left side is evaluated per document, its strings matched with groq-js's own
 * `match` (prefix tokens, case-insensitive), and the node replaced by
 * `_id in $<ids>`. `*` is exact; any other term is an approximation (no
 * stemming or hosted relevance) and is reported in `simApproximations`. */

const MATCH_PROBE = parse('$__haystack match $__pattern')
const PARAMETERISED_SLICE = /\[\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*(\.\.\.|\.\.)\s*(-?\d+|\$[A-Za-z_][A-Za-z0-9_]*)\s*\]/g

export function substituteSliceParameters(source, params) {
  return source.replace(PARAMETERISED_SLICE, (whole, left, dots, right) => {
    const resolve = (side) => {
      if (!side.startsWith('$')) return side
      const value = params?.[side.slice(1)]
      return Number.isSafeInteger(value) ? String(value) : null
    }
    const a = resolve(left)
    const b = resolve(right)
    return a === null || b === null ? whole : `[${a}${dots}${b}]`
  })
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTextQueryCall = (node) => isRecord(node) && node.type === 'FuncCall' && node.namespace === 'text' && node.name === 'query'

function collect(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, found)
  } else if (isRecord(node)) {
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) collect(value, predicate, found)
  }
  return found
}

function replaceNodes(node, replacements) {
  if (Array.isArray(node)) return node.map((item) => replaceNodes(item, replacements))
  if (!isRecord(node)) return node
  if (replacements.has(node)) return replacements.get(node)
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, replaceNodes(value, replacements)]))
}

function searchableStrings(value, out = [], depth = 0) {
  if (out.length >= 5000 || depth > 12) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) searchableStrings(item, out, depth + 1)
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) if (!key.startsWith('_')) searchableStrings(item, out, depth + 1)
  }
  return out
}

async function resolveTextQueries(tree, params, documents, options) {
  const matches = collect(tree, (node) => node.type === 'OpCall' && node.op === 'match' && isTextQueryCall(node.right))
  if (matches.length === 0) {
    if (collect(tree, isTextQueryCall).length > 0) {
      throw new SimError(400, 'queryExecutionError', 'sanity-sim supports text::query() only as the right-hand side of `match`')
    }
    return {tree, params: {}, approximations: []}
  }
  const replacements = new Map()
  const generated = {}
  const approximations = []
  let index = 0
  for (const node of matches) {
    const arg = node.right.args?.[0]
    const pattern = arg?.type === 'Parameter' ? params[arg.name] : arg?.type === 'Value' ? arg.value : undefined
    if (typeof pattern !== 'string') {
      throw new SimError(400, 'queryExecutionError', 'sanity-sim supports text::query() only with a constant or parameter search term')
    }
    const everything = pattern.trim() === '*' || pattern.trim() === ''
    const ids = []
    for (const document of documents) {
      if (everything) {
        ids.push(document._id)
        continue
      }
      const left = await (await evaluate(node.left, {...options, params, root: document})).get()
      const haystack = searchableStrings(left)
      if (haystack.length === 0) continue
      const matched = await (await evaluate(MATCH_PROBE, {params: {__haystack: haystack, __pattern: pattern}})).get()
      if (matched === true) ids.push(document._id)
    }
    const name = `__simTextMatch${(index += 1)}`
    generated[name] = ids
    replacements.set(node, {type: 'OpCall', op: 'in', left: {type: 'AccessAttribute', name: '_id'}, right: {type: 'Parameter', name}})
    if (!everything && !approximations.some((entry) => entry.term === pattern)) {
      approximations.push({function: 'text::query', term: pattern, matched: ids.length, reason: 'local prefix-token matching; no hosted stemming or relevance'})
    }
  }
  return {tree: replaceNodes(tree, replacements), params: generated, approximations}
}

/**
 * One coarse sync tag per dataset. Every write invalidates every query on the
 * dataset — over-invalidation, never under-invalidation, which is the safe
 * direction for `next-sanity`'s cache.
 */
export function syncTagFor(datasetName) {
  return 's1:' + createHash('sha1').update(`sanity-sim:${datasetName}`).digest('base64url').slice(0, 6)
}

/** Ids matched by a GROQ query (query-based patch/delete). Evaluated raw. */
export async function idsForQuery(dataset, query, params, projectId) {
  const tree = parseGroq(query, params)
  const value = await evaluate(tree, {dataset: dataset.documents(), params, sanity: {projectId, dataset: dataset.name}})
  const result = await value.get()
  const list = Array.isArray(result) ? result : result ? [result] : []
  return list.map((item) => (typeof item === 'string' ? item : item?._id)).filter(Boolean)
}

/**
 * A compiled listener filter: does a single document match `*[<filter>]`?
 * Content Lake's listen query is a filter-only expression; projections are ignored.
 */
export function compileFilter(query, params) {
  const tree = parseGroq(query, params)
  return async (doc) => {
    if (doc === null) return false
    const value = await evaluate(tree, {dataset: [doc], params})
    const result = await value.get()
    return Array.isArray(result) ? result.length > 0 : Boolean(result)
  }
}

/** `$name=<json>` query-string parameters. Content Lake refuses non-JSON values. */
export function paramsFromSearch(searchParams) {
  const params = {}
  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith('$')) continue
    try {
      params[key.slice(1)] = JSON.parse(value)
    } catch {
      throw new SimError(400, 'queryParseError', `Parameter "${key}" must be JSON-encoded (got ${JSON.stringify(value)})`)
    }
  }
  return params
}
