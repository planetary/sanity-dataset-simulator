import {describe, expect, it} from 'vitest'
import type {
  OverlayActor,
  OverlayConflict,
  OverlayConflictType,
  OverlayPath,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'
import {
  CONFLICT_RESOLUTION_ACTIONS,
  CONFLICT_RESOLUTION_ACTION_TYPES,
  acknowledgeConflict,
  applicableResolutionActions,
  createConflict,
  isAcknowledgementValid,
  resolveConflict,
  resolveRecordConflict,
  summarizeConflicts,
} from '../../sanity-overlay-core/src/conflicts/index'
import type {ResolveConflictRequest} from '../../sanity-overlay-core/src/conflicts/index'
import type {OverlayDocumentRecord} from '../../sanity-overlay-core/src/index'
import {ANCESTOR_ARTICLE, clone, localVariant, variant} from '../src/mergeFixtures'

// Phase 2 workstream W3 — PRD §28.3 document conflict panel actions mapped to the
// §13.11 `resolution.type` set, §28.1 "resolution creates a new overlay
// transaction", §28.6 soft-conflict acknowledgement.

const NOW = '2026-08-04T09:00:00.000Z'

const ACTOR: OverlayActor = {type: 'user', id: 'user-1', displayName: 'Ada'}

const BASE = variant(ANCESTOR_ARTICLE, (document) => {
  document.title = 'Upstream title'
})

const LOCAL = localVariant(ANCESTOR_ARTICLE, (document) => {
  document.title = 'Branch title'
})

/** `null` means "a conflict with no path" — `undefined` would take the default. */
function conflict(
  type: OverlayConflictType = 'SAME_PATH_CHANGED',
  path: OverlayPath | null = ['title'],
): OverlayConflict {
  return createConflict({
    documentId: 'article-1',
    type,
    detectedAt: NOW,
    ...(path === null ? {} : {path}),
    ancestorValue: 'Ancestor title',
    baseValue: 'Upstream title',
    localValue: 'Branch title',
  })
}

function req(overrides: Partial<ResolveConflictRequest> = {}): ResolveConflictRequest {
  return {
    documentId: 'article-1',
    now: NOW,
    transactionId: 'txn-resolve-1',
    actor: ACTOR,
    conflict: conflict(),
    action: 'keep-branch-value',
    currentBase: BASE,
    localMaterialized: LOCAL,
    touchedPaths: [['title']],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * §28.3 actions mapped onto the §13.11 resolution types
 * ------------------------------------------------------------------ */

describe('§28.3 conflict panel actions', () => {
  it('covers every documented action and maps each to a §13.11 resolution type', () => {
    expect(CONFLICT_RESOLUTION_ACTIONS).toEqual([
      'keep-branch-value',
      'accept-current-staging',
      'manual-edit',
      'remove-local-override',
      'keep-as-branch-created',
      'accept-base-deletion',
      'rename-branch-id',
    ])
    expect(CONFLICT_RESOLUTION_ACTION_TYPES).toEqual({
      'keep-branch-value': 'keep-local',
      'accept-current-staging': 'accept-base',
      'manual-edit': 'manual',
      'remove-local-override': 'accept-base',
      'keep-as-branch-created': 'keep-local',
      'accept-base-deletion': 'delete-local',
      'rename-branch-id': 'rename',
    })
    // Every §13.11 resolution type is reachable from some §28.3 action.
    expect(new Set(Object.values(CONFLICT_RESOLUTION_ACTION_TYPES))).toEqual(
      new Set(['keep-local', 'accept-base', 'manual', 'rename', 'delete-local']),
    )
  })

  it('keep branch value leaves local intent untouched', () => {
    const result = resolveConflict(req({action: 'keep-branch-value'}))

    expect(result.conflict.resolution).toEqual({
      type: 'keep-local',
      resolvedAt: NOW,
      resolvedBy: ACTOR,
    })
    expect(result.localMaterialized?.title).toBe('Branch title')
    expect(result.touchedPaths.map((path) => path.join('.'))).toEqual(['title'])
  })

  it('accept current staging value pins the base value and drops the override', () => {
    const result = resolveConflict(req({action: 'accept-current-staging'}))

    expect(result.conflict.resolution?.type).toBe('accept-base')
    expect(result.localMaterialized?.title).toBe('Upstream title')
    expect(result.touchedPaths).toEqual([])
  })

  it('manual edit stores the operator value and keeps the path touched', () => {
    const result = resolveConflict(req({action: 'manual-edit', value: 'Resolved title'}))

    expect(result.conflict.resolution?.type).toBe('manual')
    expect(result.localMaterialized?.title).toBe('Resolved title')
    expect(result.touchedPaths.map((path) => path.join('.'))).toEqual(['title'])
  })

  it('remove local override drops the field so the path resumes inheritance', () => {
    const result = resolveConflict(req({action: 'remove-local-override'}))

    expect(result.conflict.resolution?.type).toBe('accept-base')
    expect(result.localMaterialized).not.toHaveProperty('title')
    expect(result.touchedPaths).toEqual([])
  })

  it('remove local override also clears an explicit unset on the path (§17.5)', () => {
    const result = resolveConflict(
      req({
        action: 'remove-local-override',
        conflict: conflict('SAME_PATH_CHANGED', ['summary']),
        touchedPaths: [['summary']],
        unsetPaths: [['summary']],
        localMaterialized: localVariant(ANCESTOR_ARTICLE, (document) => {
          delete document.summary
        }),
      }),
    )

    expect(result.touchedPaths).toEqual([])
    expect(result.unsetPaths).toEqual([])
  })

  it('keep document as branch-created after base deletion', () => {
    const result = resolveConflict(
      req({
        action: 'keep-as-branch-created',
        conflict: conflict('BASE_DOCUMENT_DELETED', null),
        currentBase: null,
      }),
    )

    expect(result.conflict.resolution?.type).toBe('keep-local')
    expect(result.origin).toBe('branch')
    expect(result.localTombstone).toBe(false)
    expect(result.localMaterialized?.title).toBe('Branch title')
  })

  it('accept base deletion tombstones the document and drops local state', () => {
    const result = resolveConflict(
      req({
        action: 'accept-base-deletion',
        conflict: conflict('BASE_DOCUMENT_DELETED', null),
        currentBase: null,
      }),
    )

    expect(result.conflict.resolution?.type).toBe('delete-local')
    expect(result.localTombstone).toBe(true)
    expect(result.localMaterialized).toBeNull()
    expect(result.touchedPaths).toEqual([])
  })

  it('rename branch-created ID moves the document to the new logical ID', () => {
    const result = resolveConflict(
      req({
        action: 'rename-branch-id',
        conflict: conflict('LOCAL_ID_COLLISION', null),
        newId: 'article-1-branch',
        origin: 'branch',
      }),
    )

    expect(result.conflict.resolution?.type).toBe('rename')
    expect(result.documentId).toBe('article-1-branch')
    expect(result.localMaterialized?._id).toBe('article-1-branch')
    expect(result.origin).toBe('branch')
  })

  it('rejects a rename without a new ID and a path action without a conflict path', () => {
    expect(() =>
      resolveConflict(req({action: 'rename-branch-id', conflict: conflict('LOCAL_ID_COLLISION', null)})),
    ).toThrow(/newId/)
    expect(() =>
      resolveConflict(
        req({action: 'accept-current-staging', conflict: conflict('BASE_DOCUMENT_DELETED', null)}),
      ),
    ).toThrow(/path/)
  })

  it('lists the actions applicable to each conflict shape', () => {
    expect(applicableResolutionActions(conflict('BASE_DOCUMENT_DELETED', null))).toEqual([
      'keep-as-branch-created',
      'accept-base-deletion',
    ])
    expect(applicableResolutionActions(conflict('LOCAL_ID_COLLISION', null))).toEqual([
      'keep-branch-value',
      'rename-branch-id',
    ])
    expect(applicableResolutionActions(conflict())).toEqual([
      'keep-branch-value',
      'accept-current-staging',
      'manual-edit',
      'remove-local-override',
    ])
  })
})

/* ------------------------------------------------------------------ *
 * §28.1 — resolution creates a new overlay transaction
 * ------------------------------------------------------------------ */

describe('§28.1 resolution transaction', () => {
  it('emits one transaction naming the conflict, the action and the actor', () => {
    const result = resolveConflict(req({action: 'accept-current-staging'}))

    expect(result.transaction).toEqual({
      transactionId: 'txn-resolve-1',
      type: 'conflict-resolution',
      documentId: 'article-1',
      conflictId: 'article-1:SAME_PATH_CHANGED:$.title',
      action: 'accept-current-staging',
      resolution: 'accept-base',
      at: NOW,
      actor: ACTOR,
    })
  })

  it('is pure — the same request twice yields an identical result', () => {
    const input = req({action: 'manual-edit', value: 'Resolved title'})
    expect(resolveConflict(input)).toEqual(resolveConflict(input))
  })

  it('never mutates the caller-supplied document or conflict', () => {
    const local = clone(LOCAL) as SanityDocument
    const original = conflict()
    resolveConflict(req({action: 'manual-edit', value: 'Resolved title', localMaterialized: local}))
    expect(local.title).toBe('Branch title')
    expect(original.resolution).toBeUndefined()
  })

  it('drops the resolved conflict from the surviving conflict summary', () => {
    const result = resolveConflict(req({action: 'keep-branch-value'}))
    expect(summarizeConflicts([result.conflict])).toEqual({total: 1, hard: 0, soft: 1})
    expect(result.resolved).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * §28.6 — soft-conflict acknowledgement
 * ------------------------------------------------------------------ */

describe('§28.6 conflict acknowledgement', () => {
  const input = {
    conflict: conflict(),
    actor: ACTOR,
    now: NOW,
    reason: 'Reviewed with the content team',
    baseRevision: 'base-rev-2',
    localRevision: 'overlay.4.0123456789ab',
  }

  it('records actor, time, reason, base revision and local revision', () => {
    const result = acknowledgeConflict(input)

    expect(result.ok).toBe(true)
    expect(result.ok && result.acknowledgement).toEqual({
      conflictId: 'article-1:SAME_PATH_CHANGED:$.title',
      actor: ACTOR,
      acknowledgedAt: NOW,
      reason: 'Reviewed with the content team',
      baseRevision: 'base-rev-2',
      localRevision: 'overlay.4.0123456789ab',
    })
  })

  it('refuses to acknowledge a hard conflict', () => {
    const result = acknowledgeConflict({...input, conflict: conflict('PARENT_SHAPE_CHANGED')})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('hard-conflict-requires-resolution')
  })

  it('is invalidated by a new base revision or a new local revision', () => {
    const result = acknowledgeConflict(input)
    if (!result.ok) throw new Error('expected an acknowledgement')
    const acknowledgement = result.acknowledgement

    expect(
      isAcknowledgementValid(acknowledgement, {
        baseRevision: 'base-rev-2',
        localRevision: 'overlay.4.0123456789ab',
      }),
    ).toBe(true)
    expect(
      isAcknowledgementValid(acknowledgement, {
        baseRevision: 'base-rev-3',
        localRevision: 'overlay.4.0123456789ab',
      }),
    ).toBe(false)
    expect(
      isAcknowledgementValid(acknowledgement, {
        baseRevision: 'base-rev-2',
        localRevision: 'overlay.5.0123456789ab',
      }),
    ).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * resolveRecordConflict — the record-level wrapper (PRD §28.1, §28.3)
 * ------------------------------------------------------------------ *
 *
 * `resolveConflict` is pure and version-scoped; nothing applied it to an
 * OverlayDocumentRecord, so no server or CLI could resolve anything — the
 * Studio's fully-built resolution UI POSTed a `conflictResolution` commit and
 * got 400 INVALid_REQUEST (found live 2026-08-11, against the two false
 * BASE_DOCUMENT_DELETED conflicts of the same day). This wrapper is the
 * shared record mapper the API commit kind and the CLI verb both call.
 */

function conflictedRecord(
  overrides: Partial<OverlayDocumentRecord> = {},
): OverlayDocumentRecord {
  const materialized = clone(LOCAL)
  return {
    formatVersion: 1,
    overlayId: 'overlay-w3',
    logicalId: 'article-1',
    schemaType: 'article',
    origin: 'base',
    base: {
      firstTouchedAt: NOW,
      published: {
        revision: 'base-rev-1',
        snapshot: clone(ANCESTOR_ARTICLE),
        checksum: 'checksum-base',
        capturedAt: NOW,
      },
      draft: null,
      baseStatus: 'present',
    },
    local: {
      draft: {
        materialized,
        touchedPaths: [['title']],
        operations: [{type: 'set', path: ['title'], value: 'Branch title'}],
        ancestorKind: 'base-published',
        ancestorRevision: 'base-rev-1',
        overlayRevision: '7',
        createdAt: NOW,
        updatedAt: NOW,
      },
      published: null,
      draftTombstone: false,
      publishedTombstone: false,
    },
    conflicts: [conflict('BASE_DOCUMENT_DELETED', null)],
    runtimeRevision: 'overlay.7.abcdef012345',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

const LATER = '2026-08-11T21:00:00.000Z'

describe('resolveRecordConflict — record-level resolution', () => {
  it('keep-as-branch-created drops the base ancestry and keeps the content', () => {
    const record = conflictedRecord()
    const result = resolveRecordConflict({
      record,
      conflictId: record.conflicts[0]!.id,
      action: 'keep-as-branch-created',
      now: LATER,
      transactionId: 'txn-r1',
      actor: ACTOR,
      currentBase: null,
    })

    expect(result.record.origin).toBe('branch')
    /* The whole point of the action: no ancestor remains to conflict with. */
    expect(result.record.base).toBeNull()
    expect(result.record.local.draft?.ancestorKind).toBe('branch-created')
    expect(result.record.local.draft?.materialized.title).toBe('Branch title')
    expect(result.record.local.draftTombstone).toBe(false)
    expect(result.record.updatedAt).toBe(LATER)

    const resolved = result.record.conflicts.find((c) => c.id === record.conflicts[0]!.id)
    expect(resolved?.resolution?.type).toBe('keep-local')
    expect(resolved?.resolution?.resolvedAt).toBe(LATER)
    expect(result.transaction.type).toBe('conflict-resolution')
    expect(result.transaction.action).toBe('keep-as-branch-created')
  })

  it('accept-base-deletion tombstones both perspectives', () => {
    const record = conflictedRecord()
    const result = resolveRecordConflict({
      record,
      conflictId: record.conflicts[0]!.id,
      action: 'accept-base-deletion',
      now: LATER,
      transactionId: 'txn-r2',
      actor: ACTOR,
      currentBase: null,
    })

    expect(result.record.local.draft).toBeNull()
    expect(result.record.local.draftTombstone).toBe(true)
    expect(result.record.local.publishedTombstone).toBe(true)
    expect(
      result.record.conflicts.find((c) => c.id === record.conflicts[0]!.id)?.resolution?.type,
    ).toBe('delete-local')
  })

  it('a path action rewrites the draft through the same version semantics', () => {
    const record = conflictedRecord({conflicts: [conflict('SAME_PATH_CHANGED', ['title'])]})
    const result = resolveRecordConflict({
      record,
      conflictId: record.conflicts[0]!.id,
      action: 'accept-current-staging',
      now: LATER,
      transactionId: 'txn-r3',
      actor: ACTOR,
      currentBase: BASE,
    })

    expect(result.record.local.draft?.materialized.title).toBe('Upstream title')
    expect(result.record.local.draft?.touchedPaths).toEqual([])
    expect(result.record.conflicts[0]?.resolution?.type).toBe('accept-base')
  })

  it('refuses an unknown conflict id', () => {
    const record = conflictedRecord()
    expect(() =>
      resolveRecordConflict({
        record,
        conflictId: 'no-such-conflict',
        action: 'keep-as-branch-created',
        now: LATER,
        transactionId: 'txn-r4',
        actor: ACTOR,
        currentBase: null,
      }),
    ).toThrow(/no-such-conflict/)
  })

  it('refuses to resolve an already-resolved conflict a second time', () => {
    const record = conflictedRecord()
    const first = resolveRecordConflict({
      record,
      conflictId: record.conflicts[0]!.id,
      action: 'keep-as-branch-created',
      now: LATER,
      transactionId: 'txn-r5',
      actor: ACTOR,
      currentBase: null,
    })
    expect(() =>
      resolveRecordConflict({
        record: first.record,
        conflictId: record.conflicts[0]!.id,
        action: 'accept-base-deletion',
        now: LATER,
        transactionId: 'txn-r6',
        actor: ACTOR,
        currentBase: null,
      }),
    ).toThrow(/already resolved/i)
  })

  it('refuses an action the conflict type does not offer', () => {
    const record = conflictedRecord()
    expect(() =>
      resolveRecordConflict({
        record,
        conflictId: record.conflicts[0]!.id,
        action: 'remove-local-override',
        now: LATER,
        transactionId: 'txn-r7',
        actor: ACTOR,
        currentBase: null,
      }),
    ).toThrow(/not applicable|does not offer/i)
  })

  it('refuses rename-branch-id at the record level, by name', () => {
    /* Renaming moves the manifest head to a new logical id — store surgery this
     * record-scoped wrapper must not pretend to do. Refused loudly until a
     * store-level rename exists. */
    const record = conflictedRecord({conflicts: [conflict('LOCAL_ID_COLLISION', null)]})
    expect(() =>
      resolveRecordConflict({
        record,
        conflictId: record.conflicts[0]!.id,
        action: 'rename-branch-id',
        now: LATER,
        transactionId: 'txn-r8',
        actor: ACTOR,
        currentBase: null,
        newId: 'article-1-branch',
      }),
    ).toThrow(/rename/i)
  })
})
