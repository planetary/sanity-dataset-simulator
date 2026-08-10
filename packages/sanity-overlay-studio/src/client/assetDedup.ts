/**
 * `*[_type == "sanity.imageAsset" && sha1hash == $hash][0]` — the probe every
 * upload is gated on, answered from the branch (PRD §24, §22.6, §5.5).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES, OBSERVED LIVE ON 2026-08-09.
 *
 * A PNG dropped into `author-3.portrait` patched `_upload: {progress: 2}` into
 * the draft and stayed there forever — no asset, no error, no toast. The
 * uploader itself was fine: `client.assets.upload` answered in 4 ms from the
 * same page. What was not fine is what runs BEFORE it. From the installed
 * package, `sanity@6.8.0` `lib/useBundleDocuments-BYW8M9LS.js:13448`:
 *
 *     function uploadSanityAsset(client, assetType, file, options = {}) {
 *       …
 *       return hashFile(file).pipe(
 *         catchError(() => of(null)),
 *         mergeMap(hash => hash ? fetchExisting(client, `sanity.${assetType}Asset`, hash)
 *                               : of(null)),
 *         mergeMap(existing => existing ? of({type: 'complete', …})
 *                                       : client.observable.assets.upload(…)))
 *
 * and `:13584`:
 *
 *     function fetchExisting(client, type, hash) {
 *       return client.observable.fetch(
 *         '*[_type == $documentType && sha1hash == $hash][0]',
 *         {documentType: type, hash}, {tag: 'asset.find-duplicate'})
 *
 * **The bytes are never sent until that probe emits.** `catchError` guards
 * `hashFile` only; the probe's own liveness is load-bearing. `readPlan.ts`
 * refuses to plan it — `sanity.imageAsset` is a hosted system type — so it was
 * delegated to the base dataset, and a base that accepts the request and never
 * answers leaves the field saying "Uploading" for the life of the tab.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BRANCH CAN ANSWER IT, AND WHY THAT IS *EXACT*.
 *
 * Since §24.3, branch uploads commit synthetic `sanity.imageAsset` /
 * `sanity.fileAsset` documents INTO the overlay. The branch is enumerable, so
 * "does an asset with this sha1 exist here?" is answerable locally, with no
 * request, and the candidate set is provably complete for the branch.
 *
 * What the branch cannot see is a base asset with the same bytes. Delegating in
 * order to find one looks like the careful choice; it is not, and the reason is
 * that **the answer cannot change the reference**. Sanity asset ids are content
 * addressed — `image-<sha1>-<w>x<h>-<ext>`, `file-<sha1>-<ext>` — and §24.3
 * mints the identical id from the identical bytes. So:
 *
 *   probe finds the base asset  →  field gets `image-<sha1>-64x32-png`
 *   probe finds nothing         →  the bytes are stored in the branch, which
 *                                  mints `image-<sha1>-64x32-png`
 *
 * The same `_ref`, either way. The only difference is that in the second case
 * the BRANCH also holds the bytes — which is what §24 requires of a branch that
 * must be checkpointable and self-contained, and which the §24.1 delivery route
 * serves without consulting Sanity at all.
 *
 * So the trade is: one unbounded, unowned network dependency in the upload path,
 * against re-storing bytes that are hash-addressed and therefore deduplicated by
 * the store the moment they land. That is not a close call.
 *
 * It is still a DEPARTURE from what the hosted API would have returned — the
 * hosted answer is the base asset document, this answer is `null` — so it is
 * declared as an approximation and shows up in the §22.8 read ledger rather than
 * being quietly correct. §5.5 forbids silent approximation, not approximation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY.
 *
 * This module claims a query only when EVERY `*[…]` in it is filtered by both a
 * `_type ==` naming nothing but `sanity.*Asset` and a `sha1hash ==`. A query
 * that reaches an unconstrained `*`, or that filters assets by anything else, is
 * left alone: the generic planner's refusal is right for those, because the
 * branch really is a subset of the asset documents that exist.
 */

import {parse as parseGroq} from 'groq-js'

import type {BaseCandidateRequest} from 'sanity-overlay-query/baseSource'
import type {OverlaySource} from 'sanity-overlay-query/overlaySource'
import {planCandidateRequests} from 'sanity-overlay-query/planner'
import {defineOverlayQuery, queryTextChecksum} from 'sanity-overlay-query/registry'
import type {OverlayQueryDefinition} from 'sanity-overlay-query/types'
import type {OverlayApproximation} from './findability'
import {ID_PLAN_HEADROOM, STUDIO_MAX_REFERENCE_DEPTH, type StudioReadPlan} from './readPlan'

type Rec = Record<string, unknown>

/** The two asset planes §24.2 stores. Anything else is not this shape. */
const ASSET_TYPE = /^sanity\.(image|file)Asset$/

/** The field Sanity's dedup probe filters on. */
const HASH_FIELD = 'sha1hash'

/* ------------------------------------------------------------------ *
 * AST reading — deliberately the same vocabulary as `incomingReferences.ts`
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

/** Every string a `==`/`in` operand denotes, or `null` if it denotes none. */
function stringsOf(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as string[]
  }
  return null
}

/** Mirrors `readPlan.ts` / `incomingReferences.ts`: no local answer exists. */
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

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

export interface AssetDedupTarget {
  /** `sanity.imageAsset` or `sanity.fileAsset`. */
  readonly type: string
  /** The sha1 the caller is probing for. */
  readonly hash: string
}

export type AssetDedupDerivation =
  | {readonly supported: true; readonly targets: readonly AssetDedupTarget[]}
  | {readonly supported: false; readonly reason: string}

function decline(reason: string): AssetDedupDerivation {
  return {supported: false, reason}
}

