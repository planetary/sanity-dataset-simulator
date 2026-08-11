/**
 * The repository-level CI gates (`.github/scripts/repo-gates.mjs`), and the
 * proof that `.github/workflows/` actually invokes them.
 *
 * ## Why these gates exist as CODE and not as workflow shell
 *
 * A `run:` line is untestable. It executes once, on a runner, against one
 * repository state — the current one — and the only state it is ever observed
 * in is the passing one. Every gate below has a failure mode that has ALREADY
 * happened in this repository at least once, so "it passes today" is precisely
 * the evidence that is worthless: the question is whether it goes red on the
 * broken state, and a shell line can never be asked that question.
 *
 * So each gate is a pure function over injected inputs — a parsed vitest
 * report, a map of file bytes, a list of tracked paths — and every case here
 * hands it the broken state directly. The `.mjs` wrapper does nothing but read
 * the real inputs off disk and out of `git`, and print.
 *
 * ## The four gates, and the incident behind each
 *
 * 1. `auditSkips` — **a green that means "we did not run it"**.
 *    `test/hosted-parity.test.ts` is wrapped in `describe.skipIf(!cfg)`, and
 *    `cfg` is null whenever the gitignored repo-root `.env` is absent — which
 *    is every CI run. Measured against vitest 4.1.10: a fully skipped
 *    `describe` block reports `status: "skipped"` per test and
 *    `success: true` for the run. A CI run with no secrets is therefore
 *    byte-for-byte as green as one with them, and Gate D cites those cases as
 *    evidence. This gate reads the run's own JSON report and refuses that.
 *
 * 2. `checkPinnedEvidence` — **committed evidence must not move**.
 *    `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` is 730 lines of
 *    Spike F replay evidence. `.gitattributes` already says the count is
 *    asserted; nothing asserted it.
 *
 * 3. `auditOverlayTracking` — **`.runtime/` must never be committed**.
 *    PRD §14.3/§23/§38.1 require `.sanity-overlay/` to be TRACKED, and the
 *    store writes its own `.gitignore` for the runtime scratch inside it. Both
 *    halves have regressed: a blanket ignore of the whole directory (2026-08-04)
 *    and runtime artifacts reaching the index. The second is invisible to
 *    `git diff` and to `rg`, because those artifacts carry NUL bytes and git
 *    classifies them binary — so this gate is PATH-based and never opens a
 *    file it is judging.
 *
 * 4. `auditWorkflowSecrets` — **fork pull requests must not be configured with
 *    secrets**. PRD §11.5 and §26.9: "[MUST] CI identifies fork pull requests
 *    and verifies that draft read tokens, Blob credentials, overlay secrets,
 *    and promotion credentials are absent."
 */
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {
  OVERLAY_GITIGNORE,
  OVERLAY_RUNTIME_PATTERNS,
  PINNED_EVIDENCE,
  auditOverlayTracking,
  auditSkips,
  auditWorkflowSecrets,
  checkPinnedEvidence,
  isGitIgnored,
  workflowJobIds,
  workflowRunLines,
} from '../../../.github/scripts/repo-gates.mjs'
/* `src/layout` rather than the barrel: this needs one constant, and going
 * through `src/index` would drag in FsOverlayStore and make an unrelated edit
 * anywhere in that file able to take this gate's suite down. */
import {GITIGNORE_CONTENT} from '../../sanity-overlay-store-fs/src/layout'
import {CI_CHECKS, PHASE_6_CI_DISCHARGE, PHASE_6_CI_TASKS} from '../../sanity-overlay-cli/src/ci/checks'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const kinds = (result: {violations: ReadonlyArray<{kind: string}>}): string[] =>
  result.violations.map((v) => v.kind).sort()

/* ══════════════════════════════════════════════════════ gate 1: skips ══ */

/**
 * A minimal vitest JSON report. The shape is not invented: it was captured from
 * `vitest run --reporter=json` on 4.1.10 against a probe file containing a
 * `describe.skipIf(true)` block, an `it.skip` and an `it.todo`, and the statuses
 * below (`passed` / `skipped` / `todo`) are the three it actually emits.
 */
