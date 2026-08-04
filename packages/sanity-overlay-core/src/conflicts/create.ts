/**
 * Building §13.11 conflict records with the §17.4 default severities applied
 * (plan §6, "Implement structural conflict detection").
 *
 * Conflict identity is *derived*, not generated: `documentId`, `type` and the
 * encoded path fully determine the ID. That keeps merge a pure function — no ID
 * source to inject, no clock beyond the caller-supplied `detectedAt` — and makes
 * two evaluations of the same merge produce byte-identical conflict lists
 * (PRD §17.3 step 10, plan §8.5 "merge determinism").
 */
import {encodeOverlayPath} from '../encoding'
import {
  defaultConflictSeverity,
  type ConflictSeverityContext,
  type OverlayConflict,
  type OverlayConflictSeverity,
  type OverlayConflictType,
} from '../types/conflict'
import type {OverlayPath} from '../types/path'

export interface CreateConflictInput {
  documentId: string
  type: OverlayConflictType
  /** Injected clock value (plan §6: no `Date.now()` inside the engine). */
  detectedAt: string
  path?: OverlayPath
  ancestorValue?: unknown
  baseValue?: unknown
  localValue?: unknown
  /** Overrides the §17.4 default severity. */
  severity?: OverlayConflictSeverity
  /** Context for the one conditional §17.4 row (`REFERENCE_TARGET_DELETED`). */
  severityContext?: ConflictSeverityContext
}

/** Stable identity for a conflict: `<documentId>:<type>:<encoded path>`. */
export function conflictId(
  documentId: string,
  type: OverlayConflictType,
  path?: OverlayPath,
): string {
  return `${documentId}:${type}:${path === undefined ? '$' : encodeOverlayPath(path)}`
}

/** Build one §13.11 conflict record, defaulting severity from the §17.4 table. */
export function createConflict(input: CreateConflictInput): OverlayConflict {
  const conflict: OverlayConflict = {
    id: conflictId(input.documentId, input.type, input.path),
    documentId: input.documentId,
    severity: input.severity ?? defaultConflictSeverity(input.type, input.severityContext ?? {}),
    type: input.type,
    detectedAt: input.detectedAt,
  }
  if (input.path !== undefined) conflict.path = input.path
  if (input.ancestorValue !== undefined) conflict.ancestorValue = input.ancestorValue
  if (input.baseValue !== undefined) conflict.baseValue = input.baseValue
  if (input.localValue !== undefined) conflict.localValue = input.localValue
  return conflict
}

/** The §13.1 `conflictSummary` shape, computed from a conflict list. */
export function summarizeConflicts(conflicts: readonly OverlayConflict[]): {
  total: number
  hard: number
  soft: number
} {
  let hard = 0
  let soft = 0
  for (const conflict of conflicts) {
    if (conflict.severity === 'hard') hard += 1
    else soft += 1
  }
  return {total: conflicts.length, hard, soft}
}

/** True when any conflict blocks preview, publish or promotion (PRD §17.4). */
export function hasHardConflict(conflicts: readonly OverlayConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'hard')
}
