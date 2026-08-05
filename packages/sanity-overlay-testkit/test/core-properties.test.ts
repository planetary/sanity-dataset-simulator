import {describe, expect, it, vi} from 'vitest'
import {
  MAX_ENCODED_ID_LENGTH,
  applyTransaction,
  checkStateChecksums,
  checksum,
  createOverlayState,
  decodeLogicalId,
  decodeOverlayPath,
  encodeLogicalId,
  encodeOverlayPath,
  isEncodedLogicalId,
  parse,
  serialize,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayMutation,
  OverlayOperation,
  OverlayPath,
  OverlayState,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'
import {MERGE_SEED_CORPUS, createRng, type Rng} from '../src/mergeFixtures'

/*
 * Property-based suite, generative half (plan §8.5, PRD §35.1).
 *
 * PRD §35.1 requires the property layer to be "generated over arbitrary valid
 * documents, paths, and operation sequences". The merge properties in
 * `core-w3-merge.test.ts` are generated, but over one fixed fixture varied at
 * seven scalar paths (`mergeFixtures.SCALAR_PATHS`) — no generated document
 * shapes and no generated operation sequences. This file supplies the missing
 * three generators and the four properties that need them:
 *
 * 1. **Serializer determinism and fixpoint** — was an `it.each` table of nine
 *    hand-written samples; now generated documents and generated key orders.
 * 2. **Path and logical-ID round-trip** — was two `it.each` tables (15 + 18
 *    cases); now generated `OverlayPath`s and generated IDs.
 * 3. **Checksum integrity after any generated operation sequence** (§34.4) —
 *    was absent entirely.
 * 4. **Transaction idempotence** (§34.6) — was two hand-written scenarios; now
 *    a property over generated operation sequences.
 *
 * Seed discipline (plan §10): every property runs over a recorded corpus and
 * every assertion embeds its seed, so a failure names its own reproducer. Seeds
 * are append-only — adding one is always safe, removing one loses coverage.
 */

/**
 * Per-test budget (ms).
 *
 * Each property replays a whole recorded seed corpus, which is thousands of
 * generated documents, paths and operation sequences per test — real CPU, no
 * waiting. Measured worst case over six full-suite runs: 4.84 s for the checksum
 * property against vitest's 5 s default, i.e. 97 % of budget consumed on a
 * machine doing nothing else.
 *
 * That margin is the most likely explanation for the previously unreproduced
 * intermittent failure in this file: under a full-suite run the whole repository
 * shares one worker pool, and a CPU-bound property with 3 % headroom is the
 * first thing to lose. Raising the budget cannot mask a property violation —
 * a violated property fails on its assertion, and the assertion names its seed.
 *
 * Seeds and assertions are unchanged.
 */
vi.setConfig({testTimeout: 60_000, hookTimeout: 30_000})

/* ------------------------------------------------------------------ *
 * Recorded seed corpus
 * ------------------------------------------------------------------ */

/**
 * Seeds recorded for *this* file, appended to the existing merge corpus.
 *
 * Chosen to be disjoint from `MERGE_SEED_CORPUS` (which is Fibonacci) so the
 * union is duplicate-free and both corpora stay independently append-only.
 */
export const GENERATOR_SEEDS_APPENDED: readonly number[] = Object.freeze([
  7, 11, 17, 23, 29, 41, 97, 101, 199, 257, 401, 1024, 4096, 65537, 999983, 123456789,
])

/** The corpus every property below runs over. */
const PROPERTY_SEED_CORPUS: readonly number[] = Object.freeze([
  ...MERGE_SEED_CORPUS,
  ...GENERATOR_SEEDS_APPENDED,
])

/* ------------------------------------------------------------------ *
 * Generator 1 — arbitrary canonical-JSON values and documents
 * ------------------------------------------------------------------ */

/**
 * Strings the generator draws from, chosen to hit every case the canonical
 * serializer and the two encoders have to survive: empty, integer-like (which
 * JavaScript reorders ahead of string keys), separators used by both encoders
 * (`.`, `[`, `]`, `\`, `~`), quotes and control characters that must be JSON
 * escaped, multi-byte and astral UTF-8, and the `drafts.` prefix.
 */
export const TEXT_SAMPLES: readonly string[] = Object.freeze([
  '',
  'title',
  'hero',
  '0',
  '10',
  '007',
  'a.b',
  'a[0]',
  'back\\slash',
  'tilde~2E',
  'quote"inside',
  'new\nline',
  'tab\tchar',
  '\u0000\u001F',
  'ünïcødé',
  '日本語',
  '🎉 astral',
  'drafts.article-1',
  ' leading and trailing ',
  'MiXeDcAsE',
])

function text(rng: Rng): string {
  return rng.pick(TEXT_SAMPLES)
}

/** A key that is safe to place in an object (§35.14 forbids the prototype keys). */
function objectKey(rng: Rng): string {
  return text(rng)
}

/**
 * An arbitrary canonical-JSON value.
 *
 * Numbers stay finite (the serializer rejects `NaN`/`Infinity` by design, so
 * generating them would test the rejection, not the fixpoint) and include `-0`,
 * which the serializer normalizes to `0` — a value whose *normalization* must
 * still be a fixpoint.
 */
function jsonValue(rng: Rng, depth: number): unknown {
  const leafOnly = depth <= 0
  const kind = rng.int(leafOnly ? 7 : 9)
  switch (kind) {
    case 0:
      return null
    case 1:
      return rng.bool()
    case 2:
      return rng.int(2000) - 1000
    case 3:
      return rng.int(1000) / 8
    case 4:
      return rng.bool(0.5) ? -0 : 0
    case 5:
      return Number.MAX_SAFE_INTEGER - rng.int(4)
    case 6:
      return text(rng)
    case 7:
      return Array.from({length: rng.int(4)}, () => jsonValue(rng, depth - 1))
    default: {
      const object: Record<string, unknown> = {}
      const size = rng.int(5)
      for (let i = 0; i < size; i++) object[objectKey(rng)] = jsonValue(rng, depth - 1)
      return object
    }
  }
}

/** A keyed array item (`_key` identity is what §17.7 merges on). */
function keyedItem(rng: Rng, index: number): Record<string, unknown> {
  return {
    _key: `k${index}-${rng.int(1_000_000).toString(36)}`,
    _type: rng.pick(['section', 'span', 'block']),
    title: text(rng),
    value: jsonValue(rng, 1),
  }
}

/**
 * An arbitrary valid Sanity document: system fields, generated scalar fields, a
 * nested object, a keyed array and a non-keyed array. Depth and breadth vary
 * with the seed, so the corpus covers shapes the single merge fixture cannot.
 */
function generateDocument(rng: Rng, id: string): SanityDocument {
  const document: SanityDocument = {
    _id: id,
    _type: rng.pick(['article', 'page', 'author']),
    _createdAt: '2026-01-01T00:00:00.000Z',
    _updatedAt: '2026-01-02T00:00:00.000Z',
  }

  const fieldCount = 1 + rng.int(5)
  for (let i = 0; i < fieldCount; i++) {
    document[`field${i}`] = jsonValue(rng, 2 + rng.int(2))
  }

  document.counter = rng.int(100)
  document.label = text(rng)
  document.nested = {
    heading: text(rng),
    deeper: {value: jsonValue(rng, 2), flag: rng.bool()},
  }
  document.items = Array.from({length: 1 + rng.int(4)}, (_unused, index) => keyedItem(rng, index))
  // Never empty: `insert` needs an anchor, and an empty array would make the
  // sequence generator produce an operation the engine rejects by contract.
  document.tags = Array.from({length: 1 + rng.int(4)}, () => text(rng))

  return document
}

/**
 * A structurally identical document with every object's keys re-inserted in a
 * different order. Canonical serialization must be blind to insertion order
 * (PRD §14.3), so this is the independent half of the determinism property.
 */
function shuffleKeys(value: unknown, rng: Rng): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, rng))
  if (value === null || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const keys = Object.keys(source)
  for (let i = keys.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[keys[i], keys[j]] = [keys[j]!, keys[i]!]
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = shuffleKeys(source[key], rng)
  return out
}

/* ------------------------------------------------------------------ *
 * Generator 2 — arbitrary paths and logical IDs
 * ------------------------------------------------------------------ */

/** An arbitrary `OverlayPath`: string, numeric index and `{_key}` segments. */
function generatePath(rng: Rng): OverlayPath {
  const length = rng.int(5)
  const path: OverlayPath = []
  for (let i = 0; i < length; i++) {
    const kind = rng.int(3)
    if (kind === 0) path.push(text(rng))
    else if (kind === 1) path.push(rng.int(2000))
    else path.push({_key: text(rng)})
  }
  return path
}

/**
 * An arbitrary logical document ID.
 *
 * Built from the same text samples so dots, `drafts.` prefixes, traversal
 * fragments and non-ASCII bytes all appear; every non-`[a-z0-9_-]` byte costs
 * three encoded characters, so the assembled ID is capped well under the
 * 255-character filename limit rather than being allowed to throw.
 */
function generateLogicalId(rng: Rng): string {
  const parts: string[] = []
  const count = 1 + rng.int(3)
  for (let i = 0; i < count; i++) parts.push(text(rng))
  if (rng.bool(0.3)) parts.unshift('drafts.')
  if (rng.bool(0.2)) parts.push('../..')
  const id = parts.join(rng.bool(0.5) ? '.' : '-')
  // Never empty (the encoder rejects that by contract), and short enough that
  // the worst case (every byte escaped) still fits the filename limit.
  const capped = id.slice(0, 40)
  return capped.length === 0 ? 'x' : capped
}

/* ------------------------------------------------------------------ *
 * Generator 3 — arbitrary operation sequences
 * ------------------------------------------------------------------ */

interface GeneratedSequence {
  document: SanityDocument
  operations: OverlayOperation[]
  seed: number
}

/**
 * Every path that actually exists in a generated document — string, keyed and
 * nested segments alike. Used to drive the encoding round-trip over paths the
 * engine really produces, not only synthetic ones.
 */
function targetPaths(document: SanityDocument): OverlayPath[] {
  const paths: OverlayPath[] = [
    ['label'],
    ['counter'],
    ['tags'],
    ['tags', 0],
    ['nested'],
    ['nested', 'heading'],
    ['nested', 'deeper', 'flag'],
  ]
  const items = document.items as Array<{_key: string}>
  for (const item of items) {
    paths.push(['items', {_key: item._key}])
    paths.push(['items', {_key: item._key}, 'title'])
  }
  for (const key of Object.keys(document)) {
    if (key.startsWith('field')) paths.push([key])
  }
  return paths
}

/**
 * The subset of {@link targetPaths} a generated `set`/`unset` may aim at.
 *
 * `counter`, `tags` and `nested` are excluded on purpose: they are the anchors
 * the numeric, insert and `setIfMissing` operations rely on, and letting the
 * sequence retype them would generate operations the engine rejects by contract
 * (`inc` on a string, `insert` into a scalar) rather than operations that
 * exercise it.
 */
function assignablePaths(document: SanityDocument): OverlayPath[] {
  const paths: OverlayPath[] = [['label'], ['nested', 'heading'], ['nested', 'deeper', 'flag']]
  for (const item of document.items as Array<{_key: string}>) {
    paths.push(['items', {_key: item._key}, 'title'])
  }
  for (const key of Object.keys(document)) {
    if (key.startsWith('field')) paths.push([key])
  }
  return paths
}

/**
 * A sequence of valid §13.7 operations over a generated document.
 *
 * `set`, `setIfMissing`, `unset`, `inc`, `dec` and `insert` are all drawn; each
 * is aimed at a path the document has, and numeric operations are aimed only at
 * `counter`, which is always a number. `diffMatchPatch` and `replaceDocument`
 * are excluded: the first needs a valid patch derived from the current value
 * (that is its own unit corpus, §35.4 case 13) and the second would discard the
 * sequence being generated.
 */
function generateSequence(seed: number): GeneratedSequence {
  const rng = createRng(seed)
  const document = generateDocument(rng, `doc-${seed}`)
  const paths = assignablePaths(document)
  const operations: OverlayOperation[] = []
  const count = 1 + rng.int(8)

  for (let i = 0; i < count; i++) {
    const path = rng.pick(paths)
    switch (rng.int(6)) {
      case 0:
        operations.push({type: 'set', path: [...path], value: jsonValue(rng, 2)})
        break
      case 1:
        operations.push({
          type: 'setIfMissing',
          path: rng.bool() ? ['nested', `new${i}`] : [`extra${i}`],
          value: text(rng),
        })
        break
      case 2:
        operations.push({type: 'unset', path: [...path]})
        break
      case 3:
        operations.push({type: 'inc', path: ['counter'], amount: rng.int(50)})
        break
      case 4:
        operations.push({type: 'dec', path: ['counter'], amount: rng.int(50)})
        break
      default:
        operations.push({
          type: 'insert',
          path: ['tags', 0],
          position: rng.bool() ? 'before' : 'after',
          items: [text(rng)],
        })
    }
  }

  return {document, operations, seed}
}

/* ------------------------------------------------------------------ *
 * Deterministic transaction harness
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const
const NOW = '2026-08-03T12:00:00.000Z'

function options(seed: number, suffix: string): TransactionOptions {
  return {
    transactionId: `01JTX${String(seed).padStart(12, '0')}${suffix}`,
    idempotencyKey: `seed-${seed}-${suffix}`,
    actor: ACTOR,
    now: () => NOW,
  }
}

function emptyState(seed: number): OverlayState {
  return createOverlayState({overlayId: `overlay-${seed}`})
}

/**
 * Create the generated document, then apply its generated operation sequence,
 * as two committed transactions.
 */
function commitSequence(sequence: GeneratedSequence, keySuffix = ''): OverlayState {
  const {document, operations, seed} = sequence
  const create: OverlayMutation = {type: 'create', document}
  const created = applyTransaction(emptyState(seed), [create], options(seed, `a${keySuffix}`))
  const patch: OverlayMutation = {type: 'patch', id: document._id, operations}
  return applyTransaction(created.state, [patch], options(seed, `b${keySuffix}`)).state
}

/* ------------------------------------------------------------------ *
 * Corpus health
 * ------------------------------------------------------------------ */

describe('generative property corpus (plan §10 — recorded seeds)', () => {
  it('is non-trivial, duplicate-free and disjoint from the merge corpus', () => {
    expect(PROPERTY_SEED_CORPUS.length).toBeGreaterThanOrEqual(32)
    expect(new Set(PROPERTY_SEED_CORPUS).size).toBe(PROPERTY_SEED_CORPUS.length)
    const merge = new Set(MERGE_SEED_CORPUS)
    expect(GENERATOR_SEEDS_APPENDED.filter((seed) => merge.has(seed))).toEqual([])
  })

  /*
   * The sample list claims to cover "control characters that must be JSON
   * escaped". Written as *raw bytes* that claim was false: esbuild silently
   * drops a literal U+0000 while transforming the file, so the generator ran
   * without the one byte the canonical serializer and both encoders are most
   * likely to mishandle — and a raw NUL also makes git treat this file as
   * binary. The samples must therefore be written as escapes, and this test
   * fails if a raw control byte is ever reintroduced and eaten again.
   */
  it('really contains the control characters the corpus claims to cover', () => {
    const codePoints = new Set(TEXT_SAMPLES.flatMap((sample) => [...sample].map((c) => c.codePointAt(0))))
    for (const required of [0x00, 0x1f, 0x09, 0x0a]) {
      expect({codePoint: required, present: codePoints.has(required)}).toEqual({
        codePoint: required,
        present: true,
      })
    }
  })

  it('generates materially different documents across the corpus', () => {
    // A generator that ignored its seed would satisfy every property below
    // vacuously, so the corpus is required to produce distinct shapes.
    const shapes = new Set(
      PROPERTY_SEED_CORPUS.map((seed) => {
        const document = generateDocument(createRng(seed), 'doc')
        return serialize(document)
      }),
    )
    expect(shapes.size).toBe(PROPERTY_SEED_CORPUS.length)
  })
})

/* ------------------------------------------------------------------ *
 * PRD §35.1 property 1 — canonical serialization is deterministic and a fixpoint
 * ------------------------------------------------------------------ */

describe('property: canonical serialization is a fixpoint over generated documents (§35.1, §14.3, §34.17)', () => {
  it('serialize(parse(serialize(x))) === serialize(x) for every generated document', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const document = generateDocument(createRng(seed), `doc-${seed}`)
      const once = serialize(document)
      expect({seed, bytes: serialize(parse(once))}).toEqual({seed, bytes: once})
    }
  })

  it('is byte-identical across key-insertion orders of the same logical value', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      const document = generateDocument(rng, `doc-${seed}`)
      const reordered = shuffleKeys(document, createRng(seed ^ 0x5f5f))
      expect({seed, bytes: serialize(reordered)}).toEqual({seed, bytes: serialize(document)})
    }
  })

  it('is stable under repeated evaluation and produces one checksum per logical value', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const document = generateDocument(createRng(seed), `doc-${seed}`)
      const reordered = shuffleKeys(document, createRng(seed + 1))
      expect({seed, a: serialize(document)}).toEqual({seed, a: serialize(document)})
      expect({seed, sum: checksum(reordered)}).toEqual({seed, sum: checksum(document)})
    }
  })

  it('holds for arbitrary generated values, not only whole documents', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      for (let i = 0; i < 8; i++) {
        const value = jsonValue(rng, 4)
        const once = serialize(value)
        expect({seed, i, bytes: serialize(parse(once))}).toEqual({seed, i, bytes: once})
      }
    }
  })
})

