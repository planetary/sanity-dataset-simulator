import {describe, expect, it} from 'vitest'
import {
  OverlayReferenceError,
  applyMigration,
  assertIdImmutable,
  assertMigrationValid,
  createBaseReverseSource,
  createStrongReferenceCheck,
  extractReferences,
  migrationMutations,
  planIdMigration,
  planTypeMigration,
} from '../../sanity-overlay-core/src/references/index'
import {
  applyTransaction,
  createBaseSource,
  createOverlayState,
  resolveDraft,
  resolvePublished,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState} from '../../sanity-overlay-core/src/index'
import {
  BASE_DOCUMENTS,
  BASE_REVERSE_HITS,
  REFERENCE_ACTOR,
  REFERENCE_INSTANT,
  REFERENCE_SCHEMA,
  createTransactionSource,
  fixedClock,
} from '../src/referenceFixtures'

// Phase 2 workstream W4 — ID and type migration plans (plan §7).
// PRD §19.6 ID changes, §19.7 type changes, §20.4 OverlayMigration,
// §35.6 reference tests 10 and 11.

const base = createBaseSource(BASE_DOCUMENTS)
const baseReferences = createBaseReverseSource(BASE_REVERSE_HITS)
const tx = createTransactionSource()

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w4'})
}

const planContext = {
  base,
  baseReferences,
  schema: REFERENCE_SCHEMA,
  actor: REFERENCE_ACTOR,
  now: fixedClock(),
}

/* ------------------------------------------------------------------ *
 * §19.6 — ID changes
 * ------------------------------------------------------------------ */

