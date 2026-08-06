/**
 * PRD §30.7 — operation ordering.
 *
 * ```text
 * 1. Upload assets.
 * 2. Create branch-created reference targets as drafts or published documents.
 * 3. Create or patch dependent drafts.
 * 4. Publish targets required by strong references.
 * 5. Publish dependent documents.
 * 6. Apply unpublish operations after dependent strong references are updated.
 * 7. Apply deletes last.
 * ```
 *
 * The phase table is that list, as data. It is necessary but not sufficient: two
 * creates both sit in phase 2, and if one of them references the other, §18.8's
 * strong-reference rule says the target has to exist first. So within a phase the
 * operations are additionally ordered by the reference graph of the documents
 * they write — a topological sort whose edges come from `extractReferences`
 * (§19.1) over the *proposed* documents, not from a naming convention.
 *
 * Deletes are the mirror image. A document may only be deleted once everything
 * that referred to it has been updated; the phase table already guarantees that
 * against patches (phase 3 before phase 7), and among deletes a referrer is
 * removed before its target so no intermediate state has a dangling strong
 * reference (§18.8, §19.5).
 *
 * Ties are broken by target ID and then operation type, so the order is total and
 * the plan is deterministic (PRD §38.4).
 */
import {encodeOverlayPath} from '../encoding'
import {extractReferences} from '../references/extract'
import type {ReferenceStrength} from '../references/types'
import type {SanityDocument} from '../types/document'
import type {OverlayPath} from '../types/path'
import type {SerializedSchemaArtifact} from '../validation/schema'
import {
  isDocumentOperation,
  type PromotionOperation,
  type PromotionOperationType,
  type PromotionPhase,
} from './types'

/** PRD §30.7, as data. `publish` starts at 5 and is promoted to 4 by §30.7 step 4. */
export const PROMOTION_PHASE_BY_TYPE: Readonly<Record<PromotionOperationType, PromotionPhase>> =
  Object.freeze({
    'upload-asset': 1,
    'create-draft': 2,
    'create-published': 2,
    'patch-draft': 3,
    'patch-published': 3,
    'update-references': 3,
    noop: 3,
    publish: 5,
    unpublish: 6,
    delete: 7,
  })

/** One reference edge between two logical documents, as the ordering sees it. */
export interface PromotionReferenceEdge {
  /** The document holding the reference. */
  from: string
  /** The document it points at. */
  to: string
  strength: ReferenceStrength
  path?: OverlayPath
}

export type PromotionOrderingIssueCode = 'ORDERING_CYCLE'

export interface PromotionOrderingIssue {
  code: PromotionOrderingIssueCode
  message: string
  /** The logical IDs that form the cycle, sorted. */
  logicalIds: string[]
}

export interface OrderPromotionOptions {
  /** Reference edges over the proposed documents (PRD §19.1). */
  edges?: readonly PromotionReferenceEdge[]
  /** Logical IDs §30.7 step 4 must publish ahead of step 5's dependents. */
  strongReferenceTargets?: readonly string[]
}

export interface PromotionOrdering {
  operations: PromotionOperation[]
  issues: PromotionOrderingIssue[]
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function operationKey(operation: PromotionOperation): string {
  return isDocumentOperation(operation) ? operation.targetId : operation.assetId
}

function logicalIdOf(operation: PromotionOperation): string | null {
  return isDocumentOperation(operation) ? operation.logicalId : null
}

/**
 * Every reference edge in a set of proposed documents (PRD §19.1).
 *
 * Strength comes from the value's `_weak` or from the injected schema artifact —
 * the same classification `extractReferences` applies everywhere else, so a weak
 * reference cannot accidentally acquire ordering authority it does not have.
 */
export function promotionReferenceEdges(
  entries: ReadonlyArray<{logicalId: string; document: SanityDocument | null}>,
  schema?: SerializedSchemaArtifact,
): PromotionReferenceEdge[] {
  const edges = new Map<string, PromotionReferenceEdge>()

  for (const entry of entries) {
    if (entry.document === null) continue
    for (const reference of extractReferences(entry.document, {
      ...(schema === undefined ? {} : {schema}),
    })) {
      // Structural, not separator-joined: any separator can appear inside a
      // document ID, and a collision here silently drops an ordering constraint.
      const key = JSON.stringify([entry.logicalId, reference.targetId, encodeOverlayPath(reference.path)])
      if (edges.has(key)) continue
      edges.set(key, {
        from: entry.logicalId,
        to: reference.targetId,
        strength: reference.strength,
        path: reference.path,
      })
    }
  }

  return [...edges.values()].sort((a, b) => {
    const from = compareStrings(a.from, b.from)
    if (from !== 0) return from
    const to = compareStrings(a.to, b.to)
    if (to !== 0) return to
    return compareStrings(encodeOverlayPath(a.path ?? []), encodeOverlayPath(b.path ?? []))
  })
}

/**
 * Topologically order the logical IDs inside one phase.
 *
 * Edge direction depends on the phase: creating and patching put the target
 * first; deleting and unpublishing put the referrer first. Both are the same sort
 * with the edges reversed, so one function serves both and the two directions
 * cannot drift apart.
 */
function topoSort(
  ids: readonly string[],
  edges: readonly PromotionReferenceEdge[],
  direction: 'target-first' | 'referrer-first',
): {order: string[]; cycle: string[] | null} {
  const present = new Set(ids)
  const dependencies = new Map<string, Set<string>>()
  for (const id of ids) dependencies.set(id, new Set())

  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue
    if (edge.from === edge.to) continue
    const [dependent, dependency] =
      direction === 'target-first' ? [edge.from, edge.to] : [edge.to, edge.from]
    dependencies.get(dependent as string)?.add(dependency as string)
  }

