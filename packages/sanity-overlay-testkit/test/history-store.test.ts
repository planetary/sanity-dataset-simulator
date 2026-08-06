/**
 * Local overlay history — `FsOverlayStore.readHistory` (PRD §13.10, §14.1
 * `.runtime/transactions/`, §37 Phase 2 "Local runtime history").
 *
 * ## What this is, and what it deliberately is not
 *
 * The store already *writes* an immutable §13.10 transaction record per commit.
 * Until now nothing could read the log back: `getTransaction` answers a point
 * lookup by ID or idempotency key, and `#readAllTransactions` was private to
 * `exportCanonical`. `readHistory` is the read surface — "what did this branch
 * do, in order, and can each step still be read back".
 *
 * It is NOT Sanity's Studio History. That is a Content Lake mendoza stream this
 * system cannot reproduce (PRD §21.10 disables the native control for exactly
 * that reason), and the checkpoint format deliberately drops the transaction log
 * (§29.1, §29.2) — so history is runtime-local and does not survive a checkpoint
 * round trip. The tests below pin both halves: what it gives, and what it does
 * not.
 *
 * ## Assertion discipline
 *
 * Every ordering and membership claim is cross-checked against the actual files
 * in `.runtime/transactions/` read with `node:fs`, never against a list the same
 * call just built. Recoverability is checked by deleting a real revision file and
 * observing the report change.
 */
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayTransactionRecord} from '../../sanity-overlay-core/src/index'
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
  const root = await mkdtemp(join(tmpdir(), 'overlay-history-'))
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

/** Commit one transaction touching `logicalIds`, returning the committed record. */
async function commit(
  harness: Harness,
  key: string,
  logicalIds: readonly string[],
  options: {title?: string} = {},
): Promise<OverlayTransactionRecord> {
  const result = await harness.store.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: key,
    actor: CONTRACT_ACTOR,
    mutations: logicalIds.map((logicalId) => ({
      type: 'patch' as const,
      id: logicalId,
      operations: [
        {type: 'set' as const, path: ['title'], value: options.title ?? `Title ${key}`},
      ],
    })),
    records: logicalIds.map((logicalId) =>
      documentRecordFixture({
        logicalId,
        ...(options.title === undefined ? {} : {title: options.title}),
      }),
    ),
  })
  return result.transaction
}

/** The transaction IDs actually on disk, ascending — the independent oracle. */
async function transactionIdsOnDisk(harness: Harness): Promise<string[]> {
  const entries = await readdir(harness.layout.transactionsDir, {withFileTypes: true})
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort()
}

