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
  /**
   * A state-changing request did not declare `application/json` (415).
   *
   * Distinct from `INVALID_REQUEST` on purpose: it is not a malformed body, it
   * is a request shape that would have skipped the CORS preflight — so the
   * caller's fix is a header, not a payload.
   */
  | 'UNSUPPORTED_MEDIA_TYPE'
  /** A state-changing request came from an origin this API does not grant (403). */
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  /**
   * A rebase arrived without the CURRENT base for a document in scope (400).
   *
   * Its own code rather than `INVALID_REQUEST` because the caller's fix is
   * neither a header nor a malformed field: it is a READ they have to perform
   * first. §16.1 keeps base fetching out of core and out of this API, so only
   * the party holding a Sanity credential can state the base — and a client that
   * cannot tell this apart from a bad payload will retry the same request
   * forever.
   */
  | 'BASE_REQUIRED'
  /**
   * This API was built without an `assetStore`, so the §24 asset routes have no
   * storage behind them (501).
   *
   * A 5xx and NOT a 404, because the two say different things to the caller and
   * only one of them is true: a 404 means "this overlay holds no such asset",
   * which an image input reads as "the upload failed, try another file". This
   * means "this deployment cannot hold assets at all", and the fix is the
   * embedder's configuration rather than anything the editor can do. §5.5
   * forbids letting a caller conclude the first from the second.
   */
  | 'ASSETS_NOT_CONFIGURED'
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