  const order: string[] = []
  const done = new Set<string>()
  const remaining = [...ids].sort(compareStrings)

  while (remaining.length > 0) {
    // Deterministic Kahn: among all currently satisfiable nodes take the
    // lexicographically smallest, so the result depends on the graph alone.
    const index = remaining.findIndex((id) =>
      [...(dependencies.get(id) ?? [])].every((dependency) => done.has(dependency)),
    )
    if (index === -1) {
      return {order: [...order, ...remaining], cycle: [...remaining].sort(compareStrings)}
    }
    const [id] = remaining.splice(index, 1)
    order.push(id as string)
    done.add(id as string)
  }

  return {order, cycle: null}
}

/**
 * Order a plan's operations per PRD §30.7 and stamp each with its phase.
 *
 * Pure: the same operations plus the same edges produce the same sequence, every
 * time.
 */
export function orderPromotionOperations(
  operations: readonly PromotionOperation[],
  options: OrderPromotionOptions = {},
): PromotionOrdering {
  const edges = options.edges ?? []
  const strongTargets = new Set(options.strongReferenceTargets ?? [])
  const issues: PromotionOrderingIssue[] = []

  const phased = operations.map((operation) => {
    // §30.7 step 4 — publishing a strong-reference target comes before step 5's
    // "Publish dependent documents".
    const phase =
      operation.type === 'publish' && strongTargets.has(operation.logicalId)
        ? (4 as PromotionPhase)
        : PROMOTION_PHASE_BY_TYPE[operation.type]
    return {...operation, phase} as PromotionOperation
  })

  const byPhase = new Map<PromotionPhase, PromotionOperation[]>()
  for (const operation of phased) {
    const bucket = byPhase.get(operation.phase) ?? []
    bucket.push(operation)
    byPhase.set(operation.phase, bucket)
  }

  const ordered: PromotionOperation[] = []
  for (const phase of [...byPhase.keys()].sort((a, b) => a - b)) {
    const bucket = byPhase.get(phase) ?? []
    const ids = [...new Set(bucket.map(logicalIdOf).filter((id): id is string => id !== null))]

    let rank = new Map<string, number>()
    if (ids.length > 1) {
      const direction = phase >= 6 ? 'referrer-first' : 'target-first'
      const {order, cycle} = topoSort(ids, edges, direction)
      rank = new Map(order.map((id, index) => [id, index]))
      if (cycle !== null) {
        issues.push({
          code: 'ORDERING_CYCLE',
          message: `Reference cycle between ${cycle.join(', ')} cannot be ordered safely (PRD §30.7)`,
          logicalIds: cycle,
        })
      }
    }

    bucket.sort((a, b) => {
      const left = rank.get(logicalIdOf(a) ?? '') ?? -1
      const right = rank.get(logicalIdOf(b) ?? '') ?? -1
      if (left !== right) return left - right
      const keys = compareStrings(operationKey(a), operationKey(b))
      if (keys !== 0) return keys
      return compareStrings(a.type, b.type)
    })
    ordered.push(...bucket)
  }

  return {operations: ordered, issues}
}

const CREATE_TYPES: readonly PromotionOperationType[] = ['create-draft', 'create-published']
const PATCH_TYPES: readonly PromotionOperationType[] = [
  'patch-draft',
  'patch-published',
  'update-references',
]

/**
 * The §30.7 constraints an ordered operation list must satisfy, re-derived from
 * the PRD rather than from the sort that produced the list.
 *
 * This is the independent oracle: it shares no code path with
 * {@link orderPromotionOperations}, so a regression in the sort is caught by a
 * check that cannot regress with it.
 */
export function checkOperationOrdering(
  operations: readonly PromotionOperation[],
  options: OrderPromotionOptions = {},
): string[] {
  const violations: string[] = []
  const positions = new Map<string, number>()
  operations.forEach((operation, index) => {
    if (isDocumentOperation(operation)) {
      positions.set(`${operation.type}:${operation.logicalId}`, index)
    }
  })

  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1] as PromotionOperation
    const current = operations[index] as PromotionOperation
    if (PROMOTION_PHASE_BY_TYPE[current.type] < PROMOTION_PHASE_BY_TYPE[previous.type]) {
      violations.push(
        `${current.type} runs after ${previous.type} at index ${index}, which inverts PRD §30.7`,
      )
    }
  }

  const firstIndexFor = (logicalId: string, types: readonly PromotionOperationType[]): number => {
    for (const type of types) {
      const found = positions.get(`${type}:${logicalId}`)
      if (found !== undefined) return found
    }
    return -1
  }

  for (const edge of options.edges ?? []) {
    const referrerCreate = firstIndexFor(edge.from, CREATE_TYPES)
    const targetCreate = firstIndexFor(edge.to, CREATE_TYPES)
    if (referrerCreate !== -1 && targetCreate !== -1 && targetCreate > referrerCreate) {
      violations.push(
        `${edge.from} is created before its reference target ${edge.to} (PRD §30.7 step 2, §18.8)`,
      )
    }

    const referrerDelete = positions.get(`delete:${edge.from}`)
    const targetDelete = positions.get(`delete:${edge.to}`)
    if (
      referrerDelete !== undefined &&
      targetDelete !== undefined &&
      targetDelete < referrerDelete
    ) {
      violations.push(
        `${edge.to} is deleted before its referrer ${edge.from} (PRD §30.7 step 7, §18.8)`,
      )
    }

    const referrerPatch = firstIndexFor(edge.from, PATCH_TYPES)
    if (referrerPatch !== -1 && targetDelete !== undefined && targetDelete < referrerPatch) {
      violations.push(
        `${edge.to} is deleted before referrer ${edge.from} is updated (PRD §30.7 step 7)`,
      )
    }
  }

  return violations
}
