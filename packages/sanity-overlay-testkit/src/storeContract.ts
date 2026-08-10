/**
 * The store contract suite — PRD §35.7 "Store contract tests: every adapter must
 * pass", plan §8.2 and §8.6 ("Reusable contract-test runner exported so Phases 3
 * and 4 can run the same §35.7 suite against fs and Blob adapters unchanged").
 *
 * {@link runStoreContractSuite} implements all seventeen §35.7 lines, one `it()`
 * per line, named verbatim. It knows nothing about any backend: an adapter joins
 * by supplying a {@link StoreContractFactory} that produces an isolated, empty
 * store plus the four raw-access hooks the corruption cases need.
 *
 * The contract types come from `sanity-overlay-core/src/store` — the contract's
 * home (PRD §10.1, plan §8.1), so this runner depends on core alone and never on
 * the adapter it happens to be pointed at.
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  CHECKPOINT_MANIFEST_FILE,
  OVERLAY_FORMAT_VERSION,
  checkpointFilesToRecord,
  checkpointIntentPath,
  checkpointStateFromBundle,
  checksum,
  exportCheckpoint,
  importCheckpoint,
  isOverlayStoreError,
  parse,
  sha256Hex,
  syntheticRev,
  verifyCheckpoint,
} from 'sanity-overlay-core'
import type {
  OverlayActor,
  OverlayCanonicalBundle,
  OverlayCheckpointChecksums,
  OverlayConflict,
  OverlayDocumentRecord,
  OverlayStore,
  SanityDocument,
} from 'sanity-overlay-core'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * What an adapter must provide for the §35.7 suite to run against it.
 *
 * `readRaw` / `writeRaw` / `intentRef` / `snapshotRef` exist for one §35.7 line —
 * "Checksum corruption detection" — which cannot be exercised through the store
 * API by design: a store that let you write bad bytes through its own front door
 * would not be worth testing. Every backend has addressable storage, so the four
 * hooks are adapter-neutral (a path for the filesystem, a blob key for Blob).
 */
export interface StoreContractHarness {
  store: OverlayStore
  /** Read the raw stored bytes at an adapter-relative ref. */
  readRaw(ref: string): Promise<string>
  /** Overwrite the raw stored bytes at an adapter-relative ref, bypassing the store. */
  writeRaw(ref: string, contents: string): Promise<void>
  /** Ref of a document's canonical review-facing intent (PRD §14.2). */
  intentRef(logicalId: string): string
  /** Ref of a content-addressed base snapshot (PRD §14.1). */
  snapshotRef(contentAddress: string): string
  teardown?(): Promise<void>
}

/** Produces a fresh, isolated, empty store. Called more than once per test file. */
export type StoreContractFactory = () => Promise<StoreContractHarness>

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

export const CONTRACT_OVERLAY_ID = 'contract-overlay-0000000000000000'

export const CONTRACT_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'agent-contract',
  displayName: 'Contract suite',
}

export const CONTRACT_BASE = {
  projectId: 'proj-contract',
  dataset: 'production',
  apiVersion: '2024-10-01',
} as const

export const CONTRACT_SOURCE = {
  repositoryId: 'github:planetary/sanity-branch-overlay',
  branch: 'feature/contract',
  pullRequestId: '42',
} as const

export interface DocumentRecordFixtureOptions {
  overlayId?: string
  logicalId: string
  schemaType?: string
  origin?: 'base' | 'branch'
  title?: string
  timestamp?: string
  overlayRevision?: number
  conflicts?: OverlayConflict[]
  /** Produce a record with no local state at all — head state `unchanged` (PRD §13.2). */
  untouched?: boolean
  publishedTombstone?: boolean
  draftTombstone?: boolean
}

/**
 * A valid PRD §13.3 `OverlayDocumentRecord`.
 *
 * `origin: 'base'` captures a base snapshot (the merge ancestor, §13.4) and a
 * local draft that sets `title`; `origin: 'branch'` has no base and a
 * `branch-created` ancestor, which is the §14.2 `mode: 'replace'` shape.
 */
