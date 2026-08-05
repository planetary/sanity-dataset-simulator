/**
 * `applyTransaction` — the commit boundary (PRD §13.10, §17.11, §34.5, §34.6).
 *
 * Guarantees:
 *
 * - **All-or-nothing.** Every mutation is shape-validated before any is applied,
 *   and application builds a new state value rather than mutating the input, so a
 *   failure anywhere leaves the caller's state byte-identical. There is no
 *   partial commit to roll back (plan §5, §17.11 "manifest commit remains the
 *   single visibility point").
 * - **Exactly one revision increment** per successful transaction (§34.5),
 *   regardless of how many documents it touches.
 * - **Idempotency.** `idempotencyKey` is the deduplication authority (§13.10,
 *   v1.1): a replay returns the original recorded transaction — including its
 *   original `transactionId` — and reapplies nothing, so an `inc` or an `insert`
 *   is never duplicated by a retry (§17.8, §34.6, §35.4).
 * - `transactionId` is server-assigned naming and ordering only; it never
 *   participates in deduplication (§13.10).
 */
import {checksum} from '../checksum'
import {overlayConflictSummary} from '../conflicts/persist'
import {OverlayMutationError} from '../errors'
import type {OverlayActor} from '../types/actor'
import type {OverlayConflict} from '../types/conflict'
import {OVERLAY_FORMAT_VERSION} from '../types/format-version'
import type {OverlayMutation} from '../types/operations'
import type {OverlayTransactionRecord} from '../types/transaction'
import {persistTransactionConflicts} from './conflicts'
import {applyMutation, mutationTargetId, validateMutation, type MutationContext} from './mutation'
import type {BaseDocumentSource, MergeResolver, StrongReferenceCheck} from './ports'
import {getRecord, type OverlayState} from './state'

export interface TransactionOptions {
  /** Server-assigned, lexicographically ordered by commit time (PRD §13.10). */
  transactionId: string
  /** The deduplication authority (PRD §13.10, §34.6). */
  idempotencyKey: string
  actor: OverlayActor
  /** Injected clock: called once for `requestedAt` and once for `committedAt`. */
  now: () => string
  base?: BaseDocumentSource
  merge?: MergeResolver
  allowTypeChange?: boolean
  checkStrongReferences?: StrongReferenceCheck
  requestId?: string
}

export interface TransactionCommit {
  state: OverlayState
  transaction: OverlayTransactionRecord
  /** True when the result was replayed from the idempotency ledger (PRD §34.6). */
  replayed: boolean
  /**
   * The conflicts this commit surfaced on the documents it touched — PRD §17.11
   * "the conflict is first surfaced to the writing client at commit time". They
   * are also persisted on the §13.3 records in {@link TransactionCommit.state},
   * for as long as they remain unresolved.
   *
   * Empty when the transaction carried no base view: core never fetches base
   * (§16.1), and an absent base source is not evidence of a deleted base.
   */
  conflicts: OverlayConflict[]
  /**
   * The overlay-wide §13.1 `conflictSummary` after this commit, counting
   * unresolved conflicts across every document — the same value a store adapter
   * writes into the manifest.
   */
  conflictSummary: {total: number; hard: number; soft: number}
}

/** The §13.3 conflicts a replayed transaction's documents are currently carrying. */
function persistedConflicts(
  state: OverlayState,
  affectedDocumentIds: readonly string[],
): OverlayConflict[] {
  const conflicts: OverlayConflict[] = []
  for (const logicalId of affectedDocumentIds) {
    const record = getRecord(state, logicalId)
    if (record !== null) conflicts.push(...record.conflicts)
  }
  return conflicts
}

/** The `ResolveContext` the post-commit §17.4 detection sweep runs under. */
function detectionContext(options: TransactionOptions): {
  base?: BaseDocumentSource
  merge?: MergeResolver
} {
  return {
    ...(options.base === undefined ? {} : {base: options.base}),
    ...(options.merge === undefined ? {} : {merge: options.merge}),
  }
}

