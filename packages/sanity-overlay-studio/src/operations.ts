/**
 * The overlay OPERATIONS a Studio action asks the overlay API to perform —
 * rebase (PRD §28.4, §28.5), conflict resolution (§28.3) and checkpoint (§29).
 *
 * WHY THESE ARE REQUESTS AND NOT COMPUTATIONS.
 *
 * Core owns `autoRebase`, `applyRebaseMode` and `exportCheckpoint`, and every
 * one of them needs the §13.3 document record: the base block, the ancestor
 * snapshot, `touchedPaths`, `unsetPaths`, `origin`. None of that is in the
 * Studio's hydration answer — `/state` sends materialized bodies, not records —
 * and rebuilding it in a browser tab would be a second, weaker copy of the store
 * whose divergence from the real one nothing would catch.
 *
 * So the split is: **the Studio decides what to ask for and what it costs; the
 * overlay API applies it with core.** What lives here is the deciding and the
 * costing, both pure, both testable without a network:
 *
 *   - which documents an operation would touch,
 *   - what it destroys, stated BEFORE it runs,
 *   - the refusal to proceed until that is confirmed, matching
 *     `sanity-overlay rebase|reset`, which print the loss and exit
 *     `CONFIRMATION_REQUIRED` without `--confirm`,
 *   - and how to read the overlay's answer without mistaking silence for success.
 */

import {REBASE_MODES, toPublishedId, type RebaseMode} from '../../sanity-overlay-core/src/index'

import type {OverlayConflictReport} from './conflicts'
import type {ConflictResolutionCommand} from './conflictPanel'
import type {OverlayHydrationDocument} from './client/transport'

type Rec = Record<string, unknown>

/** Everything the Studio asks the overlay API to do beyond committing edits. */
export const OVERLAY_OPERATION_KINDS = ['conflictResolution', 'rebase', 'checkpoint'] as const

export type OverlayOperationKind = (typeof OVERLAY_OPERATION_KINDS)[number]

/* ------------------------------------------------------------------ *
 * The shared loss report
 * ------------------------------------------------------------------ */

/** One document an operation would overwrite, as the operator needs to see it. */
export interface OperationLossDocument {
  logicalId: string
  schemaType?: string
  lastLocalRevision?: string
  /** Conflicted documents lose the most: the resolution decision goes with them. */
  hasConflict: boolean
}

export interface OperationLoss {
  destructive: boolean
  summary: string
  documents: OperationLossDocument[]
}

function lossDocument(entry: OverlayHydrationDocument): OperationLossDocument {
  return {
    logicalId: entry.logicalId,
    ...(typeof entry.schemaType === 'string' ? {schemaType: entry.schemaType} : {}),
    ...(typeof entry.runtimeRevision === 'string'
      ? {lastLocalRevision: entry.runtimeRevision}
      : {}),
    hasConflict: Array.isArray(entry.conflicts) && entry.conflicts.length > 0,
  }
}

/* ------------------------------------------------------------------ *
 * §28.4 / §28.5 — rebase
 * ------------------------------------------------------------------ */

/** `auto` is §28.5's automatic rebase; the rest are core's §28.4 modes. */
export type StudioRebaseMode = RebaseMode | 'auto'

export const STUDIO_REBASE_MODES: readonly StudioRebaseMode[] = ['auto', ...REBASE_MODES]

export interface RebaseCommand {
  kind: 'rebase'
  mode: StudioRebaseMode
  documentIds: string[]
}

export interface RebaseRequest {
  mode: StudioRebaseMode
  /** The overlay's hydration answer — the only inventory the Studio has. */
  documents: readonly OverlayHydrationDocument[]
  /** Scope to one document. Any address; resolved to its logical ID. */
  documentId?: string
  confirmed?: boolean
}

export type RebasePlan =
  | {ok: true; command: RebaseCommand; loss: OperationLoss}
  | {ok: false; reason: string; needsConfirmation?: true; loss: OperationLoss}

/**
 * What each §28.4 mode takes away, in the operator's terms.
 *
 * `preview` is the only mode that changes nothing — §28.4 defines it as
 * "recompute against current base without changing local intent", and
 * `applyRebaseMode` returns `audit: null` for it, i.e. no transaction. Every
 * other mode replaces the merge ancestor, and an ancestor is not recoverable
 * from the overlay once replaced: a later three-way merge can no longer tell a
 * local edit from an inherited value. That is why the CLI makes `--confirm`
 * mandatory for all of them, and why this does too.
 */
const MODE_LOSS: Readonly<Record<StudioRebaseMode, {destructive: boolean; summary: string}>> =
  Object.freeze({
    preview: {
      destructive: false,
      summary:
        'A preview rebase recomputes the merge against the current base without changing local ' +
        'intent (PRD §28.4). Nothing is written and no transaction is recorded.',
    },
    auto: {
      destructive: true,
      summary:
        'An automatic rebase (PRD §28.5) replaces the merge ancestor with the current base for ' +
        'every document below and drops touched paths whose local value now equals base. The ' +
        'previous ancestor is not recoverable from the overlay, so a later merge can no longer ' +
        'tell an inherited value from a deliberate local one.',
    },
    'accept-base': {
      destructive: true,
      summary:
        'An accept-base rebase DISCARDS the local value at every selected touched path and ' +
        'inherits the current base instead (PRD §28.4). Those branch edits are gone from the ' +
        'overlay; only a checkpoint already in Git still holds them.',
    },
    'keep-local': {
      destructive: true,
      summary:
        'A keep-local rebase accepts the current base as the new merge ancestor while retaining ' +
        'the selected local values (PRD §28.4). Local values at paths outside the selection are ' +
        'dropped, and the previous ancestor is not recoverable.',
    },
    'full-reset': {
      destructive: true,
      summary:
        'A full reset REMOVES ALL local branch state for every document below and returns them ' +
        'to the live base (PRD §28.4, §29.8). Every branch edit, every conflict resolution and ' +
        'every branch-created document in scope stops existing in this overlay.',
    },
    freeze: {
      destructive: true,
      summary:
        'A freeze captures the current resolved document as a full branch-owned replacement ' +
        '(PRD §28.4). The document stops inheriting from base entirely, so later base changes ' +
        'no longer reach it, and the inheritance relationship cannot be restored.',
    },
  })

