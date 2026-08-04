/**
 * Workstream W4 — validation port (plan §7 "Validation port"; PRD §17.3 step 9,
 * §20.1 schema source, §20.5 validation timing).
 *
 * Core consumes a **serialized schema artifact** and never imports Studio code
 * (PRD §10.1, §20.1). Everything here is therefore a port with a pure no-op
 * default; the fixture validator that exercises it lives in the testkit.
 */

export {
  EMPTY_SCHEMA_ARTIFACT,
  getSchemaType,
  referenceRuleAt,
  resolveFieldDefinition,
} from './schema'
export type {
  SerializedSchemaArtifact,
  SerializedSchemaField,
  SerializedSchemaType,
} from './schema'

export {
  VALIDATION_TIMINGS,
  VALIDATION_TIMING_POLICY,
  composeValidators,
  hasValidationErrors,
  isValidationStale,
  noopDocumentValidator,
  toDocumentValidator,
  validateDocument,
  validationErrors,
  validationPolicyFor,
} from './validator'
export type {
  OverlayDocumentValidator,
  OverlayValidationContext,
  OverlayValidationIssue,
  ValidationTiming,
  ValidationTimingPolicy,
} from './validator'
