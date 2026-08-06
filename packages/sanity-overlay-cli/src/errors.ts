/**
 * One error type carrying the exit code, so every failure path in the CLI is a
 * `throw` and the dispatcher owns exactly one place that turns a failure into
 * an exit code and a rendered message. A command that chose its own exit code
 * at the call site would be the place the exit-code contract silently drifts.
 */
import {EXIT} from './exit'

export class CliError extends Error {
  readonly exitCode: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    exitCode: number,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.code = code
    this.details = details
  }
}

/** Wrong invocation: unknown command or option, missing or unreadable input. */
export const usageError = (message: string, details?: Record<string, unknown>): CliError =>
  new CliError(EXIT.USAGE, 'CLI_USAGE', message, details)

/** The overlay is missing, corrupt, or does not hold what was asked for. */
export const overlayError = (
  message: string,
  code = 'OVERLAY_ERROR',
  details?: Record<string, unknown>,
): CliError => new CliError(EXIT.OVERLAY, code, message, details)

/** A destructive command was invoked without `--confirm`. */
export const confirmationRequired = (
  message: string,
  details?: Record<string, unknown>,
): CliError => new CliError(EXIT.CONFIRMATION_REQUIRED, 'CONFIRMATION_REQUIRED', message, details)
