import {describe, expect, it} from 'vitest'
import {encodeOverlayPath, touchedPathFor} from '../../sanity-overlay-core/src/index'
import type {
  OverlayConflict,
  OverlayConflictType,
  OverlayPath,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {mergeDocument} from '../../sanity-overlay-core/src/merge/index'
import type {MergeRequest} from '../../sanity-overlay-core/src/merge/index'
import {
  ANCESTOR_PAGE,
  clone,
  keysOf,
  localVariant,
  scenarioCorpus,
  section,
  span,
  variant,
} from '../src/mergeFixtures'

// Phase 2 workstream W3 — PRD §35.3 array tests (10 cases), §17.7 array behavior,
// §17.5 "absence alone is not an unset" applied to keyed arrays.

const NOW = '2026-08-04T09:00:00.000Z'

function request(overrides: Partial<MergeRequest> & Pick<MergeRequest, 'documentId'>): MergeRequest {
  return {
    now: NOW,
    ancestor: null,
    currentBase: null,
    localMaterialized: null,
    localTouchedPaths: [],
    localTombstone: false,
    ...overrides,
  }
}

function pageRequest(overrides: Partial<MergeRequest>): MergeRequest {
  return request({documentId: 'page-1', ancestor: ANCESTOR_PAGE, ...overrides})
}

function conflictAt(
  conflicts: readonly OverlayConflict[],
  type: OverlayConflictType,
  path?: OverlayPath,
): OverlayConflict | undefined {
  return conflicts.find(
    (conflict) =>
      conflict.type === type &&
      (path === undefined ||
        (conflict.path !== undefined &&
          encodeOverlayPath(conflict.path) === encodeOverlayPath(path))),
  )
}

/** `sections` of a resolved document, as a plain array. */
function sections(document: SanityDocument | null): Record<string, unknown>[] {
  return (document?.sections ?? []) as Record<string, unknown>[]
}

function sectionTitle(document: SanityDocument | null, key: string): unknown {
  return sections(document).find((item) => item._key === key)?.title
}

/* ------------------------------------------------------------------ *
 * PRD §35.3 array tests — all ten cases
 * ------------------------------------------------------------------ */

describe('§35.3 array tests', () => {
  it('Local edit to keyed item survives independent base item insertion', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      const list = document.sections as Record<string, unknown>[]
      list.splice(1, 0, section('z', 'Upstream section Z'))
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      const list = document.sections as Record<string, unknown>[]
      list[0]!.title = 'Branch section A'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'a'}, 'title']],
      }),
    )

    expect(sectionTitle(result.document, 'a')).toBe('Branch section A')
    expect(sectionTitle(result.document, 'z')).toBe('Upstream section Z')
    expect(keysOf(result.document?.sections)).toEqual(['a', 'z', 'b', 'c'])
    expect(result.conflicts).toEqual([])
  })

  it('Base edit to different keyed item is inherited', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[1]!.title = 'Upstream section B'
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[0]!.title = 'Branch section A'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'a'}, 'title']],
      }),
    )

    expect(sectionTitle(result.document, 'a')).toBe('Branch section A')
    expect(sectionTitle(result.document, 'b')).toBe('Upstream section B')
    expect(result.conflicts).toEqual([])
  })

  it('Same keyed item changed on both sides conflicts', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[0]!.title = 'Upstream section A'
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[0]!.title = 'Branch section A'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'a'}, 'title']],
      }),
    )

    const conflict = conflictAt(result.conflicts, 'SAME_PATH_CHANGED', [
      'sections',
      {_key: 'a'},
      'title',
    ])
    expect(conflict?.severity).toBe('soft')
    expect(conflict?.baseValue).toBe('Upstream section A')
    expect(conflict?.localValue).toBe('Branch section A')
    // Local wins in preview (§17.4).
    expect(sectionTitle(result.document, 'a')).toBe('Branch section A')
  })

  it('Base deletes locally edited keyed item and creates hard conflict', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      document.sections = (document.sections as Record<string, unknown>[]).filter(
        (item) => item._key !== 'b',
      )
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[1]!.title = 'Branch section B'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'b'}, 'title']],
      }),
    )

    const conflict = conflictAt(result.conflicts, 'ARRAY_ITEM_DELETED', ['sections', {_key: 'b'}])
    expect(conflict?.severity).toBe('hard')
    // "Preserve local item when possible" (§17.4).
    expect(sectionTitle(result.document, 'b')).toBe('Branch section B')
    expect(keysOf(result.document?.sections)).toEqual(['a', 'b', 'c'])
  })

  it('Base deletion of an untouched keyed item is followed, with no conflict', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      document.sections = (document.sections as Record<string, unknown>[]).filter(
        (item) => item._key !== 'b',
      )
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[])[0]!.title = 'Branch section A'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'a'}, 'title']],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'c'])
    expect(result.conflicts).toEqual([])
  })

  it('Local deletes base keyed item using explicit operation', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      document.sections = (document.sections as Record<string, unknown>[]).filter(
        (item) => item._key !== 'b',
      )
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'b'}]],
        unsetPaths: [['sections', {_key: 'b'}]],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'c'])
    expect(result.conflicts).toEqual([])
  })

  it('Local and base insert distinct keys at same anchor deterministically', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).splice(
        1,
        0,
        section('bx', 'Upstream insert'),
      )
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).splice(1, 0, section('lx', 'Branch insert'))
    })

    const input = pageRequest({
      currentBase,
      localMaterialized: local,
      localTouchedPaths: [['sections', {_key: 'lx'}]],
    })
    const result = mergeDocument(input)

    // The adopted §17.7 [SHOULD] ordering: base order is the spine, the local
    // insertion sits immediately after its recorded anchor `a`, and the
    // concurrent base insertion keeps its base-relative position after it.
    expect(keysOf(result.document?.sections)).toEqual(['a', 'lx', 'bx', 'b', 'c'])
    // [MUST] an ordering exists, and it is the same on every evaluation.
    expect(keysOf(mergeDocument(input).document?.sections)).toEqual(['a', 'lx', 'bx', 'b', 'c'])
  })

  it('Duplicate `_key` is rejected', () => {
    // (a) Two local items carrying one `_key`.
    const localDuplicate = localVariant(ANCESTOR_PAGE, (document) => {
      const list = document.sections as Record<string, unknown>[]
      list.push(section('dup', 'First dup'), section('dup', 'Second dup'))
    })
    const sameSide = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: localDuplicate,
        localTouchedPaths: [['sections', {_key: 'dup'}]],
      }),
    )
    expect(conflictAt(sameSide.conflicts, 'ARRAY_KEY_COLLISION')?.severity).toBe('hard')
    const sameSideKeys = keysOf(sameSide.document?.sections)
    expect(new Set(sameSideKeys).size).toBe(sameSideKeys.length)

    // (b) Both sides introduce the same new `_key` (§17.4 `ARRAY_KEY_COLLISION`).
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).push(section('x', 'Upstream X'))
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).push(section('x', 'Branch X'))
    })
    const crossSide = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'x'}]],
      }),
    )

    const conflict = conflictAt(crossSide.conflicts, 'ARRAY_KEY_COLLISION', [
      'sections',
      {_key: 'x'},
    ])
    expect(conflict?.severity).toBe('hard')
    // "Reject the colliding local insert" (§17.4 preview behavior).
    expect(sectionTitle(crossSide.document, 'x')).toBe('Upstream X')
    const crossKeys = keysOf(crossSide.document?.sections)
    expect(new Set(crossKeys).size).toBe(crossKeys.length)
  })

  it('Portable Text span and block patches preserve keys', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      const blocks = document.body as Record<string, unknown>[]
      ;(blocks[0]!.children as Record<string, unknown>[]).push(span('span4', 'Upstream span four'))
      ;(blocks[1]!.children as Record<string, unknown>[])[0]!.text = 'Upstream span three'
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      const blocks = document.body as Record<string, unknown>[]
      ;(blocks[0]!.children as Record<string, unknown>[])[0]!.text = 'Branch span one'
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['body', {_key: 'block1'}, 'children', {_key: 'span1'}, 'text']],
      }),
    )

    const blocks = result.document?.body as Record<string, unknown>[]
    expect(keysOf(blocks)).toEqual(['block1', 'block2'])
    expect(keysOf(blocks[0]!.children)).toEqual(['span1', 'span2', 'span4'])
    expect((blocks[0]!.children as Record<string, unknown>[])[0]!.text).toBe('Branch span one')
    expect((blocks[1]!.children as Record<string, unknown>[])[0]!.text).toBe('Upstream span three')
    expect(blocks[0]!.style).toBe('normal')
    expect(result.conflicts).toEqual([])
  })

  it('Non-keyed array is treated as full-array touch', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      document.tags = ['one', 'two', 'three', 'four']
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      document.tags = ['one', 'branch-tag']
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['tags']],
      }),
    )

    // The whole array is local intent — no per-item merge, so the upstream
    // `four` is not spliced in (§17.7 last [MUST]).
    expect(result.document?.tags).toEqual(['one', 'branch-tag'])
    expect(conflictAt(result.conflicts, 'SAME_PATH_CHANGED', ['tags'])?.severity).toBe('soft')
  })

  it('Numeric index patch does not silently target a shifted item', () => {
    // W1 already truncates a numeric segment to the whole array (§13.6, §17.7)…
    expect(touchedPathFor(['tags', 1])).toEqual(['tags'])

    // …and a raw numeric touched path reaching the merge behaves the same way:
    // the base's shifted item at index 1 is never merged into the local array.
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      document.tags = ['zero', 'one', 'two', 'three']
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      document.tags = ['one', 'branch-tag', 'three']
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['tags', 1]],
      }),
    )

    expect(result.document?.tags).toEqual(['one', 'branch-tag', 'three'])
    expect(conflictAt(result.conflicts, 'SAME_PATH_CHANGED', ['tags'])).toBeDefined()
    expect(conflictAt(result.conflicts, 'SAME_PATH_CHANGED', ['tags', 1])).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * §17.5 — "absence alone is not an unset", applied to every container
 * ------------------------------------------------------------------ */

