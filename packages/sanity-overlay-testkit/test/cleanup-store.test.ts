/**
 * Local cleanup of `.runtime/` growth — `FsOverlayStore.pruneRuntimeHistory`
 * (PRD §15.7 retention, §37 Phase 2 "Local cleanup").
 *
 * ## Why this is not `collectOrphans`
 *
 * `collectOrphans` already reclaims what no manifest head reaches: document
 * revisions, base snapshots, orphan document directories and materialized files.
 * It deliberately does not touch two things that grow without bound and that are
 * NOT orphans:
 *
 * - `.runtime/transactions/` — the §13.10 log. Every record stays reachable
 *   forever by design; that is what makes it a log.
 * - `.runtime/indexes/idempotency/` — the §34.6 deduplication ledger. Deleting a
 *   pointer re-enables a retried request to apply twice, so it can never be
 *   collected as if it were garbage.
 *
 * So pruning them is a separate, explicit, opt-in operation with one thing it is
 * always allowed to do — remove a pointer that already names nothing, which is
 * broken state rather than retained state.
 *
 * Every claim below is checked against the filesystem after the call, not
 * against the report the call returned.
 */
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {encodeLogicalId, serialize} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

vi.setConfig({testTimeout: 15_000, hookTimeout: 15_000})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})))
})

interface Harness {
  root: string
  layout: OverlayLayout
  store: FsOverlayStore
  setNow(value: string): void
}

async function seededHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-cleanup-'))
  roots.push(root)
  let current = '2026-01-01T00:00:00.000Z'
  const store = new FsOverlayStore({root, now: () => current})
  await store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  return {
    root,
    layout: new OverlayLayout(root),
    store,
    setNow: (value) => {
      current = value
    },
  }
}

async function commit(harness: Harness, key: string, logicalId: string): Promise<string> {
  const result = await harness.store.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: key,
    actor: CONTRACT_ACTOR,
    mutations: [],
    records: [documentRecordFixture({logicalId, title: `Title ${key}`})],
  })
  return result.transaction.transactionId
}

/** Commit `count` transactions on one document, one per second, oldest first. */
async function commitSeries(harness: Harness, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    harness.setNow(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())
    ids.push(await commit(harness, `key-${index}`, 'article-1'))
  }
  return ids
}