export function documentRecordFixture(
  options: DocumentRecordFixtureOptions,
): OverlayDocumentRecord {
  const overlayId = options.overlayId ?? CONTRACT_OVERLAY_ID
  const logicalId = options.logicalId
  const schemaType = options.schemaType ?? 'article'
  const origin = options.origin ?? 'base'
  const timestamp = options.timestamp ?? '2026-01-01T00:00:00.000Z'
  const overlayRevision = options.overlayRevision ?? 1
  const title = options.title ?? `Title for ${logicalId}`

  const baseSnapshot: SanityDocument = {
    _id: logicalId,
    _type: schemaType,
    _rev: 'base-rev-1',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: `Base title for ${logicalId}`,
    body: [{_key: 'block-a', _type: 'block', text: 'base body'}],
  }

  const materialized: SanityDocument = {
    ...baseSnapshot,
    _updatedAt: timestamp,
    title,
  }

  const record: OverlayDocumentRecord = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId,
    logicalId,
    schemaType,
    origin,
    base:
      origin === 'branch'
        ? null
        : {
            firstTouchedAt: timestamp,
            published: {
              revision: 'base-rev-1',
              snapshot: baseSnapshot,
              checksum: checksum(baseSnapshot),
              capturedAt: timestamp,
            },
            draft: null,
            lastObservedPublishedRevision: 'base-rev-1',
            baseStatus: 'present',
          },
    local: {
      published: null,
      /* §34.1 — a tombstoned perspective carries no current local state. */
      draft:
        options.untouched === true || options.draftTombstone === true
          ? null
          : {
              materialized,
              touchedPaths: [['title']],
              operations: [{type: 'set', path: ['title'], value: title}],
              ancestorKind: origin === 'branch' ? 'branch-created' : 'base-published',
              ancestorRevision: origin === 'branch' ? undefined : 'base-rev-1',
              overlayRevision: String(overlayRevision),
              createdAt: timestamp,
              updatedAt: timestamp,
            },
      publishedTombstone: options.publishedTombstone ?? false,
      draftTombstone: options.draftTombstone ?? false,
    },
    conflicts: options.conflicts ?? [],
    runtimeRevision: syntheticRev(overlayRevision, checksum(materialized)),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  if (record.local.draft?.ancestorRevision === undefined && record.local.draft !== null) {
    delete record.local.draft.ancestorRevision
  }
  return record
}

