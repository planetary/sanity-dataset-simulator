/**
 * The PRD §37 Phase 6 "CI" checklist, as data.
 *
 * The checklist is ten lines of prose in the PRD. Prose cannot be run, and a
 * roadmap phase whose exit condition is "CI does these ten things" needs
 * something that says, per line, *what discharges it* — otherwise "we added a
 * workflow" and "we built the check" are indistinguishable in a review.
 *
 * So each line carries a {@link CiDischarge}:
 *
 * - `ci-check`      — a check this command runs, named in {@link CI_CHECKS}.
 * - `workflow-job`  — an existing suite or command a job invokes; nothing new
 *                     was built, the job is the enforcement.
 * - `configuration` — a schedule or a trigger. There is no logic to test,
 *                     because there IS none: it is a `cron` line. Anything with
 *                     logic behind it is a `ci-check` instead, so this label
 *                     cannot be used to hide unwritten code.
 *
 * Every check reports {@link CiCheckResult.measured}. That is not decoration:
 * a gate reporting zero findings over zero documents, zero files or zero
 * environment names is worse than no gate at all, because it reads as evidence.
 * The measured counts are printed in both the human and the JSON output and are
 * asserted on in the suite.
 */

/**
 * The §37 Phase 6 "CI" block, verbatim and in the PRD's order.
 *
 * Verbatim matters: it is the only way a reader can check the list against the
 * document without trusting a paraphrase.
 */
export const PHASE_6_CI_TASKS = [
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
] as const

export type Phase6CiTask = (typeof PHASE_6_CI_TASKS)[number]

/** The checks `sanity-overlay ci` runs. */
export const CI_CHECKS = [
  'overlay-schemas',
  'branch-schema',
  'strong-references',
  'unsupported-plugins',
  'write-tokens',
  'checkpoint-policy',
  'conflict-summary',
  'base-drift',
] as const

export type CiCheckId = (typeof CI_CHECKS)[number]

export type CiDischargeKind = 'ci-check' | 'workflow-job' | 'configuration'

export interface CiDischarge {
  readonly kind: CiDischargeKind
  /** The {@link CI_CHECKS} entry, when `kind` is `ci-check`. */
  readonly check?: CiCheckId
  /** The workflow job that runs it. A check nothing invokes is not a gate. */
  readonly job: string
  readonly note: string
}

