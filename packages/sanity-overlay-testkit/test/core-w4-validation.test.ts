import {describe, expect, it} from 'vitest'
import {
  EMPTY_SCHEMA_ARTIFACT,
  VALIDATION_TIMINGS,
  composeValidators,
  hasValidationErrors,
  isValidationStale,
  noopDocumentValidator,
  toDocumentValidator,
  validateDocument,
  validationErrors,
  validationPolicyFor,
} from '../../sanity-overlay-core/src/validation/index'
import type {
  OverlayDocumentValidator,
  OverlayValidationIssue,
  ValidationTiming,
} from '../../sanity-overlay-core/src/validation/index'
import {
  createBaseReverseSource,
  createStrongReferenceCheck,
  referenceValidationIssues,
} from '../../sanity-overlay-core/src/references/index'
import {
  OverlayActionBlockedError,
  applyTransaction,
  createBaseSource,
  createOverlayState,
  edit,
  publish,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState, SanityDocument} from '../../sanity-overlay-core/src/index'
import {
  BASE_DOCUMENTS,
  BASE_REVERSE_HITS,
  REFERENCE_SCHEMA,
  createTransactionSource,
} from '../src/referenceFixtures'
import {
  RELAXED_SCHEMA,
  createFixtureValidator,
} from '../src/validationFixtures'

// Phase 2 workstream W4 — the validation port (plan §7 "Validation port").
// PRD §17.3 step 9, §20.1 schema source, §20.3 compatibility scan, §20.5 timing.

const base = createBaseSource(BASE_DOCUMENTS)
const baseReferences = createBaseReverseSource(BASE_REVERSE_HITS)
const tx = createTransactionSource()

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w4'})
}

/* ------------------------------------------------------------------ *
 * The port itself
 * ------------------------------------------------------------------ */

