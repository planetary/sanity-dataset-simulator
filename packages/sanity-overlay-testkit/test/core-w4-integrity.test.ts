import {describe, expect, it} from 'vitest'
import {
  DEFAULT_MAX_REFERENCE_DEPTH,
  OverlayReferenceError,
  assertReverseScanComplete,
  createBaseReverseSource,
  createStrongReferenceCheck,
  incomingReferences,
  publishReferenceIssues,
  scanReverseReferences,
} from '../../sanity-overlay-core/src/references/index'
import {
  OverlayActionBlockedError,
  applyTransaction,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  edit,
  publish,
  unpublish,
} from '../../sanity-overlay-core/src/index'
import type {ActionOptions, OverlayState} from '../../sanity-overlay-core/src/index'
import {
  BASE_DOCUMENTS,
  BASE_REVERSE_HITS,
  REFERENCE_SCHEMA,
  createTransactionSource,
} from '../src/referenceFixtures'

// Phase 2 workstream W4 — reverse references and integrity (plan §7).
// PRD §19.4 reverse reference implementation, §19.5 strong/weak integrity,
// §18.6 unpublish re-evaluation, §18.8 delete blocking, invariant §34.10,
// §35.6 reference tests 5-9, §11.1 query.maxReferenceDepth.

const base = createBaseSource(BASE_DOCUMENTS)
const baseReferences = createBaseReverseSource(BASE_REVERSE_HITS)
const tx = createTransactionSource()

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-w4'})
}

/* ------------------------------------------------------------------ *
 * §19.4 — overlay reverse reference scan
 * ------------------------------------------------------------------ */

