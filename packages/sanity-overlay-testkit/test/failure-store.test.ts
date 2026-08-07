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
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import type {CheckpointDocumentIntent} from '../../sanity-overlay-store-fs/src/index'
import {createFailureLedger, endsWith, errnoError} from '../src/failureInjection'
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
   * ─────────────────────────────── DEFECT D-1 ────────────────────────────────
   * A COMMIT REPORTED AS FAILED HAS ALREADY LANDED, AND CANNOT BE REPAIRED.
   *
   * `commitTransaction` writes in five steps (`fsStore.ts` §"commitTransaction"):
   *
   *   1. immutable revisions  → `.runtime/revisions/…`
   *   2. transaction record   → `.runtime/transactions/…`
   *   3. THE COMMIT POINT     → `manifest.json`
   *   4. idempotency pointer  → `.runtime/indexes/idempotency/…`
   *   5. "regenerable projections" → `documents/<id>/intent.json`, materialized
   *
   * Step 5 is not regenerable. `documents/<id>/intent.json` is the §14.2
   * review-facing canonical state, the surface §29.1 puts in Git — the store
   * itself calls its absence corruption (`exportCanonical` raises
   * `OVERLAY_STORE_CORRUPT`, "manifest head has no readable intent file (PRD
   * §34.3)"). An OS error in step 5 therefore produces all three of:
   *
   *   - the caller is told the commit FAILED,
   *   - the commit is durably VISIBLE — manifest revision advanced, head named,
   *   - the review surface for that head is missing, permanently: step 4 already
   *     wrote the idempotency pointer, so the natural retry with the same key
   *     REPLAYS and never reaches step 5 again.
   *
   * This is the same shape as the two failures this repository already shipped —
   * a component reporting one thing and disk holding another — with the addition
   * that the retry path forecloses recovery. `fsStore.ts` is not owned by this
   * work, so the behaviour is PINNED here, not fixed. The `it.fails` case below
   * states what §33 requires; it will go red the moment the defect is fixed,
   * which is the signal to delete it.
   * ───────────────────────────────────────────────────────────────────────────
   */
  it.runIf(CAN_USE_PERMISSIONS)(
    'DEFECT D-1: a commit that throws an OS error after the commit point has already landed',
    async () => {
      const {root, layout, store} = await seeded()
      await commitOne(store, 'article-1', {title: 'First'})

      const before = await readManifestFile(layout)

      /* THE INJECTION: a real read-only `documents/` directory, producing a real
       * kernel refusal — not a stubbed throw a store could special-case. Step 5
       * is the only step that writes there, so this fails the commit strictly
       * after the manifest rename. */
      await chmod(layout.documentsDir, 0o500)
      chmodded.push(layout.documentsDir)

      let raised: NodeJS.ErrnoException | null = null
      try {
        await commitOne(store, 'article-2', {title: 'Second', key: 'doomed'})
      } catch (error) {
        raised = error as NodeJS.ErrnoException
      }

      /* PROOF THE INJECTION TOOK EFFECT: the operation genuinely failed, with an
       * OS error — §33's stated detection for this row. */
      expect(raised).not.toBeNull()
      expect(['EACCES', 'EPERM', 'EROFS']).toContain(raised?.code)

      /* THE DEFECT, on disk: the caller was told "failed" and the manifest moved. */
      const after = await readManifestFile(layout)
      expect(after.revision).toBe(before.revision + 1)
      expect(after.documentHeads['article-2']).toBeDefined()

      /* …with no review-facing intent behind the head it published. */
      expect(await exists(layout.intentPath('article-2'))).toBe(false)

      /* …which the store's own integrity check calls corruption — but only from
       * a COLD store. The writing process keeps the intent it never managed to
       * write in `#lastValidIntents`, so in-process reads and exports keep
       * succeeding and the damage is invisible until the next restart. The cold
       * store is the honest oracle here, and the longest possible fuse is
       * exactly what makes this worth pinning. */
      const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
      await expect(cold.exportCanonical(CONTRACT_OVERLAY_ID)).rejects.toMatchObject({
        code: 'OVERLAY_STORE_CORRUPT',
      })
      expect((await store.exportCanonical(CONTRACT_OVERLAY_ID)).documents).toHaveLength(2)

      /* …and the retry a "save failed" banner asks the editor to make is
       * swallowed by the idempotency pointer step 4 already wrote, so the gap
       * never closes even once the disk recovers. */
      await chmod(layout.documentsDir, 0o755)
      const retry = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'doomed',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: 'article-2', title: 'Second'})],
      })
      expect(retry.replayed).toBe(true)
      expect(await exists(layout.intentPath('article-2'))).toBe(false)
    },
  )

  it.fails.runIf(CAN_USE_PERMISSIONS)(
    'REQUIRED (§33 local disk write fails): a rejected commit leaves the manifest untouched — currently DEFECT D-1',
    async () => {
      const {layout, store} = await seeded()
      await commitOne(store, 'article-1', {title: 'First'})
      const beforeBytes = await readFile(layout.manifestPath, 'utf8')

      await chmod(layout.documentsDir, 0o500)
      chmodded.push(layout.documentsDir)
      await expect(commitOne(store, 'article-2', {title: 'Second'})).rejects.toBeTruthy()

      /* §33: "Save failure banner" / "Preserve in-memory unsaved patches". A
       * banner is only honest if the save really did not happen. */
      expect(await readFile(layout.manifestPath, 'utf8')).toBe(beforeBytes)
    },
  )

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
   * ─────────────────────────────── DEFECT D-2 ────────────────────────────────
   * TWO WRITERS ON ONE ROOT LOSE AN UPDATE, SILENTLY, EVEN WITH PRECONDITIONS.
   *
   * `commitTransaction` reads `manifest.json`, checks `expectedOverlayRevision`
   * against what it read, then writes. Nothing holds the file between the read
   * and the write, and nothing re-checks at the rename. Two `FsOverlayStore`
   * instances on the same root — two Studio tabs, a CLI beside a dev server, two
   * serverless invocations on one volume — therefore both pass the check and
   * both rename over the manifest. Last rename wins; the loser's head vanishes
   * from the manifest while its revision file survives as an orphan, and the
   * loser is told it committed.
   *
   * That violates PRD §35.7 "Concurrent stale write rejection", §34.5 "Every
   * successful transaction increments overlay revision exactly once", and the
   * §33 row "Blob manifest ETag conflict → re-read, reapply idempotently, retry"
   * whose filesystem analogue this is. The layout already reserves `.locks/`
   * (`layout.ts` `LOCKS_DIR`, gitignored) and nothing in any package reads or
   * writes it: the mutual exclusion was designed and never built.
   *
   * The interleaving below is FORCED rather than raced, so this is a
   * deterministic demonstration and not a flake: writer A is parked at its
   * manifest rename until writer B has fully committed.
   *
   * `fsStore.ts` is not owned by this work, so the behaviour is PINNED, not
   * fixed. The `it.fails` case states what §35.7 requires.
   * ───────────────────────────────────────────────────────────────────────────
   */
  it('DEFECT D-2: a second store on the same root silently drops a committed head', async () => {
    const ledger = createFailureLedger()
    const {root, layout, store} = await seeded({hooks: ledger.hooks})
    await commitOne(store, 'article-1', {title: 'Base state'})

    const other = new FsOverlayStore({root, now: () => FIXED_NOW})

    /* Park writer A at its commit point, holding the pre-B manifest staged. */
    const held = ledger.holdOn(endsWith('manifest.json'))
    const writerA = store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'writer-a',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-A', title: 'A'})],
      expectedOverlayRevision: 1,
    })
    for (let attempt = 0; attempt < 5000 && !held.reached(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    /* PROOF THE INJECTION TOOK EFFECT: A really is parked mid-commit, with its
     * new manifest bytes staged and not yet visible. */
    expect(held.reached()).toBe(true)
    expect((await readManifestFile(layout)).revision).toBe(1)

    /* Writer B commits completely, from its own store, while A is parked. */
    const resultB = await other.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'writer-b',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-B', title: 'B'})],
      expectedOverlayRevision: 1,
    })
    expect(resultB.replayed).toBe(false)
    expect((await readManifestFile(layout)).documentHeads['article-B']).toBeDefined()

    held.release()
    const resultA = await writerA

    /* THE DEFECT: A was told it committed, and B — which committed FIRST, and
     * fully — has been erased from the manifest. */
    expect(resultA.replayed).toBe(false)
    const manifest = await readManifestFile(layout)
    expect(manifest.documentHeads['article-A']).toBeDefined()
    expect(manifest.documentHeads['article-B']).toBeUndefined()

    /* Two successful transactions, one revision increment (§34.5 violated). */
    expect(manifest.revision).toBe(2)

    /* B's work is not corrupt, merely unreachable — which is why nothing else
     * in the system notices. */
    const report = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
    expect(report.missing).toEqual([])
  })

  it.fails(
    'REQUIRED (§35.7 "Concurrent stale write rejection"): a stale concurrent commit is refused — currently DEFECT D-2',
    async () => {
      const ledger = createFailureLedger()
      const {root, layout, store} = await seeded({hooks: ledger.hooks})
      await commitOne(store, 'article-1', {title: 'Base state'})
      const other = new FsOverlayStore({root, now: () => FIXED_NOW})

      const held = ledger.holdOn(endsWith('manifest.json'))
      const writerA = store
        .commitTransaction(CONTRACT_OVERLAY_ID, {
          idempotencyKey: 'writer-a',
          actor: CONTRACT_ACTOR,
          mutations: [],
          records: [documentRecordFixture({logicalId: 'article-A', title: 'A'})],
          expectedOverlayRevision: 1,
        })
        .then(
          () => 'committed' as const,
          (error: {code?: string}) => error.code ?? 'unknown',
        )
      for (let attempt = 0; attempt < 5000 && !held.reached(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await other.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'writer-b',
        actor: CONTRACT_ACTOR,
        mutations: [],
        records: [documentRecordFixture({logicalId: 'article-B', title: 'B'})],
        expectedOverlayRevision: 1,
      })
      held.release()

      /* The precondition A was given became false while A was in flight, so A
       * must be refused rather than allowed to overwrite. */
      expect(await writerA).toBe('OVERLAY_WRITE_CONFLICT')
      expect((await readManifestFile(layout)).documentHeads['article-B']).toBeDefined()
    },
  )
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