/** Look up a previously committed transaction by idempotency key (PRD §34.6). */
export function findByIdempotencyKey(
  state: OverlayState,
  idempotencyKey: string,
): OverlayTransactionRecord | null {
  return state.idempotencyLedger[idempotencyKey] ?? null
}

/**
 * Apply a group of mutations atomically (PRD §13.7 "Multi-document transactions
 * group multiple mutations in one request and commit atomically").
 */
export function applyTransaction(
  state: OverlayState,
  mutations: readonly OverlayMutation[],
  options: TransactionOptions,
): TransactionCommit {
  if (typeof options.idempotencyKey !== 'string' || options.idempotencyKey.length === 0) {
    throw new OverlayMutationError(
      'OVERLAY_TRANSACTION_INVALID',
      'A transaction requires a non-empty idempotencyKey (PRD §13.10)',
      {},
    )
  }
  if (typeof options.transactionId !== 'string' || options.transactionId.length === 0) {
    throw new OverlayMutationError(
      'OVERLAY_TRANSACTION_INVALID',
      'A transaction requires a server-assigned transactionId (PRD §13.10)',
      {},
    )
  }

  /* §34.6 — one idempotency key maps to one immutable transaction result. The
     stored record is returned unchanged and nothing is reapplied. */
  const replayed = findByIdempotencyKey(state, options.idempotencyKey)
  if (replayed !== null) {
    return {
      state,
      transaction: replayed,
      replayed: true,
      conflicts: persistedConflicts(state, replayed.affectedDocumentIds),
      conflictSummary: overlayConflictSummary(state),
    }
  }

  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new OverlayMutationError(
      'OVERLAY_TRANSACTION_INVALID',
      'A transaction requires at least one mutation (PRD §13.7)',
      {},
    )
  }

  /* Phase 1 — validate every mutation before applying any. */
  for (const mutation of mutations) validateMutation(mutation)

  const requestedAt = options.now()
  const overlayRevisionBefore = state.revision
  const overlayRevisionAfter = overlayRevisionBefore + 1
  const transactionDocumentIds = mutations.map(mutationTargetId)

  const context: MutationContext = {
    now: options.now,
    actor: options.actor,
    overlayRevision: overlayRevisionAfter,
    transactionDocumentIds,
    transactionMutations: mutations,
    ...(options.base === undefined ? {} : {base: options.base}),
    ...(options.merge === undefined ? {} : {merge: options.merge}),
    ...(options.allowTypeChange === undefined
      ? {}
      : {allowTypeChange: options.allowTypeChange}),
    ...(options.checkStrongReferences === undefined
      ? {}
      : {checkStrongReferences: options.checkStrongReferences}),
  }

  /* Phase 2 — apply onto a working value. Any throw escapes before the commit
     below, leaving `state` untouched. */
  let working = state
  const affected: string[] = []
  for (const mutation of mutations) {
    const result = applyMutation(working, mutation, context)
    working = result.state
    for (const id of result.affectedDocumentIds) {
      if (!affected.includes(id)) affected.push(id)
    }
  }

  /* Phase 3 — §17.11 detection at commit time, before the checksums are taken,
     so a record's stored digest covers the conflicts it now carries (§34.4). */
  const detected = persistTransactionConflicts(working, affected, detectionContext(options))
  working = detected.state

  /* Phase 4 — commit: exactly one revision increment (§34.5). */
  const committedAt = options.now()
  const resultChecksums: Record<string, string> = {}
  for (const id of affected) {
    const record = working.documents[id]
    if (record !== undefined) resultChecksums[id] = checksum(record)
  }

  const transaction: OverlayTransactionRecord = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    transactionId: options.transactionId,
    overlayId: state.overlayId,
    overlayRevisionBefore,
    overlayRevisionAfter,
    actor: options.actor,
    requestedAt,
    committedAt,
    mutations: [...mutations],
    affectedDocumentIds: affected,
    resultChecksums,
    idempotencyKey: options.idempotencyKey,
    ...(options.requestId === undefined ? {} : {requestId: options.requestId}),
  }

  const committed: OverlayState = {
    ...working,
    revision: overlayRevisionAfter,
    transactions: [...state.transactions, transaction],
    idempotencyLedger: {...state.idempotencyLedger, [options.idempotencyKey]: transaction},
  }

  return {
    state: committed,
    transaction,
    replayed: false,
    conflicts: detected.conflicts,
    conflictSummary: overlayConflictSummary(committed),
  }
}