describe('scanReverseReferences (PRD §19.4)', () => {
  it('takes base-side references($ids) hits as an injected input', () => {
    const asked: string[][] = []
    const result = scanReverseReferences(emptyState(), {
      targetIds: ['author-1'],
      base,
      baseReferences: (ids) => {
        asked.push([...ids])
        return baseReferences(ids)
      },
    })

    expect(asked[0]).toEqual(['author-1'])
    expect(result.references.map((reference) => reference.referringDocumentId)).toEqual([
      'page-1',
      'page-2',
    ])
  })

  it('computes the exact path and strength even from a pathless base hit', () => {
    const result = scanReverseReferences(emptyState(), {
      targetIds: ['page-1'],
      base,
      baseReferences,
    })

    expect(result.references).toEqual([
      {
        referringDocumentId: 'review-1',
        perspective: 'drafts',
        path: ['page'],
        targetId: 'page-1',
        strength: 'strong',
        source: 'base',
        depth: 1,
      },
    ])
  })

  it('falls back to the base hit path and strength when the referrer is not readable', () => {
    // The adapter answered `references($ids)` for a document the base source
    // cannot hand back. The hit itself is then the only evidence there is, so it
    // is carried through rather than silently dropped (§19.4 "combine").
    const result = scanReverseReferences(emptyState(), {
      targetIds: ['author-1'],
      base,
      baseReferences: [
        {
          referringDocumentId: 'unreadable-1',
          targetId: 'author-1',
          path: ['byline'],
          strength: 'weak',
        },
      ],
    })

    expect(result.references).toEqual([
      {
        referringDocumentId: 'unreadable-1',
        perspective: 'drafts',
        path: ['byline'],
        targetId: 'author-1',
        strength: 'weak',
        source: 'base',
        depth: 1,
      },
    ])
  })

  it('never falls back to a base hit for a document the overlay knows about', () => {
    // The overlay is authoritative once it holds a record: §19.4 applies local
    // tombstones and modifications *before* deciding integrity, so a stale base
    // hit must not resurrect a locally deleted referrer.
    const created = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'unreadable-1',
            _type: 'page',
            byline: {_type: 'reference', _ref: 'author-1'},
          },
        },
      ],
      {...tx(), base},
    ).state
    const state = deleteDocument(created, {id: 'unreadable-1'}, {...tx(), base}).state

    expect(
      scanReverseReferences(state, {
        targetIds: ['author-1'],
        base,
        baseReferences: [
          {referringDocumentId: 'unreadable-1', targetId: 'author-1', path: ['byline']},
        ],
      }).references,
    ).toEqual([])
  })

  it('carries weak strength through from the referring value', () => {
    const result = scanReverseReferences(emptyState(), {
      targetIds: ['author-2'],
      base,
      baseReferences,
    })

    expect(result.references[0]).toMatchObject({
      referringDocumentId: 'page-1',
      path: ['editor'],
      strength: 'weak',
    })
  })

  it('scans overlay documents for local references with no base hit at all', () => {
    const state = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'page-3',
            _type: 'page',
            title: 'Branch page',
            author: {_type: 'reference', _ref: 'author-1'},
          },
        },
      ],
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base})

    expect(result.references).toEqual([
      {
        referringDocumentId: 'page-3',
        perspective: 'drafts',
        path: ['author'],
        targetId: 'author-1',
        strength: 'strong',
        source: 'overlay',
        depth: 1,
      },
    ])
  })

  it('7. (§35.6) reverse reference combines base and overlay references', () => {
    const state = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'page-3',
            _type: 'page',
            author: {_type: 'reference', _ref: 'author-1'},
          },
        },
      ],
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})

    expect(
      result.references.map((reference) => [reference.referringDocumentId, reference.source]),
    ).toEqual([
      ['page-1', 'base'],
      ['page-2', 'base'],
      ['page-3', 'overlay'],
    ])
    // Depth-1 direct referrers are always fully enumerated. `complete` describes
    // the *transitive closure* only, and `review-1 -> page-1` sits one hop past
    // the default bound, so the closure is reported truncated (§19.4, §11.1).
    expect(result.references.every((reference) => reference.depth === 1)).toBe(true)
    expect(result.complete).toBe(false)
  })

  it('deduplicates a reference reported by both sides into one entry', () => {
    const state = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'set', path: ['title'], value: 'Compilers, revised'}]},
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})
    const page1 = result.references.filter(
      (reference) => reference.referringDocumentId === 'page-1',
    )

    expect(page1).toHaveLength(1)
    expect(page1[0]?.source).toBe('both')
  })

  it('8. (§35.6) a local change that removes a base reference drops the base hit', () => {
    const state = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'unset', path: ['author']}]},
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})

    expect(result.references.map((reference) => reference.referringDocumentId)).toEqual(['page-2'])
  })

  it('9. (§35.6) a local change that adds a reference shows up in the scan', () => {
    const state = edit(
      emptyState(),
      {
        id: 'page-2',
        operations: [{type: 'set', path: ['author'], value: {_type: 'reference', _ref: 'author-1'}}],
      },
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})
    const page2 = result.references.filter(
      (reference) => reference.referringDocumentId === 'page-2',
    )

    expect(page2.map((reference) => reference.path)).toEqual([['author'], ['related', {_key: 'r1'}]])
    expect(page2.map((reference) => reference.source)).toEqual(['overlay', 'both'])
  })

  it('applies local tombstones before deciding integrity', () => {
    const state = deleteDocument(emptyState(), {id: 'page-2'}, {...tx(), base}).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})

    expect(result.references.map((reference) => reference.referringDocumentId)).toEqual(['page-1'])
  })

  it('scans the published perspective when asked', () => {
    const state = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'unset', path: ['author']}]},
      {...tx(), base},
    ).state

    // The draft dropped the reference; the published version still holds it.
    expect(
      scanReverseReferences(state, {
        targetIds: ['author-1'],
        base,
        baseReferences,
        perspective: 'published',
      }).references.map((reference) => reference.referringDocumentId),
    ).toEqual(['page-1', 'page-2'])
  })

  describe('recursion bounds (PRD §11.1 query.maxReferenceDepth)', () => {
    it('defaults to direct referrers only', () => {
      expect(DEFAULT_MAX_REFERENCE_DEPTH).toBe(1)

      const result = scanReverseReferences(emptyState(), {
        targetIds: ['author-1'],
        base,
        baseReferences,
      })

      expect(result.maxReferenceDepth).toBe(1)
      expect(result.references.every((reference) => reference.depth === 1)).toBe(true)
    })

    it('expands transitively up to the configured depth', () => {
      const result = scanReverseReferences(emptyState(), {
        targetIds: ['author-1'],
        base,
        baseReferences,
        maxReferenceDepth: 2,
      })

      expect(
        result.references.map((reference) => [reference.referringDocumentId, reference.depth]),
      ).toEqual([
        ['page-1', 1],
        ['page-2', 1],
        ['review-1', 2],
      ])
      expect(result.truncated).toBe(false)
      expect(result.complete).toBe(true)
    })

    it('reports truncation as an error, not a complete result', () => {
      const result = scanReverseReferences(emptyState(), {
        targetIds: ['author-1'],
        base,
        baseReferences,
        maxReferenceDepth: 1,
      })

      expect(result.truncated).toBe(true)
      expect(result.complete).toBe(false)
      expect(result.error).toBeInstanceOf(OverlayReferenceError)
      expect(result.error?.referenceCode).toBe('OVERLAY_REFERENCE_DEPTH_EXCEEDED')
      expect(result.error?.details).toMatchObject({maxReferenceDepth: 1})
    })

    it('assertReverseScanComplete throws the truncation error', () => {
      const result = scanReverseReferences(emptyState(), {
        targetIds: ['author-1'],
        base,
        baseReferences,
        maxReferenceDepth: 1,
      })

      expect(() => assertReverseScanComplete(result)).toThrowError(OverlayReferenceError)
      expect(() =>
        assertReverseScanComplete(
          scanReverseReferences(emptyState(), {
            targetIds: ['author-1'],
            base,
            baseReferences,
            maxReferenceDepth: 2,
          }),
        ),
      ).not.toThrow()
    })

    it('throws at scan time when onTruncation is "throw"', () => {
      expect(() =>
        scanReverseReferences(emptyState(), {
          targetIds: ['author-1'],
          base,
          baseReferences,
          maxReferenceDepth: 1,
          onTruncation: 'throw',
        }),
      ).toThrowError(/maxReferenceDepth/)
    })

    it('terminates on a reference cycle without reporting false truncation', () => {
      const state = applyTransaction(
        emptyState(),
        [
          {
            type: 'create',
            document: {_id: 'cycle-a', _type: 'page', ref: {_type: 'reference', _ref: 'cycle-b'}},
          },
          {
            type: 'create',
            document: {_id: 'cycle-b', _type: 'page', ref: {_type: 'reference', _ref: 'cycle-a'}},
          },
        ],
        {...tx(), base},
      ).state

      const result = scanReverseReferences(state, {
        targetIds: ['cycle-a'],
        base,
        maxReferenceDepth: 5,
      })

      expect(
        result.references.map((reference) => [reference.referringDocumentId, reference.targetId]),
      ).toEqual([
        ['cycle-b', 'cycle-a'],
        ['cycle-a', 'cycle-b'],
      ])
      expect(result.truncated).toBe(false)
    })

    it('rejects a non-positive maxReferenceDepth', () => {
      expect(() =>
        scanReverseReferences(emptyState(), {targetIds: ['author-1'], base, maxReferenceDepth: 0}),
      ).toThrowError(OverlayReferenceError)
    })
  })

  it('accepts a plain array of base hits as well as a source function', () => {
    const result = scanReverseReferences(emptyState(), {
      targetIds: ['author-1'],
      base,
      baseReferences: BASE_REVERSE_HITS,
    })

    expect(result.references.map((reference) => reference.referringDocumentId)).toEqual([
      'page-1',
      'page-2',
    ])
  })

  it('is deterministic: sorted by depth, then document, then path', () => {
    const state = applyTransaction(
      emptyState(),
      [
        {
          type: 'create',
          document: {
            _id: 'aaa-page',
            _type: 'page',
            zeta: {_type: 'reference', _ref: 'author-1'},
            alpha: {_type: 'reference', _ref: 'author-1'},
          },
        },
      ],
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})

    expect(
      result.references.map((reference) => [reference.referringDocumentId, reference.path]),
    ).toEqual([
      ['aaa-page', ['alpha']],
      ['aaa-page', ['zeta']],
      ['page-1', ['author']],
      ['page-2', ['related', {_key: 'r1'}]],
    ])
  })
})

