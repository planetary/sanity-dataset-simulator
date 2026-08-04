/**
 * PRD §19.2 — the reference resolver, in the documented order.
 *
 * ```text
 * 1. Normalize target logical ID.
 * 2. Check applicable local tombstone.
 * 3. Check branch-created or locally modified target.
 * 4. Fall back to current base target.
 * 5. Return missing-reference metadata when absent.
 * 6. Apply the requested perspective to the target.
 * ```
 *
 * Steps 1-5 classify the target from overlay state plus the base source. Step 6 —
 * turning the classification into an actual document — is the injected
 * {@link VirtualTargetResolver} port, because full perspective resolution and the
 * three-way merge are workstream W3's. The default port is built from the W2
 * §18.1/§18.2 resolvers so this module is usable and testable on its own; the
 * orchestrator swaps in W3's resolver when it lands, with no change here.
 *
 * §19.1's core rule holds throughout: **nothing in this file writes.** A changed
 * target never rewrites its parents.
 */
import {toPublishedId} from '../encoding'
import type {SanityDocument} from '../types/document'
import type {OverlayDocumentRecord} from '../types/record'
import type {BaseDocumentSource, MergeResolver} from '../mutations/ports'
import {resolveDraft, resolvePublished, type ResolveContext} from '../mutations/resolve'
import {getRecord, type OverlayState} from '../mutations/state'
import type {ExtractedReference, ReferencePerspective} from './types'

/** Request handed to the step-6 port. */
export interface ResolveTargetRequest {
  /** Already normalized (step 1): never carries a `drafts.` prefix. */
  logicalId: string
  perspective: ReferencePerspective
}

/**
 * Step 6 of §19.2 — "apply the requested perspective to the target".
 *
 * The integration point for W3's perspective module: any function of this shape
 * can be injected, and core never reaches into a perspective implementation.
 */
export type VirtualTargetResolver = (request: ResolveTargetRequest) => SanityDocument | null

export interface ReferenceResolutionContext {
  base?: BaseDocumentSource
  merge?: MergeResolver
  /** PRD §19.2 step 6. Defaults to `drafts` — the editing perspective. */
  perspective?: ReferencePerspective
  /** Overrides the default step-6 port. */
  resolveTarget?: VirtualTargetResolver
}

/** Which §19.2 step produced the answer. */
export type ReferenceTargetOrigin =
  | 'local-tombstone'
  | 'branch-created'
  | 'local-modified'
  | 'base'
  | 'missing'

/** PRD §19.2 step 5 — missing-reference metadata. */
export interface MissingReferenceMetadata {
  targetId: string
  perspective: ReferencePerspective
  reason: 'tombstoned' | 'not-found'
}

export interface ResolvedReferenceTarget {
  /** The `_ref` as asked for, before normalization. */
  requestedId: string
  targetId: string
  perspective: ReferencePerspective
  origin: ReferenceTargetOrigin
  document: SanityDocument | null
  available: boolean
  /** Does the target resolve under `published`? (PRD §19.5, invariant §34.10.) */
  publishedAvailable: boolean
  /** Resolves as a draft but not as published — blocks branch publish (§19.5). */
  draftOnly: boolean
  missing: MissingReferenceMetadata | null
}

function resolveContextOf(context: ReferenceResolutionContext): ResolveContext {
  return {
    ...(context.base === undefined ? {} : {base: context.base}),
    ...(context.merge === undefined ? {} : {merge: context.merge}),
  }
}

/**
 * The default step-6 port over W2's §18.1 / §18.2 resolvers.
 *
 * Exported so a caller can compose it (for example to memoize) and so tests can
 * assert the default behaviour independently of the classification steps.
 */
