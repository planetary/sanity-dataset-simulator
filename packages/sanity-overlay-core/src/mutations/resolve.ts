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
 * The merge step itself is the injected {@link MergeResolver} port, whose default
 * is the real W3 three-way merge ({@link threeWayMerge}). Everything §17.3 needs
 * beyond §17.1's five inputs — the explicit unset set (§17.5), the document
 * origin (§17.2 rule 2) and the base status (§16.4) — is read off the §13.3
 * record here and handed to the port, so the resolver stays pure.
 */
import {toPublishedId} from '../encoding'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayDocumentRecord} from '../types/record'
import {explicitUnsetPaths} from './operations'
import {
  EMPTY_BASE_SOURCE,
  threeWayMerge,
  type BaseDocumentSource,
  type MergeResolver,
} from './ports'
import {getRecord, versionKindFor, type OverlayState, type VersionKind} from './state'

export interface ResolveContext {
  base?: BaseDocumentSource
  /** Defaults to {@link threeWayMerge}, the real PRD §17.3 algorithm. */
  merge?: MergeResolver
  /** Observer for merge conflicts (§17.4, §34.13). Purely informational. */
  onConflict?: (conflict: OverlayConflict) => void
}

function baseOf(context: ResolveContext): BaseDocumentSource {
  return context.base ?? EMPTY_BASE_SOURCE
}

function mergeOf(context: ResolveContext): MergeResolver {
  return context.merge ?? threeWayMerge
}

function mergeLocal(
  record: OverlayDocumentRecord,
  version: VersionKind,
  currentBase: SanityDocument | null,
  context: ResolveContext,
  ancestorOverride?: SanityDocument | null,
): SanityDocument {
  const local = version === 'draft' ? record.local.draft : record.local.published
  /* istanbul ignore next -- callers check presence first */
  if (local === null) throw new Error('mergeLocal called without a local version')
  const ancestorBlock = record.base
  const ancestor =
    ancestorOverride !== undefined
      ? ancestorOverride
      : ancestorBlock === null
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
    documentId: record.logicalId,
    // `detectedAt` for any conflict raised. Read off the record rather than from
    // an injected clock on purpose: resolution is a *read*, and calling a caller's
    // clock here would let a read consume a tick and move the timestamps of the
    // write that follows it. Callers that need true detection time use the W3
    // perspective resolver, which takes `now` as a value.
    now: record.updatedAt,
    // §17.5: absence alone is not a representation, so the tracked unsets are
    // replayed out of the recorded operations and handed to the merge.
    unsetPaths: explicitUnsetPaths(local.operations),
    origin: record.origin,
    ...(ancestorBlock === null ? {} : {baseStatus: ancestorBlock.baseStatus}),
    ...(context.onConflict === undefined ? {} : {onConflict: context.onConflict}),
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
    /* §18.2: a draft anchored on the branch's own published layer stacks on
     * THAT resolution — the base draft it superseded must not be its current
     * base, or untouched fields inherit content the branch already published
     * over (observed live 2026-08-11: an edit after publish restored the stale
     * upstream draft title into the form). */
    if (
      record.local.draft.ancestorKind === 'local-published' &&
      record.local.published !== null &&
      !record.local.publishedTombstone
    ) {
      const publishedResolved = mergeLocal(record, 'published', currentBasePublished, context)
      return mergeLocal(
        record,
        'draft',
        publishedResolved,
        context,
        record.local.published.materialized,
      )
    }
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
      /* §18.2: a branch-published record supersedes the base draft. The virtual
       * draft address does not exist — `resolveVersionBatch` already answers
       * `null` for it, and this predicate must agree (2026-08-11). */
      if (record.local.published !== null && !record.local.publishedTombstone) return false
    }
    return source.getDraft(logicalId) !== null
  }

  if (record !== null) {
    if (record.local.publishedTombstone) return false
    if (record.local.published !== null) return true
  }
  return source.getPublished(logicalId) !== null
}
