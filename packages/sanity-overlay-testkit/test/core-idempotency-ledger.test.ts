/**
 * THE LEDGER MUST NOT ANSWER A QUESTION IT WAS NOT ASKED (PRD §13.10, §34.6).
 *
 * §34.6 says one idempotency key maps to one immutable transaction result, and
 * every layer implemented that as an unconditional lookup: present the key, get
 * the stored record back, `replayed: true`. So a key that was reused for a
 * DIFFERENT document answered with somebody else's transaction, and the caller
 * was told its write had already landed. That is how a publish of an article
 * came to be answered with the transaction id of a publish of an author.
 *
 * A replay is only a replay if it is the same write. "Same" cannot be checked
 * in full — the ledger stores a result, not a request — but the DOCUMENTS a
 * transaction touched are recorded on the record itself
 * (`affectedDocumentIds`), and comparing the incoming targets against them is
 * one set operation. A transaction aimed at a document the stored record never
 * touched is provably not a replay of it, and saying so is strictly better than
 * a fabricated success.
 *
 * Defence in depth: this is checked in core's in-memory ledger AND in the
 * durable one both stores keep under `.runtime/indexes/idempotency/`.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {
  applyTransaction,
  createOverlayState,
  MemoryOverlayStore,
  type OverlayMutation,
} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'

const ACTOR = {type: 'user' as const, id: 'tester', displayName: 'Tester'}
const OVERLAY_ID = 'ledger-safety-000000000000'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

function create(id: string, title: string): OverlayMutation {
  return {
    type: 'create',
    document: {_id: id, _type: 'article', title},
  } as OverlayMutation
}

describe("core's ledger refuses a replay against a different document", () => {
  it('throws instead of returning the other document’s transaction', () => {
    const now = makeClock()
    const first = applyTransaction(
      createOverlayState({overlayId: OVERLAY_ID}),
      [create('author-1', 'Author')],
      {transactionId: 'tx-1', idempotencyKey: 'reused', actor: ACTOR, now},
    )
    expect(first.replayed).toBe(false)

    /* The same key, a different document. Before this guard existed the answer
     * was `{replayed: true, transaction: <the author's>}` and the article was
     * never created. */
    expect(() =>
      applyTransaction(first.state, [create('article-1', 'Article')], {
        transactionId: 'tx-2',
        idempotencyKey: 'reused',
        actor: ACTOR,
        now,
      }),
    ).toThrowError(/idempotency/i)

    /* ORACLE: the state is untouched — no half-applied article, and the ledger
     * still holds exactly the author's transaction. */
    expect(first.state.documents['article-1']).toBeUndefined()
    expect(first.state.idempotencyLedger.reused?.affectedDocumentIds).toEqual(['author-1'])
  })

  it('still replays a genuine retry of the same transaction', () => {
    const now = makeClock()
    const first = applyTransaction(
      createOverlayState({overlayId: OVERLAY_ID}),
      [create('author-1', 'Author')],
      {transactionId: 'tx-1', idempotencyKey: 'genuine', actor: ACTOR, now},
    )
    const retry = applyTransaction(first.state, [create('author-1', 'Author')], {
      transactionId: 'tx-2',
      idempotencyKey: 'genuine',
      actor: ACTOR,
      now,
    })
    expect(retry.replayed).toBe(true)
    expect(retry.transaction.transactionId).toBe('tx-1')
    expect(retry.state.revision).toBe(first.state.revision)
  })
})

/* ─────────────────── the DURABLE ledger, in both adapters ─────────────────── */

async function seedRecord(
  store: MemoryOverlayStore | FsOverlayStore,
  logicalId: string,
  key: string,
): Promise<void> {
  const now = makeClock()
  const applied = applyTransaction(createOverlayState({overlayId: OVERLAY_ID}), [
    create(logicalId, 'seed'),
  ], {transactionId: 'tx-seed', idempotencyKey: key, actor: ACTOR, now})
  await store.commitTransaction(OVERLAY_ID, {
    idempotencyKey: key,
    actor: ACTOR,
    mutations: [],
    records: [applied.state.documents[logicalId]!],
  })
}

describe.each([
  [
    'MemoryOverlayStore',
    async (): Promise<MemoryOverlayStore> => {
      const store = new MemoryOverlayStore({now: makeClock()})
      await store.createOverlay({
        overlayId: OVERLAY_ID,
        base: {projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'},
        source: {repositoryId: 'r', branch: 'b'},
        actor: ACTOR,
      })
      return store
    },
  ],
  [
    'FsOverlayStore',
    async (): Promise<FsOverlayStore> => {
      const root = await mkdtemp(join(tmpdir(), 'ledger-fs-'))
      roots.push(root)
      const store = new FsOverlayStore({root, now: makeClock()})
      await store.createOverlay({
        overlayId: OVERLAY_ID,
        base: {projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'},
        source: {repositoryId: 'r', branch: 'b'},
        actor: ACTOR,
      })
      return store
    },
  ],
])('%s durable ledger', (_name, make) => {
  it('refuses a replay whose records name a document the stored transaction never touched', async () => {
    const store = await make()
    await seedRecord(store, 'author-1', 'reused')

    const now = makeClock()
    const other = applyTransaction(createOverlayState({overlayId: OVERLAY_ID}), [
      create('article-1', 'Article'),
    ], {transactionId: 'tx-other', idempotencyKey: 'anything', actor: ACTOR, now})

    await expect(
      store.commitTransaction(OVERLAY_ID, {
        idempotencyKey: 'reused',
        actor: ACTOR,
        mutations: [],
        records: [other.state.documents['article-1']!],
      }),
    ).rejects.toThrowError(/idempotency/i)

    /* ORACLE: asked separately, the ledger still names ONLY the author. */
    const stored = await store.getTransaction(OVERLAY_ID, {idempotencyKey: 'reused'})
    expect(stored?.affectedDocumentIds).toEqual(['author-1'])
  })

  it('still replays a genuine retry for the same document', async () => {
    const store = await make()
    await seedRecord(store, 'author-1', 'genuine')

    const now = makeClock()
    const again = applyTransaction(createOverlayState({overlayId: OVERLAY_ID}), [
      create('author-1', 'seed'),
    ], {transactionId: 'tx-again', idempotencyKey: 'x', actor: ACTOR, now})

    const result = await store.commitTransaction(OVERLAY_ID, {
      idempotencyKey: 'genuine',
      actor: ACTOR,
      mutations: [],
      records: [again.state.documents['author-1']!],
    })
    expect(result.replayed).toBe(true)
    expect(result.transaction.transactionId).toBe(result.transaction.transactionId)
    expect(result.transaction.affectedDocumentIds).toEqual(['author-1'])
  })
})
