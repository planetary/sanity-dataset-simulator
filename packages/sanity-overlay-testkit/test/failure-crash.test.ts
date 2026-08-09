/**
 * PRD §35.15 "Process stops during local temporary write" — with a real process
 * and a real `SIGKILL`, because every cheaper version of this test is a lie.
 *
 * WHY A CHILD PROCESS
 *
 * The rest of the §33 suite injects failures by throwing at the rename point.
 * That proves the *error* path: a store that catches, cleans up and reports. It
 * cannot prove the *crash* path, because a thrown error still runs `catch`,
 * still unlinks the staging file, still returns to a caller — none of which a
 * killed process does. `SIGKILL` cannot be caught, blocked or handled, so what
 * the overlay looks like afterwards is decided entirely by what was already on
 * disk. That is the only honest way to ask whether temp-file-plus-rename really
 * gives "either the old state or the new state".
 *
 * THE SCRIPT
 *
 * A child opens the same overlay root, commits, and parks inside `beforeRename`
 * with the new `manifest.json` bytes staged and the rename not yet issued. It
 * announces the staging path through a marker file, then blocks forever. The
 * parent reads the marker, confirms the staged bytes are COMPLETE and hold the
 * *next* revision — so the kill is landing in the intended window and not before
 * the write — and kills the child.
 *
 * WHAT IS AND IS NOT PROVED ON macOS
 *
 * This kills a PROCESS, not a machine. APFS may still hold written bytes in the
 * page cache, so nothing here proves durability across a POWER loss; that needs
 * `fsync` (the store's `fsync: true` option) and hardware this suite does not
 * have. Power-loss durability is therefore stated as untested rather than
 * claimed. Everything below is about atomicity and recovery, which a process
 * kill does test exactly.
 */
import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OverlayLayout} from '../../sanity-overlay-store-fs/src/index'
import {until} from '../src/failureInjection'
import {
  CONTRACT_ACTOR,
  CONTRACT_BASE,
  CONTRACT_OVERLAY_ID,
  CONTRACT_SOURCE,
  documentRecordFixture,
} from '../src/storeContract'

vi.setConfig({testTimeout: 60_000, hookTimeout: 60_000})

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const TSX = join(REPO, 'packages', 'sanity-overlay-testkit', 'node_modules', '.bin', 'tsx')
const STORE_ENTRY = join(REPO, 'packages', 'sanity-overlay-store-fs', 'src', 'index.ts')
const FIXTURE_ENTRY = join(REPO, 'packages', 'sanity-overlay-testkit', 'src', 'storeContract.ts')

const roots: string[] = []
const children: Array<{kill(): void}> = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-crash-'))
  roots.push(root)
  return root
}

async function readManifestFile(layout: OverlayLayout): Promise<OverlayManifest> {
  return parse(await readFile(layout.manifestPath, 'utf8')) as OverlayManifest
}

/** Every `.tmp-` staging file anywhere under the overlay root. */
async function tempLitter(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, {withFileTypes: true}).catch(() => [])) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await tempLitter(path)))
    else if (entry.name.startsWith('.tmp-')) out.push(path)
  }
  return out
}

/**
 * The child: commit, park with the manifest staged, never rename.
 *
 * Written to disk at test time rather than committed as a fixture so the paths
 * it imports are the ones this test resolved — a stale fixture pointing at a
 * moved module would fail as "the child never started", which reads as a passing
 * crash test.
 */
