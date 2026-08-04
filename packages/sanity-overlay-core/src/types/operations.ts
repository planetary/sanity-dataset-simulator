/** PRD §13.7 — Overlay operations and mutations. */
import type {OverlayPath} from './path'
import type {SanityDocument} from './document'

/** Patch-level operations, matching the Sanity patch primitives (PRD §13.7, §25.6). */
export type OverlayOperation =
  | {type: 'set'; path: OverlayPath; value: unknown}
  | {type: 'setIfMissing'; path: OverlayPath; value: unknown}
  | {type: 'unset'; path: OverlayPath}
  | {type: 'insert'; path: OverlayPath; position: 'before' | 'after' | 'replace'; items: unknown[]}
  | {type: 'inc'; path: OverlayPath; amount: number}
  | {type: 'dec'; path: OverlayPath; amount: number}
  | {type: 'diffMatchPatch'; path: OverlayPath; patch: string}
  | {type: 'replaceDocument'; document: SanityDocument}

export type OverlayOperationType = OverlayOperation['type']

/**
 * Document-level mutation envelope (PRD §13.7, v1.1 — resolution of plan O1).
 *
 * `OverlayMutation` is the unit carried by transaction records (§13.10), mutation
 * requests (§25.5) and migration files (§20.4). `ifRevision` expresses the
 * revision precondition; `replaceDocument` stays a patch-level operation inside
 * {@link OverlayOperation}.
 */
export type OverlayMutation =
  | {type: 'create'; document: SanityDocument}
  | {type: 'createIfNotExists'; document: SanityDocument}
  | {type: 'createOrReplace'; document: SanityDocument}
  | {type: 'delete'; id: string}
  | {type: 'patch'; id: string; ifRevision?: string; operations: OverlayOperation[]}

export type OverlayMutationType = OverlayMutation['type']

/** Every `OverlayOperation['type']` value, as data (stable order for tests and UI). */
export const OVERLAY_OPERATION_TYPES = [
  'set',
  'setIfMissing',
  'unset',
  'insert',
  'inc',
  'dec',
  'diffMatchPatch',
  'replaceDocument',
] as const satisfies readonly OverlayOperationType[]

/** Every `OverlayMutation['type']` value, as data. */
export const OVERLAY_MUTATION_TYPES = [
  'create',
  'createIfNotExists',
  'createOrReplace',
  'delete',
  'patch',
] as const satisfies readonly OverlayMutationType[]

/** Insert positions supported by `insert` (PRD §13.7, §17.7). */
export const OVERLAY_INSERT_POSITIONS = ['before', 'after', 'replace'] as const
export type OverlayInsertPosition = (typeof OVERLAY_INSERT_POSITIONS)[number]
