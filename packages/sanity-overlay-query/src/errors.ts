/**
 * Structured query errors — PRD §22.9 error policy, §5.5 "No silent query
 * approximation", §22.2 `[MUST]` "Return `UNSUPPORTED_GROQ` when exactness
 * cannot be proven" and "Never silently fall back".
 *
 * Every failure path in this package raises an {@link OverlayQueryError}
 * carrying a machine-readable code and the HTTP status PRD §22.9 assigns it, so
 * an unsupported query is identifiable at an API boundary without string
 * matching.
 */

/** The PRD §22.9 table, verbatim. */
export type OverlayQueryErrorCode =
  | 'QUERY_NOT_REGISTERED'
  | 'QUERY_CHANGED'
  | 'UNSUPPORTED_GROQ'
  | 'CANDIDATE_LIMIT_EXCEEDED'
  | 'REFERENCE_DEPTH_EXCEEDED'
  | 'INVALID_GROQ'
  | 'GROQ_EVALUATION_FAILED'
  /* --- extensions beyond the §22.9 table ------------------------------- *
   * PRD §22.4 registers `allowedCallers` and `perspectives` and §22.5 requires
   * unregistered queries to be REJECTED in strict preview mode, but §22.9
   * assigns no code to a registered query invoked outside its registration.
   * These two are therefore documented extensions, not PRD codes, and are
   * marked as such so a future PRD revision can rename them knowingly. */
  | 'QUERY_CALLER_NOT_ALLOWED'
  | 'QUERY_PERSPECTIVE_NOT_REGISTERED'

const HTTP_STATUS: Record<OverlayQueryErrorCode, number> = {
  QUERY_NOT_REGISTERED: 422,
  QUERY_CHANGED: 422,
  UNSUPPORTED_GROQ: 422,
  CANDIDATE_LIMIT_EXCEEDED: 413,
  REFERENCE_DEPTH_EXCEEDED: 422,
  INVALID_GROQ: 400,
  GROQ_EVALUATION_FAILED: 500,
  QUERY_CALLER_NOT_ALLOWED: 403,
  QUERY_PERSPECTIVE_NOT_REGISTERED: 422,
}

export interface OverlayQueryErrorDetails {
  readonly [key: string]: unknown
}

/** Base class for every failure raised by `sanity-overlay-query`. */
export class OverlayQueryError extends Error {
  readonly code: OverlayQueryErrorCode
  readonly httpStatus: number
  readonly details: OverlayQueryErrorDetails

  constructor(
    code: OverlayQueryErrorCode,
    message: string,
    details: OverlayQueryErrorDetails = {},
  ) {
    super(message)
    this.name = 'OverlayQueryError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.details = details
  }

  /** Serializable form, so the failure survives an API or log boundary. */
  toJSON(): {
    name: string
    code: OverlayQueryErrorCode
    httpStatus: number
    message: string
    details: OverlayQueryErrorDetails
  } {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      message: this.message,
      details: this.details,
    }
  }
}

export const httpStatusForQueryErrorCode = (code: OverlayQueryErrorCode): number =>
  HTTP_STATUS[code]