describe('validation port (PRD §17.3 step 9, §20.1)', () => {
  it('defaults to a no-op validator, so merge output is testable without Studio', () => {
    expect(noopDocumentValidator({_id: 'a', _type: 'author'}, {logicalId: 'a', timing: 'open'})).toEqual(
      [],
    )
    expect(validateDocument({_id: 'a', _type: 'author'}, {logicalId: 'a', timing: 'open'})).toEqual([])
  })

  it('hands the injected validator the document and the full context', () => {
    const seen: Array<{id: string; timing: ValidationTiming; commit?: string}> = []
    const validator: OverlayDocumentValidator = (document, context) => {
      seen.push({
        id: document._id,
        timing: context.timing,
        ...(context.schemaCommit === undefined ? {} : {commit: context.schemaCommit}),
      })
      return []
    }

    validateDocument(
      {_id: 'author-1', _type: 'author'},
      {logicalId: 'author-1', timing: 'publish', schemaCommit: 'schema-sha-1'},
      validator,
    )

    expect(seen).toEqual([{id: 'author-1', timing: 'publish', commit: 'schema-sha-1'}])
  })

  it('consumes a serialized schema artifact only — two artifacts, two verdicts', () => {
    const document: SanityDocument = {_id: 'author-1', _type: 'author'}

    expect(hasValidationErrors(createFixtureValidator(REFERENCE_SCHEMA)(document, {
      logicalId: 'author-1',
      timing: 'open',
    }))).toBe(true)
    expect(
      createFixtureValidator(RELAXED_SCHEMA)(document, {logicalId: 'author-1', timing: 'open'}),
    ).toEqual([])
    expect(EMPTY_SCHEMA_ARTIFACT.types).toEqual([])
  })

  it('composes validators in order', () => {
    const first: OverlayDocumentValidator = () => [{level: 'warning', message: 'first'}]
    const second: OverlayDocumentValidator = () => [{level: 'error', message: 'second'}]

    expect(
      composeValidators(first, second)({_id: 'a', _type: 'author'}, {logicalId: 'a', timing: 'open'}),
    ).toEqual([
      {level: 'warning', message: 'first'},
      {level: 'error', message: 'second'},
    ])
  })

  it('separates errors from warnings', () => {
    const issues: OverlayValidationIssue[] = [
      {level: 'warning', message: 'w'},
      {level: 'error', message: 'e'},
    ]

    expect(validationErrors(issues)).toEqual([{level: 'error', message: 'e'}])
    expect(hasValidationErrors(issues)).toBe(true)
    expect(hasValidationErrors([{level: 'warning', message: 'w'}])).toBe(false)
  })

  it('invalidates cached results when the schema commit changes (§20.1)', () => {
    expect(isValidationStale('schema-sha-1', 'schema-sha-1')).toBe(false)
    expect(isValidationStale('schema-sha-1', 'schema-sha-2')).toBe(true)
    expect(isValidationStale(undefined, 'schema-sha-1')).toBe(true)
  })

  describe('timing hooks (PRD §20.5)', () => {
    it('models every documented hook', () => {
      expect([...VALIDATION_TIMINGS]).toEqual([
        'open',
        'mutate',
        'publish',
        'checkpoint',
        'promotion',
        'ci',
      ])
    })

    it('runs fast field validation on mutation and full validation on publish', () => {
      expect(validationPolicyFor('mutate')).toEqual({
        scope: 'fast',
        referenceChecks: false,
        required: true,
      })
      expect(validationPolicyFor('publish')).toEqual({
        scope: 'full',
        referenceChecks: true,
        required: true,
      })
    })

    it('marks CI validation as [SHOULD], not [MUST]', () => {
      expect(validationPolicyFor('ci').required).toBe(false)
      expect(validationPolicyFor('checkpoint').required).toBe(true)
    })
  })

  it('adapts to the W2 document-action port and blocks a publish on errors', () => {
    const state = edit(
      emptyState(),
      {id: 'author-1', operations: [{type: 'unset', path: ['name']}]},
      {...tx(), base},
    ).state

    expect(() =>
      publish(state, {id: 'author-1'}, {
        ...tx(),
        base,
        validate: toDocumentValidator(createFixtureValidator(REFERENCE_SCHEMA)),
      }),
    ).toThrowError(OverlayActionBlockedError)

    expect(() =>
      publish(state, {id: 'author-1'}, {
        ...tx(),
        base,
        validate: toDocumentValidator(createFixtureValidator(RELAXED_SCHEMA)),
      }),
    ).not.toThrow()
  })

  it('maps the action name onto the §20.5 timing', () => {
    const seen: ValidationTiming[] = []
    const adapted = toDocumentValidator((_document, context) => {
      seen.push(context.timing)
      return []
    })

    adapted({_id: 'a', _type: 'author'}, {logicalId: 'a', action: 'publish'})
    adapted({_id: 'a', _type: 'author'}, {logicalId: 'a', action: 'edit'})

    expect(seen).toEqual(['publish', 'mutate'])
  })
})

/* ------------------------------------------------------------------ *
 * The testkit fixture validator
 * ------------------------------------------------------------------ */

describe('fixture validator (testkit)', () => {
  const validate = createFixtureValidator(REFERENCE_SCHEMA)

  it('flags a missing required field with its path', () => {
    expect(validate({_id: 'page-9', _type: 'page'}, {logicalId: 'page-9', timing: 'open'})).toEqual([
      {level: 'error', ruleId: 'required', message: 'Field "title" is required', path: ['title']},
    ])
  })

  it('flags a document type the artifact does not know', () => {
    expect(
      validate({_id: 'x-1', _type: 'gadget'}, {logicalId: 'x-1', timing: 'open'}),
    ).toEqual([
      {level: 'error', ruleId: 'unknown-type', message: 'Unknown document type "gadget"'},
    ])
  })

  it('warns about a field the artifact does not model', () => {
    expect(
      validate(
        {_id: 'author-1', _type: 'author', name: 'Grace Hopper', nickname: 'Amazing Grace'},
        {logicalId: 'author-1', timing: 'open'},
      ),
    ).toEqual([
      {
        level: 'warning',
        ruleId: 'unknown-field',
        message: 'Field "nickname" is not in the schema artifact',
        path: ['nickname'],
      },
    ])
  })

  it('accepts a document that satisfies the artifact', () => {
    expect(
      validate(
        {_id: 'author-1', _type: 'author', name: 'Grace Hopper'},
        {logicalId: 'author-1', timing: 'open'},
      ),
    ).toEqual([])
  })

  it('is deterministic across key insertion order', () => {
    const a: SanityDocument = {_id: 'p', _type: 'page', zeta: 1, alpha: 2}
    const b: SanityDocument = {_id: 'p', _type: 'page', alpha: 2, zeta: 1}

    expect(validate(a, {logicalId: 'p', timing: 'open'})).toEqual(
      validate(b, {logicalId: 'p', timing: 'open'}),
    )
  })
})

