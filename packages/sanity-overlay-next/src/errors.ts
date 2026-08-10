/**
 * Structured, code-carrying failures for the overlay HTTP API.
 *
 * Every one of these becomes a `{ok: false, error: {code, message}}` body with a
 * deliberate status. The distinction that matters most is 4xx versus 5xx: PRD
 * §22.5 lets a caller pass an unsupported query through to staging and record
 * it, and that decision is only safe when "the overlay refused this query" is
 * distinguishable from "the overlay is down". A blanket 500 erases exactly that.
 */
import {httpStatusForQueryErrorCode} from 'sanity-overlay-query'
import type {OverlayQueryErrorCode} from 'sanity-overlay-query'

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
  /**
   * The caller presented an idempotency key that is already spent on a
   * DIFFERENT write (422).
   *
   * Its own code because the only fix is a new key. Answering the replay would
   * have reported someone else's transaction as this request's success, which
   * is the §5.5 silent approximation in its most expensive form: the write is
   * lost and the client is told it landed.
   */
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL'

/**
 * PRD §22.9 rows that no package raises a typed error for yet.
 *
 * `sanity-overlay-query` owns the §22.9 table for the codes IT raises, and
 * exports it as {@link httpStatusForQueryErrorCode}. Two rows of that table are
 * not its to raise:
 *
 *   - `OVERLAY_STORE_UNAVAILABLE` is raised by `FsOverlayStore` when a writer
 *     cannot take the `.locks/` critical section inside its timeout. It is
 *     flagged `retryable`, and 503 is the only status that says so; as a 400 it
 *     told a client to change its request when the correct advice was "try
 *     again".
 *   - `BASE_UNAVAILABLE` names a Content Lake outage. Nothing here raises it —
 *     §16.1 keeps base fetching on the caller's side of the boundary — but the
 *     day something does, it must arrive as a 503 rather than acquire a default.
 *
 * This is a SUPPLEMENT to the query package's table, never a copy of it: the
 * codes below are exactly the ones `httpStatusForQueryErrorCode` does not know,
 * so the two cannot drift into disagreeing about the same row.
 */
const NON_QUERY_SECTION_22_9: Readonly<Record<string, number>> = Object.freeze({
  BASE_UNAVAILABLE: 503,
  OVERLAY_STORE_UNAVAILABLE: 503,
  /**
   * The two STALENESS refusals, both 409.
   *
   * `OVERLAY_WRITE_CONFLICT` is the store refusing a write whose base revision
   * no longer matches the disk; `DOCUMENT_REVISION_CONFLICT` is the same fact
   * about one document head. Neither is in the §22.9 table — that table is the
   * query policy — but they are the same KIND of thing and they were flattened
   * by the same missing lookup, so they are resolved here rather than left to
   * the 400 default.
   *
   * 409 and not 400 because the distinction is the whole point: 400 says "your
   * payload was wrong", which invites a client to retry the identical request
   * forever; 409 says "your view of this resource is stale", which a client
   * answers by re-reading. On 2026-08-09 an editor's session sat in exactly the
   * first loop — every keystroke accepted, nothing written, no error anywhere —
   * until the server was restarted.
   */
  OVERLAY_WRITE_CONFLICT: 409,
  DOCUMENT_REVISION_CONFLICT: 409,
  /**
   * One idempotency key, two different writes — 422 (`store/replay.ts`,
   * `mutations/idempotency.ts`). Two spellings because the store and the
   * mutation engine each raise it in their own error family; one status,
   * because the caller's fix is the same.
   *
   * 422 and NOT 409. Both are 4xx and both are non-retryable, but they send the
   * client somewhere completely different: 409 makes the Studio render "the
   * branch moved underneath this session — reload", which would have an editor
   * hunting for another writer that does not exist. 422 is `transport.ts`'s
   * "refused as it stands, and resending will not help", which is the truth: the
   * key is spent and only a new one can succeed.
   */
  IDEMPOTENCY_KEY_REUSED: 422,
  OVERLAY_IDEMPOTENCY_KEY_REUSED: 422,
})

/**
 * The HTTP status PRD §22.9 assigns a machine-readable error code, or
 * `undefined` for a code the table does not name.
 *
 * WHY THIS EXISTS. `api.ts` used to resolve a response status from
 * `OverlayApiError.status` alone and flatten every other code-carrying failure
 * to 400. `sanity-overlay-query` puts the §22.9 status on every error it
 * raises, so the whole table was dead at the one boundary it was written for:
 * §33's "candidate set too large → capacity error" reached the caller
 * indistinguishable from a malformed request, and §33's "Query not registered →
 * Return 422" was not met.
 *
 * `undefined` rather than a fallback, deliberately. The caller decides what an
 * unnamed code means; a default here would silently re-acquire the behaviour
 * this function exists to remove.
 */
export function overlayApiStatusForErrorCode(code: string): number | undefined {
  const fromQueryLayer = httpStatusForQueryErrorCode(code as OverlayQueryErrorCode)
  if (typeof fromQueryLayer === 'number') return fromQueryLayer
  return NON_QUERY_SECTION_22_9[code]
}

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
