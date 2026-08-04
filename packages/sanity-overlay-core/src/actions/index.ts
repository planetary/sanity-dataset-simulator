/**
 * Document actions (PRD §18.4-§18.9) as pure functions over overlay state.
 *
 * *Plan-level sequencing note* (plan §5): §37 lists these under later phases' UI
 * work, but their semantics are pure-core and PRD §35.5 tests them as unit tests,
 * so the reducers live here. **There is no Studio surface in this phase.**
 *
 * Every action commits through {@link commitTransform}, so each one increments the
 * overlay revision exactly once (§34.5), emits exactly one branch transaction
 * (§18.5), and short-circuits on a replayed idempotency key (§34.6).
 *
 * Reference integrity is *not* implemented here. Strong-reference decisions come
 * from the injected {@link StrongReferenceCheck} port (W4, §19.4-§19.5); this
 * module only applies the §18.8 "unless the same transaction updates or deletes
 * all referring documents" exemption to whatever the port reports.
 */
import {toPublishedId} from '../encoding'
import {OverlayActionBlockedError, OverlayMutationError} from '../errors'
import type {SanityDocument} from '../types/document'
import type {OverlayMutation, OverlayOperation} from '../types/operations'
import type {OverlayDocumentRecord} from '../types/record'
import {
  applyMutation,
  blockingStrongReferences,
  ensureRecord,
  type MutationContext,
} from '../mutations/mutation'
import {deepClone} from '../mutations/paths'
import {
  noopValidator,
  type DocumentValidator,
  type StrongReferenceIssue,
  type ValidationIssue,
} from '../mutations/ports'
import {resolveDraft, resolvePublished} from '../mutations/resolve'
import {
  applySyntheticSystemFields,
  createDocumentRecord,
  createLocalVersion,
  documentIdFor,
  withRecord,
  type OverlayState,
} from '../mutations/state'
import {
  applyTransaction,
  commitTransform,
  type TransactionCommit,
  type TransactionOptions,
} from '../mutations/transaction'

export interface ActionOptions extends TransactionOptions {
  /** PRD §17.3 step 9 / §20.5 validation port. Defaults to "no issues". */
  validate?: DocumentValidator
  /**
   * PRD §18.10 — branch-only live edit mode. The flag exists; the feature does
   * not. `[LATER]`, disabled by default; enabling it currently raises.
   */
  liveEdit?: boolean
}

/** Result of a document action. */
export interface ActionResult extends TransactionCommit {
  /**
   * Strong references the action affected but did not block on — §18.6
   * "Reevaluate strong references that point to the now-unpublished document".
   */
  affectedStrongReferences?: StrongReferenceIssue[]
}

function actionContext(state: OverlayState, options: ActionOptions): MutationContext {
  return {
    now: options.now,
    actor: options.actor,
    overlayRevision: state.revision + 1,
    ...(options.base === undefined ? {} : {base: options.base}),
    ...(options.merge === undefined ? {} : {merge: options.merge}),
    ...(options.checkStrongReferences === undefined
      ? {}
      : {checkStrongReferences: options.checkStrongReferences}),
  }
}

/**
 * The record an action operates on, captured from base on first touch so an
 * action works on an untouched base document exactly as a patch does (PRD §13.3).
 */
function requireRecord(
  state: OverlayState,
  logicalId: string,
  context: MutationContext,
): OverlayDocumentRecord {
  return ensureRecord(state, logicalId, context)
}

function assertLiveEditDisabled(options: ActionOptions, action: string): void {
  if (options.liveEdit === true) {
    // §18.10: `[LATER]`, must be disabled by default and is not implemented.
    throw new OverlayActionBlockedError(
      action,
      'live-edit-not-implemented',
      'Live edit mode is [LATER] in PRD §18.10; the flag exists but the behaviour is not implemented',
      {},
    )
  }
}

/* ------------------------------------------------------------------ *
 * §18.4 Edit
 * ------------------------------------------------------------------ */

export interface EditInput {
  /** Logical document ID (a `drafts.` prefix is normalized away). */
  id: string
  operations: OverlayOperation[]
}

