/**
 * `FsOverlayStore` — the PRD §35.7 store contract suite plus the §35.9
 * filesystem-specific cases (roadmap Phase 3, PRD §14, §37 Phase 2 "Filesystem
 * store tasks").
 *
 * The §35.7 half is not written here: it is
 * {@link runStoreContractSuite}, exported from the testkit so the Phase 4 Blob
 * adapter runs the identical seventeen cases unchanged (plan §8.6).
 *
 * The §35.9 half below is filesystem-only. Two cases are deliberately reshaped:
 * "Direct agent JSON edit is detected" and "Manual Git merge can recompute and
 * repair checksums" are exercised through `revalidate()` / `repairChecksums()`
 * rather than a live `fs.watch`, because a watcher is a trigger, not a behaviour,
 * and testing it would test Node's event loop rather than the store.
 */
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve, sep} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  MemoryOverlayStore,
  checksum,
  encodeLogicalId,
  parse,
  serialize,
  OverlayNotFoundError as CoreOverlayNotFoundError,
  OverlayStoreError as CoreOverlayStoreError,
  bundleChecksum as coreBundleChecksum,
  documentHeadFromRecord as coreDocumentHeadFromRecord,
  intentFromRecord as coreIntentFromRecord,
  isOverlayStoreError as coreIsOverlayStoreError,
} from '../../sanity-overlay-core/src/index'
import {
  FsOverlayStore,
  OverlayLayout,
  assertWithinRoot,
  documentKey,
  isOverlayStoreError,
} from '../../sanity-overlay-store-fs/src/index'
/* Imported from the shim modules themselves, not through the package index, so a
 * shim that stopped re-exporting core is caught at its own boundary. */
import {
  OverlayNotFoundError as ShimOverlayNotFoundError,
  OverlayStoreError as ShimOverlayStoreError,
  isOverlayStoreError as shimIsOverlayStoreError,
} from '../../sanity-overlay-store-fs/src/errors'
import {
  bundleChecksum as shimBundleChecksum,
  documentHeadFromRecord as shimDocumentHeadFromRecord,
} from '../../sanity-overlay-store-fs/src/contract'
import {intentFromRecord as shimIntentFromRecord} from '../../sanity-overlay-store-fs/src/intent'
import type {CheckpointDocumentIntent} from '../../sanity-overlay-store-fs/src/index'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
  runStoreContractSuite,
  type StoreContractHarness,
} from '../src/storeContract'

/**
 * Every case here is real filesystem I/O — `mkdtemp`, hundreds of atomic
 * write+rename pairs, and full export/import round trips between two stores.
 * "Import canonical state" has been measured at 5703 ms against vitest's 5000 ms
 * default, i.e. it fails on machine load rather than on behaviour. The timeout is
 * raised here, at the file level, because that case is defined inside the shared
 * `runStoreContractSuite` (`../src/storeContract.ts`) and has no per-test lever.
 * This buys headroom only — it does not slow a passing run.
 */
vi.setConfig({testTimeout: 15_000, hookTimeout: 15_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/** Every temporary root this file creates, removed in `afterEach`. */
const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sanity-overlay-fs-'))
  roots.push(root)
  return root
}

interface Harness {
  root: string
  layout: OverlayLayout
  store: FsOverlayStore
  now: () => string
  setNow(value: string): void
}

async function makeHarness(
  options: {root?: string; hooks?: ConstructorParameters<typeof FsOverlayStore>[0]['hooks']} = {},
): Promise<Harness> {
  const root = options.root ?? (await makeRoot())
  let current = FIXED_NOW
  const now = (): string => current
  const store = new FsOverlayStore({root, now, hooks: options.hooks})
  return {
    root,
    layout: new OverlayLayout(root),
    store,
    now,
    setNow: (value: string) => {
      current = value
    },
  }
}

async function seededHarness(): Promise<Harness> {
  const harness = await makeHarness()
  await harness.store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  return harness
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

/* ------------------------------------------------------------------ *
 * PRD §35.7 — the shared contract, run against the filesystem adapter
 * ------------------------------------------------------------------ */

runStoreContractSuite('FsOverlayStore', async (): Promise<StoreContractHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'sanity-overlay-contract-'))
  let current = FIXED_NOW
  const store = new FsOverlayStore({root, now: () => current})
  const layout = new OverlayLayout(root)
  void current
  return {
    store,
    readRaw: (ref) => readFile(layout.resolve(ref), 'utf8'),
    writeRaw: (ref, contents) => writeFile(layout.resolve(ref), contents, 'utf8'),
    intentRef: (logicalId) => layout.relative(layout.intentPath(logicalId)),
    snapshotRef: (contentAddress) => layout.relative(layout.snapshotPath(contentAddress)),
    teardown: () => rm(root, {recursive: true, force: true}),
  }
})

