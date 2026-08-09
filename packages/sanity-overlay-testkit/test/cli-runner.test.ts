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
import {spawnSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeAll, describe, expect, it} from 'vitest'
import {
  CLI_COMMANDS,
  CLI_OPTION_NAMES,
  COMMANDS_BEYOND_PRD,
  EXIT,
  PHASE_2_CLI_COMMANDS,
  PRD_14_5_COMMANDS,
  plural,
} from '../../sanity-overlay-cli/src/index'

/** The executable a user or a CI job actually runs. */
const CLI_BIN = fileURLToPath(
  new URL('../../sanity-overlay-cli/bin/sanity-overlay.mjs', import.meta.url),
)
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

  it('declares exactly the five mandated tasks the PRD gives no command name for', () => {
    /* "Local runtime history" and "Local cleanup" are Phase 2 Filesystem store
     * tasks. "Build and run client-import codemod" and "Add lint rule for
     * direct client imports and unregistered queries" are Phase 5 Frontend
     * migration tasks, and §22.5 requires CI to RUN both — "CI runs the codemod
     * in check mode and the lint rule in error mode". `ci` is the whole §37
     * Phase 6 CI block, which is ten mandated tasks and no verb for any of
     * them. A mandated CI gate needs an invocation, and §14.5 names none.
     *
     * All five ARE our deviation — a small one, and recorded here rather than
     * discovered later in a diff. The guard is not the count: it is that each
     * verb names the §37 task it exists to serve. */
    expect(Object.keys(COMMANDS_BEYOND_PRD).sort()).toEqual([
      'ci',
      'cleanup',
      'codemod',
      'history',
      'lint',
    ])
    for (const rationale of Object.values(COMMANDS_BEYOND_PRD)) {
      expect(rationale).toMatch(/§37 Phase \d/)
    }
    /* And the phase each one claims is the phase that actually names it. */
    expect(COMMANDS_BEYOND_PRD.history).toMatch(/§37 Phase 2/)
    expect(COMMANDS_BEYOND_PRD.cleanup).toMatch(/§37 Phase 2/)
    expect(COMMANDS_BEYOND_PRD.lint).toMatch(/§37 Phase 5/)
    expect(COMMANDS_BEYOND_PRD.codemod).toMatch(/§37 Phase 5/)
    expect(COMMANDS_BEYOND_PRD.ci).toMatch(/§37 Phase 6/)
    /* §22.5 is the requirement that makes a CI-runnable verb necessary at all. */
    expect(COMMANDS_BEYOND_PRD.lint).toMatch(/§22\.5/)
    expect(COMMANDS_BEYOND_PRD.codemod).toMatch(/§22\.5/)
  })

  /**
   * The list above was a one-way guard: it required every DISPATCHED command
   * outside §14.5 to appear in `COMMANDS_BEYOND_PRD`, and said nothing about an
   * entry that is declared and then never wired up, or one that duplicates a
   * §14.5 verb and so needs no justification at all. Both are ways for the
   * ledger to describe a CLI that does not exist, which is the failure mode the
   * ledger exists to prevent in the other direction.
   *
   * Closing it also makes the count above mean something: five entries, five
   * verbs the dispatcher really answers to, none of them already specified.
   */
  it('declares nothing it does not dispatch, and nothing §14.5 already names', () => {
    for (const command of Object.keys(COMMANDS_BEYOND_PRD)) {
      expect(CLI_COMMANDS as readonly string[], `${command}: declared but not dispatched`).toContain(
        command,
      )
      expect(
        PRD_14_5_COMMANDS as readonly string[],
        `${command}: §14.5 names it, so it needs no justification here`,
      ).not.toContain(command)
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

/**
 * ## THE ONE THING `runCliCapture` CANNOT SEE
 *
 * Every other case in this file calls `runCli` in process. That is the right
 * default — it is fast, it injects the streams, and it asserts on the exact
 * bytes a user gets. But it hands `runCli` an argv array directly, and so it
 * skips the step that actually happens in production: **Node parses the command
 * line first.**
 *
 * Node 22 claims some `--flag` names for itself even when they appear AFTER the
 * script path. `node bin/sanity-overlay.mjs ci --env-file preview` never
 * reaches `runCli` at all — Node treats `--env-file` as its own option, tries
 * to load `preview` as a dotenv file, and dies with
 * `node: preview: invalid format`. Verified on v22.22.2. The bin carries no
 * execute bit, so `node <path>` is the only way to run it, and `npx` / a
 * `node_modules/.bin` shim produce the same command line.
 *
 * The consequence was not cosmetic. `--env-file` was the ONLY way to reach the
 * `write-tokens` check — PRD §11.3 and invariant §34.15, "[MUST] CI scans
 * preview environment configuration for write-capable tokens" — so a mandated
 * gate was unreachable from any command line while every in-process test of it
 * passed.
 *
 * These cases spawn the real executable. The first is the class check: no
 * declared option name may be one Node swallows. The second is the end-to-end
 * proof that the check reached is the check that ran.
 */
describe('the declared flags survive a real command line', () => {
  /**
   * Independent oracle: a throwaway script that prints its own `process.argv`.
   * It knows nothing about this CLI, so a flag reaching it is proof about NODE,
   * not about our parser.
   */
  let probe: string

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-argv-probe-'))
    probe = join(dir, 'argv.mjs')
    await writeFile(probe, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
  })

  it.each([...CLI_OPTION_NAMES])('node passes --%s through to the script', (name) => {
    const run = spawnSync(process.execPath, [probe, `--${name}`, 'VALUE'], {encoding: 'utf8'})
    expect(
      run.status,
      `node refused --${name}: ${run.stderr.trim()}. Node claims this flag for itself, so the ` +
        `CLI can never receive it. Rename the option.`,
    ).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual([`--${name}`, 'VALUE'])
  })

  it('reaches the §11.3 write-token scan through the real binary', async () => {
    /* The end-to-end claim the in-process tests structurally cannot make. */
    const {root} = await createOverlayFixture({empty: true})
    await mkdir(join(root, 'preview'), {recursive: true})
    await writeFile(join(root, 'preview', '.env.preview'), 'SANITY_API_WRITE_TOKEN=x\n', 'utf8')

    const run = spawnSync(
      process.execPath,
      [CLI_BIN, 'ci', '--json', '--root', root, '--check', 'write-tokens', '--preview-env', 'preview'],
      {encoding: 'utf8', cwd: root},
    )

    expect(run.stderr).not.toMatch(/^node:/m)
    const report = JSON.parse(run.stdout)
    const check = report.checks.find((c: {check: string}) => c.check === 'write-tokens')
    /* It ran, it saw a file, and it found the token. A scan over zero files
     * would report `pass` with `files=0`, which is the failure this asserts
     * against. */
    expect(check.status).toBe('fail')
    expect(check.measured.files).toBeGreaterThan(0)
    expect(check.measured.writeCapable).toBeGreaterThan(0)
    expect(run.status).toBe(EXIT.FINDINGS)
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
