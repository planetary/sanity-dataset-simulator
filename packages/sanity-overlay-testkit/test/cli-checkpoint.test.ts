/**
 * `export` and `import` — the checkpoint tree (PRD §29.4) and the §35.7
 * portable bundle.
 *
 * Both are thin front ends: the checkpoint tree is core's `exportCheckpoint` /
 * `importCheckpoint` written to disk by `FsOverlayStore`, and the bundle is
 * `exportCanonical` / `importCanonical`. The independent oracles are core's own
 * `verifyCheckpoint` (run against the bytes the CLI wrote) and `bundleChecksum`
 * — never a value the CLI computed.
 */
import {readFile, readdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {bundleChecksum, verifyCheckpoint} from '../../sanity-overlay-core/src/index'
import {readCheckpointDir} from '../../sanity-overlay-store-fs/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

describe('export — checkpoint tree', () => {
  it('writes a tree that core verifies clean', async () => {
    const {root, overlayId} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')

    const run = await runCliCapture(['export', '--output', dir], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const verification = verifyCheckpoint(await readCheckpointDir(dir))
    expect(verification.ok).toBe(true)
    expect(verification.corrupt).toEqual([])

    const checksums = JSON.parse(await readFile(join(dir, 'checksums.json'), 'utf8'))
    expect(checksums.overlayId).toBe(overlayId)
  })

  it('writes the §29.1 review surface and no runtime files', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})

    const entries = (await readdir(dir)).sort()
    expect(entries).toContain('manifest.json')
    expect(entries).toContain('documents')
    expect(entries).toContain('checksums.json')
    expect(entries).not.toContain('.runtime')
  })

  it('is byte-identical across runs', async () => {
    const {root} = await createOverlayFixture()
    const first = join(root, 'cp-a')
    const second = join(root, 'cp-b')

    await runCliCapture(['export', '--output', first], {cwd: root})
    await runCliCapture(['export', '--output', second], {cwd: root})

    const a = await readCheckpointDir(first)
    const b = await readCheckpointDir(second)
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
  })

  it('reports the files it wrote', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    const run = await runCliCapture(['export', '--output', dir, '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.dir).toBe(dir)
    expect(parsed.files).toContain('manifest.json')
    expect(parsed.files).toContain('checksums.json')
    expect(parsed.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exits USAGE with neither --output nor --bundle', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['export'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('--output')
  })
})

describe('export — portable bundle', () => {
  it('writes a self-verifying §35.7 bundle', async () => {
    const {root, overlayId} = await createOverlayFixture()
    const output = join(root, 'bundle.json')

    const run = await runCliCapture(['export', '--bundle', output], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const bundle = JSON.parse(await readFile(output, 'utf8'))
    expect(bundle.overlayId).toBe(overlayId)
    expect(bundle.documents).toHaveLength(2)
    expect(bundle.checksum).toBe(bundleChecksum(bundle))
  })

  it('is byte-identical across runs despite an injected wall clock', async () => {
    const {root} = await createOverlayFixture()
    const first = join(root, 'a.json')
    const second = join(root, 'b.json')

    await runCliCapture(['export', '--bundle', first], {cwd: root})
    await runCliCapture(['export', '--bundle', second], {cwd: root})

    expect(await readFile(second, 'utf8')).toBe(await readFile(first, 'utf8'))
  })

  it('--no-transactions omits the runtime transaction log', async () => {
    const {root} = await createOverlayFixture()
    const output = join(root, 'bundle.json')
    await runCliCapture(['export', '--bundle', output, '--no-transactions'], {cwd: root})
    const bundle = JSON.parse(await readFile(output, 'utf8'))
    expect(bundle.transactions).toEqual([])
    expect(bundle.checksum).toBe(bundleChecksum(bundle))
  })
})

describe('import — checkpoint tree', () => {
  it('restores an overlay into an empty root', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})

    const run = await runCliCapture(['import', '--input', dir], {cwd: target.root})

    expect(run.code).toBe(EXIT.OK)
    const manifest = JSON.parse(
      await readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    )
    expect(manifest.overlayId).toBe(source.overlayId)
    expect(Object.keys(manifest.documentHeads).sort()).toEqual(['article-1', 'article-2'])
  })

  it('round-trips: the imported overlay inspects identically to the source', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})
    await runCliCapture(['import', '--input', dir], {cwd: target.root})

    const before = await runCliCapture(['inspect', '--json'], {cwd: source.root})
    const after = await runCliCapture(['inspect', '--json'], {cwd: target.root})

    expect(after.stdout).toBe(before.stdout)
  })

  it('refuses to overwrite an existing overlay without --confirm', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture()
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})
    const before = await readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8')

    const run = await runCliCapture(['import', '--input', dir, '--overwrite'], {cwd: target.root})

    expect(run.code).toBe(EXIT.CONFIRMATION_REQUIRED)
    expect(run.stderr).toContain('--confirm')
    expect(await readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8')).toBe(
      before,
    )
  })

  it('overwrites with --overwrite --confirm', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({edits: []})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})

    const run = await runCliCapture(['import', '--input', dir, '--overwrite', '--confirm'], {
      cwd: target.root,
    })

    expect(run.code).toBe(EXIT.OK)
    const manifest = JSON.parse(
      await readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    )
    expect(Object.keys(manifest.documentHeads).sort()).toEqual(['article-1', 'article-2'])
  })

  it('rejects a semantically corrupt checkpoint and writes nothing', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})
    await writeFile(join(dir, 'documents', 'article-1', 'intent.json'), '{ not json', 'utf8')

    const run = await runCliCapture(['import', '--input', dir], {cwd: target.root})

    expect(run.code).toBe(EXIT.OVERLAY)
    await expect(
      readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('exits USAGE with neither --input nor --bundle', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['import'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('exits USAGE when the checkpoint directory does not exist', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['import', '--input', join(root, 'nope')], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('nope')
  })
})

