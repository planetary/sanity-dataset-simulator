/**
 * Reading a §13.3 record the way a reviewer thinks about it: two perspectives,
 * each with an ancestor and a branch value.
 *
 * The ancestor is NOT "the base document". §13.3 records which ancestor each
 * local version was branched from (`ancestorKind`), and getting that wrong makes
 * every diff and every rebase wrong in the same direction — a draft branched
 * from a local published version would otherwise be diffed against the base
 * published snapshot and show changes that were never made in that step.
 */
import type {
  LocalDocumentVersion,
  OverlayDocumentRecord,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'

export type VersionKind = 'draft' | 'published'

export const VERSION_KINDS: readonly VersionKind[] = Object.freeze(['draft', 'published'])

/** The merge ancestor a local version was branched from (PRD §13.3, §17.1). */
export function ancestorFor(
  record: OverlayDocumentRecord,
  local: LocalDocumentVersion,
): SanityDocument | null {
  switch (local.ancestorKind) {
    case 'base-published':
      return record.base?.published?.snapshot ?? null
    case 'base-draft':
      return record.base?.draft?.snapshot ?? null
    case 'local-published':
      return record.local.published?.materialized ?? null
    case 'branch-created':
      return null
    default:
      return null
  }
}

/** The ancestor revision that goes with {@link ancestorFor}. */
export function ancestorRevisionFor(
  record: OverlayDocumentRecord,
  local: LocalDocumentVersion,
): string | null {
  if (local.ancestorRevision !== undefined) return local.ancestorRevision
  switch (local.ancestorKind) {
    case 'base-published':
      return record.base?.published?.revision ?? null
    case 'base-draft':
      return record.base?.draft?.revision ?? null
    default:
      return null
  }
}

export function localVersion(
  record: OverlayDocumentRecord,
  kind: VersionKind,
): LocalDocumentVersion | null {
  return kind === 'draft' ? record.local.draft : record.local.published
}

export function tombstoned(record: OverlayDocumentRecord, kind: VersionKind): boolean {
  return kind === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone
}

/**
 * The perspective the CLI acts on when a command needs exactly one.
 *
 * `rebase` replaces the §13.3 base block, which is shared by both perspectives,
 * but core's `autoRebase` evaluates one (ancestor, local) pair. The draft is
 * chosen when present because that is where Studio editing lands; the choice is
 * reported in the command output rather than left implicit.
 */
export function primaryVersion(record: OverlayDocumentRecord): VersionKind | null {
  if (record.local.draft !== null) return 'draft'
  if (record.local.published !== null) return 'published'
  return null
}
