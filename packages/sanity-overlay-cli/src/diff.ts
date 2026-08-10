/**
 * Path-level diff between a document's merge ancestor and its branch value.
 *
 * Three properties make this useful rather than decorative:
 *
 * 1. **Keyed array identity.** Items are matched by `_key` (PRD §17.7), never by
 *    index, so moving an item does not read as "every item after it changed".
 *    A reorder is reported once, at the array, as the surviving key order.
 * 2. **Field granularity.** Objects are descended into, so a one-word change in
 *    a nested field is one line, not a re-print of the whole document. Arrays
 *    that are wholly added or removed are reported whole, because their identity
 *    is the array.
 * 3. **Determinism.** Entries are sorted by their display path, so the same
 *    overlay renders the same bytes regardless of the order the edits arrived in
 *    (PRD §34.17). That is what makes the output safe to commit or to diff in CI.
 *
 * Churning system fields (`_rev`, `_updatedAt`) are hidden by default: they
 * change on every write by construction (PRD §13.9), so including them would
 * bury the semantic change under noise. `--system` shows them.
 */
import {isKeyedArray, keyMap, valueEquals} from 'sanity-overlay-core'
import type {OverlayPath, OverlayPathSegment} from 'sanity-overlay-core'
import {formatPath} from './render'

export type DiffKind = 'added' | 'removed' | 'changed'

export interface DiffEntry {
  /** Display notation (`body[_key=="x"].text`), not the storage encoding. */
  readonly path: string
  readonly kind: DiffKind
  readonly before?: unknown
  readonly after?: unknown
}

export interface DiffOptions {
  /** Include `_rev` and `_updatedAt`. Off by default. */
  readonly system?: boolean
}

/** Fields that change on every write and would drown the semantic diff (PRD §13.9). */
const CHURNING_SYSTEM_FIELDS = new Set(['_rev', '_updatedAt'])

/**
 * Fields determined by the PERSPECTIVE rather than by any edit.
 *
 * A draft's materialized `_id` is `drafts.<logicalId>` by construction (§13.9),
 * so diffing a draft against a base published snapshot reports `_id` as changed
 * on every modified document — a fact about the perspective, not about the
 * branch. Hidden at the document root only: an `_id` nested inside a field is
 * user data and is diffed normally.
 */
const PERSPECTIVE_ROOT_FIELDS = new Set(['_id'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hidden(key: string, system: boolean, depth: number): boolean {
  if (system) return false
  if (CHURNING_SYSTEM_FIELDS.has(key)) return true
  return depth === 0 && PERSPECTIVE_ROOT_FIELDS.has(key)
}

/** Remove churning system fields from an emitted value, at every depth. */
function sanitize(value: unknown, system: boolean): unknown {
  if (system) return value
  if (Array.isArray(value)) return value.map((item) => sanitize(item, system))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (CHURNING_SYSTEM_FIELDS.has(key)) continue
    out[key] = sanitize(value[key], system)
  }
  return out
}

function extend(path: OverlayPath, segment: OverlayPathSegment): OverlayPath {
  return [...path, segment]
}

function sortedUnion(a: Iterable<string>, b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort()
}

/**
 * Compare two key sequences ELEMENT-WISE. Never by joining them.
 *
 * Joining with a separator `S` makes the answer depend on whether a `_key`
 * contains `S`, and nothing validates `_key` against that. For any `S` the two
 * distinct orderings of `k` and `k + S + k` both join to `k + S + k + S + k`,
 * so a genuine reorder compares equal and this diff reports the array as
 * unchanged — a change that silently disappears from review. Element-wise
 * comparison has no separator, so it has no such input.
 */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function emitPresence(
  value: unknown,
  path: OverlayPath,
  kind: 'added' | 'removed',
  out: DiffEntry[],
  system: boolean,
): void {
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => !hidden(key, system, path.length))
    if (keys.length > 0) {
      for (const key of keys.sort()) {
        emitPresence(value[key], extend(path, key), kind, out, system)
      }
      return
    }
  }
  const entry: DiffEntry =
    kind === 'added'
      ? {path: formatPath(path), kind, after: sanitize(value, system)}
      : {path: formatPath(path), kind, before: sanitize(value, system)}
  out.push(entry)
}

function walk(
  before: unknown,
  after: unknown,
  path: OverlayPath,
  out: DiffEntry[],
  system: boolean,
): void {
  if (before === undefined && after === undefined) return
  if (valueEquals(before, after)) return
  if (before === undefined) {
    emitPresence(after, path, 'added', out, system)
    return
  }
  if (after === undefined) {
    emitPresence(before, path, 'removed', out, system)
    return
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of sortedUnion(Object.keys(before), Object.keys(after))) {
      if (hidden(key, system, path.length)) continue
      walk(before[key], after[key], extend(path, key), out, system)
    }
    return
  }

  if (isKeyedArray(before) && isKeyedArray(after)) {
    const beforeItems = keyMap(before)
    const afterItems = keyMap(after)
    for (const key of sortedUnion(beforeItems.keys(), afterItems.keys())) {
      walk(beforeItems.get(key), afterItems.get(key), extend(path, {_key: key}), out, system)
    }
    /* A reorder of items that both sides hold is a change to the ARRAY, not to
     * any item, so it is reported once at the array path. */
    const beforeOrder = [...beforeItems.keys()].filter((key) => afterItems.has(key))
    const afterOrder = [...afterItems.keys()].filter((key) => beforeItems.has(key))
    if (!sameOrder(beforeOrder, afterOrder)) {
      out.push({path: formatPath(path), kind: 'changed', before: beforeOrder, after: afterOrder})
    }
    return
  }

  out.push({
    path: formatPath(path),
    kind: 'changed',
    before: sanitize(before, system),
    after: sanitize(after, system),
  })
}

/**
 * Diff two document values. Pass `undefined` (never `null`) for "no such
 * version" — `null` is a legitimate stored value and must diff as one.
 */
export function diffValues(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): DiffEntry[] {
  const out: DiffEntry[] = []
  walk(before, after, [], out, options.system === true)
  return out.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )
}
