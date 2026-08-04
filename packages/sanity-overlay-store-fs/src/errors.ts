/**
 * Structured store errors (PRD §25.14 error contract).
 *
 * Every failure an adapter raises carries a machine-readable `code`, a
 * `retryable` flag and a `details` bag, so the API layer (PRD §25.14) can render
 * `OverlayErrorResponse` without string matching. The codes below are the subset
 * of the §25.14 required list that a *store* can produce, plus four store-level
 * additions that §25.14 does not name because they never cross the HTTP boundary
 * unchanged (`OVERLAY_ALREADY_EXISTS`, `CHECKSUM_MISMATCH`,
 * `OVERLAY_STORE_CORRUPT`, `OVERLAY_PATH_ESCAPE`, `OVERLAY_RETENTION_ACTIVE`).
 *
 * TEMPORARY LOCATION — see the header of `contract.ts`. These types move to
 * `sanity-overlay-core` together with the contract.
 */

export type OverlayStoreErrorCode =
  /* PRD §25.14 required codes reachable from a store. */
  | 'OVERLAY_NOT_FOUND'
  | 'OVERLAY_CLOSED'
  | 'OVERLAY_IDENTITY_MISMATCH'
  | 'OVERLAY_WRITE_CONFLICT'
  | 'DOCUMENT_REVISION_CONFLICT'
  | 'OVERLAY_STORE_UNAVAILABLE'
  | 'INVALID_REQUEST'
  /* Store-level additions. */
  | 'OVERLAY_ALREADY_EXISTS'
  | 'CHECKSUM_MISMATCH'
  | 'OVERLAY_STORE_CORRUPT'
  | 'OVERLAY_PATH_ESCAPE'
  | 'OVERLAY_RETENTION_ACTIVE'

export interface OverlayStoreErrorDetails {
  readonly [key: string]: unknown
}

/** Base class for every error raised by an overlay store adapter. */
export class OverlayStoreError extends Error {
  readonly code: OverlayStoreErrorCode
  readonly retryable: boolean
  readonly details: OverlayStoreErrorDetails

  constructor(
    code: OverlayStoreErrorCode,
    message: string,
    options: {retryable?: boolean; details?: OverlayStoreErrorDetails} = {},
  ) {
    super(message)
    this.name = 'OverlayStoreError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? {}
  }

  /** Serializable form for logs and the §25.14 error envelope. */
  toJSON(): {
    name: string
    code: OverlayStoreErrorCode
    message: string
    retryable: boolean
    details: OverlayStoreErrorDetails
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    }
  }
}

/** The overlay, document, transaction or snapshot does not exist (PRD §25.14). */
export class OverlayNotFoundError extends OverlayStoreError {
  constructor(what: string, details?: OverlayStoreErrorDetails) {
    super('OVERLAY_NOT_FOUND', `${what} was not found`, {details})
    this.name = 'OverlayNotFoundError'
  }
}

/** An overlay already exists at the requested location (`createOverlay`). */
export class OverlayAlreadyExistsError extends OverlayStoreError {
  constructor(overlayId: string, details?: OverlayStoreErrorDetails) {
    super('OVERLAY_ALREADY_EXISTS', `Overlay ${JSON.stringify(overlayId)} already exists`, {
      details: {overlayId, ...details},
    })
    this.name = 'OverlayAlreadyExistsError'
  }
}

/**
 * A conditional manifest write lost the race (PRD §35.7 "Concurrent stale write
 * rejection", §35.9 "Concurrent expected revision conflict", §14.3 "Use expected
 * manifest revision to prevent accidental stale local writes").
 *
 * Retryable: the caller re-reads the manifest, reapplies its intent and writes
 * again (PRD §15.4 retry policy).
 */
