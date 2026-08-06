/**
 * `inspect` and `status` — the two read-only reporting commands.
 *
 * `status` answers "where is this branch"; `inspect` answers "what exactly is in
 * it". Both are asserted against the manifest and the intent files that
 * `seedOverlay` actually wrote, read back independently with `node:fs`, so a
 * command that echoed its own computation would not pass.
 */
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

async function readManifest(root: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'))
}

describe('status', () => {
  it('reports the overlay identity, lifecycle state and revision from disk', async () => {
    const {root, overlayId} = await createOverlayFixture()
    const manifest = await readManifest(root)

    const run = await runCliCapture(['status'], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain(overlayId)
    expect(run.stdout).toContain('active')
    expect(run.stdout).toContain(String(manifest.revision))
  })

  it('counts changed documents by §13.2 state', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['status', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.documents.total).toBe(2)
    expect(parsed.documents.byState).toMatchObject({modified: 1, created: 1})
  })

  it('reports a delete as a deleted document rather than a missing one', async () => {
    const {root} = await createOverlayFixture({
      edits: [{kind: 'delete', id: 'page-home'}],
    })
    const run = await runCliCapture(['status', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.documents.byState.deleted).toBe(1)
  })

  it('reports the uncheckpointed revision count', async () => {
    const {root} = await createOverlayFixture()
    const manifest = await readManifest(root)
    const run = await runCliCapture(['status', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.checkpoint).toBeNull()
    expect(parsed.uncheckpointedRevisions).toBe(manifest.revision)
  })

  it('is byte-stable across runs', async () => {
    const {root} = await createOverlayFixture()
    const first = await runCliCapture(['status'], {cwd: root})
    const second = await runCliCapture(['status'], {cwd: root})
    expect(second.stdout).toBe(first.stdout)
  })
})

describe('inspect', () => {
  it('lists every document head in logical-ID order', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['inspect', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.documents.map((doc: any) => doc.logicalId)).toEqual(['article-1', 'article-2'])
  })

  it('matches the manifest heads written to disk', async () => {
    const {root} = await createOverlayFixture()
    const manifest = await readManifest(root)
    const run = await runCliCapture(['inspect', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    for (const doc of parsed.documents) {
      const head = manifest.documentHeads[doc.logicalId]
      expect(head).toBeDefined()
      expect(doc.checksum).toBe(head.checksum)
      expect(doc.state).toBe(head.state)
      expect(doc.runtimeRevision).toBe(head.runtimeRevision)
    }
  })

  it('--document reports touched paths for one document', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['inspect', '--document', 'article-1', '--json'], {cwd: root})
    const parsed = JSON.parse(run.stdout)

    expect(parsed.logicalId).toBe('article-1')
    expect(parsed.schemaType).toBe('article')
    expect(parsed.draft.touchedPaths).toEqual(
      expect.arrayContaining(['title', 'body[_key=="block-b"].text', 'tags']),
    )
  })

  it('--document normalizes a drafts. prefix to the same logical document', async () => {
    const {root} = await createOverlayFixture()
    const plain = await runCliCapture(['inspect', '--document', 'article-1', '--json'], {cwd: root})
    const drafted = await runCliCapture(['inspect', '--document', 'drafts.article-1', '--json'], {
      cwd: root,
    })
    expect(drafted.stdout).toBe(plain.stdout)
  })

  it('--document exits OVERLAY for a document the branch does not touch', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['inspect', '--document', 'author-1'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toContain('author-1')
  })

  it('human output names the base project and dataset', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['inspect'], {cwd: root})
    expect(run.stdout).toContain('proj-cli')
    expect(run.stdout).toContain('production')
    expect(run.stdout).toContain('feature/cli')
  })
})