/**
 * Rewrite a checkpoint file with identical semantics but different bytes.
 *
 * This is what a legitimate Git merge or a formatter does, and — per PRD §14.3 —
 * it is INDISTINGUISHABLE from a hand-edit. That ambiguity is the whole reason
 * `validate` and `import` must take opposite defaults on it.
 */
async function makeBytesStale(path: string): Promise<void> {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify(parsed), 'utf8')
}

describe('validate --checkpoint', () => {
  it('exits OK on a checkpoint the CLI just wrote', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})

    const run = await runCliCapture(['validate', '--checkpoint', dir, '--json'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.checkpoint.ok).toBe(true)
    expect(parsed.checkpoint.repairable).toEqual([])
    expect(parsed.checkpoint.corrupt).toEqual([])
  })

  /**
   * The command whose entire job is verification must not quietly repair what it
   * is measuring: `validate` passes the strict reading of PRD §14.3, so a stale
   * checksum is a finding even though `import` would repair it.
   */
  it('fails on repairable divergence rather than repairing it', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})
    await makeBytesStale(join(dir, 'documents', 'article-1', 'intent.json'))

    const run = await runCliCapture(['validate', '--checkpoint', dir, '--json'], {cwd: root})

    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.checkpoint.ok).toBe(false)
    expect(parsed.checkpoint.repairable.length).toBeGreaterThan(0)
    expect(parsed.checkpoint.corrupt).toEqual([])
  })

  /**
   * A checkpoint carries no §13.3 records, so nothing can cross-check
   * `documentHeads[].checksum`. A structurally valid manifest edit is therefore
   * only ever "repairable", and `validate` must say so rather than imply the
   * manifest was verified against content.
   */
  it('surfaces a structurally valid manifest edit as repairable, and says why', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})
    await makeBytesStale(join(dir, 'manifest.json'))

    const run = await runCliCapture(['validate', '--checkpoint', dir], {cwd: root})

    expect(run.code).toBe(EXIT.FINDINGS)
    expect(run.stdout).toContain('manifest.json')
    expect(run.stdout).toContain('repairable')
    expect(run.stdout).toMatch(/carries no .*records/i)
    expect(run.stdout).toMatch(/cannot be\s+cross-checked against content/i)
  })

  it('separates semantic corruption from repairable divergence', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})
    await writeFile(join(dir, 'documents', 'article-1', 'intent.json'), '{ not json', 'utf8')

    const run = await runCliCapture(['validate', '--checkpoint', dir, '--json'], {cwd: root})

    expect(run.code).toBe(EXIT.FINDINGS)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.checkpoint.corrupt.length).toBeGreaterThan(0)
  })

  it('exits USAGE when the checkpoint directory does not exist', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['validate', '--checkpoint', join(root, 'nope')], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('does not touch the checkpoint it verified', async () => {
    const {root} = await createOverlayFixture()
    const dir = join(root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: root})
    const intentPath = join(dir, 'documents', 'article-1', 'intent.json')
    await makeBytesStale(intentPath)
    const damaged = await readFile(intentPath, 'utf8')

    await runCliCapture(['validate', '--checkpoint', dir], {cwd: root})

    expect(await readFile(intentPath, 'utf8')).toBe(damaged)
  })
})

