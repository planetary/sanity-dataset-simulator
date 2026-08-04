/**
 * The schema validation port (plan §7 "Validation port"; PRD §17.3 step 9, §20.1,
 * §20.5).
 *
 * §17.3 step 9 puts schema validation *inside* the merge, and `validation/` is a
 * core directory (§10) — but the schema itself is branch Studio code (§20.1), and
 * core must never import Studio (§10.1). The resolution PRD v1.1 mandates, and the
 * one implemented here: core consumes an injected **serialized schema artifact**
 * (`./schema`) and an injected **validator function**. The default validator
 * reports nothing, so merge output is testable with no Studio and no schema at
 * all; the testkit ships a fixture validator built from the artifact.
 *
 * Nothing in this file knows what a schema rule *is*. That is the point: a rule
 * engine lives on the far side of the port, where the artifact came from.
 */
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'
import type {DocumentValidator, ValidationContext} from '../mutations/ports'

/** PRD §20.5 — every documented validation moment, in the order §20.5 lists them. */
export const VALIDATION_TIMINGS = Object.freeze([
  'open',
  'mutate',
  'publish',
  'checkpoint',
  'promotion',
  'ci',
] as const)

export type ValidationTiming = (typeof VALIDATION_TIMINGS)[number]

export interface OverlayValidationIssue {
  level: 'error' | 'warning'
  message: string
  /** Where the issue sits inside the document (PRD §13.6). */
  path?: OverlayPath
  /** Stable identifier for the rule that produced it, for grouping and dedupe. */
  ruleId?: string
}

export interface OverlayValidationContext {
  logicalId: string
  timing: ValidationTiming
  /**
   * PRD §20.1 "[MUST] Invalidate validation results when schema commit changes."
   * Carried through so a cache keyed on it can be invalidated correctly.
   */
  schemaCommit?: string
  /** The document's schema type, when the caller knows it independently. */
  typeName?: string
}

/** The injected validator (PRD §17.3 step 9). */
export type OverlayDocumentValidator = (
  document: SanityDocument,
  context: OverlayValidationContext,
) => readonly OverlayValidationIssue[]

/** The default port: no schema, no issues. */
export const noopDocumentValidator: OverlayDocumentValidator = () => []

export interface ValidationTimingPolicy {
  /** `fast` is §20.5's "fast field and document validation" on mutation. */
  scope: 'fast' | 'full'
  /** Does this moment also run reference checks (§20.5 publish, §19.7 promotion)? */
  referenceChecks: boolean
  /** `[MUST]` moments are required; the CI pass is `[SHOULD]`. */
  required: boolean
}

/**
 * PRD §20.5, as data rather than as scattered literals.
 *
 * ```text
 * [MUST] On document open: show current errors and warnings.
 * [MUST] On mutation: run fast field and document validation.
 * [MUST] On branch publish: run full document validation and reference checks.
 * [MUST] On checkpoint: validate every changed document.
 * [MUST] On promotion plan: validate every promoted document against target schema.
 * [SHOULD] In CI: validate canonical overlay files against the branch schema.
 * ```
 *
 * Promotion carries `referenceChecks` because §19.7 blocks promotion until
 * migration *and* validation pass, and a reference whose target type was rejected
 * is exactly what that gate is for.
 */
export const VALIDATION_TIMING_POLICY: Readonly<Record<ValidationTiming, ValidationTimingPolicy>> =
  Object.freeze({
    open: Object.freeze({scope: 'full', referenceChecks: false, required: true}),
    mutate: Object.freeze({scope: 'fast', referenceChecks: false, required: true}),
    publish: Object.freeze({scope: 'full', referenceChecks: true, required: true}),
    checkpoint: Object.freeze({scope: 'full', referenceChecks: false, required: true}),
    promotion: Object.freeze({scope: 'full', referenceChecks: true, required: true}),
    ci: Object.freeze({scope: 'full', referenceChecks: false, required: false}),
  } as const)

/** The §20.5 policy for one timing. */
export function validationPolicyFor(timing: ValidationTiming): ValidationTimingPolicy {
  return VALIDATION_TIMING_POLICY[timing]
}

/** Run the port, defaulting to the no-op validator. */
export function validateDocument(
  document: SanityDocument,
  context: OverlayValidationContext,
  validator: OverlayDocumentValidator = noopDocumentValidator,
): readonly OverlayValidationIssue[] {
  return validator(document, context)
}

/** Run several validators and concatenate their issues, in order. */
export function composeValidators(
  ...validators: readonly OverlayDocumentValidator[]
): OverlayDocumentValidator {
  return (document, context) =>
    validators.flatMap((validator) => [...validator(document, context)])
}

/** Only the blocking issues. */
export function validationErrors(
  issues: readonly OverlayValidationIssue[],
): OverlayValidationIssue[] {
  return issues.filter((issue) => issue.level === 'error')
}

/** Does anything here block a publish, checkpoint or promotion? */
export function hasValidationErrors(issues: readonly OverlayValidationIssue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}

/**
 * PRD §20.1 — a cached validation result is stale as soon as the schema commit it
 * was produced under is no longer the current one. An unknown cached commit is
 * always stale.
 */
export function isValidationStale(
  cachedSchemaCommit: string | undefined,
  currentSchemaCommit: string,
): boolean {
  return cachedSchemaCommit !== currentSchemaCommit
}

/** Document-action names (PRD §18.4-§18.9) mapped onto §20.5 timings. */
const ACTION_TIMING: Readonly<Record<string, ValidationTiming>> = Object.freeze({
  open: 'open',
  publish: 'publish',
  checkpoint: 'checkpoint',
  promotion: 'promotion',
  ci: 'ci',
})

/**
 * Adapt this port to the W2 document-action port (`ActionOptions.validate`).
 *
 * W2's `ValidationContext` names an *action*; §20.5 names a *timing*. Everything
 * that is not one of the documented full-validation moments is a mutation, which
 * §20.5 answers with the fast field and document pass.
 */
export function toDocumentValidator(
  validator: OverlayDocumentValidator,
  options: {schemaCommit?: string} = {},
): DocumentValidator {
  return (document: SanityDocument, context: ValidationContext) =>
    validator(document, {
      logicalId: context.logicalId,
      timing: ACTION_TIMING[context.action] ?? 'mutate',
      ...(options.schemaCommit === undefined ? {} : {schemaCommit: options.schemaCommit}),
    })
}