describe('readHistory — the local transaction log (PRD §13.10, §37 Phase 2)', () => {
  it('returns nothing for an overlay that has committed nothing', async () => {
    const harness = await seededHarness()
    await expect(harness.store.readHistory(CONTRACT_OVERLAY_ID)).resolves.toEqual([])
  })

  it('returns one entry per transaction file on disk', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['article-2'])
    harness.setNow('2026-01-01T00:00:02.000Z')
    await commit(harness, 'key-3', ['article-3'])

    const onDisk = await transactionIdsOnDisk(harness)
    expect(onDisk).toHaveLength(3)

    const history = await harness.store.readHistory(CONTRACT_OVERLAY_ID)
    expect(history.map((entry) => entry.transaction.transactionId).sort()).toEqual(onDisk)
  })

  it('orders newest first by default and oldest first on request', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['article-2'])
    harness.setNow('2026-01-01T00:00:02.000Z')
    await commit(harness, 'key-3', ['article-3'])

    /* §13.10 MUST: transaction IDs are lexicographically ordered by commit time,
     * so the sorted filenames on disk ARE the commit order. */
    const ascending = await transactionIdsOnDisk(harness)

    const newest = await harness.store.readHistory(CONTRACT_OVERLAY_ID)
    expect(newest.map((entry) => entry.transaction.transactionId)).toEqual([...ascending].reverse())

    const oldest = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {order: 'oldest'})
    expect(oldest.map((entry) => entry.transaction.transactionId)).toEqual(ascending)
  })

  it('carries the §13.10 record exactly as it is stored on disk', async () => {
    const harness = await seededHarness()
    const committed = await commit(harness, 'key-1', ['article-1'])

    const [entry] = await harness.store.readHistory(CONTRACT_OVERLAY_ID)
    const raw = parse(
      await readFile(harness.layout.transactionPath(committed.transactionId), 'utf8'),
    )
    expect(entry!.transaction).toEqual(raw)
    expect(entry!.transaction.idempotencyKey).toBe('key-1')
    expect(entry!.transaction.overlayRevisionBefore).toBe(0)
    expect(entry!.transaction.overlayRevisionAfter).toBe(1)
  })

  it('filters by document with element-wise comparison, not a joined key', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['post-a', 'post-b'])
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['post-c'])

    const forA = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {documentId: 'post-a'})
    expect(forA.map((entry) => entry.transaction.idempotencyKey)).toEqual(['key-1'])

    /* `k` and `k+S+k` must not collide: a filter for the concatenation of two
     * affected IDs matches nothing, and neither does a strict prefix of one. */
    const joined = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {
      documentId: 'post-a,post-b',
    })
    expect(joined).toEqual([])
    const prefix = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {documentId: 'post'})
    expect(prefix).toEqual([])
  })

  it('normalizes a `drafts.` prefix in the document filter (PRD §13.3)', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])

    const viaDraft = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {
      documentId: 'drafts.article-1',
    })
    expect(viaDraft.map((entry) => entry.transaction.idempotencyKey)).toEqual(['key-1'])
  })

  it('filters by overlay revision and caps with a limit', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['article-2'])
    harness.setNow('2026-01-01T00:00:02.000Z')
    await commit(harness, 'key-3', ['article-3'])

    const since = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {
      sinceRevision: 1,
      order: 'oldest',
    })
    expect(since.map((entry) => entry.transaction.overlayRevisionAfter)).toEqual([2, 3])

    const limited = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {limit: 2})
    expect(limited.map((entry) => entry.transaction.overlayRevisionAfter)).toEqual([3, 2])
  })

  it('names the immutable revision each transaction produced, and proves it is readable', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])

    const [entry] = await harness.store.readHistory(CONTRACT_OVERLAY_ID)
    expect(entry!.artifacts).toHaveLength(1)
    const artifact = entry!.artifacts[0]!
    expect(artifact.logicalId).toBe('article-1')
    expect(artifact.present).toBe(true)
    expect(artifact.current).toBe(true)
    expect(entry!.recoverable).toBe(true)

    /* The ref must resolve to the revision file the commit actually wrote. */
    const stored = parse(await readFile(join(harness.layout.root, artifact.ref), 'utf8')) as {
      logicalId: string
    }
    expect(stored.logicalId).toBe('article-1')
  })

  it('marks a superseded revision as not current but still present', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'], {title: 'First'})
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['article-1'], {title: 'Second'})

    const history = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {order: 'oldest'})
    expect(history[0]!.artifacts[0]!.current).toBe(false)
    expect(history[0]!.artifacts[0]!.present).toBe(true)
    expect(history[1]!.artifacts[0]!.current).toBe(true)
  })

  it('reports a transaction as unrecoverable once its revision file is gone', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'], {title: 'First'})
    harness.setNow('2026-01-01T00:00:01.000Z')
    await commit(harness, 'key-2', ['article-1'], {title: 'Second'})

    const before = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {order: 'oldest'})
    const stale = before[0]!.artifacts[0]!
    expect(stale.present).toBe(true)

    /* Exactly what `collectOrphans` does to an unreachable revision. */
    await rm(join(harness.layout.root, stale.ref), {force: true})

    const after = await harness.store.readHistory(CONTRACT_OVERLAY_ID, {order: 'oldest'})
    expect(after[0]!.artifacts[0]!.present).toBe(false)
    expect(after[0]!.recoverable).toBe(false)
    /* The log entry itself survives: the record of WHAT happened is not the same
     * artifact as the content it produced. */
    expect(after[0]!.transaction.idempotencyKey).toBe('key-1')
  })

  it('separates documents a transaction removed from documents it wrote', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    harness.setNow('2026-01-01T00:00:01.000Z')
    await harness.store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'key-2',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [],
      removedDocumentIds: ['article-1'],
    })

    const [newest] = await harness.store.readHistory(CONTRACT_OVERLAY_ID)
    expect(newest!.transaction.affectedDocumentIds).toEqual(['article-1'])
    expect(newest!.artifacts).toEqual([])
    expect(newest!.removedDocumentIds).toEqual(['article-1'])
    /* A removal produced no artifact, so there is nothing to read back. */
    expect(newest!.recoverable).toBe(false)
  })

  it('refuses to serve another overlay identity (PRD §12.2)', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    await expect(harness.store.readHistory('some-other-overlay-000000000000')).rejects.toMatchObject(
      {code: 'OVERLAY_IDENTITY_MISMATCH'},
    )
  })

  it('does not survive a checkpoint round trip — the log is runtime-only (PRD §29.1, §29.2)', async () => {
    const harness = await seededHarness()
    await commit(harness, 'key-1', ['article-1'])
    expect(await harness.store.readHistory(CONTRACT_OVERLAY_ID)).toHaveLength(1)

    const checkpointDir = join(harness.root, 'checkpoint-out')
    await harness.store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir: checkpointDir})

    /* §29.1's canonical tree carries intent and snapshots only. Nothing under
     * `.runtime/` is exported, so a checkpoint cannot carry the log. */
    const exported = await readdir(checkpointDir)
    expect(exported).not.toContain('.runtime')

    const restoreRoot = await mkdtemp(join(tmpdir(), 'overlay-history-restore-'))
    roots.push(restoreRoot)
    const restored = new FsOverlayStore({
      root: restoreRoot,
      now: () => '2026-02-01T00:00:00.000Z',
    })
    await restored.importCheckpoint(checkpointDir)

    expect(await restored.readHistory(CONTRACT_OVERLAY_ID)).toEqual([])
  })
})
