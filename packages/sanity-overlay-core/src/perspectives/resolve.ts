/**
 * Perspective resolution (PRD §18.1 published, §18.2 drafts, §18.3 raw),
 * workstream W3.
 *
 * A perspective decides *which* version answers a read; the three-way merge
 * (§17) decides what that version resolves to. This module is the first half and
 * delegates the second, so `local published` in the `published` perspective is
 * always `merge(current base published, local published)` — never a bare copy of
 * the local record.
 *
 * Everything is pure: the record and the current base documents come in, a
 * resolution comes out. `now` is the injected clock stamped on conflicts and the
 * schema validator is the injected §17.3 step 9 port.
 */
import {checksum} from '../checksum'
import {encodeOverlayPath} from '../encoding'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import type {LocalDocumentVersion, OverlayDocumentRecord} from '../types/record'
import {deepClone} from '../mutations/paths'
import {addConflict, createMergeContext} from '../merge/context'
import {mergeDocument} from '../merge/merge'
import type {MergeAbsence, MergeResult} from '../merge/types'
import type {MergeValidationIssue, MergeValidator} from '../merge/validation'

/** The three perspectives the overlay answers (PRD §18.1-§18.3). */
export const OVERLAY_PERSPECTIVES = ['published', 'drafts', 'raw'] as const
export type OverlayPerspective = (typeof OVERLAY_PERSPECTIVES)[number]

/** Current base documents for one logical ID (PRD §16.1 "always read-only"). */
export interface PerspectiveBase {
  published: SanityDocument | null
  draft: SanityDocument | null
}

export interface PerspectiveRequest {
  logicalId: string
  /** Injected clock stamped on any conflict raised while resolving. */
  now: string
  /** The overlay's record for this logical ID, or `null` when untouched. */
  record: OverlayDocumentRecord | null
  base: PerspectiveBase
  /** PRD §17.3 step 9 validation port; defaults to the merge engine's no-op. */
  validate?: MergeValidator
  /** §20.5 timing label handed to the validator. */
  validationAction?: string
}

/** Which link of the §18.1/§18.2 chain answered the read. */
export type PerspectiveSource =
  | 'local-draft'
  | 'local-published'
  | 'base-draft'
  | 'base-published'
  | 'none'

export interface PerspectiveResolution {
  perspective: 'published' | 'drafts'
  document: SanityDocument | null
  source: PerspectiveSource
  absence: MergeAbsence | null
  conflicts: OverlayConflict[]
  /** PRD §17.3 step 10 — deterministic checksum of the resolved document. */
  checksum: string | null
  touchedPaths: OverlayPath[]
  removedTouchedPaths: OverlayPath[]
  validation: readonly MergeValidationIssue[]
}

/* ------------------------------------------------------------------ *
 * Unset intent recorded on a local version (§13.5, §17.5)
 * ------------------------------------------------------------------ */

/**
 * The paths a local version currently holds down with an explicit unset.
 *
 * §17.5 requires unsets to be *tracked*, and §13.5 stores the operation list that
 * tracks them. Folding the list in order is what makes "let a user remove the
 * local unset to resume inheritance" fall out: a later write on the same path
 * cancels the unset, and a later unset re-establishes it.
 */
export function unsetPathsFromOperations(
  operations: readonly OverlayOperation[],
): OverlayPath[] {
  const order: string[] = []
  const paths = new Map<string, OverlayPath>()

  for (const operation of operations) {
    if (operation.type === 'replaceDocument') {
      order.length = 0
      paths.clear()
      continue
    }
    if (!('path' in operation)) continue
    const encoded = encodeOverlayPath(operation.path)
    if (operation.type === 'unset') {
      if (!paths.has(encoded)) order.push(encoded)
      paths.set(encoded, deepClone(operation.path) as OverlayPath)
      continue
    }
    paths.delete(encoded)
  }

  return order.filter((encoded) => paths.has(encoded)).map((encoded) => paths.get(encoded)!)
}

/* ------------------------------------------------------------------ *
 * Shared resolution helpers
 * ------------------------------------------------------------------ */

type VersionKind = 'published' | 'draft'

function absent(
  perspective: 'published' | 'drafts',
  absence: MergeAbsence,
): PerspectiveResolution {
  return {
    perspective,
    document: null,
    source: 'none',
    absence,
    conflicts: [],
    checksum: null,
    touchedPaths: [],
    removedTouchedPaths: [],
    validation: [],
  }
}