export function createStateTargetResolver(
  state: OverlayState,
  context: Pick<ReferenceResolutionContext, 'base' | 'merge'> = {},
): VirtualTargetResolver {
  const resolveContext = resolveContextOf(context)
  return (request) =>
    request.perspective === 'drafts'
      ? resolveDraft(state, request.logicalId, resolveContext)
      : resolvePublished(state, request.logicalId, resolveContext)
}

/**
 * Step 2 — is a local tombstone *applicable* to this perspective?
 *
 * Under `published` a published tombstone removes the document outright (§18.1).
 * Under `drafts` a draft tombstone alone does not: §18.2 falls back to local
 * published and then to base published, so the target only disappears when both
 * tombstones are set.
 */
function tombstoneApplies(
  record: OverlayDocumentRecord,
  perspective: ReferencePerspective,
): boolean {
  return perspective === 'published'
    ? record.local.publishedTombstone
    : record.local.draftTombstone && record.local.publishedTombstone
}

/** Step 3 — does the record carry a local version for this perspective? */
function hasLocalVersion(
  record: OverlayDocumentRecord,
  perspective: ReferencePerspective,
): boolean {
  return perspective === 'published'
    ? record.local.published !== null
    : record.local.draft !== null || record.local.published !== null
}

/** Step 4 — does the current base still hold the target? */
function baseHasTarget(
  base: BaseDocumentSource | undefined,
  logicalId: string,
  perspective: ReferencePerspective,
): boolean {
  if (base === undefined) return false
  if (perspective === 'published') return base.getPublished(logicalId) !== null
  return base.getDraft(logicalId) !== null || base.getPublished(logicalId) !== null
}

/** Resolve one reference target through the §19.2 order. */
export function resolveReferenceTarget(
  state: OverlayState,
  targetId: string,
  context: ReferenceResolutionContext = {},
): ResolvedReferenceTarget {
  const perspective = context.perspective ?? 'drafts'
  /* Step 1 — normalize target logical ID. */
  const logicalId = toPublishedId(targetId)
  const record = getRecord(state, logicalId)
  const resolveTarget = context.resolveTarget ?? createStateTargetResolver(state, context)

  /* Step 2 — applicable local tombstone. */
  if (record !== null && tombstoneApplies(record, perspective)) {
    return {
      requestedId: targetId,
      targetId: logicalId,
      perspective,
      origin: 'local-tombstone',
      document: null,
      available: false,
      publishedAvailable: false,
      draftOnly: false,
      missing: {targetId: logicalId, perspective, reason: 'tombstoned'},
    }
  }

  /* Steps 3-5 — classify. */
  let origin: ReferenceTargetOrigin
  if (record !== null && record.origin === 'branch') {
    origin = 'branch-created'
  } else if (record !== null && hasLocalVersion(record, perspective)) {
    origin = 'local-modified'
  } else if (baseHasTarget(context.base, logicalId, perspective)) {
    origin = 'base'
  } else {
    origin = 'missing'
  }

  /* Step 6 — apply the requested perspective. */
  const document = resolveTarget({logicalId, perspective})
  const publishedAvailable =
    perspective === 'published'
      ? document !== null
      : resolveTarget({logicalId, perspective: 'published'}) !== null
  const draftAvailable =
    perspective === 'drafts'
      ? document !== null
      : resolveTarget({logicalId, perspective: 'drafts'}) !== null

  return {
    requestedId: targetId,
    targetId: logicalId,
    perspective,
    origin,
    document,
    available: document !== null,
    publishedAvailable,
    draftOnly: !publishedAvailable && draftAvailable,
    missing:
      document === null ? {targetId: logicalId, perspective, reason: 'not-found'} : null,
  }
}

/** Resolve the target of an extracted reference (PRD §19.1 dereferencing). */
export function dereference(
  state: OverlayState,
  reference: ExtractedReference | string,
  context: ReferenceResolutionContext = {},
): ResolvedReferenceTarget {
  const raw = typeof reference === 'string' ? reference : reference.rawRef
  return resolveReferenceTarget(state, raw, context)
}
