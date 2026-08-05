/**
 * PRD §17.11 — overlay-vs-overlay race handling, as a pure three-way comparison
 * over **operations** (plan §6 scope boundary: "Phase 2 provides the pure
 * three-way overlay-head comparison function that §17.11 requires").
 *
 * This is not the §17.3 document merge, and it must not be. §17.3 reconciles
 * three *documents* — ancestor, current base, local materialized — and by the
 * time it runs the operations that produced the local document are gone. §17.11
 * asks a different question: the client submitted `requestedIntent` against the
 * head it observed, another overlay write has since moved the head, and the
 * engine must decide whether that intent can still be replayed. The answer
 * depends on the *kind* of operation, not only on the value at the path:
 *
 * - a `set` on a moved path is a genuine disagreement (`OVERLAY_SAME_PATH_CHANGED`);
 * - an `inc` on the same moved path is a delta and composes cleanly (§17.8);
 * - a `diffMatchPatch` on the same moved path can never be replayed at all,
 *   because its hunks name an observed string that no longer exists (§17.9).
 *
 * A document-level merge collapses all three into "the value changed" and gets
 * two of them wrong.
 *
 * §17.11's eight `[MUST]`s land as follows. Seven are answered here; the last —
 * "manifest commit remains the single visibility point" — is the transaction
 * boundary in `mutations/transaction.ts`, and the idempotency rule is enforced
 * for real by the ledger there. This function honours it by refusing to replay
 * anything under a key that is already committed.
 *
 * Pure and total: no clock (`now` is injected), no ID source, no input mutated,
 * and every returned document is a fresh value.
 */
import {createConflict} from '../conflicts/create'
import {canonicalEquals} from '../serialize'
import type {OverlayConflict, OverlayConflictType} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayOperation} from '../types/operations'
import {isKeySegment, type OverlayPath} from '../types/path'
import {applyOperations} from '../mutations/operations'
import {deepClone, getAtPath} from '../mutations/paths'

/** One side of the race: a document plus the revision that names it (PRD §17.11). */
export interface OverlayHead {
  /**
   * The revision the head is known by — a §13.9 synthetic `_rev` or the ETag a
   * §25.5 precondition carried. Compared as an opaque string.
   */
  revision: string
  document: SanityDocument
}

export interface OverlayHeadComparisonRequest {
  /** Logical ID stamped on any conflict raised (§13.11). */
  documentId: string
  /** Injected clock value used as `OverlayConflict.detectedAt` (§13.11). */
  now: string
  /** §17.11 `clientObserved` — the revision the request was based on. */
  clientObserved: OverlayHead
  /** §17.11 `currentOverlay` — the revision after another overlay write. */
  currentOverlay: OverlayHead
  /** §17.11 `requestedIntent` — the operations the client submitted. */
  requestedIntent: readonly OverlayOperation[]
  /** The submitting request's idempotency key (§13.10). */
  idempotencyKey?: string
  /** Keys already committed on this overlay — the §34.6 ledger's key set. */
  committedIdempotencyKeys?: readonly string[]
}

export interface OverlayHeadComparison {
  /** False when `clientObserved.revision` still names the current head: no race. */
  stale: boolean
  /**
   * True when the request's idempotency key is already committed. §17.11 "numeric
   * operations are never applied twice under the same idempotency key" — so
   * nothing is replayed and nothing conflicts; the original result stands (§34.6).
   */
  replayed: boolean
  /** True when the whole intent can be retried automatically (§17.11 rules 2, 4). */
  safe: boolean
  /** §17.11 "the client receives the current head…" — a defensive copy. */
  currentHead: SanityDocument
  /** §17.11 "…the requested intent…" — a defensive copy. */
  requestedIntent: OverlayOperation[]
  /** §17.11 "…and the conflict path", one per refused operation, in request order. */
  conflictPaths: OverlayPath[]
  /** The §13.11 conflict records behind `conflictPaths`. */
  conflicts: OverlayConflict[]
  /** The subset of the intent that may be replayed against the current head. */
  retryOperations: OverlayOperation[]
  /**
   * The document `retryOperations` produce when applied to the current head, or
   * `null` when the retry is unsafe or there is nothing to replay. A caller that
   * wants a partial application drives `retryOperations` itself — §17.11 asks for
   * a decision, not for a half-committed document.
   */
  document: SanityDocument | null
}

