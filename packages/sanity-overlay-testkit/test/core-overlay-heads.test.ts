/**
 * PRD §17.11 — overlay-vs-overlay race handling.
 *
 * The plan's §6 scope boundary promises "the pure three-way overlay-head
 * comparison function that §17.11 requires"; the acceptance audit (F-11) found
 * only the `OVERLAY_SAME_PATH_CHANGED` conflict *type* and no function to raise
 * it. This suite is that function's contract, one describe per §17.11 `[MUST]`.
 *
 * The comparison is deliberately *not* the §17.3 document merge. §17.3 merges
 * three **documents**; §17.11 asks whether a client's **operations**, written
 * against a head that has since moved, may still be replayed. A `set` and an
 * `inc` on the same moved path have opposite answers — the first is a
 * disagreement, the second is a delta that composes — and a document-level merge
 * cannot tell them apart because by then the operation is gone.
 */
import {describe, expect, it} from 'vitest'
import {compareOverlayHeads} from '../../sanity-overlay-core/src/index'
import type {
  OverlayHeadComparisonRequest,
  OverlayOperation,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'

const NOW = '2026-08-04T12:00:00.000Z'

const OBSERVED: SanityDocument = {
  _id: 'drafts.article-1',
  _type: 'article',
  _rev: 'overlay-rev-1',
  title: 'Observed title',
  subtitle: 'Observed subtitle',
  views: 10,
  body: 'hello world',
  sections: [
    {_key: 'a', _type: 'section', title: 'A'},
    {_key: 'b', _type: 'section', title: 'B'},
  ],
}

/** Another overlay head wrote `subtitle` — a path the client never touched. */
const OTHER_DISJOINT: SanityDocument = {
  ...OBSERVED,
  _rev: 'overlay-rev-2',
  subtitle: 'Other head subtitle',
}

/** Another overlay head wrote the *same* path the client is writing. */
const OTHER_SAME_PATH: SanityDocument = {
  ...OBSERVED,
  _rev: 'overlay-rev-2',
  title: 'Other head title',
}

function request(
  overrides: Partial<OverlayHeadComparisonRequest> & {
    requestedIntent: readonly OverlayOperation[]
  },
): OverlayHeadComparisonRequest {
  return {
    documentId: 'article-1',
    now: NOW,
    clientObserved: {revision: 'overlay-rev-1', document: OBSERVED},
    currentOverlay: {revision: 'overlay-rev-2', document: OTHER_DISJOINT},
    ...overrides,
  }
}

/* ================================================================== *
 * MUST 1 — a stale revision triggers the comparison; a fresh one does not
 * ================================================================== */

describe('§17.11 — a stale document revision triggers the three-way comparison', () => {
  it('reports `stale: false` and needs no comparison when the client is current', () => {
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-1', document: OBSERVED},
        requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}],
      }),
    )
    expect(result.stale).toBe(false)
    expect(result.safe).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  it('reports `stale: true` when the overlay head has moved on', () => {
    const result = compareOverlayHeads(
      request({requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}]}),
    )
    expect(result.stale).toBe(true)
  })
})

/* ================================================================== *
 * MUST 2 — disjoint scalar paths merge automatically
 * ================================================================== */

describe('§17.11 — disjoint scalar paths merge automatically', () => {
  it('replays the intent against the current head and keeps the other head’s write', () => {
    const result = compareOverlayHeads(
      request({requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}]}),
    )
    expect(result.safe).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(result.conflictPaths).toEqual([])
    expect(result.document?.title).toBe('Client title')
    // The other head's disjoint write is not clobbered.
    expect(result.document?.subtitle).toBe('Other head subtitle')
  })

  it('merges an unset on a disjoint path', () => {
    const result = compareOverlayHeads(
      request({requestedIntent: [{type: 'unset', path: ['title']}]}),
    )
    expect(result.safe).toBe(true)
    expect(result.document?.title).toBeUndefined()
    expect(result.document?.subtitle).toBe('Other head subtitle')
  })
})

/* ================================================================== *
 * MUST 3 — the same path changed by both heads creates OVERLAY_SAME_PATH_CHANGED
 * ================================================================== */

