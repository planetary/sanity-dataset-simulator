import {describe, expect, it} from 'vitest'
import {
  checksum,
  encodeOverlayPath,
  isSyntheticRev,
  serialize,
} from '../../sanity-overlay-core/src/index'
import type {
  OverlayConflict,
  OverlayConflictType,
  OverlayPath,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {
  BASE_DELETION_MATRIX,
  checkMergeInvariants,
  classifyBaseDeletion,
  createMergeResolver,
  mergeDocument,
} from '../../sanity-overlay-core/src/merge/index'
import type {MergeRequest, MergeValidator} from '../../sanity-overlay-core/src/merge/index'
import {
  ANCESTOR_ARTICLE,
  MERGE_SEED_CORPUS,
  clone,
  generateScenario,
  localVariant,
  scenarioCorpus,
  variant,
} from '../src/mergeFixtures'

// Phase 2 workstream W3 (plan docs/plans/phase-2-core-domain.md §6, §8.3, §8.4, §8.5).
// PRD §17.1-§17.6 three-way merge, §16.4 base deletion, §13.11/§17.4 conflicts,
// §34 invariants 11-14, §35.2 core merge unit tests, §35.1 property list.

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

function conflictTypes(conflicts: readonly OverlayConflict[]): OverlayConflictType[] {
  return conflicts.map((conflict) => conflict.type)
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
        (conflict.path !== undefined && encodeOverlayPath(conflict.path) === encodeOverlayPath(path))),
  )
}

function valueAt(document: SanityDocument | null, path: OverlayPath): unknown {
  let node: unknown = document
  for (const segment of path) {
    if (node === undefined || node === null) return undefined
    if (typeof segment === 'string') {
      node = (node as Record<string, unknown>)[segment]
    } else if (typeof segment === 'number') {
      node = (node as unknown[])[segment]
    } else {
      node = (node as Record<string, unknown>[]).find((item) => item._key === segment._key)
    }
  }
  return node
}

/** True when `prefix` is `path` or an ancestor of it (test-local, independent oracle). */
function covers(prefix: OverlayPath, path: OverlayPath): boolean {
  if (prefix.length > path.length) return false
  return prefix.every((segment, index) => {
    const other = path[index]!
    if (typeof segment === 'object') return typeof other === 'object' && segment._key === other._key
    return segment === other
  })
}

/* ------------------------------------------------------------------ *
 * PRD §35.2 core merge unit tests (17 cases; cases 11-16 live in
 * core-w3-perspectives.test.ts, which owns the §18.1-§18.3 perspectives)
 * ------------------------------------------------------------------ */

