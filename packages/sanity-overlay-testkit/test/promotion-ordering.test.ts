import {describe, expect, it} from 'vitest'
import {
  PROMOTION_PHASE_BY_TYPE,
  checkOperationOrdering,
  createTargetRevisionSource,
  orderPromotionOperations,
  planPromotion,
  promotionReferenceEdges,
} from '../../sanity-overlay-core/src/promotion/index'
import type {
  PromotionOperation,
  PromotionReferenceEdge,
} from '../../sanity-overlay-core/src/promotion/index'
import {createOverlayState} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayDocumentRecord,
  SanityDocument,
  SerializedSchemaArtifact,
} from '../../sanity-overlay-core/src/index'
import {localVersion, overlayRecord} from '../src/mergeFixtures'

// Phase 8 — operation ordering (PRD §30.7, §18.8 strong-reference rule, §19.5).
//
// The phase table alone is not enough: two creates share phase 2, and if one
// references the other the target has to exist first. Every expectation below is
// written from §30.7 and §18.8 directly, and `checkOperationOrdering` re-derives
// the constraints without reusing the sort.

const NOW = '2026-08-04T10:00:00.000Z'
const ACTOR: OverlayActor = {type: 'user', id: 'publisher-1'}

const SCHEMA: SerializedSchemaArtifact = {
  schemaCommit: 'schema-sha-1',
  types: [
    {name: 'author', fields: [{name: 'name', type: 'string'}]},
    {
      name: 'page',
      fields: [
        {name: 'title', type: 'string'},
        {name: 'author', type: 'reference', to: ['author']},
        {name: 'editor', type: 'reference', weak: true, to: ['author']},
      ],
    },
  ],
}

function documentOperation(
  type: PromotionOperation['type'],
  logicalId: string,
  extra: Record<string, unknown> = {},
): PromotionOperation {
  return {
    id: `${type}:${logicalId}`,
    type,
    logicalId,
    targetId: logicalId,
    version: 'published',
    schemaType: 'page',
    phase: 3,
    precondition: {kind: 'absent'},
    ...extra,
  } as PromotionOperation
}

function typesAndIds(operations: readonly PromotionOperation[]): string[] {
  return operations.map((operation) =>
    operation.type === 'upload-asset'
      ? `upload-asset:${operation.assetId}`
      : `${operation.type}:${operation.logicalId}`,
  )
}

/* ------------------------------------------------------------------ *
 * §30.7 — the phase table
 * ------------------------------------------------------------------ */

describe('PRD §30.7 phase table', () => {
  it('numbers each operation type with the §30.7 step that runs it', () => {
    expect(PROMOTION_PHASE_BY_TYPE).toMatchObject({
      'upload-asset': 1,
      'create-published': 2,
      'create-draft': 2,
      'patch-draft': 3,
      'patch-published': 3,
      publish: 5,
      unpublish: 6,
      delete: 7,
    })
  })

  it('runs assets, creates, patches, publishes, unpublishes and deletes in that order', () => {
    const unordered: PromotionOperation[] = [
      documentOperation('delete', 'doc-delete'),
      documentOperation('publish', 'doc-publish', {reason: 'branch-published'}),
      documentOperation('create-published', 'doc-create', {document: {_id: 'x', _type: 'page'}}),
      {id: 'upload-asset:asset-1', type: 'upload-asset', phase: 1, assetId: 'asset-1', kind: 'image'},
      documentOperation('unpublish', 'doc-unpublish'),
      documentOperation('patch-published', 'doc-patch', {operations: []}),
    ]

    const {operations} = orderPromotionOperations(unordered)

    expect(typesAndIds(operations)).toEqual([
      'upload-asset:asset-1',
      'create-published:doc-create',
      'patch-published:doc-patch',
      'publish:doc-publish',
      'unpublish:doc-unpublish',
      'delete:doc-delete',
    ])
  })
})

/* ------------------------------------------------------------------ *
 * §30.7 step 2 + §18.8 — reference constraints inside a phase
 * ------------------------------------------------------------------ */

