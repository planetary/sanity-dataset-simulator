/**
 * `applyOperation` — every PRD §13.7 `OverlayOperation` variant (plan §5).
 *
 * Each application is pure: the input document is never mutated, and the result
 * carries both the new document and the {@link OverlayPath}s the operation
 * touched, computed under the §17.6 object rules and the §17.7 array rules.
 *
 * Semantics per variant:
 *
 * | Operation | Behaviour | Touched paths |
 * |---|---|---|
 * | `set` | Write, auto-vivifying missing intermediate objects/arrays | the path (its subtree, §17.6) |
 * | `setIfMissing` | No-op when the value is already present (§35.4) | none on no-op |
 * | `unset` | Remove; recorded even when already absent (§17.5) | the path |
 * | `insert` | `before`/`after`/`replace` at a `_key` anchor, a numeric anchor, or the array itself (§17.7) | inserted item keys, or the whole array when non-keyed |
 * | `inc`/`dec` | Read-modify-write to a resulting local value, original op kept as metadata (§17.8) | the path |
 * | `diffMatchPatch` | Exact patch application to the observed string (§17.9) | the path |
 * | `replaceDocument` | Whole-document replacement (§17.10) | every user field, old and new |
 */
import {OverlayMutationError, OverlayPathError, OverlayPrototypeKeyError} from '../errors'
import {encodeOverlayPath} from '../encoding'
import {isForbiddenKey} from '../serialize'
import type {SanityDocument} from '../types/document'
import type {OverlayOperation} from '../types/operations'
import {isKeySegment, type OverlayPath} from '../types/path'
import {applyDiffMatchPatch} from './diff-match-patch'
import {
  deepClone,
  getAtPath,
  indexOfKey,
  isPathPrefix,
  isPlainObject,
  setAtPath,
  touchedPathFor,
  updateAtPath,
} from './paths'

/** System fields that a patch may never rewrite; they follow the §13.9 policy. */
export const PROTECTED_SYSTEM_FIELDS = Object.freeze(['_id', '_rev', '_createdAt'] as const)

export interface ApplyOperationOptions {
  /**
   * PRD §17.10 "[MUST] Require explicit intent for `_type` changes". A
   * `replaceDocument` whose `_type` differs from the current document is refused
   * unless the caller opts in here.
   */
  allowTypeChange?: boolean
}

export interface AppliedOperation {
  document: SanityDocument
  /** Paths this operation claims as locally owned (PRD §13.5 `touchedPaths`). */
  touchedPaths: OverlayPath[]
  /** True when the operation left the document unchanged (`setIfMissing` hit). */
  noop: boolean
  /**
   * PRD §17.8: the value `inc`/`dec` resolved to. The original operation is
   * retained separately in `LocalDocumentVersion.operations`, so a retry can see
   * that the increment was already folded into the materialized value.
   */
  resultValue?: unknown
  /**
   * The operation as it must be RECORDED, when that differs from the input.
   * §13.6 canonical paths cannot spell a negative array index, but Content
   * Lake insert anchors may be negative (`after: tags[-1]` is Studio's "Add
   * item"). The insert applies against the live array, so this carries the
   * same operation re-anchored at the resolved non-negative index — storing
   * the raw one instead crashes the NEXT hydration inside `encodeOverlayPath`,
   * long after the write reported success (found live 2026-08-11: the
   * structure tool crashed on reload while the document on disk was correct).
   */
  normalizedOperation?: OverlayOperation
}

function operationError(message: string, details: Record<string, unknown> = {}): never {
  throw new OverlayMutationError('OVERLAY_OPERATION_INVALID', message, details)
}

function assertDocument(value: unknown, context: string): SanityDocument {
  if (!isPlainObject(value)) {
    return operationError(`${context} must be an object`, {received: typeof value})
  }
  if (typeof value._id !== 'string' || value._id.length === 0) {
    return operationError(`${context} requires a non-empty string \`_id\``, {received: value._id})
  }
  if (typeof value._type !== 'string' || value._type.length === 0) {
    // PRD §13.9: `_type` is required at creation for a branch-created document.
    return operationError(`${context} requires a non-empty string \`_type\``, {
      received: value._type,
    })
  }
  return value as unknown as SanityDocument
}