describe('§35.2 core merge unit tests', () => {
  it('Untouched scalar inherits current base', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.summary = 'Upstream summary'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.summary).toBe('Upstream summary')
    expect(result.document?.title).toBe('Branch title')
    expect(result.conflicts).toEqual([])
  })

  it('Touched scalar overrides unchanged base', () => {
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Branch title')
    expect(result.conflicts).toEqual([])
  })

  it('Same scalar changed on both sides creates soft conflict and local wins', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Upstream title'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Branch title')
    const conflict = conflictAt(result.conflicts, 'SAME_PATH_CHANGED', ['title'])
    expect(conflict).toBeDefined()
    expect(conflict?.severity).toBe('soft')
    expect(conflict?.ancestorValue).toBe('Ancestor title')
    expect(conflict?.baseValue).toBe('Upstream title')
    expect(conflict?.localValue).toBe('Branch title')
    expect(conflict?.detectedAt).toBe(NOW)
    expect(conflict?.documentId).toBe('article-1')
  })

  it('Local value equal to current base does NOT collapse at merge time; the §35.2 case is on rebase — see core-w3-rebase.test.ts "step 3 — removes obsolete touched paths whose local value now equals base"', () => {
    // Local moved the value to X; base has since moved to X too, and the ancestor
    // still holds the old value. §17.3 step 5 fires only for local == ancestor,
    // so this case must *not* collapse but must also record no conflict.
    //
    // The §35.2 line "Local value equal to current base removes redundant
    // override **on rebase**" is proved in `core-w3-rebase.test.ts` (§28.5 step 3)
    // plus the generative property beside it. This test is the *negative* half —
    // it exists to stop the collapse leaking into merge — so its name says so,
    // rather than reading like the §35.2 case it is not (acceptance audit F-04).
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Converged title'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Converged title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Converged title')
    expect(result.conflicts).toEqual([])
    expect(result.removedTouchedPaths).toEqual([])
  })

  it('Local value equal to ancestor collapses the touch and uses current base (§17.3 step 5)', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Upstream title'
    })
    // Local recorded a touch but then restored the ancestor value.
    const local = localVariant(ANCESTOR_ARTICLE, () => {})

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Upstream title')
    expect(result.conflicts).toEqual([])
    expect(result.removedTouchedPaths.map(encodeOverlayPath)).toEqual(['$.title'])
    expect(result.touchedPaths.map(encodeOverlayPath)).toEqual([])
  })

  it('Explicit unset suppresses current and later base values', () => {
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      delete document.summary
    })

    const suppressedAgainst = (baseSummary: string | undefined): SanityDocument | null => {
      const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
        if (baseSummary === undefined) delete document.summary
        else document.summary = baseSummary
      })
      return mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: ANCESTOR_ARTICLE,
          currentBase,
          localMaterialized: local,
          localTouchedPaths: [['summary']],
          unsetPaths: [['summary']],
        }),
      ).document
    }

    // Current base value suppressed, a *later* base value suppressed too (§17.5).
    expect(suppressedAgainst(undefined)).not.toHaveProperty('summary')
    expect(suppressedAgainst('Ancestor summary')).not.toHaveProperty('summary')
    expect(suppressedAgainst('Brand new upstream summary')).not.toHaveProperty('summary')
  })

  it('Nested child touch preserves new upstream siblings', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      const hero = document.hero as Record<string, unknown>
      hero.subtitle = 'Upstream subtitle'
      hero.badge = 'New upstream field'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['hero', 'heading']],
      }),
    )

    expect(result.document?.hero).toEqual({
      heading: 'Branch heading',
      subtitle: 'Upstream subtitle',
      badge: 'New upstream field',
    })
    expect(result.conflicts).toEqual([])
  })

  it('Parent object changed to scalar creates hard conflict', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.hero = 'now a string'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['hero', 'heading']],
      }),
    )

    const conflict = conflictAt(result.conflicts, 'PARENT_SHAPE_CHANGED', ['hero'])
    expect(conflict).toBeDefined()
    expect(conflict?.severity).toBe('hard')
    // "Preserve materialized local output only when safe" (§17.3 step 7).
    expect(result.document?.hero).toEqual({
      heading: 'Branch heading',
      subtitle: 'Ancestor subtitle',
    })
  })

  it('Base document deletion returns local materialized document', () => {
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: null,
        baseStatus: 'deleted',
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Branch title')
    expect(result.document?.summary).toBe('Ancestor summary')
    const conflict = conflictAt(result.conflicts, 'BASE_DOCUMENT_DELETED')
    expect(conflict?.severity).toBe('hard')
  })

  it('Untouched base deletion returns no document', () => {
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: null,
        baseStatus: 'deleted',
        localMaterialized: null,
      }),
    )

    expect(result.document).toBeNull()
    expect(result.absence).toBe('base-deleted')
    expect(result.conflicts).toEqual([])
  })

  it('Branch-created document resolves without base', () => {
    const local: SanityDocument = {
      _id: 'branch-doc',
      _type: 'article',
      _rev: 'overlay.3.0123456789ab',
      _createdAt: NOW,
      _updatedAt: NOW,
      title: 'Branch only',
    }

    const result = mergeDocument(
      request({
        documentId: 'branch-doc',
        origin: 'branch',
        ancestor: null,
        currentBase: null,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Branch only')
    expect(result.conflicts).toEqual([])
  })

  it('Synthetic system fields are deterministic', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.summary = 'Upstream summary'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })
    const input = request({
      documentId: 'article-1',
      ancestor: ANCESTOR_ARTICLE,
      currentBase,
      localMaterialized: local,
      localTouchedPaths: [['title']],
    })

    const first = mergeDocument(input)
    const second = mergeDocument(input)

    expect(serialize(first.document)).toBe(serialize(second.document))
    expect(first.checksum).toBe(second.checksum)
    // §13.9: local state wins, so the resolved document carries a synthetic `_rev`
    // that is content-addressed over the *resolved* document, not the local one.
    expect(isSyntheticRev(first.document?._rev)).toBe(true)
    expect(first.document?._rev).not.toBe(local._rev)
    expect(first.document?._createdAt).toBe(ANCESTOR_ARTICLE._createdAt)
    expect(first.document?._updatedAt).toBe(local._updatedAt)
    expect(first.document?._id).toBe('article-1')
  })
})

