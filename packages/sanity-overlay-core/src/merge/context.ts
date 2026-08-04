/** Shared merge traversal state and value comparison rules. */
import {canonicalEquals} from '../serialize'
import {createConflict, type CreateConflictInput} from '../conflicts/create'
import type {OverlayConflict} from '../types/conflict'
import {isKeySegment, type OverlayPath, type OverlayPathSegment} from '../types/path'
import {indexOfKey, isPlainObject} from '../mutations/paths'

export interface MergeContext {
  documentId: string
  now: string
  /** Keyed by conflict ID so one path cannot raise the same conflict twice. */
  conflicts: Map<string, OverlayConflict>
  /** Touches dropped by §17.3 step 5. */
  removed: OverlayPath[]
}

export function createMergeContext(documentId: string, now: string): MergeContext {
  return {documentId, now, conflicts: new Map(), removed: []}
}

export function addConflict(
  context: MergeContext,
  input: Omit<CreateConflictInput, 'documentId' | 'detectedAt'>,
): OverlayConflict {
  const conflict = createConflict({
    ...input,
    documentId: context.documentId,
    detectedAt: context.now,
  })
  if (!context.conflicts.has(conflict.id)) context.conflicts.set(conflict.id, conflict)
  return context.conflicts.get(conflict.id)!
}

/**
 * Value equality for merge decisions.
 *
 * `undefined` means *absent*, and absence is never equal to a present value —
 * not even to `null`, which the canonical serializer renders identically
 * (§14.3). Conflating the two would let a base `null` collapse a local unset.
 */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return canonicalEquals(a, b)
}

/** Read one segment out of a value, returning `undefined` when it does not apply. */
export function childValue(node: unknown, segment: OverlayPathSegment): unknown {
  if (node === undefined || node === null) return undefined
  if (typeof segment === 'string') {
    return isPlainObject(node) ? node[segment] : undefined
  }
  if (typeof segment === 'number') {
    return Array.isArray(node) ? node[segment] : undefined
  }
  if (!Array.isArray(node)) return undefined
  const index = indexOfKey(node, segment._key)
  return index === -1 ? undefined : node[index]
}

/** The `_key` of an array item, or `null` for a non-keyed item. */
export function itemKey(item: unknown): string | null {
  return isPlainObject(item) && typeof item._key === 'string' ? item._key : null
}

/**
 * True when every item of the array carries a `_key` (PRD §17.7 "prefer `_key`
 * identity"). An empty array qualifies: it has no counter-example.
 */
export function isKeyedArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => itemKey(item) !== null)
}

/** Index items by `_key`, in array order. */
export function keyMap(value: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>()
  if (!Array.isArray(value)) return map
  for (const item of value) {
    const key = itemKey(item)
    if (key !== null && !map.has(key)) map.set(key, item)
  }
  return map
}

/** Append a segment to a path without mutating it. */
export function extend(path: OverlayPath, segment: OverlayPathSegment): OverlayPath {
  return [...path, isKeySegment(segment) ? {_key: segment._key} : segment]
}