function childScript(root: string, markerPath: string, logicalId: string): string {
  return `
import {writeFileSync} from 'node:fs'
import {FsOverlayStore} from ${JSON.stringify(STORE_ENTRY)}
import {
  CONTRACT_ACTOR,
  CONTRACT_OVERLAY_ID,
  documentRecordFixture,
} from ${JSON.stringify(FIXTURE_ENTRY)}

const store = new FsOverlayStore({
  root: ${JSON.stringify(root)},
  now: () => ${JSON.stringify(FIXED_NOW)},
  hooks: {
    async beforeRename(info) {
      if (!info.targetPath.endsWith('manifest.json')) return
      writeFileSync(${JSON.stringify(markerPath)}, info.tempPath, 'utf8')
      /* Park forever. The parent's SIGKILL is the only thing that ends this. */
      await new Promise(() => {})
    },
  },
})

await store.commitTransaction(CONTRACT_OVERLAY_ID, {
  idempotencyKey: 'crash-commit',
  actor: CONTRACT_ACTOR,
  mutations: [],
  records: [documentRecordFixture({logicalId: ${JSON.stringify(logicalId)}, title: 'Killed mid-write'})],
})
`
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('§35.15 process stops during a local temporary write', () => {
  it('leaves the old state exactly, and a fresh store recovers to it cleanly', async () => {
    const root = await makeRoot()
    const layout = new OverlayLayout(root)
    const store = new FsOverlayStore({root, now: () => FIXED_NOW})
    await store.createOverlay({
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
      actor: CONTRACT_ACTOR,
    })
    await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'survivor',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-1', title: 'Survives the crash'})],
    })

    /* The old state, captured as bytes. Every "unchanged" assertion below is
     * against these, not against a re-derived value. */
    const beforeManifestBytes = await readFile(layout.manifestPath, 'utf8')
    const beforeIntentBytes = await readFile(layout.intentPath('article-1'), 'utf8')
    const beforeExport = await store.exportCanonical(CONTRACT_OVERLAY_ID)

    const marker = join(root, 'staged-path.txt')
    const scriptPath = join(root, 'crash-child.mjs')
    await writeFile(scriptPath, childScript(root, marker, 'article-2'), 'utf8')

    const child = spawn(TSX, [scriptPath], {stdio: ['ignore', 'pipe', 'pipe']})
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<{code: number | null; signal: string | null}>((resolve) => {
      child.on('exit', (code, signal) => resolve({code, signal}))
    })

    await until(
      () => existsSync(marker),
      `the child to reach its manifest rename (stderr so far: ${stderr})`,
    )
    const stagedPath = await readFile(marker, 'utf8')

    /* PROOF THE KILL LANDS IN THE INTENDED WINDOW: the staging file holds the
     * COMPLETE next manifest — it parses, and its revision is the one that is
     * about to become visible. A kill before the write, or after the rename,
     * would fail here rather than quietly test nothing. */
    const staged = parse(await readFile(stagedPath, 'utf8')) as OverlayManifest
    expect(staged.revision).toBe(2)
    expect(staged.documentHeads['article-2']).toBeDefined()
    expect((await readManifestFile(layout)).revision).toBe(1)

    /* THE CRASH. Uncatchable, unhandleable: no `finally`, no cleanup, no
     * lock release, no partial rename. */
    child.kill('SIGKILL')
    const outcome = await exited
    expect(outcome.signal).toBe('SIGKILL')

    /* ── INVARIANT: THE OLD STATE, BYTE FOR BYTE ────────────────────────────
     * `manifest.json` is the commit point and it never moved, so no artifact
     * the killed transaction wrote is reachable. */
    expect(await readFile(layout.manifestPath, 'utf8')).toBe(beforeManifestBytes)
    expect(await readFile(layout.intentPath('article-1'), 'utf8')).toBe(beforeIntentBytes)
    expect(await exists(layout.intentPath('article-2'))).toBe(false)

    /* ── RECOVERY ON NEXT OPEN: a store that has never seen this root ───────── */
    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
    const manifest = await cold.readManifest(CONTRACT_OVERLAY_ID)
    expect(manifest.revision).toBe(1)
    expect(Object.keys(manifest.documentHeads)).toEqual(['article-1'])

    /* Clean, and it says so: nothing invalid, nothing needing regeneration. */
    const report = await cold.revalidate(CONTRACT_OVERLAY_ID)
    expect(report.ok).toBe(true)
    expect(report.invalid).toEqual([])
    expect(report.regenerated).toEqual([])
    expect((await cold.verifyChecksums(CONTRACT_OVERLAY_ID)).ok).toBe(true)

    /* And the canonical state is the one from before the crash. */
    const afterExport = await cold.exportCanonical(CONTRACT_OVERLAY_ID)
    expect(afterExport.documents).toEqual(beforeExport.documents)

    /* ── THE COST OF A REAL CRASH, STATED RATHER THAN WISHED AWAY ───────────
     * A killed process cannot unlink its own staging file, so litter survives.
     * §14.1 `.gitignore`s `.tmp-*` so it never reaches review, and it is not
     * mistaken for content — but it IS still there, and the next case is about
     * reclaiming it. */
    const litter = await tempLitter(layout.root)
    expect(litter).toContain(stagedPath)

    /* ── THE OVERLAY IS NOT WEDGED ──────────────────────────────────────────
     * The child died INSIDE the writer critical section, so its `.locks/` file
     * is still there and nothing will ever release it. The next writer must
     * therefore break it — and must do so by establishing that the holder is
     * gone, not by waiting out a timeout. The elapsed bound is the assertion
     * that distinguishes those two: a store that only aged the lock out would
     * take `staleLockMs` (30 s) to get here. */
    expect(await exists(join(layout.root, '.locks', 'overlay.lock'))).toBe(true)
    const started = performance.now()
    await cold.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'after-crash',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-3', title: 'After the crash'})],
    })
    expect(performance.now() - started).toBeLessThan(5_000)
    const recovered = await readManifestFile(layout)
    expect(recovered.revision).toBe(2)
    expect(Object.keys(recovered.documentHeads).sort()).toEqual(['article-1', 'article-3'])
  })

  it('reclaims the staging file a killed process left behind, but never one that is still young', async () => {
    const root = await makeRoot()
    const layout = new OverlayLayout(root)
    const store = new FsOverlayStore({root, now: () => FIXED_NOW})
    await store.createOverlay({
      overlayId: CONTRACT_OVERLAY_ID,
      base: {...CONTRACT_BASE},
      source: {...CONTRACT_SOURCE},
      actor: CONTRACT_ACTOR,
    })
    await store.commitTransaction(CONTRACT_OVERLAY_ID, {
      idempotencyKey: 'survivor',
      actor: CONTRACT_ACTOR,
      mutations: [],
      records: [documentRecordFixture({logicalId: 'article-1', title: 'Survives'})],
    })

    const marker = join(root, 'staged-path.txt')
    const scriptPath = join(root, 'crash-child.mjs')
    await writeFile(scriptPath, childScript(root, marker, 'article-2'), 'utf8')
    const child = spawn(TSX, [scriptPath], {stdio: 'ignore'})
    children.push(child)
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    await until(() => existsSync(marker), 'the child to reach its manifest rename')
    const stagedPath = await readFile(marker, 'utf8')
    child.kill('SIGKILL')
    await exited

    /* PROOF: the litter is genuinely on disk before cleanup is asked to remove it. */
    expect(await exists(stagedPath)).toBe(true)

    /* FIRST, THE SAFETY HALF. The file is seconds old. Cleanup cannot tell a
     * just-crashed writer from a writer that is still running, and deleting the
     * staging file of a live one would turn a healthy commit into an `ENOENT`
     * at its rename — cleanup causing the corruption it exists to prevent. So
     * at the default threshold it must survive. */
    const young = await store.collectOrphans(CONTRACT_OVERLAY_ID)
    expect(young.deleted.map((entry) => layout.resolve(entry.ref))).not.toContain(stagedPath)
    expect(await exists(stagedPath)).toBe(true)

    /* THEN THE RECLAIM, once the file is old enough to be certainly abandoned. */
    const aged = new FsOverlayStore({root, now: () => FIXED_NOW, staleTempMs: 0})
    const report = await aged.collectOrphans(CONTRACT_OVERLAY_ID)

    /* Reclaimed, named in the report, and the manifest is untouched — §33
     * "Cleanup partially fails ⇒ retry and preserve manifest until confirmed"
     * applies to the successful path too: cleanup is never allowed to move the
     * commit point. */
    expect(report.deleted.map((entry) => layout.resolve(entry.ref))).toContain(stagedPath)
    expect(await exists(stagedPath)).toBe(false)
    expect(await tempLitter(layout.root)).toEqual([])
    expect((await readManifestFile(layout)).revision).toBe(1)
    expect(await exists(layout.intentPath('article-1'))).toBe(true)

    /* And the surviving document is still readable from cold, so cleanup
     * removed litter and nothing else. */
    const cold = new FsOverlayStore({root, now: () => FIXED_NOW})
    expect((await cold.exportCanonical(CONTRACT_OVERLAY_ID)).documents).toHaveLength(1)
  })
})
