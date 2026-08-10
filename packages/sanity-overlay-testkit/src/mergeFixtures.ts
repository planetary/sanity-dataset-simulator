/**
 * Fixture builders and deterministic generators for the W3 merge engine
 * (plan docs/plans/phase-2-core-domain.md §8.5, §8.6).
 *
 * Two things live here:
 *
 * 1. **Triples.** `ancestor` / `currentBase` / `local` fixture builders for the
 *    PRD §35.2 and §35.3 unit corpus, so each test states only what it changes.
 * 2. **A recorded seed corpus.** Plan §10: "run [the property suite] against a
 *    fixed seed corpus recorded in the repository so failures reproduce". The
 *    generator is a hand-rolled 32-bit PRNG — core takes no dependencies, and the
 *    testkit follows the same rule, so there is no `fast-check`.
 */
import {checksum} from 'sanity-overlay-core'
import type {
  BaseDocumentVersion,
  LocalDocumentVersion,
  OverlayConflict,
  OverlayDocumentRecord,
  OverlayOperation,
  OverlayPath,
  SanityDocument,
} from 'sanity-overlay-core'

/* ------------------------------------------------------------------ *
 * Deterministic PRNG
 * ------------------------------------------------------------------ */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  pick<T>(items: readonly T[]): T
  bool(probability?: number): boolean
  /** A random subset preserving input order (each item kept with `probability`). */
  subset<T>(items: readonly T[], probability?: number): T[]
}

/** mulberry32 — small, fast, and identical on every platform and Node version. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive)
  return {
    next,
    int,
    pick: (items) => items[int(items.length)]!,
    bool: (probability = 0.5) => next() < probability,
    subset: (items, probability = 0.5) => items.filter(() => next() < probability),
  }
}

/**
 * The recorded seed corpus (plan §10). Adding a seed is always safe; removing one
 * loses reproduction coverage, so seeds are append-only.
 */
export const MERGE_SEED_CORPUS: readonly number[] = Object.freeze([
  1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946,
  17711, 28657, 46368, 75025, 121393, 196418, 317811, 514229, 832040, 1346269, 2178309, 3524578,
])

/* ------------------------------------------------------------------ *
 * Static triples (PRD §35.2, §35.3)
 * ------------------------------------------------------------------ */

/** The ancestor snapshot captured at first touch (PRD §17.1, §16.3). */
export const ANCESTOR_ARTICLE: SanityDocument = Object.freeze({
  _id: 'article-1',
  _type: 'article',
  _rev: 'base-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Ancestor title',
  summary: 'Ancestor summary',
  views: 10,
  hero: {heading: 'Ancestor heading', subtitle: 'Ancestor subtitle'},
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B'},
  ],
  tags: ['one', 'two'],
}) as SanityDocument

/**
 * The array-shaped ancestor driving the PRD §35.3 corpus.
 *
 * Three keyed `sections` (so an insertion always has a *middle* anchor and the
 * §17.7 ordering rule is observable), a two-block Portable Text `body` with
 * keyed spans, and a non-keyed `tags` array for the §17.7 full-array-touch rule.
 */
export const ANCESTOR_PAGE: SanityDocument = Object.freeze({
  _id: 'page-1',
  _type: 'page',
  _rev: 'base-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Ancestor page',
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B'},
    {_key: 'c', _type: 'section', title: 'Section C'},
  ],
  body: [
    {
      _key: 'block1',
      _type: 'block',
      style: 'normal',
      children: [
        {_key: 'span1', _type: 'span', text: 'Ancestor span one', marks: []},
        {_key: 'span2', _type: 'span', text: 'Ancestor span two', marks: []},
      ],
    },
    {
      _key: 'block2',
      _type: 'block',
      style: 'normal',
      children: [{_key: 'span3', _type: 'span', text: 'Ancestor span three', marks: []}],
    },
  ],
  tags: ['one', 'two', 'three'],
}) as SanityDocument

/** One keyed `section` item. */
export function section(key: string, title: string): Record<string, unknown> {
  return {_key: key, _type: 'section', title}
}

/** One keyed Portable Text `span`. */
export function span(key: string, text: string): Record<string, unknown> {
  return {_key: key, _type: 'span', text, marks: []}
}

/** The `_key` of every item in an array, in order — the array-ordering oracle. */
export function keysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    item !== null && typeof item === 'object' && typeof (item as {_key?: unknown})._key === 'string'
      ? (item as {_key: string})._key
      : '<no-key>',
  )
}

/** A structural clone that is safe to mutate. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** `base`/`local` variants of {@link ANCESTOR_ARTICLE} built by patch function. */
export function variant(
  source: SanityDocument,
  mutate: (document: Record<string, unknown>) => void,
): SanityDocument {
  const next = clone(source) as unknown as Record<string, unknown>
  mutate(next)
  return next as unknown as SanityDocument
}

/**
 * A local materialized document carrying a synthetic `_rev` (PRD §13.9), which is
 * what the mutation engine writes and therefore what merge receives.
 */
