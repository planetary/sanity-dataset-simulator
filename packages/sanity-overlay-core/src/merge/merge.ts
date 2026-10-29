/**
 * The three-way merge (PRD §17.1-§17.7, §16.4), workstream W3.
 *
 * `mergeDocument` is a pure function: no clock, no ID source, no IO. Everything
 * time- or identity-shaped is injected (`now`, `documentId`), so the same inputs
 * always produce the same resolved document, the same conflict list and the same
 * checksum (§17.3 step 10, plan §8.5 "merge determinism").
 *
 * Precedence (§17.2), applied in order:
 *
 * 1. Applicable local tombstone.
 * 2. Branch-created document.
 * 3. Local values on touched paths.
 * 4. Current base values on untouched paths.
 * 5. Ancestor only as recovery material when current base is missing or
 *    structurally incompatible.
 *
 * Rules 3 and 4 are the recursive walk: the resolved document *starts* as the
 * current base and the touched-path trie decides where local intent overwrites
 * it. That is what makes §17.6's "preserve new upstream sibling fields" and
 * invariant §34.12 structural rather than a special case.
 */
import {checksum, parseSyntheticRev} from '../checksum'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'
import {encodeOverlayPath} from '../encoding'
import {deepClone, isPlainObject} from '../mutations/paths'
import {applySyntheticSystemFields} from '../mutations/state'
import type {MergeInput, MergeResolver} from '../mutations/ports'
import {hasDuplicateKeys, mergeKeyedArray, type NodeResult} from './arrays'
import {classifyBaseDeletion} from './base-deletion'
import {
  addConflict,
  childValue,
  createMergeContext,
  extend,
  valueEquals,
  type MergeContext,
} from './context'
import {buildTouchTree, childKind, type TouchTreeNode} from './touch-tree'
import type {MergeAbsence, MergeRequest, MergeResult} from './types'
import {hasValidationError, noopMergeValidator, type MergeValidationIssue} from './validation'

/* ------------------------------------------------------------------ *
 * Recursive node merge (§17.3 steps 4-8)
 * ------------------------------------------------------------------ */

function preserveLocal(localValue: unknown): NodeResult {
  return {present: localValue !== undefined, value: localValue}
}

/** §17.3 steps 4-6 for one fully local-owned subtree. */
function mergeOwnedValue(
  context: MergeContext,
  path: OverlayPath,
  ancestorValue: unknown,
  baseValue: unknown,
  localValue: unknown,
): NodeResult {
  // Step 4: current base equals ancestor — apply the local value, no conflict.
  if (valueEquals(baseValue, ancestorValue)) return preserveLocal(localValue)

  // Step 5: local equals ancestor — remove the local touch and use current base.
  if (valueEquals(localValue, ancestorValue)) {
    context.removed.push(deepClone(path) as OverlayPath)
    return {present: baseValue !== undefined, value: baseValue}
  }

  // Step 6: both differ from the ancestor — local wins in preview, conflict recorded.
  if (!valueEquals(localValue, baseValue)) {
    addConflict(context, {
      type: 'SAME_PATH_CHANGED',
      path,
      ancestorValue,
      baseValue,
      localValue,
    })
  }
  return preserveLocal(localValue)
}

