/**
 * `status` — "where is this branch", in one screen.
 *
 * Reads the manifest only. It never opens a document record, so it stays fast
 * and stays useful on an overlay whose `.runtime/` was never committed.
 */
import {OVERLAY_DOCUMENT_STATES} from 'sanity-overlay-core'
import type {OverlayManifest} from 'sanity-overlay-core'
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

/**
 * The `checkpoint` line.
 *
 * THREE OUTCOMES, NOT TWO. `manifest.checkpoint` records that a checkpoint was
 * TAKEN; `commitSha` records that a commit is known to CARRY it, and only a
 * caller who already held the sha can supply it — the commit does not exist
 * when the checkpoint is written. Printing `undefined at revision N` for the
 * unattributed case (which is what a template expecting a sha produced) told an
 * operator nothing; printing `none` — which is what happened while the marker
 * was never written at all — told them something false.
 */
function checkpointLine(report: StatusReport): string {
  if (report.checkpoint === null) {
    return `none  (${report.uncheckpointedRevisions} uncheckpointed revisions)`
  }
  const where =
    report.checkpoint.commitSha === undefined
      ? 'not attributed to a commit yet — commit the checkpoint tree'
      : `commit ${report.checkpoint.commitSha}`
  return (
    `revision ${report.checkpoint.overlayRevision}, ${where}  ` +
    `(${report.uncheckpointedRevisions} uncheckpointed)`
  )
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
    field('checkpoint', checkpointLine(report)),
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
