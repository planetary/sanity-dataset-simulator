import {describe, expect, it} from 'vitest'
import {
  OVERLAY_INVARIANT_IDS,
  checkCheckpointDeterminism,
  checkIdempotencyLedger,
  checkManifestHeads,
  checkMergeResultInvariants,
  checkOrphanVisibility,
  checkOverlayInvariants,
  checkRecordChecksums,
  checkRevisionIncrements,
  checkSingleCurrentVersions,
  checkStateChecksums,
  checkTombstoneSuppression,
  applyTransaction,
  checksum,
  createBaseSource,
  createOverlayState,
  deleteDocument,
  edit,
  mergeDocument,
  publish,
  syntheticRev,
} from '../../sanity-overlay-core/src/index'
import type {
  ActionOptions,
  MergeRequest,
  MergeResult,
  OverlayDocumentRecord,
  OverlayInvariantId,
  OverlayInvariantViolation,
  OverlayManifest,
  OverlayState,
  PerspectiveResolution,
  SanityDocument,
  TransactionOptions,
} from '../../sanity-overlay-core/src/index'

/*
 * Plan docs/plans/phase-2-core-domain.md §8.3 — the twelve Phase-2-scoped PRD §34
 * invariants as assertions callable from both tests and runtime debug tooling.
 *
 * Each check is a pure function over the relevant state, returning structured
 * violations. Every test below therefore has two halves: a state the production
 * engine actually produced (expected clean) and a *deliberately broken* state
 * (expected to name the invariant it breaks). A check that cannot report a
 * violation for a broken input is not an invariant, so the broken half is the
 * load-bearing one.
 */

/* ------------------------------------------------------------------ *
 * Deterministic harness
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'user-1', displayName: 'Ada'} as const
const NOW = '2026-08-03T12:00:00.000Z'

let transactionCounter = 0
function tx(overrides: Partial<TransactionOptions> = {}): TransactionOptions {
  transactionCounter += 1
  return {
    transactionId: `01JTX${String(transactionCounter).padStart(6, '0')}`,
    idempotencyKey: `key-${transactionCounter}`,
    actor: ACTOR,
    now: () => NOW,
    ...overrides,
  }
}

const BASE_ARTICLE: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'base-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Base title',
  summary: 'Base summary',
  hero: {heading: 'Base heading', subtitle: 'Base subtitle'},
  views: 10,
}

const base = createBaseSource([BASE_ARTICLE])

function emptyState(): OverlayState {
  return createOverlayState({overlayId: 'overlay-invariants'})
}

function actionOptions(overrides: Partial<ActionOptions> = {}): ActionOptions {
  return {...tx({base}), ...overrides}
}

/** A state the engine produced: one edited draft, one published document. */
function engineState(): OverlayState {
  const edited = edit(
    emptyState(),
    {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Branch title'}]},
    actionOptions(),
  )
  return publish(edited.state, {id: 'article-1'}, actionOptions()).state
}

/** A structural clone that is safe to break. */
function broken<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function ids(violations: readonly OverlayInvariantViolation[]): OverlayInvariantId[] {
  return violations.map((violation) => violation.invariant)
}

/* ------------------------------------------------------------------ *
 * §34.1 — one current local draft and one current local published state
 * ------------------------------------------------------------------ */

describe('§34.1 at most one current local draft and one current local published state', () => {
  it('accepts a state the engine produced', () => {
    expect(checkSingleCurrentVersions(engineState())).toEqual([])
  })

  it('reports a record filed under a key that is not its logical ID', () => {
    const state = engineState()
    const record = state.documents['article-1']!
    const violations = checkSingleCurrentVersions({
      ...state,
      documents: {'article-99': record},
    })
    expect(ids(violations)).toContain('34.1')
    expect(violations[0]?.message).toMatch(/article-99/)
  })

  it('reports a record filed under a draft ID, which would double the logical document', () => {
    const state = engineState()
    const record = state.documents['article-1']!
    const violations = checkSingleCurrentVersions({
      ...state,
      documents: {
        'article-1': record,
        'drafts.article-1': {...record, logicalId: 'drafts.article-1'},
      },
    })
    // Both §34.1 rules must fire, and each is asserted separately: the earlier
    // `some(/drafts\./)` form stayed green when the draft-ID rule was disabled,
    // because the duplicate-logical-document rule also mentions `drafts.` in its
    // message. Pinning one assertion per rule makes either regression red.
    expect(ids(violations)).toEqual(['34.1', '34.1'])
    expect(violations[0]?.message).toMatch(/uses a "drafts\." ID as its logical ID/)
    expect(violations[1]?.message).toMatch(/both describe logical document/)
  })

  it('reports a local draft materialized under the published document ID', () => {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Branch title'}]},
      actionOptions(),
    ).state
    const record = broken(edited.documents['article-1']!)
    // Two current *published* states: the draft now claims the published ID.
    record.local.draft!.materialized._id = 'article-1'
    const violations = checkSingleCurrentVersions({...edited, documents: {'article-1': record}})
    expect(ids(violations)).toContain('34.1')
    expect(violations[0]?.documentId).toBe('article-1')
  })

  it('reports a local published version materialized under the draft document ID', () => {
    const state = engineState()
    const record = broken(state.documents['article-1']!)
    record.local.published!.materialized._id = 'drafts.article-1'
    const violations = checkSingleCurrentVersions({...state, documents: {'article-1': record}})
    expect(ids(violations)).toContain('34.1')
  })
})