export function localVariant(
  source: SanityDocument,
  mutate: (document: Record<string, unknown>) => void,
  options: {rev?: string; updatedAt?: string} = {},
): SanityDocument {
  const next = variant(source, mutate) as unknown as Record<string, unknown>
  next._rev = options.rev ?? 'overlay.4.0123456789ab'
  next._updatedAt = options.updatedAt ?? '2026-08-03T12:00:00.000Z'
  return next as unknown as SanityDocument
}

/* ------------------------------------------------------------------ *
 * Overlay document records (PRD §13.3-§13.5) for the perspective corpus
 * ------------------------------------------------------------------ */

const FIXTURE_TIME = '2026-08-03T12:00:00.000Z'

/** One §13.4 base document version around a snapshot. */
export function baseVersion(
  snapshot: SanityDocument,
  options: {revision?: string; capturedAt?: string} = {},
): BaseDocumentVersion {
  return {
    revision: options.revision ?? (snapshot._rev as string) ?? 'base-rev-1',
    snapshot,
    checksum: checksum(snapshot),
    capturedAt: options.capturedAt ?? FIXTURE_TIME,
  }
}

/** One §13.5 local document version around a materialized document. */
export function localVersion(
  materialized: SanityDocument,
  options: {
    touchedPaths?: OverlayPath[]
    operations?: OverlayOperation[]
    ancestorKind?: LocalDocumentVersion['ancestorKind']
    ancestorRevision?: string
    overlayRevision?: string
  } = {},
): LocalDocumentVersion {
  return {
    materialized,
    touchedPaths: options.touchedPaths ?? [],
    operations: options.operations ?? [],
    ancestorKind: options.ancestorKind ?? 'base-published',
    ...(options.ancestorRevision === undefined ? {} : {ancestorRevision: options.ancestorRevision}),
    overlayRevision: options.overlayRevision ?? '4',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  }
}

export interface OverlayRecordOptions {
  logicalId?: string
  schemaType?: string
  origin?: OverlayDocumentRecord['origin']
  /** Ancestor snapshots captured at first touch (§13.3 `base` block). */
  ancestorPublished?: SanityDocument | null
  ancestorDraft?: SanityDocument | null
  baseStatus?: 'present' | 'deleted' | 'unknown'
  localPublished?: LocalDocumentVersion | null
  localDraft?: LocalDocumentVersion | null
  publishedTombstone?: boolean
  draftTombstone?: boolean
  conflicts?: OverlayConflict[]
}

/** Build a §13.3 overlay document record. Every block defaults to "nothing local". */
export function overlayRecord(options: OverlayRecordOptions = {}): OverlayDocumentRecord {
  const ancestorPublished = options.ancestorPublished ?? null
  const ancestorDraft = options.ancestorDraft ?? null
  const hasBase = ancestorPublished !== null || ancestorDraft !== null
  return {
    formatVersion: 1,
    overlayId: 'overlay-fixture',
    logicalId: options.logicalId ?? 'article-1',
    schemaType: options.schemaType ?? 'article',
    origin: options.origin ?? 'base',
    base:
      hasBase || options.baseStatus !== undefined
        ? {
            firstTouchedAt: FIXTURE_TIME,
            published: ancestorPublished === null ? null : baseVersion(ancestorPublished),
            draft: ancestorDraft === null ? null : baseVersion(ancestorDraft),
            baseStatus: options.baseStatus ?? 'present',
          }
        : null,
    local: {
      published: options.localPublished ?? null,
      draft: options.localDraft ?? null,
      publishedTombstone: options.publishedTombstone ?? false,
      draftTombstone: options.draftTombstone ?? false,
    },
    conflicts: options.conflicts ?? [],
    runtimeRevision: 'overlay.4.0123456789ab',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  }
}

/** The base draft counterpart of {@link ANCESTOR_ARTICLE} (`drafts.` prefixed). */
export const ANCESTOR_ARTICLE_DRAFT: SanityDocument = Object.freeze(
  variant(ANCESTOR_ARTICLE, (document) => {
    document._id = 'drafts.article-1'
    document._rev = 'base-draft-rev-1'
    document.title = 'Ancestor draft title'
  }),
)

/* ------------------------------------------------------------------ *
 * Generated scenarios (plan §8.5)
 * ------------------------------------------------------------------ */

/** Every scalar path the generator may change, on both sides. */
export const SCALAR_PATHS: readonly OverlayPath[] = Object.freeze([
  ['title'],
  ['summary'],
  ['views'],
  ['hero', 'heading'],
  ['hero', 'subtitle'],
  ['sections', {_key: 'a'}, 'title'],
  ['sections', {_key: 'b'}, 'title'],
]) as readonly OverlayPath[]