/**
 * PRD §18.4 — edit.
 *
 * Editing base published, base draft, or a branch-created published document all
 * create or update the **local draft**; autosave never changes local published
 * unless live edit mode is explicitly enabled (§18.4, §18.10). The action is
 * therefore a `patch` against the `drafts.` form of the ID.
 */
export function edit(state: OverlayState, input: EditInput, options: ActionOptions): ActionResult {
  assertLiveEditDisabled(options, 'edit')
  const logicalId = toPublishedId(input.id)
  const mutation: OverlayMutation = {
    type: 'patch',
    id: `drafts.${logicalId}`,
    operations: input.operations,
  }
  return applyTransaction(state, [mutation], options)
}

/* ------------------------------------------------------------------ *
 * §18.5 Publish
 * ------------------------------------------------------------------ */

export interface DocumentActionInput {
  id: string
}

/** Validation errors block; warnings do not (PRD §17.4 severity table). */
function assertValid(
  document: SanityDocument,
  logicalId: string,
  action: string,
  options: ActionOptions,
): void {
  const validator: DocumentValidator = options.validate ?? noopValidator
  const issues: readonly ValidationIssue[] = validator(document, {logicalId, action})
  const errors = issues.filter((issue) => issue.level === 'error')
  if (errors.length > 0) {
    throw new OverlayActionBlockedError(
      action,
      'schema-validation-error',
      `${action} blocked: ${errors.length} schema validation error(s) on ${JSON.stringify(
        logicalId,
      )} (PRD §18.5, §17.4)`,
      {documentId: logicalId, issues: errors},
    )
  }
}

/**
 * PRD §18.5 — branch publish.
 *
 * Validates the resolved local draft and its strong references, copies the
 * resolved draft into local published, removes the local draft, clears the
 * published tombstone, and emits one branch transaction. It never calls Sanity
 * publish — the overlay has no write credential (§34.15).
 */
export function publish(
  state: OverlayState,
  input: DocumentActionInput,
  options: ActionOptions,
): ActionResult {
  const logicalId = toPublishedId(input.id)
  const context = actionContext(state, options)
  const record = requireRecord(state, logicalId, context)

  const resolved = resolveDraft(state, logicalId, context)
  if (resolved === null) {
    throw new OverlayMutationError(
      'OVERLAY_DOCUMENT_NOT_FOUND',
      `Document ${JSON.stringify(logicalId)} has no resolvable draft to publish`,
      {logicalId},
    )
  }

  assertValid(resolved, logicalId, 'publish', options)

  // §19.5: a strong reference to a branch draft-only target blocks branch publish.
  const blocking = blockingStrongReferences(state, logicalId, 'publish', {
    ...context,
    transactionDocumentIds: [logicalId],
  })
  if (blocking.length > 0) {
    throw new OverlayActionBlockedError(
      'publish',
      'strong-reference-invalid',
      `Publishing ${JSON.stringify(logicalId)} is blocked by ${blocking.length} unpublished strong reference target(s) (PRD §18.5, §19.5, invariant §34.10)`,
      {documentId: logicalId, references: blocking},
    )
  }

  return commitTransform(state, options, (current, mutationContext) => {
    const now = mutationContext.now()
    const overlayRevision = mutationContext.overlayRevision ?? current.revision + 1
    const draft = record.local.draft

    const materialized = applySyntheticSystemFields({
      document: deepClone(resolved),
      documentId: documentIdFor(logicalId, 'published'),
      overlayRevision,
      now,
      ...(record.local.published?.materialized._createdAt === undefined
        ? {}
        : {createdAt: record.local.published.materialized._createdAt}),
    })

    const published = createLocalVersion({
      materialized,
      touchedPaths: deepClone(draft?.touchedPaths ?? record.local.published?.touchedPaths ?? []),
      operations: deepClone(draft?.operations ?? record.local.published?.operations ?? []),
      ancestorKind: draft?.ancestorKind ?? record.local.published?.ancestorKind ?? 'base-published',
      ...(draft?.ancestorRevision === undefined
        ? {}
        : {ancestorRevision: draft.ancestorRevision}),
      overlayRevision: String(overlayRevision),
      createdAt: record.local.published?.createdAt ?? now,
      updatedAt: now,
    })

    const next: OverlayDocumentRecord = {
      ...record,
      local: {
        published,
        // §18.5 "[MUST] Remove the local draft after successful branch publish".
        draft: null,
        // §18.5 "[MUST] Clear published tombstone".
        publishedTombstone: false,
        draftTombstone: false,
      },
      runtimeRevision: materialized._rev ?? record.runtimeRevision,
      updatedAt: now,
      ...(options.actor === undefined ? {} : {updatedBy: options.actor}),
    }

    return {state: withRecord(current, next), affectedDocumentIds: [logicalId]}
  })
}

