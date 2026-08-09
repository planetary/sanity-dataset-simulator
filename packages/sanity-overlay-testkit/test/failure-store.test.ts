/**
 * PRD §33 failure modes, storage half — injected against the real filesystem
 * store (PRD §35.15 "Failure injection tests", §34 data-integrity invariants).
 *
 * WHAT THIS SUITE IS FOR, AND WHAT IT REFUSES TO ACCEPT AS A PASS
 *
 * §33 is a table of failures and the behaviour each one is *required* to produce.
 * Every case below therefore does two things that a normal test does not:
 *
 *   1. **It proves the injection took effect.** A failure-injection test that
 *      silently failed to inject would pass — the system would be asked to
 *      survive nothing and would survive it. So each case asserts an independent
 *      witness that the operation genuinely failed: a real `errno` on the thrown
 *      error, a ledger count of injections that actually fired, bytes staged on
 *      disk at the moment of the throw, or a `JSON.parse` that genuinely throws
 *      over the bytes that were planted.
 *   2. **It asserts against disk, never against the return value.** The two
 *      defects this repository has already shipped were both a component telling
 *      the truth about its own intentions and a lie about the world. The oracle
 *      here is `node:fs`.
 *
 * The §33 rows covered by this file:
 *
 *   | §33 row                    | case |
 *   |----------------------------|------|
 *   | Filesystem JSON malformed  | truncated intent, truncated manifest, schema-invalid manifest |
 *   | Blob manifest corrupted    | filesystem analogue: schema/checksum failure ⇒ read-only, restorable |
 *   | Local disk write fails     | genuine EACCES, and injected ENOSPC at the commit point |
 *   | Blob manifest ETag conflict| filesystem analogue: concurrent writers, conditional revision |
 *   | Cleanup partially fails    | one undeletable orphan |
 *
 * `beforeRename` is the store's own production injection surface (declared in
 * `store-fs` for §35.9); nothing here needs a production change.
 */
