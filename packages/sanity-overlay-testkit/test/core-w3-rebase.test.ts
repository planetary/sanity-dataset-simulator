import {describe, expect, it} from 'vitest'
import {encodeOverlayPath, serialize} from '../../sanity-overlay-core/src/index'
import type {OverlayPath, SanityDocument} from '../../sanity-overlay-core/src/index'
import {
  AUTO_REBASE_PRECONDITIONS,
  REBASE_MODES,
  applyRebaseMode,
  autoRebase,
} from '../../sanity-overlay-core/src/merge/index'
import type {
  AutoRebaseRequest,
  AutoRebaseResult,
} from '../../sanity-overlay-core/src/merge/index'
import {
  ANCESTOR_ARTICLE,
  clone,
  keysOf,
  localVariant,
  scenarioCorpus,
  section,
  variant,
} from '../src/mergeFixtures'

// Phase 2 workstream W3 — PRD §28.5 automatic rebase (four preconditions, five
// steps), §28.4 rebase modes, §13.3 v1.1 ancestor replacement rules.
// Covers PRD §35.2 "Local value equal to current base removes redundant override
// on rebase" and the plan §8.5 rebase properties.

const NOW = '2026-08-04T09:00:00.000Z'

function rebaseRequest(overrides: Partial<AutoRebaseRequest> = {}): AutoRebaseRequest {
  return {
    documentId: 'article-1',
    now: NOW,
    transactionId: 'txn-rebase-1',
    ancestor: ANCESTOR_ARTICLE,
    ancestorRevision: 'base-rev-1',
    currentBase: clone(ANCESTOR_ARTICLE),
    currentBaseRevision: 'base-rev-2',
    localMaterialized: null,
    localTouchedPaths: [],
    ...overrides,
  }
}

function encoded(paths: readonly OverlayPath[]): string[] {
  return paths.map(encodeOverlayPath).sort()
}

function blocked(result: AutoRebaseResult): string[] {
  return [...result.blockedBy].sort()
}

/** A base that moved a single untouched field — the safe-rebase baseline. */
const SAFE_BASE = variant(ANCESTOR_ARTICLE, (document) => {
  document.summary = 'Upstream summary'
})

const LOCAL_TITLE = localVariant(ANCESTOR_ARTICLE, (document) => {
  document.title = 'Branch title'
})

/* ------------------------------------------------------------------ *
 * §28.5 — the four preconditions
 * ------------------------------------------------------------------ */