/**
 * Refuse a §35.14 prototype key in ANY segment of an operation path.
 *
 * §13.6 says a string segment names an object property; §35.14 says `__proto__`,
 * `constructor` and `prototype` can never be own keys of canonical overlay JSON.
 * A path naming one therefore addresses a member the format cannot hold, and
 * §5.5 leaves exactly one legal answer: refuse it, with a code, before anything
 * is applied.
 *
 * EVERY SEGMENT, not just the root. `a.__proto__.b` is the same defect one level
 * down, and a root-only check is what let it through (security review 2026-08-06
 * P2-5): the write was applied, reported committed, and stored as `"a": {}`.
 *
 * A `{_key}` segment is exempt on purpose — its `_key` is a VALUE compared
 * against array items, never a property name, so `items[_key=="__proto__"]` is
 * ordinary content and refusing it would lose data for no reason.
 */
function assertNoPrototypeKeyInPath(path: OverlayPath): void {
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]
    if (typeof segment !== 'string' || !isForbiddenKey(segment)) continue
    throw new OverlayPrototypeKeyError(segment, [encodeOverlayPath(path.slice(0, index + 1))])
  }
}

function assertWritablePath(path: OverlayPath): void {
  if (!Array.isArray(path) || path.length === 0) {
    operationError('Operation path must be a non-empty OverlayPath (PRD §13.6)', {path})
  }
  assertNoPrototypeKeyInPath(path)
  const root = path[0]
  if (typeof root === 'string' && PROTECTED_SYSTEM_FIELDS.includes(root as never)) {
    operationError(
      `Field ${JSON.stringify(root)} is a protected system field and follows the PRD §13.9 policy; it cannot be patched directly`,
      {path: encodeOverlayPath(path)},
    )
  }
}

/** All top-level user (non-underscore) field paths of a document. */
function userFieldPaths(document: Record<string, unknown>): OverlayPath[] {
  return Object.keys(document)
    .filter((key) => !key.startsWith('_'))
    .map((key) => [key])
}

/* ------------------------------------------------------------------ *
 * insert (PRD §13.7, §17.7)
 * ------------------------------------------------------------------ */

interface InsertTarget {
  /** Path of the array container. */
  arrayPath: OverlayPath
  array: unknown[]
  /** Index of the anchor element, or `null` when the path targets the array itself. */
  anchorIndex: number | null
  /** True when the anchor was addressed by numeric index (non-keyed array, §17.7). */
  numericAnchor: boolean
}

function resolveInsertTarget(document: SanityDocument, path: OverlayPath): InsertTarget {
  const direct = getAtPath(document, path)
  if (direct.exists && Array.isArray(direct.value)) {
    return {arrayPath: path, array: direct.value, anchorIndex: null, numericAnchor: false}
  }

  const arrayPath = path.slice(0, -1)
  const last = path[path.length - 1]!
  const parent = getAtPath(document, arrayPath)
  if (!parent.exists || !Array.isArray(parent.value)) {
    throw new OverlayPathError(
      'OVERLAY_PATH_NOT_FOUND',
      `insert target ${encodeOverlayPath(path)} does not resolve to an array or an array element`,
      {path: encodeOverlayPath(path)},
    )
  }

  if (isKeySegment(last)) {
    const index = indexOfKey(parent.value, last._key)
    if (index === -1) {
      throw new OverlayPathError(
        'OVERLAY_PATH_NOT_FOUND',
        `insert anchor _key ${JSON.stringify(last._key)} is not present in ${encodeOverlayPath(
          arrayPath,
        )}`,
        {path: encodeOverlayPath(path), _key: last._key},
      )
    }
    return {arrayPath, array: parent.value, anchorIndex: index, numericAnchor: false}
  }

  if (typeof last === 'number') {
    /*
     * CONTENT LAKE SEMANTICS, NOT ARRAY-BOUNDS PEDANTRY. A negative index
     * counts from the end (`-1` is the last element), and an out-of-range
     * anchor is applied at the NEAREST VALID POSITION rather than rejected —
     * `applyInsert` clamps per position. This is load-bearing for the pinned
     * Studio: its very first Portable Text batch is `setIfMissing {body: []}`
     * + `insert {before: "body[0]"}` (anchor 0 against a length-0 array), and
     * its "Add item" button spells append as `after: tags[-1]`. Rejecting the
     * former 400'd the whole atomic batch — the editor re-buffered and
     * re-failed it forever, text on screen, disk empty (found live
     * 2026-08-11); splicing the latter literally PREPENDED.
     */
    const normalized = last < 0 ? parent.value.length + last : last
    return {arrayPath, array: parent.value, anchorIndex: normalized, numericAnchor: true}
  }

  throw new OverlayPathError(
    'OVERLAY_PATH_NOT_FOUND',
    `insert target ${encodeOverlayPath(path)} does not resolve to an array or an array element`,
    {path: encodeOverlayPath(path)},
  )
}