/* ------------------------------------------------------------------ *
 * §17.2 rule 4 — an unrecorded path is never locally owned (regression class)
 * ------------------------------------------------------------------ */

describe('§17.2 untouched means base wins (regression class)', () => {
  const currentBase = (): SanityDocument =>
    variant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Upstream title'
      document.summary = 'Upstream summary'
    })

  it('returns the current base when a local document records no touched path at all', () => {
    // Nothing is locally owned, so §17.2 rule 4 applies to the whole document —
    // the stale local materialized copy must not win, and no conflict exists.
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: currentBase(),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.title = 'Stale branch title'
        }),
        localTouchedPaths: [],
      }),
    )

    // Byte-identical to the base, including its Content Lake `_rev`: an overlay
    // that owns nothing must not stamp a synthetic revision over base content.
    expect(serialize(result.document)).toBe(serialize(currentBase()))
    expect(result.conflicts).toEqual([])
  })

  it('returns the current base once every touched path has been collapsed away', () => {
    // §17.3 step 5 removes the only touch, which leaves the document untouched.
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: currentBase(),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, () => {}),
        localTouchedPaths: [['title']],
      }),
    )

    expect(result.document?.title).toBe('Upstream title')
    expect(result.document?.summary).toBe('Upstream summary')
    expect(result.removedTouchedPaths.map(encodeOverlayPath)).toEqual(['$.title'])
  })

  it('keeps inheriting base under an untouched sibling of a touched nested path', () => {
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: variant(ANCESTOR_ARTICLE, (document) => {
          ;(document.hero as Record<string, unknown>).subtitle = 'Upstream subtitle'
        }),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
          ;(document.hero as Record<string, unknown>).subtitle = 'Stale branch subtitle'
        }),
        localTouchedPaths: [['hero', 'heading']],
      }),
    )

    expect((result.document?.hero as Record<string, unknown>).subtitle).toBe('Upstream subtitle')
  })

  it('resolves a tombstone-free record with no local version to the current base', () => {
    const base = currentBase()
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: base,
        localMaterialized: null,
        localTouchedPaths: [],
      }),
    )
    expect(serialize(result.document)).toBe(serialize(base))
  })
})

/* ------------------------------------------------------------------ *
 * §17.3 step 10 — deterministic checksum, and step 9 — validation port
 * ------------------------------------------------------------------ */