describe('orderPromotionOperations — reference constraints', () => {
  const edges: PromotionReferenceEdge[] = [
    {from: 'alpha-page', to: 'zulu-author', strength: 'strong', path: ['author']},
  ]

  it('creates a reference target before the document that references it', () => {
    const unordered = [
      documentOperation('create-published', 'alpha-page', {document: {_id: 'alpha-page', _type: 'page'}}),
      documentOperation('create-published', 'zulu-author', {document: {_id: 'zulu-author', _type: 'author'}}),
    ]

    const {operations} = orderPromotionOperations(unordered, {edges})

    // Lexicographic order would put `alpha-page` first; §18.8 does not.
    expect(typesAndIds(operations)).toEqual([
      'create-published:zulu-author',
      'create-published:alpha-page',
    ])
  })

  it('deletes the referring document before the document it references', () => {
    const deleteEdges: PromotionReferenceEdge[] = [
      {from: 'zulu-page', to: 'alpha-author', strength: 'strong', path: ['author']},
    ]
    const unordered = [
      documentOperation('delete', 'alpha-author'),
      documentOperation('delete', 'zulu-page'),
    ]

    const {operations} = orderPromotionOperations(unordered, {edges: deleteEdges})

    expect(typesAndIds(operations)).toEqual(['delete:zulu-page', 'delete:alpha-author'])
  })

  it('publishes a strong-reference target before dependent publishes (§30.7 steps 4-5)', () => {
    const unordered = [
      documentOperation('publish', 'alpha-page', {reason: 'branch-published'}),
      documentOperation('publish', 'zulu-author', {reason: 'strong-reference-target'}),
    ]

    const {operations} = orderPromotionOperations(unordered, {
      edges,
      strongReferenceTargets: ['zulu-author'],
    })

    expect(typesAndIds(operations)).toEqual(['publish:zulu-author', 'publish:alpha-page'])
    expect(operations[0]?.phase).toBe(4)
    expect(operations[1]?.phase).toBe(5)
  })

  it('reports a cycle rather than silently emitting an unsafe order', () => {
    const cyclic: PromotionReferenceEdge[] = [
      {from: 'a-doc', to: 'b-doc', strength: 'strong'},
      {from: 'b-doc', to: 'a-doc', strength: 'strong'},
    ]
    const unordered = [
      documentOperation('create-published', 'a-doc', {document: {_id: 'a-doc', _type: 'page'}}),
      documentOperation('create-published', 'b-doc', {document: {_id: 'b-doc', _type: 'page'}}),
    ]

    const {issues} = orderPromotionOperations(unordered, {edges: cyclic})

    expect(issues).toEqual([
      expect.objectContaining({code: 'ORDERING_CYCLE', logicalIds: ['a-doc', 'b-doc']}),
    ])
  })

  it('ignores edges whose endpoints are not both in the phase', () => {
    const unordered = [
      documentOperation('create-published', 'alpha-page', {document: {_id: 'alpha-page', _type: 'page'}}),
    ]

    const {operations, issues} = orderPromotionOperations(unordered, {edges})

    expect(typesAndIds(operations)).toEqual(['create-published:alpha-page'])
    expect(issues).toEqual([])
  })

  it('is deterministic for identical inputs', () => {
    const unordered = [
      documentOperation('create-published', 'alpha-page', {document: {_id: 'alpha-page', _type: 'page'}}),
      documentOperation('create-published', 'zulu-author', {document: {_id: 'zulu-author', _type: 'author'}}),
      documentOperation('delete', 'mike-old'),
    ]

    expect(JSON.stringify(orderPromotionOperations(unordered, {edges}))).toBe(
      JSON.stringify(orderPromotionOperations(unordered, {edges})),
    )
  })
})

/* ------------------------------------------------------------------ *
 * The independent oracle
 * ------------------------------------------------------------------ */

