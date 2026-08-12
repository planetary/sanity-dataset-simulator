/**
 * `conflicts` — the §28.2 conflict list, the §28.3 actions that apply, and
 * (with `--resolve`) the resolution itself.
 *
 * The exit code is the product here: an unresolved conflict must fail a script
 * (PRD §17.4 "blocks preview, publish or promotion"), a resolved one must not.
 *
 * `--resolve` records a DECISION, so it follows the reset/rebase discipline:
 * no `--confirm` exits 3 with the plan printed, `--dry-run` never writes and
 * wins even alongside `--confirm`. Two actions are refused here by design:
 * `accept-current-staging` needs the CURRENT base document, which an offline
 * CLI cannot observe (§16.1) — resolve those from the Studio; and
 * `rename-branch-id` needs store-level head surgery core's record wrapper
 * refuses (see `resolveRecordConflict`).
 */
import {
  applicableResolutionActions,
  resolveRecordConflict,
  summarizeConflicts,
  toPublishedId,
} from 'sanity-overlay-core'
import type {OverlayActor, OverlayConflict} from 'sanity-overlay-core'
import {confirmationRequired, usageError} from '../errors'
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
  /** Resolve a conflict on this document (the §28.3 panel, as a verb). */
  readonly resolve?: string
  /** The §28.3 action to apply — required with `--resolve`. */
  readonly action?: string
  /** Explicit conflict id, when the document carries more than one. */
  readonly conflict?: string
  /** Operator value for `manual-edit`, parsed as JSON. */
  readonly value?: string
  readonly confirm?: boolean
  readonly dryRun?: boolean
}

const RESOLVE_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'sanity-overlay-cli',
  displayName: 'sanity-overlay CLI',
}

async function runResolve(
  ctx: CommandContext,
  options: ConflictsOptions,
): Promise<number> {
  const documentId = options.resolve!
  if (options.action === undefined) {
    throw usageError('conflicts --resolve needs --action <action> (PRD §28.3)')
  }
  if (options.action === 'accept-current-staging') {
    throw usageError(
      'accept-current-staging needs the CURRENT base document, which this offline CLI cannot ' +
        'observe (PRD §16.1). Resolve it from the Studio conflict panel instead.',
    )
  }

  const opened = await openOverlay(ctx.root, ctx.now)
  requireHead(opened.manifest, documentId)
  const logicalId = toPublishedId(documentId)

  const loaded = await loadRecords(opened)
  const record = loaded.records[logicalId]
  if (record === undefined) {
    throw usageError(`the overlay holds no readable record for ${JSON.stringify(logicalId)}`)
  }

  const unresolved = record.conflicts.filter((conflict) => conflict.resolution === undefined)
  const target =
    options.conflict !== undefined
      ? record.conflicts.find((conflict) => conflict.id === options.conflict)
      : unresolved.length === 1
        ? unresolved[0]
        : undefined
  if (target === undefined) {
    throw usageError(
      unresolved.length === 0
        ? `${logicalId} has no unresolved conflicts`
        : `${logicalId} has ${unresolved.length} unresolved conflicts — name one with --conflict <id>: ` +
          unresolved.map((conflict) => conflict.id).join(', '),
    )
  }

  const plan = {
    documentId: logicalId,
    conflictId: target.id,
    conflictType: target.type,
    severity: target.severity,
    action: options.action,
    applicable: applicableResolutionActions(target),
  }

  const willWrite = options.confirm === true && options.dryRun !== true
  if (!willWrite) {
    ctx.emitJson({...plan, applied: false})
    if (!ctx.json) {
      ctx.out(`would resolve ${target.id} (${target.type}, ${target.severity}) with ${options.action}`)
      ctx.out(`applicable actions: ${plan.applicable.join(', ')}`)
    }
    if (options.dryRun === true) return EXIT.OK
    throw confirmationRequired(
      `resolving ${target.id} records a decision on this branch. Rerun with --confirm to ` +
        'proceed, or --dry-run to see this report without the refusal.',
      {documentId: logicalId, conflictId: target.id},
    )
  }

  /* `resolveRecordConflict` refuses inapplicable actions, double resolution and
   * rename-branch-id with messages that name what IS offered. */
  const resolved = resolveRecordConflict({
    record,
    conflictId: target.id,
    action: options.action as never,
    now: ctx.now(),
    transactionId: `cli-resolve-r${opened.manifest.revision}-${logicalId}-${target.id}`,
    actor: RESOLVE_ACTOR,
    currentBase: null,
    ...(options.value === undefined ? {} : {value: JSON.parse(options.value) as unknown}),
  })

  await opened.store.commitTransaction(opened.overlayId, {
    idempotencyKey: `cli-resolve-r${opened.manifest.revision}-${logicalId}-${target.id}`,
    actor: RESOLVE_ACTOR,
    /* Empty like rebase: the post-state record IS the payload. */
    mutations: [],
    records: [resolved.record],
    expectedOverlayRevision: opened.manifest.revision,
  })

  ctx.emitJson({...plan, applied: true, resolution: resolved.transaction.resolution})
  if (!ctx.json) {
    ctx.out(
      `resolved ${target.id} with ${options.action} (${resolved.transaction.resolution}); ` +
        'the decision is recorded on the branch',
    )
  }
  return EXIT.OK
}

export async function runConflicts(
  ctx: CommandContext,
  options: ConflictsOptions,
): Promise<number> {
  if (options.resolve !== undefined) return runResolve(ctx, options)

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