describe('§28.5 automatic rebase preconditions', () => {
  it('names exactly the four documented preconditions, in a stable order', () => {
    expect(AUTO_REBASE_PRECONDITIONS).toEqual([
      'base-changed-only-on-untouched-paths',
      'array-additions-have-distinct-keys',
      'local-operations-apply-without-changing-meaning',
      'no-base-deletion-or-parent-shape-change',
    ])
  })

  it('applies when base changed only on untouched paths', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: SAFE_BASE,
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.applied).toBe(true)
    expect(result.blockedBy).toEqual([])
    expect(result.preconditions.map((entry) => entry.satisfied)).toEqual([true, true, true, true])
    expect(result.preconditions.map((entry) => entry.id)).toEqual(AUTO_REBASE_PRECONDITIONS)
  })

  it('blocks when base changed a path the branch touched', () => {
    const input = rebaseRequest({
      currentBase: variant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Upstream title'
      }),
      localMaterialized: LOCAL_TITLE,
      localTouchedPaths: [['title']],
    })
    const result = autoRebase(input)

    expect(result.applied).toBe(false)
    expect(blocked(result)).toEqual(['base-changed-only-on-untouched-paths'])
    // Nothing is changed by a blocked rebase.
    expect(result.ancestor).toEqual(input.ancestor)
    expect(result.ancestorRevision).toBe('base-rev-1')
    expect(encoded(result.touchedPaths)).toEqual(['$.title'])
    expect(result.removedTouchedPaths).toEqual([])
    expect(result.audit).toBeNull()
  })

  it('blocks when both sides added the same array `_key`', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          ;(document.sections as Record<string, unknown>[]).push(section('x', 'Upstream X'))
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          ;(document.sections as Record<string, unknown>[]).push(section('x', 'Branch X'))
        }),
        localTouchedPaths: [['sections', {_key: 'x'}]],
      }),
    )

    expect(result.applied).toBe(false)
    expect(blocked(result)).toContain('array-additions-have-distinct-keys')
  })

  it('allows distinct concurrent array additions', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          ;(document.sections as Record<string, unknown>[]).push(section('bx', 'Upstream'))
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          ;(document.sections as Record<string, unknown>[]).push(section('lx', 'Branch'))
        }),
        localTouchedPaths: [['sections', {_key: 'lx'}]],
      }),
    )

    expect(result.applied).toBe(true)
    // §17.7 rule 2: the local insertion sits immediately after its recorded
    // anchor `b`; rule 3 keeps the concurrent base insertion after `b` too.
    expect(keysOf(result.merge.document?.sections)).toEqual(['a', 'b', 'lx', 'bx'])
  })

  it('blocks when an increment would change meaning against a moved base number', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.views = 25
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.views = 25
        }),
        localTouchedPaths: [['views']],
        operations: [{type: 'inc', path: ['views'], amount: 15}],
      }),
    )

    // Local already equals base, so precondition 1 is satisfied — but §17.8 says
    // an increment against a base number that moved after the ancestor conflicts.
    expect(blocked(result)).toEqual(['local-operations-apply-without-changing-meaning'])
    expect(result.applied).toBe(false)
  })

  it('blocks when a diff-match-patch would be replayed against changed base text', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.summary = 'Upstream rewrote the summary'
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.summary = 'Upstream rewrote the summary'
        }),
        localTouchedPaths: [['summary']],
        operations: [{type: 'diffMatchPatch', path: ['summary'], patch: '@@ -1 +1 @@\n-a\n+b\n'}],
      }),
    )

    expect(blocked(result)).toEqual(['local-operations-apply-without-changing-meaning'])
  })

  it('blocks when an insert anchor `_key` no longer exists in the current base', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.sections = (document.sections as Record<string, unknown>[]).filter(
            (item) => item._key !== 'b',
          )
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          ;(document.sections as Record<string, unknown>[]).push(section('lx', 'Branch'))
        }),
        localTouchedPaths: [['sections', {_key: 'lx'}]],
        operations: [
          {
            type: 'insert',
            path: ['sections', {_key: 'b'}],
            position: 'after',
            items: [section('lx', 'Branch')],
          },
        ],
      }),
    )

    expect(blocked(result)).toContain('local-operations-apply-without-changing-meaning')
  })

  it('blocks when a set-if-missing would no longer apply', () => {
    const result = autoRebase(
      rebaseRequest({
        ancestor: variant(ANCESTOR_ARTICLE, (document) => {
          delete document.subtitle
        }),
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.subtitle = 'Upstream filled it in'
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.subtitle = 'Branch subtitle'
        }),
        localTouchedPaths: [['subtitle']],
        operations: [{type: 'setIfMissing', path: ['subtitle'], value: 'Branch subtitle'}],
      }),
    )

    expect(blocked(result)).toContain('local-operations-apply-without-changing-meaning')
  })

  it('blocks on base deletion', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: null,
        baseStatus: 'deleted',
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.applied).toBe(false)
    expect(blocked(result)).toContain('no-base-deletion-or-parent-shape-change')
    // §34.14 still holds: the preview keeps the materialized local document.
    expect(result.merge.document?.title).toBe('Branch title')
  })

  it('an UNOBSERVABLE base still blocks the rebase, but is not called a deletion', () => {
    /* Rebasing needs a current base to rebase ONTO, so `currentBase: null`
     * must block whatever the reason — but "The base document was deleted" is
     * an OBSERVATION, and nobody made it (see the merge suite's unobservable-
     * base tests, 2026-08-11). The precondition must state the true reason. */
    const result = autoRebase(
      rebaseRequest({
        currentBase: null,
        baseStatus: 'present',
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.applied).toBe(false)
    const precondition = result.preconditions.find(
      (candidate) => candidate.id === 'no-base-deletion-or-parent-shape-change',
    )
    expect(precondition?.satisfied).toBe(false)
    expect(precondition?.detail).not.toContain('deleted')
  })

  it('blocks on a parent shape change', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.hero = 'now a string'
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
        }),
        localTouchedPaths: [['hero', 'heading']],
      }),
    )

    expect(result.applied).toBe(false)
    expect(blocked(result)).toContain('no-base-deletion-or-parent-shape-change')
  })

  it('blocks on a base `_type` change', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document._type = 'story'
        }),
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
      }),
    )
    expect(blocked(result)).toContain('no-base-deletion-or-parent-shape-change')
  })
})

