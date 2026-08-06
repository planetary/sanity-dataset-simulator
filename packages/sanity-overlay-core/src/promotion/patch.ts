/**
 * Minimal patch generation (PRD §30.4 steps 7-8).
 *
 * > 7. Calculate minimal target patches where safe.
 * > 8. Use full create or replace only when required.
 *
 * A whole-document `createOrReplace` is the known failure mode this exists to
 * avoid: it silently reverts every concurrent staging edit on a path the branch
 * never touched, which is the same mistake §14.3 and §29.2 keep generated
 * materialized documents out of the review surface to prevent. So the diff walks
 * the two documents and emits the smallest §13.7 operation set that turns the
 * current target document into the desired one, and only ever falls back to a
 * whole-value operation when a smaller one would not be *correct*:
 *
 * | Fallback                    | Why it is required                              |
 * |-----------------------------|-------------------------------------------------|
 * | Target absent               | Nothing to patch — this is a create.             |
 * | `_type` changed             | §19.7 makes a type change a migration, not a patch. |
 * | Unkeyed array changed       | §13.6 — an array without `_key` support is one touch. |
 * | Keyed array reordered       | Order is not addressable by key; only the array is. |
 * | Duplicate `_key` present    | Key addressing is ambiguous (§13.11 `ARRAY_KEY_COLLISION`). |
 * | Value changed shape         | Object→scalar has no smaller correct expression.  |
 *
 * Note the third column of that table is empty for "a field changed": there is no
 * correctness reason to replace a document because one string moved, and the diff
 * never does.
 *
 * Everything here is pure and total: no clock, no ID source, no IO. The emitted
 * order — every `unset`, then every `set`, then every `insert`, each group sorted
 * by canonical encoded path — is deterministic, which is what PRD §38.4
 * "Promotion plan is deterministic" needs at the operation level.
 */
import {encodeOverlayPath} from '../encoding'
import {canonicalEquals} from '../serialize'
import {deepClone, isPlainObject} from '../mutations/paths'
import type {SanityDocument} from '../types/document'
import type {OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'

/**
 * Fields excluded from every promotion patch.
 *
 * `_rev` is the target's own concern, `_id` is fixed by the operation itself, and
 * PRD §13.9 makes overlay `_createdAt`/`_updatedAt` *synthetic* — §22.5 already
 * records that "promotion assigns real Content Lake timestamps, so preview order
 * can differ after promotion". Writing a synthetic timestamp into staging would
 * turn that accepted divergence into corruption.
 */
export const PROMOTION_IGNORED_FIELDS: readonly string[] = Object.freeze([
  '_id',
  '_rev',
  '_createdAt',
  '_updatedAt',
])

/** One field-level change, for the §30.5 review surface. */
export interface DocumentChange {
  path: OverlayPath
  kind: 'add' | 'remove' | 'change'
  before?: unknown
  after?: unknown
}

export interface DocumentDiff {
  /** The minimal §13.7 operations that turn the target into the desired document. */
  operations: OverlayOperation[]
  /** Field-level changes, sorted by canonical encoded path (PRD §30.5). */
  changes: DocumentChange[]
  /** No operation is needed — the target already matches (§30.3 "No-op"). */
  identical: boolean
  /** The diff had to fall back to a whole-*document* create or replace. */
  wholeDocument: boolean
  /** `_type` differs, which §19.7 classifies as a migration rather than a patch. */
  typeChanged: boolean
}

export interface DiffDocumentsOptions {
  /** Overrides {@link PROMOTION_IGNORED_FIELDS} for the document root. */
  ignoreFields?: readonly string[]
}

interface DiffSink {
  unsets: OverlayOperation[]
  sets: OverlayOperation[]
  inserts: OverlayOperation[]
  changes: DocumentChange[]
}

function pathKey(path: OverlayPath): string {
  return encodeOverlayPath(path)
}

function sortByPath<T extends {path: OverlayPath}>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    const left = pathKey(a.path)
    const right = pathKey(b.path)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined
}

function keyOf(item: unknown): string | null {
  if (!isPlainObject(item)) return null
  const key = item._key
  return typeof key === 'string' ? key : null
}

/** Every item is a plain object carrying a string `_key` (PRD §13.6, §17.7). */
function isKeyedArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every((item) => keyOf(item) !== null)
}

function keysOf(items: ReadonlyArray<Record<string, unknown>>): string[] {
  return items.map((item) => keyOf(item) as string)
}

function hasDuplicates(keys: readonly string[]): boolean {
  return new Set(keys).size !== keys.length
}

function setWholeValue(
  sink: DiffSink,
  path: OverlayPath,
  before: unknown,
  after: unknown,
): void {
  sink.sets.push({type: 'set', path, value: deepClone(after)})
  sink.changes.push({path, kind: 'change', before: deepClone(before), after: deepClone(after)})
}