const report = (
  files: Record<string, ReadonlyArray<['passed' | 'skipped' | 'todo' | 'failed', string]>>,
) => ({
  success: true,
  testResults: Object.entries(files).map(([name, tests]) => ({
    name: `${REPO_ROOT}packages/sanity-overlay-testkit/${name}`,
    status: 'passed',
    assertionResults: tests.map(([status, fullName]) => ({status, fullName})),
  })),
})

describe('gate 1 — the suite must not silently skip', () => {
  it('passes a run in which everything required ran and nothing was skipped', () => {
    const result = auditSkips({
      report: report({'test/a.test.ts': [['passed', 'x']], 'test/b.test.ts': [['passed', 'y']]}),
      required: ['test/a.test.ts'],
    })
    expect(kinds(result)).toEqual([])
    expect(result.ok).toBe(true)
    /* A gate that reports nothing over nothing is not a gate. */
    expect(result.measured).toMatchObject({files: 2, tests: 2, passed: 2, skipped: 0})
  })

  it('fails the exact hosted-parity shape: a whole leg skipped, run still green', () => {
    /* This IS the incident. `success: true`, no failures, and twelve parity
     * cases that never executed. */
    const result = auditSkips({
      report: report({
        'test/hosted-parity.test.ts': [
          ['skipped', 'hosted empty-overlay parity ID lookup'],
          ['skipped', 'hosted empty-overlay parity slug lookup'],
        ],
        'test/cli-runner.test.ts': [['passed', 'exit codes']],
      }),
    })
    expect(result.ok).toBe(false)
    expect(kinds(result)).toEqual(['unexpected-skip'])
    expect(result.violations[0].ref).toContain('hosted-parity')
    /* It has to NAME what did not run, or the operator learns nothing. */
    expect(result.violations[0].message).toContain('hosted empty-overlay parity ID lookup')
  })

  it('lets a run declare, in configuration, exactly which leg is inert', () => {
    const result = auditSkips({
      report: report({
        'test/hosted-parity.test.ts': [['skipped', 'ID lookup']],
        'test/cli-runner.test.ts': [['passed', 'exit codes']],
      }),
      allowSkip: ['test/hosted-parity.test.ts'],
    })
    expect(result.ok).toBe(true)
    /* Declared is not the same as unnoticed: it is still reported. */
    expect(result.declared).toEqual([
      {file: 'packages/sanity-overlay-testkit/test/hosted-parity.test.ts', skipped: 1},
    ])
  })

  it('refuses an allowance for a leg that DID run — the flag must be removed', () => {
    /* Self-cleaning in both directions, the discipline every pinned list in
     * this repo already follows. Otherwise the credentialed CI leg keeps the
     * flag it inherited from the credential-less one and silently stops
     * enforcing anything. */
    const result = auditSkips({
      report: report({'test/hosted-parity.test.ts': [['passed', 'ID lookup']]}),
      allowSkip: ['test/hosted-parity.test.ts'],
    })
    expect(result.ok).toBe(false)
    expect(kinds(result)).toEqual(['stale-allowance'])
  })

  it('refuses an allowance that names no file in the run at all', () => {
    /* A renamed or deleted suite must not leave a live allowance behind. */
    const result = auditSkips({
      report: report({'test/cli-runner.test.ts': [['passed', 'x']]}),
      allowSkip: ['test/hosted-parity.test.ts'],
    })
    expect(kinds(result)).toEqual(['stale-allowance'])
  })

  it('fails when a required suite is missing from the run', () => {
    const result = auditSkips({
      report: report({'test/cli-runner.test.ts': [['passed', 'x']]}),
      required: ['test/no-staging-writes.test.ts'],
    })
    expect(kinds(result)).toEqual(['required-missing'])
  })

  it('fails when a required suite ran but every case in it was skipped', () => {
    const result = auditSkips({
      report: report({'test/no-staging-writes.test.ts': [['skipped', 'refuses a POST']]}),
      required: ['test/no-staging-writes.test.ts'],
    })
    expect(kinds(result)).toEqual(['required-empty', 'required-skipped'])
  })

  it('fails when a required suite was emptied out rather than deleted', () => {
    /* Deleting the file is `required-missing`. Emptying it is the quieter
     * version of the same act and has to be the same colour. */
    const result = auditSkips({
      report: report({'test/no-staging-writes.test.ts': []}),
      required: ['test/no-staging-writes.test.ts'],
    })
    expect(kinds(result)).toEqual(['required-empty'])
  })

  it('refuses to let a suite be both required and allowed to skip', () => {
    const result = auditSkips({
      report: report({'test/no-staging-writes.test.ts': [['passed', 'x']]}),
      required: ['test/no-staging-writes.test.ts'],
      allowSkip: ['test/no-staging-writes.test.ts'],
    })
    expect(kinds(result)).toContain('contradictory-configuration')
    expect(result.ok).toBe(false)
  })

  it('refuses an empty report rather than passing it', () => {
    /* The wrong `--outputFile`, a runner that died before writing, a filter
     * that matched nothing: all of them produce a report with no files, and
     * all of them must be red rather than "no skips found". */
    expect(auditSkips({report: report({})}).violations.map((v) => v.kind)).toEqual(['empty-report'])
  })

  it('counts todo as a skip — an unwritten test is a test that did not run', () => {
    const result = auditSkips({report: report({'test/a.test.ts': [['todo', 'later']]})})
    expect(kinds(result)).toEqual(['unexpected-skip'])
  })
})

