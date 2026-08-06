import {describe, expect, it} from 'vitest'
import {
  createTargetRevisionSource,
  planPromotion,
} from '../../sanity-overlay-core/src/promotion/index'
import type {
  PromotionDocumentOperation,
  PromotionPlanRequest,
  PromotionPorts,
} from '../../sanity-overlay-core/src/promotion/index'
import {createOverlayState} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayDocumentRecord,
  OverlayState,
  SanityDocument,
  SerializedSchemaArtifact,
} from '../../sanity-overlay-core/src/index'
import {localVersion, overlayRecord} from '../src/mergeFixtures'

// Phase 8 — the promotion plan model (PRD §30.2-§30.5, §8.7, roadmap Phase 8).
//
// Everything here is *planning*. No test in this file writes to a dataset, and
// core has no code path that could: the current staging state arrives entirely
// through the injected `targetRevisions` port.

const NOW = '2026-08-04T10:00:00.000Z'
const ACTOR: OverlayActor = {type: 'user', id: 'publisher-1', displayName: 'Pat'}

const ANCESTOR: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'staging-1',
  title: 'Ancestor title',
  summary: 'Ancestor summary',
}

const SCHEMA: SerializedSchemaArtifact = {
  schemaCommit: 'schema-sha-1',
  types: [
    {
      name: 'article',
      fields: [
        {name: 'title', type: 'string', required: true},
        {name: 'summary', type: 'string'},
        {name: 'author', type: 'reference', to: ['author']},
      ],
    },
    {name: 'author', fields: [{name: 'name', type: 'string', required: true}]},
  ],
}

function stateWith(records: readonly OverlayDocumentRecord[], revision = 7): OverlayState {
  return createOverlayState({
    overlayId: 'overlay-promo',
    revision,
    documents: Object.fromEntries(records.map((record) => [record.logicalId, record])),
  })
}

function ports(overrides: Partial<PromotionPorts> = {}): PromotionPorts {
  return {
    targetRevisions: createTargetRevisionSource([]),
    now: () => NOW,
    ...overrides,
  }
}

function request(state: OverlayState, overrides: Partial<PromotionPlanRequest> = {}) {
  return {
    state,
    overlayId: 'overlay-promo',
    overlayRevision: state.revision,
    actor: ACTOR,
    target: {projectId: 'proj-1', dataset: 'staging'},
    sourceSchemaCommitSha: 'schema-sha-1',
    ...overrides,
  } satisfies PromotionPlanRequest
}

/** A record whose branch changed `title` only, against {@link ANCESTOR}. */
function touchedArticle(title = 'Branch title'): OverlayDocumentRecord {
  return overlayRecord({
    logicalId: 'article-1',
    schemaType: 'article',
    ancestorPublished: ANCESTOR,
    localPublished: localVersion(
      {...ANCESTOR, _rev: 'overlay:7:aaaa', title},
      {touchedPaths: [['title']], operations: [{type: 'set', path: ['title'], value: title}], overlayRevision: '7'},
    ),
  })
}

function documentOperations(operations: readonly unknown[]): PromotionDocumentOperation[] {
  return operations.filter(
    (operation): operation is PromotionDocumentOperation =>
      (operation as {type: string}).type !== 'upload-asset',
  )
}

/* ------------------------------------------------------------------ *
 * §30.4 step 3 — target revision fetch, as an injected port
 * ------------------------------------------------------------------ */

describe('planPromotion — target revision capture (PRD §30.4 step 3)', () => {
  it('asks the injected port for exactly the overlay documents it plans', () => {
    const asked: string[][] = []
    const source = createTargetRevisionSource([ANCESTOR])

    planPromotion(
      request(stateWith([touchedArticle()])),
      ports({
        targetRevisions: (ids) => {
          asked.push([...ids])
          return source(ids)
        },
      }),
    )

    expect(asked).toEqual([['article-1']])
  })

  it('records the observed target revisions and observation time on the plan', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(plan.target).toMatchObject({
      projectId: 'proj-1',
      dataset: 'staging',
      observedAt: NOW,
      revisions: {'article-1': {published: 'staging-1', draft: null}},
    })
  })

  it('carries the observed revision into the operation as its own precondition', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(documentOperations(plan.operations)).toEqual([
      expect.objectContaining({
        type: 'patch-published',
        logicalId: 'article-1',
        targetId: 'article-1',
        precondition: {kind: 'revision', revision: 'staging-1'},
      }),
    ])
  })

  it('rejects a target document with no revision — a revision guard cannot be built', () => {
    expect(() => createTargetRevisionSource([{_id: 'article-1', _type: 'article'}])).toThrow(
      /_rev/,
    )
  })
})