/**
 * Commit an arbitrary pure record transform under the same transaction rules.
 *
 * Document actions (§18.4-§18.9) do things no `OverlayMutation` expresses —
 * moving a resolved draft into local published, setting tombstones — while still
 * needing §34.5 and §34.6 to hold. They run through here so the revision
 * increments once, the transaction is logged, and a replayed idempotency key
 * short-circuits before the transform runs.
 */
export function commitTransform(
  state: OverlayState,
  options: TransactionOptions & {mutations?: readonly OverlayMutation[]},
  transform: (state: OverlayState, context: MutationContext) => {
    state: OverlayState
    affectedDocumentIds: string[]
  },
): TransactionCommit {
  const replayed = findByIdempotencyKey(state, options.idempotencyKey)
  if (replayed !== null) {
    return {
      state,
      transaction: replayed,
      replayed: true,
      conflicts: persistedConflicts(state, replayed.affectedDocumentIds),
      conflictSummary: overlayConflictSummary(state),
    }
  }

  const requestedAt = options.now()
  const overlayRevisionBefore = state.revision
  const overlayRevisionAfter = overlayRevisionBefore + 1
  const mutations = options.mutations ?? []

  const context: MutationContext = {
    now: options.now,
    actor: options.actor,
    overlayRevision: overlayRevisionAfter,
    transactionDocumentIds: mutations.map(mutationTargetId),
    transactionMutations: mutations,
    ...(options.base === undefined ? {} : {base: options.base}),
    ...(options.merge === undefined ? {} : {merge: options.merge}),
    ...(options.allowTypeChange === undefined
      ? {}
      : {allowTypeChange: options.allowTypeChange}),
    ...(options.checkStrongReferences === undefined
      ? {}
      : {checkStrongReferences: options.checkStrongReferences}),
  }

  const {state: transformed, affectedDocumentIds} = transform(state, context)

  /* §17.11 detection at commit time, before the checksums are taken (§34.4). */
  const detected = persistTransactionConflicts(
    transformed,
    affectedDocumentIds,
    detectionContext(options),
  )
  const working = detected.state

  const committedAt = options.now()
  const resultChecksums: Record<string, string> = {}
  for (const id of affectedDocumentIds) {
    const record = working.documents[id]
    if (record !== undefined) resultChecksums[id] = checksum(record)
  }

  const transaction: OverlayTransactionRecord = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    transactionId: options.transactionId,
    overlayId: state.overlayId,
    overlayRevisionBefore,
    overlayRevisionAfter,
    actor: options.actor,
    requestedAt,
    committedAt,
    mutations: [...mutations],
    affectedDocumentIds,
    resultChecksums,
    idempotencyKey: options.idempotencyKey,
    ...(options.requestId === undefined ? {} : {requestId: options.requestId}),
  }

  const committed: OverlayState = {
    ...working,
    revision: overlayRevisionAfter,
    transactions: [...state.transactions, transaction],
    idempotencyLedger: {...state.idempotencyLedger, [options.idempotencyKey]: transaction},
  }

  return {
    state: committed,
    transaction,
    replayed: false,
    conflicts: detected.conflicts,
    conflictSummary: overlayConflictSummary(committed),
  }
}
