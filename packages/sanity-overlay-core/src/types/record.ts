/** PRD §13.3 — Overlay document, §13.4 — Base document version, §13.5 — Local document version. */
import type {OverlayActor} from './actor'
import type {OverlayConflict} from './conflict'
import type {SanityDocument} from './document'
import type {OverlayFormatVersion} from './format-version'
import type {OverlayOperation} from './operations'
import type {OverlayPath} from './path'

/** PRD §13.4 — Base document version. */
export interface BaseDocumentVersion {
  revision: string
  snapshot: SanityDocument
  checksum: string
  capturedAt: string
}

/** PRD §13.5 — Local document version. */
export interface LocalDocumentVersion {
  materialized: SanityDocument
  touchedPaths: OverlayPath[]
  operations: OverlayOperation[]
  ancestorKind: 'base-published' | 'base-draft' | 'local-published' | 'branch-created'
  ancestorRevision?: string
  overlayRevision: string
  createdAt: string
  updatedAt: string
}

export const OVERLAY_ANCESTOR_KINDS = [
  'base-published',
  'base-draft',
  'local-published',
  'branch-created',
] as const

export type OverlayAncestorKind = LocalDocumentVersion['ancestorKind']

export type OverlayBaseStatus = 'present' | 'deleted' | 'unknown'

/**
 * The `base` block of an overlay document record (PRD §13.3).
 *
 * It holds the current merge ancestor: captured at first touch and replaced only
 * by an explicit or automatic rebase (§28.4, §28.5) in one transaction.
 * `firstTouchedAt` is never modified after capture (v1.1, plan resolution O6).
 */
export interface OverlayRecordBaseBlock {
  firstTouchedAt: string
  published: BaseDocumentVersion | null
  draft: BaseDocumentVersion | null
  lastObservedPublishedRevision?: string
  lastObservedDraftRevision?: string
  baseStatus: OverlayBaseStatus
}

/** The `local` block of an overlay document record (PRD §13.3). */
export interface OverlayRecordLocalBlock {
  published: LocalDocumentVersion | null
  draft: LocalDocumentVersion | null
  publishedTombstone: boolean
  draftTombstone: boolean
}

/** PRD §13.3 — Overlay document. */
export interface OverlayDocumentRecord {
  formatVersion: OverlayFormatVersion
  overlayId: string
  logicalId: string
  schemaType: string
  origin: 'base' | 'branch'

  base: OverlayRecordBaseBlock | null

  local: OverlayRecordLocalBlock

  conflicts: OverlayConflict[]
  runtimeRevision: string
  createdAt: string
  updatedAt: string
  createdBy?: OverlayActor
  updatedBy?: OverlayActor
}

export type OverlayDocumentOrigin = OverlayDocumentRecord['origin']
