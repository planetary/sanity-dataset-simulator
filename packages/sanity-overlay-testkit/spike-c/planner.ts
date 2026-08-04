// SPIKE C candidate planner prototypes (PRD §36.3, §22.6).
// System under test for the §35.10 overlay-parity method: the planner sees a
// BOUNDED candidate set; the oracle sees the full virtual dataset. Equality
// proves candidate completeness.
import type {FixtureDocument} from '../src/fixtures'
import {runGroq} from '../src/groq'
import {applyOverlay, type SpikeOverlay} from './overlay'

export type CandidatePlan =
  | {type: 'ids'; idsFromParams: string[]}
  | {type: 'ids-literal'; ids: string[]}
  /**
   * PRD §22.7 "exact slug-filtered pages plus all overlaid page documents":
   * `filter` is the GROQ a real implementation issues to Sanity, so only the
   * documents it RETURNS enter the candidate set. Exact only when the filter
   * reads local fields of `types` — a predicate that traverses a reference can
   * gain matches when the TARGET is edited, and needs §22.6 step 10 instead.
   */
  | {type: 'base-filter'; types: string[]; filter: string}
  | {type: 'slug'; docType: string}
  | {type: 'types'; types: string[]}
  | {type: 'top-k'; docType: string; orderField: string; sliceEnd: number}

export interface SpikeQueryDefinition {
  id: string
  query: string
  candidatePlan: CandidatePlan | {type: 'none'}
  status: 'tier-a' | 'tier-b' | 'unsupported'
  systemTimestampPolicy?: 'preserve-base' | 'preview-diverges' | 'unsupported'
  notes?: string
}

export interface SpikeDiagnostics {
  queryId: string
  candidateCount: number
  fullDatasetCount: number
  referenceExpansions: number
  durationMs: number
}

export class UnsupportedGroqError extends Error {
  code = 'UNSUPPORTED_GROQ' as const
  constructor(public queryId: string, reason: string) {
    super(`UNSUPPORTED_GROQ (${queryId}): ${reason}`)
  }
}

/** Collect every {_ref} in a document (spike-grade reference extraction). */
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) collectRefs(v, into)
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o._ref === 'string') into.add(o._ref)
    for (const v of Object.values(o)) collectRefs(v, into)
  }
}

/** Virtual-resolve one logical id against base + overlay. */
function resolveVirtual(
  id: string,
  baseById: Map<string, FixtureDocument>,
  overlay: SpikeOverlay,
): FixtureDocument | undefined {
  if (overlay.tombstones.has(id)) return undefined
  return overlay.documents.get(id) ?? baseById.get(id)
}

