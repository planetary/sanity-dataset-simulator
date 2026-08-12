/**
 * `applyMutation` — every PRD §13.7 `OverlayMutation` variant over overlay state
 * (plan §5: create, create-if-not-exists, create-or-replace, delete, patch).
 *
 * Every application is pure. `applyMutation` is the per-mutation *step*; the
 * commit boundary that increments the overlay revision exactly once (§34.5) and
 * records the transaction is {@link applyTransaction}. A mutation therefore
 * stamps versions with `context.overlayRevision`, defaulting to
 * `state.revision + 1`, and never mutates `state.revision` itself.
 */
import {checksum} from '../checksum'
import {toPublishedId} from '../encoding'
import {
  OverlayActionBlockedError,
  OverlayMutationError,
  OverlayPreconditionError,
} from '../errors'
import type {OverlayActor} from '../types/actor'
import type {SanityDocument} from '../types/document'
import type {OverlayMutation, OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import type {BaseDocumentVersion, OverlayAncestorKind, OverlayDocumentRecord} from '../types/record'
import {applyOperations} from './operations'
import {deepClone, isPlainObject, mergeTouchedPaths} from './paths'
import {
  noopStrongReferenceCheck,
  type BaseDocumentSource,
  type MergeResolver,
  type StrongReferenceCheck,
  type StrongReferenceIssue,
} from './ports'
import {documentExists, resolveVersion} from './resolve'
import {
  applySyntheticSystemFields,
  createDocumentRecord,
  createLocalVersion,
  currentRevisionOf,
  documentIdFor,
  getRecord,
  versionKindFor,
  withRecord,
  type OverlayState,
  type VersionKind,
} from './state'

export interface MutationContext {
  /** Injected clock (plan §5 "no Date.now()/Math.random() inside the engine"). */
  now: () => string
  actor?: OverlayActor
  base?: BaseDocumentSource
  merge?: MergeResolver
  /** Overlay revision this mutation commits at. Defaults to `state.revision + 1`. */
  overlayRevision?: number
  /** PRD §17.10 — explicit intent for a `_type` change in a full replacement. */
  allowTypeChange?: boolean
  /** W4 injection point (PRD §18.8, §19.4). Defaults to a no-op. */
  checkStrongReferences?: StrongReferenceCheck
  /** Documents mutated by the same transaction (PRD §18.8 "unless" clause). */
  transactionDocumentIds?: readonly string[]
  transactionMutations?: readonly OverlayMutation[]
}

export interface AppliedMutation {
  state: OverlayState
  affectedDocumentIds: string[]
  /** True when the mutation was a documented no-op (`createIfNotExists` on an existing document). */
  noop: boolean
}

function mutationError(message: string, details: Record<string, unknown> = {}): never {
  throw new OverlayMutationError('OVERLAY_TRANSACTION_INVALID', message, details)
}

function notFound(id: string, detail: string): never {
  throw new OverlayMutationError(
    'OVERLAY_DOCUMENT_NOT_FOUND',
    `Document ${JSON.stringify(id)} ${detail}`,
    {id},
  )
}

/** The logical document ID a mutation targets. */
export function mutationTargetId(mutation: OverlayMutation): string {
  switch (mutation.type) {
    case 'create':
    case 'createIfNotExists':
    case 'createOrReplace':
      return toPublishedId(mutation.document._id)
    case 'delete':
    case 'patch':
      return toPublishedId(mutation.id)
    /* istanbul ignore next -- validateMutation rejects unknown shapes first */
    default:
      return mutationError('Unknown mutation type', {mutation})
  }
}

/**
 * Cheap structural validation, run over *every* mutation before *any* is applied
 * so a transaction fails before it can partially commit (plan §5 all-or-nothing).
 */
export function validateMutation(mutation: unknown): asserts mutation is OverlayMutation {
  if (!isPlainObject(mutation)) mutationError('Mutation must be an object', {mutation})
  const type = (mutation as {type?: unknown}).type
  switch (type) {
    case 'create':
    case 'createIfNotExists':
    case 'createOrReplace': {
      const document = (mutation as {document?: unknown}).document
      if (!isPlainObject(document)) {
        mutationError(`${String(type)} requires a \`document\` object`, {mutation})
      }
      const doc = document as Record<string, unknown>
      if (typeof doc._id !== 'string' || doc._id.length === 0) {
        mutationError(`${String(type)} requires a non-empty \`_id\``, {mutation})
      }
      if (typeof doc._type !== 'string' || doc._type.length === 0) {
        // PRD §13.9 — `_type` required at creation.
        mutationError(`${String(type)} requires a non-empty \`_type\``, {mutation})
      }
      return
    }
    case 'delete': {
      const id = (mutation as {id?: unknown}).id
      if (typeof id !== 'string' || id.length === 0) {
        mutationError('delete requires a non-empty `id`', {mutation})
      }
      return
    }
    case 'patch': {
      const id = (mutation as {id?: unknown}).id
      if (typeof id !== 'string' || id.length === 0) {
        mutationError('patch requires a non-empty `id`', {mutation})
      }
      const operations = (mutation as {operations?: unknown}).operations
      if (!Array.isArray(operations) || operations.length === 0) {
        mutationError('patch requires a non-empty `operations` array', {mutation})
      }
      for (const operation of operations) {
        if (!isPlainObject(operation) || typeof (operation as {type?: unknown}).type !== 'string') {
          mutationError('Each patch operation must carry a string `type` (PRD §13.7)', {mutation})
        }
      }
      return
    }
    default:
      mutationError(`Unknown mutation type ${JSON.stringify(type)} (PRD §13.7)`, {mutation})
  }
}

/* ------------------------------------------------------------------ *
 * Record capture
 * ------------------------------------------------------------------ */

function baseVersion(
  snapshot: {revision: string; document: SanityDocument; capturedAt?: string} | null,
  now: string,
): BaseDocumentVersion | null {
  if (snapshot === null) return null
  const document = deepClone(snapshot.document)
  return {
    revision: snapshot.revision,
    snapshot: document,
    checksum: checksum(document),
    capturedAt: snapshot.capturedAt ?? now,
  }
}

/**
 * Capture the §13.3 `base` block at first touch. `firstTouchedAt` is set here and
 * never modified again; only a rebase (W3, §28.5) may replace the block.
 */
function captureRecordFromBase(
  state: OverlayState,
  logicalId: string,
  context: MutationContext,
): OverlayDocumentRecord | null {
  const published = context.base?.getPublished(logicalId) ?? null
  const draft = context.base?.getDraft(logicalId) ?? null
  if (published === null && draft === null) return null

  const now = context.now()
  const source = (draft ?? published)!.document
  const record = createDocumentRecord({
    overlayId: state.overlayId,
    logicalId,
    schemaType: source._type,
    origin: 'base',
    now,
    actor: context.actor,
    runtimeRevision: (published ?? draft)!.revision,
    base: {
      firstTouchedAt: now,
      published: baseVersion(published, now),
      draft: baseVersion(draft, now),
      ...(published === null ? {} : {lastObservedPublishedRevision: published.revision}),
      ...(draft === null ? {} : {lastObservedDraftRevision: draft.revision}),
      baseStatus: 'present',
    },
  })
  return record
}

/**
 * Find the record, capturing it from base on first touch (PRD §13.3 "captured at
 * first touch"). The captured record is returned but *not* inserted into state —
 * the caller commits it as part of its own write.
 */
export function ensureRecord(
  state: OverlayState,
  id: string,
  context: MutationContext,
): OverlayDocumentRecord {
  const logicalId = toPublishedId(id)
  const existing = getRecord(state, logicalId)
  if (existing !== null) return existing
  const captured = captureRecordFromBase(state, logicalId, context)
  if (captured === null) notFound(id, 'does not exist in the overlay or the base dataset')
  return captured
}

interface Baseline {
  document: SanityDocument
  ancestorKind: OverlayAncestorKind
  ancestorRevision?: string
}

/**
 * The document a patch is applied to.
 *
 * A `drafts.` target with no local or base draft falls back to local published,
 * then base published — the same chain §18.2 uses — and records the matching
 * `ancestorKind` (PRD §13.5).
 */
function baselineFor(
  record: OverlayDocumentRecord,
  version: VersionKind,
  id: string,
): Baseline {
  const local = version === 'draft' ? record.local.draft : record.local.published
  if (local !== null) {
    const baseline: Baseline = {
      document: deepClone(local.materialized),
      ancestorKind: local.ancestorKind,
    }
    if (local.ancestorRevision !== undefined) baseline.ancestorRevision = local.ancestorRevision
    return baseline
  }

  if (version === 'published') {
    const base = record.base?.published ?? null
    if (base === null) notFound(id, 'has no published version to patch')
    return {
      document: deepClone(base.snapshot),
      ancestorKind: 'base-published',
      ancestorRevision: base.revision,
    }
  }

  /* §18.2 ordering: local published BEFORE base draft. A branch publish leaves
   * {published, draft: null} — anchoring the next edit on a base draft that
   * still exists upstream re-materializes content the branch just superseded.
   * Observed live 2026-08-11: publish "Well?", type again, and the save
   * restored the stale upstream draft title. */
  if (record.local.published !== null && !record.local.publishedTombstone) {
    return {
      document: deepClone(record.local.published.materialized),
      ancestorKind: 'local-published',
      ancestorRevision: record.local.published.overlayRevision,
    }
  }
  const baseDraft = record.base?.draft ?? null
  if (baseDraft !== null) {
    return {
      document: deepClone(baseDraft.snapshot),
      ancestorKind: 'base-draft',
      ancestorRevision: baseDraft.revision,
    }
  }
  const basePublished = record.base?.published ?? null
  if (basePublished === null) notFound(id, 'has no draft or published version to patch')
  return {
    document: deepClone(basePublished.snapshot),
    ancestorKind: 'base-published',
    ancestorRevision: basePublished.revision,
  }
}

/* ------------------------------------------------------------------ *
 * Writing a local version
 * ------------------------------------------------------------------ */

interface WriteInput {
  state: OverlayState
  record: OverlayDocumentRecord
  version: VersionKind
  document: SanityDocument
  touchedPaths: readonly OverlayPath[]
  operations: readonly OverlayOperation[]
  ancestorKind: OverlayAncestorKind
  ancestorRevision?: string
  context: MutationContext
  /** Replace the recorded touched paths and operations instead of appending. */
  reset?: boolean
  createdAt?: string
}

function overlayRevisionOf(state: OverlayState, context: MutationContext): number {
  return context.overlayRevision ?? state.revision + 1
}

function writeLocalVersion(input: WriteInput): OverlayDocumentRecord {
  const {state, record, version, context} = input
  const now = context.now()
  const overlayRevision = overlayRevisionOf(state, context)
  const existing = version === 'draft' ? record.local.draft : record.local.published

  const materialized = applySyntheticSystemFields({
    document: input.document,
    documentId: documentIdFor(record.logicalId, version),
    overlayRevision,
    now,
    createdAt:
      input.createdAt ??
      existing?.materialized._createdAt ??
      input.document._createdAt ??
      undefined,
  })

  const local = createLocalVersion({
    materialized,
    touchedPaths: input.reset
      ? mergeTouchedPaths([], input.touchedPaths)
      : mergeTouchedPaths(existing?.touchedPaths ?? [], input.touchedPaths),
    // PRD §17.8: the original inc/dec operations are retained as metadata beside
    // the resulting local value.
    operations: input.reset
      ? deepClone([...input.operations])
      : [...(existing?.operations ?? []), ...deepClone([...input.operations])],
    ancestorKind: input.ancestorKind,
    ...(input.ancestorRevision === undefined ? {} : {ancestorRevision: input.ancestorRevision}),
    overlayRevision: String(overlayRevision),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })

  const next: OverlayDocumentRecord = {
    ...record,
    local: {
      ...record.local,
      [version]: local,
      // A write to a version clears that version's tombstone.
      ...(version === 'draft' ? {draftTombstone: false} : {publishedTombstone: false}),
    },
    runtimeRevision: materialized._rev ?? record.runtimeRevision,
    updatedAt: now,
  }
  if (context.actor !== undefined) next.updatedBy = context.actor
  return next
}

/* ------------------------------------------------------------------ *
 * Variants
 * ------------------------------------------------------------------ */

function userFieldPaths(document: SanityDocument): OverlayPath[] {
  return Object.keys(document)
    .filter((key) => !key.startsWith('_'))
    .map((key) => [key])
}

function applyCreate(
  state: OverlayState,
  document: SanityDocument,
  context: MutationContext,
): AppliedMutation {
  const id = document._id
  const logicalId = toPublishedId(id)
  const version = versionKindFor(id)

  if (documentExists(state, id, context)) {
    throw new OverlayMutationError(
      'OVERLAY_DOCUMENT_ALREADY_EXISTS',
      `Document ${JSON.stringify(id)} already exists in the virtual dataset (PRD §35.4)`,
      {id},
    )
  }

  const now = context.now()
  const existing = getRecord(state, logicalId)
  const record =
    existing ??
    captureRecordFromBase(state, logicalId, context) ??
    createDocumentRecord({
      overlayId: state.overlayId,
      logicalId,
      schemaType: document._type,
      // PRD §13.9 / §18.9 — a branch-created document.
      origin: 'branch',
      now,
      actor: context.actor,
      runtimeRevision: '',
    })

  const next = writeLocalVersion({
    state,
    record,
    version,
    document: deepClone(document),
    touchedPaths: userFieldPaths(document),
    operations: [{type: 'replaceDocument', document: deepClone(document)}],
    ancestorKind: record.origin === 'branch' ? 'branch-created' : 'base-published',
    context,
    reset: true,
    // §13.9: `_createdAt` is set once at branch creation, preserved for base docs.
    createdAt: record.origin === 'branch' ? (document._createdAt ?? now) : undefined,
  })

  return {state: withRecord(state, next), affectedDocumentIds: [logicalId], noop: false}
}

function applyPatch(
  state: OverlayState,
  mutation: Extract<OverlayMutation, {type: 'patch'}>,
  context: MutationContext,
): AppliedMutation {
  const logicalId = toPublishedId(mutation.id)
  const version = versionKindFor(mutation.id)
  const record = ensureRecord(state, mutation.id, context)

  if (mutation.ifRevision !== undefined) {
    const actual = currentRevisionOf(record, version)
    if (actual !== mutation.ifRevision) {
      throw new OverlayPreconditionError(mutation.id, mutation.ifRevision, actual)
    }
  }

  const tombstoned =
    version === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone
  if (tombstoned) notFound(mutation.id, 'is tombstoned in this overlay (PRD §34.2)')

  const baseline = baselineFor(record, version, mutation.id)
  // §17.2 / §35.4: `setIfMissing` missingness is answered against the resolved
  // virtual document, so the patch baseline is the resolved value where one exists.
  const resolved = resolveVersion(state, mutation.id, context)
  const startingPoint =
    record.local.draft === null && record.local.published === null && resolved !== null
      ? deepClone(resolved)
      : baseline.document

  const {document, touchedPaths, operations} = applyOperations(startingPoint, mutation.operations, {
    ...(context.allowTypeChange === undefined ? {} : {allowTypeChange: context.allowTypeChange}),
  })

  const next = writeLocalVersion({
    state,
    record,
    version,
    document,
    touchedPaths,
    /* The RESOLVED spellings, not `mutation.operations`: a numeric insert
     * anchor may have been normalized to the §13.6-encodable index it actually
     * landed at (negative and out-of-range anchors are legal on the wire but
     * cannot be stored — encoding them crashes the next hydration). */
    operations,
    ancestorKind: baseline.ancestorKind,
    ...(baseline.ancestorRevision === undefined
      ? {}
      : {ancestorRevision: baseline.ancestorRevision}),
    context,
  })

  return {state: withRecord(state, next), affectedDocumentIds: [logicalId], noop: false}
}

/**
 * PRD §18.8 delete. The mutation-level `delete` is a *full* delete: both the
 * draft and the published tombstone are set, and record metadata is preserved for
 * diff, recovery and promotion. Removing only the draft is the `discardDraft`
 * action (§18.7), not a `delete` mutation.
 */
function applyDelete(
  state: OverlayState,
  id: string,
  context: MutationContext,
): AppliedMutation {
  const logicalId = toPublishedId(id)
  const blocking = blockingStrongReferences(state, logicalId, 'delete', context)
  if (blocking.length > 0) {
    throw new OverlayActionBlockedError(
      'delete',
      'strong-reference-invalid',
      `Deleting ${JSON.stringify(logicalId)} would invalidate ${blocking.length} strong reference(s) not updated by the same transaction (PRD §18.8)`,
      {documentId: logicalId, references: blocking},
    )
  }

  const existing = getRecord(state, logicalId)
  const record = existing ?? captureRecordFromBase(state, logicalId, context)
  if (record === null) {
    // Nothing in the overlay or the base: deleting is a no-op, as in Sanity.
    return {state, affectedDocumentIds: [], noop: true}
  }

  const now = context.now()
  const next: OverlayDocumentRecord = {
    ...record,
    local: {...record.local, publishedTombstone: true, draftTombstone: true},
    updatedAt: now,
  }
  if (context.actor !== undefined) next.updatedBy = context.actor
  return {state: withRecord(state, next), affectedDocumentIds: [logicalId], noop: false}
}

/**
 * Ask the injected W4 check for incoming strong references and reduce the answer
 * to the strong references that actually block.
 *
 * Only `delete` carries the §18.8 exemption ("unless the same transaction updates
 * or deletes all referring documents"), because there the danger is a *dangling*
 * reference from another document, which a same-transaction update removes. The
 * `publish` case is §19.5's opposite question — the document being published
 * holds a strong reference to a target that is not published — so a reference
 * from the acted-on document is exactly what must block, and no exemption
 * applies. `unpublish` reports rather than blocks (§18.6); its caller decides.
 */
export function blockingStrongReferences(
  state: OverlayState,
  logicalId: string,
  action: 'delete' | 'publish' | 'unpublish',
  context: MutationContext,
): StrongReferenceIssue[] {
  const check = context.checkStrongReferences ?? noopStrongReferenceCheck
  const transactionDocumentIds = context.transactionDocumentIds ?? [logicalId]
  const issues = check({
    action,
    documentId: logicalId,
    transactionDocumentIds,
    mutations: context.transactionMutations ?? [],
  })
  const strong = issues.filter((issue) => issue.strength === 'strong')
  if (action !== 'delete') return [...strong]

  const covered = new Set(transactionDocumentIds.map(toPublishedId))
  return strong.filter((issue) => !covered.has(toPublishedId(issue.referringDocumentId)))
}

/** Apply one §13.7 `OverlayMutation` to overlay state. */
export function applyMutation(
  state: OverlayState,
  mutation: OverlayMutation,
  context: MutationContext,
): AppliedMutation {
  validateMutation(mutation)

  switch (mutation.type) {
    case 'create':
      return applyCreate(state, mutation.document, context)

    case 'createIfNotExists':
      if (documentExists(state, mutation.document._id, context)) {
        return {state, affectedDocumentIds: [], noop: true}
      }
      return applyCreate(state, mutation.document, context)

    case 'createOrReplace': {
      if (!documentExists(state, mutation.document._id, context)) {
        return applyCreate(state, mutation.document, context)
      }
      // PRD §17.10 full replacement of an existing document.
      return applyPatch(
        state,
        {
          type: 'patch',
          id: mutation.document._id,
          operations: [{type: 'replaceDocument', document: mutation.document}],
        },
        context,
      )
    }

    case 'delete':
      return applyDelete(state, mutation.id, context)

    case 'patch':
      return applyPatch(state, mutation, context)

    /* istanbul ignore next -- validateMutation rejects unknown shapes */
    default:
      return mutationError('Unknown mutation type', {mutation})
  }
}