describe('checkOperationOrdering — independent §30.7 oracle', () => {
  const edges: PromotionReferenceEdge[] = [
    {from: 'alpha-page', to: 'zulu-author', strength: 'strong'},
  ]

  it('accepts an order the sort produced', () => {
    const unordered = [
      documentOperation('create-published', 'alpha-page', {document: {_id: 'alpha-page', _type: 'page'}}),
      documentOperation('create-published', 'zulu-author', {document: {_id: 'zulu-author', _type: 'author'}}),
    ]
    const {operations} = orderPromotionOperations(unordered, {edges})

    expect(checkOperationOrdering(operations, {edges})).toEqual([])
  })

  it('rejects a referrer created before its reference target', () => {
    const violating = [
      documentOperation('create-published', 'alpha-page', {document: {_id: 'alpha-page', _type: 'page'}}),
      documentOperation('create-published', 'zulu-author', {document: {_id: 'zulu-author', _type: 'author'}}),
    ]

    expect(checkOperationOrdering(violating, {edges})).toEqual([
      expect.stringContaining('alpha-page'),
    ])
  })

  it('rejects a delete that runs before the referring document is patched', () => {
    const violating = [
      documentOperation('delete', 'zulu-author'),
      documentOperation('patch-published', 'alpha-page', {operations: []}),
    ]

    expect(checkOperationOrdering(violating, {edges}).length).toBeGreaterThan(0)
  })

  it('rejects an inverted phase sequence', () => {
    const violating = [
      documentOperation('delete', 'doc-a'),
      documentOperation('create-published', 'doc-b', {document: {_id: 'doc-b', _type: 'page'}}),
    ]

    expect(checkOperationOrdering(violating)).toEqual([expect.stringContaining('§30.7')])
  })
})

/* ------------------------------------------------------------------ *
 * Edge derivation, and the planner end to end
 * ------------------------------------------------------------------ */

describe('promotionReferenceEdges (PRD §19.1)', () => {
  it('derives edges from the proposed documents, not from a naming convention', () => {
    const page: SanityDocument = {
      _id: 'alpha-page',
      _type: 'page',
      title: 'Page',
      author: {_type: 'reference', _ref: 'zulu-author'},
      editor: {_type: 'reference', _ref: 'yankee-editor'},
    }

    expect(promotionReferenceEdges([{logicalId: 'alpha-page', document: page}], SCHEMA)).toEqual([
      {from: 'alpha-page', to: 'yankee-editor', strength: 'weak', path: ['editor']},
      {from: 'alpha-page', to: 'zulu-author', strength: 'strong', path: ['author']},
    ])
  })

  // Same defect class as the keyed-array reorder comparison in `patch.ts`: an
  // identity built by joining parts with a separator collides whenever a part
  // can contain the separator. Here the dedup key was `from + ' ' + to + ' ' +
  // path`, so the distinct edges (a -> "b c") and ("a b" -> c) produced the
  // identical key "a b c ref" and the second was silently dropped — losing an
  // ordering constraint, which is how a referrer gets written before its target.
  it('keeps distinct edges whose ids collide under naive separator joining', () => {
    const first: SanityDocument = {
      _id: 'a',
      _type: 'page',
      ref: {_type: 'reference', _ref: 'b c'},
    }
    const second: SanityDocument = {
      _id: 'a b',
      _type: 'page',
      ref: {_type: 'reference', _ref: 'c'},
    }

    const edges = promotionReferenceEdges([
      {logicalId: 'a', document: first},
      {logicalId: 'a b', document: second},
    ])

    // Independent oracle: two documents, one reference each, two edges.
    expect(edges).toHaveLength(2)
    expect(edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['a', 'b c'],
      ['a b', 'c'],
    ])
  })
})