/* ------------------------------------------------------------------ *
 * §28.5 — the five steps
 * ------------------------------------------------------------------ */

describe('§28.5 automatic rebase steps', () => {
  const applied = (): AutoRebaseResult =>
    autoRebase(
      rebaseRequest({
        currentBase: SAFE_BASE,
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
        baseBlock: {
          firstTouchedAt: '2026-02-02T00:00:00.000Z',
          published: {
            revision: 'base-rev-1',
            snapshot: ANCESTOR_ARTICLE,
            checksum: 'ignored',
            capturedAt: '2026-02-02T00:00:00.000Z',
          },
          draft: null,
          baseStatus: 'present',
        },
      }),
    )

  it('step 1 — updates the ancestor snapshot and revision', () => {
    const result = applied()
    expect(serialize(result.ancestor)).toBe(serialize(SAFE_BASE))
    expect(result.ancestorRevision).toBe('base-rev-2')
    expect(serialize(result.baseBlock?.published?.snapshot)).toBe(serialize(SAFE_BASE))
    expect(result.baseBlock?.published?.revision).toBe('base-rev-2')
  })

  it('step 1 — never modifies `firstTouchedAt` (PRD §13.3 v1.1)', () => {
    expect(applied().baseBlock?.firstTouchedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('step 2 — preserves local materialized values', () => {
    const result = applied()
    expect(result.localMaterialized?.title).toBe('Branch title')
    expect(result.merge.document?.title).toBe('Branch title')
    // …and the untouched path now inherits the new ancestor, which is the base.
    expect(result.merge.document?.summary).toBe('Upstream summary')
  })

  it('step 3 — removes obsolete touched paths whose local value now equals base', () => {
    // PRD §35.2: "Local value equal to current base removes redundant override on
    // rebase". Base moved `views` to 42 and the branch had already moved it to 42,
    // so there is nothing left to override.
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          document.views = 42
          document.summary = 'Upstream summary'
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.views = 42
        }),
        localTouchedPaths: [['views']],
      }),
    )

    expect(result.applied).toBe(true)
    expect(encoded(result.removedTouchedPaths)).toEqual(['$.views'])
    expect(result.touchedPaths).toEqual([])
    expect(result.merge.document?.views).toBe(42)
    expect(result.merge.document?.summary).toBe('Upstream summary')
  })

  it('step 3 — keeps a touched path whose local value still differs from base', () => {
    const result = applied()
    expect(encoded(result.touchedPaths)).toEqual(['$.title'])
    expect(result.removedTouchedPaths).toEqual([])
  })

  it('step 3 — never removes an explicit unset path (§34.11)', () => {
    const result = autoRebase(
      rebaseRequest({
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          delete document.summary
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          delete document.summary
        }),
        localTouchedPaths: [['summary']],
        unsetPaths: [['summary']],
      }),
    )

    expect(result.applied).toBe(true)
    // The base currently has no value either, but the unset must survive so a
    // *later* base value stays suppressed.
    expect(result.removedTouchedPaths).toEqual([])
    expect(encoded(result.touchedPaths)).toEqual(['$.summary'])
  })

  it('step 4 — records an audit transaction', () => {
    const result = applied()
    expect(result.audit).toEqual({
      transactionId: 'txn-rebase-1',
      type: 'auto-rebase',
      documentId: 'article-1',
      at: NOW,
      ancestorRevisionBefore: 'base-rev-1',
      ancestorRevisionAfter: 'base-rev-2',
      removedTouchedPaths: [],
    })
  })

  it('step 5 — revalidates the resolved document through the injected port', () => {
    const seen: string[] = []
    const result = autoRebase(
      rebaseRequest({
        currentBase: SAFE_BASE,
        localMaterialized: LOCAL_TITLE,
        localTouchedPaths: [['title']],
        validate: (document, context) => {
          seen.push(`${context.action}:${document._id}`)
          return [{level: 'warning', message: 'check the title'}]
        },
      }),
    )

    expect(seen).toContain('rebase:article-1')
    expect(result.validation).toEqual([{level: 'warning', message: 'check the title'}])
  })
})

