/**
 * Executable §34 invariants owned by the merge engine (plan §8.3).
 *
 * These are assertions over a *merge result*, callable from tests and from
 * runtime debug tooling. They deliberately re-derive their answers from the
 * request rather than from anything the merge computed, so a merge bug cannot
 * hide behind its own bookkeeping:
 *
 * - §34.11 A local unset continues to suppress later base values until removed.
 * - §34.12 Untouched paths always inherit current base values when structurally
 *   compatible.
 * - §34.13 Touched paths preserve local intent after base change.
 * - §34.14 Base deletion never destroys a touched materialized document.
 */
import {encodeOverlayPath} from '../encoding'
import {getAtPath, isPathPrefix, isPlainObject} from '../mutations/paths'
import type {OverlayConflict} from '../types/conflict'
import type {OverlayPath} from '../types/path'
import {isKeyedArray, keyMap, valueEquals} from './context'
import type {MergeRequest, MergeResult} from './types'

export type MergeInvariantId = '34.11' | '34.12' | '34.13' | '34.14'

export interface InvariantViolation {
  invariant: MergeInvariantId
  message: string
  path?: OverlayPath
}

/**
 * Every path at which two documents disagree, descending into objects and keyed
 * arrays so a single upstream field change is reported at the field, not at the
 * document root.
 */
export function changedPaths(a: unknown, b: unknown, path: OverlayPath = []): OverlayPath[] {
  if (valueEquals(a, b)) return []
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    return keys.flatMap((key) => changedPaths(a[key], b[key], [...path, key]))
  }
  if (isKeyedArray(a) && isKeyedArray(b)) {
    const left = keyMap(a)
    const right = keyMap(b)
    const keys = [...new Set([...left.keys(), ...right.keys()])]
    return keys.flatMap((key) => changedPaths(left.get(key), right.get(key), [...path, {_key: key}]))
  }
  return [path]
}

function overlaps(a: OverlayPath, b: OverlayPath): boolean {
  return isPathPrefix(a, b) || isPathPrefix(b, a)
}

function read(document: unknown, path: OverlayPath): unknown {
  if (path.length === 0) return document
  return getAtPath(document, path).value
}

function present(document: unknown, path: OverlayPath): boolean {
  if (path.length === 0) return document !== undefined && document !== null
  return getAtPath(document, path).exists
}

function hardConflictCovers(conflicts: readonly OverlayConflict[], path: OverlayPath): boolean {
  return conflicts.some(
    (conflict) =>
      conflict.severity === 'hard' &&
      (conflict.path === undefined || isPathPrefix(conflict.path, path)),
  )
}

/** §34.11 — an unset path never inherits a base value. */
export function checkUnsetSuppression(
  request: MergeRequest,
  result: MergeResult,
): InvariantViolation[] {
  if (result.document === null) return []
  return (request.unsetPaths ?? [])
    .filter((path) => present(result.document, path))
    .map((path) => ({
      invariant: '34.11' as const,
      message: `Unset path ${encodeOverlayPath(path)} reappeared in the resolved document`,
      path,
    }))
}

/** §34.12 — untouched paths inherit current base. */
export function checkUntouchedInheritance(
  request: MergeRequest,
  result: MergeResult,
): InvariantViolation[] {
  const base = request.currentBase
  if (base === null || result.document === null) return []
  if (request.origin === 'branch') return []
  // A `BASE_TYPE_CHANGED` merge deliberately returns recovery output (§17.4).
  if (result.conflicts.some((conflict) => conflict.type === 'BASE_TYPE_CHANGED')) return []

  const touched = [...(request.localTouchedPaths ?? []), ...(request.unsetPaths ?? [])]
  const violations: InvariantViolation[] = []
  for (const path of changedPaths(request.ancestor, base)) {
    if (path.length === 0) continue
    if (path.some((segment) => typeof segment === 'string' && segment.startsWith('_'))) continue
    if (touched.some((entry) => overlaps(entry, path))) continue
    if (!valueEquals(read(result.document, path), read(base, path))) {
      violations.push({
        invariant: '34.12',
        message: `Untouched path ${encodeOverlayPath(path)} did not inherit the current base value`,
        path,
      })
    }
  }
  return violations
}

/** §34.13 — touched paths preserve local intent. */
export function checkTouchedPreservation(
  request: MergeRequest,
  result: MergeResult,
): InvariantViolation[] {
  const local = request.localMaterialized
  if (local === null || result.document === null) return []
  if (request.localTombstone === true) return []

  const dropped = new Set(result.removedTouchedPaths.map(encodeOverlayPath))
  const unset = new Set((request.unsetPaths ?? []).map(encodeOverlayPath))
  const violations: InvariantViolation[] = []

  for (const path of request.localTouchedPaths ?? []) {
    if (path.length === 0) continue
    const encoded = encodeOverlayPath(path)
    if (dropped.has(encoded) || unset.has(encoded)) continue
    // A hard conflict is exactly where local intent may legitimately not apply
    // (§17.4 "Reject the colliding local insert", "block the affected item").
    if (hardConflictCovers(result.conflicts, path)) continue
    const localValue = read(local, path)
    if (valueEquals(localValue, read(request.ancestor, path))) continue
    if (!valueEquals(read(result.document, path), localValue)) {
      violations.push({
        invariant: '34.13',
        message: `Touched path ${encoded} lost local intent after the base change`,
        path,
      })
    }
  }
  return violations
}

/** §34.14 — base deletion never destroys a touched materialized document. */
export function checkBaseDeletionRecovery(
  request: MergeRequest,
  result: MergeResult,
): InvariantViolation[] {
  const local = request.localMaterialized
  if (local === null || request.localTombstone === true) return []
  const deleted =
    request.currentBase === null && (request.baseStatus === 'deleted' || request.ancestor !== null)
  if (!deleted) return []

  if (result.document === null) {
    return [
      {
        invariant: '34.14',
        message: 'Base deletion destroyed a touched materialized document',
      },
    ]
  }

  return (request.localTouchedPaths ?? [])
    .filter((path) => path.length > 0 && !valueEquals(read(result.document, path), read(local, path)))
    .map((path) => ({
      invariant: '34.14' as const,
      message: `Base deletion lost the local value at ${encodeOverlayPath(path)}`,
      path,
    }))
}

/** Run every merge-owned §34 invariant. */
export function checkMergeInvariants(
  request: MergeRequest,
  result: MergeResult,
): InvariantViolation[] {
  return [
    ...checkUnsetSuppression(request, result),
    ...checkUntouchedInheritance(request, result),
    ...checkTouchedPreservation(request, result),
    ...checkBaseDeletionRecovery(request, result),
  ]
}