describe('§17.11 — the same path changed by both heads', () => {
  it('creates OVERLAY_SAME_PATH_CHANGED and refuses the automatic retry', () => {
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: OTHER_SAME_PATH},
        requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => [conflict.type, conflict.severity])).toEqual([
      ['OVERLAY_SAME_PATH_CHANGED', 'soft'],
    ])
    const [conflict] = result.conflicts
    expect(conflict?.path).toEqual(['title'])
    expect(conflict?.documentId).toBe('article-1')
    expect(conflict?.detectedAt).toBe(NOW)
    // §13.11 compared values: what the client saw, what the other head wrote,
    // and what the client asked for.
    expect(conflict?.ancestorValue).toBe('Observed title')
    expect(conflict?.baseValue).toBe('Other head title')
    expect(conflict?.localValue).toBe('Client title')
  })

  it('is soft, matching the §17.4 row for this conflict type', () => {
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: OTHER_SAME_PATH},
        requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}],
      }),
    )
    expect(result.conflicts[0]?.severity).toBe('soft')
  })

  it('still merges the disjoint operations of a mixed request, and names only the bad one', () => {
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: OTHER_SAME_PATH},
        requestedIntent: [
          {type: 'set', path: ['title'], value: 'Client title'},
          {type: 'set', path: ['subtitle'], value: 'Client subtitle'},
        ],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflictPaths).toEqual([['title']])
    expect(result.retryOperations).toEqual([
      {type: 'set', path: ['subtitle'], value: 'Client subtitle'},
    ])
  })
})

/* ================================================================== *
 * MUST 4 — array insertions merge only when keys and anchors remain valid
 * ================================================================== */

describe('§17.11 — array insertions merge only when keys and anchors remain valid', () => {
  const insertAfterB: OverlayOperation = {
    type: 'insert',
    path: ['sections', {_key: 'b'}],
    position: 'after',
    items: [{_key: 'c', _type: 'section', title: 'C'}],
  }

  it('merges when the keyed anchor still exists and the new key is free', () => {
    const otherInserted: SanityDocument = {
      ...OBSERVED,
      _rev: 'overlay-rev-2',
      sections: [
        {_key: 'z', _type: 'section', title: 'Z'},
        ...(OBSERVED.sections as unknown[]),
      ],
    }
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: otherInserted},
        requestedIntent: [insertAfterB],
      }),
    )
    expect(result.safe).toBe(true)
    expect((result.document?.sections as {_key: string}[]).map((item) => item._key)).toEqual([
      'z',
      'a',
      'b',
      'c',
    ])
  })

  it('refuses when the other head deleted the anchor item', () => {
    const anchorGone: SanityDocument = {
      ...OBSERVED,
      _rev: 'overlay-rev-2',
      sections: [{_key: 'a', _type: 'section', title: 'A'}],
    }
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: anchorGone},
        requestedIntent: [insertAfterB],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => conflict.type)).toEqual(['ARRAY_ITEM_DELETED'])
    expect(result.conflicts[0]?.severity).toBe('hard')
    expect(result.conflictPaths).toEqual([['sections', {_key: 'b'}]])
  })

  it('refuses when the other head already used the key being inserted (§17.4 hard)', () => {
    const keyTaken: SanityDocument = {
      ...OBSERVED,
      _rev: 'overlay-rev-2',
      sections: [
        ...(OBSERVED.sections as unknown[]),
        {_key: 'c', _type: 'section', title: 'Other head C'},
      ],
    }
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: keyTaken},
        requestedIntent: [insertAfterB],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => [conflict.type, conflict.severity])).toEqual([
      ['ARRAY_KEY_COLLISION', 'hard'],
    ])
  })

  it('refuses a numeric anchor when the array moved, because indexes shift', () => {
    const otherInserted: SanityDocument = {
      ...OBSERVED,
      _rev: 'overlay-rev-2',
      sections: [
        {_key: 'z', _type: 'section', title: 'Z'},
        ...(OBSERVED.sections as unknown[]),
      ],
    }
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: otherInserted},
        requestedIntent: [
          {
            type: 'insert',
            path: ['sections', 1],
            position: 'after',
            items: [{_key: 'c', _type: 'section', title: 'C'}],
          },
        ],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => conflict.type)).toEqual([
      'OVERLAY_SAME_PATH_CHANGED',
    ])
  })

  it('allows a numeric anchor when the array did not move at all', () => {
    const result = compareOverlayHeads(
      request({
        requestedIntent: [
          {
            type: 'insert',
            path: ['sections', 1],
            position: 'after',
            items: [{_key: 'c', _type: 'section', title: 'C'}],
          },
        ],
      }),
    )
    expect(result.safe).toBe(true)
  })
})

/* ================================================================== *
 * MUST 5 — numeric operations are never applied twice under one key
 * ================================================================== */