/* ------------------------------------------------------------------ *
 * Regression — separator collisions in the §19.4 dedupe key
 * ------------------------------------------------------------------ *
 *
 * The scan deduplicates findings by an identity built from three strings: the
 * referring document ID, the encoded path, and the target ID. Joining them with
 * a separator `S` makes that identity ambiguous the moment any of the three
 * contains `S`: the string `a S b S c S d` splits as `(a, b, "c S d")` and just
 * as well as `("a S b", c, d)`, so two GENUINELY DIFFERENT reverse references
 * collapse into one entry and the scan under-reports.
 *
 * That is not cosmetic. `incomingReferences` and `createStrongReferenceCheck`
 * (§18.8, invariant §34.10) refuse a delete exactly when the scan still shows an
 * incoming strong reference, so a dropped finding is a delete that should have
 * been blocked and was not.
 *
 * The three parts are unconstrained strings by core's own contract: `_ref` is
 * verbatim document content (`isReferenceValue` only requires a non-empty
 * string) and the logical-ID encoder deliberately escapes EVERY byte outside
 * `[a-z0-9_-]` (`encoding.ts` section (b)), which is a written statement that
 * IDs carry arbitrary bytes. `encodeOverlayPath` is injective on its own — the
 * collision comes from the join, not from the encoder — so the fix is a
 * structural key, and the family below is parameterised over separators so that
 * no future choice of `S` can reintroduce it.
 */
