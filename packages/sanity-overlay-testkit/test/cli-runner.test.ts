/**
 * The CLI front door — dispatch, usage, exit codes, and the failure paths every
 * command shares (roadmap Phase 3 "the CLI", PRD §37 Phase 2).
 *
 * `runCli` is a pure-ish function over an argv array and an injected IO pair, so
 * every case here asserts on what the caller would actually see: the exit code
 * and the two streams. Nothing spawns a process, and nothing asserts on a value
 * the CLI just computed — the overlay under test is written to a real temp
 * directory by `seedOverlay`, i.e. by the Studio write path.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {CLI_COMMANDS, EXIT, plural} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

describe('exit codes', () => {
  it('are a documented, stable set', () => {
    expect(EXIT).toEqual({
      OK: 0,
      ERROR: 1,
      FINDINGS: 2,
      CONFIRMATION_REQUIRED: 3,
      OVERLAY: 4,
      USAGE: 5,
      QUERY_REFUSED: 6,
    })
  })
})

/**
 * Counted labels are built by one helper, so a wrong plural is a bug in the
 * caller's word choice rather than in the helper. Both halves are pinned here:
 * the default `+s` rule, and the explicit form every irregular caller must pass.
 */
describe('counted labels', () => {
  it('applies the default +s rule', () => {
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(1, 'file')).toBe('1 file')
    expect(plural(2, 'file')).toBe('2 files')
  })

  it('uses an explicit plural where +s would be wrong', () => {
    expect(plural(2, 'repairable divergence', 'repairable divergences')).toBe(
      '2 repairable divergences',
    )
    expect(plural(0, 'listed', 'listed')).toBe('0 listed')
    expect(plural(1, 'entry', 'entries')).toBe('1 entry')
    expect(plural(3, 'entry', 'entries')).toBe('3 entries')
  })
})

describe('dispatch', () => {
  it('exposes exactly the ten PRD §37 Phase 2 commands', () => {
    expect([...CLI_COMMANDS].sort()).toEqual(
      [
        'conflicts',
        'diff',
        'export',
        'import',
        'inspect',
        'query',
        'rebase',
        'reset',
        'status',
        'validate',
      ].sort(),
    )
  })

  it('--help lists every command and the exit-code table', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['--help'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    for (const command of CLI_COMMANDS) expect(run.stdout).toContain(command)
    expect(run.stdout).toContain('Exit codes')
    expect(run.stdout).toContain('3  confirmation required')
  })

  it('--version prints a version and nothing else on stderr', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['--version'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(run.stderr).toBe('')
  })

  it('exits USAGE with no command', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture([], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('usage')
    expect(run.stdout).toBe('')
  })

  it('exits USAGE and names the offender on an unknown command', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['frobnicate'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('frobnicate')
    expect(run.stdout).toBe('')
  })

  it('exits USAGE on an unknown option rather than ignoring it', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['status', '--definitely-not-an-option'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('definitely-not-an-option')
  })

  it('routes --root to a different overlay than the cwd', async () => {
    const withOverlay = await createOverlayFixture()
    const withoutOverlay = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['status', '--root', withOverlay.root], {
      cwd: withoutOverlay.root,
    })
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain(withOverlay.overlayId)
  })
})

describe('missing and corrupt overlays', () => {
  const overlayReading = ['status', 'inspect', 'validate', 'diff', 'conflicts'] as const

  for (const command of overlayReading) {
    it(`${command} exits OVERLAY when there is no .sanity-overlay/`, async () => {
      const {root} = await createOverlayFixture({empty: true})
      const run = await runCliCapture([command], {cwd: root})
      expect(run.code).toBe(EXIT.OVERLAY)
      expect(run.stderr).toMatch(/no overlay|OVERLAY_NOT_FOUND/i)
      expect(run.stdout).toBe('')
    })
  }

  it('reports a corrupt manifest as an overlay error, not a crash', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(join(root, '.sanity-overlay', 'manifest.json'), '{ not json', 'utf8')
    const run = await runCliCapture(['status'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    expect(run.stderr).toContain('manifest.json')
    expect(run.stderr).not.toContain('at Object.')
  })

  it('reports a corrupt manifest with --json as structured stderr', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(join(root, '.sanity-overlay', 'manifest.json'), '{ not json', 'utf8')
    const run = await runCliCapture(['status', '--json'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
    const parsed = JSON.parse(run.stderr)
    expect(parsed.ok).toBe(false)
    expect(typeof parsed.code).toBe('string')
  })

  it('refuses a --root that is a file rather than a directory', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'x', 'utf8')
    const run = await runCliCapture(['status', '--root', file], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('not-a-directory')
  })
})

describe('secret hygiene', () => {
  it('never prints the value of a token-shaped environment variable', async () => {
    const secret = 'sk-live-2b7f1c9e4a6d8f0b3e5c7a91'
    const {root} = await createOverlayFixture({
      edits: [
        {
          kind: 'edit',
          id: 'article-1',
          operations: [{type: 'set', path: ['title'], value: `leak ${secret} leak`}],
        },
      ],
    })
    const env = {SANITY_API_TOKEN: secret, PATH: '/usr/bin'}

    for (const argv of [['diff'], ['diff', '--json'], ['inspect', '--json'], ['status']]) {
      const run = await runCliCapture(argv, {cwd: root, env})
      expect(run.stdout).not.toContain(secret)
      expect(run.stderr).not.toContain(secret)
    }
  })

  it('leaves ordinary environment values alone', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['status'], {
      cwd: root,
      env: {HOME: '/Users/somebody', SANITY_API_TOKEN: 'sk-live-abcdefghijklmnop'},
    })
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).not.toContain('sk-live-abcdefghijklmnop')
  })
})

describe('write isolation', () => {
  it('read-only commands leave the manifest byte-identical', async () => {
    const {root} = await createOverlayFixture()
    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')
    const before = await readFile(manifestPath, 'utf8')

    for (const argv of [['status'], ['inspect'], ['validate'], ['diff'], ['conflicts']]) {
      await runCliCapture(argv, {cwd: root})
    }

    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })

  it('never creates an overlay as a side effect of reading one', async () => {
    const {root} = await createOverlayFixture({empty: true})
    await mkdir(join(root, 'nested'), {recursive: true})
    await runCliCapture(['status'], {cwd: join(root, 'nested')})
    await expect(readFile(join(root, 'nested', '.sanity-overlay', 'manifest.json'))).rejects.toThrow()
  })
})