function itemKey(item: unknown): string | null {
  return isPlainObject(item) && typeof item._key === 'string' ? item._key : null
}

function applyInsert(
  document: SanityDocument,
  op: Extract<OverlayOperation, {type: 'insert'}>,
): AppliedOperation {
  if (!Array.isArray(op.items)) {
    return operationError('insert requires an `items` array', {received: typeof op.items})
  }
  const target = resolveInsertTarget(document, op.path)
  const items = deepClone(op.items) as unknown[]

  const next = [...target.array]
  let removedKey: string | null = null

  const clamp = (value: number, lower: number, upper: number): number =>
    Math.min(Math.max(value, lower), upper)

  /* The anchor index the recorded operation must carry: resolved against the
   * array the insert actually ran on, and never negative (§13.6). Computed
   * against `target.array` BEFORE the splice mutates `next`. */
  let recordedAnchor: number | null = null

  if (target.anchorIndex === null) {
    if (op.position === 'before') next.unshift(...items)
    else if (op.position === 'after') next.push(...items)
    else next.splice(0, next.length, ...items)
  } else if (op.position === 'before') {
    /* A `_key` anchor is always in range; the clamps only ever move a NUMERIC
     * out-of-range anchor to the nearest valid position (Content Lake
     * semantics — see resolveInsertTarget). */
    const at = clamp(target.anchorIndex, 0, next.length)
    recordedAnchor = at
    next.splice(at, 0, ...items)
  } else if (op.position === 'after') {
    const at = clamp(target.anchorIndex, -1, next.length - 1)
    recordedAnchor = Math.max(at, 0)
    next.splice(at + 1, 0, ...items)
  } else if (next.length === 0) {
    /* Replace against an empty array: nothing to remove, the items land. */
    recordedAnchor = 0
    next.splice(0, 0, ...items)
  } else {
    const at = clamp(target.anchorIndex, 0, next.length - 1)
    recordedAnchor = at
    removedKey = itemKey(next[at])
    next.splice(at, 1, ...items)
  }

  // §17.7 key-collision detection: a local insert may not duplicate a `_key`.
  const keys = new Set<string>()
  for (const item of next) {
    const key = itemKey(item)
    if (key === null) continue
    if (keys.has(key)) {
      return operationError(
        `insert would produce a duplicate _key ${JSON.stringify(key)} in ${encodeOverlayPath(
          target.arrayPath,
        )} (PRD §17.7)`,
        {path: encodeOverlayPath(target.arrayPath), _key: key},
      )
    }
    keys.add(key)
  }

  const insertedKeys = items.map(itemKey)
  const replacingWholeArray = target.anchorIndex === null && op.position === 'replace'
  const keyedTracking =
    !target.numericAnchor && !replacingWholeArray && insertedKeys.every((key) => key !== null)

  const touchedPaths: OverlayPath[] = keyedTracking
    ? [
        ...(removedKey === null
          ? []
          : [touchedPathFor([...target.arrayPath, {_key: removedKey}])]),
        ...insertedKeys.map((key) =>
          touchedPathFor([...target.arrayPath, {_key: key as string}]),
        ),
      ]
    : // §17.7: non-keyed array mutation is a full-array touch.
      [touchedPathFor(target.arrayPath)]

  const document2 =
    target.arrayPath.length === 0
      ? operationError('insert cannot target the document root', {})
      : (setAtPath(document, target.arrayPath, next) as SanityDocument)

  /* Re-anchor the recorded operation when a numeric anchor was normalized or
   * clamped — the raw spelling may be un-encodable (§13.6 has no negative
   * index) and the resolved one is what the insert actually did. */
  const rawAnchor = op.path[op.path.length - 1]
  const normalizedOperation =
    target.numericAnchor && recordedAnchor !== null && rawAnchor !== recordedAnchor
      ? {...op, path: [...target.arrayPath, recordedAnchor]}
      : undefined

  return {
    document: document2,
    touchedPaths,
    noop: false,
    ...(normalizedOperation === undefined ? {} : {normalizedOperation}),
  }
}

