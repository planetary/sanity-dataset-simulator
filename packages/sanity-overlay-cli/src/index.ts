/**
 * `sanity-overlay-cli` — the local developer and agent CLI (roadmap Phase 3
 * "the CLI", PRD §37 Phase 2, §14.5, §29.4).
 *
 * Ten commands over the domain packages, and no domain of its own: every answer
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
export {CLI_COMMANDS, CLI_NAME, CLI_VERSION, runCli} from './cli'
export type {CliCommand} from './cli'

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