/* ------------------------------------------------------------------ *
 * §34.2 — a tombstone suppresses inheritance
 * ------------------------------------------------------------------ */

describe('§34.2 a tombstone suppresses inheritance', () => {
  function deletedRecord(): OverlayDocumentRecord {
    const edited = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Branch title'}]},
      actionOptions(),
    ).state
    const {state} = deleteDocument(edited, {id: 'article-1'}, actionOptions())
    return state.documents['article-1']!
  }

  it('accepts a deleted record resolved through the production perspectives', () => {
    const record = deletedRecord()
    expect(record.local.publishedTombstone).toBe(true)
    expect(
      checkTombstoneSuppression({record, base: {published: BASE_ARTICLE, draft: null}}),
    ).toEqual([])
  })

  it('reports a resolver that lets base content through a published tombstone', () => {
    const record = deletedRecord()
    // The injected resolver is how runtime tooling feeds in what it actually
    // served; here it serves the base document despite the tombstone.
    const leaking = (): PerspectiveResolution => ({
      perspective: 'published',
      document: BASE_ARTICLE,
      source: 'base-published',
      absence: null,
      conflicts: [],
      checksum: checksum(BASE_ARTICLE),
      touchedPaths: [],
      removedTouchedPaths: [],
      validation: [],
    })
    const violations = checkTombstoneSuppression(
      {record, base: {published: BASE_ARTICLE, draft: null}},
      {resolvePublished: leaking},
    )
    expect(ids(violations)).toContain('34.2')
    expect(violations[0]?.message).toMatch(/tombstone/i)
  })

  it('accepts an untouched base-origin record: absence of local content is inheritance, not a delete', () => {
    const record: OverlayDocumentRecord = {
      ...engineState().documents['article-1']!,
      origin: 'base',
      local: {published: null, draft: null, publishedTombstone: false, draftTombstone: false},
    }
    expect(
      checkTombstoneSuppression({record, base: {published: BASE_ARTICLE, draft: null}}),
    ).toEqual([])
  })

  it('reports branch content that vanished without a tombstone recording the delete', () => {
    const record: OverlayDocumentRecord = {
      ...engineState().documents['article-1']!,
      origin: 'branch',
      base: null,
      local: {published: null, draft: null, publishedTombstone: false, draftTombstone: false},
    }
    const violations = checkTombstoneSuppression({record, base: {published: null, draft: null}})
    expect(ids(violations)).toContain('34.2')
    expect(violations[0]?.message).toMatch(/tombstone/i)
  })
})

/* ------------------------------------------------------------------ *
 * §34.3 — every manifest head points to something that exists
 * ------------------------------------------------------------------ */