/* ------------------------------------------------------------------ *
 * PRD §35.1 property 2 — path and logical-ID encoding round-trips
 * ------------------------------------------------------------------ */

describe('property: path and logical-ID encoding round-trip over generated inputs (§35.1, §13.6, §35.9)', () => {
  it('decodeOverlayPath(encodeOverlayPath(p)) equals p for every generated path', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      for (let i = 0; i < 12; i++) {
        const path = generatePath(rng)
        const encoded = encodeOverlayPath(path)
        expect({seed, i, path: decodeOverlayPath(encoded)}).toEqual({seed, i, path})
        // Re-encoding the decoded path must reproduce the same string, so the
        // canonical form is unique per path, not merely reversible.
        expect({seed, i, encoded: encodeOverlayPath(decodeOverlayPath(encoded))}).toEqual({
          seed,
          i,
          encoded,
        })
      }
    }
  })

  it('encodes distinct generated paths to distinct strings', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      const seen = new Map<string, OverlayPath>()
      for (let i = 0; i < 12; i++) {
        const path = generatePath(rng)
        const encoded = encodeOverlayPath(path)
        const previous = seen.get(encoded)
        if (previous !== undefined) {
          expect({seed, encoded, path}).toEqual({seed, encoded, path: previous})
        }
        seen.set(encoded, path)
      }
    }
  })

  it('decodeLogicalId(encodeLogicalId(id)) equals id for every generated ID', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      for (let i = 0; i < 12; i++) {
        const id = generateLogicalId(rng)
        const encoded = encodeLogicalId(id)
        expect({seed, i, id: decodeLogicalId(encoded)}).toEqual({seed, i, id})
        expect({seed, i, ok: isEncodedLogicalId(encoded)}).toEqual({seed, i, ok: true})
        // §35.9 "Path traversal attempts fail": the encoded form is a single
        // filesystem-safe name whatever the ID contained — no separator, no
        // dot-name, never empty.
        const traversal = /[/\\]/.test(encoded) || encoded === '.' || encoded === '..'
        expect({seed, i, traversal, empty: encoded.length === 0}).toEqual({
          seed,
          i,
          traversal: false,
          empty: false,
        })
        expect({seed, i, len: encoded.length <= MAX_ENCODED_ID_LENGTH}).toEqual({
          seed,
          i,
          len: true,
        })
      }
    }
  })

  it('encodes distinct generated IDs to distinct storage keys', () => {
    const seen = new Map<string, string>()
    for (const seed of PROPERTY_SEED_CORPUS) {
      const rng = createRng(seed)
      for (let i = 0; i < 12; i++) {
        const id = generateLogicalId(rng)
        const encoded = encodeLogicalId(id)
        const previous = seen.get(encoded)
        if (previous !== undefined) {
          expect({seed, encoded, id}).toEqual({seed, encoded, id: previous})
        }
        seen.set(encoded, id)
      }
    }
  })

  it('round-trips the paths a generated document actually contains', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const document = generateDocument(createRng(seed), `doc-${seed}`)
      for (const path of targetPaths(document)) {
        expect({seed, path: decodeOverlayPath(encodeOverlayPath(path))}).toEqual({seed, path})
      }
    }
  })
})

