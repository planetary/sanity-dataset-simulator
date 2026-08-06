/**
 * `conflicts` — the §28.2 conflict list, and the §28.3 actions that apply.
 *
 * The exit code is the product here: an unresolved conflict must fail a script
 * (PRD §17.4 "blocks preview, publish or promotion"), a resolved one must not.
 * Resolution itself is not offered: §28.3 actions need a value and an actor, and
 * a CLI that guessed either would be resolving on the reviewer's behalf.
 */
import {
  applicableResolutionActions,
  summarizeConflicts,
  toPublishedId,
} from '../../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../../sanity-overlay-core/src/index'
import {EXIT} from '../exit'
import {loadRecords, openOverlay, requireHead} from '../overlay'
import {formatPath, plural, table} from '../render'
import type {CommandContext} from '../types'

export interface ConflictsOptions {
  readonly document?: string
  /** Include conflicts that already carry a §13.11 resolution. */
  readonly all?: boolean
  /** Attach the §28.3 actions applicable to each conflict. */
  readonly actions?: boolean
}

export async function runConflicts(
  ctx: CommandContext,
  options: ConflictsOptions,
): Promise<number> {
  const opened = await openOverlay(ctx.root, ctx.now)
  if (options.document !== undefined) requireHead(opened.manifest, options.document)
  const wanted = options.document === undefined ? null : toPublishedId(options.document)

  const loaded = await loadRecords(opened)
  const collected: OverlayConflict[] = []
  for (const logicalId of Object.keys(loaded.records).sort()) {
    if (wanted !== null && logicalId !== wanted) continue
    collected.push(...(loaded.records[logicalId]?.conflicts ?? []))
  }

  const listed = collected
    .filter((conflict) => options.all === true || conflict.resolution === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const unresolved = listed.filter((conflict) => conflict.resolution === undefined)

  const report = {
    overlayId: opened.overlayId,
    summary: summarizeConflicts(listed),
    manifestSummary: opened.manifest.conflictSummary,
    unresolved: unresolved.length,
    conflicts: listed.map((conflict) => ({
      id: conflict.id,
      documentId: conflict.documentId,
      type: conflict.type,
      severity: conflict.severity,
      path: conflict.path === undefined ? null : formatPath(conflict.path),
      detectedAt: conflict.detectedAt,
      resolved: conflict.resolution !== undefined,
      resolution: conflict.resolution?.type ?? null,
      ...(options.actions === true ? {actions: applicableResolutionActions(conflict)} : {}),
    })),
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    ctx.out(
      `${plural(unresolved.length, 'unresolved conflict')} (${plural(listed.length, 'listed', 'listed')})`,
    )
    if (listed.length > 0) {
      const rows: string[][] = [['SEVERITY', 'DOCUMENT', 'TYPE', 'PATH', 'STATE']]
      for (const conflict of listed) {
        rows.push([
          conflict.severity,
          conflict.documentId,
          conflict.type,
          conflict.path === undefined ? '-' : formatPath(conflict.path),
          conflict.resolution === undefined ? 'unresolved' : `resolved:${conflict.resolution.type}`,
        ])
      }
      for (const line of table(rows)) ctx.out(line)
      if (options.actions === true) {
        ctx.out('')
        for (const conflict of listed) {
          ctx.out(`${conflict.id}  ->  ${applicableResolutionActions(conflict).join(', ')}`)
        }
      }
    }
  }

  return unresolved.length > 0 ? EXIT.FINDINGS : EXIT.OK
}
