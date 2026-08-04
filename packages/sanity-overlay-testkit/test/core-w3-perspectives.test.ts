import {describe, expect, it} from 'vitest'
import {checksum} from '../../sanity-overlay-core/src/index'
import type {SanityDocument} from '../../sanity-overlay-core/src/index'
import {
  OVERLAY_PERSPECTIVES,
  resolveDraftsPerspective,
  resolvePerspective,
  resolvePublishedPerspective,
  resolveRawPerspective,
  unsetPathsFromOperations,
} from '../../sanity-overlay-core/src/perspectives/index'
import type {PerspectiveRequest} from '../../sanity-overlay-core/src/perspectives/index'
import {
  ANCESTOR_ARTICLE,
  ANCESTOR_ARTICLE_DRAFT,
  clone,
  localVariant,
  localVersion,
  overlayRecord,
  variant,
} from '../src/mergeFixtures'

// Phase 2 workstream W3 — PRD §18.1 virtual published, §18.2 virtual drafts with
// the documented fallback chain, §18.3 partial/synthetic raw view.
// Covers PRD §35.2 core merge cases 11-16.

const NOW = '2026-08-04T09:00:00.000Z'

function req(overrides: Partial<PerspectiveRequest> = {}): PerspectiveRequest {
  return {
    logicalId: 'article-1',
    now: NOW,
    record: null,
    base: {published: null, draft: null},
    ...overrides,
  }
}

const BASE_PUBLISHED = clone(ANCESTOR_ARTICLE)
const BASE_DRAFT = clone(ANCESTOR_ARTICLE_DRAFT)

/* ------------------------------------------------------------------ *
 * PRD §35.2 cases 11-16
 * ------------------------------------------------------------------ */

describe('§35.2 perspective cases', () => {
  it('Published tombstone suppresses base published', () => {
    const result = resolvePublishedPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: null},
        record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE, publishedTombstone: true}),
      }),
    )

    expect(result.document).toBeNull()
    expect(result.absence).toBe('tombstone')
    expect(result.source).toBe('none')
    expect(result.checksum).toBeNull()
  })

  it('Draft tombstone follows documented fallback', () => {
    const localPublished = localVersion(
      localVariant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Branch published title'
      }),
      {touchedPaths: [['title']]},
    )

    // §18.2 branch 1a — local published present and not tombstoned wins.
    const toLocalPublished = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished,
          draftTombstone: true,
        }),
      }),
    )
    expect(toLocalPublished.document?.title).toBe('Branch published title')
    expect(toLocalPublished.source).toBe('local-published')

    // §18.2 branch 1b — otherwise current base published, never the base draft.
    const toBasePublished = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE, draftTombstone: true}),
      }),
    )
    expect(toBasePublished.document?._id).toBe('article-1')
    expect(toBasePublished.document?.title).toBe('Ancestor title')
    expect(toBasePublished.source).toBe('base-published')

    // A full delete (§18.8, both tombstones) is absent in every perspective.
    const fullDelete = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          draftTombstone: true,
          publishedTombstone: true,
        }),
      }),
    )
    expect(fullDelete.document).toBeNull()
    expect(fullDelete.absence).toBe('tombstone')
  })

  it('Local draft takes precedence in drafts perspective', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          ancestorDraft: ANCESTOR_ARTICLE_DRAFT,
          localPublished: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              document.title = 'Branch published title'
            }),
            {touchedPaths: [['title']]},
          ),
          localDraft: localVersion(
            localVariant(ANCESTOR_ARTICLE_DRAFT, (document) => {
              document.title = 'Branch draft title'
            }),
            {touchedPaths: [['title']], ancestorKind: 'base-draft'},
          ),
        }),
      }),
    )

    expect(result.document?.title).toBe('Branch draft title')
    expect(result.source).toBe('local-draft')
  })

  it('Local published takes precedence in published perspective', () => {
    const result = resolvePublishedPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              document.title = 'Branch published title'
            }),
            {touchedPaths: [['title']]},
          ),
        }),
      }),
    )

    expect(result.document?.title).toBe('Branch published title')
    expect(result.source).toBe('local-published')
  })

  it('Base draft is used when no local state exists', () => {
    const noRecord = resolveDraftsPerspective(
      req({base: {published: BASE_PUBLISHED, draft: BASE_DRAFT}}),
    )
    expect(noRecord.document?.title).toBe('Ancestor draft title')
    expect(noRecord.source).toBe('base-draft')

    // A record that exists but holds no local version behaves identically.
    const emptyRecord = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE}),
      }),
    )
    expect(emptyRecord.document?.title).toBe('Ancestor draft title')
    expect(emptyRecord.source).toBe('base-draft')
  })

  it('Base published is fallback when no draft exists', () => {
    const result = resolveDraftsPerspective(
      req({base: {published: BASE_PUBLISHED, draft: null}}),
    )
    expect(result.document?.title).toBe('Ancestor title')
    expect(result.source).toBe('base-published')

    const published = resolvePublishedPerspective(
      req({base: {published: BASE_PUBLISHED, draft: null}}),
    )
    expect(published.document?.title).toBe('Ancestor title')
    expect(published.source).toBe('base-published')
  })
})