describe('the §19.4 dedupe key is separator-independent', () => {
  const SEPARATORS: ReadonlyArray<{name: string; char: string}> = [
    {name: 'a NUL', char: '\u0000'},
    {name: 'a space', char: ' '},
    {name: 'a comma', char: ','},
    {name: 'a pipe', char: '|'},
    {name: 'a newline', char: '\n'},
  ]

  for (const {name, char} of SEPARATORS) {
    it(`keeps two distinct reverse references apart when the parts contain ${name}`, () => {
      /* Both tuples join to `doc-a S $.p S $.q S b` under any separator `S`:
       * the joined string carries three separators and the key only accounts
       * for two of them. */
      const firstReferrer = 'doc-a'
      const firstTarget = `$.q${char}b`
      const secondReferrer = `doc-a${char}$.p`
      const secondTarget = 'b'

      const state = applyTransaction(
        emptyState(),
        [
          {
            type: 'create',
            document: {
              _id: firstReferrer,
              _type: 'page',
              p: {_type: 'reference', _ref: firstTarget},
            },
          },
          {
            type: 'create',
            document: {
              _id: secondReferrer,
              _type: 'page',
              q: {_type: 'reference', _ref: secondTarget},
            },
          },
        ],
        tx(),
      ).state

      const result = scanReverseReferences(state, {targetIds: [firstTarget, secondTarget]})

      /* Independent oracle: two different documents each hold one reference, at
       * different paths, to different targets. Nothing about them is duplicate,
       * so the scan owes exactly two findings. */
      expect(
        result.references.map((reference) => [
          reference.referringDocumentId,
          reference.path,
          reference.targetId,
        ]),
      ).toEqual([
        [firstReferrer, ['p'], firstTarget],
        [secondReferrer, ['q'], secondTarget],
      ])
    })
  }

  /**
   * The consequence, spelled out at the §18.8 boundary rather than at the key.
   *
   * Two documents refer to `b`: one weakly, one strongly. Their dedupe keys
   * collide, the first one entered wins, and the survivor is the WEAK one — so
   * the scan reports `b` as weakly referenced only and the delete check finds
   * nothing to refuse. A strong reference is left dangling, which invariant
   * §34.10 says can never happen.
   *
   * The two paths are `["p\u0000$", "q"]` and `["q"]`: encoded they are
   * `$.p<S>$.q` and `$.q`, which is what lets one referrer ID absorb the other
   * referrer ID plus a whole path segment.
   */
  it.each([
    {name: 'a NUL', char: '\u0000'},
    {name: 'a space', char: ' '},
    {name: 'a comma', char: ','},
    {name: 'a pipe', char: '|'},
  ])('refuses a delete whose only strong referrer collides under $name', ({char}) => {
    const weakReferrer = 'doc-a'
    const strongReferrer = `doc-a${char}$.p`

    const state = applyTransaction(
      emptyState(),
      [
        {type: 'create', document: {_id: 'b', _type: 'page', title: 'Target'}},
        {
          type: 'create',
          document: {
            _id: weakReferrer,
            _type: 'page',
            [`p${char}$`]: {q: {_type: 'reference', _ref: 'b', _weak: true}},
          },
        },
        {
          type: 'create',
          document: {
            _id: strongReferrer,
            _type: 'page',
            q: {_type: 'reference', _ref: 'b'},
          },
        },
      ],
      tx(),
    ).state

    /* Independent oracle: the state itself. `strongReferrer` holds a reference
     * value with no `_weak` marker, which §19.5 classifies as strong, and it is
     * still there when the delete is attempted. §18.8 must refuse. */
    expect(() =>
      deleteDocument(
        state,
        {id: 'b'},
        {...tx(), checkStrongReferences: createStrongReferenceCheck(state, {})},
      ),
    ).toThrowError(OverlayActionBlockedError)

    /* And the scan the check reads must have seen both referrers, not one. */
    expect(
      scanReverseReferences(state, {targetIds: ['b']}).references.map(
        (reference) => reference.strength,
      ),
    ).toEqual(['weak', 'strong'])
  })

  it('still collapses a genuinely duplicate finding into one entry', () => {
    /* The other half of the contract: the fix must not turn the dedupe off.
     * `page-1` referring to `author-1` is reported by BOTH the base hits and the
     * overlay re-extraction, and must stay one entry marked `both`. */
    const state = edit(
      emptyState(),
      {id: 'page-1', operations: [{type: 'set', path: ['title'], value: 'Compilers, revised'}]},
      {...tx(), base},
    ).state

    const result = scanReverseReferences(state, {targetIds: ['author-1'], base, baseReferences})
    const page1 = result.references.filter(
      (reference) => reference.referringDocumentId === 'page-1',
    )

    expect(page1).toHaveLength(1)
    expect(page1[0]?.source).toBe('both')
  })
})