function fromBase(
  request: PerspectiveRequest,
  perspective: 'published' | 'drafts',
  document: SanityDocument | null,
  source: PerspectiveSource,
): PerspectiveResolution {
  if (document === null) {
    const deleted = request.record?.base?.baseStatus === 'deleted'
    return absent(perspective, deleted ? 'base-deleted' : 'missing')
  }
  const resolved = deepClone(document)
  return {
    perspective,
    document: resolved,
    source,
    absence: null,
    conflicts: [],
    checksum: checksum(resolved),
    touchedPaths: [],
    removedTouchedPaths: [],
    validation: [],
  }
}

function localVersionOf(
  record: OverlayDocumentRecord,
  version: VersionKind,
): LocalDocumentVersion | null {
  return version === 'draft' ? record.local.draft : record.local.published
}

function fromMerge(
  perspective: 'published' | 'drafts',
  source: PerspectiveSource,
  result: MergeResult,
  extra: readonly OverlayConflict[] = [],
): PerspectiveResolution {
  return {
    perspective,
    document: result.document,
    source: result.document === null ? 'none' : source,
    absence: result.absence,
    conflicts: [...extra, ...result.conflicts],
    checksum: result.checksum,
    touchedPaths: result.touchedPaths,
    removedTouchedPaths: result.removedTouchedPaths,
    validation: result.validation,
  }
}

/**
 * Merge one local version against the current base for its perspective.
 *
 * The ancestor is the §13.3 `base` block's snapshot for the same version, falling
 * back to the published snapshot: a local draft first touched from base published
 * has no base draft ancestor to compare against.
 */
function mergeVersion(
  request: PerspectiveRequest,
  perspective: 'published' | 'drafts',
  version: VersionKind,
  source: PerspectiveSource,
): PerspectiveResolution {
  const record = request.record!
  const local = localVersionOf(record, version)!
  const baseBlock = record.base

  /* §18.2: a draft anchored on the branch's own published layer stacks on THAT
   * resolution. Using the base draft as its current base would let untouched
   * fields inherit content the branch already published over (observed live
   * 2026-08-11: an edit after publish resolved to the stale upstream draft). */
  const draftOverLocalPublished =
    version === 'draft' &&
    local.ancestorKind === 'local-published' &&
    record.local.published !== null &&
    !record.local.publishedTombstone

  let ancestor: SanityDocument | null
  let currentBase: SanityDocument | null
  if (draftOverLocalPublished) {
    ancestor = record.local.published!.materialized
    currentBase = mergeVersion(request, perspective, 'published', 'local-published').document
  } else {
    ancestor =
      version === 'draft'
        ? (baseBlock?.draft?.snapshot ?? baseBlock?.published?.snapshot ?? null)
        : (baseBlock?.published?.snapshot ?? null)
    currentBase =
      version === 'draft' ? (request.base.draft ?? request.base.published) : request.base.published
  }

  const extra: OverlayConflict[] = []
  // §17.4 `BASE_DRAFT_DELETED`: the base draft this local draft was anchored to is
  // gone, the local draft wins, and §18.2's fallback chain still applies. A draft
  // stacked on the branch's own published layer superseded the base draft, so its
  // later deletion upstream is not a conflict for it.
  if (
    !draftOverLocalPublished &&
    version === 'draft' &&
    baseBlock?.draft != null &&
    request.base.draft === null &&
    request.base.published !== null
  ) {
    const context = createMergeContext(request.logicalId, request.now)
    extra.push(
      addConflict(context, {
        type: 'BASE_DRAFT_DELETED',
        ancestorValue: baseBlock.draft.revision,
      }),
    )
  }

  const result = mergeDocument({
    documentId: request.logicalId,
    now: request.now,
    ancestor,
    currentBase,
    localMaterialized: local.materialized,
    localTouchedPaths: local.touchedPaths,
    localTombstone: false,
    unsetPaths: unsetPathsFromOperations(local.operations),
    origin: record.origin,
    ...(baseBlock === null ? {} : {baseStatus: baseBlock.baseStatus}),
    ...(request.validate === undefined ? {} : {validate: request.validate}),
    ...(request.validationAction === undefined
      ? {}
      : {validationAction: request.validationAction}),
  })

  return fromMerge(perspective, source, result, extra)
}

/* ------------------------------------------------------------------ *
 * §18.1 virtual published perspective
 * ------------------------------------------------------------------ */

/**
 * PRD §18.1:
 *
 * ```text
 * if local.publishedTombstone:  return no document
 * else if local.published exists: return merge(current base published, local published)
 * else: return current base published
 * ```
 */
export function resolvePublishedPerspective(
  request: PerspectiveRequest,
): PerspectiveResolution {
  const record = request.record
  if (record === null) return fromBase(request, 'published', request.base.published, 'base-published')
  if (record.local.publishedTombstone) return absent('published', 'tombstone')
  if (record.local.published !== null) {
    return mergeVersion(request, 'published', 'published', 'local-published')
  }
  return fromBase(request, 'published', request.base.published, 'base-published')
}