import {chmod, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {checksum, parse, serialize} from '../../sanity-overlay-core/src/index'
import type {OverlayDocumentRecord, OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout, intentChecksum} from '../../sanity-overlay-store-fs/src/index'
import type {CheckpointDocumentIntent} from '../../sanity-overlay-store-fs/src/index'
import {createFailureLedger, endsWith, errnoError, until} from '../src/failureInjection'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

vi.setConfig({testTimeout: 20_000, hookTimeout: 20_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

/**
 * A permission-based injection is meaningless for a process that ignores
 * permissions. Root would make the EACCES case pass by never failing at all,
 * which is the exact vacuity this suite is built to avoid.
 */
const CAN_USE_PERMISSIONS = typeof process.getuid === 'function' && process.getuid() !== 0

const roots: string[] = []
const chmodded: string[] = []

afterEach(async () => {
  /* Restore write permission first, or the cleanup itself fails. */
  for (const path of chmodded.splice(0)) await chmod(path, 0o755).catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-failure-'))
  roots.push(root)
  return root
}

interface Harness {
  root: string
  layout: OverlayLayout
  store: FsOverlayStore
}

async function seeded(options: {hooks?: {beforeRename(info: {tempPath: string; targetPath: string}): Promise<void>}} = {}): Promise<Harness> {
  const root = await makeRoot()
  const store = new FsOverlayStore({root, now: () => FIXED_NOW, hooks: options.hooks})
  await store.createOverlay({
    overlayId: CONTRACT_OVERLAY_ID,
    base: {...CONTRACT_BASE},
    source: {...CONTRACT_SOURCE},
    actor: CONTRACT_ACTOR,
  })
  return {root, layout: new OverlayLayout(root), store}
}

/** Commit one document, returning the record that was written. */
async function commitOne(
  store: FsOverlayStore,
  logicalId: string,
  options: {title?: string; key?: string; overlayRevision?: number} = {},
): Promise<OverlayDocumentRecord> {
  const record = documentRecordFixture({
    logicalId,
    title: options.title,
    overlayRevision: options.overlayRevision,
  })
  await store.commitTransaction(CONTRACT_OVERLAY_ID, {
    idempotencyKey: options.key ?? `commit-${logicalId}-${options.title ?? 'x'}`,
    actor: CONTRACT_ACTOR,
    mutations: [],
    records: [record],
  })
  return record
}

async function readManifestFile(layout: OverlayLayout): Promise<OverlayManifest> {
  return parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Every `.tmp-` staging file left anywhere under the overlay root. */
async function tempLitter(layout: OverlayLayout, dir?: string): Promise<string[]> {
  const target = dir ?? layout.resolve('.')
  const out: string[] = []
  for (const entry of await readdir(target, {withFileTypes: true}).catch(() => [])) {
    const path = join(target, entry.name)
    if (entry.isDirectory()) out.push(...(await tempLitter(layout, path)))
    else if (entry.name.startsWith('.tmp-')) out.push(path)
  }
  return out
}

/* ================================================================== *
 * §33 "Filesystem JSON malformed" — Parser failure ⇒ serve last valid
 * state only
 * ================================================================== */

describe('§33 Filesystem JSON malformed — a truncated file never becomes current state', () => {
  it('serves the last valid intent and writes a .broken diagnostic copy', async () => {
    const {layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Branch title'})

    const intentPath = layout.intentPath('article-1')
    const whole = await readFile(intentPath, 'utf8')
    const goodIntent = parse(whole) as CheckpointDocumentIntent

    /* THE INJECTION: a partially written file — exactly what a process killed
     * mid-write leaves behind if the atomic rename is bypassed. */
    await truncate(intentPath, Math.floor(whole.length / 2))

    /* PROOF THE INJECTION TOOK EFFECT: the bytes on disk are genuinely
     * unparseable, and genuinely shorter. Without this the case would pass
     * against a truncation that never happened. */
    const damaged = await readFile(intentPath, 'utf8')
    expect(damaged.length).toBeLessThan(whole.length)
    expect(() => JSON.parse(damaged)).toThrow()

    /* REQUIRED BEHAVIOUR: last valid state only — never the damaged bytes. */
    const read = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
    expect(read?.intent).toEqual(goodIntent)

    /* And the damage is reported, not swallowed: a `.broken` copy holds the
     * evidence so the file and its content can be shown to a human (§14.3). */
    const brokenPath = `${intentPath}.broken`
    expect(await exists(brokenPath)).toBe(true)
    expect(await readFile(brokenPath, 'utf8')).toBe(damaged)

    /* The manifest head is untouched: a parse failure is not a content change. */
    const manifest = await readManifestFile(layout)
    expect(manifest.documentHeads['article-1']).toBeDefined()
    expect(manifest.revision).toBe(1)
  })

  it('reports the damaged file as invalid from revalidate rather than serving it', async () => {
    const {layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Branch title'})

    const intentPath = layout.intentPath('article-1')
    const whole = await readFile(intentPath, 'utf8')
    await truncate(intentPath, Math.floor(whole.length / 2))
    const damaged = await readFile(intentPath, 'utf8')
    expect(() => JSON.parse(damaged)).toThrow()

    const report = await store.revalidate(CONTRACT_OVERLAY_ID)

    expect(report.ok).toBe(false)
    expect(report.invalid.map((failure) => failure.logicalId)).toContain('article-1')
    /* §5.5 forbids silent approximation: the file that failed is named, and the
     * diagnostic copy it produced is named with it. */
    const failure = report.invalid.find((entry) => entry.logicalId === 'article-1')
    expect(failure?.brokenCopyRef).toMatch(/\.broken$/)
    /* A file that failed to parse must not be reported as a CHANGE — that is how
     * a direct-edit watcher would push corruption into the projection. */
    expect(report.changed).not.toContain('article-1')
  })
})

/* ================================================================== *
 * §33 "Blob manifest corrupted" — Schema or checksum failure ⇒ fatal
 * overlay error, read-only, restore from checkpoint or prior revision.
 * The filesystem is the adapter that exists, so the row is exercised
 * against it.
 * ================================================================== */

describe('§33 manifest corrupted — a fatal, read-only, restorable error', () => {
  it('refuses to serve a truncated manifest to a store that never saw a good one', async () => {
    const {root, layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Branch title'})

    const whole = await readFile(layout.manifestPath, 'utf8')
    await truncate(layout.manifestPath, Math.floor(whole.length / 2))
    const damaged = await readFile(layout.manifestPath, 'utf8')
    expect(() => JSON.parse(damaged)).toThrow()

    /* A FRESH store: no last-valid cache to fall back on. This is the case that
     * matters, because the in-process cache would otherwise mask corruption
     * until the next restart — the longest possible fuse. */
    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})

    await expect(cold.readManifest(CONTRACT_OVERLAY_ID)).rejects.toMatchObject({
      code: 'OVERLAY_STORE_CORRUPT',
    })

    /* NOT `OVERLAY_NOT_FOUND`, and this is the load-bearing distinction: a store
     * that reported "no overlay here" would invite its caller to create a fresh
     * empty one on top of the branch's only copy of the work. */
    await expect(cold.readManifest(CONTRACT_OVERLAY_ID)).rejects.not.toMatchObject({
      code: 'OVERLAY_NOT_FOUND',
    })

    /* READ-ONLY: no write may proceed against a corrupt manifest. */
    await expect(
      commitOne(cold, 'article-2', {title: 'Written over corruption'}),
    ).rejects.toMatchObject({code: 'OVERLAY_STORE_CORRUPT'})

    /* RESTORABLE: the damaged bytes are still there, and the document artifacts
     * the manifest named were never destroyed, so a checkpoint or a prior
     * revision can rebuild. */
    expect(await readFile(layout.manifestPath, 'utf8')).toBe(damaged)
    expect(await exists(layout.intentPath('article-1'))).toBe(true)
  })

  it('rejects a manifest that parses but is not a manifest', async () => {
    const {root, layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Branch title'})

    /* THE INJECTION: valid JSON, wrong shape — the "schema failure" half of the
     * §33 detection column, which a `JSON.parse` guard alone would wave through. */
    const planted = serialize({overlayId: CONTRACT_OVERLAY_ID, revision: 'not-a-number'})
    await writeFile(layout.manifestPath, planted, 'utf8')

    /* PROOF THE INJECTION TOOK EFFECT: it really does parse. */
    expect(() => JSON.parse(planted)).not.toThrow()

    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
    await expect(cold.readManifest(CONTRACT_OVERLAY_ID)).rejects.toMatchObject({
      code: 'OVERLAY_STORE_CORRUPT',
    })
  })

  it('detects a revision whose bytes no longer hash to its own content address', async () => {
    const {layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Branch title'})

    const manifestBefore = await readManifestFile(layout)
    const head = manifestBefore.documentHeads['article-1']!
    const revisionPath = layout.resolve(head.storageRef)
    const record = parse(await readFile(revisionPath, 'utf8')) as OverlayDocumentRecord

    /* THE INJECTION: rewrite the CONTENT of a content-addressed file, leaving
     * its name — which is its hash — alone. Bit rot, a bad merge, a stray editor. */
    const tampered = {
      ...record,
      local: {
        ...record.local,
        draft: record.local.draft
          ? {...record.local.draft, materialized: {...record.local.draft.materialized, title: 'Tampered'}}
          : record.local.draft,
      },
    }
    await writeFile(revisionPath, serialize(tampered), 'utf8')

    /* PROOF THE INJECTION TOOK EFFECT: the file still parses, and its checksum
     * genuinely differs from the address it is stored under. */
    const reread = parse(await readFile(revisionPath, 'utf8')) as OverlayDocumentRecord
    expect(checksum(reread)).not.toBe(head.checksum)

    const report = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
    expect(report.ok).toBe(false)
    const issue = report.issues.find((entry) => entry.kind === 'revision')
    expect(issue).toBeDefined()
    expect(issue?.logicalId).toBe('article-1')
    expect(issue?.expected).toBe(head.checksum)
    expect(issue?.actual).toBe(checksum(reread))

    /* NOT REPAIRABLE, and this is the whole point of the flag: rewriting the
     * stored checksum to match tampered bytes would destroy the only evidence
     * that the content ever changed (PRD §14.3, §34.4). */
    expect(issue?.repairable).toBe(false)

    const repair = await store.repairChecksums(CONTRACT_OVERLAY_ID)
    expect(repair.unrepairable.map((entry) => entry.ref)).toContain(head.storageRef)
    expect(repair.repaired).not.toContain(head.storageRef)

    /* And the head still names the ORIGINAL address — repair did not move it. */
    const manifestAfter = await readManifestFile(layout)
    expect(manifestAfter.documentHeads['article-1']!.checksum).toBe(head.checksum)
  })
})

/* ================================================================== *
 * §33 "Local disk write fails" — OS error ⇒ save failure banner,
 * preserve in-memory unsaved patches, no staging fallback.
 * §35.15 "Filesystem disk full", "Process stops during local
 * temporary write".
 * ================================================================== */

describe('§33 local disk write fails — the failure is reported and nothing partial survives', () => {
  /**
   * ────────────────── THE COMMIT POINT IS WHERE FAILURE STOPS ─────────────────
   * `commitTransaction` writes in five steps (`fsStore.ts` §"commitTransaction"):
   *
   *   1. immutable revisions  → `.runtime/revisions/…`
   *   2. transaction record   → `.runtime/transactions/…`
   *   3. THE COMMIT POINT     → `manifest.json`
   *   4. idempotency pointer  → `.runtime/indexes/idempotency/…`
   *   5. regenerable projections → `documents/<id>/intent.json`, materialized
   *
   * Steps 1-2 may fail the call: nothing is visible yet, so "the save failed" is
   * true. Steps 4-5 may NOT, and this pair of cases is the reason. A store that
   * raised the step-5 `EACCES` would tell the editor a save failed that had in
   * fact landed — the manifest revision has advanced and the head is named —
   * and the retry that a §33 "save failure banner" invites would then be
   * swallowed by the idempotency pointer step 4 already wrote, so the review
   * surface would never be rebuilt. That was DEFECT D-1, found by this suite and
   * fixed in `fsStore.ts`: past the commit point failures are collected into
   * `projectionFailures` and the projection is regenerated from the head's
   * immutable revision (§34.2 — deleting a local file is not a content change).
   * ───────────────────────────────────────────────────────────────────────────
   */
  it.runIf(CAN_USE_PERMISSIONS)(
    'reports a projection failure after the commit point without calling the commit failed',
    async () => {
      const {root, layout, store} = await seeded()
      await commitOne(store, 'article-1', {title: 'First'})

      const before = await readManifestFile(layout)

      /* THE INJECTION: a real read-only `documents/` directory, producing a real
       * kernel refusal — not a stubbed throw a store could special-case. Step 5
       * is the only step that writes there, so this fails strictly AFTER the
       * manifest rename. */
      await chmod(layout.documentsDir, 0o500)
      chmodded.push(layout.documentsDir)

      const result = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'doomed',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: 'article-2', title: 'Second'})],
      })

      /* PROOF THE INJECTION TOOK EFFECT: the projection really could not be
       * written, and the store says so, with the OS's own error code. Without
       * this the case would pass against a disk that was never made read-only. */
      expect(result.projectionFailures).toHaveLength(1)
      expect(['EACCES', 'EPERM', 'EROFS']).toContain(result.projectionFailures[0]!.code)
      expect(result.projectionFailures[0]!.ref).toContain('intent.json')
      expect(await exists(layout.intentPath('article-2'))).toBe(false)

      /* REQUIRED BEHAVIOUR: the commit is reported as what it is — committed. */
      expect(result.replayed).toBe(false)
      const after = await readManifestFile(layout)
      expect(after.revision).toBe(before.revision + 1)
      expect(after.documentHeads['article-2']).toBeDefined()

      /* And a COLD store — no cache to hide behind, the honest oracle — still
       * exports both documents, because the missing projection is rebuilt from
       * the immutable revision the head names rather than called corruption.
       * `documents/` is STILL unwritable here, so this proves the read path
       * recovers without needing the disk back. */
      const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
      const bundle = await cold.exportCanonical(CONTRACT_OVERLAY_ID)
      expect(bundle.documents).toHaveLength(2)
      const rebuilt = bundle.documents.find(
        (document) => document.intent.logicalId === 'article-2',
      )
      /* Not a placeholder: the rebuilt intent carries the committed edit and
       * agrees with the intent the clean commit of `article-1` produced, so it
       * is the same projection and not an empty shell that happens to parse. */
      expect(rebuilt?.intent.draft?.overrides).toContainEqual({path: ['title'], value: 'Second'})
      expect(rebuilt?.intent.checksum).toBe(intentChecksum(rebuilt!.intent))

      /* RECOVERY ON NEXT OPEN, once the disk is back: `revalidate` rewrites the
       * file and NAMES it — a review surface that reappeared silently would be
       * indistinguishable from one that was never lost. */
      await chmod(layout.documentsDir, 0o755)
      const colder = new FsOverlayStore({root, now: () => FIXED_NOW})
      const report = await colder.revalidate(CONTRACT_OVERLAY_ID)
      expect(report.regenerated).toEqual([
        colder.layout.relative(colder.layout.intentPath('article-2')),
      ])
      expect(report.ok).toBe(true)

      /* THE INDEPENDENT ORACLE: the bytes are on disk, they parse, and a fourth
       * store reading them from cold agrees with the record the manifest names. */
      const onDisk = parse(
        await readFile(layout.intentPath('article-2'), 'utf8'),
      ) as CheckpointDocumentIntent
      expect(onDisk.draft?.overrides).toContainEqual({path: ['title'], value: 'Second'})
      expect(onDisk.checksum).toBe(intentChecksum(onDisk))
      const fourth = new FsOverlayStore({root, now: () => FIXED_NOW})
      expect((await fourth.revalidate(CONTRACT_OVERLAY_ID)).regenerated).toEqual([])
    },
  )

  it('leaves the manifest byte-identical when a write fails BEFORE the commit point', async () => {
    const ledger = createFailureLedger()
    const {layout, store} = await seeded({hooks: ledger.hooks})
    await commitOne(store, 'article-1', {title: 'First'})
    const beforeBytes = await readFile(layout.manifestPath, 'utf8')
    ledger.reset()

    /* Step 1 — the immutable revision, written before anything is visible. */
    ledger.failOn(
      (targetPath) => targetPath.includes('/revisions/'),
      errnoError('ENOSPC', 'rename', layout.revisionsDir),
      {repeat: true},
    )
    await expect(commitOne(store, 'article-2', {title: 'Second'})).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    expect(ledger.injections()).toBeGreaterThan(0)

    /* §33: "Save failure banner" / "Preserve in-memory unsaved patches". A
     * banner is only honest if the save really did not happen — so the commit
     * point must be byte-for-byte where it was, and nothing may be reachable. */
    expect(await readFile(layout.manifestPath, 'utf8')).toBe(beforeBytes)
    expect(await exists(layout.intentPath('article-2'))).toBe(false)
    expect(await tempLitter(layout)).toEqual([])
  })

  it('fails at the rename point without publishing bytes and without leaving litter', async () => {
    const ledger = createFailureLedger()
    const {layout, store} = await seeded({hooks: ledger.hooks})
    await commitOne(store, 'article-1', {title: 'First'})

    const beforeBytes = await readFile(layout.manifestPath, 'utf8')
    const before = parse(beforeBytes) as OverlayManifest
    ledger.reset()

    /* THE INJECTION: the disk fills at the instant the manifest — the commit
     * point — is about to become visible. The document revision for this
     * transaction has already been written by then, so this is precisely
     * §35.15's "document write succeeds and manifest write fails". */
    ledger.failOn(endsWith('manifest.json'), errnoError('ENOSPC', 'rename', layout.manifestPath))

    await expect(commitOne(store, 'article-2', {title: 'Second'})).rejects.toMatchObject({
      code: 'ENOSPC',
    })

    /* PROOF THE INJECTION TOOK EFFECT, three ways:
     *   - it fired exactly once;
     *   - a revision file WAS staged before it fired, so the failure landed in
     *     the real window rather than before any work happened;
     *   - the staged manifest held real bytes at the moment of the throw. */
    expect(ledger.injections()).toBe(1)
    const staged = ledger.matching(endsWith('manifest.json'))
    expect(staged).toHaveLength(1)
    expect(staged[0]!.bytes).toBeGreaterThan(0)
    expect(
      ledger.writes.filter((write) => write.targetPath.includes('/revisions/')).length,
    ).toBeGreaterThan(0)

    /* REQUIRED BEHAVIOUR: the commit point never moved. */
    expect(await readFile(layout.manifestPath, 'utf8')).toBe(beforeBytes)
    expect((await readManifestFile(layout)).revision).toBe(before.revision)

    /* No staging file survives a failed write (PRD §14.3): a `.tmp-` left behind
     * would eventually be mistaken for content by a directory walk. */
    expect(await tempLitter(layout)).toEqual([])

    /* What DID reach disk is unreachable, and reclaimable — §34.8. */
    const orphans = await store.collectOrphans(CONTRACT_OVERLAY_ID, {dryRun: true})
    expect(orphans.orphans.length).toBeGreaterThan(0)

    /* The store is not wedged: with the one-shot injection spent, the retry lands. */
    await commitOne(store, 'article-2', {title: 'Second', key: 'retry'})
    const after = await readManifestFile(layout)
    expect(after.documentHeads['article-2']).toBeDefined()
    expect(after.revision).toBe(before.revision + 1)
  })

  it('does not advance the overlay revision for a transaction that failed', async () => {
    const ledger = createFailureLedger()
    const {layout, store} = await seeded({hooks: ledger.hooks})
    await commitOne(store, 'article-1', {title: 'First'})

    ledger.failOn(endsWith('manifest.json'), errnoError('EIO', 'rename', layout.manifestPath))
    await expect(commitOne(store, 'article-2', {title: 'Second'})).rejects.toMatchObject({
      code: 'EIO',
    })
    expect(ledger.injections()).toBe(1)

    /* PRD §34.5 — "Every successful transaction increments overlay revision
     * exactly once". The contrapositive is the one a failure suite must hold:
     * an UNSUCCESSFUL transaction increments it zero times, on disk and in the
     * store's own view of itself. */
    await commitOne(store, 'article-3', {title: 'Third'})
    const manifest = await readManifestFile(layout)
    expect(manifest.revision).toBe(2)
    expect(Object.keys(manifest.documentHeads).sort()).toEqual(['article-1', 'article-3'])

    /* The failed transaction's record was written before the commit point and
     * survives as an orphan — harmless only because the IDEMPOTENCY POINTER is
     * written after the commit point, so a retry is re-applied rather than
     * replayed away. That ordering is load-bearing; assert it directly. */
    expect(manifest.transactionHead).not.toBe('')
    const replayProbe = await store.getTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'commit-article-2-Second',
    })
    expect(replayProbe).toBeNull()
  })
})

/* ================================================================== *
 * §33 "Blob manifest ETag conflict" — Precondition failure ⇒ re-read,
 * reapply idempotently, retry. The filesystem adapter's equivalent is
 * the conditional manifest revision, and the failure to be injected is
 * two writers on one document.
 * ================================================================== */

describe('§33 concurrent writers to one overlay', () => {
  it('rejects a writer whose expected revision is already stale', async () => {
    const {root, layout, store} = await seeded()
    await commitOne(store, 'article-1', {title: 'Base state'})
    const other = new FsOverlayStore({root, now: () => FIXED_NOW})

    /* Sequential, so the precondition is unambiguously the thing being tested:
     * the second writer's view of the world is genuinely out of date. */
    await commitOne(store, 'article-2', {title: 'Writer A', overlayRevision: 2})
    expect((await readManifestFile(layout)).revision).toBe(2)

    await expect(
      other.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'writer-b',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: 'article-3', title: 'Writer B'})],
        expectedOverlayRevision: 1,
      }),
    ).rejects.toMatchObject({code: 'OVERLAY_WRITE_CONFLICT'})

    /* "Re-read, reapply idempotently, retry" — and the retry lands at 3, not as
     * a second revision 2. */
    await other.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'writer-b-retry',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-3', title: 'Writer B'})],
      expectedOverlayRevision: 2,
    })
    const manifest = await readManifestFile(layout)
    expect(manifest.revision).toBe(3)
    expect(Object.keys(manifest.documentHeads).sort()).toEqual([
      'article-1',
      'article-2',
      'article-3',
    ])
  })

  /**
   * The forced-interleaving cases that found and now guard DEFECT D-2 — two
   * stores on one root losing a committed head — live in
   * `failure-concurrency.test.ts`, which is about writers meeting each other
   * rather than a writer meeting a broken disk. What belongs HERE is the guard
   * that survives when the lock does not apply: PRD §14.4 invites an agent or a
   * Git merge to rewrite the files directly, and such a writer never takes the
   * `.locks/` critical section at all.
   */
  it('refuses to overwrite a manifest that an unlocked external writer moved', async () => {
    const ledger = createFailureLedger()
    const {layout, store} = await seeded({hooks: ledger.hooks})
    await commitOne(store, 'article-1', {title: 'Base state'})

    /* Park the store at its commit point, with the new manifest staged. */
    const held = ledger.holdOn(endsWith('manifest.json'))
    const commit = store
      .commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'writer-a',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: 'article-A', title: 'A'})],
      })
      .then(
        () => 'committed' as const,
        (error: {code?: string}) => error.code ?? 'unknown',
      )
    await until(() => held.reached(), 'the commit parked at its rename')

    /* THE INJECTION: something that is not this store — no lock, no API —
     * publishes a different manifest while the commit is in flight. This is a
     * `git merge` landing, or an older build of the CLI. */
    const planted = parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
    planted.revision = 7
    planted.updatedAt = FIXED_NOW
    await writeFile(layout.manifestPath, serialize(planted), 'utf8')

    held.release()

    /* REQUIRED: the rename is refused, because the revision the commit was based
     * on is no longer the revision on disk. Silently overwriting would erase
     * whatever the external writer published. */
    expect(await commit).toBe('OVERLAY_WRITE_CONFLICT')

    /* PROOF: the external writer's bytes are intact and no head was lost. */
    const manifest = await readManifestFile(layout)
    expect(manifest.revision).toBe(7)
    expect(manifest.documentHeads['article-A']).toBeUndefined()
    expect(manifest.documentHeads['article-1']).toBeDefined()
    expect(await tempLitter(layout)).toEqual([])
  })
})

