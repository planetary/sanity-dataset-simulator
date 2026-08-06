import {describe, expect, it} from 'vitest'
import {
  DEFAULT_PLAN_TTL_MS,
  OverlayPromotionError,
  PROMOTION_APPLY_GAPS,
  applyPromotionPlan,
  assertPromotionPlanApplicable,
  createTargetRevisionSource,
  isPlanExpired,
  planPromotion,
  promotionPlanChecksum,
  promotionPreconditionMismatches,
  verifyPromotionPlan,
} from '../../sanity-overlay-core/src/promotion/index'
import type {
  PromotionPlan,
  PromotionPorts,
  PromotionTargetSnapshot,
} from '../../sanity-overlay-core/src/promotion/index'
import {createOverlayState} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayDocumentRecord,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {localVersion, overlayRecord} from '../src/mergeFixtures'

// Phase 8 — plan checksum, expiry and invalidation (PRD §30.2, §30.6, §34.18,
// §35.14 "Expired plan cannot apply" / "Changed target revision invalidates
// plan"), plus branch asset mapping (§24.9, §34.20) and the deliberately absent
// apply half (§30.6, §30.8, §30.9).

const NOW = '2026-08-04T10:00:00.000Z'
const ACTOR: OverlayActor = {type: 'user', id: 'publisher-1'}

const ANCESTOR: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'staging-1',
  title: 'Ancestor title',
}

function touched(title = 'Branch title'): OverlayDocumentRecord {
  return overlayRecord({
    logicalId: 'article-1',
    schemaType: 'article',
    ancestorPublished: ANCESTOR,
    localPublished: localVersion(
      {...ANCESTOR, _rev: 'overlay:7:aaaa', title},
      {touchedPaths: [['title']], overlayRevision: '7'},
    ),
  })
}

function buildPlan(
  records: readonly OverlayDocumentRecord[] = [touched()],
  targets: readonly SanityDocument[] = [ANCESTOR],
  overrides: Partial<PromotionPorts> = {},
): PromotionPlan {
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
      ...overrides,
    },
  )
}

function freshSnapshot(documents: readonly SanityDocument[]): PromotionTargetSnapshot {
  return createTargetRevisionSource([...documents])(['article-1'])
}

/* ------------------------------------------------------------------ *
 * §30.2 checksum / §34.18
 * ------------------------------------------------------------------ */

describe('promotion plan checksum (PRD §30.2, invariant §34.18)', () => {
  it('signs the plan over everything except the checksum field itself', () => {
    const plan = buildPlan()

    expect(plan.checksum).toHaveLength(64)
    expect(promotionPlanChecksum({...plan, checksum: ''})).toBe(plan.checksum)
  })

  it('detects a tampered operation', () => {
    const plan = buildPlan()
    const tampered: PromotionPlan = {
      ...plan,
      operations: [...plan.operations, ...plan.operations.slice(0, 1)],
    }

    const {ok, issues} = verifyPromotionPlan(tampered, {
      now: NOW,
      overlayRevision: 7,
      targetRevisions: freshSnapshot([ANCESTOR]),
    })

    expect(ok).toBe(false)
    expect(issues.map((issue) => issue.code)).toContain('PLAN_CHECKSUM_MISMATCH')
  })

  it('makes expiry structural: an extended expiresAt invalidates the checksum', () => {
    const plan = buildPlan()
    const extended: PromotionPlan = {...plan, expiresAt: '2099-01-01T00:00:00.000Z'}

    const {issues} = verifyPromotionPlan(extended, {
      now: NOW,
      overlayRevision: 7,
      targetRevisions: freshSnapshot([ANCESTOR]),
    })

    // The plan is no longer expired, but it is no longer *the* plan either.
    expect(issues.map((issue) => issue.code)).toEqual(['PLAN_CHECKSUM_MISMATCH'])
  })

  it('makes the observed target revisions part of what is signed', () => {
    const plan = buildPlan()
    const rewritten: PromotionPlan = {
      ...plan,
      target: {...plan.target, revisions: {'article-1': {published: 'staging-9', draft: null}}},
    }

    expect(promotionPlanChecksum({...rewritten, checksum: ''})).not.toBe(plan.checksum)
  })
})

/* ------------------------------------------------------------------ *
 * §30.2 expiry
 * ------------------------------------------------------------------ */

