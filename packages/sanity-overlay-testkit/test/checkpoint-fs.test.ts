/**
 * Checkpoint I/O and the direct-edit watcher on the filesystem — PRD §14.3,
 * §14.4, §29.1, §29.4, §29.7, §35.14.
 *
 * The *format* is asserted in `checkpoint-format.test.ts` against an in-memory
 * file map. This file asserts the half that only a real filesystem can prove:
 * that the bytes land on disk before the promise resolves, that a corrupt
 * checkpoint leaves the target store untouched rather than half-loaded, and that
 * a developer editing `.sanity-overlay/` by hand is detected, repaired where
 * PRD §14.3 says it is repairable, and refused where it is not.
 *
 * Assertions read the files back off disk with plain `node:fs` rather than
 * through the store, so nothing is checked against a value the store just
 * computed.
 */
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  CHECKPOINT_MANIFEST_FILE,
  checkpointIntentPath,
  checksum,
  decodeLogicalId,
  isOverlayStoreError,
  parse,
  serialize,
  sha256Hex,
  verifyCheckpoint,
} from '../../sanity-overlay-core/src/index'
import type {
  CheckpointDocumentIntent,
  OverlayCheckpointChecksums,
  OverlayRevalidationReport,
} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, readCheckpointDir, watchOverlay} from '../../sanity-overlay-store-fs/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

vi.setConfig({testTimeout: 20_000, hookTimeout: 20_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})))
})

async function makeRoot(prefix = 'overlay-checkpoint-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface Harness {
  root: string
  store: FsOverlayStore
  renames: string[]
}

async function makeStore(): Promise<Harness> {
  const root = await makeRoot()
  const renames: string[] = []
  const store = new FsOverlayStore({
    root,
    now: () => FIXED_NOW,
    hooks: {
      beforeRename({targetPath}) {
        renames.push(targetPath)
      },
    },
  })
  return {root, store, renames}
}

async function seededStore(): Promise<Harness> {
  const harness = await makeStore()
  await harness.store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  await harness.store.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: 'checkpoint-seed',
    actor: CONTRACT_ACTOR,
    mutations: [{type: 'patch', id: 'article-1', operations: []}],
    records: [
      documentRecordFixture({logicalId: 'article-1', title: 'One'}),
      documentRecordFixture({logicalId: 'legacy.page.v2', title: 'Dotted'}),
    ],
  })
  harness.renames.length = 0
  return harness
}

/** Every file under `dir`, as relative POSIX paths. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {recursive: true, withFileTypes: true})
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).split('\\').join('/'))
    .sort()
}

const ARTICLE_INTENT = checkpointIntentPath('article-1')

describe('exportCheckpoint — writing the §29.1 canonical tree', () => {
  it('writes every canonical file and a checksum manifest that covers them', async () => {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')

    const result = await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    expect(result.overlayId).toBe(CONTRACT_OVERLAY_ID)
    expect(result.dir).toBe(dir)
    expect(await listFiles(dir)).toEqual(result.files)

    /* Independent oracle: hash the bytes off disk and compare to the manifest. */
    const record = parse(
      await readFile(join(dir, CHECKPOINT_CHECKSUMS_FILE), 'utf8'),
    ) as OverlayCheckpointChecksums
    expect(Object.keys(record.files).sort()).toEqual(
      result.files.filter((path) => path !== CHECKPOINT_CHECKSUMS_FILE).sort(),
    )
    for (const [path, digest] of Object.entries(record.files)) {
      expect(sha256Hex(await readFile(join(dir, path), 'utf8'))).toBe(digest)
    }

    /* The document directory names decode back to the logical IDs. */
    expect(
      result.files
        .filter((path) => path.startsWith('documents/'))
        .map((path) => decodeLogicalId(path.split('/')[1]!))
        .sort(),
    ).toEqual(['article-1', 'legacy.page.v2'])
  })

  it('is durable before it resolves: every file is renamed into place, no temp files remain', async () => {
    const {store, renames} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')

    const result = await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    /* One atomic rename per written file, all completed before the await returned. */
    expect(renames).toHaveLength(result.files.length)
    const onDisk = await listFiles(dir)
    expect(onDisk.some((path) => path.includes('.tmp-'))).toBe(false)
    /* Reading synchronously right now must find complete, valid bytes. */
    for (const path of result.files) {
      expect(() => parse(readFileSync(join(dir, path), 'utf8'))).not.toThrow()
    }
  })

  it('re-exports byte-identically from the same logical state (§34.17)', async () => {
    const {store} = await seededStore()
    const first = join(await makeRoot('overlay-out-'), 'a')
    const second = join(await makeRoot('overlay-out-'), 'b')

    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir: first})
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir: second})

    const read = async (dir: string): Promise<Record<string, string>> =>
      Object.fromEntries(
        await Promise.all(
          (await listFiles(dir)).map(async (path) => [path, await readFile(join(dir, path), 'utf8')]),
        ),
      )
    expect(await read(second)).toEqual(await read(first))
  })

  it('exports in place without rewriting the live canonical files', async () => {
    const {store, root} = await seededStore()
    const live = join(root, '.sanity-overlay')
    const before = await readFile(join(live, ARTICLE_INTENT), 'utf8')
    const manifestBefore = await readFile(join(live, CHECKPOINT_MANIFEST_FILE), 'utf8')

    const result = await store.exportCheckpoint(CONTRACT_OVERLAY_ID)

    expect(result.dir).toBe(live)
    expect(await readFile(join(live, ARTICLE_INTENT), 'utf8')).toBe(before)
    expect(await readFile(join(live, CHECKPOINT_MANIFEST_FILE), 'utf8')).toBe(manifestBefore)
    /* The one thing the live tree lacked. */
    expect(result.files).toContain(CHECKPOINT_CHECKSUMS_FILE)
    expect(verifyCheckpoint(await readCheckpointDir(live)).ok).toBe(true)
  })
})

