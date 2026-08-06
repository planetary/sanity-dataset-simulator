import {describe, expect, it} from 'vitest'
import {
  createTargetRevisionSource,
  planPromotion,
  renderPromotionDiff,
} from '../../sanity-overlay-core/src/promotion/index'
import {createOverlayState} from '../../sanity-overlay-core/src/index'
import type {
  OverlayActor,
  OverlayDocumentRecord,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {localVersion, overlayRecord} from '../src/mergeFixtures'

// Phase 8 — the human-readable diff (PRD §30.4 step 12, §30.5).
//
// "Produce human-readable and machine-readable diff." The machine-readable half
// is the plan itself; this is the half a person reads before deciding whether to
// touch a shared dataset. It must be deterministic (§34.17 canonical
// serialization) and it must show the change per document and per path.

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
  extraPorts: Record<string, unknown> = {},
) {
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
      planId: () => 'plan-test-1',
      ...extraPorts,
    },
  )
}

/* ------------------------------------------------------------------ *
 * The whole rendering, for one small plan
 * ------------------------------------------------------------------ */

describe('renderPromotionDiff (PRD §30.4 step 12)', () => {
  it('renders a single-document patch exactly', () => {
    const expected = [
      'Promotion plan plan-test-1',
      '  overlay     overlay-promo revision 7',
      '  target      proj-1/staging observed 2026-08-04T10:00:00.000Z',
      '  expires     2026-08-04T10:30:00.000Z',
      '  status      ready',
      '  summary     1 operation (patch-published 1)',
      '',
      'article-1 (article)',
      '  action      patch-published',
      '  target rev  published staging-1',
      '  base rev    published staging-1',
      '  overlay rev published 7',
      '  changes',
      '    ~ published $.title',
      '        - "Ancestor title"',
      '        + "Branch title"',
      '',
      'operations (PRD §30.7 order)',
      '  1. phase 3  patch-published  article-1',
      '',
    ].join('\n')

    expect(renderPromotionDiff(buildPlan())).toBe(expected)
  })

  it('is deterministic', () => {
    expect(renderPromotionDiff(buildPlan())).toBe(renderPromotionDiff(buildPlan()))
  })

  it('shows added and removed paths with their own markers', () => {
    const target: SanityDocument = {
      _id: 'article-1',
      _type: 'article',
      _rev: 'staging-1',
      title: 'Ancestor title',
      legacy: 'drop me',
    }
    const record = overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      ancestorPublished: target,
      localPublished: localVersion(
        {_id: 'article-1', _type: 'article', _rev: 'overlay:7:aaaa', title: 'Ancestor title', subtitle: 'Added'},
        {
          touchedPaths: [['subtitle'], ['legacy']],
          operations: [
            {type: 'set', path: ['subtitle'], value: 'Added'},
            {type: 'unset', path: ['legacy']},
          ],
          overlayRevision: '7',
        },
      ),
    })

    const rendered = renderPromotionDiff(buildPlan([record], [target]))

    expect(rendered).toContain('    - published $.legacy')
    expect(rendered).toContain('        - "drop me"')
    expect(rendered).toContain('    + published $.subtitle')
    expect(rendered).toContain('        + "Added"')
  })

  it('serializes values canonically, so key order cannot vary', () => {
    const target: SanityDocument = {
      _id: 'article-1',
      _type: 'article',
      _rev: 'staging-1',
      seo: {description: 'old', keywords: ['a']},
    }
    const record = overlayRecord({
      logicalId: 'article-1',
      schemaType: 'article',
      ancestorPublished: target,
      localPublished: localVersion(
        {
          _id: 'article-1',
          _type: 'article',
          _rev: 'overlay:7:aaaa',
          // Deliberately reversed key insertion order.
          seo: {keywords: ['a'], description: 'new'},
        },
        {touchedPaths: [['seo']], overlayRevision: '7'},
      ),
    })

    const rendered = renderPromotionDiff(buildPlan([record], [target]))

    expect(rendered).toContain('        + "new"')
    expect(rendered).toContain('    ~ published $.seo.description')
  })

  it('marks a blocked plan in the status line and lists the blockers', () => {
    const rendered = renderPromotionDiff(buildPlan([touched()], []))

    expect(rendered).toContain('  status      BLOCKED')
    expect(rendered).toContain('blockers')
    expect(rendered).toContain('  [block] HARD_CONFLICT article-1')
  })

  it('marks a plan that needs acknowledgement and lists the conflicts', () => {
    const moved: SanityDocument = {...ANCESTOR, _rev: 'staging-2', title: 'Staging title'}
    const rendered = renderPromotionDiff(buildPlan([touched()], [moved]))

    expect(rendered).toContain('  status      NEEDS ACKNOWLEDGEMENT')
    expect(rendered).toContain('conflicts')
    expect(rendered).toContain('  ! soft SAME_PATH_CHANGED article-1 $.title unresolved')
  })

  it('lists validation issues per document', () => {
    const rendered = renderPromotionDiff(
      buildPlan([touched()], [ANCESTOR], {
        validate: () => [{level: 'warning', message: 'summary is short', path: ['summary']}],
      }),
    )

    expect(rendered).toContain('validation')
    expect(rendered).toContain('  warning article-1 $.summary summary is short')
  })

  it('renders a create as a whole-document addition', () => {
    const created = overlayRecord({
      logicalId: 'author-9',
      schemaType: 'author',
      origin: 'branch',
      localPublished: localVersion(
        {_id: 'author-9', _type: 'author', _rev: 'overlay:7:bbbb', name: 'New author'},
        {ancestorKind: 'branch-created', overlayRevision: '7'},
      ),
    })

    const rendered = renderPromotionDiff(buildPlan([created], []))

    expect(rendered).toContain('author-9 (author)')
    expect(rendered).toContain('  action      create-published')
    expect(rendered).toContain('  target rev  absent')
    expect(rendered).toContain('    + published $')
  })

  it('says so plainly when a document needs no change', () => {
    const rendered = renderPromotionDiff(buildPlan([touched('Ancestor title')], [ANCESTOR]))

    expect(rendered).toContain('  action      noop')
    expect(rendered).toContain('    (no field changes — target already matches)')
  })

  it('truncates long values rather than flooding the review', () => {
    const long = 'x'.repeat(500)
    const rendered = renderPromotionDiff(buildPlan([touched(long)], [ANCESTOR]), {
      maxValueLength: 10,
    })

    // 10 characters of the rendered JSON token — the opening quote plus 8 `x` —
    // then the ellipsis.
    expect(rendered).toContain('        + "xxxxxxxx…')
    expect(rendered).not.toContain(long)
  })
})
