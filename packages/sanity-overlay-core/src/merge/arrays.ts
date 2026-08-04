/**
 * Keyed array merge (PRD §17.7, §35.3).
 *
 * Every `[MUST]` of §17.7 is decided here:
 *
 * - `_key` identity for object and Portable Text arrays — items are matched by
 *   `_key`, never by index.
 * - Insertion tracked against stable `_key` anchors — a local insertion's anchor
 *   is the nearest preceding local item that survives into the merged array,
 *   which is exactly the anchor the `insert before|after` operation recorded.
 * - Key collisions detected — two sides introducing the same `_key` with
 *   different content is `ARRAY_KEY_COLLISION` (hard), and the colliding local
 *   insert is rejected so the output can never contain a duplicate key.
 * - Upstream deletion of a locally edited item detected — `ARRAY_ITEM_DELETED`
 *   (hard), with the local item preserved at its anchor.
 * - Independent upstream additions preserved.
 * - Deterministic ordering — the plan adopts the §17.7 `[SHOULD]` rule: base
 *   order first, each local insertion placed immediately after its recorded
 *   anchor, concurrent base insertions keeping base order, and local insertions
 *   at one anchor keeping local transaction order (which is local array order).
 *
 * Non-keyed arrays never reach here: §17.7 makes them a full-array touch.
 */
import type {OverlayPath} from '../types/path'
import {
  addConflict,
  extend,
  isKeyedArray,
  itemKey,
  keyMap,
  valueEquals,
  type MergeContext,
} from './context'
import type {TouchTreeNode} from './touch-tree'

export interface NodeResult {
  present: boolean
  value: unknown
}

export type MergeNodeFn = (
  context: MergeContext,
  path: OverlayPath,
  ancestorValue: unknown,
  baseValue: unknown,
  localValue: unknown,
  node: TouchTreeNode,
) => NodeResult

interface Slot {
  key: string | null
  value: unknown
}

/** True when the array holds two items with the same `_key`. */
export function hasDuplicateKeys(value: readonly unknown[]): boolean {
  const seen = new Set<string>()
  for (const item of value) {
    const key = itemKey(item)
    if (key === null) continue
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

export function mergeKeyedArray(
  context: MergeContext,
  path: OverlayPath,
  ancestorValue: unknown,
  baseValue: unknown,
  localValue: unknown,
  node: TouchTreeNode,
  mergeNode: MergeNodeFn,
): NodeResult {
  // A local side that is not a keyed array is a full-array touch (§17.7).
  if (!isKeyedArray(localValue) || !isKeyedArray(baseValue)) {
    return {present: localValue !== undefined, value: localValue}
  }

  const ancestorItems = keyMap(ancestorValue)
  const baseItems = keyMap(baseValue)
  const localItems = keyMap(localValue)

  if (hasDuplicateKeys(localValue)) {
    addConflict(context, {type: 'ARRAY_KEY_COLLISION', path, localValue})
  }

  const result: Slot[] = []

  /* --- 1. base order is the spine (§17.7 rule 1) --- */
  for (const item of baseValue) {
    const key = itemKey(item)
    /* istanbul ignore next -- isKeyedArray guarantees a key */
    if (key === null) continue

    const inAncestor = ancestorItems.has(key)
    const inLocal = localItems.has(key)

    if (inAncestor && !inLocal) {
      // §17.5: absence alone is not an unset, because absence inherits base. The
      // item is dropped only when the branch recorded the intent — a touch or
      // unset on the item itself, or a touch on the whole array (§35.3 "Local
      // deletes base keyed item using explicit operation").
      if (node.self || node.children.has(`k:${key}`)) continue
      result.push({key, value: item})
      continue
    }

    if (!inAncestor && inLocal) {
      // Both sides introduced the same `_key` (§17.4 `ARRAY_KEY_COLLISION`).
      const local = localItems.get(key)
      if (!valueEquals(item, local)) {
        addConflict(context, {
          type: 'ARRAY_KEY_COLLISION',
          path: extend(path, {_key: key}),
          baseValue: item,
          localValue: local,
        })
      }
      // "Reject the colliding local insert" (§17.4 preview behavior).
      result.push({key, value: item})
      continue
    }

    if (inLocal) {
      const child = node.children.get(`k:${key}`)
      if (child === undefined) {
        // Untouched item: inherit the upstream version (§35.3 "Base edit to
        // different keyed item is inherited").
        result.push({key, value: item})
        continue
      }
      const merged = mergeNode(
        context,
        extend(path, {_key: key}),
        ancestorItems.get(key),
        item,
        localItems.get(key),
        child.node,
      )
      if (merged.present) result.push({key, value: merged.value})
      continue
    }

    // Independent upstream addition (§17.7 "[MUST] Preserve independent upstream
    // additions").
    result.push({key, value: item})
  }

  /* --- 2. local insertions and upstream-deleted local items, at their anchors --- */
  let anchor = -1
  for (const item of localValue) {
    const key = itemKey(item)
    /* istanbul ignore next -- isKeyedArray guarantees a key */
    if (key === null) continue

    const placed = result.findIndex((slot) => slot.key === key)
    if (placed !== -1) {
      anchor = placed
      continue
    }
    if (baseItems.has(key)) {
      // Present in base but dropped above (locally deleted, or collision-rejected).
      continue
    }

    if (ancestorItems.has(key)) {
      // Upstream deleted an item the branch still holds (§17.7, §35.3).
      const child = node.children.get(`k:${key}`)
      const locallyModified = child !== undefined || !valueEquals(item, ancestorItems.get(key))
      if (!locallyModified) continue // untouched item follows the upstream delete
      addConflict(context, {
        type: 'ARRAY_ITEM_DELETED',
        path: extend(path, {_key: key}),
        ancestorValue: ancestorItems.get(key),
        localValue: item,
      })
    }

    // Insert immediately after the recorded anchor (§17.7 rules 2 and 4).
    const at = anchor + 1
    result.splice(at, 0, {key, value: item})
    anchor = at
  }

  return {present: true, value: result.map((slot) => slot.value)}
}