/* ------------------------------------------------------------------ *
 * Per-operation verdicts
 * ------------------------------------------------------------------ */

interface Refusal {
  path: OverlayPath
  type: OverlayConflictType
  observedValue: unknown
  currentValue: unknown
  requestedValue: unknown
}

/** The path an operation writes to; `[]` for a whole-document replacement. */
function operationPath(operation: OverlayOperation): OverlayPath {
  return operation.type === 'replaceDocument' ? [] : operation.path
}

/** The value the operation asks for, for the §13.11 `localValue` column. */
function requestedValue(operation: OverlayOperation): unknown {
  switch (operation.type) {
    case 'set':
    case 'setIfMissing':
      return operation.value
    case 'insert':
      return operation.items
    case 'inc':
      return operation.amount
    case 'dec':
      return -operation.amount
    case 'diffMatchPatch':
      return operation.patch
    case 'replaceDocument':
      return operation.document
    default:
      return undefined
  }
}

/** Did the two heads disagree about the value at `path`? */
function movedAt(request: OverlayHeadComparisonRequest, path: OverlayPath): boolean {
  const observed = getAtPath(request.clientObserved.document, path)
  const current = getAtPath(request.currentOverlay.document, path)
  if (observed.exists !== current.exists) return true
  return !canonicalEquals(observed.value, current.value)
}

/** The array an `insert` targets: the path without its trailing anchor segment. */
function insertArrayPath(path: OverlayPath): OverlayPath {
  if (path.length === 0) return path
  const last = path[path.length - 1]!
  return isKeySegment(last) || typeof last === 'number' ? path.slice(0, -1) : path
}

function keysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const keys: string[] = []
  for (const item of value) {
    if (item !== null && typeof item === 'object' && typeof (item as {_key?: unknown})._key === 'string') {
      keys.push((item as {_key: string})._key)
    }
  }
  return keys
}

/**
 * §17.11 "array insertions merge only when keys and anchors remain valid".
 *
 * Three ways an insertion stops being valid:
 *
 * 1. a keyed anchor the other head deleted — the insertion has nowhere to go
 *    (`ARRAY_ITEM_DELETED`, hard per §17.4);
 * 2. a `_key` the other head has since used — replaying would duplicate it
 *    (`ARRAY_KEY_COLLISION`, hard per §17.4, invariant §17.7);
 * 3. a *numeric* anchor in an array that moved — an index names a position, not
 *    an item, so any change to the array silently re-targets the insertion
 *    (§35.3 case 10). Only an untouched array keeps a numeric anchor honest.
 */
function classifyInsert(
  request: OverlayHeadComparisonRequest,
  operation: Extract<OverlayOperation, {type: 'insert'}>,
): Refusal | null {
  const arrayPath = insertArrayPath(operation.path)
  const anchor = operation.path.length > arrayPath.length ? operation.path[operation.path.length - 1]! : null
  const currentArray = getAtPath(request.currentOverlay.document, arrayPath)

  if (anchor !== null && isKeySegment(anchor)) {
    if (!getAtPath(request.currentOverlay.document, operation.path).exists) {
      return {
        path: operation.path,
        type: 'ARRAY_ITEM_DELETED',
        observedValue: getAtPath(request.clientObserved.document, operation.path).value,
        currentValue: undefined,
        requestedValue: operation.items,
      }
    }
  }

  const taken = new Set(keysOf(currentArray.value))
  const observedKeys = new Set(keysOf(getAtPath(request.clientObserved.document, arrayPath).value))
  for (const key of keysOf(operation.items)) {
    // A key the other head introduced (not one the client already saw) is a
    // genuine collision; a key both heads already had is the client's own item.
    if (taken.has(key) && !observedKeys.has(key)) {
      return {
        path: operation.path,
        type: 'ARRAY_KEY_COLLISION',
        observedValue: [...observedKeys],
        currentValue: [...taken],
        requestedValue: operation.items,
      }
    }
  }

  if (anchor !== null && typeof anchor === 'number' && movedAt(request, arrayPath)) {
    return {
      path: operation.path,
      type: 'OVERLAY_SAME_PATH_CHANGED',
      observedValue: getAtPath(request.clientObserved.document, arrayPath).value,
      currentValue: currentArray.value,
      requestedValue: operation.items,
    }
  }

  // `position: 'replace'` overwrites the anchored item, so a moved item is a
  // straight same-path disagreement.
  if (operation.position === 'replace' && movedAt(request, operation.path)) {
    return {
      path: operation.path,
      type: 'OVERLAY_SAME_PATH_CHANGED',
      observedValue: getAtPath(request.clientObserved.document, operation.path).value,
      currentValue: getAtPath(request.currentOverlay.document, operation.path).value,
      requestedValue: operation.items,
    }
  }

  return null
}