describe('importCheckpoint — loading a committed tree (PRD §29.7)', () => {
  it('reproduces the same logical state in a fresh store', async () => {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    const peer = await makeStore()
    const result = await peer.store.importCheckpoint(dir)

    expect(result.importedDocuments).toBe(2)
    expect(result.importedSnapshots).toBe(2)
    expect(result.repaired).toEqual([])

    expect(await peer.store.readManifest(CONTRACT_OVERLAY_ID)).toEqual(
      await store.readManifest(CONTRACT_OVERLAY_ID),
    )
    for (const logicalId of ['article-1', 'legacy.page.v2']) {
      const source = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, logicalId)
      const imported = await peer.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, logicalId)
      expect(imported?.intent).toEqual(source?.intent)
      expect(imported?.baseSnapshot).toEqual(source?.baseSnapshot)
    }
    expect((await peer.store.verifyChecksums(CONTRACT_OVERLAY_ID)).ok).toBe(true)
  })

  it('re-exports byte-identically to the checkpoint it imported', async () => {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    const peer = await makeStore()
    await peer.store.importCheckpoint(dir)
    const roundTripped = join(await makeRoot('overlay-out-'), 'again')
    await peer.store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir: roundTripped})

    for (const path of await listFiles(dir)) {
      expect(await readFile(join(roundTripped, path), 'utf8'), path).toBe(
        await readFile(join(dir, path), 'utf8'),
      )
    }
    expect(await listFiles(roundTripped)).toEqual(await listFiles(dir))
  })

  it('refuses to import over live state without an explicit opt-in', async () => {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    await expect(store.importCheckpoint(dir)).rejects.toThrow(/already exists/i)
    const forced = await store.importCheckpoint(dir, {overwrite: true})
    expect(forced.importedDocuments).toBe(2)
  })

  it('rejects a checkpoint belonging to a different overlay', async () => {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})

    const peer = await makeStore()
    await expect(
      peer.store.importCheckpoint(dir, {expectOverlayId: 'a-different-overlay'}),
    ).rejects.toMatchObject({code: 'OVERLAY_IDENTITY_MISMATCH'})
  })
})

