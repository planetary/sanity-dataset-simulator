/**
 * `status` — "where is this branch", in one screen.
 *
 * Reads the manifest only. It never opens a document record, so it stays fast
 * and stays useful on an overlay whose `.runtime/` was never committed.
 */
import {OVERLAY_DOCUMENT_STATES} from '../../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../../sanity-overlay-core/src/index'
import {EXIT} from '../exit'
import {openOverlay} from '../overlay'
import {field} from '../render'
import type {CommandContext} from '../types'

export interface StatusOptions {
  readonly root: string
}

export interface StatusReport {
  readonly overlayId: string
  readonly status: string
  readonly revision: number
  readonly formatVersion: OverlayManifest['formatVersion']
  readonly base: OverlayManifest['base']
  readonly source: OverlayManifest['source']
  readonly documents: {readonly total: number; readonly byState: Record<string, number>}
  readonly conflicts: OverlayManifest['conflictSummary']
  readonly checkpoint: NonNullable<OverlayManifest['checkpoint']> | null
  /** Revisions committed since the last checkpoint (PRD §29.6). */
  readonly uncheckpointedRevisions: number
  readonly expiresAt: string | null
}

export function statusReport(manifest: OverlayManifest): StatusReport {
  const byState: Record<string, number> = {}
  for (const state of OVERLAY_DOCUMENT_STATES) byState[state] = 0
  for (const head of Object.values(manifest.documentHeads)) {
    byState[head.state] = (byState[head.state] ?? 0) + 1
  }

  const checkpoint = manifest.checkpoint ?? null
  return {
    overlayId: manifest.overlayId,
    status: manifest.status,
    revision: manifest.revision,
    formatVersion: manifest.formatVersion,
    base: manifest.base,
    source: manifest.source,
    documents: {total: Object.keys(manifest.documentHeads).length, byState},
    conflicts: manifest.conflictSummary,
    checkpoint,
    uncheckpointedRevisions:
      checkpoint === null ? manifest.revision : manifest.revision - checkpoint.overlayRevision,
    expiresAt: manifest.expiresAt ?? null,
  }
}

/** Human rendering shared by `status` and the header of `inspect`. */
export function renderStatus(report: StatusReport): string[] {
  const states = Object.entries(report.documents.byState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state} ${count}`)
    .join(', ')

  const source = [
    report.source.repositoryId,
    `branch ${report.source.branch}`,
    report.source.pullRequestId === undefined ? null : `PR ${report.source.pullRequestId}`,
  ]
    .filter((part): part is string => part !== null)
    .join('  ')

  return [
    field('overlay', report.overlayId),
    field('status', report.status),
    field('revision', String(report.revision)),
    field(
      'base',
      `${report.base.projectId}/${report.base.dataset} @${report.base.apiVersion}`,
    ),
    field('source', source),
    field(
      'documents',
      `${report.documents.total}${states.length === 0 ? '' : `  (${states})`}`,
    ),
    field(
      'conflicts',
      `${report.conflicts.total}  (hard ${report.conflicts.hard}, soft ${report.conflicts.soft})`,
    ),
    field(
      'checkpoint',
      report.checkpoint === null
        ? `none  (${report.uncheckpointedRevisions} uncheckpointed revisions)`
        : `${report.checkpoint.commitSha} at revision ${report.checkpoint.overlayRevision}  (${report.uncheckpointedRevisions} uncheckpointed)`,
    ),
    field('expires', report.expiresAt ?? 'never'),
  ]
}

export async function runStatus(ctx: CommandContext): Promise<number> {
  const opened = await openOverlay(ctx.root, ctx.now)
  const report = statusReport(opened.manifest)
  ctx.emitJson(report)
  if (!ctx.json) for (const line of renderStatus(report)) ctx.out(line)
  return EXIT.OK
}