describe('§34.3 every manifest document head points to an existing revision or record', () => {
  function manifestWith(storageRef: string, documentChecksum = checksum(BASE_ARTICLE)): OverlayManifest {
    return {
      formatVersion: 1,
      overlayId: 'overlay-invariants',
      status: 'active',
      base: {projectId: 'p', dataset: 'staging', apiVersion: '2024-11-12'},
      source: {repositoryId: 'github:org/repo', branch: 'feature/x'},
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
      documentHeads: {
        'article-1': {
          logicalId: 'article-1',
          schemaType: 'article',
          runtimeRevision: syntheticRev(3, documentChecksum),
          storageRef,
          checksum: documentChecksum,
          updatedAt: NOW,
          state: 'modified',
          hasDraft: true,
          hasPublished: true,
          hasConflict: false,
        },
      },
      conflictSummary: {total: 0, hard: 0, soft: 0},
    }
  }

  it('accepts a head whose storage ref exists', () => {
    const manifest = manifestWith('revisions/abc')
    expect(checkManifestHeads(manifest, {knownRefs: ['revisions/abc']})).toEqual([])
  })

  it('reports a head pointing at a revision that is not stored', () => {
    const manifest = manifestWith('revisions/gone')
    const violations = checkManifestHeads(manifest, {knownRefs: ['revisions/abc']})
    expect(ids(violations)).toContain('34.3')
    expect(violations[0]?.documentId).toBe('article-1')
  })

  it('reports an empty storage ref and a head filed under the wrong key', () => {
    // Each rule is pinned by its own message. Asserting only `toContain('34.3')`
    // stayed green when the empty-ref rule was disabled, because an empty ref is
    // also absent from `knownRefs` and the existence rule reported instead.
    const empty = checkManifestHeads(manifestWith(''), {knownRefs: []})
    expect(empty.some((violation) => /empty storageRef/.test(violation.message))).toBe(true)

    const manifest = manifestWith('revisions/abc')
    const misfiled: OverlayManifest = {
      ...manifest,
      documentHeads: {'article-2': manifest.documentHeads['article-1']!},
    }
    const wrongKey = checkManifestHeads(misfiled, {knownRefs: ['revisions/abc']})
    expect(ids(wrongKey)).toEqual(['34.3'])
    expect(wrongKey[0]?.message).toMatch(/is filed under key "article-2"/)
  })
})

/* ------------------------------------------------------------------ *
 * §34.4 — every record checksum matches its serialized content
 * ------------------------------------------------------------------ */

describe('§34.4 every document record checksum matches its serialized content', () => {
  it('accepts a state the engine produced', () => {
    const state = engineState()
    expect(checkStateChecksums(state)).toEqual([])
    expect(checkRecordChecksums(state.documents['article-1']!)).toEqual([])
  })

  it('reports a base snapshot whose stored checksum no longer matches', () => {
    const state = engineState()
    const record = broken(state.documents['article-1']!)
    record.base!.published!.checksum = checksum({tampered: true})
    const violations = checkRecordChecksums(record)
    expect(ids(violations)).toContain('34.4')
    expect(violations[0]?.message).toMatch(/base published/i)
  })

  it('reports a base snapshot whose content was edited under a stored checksum', () => {
    const state = engineState()
    const record = broken(state.documents['article-1']!)
    record.base!.published!.snapshot.title = 'Silently rewritten'
    expect(ids(checkRecordChecksums(record))).toContain('34.4')
  })

  it('reports a local materialized document whose synthetic _rev no longer matches its content', () => {
    const state = engineState()
    const record = broken(state.documents['article-1']!)
    record.local.published!.materialized.title = 'Rewritten without restamping'
    const violations = checkRecordChecksums(record)
    expect(ids(violations)).toContain('34.4')
    expect(violations.some((violation) => /_rev/.test(violation.message))).toBe(true)
  })

  it('reports a stale checksum recorded by the most recent transaction', () => {
    const state = engineState()
    const transactions = broken([...state.transactions])
    const last = transactions[transactions.length - 1]!
    last.resultChecksums['article-1'] = checksum({stale: true})
    const violations = checkStateChecksums({...state, transactions})
    expect(ids(violations)).toContain('34.4')
  })
})

/* ------------------------------------------------------------------ *
 * §34.5 — one revision increment per successful transaction
 * ------------------------------------------------------------------ */