/* ══════════════════════════════════════════ gate 2: pinned evidence ══ */

const jsonl = (n: number): Buffer =>
  Buffer.from(Array.from({length: n}, (_, i) => JSON.stringify({i})).join('\n') + '\n')

describe('gate 2 — pinned evidence must not move', () => {
  const pins = [{path: 'evidence.jsonl', lines: 730, format: 'jsonl' as const, why: 'Spike F'}]

  it('passes the exact pinned shape', () => {
    const result = checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', jsonl(730)]])})
    expect(kinds(result)).toEqual([])
    expect(result.measured).toMatchObject({pins: 1, lines: 730})
  })

  it('fails when a line is added', () => {
    const result = checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', jsonl(731)]])})
    expect(kinds(result)).toEqual(['line-count'])
    expect(result.violations[0].message).toContain('731')
    expect(result.violations[0].message).toContain('730')
  })

  it('fails when a line is removed', () => {
    expect(
      kinds(checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', jsonl(729)]])})),
    ).toEqual(['line-count'])
  })

  it('fails when the file is gone', () => {
    expect(kinds(checkPinnedEvidence({pins, files: new Map()}))).toEqual(['missing'])
  })

  it('fails on CRLF, which .gitattributes exists to prevent', () => {
    /* The replay harness splits on '\n'; a CRLF checkout keeps the line count
     * identical and corrupts every record. A count-only check would pass it. */
    const crlf = Buffer.from(jsonl(730).toString('utf8').replaceAll('\n', '\r\n'))
    expect(kinds(checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', crlf]])}))).toContain(
      'crlf',
    )
  })

  it('fails on a NUL byte, which would make the evidence unreviewable', () => {
    const withNul = Buffer.concat([Buffer.from('\0'), jsonl(730)])
    expect(kinds(checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', withNul]])}))).toContain(
      'nul-byte',
    )
  })

  it('fails when a line stops being JSON, at the same line count', () => {
    /* Corruption that preserves the count is exactly what a line-count gate
     * alone would wave through. */
    const corrupt = Buffer.from(jsonl(730).toString('utf8').replace('{"i":5}', 'not json'))
    const result = checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', corrupt]])})
    expect(kinds(result)).toEqual(['invalid-jsonl'])
    expect(result.violations[0].message).toContain('line 6')
  })

  it('fails when the trailing newline is dropped', () => {
    const noEol = Buffer.from(jsonl(730).toString('utf8').trimEnd())
    expect(kinds(checkPinnedEvidence({pins, files: new Map([['evidence.jsonl', noEol]])}))).toContain(
      'no-trailing-newline',
    )
  })

  it('refuses an empty pin table rather than passing it', () => {
    expect(kinds(checkPinnedEvidence({pins: [], files: new Map()}))).toEqual(['no-pins'])
  })

  it('pins the real file, and the real file is what the table says', () => {
    /* The end-to-end claim, against the committed bytes rather than a fixture.
     * `wc -l` is the independent oracle: it counts newline bytes and knows
     * nothing about this module. */
    const pin = PINNED_EVIDENCE.find((p) =>
      p.path.endsWith('examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl'),
    )
    expect(pin, 'proxy-log.jsonl must be in the pin table').toBeDefined()
    expect(pin!.lines).toBe(730)

    const wc = execFileSync('/usr/bin/wc', ['-l', pin!.path], {cwd: REPO_ROOT, encoding: 'utf8'})
    expect(Number.parseInt(wc.trim(), 10)).toBe(730)

    const files = new Map([[pin!.path, readFileSync(join(REPO_ROOT, pin!.path))]])
    expect(kinds(checkPinnedEvidence({pins: [pin!], files}))).toEqual([])
  })
})

/* ═══════════════════════════════════════ gate 3: .sanity-overlay/ ══ */

const OVERLAY = 'examples/kitchen-sink/.sanity-overlay'

const overlayInputs = (extra: string[] = []) => ({
  tracked: [
    `${OVERLAY}/.gitignore`,
    `${OVERLAY}/manifest.json`,
    `${OVERLAY}/checksums.json`,
    `${OVERLAY}/documents/article-01/intent.json`,
    'README.md',
    ...extra,
  ],
  onDisk: [OVERLAY],
  read: (path: string) => (path === `${OVERLAY}/.gitignore` ? OVERLAY_GITIGNORE : undefined),
  isIgnored: () => false,
})

describe('gate 3 — .sanity-overlay/ is tracked and .runtime/ is not', () => {
  it('passes the layout PRD §14.3/§23/§38.1 require', () => {
    const result = auditOverlayTracking(overlayInputs())
    expect(kinds(result)).toEqual([])
    expect(result.measured).toMatchObject({roots: 1, tracked: 4})
  })

  it.each([
    ['.runtime/transactions/000001.json'],
    ['.locks/manifest.lock'],
    ['.history/manifest.7.json'],
    ['documents/article-01/intent.json.broken'],
    ['.tmp-manifest-8821'],
  ])('fails when %s reaches the index', (artifact) => {
    /* The whole ignored family, not just the one instance that happened. Each
     * pattern in the store's own .gitignore gets a case. */
    const result = auditOverlayTracking(overlayInputs([`${OVERLAY}/${artifact}`]))
    expect(kinds(result)).toEqual(['runtime-artifact-tracked'])
    expect(result.violations[0].ref).toBe(`${OVERLAY}/${artifact}`)
  })

  it('sees a NUL-carrying runtime artifact, because it never opens the file', () => {
    /* The reason this gate is path-based. A NUL makes the blob binary to git,
     * so `git diff` prints nothing and `rg` skips it — which is how this got
     * committed twice. `read` throws here to prove the gate never calls it on
     * the artifact. */
    const inputs = overlayInputs([`${OVERLAY}/.runtime/materialized/article-01.json`])
    const result = auditOverlayTracking({
      ...inputs,
      read: (path: string) => {
        if (path.includes('.runtime/')) throw new Error('gate must not read runtime artifacts')
        return inputs.read(path)
      },
    })
    expect(kinds(result)).toEqual(['runtime-artifact-tracked'])
  })

  it('fails when the overlay is not tracked at all — the 2026-08-04 regression', () => {
    /* A blanket `.sanity-overlay/` line in the root .gitignore. The directory
     * is on disk, so the gate finds the root; nothing under it is in the index. */
    const result = auditOverlayTracking({
      tracked: ['README.md'],
      onDisk: [OVERLAY],
      read: () => undefined,
      isIgnored: () => true,
    })
    expect(kinds(result)).toEqual([
      'gitignore-not-tracked',
      'manifest-not-tracked',
      'overlay-ignored',
    ])
  })

  it('fails when the store-written .gitignore drifts from the store', () => {
    const inputs = overlayInputs()
    const result = auditOverlayTracking({
      ...inputs,
      read: () => '.runtime/\n' /* .locks/, .history/, *.broken, .tmp-* dropped */,
    })
    expect(kinds(result)).toEqual(['gitignore-drifted'])
  })

  it('refuses a repository in which it found no overlay to judge', () => {
    /* The directory renamed, the example deleted, the glob wrong: the gate has
     * to say it inspected nothing rather than report a clean bill of health. */
    expect(
      kinds(auditOverlayTracking({tracked: ['README.md'], onDisk: [], read: () => undefined, isIgnored: () => false})),
    ).toEqual(['no-overlay-found'])
  })

  it('judges every overlay in the repository, not just the first', () => {
    const second = 'e2e/fixtures/.sanity-overlay'
    const inputs = overlayInputs()
    const result = auditOverlayTracking({
      ...inputs,
      tracked: [...inputs.tracked, `${second}/.runtime/x.json`],
      onDisk: [OVERLAY, second],
    })
    expect(kinds(result)).toEqual([
      'gitignore-not-tracked',
      'manifest-not-tracked',
      'runtime-artifact-tracked',
    ])
  })

  it('takes its pattern list from the store, not from a second copy of it', () => {
    /* If FsOverlayStore learns to ignore another directory, this gate must
     * learn it in the same commit. `GITIGNORE_CONTENT` is the store's own
     * export. */
    expect(OVERLAY_GITIGNORE).toBe(GITIGNORE_CONTENT)
    expect(OVERLAY_RUNTIME_PATTERNS).toEqual(
      GITIGNORE_CONTENT.split('\n').filter((line) => line.trim().length > 0),
    )
  })

  /**
   * REGRESSION. `auditOverlayTracking` takes `isIgnored` as an argument, so
   * every case above proves what the gate does with the ANSWER and nothing at
   * all about whether the wrapper asks the right QUESTION. It did not.
   *
   * `git check-ignore` reports nothing for a path already in the index, on the
   * reasoning that a tracked file is unaffected by ignore rules. True of the
   * file, irrelevant to the damage: the 2026-08-04 blanket `.sanity-overlay/`
   * line did not untrack what was already committed, it stopped everything NEW
   * from ever being added. So the gate was inert against the exact incident it
   * was written for, and every unit test above was green — caught only by
   * watching the wrapper fail to go red on a deliberately broken clone.
   *
   * `--no-index` is the fix, and this asserts it against a real git repository
   * built here rather than against a mock, because a mock of git would have
   * been mocked with the wrong behaviour too.
   */
  it('asks git whether a rule MATCHES, not whether an untracked file is hidden', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-ignore-oracle-'))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'})
    git('init', '-q')
    git('config', 'user.email', 'gate@example.test')
    git('config', 'user.name', 'gate')
    mkdirSync(join(dir, '.sanity-overlay'), {recursive: true})
    writeFileSync(join(dir, '.sanity-overlay', 'manifest.json'), '{}\n')
    git('add', '-A')
    git('commit', '-qm', 'tracked overlay')

    /* Tracked AND now ignored — the shape of the incident. */
    expect(isGitIgnored('.sanity-overlay/manifest.json', dir)).toBe(false)
    writeFileSync(join(dir, '.gitignore'), '.sanity-overlay/\n')
    expect(isGitIgnored('.sanity-overlay/manifest.json', dir)).toBe(true)
  })

  it('the real repository passes', () => {
    /* Against `git ls-files`, the same oracle the wrapper uses. */
    const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: REPO_ROOT, encoding: 'utf8'})
      .split('\0')
      .filter((p) => p.length > 0)
    const onDisk = [...new Set(tracked.filter((p) => p.includes('/.sanity-overlay/')).map((p) => p.slice(0, p.indexOf('/.sanity-overlay/') + '/.sanity-overlay'.length)))]
    const result = auditOverlayTracking({
      tracked,
      onDisk,
      read: (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8'),
      isIgnored: () => false,
    })
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([])
    expect(result.measured.roots).toBeGreaterThan(0)
  })
})

