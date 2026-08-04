/**
 * Rebase (PRD §28.5 automatic rebase, §28.4 rebase modes), workstream W3.
 *
 * A rebase is the only thing that replaces the §13.3 `base` block — the merge
 * ancestor — and it does so in one transaction, never touching `firstTouchedAt`
 * (PRD §13.3 v1.1, plan resolution O6). Everything here is pure: the caller
 * supplies `now`, the `transactionId` and the actor; nothing is generated.
 *
 * ## Reading of precondition 1
 *
 * §28.5 allows an automatic rebase only when "base changed only on untouched
 * paths", and §28.5 step 3 then removes "obsolete touched paths whose local value
 * now equals base". Those two only co-exist under one reading: a base change on a
 * touched path where the branch *already holds the new base value* is not a
 * divergence, so it does not violate precondition 1. Under the literal reading
 * step 3 is unreachable — a path whose local value equals base without base having
 * changed it also equals the ancestor, which §17.3 step 5 already collapses inside
 * the merge. So a converged path satisfies precondition 1, and step 3 is what
 * cleans it up.
 */
import {checksum} from '../checksum'
import {encodeOverlayPath} from '../encoding'
import type {OverlayActor} from '../types/actor'
import type {SanityDocument} from '../types/document'
import type {OverlayOperation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import type {
  OverlayBaseStatus,
  OverlayDocumentOrigin,
  OverlayRecordBaseBlock,
} from '../types/record'
import {deepClone, getAtPath, isPathPrefix, removeAtPath, setAtPath} from '../mutations/paths'
import {itemKey, valueEquals} from './context'
import {changedPaths} from './invariants'
import {mergeDocument} from './merge'
import type {MergeRequest, MergeResult} from './types'
import type {MergeValidationIssue, MergeValidator} from './validation'

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** The four §28.5 preconditions, in the order the PRD lists them. */
export const AUTO_REBASE_PRECONDITIONS = [
  'base-changed-only-on-untouched-paths',
  'array-additions-have-distinct-keys',
  'local-operations-apply-without-changing-meaning',
  'no-base-deletion-or-parent-shape-change',
] as const

export type AutoRebasePreconditionId = (typeof AUTO_REBASE_PRECONDITIONS)[number]

export interface AutoRebasePrecondition {
  id: AutoRebasePreconditionId
  satisfied: boolean
  /** Why it failed. Absent when satisfied. */
  detail?: string
  /** Paths that caused the failure, for the conflict panel (§28.2). */
  paths?: OverlayPath[]
}

export interface AutoRebaseRequest {
  documentId: string
  /** Injected clock (§13.11 `detectedAt`, audit timestamps). */
  now: string
  /** Injected transaction ID — core generates none (§13.10, plan §6). */
  transactionId: string
  actor?: OverlayActor
  /** Base snapshot captured at first touch (§17.1). */
  ancestor: SanityDocument | null
  ancestorRevision?: string
  currentBase: SanityDocument | null
  currentBaseRevision?: string
  localMaterialized: SanityDocument | null
  localTouchedPaths: readonly OverlayPath[]
  unsetPaths?: readonly OverlayPath[]
  localTombstone?: boolean
  origin?: OverlayDocumentOrigin
  baseStatus?: OverlayBaseStatus
  /** Recorded §13.7 operations, consulted by precondition 3. */
  operations?: readonly OverlayOperation[]
  /** §13.3 base block. `firstTouchedAt` is carried through untouched. */
  baseBlock?: OverlayRecordBaseBlock | null
  /** §17.3 step 9 validation port, re-run by §28.5 step 5. */
  validate?: MergeValidator
}

/** The audit transaction §28.5 step 4 and §28.1 require. */
export interface RebaseAuditTransaction {
  transactionId: string
  type:
    | 'auto-rebase'
    | 'rebase-accept-base'
    | 'rebase-keep-local'
    | 'rebase-full-reset'
    | 'rebase-freeze'
  documentId: string
  at: string
  actor?: OverlayActor
  ancestorRevisionBefore: string | null
  ancestorRevisionAfter: string | null
  removedTouchedPaths: OverlayPath[]
}

export interface AutoRebaseResult {
  applied: boolean
  preconditions: AutoRebasePrecondition[]
  blockedBy: AutoRebasePreconditionId[]
  /** Step 1 — the new merge ancestor (unchanged when the rebase is blocked). */
  ancestor: SanityDocument | null
  ancestorRevision: string | null
  /** Step 1 — the §13.3 base block, with `firstTouchedAt` preserved. */
  baseBlock: OverlayRecordBaseBlock | null
  /** Step 2 — local materialized values, preserved verbatim. */
  localMaterialized: SanityDocument | null
  /** Step 3 — the surviving touched paths. */
  touchedPaths: OverlayPath[]
  removedTouchedPaths: OverlayPath[]
  /** Step 4 — `null` when the rebase was blocked and nothing changed. */
  audit: RebaseAuditTransaction | null
  /** Step 5 — the revalidated resolution. */
  merge: MergeResult
  validation: readonly MergeValidationIssue[]
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function read(document: unknown, path: OverlayPath): unknown {
  if (path.length === 0) return document
  return getAtPath(document, path).value
}

function exists(document: unknown, path: OverlayPath): boolean {
  if (path.length === 0) return document !== undefined && document !== null
  return getAtPath(document, path).exists
}

function isSystemPath(path: OverlayPath): boolean {
  return path.some((segment) => typeof segment === 'string' && segment.startsWith('_'))
}

function overlaps(a: OverlayPath, b: OverlayPath): boolean {
  return isPathPrefix(a, b) || isPathPrefix(b, a)
}

function clonePaths(paths: readonly OverlayPath[]): OverlayPath[] {
  return paths.map((path) => deepClone(path) as OverlayPath)
}

function encodedSet(paths: readonly OverlayPath[]): Set<string> {
  return new Set(paths.map(encodeOverlayPath))
}

function mergeFor(request: AutoRebaseRequest, overrides: Partial<MergeRequest> = {}): MergeResult {
  return mergeDocument({
    documentId: request.documentId,
    now: request.now,
    ancestor: request.ancestor,
    currentBase: request.currentBase,
    localMaterialized: request.localMaterialized,
    localTouchedPaths: request.localTouchedPaths,
    localTombstone: request.localTombstone ?? false,
    ...(request.unsetPaths === undefined ? {} : {unsetPaths: request.unsetPaths}),
    ...(request.origin === undefined ? {} : {origin: request.origin}),
    ...(request.baseStatus === undefined ? {} : {baseStatus: request.baseStatus}),
    ...(request.validate === undefined ? {} : {validate: request.validate}),
    ...overrides,
  })
}

/* ------------------------------------------------------------------ *
 * The four preconditions (§28.5)
 * ------------------------------------------------------------------ */

/** Precondition 1 — base changed only on untouched (or already converged) paths. */
function checkBaseChangeScope(request: AutoRebaseRequest): AutoRebasePrecondition {
  const id = 'base-changed-only-on-untouched-paths'
  const base = request.currentBase
  if (base === null) {
    return {id, satisfied: false, detail: 'There is no current base to rebase onto'}
  }

  const touched = [...request.localTouchedPaths, ...(request.unsetPaths ?? [])]
  const offending = changedPaths(request.ancestor, base).filter(
    (path) =>
      path.length > 0 &&
      !isSystemPath(path) &&
      touched.some((entry) => overlaps(entry, path)) &&
      // A path the branch has already converged onto the new base value is not a
      // divergence — see the module note on precondition 1.
      !valueEquals(read(request.localMaterialized, path), read(base, path)),
  )

  if (offending.length === 0) return {id, satisfied: true}
  return {
    id,
    satisfied: false,
    detail: 'Current base changed a path the branch touched',
    paths: offending,
  }
}

/** Precondition 2 — array additions on both sides carry distinct `_key` values. */
function checkArrayKeys(request: AutoRebaseRequest, preview: MergeResult): AutoRebasePrecondition {
  const id = 'array-additions-have-distinct-keys'
  const collisions = preview.conflicts.filter((conflict) => conflict.type === 'ARRAY_KEY_COLLISION')
  if (collisions.length === 0) return {id, satisfied: true}
  return {
    id,
    satisfied: false,
    detail: 'Concurrent array insertions introduced the same `_key`',
    paths: collisions.flatMap((conflict) => (conflict.path === undefined ? [] : [conflict.path])),
  }
}

/**
 * Precondition 3 — every recorded local operation still means the same thing
 * against the current base.
 *
 * The rules are the PRD's own: §17.8 (`inc`/`dec` conflict when the base number
 * moved after the ancestor), §17.9 (a `diffMatchPatch` is never replayed against
 * later base text), §17.7 (an `insert` needs its `_key` anchor to still exist) and
 * §13.7 (`setIfMissing` is a no-op once the value is present).
 */
function checkOperationMeaning(request: AutoRebaseRequest): AutoRebasePrecondition {
  const id = 'local-operations-apply-without-changing-meaning'
  const base = request.currentBase
  const ancestor = request.ancestor
  const offending: OverlayPath[] = []
  const reasons: string[] = []

  for (const operation of request.operations ?? []) {
    if (operation.type === 'replaceDocument') continue
    const path = operation.path
    const baseValue = read(base, path)
    const ancestorValue = read(ancestor, path)

    if (operation.type === 'inc' || operation.type === 'dec') {
      if (!valueEquals(baseValue, ancestorValue)) {
        offending.push(path)
        reasons.push(`${operation.type} at ${encodeOverlayPath(path)} targets a moved base number`)
      }
      continue
    }

    if (operation.type === 'diffMatchPatch') {
      if (!valueEquals(baseValue, ancestorValue)) {
        offending.push(path)
        reasons.push(`diffMatchPatch at ${encodeOverlayPath(path)} would replay against new text`)
      }
      continue
    }

    if (operation.type === 'setIfMissing') {
      if (exists(base, path) !== exists(ancestor, path)) {
        offending.push(path)
        reasons.push(`setIfMissing at ${encodeOverlayPath(path)} no longer applies`)
      }
      continue
    }

    if (operation.type === 'insert') {
      const anchor = path[path.length - 1]
      const parent = path.slice(0, -1)
      const parentValue = read(base, parent)
      if (anchor !== undefined && typeof anchor === 'object') {
        const present =
          Array.isArray(parentValue) && parentValue.some((item) => itemKey(item) === anchor._key)
        if (!present) {
          offending.push(path)
          reasons.push(`insert anchor ${encodeOverlayPath(path)} no longer exists in base`)
        }
        continue
      }
      // A numeric or absent anchor means a non-keyed array (§17.7): any upstream
      // change to the array shifts the position and changes the meaning.
      if (!valueEquals(parentValue, read(ancestor, parent))) {
        offending.push(path)
        reasons.push(`insert at ${encodeOverlayPath(path)} targets a shifted non-keyed array`)
      }
    }
  }

  if (offending.length === 0) return {id, satisfied: true}
  return {id, satisfied: false, detail: reasons.join('; '), paths: offending}
}

/** Precondition 4 — no base deletion and no parent shape change. */
function checkStructure(request: AutoRebaseRequest, preview: MergeResult): AutoRebasePrecondition {
  const id = 'no-base-deletion-or-parent-shape-change'
  const baseDeleted =
    request.currentBase === null &&
    (request.baseStatus === 'deleted' || request.ancestor !== null)
  if (baseDeleted) return {id, satisfied: false, detail: 'The base document was deleted'}

  const structural = preview.conflicts.filter(
    (conflict) =>
      conflict.type === 'PARENT_SHAPE_CHANGED' ||
      conflict.type === 'BASE_TYPE_CHANGED' ||
      conflict.type === 'ARRAY_ITEM_DELETED',
  )
  if (structural.length === 0) return {id, satisfied: true}
  return {
    id,
    satisfied: false,
    detail: `Structural conflict: ${structural.map((conflict) => conflict.type).join(', ')}`,
    paths: structural.flatMap((conflict) => (conflict.path === undefined ? [] : [conflict.path])),
  }
}

/* ------------------------------------------------------------------ *
 * autoRebase (§28.5)
 * ------------------------------------------------------------------ */

/**
 * Step 3 — drop touched paths whose local value now equals the current base.
 *
 * An explicit unset is never dropped: §34.11 requires it to keep suppressing
 * *later* base values, and "base has no value here right now" is not the explicit
 * removal §17.5 asks for.
 */
function obsoleteTouchedPaths(request: AutoRebaseRequest): OverlayPath[] {
  const held = encodedSet(request.unsetPaths ?? [])
  return request.localTouchedPaths.filter(
    (path) =>
      path.length > 0 &&
      !held.has(encodeOverlayPath(path)) &&
      valueEquals(read(request.localMaterialized, path), read(request.currentBase, path)),
  )
}

function rebasedBaseBlock(
  request: AutoRebaseRequest,
  ancestor: SanityDocument,
  revision: string,
): OverlayRecordBaseBlock | null {
  const block = request.baseBlock
  if (block === null || block === undefined) return null
  return {
    ...block,
    // §13.3 v1.1: `firstTouchedAt` is never modified.
    firstTouchedAt: block.firstTouchedAt,
    published: {
      revision,
      snapshot: deepClone(ancestor),
      checksum: checksum(ancestor),
      capturedAt: request.now,
    },
    baseStatus: 'present',
  }
}

/** PRD §28.5 — automatic rebase for safe changes. */
export function autoRebase(request: AutoRebaseRequest): AutoRebaseResult {
  // The preview merge is also the §28.4 "preview rebase": recompute against the
  // current base without changing local intent.
  const preview = mergeFor(request)

  const preconditions: AutoRebasePrecondition[] = [
    checkBaseChangeScope(request),
    checkArrayKeys(request, preview),
    checkOperationMeaning(request),
    checkStructure(request, preview),
  ]
  const blockedBy = preconditions
    .filter((entry) => !entry.satisfied)
    .map((entry) => entry.id)

  if (blockedBy.length > 0 || request.currentBase === null) {
    return {
      applied: false,
      preconditions,
      blockedBy,
      ancestor: request.ancestor,
      ancestorRevision: request.ancestorRevision ?? null,
      baseBlock: request.baseBlock ?? null,
      localMaterialized: request.localMaterialized,
      touchedPaths: clonePaths(request.localTouchedPaths),
      removedTouchedPaths: [],
      audit: null,
      merge: preview,
      validation: preview.validation,
    }
  }

  /* Step 1 — update ancestor snapshot and revision. */
  const ancestor = deepClone(request.currentBase)
  const ancestorRevision =
    request.currentBaseRevision ??
    (typeof request.currentBase._rev === 'string' ? request.currentBase._rev : null)

  /* Step 3 — remove obsolete touched paths. */
  const removed = obsoleteTouchedPaths(request)
  const dropped = encodedSet(removed)
  const touchedPaths = clonePaths(
    request.localTouchedPaths.filter((path) => !dropped.has(encodeOverlayPath(path))),
  )

  /* Step 5 — revalidate the resolved document against the new ancestor. */
  const merge = mergeFor(request, {
    ancestor,
    localTouchedPaths: touchedPaths,
    validationAction: 'rebase',
  })

  /* Step 4 — record an audit transaction. */
  const audit: RebaseAuditTransaction = {
    transactionId: request.transactionId,
    type: 'auto-rebase',
    documentId: request.documentId,
    at: request.now,
    ...(request.actor === undefined ? {} : {actor: request.actor}),
    ancestorRevisionBefore: request.ancestorRevision ?? null,
    ancestorRevisionAfter: ancestorRevision,
    removedTouchedPaths: clonePaths(removed),
  }

  return {
    applied: true,
    preconditions,
    blockedBy: [],
    ancestor,
    ancestorRevision,
    baseBlock:
      ancestorRevision === null ? (request.baseBlock ?? null) : rebasedBaseBlock(request, ancestor, ancestorRevision),
    /* Step 2 — local materialized values are preserved verbatim. */
    localMaterialized: request.localMaterialized,
    touchedPaths,
    removedTouchedPaths: clonePaths(removed),
    audit,
    merge,
    validation: merge.validation,
  }
}

/* ------------------------------------------------------------------ *
 * §28.4 rebase modes
 * ------------------------------------------------------------------ */

export const REBASE_MODES = [
  'preview',
  'accept-base',
  'keep-local',
  'full-reset',
  'freeze',
] as const

export type RebaseMode = (typeof REBASE_MODES)[number]

export interface RebaseModeRequest extends AutoRebaseRequest {
  mode: RebaseMode
  /**
   * Operator selection. `accept-base` drops the selected touched paths;
   * `keep-local` retains them and drops the rest. Omitted means "all".
   */
  paths?: readonly OverlayPath[]
}

export interface RebaseModeResult {
  mode: RebaseMode
  ancestor: SanityDocument | null
  ancestorRevision: string | null
  baseBlock: OverlayRecordBaseBlock | null
  localMaterialized: SanityDocument | null
  touchedPaths: OverlayPath[]
  unsetPaths: OverlayPath[]
  removedTouchedPaths: OverlayPath[]
  origin: OverlayDocumentOrigin
  localTombstone: boolean
  merge: MergeResult
  audit: RebaseAuditTransaction | null
}

/** Copy the current base value into the local document at `path`. */
function adoptBaseValue(
  document: SanityDocument | null,
  base: SanityDocument | null,
  path: OverlayPath,
): SanityDocument | null {
  if (document === null || path.length === 0) return document
  const lookup = getAtPath(base, path)
  const next = lookup.exists
    ? setAtPath(document, path, deepClone(lookup.value))
    : removeAtPath(document, path)
  return next as SanityDocument
}

/** Every top-level user field of a document (§17.10 "mark all user fields touched"). */
function userFieldPaths(document: SanityDocument | null): OverlayPath[] {
  if (document === null) return []
  return Object.keys(document)
    .filter((key) => !key.startsWith('_'))
    .sort()
    .map((key) => [key] as OverlayPath)
}

function auditFor(
  request: RebaseModeRequest,
  type: RebaseAuditTransaction['type'],
  ancestorRevisionAfter: string | null,
  removed: readonly OverlayPath[],
): RebaseAuditTransaction {
  return {
    transactionId: request.transactionId,
    type,
    documentId: request.documentId,
    at: request.now,
    ...(request.actor === undefined ? {} : {actor: request.actor}),
    ancestorRevisionBefore: request.ancestorRevision ?? null,
    ancestorRevisionAfter,
    removedTouchedPaths: clonePaths(removed),
  }
}

/**
 * PRD §28.4 rebase modes, as pure functions.
 *
 * | Mode | Behavior |
 * |---|---|
 * | `preview` | Recompute against current base without changing local intent |
 * | `accept-base` | Drop selected local touched paths and inherit current base |
 * | `keep-local` | Accept current base as new ancestor while retaining selected values |
 * | `full-reset` | Remove local state and return to live base |
 * | `freeze` | Capture the current resolved document as a full branch-owned replacement |
 */
export function applyRebaseMode(request: RebaseModeRequest): RebaseModeResult {
  const baseRevision =
    request.currentBaseRevision ??
    (typeof request.currentBase?._rev === 'string' ? request.currentBase._rev : null)
  const unsetPaths = clonePaths(request.unsetPaths ?? [])
  const selection = request.paths === undefined ? null : encodedSet(request.paths)

  if (request.mode === 'preview') {
    return {
      mode: 'preview',
      ancestor: request.ancestor,
      ancestorRevision: request.ancestorRevision ?? null,
      baseBlock: request.baseBlock ?? null,
      localMaterialized: request.localMaterialized,
      touchedPaths: clonePaths(request.localTouchedPaths),
      unsetPaths,
      removedTouchedPaths: [],
      origin: request.origin ?? 'base',
      localTombstone: request.localTombstone ?? false,
      merge: mergeFor(request, {validationAction: 'rebase-preview'}),
      // Local intent is unchanged, so no transaction is created (§28.1).
      audit: null,
    }
  }

  if (request.mode === 'full-reset') {
    const merge = mergeFor(request, {
      ancestor: null,
      localMaterialized: null,
      localTouchedPaths: [],
      unsetPaths: [],
      localTombstone: false,
      validationAction: 'rebase-full-reset',
    })
    return {
      mode: 'full-reset',
      ancestor: null,
      ancestorRevision: null,
      baseBlock: null,
      localMaterialized: null,
      touchedPaths: [],
      unsetPaths: [],
      removedTouchedPaths: clonePaths(request.localTouchedPaths),
      origin: request.origin ?? 'base',
      localTombstone: false,
      merge,
      audit: auditFor(request, 'rebase-full-reset', null, request.localTouchedPaths),
    }
  }

  if (request.mode === 'freeze') {
    const preview = mergeFor(request, {validationAction: 'rebase-freeze'})
    const frozen = preview.document
    const touchedPaths = userFieldPaths(frozen)
    const ancestor = request.currentBase === null ? null : deepClone(request.currentBase)
    const merge = mergeFor(request, {
      ancestor,
      localMaterialized: frozen,
      localTouchedPaths: touchedPaths,
      unsetPaths: [],
      origin: 'branch',
      validationAction: 'rebase-freeze',
    })
    return {
      mode: 'freeze',
      ancestor,
      ancestorRevision: baseRevision,
      baseBlock:
        ancestor === null || baseRevision === null
          ? (request.baseBlock ?? null)
          : rebasedBaseBlock(request, ancestor, baseRevision),
      localMaterialized: frozen,
      touchedPaths,
      unsetPaths: [],
      removedTouchedPaths: [],
      origin: 'branch',
      localTombstone: request.localTombstone ?? false,
      merge,
      audit: auditFor(request, 'rebase-freeze', baseRevision, []),
    }
  }

  // `accept-base` and `keep-local` both drop a set of touched paths; they differ
  // in which set, and in whether the ancestor advances.
  const acceptBase = request.mode === 'accept-base'
  const removed = request.localTouchedPaths.filter((path) => {
    if (selection === null) return acceptBase
    const selected = selection.has(encodeOverlayPath(path))
    return acceptBase ? selected : !selected
  })
  const dropped = encodedSet(removed)
  const touchedPaths = clonePaths(
    request.localTouchedPaths.filter((path) => !dropped.has(encodeOverlayPath(path))),
  )
  const survivingUnsets = unsetPaths.filter((path) => !dropped.has(encodeOverlayPath(path)))

  let localMaterialized = request.localMaterialized
  for (const path of removed) {
    localMaterialized = adoptBaseValue(localMaterialized, request.currentBase, path)
  }

  const ancestor = acceptBase
    ? request.ancestor
    : request.currentBase === null
      ? null
      : deepClone(request.currentBase)
  const ancestorRevision = acceptBase ? (request.ancestorRevision ?? null) : baseRevision

  const merge = mergeFor(request, {
    ancestor,
    localMaterialized,
    localTouchedPaths: touchedPaths,
    unsetPaths: survivingUnsets,
    validationAction: acceptBase ? 'rebase-accept-base' : 'rebase-keep-local',
  })

  return {
    mode: request.mode,
    ancestor,
    ancestorRevision,
    baseBlock:
      acceptBase || ancestor === null || ancestorRevision === null
        ? (request.baseBlock ?? null)
        : rebasedBaseBlock(request, ancestor, ancestorRevision),
    localMaterialized,
    touchedPaths,
    unsetPaths: survivingUnsets,
    removedTouchedPaths: clonePaths(removed),
    origin: request.origin ?? 'base',
    localTombstone: request.localTombstone ?? false,
    merge,
    audit: auditFor(
      request,
      acceptBase ? 'rebase-accept-base' : 'rebase-keep-local',
      ancestorRevision,
      removed,
    ),
  }
}
