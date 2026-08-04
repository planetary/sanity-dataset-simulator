/**
 * Canonical JSON serializer (PRD §14.3, §34.17, §12.1).
 *
 * One serializer, shared by hashing, checkpoint output and every adapter
 * (plan §4). Rules:
 *
 * - Deterministic key ordering: object keys are sorted recursively by UTF-16 code
 *   unit (`Array.prototype.sort` default), which is locale-independent. Arrays
 *   keep their order — order is data.
 * - Two-space indentation and a newline at end of file.
 * - `undefined` object properties are omitted (as `JSON.stringify` does);
 *   `undefined` inside an array becomes `null`.
 * - Non-JSON values (`NaN`, `Infinity`, `-Infinity`, `bigint`, functions,
 *   symbols) are rejected rather than silently coerced, so a hash can never be
 *   computed over a lossy encoding.
 * - Prototype-polluting own keys (`__proto__`, `constructor`, `prototype`) are
 *   rejected on both write and read (PRD §35.14 "Malformed JSON prototype keys
 *   fail").
 *
 * The emitter is hand-written rather than `JSON.stringify(sorted, null, 2)`
 * because JavaScript reorders integer-like own keys ahead of string keys, which
 * would silently override the sort for objects keyed by `"0"`, `"10"`, and so on.
 */
import {
  OverlayPrototypeKeyError,
  OverlaySerializationError,
  type OverlayErrorDetails,
} from './errors'

/** Keys rejected anywhere in a canonical document (PRD §35.14). */
export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'] as const)

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_KEYS)

const INDENT = '  '

export type JsonPath = readonly (string | number)[]

function fail(
  message: string,
  path: JsonPath,
  details: OverlayErrorDetails = {},
): OverlaySerializationError {
  return new OverlaySerializationError('OVERLAY_CANONICAL_JSON_INVALID', message, {
    path: [...path],
    ...details,
  })
}

/** True when the key can never appear in canonical overlay JSON. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_SET.has(key)
}

function assertNoForbiddenKeys(object: object, path: JsonPath): void {
  // getOwnPropertyNames, not keys: `JSON.parse` produces `__proto__` as an own
  // data property, and a non-enumerable own `constructor` is equally unwanted.
  for (const key of Object.getOwnPropertyNames(object)) {
    if (isForbiddenKey(key)) throw new OverlayPrototypeKeyError(key, path)
  }
}

function isPlainValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function emit(value: unknown, depth: number, path: JsonPath): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw fail(`Non-finite number ${String(value)} is not valid canonical JSON`, path)
      }
      // Normalize -0 to 0 so two logically equal states hash identically.
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      throw fail('BigInt is not valid canonical JSON', path)
    case 'function':
      throw fail('Function is not valid canonical JSON', path)
    case 'symbol':
      throw fail('Symbol is not valid canonical JSON', path)
    case 'undefined':
      // Only reachable from an array element; object properties are filtered.
      return 'null'
    default:
      break
  }

  if (!isPlainValue(value)) {
    throw fail(`Unsupported value of type ${typeof value}`, path)
  }

  const toJSON = (value as {toJSON?: unknown}).toJSON
  if (typeof toJSON === 'function') {
    const replaced = (toJSON as (key?: string) => unknown).call(value)
    return emit(replaced, depth, path)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = INDENT.repeat(depth + 1)
    const parts = value.map((item, index) => inner + emit(item, depth + 1, [...path, index]))
    return `[\n${parts.join(',\n')}\n${INDENT.repeat(depth)}]`
  }

  assertNoForbiddenKeys(value, path)

  const keys = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()

  if (keys.length === 0) return '{}'

  const inner = INDENT.repeat(depth + 1)
  const parts = keys.map(
    (key) =>
      `${inner}${JSON.stringify(key)}: ${emit(
        (value as Record<string, unknown>)[key],
        depth + 1,
        [...path, key],
      )}`,
  )
  return `{\n${parts.join(',\n')}\n${INDENT.repeat(depth)}}`
}

/**
 * Serialize a value to canonical JSON text: sorted keys, two-space indent, one
 * trailing newline. This exact byte string is what checksums hash and what
 * checkpoint files contain (PRD §14.3, §13.2).
 */
export function serialize(value: unknown): string {
  return `${emit(value, 0, [])}\n`
}

/** Alias kept for call sites that want the intent spelled out. */
export const serializeCanonical = serialize

/**
 * Serialize without the trailing newline. Used where canonical bytes are embedded
 * in another structure rather than written as a file.
 */
export function serializeCompact(value: unknown): string {
  return emit(value, 0, [])
}

function assertSafeTree(value: unknown, path: JsonPath): void {
  if (!isPlainValue(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeTree(item, [...path, index]))
    return
  }
  assertNoForbiddenKeys(value, path)
  for (const key of Object.keys(value)) {
    assertSafeTree((value as Record<string, unknown>)[key], [...path, key])
  }
}

/**
 * Parse canonical JSON text, rejecting prototype-polluting keys anywhere in the
 * tree (PRD §35.14, §14.3 "Refuse malformed JSON"). Malformed JSON raises a
 * structured error rather than a raw `SyntaxError`.
 */
export function parse(text: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw fail(`Malformed JSON: ${(error as Error).message}`, [], {
      cause: (error as Error).message,
    })
  }
  assertSafeTree(parsed, [])
  return parsed
}

/** Alias kept for call sites that want the intent spelled out. */
export const parseCanonical = parse

/**
 * Parse then re-serialize. `roundTrip(serialize(x))` equals `serialize(x)` for
 * every serializable value — the §35.1 fixpoint property.
 */
export function roundTrip(text: string): string {
  return serialize(parse(text))
}

/**
 * Deep copy of `value` with keys in canonical order and `undefined` properties
 * dropped. Useful where a structure (not text) must be handed on in canonical
 * shape; it goes through the same rejection rules as {@link serialize}.
 */
export function canonicalize<T>(value: T): T {
  return parse(serialize(value)) as T
}

/** True when two values have identical canonical serializations. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return serialize(a) === serialize(b)
}
