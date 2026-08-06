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
import {
  CLI_COMMANDS,
  COMMANDS_BEYOND_PRD,
  EXIT,
  PHASE_2_CLI_COMMANDS,
  PRD_14_5_COMMANDS,
  plural,
} from '../../sanity-overlay-cli/src/index'
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

/**
 * ## Why the dispatched command set is not the §37 Phase 2 checklist
 *
 * This block used to pin `CLI_COMMANDS` at "exactly the ten PRD §37 Phase 2
 * commands". That conflated two different lists in the PRD, and the conflation
 * is what these tests now separate.
 *
 * - **§14.5 "Filesystem commands"** is the SPECIFIED command surface. It is a
 *   fenced block naming fourteen commands, and `normalize --repair-checksums`
 *   is one of them — spelled exactly that way, and used again verbatim in the
 *   §29.4 checkpoint-commit recipe (`export` → `normalize --repair-checksums` →
 *   `git add` → `git commit`).
 * - **§37 Phase 2 "CLI"** is a PHASE TASK CHECKLIST. It selects ten of those
 *   fourteen as the work of that phase. It is a schedule, not an inventory, and
 *   it never claims to bound the CLI.
 *
 * So `normalize` is not an eleventh command anyone invented. Pinning the
 * dispatcher to the §37 selection would have made the PRD's own §29.4 workflow
 * un-runnable, which is the test failing the product rather than the reverse.
 *
 * Two §14.5 commands are still deliberately absent, and the test says so, so
 * that "not built" stays distinguishable from "not noticed":
 * `materialize` (§14.4 step 6 runs on every revalidation, so there is nothing
 * for an operator to trigger yet) and `promotion-plan` (§37 Phase 8, superseded
 * in full by §0.0 — the system never writes to Sanity).
 *
 * Anything the dispatcher exposes that §14.5 does NOT name has to be declared in
 * `COMMANDS_BEYOND_PRD` with the §37 task it serves. That is the actual guard:
 * not a count, but the requirement that a new verb be justified in a named list
 * before it can be dispatched.
 */
describe('dispatch', () => {
  it('pins the §37 Phase 2 CLI checklist at exactly its ten commands', () => {
    /* Unchanged, and deliberately so: this is the PRD's phase scope. Widening it
     * would be a claim about the schedule, not about the CLI. */
    expect([...PHASE_2_CLI_COMMANDS].sort()).toEqual(
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

  it('dispatches every §37 Phase 2 command', () => {
    for (const command of PHASE_2_CLI_COMMANDS) expect(CLI_COMMANDS).toContain(command)
  })

  it('treats §14.5 as the specified surface, and §37 Phase 2 as a selection from it', () => {
    /* The relationship that makes `normalize` legitimate: the phase checklist is
     * a strict subset of the specified surface. */
    for (const command of PHASE_2_CLI_COMMANDS) expect(PRD_14_5_COMMANDS).toContain(command)
    expect(PRD_14_5_COMMANDS.length).toBeGreaterThan(PHASE_2_CLI_COMMANDS.length)
  })

  it('dispatches `normalize` because PRD §14.5 and §29.4 name it, not as a new verb', () => {
    expect(PRD_14_5_COMMANDS).toContain('normalize')
    expect(CLI_COMMANDS).toContain('normalize')
    /* And it is NOT one of the phase-checklist ten — that is the whole point. */
    expect(PHASE_2_CLI_COMMANDS as readonly string[]).not.toContain('normalize')
  })

  it('names the §14.5 commands it does not dispatch instead of silently omitting them', () => {
    const undispatched = PRD_14_5_COMMANDS.filter(
      (command) => !(CLI_COMMANDS as readonly string[]).includes(command),
    )
    expect([...undispatched].sort()).toEqual(['materialize', 'promotion-plan'])
  })

  it('requires every command outside §14.5 to be declared with the task it serves', () => {
    const undeclared = CLI_COMMANDS.filter(
      (command) =>
        !(PRD_14_5_COMMANDS as readonly string[]).includes(command) &&
        COMMANDS_BEYOND_PRD[command as keyof typeof COMMANDS_BEYOND_PRD] === undefined,
    )
    expect(undeclared).toEqual([])
  })

  it('declares exactly the two §37 Phase 2 store tasks the PRD gives no command name for', () => {
    /* "Local runtime history" and "Local cleanup" are Phase 2 Filesystem store
     * tasks. The PRD mandates the capability and never names a verb for it, so
     * these two ARE our deviation — a small one, and recorded here rather than
     * discovered later in a diff. */
    expect(Object.keys(COMMANDS_BEYOND_PRD).sort()).toEqual(['cleanup', 'history'])
    for (const rationale of Object.values(COMMANDS_BEYOND_PRD)) {
      expect(rationale).toMatch(/§37 Phase 2/)
    }
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
