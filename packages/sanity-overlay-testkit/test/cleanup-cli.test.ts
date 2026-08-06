/**
 * `sanity-overlay cleanup` — local cleanup on the command line (PRD §15.7,
 * §37 Phase 2 "Local cleanup").
 *
 * The command joins the two halves that were already separate for good reason:
 *
 * - `collectOrphans` — immutable artifacts no manifest head reaches. Pure
 *   garbage; reclaiming it changes no behaviour.
 * - `pruneRuntimeHistory` — the §13.10 log and the §34.6 idempotency ledger.
 *   NOT garbage; pruning it trades an audit trail and exactly-once replay for
 *   disk, so it only happens when the operator states a retention window.
 *
 * Both are gated behind `--confirm`, the same way `reset` and `rebase` are, and
 * the refusal path still prints the full report — the point of refusing is to
 * show what was about to be removed.
 *
 * Every deletion claim is checked by listing the real directories afterwards.
 */
import {readdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import type {SeedEdit} from '../../sanity-overlay-client/src/dev/seedOverlay'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

/** Three successive edits of one document: two superseded revisions, one head. */
const SUPERSEDING_EDITS: readonly SeedEdit[] = Object.freeze<SeedEdit[]>([
  {kind: 'edit', id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'One'}]},
  {kind: 'edit', id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Two'}]},
  {kind: 'edit', id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Three'}]},
])

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

function runtime(root: string, ...segments: string[]): string {
  return join(root, '.sanity-overlay', '.runtime', ...segments)
}

/** Every stored revision file across every document directory. */
async function revisionFiles(root: string): Promise<string[]> {
  const dirs = await names(runtime(root, 'revisions'))
  const files: string[] = []
  for (const dir of dirs) {
    for (const file of await names(runtime(root, 'revisions', dir))) files.push(`${dir}/${file}`)
  }
  return files.sort()
}

describe('cleanup', () => {
  it('refuses without --confirm, prints the report, and removes nothing', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const before = await revisionFiles(root)
    expect(before.length).toBeGreaterThan(1)

    const run = await runCliCapture(['cleanup'], {cwd: root})
    expect(run.code).toBe(EXIT.CONFIRMATION_REQUIRED)
    /* The refusal still shows the loss — that is the entire point of refusing. */
    expect(run.stdout).toMatch(/orphan/i)
    expect(await revisionFiles(root)).toEqual(before)
  })

  it('--dry-run reports and exits OK without removing anything', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const before = await revisionFiles(root)

    const run = await runCliCapture(['cleanup', '--dry-run', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      applied: boolean
      dryRun: boolean
      orphans: {candidates: Array<{kind: string; ref: string}>; deleted: unknown[]}
    }
    expect(report.applied).toBe(false)
    expect(report.dryRun).toBe(true)
    expect(report.orphans.candidates.length).toBeGreaterThan(0)
    expect(report.orphans.deleted).toEqual([])
    expect(await revisionFiles(root)).toEqual(before)
  })

  it('--confirm removes the superseded revisions and leaves the head alone', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const before = await revisionFiles(root)

    /* The head the manifest names must survive; ask the CLI what it is. */
    const inspected = await runCliCapture(['inspect', '--json'], {cwd: root})
    const manifest = JSON.parse(inspected.stdout) as {
      documents: Array<{storageRef: string}>
    }
    const keptRefs = manifest.documents.map((head) => head.storageRef)
    expect(keptRefs.length).toBeGreaterThan(0)

    const run = await runCliCapture(['cleanup', '--confirm', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      applied: boolean
      orphans: {deleted: Array<{ref: string}>}
    }
    expect(report.applied).toBe(true)
    expect(report.orphans.deleted.length).toBeGreaterThan(0)

    const after = await revisionFiles(root)
    expect(after.length).toBeLessThan(before.length)
    /* Content still reachable from the manifest is untouched. */
    for (const ref of keptRefs) {
      expect(after).toContain(ref.replace(/^\.runtime\/revisions\//, ''))
    }

    /* And the overlay still validates against the §34 invariants afterwards. */
    const validated = await runCliCapture(['validate'], {cwd: root})
    expect(validated.code).toBe(EXIT.OK)
  })

  it('leaves the transaction log alone unless a retention window is given', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const before = await names(runtime(root, 'transactions'))
    expect(before).toHaveLength(3)

    const run = await runCliCapture(['cleanup', '--confirm', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      runtimeHistory: {transactions: unknown[]; pointers: unknown[]}
    }
    expect(report.runtimeHistory.transactions).toEqual([])
    expect(await names(runtime(root, 'transactions'))).toEqual(before)
  })

  it('--keep-last prunes the log and its idempotency pointers together', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    expect(await names(runtime(root, 'transactions'))).toHaveLength(3)
    expect(await names(runtime(root, 'indexes', 'idempotency'))).toHaveLength(3)

    const run = await runCliCapture(['cleanup', '--confirm', '--keep-last', '1', '--json'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      runtimeHistory: {
        transactions: Array<{transactionId: string}>
        pointers: Array<{reason: string}>
        retainedHead: string
      }
    }
    expect(report.runtimeHistory.transactions).toHaveLength(2)
    expect(report.runtimeHistory.pointers.every((p) => p.reason === 'pruned-transaction')).toBe(true)

    /* Records and pointers go together, so no dangling pointer is created. */
    expect(await names(runtime(root, 'transactions'))).toHaveLength(1)
    expect(await names(runtime(root, 'indexes', 'idempotency'))).toHaveLength(1)

    /* `history` now honestly reports one entry rather than three. */
    const history = await runCliCapture(['history', '--json'], {cwd: root})
    const log = JSON.parse(history.stdout) as {count: number}
    expect(log.count).toBe(1)
  })

  it('warns in prose that pruning the log weakens §34.6 replay', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const run = await runCliCapture(['cleanup', '--confirm', '--keep-last', '1'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toMatch(/idempotenc/i)
    expect(run.stdout).toMatch(/replay|re-?appl/i)
  })

  it('removes an idempotency pointer that already names nothing, with no window', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    /* Wipe the log but keep the ledger: every pointer now names nothing, which
     * is broken state and needs no retention decision to clear. */
    await rm(runtime(root, 'transactions'), {recursive: true, force: true})
    expect(await names(runtime(root, 'indexes', 'idempotency'))).toHaveLength(3)

    const run = await runCliCapture(['cleanup', '--confirm', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      runtimeHistory: {pointers: Array<{reason: string}>}
    }
    expect(report.runtimeHistory.pointers).toHaveLength(3)
    expect(report.runtimeHistory.pointers.every((p) => p.reason === 'dangling')).toBe(true)
    expect(await names(runtime(root, 'indexes', 'idempotency'))).toHaveLength(0)
  })

  it('rejects a non-numeric --keep-last rather than pruning everything', async () => {
    const {root} = await createOverlayFixture({edits: SUPERSEDING_EDITS})
    const run = await runCliCapture(['cleanup', '--confirm', '--keep-last', 'all'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('--keep-last')
    expect(run.stderr).toContain('all')
    /* Nothing was pruned on the way to refusing. */
    expect(await names(runtime(root, 'transactions'))).toHaveLength(3)
  })

  it('fails with the overlay exit code when there is no overlay', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['cleanup', '--dry-run'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toContain('OVERLAY_NOT_FOUND')
  })
})