function pointerDir(harness: Harness): string {
  return join(harness.layout.indexesDir, 'idempotency')
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

describe('pruneRuntimeHistory — `.runtime/` growth (PRD §15.7, §37 Phase 2)', () => {
  it('removes nothing from a healthy overlay when no retention is asked for', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 3)

    const transactionsBefore = await names(harness.layout.transactionsDir)
    const pointersBefore = await names(pointerDir(harness))

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID)
    expect(report.transactions).toEqual([])
    expect(report.pointers).toEqual([])
    expect(report.scannedTransactions).toBe(3)
    expect(report.scannedPointers).toBe(3)

    expect(await names(harness.layout.transactionsDir)).toEqual(transactionsBefore)
    expect(await names(pointerDir(harness))).toEqual(pointersBefore)
  })

  it('always removes an idempotency pointer that names nothing', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 2)

    /* A crash between step 3 (manifest) and step 4 (pointer) cannot produce this,
     * but a half-finished manual cleanup can — and `getTransaction` already
     * answers `null` for it, so the pointer is broken state, not retained state. */
    const dangling = join(pointerDir(harness), `${encodeLogicalId('ghost-key')}.json`)
    await writeFile(
      dangling,
      serialize({
        formatVersion: 1,
        idempotencyKey: 'ghost-key',
        transactionId: 'tx-does-not-exist',
        committedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    )
    expect(await names(pointerDir(harness))).toHaveLength(3)

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID)
    expect(report.pointers).toHaveLength(1)
    expect(report.pointers[0]!.reason).toBe('dangling')
    expect(report.transactions).toEqual([])

    /* Only the ghost went. The two real pointers still resolve. */
    expect(await names(pointerDir(harness))).toHaveLength(2)
    await expect(
      harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: 'key-0'}),
    ).resolves.not.toBeNull()
  })

  it('removes an unparseable pointer file as garbage', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 1)
    const broken = join(pointerDir(harness), `${encodeLogicalId('broken-key')}.json`)
    await writeFile(broken, '{ not json', 'utf8')

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID)
    expect(report.pointers).toHaveLength(1)
    expect(report.pointers[0]!.transactionId).toBeNull()
    expect(await names(pointerDir(harness))).toHaveLength(1)
  })

  it('keepLast retains the newest transactions and drops the rest with their pointers', async () => {
    const harness = await seededHarness()
    const ids = await commitSeries(harness, 5)

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 2})
    expect(report.transactions.map((entry) => entry.transactionId)).toEqual(ids.slice(0, 3))

    const remaining = await names(harness.layout.transactionsDir)
    expect(remaining).toEqual(ids.slice(3).map((id) => `${id}.json`).sort())

    /* Every pruned transaction took its pointer with it — no dangling pointer is
     * created by pruning, which is the one thing pruning must never do. */
    expect(await names(pointerDir(harness))).toHaveLength(2)
    for (const key of ['key-0', 'key-1', 'key-2']) {
      await expect(
        harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: key}),
      ).resolves.toBeNull()
    }
    for (const key of ['key-3', 'key-4']) {
      await expect(
        harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: key}),
      ).resolves.not.toBeNull()
    }
  })

  it('keepAfterRevision retains everything committed after that overlay revision', async () => {
    const harness = await seededHarness()
    const ids = await commitSeries(harness, 4)

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {
      keepAfterRevision: 2,
    })
    expect(report.transactions.map((entry) => entry.overlayRevisionAfter)).toEqual([1, 2])
    expect(await names(harness.layout.transactionsDir)).toEqual(
      ids.slice(2).map((id) => `${id}.json`).sort(),
    )
  })

  it('never prunes the transaction the manifest still names as its head', async () => {
    const harness = await seededHarness()
    const ids = await commitSeries(harness, 3)
    const head = ids[ids.length - 1]!

    const report = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 0})
    expect(report.retainedHead).toBe(head)
    expect(report.transactions.map((entry) => entry.transactionId)).toEqual(ids.slice(0, 2))

    /* The manifest's `transactionHead` must keep resolving to a readable record. */
    const manifest = await harness.store.readManifest(CONTRACT_OVERLAY_ID)
    expect(manifest.transactionHead).toBe(head)
    await expect(
      harness.store.getTransaction(CONTRACT_OVERLAY_ID, {transactionId: head}),
    ).resolves.not.toBeNull()
  })

  it('dryRun reports exactly what it would remove and removes nothing', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 4)

    const transactionsBefore = await names(harness.layout.transactionsDir)
    const pointersBefore = await names(pointerDir(harness))

    const dry = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {
      keepLast: 1,
      dryRun: true,
    })
    expect(dry.dryRun).toBe(true)
    expect(dry.transactions).toHaveLength(3)
    expect(await names(harness.layout.transactionsDir)).toEqual(transactionsBefore)
    expect(await names(pointerDir(harness))).toEqual(pointersBefore)

    /* Applying afterwards removes precisely the set the dry run named. */
    const wet = await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 1})
    expect(wet.transactions.map((entry) => entry.transactionId)).toEqual(
      dry.transactions.map((entry) => entry.transactionId),
    )
    expect(await names(harness.layout.transactionsDir)).toHaveLength(1)
  })

  it('keeps idempotency keys distinct — `k` and `k+separator+k` do not collide', async () => {
    const harness = await seededHarness()
    harness.setNow('2026-01-01T00:00:00.000Z')
    await commit(harness, 'k', 'article-1')
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'k-k', 'article-2')
    harness.setNow('2026-01-01T00:00:02.000Z')
    await commit(harness, 'k-k-k', 'article-3')

    /* Prune the oldest only. The two survivors must both still resolve by key —
     * a pruner that matched pointers by prefix or by a joined key would take
     * them all. */
    await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 2})

    await expect(
      harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: 'k'}),
    ).resolves.toBeNull()
    for (const key of ['k-k', 'k-k-k']) {
      const found = await harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: key})
      expect(found?.idempotencyKey).toBe(key)
    }
  })

  it('leaves the document revisions the manifest still reaches alone', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 3)
    const before = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')

    await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 0})

    /* Pruning the LOG must not touch CONTENT. Re-read from disk. */
    const after = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(after?.record).toEqual(before?.record)
    const raw = await readFile(join(harness.layout.root, after!.storageRef), 'utf8')
    expect(raw.length).toBeGreaterThan(0)
  })

  it('refuses to prune another overlay identity (PRD §12.2)', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 1)
    await expect(
      harness.store.pruneRuntimeHistory('some-other-overlay-000000000000', {keepLast: 0}),
    ).rejects.toMatchObject({code: 'OVERLAY_IDENTITY_MISMATCH'})
  })

  it('leaves the history a checkpoint would export untouched, because there is none', async () => {
    const harness = await seededHarness()
    await commitSeries(harness, 3)
    await harness.store.pruneRuntimeHistory(CONTRACT_OVERLAY_ID, {keepLast: 0})

    /* §29.2 exports semantic intent, never the runtime log — so a fully pruned
     * log costs a checkpoint nothing. Proven by exporting after the prune. */
    const dir = join(harness.root, 'checkpoint-out')
    const exported = await harness.store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})
    expect(exported.files).toContain('manifest.json')
    expect(exported.files.some((file) => file.includes('.runtime'))).toBe(false)
  })
})