/* ------------------------------------------------------------------ *
 * §30.4 steps 4-5 — recompute against *current* staging, not the ancestor
 * ------------------------------------------------------------------ */

describe('planPromotion — conflict recomputation (PRD §30.4 steps 4-5)', () => {
  it('raises no conflict when staging still holds the captured ancestor', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(plan.conflicts).toEqual([])
    expect(plan.blocked).toBe(false)
  })

  it('raises SAME_PATH_CHANGED when staging moved the same path since first touch', () => {
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}

    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([moved])}),
    )

    expect(plan.conflicts.map((conflict) => [conflict.type, conflict.severity])).toEqual([
      ['SAME_PATH_CHANGED', 'soft'],
    ])
    expect(plan.conflicts[0]).toMatchObject({
      documentId: 'article-1',
      path: ['title'],
      baseValue: 'Staging title',
      localValue: 'Branch title',
    })
  })

  it('does not revert an untouched path that staging changed after first touch', () => {
    // The whole point of recomputing against *current* staging: `summary` moved
    // upstream and the branch never touched it, so promotion must leave it alone.
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', summary: 'Staging summary'}

    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([moved])}),
    )

    const [operation] = documentOperations(plan.operations)
    expect(operation).toMatchObject({type: 'patch-published'})
    expect((operation as {operations: unknown[]}).operations).toEqual([
      {type: 'set', path: ['title'], value: 'Branch title'},
    ])
    expect(plan.conflicts).toEqual([])
  })

  it('is a plan-time recomputation, not the conflicts stored on the record', () => {
    const stale = touchedArticle()
    stale.conflicts = [
      {
        id: 'article-1:SAME_PATH_CHANGED:$.summary',
        documentId: 'article-1',
        severity: 'soft',
        type: 'SAME_PATH_CHANGED',
        path: ['summary'],
        detectedAt: '2026-01-01T00:00:00.000Z',
      },
    ]

    const plan = planPromotion(
      request(stateWith([stale])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    // Staging matches the ancestor now, so the recorded disagreement is gone.
    expect(plan.conflicts).toEqual([])
  })

  it('carries an existing acknowledgement forward for an unchanged disagreement', () => {
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}
    const acknowledged = touchedArticle()
    acknowledged.conflicts = [
      {
        id: 'article-1:SAME_PATH_CHANGED:$.title',
        documentId: 'article-1',
        severity: 'soft',
        type: 'SAME_PATH_CHANGED',
        path: ['title'],
        ancestorValue: 'Ancestor title',
        baseValue: 'Staging title',
        localValue: 'Branch title',
        detectedAt: '2026-08-01T00:00:00.000Z',
        resolution: {type: 'keep-local', resolvedAt: '2026-08-02T00:00:00.000Z', resolvedBy: ACTOR},
      },
    ]

    const plan = planPromotion(
      request(stateWith([acknowledged])),
      ports({targetRevisions: createTargetRevisionSource([moved])}),
    )

    expect(plan.conflicts[0]?.resolution?.type).toBe('keep-local')
    expect(plan.requiresAcknowledgement).toBe(false)
  })

  it('requires acknowledgement for an unresolved soft conflict (PRD §17.4)', () => {
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}

    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([moved])}),
    )

    expect(plan.requiresAcknowledgement).toBe(true)
    expect(plan.blocked).toBe(false)
    expect(plan.blockers.map((blocker) => [blocker.code, blocker.severity])).toEqual([
      ['UNACKNOWLEDGED_CONFLICT', 'acknowledge'],
    ])
  })

  it('blocks on an unresolved hard conflict (PRD §30.1)', () => {
    // Staging deleted the document the branch edited — §16.4 row 2.
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([])}),
    )

    expect(plan.conflicts.map((conflict) => conflict.type)).toEqual(['BASE_DOCUMENT_DELETED'])
    expect(plan.blocked).toBe(true)
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('HARD_CONFLICT')
  })
})