describe('divergence on disk — corrupt fails clearly, nothing half-loads', () => {
  async function tamperedCheckpoint(
    edit: (dir: string) => Promise<void>,
  ): Promise<{dir: string; peer: Harness}> {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})
    await edit(dir)
    return {dir, peer: await makeStore()}
  }

  /** Nothing at all was written into the target store. */
  async function expectUntouched(peer: Harness): Promise<void> {
    await expect(peer.store.readManifest(CONTRACT_OVERLAY_ID)).rejects.toMatchObject({
      code: 'OVERLAY_NOT_FOUND',
    })
  }

  it('refuses a snapshot whose bytes no longer hash to its own name', async () => {
    const {dir, peer} = await tamperedCheckpoint(async (target) => {
      const snapshots = (await listFiles(target)).filter((path) => path.startsWith('snapshots/'))
      const path = join(target, snapshots[0]!)
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.replace('base body', 'tampered body'), 'utf8')
      /* Keep the checksum manifest self-consistent, so the violated content
       * address is the only remaining signal. */
      const manifestPath = join(target, CHECKPOINT_CHECKSUMS_FILE)
      const record = parse(await readFile(manifestPath, 'utf8')) as OverlayCheckpointChecksums
      const next = {
        ...record,
        files: {...record.files, [snapshots[0]!]: sha256Hex(await readFile(path, 'utf8'))},
      }
      const {checksum: _drop, ...rest} = next
      await writeFile(manifestPath, serialize({...next, checksum: checksum(rest)}), 'utf8')
    })

    await expect(peer.store.importCheckpoint(dir)).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    })
    await expectUntouched(peer)
  })

  it('refuses a truncated intent file', async () => {
    const {dir, peer} = await tamperedCheckpoint(async (target) => {
      const path = join(target, ARTICLE_INTENT)
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.slice(0, Math.floor(text.length / 2)), 'utf8')
    })

    await expect(peer.store.importCheckpoint(dir)).rejects.toMatchObject({
      code: 'OVERLAY_STORE_CORRUPT',
    })
    await expectUntouched(peer)
  })

  it('refuses a checkpoint with no checksum manifest', async () => {
    const {dir, peer} = await tamperedCheckpoint(async (target) => {
      await rm(join(target, CHECKPOINT_CHECKSUMS_FILE))
    })

    await expect(peer.store.importCheckpoint(dir)).rejects.toMatchObject({
      code: 'OVERLAY_STORE_CORRUPT',
    })
    await expectUntouched(peer)
  })

  it('refuses prototype-polluting JSON (PRD §35.14)', async () => {
    const {dir, peer} = await tamperedCheckpoint(async (target) => {
      await writeFile(
        join(target, ARTICLE_INTENT),
        '{\n  "__proto__": {\n    "checkpointPolluted": true\n  }\n}\n',
        'utf8',
      )
    })

    await expect(peer.store.importCheckpoint(dir)).rejects.toMatchObject({
      code: 'OVERLAY_STORE_CORRUPT',
    })
    expect(({} as Record<string, unknown>).checkpointPolluted).toBeUndefined()
    await expectUntouched(peer)
  })
})

describe('repairable metadata on disk — a hand edit is not corruption (PRD §14.3)', () => {
  /** Edit `intent.json` the way a developer or coding agent would. */
  async function handEditedCheckpoint(): Promise<{dir: string; peer: Harness}> {
    const {store} = await seededStore()
    const dir = join(await makeRoot('overlay-out-'), 'checkpoint')
    await store.exportCheckpoint(CONTRACT_OVERLAY_ID, {dir})
    const path = join(dir, ARTICLE_INTENT)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"One"', '"Edited by hand"'), 'utf8')
    return {dir, peer: await makeStore()}
  }

  it('imports the edit and repairs the stale checksums', async () => {
    const {dir, peer} = await handEditedCheckpoint()

    const result = await peer.store.importCheckpoint(dir)
    expect(result.repaired).toContain(ARTICLE_INTENT)
    expect(result.issues.every((issue) => issue.repairable)).toBe(true)

    /* The edit survived, and the stored file now carries a checksum matching it. */
    const stored = parse(
      await readFile(join(peer.root, '.sanity-overlay', ARTICLE_INTENT), 'utf8'),
    ) as CheckpointDocumentIntent
    expect(stored.draft?.overrides).toEqual([{path: ['title'], value: 'Edited by hand'}])
    const {checksum: recorded, ...rest} = stored
    expect(recorded).toBe(checksum(rest))
    expect((await peer.store.verifyChecksums(CONTRACT_OVERLAY_ID)).ok).toBe(true)
  })

  it('rejects the same edit when the caller asks for strictness, writing nothing', async () => {
    const {dir, peer} = await handEditedCheckpoint()

    await expect(peer.store.importCheckpoint(dir, {onDivergence: 'reject'})).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    })
    await expect(peer.store.readManifest(CONTRACT_OVERLAY_ID)).rejects.toMatchObject({
      code: 'OVERLAY_NOT_FOUND',
    })
  })
})