describe('§34.5 every successful transaction increments overlay revision exactly once', () => {
  it('accepts a state the engine produced', () => {
    const state = engineState()
    expect(state.revision).toBe(2)
    expect(checkRevisionIncrements(state)).toEqual([])
  })

  it('reports a transaction that moved the revision by more than one', () => {
    const state = engineState()
    const transactions = broken([...state.transactions])
    transactions[1]!.overlayRevisionAfter = 5
    const violations = checkRevisionIncrements({...state, transactions, revision: 5})
    expect(ids(violations)).toContain('34.5')
    expect(violations[0]?.message).toMatch(/exactly once/i)
  })

  it('reports a gap between two consecutive transactions', () => {
    const state = engineState()
    const transactions = broken([...state.transactions])
    transactions[1]!.overlayRevisionBefore = 4
    transactions[1]!.overlayRevisionAfter = 5
    expect(ids(checkRevisionIncrements({...state, transactions, revision: 5}))).toContain('34.5')
  })

  it('reports a state revision that disagrees with the last committed transaction', () => {
    const state = engineState()
    expect(ids(checkRevisionIncrements({...state, revision: 7}))).toContain('34.5')
  })

  it('reports a duplicated transaction ID', () => {
    const state = engineState()
    const transactions = broken([...state.transactions])
    transactions[1]!.transactionId = transactions[0]!.transactionId
    expect(ids(checkRevisionIncrements({...state, transactions}))).toContain('34.5')
  })
})

/* ------------------------------------------------------------------ *
 * §34.6 — one idempotency key maps to one immutable transaction result
 * ------------------------------------------------------------------ */

describe('§34.6 one idempotency key maps to one immutable transaction result', () => {
  it('accepts a state whose transaction was replayed under its key', () => {
    const options = actionOptions()
    const first = edit(
      emptyState(),
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Once'}]},
      options,
    )
    const replay = edit(
      first.state,
      {id: 'article-1', operations: [{type: 'set', path: ['title'], value: 'Once'}]},
      options,
    )
    expect(replay.replayed).toBe(true)
    expect(checkIdempotencyLedger(replay.state)).toEqual([])
  })

  it('reports two distinct transactions committed under one key', () => {
    const state = engineState()
    const transactions = broken([...state.transactions])
    transactions[1]!.idempotencyKey = transactions[0]!.idempotencyKey
    const violations = checkIdempotencyLedger({...state, transactions})
    // Pinned to the duplicate-key message. `/idempotency key/i` stayed green when
    // the duplicate-key rule was disabled, because the ledger-mismatch rule uses
    // the same words; only the "were both committed under" phrasing is unique to
    // the rule this test names.
    expect(ids(violations)).toContain('34.6')
    expect(
      violations.some((violation) => /were both committed under idempotency key/.test(violation.message)),
    ).toBe(true)
  })

  it('reports a ledger entry that no longer equals the committed transaction', () => {
    const state = engineState()
    const key = state.transactions[0]!.idempotencyKey
    const ledger = broken({...state.idempotencyLedger})
    ledger[key]!.affectedDocumentIds = ['article-99']
    expect(ids(checkIdempotencyLedger({...state, idempotencyLedger: ledger}))).toContain('34.6')
  })

  it('reports a committed transaction missing from the ledger', () => {
    const state = engineState()
    const key = state.transactions[0]!.idempotencyKey
    const ledger = {...state.idempotencyLedger}
    delete ledger[key]
    expect(ids(checkIdempotencyLedger({...state, idempotencyLedger: ledger}))).toContain('34.6')
  })
})

/* ------------------------------------------------------------------ *
 * §34.8 — orphan revisions are never visible
 * ------------------------------------------------------------------ */

