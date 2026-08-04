/**
 * `MemoryOverlayStore` — Workstream W5, plan §8.1 and §8.2.
 *
 * `memory` is a configured runtime mode (PRD §11.1 `mode: 'off' | 'fs' | 'blob' |
 * 'memory'`), not test scaffolding, so the adapter is held to the identical
 * seventeen §35.7 lines the filesystem adapter passes — run here through the
 * shared {@link runStoreContractSuite} with no adapter-specific relaxations
 * (plan §8.6 "Reusable contract-test runner exported so Phases 3 and 4 can run
 * the same §35.7 suite against fs and Blob adapters unchanged").
 *
 * The second half covers the two properties plan §8.1 asks of *this* adapter and
 * that the shared suite deliberately does not assume: an injectable clock and an
 * injectable ID source, so every test is deterministic.
 */
import {describe, expect, it} from 'vitest'
import {
  MemoryOverlayStorage,
  MemoryOverlayStore,
  checksum,
  isOverlayStoreError,
  serialize,
} from '../../sanity-overlay-core/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
  runStoreContractSuite,
  type StoreContractHarness,
} from '../src/storeContract'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/* ------------------------------------------------------------------ *
 * PRD §35.7 — the shared contract, run against the memory adapter
 * ------------------------------------------------------------------ */

runStoreContractSuite('MemoryOverlayStore', async (): Promise<StoreContractHarness> => {
  const storage = new MemoryOverlayStorage()
  const store = new MemoryOverlayStore({storage, now: () => FIXED_NOW})
  return {
    store,
    readRaw: async (ref) => {
      const contents = storage.read(ref)
      if (contents === null) throw new Error(`No stored bytes at ${ref}`)
      return contents
    },
    writeRaw: async (ref, contents) => {
      storage.write(ref, contents)
    },
    intentRef: (logicalId) => store.layout.intentRef(logicalId),
    snapshotRef: (contentAddress) => store.layout.snapshotRef(contentAddress),
  }
})

/* ------------------------------------------------------------------ *
 * Plan §8.1 — "injectable clock and ID source so every test is deterministic"
 * ------------------------------------------------------------------ */

describe('memory adapter determinism (plan §8.1)', () => {
  function makeStore(
    options: {
      now?: () => string
      newTransactionId?: (context: {
        overlayId: string
        timestamp: string
        sequence: number
      }) => string
    } = {},
  ): MemoryOverlayStore {
    return new MemoryOverlayStore({
      now: options.now ?? (() => FIXED_NOW),
      ...(options.newTransactionId === undefined
        ? {}
        : {newTransactionId: options.newTransactionId}),
    })
  }

  async function seed(store: MemoryOverlayStore): Promise<void> {
    await store.createOverlay({
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
      actor: CONTRACT_ACTOR,
    })
  }

  it('refuses to construct without an injected clock', () => {
    let caught: unknown
    try {
      /* eslint-disable-next-line @typescript-eslint/no-new */
      new MemoryOverlayStore({} as never)
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'INVALID_REQUEST')).toBe(true)
  })

  it('stamps every timestamp from the injected clock, never a wall clock', async () => {
    const ticks = ['2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z', '2026-03-03T00:00:00.000Z']
    let index = 0
    const store = makeStore({now: () => ticks[Math.min(index++, ticks.length - 1)]!})

    await seed(store)
    const manifest = await store.readManifest(CONTRACT_OVERLAY_ID)
    expect(manifest.createdAt).toBe(ticks[0])

    const committed = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'clock-1',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-1'})],
    })
    /* Every timestamp the store produced is one of the injected ticks. */
    expect(ticks).toContain(committed.transaction.committedAt)
    expect(ticks).toContain(committed.manifest.updatedAt)
  })

  it('uses the injected ID source for transaction IDs', async () => {
    const seen: number[] = []
    const store = makeStore({
      newTransactionId: ({overlayId, timestamp, sequence}) => {
        seen.push(sequence)
        return `custom-${overlayId.slice(0, 4)}-${timestamp.slice(0, 4)}-${sequence}`
      },
    })
    await seed(store)

    const first = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'id-source-1',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-1'})],
    })
    const second = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'id-source-2',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-2'})],
    })

    expect(first.transaction.transactionId).toBe('custom-cont-2026-0')
    expect(second.transaction.transactionId).toBe('custom-cont-2026-1')
    expect(seen).toEqual([0, 1])
  })

  it('produces a byte-identical export from two independently driven stores', async () => {
    async function drive(): Promise<string> {
      const store = makeStore()
      await seed(store)
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'determinism',
        actor: CONTRACT_ACTOR,
        mutations: [{type: 'patch', id: 'article-1', operations: []}],
        records: [
          documentRecordFixture({logicalId: 'article-1', title: 'One'}),
          documentRecordFixture({logicalId: 'article-2', title: 'Two'}),
        ],
      })
      return serialize(await store.exportCanonical(CONTRACT_OVERLAY_ID))
    }

    expect(await drive()).toBe(await drive())
  })

  it('keeps two stores fully isolated — memory mode holds no shared state', async () => {
    const a = makeStore()
    const b = makeStore()
    await seed(a)

    await a.putDocumentRevision(CONTRACT_OVERLAY_ID, documentRecordFixture({logicalId: 'only-in-a'}))

    let caught: unknown
    try {
      await b.readManifest(CONTRACT_OVERLAY_ID)
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'OVERLAY_NOT_FOUND')).toBe(true)
  })

  it('stores every artifact as canonical JSON addressed by a stable ref', async () => {
    const storage = new MemoryOverlayStorage()
    const store = new MemoryOverlayStore({storage, now: () => FIXED_NOW})
    await seed(store)
    const record = documentRecordFixture({logicalId: 'legacy.page.v2', title: 'Dotted'})
    const written = await store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)

    /* The revision's own bytes hash to the checksum the head advertises — an
     * oracle independent of the store's own bookkeeping (PRD §34.4). */
    const raw = storage.read(written.storageRef)
    expect(raw).not.toBeNull()
    expect(checksum(JSON.parse(raw!) as unknown)).toBe(written.head.checksum)
    expect(raw).toBe(serialize(record))

    /* Dots and `drafts.` prefixes survive the ref encoding (PRD §35.9). */
    expect(store.layout.intentRef('drafts.legacy.page.v2')).toBe(
      store.layout.intentRef('legacy.page.v2'),
    )
    expect(storage.read(store.layout.intentRef('legacy.page.v2'))).not.toBeNull()
  })
})