/* ------------------------------------------------------------------ *
 * §18.2 virtual drafts perspective
 * ------------------------------------------------------------------ */

/**
 * PRD §18.2, including the documented fallback chain.
 *
 * One deviation is deliberate and documented: §18.2's draft-tombstone branch ends
 * "else current base published", but a *published* tombstone is an applicable
 * local tombstone (§17.2 precedence rule 1) and a §18.8 full delete sets both.
 * Falling back to base published there would resurrect a deleted document, so a
 * published tombstone keeps the document absent.
 */
export function resolveDraftsPerspective(request: PerspectiveRequest): PerspectiveResolution {
  const record = request.record
  const base = request.base

  if (record === null) {
    return base.draft !== null
      ? fromBase(request, 'drafts', base.draft, 'base-draft')
      : fromBase(request, 'drafts', base.published, 'base-published')
  }

  if (record.local.draftTombstone) {
    if (record.local.published !== null && !record.local.publishedTombstone) {
      return mergeVersion(request, 'drafts', 'published', 'local-published')
    }
    if (record.local.publishedTombstone) return absent('drafts', 'tombstone')
    return fromBase(request, 'drafts', base.published, 'base-published')
  }

  if (record.local.draft !== null) {
    return mergeVersion(request, 'drafts', 'draft', 'local-draft')
  }

  if (record.local.published !== null && !record.local.publishedTombstone) {
    return mergeVersion(request, 'drafts', 'published', 'local-published')
  }

  if (record.local.publishedTombstone) {
    return fromBase(request, 'drafts', base.draft, 'base-draft')
  }

  return base.draft !== null
    ? fromBase(request, 'drafts', base.draft, 'base-draft')
    : fromBase(request, 'drafts', base.published, 'base-published')
}

/* ------------------------------------------------------------------ *
 * §18.3 raw perspective — partial and synthetic
 * ------------------------------------------------------------------ */

/**
 * PRD §18.3. `raw` is partial and synthetic in overlay mode: it returns the four
 * stored versions plus tombstone and conflict metadata, and explicitly does not
 * claim parity with Sanity's hosted `raw` perspective or with release versions.
 * The `partial`, `claimsHostedParity` and `releases` fields carry that disclaimer
 * in the payload so no caller can mistake it for hosted `raw`.
 */
export interface RawPerspectiveView {
  perspective: 'raw'
  logicalId: string
  basePublished: SanityDocument | null
  baseDraft: SanityDocument | null
  localPublished: LocalDocumentVersion | null
  localDraft: LocalDocumentVersion | null
  tombstones: {published: boolean; draft: boolean}
  conflicts: OverlayConflict[]
  /** Always `true`: the view is a synthetic subset (§18.3). */
  partial: true
  /** Always `false`: no parity with hosted `raw` is claimed (§18.3). */
  claimsHostedParity: false
  /** Always `null`: release perspectives are out of scope (§18.3). */
  releases: null
}

export function resolveRawPerspective(request: PerspectiveRequest): RawPerspectiveView {
  const record = request.record
  return {
    perspective: 'raw',
    logicalId: request.logicalId,
    basePublished: request.base.published === null ? null : deepClone(request.base.published),
    baseDraft: request.base.draft === null ? null : deepClone(request.base.draft),
    localPublished: record?.local.published ?? null,
    localDraft: record?.local.draft ?? null,
    tombstones: {
      published: record?.local.publishedTombstone ?? false,
      draft: record?.local.draftTombstone ?? false,
    },
    conflicts: record?.conflicts ?? [],
    partial: true,
    claimsHostedParity: false,
    releases: null,
  }
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

export function resolvePerspective(
  perspective: 'published',
  request: PerspectiveRequest,
): PerspectiveResolution
export function resolvePerspective(
  perspective: 'drafts',
  request: PerspectiveRequest,
): PerspectiveResolution
export function resolvePerspective(
  perspective: 'raw',
  request: PerspectiveRequest,
): RawPerspectiveView
export function resolvePerspective(
  perspective: OverlayPerspective,
  request: PerspectiveRequest,
): PerspectiveResolution | RawPerspectiveView
export function resolvePerspective(
  perspective: OverlayPerspective,
  request: PerspectiveRequest,
): PerspectiveResolution | RawPerspectiveView {
  if (perspective === 'published') return resolvePublishedPerspective(request)
  if (perspective === 'drafts') return resolveDraftsPerspective(request)
  return resolveRawPerspective(request)
}