export function planRebase(request: RebaseRequest): RebasePlan {
  const {mode} = request

  const empty: OperationLoss = {destructive: false, summary: '', documents: []}

  if (!STUDIO_REBASE_MODES.includes(mode)) {
    return {
      ok: false,
      reason:
        `Unknown rebase mode ${JSON.stringify(mode)}. PRD §28.4 defines ` +
        `${REBASE_MODES.join(', ')}, and §28.5 adds "auto".`,
      loss: empty,
    }
  }

  let scoped = [...request.documents]
  if (request.documentId !== undefined) {
    const logicalId = toPublishedId(request.documentId)
    scoped = scoped.filter((entry) => entry.logicalId === logicalId)
    if (scoped.length === 0) {
      return {
        ok: false,
        reason:
          `The overlay holds no branch state for ${logicalId}, so there is nothing to rebase. ` +
          'Rebasing the whole overlay instead would touch documents the editor did not ask about.',
        loss: empty,
      }
    }
  }

  if (scoped.length === 0) {
    return {
      ok: false,
      reason: 'The overlay holds no branch documents, so a rebase would do nothing.',
      loss: empty,
    }
  }

  const shape = MODE_LOSS[mode]
  const loss: OperationLoss = {
    destructive: shape.destructive,
    summary: shape.summary,
    documents: scoped.map(lossDocument),
  }

  if (loss.destructive && request.confirmed !== true) {
    return {ok: false, reason: shape.summary, needsConfirmation: true, loss}
  }

  return {
    ok: true,
    command: {kind: 'rebase', mode, documentIds: scoped.map((entry) => entry.logicalId)},
    loss,
  }
}

/* ------------------------------------------------------------------ *
 * Reading the overlay's answer
 * ------------------------------------------------------------------ */

export interface RebaseBlockage {
  logicalId: string
  blockedBy: string[]
}

export interface RebaseOutcome {
  /** `false` when the overlay answered without a per-document report at all. */
  reported: boolean
  ok: boolean
  applied: string[]
  blocked: RebaseBlockage[]
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a rebase answer.
 *
 * SILENCE IS NOT SUCCESS. §28.5 lists four preconditions that can block an
 * automatic rebase, and `autoRebase` returns `applied: false` with a `blockedBy`
 * list rather than throwing. An overlay API that answered 200 with no report has
 * not said a rebase happened, and treating that as "done" is how an editor comes
 * to believe a branch is up to date when it is not.
 */
export function readRebaseOutcome(body: unknown): RebaseOutcome {
  const documents = isRec(body) && Array.isArray(body.documents) ? body.documents : null
  if (documents === null) {
    return {reported: false, ok: false, applied: [], blocked: []}
  }

  const applied: string[] = []
  const blocked: RebaseBlockage[] = []
  for (const entry of documents) {
    if (!isRec(entry) || typeof entry.logicalId !== 'string') continue
    const blockedBy = Array.isArray(entry.blockedBy)
      ? entry.blockedBy.filter((value): value is string => typeof value === 'string')
      : []
    if (blockedBy.length > 0 || entry.applied !== true) {
      blocked.push({logicalId: entry.logicalId, blockedBy})
      continue
    }
    applied.push(entry.logicalId)
  }

  return {reported: true, ok: blocked.length === 0, applied, blocked}
}

/* ------------------------------------------------------------------ *
 * §29 — checkpoint
 * ------------------------------------------------------------------ */

export interface CheckpointCommand {
  kind: 'checkpoint'
  note?: string
}

export interface CheckpointRequest {
  conflicts: OverlayConflictReport
  note?: string
  /** §28.1 — "Hard conflicts block … checkpoint confirmation when configured." */
  requireCleanConflicts?: boolean
}

export type CheckpointPlan =
  | {ok: true; command: CheckpointCommand}
  | {ok: false; reason: string}

export function planCheckpoint(request: CheckpointRequest): CheckpointPlan {
  if (request.requireCleanConflicts === true) {
    if (!request.conflicts.available) {
      return {
        ok: false,
        reason:
          'This overlay API does not report conflicts, so a clean-conflict checkpoint cannot be ' +
          'confirmed — an unknown conflict state is not a clean one (PRD §28.1). Check the ' +
          'overlay manifest, or take the checkpoint without requiring clean conflicts.',
      }
    }
    const hard = request.conflicts.summary.hard
    if (hard > 0) {
      return {
        ok: false,
        reason:
          `${hard} hard conflict${hard === 1 ? '' : 's'} ${hard === 1 ? 'is' : 'are'} open. PRD ` +
          '§28.1 blocks checkpoint confirmation on a hard conflict; resolve it in the conflict ' +
          'panel first.',
      }
    }
  }

  const note = typeof request.note === 'string' && request.note.trim().length > 0
    ? request.note.trim()
    : undefined

  return {ok: true, command: {kind: 'checkpoint', ...(note === undefined ? {} : {note})}}
}

/* ------------------------------------------------------------------ */

/** Every command shape `transport.operation` accepts. */
export type OverlayOperationCommand =
  | ConflictResolutionCommand
  | RebaseCommand
  | CheckpointCommand
