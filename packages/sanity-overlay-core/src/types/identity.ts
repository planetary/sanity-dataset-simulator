/**
 * PRD §12.1 — Overlay identity input.
 *
 * The identity input is mutually exclusive: a pull-request identity never
 * includes the branch name in the hash (§12.2). The hash itself lives in
 * `checksum.ts` because it consumes the canonical JSON serializer.
 */
import type {OverlayFormatVersion} from './format-version'

export type OverlayIdentity =
  | {kind: 'pull-request'; pullRequestId: string}
  | {kind: 'branch'; branch: string}

export interface OverlayIdentityInput {
  formatVersion: OverlayFormatVersion
  sanityProjectId: string
  baseDataset: string
  repositoryId: string
  vercelProjectId?: string
  identity: OverlayIdentity
}