describe('import — divergence policy', () => {
  it('repairs stale checksums by default and names what it repaired', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})
    await makeBytesStale(join(dir, 'documents', 'article-1', 'intent.json'))

    const run = await runCliCapture(['import', '--input', dir], {cwd: target.root})

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('repaired')
    const json = await runCliCapture(['import', '--input', dir, '--overwrite', '--confirm', '--json'], {
      cwd: target.root,
    })
    expect(JSON.parse(json.stdout).repaired.length).toBeGreaterThan(0)
  })

  it('--strict refuses the same divergence and writes nothing', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})
    await makeBytesStale(join(dir, 'documents', 'article-1', 'intent.json'))

    const run = await runCliCapture(['import', '--input', dir, '--strict'], {cwd: target.root})

    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toMatch(/checksum|diverg/i)
    await expect(
      readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('states that a checkpoint import carries no runtime records or transaction log', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const dir = join(source.root, 'checkpoint')
    await runCliCapture(['export', '--output', dir], {cwd: source.root})

    const run = await runCliCapture(['import', '--input', dir], {cwd: target.root})

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toMatch(/no runtime records|transaction log/i)
  })

  it('the bundle path is lossless and says so', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const bundle = join(source.root, 'bundle.json')
    await runCliCapture(['export', '--bundle', bundle], {cwd: source.root})

    const run = await runCliCapture(['import', '--bundle', bundle, '--json'], {cwd: target.root})

    expect(run.code).toBe(EXIT.OK)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.lossless).toBe(true)
    expect(parsed.importedTransactions).toBeGreaterThan(0)
  })
})

describe('import — portable bundle', () => {
  it('round-trips a bundle into an empty root', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const output = join(source.root, 'bundle.json')
    await runCliCapture(['export', '--bundle', output], {cwd: source.root})

    const run = await runCliCapture(['import', '--bundle', output], {cwd: target.root})

    expect(run.code).toBe(EXIT.OK)
    const before = await runCliCapture(['inspect', '--json'], {cwd: source.root})
    const after = await runCliCapture(['inspect', '--json'], {cwd: target.root})
    expect(after.stdout).toBe(before.stdout)
  })

  it('rejects a bundle whose checksum does not match its contents', async () => {
    const source = await createOverlayFixture()
    const target = await createOverlayFixture({empty: true})
    const output = join(source.root, 'bundle.json')
    await runCliCapture(['export', '--bundle', output], {cwd: source.root})

    const bundle = JSON.parse(await readFile(output, 'utf8'))
    bundle.manifest.status = 'closed'
    await writeFile(output, JSON.stringify(bundle), 'utf8')

    const run = await runCliCapture(['import', '--bundle', output], {cwd: target.root})

    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toMatch(/checksum/i)
    await expect(
      readFile(join(target.root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('exits USAGE when the bundle file is not readable JSON', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const path = join(root, 'broken.json')
    await writeFile(path, 'not json at all', 'utf8')
    const run = await runCliCapture(['import', '--bundle', path], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('broken.json')
  })
})