function mergeNode(
  context: MergeContext,
  path: OverlayPath,
  ancestorValue: unknown,
  baseValue: unknown,
  localValue: unknown,
  node: TouchTreeNode,
): NodeResult {
  // §17.5: an explicit unset suppresses the path, now and after any later base
  // change, until the unset is removed (invariant §34.11).
  if (node.unset) {
    if (!valueEquals(baseValue, ancestorValue)) {
      addConflict(context, {
        type: 'SAME_PATH_CHANGED',
        path,
        ancestorValue,
        baseValue,
        localValue: undefined,
      })
    }
    return {present: false, value: undefined}
  }

  if (node.children.size === 0) {
    // §17.2 rule 4: a node the branch never recorded is not locally owned, so the
    // current base wins. Only the root can reach here unrecorded — every trie leaf
    // below it is created by recording a path — and the root is exactly the case
    // of a local materialized document with no surviving touched path.
    if (!node.self) return {present: baseValue !== undefined, value: baseValue}
    return mergeOwnedValue(context, path, ancestorValue, baseValue, localValue)
  }

  const kind = childKind(node)

  // §17.7: a numeric index segment means the array has no `_key` support, so the
  // whole array is a single local touch and no per-item merge is attempted.
  if (kind === 'index') {
    return mergeOwnedValue(context, path, ancestorValue, baseValue, localValue)
  }

  if (baseValue === undefined || baseValue === null) {
    // Base has no container here. Nothing upstream can be inherited, so the
    // local-owned children are simply projected.
    if (kind === 'keyed') return preserveLocal(localValue)
    const built: Record<string, unknown> = {}
    for (const child of node.children.values()) {
      const segment = child.segment as string
      const merged = mergeNode(
        context,
        extend(path, segment),
        childValue(ancestorValue, segment),
        undefined,
        childValue(localValue, segment),
        child.node,
      )
      if (merged.present) built[segment] = merged.value
    }
    if (Object.keys(built).length === 0) return {present: false, value: undefined}
    return {present: true, value: built}
  }

  if (kind === 'keyed') {
    if (!Array.isArray(baseValue)) {
      // §17.3 step 7 / §17.6: the parent shape no longer supports the path.
      addConflict(context, {
        type: 'PARENT_SHAPE_CHANGED',
        path,
        ancestorValue,
        baseValue,
        localValue,
      })
      return preserveLocal(localValue)
    }
    return mergeKeyedArray(context, path, ancestorValue, baseValue, localValue, node, mergeNode)
  }

  if (!isPlainObject(baseValue)) {
    addConflict(context, {
      type: 'PARENT_SHAPE_CHANGED',
      path,
      ancestorValue,
      baseValue,
      localValue,
    })
    return preserveLocal(localValue)
  }

  // §17.6: descend, so untouched upstream siblings — including fields base added
  // after the ancestor — survive untouched.
  const out: Record<string, unknown> = {...baseValue}
  for (const child of node.children.values()) {
    const segment = child.segment as string
    const merged = mergeNode(
      context,
      extend(path, segment),
      childValue(ancestorValue, segment),
      childValue(baseValue, segment),
      childValue(localValue, segment),
      child.node,
    )
    if (merged.present) out[segment] = merged.value
    else delete out[segment]
  }
  return {present: true, value: out}
}

/* ------------------------------------------------------------------ *
 * System fields and finalization (§13.9, §17.3 steps 9-10)
 * ------------------------------------------------------------------ */

/**
 * Stamp the §13.9 synthetic system fields on a resolved document in which local
 * state won.
 *
 * `_rev` is recomputed over the *resolved* document rather than copied from the
 * local materialized one: the resolved document also carries inherited upstream
 * values, so reusing the local `_rev` would name content that does not exist.
 * The overlay revision component is taken from the local `_rev`, which keeps the
 * value a pure function of the inputs.
 */
function stampSystemFields(
  document: SanityDocument,
  local: SanityDocument,
  base: SanityDocument | null,
  now: string,
): SanityDocument {
  const parsed = typeof local._rev === 'string' ? parseSyntheticRev(local._rev) : null
  const next = {...document, _type: local._type}
  const createdAt = base?._createdAt ?? local._createdAt
  return applySyntheticSystemFields({
    document: next as SanityDocument,
    documentId: local._id,
    overlayRevision: parsed?.overlayRevision ?? '0',
    now: local._updatedAt ?? now,
    ...(createdAt === undefined ? {} : {createdAt}),
  })
}

