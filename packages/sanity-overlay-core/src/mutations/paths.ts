/**
 * Path traversal and copy-on-write updates over an {@link OverlayPath} (PRD §13.6).
 *
 * The three §13.6 segment kinds are honoured exactly:
 *
 * - `string` — an object property.
 * - `{_key}` — a keyed array item. The anchor **must already exist**; the engine
 *   never appends a phantom item to satisfy a keyed path, because that would
 *   silently invent array identity the merge engine later trusts (§17.7).
 * - `number` — a numeric array index, allowed only for arrays with no `_key`
 *   support, and always implying a full-array touch (§13.6, §17.7).
 *
 * Every write is copy-on-write: nodes along the written path are cloned, every
 * other node keeps its identity. Nothing here mutates its input.
 */
import {OverlayPathError} from '../errors'
import {encodeOverlayPath} from '../encoding'
import {isForbiddenKey} from '../serialize'
import {isKeySegment, type OverlayPath, type OverlayPathSegment} from '../types/path'

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural deep clone of JSON-shaped data. Keeps the engine free of shared state.
 *
 * A §35.14 forbidden own key is COPIED, not assigned. `out['__proto__'] = …` runs
 * `Object.prototype`'s `__proto__` **setter**, which swaps the clone's prototype
 * instead of creating an own property: the value is destroyed, and — worse —
 * `serialize()`'s `assertNoForbiddenKeys` then finds nothing to refuse, so the
 * write is silently approximated rather than rejected (PRD §5.5; security review
 * 2026-08-06 P2-5). `defineProperty` writes the own key, so a forbidden key
 * survives the clone and reaches the one place that already knows to refuse it.
 * Cloning is not the place to make that decision.
 */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const cloned = deepClone(value[key])
      if (isForbiddenKey(key)) {
        Object.defineProperty(out, key, {
          value: cloned,
          writable: true,
          enumerable: true,
          configurable: true,
        })
        continue
      }
      out[key] = cloned
    }
    return out as unknown as T
  }
  return value
}

function pathError(
  code: 'OVERLAY_PATH_NOT_FOUND' | 'OVERLAY_PATH_TYPE_MISMATCH',
  message: string,
  path: OverlayPath,
  index: number,
  extra: Record<string, unknown> = {},
): OverlayPathError {
  return new OverlayPathError(code, message, {
    path: encodeOverlayPath(path),
    segmentIndex: index,
    ...extra,
  })
}

function describe(segment: OverlayPathSegment): string {
  return isKeySegment(segment) ? `{_key: ${JSON.stringify(segment._key)}}` : JSON.stringify(segment)
}

/** Index of the array item carrying `_key`, or `-1`. */
export function indexOfKey(array: readonly unknown[], key: string): number {
  return array.findIndex((item) => isPlainObject(item) && item._key === key)
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

export interface PathLookup {
  /** True when the path resolves to an existing member (a stored `undefined` counts as absent). */
  exists: boolean
  value: unknown
}

/** Read the value at `path`, reporting whether it exists (PRD §13.6). */
export function getAtPath(root: unknown, path: OverlayPath): PathLookup {
  let current: unknown = root
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!
    if (typeof segment === 'string') {
      if (!isPlainObject(current)) return {exists: false, value: undefined}
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return {exists: false, value: undefined}
      }
      current = current[segment]
      continue
    }
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return {exists: false, value: undefined}
      }
      current = current[segment]
      continue
    }
    if (!Array.isArray(current)) return {exists: false, value: undefined}
    const index = indexOfKey(current, segment._key)
    if (index === -1) return {exists: false, value: undefined}
    current = current[index]
  }
  return {exists: current !== undefined, value: current}
}

