/**
 * `sanity-overlay-cli` — the local developer and agent CLI (roadmap Phase 3
 * "the CLI", PRD §37 Phase 2, §14.5, §29.4).
 *
 * Commands over the domain packages, and no domain of its own: every answer
 * comes from `sanity-overlay-core` (invariants, merge, rebase, conflicts,
 * checkpoint), `sanity-overlay-store-fs` (the `.sanity-overlay/` layout) or
 * `sanity-overlay-query` (the registry and the pinned `groq-js` evaluator). The
 * CLI's own contributions are argument parsing, a stable exit-code contract, a
 * deterministic human rendering, and the refusal to destroy anything without
 * `--confirm`.
 *
 * `runCli` takes its streams, cwd, clock and environment as arguments, so the
 * suite runs the real commands against real overlay directories and asserts on
 * the exact bytes a user would see.
 *
 * Milestone note (PRD §1.4): `[M-LOCAL]` tooling. No milestone acceptance is
 * claimed by this package.
 */
export {
  CLI_COMMANDS,
  CLI_NAME,
  CLI_OPTION_NAMES,
  CLI_VERSION,
  COMMANDS_BEYOND_PRD,
  PHASE_2_CLI_COMMANDS,
  PRD_14_5_COMMANDS,
  runCli,
} from './cli'
export type {CliCommand} from './cli'

export {runAttach} from './commands/attach'
export type {AttachOptions} from './commands/attach'

export {runDev} from './commands/dev'
export type {DevOptions} from './commands/dev'

export {EXIT, EXIT_CODE_TABLE} from './exit'
export type {ExitCode} from './exit'

export {CliError} from './errors'
export type {CliIo, CommandContext, RunCliOptions} from './types'

/* The path-level diff engine, exported so a report tool can reuse it. */
export {diffValues} from './diff'
export type {DiffEntry, DiffKind, DiffOptions} from './diff'

/* Record navigation used by `diff` and `rebase` (PRD §13.3 ancestor selection). */
export {
  VERSION_KINDS,
  ancestorFor,
  ancestorRevisionFor,
  localVersion,
  primaryVersion,
  tombstoned,
} from './records'
export type {VersionKind} from './records'

export {formatPath, plural, table} from './render'
export {collectSecrets, redact, REDACTED} from './redact'

/* PRD §37 Phase 6 CI — the checklist as data, the checks, and the PR reporting
 * decisions. Exported so the suite asserts on them directly and a consuming
 * project can compose them into its own gate. */
export {
  CI_CHECKS,
  PHASE_6_CI_DISCHARGE,
  PHASE_6_CI_TASKS,
  resultOf,
  skipped,
  taskFor,
} from './ci/checks'
export type {
  CiCheckId,
  CiCheckResult,
  CiDischarge,
  CiDischargeKind,
  CiFinding,
  CiReport,
  CiStatus,
  Phase6CiTask,
} from './ci/checks'

export {
  CHECKPOINT_POLICIES,
  baseDriftCheck,
  branchSchemaCheck,
  checkpointPolicyCheck,
  conflictSummaryCheck,
  overlaySchemasCheck,
  strongReferencesCheck,
} from './ci/overlayChecks'
export type {CheckpointPolicy} from './ci/overlayChecks'

export {
  UNSUPPORTED_HOSTED_NAMES,
  UNSUPPORTED_PLUGIN_MODULES,
  UNSUPPORTED_PLUGIN_SYMBOLS,
  extractEnvNames,
  scanForUnsupportedPlugins,
  scanForWriteTokens,
} from './ci/scan'

export {CONFLICT_COMMENT_MARKER, renderCiText, renderConflictMarkdown} from './ci/report'

export {
  COMMIT_STATUS_CONTEXT,
  countsEqual,
  createHttpGitHubClient,
  parseRepository,
  planCommitStatus,
  planConflictComment,
  publishPrReport,
} from './ci/github'
export type {
  CommentPlan,
  CommitStatusPlan,
  CommitStatusState,
  ConflictCounts,
  GitHubClient,
  GitHubIssueComment,
  PrTarget,
} from './ci/github'
