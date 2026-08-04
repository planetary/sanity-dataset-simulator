/** Shared vocabulary for workstream W4 — references (plan §7, PRD §19). */
import {OverlayError, type OverlayErrorCode, type OverlayErrorDetails} from '../errors'
import type {OverlayPath} from '../types/path'

/** PRD §19.5 — strong references constrain integrity, weak references do not. */
export type ReferenceStrength = 'strong' | 'weak'

/**
 * The perspective a reference target is resolved under (PRD §19.2 step 6).
 *
 * `raw` is deliberately absent: §18.3 makes it a partial, synthetic view owned by
 * the perspective module, and no reference decision in §19 is expressed in terms
 * of it.
 */
export type ReferencePerspective = 'published' | 'drafts'

/** Which concrete version of a document holds or is addressed by a reference. */
export type ReferenceVersion = 'draft' | 'published'

/** One reference found by {@link extractReferences} (PRD §19.1). */
export interface ExtractedReference {
  /** Path of the reference inside the holding document (PRD §13.6). */
  path: OverlayPath
  /** The literal `_ref` value, `drafts.` prefix and all. */
  rawRef: string
  /** Normalized target logical ID (PRD §19.2 step 1). */
  targetId: string
  /** Version named by `rawRef`. */
  targetVersion: ReferenceVersion
  strength: ReferenceStrength
  /** Present only when the schema artifact — not the value — made it weak. */
  weakFromSchema?: true
}

/** W4 error codes — the subset of {@link OverlayErrorCode} raised by §19 work. */
export type OverlayReferenceErrorCode =
  | 'OVERLAY_REFERENCE_DEPTH_EXCEEDED'
  | 'OVERLAY_REFERENCE_INTEGRITY'
  | 'OVERLAY_ID_CHANGE_NOT_ALLOWED'
  | 'OVERLAY_MIGRATION_INVALID'

/** A reference-graph failure (PRD §19.4 truncation, §19.6 immutable `_id`). */
export class OverlayReferenceError extends OverlayError {
  readonly referenceCode: OverlayReferenceErrorCode

  constructor(
    referenceCode: OverlayReferenceErrorCode,
    message: string,
    details: OverlayErrorDetails = {},
  ) {
    super(referenceCode as OverlayErrorCode, message, details)
    this.name = 'OverlayReferenceError'
    this.referenceCode = referenceCode
  }
}