describe('planPromotion — ordering end to end (PRD §30.7, §18.8)', () => {
  function branchRecord(
    logicalId: string,
    schemaType: string,
    document: SanityDocument,
  ): OverlayDocumentRecord {
    return overlayRecord({
      logicalId,
      schemaType,
      origin: 'branch',
      localPublished: localVersion(document, {
        ancestorKind: 'branch-created',
        overlayRevision: '7',
      }),
    })
  }

  const author = branchRecord('zulu-author', 'author', {
    _id: 'zulu-author',
    _type: 'author',
    _rev: 'overlay:7:aaaa',
    name: 'Zed',
  })
  const page = branchRecord('alpha-page', 'page', {
    _id: 'alpha-page',
    _type: 'page',
    _rev: 'overlay:7:bbbb',
    title: 'Alpha',
    author: {_type: 'reference', _ref: 'zulu-author'},
  })

  function plan(records: readonly OverlayDocumentRecord[], targets: readonly SanityDocument[] = []) {
    return planPromotion(
      {
        state: createOverlayState({
          overlayId: 'overlay-promo',
          revision: 7,
          documents: Object.fromEntries(records.map((record) => [record.logicalId, record])),
        }),
        overlayId: 'overlay-promo',
        overlayRevision: 7,
        actor: ACTOR,
        target: {projectId: 'proj-1', dataset: 'staging'},
      },
      {
        targetRevisions: createTargetRevisionSource([...targets]),
        now: () => NOW,
        schema: SCHEMA,
      },
    )
  }

  it('creates the referenced author before the page that references it', () => {
    const result = plan([page, author])

    expect(typesAndIds(result.operations)).toEqual([
      'create-published:zulu-author',
      'create-published:alpha-page',
    ])
  })

  it('passes its own §30.7 oracle', () => {
    const result = plan([page, author])
    const edges = promotionReferenceEdges(
      result.documents.map((entry) => ({
        logicalId: entry.logicalId,
        document: entry.proposed.published,
      })),
      SCHEMA,
    )

    expect(checkOperationOrdering(result.operations, {edges})).toEqual([])
  })

  it('records the reference impact of a target the plan itself creates (§30.5)', () => {
    const result = plan([page, author])
    const entry = result.documents.find((document) => document.logicalId === 'alpha-page')

    expect(entry?.references).toEqual([
      {
        version: 'published',
        path: ['author'],
        targetId: 'zulu-author',
        strength: 'strong',
        status: 'created-by-plan',
      },
    ])
  })

  it('blocks when a strong reference target is neither in staging nor in the plan', () => {
    const orphan = branchRecord('alpha-page', 'page', {
      _id: 'alpha-page',
      _type: 'page',
      _rev: 'overlay:7:bbbb',
      title: 'Alpha',
      author: {_type: 'reference', _ref: 'missing-author'},
    })

    const result = plan([orphan])

    expect(result.blocked).toBe(true)
    expect(result.blockers.map((blocker) => blocker.code)).toContain('STRONG_REFERENCE_INVALID')
  })

  it('does not block on a weak reference to a missing target (PRD §19.5)', () => {
    const weak = branchRecord('alpha-page', 'page', {
      _id: 'alpha-page',
      _type: 'page',
      _rev: 'overlay:7:bbbb',
      title: 'Alpha',
      editor: {_type: 'reference', _ref: 'missing-editor'},
    })

    const result = plan([weak])

    expect(result.blockers.map((blocker) => blocker.code)).not.toContain(
      'STRONG_REFERENCE_INVALID',
    )
    expect(result.blocked).toBe(false)
  })

  it('publishes a draft-only strong-reference target instead of leaving it dangling (§30.7 step 4)', () => {
    const draftOnlyAuthor = overlayRecord({
      logicalId: 'zulu-author',
      schemaType: 'author',
      origin: 'branch',
      localDraft: localVersion(
        {_id: 'drafts.zulu-author', _type: 'author', _rev: 'overlay:7:cccc', name: 'Zed'},
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })

    const result = plan([page, draftOnlyAuthor])

    expect(typesAndIds(result.operations)).toEqual([
      'create-draft:zulu-author',
      'create-published:alpha-page',
      'publish:zulu-author',
    ])
    expect(result.operations[2]).toMatchObject({phase: 4, reason: 'strong-reference-target'})
  })
})
