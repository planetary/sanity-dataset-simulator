/**
 * `sanity-overlay history` — the local overlay log, on the command line
 * (PRD §13.10, §14.1 `.runtime/transactions/`, §37 Phase 2 "Local runtime
 * history").
 *
 * The command exists to answer one question honestly: *what did this branch do,
 * in order, and can each step still be read back*. It is not Studio History —
 * there is no Content Lake revision stream behind it — and the log lives under
 * `.runtime/`, which §14.1 keeps out of Git and §29.2 keeps out of a checkpoint.
 * The last two cases below pin that honesty: an overlay whose `.runtime/` never
 * arrived must say the log is not retained, not print "no history" as though the
 * branch had done nothing.
 *
 * Assertions are against the transaction files on disk, read with `node:fs`, not
 * against a list the CLI just printed to itself.
 */
import {readdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

const RUNTIME_TRANSACTIONS = ['.sanity-overlay', '.runtime', 'transactions']

/** Transaction IDs actually on disk, ascending — the independent oracle. */
async function transactionIdsOnDisk(root: string): Promise<string[]> {
  const entries = await readdir(join(root, ...RUNTIME_TRANSACTIONS), {withFileTypes: true})
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort()
}

describe('history', () => {
  it('lists every committed transaction, newest first', async () => {
    const {root} = await createOverlayFixture()
    const onDisk = await transactionIdsOnDisk(root)
    expect(onDisk.length).toBeGreaterThan(1)

    const run = await runCliCapture(['history'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    for (const id of onDisk) expect(run.stdout).toContain(id)

    /* Newest first: the last ID on disk must appear before the first one. */
    const newest = run.stdout.indexOf(onDisk[onDisk.length - 1]!)
    const oldest = run.stdout.indexOf(onDisk[0]!)
    expect(newest).toBeGreaterThanOrEqual(0)
    expect(newest).toBeLessThan(oldest)
  })

  it('--json reports each entry against the transaction files on disk', async () => {
    const {root, overlayId} = await createOverlayFixture()
    const onDisk = await transactionIdsOnDisk(root)

    const run = await runCliCapture(['history', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      overlayId: string
      revision: number
      retained: boolean
      count: number
      entries: Array<{
        transactionId: string
        overlayRevisionBefore: number
        overlayRevisionAfter: number
        affectedDocumentIds: string[]
        recoverable: boolean
        artifacts: Array<{logicalId: string; ref: string; present: boolean; current: boolean}>
      }>
    }

    expect(report.overlayId).toBe(overlayId)
    expect(report.retained).toBe(true)
    expect(report.count).toBe(onDisk.length)
    expect(report.entries.map((entry) => entry.transactionId).sort()).toEqual(onDisk)

    /* Revisions form an unbroken chain from 0 up to the manifest revision. */
    const ascending = [...report.entries].sort(
      (a, b) => a.overlayRevisionAfter - b.overlayRevisionAfter,
    )
    expect(ascending[0]!.overlayRevisionBefore).toBe(0)
    for (const [index, entry] of ascending.entries()) {
      expect(entry.overlayRevisionAfter).toBe(entry.overlayRevisionBefore + 1)
      if (index > 0) {
        expect(entry.overlayRevisionBefore).toBe(ascending[index - 1]!.overlayRevisionAfter)
      }
    }
    expect(ascending[ascending.length - 1]!.overlayRevisionAfter).toBe(report.revision)

    /* Every artifact the log names is still on disk in a healthy overlay. */
    for (const entry of report.entries) {
      expect(entry.recoverable).toBe(true)
      for (const artifact of entry.artifacts) expect(artifact.present).toBe(true)
    }
  })

  it('--document narrows to one logical document', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['history', '--document', 'article-2', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      count: number
      entries: Array<{affectedDocumentIds: string[]}>
    }
    expect(report.count).toBeGreaterThan(0)
    for (const entry of report.entries) {
      expect(entry.affectedDocumentIds).toContain('article-2')
    }
  })

  it('--limit caps the number of entries', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['history', '--limit', '1', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {count: number; entries: unknown[]}
    expect(report.count).toBe(1)
    expect(report.entries).toHaveLength(1)
  })

  it('--since drops everything committed at or before that revision', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['history', '--since', '1', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      entries: Array<{overlayRevisionAfter: number}>
    }
    expect(report.entries.length).toBeGreaterThan(0)
    for (const entry of report.entries) expect(entry.overlayRevisionAfter).toBeGreaterThan(1)
  })

  it('rejects a non-numeric --limit rather than silently listing everything', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['history', '--limit', 'lots'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stdout).toBe('')
    /* Named, so the failure is actionable and cannot be satisfied by the
     * dispatcher's generic "unknown command" refusal. */
    expect(run.stderr).toContain('--limit')
    expect(run.stderr).toContain('lots')
  })

  it('--mutations prints the §13.7 operations a transaction applied', async () => {
    const {root} = await createOverlayFixture()
    const without = await runCliCapture(['history'], {cwd: root})
    const withOps = await runCliCapture(['history', '--mutations'], {cwd: root})
    expect(withOps.code).toBe(EXIT.OK)
    /* The fixture sets `title` on article-1; only the detailed form shows it. */
    expect(withOps.stdout).toContain('title')
    expect(without.stdout).not.toContain('title')
  })

  it('says the log is NOT RETAINED when `.runtime/` never arrived', async () => {
    const {root} = await createOverlayFixture()
    /* Exactly a fresh `git clone`: §14.1 keeps `.runtime/` out of version
     * control, so the canonical review files arrive without any history. */
    await rm(join(root, '.sanity-overlay', '.runtime'), {recursive: true, force: true})

    const run = await runCliCapture(['history', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {retained: boolean; count: number; revision: number}
    expect(report.revision).toBeGreaterThan(0)
    expect(report.count).toBe(0)
    /* The distinction that matters: the branch DID things, the log did not survive. */
    expect(report.retained).toBe(false)

    const human = await runCliCapture(['history'], {cwd: root})
    expect(human.stdout).toMatch(/not retained/i)
    expect(human.stdout).toMatch(/\.runtime/)
  })

  it('reports an empty overlay as retained with nothing in it', async () => {
    const {root} = await createOverlayFixture({edits: []})
    const run = await runCliCapture(['history', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {retained: boolean; count: number; revision: number}
    expect(report.revision).toBe(0)
    expect(report.count).toBe(0)
    /* Revision 0 means nothing was ever committed, so an empty log is truthful. */
    expect(report.retained).toBe(true)
  })

  it('fails with the overlay exit code when there is no overlay', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['history'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toContain('OVERLAY_NOT_FOUND')
  })
})
