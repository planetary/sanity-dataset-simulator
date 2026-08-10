/**
 * `reset` — PRD §29.8 "Reset all documents after confirmation".
 *
 * Destruction is never the easy default. The command always computes and prints
 * the loss report FIRST, from the manifest heads it is about to drop, and only
 * then decides whether it is allowed to proceed:
 *
 *   no `--confirm`  → print the loss, write nothing, exit CONFIRMATION_REQUIRED
 *   `--dry-run`     → print the loss, write nothing, exit OK (even with --confirm)
 *   `--confirm`     → print the loss, then reset
 *
 * The report is emitted on stdout even in the refusal case, because the point of
 * refusing is to show the operator what they were about to lose.
 */
import type {OverlayActor} from 'sanity-overlay-core'
import {toPublishedId} from 'sanity-overlay-core'
import {confirmationRequired, usageError} from '../errors'
import {EXIT} from '../exit'
import {openOverlay, requireHead, sortedHeads} from '../overlay'
import {plural, table} from '../render'
import type {CommandContext} from '../types'

export interface ResetOptions {
  readonly document?: string
  readonly all?: boolean
  readonly confirm?: boolean
  readonly dryRun?: boolean
}

const RESET_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'sanity-overlay-cli',
  displayName: 'sanity-overlay CLI',
}

export async function runReset(ctx: CommandContext, options: ResetOptions): Promise<number> {
  const wantsAll = options.all === true
  const wantsOne = options.document !== undefined
  if (wantsAll === wantsOne) {
    throw usageError(
      'reset requires exactly one of --all or --document <id>; refusing to guess which state to destroy',
    )
  }

  const opened = await openOverlay(ctx.root, ctx.now)
  const heads = wantsAll
    ? sortedHeads(opened.manifest)
    : [requireHead(opened.manifest, options.document!)]

  const wouldRemove = heads.map((head) => ({
    logicalId: head.logicalId,
    schemaType: head.schemaType,
    state: head.state,
    runtimeRevision: head.runtimeRevision,
    hasConflict: head.hasConflict,
  }))

  const dryRun = options.dryRun === true
  const confirmed = options.confirm === true

  const willWrite = confirmed && !dryRun
  if (!willWrite) {
    ctx.emitJson({
      overlayId: opened.overlayId,
      scope: wantsAll ? 'all' : 'document',
      confirmed,
      dryRun,
      applied: false,
      wouldRemove,
    })
    if (!ctx.json) {
      ctx.out(
        `${plural(wouldRemove.length, 'document')} would be reset to base and their branch state lost:`,
      )
      for (const line of table([
        ['STATE', 'DOCUMENT', 'TYPE', 'REVISION'],
        ...wouldRemove.map((entry) => [
          entry.state,
          entry.logicalId,
          entry.schemaType,
          entry.runtimeRevision,
        ]),
      ])) {
        ctx.out(line)
      }
    }
    if (dryRun) return EXIT.OK
    throw confirmationRequired(
      `reset would discard branch state for ${plural(wouldRemove.length, 'document')}. Rerun with --confirm to proceed, or --dry-run to see this report without the refusal.`,
      {documents: wouldRemove.map((entry) => entry.logicalId)},
    )
  }

  const result = wantsAll
    ? await opened.store.resetOverlay(opened.overlayId, {confirm: true, actor: RESET_ACTOR})
    : await opened.store.resetDocument(
        opened.overlayId,
        toPublishedId(options.document!),
        {actor: RESET_ACTOR},
      )

  ctx.emitJson({
    overlayId: opened.overlayId,
    scope: wantsAll ? 'all' : 'document',
    confirmed: true,
    dryRun: false,
    applied: true,
    removedDocumentIds: result.removedDocumentIds,
    removedRefs: result.removedRefs,
    revision: result.manifest.revision,
  })

  if (!ctx.json) {
    ctx.out(
      `reset ${plural(result.removedDocumentIds.length, 'document')} — overlay is now at revision ${result.manifest.revision}`,
    )
    for (const id of result.removedDocumentIds) ctx.out(`  removed  ${id}`)
  }
  return EXIT.OK
}