function survivingTouchedPaths(
  touchedPaths: readonly OverlayPath[],
  removed: readonly OverlayPath[],
): OverlayPath[] {
  const dropped = new Set(removed.map(encodeOverlayPath))
  return touchedPaths
    .filter((path) => !dropped.has(encodeOverlayPath(path)))
    .map((path) => deepClone(path) as OverlayPath)
}

interface FinalizeInput {
  context: MergeContext
  request: MergeRequest
  document: SanityDocument | null
  absence: MergeAbsence | null
  touchedPaths: readonly OverlayPath[]
}

function finalize(input: FinalizeInput): MergeResult {
  const {context, request} = input
  let document = input.document

  // §17.3 step 9 — schema validation on the resolved document.
  let validation: readonly MergeValidationIssue[] = []
  if (document !== null) {
    const validate = request.validate ?? noopMergeValidator
    validation = validate(document, {
      logicalId: request.documentId,
      action: request.validationAction ?? 'merge',
    })
    if (validation.length > 0) {
      addConflict(context, {
        type: 'SCHEMA_VALIDATION_ERROR',
        severity: hasValidationError(validation) ? 'hard' : 'soft',
        ...(validation[0]?.path === undefined ? {} : {path: validation[0].path}),
      })
    }
  }

  if (document !== null) document = deepClone(document)

  return {
    document,
    absence: input.absence,
    conflicts: [...context.conflicts.values()],
    // §17.3 step 10 — deterministic checksum of the resolved document.
    checksum: document === null ? null : checksum(document),
    touchedPaths: survivingTouchedPaths(input.touchedPaths, context.removed),
    removedTouchedPaths: context.removed.map((path) => deepClone(path) as OverlayPath),
    validation,
  }
}

/* ------------------------------------------------------------------ *
 * mergeDocument
 * ------------------------------------------------------------------ */

