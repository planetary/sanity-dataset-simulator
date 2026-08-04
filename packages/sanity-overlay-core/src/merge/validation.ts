/**
 * The schema validation port consumed by merge step 9 (PRD §17.3, §20.1, §20.5).
 *
 * Core never imports Studio code (PRD §10.1): the branch schema arrives as a
 * serialized artifact and the validator built from it is injected. This module
 * declares the *narrowest* shape the merge engine needs — a pure function from
 * a resolved document to a list of issues — plus a no-op default, so merge output
 * is testable long before the real validation port exists.
 *
 * The declaration is structural on purpose: it is byte-for-byte assignable to and
 * from `DocumentValidator` in `../mutations/ports`, so one implementation
 * satisfies the mutation engine, the document actions and the merge engine.
 */
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'

export interface MergeValidationIssue {
  level: 'error' | 'warning'
  message: string
  path?: OverlayPath
}

export interface MergeValidationContext {
  /** Logical document ID (or the perspective ID) being validated. */
  logicalId: string
  /** What triggered validation — `merge`, `rebase`, `publish`, … (PRD §20.5 timing). */
  action: string
}

/** PRD §17.3 step 9. Pure, synchronous, and never throws for a valid document. */
export type MergeValidator = (
  document: SanityDocument,
  context: MergeValidationContext,
) => readonly MergeValidationIssue[]

/** Default port: the merge engine runs unvalidated rather than half-validated. */
export const noopMergeValidator: MergeValidator = () => []

/** True when the issue list blocks (PRD §17.4: a validation *error* is hard). */
export function hasValidationError(issues: readonly MergeValidationIssue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}