describe('promotion plan expiry (PRD §30.2, §30.6)', () => {
  it('derives expiresAt from the injected clock plus the configured lifetime', () => {
    const plan = buildPlan()

    expect(plan.expiresAt).toBe(new Date(Date.parse(NOW) + DEFAULT_PLAN_TTL_MS).toISOString())
  })

  it('honours an explicit ttl', () => {
    const plan = buildPlan([touched()], [ANCESTOR], {ttlMs: 60_000})

    expect(plan.expiresAt).toBe('2026-08-04T10:01:00.000Z')
  })

  it('is expired exactly at expiresAt, not a millisecond earlier', () => {
    const plan = buildPlan([touched()], [ANCESTOR], {ttlMs: 60_000})

    expect(isPlanExpired(plan, '2026-08-04T10:00:59.999Z')).toBe(false)
    expect(isPlanExpired(plan, '2026-08-04T10:01:00.000Z')).toBe(true)
  })

  it('reports an expired plan as unusable', () => {
    const plan = buildPlan([touched()], [ANCESTOR], {ttlMs: 60_000})

    const {ok, issues} = verifyPromotionPlan(plan, {
      now: '2026-08-04T11:00:00.000Z',
      overlayRevision: 7,
      targetRevisions: freshSnapshot([ANCESTOR]),
    })

    expect(ok).toBe(false)
    expect(issues.map((issue) => issue.code)).toEqual(['PLAN_EXPIRED'])
  })
})

/* ------------------------------------------------------------------ *
 * §30.6 — revision recheck
 * ------------------------------------------------------------------ */

describe('promotion plan invalidation (PRD §30.6, §35.14)', () => {
  it('accepts a plan whose target and overlay have not moved', () => {
    const plan = buildPlan()

    expect(
      verifyPromotionPlan(plan, {
        now: NOW,
        overlayRevision: 7,
        targetRevisions: freshSnapshot([ANCESTOR]),
      }),
    ).toEqual({ok: true, issues: []})
  })

  it('invalidates the plan when a target revision changed since planning', () => {
    const plan = buildPlan()

    const {ok, issues} = verifyPromotionPlan(plan, {
      now: NOW,
      overlayRevision: 7,
      targetRevisions: freshSnapshot([{...ANCESTOR, _rev: 'staging-2'}]),
    })

    expect(ok).toBe(false)
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'TARGET_REVISION_CHANGED',
        logicalId: 'article-1',
        expected: 'staging-1',
        actual: 'staging-2',
      }),
    ])
  })

  it('invalidates the plan when the target document disappeared', () => {
    const plan = buildPlan()

    const {issues} = verifyPromotionPlan(plan, {
      now: NOW,
      overlayRevision: 7,
      targetRevisions: freshSnapshot([]),
    })

    expect(issues.map((issue) => issue.code)).toEqual(['TARGET_REVISION_CHANGED'])
  })

  it('invalidates the plan when the overlay revision moved', () => {
    const plan = buildPlan()

    const {issues} = verifyPromotionPlan(plan, {
      now: NOW,
      overlayRevision: 8,
      targetRevisions: freshSnapshot([ANCESTOR]),
    })

    expect(issues).toEqual([
      expect.objectContaining({code: 'OVERLAY_REVISION_CHANGED', expected: '7', actual: '8'}),
    ])
  })

  it('refuses a blocked plan even when every revision still matches', () => {
    const plan = buildPlan([touched()], [])

    expect(plan.blocked).toBe(true)
    const {issues} = verifyPromotionPlan(plan, {
      now: NOW,
      overlayRevision: 7,
      targetRevisions: {},
    })

    expect(issues.map((issue) => issue.code)).toContain('PLAN_BLOCKED')
  })

  it('reports unacknowledged soft conflicts unless the caller acknowledges them', () => {
    const plan = buildPlan([touched()], [{...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}])
    const observed = freshSnapshot([{...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}])

    expect(
      verifyPromotionPlan(plan, {now: NOW, overlayRevision: 7, targetRevisions: observed}).issues.map(
        (issue) => issue.code,
      ),
    ).toEqual(['PLAN_UNACKNOWLEDGED'])

    expect(
      verifyPromotionPlan(plan, {
        now: NOW,
        overlayRevision: 7,
        targetRevisions: observed,
        acknowledged: true,
      }),
    ).toEqual({ok: true, issues: []})
  })

  it('throws a structured error rather than returning a verdict, on request', () => {
    const plan = buildPlan()

    expect(() =>
      assertPromotionPlanApplicable(plan, {
        now: NOW,
        overlayRevision: 9,
        targetRevisions: freshSnapshot([ANCESTOR]),
      }),
    ).toThrow(OverlayPromotionError)

    try {
      assertPromotionPlanApplicable(plan, {
        now: NOW,
        overlayRevision: 9,
        targetRevisions: freshSnapshot([ANCESTOR]),
      })
    } catch (error) {
      expect((error as OverlayPromotionError).code).toBe('PROMOTION_BLOCKED')
      expect((error as OverlayPromotionError).issues.map((issue) => issue.code)).toEqual([
        'OVERLAY_REVISION_CHANGED',
      ])
    }
  })
})

/* ------------------------------------------------------------------ *
 * The second, independent guard: the operations themselves
 * ------------------------------------------------------------------ */

