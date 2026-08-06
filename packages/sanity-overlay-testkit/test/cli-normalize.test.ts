/**
 * `sanity-overlay normalize` — the file parse-error surface (PRD §14.3, §14.4,
 * §14.5 `normalize --repair-checksums`, §37 Phase 2 "File parse error UI" and
 * "Reset actions").
 *
 * The recovery machinery already existed inside the store: refuse malformed
 * JSON, retain the last valid state, write a `.broken` diagnostic copy,
 * revalidate before serving, and treat a stale checksum over a semantically
 * valid file as repairable metadata. What did not exist was any way for a
 * developer or an agent to SEE it or ACT on it. This command is that surface.
 *
 * Two properties are load-bearing and are pinned below:
 *
 * - Without `--repair-checksums` it reports and does not rewrite canonical
 *   files. A repair tool that silently repaired what it was measuring would make
 *   `validate` unfalsifiable.
 * - An unparseable file produces a named `.broken` copy AND the concrete next
 *   commands, because "your file is broken" without a route out is not UX.
 */
import {readFile, readdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {parse, serialize} from '../../sanity-overlay-core/src/index'
import {encodeLogicalId} from '../../sanity-overlay-core/src/index'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

function intentPath(root: string, logicalId: string): string {
  return join(root, '.sanity-overlay', 'documents', encodeLogicalId(logicalId), 'intent.json')
}

async function brokenCopies(root: string, logicalId: string): Promise<string[]> {
  const dir = join(root, '.sanity-overlay', 'documents', encodeLogicalId(logicalId))
  return (await readdir(dir)).filter((name) => name.endsWith('.broken')).sort()
}

describe('normalize', () => {
  it('reports a healthy overlay as clean and writes nothing', async () => {
    const {root} = await createOverlayFixture()
    const before = await readFile(intentPath(root, 'article-1'), 'utf8')

    const run = await runCliCapture(['normalize', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {
      ok: boolean
      checked: number
      invalid: unknown[]
      pendingRepairs: unknown[]
      repaired: unknown[]
    }
    expect(report.ok).toBe(true)
    expect(report.checked).toBeGreaterThan(0)
    expect(report.invalid).toEqual([])
    expect(report.pendingRepairs).toEqual([])
    expect(report.repaired).toEqual([])

    expect(await readFile(intentPath(root, 'article-1'), 'utf8')).toBe(before)
  })

  it('reports an unparseable intent file, names its .broken copy, and exits FINDINGS', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(intentPath(root, 'article-1'), '{ "logicalId": "article-1", ', 'utf8')

    const run = await runCliCapture(['normalize'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    expect(run.stdout).toContain('article-1')
    expect(run.stdout).toContain('.broken')

    /* The diagnostic copy is a real file, holding the bytes that failed. */
    const copies = await brokenCopies(root, 'article-1')
    expect(copies).toHaveLength(1)
    const copyPath = join(
      root,
      '.sanity-overlay',
      'documents',
      encodeLogicalId('article-1'),
      copies[0]!,
    )
    expect(await readFile(copyPath, 'utf8')).toBe('{ "logicalId": "article-1", ')
  })

  it('offers both routes out of an unparseable file', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(intentPath(root, 'article-1'), 'not json at all', 'utf8')

    const run = await runCliCapture(['normalize'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    /* Restore from Git, or discard this document's branch state entirely. */
    expect(run.stdout).toContain('git checkout')
    expect(run.stdout).toContain('reset --document article-1 --confirm')
  })

  it('reports a stale checksum without rewriting the file', async () => {
    const {root} = await createOverlayFixture()
    const path = intentPath(root, 'article-1')
    const intent = parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const stale = serialize({...intent, checksum: 'f'.repeat(64)})
    await writeFile(path, stale, 'utf8')

    const run = await runCliCapture(['normalize', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const report = JSON.parse(run.stdout) as {
      ok: boolean
      repaired: unknown[]
      pendingRepairs: Array<{ref: string; logicalId: string}>
    }
    expect(report.ok).toBe(false)
    expect(report.repaired).toEqual([])
    expect(report.pendingRepairs).toHaveLength(1)
    expect(report.pendingRepairs[0]!.logicalId).toBe('article-1')

    /* Byte-for-byte untouched: reporting is not repairing. */
    expect(await readFile(path, 'utf8')).toBe(stale)
  })

  it('--repair-checksums rewrites the stale checksum and then reports clean', async () => {
    const {root} = await createOverlayFixture()
    const path = intentPath(root, 'article-1')
    const original = await readFile(path, 'utf8')
    const intent = parse(original) as Record<string, unknown>
    await writeFile(path, serialize({...intent, checksum: 'f'.repeat(64)}), 'utf8')

    const run = await runCliCapture(['normalize', '--repair-checksums', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const report = JSON.parse(run.stdout) as {ok: boolean; repaired: string[]}
    expect(report.ok).toBe(true)
    expect(report.repaired).toHaveLength(1)

    /* The file on disk is back to the canonical bytes the store would write. */
    expect(await readFile(path, 'utf8')).toBe(original)

    /* And `validate`, which never repairs, now agrees. */
    const validated = await runCliCapture(['validate'], {cwd: root})
    expect(validated.code).toBe(EXIT.OK)
  })

  it('does not fabricate a repair for a file that is not semantically valid', async () => {
    const {root} = await createOverlayFixture()
    const path = intentPath(root, 'article-1')
    const intent = parse(await readFile(path, 'utf8')) as Record<string, unknown>
    /* A logical ID that disagrees with its own directory is a §14.4 step-3
     * failure, not stale metadata — rewriting the checksum would bless it. */
    await writeFile(path, serialize({...intent, logicalId: 'somewhere-else'}), 'utf8')

    const run = await runCliCapture(['normalize', '--repair-checksums', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.FINDINGS)
    const report = JSON.parse(run.stdout) as {
      repaired: string[]
      invalid: Array<{logicalId: string; message: string}>
    }
    expect(report.repaired).toEqual([])
    expect(report.invalid).toHaveLength(1)
    expect(report.invalid[0]!.logicalId).toBe('article-1')

    const onDisk = parse(await readFile(path, 'utf8')) as {logicalId: string}
    expect(onDisk.logicalId).toBe('somewhere-else')
  })

  it('--document narrows revalidation to one logical document', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(intentPath(root, 'article-2'), 'not json', 'utf8')

    const narrowed = await runCliCapture(['normalize', '--document', 'article-1', '--json'], {
      cwd: root,
    })
    expect(narrowed.code).toBe(EXIT.OK)
    const report = JSON.parse(narrowed.stdout) as {checked: number; invalid: unknown[]}
    expect(report.checked).toBe(1)
    expect(report.invalid).toEqual([])

    /* Unnarrowed, the same overlay reports the broken file. */
    const wide = await runCliCapture(['normalize', '--json'], {cwd: root})
    expect(wide.code).toBe(EXIT.FINDINGS)
  })

  it('reports a manifest that cannot be parsed, with its .broken copy on disk', async () => {
    const {root} = await createOverlayFixture()
    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')
    await writeFile(manifestPath, '{ "overlayId": ', 'utf8')

    const run = await runCliCapture(['normalize'], {cwd: root})
    /* Nothing can be normalized without a readable manifest: it names every head.
     * The overlay exit code is the honest answer, and the diagnostic copy is
     * written on the way out (PRD §14.3 SHOULD). */
    expect(run.code).toBe(EXIT.OVERLAY)
    const copies = (await readdir(join(root, '.sanity-overlay'))).filter((name) =>
      name.endsWith('.broken'),
    )
    expect(copies).toHaveLength(1)
  })

  it('fails with the overlay exit code when there is no overlay', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['normalize'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toContain('OVERLAY_NOT_FOUND')
  })
})
