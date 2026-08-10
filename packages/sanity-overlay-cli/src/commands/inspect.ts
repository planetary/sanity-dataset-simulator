/**
 * `inspect` — the manifest and its document heads, or one document in detail.
 *
 * `--document` normalizes a `drafts.` prefix first (PRD §13.3, §18.2): draft and
 * published state of one logical document share a record, so
 * `inspect --document drafts.x` and `inspect --document x` must be the same
 * question, not two.
 */
import {toPublishedId} from 'sanity-overlay-core'
import type {OverlayDocumentRecord} from 'sanity-overlay-core'
import {overlayError} from '../errors'
import {EXIT} from '../exit'
import {openOverlay, requireHead, sortedHeads} from '../overlay'
import {ancestorRevisionFor, VERSION_KINDS, localVersion, tombstoned} from '../records'
import {formatPath, table} from '../render'
import {renderStatus, statusReport} from './status'
import type {CommandContext} from '../types'

export interface InspectOptions {
  readonly document?: string
}

function documentDetail(record: OverlayDocumentRecord, state: string): Record<string, unknown> {
  const perspectives: Record<string, unknown> = {}
  for (const kind of VERSION_KINDS) {
    const local = localVersion(record, kind)
    perspectives[kind] =
      local === null
        ? null
        : {
            ancestorKind: local.ancestorKind,
            ancestorRevision: ancestorRevisionFor(record, local),
            overlayRevision: local.overlayRevision,
            touchedPaths: local.touchedPaths.map(formatPath).sort(),
            operations: local.operations.length,
            createdAt: local.createdAt,
            updatedAt: local.updatedAt,
          }
  }

  return {
    logicalId: record.logicalId,
    schemaType: record.schemaType,
    origin: record.origin,
    state,
    runtimeRevision: record.runtimeRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tombstones: {
      draft: tombstoned(record, 'draft'),
      published: tombstoned(record, 'published'),
    },
    base:
      record.base === null
        ? null
        : {
            firstTouchedAt: record.base.firstTouchedAt,
            baseStatus: record.base.baseStatus,
            publishedRevision: record.base.published?.revision ?? null,
            draftRevision: record.base.draft?.revision ?? null,
          },
    conflicts: record.conflicts.map((conflict) => ({
      id: conflict.id,
      type: conflict.type,
      severity: conflict.severity,
      path: conflict.path === undefined ? null : formatPath(conflict.path),
      resolved: conflict.resolution !== undefined,
    })),
    ...perspectives,
  }
}

export async function runInspect(ctx: CommandContext, options: InspectOptions): Promise<number> {
  const opened = await openOverlay(ctx.root, ctx.now)

  if (options.document !== undefined) {
    const head = requireHead(opened.manifest, options.document)
    const logicalId = toPublishedId(options.document)
    const read = await opened.store.readDocumentByLogicalId(opened.overlayId, logicalId)
    if (!read?.record) {
      throw overlayError(
        `Document ${logicalId} has a manifest head but no readable immutable revision; .runtime/ was never written or has been pruned`,
        'OVERLAY_RECORD_ABSENT',
        {logicalId},
      )
    }
    const detail = documentDetail(read.record, head.state)
    ctx.emitJson(detail)
    if (!ctx.json) {
      ctx.out(`${head.state}  ${read.record.logicalId}  (${read.record.schemaType})`)
      for (const kind of VERSION_KINDS) {
        const local = localVersion(read.record, kind)
        if (local === null) continue
        ctx.out(`  ${kind}  ancestor ${local.ancestorKind}`)
        for (const path of local.touchedPaths.map(formatPath).sort()) ctx.out(`    ${path}`)
      }
    }
    return EXIT.OK
  }

  const heads = sortedHeads(opened.manifest)
  const report = {
    ...statusReport(opened.manifest),
    documents: heads.map((head) => ({
      logicalId: head.logicalId,
      schemaType: head.schemaType,
      state: head.state,
      runtimeRevision: head.runtimeRevision,
      checksum: head.checksum,
      storageRef: head.storageRef,
      updatedAt: head.updatedAt,
      hasDraft: head.hasDraft,
      hasPublished: head.hasPublished,
      hasConflict: head.hasConflict,
    })),
  }
  ctx.emitJson(report)

  if (!ctx.json) {
    for (const line of renderStatus(statusReport(opened.manifest))) ctx.out(line)
    ctx.out('')
    const rows: string[][] = [['STATE', 'DOCUMENT', 'TYPE', 'REVISION', 'CONFLICT']]
    for (const head of heads) {
      rows.push([
        head.state,
        head.logicalId,
        head.schemaType,
        head.runtimeRevision,
        head.hasConflict ? 'yes' : '-',
      ])
    }
    for (const line of table(rows)) ctx.out(line)
  }

  /* Document records are deliberately not opened here: `inspect` reports the
   * manifest's view, and a document whose record is unreadable is `validate`'s
   * finding, not a reason for `inspect` to fail. */
  return EXIT.OK
}
