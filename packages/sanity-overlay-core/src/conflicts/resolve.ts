/**
 * Manual conflict resolution (PRD §28.3 actions, §13.11 `resolution`, §28.1
 * "resolution creates a new overlay transaction") and §28.6 soft-conflict
 * acknowledgement, workstream W3.
 *
 * Every function here is pure and total: the actor, the clock and the transaction
 * ID are injected, nothing is generated, and no input is mutated. The result is
 * the *next* local state — the store applies it, core only computes it.
 *
 * §28.3 lists eight panel actions. Seven change state and are modelled here; the
 * eighth, "Open incoming references", is navigation and has no domain effect.
 */
import {OverlayError} from '../errors'
import type {OverlayActor} from '../types/actor'
import type {
  OverlayConflict,
  OverlayConflictResolutionType,
  OverlayConflictType,
} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'
import type {OverlayDocumentOrigin} from '../types/record'
import {encodeOverlayPath} from '../encoding'
import {deepClone, getAtPath, removeAtPath, setAtPath} from '../mutations/paths'

/* ------------------------------------------------------------------ *
 * The §28.3 action set
 * ------------------------------------------------------------------ */

/** The seven state-changing actions of the §28.3 document conflict panel. */
export const CONFLICT_RESOLUTION_ACTIONS = [
  'keep-branch-value',
  'accept-current-staging',
  'manual-edit',
  'remove-local-override',
  'keep-as-branch-created',
  'accept-base-deletion',
  'rename-branch-id',
] as const

export type ConflictResolutionAction = (typeof CONFLICT_RESOLUTION_ACTIONS)[number]

/**
 * §28.3 action → §13.11 `resolution.type`.
 *
 * Two actions share `accept-base` because §13.11 has five resolution types and
 * §28.3 has seven actions: "accept current staging value" and "remove local
 * override and resume inheritance" both end local ownership of the path. They
 * differ in what stays in the materialized document — see {@link resolveConflict}.
 */
export const CONFLICT_RESOLUTION_ACTION_TYPES: Readonly<
  Record<ConflictResolutionAction, OverlayConflictResolutionType>
> = Object.freeze({
  'keep-branch-value': 'keep-local',
  'accept-current-staging': 'accept-base',
  'manual-edit': 'manual',
  'remove-local-override': 'accept-base',
  'keep-as-branch-created': 'keep-local',
  'accept-base-deletion': 'delete-local',
  'rename-branch-id': 'rename',
})

const PATH_ACTIONS: readonly ConflictResolutionAction[] = [
  'keep-branch-value',
  'accept-current-staging',
  'manual-edit',
  'remove-local-override',
]

const DELETION_ACTIONS: readonly ConflictResolutionAction[] = [
  'keep-as-branch-created',
  'accept-base-deletion',
]

const COLLISION_ACTIONS: readonly ConflictResolutionAction[] = [
  'keep-branch-value',
  'rename-branch-id',
]

const DELETION_CONFLICTS: readonly OverlayConflictType[] = [
  'BASE_DOCUMENT_DELETED',
  'ARRAY_ITEM_DELETED',
  'REFERENCE_TARGET_DELETED',
]

/** Which §28.3 actions the panel should offer for a conflict. */
export function applicableResolutionActions(
  conflict: OverlayConflict,
): ConflictResolutionAction[] {
  if (conflict.type === 'LOCAL_ID_COLLISION') return [...COLLISION_ACTIONS]
  if (conflict.type === 'BASE_DOCUMENT_DELETED') return [...DELETION_ACTIONS]
  if (conflict.path === undefined) {
    return DELETION_CONFLICTS.includes(conflict.type)
      ? [...DELETION_ACTIONS]
      : ['keep-branch-value']
  }
  return [...PATH_ACTIONS]
}

/* ------------------------------------------------------------------ *
 * resolveConflict
 * ------------------------------------------------------------------ */

