/**
 * `sanity-overlay ci` — the PRD §37 Phase 6 "CI" checklist, made runnable.
 *
 * The checklist names ten checks. This file pins three separate things, because
 * conflating them is how a CI gate becomes decoration:
 *
 * 1. **The inventory.** `PHASE_6_CI_TASKS` is the checklist verbatim, and every
 *    entry declares HOW it is discharged — a `ci` check, a workflow job, or
 *    configuration only. A task with no discharge entry is a task nobody built.
 * 2. **The checks themselves**, each run against a REAL overlay written by the
 *    real store (`createOverlayFixture` drives core's mutation engine), with a
 *    damage case that proves the check can go red.
 * 3. **Non-vacuity.** Every check reports `measured` counts. A gate that reports
 *    "0 findings" over 0 documents, 0 files or 0 environment names is worse than
 *    no gate, so the pass cases assert the counts are non-zero and the report
 *    carries them into the output a human reads.
 *
 * Skips are loud on purpose: a check that cannot run (no `--base` in fs mode, no
 * schema artifact) exits non-zero unless the invocation explicitly named it in
 * `--allow-skip`. That forces the workflow to declare, in configuration, exactly
 * which checks are inert and why.
 */
import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  CI_CHECKS,
  PHASE_6_CI_DISCHARGE,
  PHASE_6_CI_TASKS,
} from '../../sanity-overlay-cli/src/ci/checks'
import {
  FIXTURE_BASE_DOCUMENTS,
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

/** The §20.1 serialized schema artifact the fixture's two article types satisfy. */
const SCHEMA_ARTIFACT = {
  schemaCommit: 'schema-sha-0001',
  types: [
    {
      name: 'article',
      fields: [
        {name: 'title', type: 'string'},
        {name: 'slug', type: 'slug'},
        {name: 'author', type: 'reference', to: ['author']},
        {name: 'body', type: 'array', of: [{type: 'block'}]},
      ],
    },
    {name: 'author', fields: [{name: 'name', type: 'string'}]},
    {name: 'page', fields: [{name: 'title', type: 'string'}]},
  ],
}

async function writeJson(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

async function writeFileAt(root: string, name: string, text: string): Promise<string> {
  const path = join(root, name)
  await mkdir(join(path, '..'), {recursive: true})
  await writeFile(path, text, 'utf8')
  return path
}

interface CiJson {
  ok: boolean
  overlayId: string | null
  checks: {
    check: string
    task: string
    status: 'pass' | 'fail' | 'skip'
    skipReason?: string
    findings: {severity: string; message: string; ref?: string}[]
    measured: Record<string, number>
  }[]
  failed: string[]
  skipped: string[]
}

function checkOf(report: CiJson, id: string): CiJson['checks'][number] {
  const found = report.checks.find((entry) => entry.check === id)
  if (found === undefined) throw new Error(`no check ${id} in report: ${report.checks.map((c) => c.check).join(', ')}`)
  return found
}

async function runCi(root: string, argv: readonly string[]): Promise<{code: number; report: CiJson; stdout: string}> {
  const run = await runCliCapture(['ci', '--json', ...argv], {cwd: root})
  let report: CiJson
  try {
    report = JSON.parse(run.stdout) as CiJson
  } catch {
    throw new Error(`ci --json did not emit JSON.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  }
  return {code: run.code, report, stdout: run.stdout}
}

/* ------------------------------------------------------------------ *
 * 1. The §37 Phase 6 inventory
 * ------------------------------------------------------------------ */

describe('the PRD §37 Phase 6 CI checklist is an inventory, not a slogan', () => {
  it('carries the ten checklist lines verbatim and in order', () => {
    expect([...PHASE_6_CI_TASKS]).toEqual([
      'Validate overlay file schemas.',
      'Validate branch schema.',
      'Validate strong references.',
      'Run query parity tests.',
      'Check unsupported plugins.',
      'Check no write tokens in preview configuration.',
      'Check checkpoint status policy.',
      'Report conflict summary on PR.',
      'Schedule recurring base drift scan for open overlays.',
      'Refresh PR status when drift changes conflicts.',
    ])
  })

  it('declares how every task is discharged, and names the job that runs it', () => {
    for (const task of PHASE_6_CI_TASKS) {
      const discharge = PHASE_6_CI_DISCHARGE[task]
      expect(discharge, `no discharge declared for ${JSON.stringify(task)}`).toBeDefined()
      expect(['ci-check', 'workflow-job', 'configuration']).toContain(discharge.kind)
      expect(discharge.job.length).toBeGreaterThan(0)
      /* The note is where "configuration only" has to be said out loud. */
      expect(discharge.note.length).toBeGreaterThan(20)
    }
  })

  it('points every `ci-check` discharge at a check the command actually runs', () => {
    for (const task of PHASE_6_CI_TASKS) {
      const discharge = PHASE_6_CI_DISCHARGE[task]
      if (discharge.kind !== 'ci-check') continue
      expect(discharge.check).toBeDefined()
      expect(CI_CHECKS as readonly string[]).toContain(discharge.check)
    }
  })

  it('leaves no `ci` check unattached to a checklist line', () => {
    const claimed = new Set(
      PHASE_6_CI_TASKS.map((task) => PHASE_6_CI_DISCHARGE[task].check).filter(
        (check): check is (typeof CI_CHECKS)[number] => check !== undefined,
      ),
    )
    expect([...CI_CHECKS].filter((check) => !claimed.has(check))).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 2. overlay file schemas — "Validate overlay file schemas."
 * ------------------------------------------------------------------ */

describe('overlay-schemas', () => {
  it('passes on an intact overlay and reports what it measured', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'overlay-schemas'])
    expect(code).toBe(EXIT.OK)

    const check = checkOf(report, 'overlay-schemas')
    expect(check.status).toBe('pass')
    expect(check.findings.filter((f) => f.severity === 'error')).toEqual([])
    /* The one §34.3 sub-check no store-written manifest can satisfy — head
     * checksum is over the §13.3 RECORD, the synthetic `_rev` is over the
     * materialized DOCUMENT — is reported as a warning rather than dropped, so
     * a REAL §34.3 breach is still visible in the same list. */
    expect(check.findings.some((f) => f.severity === 'warning' && f.message.startsWith('§34.3'))).toBe(
      true,
    )
    /* Non-vacuity: the gate saw real documents, ran real invariants, and
     * recomputed real checksums. */
    expect(check.measured.documents).toBeGreaterThan(0)
    expect(check.measured.invariants).toBeGreaterThanOrEqual(12)
    expect(check.measured.checksums).toBeGreaterThan(0)
  })

  it('prints the measured counts in the human output too', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['ci', '--check', 'overlay-schemas'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('overlay-schemas')
    expect(run.stdout).toMatch(/documents=\d+/)
    expect(run.stdout).toMatch(/invariants=\d+/)
  })

  it('fails when a canonical intent file is corrupted behind the store', async () => {
    const {root} = await createOverlayFixture()
    await writeFile(
      join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
      '{ not json',
      'utf8',
    )
    const {code, report} = await runCi(root, ['--check', 'overlay-schemas'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'overlay-schemas')
    expect(check.status).toBe('fail')
    expect(check.findings.length).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 3. branch schema — "Validate branch schema."
 * ------------------------------------------------------------------ */

describe('branch-schema', () => {
  it('skips loudly, and fails the run, when no --schema artifact is given', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'branch-schema'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'branch-schema')
    expect(check.status).toBe('skip')
    expect(check.skipReason).toMatch(/--schema/)
    expect(report.skipped).toContain('branch-schema')
  })

  it('exits OK when the skip is explicitly allowed, and still says it skipped', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(
      ['ci', '--check', 'branch-schema', '--allow-skip', 'branch-schema'],
      {cwd: root},
    )
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('skip')
    expect(run.stdout).toMatch(/--schema/)
  })

  it('validates every document type against the artifact', async () => {
    const {root} = await createOverlayFixture({
      source: {
        repositoryId: 'github:planetary/cli',
        branch: 'feature/cli',
        schemaCommitSha: SCHEMA_ARTIFACT.schemaCommit,
      },
    })
    const schema = await writeJson(root, 'schema.json', SCHEMA_ARTIFACT)
    const {code, report} = await runCi(root, ['--check', 'branch-schema', '--schema', schema])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'branch-schema')
    expect(check.status).toBe('pass')
    expect(check.measured.documents).toBeGreaterThan(0)
    expect(check.measured.schemaTypes).toBe(SCHEMA_ARTIFACT.types.length)
  })

  it('fails on a document whose type the branch schema does not declare', async () => {
    const {root} = await createOverlayFixture({
      source: {
        repositoryId: 'github:planetary/cli',
        branch: 'feature/cli',
        schemaCommitSha: SCHEMA_ARTIFACT.schemaCommit,
      },
    })
    const schema = await writeJson(root, 'schema.json', {
      ...SCHEMA_ARTIFACT,
      types: SCHEMA_ARTIFACT.types.filter((type) => type.name !== 'article'),
    })
    const {code, report} = await runCi(root, ['--check', 'branch-schema', '--schema', schema])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'branch-schema')
    expect(check.status).toBe('fail')
    expect(check.findings.some((f) => f.message.includes('article'))).toBe(true)
  })

  it('fails when the manifest carries no §20.1 schema commit SHA to compare', async () => {
    const {root} = await createOverlayFixture()
    const schema = await writeJson(root, 'schema.json', SCHEMA_ARTIFACT)
    const {code, report} = await runCi(root, ['--check', 'branch-schema', '--schema', schema])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'branch-schema')
    expect(check.findings.some((f) => /schemaCommit/i.test(f.message))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 4. strong references — "Validate strong references."
 * ------------------------------------------------------------------ */

describe('strong-references', () => {
  it('skips without --base, because fs mode has no base connection', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'strong-references'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'strong-references')
    expect(check.status).toBe('skip')
    expect(check.skipReason).toMatch(/--base/)
  })

  it('passes when every strong reference resolves to a published target', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeJson(root, 'base.json', FIXTURE_BASE_DOCUMENTS)
    const {code, report} = await runCi(root, ['--check', 'strong-references', '--base', base])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'strong-references')
    expect(check.status).toBe('pass')
    /* Non-vacuity: it actually walked references, not an empty document set. */
    expect(check.measured.documents).toBeGreaterThan(0)
    expect(check.measured.references).toBeGreaterThan(0)
  })

  it('fails when a strong reference targets a document with no published version', async () => {
    const {root} = await createOverlayFixture()
    /* Same base, minus the author every fixture article points at. */
    const base = await writeJson(
      root,
      'base.json',
      FIXTURE_BASE_DOCUMENTS.filter((document) => document._id !== 'author-1'),
    )
    const {code, report} = await runCi(root, ['--check', 'strong-references', '--base', base])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'strong-references')
    expect(check.status).toBe('fail')
    expect(check.findings.some((f) => f.message.includes('author-1'))).toBe(true)
    expect(check.findings.some((f) => f.severity === 'error')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 5. unsupported plugins — "Check unsupported plugins."
 * ------------------------------------------------------------------ */

describe('unsupported-plugins', () => {
  it('passes a config that only uses supported tooling, and counts what it parsed', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'studio/sanity.config.ts',
      [
        "import {defineConfig} from 'sanity'",
        "import {structureTool} from 'sanity/structure'",
        "import {defineOverlayConfig} from 'sanity-overlay-studio'",
        '',
        'export default defineOverlayConfig({',
        "  name: 'default',",
        '  plugins: [structureTool()],',
        '})',
        '',
      ].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'unsupported-plugins', '--config', 'studio'])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'unsupported-plugins')
    expect(check.status).toBe('pass')
    expect(check.measured.files).toBeGreaterThan(0)
    expect(check.measured.imports).toBeGreaterThan(0)
    expect(check.measured.pluginCalls).toBeGreaterThan(0)
  })

  it('fails on a §21.11 Unsupported plugin module', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'studio/sanity.config.ts',
      [
        "import {defineConfig} from 'sanity'",
        "import {visionTool} from '@sanity/vision'",
        '',
        'export default defineConfig({plugins: [visionTool()]})',
        '',
      ].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'unsupported-plugins', '--config', 'studio'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'unsupported-plugins')
    expect(check.status).toBe('fail')
    expect(check.findings.some((f) => f.message.includes('@sanity/vision'))).toBe(true)
  })

  it('fails on a hosted tool §21.10 requires to be disabled', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'studio/sanity.config.ts',
      [
        "import {defineConfig} from 'sanity'",
        "import {scheduledPublishing} from '@sanity/scheduled-publishing'",
        '',
        'export default defineConfig({plugins: [scheduledPublishing()]})',
        '',
      ].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'unsupported-plugins', '--config', 'studio'])
    expect(code).toBe(EXIT.FINDINGS)
    expect(checkOf(report, 'unsupported-plugins').status).toBe('fail')
  })

  it('refuses to report success over an empty file set', async () => {
    const {root} = await createOverlayFixture()
    await mkdir(join(root, 'empty-studio'), {recursive: true})
    const {code, report} = await runCi(root, [
      '--check',
      'unsupported-plugins',
      '--config',
      'empty-studio',
    ])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'unsupported-plugins')
    expect(check.status).toBe('skip')
    expect(check.skipReason).toMatch(/no .*file/i)
    expect(check.measured.files).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 6. write tokens — "Check no write tokens in preview configuration."
 * ------------------------------------------------------------------ */

describe('write-tokens', () => {
  it('passes a preview configuration that only names read-only credentials', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'preview/.env.preview',
      ['SANITY_PROJECT_ID=proj', 'SANITY_API_READ_TOKEN=sk-read', 'OVERLAY_MODE=blob', ''].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'write-tokens', '--preview-env', 'preview'])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'write-tokens')
    expect(check.status).toBe('pass')
    expect(check.measured.files).toBe(1)
    /* Non-vacuity: three names were read and classified, one of them a credential. */
    expect(check.measured.names).toBe(3)
    expect(check.measured.credentials).toBe(1)
    expect(check.measured.readOnly).toBe(1)
    expect(check.measured.writeCapable).toBe(0)
  })

  it('fails on a write-capable Sanity credential (PRD §11.3, invariant §34.15)', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'preview/.env.preview',
      ['SANITY_API_WRITE_TOKEN=sk-write', ''].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'write-tokens', '--preview-env', 'preview'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'write-tokens')
    expect(check.status).toBe('fail')
    expect(check.measured.writeCapable).toBe(1)
    expect(check.findings.some((f) => f.message.includes('SANITY_API_WRITE_TOKEN'))).toBe(true)
  })

  it('reads GitHub-workflow and JSON preview configuration, not only dotenv', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'preview/deploy.yml',
      ['jobs:', '  preview:', '    env:', '      SANITY_TOKEN: ${{ secrets.SANITY_TOKEN }}', ''].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'write-tokens', '--preview-env', 'preview'])
    expect(code).toBe(EXIT.FINDINGS)
    expect(checkOf(report, 'write-tokens').findings.some((f) => f.message.includes('SANITY_TOKEN'))).toBe(
      true,
    )
  })

  it('warns when a read-only credential is browser-reachable', async () => {
    const {root} = await createOverlayFixture()
    await writeFileAt(
      root,
      'preview/.env.preview',
      ['NEXT_PUBLIC_SANITY_API_READ_TOKEN=sk-read', ''].join('\n'),
    )
    const {code, report} = await runCi(root, ['--check', 'write-tokens', '--preview-env', 'preview'])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'write-tokens')
    expect(check.status).toBe('pass')
    expect(check.findings.some((f) => f.severity === 'warning')).toBe(true)
  })

  it('refuses to report success over an empty file set', async () => {
    const {root} = await createOverlayFixture()
    await mkdir(join(root, 'no-config'), {recursive: true})
    const {code, report} = await runCi(root, ['--check', 'write-tokens', '--preview-env', 'no-config'])
    expect(code).toBe(EXIT.FINDINGS)
    expect(checkOf(report, 'write-tokens').status).toBe('skip')
  })
})

/* ------------------------------------------------------------------ *
 * 7. checkpoint status policy — "Check checkpoint status policy."
 * ------------------------------------------------------------------ */

describe('checkpoint-policy', () => {
  it('fails an overlay with uncheckpointed revisions under the D05 default', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'checkpoint-policy'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'checkpoint-policy')
    expect(check.status).toBe('fail')
    expect(check.measured.revision).toBeGreaterThan(0)
    expect(check.measured.uncheckpointedRevisions).toBeGreaterThan(0)
    expect(check.findings.some((f) => /checkpoint/i.test(f.message))).toBe(true)
  })

  it('reports the same state as a warning, exit 0, under --checkpoint-policy warn', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, [
      '--check',
      'checkpoint-policy',
      '--checkpoint-policy',
      'warn',
    ])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'checkpoint-policy')
    expect(check.status).toBe('pass')
    expect(check.findings.every((f) => f.severity === 'warning')).toBe(true)
    /* Still measured, so "warn" is not a way to hide the number. */
    expect(check.measured.uncheckpointedRevisions).toBeGreaterThan(0)
  })

  it('skips loudly under --checkpoint-policy off rather than reporting success', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, [
      '--check',
      'checkpoint-policy',
      '--checkpoint-policy',
      'off',
      '--allow-skip',
      'checkpoint-policy',
    ])
    expect(code).toBe(EXIT.OK)
    expect(checkOf(report, 'checkpoint-policy').status).toBe('skip')
  })

  it('rejects an unknown policy instead of silently defaulting', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['ci', '--checkpoint-policy', 'maybe'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
  })
})

/* ------------------------------------------------------------------ *
 * 8. conflict summary — "Report conflict summary on PR."
 * ------------------------------------------------------------------ */

describe('conflict-summary', () => {
  it('passes and measures a clean overlay', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'conflict-summary'])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'conflict-summary')
    expect(check.status).toBe('pass')
    expect(check.measured.documents).toBeGreaterThan(0)
    expect(check.measured.unresolved).toBe(0)
  })

  it('renders a markdown body a PR comment can carry', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['ci', '--check', 'conflict-summary', '--format', 'markdown'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout).toContain('|')
    expect(run.stdout).toMatch(/conflict/i)
    expect(run.stdout).toMatch(/overlay/i)
  })
})

/* ------------------------------------------------------------------ *
 * 9. base drift — "Schedule recurring base drift scan for open overlays."
 * ------------------------------------------------------------------ */

describe('base-drift', () => {
  it('skips without --base, and says why', async () => {
    const {root} = await createOverlayFixture()
    const {code, report} = await runCi(root, ['--check', 'base-drift'])
    expect(code).toBe(EXIT.FINDINGS)
    const check = checkOf(report, 'base-drift')
    expect(check.status).toBe('skip')
    expect(check.skipReason).toMatch(/--base/)
  })

  it('reports no drift when the base is unchanged since first touch', async () => {
    const {root} = await createOverlayFixture()
    const base = await writeJson(root, 'base.json', FIXTURE_BASE_DOCUMENTS)
    const {code, report} = await runCi(root, ['--check', 'base-drift', '--base', base])
    expect(code).toBe(EXIT.OK)
    const check = checkOf(report, 'base-drift')
    expect(check.status).toBe('pass')
    expect(check.measured.documents).toBeGreaterThan(0)
    expect(check.measured.drifted).toBe(0)
    expect(check.measured.conflictsAfterScan).toBe(0)
  })

  it('detects a moved base revision and reports the recomputed conflict summary', async () => {
    const {root} = await createOverlayFixture()
    const moved = FIXTURE_BASE_DOCUMENTS.map((document) =>
      document._id === 'article-1'
        ? {...document, _rev: 'base-rev-article-1-MOVED', title: 'Base title moved by an editor'}
        : document,
    )
    const base = await writeJson(root, 'base.json', moved)
    const {code, report} = await runCi(root, ['--check', 'base-drift', '--base', base])
    const check = checkOf(report, 'base-drift')
    expect(check.measured.drifted).toBeGreaterThan(0)
    /* The fixture's local edit touches `title`, and the base moved `title`, so
     * §17.3 must produce a conflict the manifest summary does not yet carry. */
    expect(check.measured.conflictsAfterScan).toBeGreaterThan(0)
    expect(check.measured.summaryChanged).toBe(1)
    expect(code).toBe(EXIT.FINDINGS)
  })

  it('never writes: a drift scan leaves the manifest revision untouched (§16.6)', async () => {
    const {root} = await createOverlayFixture()
    const before = await runCliCapture(['status', '--json'], {cwd: root})
    const moved = FIXTURE_BASE_DOCUMENTS.map((document) =>
      document._id === 'article-1' ? {...document, _rev: 'moved', title: 'moved'} : document,
    )
    const base = await writeJson(root, 'base.json', moved)
    await runCi(root, ['--check', 'base-drift', '--base', base])
    const after = await runCliCapture(['status', '--json'], {cwd: root})
    expect(JSON.parse(after.stdout).revision).toBe(JSON.parse(before.stdout).revision)
  })
})

/* ------------------------------------------------------------------ *
 * 10. the command as a whole
 * ------------------------------------------------------------------ */

describe('ci as a whole', () => {
  it('runs every check by default', async () => {
    const {root} = await createOverlayFixture()
    const {report} = await runCi(root, ['--allow-skip', 'all', '--checkpoint-policy', 'warn'])
    expect(report.checks.map((check) => check.check).sort()).toEqual([...CI_CHECKS].sort())
  })

  it('rejects an unknown --check instead of running nothing', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['ci', '--check', 'nope'], {cwd: root})
    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain('nope')
  })

  it('rejects an unknown --allow-skip id, so a typo cannot silence a gate', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['ci', '--check', 'branch-schema', '--allow-skip', 'brnch-schema'], {
      cwd: root,
    })
    expect(run.code).toBe(EXIT.USAGE)
  })

  it('fails with the overlay exit code when there is no overlay at all', async () => {
    const {root} = await createOverlayFixture({empty: true})
    const run = await runCliCapture(['ci', '--check', 'overlay-schemas'], {cwd: root})
    expect(run.code).toBe(EXIT.OVERLAY)
  })
})