describe('§17.3 steps 9 and 10', () => {
  it('computes the checksum of the resolved document (step 10)', () => {
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.title = 'Branch title'
        }),
        localTouchedPaths: [['title']],
      }),
    )

    // Independent oracle: hash the returned document with the W1 checksum.
    expect(result.checksum).toBe(checksum(result.document))
  })

  it('reports no checksum for an absent document', () => {
    const result = mergeDocument(
      request({documentId: 'article-1', localTombstone: true, currentBase: ANCESTOR_ARTICLE}),
    )
    expect(result.document).toBeNull()
    expect(result.checksum).toBeNull()
    expect(result.absence).toBe('tombstone')
  })

  it('runs the injected validator on the resolved document (step 9) and defaults to a no-op', () => {
    const seen: string[] = []
    const validate: MergeValidator = (document, context) => {
      seen.push(`${context.action}:${document._id}:${String(document.title)}`)
      return [{level: 'error', message: 'title too short', path: ['title']}]
    }

    const withValidator = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.title = 'Hi'
        }),
        localTouchedPaths: [['title']],
        validate,
      }),
    )

    expect(seen).toEqual(['merge:article-1:Hi'])
    expect(withValidator.validation).toEqual([
      {level: 'error', message: 'title too short', path: ['title']},
    ])
    // A schema validation *error* is a hard conflict (PRD §17.4).
    expect(conflictAt(withValidator.conflicts, 'SCHEMA_VALIDATION_ERROR')?.severity).toBe('hard')

    const withoutValidator = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          document.title = 'Hi'
        }),
        localTouchedPaths: [['title']],
      }),
    )
    expect(withoutValidator.validation).toEqual([])
    expect(withoutValidator.conflicts).toEqual([])
  })

  it('records a schema validation warning as a soft conflict', () => {
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: localVariant(ANCESTOR_ARTICLE, () => {}),
        localTouchedPaths: [['title']],
        validate: () => [{level: 'warning', message: 'prefer a longer title'}],
      }),
    )
    expect(conflictAt(result.conflicts, 'SCHEMA_VALIDATION_ERROR')?.severity).toBe('soft')
  })
})

/* ------------------------------------------------------------------ *
 * Structural conflict detection (plan §6; §13.11 taxonomy)
 * ------------------------------------------------------------------ */

describe('structural conflicts (§17.3 step 7, §17.4, §13.11)', () => {
  it('records BASE_TYPE_CHANGED as hard and falls back to the local materialized document', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document._type = 'story'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    const conflict = conflictAt(result.conflicts, 'BASE_TYPE_CHANGED')
    expect(conflict?.severity).toBe('hard')
    expect(conflict?.baseValue).toBe('story')
    expect(conflict?.ancestorValue).toBe('article')
    expect(result.document?._type).toBe('article')
    expect(result.document?.title).toBe('Branch title')
  })

  it('records LOCAL_ID_COLLISION when a branch-created ID now exists in base', () => {
    const local: SanityDocument = {
      _id: 'article-1',
      _type: 'article',
      _rev: 'overlay.2.0123456789ab',
      title: 'Branch only',
    }

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        origin: 'branch',
        ancestor: null,
        currentBase: clone(ANCESTOR_ARTICLE),
        localMaterialized: local,
        localTouchedPaths: [['title']],
      }),
    )

    const conflict = conflictAt(result.conflicts, 'LOCAL_ID_COLLISION')
    expect(conflict?.severity).toBe('hard')
    // "Keep local hidden behind conflict state or temporary alias" (§17.4).
    expect(result.document?.title).toBe('Branch only')
  })

  it('records SAME_PATH_CHANGED when base changes a path the branch unset (§17.5)', () => {
    const currentBase = variant(ANCESTOR_ARTICLE, (document) => {
      document.summary = 'Upstream summary'
    })
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      delete document.summary
    })

    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase,
        localMaterialized: local,
        localTouchedPaths: [['summary']],
        unsetPaths: [['summary']],
      }),
    )

    expect(result.document).not.toHaveProperty('summary')
    expect(conflictAt(result.conflicts, 'SAME_PATH_CHANGED', ['summary'])?.severity).toBe('soft')
  })

  it('gives every conflict a deterministic, path-scoped identity', () => {
    const build = (): OverlayConflict[] =>
      mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: ANCESTOR_ARTICLE,
          currentBase: variant(ANCESTOR_ARTICLE, (document) => {
            document.title = 'Upstream title'
            document.summary = 'Upstream summary'
          }),
          localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
            document.title = 'Branch title'
            document.summary = 'Branch summary'
          }),
          localTouchedPaths: [['title'], ['summary']],
        }),
      ).conflicts

    const first = build()
    const second = build()
    expect(first.map((conflict) => conflict.id)).toEqual(second.map((conflict) => conflict.id))
    expect(new Set(first.map((conflict) => conflict.id)).size).toBe(first.length)
  })
})