describe('§34.8 orphan revisions are never visible without a manifest or checkpoint reference', () => {
  const manifest: OverlayManifest = {
    formatVersion: 1,
    overlayId: 'overlay-invariants',
    status: 'active',
    base: {projectId: 'p', dataset: 'staging', apiVersion: '2024-11-12'},
    source: {repositoryId: 'github:org/repo', branch: 'feature/x'},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    documentHeads: {
      'article-1': {
        logicalId: 'article-1',
        schemaType: 'article',
        runtimeRevision: syntheticRev(1, checksum(BASE_ARTICLE)),
        storageRef: 'revisions/head',
        checksum: checksum(BASE_ARTICLE),
        updatedAt: NOW,
        state: 'modified',
        hasDraft: true,
        hasPublished: false,
        hasConflict: false,
      },
    },
    conflictSummary: {total: 0, hard: 0, soft: 0},
  }

  it('accepts visible artifacts that a head references', () => {
    expect(
      checkOrphanVisibility({
        manifest,
        storedRefs: ['revisions/head', 'revisions/superseded'],
        visibleRefs: ['revisions/head'],
      }),
    ).toEqual([])
  })

  it('reports a superseded revision that is still visible', () => {
    const violations = checkOrphanVisibility({
      manifest,
      storedRefs: ['revisions/head', 'revisions/superseded'],
      visibleRefs: ['revisions/head', 'revisions/superseded'],
    })
    expect(ids(violations)).toContain('34.8')
    expect(violations[0]?.message).toMatch(/revisions\/superseded/)
  })

  it('accepts a revision held only by a checkpoint reference', () => {
    expect(
      checkOrphanVisibility({
        manifest,
        storedRefs: ['revisions/head', 'revisions/checkpointed'],
        visibleRefs: ['revisions/head', 'revisions/checkpointed'],
        checkpointRefs: ['revisions/checkpointed'],
      }),
    ).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * §34.17 — checkpoint output is deterministic for the same logical state
 * ------------------------------------------------------------------ */

describe('§34.17 checkpoint output is deterministic for the same logical state', () => {
  it('accepts two renderings of one logical state that differ only in key order', () => {
    const first: Record<string, unknown> = {}
    first.zebra = 1
    first.alpha = {nested: true, list: [3, 2, 1]}
    const second: Record<string, unknown> = {}
    second.alpha = {list: [3, 2, 1], nested: true}
    second.zebra = 1
    expect(checkCheckpointDeterminism([first, second])).toEqual([])
  })

  it('reports two renderings of one logical state that do not serialize identically', () => {
    const violations = checkCheckpointDeterminism([
      {a: 1, b: 2},
      {a: 1, b: 2, generatedAt: NOW},
    ])
    expect(ids(violations)).toContain('34.17')
    expect(violations[0]?.message).toMatch(/byte-identical/i)
  })

  it('reports a value the canonical serializer cannot render at all', () => {
    // Renamed: the previous title claimed to cover the *fixpoint* branch, but
    // `NaN` never reaches it — `serialize` throws first, so the reject branch
    // answered and disabling the fixpoint comparison left this green. The
    // message is now pinned to the branch actually exercised.
    expect(checkCheckpointDeterminism([{a: [1, {b: null}], c: 'ø'}])).toEqual([])

    for (const unserializable of [{a: Number.NaN}, {a: Number.POSITIVE_INFINITY}, {a: 1n}]) {
      const violations = checkCheckpointDeterminism([unserializable])
      expect(ids(violations)).toEqual(['34.17'])
      expect(violations[0]?.message).toMatch(/is not canonically serializable/)
    }
  })

  /*
   * The *fixpoint* branch of `checkCheckpointDeterminism` has no test here on
   * purpose. It is defensive: no value reachable through the real serializer can
   * trigger it. That was checked, not assumed — 18 adversarial candidates (lone
   * surrogates, `-0`, `1e21`, denormals, 2^53+1, `undefined` in an array, empty
   * and control-character keys, U+2028, a BOM, integer-like key ordering) are all
   * fixpoints. Writing a test for it would mean faking a serializer, which would
   * assert on the fake rather than on production. The property itself *is*
   * covered, directly and generatively: `core-properties.test.ts` asserts
   * `serialize(parse(serialize(x))) === serialize(x)` over 48 generated
   * documents, and mutating the serializer's key sort turns that red.
   */
})

/* ------------------------------------------------------------------ *
 * §34.11-§34.14 — the merge-side invariants, composed
 * ------------------------------------------------------------------ */

describe('§34.11-§34.14 merge invariants are reachable from the same entry point', () => {
  const ancestor: SanityDocument = {
    _id: 'article-1',
    _type: 'article',
    title: 'Ancestor title',
    summary: 'Ancestor summary',
  }
  const currentBase: SanityDocument = {...ancestor, summary: 'Upstream summary'}
  const local: SanityDocument = {...ancestor, title: 'Branch title'}

  const request: MergeRequest = {
    documentId: 'article-1',
    now: NOW,
    ancestor,
    currentBase,
    localMaterialized: local,
    localTouchedPaths: [['title']],
  }

  it('accepts a real merge result', () => {
    const result = mergeDocument(request)
    expect(result.document?.summary).toBe('Upstream summary')
    expect(checkMergeResultInvariants(request, result)).toEqual([])
  })

  it('reports a result that dropped an untouched upstream change (§34.12)', () => {
    const result: MergeResult = {
      ...mergeDocument(request),
      document: {...local, summary: 'Ancestor summary'},
    }
    expect(ids(checkMergeResultInvariants(request, result))).toContain('34.12')
  })

  it('reports a result that lost local intent on a touched path (§34.13)', () => {
    const result: MergeResult = {
      ...mergeDocument(request),
      document: {...currentBase},
    }
    expect(ids(checkMergeResultInvariants(request, result))).toContain('34.13')
  })
})

/* ------------------------------------------------------------------ *
 * The twelve Phase-2-scoped invariants, end to end
 * ------------------------------------------------------------------ */

describe('plan §8.3 — all twelve Phase-2-scoped invariants are executable', () => {
  it('exports exactly the twelve invariant IDs plan §8.3 lists', () => {
    expect([...OVERLAY_INVARIANT_IDS]).toEqual([
      '34.1',
      '34.2',
      '34.3',
      '34.4',
      '34.5',
      '34.6',
      '34.8',
      '34.11',
      '34.12',
      '34.13',
      '34.14',
      '34.17',
    ])
  })

  it('runs clean over a state, manifest and merge the engine produced', () => {
    const state = engineState()
    const record = state.documents['article-1']!
    const ancestor: SanityDocument = {_id: 'article-1', _type: 'article', title: 'A', summary: 'S'}
    const mergeRequest: MergeRequest = {
      documentId: 'article-1',
      now: NOW,
      ancestor,
      currentBase: {...ancestor, summary: 'S2'},
      localMaterialized: {...ancestor, title: 'B'},
      localTouchedPaths: [['title']],
    }
    const violations = checkOverlayInvariants({
      state,
      base: {'article-1': {published: BASE_ARTICLE, draft: null}},
      records: [record],
      merges: [{request: mergeRequest, result: mergeDocument(mergeRequest)}],
      checkpointRenderings: [state, {...state}],
    })
    expect(violations).toEqual([])
  })

  /**
   * One deliberately broken input per invariant. This is the evidence that all
   * twelve are *executable*: each entry must produce its own ID.
   */
  const breakers: Array<[OverlayInvariantId, () => OverlayInvariantViolation[]]> = [
    [
      '34.1',
      () => {
        const state = engineState()
        return checkOverlayInvariants({
          state: {...state, documents: {'article-99': state.documents['article-1']!}},
        })
      },
    ],
    [
      '34.2',
      () =>
        checkOverlayInvariants({
          records: [
            {
              ...engineState().documents['article-1']!,
              origin: 'branch',
              base: null,
              local: {
                published: null,
                draft: null,
                publishedTombstone: false,
                draftTombstone: false,
              },
            },
          ],
        }),
    ],
    [
      '34.3',
      () => {
        const state = engineState()
        const manifest: OverlayManifest = {
          formatVersion: 1,
          overlayId: state.overlayId,
          status: 'active',
          base: {projectId: 'p', dataset: 'staging', apiVersion: '2024-11-12'},
          source: {repositoryId: 'github:org/repo', branch: 'feature/x'},
          revision: state.revision,
          createdAt: NOW,
          updatedAt: NOW,
          documentHeads: {
            'article-1': {
              logicalId: 'article-1',
              schemaType: 'article',
              runtimeRevision: syntheticRev(state.revision, checksum(BASE_ARTICLE)),
              storageRef: 'revisions/missing',
              checksum: checksum(BASE_ARTICLE),
              updatedAt: NOW,
              state: 'modified',
              hasDraft: false,
              hasPublished: true,
              hasConflict: false,
            },
          },
          conflictSummary: {total: 0, hard: 0, soft: 0},
        }
        return checkOverlayInvariants({manifest, knownRefs: []})
      },
    ],
    [
      '34.4',
      () => {
        const state = engineState()
        const record = broken(state.documents['article-1']!)
        record.base!.published!.checksum = checksum({tampered: true})
        return checkOverlayInvariants({state: {...state, documents: {'article-1': record}}})
      },
    ],
    [
      '34.5',
      () => {
        const state = engineState()
        return checkOverlayInvariants({state: {...state, revision: 9}})
      },
    ],
    [
      '34.6',
      () => {
        const state = engineState()
        const key = state.transactions[0]!.idempotencyKey
        const ledger = {...state.idempotencyLedger}
        delete ledger[key]
        return checkOverlayInvariants({state: {...state, idempotencyLedger: ledger}})
      },
    ],
    [
      '34.8',
      () =>
        checkOverlayInvariants({
          manifest: {
            formatVersion: 1,
            overlayId: 'overlay-invariants',
            status: 'active',
            base: {projectId: 'p', dataset: 'staging', apiVersion: '2024-11-12'},
            source: {repositoryId: 'github:org/repo', branch: 'feature/x'},
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
            documentHeads: {},
            conflictSummary: {total: 0, hard: 0, soft: 0},
          },
          visibleRefs: ['revisions/orphan'],
          storedRefs: ['revisions/orphan'],
        }),
    ],
    [
      '34.11',
      () => {
        const ancestor: SanityDocument = {_id: 'a', _type: 'article', title: 'T', summary: 'S'}
        const request: MergeRequest = {
          documentId: 'a',
          now: NOW,
          ancestor,
          currentBase: {...ancestor, summary: 'Upstream'},
          localMaterialized: {_id: 'a', _type: 'article', title: 'T'},
          localTouchedPaths: [['summary']],
          unsetPaths: [['summary']],
        }
        const result: MergeResult = {
          ...mergeDocument(request),
          document: {...ancestor, summary: 'Upstream'},
        }
        return checkOverlayInvariants({merges: [{request, result}]})
      },
    ],
    [
      '34.12',
      () => {
        const ancestor: SanityDocument = {_id: 'a', _type: 'article', title: 'T', summary: 'S'}
        const request: MergeRequest = {
          documentId: 'a',
          now: NOW,
          ancestor,
          currentBase: {...ancestor, summary: 'Upstream'},
          localMaterialized: {...ancestor, title: 'Branch'},
          localTouchedPaths: [['title']],
        }
        const result: MergeResult = {
          ...mergeDocument(request),
          document: {...ancestor, title: 'Branch'},
        }
        return checkOverlayInvariants({merges: [{request, result}]})
      },
    ],
    [
      '34.13',
      () => {
        const ancestor: SanityDocument = {_id: 'a', _type: 'article', title: 'T', summary: 'S'}
        const request: MergeRequest = {
          documentId: 'a',
          now: NOW,
          ancestor,
          currentBase: {...ancestor, summary: 'Upstream'},
          localMaterialized: {...ancestor, title: 'Branch'},
          localTouchedPaths: [['title']],
        }
        const result: MergeResult = {
          ...mergeDocument(request),
          document: {...ancestor, summary: 'Upstream'},
        }
        return checkOverlayInvariants({merges: [{request, result}]})
      },
    ],
    [
      '34.14',
      () => {
        const ancestor: SanityDocument = {_id: 'a', _type: 'article', title: 'T'}
        const request: MergeRequest = {
          documentId: 'a',
          now: NOW,
          ancestor,
          currentBase: null,
          baseStatus: 'deleted',
          localMaterialized: {...ancestor, title: 'Branch'},
          localTouchedPaths: [['title']],
        }
        const result: MergeResult = {...mergeDocument(request), document: null, absence: 'base-deleted'}
        return checkOverlayInvariants({merges: [{request, result}]})
      },
    ],
    [
      '34.17',
      () =>
        checkOverlayInvariants({
          checkpointRenderings: [
            {a: 1},
            {a: 1, drifted: true},
          ],
        }),
    ],
  ]

  it.each(breakers)('%s reports a violation for a deliberately broken input', (id, run) => {
    expect(ids(run())).toContain(id)
  })
})