/* ------------------------------------------------------------------ *
 * §18.1 / §18.2 merge semantics inside a perspective
 * ------------------------------------------------------------------ */

describe('§18.1 virtual published perspective', () => {
  it('merges local published over current base published rather than replacing it', () => {
    const result = resolvePublishedPerspective(
      req({
        base: {
          published: variant(ANCESTOR_ARTICLE, (document) => {
            document.summary = 'Upstream summary'
          }),
          draft: null,
        },
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              document.title = 'Branch published title'
            }),
            {touchedPaths: [['title']]},
          ),
        }),
      }),
    )

    expect(result.document?.title).toBe('Branch published title')
    // Untouched path inherits the current base (§34.12).
    expect(result.document?.summary).toBe('Upstream summary')
    expect(result.checksum).toBe(checksum(result.document as SanityDocument))
  })

  it('reports base deletion of an untouched document as an absent document', () => {
    const result = resolvePublishedPerspective(
      req({
        base: {published: null, draft: null},
        record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE, baseStatus: 'deleted'}),
      }),
    )
    expect(result.document).toBeNull()
    expect(result.absence).toBe('base-deleted')
  })
})

describe('§18.2 virtual drafts perspective', () => {
  it('merges a local draft against the current base draft when one exists', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {
          published: BASE_PUBLISHED,
          draft: variant(ANCESTOR_ARTICLE_DRAFT, (document) => {
            document.summary = 'Upstream draft summary'
          }),
        },
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          ancestorDraft: ANCESTOR_ARTICLE_DRAFT,
          localDraft: localVersion(
            localVariant(ANCESTOR_ARTICLE_DRAFT, (document) => {
              document.title = 'Branch draft title'
            }),
            {touchedPaths: [['title']], ancestorKind: 'base-draft'},
          ),
        }),
      }),
    )

    expect(result.document?.title).toBe('Branch draft title')
    expect(result.document?.summary).toBe('Upstream draft summary')
  })

  it('merges a local draft against base published when there is no base draft', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {
          published: variant(ANCESTOR_ARTICLE, (document) => {
            document.summary = 'Upstream summary'
          }),
          draft: null,
        },
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localDraft: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              document.title = 'Branch draft title'
            }),
            {touchedPaths: [['title']]},
          ),
        }),
      }),
    )

    expect(result.document?.title).toBe('Branch draft title')
    expect(result.document?.summary).toBe('Upstream summary')
  })

  it('records BASE_DRAFT_DELETED as a soft conflict and lets the local draft win (§17.4)', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: null},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          ancestorDraft: ANCESTOR_ARTICLE_DRAFT,
          localDraft: localVersion(
            localVariant(ANCESTOR_ARTICLE_DRAFT, (document) => {
              document.title = 'Branch draft title'
            }),
            {touchedPaths: [['title']], ancestorKind: 'base-draft'},
          ),
        }),
      }),
    )

    const conflict = result.conflicts.find((entry) => entry.type === 'BASE_DRAFT_DELETED')
    expect(conflict?.severity).toBe('soft')
    expect(result.document?.title).toBe('Branch draft title')
    expect(result.source).toBe('local-draft')
  })

  it('falls back to local published when only a local published version exists', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: null},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              document.title = 'Branch published title'
            }),
            {touchedPaths: [['title']]},
          ),
        }),
      }),
    )
    expect(result.document?.title).toBe('Branch published title')
    expect(result.source).toBe('local-published')
  })

  it('falls back past a published tombstone to the current base draft', () => {
    const result = resolveDraftsPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE, publishedTombstone: true}),
      }),
    )
    expect(result.document?.title).toBe('Ancestor draft title')
    expect(result.source).toBe('base-draft')
  })
})

/* ------------------------------------------------------------------ *
 * §17.5 — unset operations recorded on the local version suppress base
 * ------------------------------------------------------------------ */