/* ------------------------------------------------------------------ *
 * applyOperation
 * ------------------------------------------------------------------ */

/** Apply one §13.7 operation to a document, returning the result and its touched paths. */
export function applyOperation(
  document: SanityDocument,
  operation: OverlayOperation,
  options: ApplyOperationOptions = {},
): AppliedOperation {
  switch (operation.type) {
    case 'set': {
      assertWritablePath(operation.path)
      const next = setAtPath(document, operation.path, deepClone(operation.value)) as SanityDocument
      return {document: next, touchedPaths: [touchedPathFor(operation.path)], noop: false}
    }

    case 'setIfMissing': {
      assertWritablePath(operation.path)
      // Missingness is evaluated against the document handed in, which the
      // mutation layer resolves from base + overlay first (PRD §17.2, §35.4).
      if (getAtPath(document, operation.path).exists) {
        // No touched path: the value keeps inheriting base (plan §5).
        return {document, touchedPaths: [], noop: true}
      }
      const next = setAtPath(document, operation.path, deepClone(operation.value)) as SanityDocument
      return {document: next, touchedPaths: [touchedPathFor(operation.path)], noop: false}
    }

    case 'unset': {
      assertWritablePath(operation.path)
      const next = updateAtPath(document, operation.path, () => ({action: 'remove'}), {
        create: false,
      }) as SanityDocument
      // §17.5: the touch is recorded even when the field was already absent, so
      // a base value added later stays suppressed.
      return {document: next, touchedPaths: [touchedPathFor(operation.path)], noop: false}
    }

    case 'insert':
      assertWritablePath(operation.path)
      return applyInsert(document, operation)

    case 'inc':
    case 'dec': {
      assertWritablePath(operation.path)
      if (typeof operation.amount !== 'number' || !Number.isFinite(operation.amount)) {
        return operationError(`${operation.type} requires a finite numeric \`amount\``, {
          received: operation.amount,
        })
      }
      const current = getAtPath(document, operation.path)
      if (current.exists && typeof current.value !== 'number') {
        return operationError(
          `${operation.type} target ${encodeOverlayPath(operation.path)} holds ${typeof current.value}, not a number`,
          {path: encodeOverlayPath(operation.path)},
        )
      }
      const start = current.exists ? (current.value as number) : 0
      const delta = operation.type === 'inc' ? operation.amount : -operation.amount
      const value = start + delta
      const next = setAtPath(document, operation.path, value) as SanityDocument
      return {
        document: next,
        touchedPaths: [touchedPathFor(operation.path)],
        noop: false,
        resultValue: value,
      }
    }

    case 'diffMatchPatch': {
      assertWritablePath(operation.path)
      const current = getAtPath(document, operation.path)
      if (!current.exists || typeof current.value !== 'string') {
        return operationError(
          `diffMatchPatch target ${encodeOverlayPath(operation.path)} must be an existing string`,
          {path: encodeOverlayPath(operation.path), received: typeof current.value},
        )
      }
      // §17.9: apply to the client-observed value and store the resulting string.
      const value = applyDiffMatchPatch(current.value, operation.patch)
      const next = setAtPath(document, operation.path, value) as SanityDocument
      return {
        document: next,
        touchedPaths: [touchedPathFor(operation.path)],
        noop: false,
        resultValue: value,
      }
    }

    case 'replaceDocument': {
      const replacement = assertDocument(operation.document, 'replaceDocument.document')
      // §17.10: `_id` changes are create-new plus reference migration (W4), never
      // an in-place mutation.
      if (replacement._id !== document._id) {
        throw new OverlayMutationError(
          'OVERLAY_ID_CHANGE_NOT_ALLOWED',
          `replaceDocument cannot change \`_id\` from ${JSON.stringify(
            document._id,
          )} to ${JSON.stringify(replacement._id)}; an ID change is a new document plus a reference migration (PRD §17.10, §19.6)`,
          {from: document._id, to: replacement._id},
        )
      }
      if (replacement._type !== document._type && options.allowTypeChange !== true) {
        throw new OverlayMutationError(
          'OVERLAY_TYPE_CHANGE_REQUIRES_INTENT',
          `replaceDocument changes \`_type\` from ${JSON.stringify(
            document._type,
          )} to ${JSON.stringify(replacement._type)}; PRD §17.10 requires explicit intent`,
          {from: document._type, to: replacement._type},
        )
      }
      const next = deepClone(replacement)
      // Protected system fields follow the §13.9 policy, not the payload.
      next._id = document._id
      if (document._createdAt !== undefined) next._createdAt = document._createdAt
      delete next._rev

      // §17.10 "[MUST] Mark all user fields as touched" — including fields the
      // replacement drops, so they stay suppressed against base.
      const touchedPaths = [
        ...userFieldPaths(document as unknown as Record<string, unknown>),
        ...userFieldPaths(next as unknown as Record<string, unknown>),
      ]
      return {document: next, touchedPaths, noop: false}
    }

    default: {
      const unknownOperation = operation as {type?: unknown}
      return operationError(
        `Unknown operation type ${JSON.stringify(unknownOperation.type)} (PRD §13.7)`,
        {type: unknownOperation.type},
      )
    }
  }
}

