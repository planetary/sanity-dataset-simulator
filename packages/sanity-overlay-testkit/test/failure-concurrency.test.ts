/**
 * PRD §35.7 "Concurrent stale write rejection", §35.9 "Concurrent expected
 * revision conflict", §34.5 "Every successful transaction increments overlay
 * revision exactly once" — proved by forcing the interleaving, not by racing it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `failure-store.test.ts`
 *
 * Every other §33 row is one process meeting one broken disk. This one is two
 * writers meeting each other, and it is the only failure mode in the set that
 * can destroy *committed* work rather than merely fail to produce it. It earned
 * its own file when the defect it describes (a lost update across two
 * `FsOverlayStore` instances on one root) was found and fixed.
 *
 * HOW THE INTERLEAVING IS MADE DETERMINISTIC
 *
 * `FailureLedger.holdOn` parks a writer inside `beforeRename` — after its new
 * manifest bytes are staged, before the rename that publishes them. That is the
 * exact instant at which a second writer would have to be excluded, so parking
 * there turns a race into a scripted sequence. Nothing here sleeps on a guessed
 * duration to make the timing work.
 *
 * THE FALSIFIER FOR "THE SECOND WRITER IS BLOCKED"
 *
 * "B did not finish" is not evidence: B might merely be slow. The evidence used
 * below is that B performs **zero atomic writes** while A is parked — observed
 * through the same ledger, which sees every `beforeRename` from both stores. An
 * unserialized B reaches its first revision write within microseconds, so the
 * observation window closes on the first write B makes rather than on a timer.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import {createFailureLedger, endsWith, until} from '../src/failureInjection'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/**
 * How long the "B made no progress" window stays open.
 *
 * Only an UPPER bound on the observation: the loop exits the instant B writes
 * anything or settles, so an unserialized B fails the case in single-digit
 * milliseconds and this value never lengthens a red run. It is long enough that
 * a loaded machine cannot manufacture a pass.
 */
const BLOCKED_OBSERVATION_MS = 400

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-concurrency-'))
  roots.push(root)
  return root
}

async function readManifestFile(layout: OverlayLayout): Promise<OverlayManifest> {
  return parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
}

interface TwoWriters {
  root: string
  layout: OverlayLayout
  a: FsOverlayStore
  b: FsOverlayStore
  ledger: ReturnType<typeof createFailureLedger>
}

/**
 * Two independent stores over one root — two Studio tabs, a CLI beside a dev
 * server, two serverless invocations on one volume — sharing one ledger so the
 * writes of both are observed on a single timeline.
 */
async function twoWriters(): Promise<TwoWriters> {
  const root = await makeRoot()
  const ledger = createFailureLedger()
  const a = new FsOverlayStore({root, now: () => FIXED_NOW, hooks: ledger.hooks})
  await a.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  const b = new FsOverlayStore({root, now: () => FIXED_NOW, hooks: ledger.hooks})
  await a.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: 'seed',
    actor: CONTRACT_ACTOR,
    mutations: [],
    records: [documentRecordFixture({logicalId: 'article-1', title: 'Base state'})],
  })
  return {root, layout: new OverlayLayout(root), a, b, ledger}
}

function commit(
  store: FsOverlayStore,
  logicalId: string,
  options: {key: string; expectedOverlayRevision?: number},
): Promise<{committed: true} | {code: string}> {
  const request: Parameters<FsOverlayStore['commitTransaction']>[1] = {
    idempotencyKey: options.key,
    actor: CONTRACT_ACTOR,
    mutations: [],
    records: [documentRecordFixture({logicalId, title: logicalId})],
  }
  if (options.expectedOverlayRevision !== undefined) {
    request.expectedOverlayRevision = options.expectedOverlayRevision
  }
  return store.commitTransaction(CONTRACT_OVERLAY_ID, request).then(
    () => ({committed: true}) as const,
    (error: {code?: string}) => ({code: error.code ?? 'unknown'}),
  )
}

