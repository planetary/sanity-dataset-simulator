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
  } else if (plan.type === 'slug' || plan.type === 'types') {
    const types = plan.type === 'slug' ? [plan.docType] : plan.types
    for (const d of base) if (types.includes(d._type)) add(d._id)
    for (const [id, d] of overlay.documents) if (types.includes(d._type)) add(id)
  } else if (plan.type === 'top-k') {
    // §22.6 bounded top-K: baseFetchCount = requestedEnd + affectedCount
    const affected = new Set<string>()
    for (const [id, d] of overlay.documents) if (d._type === plan.docType) affected.add(id)
    for (const id of overlay.tombstones) {
      if (baseById.get(id)?._type === plan.docType) affected.add(id)
    }
    const baseFetchCount = plan.sliceEnd + affected.size
    const baseTop = base
      .filter((d) => d._type === plan.docType)
      .sort((a, b) => String(b[plan.orderField]).localeCompare(String(a[plan.orderField])))
      .slice(0, baseFetchCount)
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

  const dataset = [...candidates.values()]
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