describe('§17.5 absence is not intent (regression class)', () => {
  it('inherits a base keyed item the branch dropped without recording intent', () => {
    // The branch edited `a` only. `b` is missing from the materialized local
    // array but nothing records that intent, so §17.5 says the path still
    // inherits base — absence alone must not suppress an upstream item.
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      const list = document.sections as Record<string, unknown>[]
      list[0]!.title = 'Branch section A'
      document.sections = list.filter((item) => item._key !== 'b')
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'a'}, 'title']],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'b', 'c'])
    expect(sectionTitle(result.document, 'a')).toBe('Branch section A')
    expect(sectionTitle(result.document, 'b')).toBe('Section B')
  })

  it('inherits a base object field the branch dropped without recording intent', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      document.title = 'Branch page'
      delete document.tags
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.tags).toEqual(['one', 'two', 'three'])
  })

  it('drops a keyed item when the branch recorded a touch on it', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      document.sections = (document.sections as Record<string, unknown>[]).filter(
        (item) => item._key !== 'b',
      )
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'b'}]],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'c'])
  })

  it('drops a keyed item when the whole array is recorded as touched', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      const list = document.sections as Record<string, unknown>[]
      list[0]!.title = 'Branch section A'
      document.sections = list.filter((item) => item._key !== 'b')
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['sections'], ['sections', {_key: 'a'}, 'title']],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'c'])
  })
})