/* ------------------------------------------------------------------ *
 * PRD §35.1 property — checksum integrity after generated operation sequences
 * ------------------------------------------------------------------ */

describe('property: checksums match content after any generated operation sequence (§35.1, §34.4)', () => {
  it('every stored digest in the committed state recomputes (§34.4 as an executable check)', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const state = commitSequence(generateSequence(seed))
      expect({seed, violations: checkStateChecksums(state)}).toEqual({seed, violations: []})
    }
  })

  it('the transaction result checksum equals an independently recomputed record checksum', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const sequence = generateSequence(seed)
      const state = commitSequence(sequence)
      const last = state.transactions[state.transactions.length - 1]!
      for (const [documentId, stored] of Object.entries(last.resultChecksums)) {
        const record = state.documents[documentId]!
        // Independent oracle: SHA-256 over the canonical serialization of the
        // committed record, recomputed here rather than read back from the
        // transaction that wrote it.
        expect({seed, documentId, sum: stored}).toEqual({
          seed,
          documentId,
          sum: checksum(record),
        })
      }
      expect({seed, ids: Object.keys(last.resultChecksums)}).toEqual({
        seed,
        ids: [sequence.document._id],
      })
    }
  })

  it("the materialized document's synthetic _rev commits to its own content", () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const sequence = generateSequence(seed)
      const state = commitSequence(sequence)
      const record = state.documents[sequence.document._id]!
      const version = record.local.published ?? record.local.draft!
      const withoutRev: SanityDocument = {...version.materialized}
      delete withoutRev._rev
      expect({seed, rev: version.materialized._rev}).toEqual({
        seed,
        rev: `overlay.${version.overlayRevision}.${checksum(withoutRev).slice(0, 12)}`,
      })
    }
  })

  it('a tampered committed record is detected by the same check', () => {
    // The property above can only be trusted if the check it runs is capable of
    // failing, so the same corpus is replayed with one byte of content changed.
    for (const seed of PROPERTY_SEED_CORPUS) {
      const state = commitSequence(generateSequence(seed))
      const documentId = Object.keys(state.documents)[0]!
      const record = JSON.parse(JSON.stringify(state.documents[documentId])) as (typeof state.documents)[string]
      const version = record.local.published ?? record.local.draft!
      version.materialized.tamperedField = `tampered-${seed}`
      const tampered: OverlayState = {...state, documents: {[documentId]: record}}
      expect({seed, clean: checkStateChecksums(tampered).length === 0}).toEqual({
        seed,
        clean: false,
      })
    }
  })
})

