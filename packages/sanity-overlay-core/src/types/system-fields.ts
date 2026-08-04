/**
 * PRD §13.9 — Synthetic system fields, as data (plan §4, "Also in scope for W1").
 *
 * The table below is the §13.9 policy table transcribed verbatim into a lookup so
 * later workstreams read one source instead of scattering literals.
 */

export type SyntheticFieldOrigin = 'base' | 'branch'

export type SyntheticSystemField = '_id' | '_type' | '_createdAt' | '_updatedAt' | '_rev'

export type SyntheticFieldRule =
  | 'preserve-logical-id-by-perspective'
  | 'generate-new-id-reserved-for-promotion'
  | 'preserve-unless-explicit-migration'
  | 'required-at-creation'
  | 'preserve-base-value'
  | 'set-once-at-branch-creation'
  | 'latest-local-mutation-time'
  | 'synthetic-overlay-revision'

export interface SyntheticSystemFieldPolicy {
  field: SyntheticSystemField
  /** Behaviour for a document whose origin is an existing base document. */
  base: {rule: SyntheticFieldRule; description: string}
  /** Behaviour for a branch-created document. */
  branch: {rule: SyntheticFieldRule; description: string}
}

export const SYNTHETIC_SYSTEM_FIELD_POLICY: readonly SyntheticSystemFieldPolicy[] = Object.freeze([
  {
    field: '_id',
    base: {
      rule: 'preserve-logical-id-by-perspective',
      description: 'Preserve logical Sanity ID or `drafts.` form by perspective',
    },
    branch: {
      rule: 'generate-new-id-reserved-for-promotion',
      description: 'Generate normal UUID-style ID; reserve it for promotion',
    },
  },
  {
    field: '_type',
    base: {
      rule: 'preserve-unless-explicit-migration',
      description: 'Preserve unless explicit migration creates a new document',
    },
    branch: {rule: 'required-at-creation', description: 'Required at creation'},
  },
  {
    field: '_createdAt',
    base: {rule: 'preserve-base-value', description: 'Preserve base value'},
    branch: {rule: 'set-once-at-branch-creation', description: 'Set once at branch creation'},
  },
  {
    field: '_updatedAt',
    base: {
      rule: 'latest-local-mutation-time',
      description: 'Set to latest local mutation time in virtual output',
    },
    branch: {
      rule: 'latest-local-mutation-time',
      description: 'Set to latest local mutation time',
    },
  },
  {
    field: '_rev',
    base: {
      rule: 'synthetic-overlay-revision',
      description: 'Return synthetic overlay revision when local state wins',
    },
    branch: {
      rule: 'synthetic-overlay-revision',
      description: 'Return synthetic overlay revision',
    },
  },
])

/** Look up the §13.9 rule for one field and document origin. */
export function syntheticSystemFieldRule(
  field: SyntheticSystemField,
  origin: SyntheticFieldOrigin,
): SyntheticFieldRule {
  const row = SYNTHETIC_SYSTEM_FIELD_POLICY.find((entry) => entry.field === field)
  /* istanbul ignore next -- the union makes this unreachable */
  if (!row) throw new Error(`Unknown synthetic system field ${field}`)
  return row[origin].rule
}
