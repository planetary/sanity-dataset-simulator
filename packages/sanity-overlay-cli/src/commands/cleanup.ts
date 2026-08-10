/**
 * `cleanup` — reclaim local overlay storage (PRD §15.7, §37 Phase 2 "Local
 * cleanup").
 *
 * Two operations with genuinely different risk, run together but reported apart:
 *
 * 1. **Orphan collection** (`store.collectOrphans`). Immutable artifacts no
 *    manifest head reaches: superseded document revisions, unreferenced base
 *    snapshots, document directories and materialized files for documents the
 *    overlay no longer touches. Reclaiming these changes no behaviour — nothing
 *    could read them.
 *
 * 2. **Runtime log pruning** (`store.pruneRuntimeHistory`). The §13.10
 *    transaction log and the §34.6 idempotency ledger. These are NOT orphans:
 *    every record stays reachable by design, and every pointer is the authority
 *    that stops a retried request applying twice. So nothing is pruned unless
 *    the operator states a retention window with `--keep-last` or
 *    `--keep-after-revision`, and the prose output says plainly what that costs.
 *
 *    The single exception needs no window: a pointer naming a transaction file
 *    that no longer exists. `getTransaction` already answers `null` for it, so
 *    the key already re-applies — removing the file changes nothing except the
 *    directory's size.
 *
 * `--confirm` gates the write, exactly as it does for `reset` and `rebase`, and
 * the refusal path still prints the whole report.
 */
import type {
  OverlayOrphanReport,
  RuntimeHistoryPruneReport,
} from 'sanity-overlay-store-fs'
import {confirmationRequired, usageError} from '../errors'
import {EXIT} from '../exit'
import {openOverlay} from '../overlay'
import {field, plural, table} from '../render'
import type {CommandContext} from '../types'

export interface CleanupOptions {
  readonly confirm?: boolean
  readonly dryRun?: boolean
  readonly keepLast?: string
  readonly keepAfterRevision?: string
}

function numeric(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(
      `cleanup ${flag} expects a non-negative integer, received ${JSON.stringify(raw)}`,
      {flag, value: raw},
    )
  }
  return value
}

function renderOrphans(ctx: CommandContext, report: OverlayOrphanReport, applied: boolean): void {
  const rows = applied ? report.deleted : report.orphans
  ctx.out(
    `orphans: ${plural(report.scanned, 'artifact')} scanned, ${plural(
      report.orphans.length,
      'reclaimable',
      'reclaimable',
    )}${applied ? `, ${report.deleted.length} removed` : ''}`,
  )
  if (rows.length > 0) {
    for (const line of table([
      ['KIND', 'REF', 'REASON'],
      ...rows.map((orphan) => [orphan.kind, orphan.ref, orphan.reason]),
    ])) {
      ctx.out(`  ${line}`)
    }
  }
  for (const failure of report.failures) ctx.out(`  FAILED  ${failure.ref}  ${failure.reason}`)
}

function renderHistory(ctx: CommandContext, report: RuntimeHistoryPruneReport): void {
  ctx.out('')
  ctx.out(
    `runtime log: ${plural(report.scannedTransactions, 'transaction')} and ${plural(
      report.scannedPointers,
      'idempotency pointer',
    )} scanned`,
  )
  const pruned = report.transactions.length
  const dangling = report.pointers.filter((pointer) => pointer.reason === 'dangling').length
  ctx.out(
    `  ${plural(pruned, 'transaction')} pruned, ${plural(dangling, 'dangling pointer')} cleared`,
  )
  if (report.retainedHead !== null) {
    ctx.out(`  retained head  ${report.retainedHead}  (the manifest still names it)`)
  }
  for (const entry of report.transactions) {
    ctx.out(`  prune  r${entry.overlayRevisionAfter}  ${entry.transactionId}`)
  }
  for (const failure of report.failures) ctx.out(`  FAILED  ${failure.ref}  ${failure.reason}`)

  if (pruned > 0) {
    ctx.out('')
    ctx.out(
      `pruning the log discards the idempotency ledger for ${plural(pruned, 'transaction')}.`,
    )
    ctx.out(
      '  A retried request carrying one of those keys will re-apply rather than replay its',
    )
    ctx.out(
      '  original result (PRD §34.6), and `sanity-overlay history` loses those entries for',
    )
    ctx.out('  good — .runtime/ is not in Git and not in a checkpoint (PRD §14.1, §29.2).')
  }
}

export async function runCleanup(ctx: CommandContext, options: CleanupOptions): Promise<number> {
  const keepLast = numeric(options.keepLast, '--keep-last')
  const keepAfterRevision = numeric(options.keepAfterRevision, '--keep-after-revision')

  const opened = await openOverlay(ctx.root, ctx.now)
  const dryRun = options.dryRun === true
  const applied = options.confirm === true && !dryRun

  const window = {
    ...(keepLast === undefined ? {} : {keepLast}),
    ...(keepAfterRevision === undefined ? {} : {keepAfterRevision}),
  }

  const orphans = await opened.store.collectOrphans(opened.overlayId, {dryRun: !applied})
  const history = await opened.store.pruneRuntimeHistory(opened.overlayId, {
    ...window,
    dryRun: !applied,
  })

  const report = {
    overlayId: opened.overlayId,
    confirmed: options.confirm === true,
    dryRun,
    applied,
    orphans: {
      scanned: orphans.scanned,
      candidates: orphans.orphans,
      deleted: orphans.deleted,
      failures: orphans.failures,
    },
    runtimeHistory: {
      scannedTransactions: history.scannedTransactions,
      scannedPointers: history.scannedPointers,
      transactions: history.transactions,
      pointers: history.pointers,
      retainedHead: history.retainedHead,
      failures: history.failures,
    },
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    ctx.out(field('overlay', opened.overlayId))
    ctx.out(field('mode', applied ? 'applied' : 'report only'))
    ctx.out('')
    renderOrphans(ctx, orphans, applied)
    renderHistory(ctx, history)
    if (keepLast === undefined && keepAfterRevision === undefined) {
      ctx.out('')
      ctx.out(
        'the transaction log is retained: pass --keep-last <n> or --keep-after-revision <n>',
      )
      ctx.out('  to prune it. Dangling pointers are cleared regardless.')
    }
  }

  if (applied) return EXIT.OK
  if (dryRun) return EXIT.OK

  const removable = orphans.orphans.length + history.transactions.length + history.pointers.length
  throw confirmationRequired(
    `cleanup would remove ${plural(removable, 'artifact')}. Rerun with --confirm to proceed, or --dry-run to see this report without the refusal.`,
    {
      orphans: orphans.orphans.length,
      transactions: history.transactions.length,
      pointers: history.pointers.length,
    },
  )
}