/**
 * Read a query as an asset-dedup probe, or say why it is not one.
 *
 * Values may arrive as literals or as supplied parameters — Sanity's own call
 * binds BOTH sides to parameters (`$documentType`, `$hash`), which is precisely
 * why the generic planner's per-call derivation refuses it: the identical GROQ
 * is plannable for `article` and refused for `sanity.imageAsset`.
 */
export function deriveAssetDedupTargets(query: unknown, params: unknown): AssetDedupDerivation {
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
  const filtered = new Set<unknown>()
  walk(tree, (node) => {
    if (node.type !== 'Filter') return
    if (!isNode(node.base) || node.base.type !== 'Everything') return
    filters.push(node.expr)
    filtered.add(node.base)
  })
  let unconstrained = false
  walk(tree, (node) => {
    if (node.type === 'Everything' && !filtered.has(node)) unconstrained = true
  })
  if (unconstrained) return decline('the query reaches an unconstrained `*`')
  if (filters.length === 0) return decline('the query selects no documents')

  const targets: AssetDedupTarget[] = []
  for (const expr of filters) {
    let types: string[] | null = null
    let hashes: string[] | null = null

    for (const conjunct of conjunctsOf(expr)) {
      if (conjunct.type !== 'OpCall') continue
      if (conjunct.op !== '==' && conjunct.op !== 'in') continue
      const name = attributeName(conjunct.left)
      if (name !== '_type' && name !== HASH_FIELD) continue
      const resolved = operandValue(conjunct.right, callParams)
      if (resolved === null) continue
      const values = stringsOf(resolved.value)
      if (values === null) continue
      if (name === '_type') types = types === null ? values : [...types, ...values]
      else hashes = hashes === null ? values : [...hashes, ...values]
    }

    if (types === null || hashes === null) {
      return decline(
        'not every `*[…]` in this query filters by both `_type` and `sha1hash`, so it is not an ' +
          'asset-deduplication probe',
      )
    }
    if (!types.every((type) => ASSET_TYPE.test(type))) {
      return decline(
        `the \`_type\` constraint names ${JSON.stringify(types)}, which is not exclusively ` +
          'sanity.imageAsset / sanity.fileAsset — the branch is not a complete candidate set for it',
      )
    }
    for (const type of types) {
      for (const hash of hashes) targets.push({type, hash})
    }
  }

  return {supported: true, targets}
}

/* ------------------------------------------------------------------ *
 * The branch answer
 * ------------------------------------------------------------------ */

/**
 * Branch addresses holding an asset document that matches one of the targets.
 *
 * Reads the CURRENT branch body, so an asset the branch has replaced or whose
 * hash the branch changed is judged on what the branch says now — the same rule
 * §19.4 applies to references, for the same reason.
 */
export function branchAssetAddresses(
  overlay: OverlaySource,
  targets: readonly AssetDedupTarget[],
): string[] {
  const wanted = new Set(targets.map((target) => `${target.type} ${target.hash}`))
  const out: string[] = []
  for (const [address, document] of overlay.documents) {
    const record = document as unknown as Rec
    const type = record._type
    const hash = record[HASH_FIELD]
    if (typeof type !== 'string' || typeof hash !== 'string') continue
    if (!wanted.has(`${type} ${hash}`)) continue
    out.push(address)
  }
  out.sort()
  return out
}

/** Why the read ledger records this answer as inexact, in the ledger's own shape. */
export function assetDedupApproximation(
  targets: readonly AssetDedupTarget[],
): OverlayApproximation {
  return {
    function: 'asset.find-duplicate',
    term: targets.map((target) => `${target.type}:${target.hash}`).join(', '),
    reason:
      'answered from the branch alone. The base dataset is NOT consulted, because doing so puts ' +
      'an unbounded request in front of every upload and a base that never answers leaves the ' +
      'image field saying "Uploading" forever (PRD §5.5). A base asset with these bytes is ' +
      'therefore reported as absent and the bytes are stored in the branch instead — which ' +
      'yields the SAME `asset._ref`, since asset ids are content-addressed from the sha1.',
  }
}

export interface AssetDedupPlanRequest {
  readonly query: string
  readonly targets: readonly AssetDedupTarget[]
  readonly overlay: OverlaySource
}

/**
 * Build the plan for one dedup probe. Synchronous and request-free by design:
 * the whole point is that nothing in the upload path waits on a network.
 */
export function assetDedupReadPlan(request: AssetDedupPlanRequest): StudioReadPlan {
  const ids = branchAssetAddresses(request.overlay, request.targets)
  const checksum = queryTextChecksum(request.query)

  const definition: OverlayQueryDefinition = defineOverlayQuery({
    id: `studio:asset-dedup:${checksum.slice(0, 16)}`,
    description:
      'Sanity’s asset-deduplication probe (`asset.find-duplicate`), answered from the branch. ' +
      'The candidate set is the branch asset documents whose sha1hash the caller asked for; ' +
      'nothing is fetched from the base dataset.',
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
      'Bounded by construction: the candidate set is enumerated from the branch, so the probe ' +
      'costs no request and cannot stall. groq-js re-evaluates the caller’s own filter over the ' +
      'candidates, so an empty branch answers `null` exactly as the caller’s `[0]` expects.',
  })

  const baseRequests: readonly BaseCandidateRequest[] =
    planCandidateRequests(definition, {}).baseRequests

  return {
    definition,
    planParams: {},
    baseRequests,
    /* The whole point. Even an `ids-literal` plan whose ids all came from the
     * branch would otherwise re-fetch those ids from staging to build the
     * candidate pool — putting the unbounded request back in front of the
     * upload that this module exists to get it out of. */
    branchOnly: true,
    approximations: [assetDedupApproximation(request.targets)],
  }
}
