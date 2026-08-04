/** PRD §13.1 — Manifest, §13.2 — Document head, §12.3 — Lifecycle states. */
import type {OverlayActor} from './actor'
import type {OverlayFormatVersion} from './format-version'

/** PRD §12.3 lifecycle states, as data (stable order matches the §12.3 table). */
export const OVERLAY_STATUSES = [
  'active',
  'checkpointed',
  'conflicted',
  'closed',
  'promoted',
  'expired',
] as const

export type OverlayStatus = (typeof OVERLAY_STATUSES)[number]

/** PRD §13.2 document head state values. */
export const OVERLAY_DOCUMENT_STATES = [
  'created',
  'modified',
  'deleted',
  'unpublished',
  'unchanged',
] as const

export type OverlayDocumentState = (typeof OVERLAY_DOCUMENT_STATES)[number]

/**
 * PRD §13.2 — Document head.
 *
 * `checksum` is SHA-256 over the canonical JSON serialization (§14.3 rules), hex
 * encoded; `storageRef` is an opaque string so fs, Blob and memory adapters can
 * each fill it (plan §2).
 */
export interface OverlayDocumentHead {
  logicalId: string
  schemaType: string
  runtimeRevision: string
  storageRef: string
  checksum: string
  updatedAt: string
  updatedBy?: OverlayActor
  state: OverlayDocumentState
  hasDraft: boolean
  hasPublished: boolean
  hasConflict: boolean
}

/** PRD §13.1 — Manifest. */
export interface OverlayManifest {
  formatVersion: OverlayFormatVersion
  overlayId: string
  status: OverlayStatus
  base: {
    projectId: string
    dataset: string
    apiVersion: string
  }
  source: {
    repositoryId: string
    vercelProjectId?: string
    pullRequestId?: string
    branch: string
    schemaCommitSha?: string
  }
  revision: number
  createdAt: string
  updatedAt: string
  createdBy?: OverlayActor
  updatedBy?: OverlayActor
  documentHeads: Record<string, OverlayDocumentHead>
  transactionHead?: string
  conflictSummary: {
    total: number
    hard: number
    soft: number
  }
  checkpoint?: {
    overlayRevision: number
    commitSha: string
    createdAt: string
  }
  promotion?: {
    planId?: string
    targetDataset?: string
    promotedAt?: string
    resultingTransactionId?: string
  }
  expiresAt?: string
}
