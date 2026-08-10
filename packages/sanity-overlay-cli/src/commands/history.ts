/**
 * `history` — what this branch did, in order (PRD §13.10, §14.1
 * `.runtime/transactions/`, §37 Phase 2 "Local runtime history").
 *
 * ## What it is, said plainly
 *
 * The overlay writes an immutable §13.10 transaction record per commit. This
 * command reads that log back: one row per transaction, in commit order, naming
 * the actor, the overlay revision transition, the documents touched, and whether
 * the immutable revision each step produced can still be read off disk.
 *
 * ## What it is NOT
 *
 * It is not Sanity's document History. Studio's timeline is a Content Lake
 * mendoza revision stream that this system cannot reproduce and deliberately
 * disables (PRD §21.10) — there is no per-field time travel here, and no
 * "restore to this revision" button behind these rows.
 *
 * It is also not durable. §14.1 keeps `.runtime/` out of Git and §29.2 keeps the
 * transaction log out of a checkpoint, on purpose: a checkpoint exports semantic
 * intent, not an autosave stream. So a fresh clone, or an overlay restored from a
 * checkpoint tree, legitimately has no history — and this command says
 * `NOT RETAINED` rather than printing an empty list that would read as "this
 * branch changed nothing".
 */
import type {OverlayHistoryEntry} from 'sanity-overlay-store-fs'
import {usageError} from '../errors'
import {EXIT} from '../exit'
import {openOverlay} from '../overlay'
import {field, plural, table, toJson} from '../render'
import type {CommandContext} from '../types'

export interface HistoryOptions {
  readonly document?: string
  readonly limit?: string
  readonly since?: string
  readonly order?: string
  /** Print the §13.7 operations each transaction applied. */
  readonly mutations?: boolean
}

/** Parse a numeric option strictly: a typo must not silently mean "no limit". */
function numeric(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw usageError(
      `history ${flag} expects a non-negative integer, received ${JSON.stringify(raw)}`,
      {flag, value: raw},
    )
  }
  return value
}

function summarize(entry: OverlayHistoryEntry): Record<string, unknown> {
  const {transaction} = entry
  return {
    transactionId: transaction.transactionId,
    overlayRevisionBefore: transaction.overlayRevisionBefore,
    overlayRevisionAfter: transaction.overlayRevisionAfter,
    requestedAt: transaction.requestedAt,
    committedAt: transaction.committedAt,
    actor: transaction.actor,
    idempotencyKey: transaction.idempotencyKey,
    affectedDocumentIds: transaction.affectedDocumentIds,
    removedDocumentIds: entry.removedDocumentIds,
    recoverable: entry.recoverable,
    artifacts: entry.artifacts,
  }
}

export async function runHistory(ctx: CommandContext, options: HistoryOptions): Promise<number> {
  if (options.order !== undefined && options.order !== 'newest' && options.order !== 'oldest') {
    throw usageError(
      `history --order expects "newest" or "oldest", received ${JSON.stringify(options.order)}`,
      {order: options.order},
    )
  }

  const limit = numeric(options.limit, '--limit')
  const since = numeric(options.since, '--since')

  const opened = await openOverlay(ctx.root, ctx.now)
  const entries = await opened.store.readHistory(opened.overlayId, {
    ...(options.document === undefined ? {} : {documentId: options.document}),
    ...(since === undefined ? {} : {sinceRevision: since}),
    ...(limit === undefined ? {} : {limit}),
    ...(options.order === 'oldest' ? {order: 'oldest' as const} : {}),
  })

  /* Retention is a property of the LOG, not of the current filter: asking for
   * one document and getting nothing is not the same finding as the log having
   * been dropped. Probed unfiltered so a filter can never fake either answer. */
  const anyRetained = await opened.store.readHistory(opened.overlayId, {limit: 1})
  const retained = anyRetained.length > 0 || opened.manifest.revision === 0

  const report = {
    overlayId: opened.overlayId,
    revision: opened.manifest.revision,
    retained,
    count: entries.length,
    entries: entries.map(summarize),
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    ctx.out(field('overlay', opened.overlayId))
    ctx.out(field('revision', String(opened.manifest.revision)))
    ctx.out(field('transactions', plural(entries.length, 'entry', 'entries')))
    ctx.out('')

    if (entries.length > 0) {
      for (const line of table([
        ['REVISION', 'TRANSACTION', 'COMMITTED', 'ACTOR', 'DOCUMENTS', 'CONTENT'],
        ...entries.map((entry) => [
          `${entry.transaction.overlayRevisionBefore}->${entry.transaction.overlayRevisionAfter}`,
          entry.transaction.transactionId,
          entry.transaction.committedAt,
          `${entry.transaction.actor.type}:${entry.transaction.actor.id}`,
          entry.transaction.affectedDocumentIds.join(' ') || '-',
          entry.recoverable
            ? 'readable'
            : entry.artifacts.length === 0
              ? 'removal'
              : 'pruned',
        ]),
      ])) {
        ctx.out(line)
      }
    }

    if (options.mutations === true) {
      for (const entry of entries) {
        ctx.out('')
        ctx.out(`${entry.transaction.transactionId}  mutations`)
        for (const mutation of entry.transaction.mutations) ctx.out(`  ${toJson(mutation).trim()}`)
      }
    }

    if (!retained) {
      ctx.out('')
      ctx.out(
        `history NOT RETAINED — this overlay is at revision ${opened.manifest.revision} but no`,
      )
      ctx.out(
        '  transaction log is stored. .sanity-overlay/.runtime/ is generated, gitignored and',
      )
      ctx.out(
        '  excluded from checkpoints (PRD §14.1, §29.2), so a fresh clone or a checkpoint',
      )
      ctx.out(
        '  import legitimately arrives without one. The branch state itself is intact —',
      )
      ctx.out('  see `sanity-overlay diff` and `sanity-overlay inspect`.')
    } else if (entries.length === 0) {
      ctx.out('no transactions match.')
    }
  }

  return EXIT.OK
}