describe('§17.11 — numeric operations are never applied twice under one idempotency key', () => {
  it('replays nothing when the key was already committed', () => {
    const result = compareOverlayHeads(
      request({
        idempotencyKey: 'k-1',
        committedIdempotencyKeys: ['k-0', 'k-1'],
        requestedIntent: [{type: 'inc', path: ['views'], amount: 5}],
      }),
    )
    expect(result.replayed).toBe(true)
    expect(result.safe).toBe(true)
    expect(result.retryOperations).toEqual([])
    expect(result.document).toBeNull()
    expect(result.conflicts).toEqual([])
  })

  it('composes an increment onto a value the other head also moved', () => {
    const otherIncremented: SanityDocument = {...OBSERVED, _rev: 'overlay-rev-2', views: 17}
    const result = compareOverlayHeads(
      request({
        idempotencyKey: 'k-2',
        committedIdempotencyKeys: ['k-1'],
        currentOverlay: {revision: 'overlay-rev-2', document: otherIncremented},
        requestedIntent: [{type: 'inc', path: ['views'], amount: 5}],
      }),
    )
    // §17.8: an increment is a delta, not a value — replaying it on the *current*
    // head is exactly right, and is not a same-path disagreement.
    expect(result.safe).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(result.document?.views).toBe(22)
  })

  it('refuses an increment when the other head made the target non-numeric', () => {
    const retyped: SanityDocument = {...OBSERVED, _rev: 'overlay-rev-2', views: 'many'}
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: retyped},
        requestedIntent: [{type: 'inc', path: ['views'], amount: 5}],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => conflict.type)).toEqual(['BASE_TYPE_CHANGED'])
  })
})

/* ================================================================== *
 * MUST 6 — text diffs are never replayed against a different observed string
 * ================================================================== */

describe('§17.11 — text diffs are never replayed against a different observed string', () => {
  const patch = '@@ -1,11 +1,11 @@\n hello \n-world\n+WORLD\n'

  it('replays the diff when the string is byte-identical in both heads', () => {
    const result = compareOverlayHeads(
      request({requestedIntent: [{type: 'diffMatchPatch', path: ['body'], patch}]}),
    )
    expect(result.safe).toBe(true)
    expect(result.document?.body).toBe('hello WORLD')
  })

  it('refuses the diff when the other head changed the string', () => {
    const moved: SanityDocument = {...OBSERVED, _rev: 'overlay-rev-2', body: 'hello there'}
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: moved},
        requestedIntent: [{type: 'diffMatchPatch', path: ['body'], patch}],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflicts.map((conflict) => conflict.type)).toEqual([
      'OVERLAY_SAME_PATH_CHANGED',
    ])
    expect(result.conflictPaths).toEqual([['body']])
  })

  it('refuses the diff even when the other head only moved a parent of the path', () => {
    const moved: SanityDocument = {...OBSERVED, _rev: 'overlay-rev-2'}
    delete moved.body
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: moved},
        requestedIntent: [{type: 'diffMatchPatch', path: ['body'], patch}],
      }),
    )
    expect(result.safe).toBe(false)
  })
})

/* ================================================================== *
 * MUST 7 — the structured response when automatic retry is unsafe
 * ================================================================== */

describe('§17.11 — the client receives head, intent and conflict path when retry is unsafe', () => {
  it('returns all three, and the head is a copy the caller cannot corrupt', () => {
    const intent: OverlayOperation[] = [{type: 'set', path: ['title'], value: 'Client title'}]
    const result = compareOverlayHeads(
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: OTHER_SAME_PATH},
        requestedIntent: intent,
      }),
    )

    expect(result.safe).toBe(false)
    expect(result.currentHead).toEqual(OTHER_SAME_PATH)
    expect(result.requestedIntent).toEqual(intent)
    expect(result.conflictPaths).toEqual([['title']])

    result.currentHead.title = 'mutated'
    expect(OTHER_SAME_PATH.title).toBe('Other head title')
    result.requestedIntent[0] = {type: 'unset', path: ['x']}
    expect(intent[0]).toEqual({type: 'set', path: ['title'], value: 'Client title'})
  })

  it('is a pure function — two evaluations produce identical output', () => {
    const build = (): OverlayHeadComparisonRequest =>
      request({
        currentOverlay: {revision: 'overlay-rev-2', document: OTHER_SAME_PATH},
        requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}],
      })
    expect(JSON.stringify(compareOverlayHeads(build()))).toBe(
      JSON.stringify(compareOverlayHeads(build())),
    )
  })

  it('does not mutate the documents it was handed', () => {
    const snapshot = JSON.stringify(OBSERVED)
    compareOverlayHeads(
      request({requestedIntent: [{type: 'set', path: ['title'], value: 'Client title'}]}),
    )
    expect(JSON.stringify(OBSERVED)).toBe(snapshot)
  })

  it('treats a whole-document replacement as unsafe whenever the heads differ', () => {
    const result = compareOverlayHeads(
      request({
        requestedIntent: [
          {type: 'replaceDocument', document: {...OBSERVED, title: 'Client replacement'}},
        ],
      }),
    )
    expect(result.safe).toBe(false)
    expect(result.conflictPaths).toEqual([[]])
  })
})