/* ------------------------------------------------------------------ *
 * PRD §16.4 base deletion matrix
 * ------------------------------------------------------------------ */

describe('§16.4 base deletion rules', () => {
  it('publishes the matrix as data with one row per documented state', () => {
    expect(BASE_DELETION_MATRIX.map((row) => row.state)).toEqual([
      'untouched',
      'touched-and-modified',
      'branch-created',
      'locally-tombstoned',
    ])
  })

  it('classifies every row of the matrix', () => {
    expect(classifyBaseDeletion({touched: false, origin: 'base', tombstoned: false})).toEqual({
      state: 'untouched',
      result: 'absent',
      conflict: null,
    })
    expect(classifyBaseDeletion({touched: true, origin: 'base', tombstoned: false})).toEqual({
      state: 'touched-and-modified',
      result: 'preserve-local',
      conflict: 'BASE_DOCUMENT_DELETED',
    })
    expect(classifyBaseDeletion({touched: true, origin: 'branch', tombstoned: false})).toEqual({
      state: 'branch-created',
      result: 'preserve-local',
      conflict: null,
    })
    expect(classifyBaseDeletion({touched: true, origin: 'base', tombstoned: true})).toEqual({
      state: 'locally-tombstoned',
      result: 'absent',
      conflict: null,
    })
  })

  it('keeps a locally tombstoned document absent without a new conflict', () => {
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: null,
        baseStatus: 'deleted',
        localMaterialized: localVariant(ANCESTOR_ARTICLE, () => {}),
        localTouchedPaths: [['title']],
        localTombstone: true,
      }),
    )
    expect(result.document).toBeNull()
    expect(result.conflicts).toEqual([])
  })

  it('never destroys a touched materialized document (§34.14)', () => {
    const local = localVariant(ANCESTOR_ARTICLE, (document) => {
      document.title = 'Branch title'
      ;(document.hero as Record<string, unknown>).heading = 'Branch heading'
    })
    const result = mergeDocument(
      request({
        documentId: 'article-1',
        ancestor: ANCESTOR_ARTICLE,
        currentBase: null,
        baseStatus: 'deleted',
        localMaterialized: local,
        localTouchedPaths: [['title'], ['hero', 'heading']],
      }),
    )
    expect(result.document?.title).toBe('Branch title')
    expect((result.document?.hero as Record<string, unknown>).heading).toBe('Branch heading')
  })
})

/* ------------------------------------------------------------------ *
 * §34 invariants 11-14, executable (plan §8.3)
 * ------------------------------------------------------------------ */