/** Resolve one document from `ancestor`, `currentBase` and the branch state. */
export function mergeDocument(request: MergeRequest): MergeResult {
  const context = createMergeContext(request.documentId, request.now)
  const touchedPaths = request.localTouchedPaths ?? []
  const unsetPaths = request.unsetPaths ?? []
  const local = request.localMaterialized
  const base = request.currentBase
  const ancestor = request.ancestor
  const origin = request.origin ?? 'base'
  /*
   * DELETION IS AN OBSERVATION, NOT AN INFERENCE. §16.1 makes direct base
   * reads the source of truth, so only an explicit `baseStatus: 'deleted'` —
   * set by a caller that actually observed the base gone — may flag deletion.
   * This used to also fire on `ancestor !== null`, i.e. on ANY commit that
   * omitted `baseDocuments` while the record had a merge ancestor. Nothing in
   * production ever sets 'deleted', so that heuristic was the only live
   * detector — and in Mode 2 (no base plane exists) it manufactured hard
   * BASE_DOCUMENT_DELETED conflicts on every edit of a base-ancestored
   * document, blocking publish over a deletion nobody saw (found live
   * 2026-08-11). An unobservable base merges as "nothing new observed": the
   * local document is preserved without conflict, and genuine upstream
   * deletions are the §16.6 drift scan's job to assert.
   */
  const baseDeleted = base === null && request.baseStatus === 'deleted'

  const classification = classifyBaseDeletion({
    touched: local !== null,
    origin,
    tombstoned: request.localTombstone === true,
  })

  /* --- §17.2 rule 1: an applicable local tombstone --- */
  if (request.localTombstone === true) {
    return finalize({
      context,
      request,
      document: null,
      absence: 'tombstone',
      touchedPaths,
    })
  }

  /* --- No local version: the base is the answer (§17.2 rule 4) --- */
  if (local === null) {
    if (base === null) {
      return finalize({
        context,
        request,
        document: null,
        absence: baseDeleted ? 'base-deleted' : 'missing',
        touchedPaths,
      })
    }
    return finalize({context, request, document: base, absence: null, touchedPaths})
  }

  /* --- §17.2 rule 2: a branch-created document outranks base entirely --- */
  if (origin === 'branch') {
    if (base !== null) {
      // §13.11 `LOCAL_ID_COLLISION`: the branch ID now exists upstream.
      addConflict(context, {
        type: 'LOCAL_ID_COLLISION',
        baseValue: base._rev,
        localValue: local._id,
      })
    }
    return finalize({
      context,
      request,
      document: stampSystemFields(local, local, null, request.now),
      absence: null,
      touchedPaths,
    })
  }

  /* --- §16.4: the base document was deleted --- */
  if (base === null) {
    if (baseDeleted && classification.conflict !== null) {
      addConflict(context, {type: classification.conflict, ancestorValue: ancestor?._rev})
    }
    return finalize({
      context,
      request,
      document: stampSystemFields(local, local, null, request.now),
      absence: null,
      touchedPaths,
    })
  }

  /* --- §17.4 `BASE_TYPE_CHANGED`: recovery output, no structural merge --- */
  if (
    ancestor !== null &&
    typeof ancestor._type === 'string' &&
    typeof base._type === 'string' &&
    ancestor._type !== base._type
  ) {
    addConflict(context, {
      type: 'BASE_TYPE_CHANGED',
      path: ['_type'],
      ancestorValue: ancestor._type,
      baseValue: base._type,
      localValue: local._type,
    })
    return finalize({
      context,
      request,
      document: stampSystemFields(local, local, null, request.now),
      absence: null,
      touchedPaths,
    })
  }

  /* --- §17.3 steps 4-8 --- */
  const tree = buildTouchTree(touchedPaths, unsetPaths)

  // §17.2 rule 4: with nothing recorded as touched the branch owns no part of this
  // document, so it resolves to the current base exactly — same answer as a record
  // with no local version, including base's Content Lake `_rev`. Stamping a
  // synthetic `_rev` (§13.9) here would name local ownership that does not exist.
  if (tree.children.size === 0 && !tree.self) {
    return finalize({context, request, document: base, absence: null, touchedPaths})
  }

  const merged = mergeNode(context, [], ancestor, base, local, tree)
  const document = (merged.present ? merged.value : base) as SanityDocument

  return finalize({
    context,
    request,
    document: stampSystemFields(document, local, base, request.now),
    absence: null,
    touchedPaths,
  })
}

/* ------------------------------------------------------------------ *
 * W2 port adapter
 * ------------------------------------------------------------------ */

export interface MergeResolverOptions {
  documentId: string
  now: string
  origin?: MergeRequest['origin']
  baseStatus?: MergeRequest['baseStatus']
  unsetPaths?: readonly OverlayPath[]
  validate?: MergeRequest['validate']
}

/**
 * Adapt {@link mergeDocument} to the `MergeResolver` port W2 injects
 * (`../mutations/ports`), which returns only the resolved document.
 */
export function createMergeResolver(options: MergeResolverOptions): MergeResolver {
  return (input: MergeInput): SanityDocument => {
    const result = mergeDocument({
      documentId: options.documentId,
      now: options.now,
      ancestor: input.ancestor,
      currentBase: input.currentBase,
      localMaterialized: input.localMaterialized,
      localTouchedPaths: input.localTouchedPaths,
      localTombstone: input.localTombstone,
      ...(options.origin === undefined ? {} : {origin: options.origin}),
      ...(options.baseStatus === undefined ? {} : {baseStatus: options.baseStatus}),
      ...(options.unsetPaths === undefined ? {} : {unsetPaths: options.unsetPaths}),
      ...(options.validate === undefined ? {} : {validate: options.validate}),
    })
    return result.document ?? input.localMaterialized
  }
}

/** Re-exported so the array helper is reachable from the merge entry point. */
export {hasDuplicateKeys}

/** Deterministic conflict list ordering helper for callers that merge results. */
export function sortConflicts(conflicts: readonly OverlayConflict[]): OverlayConflict[] {
  return [...conflicts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