describe('planIdMigration (PRD §19.6, §20.4)', () => {
  it('10. (§35.6) the plan includes all incoming references', () => {
    const plan = planIdMigration(
      emptyState(),
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )

    expect(
      plan.incomingReferences.map((reference) => [
        reference.referringDocumentId,
        reference.path,
        reference.strength,
      ]),
    ).toEqual([
      ['page-1', ['author'], 'strong'],
      ['page-2', ['related', {_key: 'r1'}], 'strong'],
    ])
  })

  it('produces an OverlayMigration in the §20.4 shape', () => {
    const plan = planIdMigration(
      emptyState(),
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )

    expect(plan.migration.id).toBe('mig-001')
    expect(plan.migration.schemaCommitAfter).toBe('schema-sha-1')
    expect(plan.migration.affectedTypes).toEqual(['author', 'page'])
    expect(plan.migration.createdAt).toBe(REFERENCE_INSTANT)
    expect(plan.migration.createdBy).toEqual(REFERENCE_ACTOR)
    expect(plan.migration.operations.map((operation) => operation.documentId)).toEqual([
      'author-1-renamed',
      'page-1',
      'page-2',
      'author-1',
    ])
  })

  it('creates the new document and never mutates `_id` in place (§19.6, §17.10)', () => {
    const plan = planIdMigration(
      emptyState(),
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )
    const create = plan.migration.operations[0]?.mutations[0]

    expect(create).toMatchObject({
      type: 'create',
      document: {_id: 'author-1-renamed', _type: 'author', name: 'Grace Hopper'},
    })
    // Base revision metadata never travels to a new logical document.
    expect((create as {document: Record<string, unknown>}).document._rev).toBeUndefined()
  })

  it('rewrites each referrer by `_ref` alone, preserving `_key` and `_weak`', () => {
    const plan = planIdMigration(
      emptyState(),
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )

    expect(plan.migration.operations[2]?.mutations).toEqual([
      {
        type: 'patch',
        id: 'page-2',
        operations: [
          {type: 'set', path: ['related', {_key: 'r1'}, '_ref'], value: 'author-1-renamed'},
        ],
      },
    ])
  })

  it('preserves the old ID tombstone so the base document stays suppressed (§19.6)', () => {
    const plan = planIdMigration(
      emptyState(),
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )

    expect(plan.preservesOldIdTombstone).toBe(true)
    expect(plan.migration.operations[3]?.mutations).toEqual([{type: 'delete', id: 'author-1'}])
  })

  it('does not preserve a tombstone for a branch-created source', () => {
    const state = applyTransaction(
      emptyState(),
      [{type: 'create', document: {_id: 'author-7', _type: 'author', name: 'Branch only'}}],
      {...tx(), base},
    ).state

    expect(
      planIdMigration(state, {fromId: 'author-7', toId: 'author-8', migrationId: 'mig-002'}, planContext)
        .preservesOldIdTombstone,
    ).toBe(false)
  })

  it('never crawls and rewrites on its own — planning leaves state untouched (§19.6)', () => {
    const before = emptyState()
    planIdMigration(
      before,
      {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
      planContext,
    )

    expect(before.documents).toEqual({})
    expect(before.revision).toBe(0)
  })

  it('refuses a no-op rename and a colliding target ID', () => {
    expect(() =>
      planIdMigration(
        emptyState(),
        {fromId: 'author-1', toId: 'author-1', migrationId: 'mig-003'},
        planContext,
      ),
    ).toThrowError(OverlayReferenceError)

    expect(() =>
      planIdMigration(
        emptyState(),
        {fromId: 'author-1', toId: 'author-2', migrationId: 'mig-004'},
        planContext,
      ),
    ).toThrowError(/already exists/i)
  })

  it('refuses to plan for a source that does not resolve', () => {
    expect(() =>
      planIdMigration(
        emptyState(),
        {fromId: 'author-404', toId: 'author-405', migrationId: 'mig-005'},
        planContext,
      ),
    ).toThrowError(OverlayReferenceError)
  })

  it('assertIdImmutable rejects an in-lineage `_id` change (§19.6)', () => {
    expect(() => assertIdImmutable('author-1', 'author-1')).not.toThrow()
    expect(() => assertIdImmutable('author-1', 'drafts.author-1')).not.toThrow()

    let thrown: OverlayReferenceError | null = null
    try {
      assertIdImmutable('author-1', 'author-2')
    } catch (error) {
      thrown = error as OverlayReferenceError
    }
    expect(thrown).toBeInstanceOf(OverlayReferenceError)
    expect(thrown?.referenceCode).toBe('OVERLAY_ID_CHANGE_NOT_ALLOWED')
  })

  describe('applying an approved plan', () => {
    it('commits as one transaction, which is exactly why §18.8 permits the delete', () => {
      const state = emptyState()
      const plan = planIdMigration(
        state,
        {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
        planContext,
      )

      const result = applyMigration(state, plan.migration, {
        ...tx(),
        base,
        checkStrongReferences: createStrongReferenceCheck(state, {base, baseReferences}),
      })

      // One transaction, one revision increment (§34.5).
      expect(result.state.revision).toBe(1)
      expect(result.transaction.affectedDocumentIds.sort()).toEqual([
        'author-1',
        'author-1-renamed',
        'page-1',
        'page-2',
      ])

      // The old ID is suppressed and the new one resolves.
      expect(resolvePublished(result.state, 'author-1', {base})).toBeNull()
      expect(resolvePublished(result.state, 'author-1-renamed', {base})?.name).toBe('Grace Hopper')

      // Every incoming reference now points at the new ID.
      const page2 = resolveDraft(result.state, 'page-2', {base})
      expect(extractReferences(page2)[0]).toMatchObject({
        path: ['related', {_key: 'r1'}],
        targetId: 'author-1-renamed',
      })
      expect(page2?.related).toEqual([
        {_key: 'r1', _type: 'reference', _ref: 'author-1-renamed'},
      ])
    })

    it('is blocked without the plan: deleting the old ID alone invalidates referrers', () => {
      const state = emptyState()

      expect(() =>
        applyTransaction(state, [{type: 'delete', id: 'author-1'}], {
          ...tx(),
          base,
          checkStrongReferences: createStrongReferenceCheck(state, {base, baseReferences}),
        }),
      ).toThrowError(/strong reference/i)
    })

    it('migrationMutations flattens the plan in operation order', () => {
      const plan = planIdMigration(
        emptyState(),
        {fromId: 'author-1', toId: 'author-1-renamed', migrationId: 'mig-001'},
        planContext,
      )

      expect(migrationMutations(plan.migration).map((mutation) => mutation.type)).toEqual([
        'create',
        'patch',
        'patch',
        'delete',
      ])
    })
  })
})

/* ------------------------------------------------------------------ *
 * §19.7 — type changes
 * ------------------------------------------------------------------ */

describe('planTypeMigration (PRD §19.7)', () => {
  it('11. (§35.6) detects incompatible reference target definitions', () => {
    const plan = planTypeMigration(
      emptyState(),
      {documentId: 'author-1', toType: 'person', migrationId: 'mig-010'},
      planContext,
    )

    expect(plan.fromType).toBe('author')
    expect(plan.compatible).toBe(false)
    expect(plan.incompatibleReferences).toEqual([
      {
        referringDocumentId: 'page-1',
        referringType: 'page',
        path: ['author'],
        allowedTypes: ['author'],
        strength: 'strong',
      },
      {
        referringDocumentId: 'page-2',
        referringType: 'page',
        path: ['related', {_key: 'r1'}],
        allowedTypes: ['author'],
        strength: 'strong',
      },
    ])
  })

  it('accepts a new type that every referring field allows', () => {
    // `page.editor` allows `['author', 'editor']`, and only `page-1.editor`
    // points at `author-2`.
    const plan = planTypeMigration(
      emptyState(),
      {documentId: 'author-2', toType: 'editor', migrationId: 'mig-011'},
      planContext,
    )

    expect(plan.incomingReferences.map((reference) => reference.path)).toEqual([['editor']])
    expect(plan.incompatibleReferences).toEqual([])
    expect(plan.compatible).toBe(true)
  })

  it('treats a path the artifact says nothing about as no rule, not a violation', () => {
    const state = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'gadget-1',
            _type: 'gadget',
            owner: {_type: 'reference', _ref: 'author-2'},
          },
        },
      ],
      {...tx(), base},
    ).state

    const plan = planTypeMigration(
      state,
      {documentId: 'author-2', toType: 'editor', migrationId: 'mig-012'},
      planContext,
    )

    expect(plan.incomingReferences.map((reference) => reference.referringDocumentId)).toEqual([
      'gadget-1',
      'page-1',
    ])
    expect(plan.incompatibleReferences).toEqual([])
  })

  it('models the change as a full replacement, never an in-place `_type` set (§17.10)', () => {
    const plan = planTypeMigration(
      emptyState(),
      {documentId: 'author-2', toType: 'editor', migrationId: 'mig-011'},
      planContext,
    )

    expect(plan.migration.affectedTypes).toEqual(['author', 'editor'])
    expect(plan.migration.operations[0]?.mutations[0]).toMatchObject({
      type: 'patch',
      id: 'author-2',
      operations: [{type: 'replaceDocument', document: {_id: 'author-2', _type: 'editor'}}],
    })
  })

  it('applies only with explicit type-change intent (§17.10)', () => {
    const state = emptyState()
    const plan = planTypeMigration(
      state,
      {documentId: 'author-2', toType: 'editor', migrationId: 'mig-011'},
      planContext,
    )

    expect(() => applyMigration(state, plan.migration, {...tx(), base})).toThrowError(
      /explicit intent/i,
    )

    const result = applyMigration(state, plan.migration, {...tx(), base, allowTypeChange: true})
    expect(resolvePublished(result.state, 'author-2', {base})?._type).toBe('editor')
  })

  it('assertMigrationValid blocks an incompatible plan (§19.7)', () => {
    const bad = planTypeMigration(
      emptyState(),
      {documentId: 'author-1', toType: 'person', migrationId: 'mig-010'},
      planContext,
    )
    const good = planTypeMigration(
      emptyState(),
      {documentId: 'author-2', toType: 'editor', migrationId: 'mig-011'},
      planContext,
    )

    let thrown: OverlayReferenceError | null = null
    try {
      assertMigrationValid(bad)
    } catch (error) {
      thrown = error as OverlayReferenceError
    }
    expect(thrown).toBeInstanceOf(OverlayReferenceError)
    expect(thrown?.referenceCode).toBe('OVERLAY_MIGRATION_INVALID')
    expect(thrown?.details).toMatchObject({documentId: 'author-1', toType: 'person'})

    expect(assertMigrationValid(good)).toBe(good)
  })

  it('refuses a no-op type change and an unresolvable document', () => {
    expect(() =>
      planTypeMigration(
        emptyState(),
        {documentId: 'author-1', toType: 'author', migrationId: 'mig-013'},
        planContext,
      ),
    ).toThrowError(OverlayReferenceError)

    expect(() =>
      planTypeMigration(
        emptyState(),
        {documentId: 'author-404', toType: 'person', migrationId: 'mig-014'},
        planContext,
      ),
    ).toThrowError(OverlayReferenceError)
  })
})
