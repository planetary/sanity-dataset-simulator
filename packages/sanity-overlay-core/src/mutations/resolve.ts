/**
 * Virtual document resolution the mutation engine needs (PRD §18.1, §18.2, §35.4).
 *
 * W3 owns the full perspective resolver and the three-way merge; W2 needs just
 * enough of it to answer two questions the PRD makes explicit:
 *
 * - "Create-if-not-exists against base **and overlay**" (§35.4): existence is a
 *   question about base + overlay + tombstones, never the overlay alone.
 * - `setIfMissing` missingness is evaluated against the *resolved virtual
 *   document* (§17.2 precedence), not the local record alone (plan §5).
 *
 * The merge step itself is the injected {@link MergeResolver} port, defaulting to
 * the documented W2 stub.
 */
import {toPublishedId} from '../encoding'
import type {SanityDocument} from '../types/document'
import type {OverlayDocumentRecord} from '../types/record'
import {
  EMPTY_BASE_SOURCE,
  localWinsMerge,
  type BaseDocumentSource,
  type MergeResolver,
} from './ports'
import {getRecord, versionKindFor, type OverlayState, type VersionKind} from './state'

export interface ResolveContext {
  base?: BaseDocumentSource
  merge?: MergeResolver
}

function baseOf(context: ResolveContext): BaseDocumentSource {
  return context.base ?? EMPTY_BASE_SOURCE
}

function mergeOf(context: ResolveContext): MergeResolver {
  return context.merge ?? localWinsMerge
}

function mergeLocal(
  record: OverlayDocumentRecord,
  version: VersionKind,
  currentBase: SanityDocument | null,
  context: ResolveContext,
): SanityDocument {
  const local = version === 'draft' ? record.local.draft : record.local.published
  /* istanbul ignore next -- callers check presence first */
  if (local === null) throw new Error('mergeLocal called without a local version')
  const ancestorBlock = record.base
  const ancestor =
    ancestorBlock === null
      ? null
      : ((version === 'draft' ? ancestorBlock.draft : ancestorBlock.published)?.snapshot ??
        ancestorBlock.published?.snapshot ??
        null)
  return mergeOf(context)({
    ancestor,
    currentBase,
    localMaterialized: local.materialized,
    localTouchedPaths: local.touchedPaths,
    localTombstone: version === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone,
  })
}

/** PRD §18.1 — virtual `published` perspective. */
export function resolvePublished(
  state: OverlayState,
  id: string,
  context: ResolveContext = {},
): SanityDocument | null {
  const logicalId = toPublishedId(id)
  const record = getRecord(state, logicalId)
  const currentBase = baseOf(context).getPublished(logicalId)?.document ?? null

  if (record === null) return currentBase
  if (record.local.publishedTombstone) return null
  if (record.local.published !== null) return mergeLocal(record, 'published', currentBase, context)
  return currentBase
}

/** PRD §18.2 — virtual `drafts` perspective, including the documented fallback chain. */
export function resolveDraft(
  state: OverlayState,
  id: string,
  context: ResolveContext = {},
): SanityDocument | null {
  const logicalId = toPublishedId(id)
  const record = getRecord(state, logicalId)
  const source = baseOf(context)
  const currentBaseDraft = source.getDraft(logicalId)?.document ?? null
  const currentBasePublished = source.getPublished(logicalId)?.document ?? null

  if (record === null) return currentBaseDraft ?? currentBasePublished

  if (record.local.draftTombstone) {
    if (record.local.published !== null && !record.local.publishedTombstone) {
      return mergeLocal(record, 'published', currentBasePublished, context)
    }
    return record.local.publishedTombstone ? null : currentBasePublished
  }
  if (record.local.draft !== null) {
    return mergeLocal(record, 'draft', currentBaseDraft ?? currentBasePublished, context)
  }
  if (record.local.published !== null && !record.local.publishedTombstone) {
    return mergeLocal(record, 'published', currentBasePublished, context)
  }
  if (record.local.publishedTombstone) return currentBaseDraft
  return currentBaseDraft ?? currentBasePublished
}

/** Resolve the version named by a document ID (`drafts.x` → draft, `x` → published). */
export function resolveVersion(
  state: OverlayState,
  id: string,
  context: ResolveContext = {},
): SanityDocument | null {
  return versionKindFor(id) === 'draft'
    ? resolveDraft(state, id, context)
    : resolvePublished(state, id, context)
}

/**
 * Does the document named by `id` exist in the **virtual dataset** — base plus
 * overlay plus tombstones (PRD §35.4)?
 *
 * This is existence of the concrete version, not of the perspective's fallback:
 * `createIfNotExists('drafts.x')` may legitimately create a draft while a
 * published `x` exists, exactly as in hosted Sanity.
 */
export function documentExists(
  state: OverlayState,
  id: string,
  context: ResolveContext = {},
): boolean {
  const logicalId = toPublishedId(id)
  const version = versionKindFor(id)
  const record = getRecord(state, logicalId)
  const source = baseOf(context)

  if (version === 'draft') {
    if (record !== null) {
      if (record.local.draftTombstone) return false
      if (record.local.draft !== null) return true
    }
    return source.getDraft(logicalId) !== null
  }

  if (record !== null) {
    if (record.local.publishedTombstone) return false
    if (record.local.published !== null) return true
  }
  return source.getPublished(logicalId) !== null
}