/* ------------------------------------------------------------------ *
 * §28.4 rebase modes
 * ------------------------------------------------------------------ */

describe('§28.4 rebase modes', () => {
  const base = variant(ANCESTOR_ARTICLE, (document) => {
    document.summary = 'Upstream summary'
    document.views = 99
  })
  const local = localVariant(ANCESTOR_ARTICLE, (document) => {
    document.title = 'Branch title'
    ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
  })
  const modeRequest = {
    ...rebaseRequest({
      currentBase: base,
      localMaterialized: local,
      localTouchedPaths: [['title'], ['hero', 'heading']],
    }),
  }

  it('names exactly the five documented modes', () => {
    expect(REBASE_MODES).toEqual([
      'preview',
      'accept-base',
      'keep-local',
      'full-reset',
      'freeze',
    ])
  })

  it('preview recomputes against current base without changing local intent', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'preview'})

    expect(serialize(result.ancestor)).toBe(serialize(ANCESTOR_ARTICLE))
    expect(encoded(result.touchedPaths)).toEqual(['$.hero.heading', '$.title'])
    expect(result.merge.document?.title).toBe('Branch title')
    expect(result.merge.document?.summary).toBe('Upstream summary')
    // No intent changed, so no transaction is recorded.
    expect(result.audit).toBeNull()
  })

  it('accept-base drops the selected touched paths and inherits current base', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'accept-base', paths: [['title']]})

    expect(encoded(result.touchedPaths)).toEqual(['$.hero.heading'])
    expect(encoded(result.removedTouchedPaths)).toEqual(['$.title'])
    expect(result.merge.document?.title).toBe('Ancestor title')
    expect((result.merge.document?.hero as Record<string, unknown>).heading).toBe('Branch heading')
    expect(result.localMaterialized?.title).toBe('Ancestor title')
    expect(result.audit?.type).toBe('rebase-accept-base')
  })

  it('accept-base with no selection drops every local override', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'accept-base'})
    expect(result.touchedPaths).toEqual([])
    expect(serialize(result.merge.document)).toBe(serialize(base))
  })

  it('keep-local accepts current base as the new ancestor while retaining selected values', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'keep-local', paths: [['title']]})

    expect(serialize(result.ancestor)).toBe(serialize(base))
    expect(result.ancestorRevision).toBe('base-rev-2')
    expect(encoded(result.touchedPaths)).toEqual(['$.title'])
    expect(result.merge.document?.title).toBe('Branch title')
    // The unselected local value is dropped and inherits base.
    expect((result.merge.document?.hero as Record<string, unknown>).heading).toBe(
      'Ancestor heading',
    )
    expect(result.audit?.type).toBe('rebase-keep-local')
  })

  it('full reset removes local state and returns to the live base', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'full-reset'})

    expect(result.localMaterialized).toBeNull()
    expect(result.touchedPaths).toEqual([])
    expect(result.unsetPaths).toEqual([])
    expect(result.ancestor).toBeNull()
    expect(serialize(result.merge.document)).toBe(serialize(base))
    expect(result.audit?.type).toBe('rebase-full-reset')
  })

  it('freeze captures the resolved document as a branch-owned replacement', () => {
    const result = applyRebaseMode({...modeRequest, mode: 'freeze'})

    expect(result.origin).toBe('branch')
    expect(result.localMaterialized?.title).toBe('Branch title')
    expect(result.localMaterialized?.summary).toBe('Upstream summary')
    // §17.10 — a full replacement marks every user field touched.
    expect(encoded(result.touchedPaths)).toEqual(
      encoded([['hero'], ['sections'], ['summary'], ['tags'], ['title'], ['views']]),
    )
    expect(result.touchedPaths.every((path) => !String(path[0]).startsWith('_'))).toBe(true)
    expect(serialize(result.ancestor)).toBe(serialize(base))
    expect(result.audit?.type).toBe('rebase-freeze')
  })
})