/* ================================================================== *
 * §33 "Cleanup partially fails" — Worker result ⇒ retry and preserve
 * manifest until confirmed. §35.15 "Cleanup deletes some but not all
 * orphan objects".
 * ================================================================== */

describe('§33 cleanup partially fails', () => {
  it.runIf(CAN_USE_PERMISSIONS)(
    'reports the orphan it could not delete and preserves the manifest',
    async () => {
      const ledger = createFailureLedger()
      const {layout, store} = await seeded({hooks: ledger.hooks})
      await commitOne(store, 'article-1', {title: 'First'})

      /* Make orphans the honest way: a failed commit leaves an unreachable
       * revision behind (§34.8), which is exactly what cleanup exists to remove. */
      ledger.failOn(
        endsWith('manifest.json'),
        errnoError('ENOSPC', 'rename', layout.manifestPath),
        {repeat: true},
      )
      await expect(commitOne(store, 'article-2', {title: 'A'})).rejects.toBeTruthy()
      await expect(commitOne(store, 'article-3', {title: 'B'})).rejects.toBeTruthy()
      ledger.disarm()

      const before = await store.collectOrphans(CONTRACT_OVERLAY_ID, {dryRun: true})
      expect(before.orphans.length).toBeGreaterThanOrEqual(2)

      /* THE INJECTION: one orphan's directory becomes unwritable, so its unlink
       * fails while its siblings' succeed. */
      const victim = before.orphans.find((orphan) => orphan.kind === 'revision')
      expect(victim).toBeDefined()
      const victimPath = layout.resolve(victim!.ref)
      const victimDir = join(victimPath, '..')
      await chmod(victimDir, 0o500)
      chmodded.push(victimDir)

      const report = await store.collectOrphans(CONTRACT_OVERLAY_ID)

      /* PROOF THE INJECTION TOOK EFFECT: the file is still on disk after a
       * cleanup pass that was asked to remove it. */
      expect(await exists(victimPath)).toBe(true)

      /* REQUIRED BEHAVIOUR: the failure is reported, never silently counted as
       * a deletion, and the manifest survives untouched. */
      expect(report.failures.map((failure) => failure.ref)).toContain(victim!.ref)
      expect(report.deleted.map((entry) => entry.ref)).not.toContain(victim!.ref)

      const manifest = await readManifestFile(layout)
      expect(manifest.documentHeads['article-1']).toBeDefined()
      expect(manifest.revision).toBe(1)

      /* "Retry ... until confirmed": once the obstruction clears, a second pass
       * finishes the job. */
      await chmod(victimDir, 0o755)
      const retry = await store.collectOrphans(CONTRACT_OVERLAY_ID)
      expect(retry.failures).toEqual([])
      expect(await exists(victimPath)).toBe(false)
    },
  )
})