/* ═════════════════════════════ gate 4: fork pull requests and secrets ══ */

describe('gate 4 — a fork pull request must not be configured with secrets', () => {
  it('passes a pull_request workflow that uses no secret', () => {
    const result = auditWorkflowSecrets({
      workflows: new Map([['ci.yml', 'on:\n  push:\n  pull_request:\njobs:\n  test:\n    steps: []\n']]),
    })
    expect(kinds(result)).toEqual([])
    expect(result.measured).toMatchObject({workflows: 1})
  })

  it('fails when a pull_request-triggered workflow reads a repository secret', () => {
    /* PRD §11.5: draft read tokens, Blob credentials, overlay secrets and
     * promotion credentials must be absent on a fork PR. The only way to
     * guarantee that from inside the repository is not to configure them. */
    const result = auditWorkflowSecrets({
      workflows: new Map([
        [
          'ci.yml',
          'on:\n  pull_request:\njobs:\n  test:\n    env:\n      SANITY_API_READ_TOKEN: ${{ secrets.SANITY_API_READ_TOKEN }}\n',
        ],
      ]),
    })
    expect(kinds(result)).toEqual(['secret-on-pull-request'])
    expect(result.violations[0].message).toContain('SANITY_API_READ_TOKEN')
  })

  it('allows GITHUB_TOKEN, which is read-only on a fork by construction', () => {
    const result = auditWorkflowSecrets({
      workflows: new Map([
        ['ci.yml', 'on:\n  pull_request:\njobs:\n  t:\n    env:\n      GH: ${{ secrets.GITHUB_TOKEN }}\n'],
      ]),
    })
    expect(kinds(result)).toEqual([])
  })

  it('permits a secret in a workflow no pull request can trigger', () => {
    const result = auditWorkflowSecrets({
      workflows: new Map([
        ['drift.yml', 'on:\n  schedule:\n    - cron: "0 */6 * * *"\njobs:\n  s:\n    env:\n      T: ${{ secrets.X }}\n'],
      ]),
    })
    expect(kinds(result)).toEqual([])
  })

  it('refuses pull_request_target outright', () => {
    /* It runs with the base repository's full secret context against fork-authored
     * code. There is no configuration of it this repository needs. */
    const result = auditWorkflowSecrets({
      workflows: new Map([['bad.yml', 'on:\n  pull_request_target:\njobs:\n  t:\n    steps: []\n']]),
    })
    expect(kinds(result)).toEqual(['pull-request-target-trigger'])
  })

  it('does not read a workflow\'s own prose as the offence it describes', () => {
    /* These workflows document what they refuse, so both forbidden shapes
     * appear in comments explaining why they are not used. Full-line comments
     * are stripped before anything is judged. */
    const result = auditWorkflowSecrets({
      workflows: new Map([
        [
          'ci.yml',
          [
            '# Do not add ${{ secrets.SANITY_API_WRITE_TOKEN }} here, and never',
            '# use pull_request_target: it runs fork code with full secrets.',
            'on:',
            '  pull_request:',
            'jobs:',
            '  t:',
            '    steps: []',
            '',
          ].join('\n'),
        ],
      ]),
    })
    expect(kinds(result)).toEqual([])
  })

  it('still reports a trailing-comment secret, erring toward over-reporting', () => {
    /* The stated direction of the imprecision: a false positive costs one edit,
     * a false negative costs the guarantee. */
    const result = auditWorkflowSecrets({
      workflows: new Map([
        ['ci.yml', 'on:\n  pull_request:\njobs:\n  t:\n    steps: []  # ${{ secrets.X }}\n'],
      ]),
    })
    expect(kinds(result)).toEqual(['secret-on-pull-request'])
  })

  it('refuses to report on a repository with no workflows', () => {
    expect(kinds(auditWorkflowSecrets({workflows: new Map()}))).toEqual(['no-workflows'])
  })
})

