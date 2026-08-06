/**
 * `query` — GROQ against the branch, through the registry.
 *
 * The point of this command is that it CANNOT answer an unregistered query: it
 * runs `evaluateOverlayQuery` over `M_LOCAL_QUERIES`, so the CLI's refusal
 * policy is the runtime's refusal policy rather than a second one. The
 * exactness assertions use the seeded base dataset as the oracle: base says
 * "Base article title", the branch draft says "Branch article title", and the
 * perspective decides which one a registered lookup returns.
 */
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  FIXTURE_BASE_DOCUMENTS,
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

async function writeBaseFile(root: string): Promise<string> {
  const path = join(root, 'base.json')
  await writeFile(path, JSON.stringify(FIXTURE_BASE_DOCUMENTS, null, 2), 'utf8')
  return path
}

describe('query registry policy', () => {
  it('--list names every registered query and its tier', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['query', '--list'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('article-by-id')
    expect(run.stdout).toContain('page-by-slug')
    expect(run.stdout).toContain('unconstrained-star')
    expect(run.stdout).toContain('unsupported')
  })

  it('refuses an unregistered query id', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(['query', 'totally-made-up', '--base', base], {cwd: root})
    expect(run.code).toBe(EXIT.QUERY_REFUSED)
    expect(run.stderr).toContain('QUERY_NOT_REGISTERED')
    expect(run.stdout).toBe('')
  })

  it('refuses a raw GROQ string as if it were an id, rather than evaluating it', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(['query', '*[_type == "article"]', '--base', base], {cwd: root})
    expect(run.code).toBe(EXIT.QUERY_REFUSED)
    expect(run.stderr).toContain('QUERY_NOT_REGISTERED')
  })

  it('refuses a registered-but-unsupported query structurally', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'unconstrained-star', '--caller', 'test', '--perspective', 'published', '--base', base],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.QUERY_REFUSED)
    expect(run.stderr).toContain('UNSUPPORTED_GROQ')
  })

  it('refuses a caller the registration does not allow', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'unconstrained-star', '--caller', 'frontend', '--perspective', 'published', '--base', base],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.QUERY_REFUSED)
    expect(run.stderr).toContain('CALLER')
  })

  it('exits USAGE with no query id and no --list', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['query'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
  })
})

describe('query evaluation', () => {
  it('returns the branch value in the drafts perspective', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'article-by-id', '--param', 'id=article-1', '--base', base, '--json'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    const parsed = JSON.parse(run.stdout)
    expect(parsed.result.title).toBe('Branch article title')
  })

  it('returns the base value in the published perspective', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      [
        'query',
        'article-by-id',
        '--param',
        'id=article-1',
        '--perspective',
        'published',
        '--base',
        base,
        '--json',
      ],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(JSON.parse(run.stdout).result.title).toBe('Base article title')
  })

  it('includes a branch-created document no base fetch could ever return', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(['query', 'article-type-list', '--base', base, '--json'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.OK)
    const ids = JSON.parse(run.stdout).result.map((doc: any) => doc._id)
    expect(ids).toContain('article-2')
    expect(ids).toContain('article-1')
  })

  it('suppresses a tombstoned document instead of serving the base row', async () => {
    const {root} = await createOverlayFixture({edits: [{kind: 'delete', id: 'article-1'}]})
    const base = await writeBaseFile(root)
    const run = await runCliCapture(['query', 'article-type-list', '--base', base, '--json'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.OK)
    const ids = JSON.parse(run.stdout).result.map((doc: any) => doc._id)
    expect(ids).not.toContain('article-1')
  })

  it('emits §22.8 diagnostics', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'article-by-id', '--param', 'id=article-1', '--base', base, '--json'],
      {cwd: root},
    )
    const {diagnostics} = JSON.parse(run.stdout)
    expect(diagnostics.queryId).toBe('article-by-id')
    expect(diagnostics.exact).toBe(true)
    expect(diagnostics.candidateIds).toContain('article-1')
    expect(diagnostics.evaluatorInvocations).toBeGreaterThan(0)
  })

  it('parses JSON parameter values and falls back to strings', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'article-by-slug', '--param', 'slug=base-article', '--base', base, '--json'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(JSON.parse(run.stdout).result.slug).toBe('base-article')
  })

  it('exits USAGE on a malformed --param', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeBaseFile(root)
    const run = await runCliCapture(
      ['query', 'article-by-id', '--param', 'no-equals-sign', '--base', base],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('runs with no --base at all, treating the base dataset as empty', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['query', 'article-type-list', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    const ids = JSON.parse(run.stdout).result.map((doc: any) => doc._id)
    expect(ids).toContain('article-2')
  })
})
