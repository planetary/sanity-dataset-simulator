/**
 * The CLI's exit-code contract.
 *
 * Scripts and CI steps branch on these, so they are frozen data with one
 * meaning each, not ad-hoc numbers chosen at each throw site. `FINDINGS` is the
 * one that matters most: `validate`, `conflicts`, `rebase` (blocked) and
 * `diff --exit-code` all use it, so "the branch is not clean" is a single
 * testable condition rather than four different failure shapes.
 */
export const EXIT = Object.freeze({
  /** The command did what it was asked and found nothing wrong. */
  OK: 0,
  /** An unexpected internal failure. Anything that reaches here is a bug. */
  ERROR: 1,
  /** The command ran and reported findings: violations, conflicts, a blocked rebase, a diff. */
  FINDINGS: 2,
  /** A destructive command refused to run because `--confirm` was absent. */
  CONFIRMATION_REQUIRED: 3,
  /** The overlay is missing, corrupt, closed, or does not hold the requested document. */
  OVERLAY: 4,
  /** The invocation itself was wrong: unknown command or option, missing required input. */
  USAGE: 5,
  /** The query layer refused: unregistered, unsupported, caller or perspective not allowed. */
  QUERY_REFUSED: 6,
})

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Rendered in `--help`; kept next to the codes so the two cannot drift. */
export const EXIT_CODE_TABLE: readonly (readonly [number, string])[] = Object.freeze([
  [EXIT.OK, 'success, nothing to report'],
  [EXIT.ERROR, 'unexpected internal error'],
  [EXIT.FINDINGS, 'ran successfully and found something (violations, conflicts, changes)'],
  [EXIT.CONFIRMATION_REQUIRED, 'confirmation required — rerun with --confirm'],
  [EXIT.OVERLAY, 'overlay missing, corrupt, or does not hold the requested document'],
  [EXIT.USAGE, 'usage error'],
  [EXIT.QUERY_REFUSED, 'query refused by the registry'],
] as const)