describe('§34 invariants 11-14', () => {
  const conflictedRequest = (): MergeRequest =>
    request({
      documentId: 'article-1',
      ancestor: ANCESTOR_ARTICLE,
      currentBase: variant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Upstream title'
        document.summary = 'Upstream summary'
      }),
      localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Branch title'
        delete document.views
      }),
      localTouchedPaths: [['title'], ['views']],
      unsetPaths: [['views']],
    })

  it('reports no violations for a well-formed merge', () => {
    const input = conflictedRequest()
    expect(checkMergeInvariants(input, mergeDocument(input))).toEqual([])
  })

  it('flags §34.11 when an unset path reappears in the output', () => {
    const input = conflictedRequest()
    const result = mergeDocument(input)
    const broken = {
      ...result,
      document: {...(result.document as SanityDocument), views: 99},
    }
    const violations = checkMergeInvariants(input, broken)
    expect(violations.map((violation) => violation.invariant)).toContain('34.11')
  })

  it('flags §34.12 when an untouched path does not inherit current base', () => {
    const input = conflictedRequest()
    const result = mergeDocument(input)
    const broken = {
      ...result,
      document: {...(result.document as SanityDocument), summary: 'Stale ancestor summary'},
    }
    const violations = checkMergeInvariants(input, broken)
    expect(violations.map((violation) => violation.invariant)).toContain('34.12')
  })

  it('flags §34.13 when a touched path loses local intent', () => {
    const input = conflictedRequest()
    const result = mergeDocument(input)
    const broken = {
      ...result,
      document: {...(result.document as SanityDocument), title: 'Upstream title'},
    }
    const violations = checkMergeInvariants(input, broken)
    expect(violations.map((violation) => violation.invariant)).toContain('34.13')
  })

  it('flags §34.14 when base deletion destroys a touched materialized document', () => {
    const input = request({
      documentId: 'article-1',
      ancestor: ANCESTOR_ARTICLE,
      currentBase: null,
      baseStatus: 'deleted',
      localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Branch title'
      }),
      localTouchedPaths: [['title']],
    })
    const result = mergeDocument(input)
    const violations = checkMergeInvariants(input, {...result, document: null, absence: 'base-deleted'})
    expect(violations.map((violation) => violation.invariant)).toContain('34.14')
  })
})

/* ------------------------------------------------------------------ *
 * MergeResolver adapter (W2 port, PRD §17.1)
 * ------------------------------------------------------------------ */

describe('createMergeResolver', () => {
  it('adapts the merge engine to the W2 MergeResolver port', () => {
    const resolve = createMergeResolver({documentId: 'article-1', now: NOW})
    const merged = resolve({
      ancestor: ANCESTOR_ARTICLE,
      currentBase: variant(ANCESTOR_ARTICLE, (document) => {
        document.summary = 'Upstream summary'
      }),
      localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
        document.title = 'Branch title'
      }),
      localTouchedPaths: [['title']],
      localTombstone: false,
    })

    expect(merged.title).toBe('Branch title')
    expect(merged.summary).toBe('Upstream summary')
  })
})

/* ------------------------------------------------------------------ *
 * Property-based suite (plan §8.5, PRD §35.1) over the recorded seed corpus
 * ------------------------------------------------------------------ */