describe('§35.7 concurrent stale write rejection — two stores, one root', () => {
  it('excludes the second writer from the commit point while the first holds it', async () => {
    const {layout, a, b, ledger} = await twoWriters()

    /* Park writer A with its new manifest bytes staged and not yet visible. */
    const held = ledger.holdOn(endsWith('manifest.json'))
    let aSettled = false
    const writerA = commit(a, 'article-A', {key: 'writer-a', expectedOverlayRevision: 1}).then(
      (result) => {
        aSettled = true
        return result
      },
    )
    await until(() => held.reached(), 'writer A parked at its commit point')

    /* PROOF THE PARK IS REAL: A is genuinely mid-commit and the manifest on disk
     * still holds the pre-A state. */
    expect(aSettled).toBe(false)
    expect((await readManifestFile(layout)).revision).toBe(1)

    const atPark = ledger.writes.length
    let bSettled: {committed: true} | {code: string} | null = null
    const writerB = commit(b, 'article-B', {key: 'writer-b'}).then((result) => {
      bSettled = result
      return result
    })

    /* THE FALSIFIER: B must not touch the disk at all while A holds the commit
     * point. The loop closes on B's FIRST write, so an unserialized B is caught
     * immediately rather than after the full window. */
    const deadline = Date.now() + BLOCKED_OBSERVATION_MS
    while (Date.now() < deadline && ledger.writes.length === atPark && bSettled === null) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(ledger.writes.length).toBe(atPark)
    expect(bSettled).toBeNull()

    held.release()
    const resultA = await writerA
    const resultB = await writerB

    /* A committed. B, whose precondition was written while it waited, either
     * committed behind A or was refused — never silently overwrote. */
    expect(resultA).toEqual({committed: true})
    expect(resultB).toEqual({committed: true})

    /* §35.7 / §34.5: BOTH heads survive and the revision counted both commits.
     * A lost update shows up here as a missing head and a revision of 2. */
    const manifest = await readManifestFile(layout)
    expect(Object.keys(manifest.documentHeads).sort()).toEqual([
      'article-1',
      'article-A',
      'article-B',
    ])
    expect(manifest.revision).toBe(3)
  })

  it('refuses the waiting writer whose expected revision went stale while it waited', async () => {
    const {layout, a, b, ledger} = await twoWriters()

    const held = ledger.holdOn(endsWith('manifest.json'))
    const writerA = commit(a, 'article-A', {key: 'writer-a', expectedOverlayRevision: 1})
    await until(() => held.reached(), 'writer A parked at its commit point')

    /* B was handed a precondition that is true when it is issued and false by the
     * time it can act on it. §33 "Blob manifest ETag conflict" requires the
     * precondition to be honoured against the state at WRITE time, not read time. */
    let bSettled: {committed: true} | {code: string} | null = null
    const writerB = commit(b, 'article-B', {key: 'writer-b', expectedOverlayRevision: 1}).then(
      (result) => {
        bSettled = result
        return result
      },
    )

    const deadline = Date.now() + BLOCKED_OBSERVATION_MS
    while (Date.now() < deadline && bSettled === null) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(bSettled).toBeNull()

    held.release()
    expect(await writerA).toEqual({committed: true})
    expect(await writerB).toEqual({code: 'OVERLAY_WRITE_CONFLICT'})

    /* The refused writer changed nothing, and the winner is intact. */
    const manifest = await readManifestFile(layout)
    expect(Object.keys(manifest.documentHeads).sort()).toEqual(['article-1', 'article-A'])
    expect(manifest.revision).toBe(2)

    /* "Re-read, reapply idempotently, retry": the retry against the state B can
     * now actually see lands, and lands as a NEW revision. */
    expect(await commit(b, 'article-B', {key: 'writer-b-retry', expectedOverlayRevision: 2})).toEqual(
      {committed: true},
    )
    const after = await readManifestFile(layout)
    expect(after.revision).toBe(3)
    expect(after.documentHeads['article-B']).toBeDefined()
  })

  it('keeps every head when many writers commit through two stores at once', async () => {
    const {layout, a, b} = await twoWriters()

    /* No forced interleaving here — genuine concurrency across two stores, which
     * is what a Studio tab and a running dev server actually produce. The gate is
     * a conservation law: N successful commits, N heads, N revisions. */
    const results = await Promise.all(
      Array.from({length: 12}, (_unused, index) =>
        commit(index % 2 === 0 ? a : b, `article-${String(index).padStart(2, '0')}`, {
          key: `parallel-${index}`,
        }),
      ),
    )
    expect(results.every((result) => 'committed' in result)).toBe(true)

    const manifest = await readManifestFile(layout)
    expect(Object.keys(manifest.documentHeads)).toHaveLength(13)
    expect(manifest.revision).toBe(13)

    /* The independent oracle: a THIRD, freshly constructed store re-reading the
     * tree from cold agrees, so nothing above is an artifact of a writer's cache. */
    const cold = new FsOverlayStore({root: layout.workspaceRoot, now: () => FIXED_NOW})
    const changed = await cold.listChangedDocuments(CONTRACT_OVERLAY_ID)
    expect(changed).toHaveLength(13)
    expect((await cold.exportCanonical(CONTRACT_OVERLAY_ID)).documents).toHaveLength(13)
  })
})
