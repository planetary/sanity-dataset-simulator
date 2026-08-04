/**
 * PRD §13.6 — Overlay path.
 *
 * Paths must preserve keyed array identity. Numeric array indexes are allowed
 * only when the array has no `_key` support and the entire array is treated as
 * touched.
 */

export type OverlayPathSegment = string | number | {_key: string}

export type OverlayPath = OverlayPathSegment[]

/** Narrow a segment to the keyed form `{_key: string}`. */
export function isKeySegment(segment: OverlayPathSegment): segment is {_key: string} {
  return typeof segment === 'object' && segment !== null && typeof segment._key === 'string'
}

/** Narrow a segment to a non-negative integer array index. */
export function isIndexSegment(segment: OverlayPathSegment): segment is number {
  return typeof segment === 'number' && Number.isInteger(segment) && segment >= 0
}