/* ══════════════════════════════ the workflows actually invoke all this ══ */

/*
 * Read from the DIRECTORY, not from `git ls-files`.
 *
 * A workflow only takes effect once committed, so the index is the tempting
 * oracle — but it means a newly added workflow is invisible to this gate until
 * after the commit that adds it, which is exactly the wrong way round: the
 * assertions below are what should stop a workflow being committed with a
 * secret on a fork-reachable trigger. In CI the worktree and the index agree
 * anyway, because the runner checked the commit out.
 */
const workflowFiles = (): Map<string, string> => {
  const dir = join(REPO_ROOT, '.github/workflows')
  const names = readdirSync(dir).filter((p) => p.endsWith('.yml') || p.endsWith('.yaml'))
  return new Map(names.map((p) => [`.github/workflows/${p}`, readFileSync(join(dir, p), 'utf8')]))
}

describe('the checks are wired into a workflow, so they are gates and not modules', () => {
  const workflows = workflowFiles()
  const runLines = [...workflows.values()].flatMap((text) => workflowRunLines(text))
  const jobIds = new Set([...workflows.values()].flatMap((text) => workflowJobIds(text)))

  it('found the workflows at all', () => {
    expect(workflows.size).toBeGreaterThan(0)
    expect(runLines.length).toBeGreaterThan(0)
    expect(jobIds.size).toBeGreaterThan(0)
  })

  it.each(['skips', 'pinned-evidence', 'overlay-tracking', 'workflow-secrets'])(
    'a workflow step runs the %s gate',
    (gate) => {
      expect(runLines.some((line) => line.includes(`repo-gates.mjs ${gate}`))).toBe(true)
    },
  )

  /**
   * REGRESSION. The wrapper writes a GitHub job summary, because the log
   * scrolls and the summary does not — and a DECLARED skip that nobody reads is
   * the same as an undeclared one.
   *
   * That writer was `require('node:fs').appendFileSync(...)` inside an ES
   * module. `require` is not defined there, so the call threw on every single
   * invocation and the surrounding catch — correctly present, so a summary that
   * cannot be written does not fail the gate — swallowed it. Every gate stayed
   * green and the summary was never written once.
   *
   * The class is "a side effect wrapped in a catch, never observed". This runs
   * the real script as a real process with GITHUB_STEP_SUMMARY set and reads
   * the file back.
   */
  it('writes the GitHub job summary it claims to write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-summary-'))
    const file = join(dir, 'summary.md')
    writeFileSync(file, '')

    const run = spawnSync(process.execPath, ['.github/scripts/repo-gates.mjs', 'pinned-evidence'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {...process.env, GITHUB_STEP_SUMMARY: file},
    })

    expect(run.status, run.stderr).toBe(0)
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('pinned-evidence: PASS')
    /* The denominator, not just the verdict: a summary that omits what was
     * measured is the same reading problem one level up. */
    expect(written).toContain('lines=730')
  })

  it('the real repository passes gate 4', () => {
    const result = auditWorkflowSecrets({workflows})
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([])
  })

  /**
   * `PHASE_6_CI_DISCHARGE` states, per §37 Phase 6 line, the workflow job that
   * discharges it. Until this test existed, every one of those job names was a
   * string in a comment: `overlay-gates`, `query-parity`, `conflict-report` and
   * `base-drift-scan` were all named and NONE of them existed in
   * `.github/workflows/`. The table read as evidence of a wired-up gate and was
   * evidence of nothing.
   */
  it('every §37 Phase 6 task names a job that exists', () => {
    for (const task of PHASE_6_CI_TASKS) {
      const {job} = PHASE_6_CI_DISCHARGE[task]
      expect([...jobIds], `${task} claims job "${job}"`).toContain(job)
    }
  })

  it('every check `sanity-overlay ci` can run is invoked or explicitly allowed to skip', () => {
    /* A check added to CI_CHECKS that no job selects is a check nothing runs.
     * Selection is `--check`; a declared no-op is `--allow-skip`; both count,
     * because "we chose not to run it here" is a decision and "nobody noticed"
     * is not. */
    const invoked = runLines.filter((line) => line.includes('sanity-overlay.mjs ci')).join(' ')
    expect(invoked.length, 'no workflow step runs `sanity-overlay ci`').toBeGreaterThan(0)
    for (const check of CI_CHECKS) {
      expect(invoked, `no job runs or declares the ${check} check`).toContain(check)
    }
  })

  it('the base drift scan is scheduled at the PRD §16.6 cadence', () => {
    /* §16.6 default: every 6 hours. The discharge table calls the schedule
     * "configuration only"; this is the assertion that the configuration
     * exists and says what the table claims it says. */
    const drift = [...workflows.entries()].find(([name]) => name.includes('base-drift'))
    expect(drift, '.github/workflows/base-drift-scan.yml').toBeDefined()
    expect(drift![1]).toMatch(/cron:\s*['"]0 \*\/6 \* \* \*['"]/)
    /* Owner decision 2026-08-11: the schedule is DEFERRED until CI is triaged
     * and re-enabled. The §16.6 cadence must stay recorded (the assertion
     * above — a commented line satisfies it), but no ACTIVE `schedule:`
     * trigger may exist. Re-enabling the cron is done by deleting this
     * assertion together with uncommenting the workflow — a deliberate pair,
     * never a drive-by. */
    expect(drift![1]).not.toMatch(/^\s{2}schedule:/m)
  })
})