/* ------------------------------------------------------------------ *
 * §18.6 Unpublish
 * ------------------------------------------------------------------ */

/**
 * PRD §18.6 — branch unpublish.
 *
 * Creates or preserves a local draft holding the currently resolved published
 * document, then sets the published tombstone. The local published state is
 * removed only after the draft is stored — here both happen inside one committed
 * value, so the draft can never be lost. Strong references pointing at the
 * now-unpublished document are re-evaluated and **reported**, not blocked
 * (§18.6 "Reevaluate"; only publish and delete block).
 */
export function unpublish(
  state: OverlayState,
  input: DocumentActionInput,
  options: ActionOptions,
): ActionResult {
  const logicalId = toPublishedId(input.id)
  const context = actionContext(state, options)
  const record = requireRecord(state, logicalId, context)

  const resolved = resolvePublished(state, logicalId, context)
  if (resolved === null) {
    throw new OverlayMutationError(
      'OVERLAY_DOCUMENT_NOT_FOUND',
      `Document ${JSON.stringify(logicalId)} has no resolvable published version to unpublish`,
      {logicalId},
    )
  }

  const affectedStrongReferences = blockingStrongReferences(state, logicalId, 'unpublish', {
    ...context,
    transactionDocumentIds: [logicalId],
  })

  const commit = commitTransform(state, options, (current, mutationContext) => {
    const now = mutationContext.now()
    const overlayRevision = mutationContext.overlayRevision ?? current.revision + 1
    const existingDraft = record.local.draft

    const materialized = applySyntheticSystemFields({
      document: deepClone(existingDraft?.materialized ?? resolved),
      documentId: documentIdFor(logicalId, 'draft'),
      overlayRevision,
      now,
      ...(resolved._createdAt === undefined ? {} : {createdAt: resolved._createdAt}),
    })

    const draft = createLocalVersion({
      materialized,
      touchedPaths: deepClone(
        existingDraft?.touchedPaths ?? record.local.published?.touchedPaths ?? [],
      ),
      operations: deepClone(existingDraft?.operations ?? record.local.published?.operations ?? []),
      ancestorKind:
        existingDraft?.ancestorKind ??
        (record.local.published === null ? 'base-published' : 'local-published'),
      ...(existingDraft?.ancestorRevision === undefined
        ? {}
        : {ancestorRevision: existingDraft.ancestorRevision}),
      overlayRevision: String(overlayRevision),
      createdAt: existingDraft?.createdAt ?? now,
      updatedAt: now,
    })

    const next: OverlayDocumentRecord = {
      ...record,
      local: {
        draft,
        draftTombstone: false,
        // §18.6 "[MUST] Remove local published state only after the draft is
        // safely stored" — one atomic value, so the draft is stored first.
        published: null,
        publishedTombstone: true,
      },
      runtimeRevision: materialized._rev ?? record.runtimeRevision,
      updatedAt: now,
      ...(options.actor === undefined ? {} : {updatedBy: options.actor}),
    }

    return {state: withRecord(current, next), affectedDocumentIds: [logicalId]}
  })

  return {...commit, affectedStrongReferences}
}

/* ------------------------------------------------------------------ *
 * §18.7 Discard draft
 * ------------------------------------------------------------------ */

/**
 * PRD §18.7 — discard draft. Deletes local draft state together with its
 * draft-only touched paths and operations, and **does not** remove local
 * published. Perspective fallback then follows §18.2.
 */
export function discardDraft(
  state: OverlayState,
  input: DocumentActionInput,
  options: ActionOptions,
): ActionResult {
  const logicalId = toPublishedId(input.id)
  const record = requireRecord(state, logicalId, actionContext(state, options))

  return commitTransform(state, options, (current, mutationContext) => {
    const now = mutationContext.now()
    const next: OverlayDocumentRecord = {
      ...record,
      local: {
        ...record.local,
        // Dropping the version drops its touchedPaths and operations with it.
        draft: null,
        draftTombstone: false,
      },
      updatedAt: now,
      ...(options.actor === undefined ? {} : {updatedBy: options.actor}),
    }
    return {state: withRecord(current, next), affectedDocumentIds: [logicalId]}
  })
}