/* ------------------------------------------------------------------ *
 * PRD §35.9 — filesystem-specific tests
 * ------------------------------------------------------------------ */

describe('filesystem store (PRD §35.9)', () => {
  it('Atomic temporary write and rename', async () => {
    const observations: Array<{
      tempPath: string
      targetPath: string
      tempContents: string
      targetContents: string | null
    }> = []

    const harness = await makeHarness({
      hooks: {
        async beforeRename({tempPath, targetPath}) {
          observations.push({
            tempPath,
            targetPath,
            tempContents: await readFile(tempPath, 'utf8'),
            targetContents: (await exists(targetPath))
              ? await readFile(targetPath, 'utf8')
              : null,
          })
        },
      },
    })

    await harness.store.createOverlay({
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
    })
    observations.length = 0

    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Second'}),
    )

    const manifestWrite = observations.find(
      (entry) => entry.targetPath === harness.layout.manifestPath,
    )
    expect(manifestWrite).toBeDefined()

    /* The staging file is a *different* path, it already holds the complete new
     * bytes, and the target still holds the previous committed bytes. That is
     * exactly the PRD §14.3 "temporary file plus rename" guarantee: a concurrent
     * reader sees old-or-new, never a partial file. */
    expect(manifestWrite!.tempPath).not.toBe(manifestWrite!.targetPath)
    expect(manifestWrite!.tempPath.split(sep).pop()).toMatch(/^\.tmp-/)
    expect(parse(manifestWrite!.tempContents)).toMatchObject({revision: 1})
    expect(parse(manifestWrite!.targetContents!)).toMatchObject({revision: 0})

    /* Every file the store writes goes through the same primitive. */
    for (const observation of observations) {
      expect(observation.tempPath).not.toBe(observation.targetPath)
      expect(observation.tempContents.endsWith('\n')).toBe(true)
    }

    /* A failed write leaves the target untouched and no temporary litter. */
    const failing = new FsOverlayStore({
      root: harness.root,
      now: () => FIXED_NOW,
      hooks: {
        beforeRename() {
          throw new Error('simulated crash before rename')
        },
      },
    })
    const before = await readFile(harness.layout.manifestPath, 'utf8')
    await expect(
      failing.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-2'}),
      ),
    ).rejects.toThrow('simulated crash before rename')
    expect(await readFile(harness.layout.manifestPath, 'utf8')).toBe(before)

    const stray: string[] = []
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, {withFileTypes: true})) {
        if (entry.name.startsWith('.tmp-')) stray.push(join(dir, entry.name))
        if (entry.isDirectory()) await walk(join(dir, entry.name))
      }
    }
    await walk(harness.layout.root)
    expect(stray).toEqual([])
  })

  it('Concurrent expected revision conflict', async () => {
    const harness = await seededHarness()
    /* Two independent store instances over one working tree — the local
     * equivalent of two processes (a CLI and the dev server). */
    const other = new FsOverlayStore({root: harness.root, now: () => FIXED_NOW})

    const seenByA = await harness.store.readManifest(CONTRACT_OVERLAY_ID)
    const seenByB = await other.readManifest(CONTRACT_OVERLAY_ID)
    expect(seenByB.revision).toBe(seenByA.revision)

    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Written by A'}),
    )

    let caught: unknown
    try {
      await other.writeManifestConditional(
        CONTRACT_OVERLAY_ID,
        {...seenByB, revision: seenByB.revision + 1, status: 'conflicted'},
        seenByB.revision,
      )
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'OVERLAY_WRITE_CONFLICT')).toBe(true)
    expect((caught as {retryable: boolean}).retryable).toBe(true)
    expect((caught as {details: Record<string, unknown>}).details).toMatchObject({
      expectedRevision: 0,
      actualRevision: 1,
    })

    /* B's stale write changed nothing on disk. */
    const onDisk = parse(await readFile(harness.layout.manifestPath, 'utf8')) as {
      revision: number
      status: string
    }
    expect(onDisk.revision).toBe(1)
    expect(onDisk.status).toBe('active')

    /* The documented recovery is re-read, reapply, retry (PRD §15.4). */
    const fresh = await other.readManifest(CONTRACT_OVERLAY_ID)
    const retried = await other.writeManifestConditional(
      CONTRACT_OVERLAY_ID,
      {...fresh, revision: fresh.revision + 1, status: 'conflicted'},
      fresh.revision,
    )
    expect(retried.revision).toBe(2)
  })

  it('Malformed JSON preserves last valid state', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Last valid title'}),
    )

    const intentPath = harness.layout.intentPath('article-1')
    const validIntent = await readFile(intentPath, 'utf8')
    const validManifest = await readFile(harness.layout.manifestPath, 'utf8')

    /* An agent leaves a half-finished edit behind. */
    await writeFile(intentPath, '{"formatVersion": 1, "logicalId": "article-1",', 'utf8')

    const report = await harness.store.revalidate(CONTRACT_OVERLAY_ID)
    expect(report.ok).toBe(false)
    expect(report.invalid).toHaveLength(1)
    expect(report.invalid[0]).toMatchObject({kind: 'intent', logicalId: 'article-1'})
    expect(report.invalid[0]?.message).toMatch(/JSON/i)

    /* PRD §14.3 SHOULD — a `.broken` diagnostic copy of what failed to parse. */
    const brokenRef = report.invalid[0]?.brokenCopyRef
    expect(brokenRef).toBe('documents/article-1/intent.json.broken')
    expect(await readFile(`${intentPath}.broken`, 'utf8')).toBe(
      '{"formatVersion": 1, "logicalId": "article-1",',
    )

    /* PRD §14.3 MUST — "retain the last valid in-memory state". The malformed
     * bytes are never served as current state (§14.4 step 10). */
    const read = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(read?.intent?.draft?.overrides).toEqual([{path: ['title'], value: 'Last valid title'}])
    expect(serialize(read?.intent)).toBe(validIntent)

    /* The same rule applies to the manifest. */
    await writeFile(harness.layout.manifestPath, '}} not json {{', 'utf8')
    const manifest = await harness.store.readManifest(CONTRACT_OVERLAY_ID)
    expect(manifest.revision).toBe(1)
    expect(serialize(manifest)).toBe(validManifest)
    expect(await readFile(`${harness.layout.manifestPath}.broken`, 'utf8')).toBe('}} not json {{')

    /* A store with no cached state refuses rather than inventing one. */
    const cold = new FsOverlayStore({root: harness.root, now: () => FIXED_NOW})
    let caught: unknown
    try {
      await cold.readManifest(CONTRACT_OVERLAY_ID)
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'OVERLAY_STORE_CORRUPT')).toBe(true)
  })

  it('Direct agent JSON edit is detected', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Before'}),
    )

    /* Baseline: nothing has changed since the store wrote the file. */
    const baseline = await harness.store.revalidate(CONTRACT_OVERLAY_ID)
    expect(baseline.ok).toBe(true)
    expect(baseline.changed).toEqual([])
    expect(baseline.checked).toBe(1)

    /* PRD §14.4 step 1: the agent edits `documents/<id>/intent.json` by hand. */
    const intentPath = harness.layout.intentPath('article-1')
    const edited = parse(await readFile(intentPath, 'utf8')) as CheckpointDocumentIntent
    edited.draft!.overrides = [{path: ['title'], value: 'After a direct edit'}]
    await writeFile(intentPath, serialize(edited), 'utf8')

    /* Steps 2-7: parse, normalize, validate, recompute checksums, emit changed. */
    const report = await harness.store.revalidate(CONTRACT_OVERLAY_ID)
    expect(report.ok).toBe(true)
    expect(report.changed).toEqual(['article-1'])
    expect(report.invalid).toEqual([])
    expect(report.repairedChecksums).toEqual(['documents/article-1/intent.json'])

    /* Step 10 in the negative: a structurally invalid edit is refused. */
    const broken = parse(await readFile(intentPath, 'utf8')) as CheckpointDocumentIntent
    broken.logicalId = 'a-different-document'
    await writeFile(intentPath, serialize(broken), 'utf8')
    const rejected = await harness.store.revalidate(CONTRACT_OVERLAY_ID)
    expect(rejected.ok).toBe(false)
    expect(rejected.invalid[0]?.message).toMatch(/does not match its directory/)

    /* A tombstone that contradicts a live local state is refused too (§34.1). */
    const contradictory = parse(await readFile(intentPath, 'utf8')) as CheckpointDocumentIntent
    contradictory.logicalId = 'article-1'
    contradictory.tombstones = {draft: true, published: false}
    await writeFile(intentPath, serialize(contradictory), 'utf8')
    const contradiction = await harness.store.revalidate(CONTRACT_OVERLAY_ID)
    expect(contradiction.ok).toBe(false)
    expect(contradiction.invalid[0]?.message).toMatch(/tombstone cannot coexist/)
  })

  it('Manual Git merge can recompute and repair checksums', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Ours'}),
    )

    /* A human resolves a merge conflict inside intent.json and leaves the stored
     * checksum untouched — the exact PRD §14.3 / §29.2 scenario. */
    const intentPath = harness.layout.intentPath('article-1')
    const merged = parse(await readFile(intentPath, 'utf8')) as CheckpointDocumentIntent
    const staleChecksum = merged.checksum
    merged.draft!.overrides = [{path: ['title'], value: 'Merged by hand'}]
    await writeFile(intentPath, serialize(merged), 'utf8')

    const before = await harness.store.verifyChecksums(CONTRACT_OVERLAY_ID)
    const issue = before.issues.find((entry) => entry.kind === 'intent')
    expect(issue).toBeDefined()
    /* §14.3 MUST — stale checksum metadata on a semantically valid file is
     * repairable, not a rejection. */
    expect(issue?.repairable).toBe(true)
    expect(issue?.expected).toBe(staleChecksum)

    const repair = await harness.store.repairChecksums(CONTRACT_OVERLAY_ID)
    expect(repair.repaired).toEqual(['documents/article-1/intent.json'])
    expect(repair.unrepairable).toEqual([])

    const repaired = parse(await readFile(intentPath, 'utf8')) as CheckpointDocumentIntent
    expect(repaired.checksum).not.toBe(staleChecksum)
    expect(repaired.draft?.overrides).toEqual([{path: ['title'], value: 'Merged by hand'}])
    expect((await harness.store.verifyChecksums(CONTRACT_OVERLAY_ID)).issues).toEqual([])

    /* Repair never papers over a violated content address. */
    const snapshotDir = harness.layout.snapshotsDir
    const [snapshotFile] = await readdir(snapshotDir)
    await writeFile(
      join(snapshotDir, snapshotFile!),
      serialize({formatVersion: 1, tampered: true}),
      'utf8',
    )
    const second = await harness.store.repairChecksums(CONTRACT_OVERLAY_ID)
    expect(second.repaired).toEqual([])
    expect(second.unrepairable).toHaveLength(1)
    expect(second.unrepairable[0]).toMatchObject({kind: 'snapshot', repairable: false})
  })

  it('Deterministic serialization', async () => {
    /* Two independent working trees, the same logical state, byte-identical
     * output — PRD §14.3 determinism rules and §34.17. */
    const first = await seededHarness()
    const second = await seededHarness()

    const record = documentRecordFixture({logicalId: 'article-1', title: 'Deterministic'})
    /* The same logical value with a different key insertion order. */
    const shuffled = parse(
      JSON.stringify({
        updatedAt: record.updatedAt,
        local: record.local,
        conflicts: record.conflicts,
        runtimeRevision: record.runtimeRevision,
        base: record.base,
        origin: record.origin,
        schemaType: record.schemaType,
        logicalId: record.logicalId,
        overlayId: record.overlayId,
        formatVersion: record.formatVersion,
        createdAt: record.createdAt,
      }),
    ) as typeof record

    await first.store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)
    await second.store.putDocumentRevision(CONTRACT_OVERLAY_ID, shuffled)

    for (const relative of ['manifest.json', 'documents/article-1/intent.json']) {
      const a = await readFile(first.layout.resolve(relative), 'utf8')
      const b = await readFile(second.layout.resolve(relative), 'utf8')
      expect(a).toBe(b)
    }

    const intentText = await readFile(first.layout.intentPath('article-1'), 'utf8')
    /* PRD §14.3: deterministic key ordering, two-space indentation, newline at EOF. */
    expect(intentText.endsWith('}\n')).toBe(true)
    expect(intentText).toContain('\n  "base": {')
    const topLevelKeys = [...intentText.matchAll(/^ {2}"([^"]+)":/gm)].map((match) => match[1])
    expect(topLevelKeys).toEqual([...topLevelKeys].sort())

    /* The content address of the base capture is stable across trees. */
    expect(await readdir(first.layout.snapshotsDir)).toEqual(
      await readdir(second.layout.snapshotsDir),
    )
  })

  it('Git diff contains semantic intent changes, not regenerated full materialized documents', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'First'}),
    )

    /* The committed tree is manifest + intent + snapshots; everything generated
     * lives under `.runtime/` and is ignored (PRD §14.1, §29.2). */
    const ignore = await readFile(harness.layout.resolve('.gitignore'), 'utf8')
    expect(ignore).toContain('.runtime/')
    expect(await exists(harness.layout.resolve('.gitattributes'))).toBe(true)
    expect(await exists(harness.layout.materializedPath('article-1'))).toBe(true)
    expect(harness.layout.materializedPath('article-1')).toContain(
      `${sep}.runtime${sep}materialized${sep}`,
    )

    async function trackedFiles(): Promise<Map<string, string>> {
      const files = new Map<string, string>()
      async function walk(dir: string): Promise<void> {
        for (const entry of await readdir(dir, {withFileTypes: true})) {
          if (entry.name.startsWith('.runtime') || entry.name.startsWith('.tmp-')) continue
          const path = join(dir, entry.name)
          if (entry.isDirectory()) await walk(path)
          else files.set(harness.layout.relative(path), await readFile(path, 'utf8'))
        }
      }
      await walk(harness.layout.root)
      return files
    }

    const before = await trackedFiles()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Second'}),
    )
    const after = await trackedFiles()

    const changed = [...after.keys()].filter((ref) => after.get(ref) !== before.get(ref)).sort()
    /* Only the manifest and the semantic intent move. The base snapshot is
     * immutable and content-addressed, so it is added once and never rewritten. */
    expect(changed).toEqual(['documents/article-1/intent.json', 'manifest.json'])

    const intentDiff = after.get('documents/article-1/intent.json')!
    expect(intentDiff).toContain('"Second"')
    /* The intent is semantic override state, not a re-serialized document. */
    expect(intentDiff).toContain('"overrides"')
    expect(intentDiff).not.toContain('"_rev"')
  })

  it('Reset one document', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1'}),
    )
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-2'}),
    )

    const result = await harness.store.resetDocument(CONTRACT_OVERLAY_ID, 'article-1')

    expect(result.removedDocumentIds).toEqual(['article-1'])
    expect(result.manifest.revision).toBe(3)
    expect(Object.keys(result.manifest.documentHeads)).toEqual(['article-2'])

    expect(await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')).toBeNull()
    expect(await exists(harness.layout.documentDir('article-1'))).toBe(false)
    expect(await exists(harness.layout.materializedPath('article-1'))).toBe(false)
    expect(await exists(harness.layout.revisionDir('article-1'))).toBe(false)

    /* The untouched sibling survives intact and the overlay still verifies. */
    const survivor = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-2')
    expect(survivor?.record?.logicalId).toBe('article-2')
    expect((await harness.store.verifyChecksums(CONTRACT_OVERLAY_ID)).ok).toBe(true)

    /* A `drafts.` alias resolves to the same logical document. */
    await expect(
      harness.store.resetDocument(CONTRACT_OVERLAY_ID, 'drafts.article-2'),
    ).resolves.toMatchObject({removedDocumentIds: ['article-2']})

    let caught: unknown
    try {
      await harness.store.resetDocument(CONTRACT_OVERLAY_ID, 'article-1')
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'OVERLAY_NOT_FOUND')).toBe(true)
  })

  it('Reset entire overlay', async () => {
    const harness = await seededHarness()
    await harness.store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'seed',
      actor: CONTRACT_ACTOR,
      mutations: [{type: 'patch', id: 'article-1', operations: []}],
      records: [
        documentRecordFixture({logicalId: 'article-1'}),
        documentRecordFixture({logicalId: 'article-2'}),
      ],
    })

    /* PRD §29.8 "Reset all documents after confirmation". */
    let unconfirmed: unknown
    try {
      // @ts-expect-error -- confirmation is required by the type as well as at runtime.
      await harness.store.resetOverlay(CONTRACT_OVERLAY_ID, {})
    } catch (error) {
      unconfirmed = error
    }
    expect(isOverlayStoreError(unconfirmed, 'INVALID_REQUEST')).toBe(true)
    expect(Object.keys((await harness.store.readManifest(CONTRACT_OVERLAY_ID)).documentHeads))
      .toHaveLength(2)

    const result = await harness.store.resetOverlay(CONTRACT_OVERLAY_ID, {confirm: true})

    expect(result.removedDocumentIds).toEqual(['article-1', 'article-2'])
    expect(result.manifest.documentHeads).toEqual({})
    expect(result.manifest.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    expect(result.manifest.revision).toBe(2)

    expect(await readdir(harness.layout.documentsDir)).toEqual([])
    expect(await readdir(harness.layout.snapshotsDir)).toEqual([])
    expect(await readdir(harness.layout.materializedDir)).toEqual([])
    expect(await harness.store.listChangedDocuments(CONTRACT_OVERLAY_ID)).toEqual([])

    /* The overlay identity and the audit log survive a reset: §34.6 keeps one
     * idempotency key bound to one immutable result. */
    const manifest = await harness.store.readManifest(CONTRACT_OVERLAY_ID)
    expect(manifest.overlayId).toBe(CONTRACT_OVERLAY_ID)
    expect(
      await harness.store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: 'seed'}),
    ).not.toBeNull()
  })

  it('File path encoding handles IDs with dots and draft prefixes', async () => {
    const harness = await seededHarness()

    const ids = ['legacy.page.v2', 'article-02', 'Uppercase.Id', 'Ünïcødé.slug']
    for (const logicalId of ids) {
      await harness.store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId, title: `Title of ${logicalId}`}),
      )
    }

    const directories = (await readdir(harness.layout.documentsDir)).sort()
    expect(directories).toEqual(ids.map(encodeLogicalId).sort())
    /* Dots never survive into a directory name, so nothing can be read as a path
     * segment or as a hidden file. */
    for (const name of directories) {
      expect(name).not.toContain('.')
      /* Literal `[a-z0-9_-]` plus `~XX` escapes: no separator, no dot, no case
       * collision on a case-insensitive filesystem. */
      expect(name).toMatch(/^(?:[a-z0-9_-]|~[0-9A-F]{2})+$/)
    }
    expect(documentKey('legacy.page.v2')).toBe('legacy~2Epage~2Ev2')

    /* Draft and published forms of one logical document share one record and one
     * directory (PRD §13.3, §35.9). */
    expect(documentKey('drafts.article-02')).toBe(documentKey('article-02'))
    const viaDraft = await harness.store.readDocumentByLogicalId(
      CONTRACT_OVERLAY_ID,
      'drafts.article-02',
    )
    expect(viaDraft?.head.logicalId).toBe('article-02')
    expect(viaDraft?.intent?.logicalId).toBe('article-02')

    /* Reversible: the on-disk name decodes back to the original ID. */
    for (const logicalId of ids) {
      const intent = parse(
        await readFile(harness.layout.intentPath(logicalId), 'utf8'),
      ) as CheckpointDocumentIntent
      expect(intent.logicalId).toBe(logicalId)
    }

    /* Case-only variants cannot collide on a case-insensitive filesystem. */
    expect(documentKey('Uppercase.Id')).not.toBe(documentKey('uppercase.id'))
  })

  it('Path traversal attempts fail', async () => {
    const harness = await seededHarness()
    const overlayRoot = resolve(harness.layout.root)

    /* (a) A hostile logical ID is encoded, never interpreted. */
    for (const hostile of ['../../etc/passwd', '..', '.', 'a/b/c', 'x\\y']) {
      const path = harness.layout.intentPath(hostile)
      expect(path.startsWith(overlayRoot + sep)).toBe(true)
      expect(path).not.toContain(`..${sep}`)
    }

    const hostileId = '../../etc/passwd'
    const written = await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: hostileId, title: 'Contained'}),
    )
    expect(written.storageRef.startsWith('.runtime/revisions/')).toBe(true)
    expect(await exists(join(overlayRoot, '..', '..', 'etc', 'passwd'))).toBe(false)
    const read = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, hostileId)
    expect(read?.record?.logicalId).toBe(hostileId)

    /* (b) A hostile storage ref is refused outright rather than sanitized. */
    for (const escape of ['../../../etc/passwd', '/etc/passwd', '.runtime/../../secrets.json']) {
      let caught: unknown
      try {
        await harness.store.getDocumentRevision(CONTRACT_OVERLAY_ID, escape)
      } catch (error) {
        caught = error
      }
      expect(isOverlayStoreError(caught, 'OVERLAY_PATH_ESCAPE')).toBe(true)
    }

    /* (c) The containment guard itself. */
    expect(assertWithinRoot(overlayRoot, 'documents/x')).toBe(join(overlayRoot, 'documents', 'x'))
    expect(() => assertWithinRoot(overlayRoot, '../outside')).toThrow(/resolves outside/)
    expect(() => assertWithinRoot(overlayRoot, '/absolute/elsewhere')).toThrow(/resolves outside/)

    /* (d) A hand-edited manifest cannot redirect a head outside the overlay. */
    const manifestPath = harness.layout.manifestPath
    const manifest = parse(await readFile(manifestPath, 'utf8')) as {
      documentHeads: Record<string, {storageRef: string}>
    }
    const key = Object.keys(manifest.documentHeads)[0]!
    manifest.documentHeads[key]!.storageRef = '../../../../etc/passwd'
    await writeFile(manifestPath, serialize(manifest), 'utf8')

    const cold = new FsOverlayStore({root: harness.root, now: () => FIXED_NOW})
    let caught: unknown
    try {
      await cold.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, hostileId)
    } catch (error) {
      caught = error
    }
    expect(isOverlayStoreError(caught, 'OVERLAY_PATH_ESCAPE')).toBe(true)

    /* (e) Nothing was created outside the temporary root. */
    const outside = join(harness.root, '..', 'etc')
    expect(await exists(outside)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Layout and scaffolding invariants (PRD §14.1)
 * ------------------------------------------------------------------ */

describe('filesystem layout (PRD §14.1)', () => {
  it('scaffolds the canonical layout with runtime files ignored', async () => {
    const harness = await seededHarness()
    const entries = (await readdir(harness.layout.root)).sort()
    expect(entries).toEqual([
      '.gitattributes',
      '.gitignore',
      '.runtime',
      'README.md',
      'documents',
      'manifest.json',
      'snapshots',
    ])

    const runtime = (await readdir(harness.layout.runtimeDir)).sort()
    expect(runtime).toEqual(['indexes', 'materialized', 'revisions', 'transactions'])

    const attributes = await readFile(harness.layout.resolve('.gitattributes'), 'utf8')
    expect(attributes).toContain('.sanity-overlay/snapshots/** linguist-generated=true')
    expect(attributes).toContain('.sanity-overlay/.runtime/** export-ignore')
  })

  it('requires an injected clock and an absolute root', async () => {
    const root = await makeRoot()
    // @ts-expect-error -- `now` is required by the type as well as at runtime.
    expect(() => new FsOverlayStore({root})).toThrow(/injected `now` clock/)
    expect(() => new FsOverlayStore({root: 'relative/path', now: () => FIXED_NOW})).toThrow(
      /absolute path/,
    )
  })

  it('stores one immutable content-addressed snapshot per captured base state', async () => {
    const harness = await seededHarness()
    const record = documentRecordFixture({logicalId: 'article-1', title: 'One'})

    const first = await harness.store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)
    const second = await harness.store.putDocumentRevision(CONTRACT_OVERLAY_ID, {
      ...record,
      local: {
        ...record.local,
        draft: {...record.local.draft!, materialized: {...record.local.draft!.materialized, title: 'Two'}},
      },
    })

    /* The base capture did not change, so it is stored exactly once (PRD §14.3). */
    expect(second.snapshotRef).toBe(first.snapshotRef)
    expect(await readdir(harness.layout.snapshotsDir)).toEqual([`${first.snapshotRef}.json`])

    const snapshot = parse(
      await readFile(harness.layout.snapshotPath(first.snapshotRef!), 'utf8'),
    )
    expect(checksum(snapshot)).toBe(first.snapshotRef)
  })

  it('recovers unreachable artifacts left by a crash before the manifest write', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Committed'}),
    )

    /* Simulate the §15.3 crash window: the immutable revision landed but the
     * manifest write never happened. */
    const crashing = new FsOverlayStore({
      root: harness.root,
      now: () => FIXED_NOW,
      hooks: {
        beforeRename({targetPath}) {
          if (targetPath === harness.layout.manifestPath) throw new Error('crash')
        },
      },
    })
    await expect(
      crashing.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Never committed'}),
      ),
    ).rejects.toThrow('crash')

    /* The overlay still reads as the last committed state (PRD §34.8). */
    const read = await harness.store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(read?.record?.local.draft?.materialized.title).toBe('Committed')
    expect((await harness.store.readManifest(CONTRACT_OVERLAY_ID)).revision).toBe(1)

    const orphans = await harness.store.collectOrphans(CONTRACT_OVERLAY_ID)
    expect(orphans.orphans.filter((entry) => entry.kind === 'revision')).toHaveLength(1)
    expect(orphans.failures).toEqual([])
    expect((await harness.store.verifyChecksums(CONTRACT_OVERLAY_ID)).ok).toBe(true)
  })

  it('materializes drafts and published state into the ignored runtime directory', async () => {
    const harness = await seededHarness()
    await harness.store.putDocumentRevision(
      CONTRACT_OVERLAY_ID,
      documentRecordFixture({logicalId: 'article-1', title: 'Materialized'}),
    )

    const materialized = parse(
      await readFile(harness.layout.materializedPath('article-1'), 'utf8'),
    ) as {draft: {title: string} | null; published: unknown; generatedAt: string}

    expect(materialized.draft?.title).toBe('Materialized')
    expect(materialized.published).toBeNull()
    expect(materialized.generatedAt).toBe(FIXED_NOW)
  })

  it('creates missing parent directories for a document key', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'nested'), {recursive: true})
    const store = new FsOverlayStore({root: join(root, 'nested'), now: () => FIXED_NOW})
    const manifest = await store.createOverlay({
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
    })
    expect(manifest.revision).toBe(0)
    expect(await exists(join(root, 'nested', '.sanity-overlay', 'manifest.json'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Re-export shim identity — plan §8.1, PRD §10.1
 *
 * `sanity-overlay-store-fs/src/{contract,errors,intent}.ts` are now shims over
 * `sanity-overlay-core/src/store/`, and each one's header claims it re-exports
 * "the *same* declarations — so `instanceof` and `isOverlayStoreError` still
 * hold across package boundaries".
 *
 * That claim needs its own coverage, because the failure mode is invisible
 * everywhere else: a shim that drifted into a *re-declaration* would still
 * type-check, and every behavioural case above would still pass, since each one
 * catches errors raised by the same package it imported the class from. It would
 * break only in production — where the core-resident `MemoryOverlayStore` raises
 * an error that a `catch` written against the fs package fails to recognise, and
 * a retryable write conflict silently becomes an unhandled exception.
 * ------------------------------------------------------------------ */

describe('store-fs re-export shim over core (plan §8.1, PRD §10.1)', () => {
  it('re-exports the identical error declarations rather than copies', () => {
    expect(ShimOverlayStoreError).toBe(CoreOverlayStoreError)
    expect(ShimOverlayNotFoundError).toBe(CoreOverlayNotFoundError)
    expect(shimIsOverlayStoreError).toBe(coreIsOverlayStoreError)
  })

  it('re-exports the identical contract and intent helpers', () => {
    expect(shimBundleChecksum).toBe(coreBundleChecksum)
    expect(shimDocumentHeadFromRecord).toBe(coreDocumentHeadFromRecord)
    expect(shimIntentFromRecord).toBe(coreIntentFromRecord)
  })

  it('lets an error raised by the core adapter be caught through the fs package', async () => {
    const store = new MemoryOverlayStore({now: () => FIXED_NOW})

    let caught: unknown
    try {
      await store.readManifest(CONTRACT_OVERLAY_ID)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ShimOverlayNotFoundError)
    expect(caught).toBeInstanceOf(ShimOverlayStoreError)
    expect(shimIsOverlayStoreError(caught, 'OVERLAY_NOT_FOUND')).toBe(true)
    /* …and through the package index, which is how callers actually import it. */
    expect(isOverlayStoreError(caught, 'OVERLAY_NOT_FOUND')).toBe(true)
  })

  it("lets an error raised by the fs adapter be caught with core's declarations", async () => {
    const store = new FsOverlayStore({root: await makeRoot(), now: () => FIXED_NOW})

    let caught: unknown
    try {
      await store.readManifest(CONTRACT_OVERLAY_ID)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CoreOverlayNotFoundError)
    expect(caught).toBeInstanceOf(CoreOverlayStoreError)
    expect(coreIsOverlayStoreError(caught, 'OVERLAY_NOT_FOUND')).toBe(true)
  })

  it('agrees on the same structured failure for the same contract violation', async () => {
    /* Both adapters raise the *same class* for the §35.7 "Concurrent stale write
     * rejection" line, so an API layer can classify either without knowing which
     * backend produced it (PRD §25.14). */
    const memory = new MemoryOverlayStore({now: () => FIXED_NOW})
    const fs = new FsOverlayStore({root: await makeRoot(), now: () => FIXED_NOW})

    const create = {
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
      actor: CONTRACT_ACTOR,
    }
    await memory.createOverlay(create)
    await fs.createOverlay(create)

    const staleWrite = async (store: FsOverlayStore | MemoryOverlayStore): Promise<unknown> => {
      const current = await store.readManifest(CONTRACT_OVERLAY_ID)
      try {
        await store.writeManifestConditional(
          CONTRACT_OVERLAY_ID,
          {...current, revision: 99},
          98,
        )
      } catch (error) {
        return error
      }
      throw new Error('expected a stale conditional write to be rejected')
    }

    const fromMemory = await staleWrite(memory)
    const fromFs = await staleWrite(fs)

    for (const error of [fromMemory, fromFs]) {
      expect(shimIsOverlayStoreError(error, 'OVERLAY_WRITE_CONFLICT')).toBe(true)
      expect(coreIsOverlayStoreError(error, 'OVERLAY_WRITE_CONFLICT')).toBe(true)
      expect((error as InstanceType<typeof CoreOverlayStoreError>).retryable).toBe(true)
    }
    expect((fromMemory as {constructor: unknown}).constructor).toBe(
      (fromFs as {constructor: unknown}).constructor,
    )
  })
})
