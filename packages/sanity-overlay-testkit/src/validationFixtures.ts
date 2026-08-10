/**
 * The testkit's fixture validator (plan docs/plans/phase-2-core-domain.md §7
 * "Validation port", §8.6; PRD §17.3 step 9, §20.1, §20.3, §20.5).
 *
 * The plan requires "an injected port with a no-op default plus a fixture
 * validator in the testkit, so merge output can be tested without Studio". This is
 * that fixture validator: it reads nothing but the **serialized schema artifact**
 * (PRD §20.1) that core is contractually given, imports no Studio code, no
 * `sanity` package and no `@sanity/types`, and adds no dependency.
 *
 * It is deliberately a *fixture*, not a schema engine. It covers the three checks
 * PRD §20.3 lists that need no reference graph:
 *
 * - Base documents whose `_type` is not in branch schema.
 * - Required fields missing from resolved documents.
 * - Fields the artifact does not model (reported as a warning, since §20.2 keeps
 *   removed-field data in the document).
 *
 * The reference-shaped checks in §20.3 — disallowed target types, draft-only
 * strong targets — need overlay state, and live in core as
 * `referenceValidationIssues`.
 */
import type {
  OverlayDocumentValidator,
  OverlayValidationIssue,
  SerializedSchemaArtifact,
  SerializedSchemaField,
} from 'sanity-overlay-core/validation'
import type {SanityDocument} from 'sanity-overlay-core'

/**
 * A second artifact for the same fixture types with **no** required fields.
 *
 * Two artifacts over one document is how a test shows the verdict comes from the
 * injected artifact and from nothing else (PRD §20.1).
 */
export const RELAXED_SCHEMA: SerializedSchemaArtifact = {
  schemaCommit: 'schema-sha-relaxed',
  types: [
    {name: 'author', fields: [{name: 'name', type: 'string'}]},
    {name: 'editor', fields: [{name: 'name', type: 'string'}]},
    {
      name: 'page',
      fields: [
        {name: 'title', type: 'string'},
        {name: 'author', type: 'reference', to: ['author']},
        {name: 'editor', type: 'reference', weak: true, to: ['author', 'editor']},
        {name: 'related', type: 'array', of: [{type: 'reference', to: ['author']}]},
      ],
    },
    {name: 'review', fields: [{name: 'page', type: 'reference', to: ['page']}]},
  ],
}

function fieldsOf(
  schema: SerializedSchemaArtifact,
  typeName: string,
): readonly SerializedSchemaField[] | null {
  const type = schema.types.find((candidate) => candidate.name === typeName)
  if (type === undefined) return null
  return type.fields ?? []
}

/** Deterministic order: by path, then rule, then message. */
function sortIssues(issues: OverlayValidationIssue[]): OverlayValidationIssue[] {
  return issues.sort((a, b) => {
    const left = (a.path ?? []).join('.')
    const right = (b.path ?? []).join('.')
    if (left !== right) return left < right ? -1 : 1
    if (a.ruleId !== b.ruleId) return (a.ruleId ?? '') < (b.ruleId ?? '') ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

/**
 * Build a validator over one serialized schema artifact.
 *
 * Every timing (PRD §20.5) runs the same checks here; a real validator would
 * narrow the `fast` scope, but a fixture that behaved differently per timing would
 * make tests harder to read, not easier.
 */
export function createFixtureValidator(
  schema: SerializedSchemaArtifact,
): OverlayDocumentValidator {
  return (document: SanityDocument): readonly OverlayValidationIssue[] => {
    const fields = fieldsOf(schema, document._type)
    if (fields === null) {
      return [
        {
          level: 'error',
          ruleId: 'unknown-type',
          message: `Unknown document type ${JSON.stringify(document._type)}`,
        },
      ]
    }

    const issues: OverlayValidationIssue[] = []

    for (const field of fields) {
      if (field.required !== true || field.name === undefined) continue
      const value = (document as Record<string, unknown>)[field.name]
      if (value === undefined || value === null || value === '') {
        issues.push({
          level: 'error',
          ruleId: 'required',
          message: `Field ${JSON.stringify(field.name)} is required`,
          path: [field.name],
        })
      }
    }

    const known = new Set(
      fields.map((field) => field.name).filter((name): name is string => name !== undefined),
    )
    for (const key of Object.keys(document)) {
      // `_`-prefixed keys are system fields (PRD §13.9), never schema fields.
      if (key.startsWith('_') || known.has(key)) continue
      issues.push({
        level: 'warning',
        ruleId: 'unknown-field',
        message: `Field ${JSON.stringify(key)} is not in the schema artifact`,
        path: [key],
      })
    }

    return sortIssues(issues)
  }
}