/* ------------------------------------------------------------------ *
 * §18.8 Delete and restore
 * ------------------------------------------------------------------ */

/**
 * PRD §18.8 — delete. Runs the incoming strong-reference check first (through the
 * injected W4 port), then sets **both** tombstones while preserving record
 * metadata for diff, recovery and promotion.
 */
export function deleteDocument(
  state: OverlayState,
  input: DocumentActionInput,
  options: ActionOptions,
): ActionResult {
  const logicalId = toPublishedId(input.id)
  const mutation: OverlayMutation = {type: 'delete', id: logicalId}
  return applyTransaction(state, [mutation], options)
}

export interface RestoreInput extends DocumentActionInput {
  /** Which tombstones to clear. Defaults to `both` (PRD §18.8 explicit restore). */
  target?: 'draft' | 'published' | 'both'
}

/**
 * PRD §18.8 — explicit restore before checkpoint cleanup. Clears the intended
 * tombstones; the preserved local versions become visible again unchanged.
 */
export function restore(
  state: OverlayState,
  input: RestoreInput,
  options: ActionOptions,
): ActionResult {
  const logicalId = toPublishedId(input.id)
  const record = requireRecord(state, logicalId, actionContext(state, options))
  const target = input.target ?? 'both'

  return commitTransform(state, options, (current, mutationContext) => {
    const now = mutationContext.now()
    const next: OverlayDocumentRecord = {
      ...record,
      local: {
        ...record.local,
        ...(target === 'draft' || target === 'both' ? {draftTombstone: false} : {}),
        ...(target === 'published' || target === 'both' ? {publishedTombstone: false} : {}),
      },
      updatedAt: now,
      ...(options.actor === undefined ? {} : {updatedBy: options.actor}),
    }
    return {state: withRecord(current, next), affectedDocumentIds: [logicalId]}
  })
}

/* ------------------------------------------------------------------ *
 * §18.9 Duplicate
 * ------------------------------------------------------------------ */

export interface DuplicateInput extends DocumentActionInput {
  /** Injected new logical ID (plan §5: no `Math.random()` inside the engine). */
  newId: string
  /** §18.9 "[MUST] Apply configured initial-value or duplicate transforms". */
  transform?: (document: SanityDocument) => SanityDocument
}

/**
 * PRD §18.9 — duplicate. New logical ID, base revision metadata removed,
 * `origin: 'branch'`, content and `_type` preserved, configured transforms
 * applied, starting as a **local draft**.
 */
export function duplicate(
  state: OverlayState,
  input: DuplicateInput,
  options: ActionOptions,
): ActionResult {
  const sourceId = toPublishedId(input.id)
  const newId = toPublishedId(input.newId)
  const context = actionContext(state, options)

  const source =
    resolveDraft(state, sourceId, context) ?? resolvePublished(state, sourceId, context)
  if (source === null) {
    throw new OverlayMutationError(
      'OVERLAY_DOCUMENT_NOT_FOUND',
      `Document ${JSON.stringify(sourceId)} cannot be resolved for duplication`,
      {logicalId: sourceId},
    )
  }

  const copy = deepClone(source)
  copy._id = `drafts.${newId}`
  // §18.9 "[MUST] Remove base revision metadata".
  delete copy._rev
  delete copy._createdAt
  delete copy._updatedAt
  const transformed = input.transform ? input.transform(copy) : copy
  transformed._id = `drafts.${newId}`
  transformed._type = source._type

  return commitTransform(
    state,
    {...options, mutations: [{type: 'create', document: transformed}]},
    (current, mutationContext) => {
      const result = applyMutation(
        current,
        {type: 'create', document: transformed},
        mutationContext,
      )
      return {state: result.state, affectedDocumentIds: result.affectedDocumentIds}
    },
  )
}

/* ------------------------------------------------------------------ *
 * Branch-created record helper
 * ------------------------------------------------------------------ */

export {createDocumentRecord}