/** A §13.11 conflict, unresolved by default so it counts toward `conflictSummary`. */
export function conflictFixture(
  documentId: string,
  overrides: Partial<OverlayConflict> = {},
): OverlayConflict {
  return {
    id: `conflict-${documentId}`,
    documentId,
    severity: 'hard',
    type: 'SAME_PATH_CHANGED',
    path: ['title'],
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

async function expectStoreError(
  run: () => Promise<unknown>,
  code: string,
): Promise<{code: string; message: string; details: Record<string, unknown>}> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  if (caught === undefined) {
    throw new Error(`Expected a store error with code ${code}, but the call resolved`)
  }
  if (!isOverlayStoreError(caught)) {
    throw new Error(
      `Expected an OverlayStoreError with code ${code}, received ${String(
        (caught as Error)?.name ?? caught,
      )}: ${String((caught as Error)?.message ?? caught)}`,
    )
  }
  expect(caught.code).toBe(code)
  return {code: caught.code, message: caught.message, details: {...caught.details}}
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

/**
 * Run the PRD §35.7 store contract suite against one adapter.
 *
 * @param name  Adapter name, used in the `describe` title.
 * @param makeStore  Factory producing a fresh, isolated, empty store.
 */
export function runStoreContractSuite(name: string, makeStore: StoreContractFactory): void {
  describe(`store contract (PRD §35.7) — ${name}`, () => {
    let harness: StoreContractHarness
    let store: OverlayStore
    const extraHarnesses: StoreContractHarness[] = []

    /** A second, independent store — needed by the export/import round trip. */
    async function makePeer(): Promise<StoreContractHarness> {
      const peer = await makeStore()
      extraHarnesses.push(peer)
      return peer
    }

    async function createOverlay(): Promise<void> {
      await store.createOverlay({
        overlayId: CONTRACT_OVERLAY_ID,
        base: {...CONTRACT_BASE},
        source: {...CONTRACT_SOURCE},
        actor: CONTRACT_ACTOR,
      })
    }

    beforeEach(async () => {
      harness = await makeStore()
      store = harness.store
    })

    afterEach(async () => {
      await harness.teardown?.()
      for (const extra of extraHarnesses.splice(0)) await extra.teardown?.()
    })

    /* ---------------------------------------------------------- 1 */
    it('Create overlay', async () => {
      const manifest = await store.createOverlay({
        overlayId: CONTRACT_OVERLAY_ID,
        base: {...CONTRACT_BASE},
        source: {...CONTRACT_SOURCE},
        actor: CONTRACT_ACTOR,
      })

      expect(manifest.formatVersion).toBe(OVERLAY_FORMAT_VERSION)
      expect(manifest.overlayId).toBe(CONTRACT_OVERLAY_ID)
      expect(manifest.status).toBe('active')
      expect(manifest.revision).toBe(0)
      expect(manifest.base).toEqual({...CONTRACT_BASE})
      expect(manifest.source).toEqual({...CONTRACT_SOURCE})
      expect(manifest.createdBy).toEqual(CONTRACT_ACTOR)
      expect(manifest.createdAt).toBe(manifest.updatedAt)

      /* Creating twice is an error, not a silent overwrite of live branch state. */
      await expectStoreError(
        () =>
          store.createOverlay({
            overlayId: CONTRACT_OVERLAY_ID,
            base: {...CONTRACT_BASE},
            source: {...CONTRACT_SOURCE},
          }),
        'OVERLAY_ALREADY_EXISTS',
      )

      const reopened = await store.createOverlay({
        overlayId: CONTRACT_OVERLAY_ID,
        base: {...CONTRACT_BASE},
        source: {...CONTRACT_SOURCE},
        ifNotExists: true,
      })
      expect(reopened.revision).toBe(0)
      expect(reopened.createdAt).toBe(manifest.createdAt)
    })

    /* ---------------------------------------------------------- 2 */
    it('Read empty overlay', async () => {
      await createOverlay()

      const manifest = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(manifest.revision).toBe(0)
      expect(manifest.documentHeads).toEqual({})
      expect(manifest.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
      expect(manifest.transactionHead).toBeUndefined()

      expect(await store.listChangedDocuments(CONTRACT_OVERLAY_ID)).toEqual([])
      expect(await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'nothing-here')).toBeNull()

      /* An overlay this store does not hold is an error, never an empty success. */
      let rejected = false
      try {
        await store.readManifest('some-other-overlay')
      } catch (error) {
        rejected = true
        expect(isOverlayStoreError(error)).toBe(true)
        expect(['OVERLAY_NOT_FOUND', 'OVERLAY_IDENTITY_MISMATCH']).toContain(
          (error as {code: string}).code,
        )
      }
      expect(rejected).toBe(true)
    })

    /* ---------------------------------------------------------- 3 */
    it('Conditional manifest write', async () => {
      await createOverlay()
      const current = await store.readManifest(CONTRACT_OVERLAY_ID)

      const next = {...current, revision: current.revision + 1, status: 'conflicted' as const}
      const written = await store.writeManifestConditional(
        CONTRACT_OVERLAY_ID,
        next,
        current.revision,
        {actor: CONTRACT_ACTOR},
      )
      expect(written.revision).toBe(1)
      expect(written.status).toBe('conflicted')
      expect(written.updatedBy).toEqual(CONTRACT_ACTOR)

      const reread = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(reread.revision).toBe(1)
      expect(reread.status).toBe('conflicted')

      /* A conditional write is the overlay's exactly-once increment (PRD §34.5). */
      await expectStoreError(
        () => store.writeManifestConditional(CONTRACT_OVERLAY_ID, {...reread, revision: 5}, 1),
        'INVALID_REQUEST',
      )
      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).revision).toBe(1)

      /* The overlayId *is* the overlay's identity (PRD §12.1) — not a field a
       * write may edit. A body that renames the overlay is refused even when its
       * revision arithmetic is impeccable, so a manifest write can never
       * re-identify the state it replaces. */
      await expectStoreError(
        () =>
          store.writeManifestConditional(
            CONTRACT_OVERLAY_ID,
            {...reread, overlayId: 'some-other-overlay', revision: reread.revision + 1},
            reread.revision,
          ),
        'OVERLAY_IDENTITY_MISMATCH',
      )
      const unchanged = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(unchanged.overlayId).toBe(CONTRACT_OVERLAY_ID)
      expect(unchanged.revision).toBe(1)
    })

    /* ---------------------------------------------------------- 4 */
    it('Store and read document revision', async () => {
      await createOverlay()
      const record = documentRecordFixture({logicalId: 'article-1', title: 'Stored title'})

      const result = await store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)

      expect(result.manifest.revision).toBe(1)
      expect(result.checksum).toBe(checksum(record))
      expect(result.snapshotRef).toBeDefined()
      expect(result.head).toMatchObject({
        logicalId: 'article-1',
        schemaType: 'article',
        runtimeRevision: record.runtimeRevision,
        checksum: result.checksum,
        state: 'modified',
        hasDraft: true,
        hasPublished: false,
        hasConflict: false,
      })

      const roundTripped = await store.getDocumentRevision(CONTRACT_OVERLAY_ID, result.storageRef)
      expect(roundTripped).toEqual(record)

      const manifest = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(manifest.documentHeads['article-1']).toEqual(result.head)

      /* An unknown revision address reads as absent, not as an exception. */
      expect(
        await store.getDocumentRevision(
          CONTRACT_OVERLAY_ID,
          result.storageRef.replace(/[0-9a-f]{8}\.json$/, 'deadbeef.json'),
        ),
      ).toBeNull()

      /* Document-level precondition (PRD §25.5 `expectedDocumentRevisions`). */
      await expectStoreError(
        () =>
          store.putDocumentRevision(
            CONTRACT_OVERLAY_ID,
            documentRecordFixture({logicalId: 'article-1', title: 'Racy'}),
            {expectedDocumentRevision: 'overlay.9.aaaaaaaaaaaa'},
          ),
        'DOCUMENT_REVISION_CONFLICT',
      )

      /* A record carrying a foreign `overlayId` is refused, never silently
       * refiled under this overlay (PRD §12.1, §13.3). The rejection happens
       * before anything is stored, so no head and no revision appear. */
      const beforeForeign = await store.readManifest(CONTRACT_OVERLAY_ID)
      await expectStoreError(
        () =>
          store.putDocumentRevision(CONTRACT_OVERLAY_ID, {
            ...documentRecordFixture({logicalId: 'article-2'}),
            overlayId: 'some-other-overlay',
          }),
        'OVERLAY_IDENTITY_MISMATCH',
      )
      const afterForeign = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(afterForeign.revision).toBe(beforeForeign.revision)
      expect(afterForeign.documentHeads['article-2']).toBeUndefined()
      expect(await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-2')).toBeNull()
    })

    /* ---------------------------------------------------------- 5 */
    it('Commit multi-document transaction', async () => {
      await createOverlay()
      const before = await store.readManifest(CONTRACT_OVERLAY_ID)

      const records = [
        documentRecordFixture({logicalId: 'article-b', title: 'B'}),
        documentRecordFixture({logicalId: 'article-a', title: 'A'}),
        documentRecordFixture({
          logicalId: 'article-c',
          origin: 'branch',
          title: 'C',
          conflicts: [conflictFixture('article-c')],
        }),
      ]

      const result = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'multi-doc-1',
        actor: CONTRACT_ACTOR,
        mutations: records.map((record) => ({
          type: 'patch' as const,
          id: record.logicalId,
          operations: [{type: 'set' as const, path: ['title'], value: 'x'}],
        })),
        records,
      })

      expect(result.replayed).toBe(false)
      /* §34.5 — exactly one revision increment for the whole transaction. */
      expect(result.manifest.revision).toBe(before.revision + 1)
      expect(result.transaction.overlayRevisionBefore).toBe(before.revision)
      expect(result.transaction.overlayRevisionAfter).toBe(before.revision + 1)
      expect(result.transaction.affectedDocumentIds).toEqual([
        'article-a',
        'article-b',
        'article-c',
      ])
      expect(result.transaction.idempotencyKey).toBe('multi-doc-1')
      expect(result.transaction.transactionId).toBeTruthy()
      for (const record of records) {
        expect(result.transaction.resultChecksums[record.logicalId]).toBe(checksum(record))
      }

      const manifest = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(Object.keys(manifest.documentHeads).sort()).toEqual([
        'article-a',
        'article-b',
        'article-c',
      ])
      expect(manifest.transactionHead).toBe(result.transaction.transactionId)

      /* Unresolved conflicts roll up into the manifest summary (PRD §13.1). */
      expect(manifest.documentHeads['article-c']?.hasConflict).toBe(true)
      expect(manifest.documentHeads['article-a']?.hasConflict).toBe(false)
      expect(manifest.conflictSummary).toEqual({total: 1, hard: 1, soft: 0})

      /* Every head reaches a stored revision (PRD §34.3). */
      for (const head of Object.values(manifest.documentHeads)) {
        const stored = await store.getDocumentRevision(CONTRACT_OVERLAY_ID, head.storageRef)
        expect(stored).not.toBeNull()
        expect(checksum(stored)).toBe(head.checksum)
      }
    })

    /* ---------------------------------------------------------- 6 */
    it('Idempotent transaction replay', async () => {
      await createOverlay()
      const record = documentRecordFixture({logicalId: 'article-1', title: 'First write'})

      const first = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'replay-key',
        actor: CONTRACT_ACTOR,
        mutations: [{type: 'patch', id: 'article-1', operations: []}],
        records: [record],
      })
      const afterFirst = await store.readManifest(CONTRACT_OVERLAY_ID)

      /* A retry carrying the same key returns the original result and applies
       * nothing — even when the retry body differs (PRD §13.10, §34.6). */
      const replay = await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'replay-key',
        actor: CONTRACT_ACTOR,
        mutations: [{type: 'delete', id: 'article-1'}],
        records: [documentRecordFixture({logicalId: 'article-1', title: 'MUST NOT BE APPLIED'})],
      })

      expect(replay.replayed).toBe(true)
      expect(replay.transaction.transactionId).toBe(first.transaction.transactionId)
      expect(replay.transaction).toEqual(first.transaction)
      expect(replay.manifest.revision).toBe(afterFirst.revision)

      const stored = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
      expect(stored?.record).toEqual(record)
      expect(stored?.head.checksum).toBe(checksum(record))

      /* Both selectors resolve the same immutable result. */
      const byKey = await store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: 'replay-key'})
      const byId = await store.getTransaction(CONTRACT_OVERLAY_ID, {
        transactionId: first.transaction.transactionId,
      })
      expect(byKey).toEqual(first.transaction)
      expect(byId).toEqual(first.transaction)
      expect(await store.getTransaction(CONTRACT_OVERLAY_ID, {idempotencyKey: 'never'})).toBeNull()
      expect(
        await store.getTransaction(CONTRACT_OVERLAY_ID, {transactionId: 'tx-does-not-exist'}),
      ).toBeNull()

      /* A transaction is scoped to the overlay that committed it (PRD §12.1,
       * §13.10). Asking under a different overlay ID is an identity error, not a
       * silent hit — otherwise an idempotency key could replay one overlay's
       * committed work into another. */
      await expectStoreError(
        () =>
          store.getTransaction('some-other-overlay', {
            transactionId: first.transaction.transactionId,
          }),
        'OVERLAY_IDENTITY_MISMATCH',
      )
      await expectStoreError(
        () => store.getTransaction('some-other-overlay', {idempotencyKey: 'replay-key'}),
        'OVERLAY_IDENTITY_MISMATCH',
      )
    })

    /* ---------------------------------------------------------- 7 */
    it('Concurrent stale write rejection', async () => {
      await createOverlay()

      /* Two callers read the same revision; the second commits against a revision
       * that no longer exists (PRD §14.3 expected manifest revision). */
      const readerA = await store.readManifest(CONTRACT_OVERLAY_ID)
      const readerB = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(readerA.revision).toBe(readerB.revision)

      await store.writeManifestConditional(
        CONTRACT_OVERLAY_ID,
        {...readerA, revision: readerA.revision + 1},
        readerA.revision,
      )

      const failure = await expectStoreError(
        () =>
          store.writeManifestConditional(
            CONTRACT_OVERLAY_ID,
            {...readerB, revision: readerB.revision + 1},
            readerB.revision,
          ),
        'OVERLAY_WRITE_CONFLICT',
      )
      expect(failure.details).toMatchObject({
        expectedRevision: readerB.revision,
        actualRevision: readerA.revision + 1,
      })

      /* The losing write left nothing behind. */
      const manifest = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(manifest.revision).toBe(readerA.revision + 1)

      /* The same precondition guards document and transaction writes. */
      await expectStoreError(
        () =>
          store.putDocumentRevision(
            CONTRACT_OVERLAY_ID,
            documentRecordFixture({logicalId: 'article-1'}),
            {expectedOverlayRevision: readerB.revision},
          ),
        'OVERLAY_WRITE_CONFLICT',
      )
      await expectStoreError(
        () =>
          store.commitTransaction(CONTRACT_OVERLAY_ID, {
            idempotencyKey: 'stale-commit',
            actor: CONTRACT_ACTOR,
            mutations: [],
            records: [documentRecordFixture({logicalId: 'article-1'})],
            expectedOverlayRevision: readerB.revision,
          }),
        'OVERLAY_WRITE_CONFLICT',
      )
      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).revision).toBe(readerA.revision + 1)

      /* The per-document precondition guards a commit as well as a single write
       * (PRD §25.5 `expectedDocumentRevisions`): a caller that believes it holds
       * `article-1` at some revision must lose when the overlay disagrees — here
       * the document does not exist at all, so every expectation is stale. */
      await expectStoreError(
        () =>
          store.commitTransaction(CONTRACT_OVERLAY_ID, {
            idempotencyKey: 'stale-document-commit',
            actor: CONTRACT_ACTOR,
            mutations: [],
            records: [documentRecordFixture({logicalId: 'article-1'})],
            expectedDocumentRevisions: {'article-1': 'overlay.9.aaaaaaaaaaaa'},
          }),
        'DOCUMENT_REVISION_CONFLICT',
      )
      /* The rejected commit is not recorded, so its key stays replayable. */
      expect(
        await store.getTransaction(CONTRACT_OVERLAY_ID, {
          idempotencyKey: 'stale-document-commit',
        }),
      ).toBeNull()
      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).revision).toBe(readerA.revision + 1)
    })

    /* ---------------------------------------------------------- 8 */
    it('List changed documents', async () => {
      await createOverlay()

      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-z', title: 'Z'}),
      )
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-a', origin: 'branch', title: 'A'}),
      )
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({
          logicalId: 'article-m',
          publishedTombstone: true,
          draftTombstone: true,
        }),
      )
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-u', untouched: true}),
      )

      const changed = await store.listChangedDocuments(CONTRACT_OVERLAY_ID)
      expect(changed.map((head) => head.logicalId)).toEqual([
        'article-a',
        'article-m',
        'article-z',
      ])
      expect(changed.map((head) => head.state)).toEqual(['created', 'deleted', 'modified'])

      const all = await store.listChangedDocuments(CONTRACT_OVERLAY_ID, {includeUnchanged: true})
      expect(all.map((head) => head.logicalId)).toEqual([
        'article-a',
        'article-m',
        'article-u',
        'article-z',
      ])

      const created = await store.listChangedDocuments(CONTRACT_OVERLAY_ID, {states: ['created']})
      expect(created.map((head) => head.logicalId)).toEqual(['article-a'])
    })

    /* ---------------------------------------------------------- 9 */
    it('Read by logical ID', async () => {
      await createOverlay()
      const record = documentRecordFixture({logicalId: 'article-1', title: 'Readable'})
      const written = await store.putDocumentRevision(CONTRACT_OVERLAY_ID, record)

      const read = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
      expect(read).not.toBeNull()
      expect(read?.head).toEqual(written.head)
      expect(read?.record).toEqual(record)
      expect(read?.storageRef).toBe(written.storageRef)

      /* PRD §14.2 — the canonical review-facing artifact. */
      expect(read?.intent?.logicalId).toBe('article-1')
      expect(read?.intent?.type).toBe('article')
      expect(read?.intent?.draft?.mode).toBe('patch')
      expect(read?.intent?.draft?.overrides).toEqual([{path: ['title'], value: 'Readable'}])
      expect(read?.intent?.touchedPaths).toEqual([['title']])
      expect(read?.intent?.base.snapshotRef).toBe(written.snapshotRef)

      /* The base capture is reachable from the intent (§14.2 three-way merge). */
      expect(read?.baseSnapshot?.published?.revision).toBe('base-rev-1')

      /* Draft and published state share one logical document (PRD §13.3, §18.2). */
      const viaDraftId = await store.readDocumentByLogicalId(
        CONTRACT_OVERLAY_ID,
        'drafts.article-1',
      )
      expect(viaDraftId?.head).toEqual(written.head)

      expect(await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-absent')).toBeNull()
    })

    /* ---------------------------------------------------------- 10 */
    it('Export canonical state', async () => {
      await createOverlay()
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'export-seed',
        actor: CONTRACT_ACTOR,
        mutations: [{type: 'patch', id: 'article-1', operations: []}],
        records: [
          documentRecordFixture({logicalId: 'article-1', title: 'One'}),
          documentRecordFixture({logicalId: 'article-2', title: 'Two'}),
        ],
      })

      const bundle = await store.exportCanonical(CONTRACT_OVERLAY_ID)

      expect(bundle.formatVersion).toBe(OVERLAY_FORMAT_VERSION)
      expect(bundle.overlayId).toBe(CONTRACT_OVERLAY_ID)
      expect(bundle.manifest.revision).toBe(1)
      expect(bundle.documents.map((entry) => entry.intent.logicalId)).toEqual([
        'article-1',
        'article-2',
      ])
      expect(bundle.transactions).toHaveLength(1)
      expect(Object.keys(bundle.snapshots)).toHaveLength(2)
      for (const [address, snapshot] of Object.entries(bundle.snapshots)) {
        expect(checksum(snapshot)).toBe(address)
      }
      expect(bundle.checksum).toMatch(/^[0-9a-f]{64}$/)

      /* Deterministic for the same logical state (PRD §34.17). */
      const again = await store.exportCanonical(CONTRACT_OVERLAY_ID)
      expect({...again, exportedAt: '', checksum: ''}).toEqual({
        ...bundle,
        exportedAt: '',
        checksum: '',
      })

      /* The same state renders to the Git-facing checkpoint tree (PRD §29.1).
       * Rendering is core's, so this holds for every adapter — and it is the
       * *whole-checkpoint* granularity §34.17 asks for, not just per file. */
      const checkpoint = exportCheckpoint(checkpointStateFromBundle(bundle))
      expect([...checkpoint.keys()]).toEqual(
        [
          CHECKPOINT_CHECKSUMS_FILE,
          CHECKPOINT_MANIFEST_FILE,
          checkpointIntentPath('article-1'),
          checkpointIntentPath('article-2'),
          ...Object.keys(bundle.snapshots).map((address) => `snapshots/${address}.json`),
        ].sort(),
      )
      expect(checkpointFilesToRecord(exportCheckpoint(checkpointStateFromBundle(again)))).toEqual(
        checkpointFilesToRecord(checkpoint),
      )

      /* The checksum manifest hashes the exact bytes of every other file. */
      const checksums = parse(
        checkpoint.get(CHECKPOINT_CHECKSUMS_FILE)!,
      ) as OverlayCheckpointChecksums
      for (const [path, text] of checkpoint) {
        if (path === CHECKPOINT_CHECKSUMS_FILE) continue
        expect(checksums.files[path], path).toBe(sha256Hex(text))
      }
      expect(verifyCheckpoint(checkpoint).ok).toBe(true)
    })

    /* ---------------------------------------------------------- 11 */
    it('Import canonical state', async () => {
      await createOverlay()
      await store.commitTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'import-seed',
        actor: CONTRACT_ACTOR,
        mutations: [{type: 'patch', id: 'article-1', operations: []}],
        records: [
          documentRecordFixture({logicalId: 'article-1', title: 'One'}),
          documentRecordFixture({logicalId: 'legacy.page.v2', title: 'Dotted'}),
        ],
      })
      const bundle = await store.exportCanonical(CONTRACT_OVERLAY_ID)

      const peer = await makePeer()
      const result = await peer.store.importCanonical(bundle)

      expect(result.importedDocuments).toBe(2)
      expect(result.importedSnapshots).toBe(2)
      expect(result.importedTransactions).toBe(1)

      const imported = await peer.store.readManifest(CONTRACT_OVERLAY_ID)
      expect(imported).toEqual(bundle.manifest)

      for (const entry of bundle.documents) {
        const read = await peer.store.readDocumentByLogicalId(
          CONTRACT_OVERLAY_ID,
          entry.intent.logicalId,
        )
        expect(read?.record).toEqual(entry.record)
        expect(read?.intent).toEqual(entry.intent)
      }

      /* The imported store re-exports byte-identical logical state (PRD §34.17). */
      const reexported = await peer.store.exportCanonical(CONTRACT_OVERLAY_ID)
      expect({...reexported, exportedAt: '', checksum: ''}).toEqual({
        ...bundle,
        exportedAt: '',
        checksum: '',
      })

      /* Idempotency survives the transfer (PRD §34.6). */
      const replayed = await peer.store.getTransaction(CONTRACT_OVERLAY_ID, {
        idempotencyKey: 'import-seed',
      })
      expect(replayed?.transactionId).toBe(bundle.transactions[0]?.transactionId)

      /* Importing over live state needs an explicit opt-in. */
      await expectStoreError(
        () => peer.store.importCanonical(bundle),
        'OVERLAY_ALREADY_EXISTS',
      )
      const overwritten = await peer.store.importCanonical(bundle, {overwrite: true})
      expect(overwritten.importedDocuments).toBe(2)

      /* A tampered bundle is refused before anything is written (PRD §34.4). */
      const tampered: OverlayCanonicalBundle = {
        ...bundle,
        manifest: {...bundle.manifest, revision: 99},
      }
      const peerTwo = await makePeer()
      await expectStoreError(() => peerTwo.store.importCanonical(tampered), 'CHECKSUM_MISMATCH')

      /* The checkpoint tree round-trips the same logical state and re-renders
       * byte-identically, for every adapter (PRD §29.7, §34.17). */
      const checkpoint = exportCheckpoint(checkpointStateFromBundle(bundle))
      const reimported = importCheckpoint(checkpoint)
      expect(reimported.repaired).toEqual([])
      expect(reimported.state.manifest).toEqual(bundle.manifest)
      expect(reimported.state.documents).toEqual(
        bundle.documents.map((entry) => entry.intent),
      )
      expect(reimported.state.snapshots).toEqual(bundle.snapshots)
      expect(checkpointFilesToRecord(reimported.files)).toEqual(
        checkpointFilesToRecord(checkpoint),
      )

      /* A hand edit that leaves the file valid is repairable metadata, never a
       * rejection (PRD §14.3); a violated content address is not. */
      const edited = new Map(checkpoint)
      const intentRefPath = checkpointIntentPath('article-1')
      edited.set(intentRefPath, edited.get(intentRefPath)!.replace('"One"', '"Hand edited"'))
      const editedReport = verifyCheckpoint(edited)
      expect(editedReport.corrupt).toEqual([])
      expect(editedReport.repairable.map((issue) => issue.ref)).toContain(intentRefPath)
      expect(importCheckpoint(edited).repaired).toContain(intentRefPath)

      const snapshotAddress = Object.keys(bundle.snapshots)[0]!
      const damaged = new Map(checkpoint)
      damaged.set(
        `snapshots/${snapshotAddress}.json`,
        damaged.get(`snapshots/${snapshotAddress}.json`)!.replace('base body', 'tampered body'),
      )
      expect(verifyCheckpoint(damaged).corrupt.map((issue) => issue.kind)).toContain(
        'content-address-mismatch',
      )
    })

    /* ---------------------------------------------------------- 12 */
    it('Mark closed', async () => {
      await createOverlay()
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1'}),
      )

      const closed = await store.markClosed(CONTRACT_OVERLAY_ID, {actor: CONTRACT_ACTOR})
      expect(closed.status).toBe('closed')
      expect(closed.revision).toBe(2)
      expect(closed.updatedBy).toEqual(CONTRACT_ACTOR)
      /* PRD §15.7 default: closed and uncheckpointed retains for 30 days. */
      expect(closed.expiresAt).toBeDefined()
      expect(daysBetween(closed.updatedAt, closed.expiresAt!)).toBe(30)

      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).status).toBe('closed')

      /* PRD §12.3 — a closed overlay refuses writes by default. */
      await expectStoreError(
        () =>
          store.putDocumentRevision(
            CONTRACT_OVERLAY_ID,
            documentRecordFixture({logicalId: 'article-2'}),
          ),
        'OVERLAY_CLOSED',
      )
      await expectStoreError(
        () =>
          store.commitTransaction(CONTRACT_OVERLAY_ID, {
            idempotencyKey: 'after-close',
            actor: CONTRACT_ACTOR,
            mutations: [],
            records: [documentRecordFixture({logicalId: 'article-2'})],
          }),
        'OVERLAY_CLOSED',
      )

      /* Reads still work — a closed overlay is retained, not erased (§12.3). */
      const head = await store.readDocumentByLogicalId(CONTRACT_OVERLAY_ID, 'article-1')
      expect(head?.head.logicalId).toBe('article-1')
    })

    /* ---------------------------------------------------------- 13 */
    it('Mark promoted', async () => {
      await createOverlay()
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1'}),
      )

      /* PRD §12.3 — the only edge into `promoted` starts at `closed`. */
      await expectStoreError(
        () => store.markPromoted(CONTRACT_OVERLAY_ID, {planId: 'plan-1'}),
        'INVALID_REQUEST',
      )

      await store.markClosed(CONTRACT_OVERLAY_ID)
      const promoted = await store.markPromoted(CONTRACT_OVERLAY_ID, {
        planId: 'plan-1',
        targetDataset: 'staging',
        resultingTransactionId: 'sanity-tx-77',
        actor: CONTRACT_ACTOR,
      })

      expect(promoted.status).toBe('promoted')
      expect(promoted.promotion).toMatchObject({
        planId: 'plan-1',
        targetDataset: 'staging',
        resultingTransactionId: 'sanity-tx-77',
      })
      expect(promoted.promotion?.promotedAt).toBeDefined()
      /* PRD §15.7 default: promoted retains for 14 days. */
      expect(daysBetween(promoted.updatedAt, promoted.expiresAt!)).toBe(14)

      const reread = await store.readManifest(CONTRACT_OVERLAY_ID)
      expect(reread.status).toBe('promoted')
      expect(reread.promotion).toEqual(promoted.promotion)
    })

    /* ---------------------------------------------------------- 14 */
    it('Retention metadata', async () => {
      await createOverlay()
      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).expiresAt).toBeUndefined()

      const relative = await store.setRetention(CONTRACT_OVERLAY_ID, {
        ttlDays: 7,
        reason: 'orphan sweep',
      })
      expect(relative.revision).toBe(1)
      expect(daysBetween(relative.updatedAt, relative.expiresAt!)).toBe(7)

      const absolute = await store.setRetention(CONTRACT_OVERLAY_ID, {
        expiresAt: '2030-01-01T00:00:00.000Z',
      })
      expect(absolute.expiresAt).toBe('2030-01-01T00:00:00.000Z')
      expect(absolute.revision).toBe(2)

      const cleared = await store.setRetention(CONTRACT_OVERLAY_ID, {expiresAt: null})
      expect(cleared.expiresAt).toBeUndefined()

      expect((await store.readManifest(CONTRACT_OVERLAY_ID)).expiresAt).toBeUndefined()
    })

    /* ---------------------------------------------------------- 15 */
    it('Delete overlay', async () => {
      await createOverlay()
      await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1'}),
      )

      /* PRD §15.7 — "Mark overlay closed before deletion". */
      await expectStoreError(
        () => store.deleteOverlay(CONTRACT_OVERLAY_ID),
        'OVERLAY_RETENTION_ACTIVE',
      )

      await store.markClosed(CONTRACT_OVERLAY_ID)
      const result = await store.deleteOverlay(CONTRACT_OVERLAY_ID)

      expect(result.deleted).toBe(true)
      expect(result.overlayId).toBe(CONTRACT_OVERLAY_ID)
      expect(result.removedRefs.length).toBeGreaterThan(0)

      await expectStoreError(() => store.readManifest(CONTRACT_OVERLAY_ID), 'OVERLAY_NOT_FOUND')
    })

    /* ---------------------------------------------------------- 16 */
    it('Orphan revision cleanup', async () => {
      await createOverlay()

      const first = await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Version one'}),
      )
      const second = await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({
          logicalId: 'article-1',
          title: 'Version two',
          overlayRevision: 2,
          timestamp: '2026-01-02T00:00:00.000Z',
        }),
      )
      expect(second.storageRef).not.toBe(first.storageRef)

      /* The superseded revision is unreachable from any head (PRD §34.8). */
      const dryRun = await store.collectOrphans(CONTRACT_OVERLAY_ID, {dryRun: true})
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.deleted).toEqual([])
      expect(dryRun.orphans.map((orphan) => orphan.ref)).toContain(first.storageRef)
      expect(dryRun.orphans.map((orphan) => orphan.ref)).not.toContain(second.storageRef)
      /* Nothing was removed by the dry run. */
      expect(await store.getDocumentRevision(CONTRACT_OVERLAY_ID, first.storageRef)).not.toBeNull()

      const collected = await store.collectOrphans(CONTRACT_OVERLAY_ID)
      expect(collected.failures).toEqual([])
      expect(collected.deleted.map((orphan) => orphan.ref)).toContain(first.storageRef)
      expect(await store.getDocumentRevision(CONTRACT_OVERLAY_ID, first.storageRef)).toBeNull()

      /* The reachable state is untouched and still verifies. */
      expect(await store.getDocumentRevision(CONTRACT_OVERLAY_ID, second.storageRef)).not.toBeNull()
      const report = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
      expect(report.ok).toBe(true)

      /* A second sweep finds nothing left to reclaim. */
      const rerun = await store.collectOrphans(CONTRACT_OVERLAY_ID)
      expect(rerun.orphans).toEqual([])
    })

    /* ---------------------------------------------------------- 17 */
    it('Checksum corruption detection', async () => {
      await createOverlay()
      const written = await store.putDocumentRevision(
        CONTRACT_OVERLAY_ID,
        documentRecordFixture({logicalId: 'article-1', title: 'Original'}),
      )

      const clean = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
      expect(clean.ok).toBe(true)
      expect(clean.issues).toEqual([])
      expect(clean.missing).toEqual([])
      expect(clean.checked).toBeGreaterThan(0)

      /* (a) The review-facing intent is edited but its checksum is left stale.
       * PRD §14.3: repairable metadata, not a rejection. */
      const intentRef = harness.intentRef('article-1')
      const intentText = await harness.readRaw(intentRef)
      await harness.writeRaw(intentRef, intentText.replace('Original', 'Edited by hand'))

      const afterIntentEdit = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
      expect(afterIntentEdit.ok).toBe(false)
      const intentIssue = afterIntentEdit.issues.find((issue) => issue.kind === 'intent')
      expect(intentIssue).toBeDefined()
      expect(intentIssue?.logicalId).toBe('article-1')
      expect(intentIssue?.repairable).toBe(true)
      expect(intentIssue?.expected).not.toBe(intentIssue?.actual)

      /* (b) A content-addressed artifact whose bytes no longer hash to its own
       * name is corruption, and must not be classified as repairable metadata. */
      const snapshotRef = harness.snapshotRef(written.snapshotRef!)
      const snapshotText = await harness.readRaw(snapshotRef)
      await harness.writeRaw(snapshotRef, snapshotText.replace('base body', 'tampered body'))

      const afterSnapshotEdit = await store.verifyChecksums(CONTRACT_OVERLAY_ID)
      const snapshotIssue = afterSnapshotEdit.issues.find((issue) => issue.kind === 'snapshot')
      expect(snapshotIssue).toBeDefined()
      expect(snapshotIssue?.repairable).toBe(false)
      expect(snapshotIssue?.expected).toBe(written.snapshotRef)
      expect(snapshotIssue?.actual).not.toBe(written.snapshotRef)
      expect(afterSnapshotEdit.ok).toBe(false)
    })
  })
}