/* ------------------------------------------------------------------ *
 * §30.3 — operation types
 * ------------------------------------------------------------------ */

describe('planPromotion — operation selection (PRD §30.3)', () => {
  it('creates a published document for a branch-created record', () => {
    const record = overlayRecord({
      logicalId: 'author-9',
      schemaType: 'author',
      origin: 'branch',
      localPublished: localVersion(
        {_id: 'author-9', _type: 'author', _rev: 'overlay:7:bbbb', name: 'New author'},
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })

    const plan = planPromotion(request(stateWith([record])), ports())

    expect(documentOperations(plan.operations)).toEqual([
      expect.objectContaining({
        type: 'create-published',
        logicalId: 'author-9',
        targetId: 'author-9',
        precondition: {kind: 'absent'},
      }),
    ])
  })

  it('emits a no-op when the target already matches the branch (PRD §30.3)', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle('Ancestor title')])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(documentOperations(plan.operations)).toEqual([
      expect.objectContaining({type: 'noop', logicalId: 'article-1', reason: 'target-matches'}),
    ])
  })

  it('patches the target draft when the branch has a local draft', () => {
    const ancestorDraft: SanityDocument = {
      _id: 'drafts.article-1',
      _type: 'article',
      _rev: 'staging-draft-1',
      title: 'Ancestor draft',
    }
    const record = overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      ancestorDraft,
      localDraft: localVersion(
        {...ancestorDraft, _rev: 'overlay:7:cccc', title: 'Branch draft'},
        {touchedPaths: [['title']], ancestorKind: 'base-draft', overlayRevision: '7'},
      ),
    })

    const plan = planPromotion(
      request(stateWith([record])),
      ports({targetRevisions: createTargetRevisionSource([ancestorDraft])}),
    )

    expect(documentOperations(plan.operations)).toEqual([
      expect.objectContaining({
        type: 'patch-draft',
        targetId: 'drafts.article-1',
        precondition: {kind: 'revision', revision: 'staging-draft-1'},
      }),
    ])
  })

  it('deletes both target versions when the branch tombstoned the document', () => {
    const draft: SanityDocument = {
      _id: 'drafts.article-1',
      _type: 'article',
      _rev: 'staging-draft-1',
      title: 'x',
    }
    const record = overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      ancestorPublished: ANCESTOR,
      publishedTombstone: true,
      draftTombstone: true,
    })

    const plan = planPromotion(
      request(stateWith([record])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR, draft])}),
    )

    expect(
      documentOperations(plan.operations).map((operation) => [operation.type, operation.targetId]),
    ).toEqual([
      ['delete', 'article-1'],
      ['delete', 'drafts.article-1'],
    ])
  })

  it('unpublishes when only the published version is tombstoned (PRD §18.6)', () => {
    const record = overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      ancestorPublished: ANCESTOR,
      publishedTombstone: true,
      localDraft: localVersion(
        {...ANCESTOR, _id: 'drafts.article-1', _rev: 'overlay:7:dddd'},
        {ancestorKind: 'base-published', overlayRevision: '7'},
      ),
    })

    const plan = planPromotion(
      request(stateWith([record])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(documentOperations(plan.operations).map((operation) => operation.type)).toContain(
      'unpublish',
    )
  })

  it('plans nothing for a record the branch never gave a local version', () => {
    const untouched = overlayRecord({logicalId: 'article-1', ancestorPublished: ANCESTOR})

    const plan = planPromotion(
      request(stateWith([untouched])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(plan.operations).toEqual([])
    expect(plan.documents).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * §30.4 step 11 / §20.5 — schema validation against the *target* schema
 * ------------------------------------------------------------------ */

describe('planPromotion — schema validation (PRD §30.4 step 11, §20.5)', () => {
  it('validates every promoted document at the `promotion` timing', () => {
    const seen: Array<{id: string; timing: string}> = []

    planPromotion(
      request(stateWith([touchedArticle()])),
      ports({
        targetRevisions: createTargetRevisionSource([ANCESTOR]),
        schema: SCHEMA,
        validate: (document, context) => {
          seen.push({id: document._id, timing: context.timing})
          return []
        },
      }),
    )

    expect(seen).toEqual([{id: 'article-1', timing: 'promotion'}])
  })

  it('blocks the plan on a validation error and counts it in the summary', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({
        targetRevisions: createTargetRevisionSource([ANCESTOR]),
        validate: () => [
          {level: 'error', message: 'title is required', path: ['title'], ruleId: 'required'},
          {level: 'warning', message: 'summary is short'},
        ],
      }),
    )

    expect(plan.validation).toMatchObject({errors: 1, warnings: 1})
    expect(plan.blocked).toBe(true)
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('VALIDATION_ERROR')
  })

  it('does not block on validation warnings alone', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({
        targetRevisions: createTargetRevisionSource([ANCESTOR]),
        validate: () => [{level: 'warning', message: 'summary is short'}],
      }),
    )

    expect(plan.validation).toMatchObject({errors: 0, warnings: 1})
    expect(plan.blocked).toBe(false)
  })

  it('records the schema commit the plan was computed under (PRD §20.1)', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR]), schema: SCHEMA}),
    )

    expect(plan.sourceSchemaCommitSha).toBe('schema-sha-1')
  })
})

