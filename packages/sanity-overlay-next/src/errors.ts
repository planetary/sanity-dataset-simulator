/**
 * Structured, code-carrying failures for the overlay HTTP API.
 *
 * Every one of these becomes a `{ok: false, error: {code, message}}` body with a
 * deliberate status. The distinction that matters most is 4xx versus 5xx: PRD
 * §22.5 lets a caller pass an unsupported query through to staging and record
 * it, and that decision is only safe when "the overlay refused this query" is
 * distinguishable from "the overlay is down". A blanket 500 erases exactly that.
 */
export type OverlayApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_QUERY'
  | 'NOT_FOUND'
  | 'INTERNAL'

export class OverlayApiError extends Error {
  readonly status: number
  readonly code: OverlayApiErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    status: number,
    code: OverlayApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OverlayApiError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}