/** Convenience wrapper: `true` when the path resolves to a present value. */
export function hasAtPath(root: unknown, path: OverlayPath): boolean {
  return getAtPath(root, path).exists
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

export type PathUpdate =
  | {action: 'set'; value: unknown}
  | {action: 'remove'}
  | {action: 'none'}

export type PathUpdater = (current: unknown, exists: boolean) => PathUpdate

export interface UpdateOptions {
  /**
   * Auto-vivify missing intermediate containers (`{}` for a string segment, `[]`
   * for a numeric segment). `set` and `setIfMissing` create; `unset`, `inc`,
   * `dec` and `diffMatchPatch` do not. A `{_key}` anchor is never auto-vivified.
   */
  create?: boolean
}

interface Frame {
  path: OverlayPath
  updater: PathUpdater
  create: boolean
}

function containerFor(
  node: unknown,
  kind: 'object' | 'array',
  frame: Frame,
  index: number,
): Record<string, unknown> | unknown[] | null {
  if (node === undefined || node === null) {
    if (!frame.create) return null
    return kind === 'object' ? {} : []
  }
  if (kind === 'object') {
    if (!isPlainObject(node)) {
      throw pathError(
        'OVERLAY_PATH_TYPE_MISMATCH',
        `Cannot traverse ${describe(frame.path[index]!)}: the parent is ${
          Array.isArray(node) ? 'an array' : `a ${typeof node}`
        }, not an object`,
        frame.path,
        index,
      )
    }
    return {...node}
  }
  if (!Array.isArray(node)) {
    throw pathError(
      'OVERLAY_PATH_TYPE_MISMATCH',
      `Cannot traverse ${describe(frame.path[index]!)}: the parent is ${
        isPlainObject(node) ? 'an object' : `a ${typeof node}`
      }, not an array`,
      frame.path,
      index,
    )
  }
  return [...node]
}

function descend(node: unknown, index: number, frame: Frame): unknown {
  const segment = frame.path[index]!
  const isLast = index === frame.path.length - 1

  /* --- object property --- */
  if (typeof segment === 'string') {
    const object = containerFor(node, 'object', frame, index) as Record<string, unknown> | null
    if (object === null) return node
    const exists = Object.prototype.hasOwnProperty.call(object, segment)
    if (isLast) {
      const result = frame.updater(exists ? object[segment] : undefined, exists)
      if (result.action === 'none') return node
      if (result.action === 'remove') {
        if (!exists) return node
        delete object[segment]
        return object
      }
      object[segment] = result.value
      return object
    }
    if (!exists && !frame.create) return node
    object[segment] = descend(exists ? object[segment] : undefined, index + 1, frame)
    return object
  }

  /* --- numeric array index --- */
  if (typeof segment === 'number') {
    if (!Number.isInteger(segment) || segment < 0) {
      throw pathError(
        'OVERLAY_PATH_NOT_FOUND',
        `Array index segment must be a non-negative integer, received ${String(segment)}`,
        frame.path,
        index,
      )
    }
    const array = containerFor(node, 'array', frame, index) as unknown[] | null
    if (array === null) return node
    const exists = segment < array.length
    if (isLast) {
      const result = frame.updater(exists ? array[segment] : undefined, exists)
      if (result.action === 'none') return node
      if (result.action === 'remove') {
        if (!exists) return node
        array.splice(segment, 1)
        return array
      }
      if (!exists && segment > array.length) {
        // Writing past the end would produce a hole, which canonical JSON cannot
        // represent losslessly (PRD §14.3). Refuse rather than emit `null` padding.
        throw pathError(
          'OVERLAY_PATH_NOT_FOUND',
          `Array index ${segment} is out of range for an array of length ${array.length}`,
          frame.path,
          index,
          {length: array.length},
        )
      }
      array[segment] = result.value
      return array
    }
    if (!exists) {
      if (!frame.create) return node
      throw pathError(
        'OVERLAY_PATH_NOT_FOUND',
        `Array index ${segment} is out of range for an array of length ${array.length}`,
        frame.path,
        index,
        {length: array.length},
      )
    }
    array[segment] = descend(array[segment], index + 1, frame)
    return array
  }

  /* --- keyed array item --- */
  const array = containerFor(node, 'array', frame, index) as unknown[] | null
  if (array === null) return node
  const at = indexOfKey(array, segment._key)
  if (at === -1) {
    if (!frame.create) return node
    // §17.7: `_key` identity is the anchor. Inventing an item would fabricate
    // identity the merge engine treats as stable, so this is always an error.
    throw pathError(
      'OVERLAY_PATH_NOT_FOUND',
      `No array item with _key ${JSON.stringify(segment._key)} exists at this anchor`,
      frame.path,
      index,
      {_key: segment._key},
    )
  }
  if (isLast) {
    const result = frame.updater(array[at], true)
    if (result.action === 'none') return node
    if (result.action === 'remove') {
      array.splice(at, 1)
      return array
    }
    array[at] = result.value
    return array
  }
  array[at] = descend(array[at], index + 1, frame)
  return array
}

/**
 * Return a copy of `root` with the value at `path` updated by `updater`.
 *
 * The root itself is never removed: an empty path is rejected, because a
 * document-wide replacement is `replaceDocument` (PRD §17.10), not a path write.
 */
export function updateAtPath(
  root: unknown,
  path: OverlayPath,
  updater: PathUpdater,
  options: UpdateOptions = {},
): unknown {
  if (path.length === 0) {
    throw new OverlayPathError(
      'OVERLAY_OPERATION_INVALID',
      'The empty path cannot be written; use replaceDocument for whole-document changes (PRD §17.10)',
      {path: encodeOverlayPath(path)},
    )
  }
  return descend(root, 0, {path, updater, create: options.create === true})
}

/** Set `value` at `path`, creating missing intermediate objects and arrays. */
export function setAtPath(root: unknown, path: OverlayPath, value: unknown): unknown {
  return updateAtPath(root, path, () => ({action: 'set', value}), {create: true})
}

/** Remove the member at `path`. Missing members are a no-op on the document. */
export function removeAtPath(root: unknown, path: OverlayPath): unknown {
  return updateAtPath(root, path, () => ({action: 'remove'}), {create: false})
}

/* ------------------------------------------------------------------ *
 * Touched-path bookkeeping (PRD §13.5, §17.6, §17.7)
 * ------------------------------------------------------------------ */

/**
 * A recorded touched path covers its whole subtree.
 *
 * This is the concrete reading of §17.6 "treat full object replacement as
 * touching the entire object subtree": recording `["hero"]` means every path
 * under `hero` is locally owned, so `isPathTouched(paths, ["hero", "heading"])`
 * is true. Recording only `["hero", "heading"]` leaves sibling `hero.*` fields
 * inheriting base, which is the same section's "preserve new upstream sibling
 * fields" rule.
 */
export function isPathTouched(touchedPaths: readonly OverlayPath[], path: OverlayPath): boolean {
  return touchedPaths.some((touched) => isPathPrefix(touched, path))
}

/** True when `prefix` is `path` or an ancestor of it. */
export function isPathPrefix(prefix: OverlayPath, path: OverlayPath): boolean {
  if (prefix.length > path.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (!segmentEquals(prefix[i]!, path[i]!)) return false
  }
  return true
}

export function segmentEquals(a: OverlayPathSegment, b: OverlayPathSegment): boolean {
  if (isKeySegment(a)) return isKeySegment(b) && a._key === b._key
  if (isKeySegment(b)) return false
  return a === b
}

/**
 * Union two touched-path lists, dropping duplicates and any path already covered
 * by a recorded ancestor (§17.6 subtree rule). Insertion order is preserved so
 * output is deterministic for the same operation sequence.
 */
export function mergeTouchedPaths(
  existing: readonly OverlayPath[],
  added: readonly OverlayPath[],
): OverlayPath[] {
  const result: OverlayPath[] = []
  const seen = new Set<string>()

  for (const path of [...existing, ...added]) {
    const encoded = encodeOverlayPath(path)
    if (seen.has(encoded)) continue
    // A newly added ancestor supersedes the descendants recorded before it.
    for (let i = result.length - 1; i >= 0; i--) {
      if (isPathPrefix(path, result[i]!)) {
        seen.delete(encodeOverlayPath(result[i]!))
        result.splice(i, 1)
      }
    }
    if (result.some((kept) => isPathPrefix(kept, path))) continue
    seen.add(encoded)
    result.push(deepClone(path) as OverlayPath)
  }

  return result
}

/**
 * The path actually recorded as touched for a write at `path` (PRD §13.6, §17.7).
 *
 * A numeric index segment means the array has no `_key` support, so the *whole
 * array* is treated as touched: the recorded path is truncated just above the
 * first numeric segment. Keyed and property segments are recorded verbatim.
 */
export function touchedPathFor(path: OverlayPath): OverlayPath {
  const firstIndex = path.findIndex((segment) => typeof segment === 'number')
  return deepClone(firstIndex === -1 ? path : path.slice(0, firstIndex)) as OverlayPath
}