export class OverlayWriteConflictError extends OverlayStoreError {
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(overlayId: string, expectedRevision: number, actualRevision: number) {
    super(
      'OVERLAY_WRITE_CONFLICT',
      `Overlay ${JSON.stringify(overlayId)} expected revision ${expectedRevision} but the stored revision is ${actualRevision}`,
      {retryable: true, details: {overlayId, expectedRevision, actualRevision}},
    )
    this.name = 'OverlayWriteConflictError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/** A per-document revision precondition failed (PRD §25.5 `expectedDocumentRevisions`). */
export class OverlayDocumentRevisionConflictError extends OverlayStoreError {
  readonly documentId: string
  readonly expectedRevision: string
  readonly actualRevision: string | null

  constructor(documentId: string, expectedRevision: string, actualRevision: string | null) {
    super(
      'DOCUMENT_REVISION_CONFLICT',
      `Document ${JSON.stringify(documentId)} expected revision ${JSON.stringify(
        expectedRevision,
      )} but the stored revision is ${
        actualRevision === null ? 'absent' : JSON.stringify(actualRevision)
      }`,
      {retryable: true, details: {documentId, expectedRevision, actualRevision}},
    )
    this.name = 'OverlayDocumentRevisionConflictError'
    this.documentId = documentId
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/**
 * Stored bytes do not hash to their recorded checksum (PRD §34.4, §35.7
 * "Checksum corruption detection").
 *
 * `repairable` distinguishes the two §14.3 cases: a stale *metadata* checksum on
 * a semantically valid file is repairable and must not be rejected (the manual
 * Git merge case), whereas a content-addressed artifact whose bytes no longer
 * hash to its own filename is corruption.
 */
export class OverlayChecksumMismatchError extends OverlayStoreError {
  readonly expected: string
  readonly actual: string
  readonly repairable: boolean

  constructor(
    ref: string,
    expected: string,
    actual: string,
    options: {repairable?: boolean; details?: OverlayStoreErrorDetails} = {},
  ) {
    super(
      'CHECKSUM_MISMATCH',
      `Checksum mismatch for ${ref}: expected ${expected}, recomputed ${actual}`,
      {details: {ref, expected, actual, repairable: options.repairable ?? false, ...options.details}},
    )
    this.name = 'OverlayChecksumMismatchError'
    this.expected = expected
    this.actual = actual
    this.repairable = options.repairable ?? false
  }
}

/**
 * A stored file could not be parsed or failed structural validation (PRD §14.3
 * "Refuse malformed JSON and retain the last valid in-memory state").
 */
export class OverlayStoreCorruptError extends OverlayStoreError {
  readonly ref: string

  constructor(ref: string, reason: string, details?: OverlayStoreErrorDetails) {
    super('OVERLAY_STORE_CORRUPT', `${ref} is not valid overlay state: ${reason}`, {
      details: {ref, reason, ...details},
    })
    this.name = 'OverlayStoreCorruptError'
    this.ref = ref
  }
}

/** Writes are not allowed in the overlay's current lifecycle state (PRD §12.3). */
export class OverlayClosedError extends OverlayStoreError {
  constructor(overlayId: string, status: string) {
    super(
      'OVERLAY_CLOSED',
      `Overlay ${JSON.stringify(overlayId)} is ${status}; writes are not allowed in this state`,
      {details: {overlayId, status}},
    )
    this.name = 'OverlayClosedError'
  }
}

/** The requested overlay ID is not the overlay this store holds (PRD §12.2, §25.14). */
export class OverlayIdentityMismatchError extends OverlayStoreError {
  constructor(requested: string, stored: string) {
    super(
      'OVERLAY_IDENTITY_MISMATCH',
      `This store holds overlay ${JSON.stringify(stored)}, not ${JSON.stringify(requested)}`,
      {details: {requested, stored}},
    )
    this.name = 'OverlayIdentityMismatchError'
  }
}

/**
 * A resolved path left the overlay root (PRD §35.9 "Path traversal attempts
 * fail", §26.7 input validation).
 */
export class OverlayPathEscapeError extends OverlayStoreError {
  constructor(candidate: string, root: string, details?: OverlayStoreErrorDetails) {
    super(
      'OVERLAY_PATH_ESCAPE',
      `Refusing to touch ${JSON.stringify(candidate)}: it resolves outside the overlay root ${JSON.stringify(root)}`,
      {details: {candidate, root, ...details}},
    )
    this.name = 'OverlayPathEscapeError'
  }
}

/** Deletion was refused because retention or an in-flight promotion still applies (PRD §15.7). */
export class OverlayRetentionActiveError extends OverlayStoreError {
  constructor(overlayId: string, reason: string, details?: OverlayStoreErrorDetails) {
    super('OVERLAY_RETENTION_ACTIVE', `Refusing to delete overlay ${JSON.stringify(overlayId)}: ${reason}`, {
      details: {overlayId, reason, ...details},
    })
    this.name = 'OverlayRetentionActiveError'
  }
}

/** The request itself was structurally invalid (PRD §25.14 `INVALID_REQUEST`). */
export class OverlayInvalidRequestError extends OverlayStoreError {
  constructor(message: string, details?: OverlayStoreErrorDetails) {
    super('INVALID_REQUEST', message, {details})
    this.name = 'OverlayInvalidRequestError'
  }
}

/** True when `error` is an {@link OverlayStoreError}, optionally of a specific code. */
export function isOverlayStoreError(
  error: unknown,
  code?: OverlayStoreErrorCode,
): error is OverlayStoreError {
  if (!(error instanceof OverlayStoreError)) return false
  return code === undefined || error.code === code
}
