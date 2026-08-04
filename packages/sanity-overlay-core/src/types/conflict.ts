/** PRD §13.11 — Conflict record, with the §17.4 default severity table as data. */
import type {OverlayActor} from './actor'
import type {OverlayPath} from './path'

export type OverlayConflictSeverity = 'soft' | 'hard'

/** The thirteen-member conflict type union (PRD §13.11, v1.1 added `OVERLAY_SAME_PATH_CHANGED`). */
export type OverlayConflictType =
  | 'SAME_PATH_CHANGED'
  | 'OVERLAY_SAME_PATH_CHANGED'
  | 'PARENT_SHAPE_CHANGED'
  | 'BASE_DOCUMENT_DELETED'
  | 'BASE_DRAFT_DELETED'
  | 'BASE_TYPE_CHANGED'
  | 'ARRAY_ITEM_DELETED'
  | 'ARRAY_KEY_COLLISION'
  | 'REFERENCE_TARGET_DELETED'
  | 'STRONG_REFERENCE_INVALID'
  | 'LOCAL_ID_COLLISION'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'UNSUPPORTED_SCHEMA_MIGRATION'

export type OverlayConflictResolutionType =
  | 'keep-local'
  | 'accept-base'
  | 'manual'
  | 'rename'
  | 'delete-local'

export interface OverlayConflictResolution {
  type: OverlayConflictResolutionType
  resolvedAt: string
  resolvedBy: OverlayActor
}

export interface OverlayConflict {
  id: string
  documentId: string
  severity: OverlayConflictSeverity
  type: OverlayConflictType
  path?: OverlayPath
  ancestorValue?: unknown
  baseValue?: unknown
  localValue?: unknown
  detectedAt: string
  resolution?: OverlayConflictResolution
}

/** Every conflict type, as data (stable order). */
export const OVERLAY_CONFLICT_TYPES = [
  'SAME_PATH_CHANGED',
  'OVERLAY_SAME_PATH_CHANGED',
  'PARENT_SHAPE_CHANGED',
  'BASE_DOCUMENT_DELETED',
  'BASE_DRAFT_DELETED',
  'BASE_TYPE_CHANGED',
  'ARRAY_ITEM_DELETED',
  'ARRAY_KEY_COLLISION',
  'REFERENCE_TARGET_DELETED',
  'STRONG_REFERENCE_INVALID',
  'LOCAL_ID_COLLISION',
  'SCHEMA_VALIDATION_ERROR',
  'UNSUPPORTED_SCHEMA_MIGRATION',
] as const satisfies readonly OverlayConflictType[]

export const OVERLAY_CONFLICT_RESOLUTION_TYPES = [
  'keep-local',
  'accept-base',
  'manual',
  'rename',
  'delete-local',
] as const satisfies readonly OverlayConflictResolutionType[]

/**
 * Default severity per conflict type, transcribed from the PRD §17.4 table
 * (plan §4: "Encode default severities from the PRD §17.4 table as data, not
 * scattered literals"). Every §13.11 union member maps to a §17.4 row.
 *
 * `REFERENCE_TARGET_DELETED` is the one row whose severity is conditional —
 * §17.4 reads "Soft for weak, hard for strong". The unconditional default here is
 * `soft` (the weak-reference case, which is what a bare
 * `REFERENCE_TARGET_DELETED` describes); the strong-reference case is either
 * `STRONG_REFERENCE_INVALID` (hard) or resolved through
 * {@link defaultConflictSeverity} with `referenceStrength: 'strong'`.
 */
export const DEFAULT_CONFLICT_SEVERITY: Readonly<
  Record<OverlayConflictType, OverlayConflictSeverity>
> = Object.freeze({
  SAME_PATH_CHANGED: 'soft',
  OVERLAY_SAME_PATH_CHANGED: 'soft',
  PARENT_SHAPE_CHANGED: 'hard',
  BASE_DOCUMENT_DELETED: 'hard',
  BASE_DRAFT_DELETED: 'soft',
  BASE_TYPE_CHANGED: 'hard',
  ARRAY_ITEM_DELETED: 'hard',
  ARRAY_KEY_COLLISION: 'hard',
  REFERENCE_TARGET_DELETED: 'soft',
  STRONG_REFERENCE_INVALID: 'hard',
  LOCAL_ID_COLLISION: 'hard',
  SCHEMA_VALIDATION_ERROR: 'hard',
  UNSUPPORTED_SCHEMA_MIGRATION: 'hard',
})

export interface ConflictSeverityContext {
  /** Reference strength, for the conditional §17.4 `REFERENCE_TARGET_DELETED` row. */
  referenceStrength?: 'strong' | 'weak'
}

/**
 * Default severity for a conflict type (PRD §17.4). Only
 * `REFERENCE_TARGET_DELETED` consults the context: a deleted target of a strong
 * reference is hard, a weak one is soft.
 */
export function defaultConflictSeverity(
  type: OverlayConflictType,
  context: ConflictSeverityContext = {},
): OverlayConflictSeverity {
  if (type === 'REFERENCE_TARGET_DELETED' && context.referenceStrength === 'strong') {
    return 'hard'
  }
  return DEFAULT_CONFLICT_SEVERITY[type]
}