/**
 * The paths currently held down by an explicit unset (PRD §17.5, invariant §34.11).
 *
 * §17.5 rejects "absence alone" as a representation, because absence inherits the
 * current base value. The engine records the unset as a tracked operation on a
 * touched path; this function replays the recorded
 * `LocalDocumentVersion.operations` to answer which paths are still suppressed,
 * so the merge engine (W3) can keep suppressing a base field added *later*, and
 * a user removing the unset resumes inheritance.
 *
 * A later write at or under an unset path revives it; `replaceDocument` clears
 * every field tombstone, since it re-states the whole document.
 */
export function explicitUnsetPaths(operations: readonly OverlayOperation[]): OverlayPath[] {
  const unset = new Map<string, OverlayPath>()

  for (const operation of operations) {
    if (operation.type === 'replaceDocument') {
      unset.clear()
      continue
    }
    const path = operation.path
    if (operation.type === 'unset') {
      unset.set(encodeOverlayPath(path), deepClone(path) as OverlayPath)
      continue
    }
    // Writing at, or anywhere under, a suppressed path revives it.
    for (const [encoded, recorded] of [...unset]) {
      if (isPathPrefix(recorded, path) || isPathPrefix(path, recorded)) unset.delete(encoded)
    }
  }

  return [...unset.values()]
}

/**
 * Fold a sequence of operations over a document, accumulating touched paths.
 * Operations are applied in order, each seeing the previous result (§17.11's
 * "local insertions at the same anchor retain local transaction order").
 */
export function applyOperations(
  document: SanityDocument,
  operations: readonly OverlayOperation[],
  options: ApplyOperationOptions = {},
): {
  document: SanityDocument
  touchedPaths: OverlayPath[]
  results: AppliedOperation[]
  /**
   * The operations as they must be RECORDED — identical to the input except
   * where an operation resolved to a different canonical spelling (see
   * `AppliedOperation.normalizedOperation`). Callers that persist operations
   * must store these, never the raw input.
   */
  operations: OverlayOperation[]
} {
  let current = document
  const touchedPaths: OverlayPath[] = []
  const results: AppliedOperation[] = []
  const recorded: OverlayOperation[] = []
  for (const operation of operations) {
    const applied = applyOperation(current, operation, options)
    current = applied.document
    touchedPaths.push(...applied.touchedPaths)
    results.push(applied)
    recorded.push(applied.normalizedOperation ?? operation)
  }
  return {document: current, touchedPaths, results, operations: recorded}
}