describe('unset operations recorded on a local version (§13.5, §17.5)', () => {
  it('derives unset paths from the recorded operation list', () => {
    expect(
      unsetPathsFromOperations([
        {type: 'unset', path: ['summary']},
        {type: 'set', path: ['title'], value: 'x'},
      ]).map((path) => path.join('.')),
    ).toEqual(['summary'])

    // A later write on the same path cancels the unset (§17.5 "let a user remove
    // the local unset to resume inheritance").
    expect(
      unsetPathsFromOperations([
        {type: 'unset', path: ['summary']},
        {type: 'set', path: ['summary'], value: 'back'},
      ]),
    ).toEqual([])
  })

  it('suppresses a later base value for an unset path', () => {
    const result = resolvePublishedPerspective(
      req({
        base: {
          published: variant(ANCESTOR_ARTICLE, (document) => {
            document.summary = 'Brand new upstream summary'
          }),
          draft: null,
        },
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished: localVersion(
            localVariant(ANCESTOR_ARTICLE, (document) => {
              delete document.summary
            }),
            {touchedPaths: [['summary']], operations: [{type: 'unset', path: ['summary']}]},
          ),
        }),
      }),
    )

    expect(result.document).not.toHaveProperty('summary')
  })
})

/* ------------------------------------------------------------------ *
 * §18.3 raw perspective — partial and synthetic
 * ------------------------------------------------------------------ */

describe('§18.3 raw perspective', () => {
  it('returns every documented component and claims no hosted parity', () => {
    const localPublished = localVersion(
      localVariant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Branch published title'
      }),
      {touchedPaths: [['title']]},
    )
    const localDraft = localVersion(
      localVariant(ANCESTOR_ARTICLE_DRAFT, (document) => {
        document.title = 'Branch draft title'
      }),
      {touchedPaths: [['title']], ancestorKind: 'base-draft'},
    )
    const conflicts = [
      {
        id: 'article-1:SAME_PATH_CHANGED:$.title',
        documentId: 'article-1',
        severity: 'soft' as const,
        type: 'SAME_PATH_CHANGED' as const,
        path: ['title'],
        detectedAt: NOW,
      },
    ]

    const raw = resolveRawPerspective(
      req({
        base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
        record: overlayRecord({
          ancestorPublished: ANCESTOR_ARTICLE,
          localPublished,
          localDraft,
          draftTombstone: true,
          conflicts,
        }),
      }),
    )

    expect(raw.basePublished).toEqual(BASE_PUBLISHED)
    expect(raw.baseDraft).toEqual(BASE_DRAFT)
    expect(raw.localPublished).toEqual(localPublished)
    expect(raw.localDraft).toEqual(localDraft)
    expect(raw.tombstones).toEqual({published: false, draft: true})
    expect(raw.conflicts).toEqual(conflicts)
    // §18.3: "partial and synthetic … does not claim exact parity".
    expect(raw.partial).toBe(true)
    expect(raw.claimsHostedParity).toBe(false)
    expect(raw.releases).toBeNull()
  })

  it('returns empty local state and no conflicts when the overlay holds no record', () => {
    const raw = resolveRawPerspective(req({base: {published: BASE_PUBLISHED, draft: null}}))
    expect(raw.basePublished).toEqual(BASE_PUBLISHED)
    expect(raw.baseDraft).toBeNull()
    expect(raw.localPublished).toBeNull()
    expect(raw.localDraft).toBeNull()
    expect(raw.tombstones).toEqual({published: false, draft: false})
    expect(raw.conflicts).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Dispatcher and determinism
 * ------------------------------------------------------------------ */

describe('resolvePerspective', () => {
  it('names exactly the three overlay perspectives', () => {
    expect(OVERLAY_PERSPECTIVES).toEqual(['published', 'drafts', 'raw'])
  })

  it('dispatches to the matching resolver', () => {
    const input = req({
      base: {published: BASE_PUBLISHED, draft: BASE_DRAFT},
      record: overlayRecord({ancestorPublished: ANCESTOR_ARTICLE}),
    })

    expect(resolvePerspective('published', input)).toEqual(resolvePublishedPerspective(input))
    expect(resolvePerspective('drafts', input)).toEqual(resolveDraftsPerspective(input))
    expect(resolvePerspective('raw', input)).toEqual(resolveRawPerspective(input))
  })

  it('is deterministic — repeated resolution yields an identical result', () => {
    const input = req({
      base: {
        published: variant(ANCESTOR_ARTICLE, (document) => {
          document.summary = 'Upstream summary'
        }),
        draft: null,
      },
      record: overlayRecord({
        ancestorPublished: ANCESTOR_ARTICLE,
        localPublished: localVersion(
          localVariant(ANCESTOR_ARTICLE, (document) => {
            document.title = 'Branch published title'
          }),
          {touchedPaths: [['title']]},
        ),
      }),
    })

    expect(resolvePublishedPerspective(input)).toEqual(resolvePublishedPerspective(input))
    expect(resolvePublishedPerspective(input).checksum).toBe(
      resolvePublishedPerspective(input).checksum,
    )
  })
})
