/**
 * Structured errors for the core domain engine.
 *
 * PRD §14.3 and §37 Phase 1 ("Reads must reject unknown future versions with a
 * structured error rather than best-effort parsing", plan §4) require errors that
 * carry a machine-readable code and context, not just a message. Every error
 * thrown by this package is an {@link OverlayError} subclass.
 */

export type OverlayErrorCode =
  | 'OVERLAY_CANONICAL_JSON_INVALID'
  | 'OVERLAY_PROTOTYPE_KEY_REJECTED'
  | 'OVERLAY_CHECKSUM_INVALID'
  | 'OVERLAY_PATH_ENCODING_INVALID'
  | 'OVERLAY_ID_ENCODING_INVALID'
  | 'OVERLAY_UNSUPPORTED_FORMAT_VERSION'
  | 'OVERLAY_MIGRATION_MISSING'
  | 'OVERLAY_MIGRATION_INVALID'
  /* W2 — mutation engine (PRD §13.7, §17.5-§17.10, §18.4-§18.9). */
  | 'OVERLAY_PATH_NOT_FOUND'
  | 'OVERLAY_PATH_TYPE_MISMATCH'
  | 'OVERLAY_OPERATION_INVALID'
  | 'OVERLAY_DMP_PATCH_INVALID'
  | 'OVERLAY_DMP_PATCH_UNSUPPORTED'
  | 'OVERLAY_DMP_CONTEXT_MISMATCH'
  | 'OVERLAY_DOCUMENT_NOT_FOUND'
  | 'OVERLAY_DOCUMENT_ALREADY_EXISTS'
  | 'OVERLAY_REVISION_PRECONDITION_FAILED'
  | 'OVERLAY_TYPE_CHANGE_REQUIRES_INTENT'
  | 'OVERLAY_ID_CHANGE_NOT_ALLOWED'
  | 'OVERLAY_ACTION_BLOCKED'
  | 'OVERLAY_TRANSACTION_INVALID'
  /* W4 — references (PRD §19.4 truncation, §19.5 integrity). */
  | 'OVERLAY_REFERENCE_DEPTH_EXCEEDED'
  | 'OVERLAY_REFERENCE_INTEGRITY'

export interface OverlayErrorDetails {
  readonly [key: string]: unknown
}

/** Base class for every error raised by `sanity-overlay-core`. */
export class OverlayError extends Error {
  readonly code: OverlayErrorCode
  readonly details: OverlayErrorDetails

  constructor(code: OverlayErrorCode, message: string, details: OverlayErrorDetails = {}) {
    super(message)
    this.name = 'OverlayError'
    this.code = code
    this.details = details
  }

  /** Serializable form, so the error can cross an API or log boundary intact. */
  toJSON(): {name: string; code: OverlayErrorCode; message: string; details: OverlayErrorDetails} {
    return {name: this.name, code: this.code, message: this.message, details: this.details}
  }
}

/** Canonical JSON could not be produced or parsed (PRD §14.3). */
export class OverlaySerializationError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlaySerializationError'
  }
}

/** A prototype-polluting key was present in input (PRD §35.14). */
export class OverlayPrototypeKeyError extends OverlaySerializationError {
  constructor(key: string, path: readonly (string | number)[]) {
    super(
      'OVERLAY_PROTOTYPE_KEY_REJECTED',
      `Prototype-polluting key ${JSON.stringify(key)} is not allowed (at ${
        path.length > 0 ? path.join('.') : '<root>'
      })`,
      {key, path: [...path]},
    )
    this.name = 'OverlayPrototypeKeyError'
  }
}

/** Path or logical-ID encoding failure (PRD §13.6, §14.3). */
export class OverlayEncodingError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlayEncodingError'
  }
}

/** An unknown or unsupported `formatVersion` was read (PRD §13.1, §13.3, §13.10). */
export class OverlayFormatVersionError extends OverlayError {
  readonly received: unknown
  readonly supportedVersion: number

  constructor(received: unknown, supportedVersion: number, message?: string) {
    super(
      'OVERLAY_UNSUPPORTED_FORMAT_VERSION',
      message ??
        `Unsupported overlay formatVersion ${JSON.stringify(
          received,
        )}; this build supports formatVersion ${supportedVersion}`,
      {received, supportedVersion},
    )
    this.name = 'OverlayFormatVersionError'
    this.received = received
    this.supportedVersion = supportedVersion
  }
}

/** No registered migration exists for a step in the upgrade chain. */
export class OverlayMigrationError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlayMigrationError'
  }
}

/**
 * A path could not be traversed or written (W2, PRD §13.6, §17.6, §17.7).
 *
 * The engine never silently mis-applies: a missing `{_key}` anchor, an out-of-range
 * numeric index, or a container of the wrong kind raises this rather than guessing.
 */
export class OverlayPathError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlayPathError'
  }
}

/** An operation or mutation was structurally invalid (PRD §13.7, §17.10). */
export class OverlayMutationError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlayMutationError'
  }
}

/**
 * A `diffMatchPatch` patch could not be parsed or applied exactly (PRD §17.9).
 *
 * The supported subset is documented on {@link applyDiffMatchPatch}; anything
 * outside it throws instead of applying an approximation.
 */
export class OverlayDiffMatchPatchError extends OverlayError {
  constructor(code: OverlayErrorCode, message: string, details?: OverlayErrorDetails) {
    super(code, message, details)
    this.name = 'OverlayDiffMatchPatchError'
  }
}

/** A revision precondition (`patch.ifRevision`) did not hold (PRD §13.7, §25.6). */
export class OverlayPreconditionError extends OverlayError {
  readonly documentId: string
  readonly expected: string
  readonly actual: string | null

  constructor(documentId: string, expected: string, actual: string | null) {
    super(
      'OVERLAY_REVISION_PRECONDITION_FAILED',
      `Revision precondition failed for ${JSON.stringify(documentId)}: expected ${JSON.stringify(
        expected,
      )}, current revision is ${actual === null ? 'absent' : JSON.stringify(actual)}`,
      {documentId, expected, actual},
    )
    this.name = 'OverlayPreconditionError'
    this.documentId = documentId
    this.expected = expected
    this.actual = actual
  }
}

/**
 * A document action was blocked by a precondition (PRD §18.5 publish validation
 * and strong references, §18.8 delete strong-reference check).
 */
export class OverlayActionBlockedError extends OverlayError {
  readonly action: string
  readonly reason: string

  constructor(action: string, reason: string, message: string, details: OverlayErrorDetails = {}) {
    super('OVERLAY_ACTION_BLOCKED', message, {action, reason, ...details})
    this.name = 'OverlayActionBlockedError'
    this.action = action
    this.reason = reason
  }
}