export const PHASE_6_CI_DISCHARGE: Readonly<Record<Phase6CiTask, CiDischarge>> = Object.freeze({
  'Validate overlay file schemas.': {
    kind: 'ci-check',
    check: 'overlay-schemas',
    job: 'overlay-gates',
    note:
      'Composes the twelve executable PRD §34 invariants in core with the adapter’s own ' +
      'checksum verification and the per-document read failures `loadRecords` collects — the ' +
      'same three sources `sanity-overlay validate` uses. Nothing here re-implements them.',
  },
  'Validate branch schema.': {
    kind: 'ci-check',
    check: 'branch-schema',
    job: 'overlay-gates',
    note:
      'PRD §20.5 “[SHOULD] In CI: validate canonical overlay files against the branch schema”. Reads the ' +
      '§20.1 serialized schema artifact from --schema and checks every document type, every ' +
      'declared required field and the §20.1 schema commit SHA recorded in the manifest.',
  },
  'Validate strong references.': {
    kind: 'ci-check',
    check: 'strong-references',
    job: 'overlay-gates',
    note:
      'Core’s `referenceValidationIssues` (PRD §19.5, §18.8, invariant §34.10) over every ' +
      'document in the overlay. Needs --base: in fs mode there is no Content Lake connection, ' +
      'and a reference check that assumed an empty base would report every base target missing.',
  },
  'Run query parity tests.': {
    kind: 'workflow-job',
    job: 'query-parity',
    note:
      'PRD §22.4 parity and §22.2 boundedness already exist as suites in the testkit, plus the ' +
      'registry’s own unregistered-query checker. The job runs those files directly; this ' +
      'command adds no second implementation of them.',
  },
  'Check unsupported plugins.': {
    kind: 'ci-check',
    check: 'unsupported-plugins',
    job: 'overlay-gates',
    note:
      'PRD §21.10 features to disable and the §21.11 “Unsupported” plugin classes. The deny ' +
      'list is derived from `sanity-overlay-studio`’s own HOSTED_FEATURES and ' +
      'DISABLED_HOSTED_TOOL_NAMES, so the gate cannot drift from what the Studio disables.',
  },
  'Check no write tokens in preview configuration.': {
    kind: 'ci-check',
    check: 'write-tokens',
    job: 'overlay-gates',
    note:
      'PRD §11.3 and invariant §34.15. Classification is `classifyTokenEnvKey` from ' +
      'sanity-overlay-studio — the check the Studio already refuses to boot against — applied ' +
      'to environment names extracted from dotenv, workflow YAML, JSON and source files.',
  },
  'Check checkpoint status policy.': {
    kind: 'ci-check',
    check: 'checkpoint-policy',
    job: 'overlay-gates',
    note:
      'PRD §29.6 “Manifest shows checkpoint.overlayRevision < manifest.revision … CI can choose ' +
      'whether uncheckpointed runtime state is acceptable”. The default is decision D05’s ' +
      'default-when-unanswered: block. --checkpoint-policy warn|off is the project’s choice.',
  },
  'Report conflict summary on PR.': {
    kind: 'ci-check',
    check: 'conflict-summary',
    job: 'conflict-report',
    note:
      'The §13.1 conflictSummary and the §13.3 per-document conflicts, rendered as the markdown ' +
      'body of a PR comment (--format markdown). Posting it is `--report pr`, which needs a ' +
      'GitHub token; without one the run says it skipped rather than reporting success.',
  },
  'Schedule recurring base drift scan for open overlays.': {
    kind: 'configuration',
    check: 'base-drift',
    job: 'base-drift-scan',
    note:
      'Two halves, and only one of them is code. The SCAN is the `base-drift` check: it re-reads ' +
      'the current base, re-runs the §17.3 merge per touched document and recomputes the ' +
      'conflict summary without writing. The SCHEDULE is configuration only — a `cron` line at ' +
      'the PRD §16.6 default cadence of every 6 hours in .github/workflows/base-drift-scan.yml. ' +
      'Nothing tests that GitHub honours a cron; the suite tests the cron expression and the scan.',
  },
  'Refresh PR status when drift changes conflicts.': {
    kind: 'configuration',
    check: 'base-drift',
    job: 'base-drift-scan',
    note:
      'The DECISION — “did the conflict summary change, and what commit status does that imply” ' +
      '— is `planCommitStatus` in ci/github.ts, a pure function over the previous and current ' +
      'summaries, tested against an injected client with no network. The DELIVERY is ' +
      'configuration: the workflow’s token, permissions and repository inputs. PRD §16.6 ' +
      '“Update … only when the conflict summary changes”.',
  },
})

export type CiStatus = 'pass' | 'fail' | 'skip'

export interface CiFinding {
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** File, document or environment name the finding belongs to. */
  readonly ref?: string
}

export interface CiCheckResult {
  readonly check: CiCheckId
  readonly task: Phase6CiTask
  readonly status: CiStatus
  /** Present exactly when `status` is `skip`. Always printed. */
  readonly skipReason?: string
  readonly findings: readonly CiFinding[]
  /** What the check actually looked at. A green gate must prove it saw something. */
  readonly measured: Readonly<Record<string, number>>
}

export interface CiReport {
  readonly ok: boolean
  readonly root: string
  readonly overlayId: string | null
  readonly checks: readonly CiCheckResult[]
  readonly failed: readonly CiCheckId[]
  /** Skipped and NOT allowed — the ones that make the run fail. */
  readonly skipped: readonly CiCheckId[]
  readonly prReport?: {
    readonly status: 'sent' | 'skip';
    readonly reason?: string
    readonly comment?: string
    readonly commitStatus?: string
  }
}

/** The §37 Phase 6 line a check discharges, for the report. */
export function taskFor(check: CiCheckId): Phase6CiTask {
  for (const task of PHASE_6_CI_TASKS) {
    if (PHASE_6_CI_DISCHARGE[task].check === check) return task
  }
  /* Unreachable while the suite's "no check unattached to a checklist line"
   * test passes; kept as a total function rather than a cast. */
  throw new Error(`No PRD §37 Phase 6 task claims check ${JSON.stringify(check)}`)
}

/** A `pass`/`fail` result, decided by whether any finding is an error. */
export function resultOf(
  check: CiCheckId,
  findings: readonly CiFinding[],
  measured: Readonly<Record<string, number>>,
): CiCheckResult {
  const failed = findings.some((finding) => finding.severity === 'error')
  return {check, task: taskFor(check), status: failed ? 'fail' : 'pass', findings, measured}
}

/** A `skip` result. The reason is mandatory: a silent no-op is the failure mode. */
export function skipped(
  check: CiCheckId,
  skipReason: string,
  measured: Readonly<Record<string, number>> = {},
): CiCheckResult {
  return {check, task: taskFor(check), status: 'skip', skipReason, findings: [], measured}
}