describe('direct-edit watcher (PRD §14.3 "Watch ... for direct agent edits", §14.4)', () => {
  const intentPathIn = (root: string): string => join(root, '.sanity-overlay', ARTICLE_INTENT)

  it('detects a hand edit and reports it only after the repair is on disk', async () => {
    const {store, root} = await seededStore()
    const seen: OverlayRevalidationReport[] = []
    const durableAtCallback: boolean[] = []

    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {
      intervalMs: 0,
      onChange(report) {
        seen.push(report)
        /* Synchronous read: if the repair had not been flushed before the
         * callback fired, this would still show the stale checksum. */
        const stored = parse(readFileSync(intentPathIn(root), 'utf8')) as CheckpointDocumentIntent
        const {checksum: recorded, ...rest} = stored
        durableAtCallback.push(recorded === checksum(rest))
      },
    })

    await watcher.poll()
    seen.length = 0
    durableAtCallback.length = 0

    const path = intentPathIn(root)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"One"', '"Edited in place"'), 'utf8')

    const report = await watcher.poll()
    watcher.close()

    expect(report.changed).toEqual(['article-1'])
    expect(report.repairedChecksums).toContain(ARTICLE_INTENT)
    expect(report.invalid).toEqual([])
    expect(seen).toHaveLength(1)
    expect(durableAtCallback).toEqual([true])

    /* And the edit is what the store now serves. */
    const served = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(served?.intent?.draft?.overrides).toEqual([
      {path: ['title'], value: 'Edited in place'},
    ])
  })

  it('recovers from an invalid file: refuses it, keeps serving the last valid state', async () => {
    const {store, root} = await seededStore()
    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {intervalMs: 0})
    await watcher.poll()

    const before = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    await writeFile(intentPathIn(root), '{"logicalId": "article-1", "draft"', 'utf8')

    const report = await watcher.poll()
    watcher.close()

    expect(report.ok).toBe(false)
    expect(report.invalid).toHaveLength(1)
    expect(report.invalid[0]?.logicalId).toBe('article-1')
    /* PRD §14.3 SHOULD — a `.broken` diagnostic copy is on disk. */
    expect(report.invalid[0]?.brokenCopyRef).toBe(`${ARTICLE_INTENT}.broken`)
    await expect(
      readFile(join(root, '.sanity-overlay', `${ARTICLE_INTENT}.broken`), 'utf8'),
    ).resolves.toContain('"logicalId": "article-1", "draft"')

    /* §14.3 "retain the last valid in-memory state": the malformed file is not served. */
    const after = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(after?.intent).toEqual(before?.intent)
  })

  it('refuses a prototype-polluting direct edit (PRD §35.14)', async () => {
    const {store, root} = await seededStore()
    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {intervalMs: 0})
    await watcher.poll()

    await writeFile(
      intentPathIn(root),
      '{\n  "__proto__": {\n    "watcherPolluted": true\n  }\n}\n',
      'utf8',
    )
    const report = await watcher.poll()
    watcher.close()

    expect(report.ok).toBe(false)
    expect(report.invalid[0]?.logicalId).toBe('article-1')
    expect(({} as Record<string, unknown>).watcherPolluted).toBeUndefined()
  })

  it('polls automatically until closed', async () => {
    const {store, root} = await seededStore()
    const seen: OverlayRevalidationReport[] = []
    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {
      intervalMs: 10,
      onChange: (report) => void seen.push(report),
    })

    /* A pass over an untouched tree is silent: `onChange` means "something moved". */
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(seen).toEqual([])

    const path = intentPathIn(root)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"One"', '"Edited by the agent"'), 'utf8')

    await vi.waitFor(
      () => expect(seen.some((report) => report.changed.includes('article-1'))).toBe(true),
      {timeout: 5000, interval: 10},
    )

    watcher.close()
    expect(watcher.closed).toBe(true)
    const after = seen.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(seen.length).toBe(after)
  })

  it('never runs two revalidation passes concurrently', async () => {
    const {store} = await seededStore()
    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {intervalMs: 0})

    const [first, second] = await Promise.all([watcher.poll(), watcher.poll()])
    watcher.close()

    /* A second caller joins the in-flight pass rather than starting a racing one. */
    expect(second).toBe(first)
  })

  it('surfaces a manifest rewritten underneath the store', async () => {
    const {store, root} = await seededStore()
    const watcher = watchOverlay(store, CONTRACT_OVERLAY_ID, {intervalMs: 0})
    await watcher.poll()

    const path = join(root, '.sanity-overlay', CHECKPOINT_MANIFEST_FILE)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"revision": 1', '"revision": 2'), 'utf8')

    const report = await watcher.poll()
    watcher.close()
    expect(report.manifestChanged).toBe(true)
    expect((await store.readManifest(CONTRACT_OVERLAY_ID)).revision).toBe(2)
  })
})
