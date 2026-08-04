/**
 * PRD §19.6 (ID changes), §19.7 (type changes) and §20.4 (`OverlayMigration`).
 *
 * ```text
 * §19.6
 * [MUST] `_id` is immutable within one overlay document lineage.
 * [MUST] Changing an ID creates a new document and a migration plan for incoming references.
 * [MUST] Do not automatically crawl and rewrite references without showing the migration plan.
 * [MUST] Preserve old ID tombstone when required to suppress the base document.
 *
 * §19.7
 * [MUST] Treat `_type` change as a migration.
 * [MUST] Validate all references whose allowed `to` types may reject the new type.
 * [MUST] Block promotion until migration and validation pass.
 * ```
 *
 * **Nothing here writes.** `planIdMigration` and `planTypeMigration` are pure
 * functions from state to a plan; `applyMigration` exists as a separate, explicit
 * call so "do not automatically crawl and rewrite" is enforced by the shape of the
 * API rather than by convention. A plan is data — it can be serialized to
 * `.sanity-overlay/migrations/<migration-id>.json` (§20.4) and reviewed before
 * anything is committed.
 *
 * **Why one transaction.** An ID migration deletes the old logical document while
 * referrers still point at it, which §18.8 blocks — *unless the same transaction
 * updates or deletes all referring documents*. The plan orders its operations as
 * create → rewrite every referrer → delete the old ID, so applying it as one
 * transaction satisfies that exemption exactly. Applying it piecemeal does not,
 * and must not.
 *
 * `OverlayMigration` is declared here rather than in `types/` because §20.4 is
 * reference-and-schema machinery; when W1 adopts it, this declaration is the one
 * to move.
 */