/* ------------------------------------------------------------------ *
 * §17.7 ordering rules, stated one at a time
 * ------------------------------------------------------------------ */

describe('§17.7 deterministic ordering rule', () => {
  it('keeps local insertions at one anchor in local transaction order (rule 4)', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).splice(
        1,
        0,
        section('l1', 'Branch one'),
        section('l2', 'Branch two'),
      )
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [
          ['sections', {_key: 'l1'}],
          ['sections', {_key: 'l2'}],
        ],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'l1', 'l2', 'b', 'c'])
  })

  it('keeps concurrent base insertions in base order (rule 3)', () => {
    const currentBase = variant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).splice(
        1,
        0,
        section('b1', 'Upstream one'),
        section('b2', 'Upstream two'),
      )
    })
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).push(section('lz', 'Branch tail'))
    })

    const result = mergeDocument(
      pageRequest({
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'lz'}]],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['a', 'b1', 'b2', 'b', 'c', 'lz'])
  })

  it('places a local insertion before the anchor when it leads the array (rule 2)', () => {
    const local = localVariant(ANCESTOR_PAGE, (document) => {
      ;(document.sections as Record<string, unknown>[]).unshift(section('head', 'Branch head'))
    })

    const result = mergeDocument(
      pageRequest({
        currentBase: clone(ANCESTOR_PAGE),
        localMaterialized: local,
        localTouchedPaths: [['sections', {_key: 'head'}]],
      }),
    )

    expect(keysOf(result.document?.sections)).toEqual(['head', 'a', 'b', 'c'])
  })
})

/* ------------------------------------------------------------------ *
 * Plan §8.5 — keyed array merge property, over the recorded seed corpus
 * ------------------------------------------------------------------ */

describe('keyed array merge property (§35.1)', () => {
  it('resolved arrays contain no duplicate `_key` and keep every independent insertion', () => {
    for (const scenario of scenarioCorpus()) {
      const result = mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: scenario.ancestor,
          currentBase: scenario.currentBase,
          localMaterialized: scenario.local,
          localTouchedPaths: scenario.touchedPaths,
          unsetPaths: scenario.unsetPaths,
        }),
      )

      const keys = keysOf(result.document?.sections)
      expect({seed: scenario.seed, duplicates: keys.length - new Set(keys).size}).toEqual({
        seed: scenario.seed,
        duplicates: 0,
      })
      for (const key of [...scenario.baseInsertedKeys, ...scenario.localInsertedKeys]) {
        expect({seed: scenario.seed, key, present: keys.includes(key)}).toEqual({
          seed: scenario.seed,
          key,
          present: true,
        })
      }
    }
  })
})