/* ------------------------------------------------------------------ *
 * §34.9 — branch-created IDs must not collide with current base IDs
 * ------------------------------------------------------------------ */

describe('planPromotion — invariant §34.9', () => {
  it('blocks when a branch-created ID now exists in the target dataset', () => {
    const record = overlayRecord({
      logicalId: 'author-9',
      schemaType: 'author',
      origin: 'branch',
      localPublished: localVersion(
        {_id: 'author-9', _type: 'author', _rev: 'overlay:7:bbbb', name: 'New author'},
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })
    const collision: SanityDocument = {
      _id: 'author-9',
      _type: 'author',
      _rev: 'staging-9',
      name: 'Somebody else',
    }

    const plan = planPromotion(
      request(stateWith([record])),
      ports({targetRevisions: createTargetRevisionSource([collision])}),
    )

    expect(plan.blocked).toBe(true)
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('BRANCH_ID_COLLISION')
  })
})

/* ------------------------------------------------------------------ *
 * §30.5 — the per-document review surface
 * ------------------------------------------------------------------ */

describe('planPromotion — review surface (PRD §30.5)', () => {
  it('reports every §30.5 review field for a patched document', () => {
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', summary: 'Staging summary'}

    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([moved])}),
    )

    const [entry] = plan.documents
    expect(entry).toMatchObject({
      logicalId: 'article-1',
      schemaType: 'article',
      actions: ['patch-published'],
      baseRevisionAtFirstTouch: {published: 'staging-1', draft: null},
      targetRevision: {published: 'staging-2', draft: null},
      overlayRevision: {published: '7', draft: null},
    })
    expect(entry?.current.published?.title).toBe('Ancestor title')
    expect(entry?.proposed.published?.title).toBe('Branch title')
    expect(entry?.changes).toEqual([
      {version: 'published', path: ['title'], kind: 'change', before: 'Ancestor title', after: 'Branch title'},
    ])
  })
})

/* ------------------------------------------------------------------ *
 * §38.4 — the plan is deterministic
 * ------------------------------------------------------------------ */

describe('planPromotion — determinism (PRD §38.4)', () => {
  it('produces byte-identical plans for identical inputs', () => {
    const build = () =>
      planPromotion(
        request(stateWith([touchedArticle()])),
        ports({targetRevisions: createTargetRevisionSource([ANCESTOR]), schema: SCHEMA}),
      )

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
  })

  it('derives the plan ID from the plan inputs rather than from randomness', () => {
    const first = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )
    const second = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )
    const different = planPromotion(
      request(stateWith([touchedArticle('Another title')])),
      ports({targetRevisions: createTargetRevisionSource([ANCESTOR])}),
    )

    expect(first.id).toBe(second.id)
    expect(different.id).not.toBe(first.id)
  })

  it('accepts an injected plan-ID source (no ID generation inside core)', () => {
    const plan = planPromotion(
      request(stateWith([touchedArticle()])),
      ports({
        targetRevisions: createTargetRevisionSource([ANCESTOR]),
        planId: () => 'plan-fixed-1',
      }),
    )

    expect(plan.id).toBe('plan-fixed-1')
  })
})