export interface MergeScenario {
  ancestor: SanityDocument
  currentBase: SanityDocument
  local: SanityDocument
  touchedPaths: OverlayPath[]
  unsetPaths: OverlayPath[]
  /** Paths the generator changed on the base side (for oracle assertions). */
  basePaths: OverlayPath[]
  /** Paths the generator changed on the local side (excluding unsets). */
  localPaths: OverlayPath[]
  /** `_key`s the base side inserted into `sections`. */
  baseInsertedKeys: string[]
  /** `_key`s the local side inserted into `sections`. */
  localInsertedKeys: string[]
  seed: number
}

function writeAt(document: Record<string, unknown>, path: OverlayPath, value: unknown): void {
  let node: unknown = document
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!
    if (typeof segment === 'string') {
      node = (node as Record<string, unknown>)[segment]
    } else if (typeof segment === 'object') {
      const list = node as Record<string, unknown>[]
      node = list.find((item) => item._key === segment._key)!
    }
  }
  const last = path[path.length - 1]!
  ;(node as Record<string, unknown>)[last as string] = value
}

function removeAt(document: Record<string, unknown>, path: OverlayPath): void {
  let node: unknown = document
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!
    if (typeof segment === 'string') node = (node as Record<string, unknown>)[segment]
    else if (typeof segment === 'object') {
      const list = node as Record<string, unknown>[]
      node = list.find((item) => item._key === segment._key)!
    }
  }
  delete (node as Record<string, unknown>)[path[path.length - 1] as string]
}

/**
 * A fresh value for one side of the generator.
 *
 * The two sides draw from disjoint ranges — distinct string prefixes, and
 * numeric bands 1000 apart — so a generated "base changed and local changed"
 * scenario can never accidentally produce equal values and turn a same-path
 * conflict into a silent agreement.
 */
function scalarFor(path: OverlayPath, side: 'base' | 'local', rng: Rng): unknown {
  const last = path[path.length - 1]
  if (last === 'views') return (side === 'base' ? 1000 : 2000) + rng.int(1000)
  return `${side}-${rng.int(1_000_000).toString(36)}`
}

/**
 * Generate one ancestor / base / local triple.
 *
 * The two sides are generated independently from the same ancestor, so the full
 * cross-product of "base changed / local touched" combinations — including
 * same-path changes, disjoint changes, unsets, and concurrent keyed insertions —
 * appears across the seed corpus.
 */
export function generateScenario(seed: number): MergeScenario {
  const rng = createRng(seed)
  const ancestor = clone(ANCESTOR_ARTICLE)

  const basePaths = rng.subset(SCALAR_PATHS, 0.45)
  const localPaths = rng.subset(SCALAR_PATHS, 0.45)
  const unsetPaths = rng
    .subset(
      SCALAR_PATHS.filter((path) => !localPaths.includes(path)),
      0.2,
    )
    .filter((path) => path.length === 1 || typeof path[0] === 'string')

  const currentBase = clone(ancestor)
  const baseRecord = currentBase as unknown as Record<string, unknown>
  for (const path of basePaths) writeAt(baseRecord, path, scalarFor(path, 'base', rng))

  const local = clone(ancestor)
  const localRecord = local as unknown as Record<string, unknown>
  for (const path of localPaths) writeAt(localRecord, path, scalarFor(path, 'local', rng))
  for (const path of unsetPaths) removeAt(localRecord, path)

  const baseInsertedKeys: string[] = []
  const localInsertedKeys: string[] = []
  if (rng.bool(0.6)) {
    const key = `base-${rng.int(1_000_000).toString(36)}`
    baseInsertedKeys.push(key)
    const sections = baseRecord.sections as Record<string, unknown>[]
    sections.splice(rng.int(sections.length + 1), 0, {
      _key: key,
      _type: 'section',
      title: 'Upstream section',
    })
  }
  if (rng.bool(0.6)) {
    const key = `local-${rng.int(1_000_000).toString(36)}`
    localInsertedKeys.push(key)
    const sections = localRecord.sections as Record<string, unknown>[]
    sections.splice(rng.int(sections.length + 1), 0, {
      _key: key,
      _type: 'section',
      title: 'Branch section',
    })
  }

  localRecord._rev = 'overlay.7.0123456789ab'
  localRecord._updatedAt = '2026-08-03T12:00:00.000Z'

  const touchedPaths: OverlayPath[] = [
    ...localPaths.map((path) => path.map((segment) => segment) as OverlayPath),
    ...unsetPaths.map((path) => path.map((segment) => segment) as OverlayPath),
    ...localInsertedKeys.map((key) => ['sections', {_key: key}] as OverlayPath),
  ]

  return {
    ancestor,
    currentBase,
    local,
    touchedPaths,
    unsetPaths: unsetPaths.map((path) => path.map((segment) => segment) as OverlayPath),
    basePaths: basePaths.map((path) => path.map((segment) => segment) as OverlayPath),
    localPaths: localPaths.map((path) => path.map((segment) => segment) as OverlayPath),
    baseInsertedKeys,
    localInsertedKeys,
    seed,
  }
}

/** Every scenario in the recorded corpus (plan §10 reproducibility). */
export function scenarioCorpus(): MergeScenario[] {
  return MERGE_SEED_CORPUS.map((seed) => generateScenario(seed))
}
