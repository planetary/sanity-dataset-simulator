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
  summarizeConflicts,
} from '../../sanity-overlay-core/src/conflicts/index'
import type {ResolveConflictRequest} from '../../sanity-overlay-core/src/conflicts/index'
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
