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
  /**
   * PRD §13.1 — the last checkpoint this overlay took.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * "CHECKPOINT WRITTEN" AND "CHECKPOINT ATTRIBUTED TO A COMMIT" ARE TWO FACTS.
   *
   * `commitSha` used to be required, and the consequence was that the field was
   * never written at all. A checkpoint taken from a Studio CANNOT name a commit:
   * the checkpoint is what PRODUCES the files that will be committed, so the
   * commit does not exist yet, by construction. A required sha therefore left
   * the only writer with two choices — fabricate one (§5.5 forbids it) or write
   * nothing — and it wrote nothing. `sanity-overlay status` and CI's §29.6
   * policy then reported "never checkpointed" immediately after a checkpoint,
   * and `touchedSinceCheckpoint` could never be derived by anyone.
   *
   * So the field now records the checkpoint EVENT, and `commitSha` is the
   * separate, optional fact of ATTRIBUTION:
   *
   *   present, no `commitSha`  the checkpoint was taken at `overlayRevision`
   *                            and is not yet known to be in Git
   *   present, with `commitSha` a commit is known to carry it
   *   absent                    no checkpoint has ever been taken
   *
   * Every §29.6 predicate the PRD states is written in terms of
   * `checkpoint.overlayRevision`, never the sha, so the unattributed form
   * satisfies the policy the PRD actually specifies.
   *
   * WHY THERE IS NO "STAMP THE SHA AFTERWARDS" PATH. The sha would have to be
   * written into `manifest.json`, and `manifest.json` is itself a file of the
   * checkpoint tree that was just committed. Writing it back makes the store's
   * manifest differ from the committed one, and reconciling that needs a second
   * commit — which needs a third sha. The circularity is the shape of the
   * problem, not an implementation detail, so `commitSha` is written only by a
   * caller that already held it (a CI job that knows its target commit) and is
   * otherwise left out. Where the tree landed is a question Git answers.
   * ─────────────────────────────────────────────────────────────────────────
   */
  checkpoint?: {
    overlayRevision: number
    /** Present only when the caller could name the commit without inventing it. */
    commitSha?: string
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