describe('merge properties over the recorded seed corpus', () => {
  it('has a non-trivial recorded corpus', () => {
    expect(MERGE_SEED_CORPUS.length).toBeGreaterThanOrEqual(32)
    expect(new Set(MERGE_SEED_CORPUS).size).toBe(MERGE_SEED_CORPUS.length)
  })

  it('merge identity: no touched paths and base equal to ancestor returns current base', () => {
    for (const seed of MERGE_SEED_CORPUS) {
      const scenario = generateScenario(seed)
      const result = mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: scenario.ancestor,
          currentBase: clone(scenario.ancestor),
          localMaterialized: null,
          localTouchedPaths: [],
        }),
      )
      expect(serialize(result.document)).toBe(serialize(scenario.ancestor))
      expect(result.conflicts).toEqual([])
    }
  })

  it('merge determinism: repeated evaluation yields identical output and checksum', () => {
    for (const scenario of scenarioCorpus()) {
      const input = request({
        documentId: 'article-1',
        ancestor: scenario.ancestor,
        currentBase: scenario.currentBase,
        localMaterialized: scenario.local,
        localTouchedPaths: scenario.touchedPaths,
        unsetPaths: scenario.unsetPaths,
      })
      const first = mergeDocument(input)
      const second = mergeDocument(input)
      expect(serialize(first.document)).toBe(serialize(second.document))
      expect(first.checksum).toBe(second.checksum)
      expect(serialize(first.conflicts)).toBe(serialize(second.conflicts))
    }
  })

  it('untouched-path inheritance: base changes disjoint from touched paths appear in the output (§34.12)', () => {
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
      for (const basePath of scenario.basePaths) {
        const touched = scenario.touchedPaths.some(
          (path) => covers(path, basePath) || covers(basePath, path),
        )
        if (touched) continue
        expect({seed: scenario.seed, value: valueAt(result.document, basePath)}).toEqual({
          seed: scenario.seed,
          value: valueAt(scenario.currentBase, basePath),
        })
      }
    }
  })

  it('touched-path preservation: local intent survives base changes, with a conflict on same-path change (§34.13)', () => {
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
      for (const localPath of scenario.localPaths) {
        expect({seed: scenario.seed, value: valueAt(result.document, localPath)}).toEqual({
          seed: scenario.seed,
          value: valueAt(scenario.local, localPath),
        })
        const baseAlsoChanged = scenario.basePaths.some((path) => covers(path, localPath))
        if (!baseAlsoChanged) continue
        expect({
          seed: scenario.seed,
          path: encodeOverlayPath(localPath),
          conflict: conflictAt(result.conflicts, 'SAME_PATH_CHANGED', localPath) !== undefined,
        }).toEqual({seed: scenario.seed, path: encodeOverlayPath(localPath), conflict: true})
      }
    }
  })

  it('unset persistence: an unset path never inherits a later base value (§34.11)', () => {
    for (const scenario of scenarioCorpus()) {
      // Push the base forward again on every unset path: the suppression must hold.
      const laterBase = clone(scenario.currentBase) as unknown as Record<string, unknown>
      for (const path of scenario.unsetPaths) {
        if (path.length === 1 && typeof path[0] === 'string') {
          laterBase[path[0]] = `later-base-${scenario.seed}`
        }
      }
      const result = mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: scenario.ancestor,
          currentBase: laterBase as unknown as SanityDocument,
          localMaterialized: scenario.local,
          localTouchedPaths: scenario.touchedPaths,
          unsetPaths: scenario.unsetPaths,
        }),
      )
      for (const path of scenario.unsetPaths) {
        expect({seed: scenario.seed, value: valueAt(result.document, path)}).toEqual({
          seed: scenario.seed,
          value: undefined,
        })
      }
    }
  })

  it('local-equals-ancestor collapse: an unchanged touched path yields the current base value', () => {
    for (const scenario of scenarioCorpus()) {
      // Touch every scalar path but change nothing locally.
      const local = clone(scenario.ancestor) as unknown as Record<string, unknown>
      local._rev = 'overlay.9.0123456789ab'
      const result = mergeDocument(
        request({
          documentId: 'article-1',
          ancestor: scenario.ancestor,
          currentBase: scenario.currentBase,
          localMaterialized: local as unknown as SanityDocument,
          localTouchedPaths: scenario.basePaths,
        }),
      )
      for (const path of scenario.basePaths) {
        expect({seed: scenario.seed, value: valueAt(result.document, path)}).toEqual({
          seed: scenario.seed,
          value: valueAt(scenario.currentBase, path),
        })
      }
      expect(result.removedTouchedPaths.map(encodeOverlayPath).sort()).toEqual(
        scenario.basePaths.map(encodeOverlayPath).sort(),
      )
      expect(conflictTypes(result.conflicts)).toEqual([])
    }
  })

  it('never violates invariants 11-14 across the corpus', () => {
    for (const scenario of scenarioCorpus()) {
      const input = request({
        documentId: 'article-1',
        ancestor: scenario.ancestor,
        currentBase: scenario.currentBase,
        localMaterialized: scenario.local,
        localTouchedPaths: scenario.touchedPaths,
        unsetPaths: scenario.unsetPaths,
      })
      expect({seed: scenario.seed, violations: checkMergeInvariants(input, mergeDocument(input))})
        .toEqual({seed: scenario.seed, violations: []})
    }
  })
})