function diffKeyedArray(
  sink: DiffSink,
  path: OverlayPath,
  before: ReadonlyArray<Record<string, unknown>>,
  after: ReadonlyArray<Record<string, unknown>>,
): void {
  const beforeKeys = keysOf(before)
  const afterKeys = keysOf(after)

  // Ambiguous key addressing — §13.11 `ARRAY_KEY_COLLISION` territory. The whole
  // array is the only unambiguous address left.
  if (hasDuplicates(beforeKeys) || hasDuplicates(afterKeys)) {
    setWholeValue(sink, path, before, after)
    return
  }

  const afterSet = new Set(afterKeys)
  const survivors = beforeKeys.filter((key) => afterSet.has(key))

  // Nothing survives: every anchor a targeted insert could use is gone.
  if (survivors.length === 0) {
    setWholeValue(sink, path, before, after)
    return
  }

  // Relative order of the survivors is not addressable by key, so a reorder is a
  // whole-array operation. It is *not* a whole-document one.
  //
  // The two sequences are compared element-wise rather than by joining them
  // with a separator. Any separator `S` is ambiguous: the two distinct
  // orderings of the keys `k` and `k + S + k` both join to `k + S + k + S + k`,
  // so a genuine reorder compares equal and the targeted branch below emits no
  // operation at all for it. Nothing constrains `_key` away from containing any
  // particular character, so the comparison must not depend on one.
  const survivingAfter = afterKeys.filter((key) => survivors.includes(key))
  const reordered =
    survivors.length !== survivingAfter.length ||
    survivors.some((key, index) => key !== survivingAfter[index])
  if (reordered) {
    setWholeValue(sink, path, before, after)
    return
  }

  const beforeByKey = new Map(before.map((item) => [keyOf(item) as string, item]))
  const survivorSet = new Set(survivors)

  for (const key of beforeKeys) {
    if (afterSet.has(key)) continue
    const itemPath: OverlayPath = [...path, {_key: key}]
    sink.unsets.push({type: 'unset', path: itemPath})
    sink.changes.push({
      path: itemPath,
      kind: 'remove',
      before: deepClone(beforeByKey.get(key)),
    })
  }

  for (const item of after) {
    const key = keyOf(item) as string
    if (!survivorSet.has(key)) continue
    diffValue(sink, [...path, {_key: key}], beforeByKey.get(key), item)
  }

  // Runs of consecutive new items share one anchor, so an inserted pair produces
  // one `insert` rather than two, and the emitted order matches the desired order.
  let run: Array<Record<string, unknown>> = []
  let anchorBefore: string | null = null
  const flush = (anchorAfter: string | null): void => {
    if (run.length === 0) return
    const items = run.map((item) => deepClone(item))
    for (const item of run) {
      sink.changes.push({
        path: [...path, {_key: keyOf(item) as string}],
        kind: 'add',
        after: deepClone(item),
      })
    }
    if (anchorBefore !== null) {
      sink.inserts.push({
        type: 'insert',
        path: [...path, {_key: anchorBefore}],
        position: 'after',
        items,
      })
    } else if (anchorAfter !== null) {
      sink.inserts.push({
        type: 'insert',
        path: [...path, {_key: anchorAfter}],
        position: 'before',
        items,
      })
    }
    run = []
  }

  for (const item of after) {
    const key = keyOf(item) as string
    if (survivorSet.has(key)) {
      flush(key)
      anchorBefore = key
      continue
    }
    run.push(item)
  }
  flush(null)
}

function diffObject(
  sink: DiffSink,
  path: OverlayPath,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignoreFields: readonly string[],
): void {
  const names = new Set<string>()
  for (const name of Object.keys(before)) names.add(name)
  for (const name of Object.keys(after)) names.add(name)

  for (const name of [...names].sort()) {
    if (ignoreFields.includes(name)) continue
    const childPath: OverlayPath = [...path, name]
    const inBefore = has(before, name)
    const inAfter = has(after, name)

    if (inBefore && !inAfter) {
      sink.unsets.push({type: 'unset', path: childPath})
      sink.changes.push({path: childPath, kind: 'remove', before: deepClone(before[name])})
      continue
    }
    if (!inBefore && inAfter) {
      sink.sets.push({type: 'set', path: childPath, value: deepClone(after[name])})
      sink.changes.push({path: childPath, kind: 'add', after: deepClone(after[name])})
      continue
    }
    diffValue(sink, childPath, before[name], after[name])
  }
}

function diffValue(sink: DiffSink, path: OverlayPath, before: unknown, after: unknown): void {
  if (canonicalEquals(before, after)) return

  if (isPlainObject(before) && isPlainObject(after)) {
    diffObject(sink, path, before, after, [])
    return
  }
  if (isKeyedArray(before) && isKeyedArray(after)) {
    diffKeyedArray(sink, path, before, after)
    return
  }
  setWholeValue(sink, path, before, after)
}

/**
 * The minimal operation set that turns `target` into `desired`.
 *
 * `target` is the **current staging document** (or `null` when staging has none);
 * `desired` is the resolved overlay document that promotion wants staging to hold.
 */
export function diffDocuments(
  target: SanityDocument | null,
  desired: SanityDocument,
  options: DiffDocumentsOptions = {},
): DocumentDiff {
  if (target === null) {
    return {
      operations: [{type: 'replaceDocument', document: deepClone(desired)}],
      changes: [{path: [], kind: 'add', after: deepClone(desired)}],
      identical: false,
      wholeDocument: true,
      typeChanged: false,
    }
  }

  if (target._type !== desired._type) {
    return {
      operations: [{type: 'replaceDocument', document: deepClone(desired)}],
      changes: [
        {path: ['_type'], kind: 'change', before: target._type, after: desired._type},
      ],
      identical: false,
      wholeDocument: true,
      typeChanged: true,
    }
  }

  const sink: DiffSink = {unsets: [], sets: [], inserts: [], changes: []}
  const ignoreFields = [...(options.ignoreFields ?? PROMOTION_IGNORED_FIELDS), '_type']
  diffObject(sink, [], target as Record<string, unknown>, desired as Record<string, unknown>, ignoreFields)

  const operations: OverlayOperation[] = [
    ...sortByPath(sink.unsets as Array<OverlayOperation & {path: OverlayPath}>),
    ...sortByPath(sink.sets as Array<OverlayOperation & {path: OverlayPath}>),
    ...sortByPath(sink.inserts as Array<OverlayOperation & {path: OverlayPath}>),
  ]

  return {
    operations,
    changes: sortByPath(sink.changes),
    identical: operations.length === 0,
    wholeDocument: false,
    typeChanged: false,
  }
}
