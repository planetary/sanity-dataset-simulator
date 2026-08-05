/**
 * The overlay side of candidate planning — PRD §22.6 steps 6, 7 and 13.
 *
 * The query layer does not own overlay storage; it consumes a resolved,
 * perspective-applied view of the branch. `sanity-overlay-core` produces that
 * view, a store adapter persists it, and this port is what the two agree on.
 */
import type {QueryDocument} from './types'

export interface OverlaySource {
  /** logical document ID -> the branch-resolved document (created or modified). */
  readonly documents: ReadonlyMap<string, QueryDocument>
  /** logical document IDs whose base document is suppressed (§22.6 step 7). */
  readonly tombstones: ReadonlySet<string>
  /** Optional: IDs currently in conflict, surfaced through §22.8 diagnostics. */
  readonly conflicts?: ReadonlySet<string>
}

export const emptyOverlaySource = (): OverlaySource => ({
  documents: new Map(),
  tombstones: new Set(),
})

/**
 * Virtual resolution of one logical ID (§22.6 step 13): a tombstone suppresses
 * the document entirely, otherwise the branch record wins over base.
 */
export function resolveVirtualDocument(
  id: string,
  base: ReadonlyMap<string, QueryDocument>,
  overlay: OverlaySource,
): QueryDocument | undefined {
  if (overlay.tombstones.has(id)) return undefined
  return overlay.documents.get(id) ?? base.get(id)
}