/** Decide one operation. `null` means "safe to replay against the current head". */
function classify(
  request: OverlayHeadComparisonRequest,
  operation: OverlayOperation,
): Refusal | null {
  const path = operationPath(operation)
  const observed = getAtPath(request.clientObserved.document, path)
  const current = getAtPath(request.currentOverlay.document, path)
  const samePath = (type: OverlayConflictType): Refusal => ({
    path,
    type,
    observedValue: observed.value,
    currentValue: current.value,
    requestedValue: requestedValue(operation),
  })

  switch (operation.type) {
    case 'replaceDocument':
      // The intent is the whole document, so *any* divergence between the heads
      // is a divergence the replacement would silently discard.
      return canonicalEquals(request.clientObserved.document, request.currentOverlay.document)
        ? null
        : samePath('OVERLAY_SAME_PATH_CHANGED')

    case 'inc':
    case 'dec': {
      // §17.8: a delta composes with any other delta, so a moved number is not a
      // disagreement — but a *retyped* member is, because there is nothing to add to.
      if (!current.exists || typeof current.value !== 'number') {
        return samePath('BASE_TYPE_CHANGED')
      }
      return null
    }

    case 'diffMatchPatch':
      // §17.11: "text diffs are never replayed against a different observed string".
      return movedAt(request, path) ? samePath('OVERLAY_SAME_PATH_CHANGED') : null

    case 'insert':
      return classifyInsert(request, operation)

    case 'set':
    case 'setIfMissing':
    case 'unset':
    default:
      return movedAt(request, path) ? samePath('OVERLAY_SAME_PATH_CHANGED') : null
  }
}

/* ------------------------------------------------------------------ *
 * compareOverlayHeads
 * ------------------------------------------------------------------ */

/**
 * Compare two overlay heads against a submitted intent (PRD §17.11).
 *
 * The three-way shape is `clientObserved` (the shared ancestor of this race),
 * `currentOverlay` (the other head) and `requestedIntent` (this head's proposal).
 */
export function compareOverlayHeads(
  request: OverlayHeadComparisonRequest,
): OverlayHeadComparison {
  const intent = deepClone([...request.requestedIntent]) as OverlayOperation[]
  const currentHead = deepClone(request.currentOverlay.document)
  const stale = request.clientObserved.revision !== request.currentOverlay.revision

  /* §17.11 / §34.6 — a committed key is a replay: nothing is reapplied, so an
     `inc` cannot be counted twice and an `insert` cannot be duplicated. */
  const committed = request.committedIdempotencyKeys ?? []
  if (request.idempotencyKey !== undefined && committed.includes(request.idempotencyKey)) {
    return {
      stale,
      replayed: true,
      safe: true,
      currentHead,
      requestedIntent: intent,
      conflictPaths: [],
      conflicts: [],
      retryOperations: [],
      document: null,
    }
  }

  const retryOperations: OverlayOperation[] = []
  const conflictPaths: OverlayPath[] = []
  const conflicts: OverlayConflict[] = []

  for (const operation of intent) {
    const refusal = classify(request, operation)
    if (refusal === null) {
      retryOperations.push(deepClone(operation) as OverlayOperation)
      continue
    }
    conflictPaths.push(deepClone(refusal.path) as OverlayPath)
    conflicts.push(
      createConflict({
        documentId: request.documentId,
        type: refusal.type,
        detectedAt: request.now,
        path: refusal.path,
        ...(refusal.observedValue === undefined ? {} : {ancestorValue: refusal.observedValue}),
        ...(refusal.currentValue === undefined ? {} : {baseValue: refusal.currentValue}),
        ...(refusal.requestedValue === undefined ? {} : {localValue: refusal.requestedValue}),
      }),
    )
  }

  const safe = conflicts.length === 0
  return {
    stale,
    replayed: false,
    safe,
    currentHead,
    requestedIntent: intent,
    conflictPaths,
    conflicts,
    retryOperations,
    document:
      safe && retryOperations.length > 0
        ? applyOperations(deepClone(request.currentOverlay.document), retryOperations).document
        : null,
  }
}