export async function evaluateRegistered<T = unknown>(
  def: SpikeQueryDefinition,
  base: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown> = {},
  maxReferenceDepth = 3,
): Promise<{result: T; diagnostics: SpikeDiagnostics}> {
  const started = performance.now()
  if (def.status === 'unsupported' || def.candidatePlan.type === 'none') {
    throw new UnsupportedGroqError(def.id, 'no finite exact candidate plan is registered')
  }
  const plan = def.candidatePlan
  const baseById = new Map(base.map((d) => [d._id, d]))
  const candidates = new Map<string, FixtureDocument>()
  const add = (id: string) => {
    const d = resolveVirtual(id, baseById, overlay)
    if (d) candidates.set(d._id, d)
  }

  if (plan.type === 'ids' || plan.type === 'ids-literal') {
    const ids = plan.type === 'ids' ? plan.idsFromParams.map((p) => String(params[p])) : plan.ids
    for (const id of ids) add(id)
    // an overlay doc may have been created at a requested id — covered by add()
  } else if (plan.type === 'base-filter') {
    // Server-side filtered fetch (§22.6 step 5). Only the returned documents
    // are candidates: this is what makes the plan bounded rather than a scan.
    const matched = await runGroq<Array<{_id: string}>>(plan.filter, base, params)
    for (const d of matched) add(d._id)
    // Step 6: any branch record of the candidate types can newly match.
    for (const [id, d] of overlay.documents) {
      if (plan.types.includes(d._type) || plan.types.includes(baseById.get(id)?._type ?? '')) {
        add(id)
      }
    }
  } else if (plan.type === 'slug' || plan.type === 'types') {
    const types = plan.type === 'slug' ? [plan.docType] : plan.types
    for (const d of base) if (types.includes(d._type)) add(d._id)
    for (const [id, d] of overlay.documents) if (types.includes(d._type)) add(id)
  } else if (plan.type === 'top-k') {
    // §22.6 bounded top-K. `affected` is every id whose membership or order in
    // the candidate type can differ from base — including a branch record that
    // moves a document OUT of the type, which the base `_type` reveals and the
    // overlay `_type` hides.
    const affected = new Set<string>()
    for (const [id, d] of overlay.documents) {
      if (d._type === plan.docType || baseById.get(id)?._type === plan.docType) affected.add(id)
    }
    for (const id of overlay.tombstones) {
      if (baseById.get(id)?._type === plan.docType) affected.add(id)
    }
    // Fetch the top K of the UNTOUCHED base order, then union the affected
    // records: an untouched base document with K untouched documents ordered
    // above it keeps them all above it after resolution, so it cannot enter the
    // requested slice. That makes `sliceEnd + affected.size` exact — fetching
    // sliceEnd + affected and THEN adding affected on top over-fetches.
    const baseTop = base
      .filter((d) => d._type === plan.docType && !affected.has(d._id))
      .sort((a, b) => String(b[plan.orderField]).localeCompare(String(a[plan.orderField])))
      .slice(0, plan.sliceEnd)
    for (const d of baseTop) add(d._id)
    for (const id of affected) add(id)
  }

  // Reference expansion (dereference support): virtual-resolve ref targets.
  let expansions = 0
  let frontier = [...candidates.values()]
  for (let depth = 0; depth < maxReferenceDepth && frontier.length > 0; depth++) {
    const refs = new Set<string>()
    for (const d of frontier) collectRefs(d, refs)
    const next: FixtureDocument[] = []
    for (const id of refs) {
      if (candidates.has(id)) continue
      const d = resolveVirtual(id, baseById, overlay)
      if (d) {
        candidates.set(d._id, d)
        next.push(d)
        expansions++
      }
    }
    frontier = next
  }

  // Candidate sets are unordered, but GROQ document order is NOT: an unordered
  // `*[...][0]` returns the first document in DATASET order. The candidate set
  // must therefore be presented in the same order `applyOverlay` produces —
  // base order first, then branch-created documents — or a plan that happens to
  // discover matches in a different order silently returns a different document.
  const baseIndex = new Map(base.map((d, i) => [d._id, i]))
  const overlayIndex = new Map([...overlay.documents.keys()].map((id, i) => [id, i]))
  const dataset = [...candidates.values()].sort((a, b) => {
    const ai = baseIndex.get(a._id)
    const bi = baseIndex.get(b._id)
    if (ai !== undefined && bi !== undefined) return ai - bi
    if (ai !== undefined) return -1
    if (bi !== undefined) return 1
    return (overlayIndex.get(a._id) ?? 0) - (overlayIndex.get(b._id) ?? 0)
  })
  const result = await runGroq<T>(def.query, dataset, params)
  return {
    result,
    diagnostics: {
      queryId: def.id,
      candidateCount: dataset.length,
      fullDatasetCount: applyOverlay(base, overlay).length,
      referenceExpansions: expansions,
      durationMs: performance.now() - started,
    },
  }
}

/** Oracle side: original query over the FULL resolved virtual dataset. */
export async function evaluateOracle<T = unknown>(
  def: SpikeQueryDefinition,
  base: FixtureDocument[],
  overlay: SpikeOverlay,
  params: Record<string, unknown> = {},
): Promise<T> {
  return runGroq<T>(def.query, applyOverlay(base, overlay), params)
}