import {DRAFTS_PREFIX, toPublishedId} from '../encoding'
import type {OverlayActor} from '../types/actor'
import type {SanityDocument} from '../types/document'
import type {OverlayMutation, OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import {deepClone} from '../mutations/paths'
import {resolveDraft, resolvePublished} from '../mutations/resolve'
import type {OverlayState} from '../mutations/state'
import {applyTransaction, type TransactionCommit, type TransactionOptions} from '../mutations/transaction'
import {referenceRuleAt} from '../validation/schema'
import {incomingReferenceGraph, type ReferenceIntegrityContext} from './integrity'
import type {ReverseReference} from './reverse'
import {OverlayReferenceError, type ReferenceStrength} from './types'

/* ------------------------------------------------------------------ *
 * PRD §20.4 — content migration files
 * ------------------------------------------------------------------ */

export interface OverlayMigrationOperation {
  documentId: string
  description: string
  mutations: OverlayMutation[]
}

/** PRD §20.4 `OverlayMigration`, verbatim. */
export interface OverlayMigration {
  id: string
  title: string
  schemaCommitBefore?: string
  schemaCommitAfter: string
  affectedTypes: string[]
  operations: OverlayMigrationOperation[]
  createdAt: string
  createdBy: OverlayActor
}

/** Context every plan builder needs: reference inputs plus a deterministic stamp. */
export interface MigrationPlanContext extends ReferenceIntegrityContext {
  actor: OverlayActor
  /** Injected clock — no `Date.now()` inside the engine. */
  now: () => string
  /** PRD §20.1. Defaults to the injected artifact's `schemaCommit`. */
  schemaCommitAfter?: string
  schemaCommitBefore?: string
}

interface MigrationPlanBase {
  incomingReferences: readonly ReverseReference[]
  incompatibleReferences: readonly TypeMigrationIncompatibility[]
  /** False when §19.7 validation found a reference the new type would break. */
  compatible: boolean
  migration: OverlayMigration
}

export interface IdMigrationPlan extends MigrationPlanBase {
  kind: 'id'
  fromId: string
  toId: string
  /** §19.6 "Preserve old ID tombstone when required to suppress the base document". */
  preservesOldIdTombstone: boolean
}

export interface TypeMigrationIncompatibility {
  referringDocumentId: string
  /** Schema type of the *referring* document, whose field rule was consulted. */
  referringType: string
  path: OverlayPath
  /** The field's allowed `to` types (PRD §19.7). */
  allowedTypes: string[]
  strength: ReferenceStrength
}

export interface TypeMigrationPlan extends MigrationPlanBase {
  kind: 'type'
  documentId: string
  fromType: string
  toType: string
}

export type OverlayMigrationPlan = IdMigrationPlan | TypeMigrationPlan

function migrationError(
  code: 'OVERLAY_ID_CHANGE_NOT_ALLOWED' | 'OVERLAY_MIGRATION_INVALID',
  message: string,
  details: Record<string, unknown>,
): OverlayReferenceError {
  return new OverlayReferenceError(code, message, details)
}

/**
 * PRD §19.6 — `_id` is immutable within one overlay document lineage.
 *
 * The draft and published forms of one logical document are the same lineage, so
 * `drafts.x` and `x` are the same `_id` for this rule.
 */
export function assertIdImmutable(currentId: string, nextId: string): void {
  if (toPublishedId(currentId) === toPublishedId(nextId)) return
  throw migrationError(
    'OVERLAY_ID_CHANGE_NOT_ALLOWED',
    `\`_id\` is immutable within one overlay document lineage; changing ${JSON.stringify(
      currentId,
    )} to ${JSON.stringify(nextId)} is a new document plus a migration plan (PRD §19.6)`,
    {from: currentId, to: nextId},
  )
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function resolveEither(
  state: OverlayState,
  logicalId: string,
  context: MigrationPlanContext,
): {document: SanityDocument; version: 'published' | 'draft'} | null {
  const resolveContext = context.base === undefined ? {} : {base: context.base}
  const published = resolvePublished(state, logicalId, resolveContext)
  if (published !== null) return {document: published, version: 'published'}
  const draft = resolveDraft(state, logicalId, resolveContext)
  if (draft !== null) return {document: draft, version: 'draft'}
  return null
}

function typeOf(
  state: OverlayState,
  logicalId: string,
  context: MigrationPlanContext,
): string | undefined {
  return resolveEither(state, logicalId, context)?.document._type
}

function schemaCommits(context: MigrationPlanContext): Pick<
  OverlayMigration,
  'schemaCommitAfter'
> & {schemaCommitBefore?: string} {
  const after = context.schemaCommitAfter ?? context.schema?.schemaCommit ?? ''
  return {
    schemaCommitAfter: after,
    ...(context.schemaCommitBefore === undefined
      ? {}
      : {schemaCommitBefore: context.schemaCommitBefore}),
  }
}

/* ------------------------------------------------------------------ *
 * §19.6 — ID migration
 * ------------------------------------------------------------------ */

export interface IdMigrationInput {
  fromId: string
  toId: string
  /** Deterministic plan ID — core generates no randomness. */
  migrationId: string
  title?: string
}

/**
 * Plan an ID change (PRD §19.6). Returns the plan; applies nothing.
 *
 * Referrers are rewritten by setting `<path>._ref` rather than replacing the whole
 * reference object, so `_key`, `_weak` and any custom fields on the reference node
 * survive the migration untouched.
 */
export function planIdMigration(
  state: OverlayState,
  input: IdMigrationInput,
  context: MigrationPlanContext,
): IdMigrationPlan {
  const fromId = toPublishedId(input.fromId)
  const toId = toPublishedId(input.toId)

  if (fromId === toId) {
    throw migrationError(
      'OVERLAY_MIGRATION_INVALID',
      `An ID migration must change the logical ID; ${JSON.stringify(fromId)} was given twice (PRD §19.6)`,
      {fromId, toId},
    )
  }

  const source = resolveEither(state, fromId, context)
  if (source === null) {
    throw migrationError(
      'OVERLAY_MIGRATION_INVALID',
      `Document ${JSON.stringify(fromId)} does not resolve, so there is nothing to migrate (PRD §19.6)`,
      {fromId, toId},
    )
  }
  if (resolveEither(state, toId, context) !== null) {
    throw migrationError(
      'OVERLAY_MIGRATION_INVALID',
      `Target ID ${JSON.stringify(toId)} already exists in the virtual dataset (PRD §13.11 LOCAL_ID_COLLISION)`,
      {fromId, toId},
    )
  }

  const incomingReferences = incomingReferenceGraph(state, fromId, context)

  /* 1 — the new document. Base revision metadata never travels with it. */
  const document = deepClone(source.document)
  document._id = source.version === 'draft' ? `${DRAFTS_PREFIX}${toId}` : toId
  delete document._rev
  delete document._createdAt
  delete document._updatedAt

  const operations: OverlayMigrationOperation[] = [
    {
      documentId: toId,
      description: `Create ${toId} from ${fromId} (PRD §19.6: an ID change is a new document)`,
      mutations: [{type: 'create', document}],
    },
  ]

  /* 2 — one patch per referring document, rewriting every `_ref` it holds. */
  const byReferrer = new Map<string, OverlayOperation[]>()
  for (const reference of incomingReferences) {
    const bucket = byReferrer.get(reference.referringDocumentId) ?? []
    bucket.push({type: 'set', path: [...reference.path, '_ref'], value: toId})
    byReferrer.set(reference.referringDocumentId, bucket)
  }
  for (const [referringDocumentId, ops] of byReferrer) {
    operations.push({
      documentId: referringDocumentId,
      description: `Repoint ${ops.length} reference(s) in ${referringDocumentId} from ${fromId} to ${toId}`,
      mutations: [{type: 'patch', id: referringDocumentId, operations: ops}],
    })
  }

  /* 3 — retire the old ID. A tombstone is what suppresses a base document
     (§19.6, §34.2); for a branch-created source it merely removes the record. */
  const preservesOldIdTombstone =
    context.base !== undefined &&
    (context.base.getPublished(fromId) !== null || context.base.getDraft(fromId) !== null)

  operations.push({
    documentId: fromId,
    description: preservesOldIdTombstone
      ? `Tombstone ${fromId} so the base document stays suppressed (PRD §19.6)`
      : `Remove the branch-created ${fromId}`,
    mutations: [{type: 'delete', id: fromId}],
  })

  const referringTypes = incomingReferences
    .map((reference) => typeOf(state, reference.referringDocumentId, context))
    .filter((name): name is string => name !== undefined)

  return {
    kind: 'id',
    fromId,
    toId,
    preservesOldIdTombstone,
    incomingReferences,
    incompatibleReferences: [],
    compatible: true,
    migration: {
      id: input.migrationId,
      title: input.title ?? `Rename ${fromId} to ${toId}`,
      ...schemaCommits(context),
      affectedTypes: sortedUnique([source.document._type, ...referringTypes]),
      operations,
      createdAt: context.now(),
      createdBy: context.actor,
    },
  }
}

/* ------------------------------------------------------------------ *
 * §19.7 — type migration
 * ------------------------------------------------------------------ */

export interface TypeMigrationInput {
  documentId: string
  toType: string
  migrationId: string
  title?: string
}

/**
 * Plan a `_type` change (PRD §19.7). Returns the plan; applies nothing.
 *
 * Every incoming reference is validated against the referring field's allowed `to`
 * list. A path the artifact says nothing about yields **no rule**, never a
 * violation — an unknown type or an unmodelled field cannot reject anything.
 */
export function planTypeMigration(
  state: OverlayState,
  input: TypeMigrationInput,
  context: MigrationPlanContext,
): TypeMigrationPlan {
  const documentId = toPublishedId(input.documentId)
  const source = resolveEither(state, documentId, context)
  if (source === null) {
    throw migrationError(
      'OVERLAY_MIGRATION_INVALID',
      `Document ${JSON.stringify(documentId)} does not resolve, so there is nothing to migrate (PRD §19.7)`,
      {documentId, toType: input.toType},
    )
  }

  const fromType = source.document._type
  if (fromType === input.toType) {
    throw migrationError(
      'OVERLAY_MIGRATION_INVALID',
      `A type migration must change \`_type\`; ${JSON.stringify(fromType)} was given twice (PRD §19.7)`,
      {documentId, toType: input.toType},
    )
  }

  const incomingReferences = incomingReferenceGraph(state, documentId, context)

  const incompatibleReferences: TypeMigrationIncompatibility[] = []
  for (const reference of incomingReferences) {
    const referringType = typeOf(state, reference.referringDocumentId, context)
    if (referringType === undefined) continue
    const rule = referenceRuleAt(context.schema, referringType, reference.path)
    if (rule === null || rule.to.length === 0) continue
    if (rule.to.includes(input.toType)) continue
    incompatibleReferences.push({
      referringDocumentId: reference.referringDocumentId,
      referringType,
      path: reference.path,
      allowedTypes: rule.to,
      strength: reference.strength,
    })
  }

  /* §17.10 / §20.2: a `_type` change is a full document replacement carrying
     explicit intent, never an in-place `set` on the protected `_type` field. */
  const replacement = deepClone(source.document)
  replacement._type = input.toType
  delete replacement._rev

  return {
    kind: 'type',
    documentId,
    fromType,
    toType: input.toType,
    incomingReferences,
    incompatibleReferences,
    compatible: incompatibleReferences.length === 0,
    migration: {
      id: input.migrationId,
      title: input.title ?? `Change ${documentId} from ${fromType} to ${input.toType}`,
      ...schemaCommits(context),
      affectedTypes: sortedUnique([fromType, input.toType]),
      operations: [
        {
          documentId,
          description: `Replace ${documentId} with \`_type\` ${input.toType} (PRD §19.7, §17.10)`,
          mutations: [
            {
              type: 'patch',
              id: source.version === 'draft' ? `${DRAFTS_PREFIX}${documentId}` : documentId,
              operations: [{type: 'replaceDocument', document: replacement}],
            },
          ],
        },
      ],
      createdAt: context.now(),
      createdBy: context.actor,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Using a plan
 * ------------------------------------------------------------------ */

/**
 * PRD §19.7 "[MUST] Block promotion until migration and validation pass."
 *
 * Returns the plan so it can be used inline; throws when a reference rule rejects
 * the new type.
 */
export function assertMigrationValid<T extends OverlayMigrationPlan>(plan: T): T {
  if (plan.compatible) return plan
  throw migrationError(
    'OVERLAY_MIGRATION_INVALID',
    `Migration ${JSON.stringify(plan.migration.id)} is blocked by ${
      plan.incompatibleReferences.length
    } reference target definition(s) that reject the new type (PRD §19.7)`,
    {
      ...(plan.kind === 'type'
        ? {documentId: plan.documentId, toType: plan.toType}
        : {fromId: plan.fromId, toId: plan.toId}),
      incompatibleReferences: plan.incompatibleReferences,
    },
  )
}

/** Flatten a §20.4 migration into the mutation list it commits as, in order. */
export function migrationMutations(migration: OverlayMigration): OverlayMutation[] {
  return migration.operations.flatMap((operation) => operation.mutations)
}

/**
 * Commit an approved migration as **one** transaction.
 *
 * One transaction is not an optimization: it is what makes the plan legal under
 * §18.8, because every referrer of the deleted ID is updated by the same
 * transaction.
 */
export function applyMigration(
  state: OverlayState,
  migration: OverlayMigration,
  options: TransactionOptions,
): TransactionCommit {
  return applyTransaction(state, migrationMutations(migration), options)
}