/* ------------------------------------------------------------------ *
 * Reference checks at publish (PRD §20.5, §20.3, §19.5)
 * ------------------------------------------------------------------ */

describe('referenceValidationIssues (PRD §20.5 publish, §20.3)', () => {
  it('reports a strong reference to a draft-only target as an error', () => {
    const created = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'drafts.author-9', _type: 'author', name: 'Draft only'}}],
      {...tx(), base},
    ).state
    const state = edit(
      created,
      {
        id: 'page-1',
        operations: [{type: 'set', path: ['author'], value: {_type: 'reference', _ref: 'author-9'}}],
      },
      {...tx(), base},
    ).state

    expect(
      referenceValidationIssues(state, 'page-1', {base, schema: REFERENCE_SCHEMA}),
    ).toEqual([
      {
        level: 'error',
        ruleId: 'reference-not-published',
        message:
          'Strong reference at "author" targets "author-9", which has no published virtual document',
        path: ['author'],
      },
    ])
  })

  it('reports a weak reference to a missing target as a warning, not an error', () => {
    const state = edit(
      emptyState(),
      {
        id: 'page-1',
        operations: [
          {
            type: 'set',
            path: ['author'],
            value: {_type: 'reference', _ref: 'author-404', _weak: true},
          },
        ],
      },
      {...tx(), base},
    ).state

    const issues = referenceValidationIssues(state, 'page-1', {base, schema: REFERENCE_SCHEMA})
    expect(issues.map((issue) => issue.level)).toEqual(['warning'])
    expect(hasValidationErrors(issues)).toBe(false)
  })

  it('reports a reference to a disallowed target type (§20.3, §19.7)', () => {
    const state = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'page-x',
            _type: 'page',
            title: 'Wrong target',
            author: {_type: 'reference', _ref: 'review-1'},
          },
        },
      ],
      {...tx(), base},
    ).state

    expect(referenceValidationIssues(state, 'page-x', {base, schema: REFERENCE_SCHEMA})).toEqual([
      {
        level: 'error',
        ruleId: 'reference-type-not-allowed',
        message: 'Reference at "author" targets type "review", which is not in ["author"]',
        path: ['author'],
      },
    ])
  })

  it('accepts a document whose references all resolve to allowed published targets', () => {
    expect(referenceValidationIssues(emptyState(), 'page-1', {base, schema: REFERENCE_SCHEMA})).toEqual(
      [],
    )
  })

  it('is what §20.5 adds at publish: a valid document with a broken reference still blocks', () => {
    const created = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'drafts.author-9', _type: 'author', name: 'Draft only'}}],
      {...tx(), base},
    ).state
    const state = edit(
      created,
      {
        id: 'page-1',
        operations: [{type: 'set', path: ['author'], value: {_type: 'reference', _ref: 'author-9'}}],
      },
      {...tx(), base},
    ).state

    // The document itself validates against the artifact...
    expect(
      createFixtureValidator(REFERENCE_SCHEMA)(
        {_id: 'page-1', _type: 'page', title: 'Compilers'},
        {logicalId: 'page-1', timing: 'publish'},
      ),
    ).toEqual([])

    // ...but the reference check blocks the publish (§19.5, §34.10).
    expect(() =>
      publish(state, {id: 'page-1'}, {
        ...tx(),
        base,
        validate: toDocumentValidator(createFixtureValidator(REFERENCE_SCHEMA)),
        checkStrongReferences: createStrongReferenceCheck(state, {
          base,
          baseReferences,
          schema: REFERENCE_SCHEMA,
        }),
      }),
    ).toThrowError(OverlayActionBlockedError)
  })
})