/* ------------------------------------------------------------------ *
 * Plan §8.5 rebase properties, over the recorded seed corpus
 * ------------------------------------------------------------------ */

describe('rebase properties (§35.1)', () => {
  it('rebase idempotence: rebasing again against the same base changes nothing', () => {
    for (const scenario of scenarioCorpus()) {
      const first = autoRebase(
        rebaseRequest({
          ancestor: scenario.ancestor,
          currentBase: scenario.currentBase,
          localMaterialized: scenario.local,
          localTouchedPaths: scenario.touchedPaths,
          unsetPaths: scenario.unsetPaths,
        }),
      )
      const second = autoRebase(
        rebaseRequest({
          ancestor: first.ancestor,
          ancestorRevision: first.ancestorRevision ?? undefined,
          currentBase: scenario.currentBase,
          localMaterialized: first.localMaterialized,
          localTouchedPaths: first.touchedPaths,
          unsetPaths: scenario.unsetPaths,
        }),
      )

      expect({seed: scenario.seed, ancestor: serialize(second.ancestor)}).toEqual({
        seed: scenario.seed,
        ancestor: serialize(first.ancestor),
      })
      expect({seed: scenario.seed, touched: encoded(second.touchedPaths)}).toEqual({
        seed: scenario.seed,
        touched: encoded(first.touchedPaths),
      })
      expect({seed: scenario.seed, document: serialize(second.merge.document)}).toEqual({
        seed: scenario.seed,
        document: serialize(first.merge.document),
      })
      expect({seed: scenario.seed, removed: second.removedTouchedPaths}).toEqual({
        seed: scenario.seed,
        removed: [],
      })
    }
  })

  it('local-equals-base override removal: a converged touched path is dropped on rebase', () => {
    for (const scenario of scenarioCorpus()) {
      if (scenario.basePaths.length === 0) continue
      // Converge the branch onto the base at every base-changed scalar path.
      const local = clone(scenario.currentBase) as unknown as Record<string, unknown>
      local._rev = 'overlay.9.0123456789ab'

      const result = autoRebase(
        rebaseRequest({
          ancestor: scenario.ancestor,
          currentBase: scenario.currentBase,
          localMaterialized: local as unknown as SanityDocument,
          localTouchedPaths: scenario.basePaths,
        }),
      )

      expect({seed: scenario.seed, applied: result.applied}).toEqual({
        seed: scenario.seed,
        applied: true,
      })
      expect({seed: scenario.seed, removed: encoded(result.removedTouchedPaths)}).toEqual({
        seed: scenario.seed,
        removed: encoded(scenario.basePaths),
      })
      expect({seed: scenario.seed, touched: result.touchedPaths}).toEqual({
        seed: scenario.seed,
        touched: [],
      })
    }
  })
})