/* ------------------------------------------------------------------ *
 * PRD §35.1 property — transaction idempotence over generated sequences
 * ------------------------------------------------------------------ */

describe('property: replaying a generated transaction never changes state (§35.1, §34.6, §5.3)', () => {
  it('a replay under the same idempotency key returns the original result byte for byte', () => {
    for (const seed of PROPERTY_SEED_CORPUS) {
      const sequence = generateSequence(seed)
      const first = commitSequence(sequence)
      const patch: OverlayMutation = {
        type: 'patch',
        id: sequence.document._id,
        operations: sequence.operations,
      }
      const replay = applyTransaction(first, [patch], options(seed, 'b'))

      expect({seed, replayed: replay.replayed}).toEqual({seed, replayed: true})
      expect({seed, state: serialize(replay.state)}).toEqual({seed, state: serialize(first)})
      const original = first.transactions[first.transactions.length - 1]!
      expect({seed, id: replay.transaction.transactionId}).toEqual({
        seed,
        id: original.transactionId,
      })
      expect({seed, tx: serialize(replay.transaction)}).toEqual({seed, tx: serialize(original)})
    }
  })

  it('committing the same sequence under a fresh key twice is not the same as replaying it', () => {
    // The complement of the property above: without the idempotency key the
    // engine really does apply the sequence again, so the replay assertion is
    // not passing because the operations happen to be no-ops.
    let applied = 0
    for (const seed of PROPERTY_SEED_CORPUS) {
      const sequence = generateSequence(seed)
      const first = commitSequence(sequence)
      const patch: OverlayMutation = {
        type: 'patch',
        id: sequence.document._id,
        operations: sequence.operations,
      }
      const again = applyTransaction(first, [patch], options(seed, 'c'))
      expect({seed, replayed: again.replayed}).toEqual({seed, replayed: false})
      expect({seed, revision: again.state.revision}).toEqual({seed, revision: first.revision + 1})
      if (serialize(again.state.documents) !== serialize(first.documents)) applied += 1
    }
    // `inc`/`dec`/`insert` are not idempotent, so most seeds must move.
    expect(applied).toBeGreaterThan(PROPERTY_SEED_CORPUS.length / 2)
  })
})
