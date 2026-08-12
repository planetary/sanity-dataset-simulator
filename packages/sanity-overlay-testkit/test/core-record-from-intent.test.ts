/**
 * `recordFromIntent` — the inverse of `intentFromRecord` (PRD §14.4 step 6,
 * §29.7 step 4).
 *
 * WHY THIS EXISTS. Found live, 2026-08-11: a fresh clone of a repo with a
 * committed `.sanity-overlay/` served ZERO documents — the overlay API's
 * `hydrateState` keeps only `read.record`, and records live in the gitignored
 * `.runtime/`. The committed surface (`intent.json` + `snapshots/`) is
 * sufficient to materialize every document — §14.4 step 6 says the resolver
 * MUST ("Resolver materializes the virtual document into `.runtime/
 * materialized/`" from a directly-edited intent, and a fresh clone is just
 * "every intent was directly edited") — but no inverse of `intentFromRecord`
 * existed, so the server refused instead.
 *
 * THE ORACLE IS ROUND-TRIP FIDELITY. Every positive case builds a REAL record
 * through `applyTransaction`, projects it with `intentFromRecord` +
 * `baseSnapshotFrom` (exactly what the store persists), rebuilds with
 * `recordFromIntent`, and asserts the rebuilt materialized document deep-equals
 * the original. Fixture intents would prove agreement between two functions
 * nobody runs; the round trip proves agreement with what the store writes.
 *
 * DECLARED FIDELITY LOSSES (asserted, not hidden):
 *   - `operations` survive only as what the intent preserves — keyed array
 *     operations plus the set/unset the overrides collapse to. `inc`/`dec`/
 *     `diffMatchPatch` history is already collapsed by intent compaction
 *     itself (§29.2 determinism), so nothing here loses more than the
 *     committed format does.
 *   - per-layer `touchedPaths` cannot be split (the intent stores one combined
 *     list); each rebuilt layer carries the combined superset, which biases
 *     future conflict detection CONSERVATIVE, never permissive.
 *   - a patch-mode layer with NO base snapshot is refused (`null`), not faked
 *     — the §14.4 step 10 rule.
 */
import {describe, expect, it} from 'vitest'
import {
  applyTransaction,
  baseSnapshotFrom,
  createBaseSource,
  createOverlayState,
  intentFromRecord,
  publish,
  recordFromIntent,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayDocumentRecord,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

const ACTOR = {id: 'tester', type: 'user' as const}

function fixedClock(instant = '2026-08-11T12:00:00.000Z'): () => string {
  return () => instant
}

let transactionCounter = 0
function tx(overrides: Partial<TransactionOptions> = {}): TransactionOptions {
  transactionCounter += 1
  return {
    transactionId: `01JRF${String(transactionCounter).padStart(6, '0')}`,
    idempotencyKey: `rfi-key-${transactionCounter}`,
    actor: ACTOR,
    now: fixedClock(),
    ...overrides,
  }
}

const BASE_ARTICLE: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'base-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Base title',
  hero: {heading: 'Base heading', subtitle: 'Base subtitle'},
  tags: ['one', 'two'],
  sections: [
    {_key: 'a', _type: 'section', title: 'Section A'},
    {_key: 'b', _type: 'section', title: 'Section B'},
  ],
}

const base = createBaseSource([BASE_ARTICLE])

