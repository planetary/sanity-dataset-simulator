// SPIKE C code (PRD §36.3). Prototype-quality by design: proves candidate
// planning is exact, then Phase 2/6 rebuild it under the real test regime.
// Overlay model is the simplified published-perspective view: materialized
// documents + tombstones (full merge semantics are Phase 2, PRD §17).
import type {FixtureDocument} from '../src/fixtures'

export interface SpikeOverlay {
  /** logicalId -> complete materialized branch document (created or modified) */
  documents: Map<string, FixtureDocument>
  /** logicalIds whose base document is suppressed */
  tombstones: Set<string>
}

export const emptyOverlay = (): SpikeOverlay => ({documents: new Map(), tombstones: new Set()})

/** Resolved virtual dataset (published perspective): the §35.10 oracle input. */
export function applyOverlay(base: FixtureDocument[], overlay: SpikeOverlay): FixtureDocument[] {
  const out: FixtureDocument[] = []
  const seen = new Set<string>()
  for (const doc of base) {
    if (overlay.tombstones.has(doc._id)) continue
    const local = overlay.documents.get(doc._id)
    out.push(local ?? doc)
    seen.add(doc._id)
  }
  for (const [id, doc] of overlay.documents) {
    if (!seen.has(id) && !overlay.tombstones.has(id)) out.push(doc)
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic overlay fixtures — each targets a §35.11 behavior.

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const find = (base: FixtureDocument[], id: string): FixtureDocument => {
  const d = base.find((x) => x._id === id)
  if (!d) throw new Error(`fixture missing ${id}`)
  return clone(d)
}

/** Filter membership: article-05 loses 'odd', gains 'featured'; title edited. */
export function ovFilterChange(base: FixtureDocument[]): SpikeOverlay {
  const o = emptyOverlay()
  const d = find(base, 'article-05')
  d.tags = ['news', 'featured']
  d.title = 'Article 5 (branch edit)'
  o.documents.set(d._id, d)
  return o
}

/** Sort + slice membership: article-25 (outside top 20) becomes the newest. */
export function ovSortChange(base: FixtureDocument[]): SpikeOverlay {
  const o = emptyOverlay()
  const d = find(base, 'article-25')
  d.publishedAt = '2026-03-01T12:00:00Z'
  o.documents.set(d._id, d)
  return o
}

/** Branch-created document enters type list and top of the ordered slice. */
export function ovBranchCreate(base: FixtureDocument[]): SpikeOverlay {
  const o = emptyOverlay()
  const t = find(base, 'article-01')
  const d: FixtureDocument = {
    ...t,
    _id: 'article-branch-1',
    title: 'Branch article',
    slug: {_type: 'slug', current: 'branch-article'},
    publishedAt: '2026-04-01T12:00:00Z',
    tags: ['news', 'branch'],
  }
  o.documents.set(d._id, d)
  return o
}

/** Tombstone: article-03 leaves every result. */
export function ovTombstone(): SpikeOverlay {
  const o = emptyOverlay()
  o.tombstones.add('article-03')
  return o
}

/** Reference target change: author-2 renamed -> deref + parent membership shift. */
export function ovRefTargetChange(base: FixtureDocument[]): SpikeOverlay {
  const o = emptyOverlay()
  const d = find(base, 'author-2')
  d.name = 'Author 2 (branch rename)'
  o.documents.set(d._id, d)
  return o
}

export const OVERLAY_FIXTURES: Record<string, (base: FixtureDocument[]) => SpikeOverlay> = {
  'empty': () => emptyOverlay(),
  'filter-change': ovFilterChange,
  'sort-change': ovSortChange,
  'branch-create': ovBranchCreate,
  'tombstone': () => ovTombstone(),
  'ref-target-change': ovRefTargetChange,
}
