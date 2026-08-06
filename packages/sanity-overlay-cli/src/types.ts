/**
 * The CLI's injected boundary.
 *
 * `runCli` takes its argv, its streams, its working directory, its clock and its
 * environment as arguments rather than reading `process.*`. That is what lets a
 * test run the real command against a real overlay directory and assert on the
 * exact bytes a user would see, without spawning anything.
 */
export interface CliIo {
  /** stdout — the command's answer. Machine-readable when `--json` is set. */
  out(chunk: string): void
  /** stderr — diagnostics and failures. Never carries the answer. */
  err(chunk: string): void
}

export interface RunCliOptions {
  /** Arguments after the program name. */
  readonly argv: readonly string[]
  readonly io: CliIo
  /** Directory `--root` is resolved against, and the default overlay root. */
  readonly cwd: string
  /** Injected clock. Every write the CLI makes is stamped from here. */
  readonly now?: () => string
  /** Consulted only to know which strings are credentials (see `redact.ts`). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Everything a command body needs, assembled once by the dispatcher. */
export interface CommandContext {
  /** Absolute directory that contains (or will contain) `.sanity-overlay/`. */
  readonly root: string
  readonly json: boolean
  readonly now: () => string
  /** Write one line to stdout. */
  readonly out: (line: string) => void
  /** Write one line to stderr. */
  readonly warn: (line: string) => void
  /** Emit the machine-readable answer; a no-op when `--json` is not set. */
  readonly emitJson: (value: unknown) => void
}
