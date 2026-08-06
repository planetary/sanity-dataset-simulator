/**
 * `validate` — the PRD §34 invariant gate (roadmap Phase 3 "the CLI").
 *
 * The command is a front end over `checkOverlayInvariants` plus the adapter's
 * own `verifyChecksums`. Every damage case below is inflicted on disk *behind*
 * the store's back — the store's front door refuses bad bytes by design — and
 * the expectation is a structured finding and a non-zero exit, never a stack
 * trace.
 */
import {readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

async function revisionFileFor(root: string, logicalId: string): Promise<string> {
  const dir = join(root, '.sanity-overlay', '.runtime', 'revisions', logicalId)
  const entries = await readdir(dir)
  const file = entries.find((name) => name.endsWith('.json'))
  if (file === undefined) throw new Error(`no revision file in ${dir}`)
  return join(dir, file)
}

describe('validate on an intact overlay', () => {
  it('exits OK', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['validate'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('0 violations')
  })

  it('reports which invariants it ran', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['validate', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.violations).toEqual([])
    expect(parsed.checksums.ok).toBe(true)
    expect(parsed.invariantsChecked).toEqual(
      expect.arrayContaining(['34.1', '34.2', '34.3', '34.4', '34.5', '34.6', '34.17']),
    )
  })

  /**
   * §34.3 cross-checks a head's synthetic `_rev` prefix against the head
   * checksum. The head checksum is the checksum of the §13.3 RECORD; the
   * synthetic `_rev` embeds the checksum of the materialized DOCUMENT (§13.9).
   * They are two different hashes, so the sub-check cannot hold for any manifest
   * a real store wrote. The CLI reports it loudly instead of failing every clean
   * overlay — and `--strict` still fails on it, so the exemption cannot be used
   * to hide a regression.
   */
  it('reports the known §34.3 runtime-revision disagreement without failing', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['validate', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.knownIssues.length).toBeGreaterThan(0)
    for (const issue of parsed.knownIssues) expect(issue.invariant).toBe('34.3')
  })

  it('--strict fails on the known issue', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['validate', '--strict'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
  })
})

describe('validate finds real damage', () => {
  it('reports a content-address violation when a revision file is edited in place', async () => {
    const {root} = await createOverlayFixture()
    const revisionFile = await revisionFileFor(root, 'article-1')
    const record = JSON.parse(await readFile(revisionFile, 'utf8'))
    record.schemaType = 'tampered'
    await writeFile(revisionFile, JSON.stringify(record), 'utf8')

    const run = await runCliCapture(['validate', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.checksums.ok).toBe(false)
    expect(JSON.stringify(parsed.checksums.issues)).toContain('article-1')
  })

  it('reports a missing base snapshot rather than crashing', async () => {
    const {root} = await createOverlayFixture()
    const snapshots = join(root, '.sanity-overlay', 'snapshots')
    for (const entry of await readdir(snapshots)) await rm(join(snapshots, entry))

    const run = await runCliCapture(['validate', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.checksums.missing.length).toBeGreaterThan(0)
  })

  it('reports an unparseable intent file as a document finding', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(
      join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
      '{ this is not json',
      'utf8',
    )

    const run = await runCliCapture(['validate', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.unreadable.map((entry: any) => entry.logicalId)).toContain('article-1')
    expect(run.stderr).not.toContain('at Object.')
  })

  it('human output is non-empty and names the failing document', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(
      join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
      '{ this is not json',
      'utf8',
    )
    const run = await runCliCapture(['validate'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    expect(run.stdout).toContain('article-1')
  })

  it('leaves the overlay untouched — validate never repairs', async () => {
    const {root} = await createOverlayFixture()
    const revisionFile = await revisionFileFor(root, 'article-1')
    const record = JSON.parse(await readFile(revisionFile, 'utf8'))
    record.schemaType = 'tampered'
    const damaged = JSON.stringify(record)
    await writeFile(revisionFile, damaged, 'utf8')

    await runCliCapture(['validate'], {cwd: root})

    expect(await readFile(revisionFile, 'utf8')).toBe(damaged)
  })
})