/** The overlay transaction §28.1 requires for every resolution. */
export interface ConflictResolutionTransaction {
  transactionId: string
  type: 'conflict-resolution'
  documentId: string
  conflictId: string
  action: ConflictResolutionAction
  resolution: OverlayConflictResolutionType
  at: string
  actor: OverlayActor
}

export interface ResolveConflictRequest {
  /** Logical ID of the document holding the conflict. */
  documentId: string
  /** Injected clock — `resolution.resolvedAt` and the transaction timestamp. */
  now: string
  /** Injected transaction ID; core generates none (§13.10). */
  transactionId: string
  actor: OverlayActor
  conflict: OverlayConflict
  action: ConflictResolutionAction
  currentBase: SanityDocument | null
  localMaterialized: SanityDocument | null
  touchedPaths: readonly OverlayPath[]
  unsetPaths?: readonly OverlayPath[]
  origin?: OverlayDocumentOrigin
  localTombstone?: boolean
  /** The operator's value, for `manual-edit`. `undefined` removes the field. */
  value?: unknown
  /** The new logical ID, for `rename-branch-id`. */
  newId?: string
}

export interface ConflictResolutionResult {
  /** The conflict with its §13.11 `resolution` block stamped. */
  conflict: OverlayConflict
  resolved: true
  documentId: string
  localMaterialized: SanityDocument | null
  touchedPaths: OverlayPath[]
  unsetPaths: OverlayPath[]
  origin: OverlayDocumentOrigin
  localTombstone: boolean
  transaction: ConflictResolutionTransaction
}

function invalid(message: string, details: Record<string, unknown>): OverlayError {
  return new OverlayError('OVERLAY_OPERATION_INVALID', message, details)
}

function withoutPath(paths: readonly OverlayPath[], path: OverlayPath): OverlayPath[] {
  const encoded = encodeOverlayPath(path)
  return paths
    .filter((entry) => encodeOverlayPath(entry) !== encoded)
    .map((entry) => deepClone(entry) as OverlayPath)
}

function hasPath(paths: readonly OverlayPath[], path: OverlayPath): boolean {
  const encoded = encodeOverlayPath(path)
  return paths.some((entry) => encodeOverlayPath(entry) === encoded)
}

/**
 * Apply one §28.3 panel action, returning the next local state.
 *
 * `accept-current-staging` writes the current base value into the materialized
 * document and ends local ownership, so the stored document shows exactly what
 * was accepted. `remove-local-override` ends ownership by *removing* the local
 * member, so the merge projects base structurally — that is the "resume
 * inheritance" half of the pair.
 */
