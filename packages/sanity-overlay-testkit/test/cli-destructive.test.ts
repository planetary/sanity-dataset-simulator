/**
 * `reset` and `rebase` — the two commands that destroy work.
 *
 * The rule under test is that destruction is never the easy default: without an
 * explicit `--confirm` the command must print exactly what would be lost and
 * change nothing on disk. Every "changed nothing" assertion reads the manifest
 * back with `node:fs` rather than trusting the command's own report.
 */
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  FIXTURE_BASE_DOCUMENTS,
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'
import type {SanityDocument} from '../../sanity-overlay-core/src/index'

afterEach(cleanupOverlayFixtures)

async function manifestOf(root: string): Promise<any> {
  return JSON.parse(await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'))
}

/** Write a `--base` file holding the current base dataset, optionally patched. */
async function writeBaseFile(
  root: string,
  patch: (documents: SanityDocument[]) => SanityDocument[] = (docs) => docs,
): Promise<string> {
  const path = join(root, 'base.json')
  const documents = patch(FIXTURE_BASE_DOCUMENTS.map((doc) => JSON.parse(JSON.stringify(doc))))
  await writeFile(path, JSON.stringify(documents, null, 2), 'utf8')
  return path
}

describe('reset', () => {
  it('refuses without --confirm, prints the loss, and writes nothing', async () => {
    const {root} = await createOverlayFixture()
    const before = await manifestOf(root)

    const run = await runCliCapture(['reset', '--all'], {cwd: root})

    expect(run.code).toBe(EXIT.CONFIRMATION_REQUIRED)
    expect(run.stdout).toContain('article-1')
    expect(run.stdout).toContain('article-2')
    expect(run.stderr).toContain('--confirm')
    const after = await manifestOf(root)
    expect(after.revision).toBe(before.revision)
    expect(Object.keys(after.documentHeads).sort()).toEqual(['article-1', 'article-2'])
  })

  it('names the state that would be lost, not just the ID', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['reset', '--all', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)
    expect(parsed.confirmed).toBe(false)
    expect(parsed.wouldRemove).toEqual([
      expect.objectContaining({logicalId: 'article-1', state: 'modified'}),
      expect.objectContaining({logicalId: 'article-2', state: 'created'}),
    ])
  })

  it('--dry-run writes nothing even with --confirm', async () => {
    const {root} = await createOverlayFixture()
    const before = await manifestOf(root)

    const run = await runCliCapture(['reset', '--all', '--confirm', '--dry-run'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('article-1')
    expect(await manifestOf(root)).toEqual(before)
  })

  it('--all --confirm empties the overlay and advances the revision', async () => {
    const {root} = await createOverlayFixture()
    const before = await manifestOf(root)

    const run = await runCliCapture(['reset', '--all', '--confirm'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const after = await manifestOf(root)
    expect(after.documentHeads).toEqual({})
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('--document --confirm removes only that document', async () => {
    const {root} = await createOverlayFixture()

    const run = await runCliCapture(['reset', '--document', 'article-1', '--confirm'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    expect(Object.keys((await manifestOf(root)).documentHeads)).toEqual(['article-2'])
  })

  it('exits USAGE with neither --all nor --document', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['reset', '--confirm'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(Object.keys((await manifestOf(root)).documentHeads).length).toBe(2)
  })

  it('exits USAGE with both --all and --document', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['reset', '--all', '--document', 'article-1', '--confirm'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.USAGE)
    expect(Object.keys((await manifestOf(root)).documentHeads).length).toBe(2)
  })

  it('exits OVERLAY for a document the branch does not touch', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['reset', '--document', 'author-1', '--confirm'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(Object.keys((await manifestOf(root)).documentHeads).length).toBe(2)
  })
})

describe('rebase', () => {
  it('exits USAGE without --base, because the current base cannot be guessed', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['rebase', '--confirm'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('--base')
  })

  it('refuses without --confirm and writes nothing', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', slug: {current: 'moved-slug'}}
          : doc,
      ),
    )
    const before = await manifestOf(root)

    const run = await runCliCapture(['rebase', '--base', base], {cwd: root})

    expect(run.code).toBe(EXIT.CONFIRMATION_REQUIRED)
    expect(run.stderr).toContain('--confirm')
    expect(await manifestOf(root)).toEqual(before)
  })

  it('applies when the base moved only on untouched paths', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', slug: {current: 'moved-slug'}}
          : doc,
      ),
    )
    const before = await manifestOf(root)

    const run = await runCliCapture(['rebase', '--base', base, '--confirm', '--json'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const parsed = JSON.parse(run.stdout)
    const article = parsed.documents.find((doc: any) => doc.logicalId === 'article-1')
    expect(article.applied).toBe(true)
    expect(article.blockedBy).toEqual([])

    const after = await manifestOf(root)
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('records the new merge ancestor revision on disk after applying', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', slug: {current: 'moved-slug'}}
          : doc,
      ),
    )

    await runCliCapture(['rebase', '--base', base, '--confirm'], {cwd: root})

    const intent = JSON.parse(
      await readFile(join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'), 'utf8'),
    )
    expect(intent.base.publishedRevision).toBe('base-rev-article-1b')
  })

  it('blocks and exits FINDINGS when the base moved on a touched path', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', title: 'Base title moved underneath'}
          : doc,
      ),
    )
    const before = await manifestOf(root)

    const run = await runCliCapture(['rebase', '--base', base, '--confirm', '--json'], {cwd: root})

    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    const article = parsed.documents.find((doc: any) => doc.logicalId === 'article-1')
    expect(article.applied).toBe(false)
    expect(article.blockedBy).toContain('base-changed-only-on-untouched-paths')
    expect(await manifestOf(root)).toEqual(before)
  })

  it('--dry-run reports the plan without writing', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', slug: {current: 'moved-slug'}}
          : doc,
      ),
    )
    const before = await manifestOf(root)

    const run = await runCliCapture(['rebase', '--base', base, '--confirm', '--dry-run'], {
      cwd: root,
    })

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('article-1')
    expect(await manifestOf(root)).toEqual(before)
  })

  it('exits USAGE on an unknown --mode', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(['rebase', '--base', base, '--mode', 'nope', '--confirm'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('--mode accept-base drops the local value for the touched path', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root, (docs) =>
      docs.map((doc) =>
        doc._id === 'article-1'
          ? {...doc, _rev: 'base-rev-article-1b', title: 'Base title moved underneath'}
          : doc,
      ),
    )

    const run = await runCliCapture(
      ['rebase', '--document', 'article-1', '--base', base, '--mode', 'accept-base', '--confirm'],
      {cwd: root},
    )

    expect(run.code).toBe(EXIT.OK)
    const materialized = JSON.parse(
      await readFile(
        join(root, '.sanity-overlay', '.runtime', 'materialized', 'article-1.json'),
        'utf8',
      ),
    )
    expect(JSON.stringify(materialized)).toContain('Base title moved underneath')
  })

  it('exits USAGE when --base is not readable JSON', async () => {
    const {root} = await createOverlayFixture()
    const path = join(root, 'broken-base.json')
    await writeFile(path, '{ nope', 'utf8')
    const run = await runCliCapture(['rebase', '--base', path, '--confirm'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('broken-base.json')
  })
})