/** Project the record exactly the way the store persists it, then rebuild. */
function roundTrip(record: OverlayDocumentRecord): OverlayDocumentRecord | null {
  const snapshot = baseSnapshotFrom(record)
  const intent = intentFromRecord(record, snapshot === null ? {} : {snapshotRef: 'sha-of-snapshot'})
  return recordFromIntent(intent, {
    overlayId: record.overlayId,
    baseSnapshot: snapshot,
    runtimeRevision: record.runtimeRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
}

describe('recordFromIntent — branch-created documents (mode: replace)', () => {
  it('round-trips a branch-created draft, body and identity intact', () => {
    const {state} = applyTransaction(
      createOverlayState({overlayId: 'rfi'}),
      [
        {
          type: 'create',
          document: {
            _id: 'drafts.note-1',
            _type: 'note',
            title: 'Fresh — with an em dash',
            body: [{_key: 'b1', _type: 'block', children: [{_key: 's1', _type: 'span', text: 'hi'}]}],
          } as SanityDocument,
        },
      ],
      tx({base}),
    )
    const record = state.documents['note-1']!

    const rebuilt = roundTrip(record)!
    expect(rebuilt).not.toBeNull()
    expect(rebuilt.logicalId).toBe('note-1')
    expect(rebuilt.schemaType).toBe('note')
    expect(rebuilt.origin).toBe('branch')
    expect(rebuilt.local.draft!.materialized).toEqual(record.local.draft!.materialized)
    expect(rebuilt.local.draft!.ancestorKind).toBe('branch-created')
    expect(rebuilt.local.published).toBeNull()
    expect(rebuilt.local.draftTombstone).toBe(false)
  })

  it('round-trips a published branch document (published layer, replace)', () => {
    const first = applyTransaction(
      createOverlayState({overlayId: 'rfi'}),
      [{type: 'create', document: {_id: 'drafts.note-2', _type: 'note', title: 'Publish me'} as SanityDocument}],
      tx({base}),
    )
    const published = publish(first.state, {id: 'note-2'}, tx({base}))
    const record = published.state.documents['note-2']!
    expect(record.local.published).not.toBeNull()

    const rebuilt = roundTrip(record)!
    expect(rebuilt.local.published!.materialized).toEqual(record.local.published!.materialized)
  })
})

describe('recordFromIntent — base-ancestored documents (mode: patch)', () => {
  it('round-trips overrides, unsets and keyed inserts against the snapshot', () => {
    const {state} = applyTransaction(
      createOverlayState({overlayId: 'rfi'}),
      [
        {
          type: 'patch',
          id: 'drafts.article-1',
          operations: [
            {type: 'set', path: ['title'], value: 'Branch title'},
            {type: 'unset', path: ['hero', 'subtitle']},
            {
              type: 'insert',
              path: ['sections', {_key: 'a'}],
              position: 'after',
              items: [{_key: 'a1', _type: 'section', title: 'Inserted'}],
            },
          ],
        },
      ],
      tx({base}),
    )
    const record = state.documents['article-1']!
    expect(record.base).not.toBeNull()

    const rebuilt = roundTrip(record)!
    expect(rebuilt).not.toBeNull()
    expect(rebuilt.origin).toBe('base')

    /* DECLARED LOSS: `_rev` and `_updatedAt` are transaction metadata that
     * live only in `.runtime/`; a rebuild mints a deterministic rehydration
     * `_rev` instead (asserted below). Every CONTENT field must round-trip
     * exactly — replace-mode intents (the other describe) round-trip even the
     * system fields, because the replacement embeds the whole document. */
    const strip = ({_rev, _updatedAt, ...content}: Record<string, unknown>) => content
    expect(strip(rebuilt.local.draft!.materialized)).toEqual(
      strip(record.local.draft!.materialized),
    )
    expect(typeof rebuilt.local.draft!.materialized._rev).toBe('string')
    expect((rebuilt.local.draft!.materialized._rev as string).length).toBeGreaterThan(0)
    /* The declared superset bias: every rebuilt layer carries the combined
     * touched paths, and they cover the original layer's paths. */
    const original = new Set(record.local.draft!.touchedPaths.map((p) => JSON.stringify(p)))
    const covered = new Set(rebuilt.local.draft!.touchedPaths.map((p) => JSON.stringify(p)))
    for (const path of original) expect(covered.has(path)).toBe(true)
  })

  it('refuses a patch-mode layer with no base snapshot rather than guessing', () => {
    const {state} = applyTransaction(
      createOverlayState({overlayId: 'rfi'}),
      [{type: 'patch', id: 'drafts.article-1', operations: [{type: 'set', path: ['title'], value: 'x'}]}],
      tx({base}),
    )
    const record = state.documents['article-1']!
    const intent = intentFromRecord(record, {snapshotRef: 'sha-of-snapshot'})

    expect(
      recordFromIntent(intent, {
        overlayId: 'rfi',
        baseSnapshot: null,
        runtimeRevision: record.runtimeRevision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    ).toBeNull()
  })
})

describe('recordFromIntent — tombstones', () => {
  it('round-trips a draft tombstone as a tombstone, not as an absent layer', () => {
    const created = applyTransaction(
      createOverlayState({overlayId: 'rfi'}),
      [{type: 'create', document: {_id: 'drafts.note-3', _type: 'note', title: 'Doomed'} as SanityDocument}],
      tx({base}),
    )
    const deleted = applyTransaction(
      created.state,
      [{type: 'delete', id: 'note-3'}],
      tx({base}),
    )
    const record = deleted.state.documents['note-3']!
    expect(record.local.draftTombstone).toBe(true)

    const rebuilt = roundTrip(record)!
    expect(rebuilt.local.draftTombstone).toBe(true)
    expect(rebuilt.local.publishedTombstone).toBe(record.local.publishedTombstone)
    expect(rebuilt.local.draft).toBeNull()
  })
})