export function resolveConflict(request: ResolveConflictRequest): ConflictResolutionResult {
  const {action, conflict} = request
  const type = CONFLICT_RESOLUTION_ACTION_TYPES[action]
  if (type === undefined) {
    throw invalid(`Unknown conflict resolution action ${JSON.stringify(action)} (PRD §28.3)`, {
      action,
    })
  }

  const path = conflict.path
  if (PATH_ACTIONS.includes(action) && action !== 'keep-branch-value' && path === undefined) {
    throw invalid(`Action ${action} needs a conflict path (PRD §28.3)`, {action, conflict: conflict.id})
  }

  let documentId = request.documentId
  let local = request.localMaterialized === null ? null : deepClone(request.localMaterialized)
  let touchedPaths = request.touchedPaths.map((entry) => deepClone(entry) as OverlayPath)
  let unsetPaths = (request.unsetPaths ?? []).map((entry) => deepClone(entry) as OverlayPath)
  let origin: OverlayDocumentOrigin = request.origin ?? 'base'
  let localTombstone = request.localTombstone ?? false

  if (action === 'accept-current-staging' && path !== undefined) {
    const lookup = getAtPath(request.currentBase, path)
    if (local !== null) {
      local = (
        lookup.exists ? setAtPath(local, path, deepClone(lookup.value)) : removeAtPath(local, path)
      ) as SanityDocument
    }
    touchedPaths = withoutPath(touchedPaths, path)
    unsetPaths = withoutPath(unsetPaths, path)
  }

  if (action === 'remove-local-override' && path !== undefined) {
    if (local !== null) local = removeAtPath(local, path) as SanityDocument
    touchedPaths = withoutPath(touchedPaths, path)
    unsetPaths = withoutPath(unsetPaths, path)
  }

  if (action === 'manual-edit' && path !== undefined) {
    if (local !== null) {
      local = (
        request.value === undefined
          ? removeAtPath(local, path)
          : setAtPath(local, path, deepClone(request.value))
      ) as SanityDocument
    }
    if (!hasPath(touchedPaths, path)) touchedPaths = [...touchedPaths, deepClone(path) as OverlayPath]
    unsetPaths = request.value === undefined ? unsetPaths : withoutPath(unsetPaths, path)
  }

  if (action === 'keep-as-branch-created') {
    origin = 'branch'
    localTombstone = false
  }

  if (action === 'accept-base-deletion') {
    local = null
    touchedPaths = []
    unsetPaths = []
    localTombstone = true
  }

  if (action === 'rename-branch-id') {
    const newId = request.newId
    if (newId === undefined || newId.length === 0) {
      throw invalid('Action rename-branch-id needs a newId (PRD §28.3, §19.6)', {
        action,
        conflict: conflict.id,
      })
    }
    documentId = newId
    origin = 'branch'
    if (local !== null) local = {...local, _id: newId}
  }

  const resolved: OverlayConflict = {
    ...deepClone(conflict),
    resolution: {type, resolvedAt: request.now, resolvedBy: request.actor},
  }

  return {
    conflict: resolved,
    resolved: true,
    documentId,
    localMaterialized: local,
    touchedPaths,
    unsetPaths,
    origin,
    localTombstone,
    transaction: {
      transactionId: request.transactionId,
      type: 'conflict-resolution',
      documentId,
      conflictId: conflict.id,
      action,
      resolution: type,
      at: request.now,
      actor: request.actor,
    },
  }
}

/* ------------------------------------------------------------------ *
 * §28.6 acknowledgement
 * ------------------------------------------------------------------ */

/** The §28.6 record: actor, time, reason, base revision, local revision. */
export interface ConflictAcknowledgement {
  conflictId: string
  actor: OverlayActor
  acknowledgedAt: string
  reason: string
  baseRevision: string
  localRevision: string
}

export interface AcknowledgeConflictRequest {
  conflict: OverlayConflict
  actor: OverlayActor
  now: string
  reason: string
  baseRevision: string
  localRevision: string
}

export type AcknowledgeConflictResult =
  | {ok: true; acknowledgement: ConflictAcknowledgement}
  | {ok: false; reason: 'hard-conflict-requires-resolution'}

/**
 * §28.6 — "A soft conflict may be marked acknowledged without choosing a new
 * value." A hard conflict blocks branch publish and promotion (§28.1), so it can
 * only be *resolved*, never acknowledged; that is a domain answer, not an
 * exception, so it comes back as a result.
 */
export function acknowledgeConflict(
  request: AcknowledgeConflictRequest,
): AcknowledgeConflictResult {
  if (request.conflict.severity === 'hard') {
    return {ok: false, reason: 'hard-conflict-requires-resolution'}
  }
  return {
    ok: true,
    acknowledgement: {
      conflictId: request.conflict.id,
      actor: request.actor,
      acknowledgedAt: request.now,
      reason: request.reason,
      baseRevision: request.baseRevision,
      localRevision: request.localRevision,
    },
  }
}

/** §28.6 — "A new base or local revision invalidates the acknowledgement." */
export function isAcknowledgementValid(
  acknowledgement: ConflictAcknowledgement,
  current: {baseRevision: string; localRevision: string},
): boolean {
  return (
    acknowledgement.baseRevision === current.baseRevision &&
    acknowledgement.localRevision === current.localRevision
  )
}