describe('per-operation preconditions (PRD §30.6 revision guards)', () => {
  it('carries a revision guard on every content operation', () => {
    const plan = buildPlan()

    for (const operation of plan.operations) {
      if (operation.type === 'upload-asset') continue
      expect(operation.precondition).toBeDefined()
    }
  })

  it('detects a moved target from the operations alone, without the plan header', () => {
    const plan = buildPlan()
    const stripped: PromotionPlan = {
      ...plan,
      target: {...plan.target, revisions: {}},
    }

    expect(
      promotionPreconditionMismatches(stripped, freshSnapshot([{...ANCESTOR, _rev: 'staging-2'}])),
    ).toEqual([
      expect.objectContaining({
        code: 'TARGET_REVISION_CHANGED',
        logicalId: 'article-1',
        expected: 'staging-1',
        actual: 'staging-2',
      }),
    ])
  })

  it('rejects a create whose target has since appeared', () => {
    const branchCreated = overlayRecord({
      logicalId: 'author-9',
      schemaType: 'author',
      origin: 'branch',
      localPublished: localVersion(
        {_id: 'author-9', _type: 'author', _rev: 'overlay:7:bbbb', name: 'New'},
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })
    const plan = buildPlan([branchCreated], [])

    const appeared = createTargetRevisionSource([
      {_id: 'author-9', _type: 'author', _rev: 'staging-9', name: 'Someone'},
    ])(['author-9'])

    expect(promotionPreconditionMismatches(plan, appeared)).toEqual([
      expect.objectContaining({code: 'TARGET_EXISTS', logicalId: 'author-9'}),
    ])
  })
})

/* ------------------------------------------------------------------ *
 * §24.9 / invariant §34.20 — branch assets
 * ------------------------------------------------------------------ */

describe('branch asset mapping (PRD §24.9, invariant §34.20)', () => {
  const withAsset = (): OverlayDocumentRecord =>
    overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      origin: 'branch',
      localPublished: localVersion(
        {
          _id: 'article-1',
          _type: 'article',
          _rev: 'overlay:7:aaaa',
          title: 'Branch title',
          hero: {_type: 'image', asset: {_type: 'reference', _ref: 'overlay-asset-1'}},
        },
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })

  it('blocks content apply while a referenced branch asset has no Sanity asset ID', () => {
    const plan = buildPlan([withAsset()], [], {
      assets: () => [{assetId: 'overlay-asset-1', kind: 'image'}],
    })

    expect(plan.assetMappings).toEqual([
      {
        overlayAssetId: 'overlay-asset-1',
        kind: 'image',
        uploadRequired: true,
        references: [{logicalId: 'article-1', version: 'published', path: ['hero', 'asset']}],
      },
    ])
    expect(plan.blocked).toBe(true)
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('UNMAPPED_BRANCH_ASSET')
  })

  it('orders the upload ahead of every content operation (PRD §30.7 step 1)', () => {
    const plan = buildPlan([withAsset()], [], {
      assets: () => [{assetId: 'overlay-asset-1', kind: 'image'}],
    })

    expect(plan.operations[0]).toMatchObject({type: 'upload-asset', assetId: 'overlay-asset-1', phase: 1})
  })

  it('does not block once the asset is mapped to a real Sanity asset', () => {
    const plan = buildPlan([withAsset()], [], {
      assets: () => [
        {assetId: 'overlay-asset-1', kind: 'image', promotedSanityAssetId: 'image-abc-800x600-jpg'},
      ],
    })

    expect(plan.assetMappings[0]).toMatchObject({
      uploadRequired: false,
      sanityAssetId: 'image-abc-800x600-jpg',
    })
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain('UNMAPPED_BRANCH_ASSET')
    expect(plan.operations.some((operation) => operation.type === 'upload-asset')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * The apply half, which deliberately does not exist
 * ------------------------------------------------------------------ */

describe('apply is unimplemented on purpose (PRD §30.6, §30.8, §30.9)', () => {
  it('throws instead of mutating a dataset', () => {
    const plan = buildPlan()

    expect(() => applyPromotionPlan(plan)).toThrow(OverlayPromotionError)
    try {
      applyPromotionPlan(plan)
    } catch (error) {
      expect((error as OverlayPromotionError).code).toBe('PROMOTION_APPLY_NOT_IMPLEMENTED')
    }
  })

  it('enumerates every PRD §30 clause left unimplemented, as inspectable data', () => {
    const sections = PROMOTION_APPLY_GAPS.map((gap) => gap.section)

    expect(sections).toContain('§30.6')
    expect(sections).toContain('§30.8')
    expect(sections).toContain('§30.9')
    for (const gap of PROMOTION_APPLY_GAPS) {
      expect(gap.requirement.length).toBeGreaterThan(0)
      expect(gap.modelled.length).toBeGreaterThan(0)
    }
  })
})