/* ------------------------------------------------------------------ *
 * §18.8 / §19.5 / §34.10 — strong and weak integrity checks
 * ------------------------------------------------------------------ */

/** Transaction options carrying the W4 strong-reference port for `state`. */
function checked(state: OverlayState): ActionOptions {
  return {
    ...tx(),
    base,
    checkStrongReferences: createStrongReferenceCheck(state, {
      base,
      baseReferences,
      schema: REFERENCE_SCHEMA,
    }),
  }
}

describe('strong and weak integrity (PRD §18.8, §19.5, §34.10)', () => {
  it('5. (§35.6) a strong reference blocks the target delete', () => {
    const state = emptyState()

    expect(() => deleteDocument(state, {id: 'page-1'}, checked(state))).toThrowError(
      OverlayActionBlockedError,
    )

    let details: unknown
    try {
      deleteDocument(state, {id: 'page-1'}, checked(state))
    } catch (error) {
      details = (error as OverlayActionBlockedError).details
    }
    expect(details).toMatchObject({
      documentId: 'page-1',
      references: [
        {
          referringDocumentId: 'review-1',
          path: ['page'],
          targetId: 'page-1',
          strength: 'strong',
          reason: 'target-deleted',
        },
      ],
    })
  })

  it('6. (§35.6) a weak reference permits the target delete', () => {
    const state = emptyState()
    // `author-2` is referenced only from `page-1.editor`, which is weak.
    const result = deleteDocument(state, {id: 'author-2'}, checked(state))

    expect(result.state.documents['author-2']?.local.publishedTombstone).toBe(true)
    expect(result.state.documents['author-2']?.local.draftTombstone).toBe(true)
  })

  it('permits the delete when the same transaction deletes every referrer (§18.8)', () => {
    const state = emptyState()
    const result = applyTransaction(
      state,
      [
        {type: 'delete', id: 'page-1'},
        {type: 'delete', id: 'review-1'},
      ],
      checked(state),
    )

    expect(result.state.documents['page-1']?.local.publishedTombstone).toBe(true)
    expect(result.state.documents['review-1']?.local.publishedTombstone).toBe(true)
  })

  it('permits the delete when the same transaction updates every referrer (§18.8)', () => {
    const state = emptyState()
    const result = applyTransaction(
      state,
      [
        {type: 'patch', id: 'review-1', operations: [{type: 'unset', path: ['page']}]},
        {type: 'delete', id: 'page-1'},
      ],
      checked(state),
    )

    expect(result.state.documents['page-1']?.local.publishedTombstone).toBe(true)
  })

  it('8. (§35.6) a local change that removes a base reference unblocks the delete check', () => {
    const before = emptyState()
    expect(() => deleteDocument(before, {id: 'page-1'}, checked(before))).toThrowError(
      OverlayActionBlockedError,
    )

    const state = applyTransaction(
      before,
      [{type: 'patch', id: 'review-1', operations: [{type: 'unset', path: ['page']}]}],
      {...tx(), base},
    ).state

    expect(incomingReferences(state, 'page-1', {base, baseReferences})).toEqual([])
    expect(
      deleteDocument(state, {id: 'page-1'}, checked(state)).state.documents['page-1']?.local
        .publishedTombstone,
    ).toBe(true)
  })

  it('9. (§35.6) a local change that adds a reference blocks the delete check', () => {
    const before = emptyState()
    // `author-2` starts weakly referenced only, so the delete is permitted.
    expect(() => deleteDocument(before, {id: 'author-2'}, checked(before))).not.toThrow()

    const state = applyTransaction(
      before,
      [
        {
          type: 'create',
          document: {
            _id: 'page-3',
            _type: 'page',
            author: {_type: 'reference', _ref: 'author-2'},
          },
        },
      ],
      {...tx(), base},
    ).state

    expect(() => deleteDocument(state, {id: 'author-2'}, checked(state))).toThrowError(
      /strong reference/i,
    )
  })

  it('checks both perspectives, so a draft-only removal still blocks the delete', () => {
    // `edit` writes a local draft; the published `review-1` still points at
    // `page-1`, so the virtual dataset still holds a strong reference (§18.8).
    const state = edit(
      emptyState(),
      {id: 'review-1', operations: [{type: 'unset', path: ['page']}]},
      {...tx(), base},
    ).state

    expect(() => deleteDocument(state, {id: 'page-1'}, checked(state))).toThrowError(
      OverlayActionBlockedError,
    )
    expect(
      incomingReferences(state, 'page-1', {base, baseReferences, perspective: 'drafts'}),
    ).toEqual([])
  })

  it('reports incoming references with their reason for a delete', () => {
    expect(incomingReferences(emptyState(), 'author-1', {base, baseReferences})).toEqual([
      {
        referringDocumentId: 'page-1',
        path: ['author'],
        targetId: 'author-1',
        strength: 'strong',
        reason: 'target-deleted',
      },
      {
        referringDocumentId: 'page-2',
        path: ['related', {_key: 'r1'}],
        targetId: 'author-1',
        strength: 'strong',
        reason: 'target-deleted',
      },
    ])
  })

  describe('branch publish (PRD §19.5, invariant §34.10)', () => {
    /** A draft-only `author-9` plus a `page-1` draft that references it. */
    function withDraftOnlyTarget(strength: 'strong' | 'weak'): OverlayState {
      const created = applyTransaction(
        emptyState(),
        [
          {
            type: 'create',
            document: {_id: 'drafts.author-9', _type: 'author', name: 'Draft only'},
          },
        ],
        {...tx(), base},
      ).state

      return edit(
        created,
        {
          id: 'page-1',
          operations: [
            {
              type: 'set',
              path: ['author'],
              value: {
                _type: 'reference',
                _ref: 'author-9',
                ...(strength === 'weak' ? {_weak: true} : {}),
              },
            },
          ],
        },
        {...tx(), base},
      ).state
    }

    it('a strong reference to a branch draft-only target blocks branch publish', () => {
      const state = withDraftOnlyTarget('strong')

      expect(() => publish(state, {id: 'page-1'}, checked(state))).toThrowError(
        OverlayActionBlockedError,
      )
      expect(publishReferenceIssues(state, 'page-1', {base, schema: REFERENCE_SCHEMA})).toEqual([
        {
          referringDocumentId: 'page-1',
          path: ['author'],
          targetId: 'author-9',
          strength: 'strong',
          reason: 'target-draft-only',
        },
      ])
    })

    it('a weak reference to the same draft-only target permits branch publish', () => {
      const state = withDraftOnlyTarget('weak')

      expect(() => publish(state, {id: 'page-1'}, checked(state))).not.toThrow()
    })

    it('reports a tombstoned target as deleted, not draft-only', () => {
      const deleted = deleteDocument(emptyState(), {id: 'author-1'}, {...tx(), base}).state

      expect(publishReferenceIssues(deleted, 'page-1', {base, schema: REFERENCE_SCHEMA})).toEqual([
        {
          referringDocumentId: 'page-1',
          path: ['author'],
          targetId: 'author-1',
          strength: 'strong',
          reason: 'target-deleted',
        },
      ])
    })

    it('a published base target does not block branch publish', () => {
      const state = edit(
        emptyState(),
        {id: 'page-1', operations: [{type: 'set', path: ['title'], value: 'Compilers, revised'}]},
        {...tx(), base},
      ).state

      expect(publishReferenceIssues(state, 'page-1', {base, schema: REFERENCE_SCHEMA})).toEqual([])
      expect(() => publish(state, {id: 'page-1'}, checked(state))).not.toThrow()
    })
  })

  it('unpublish re-evaluates strong references pointing at the target (§18.6)', () => {
    const state = emptyState()
    const result = unpublish(state, {id: 'author-1'}, checked(state))

    expect(result.affectedStrongReferences).toEqual([
      {
        referringDocumentId: 'page-1',
        path: ['author'],
        targetId: 'author-1',
        strength: 'strong',
        reason: 'target-unpublished',
      },
      {
        referringDocumentId: 'page-2',
        path: ['related', {_key: 'r1'}],
        targetId: 'author-1',
        strength: 'strong',
        reason: 'target-unpublished',
      },
    ])
    // §18.6 re-evaluates and reports; it never blocks.
    expect(result.state.documents['author-1']?.local.publishedTombstone).toBe(true)
  })

  it('unpublish does not report the weak referrer of the unpublished document', () => {
    const state = emptyState()
    const result = unpublish(state, {id: 'author-2'}, checked(state))

    expect(result.affectedStrongReferences).toEqual([])
  })
})
