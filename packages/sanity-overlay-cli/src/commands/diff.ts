/**
 * `diff` — what this branch changed versus its base, per document and per path.
 *
 * Per perspective, because a draft and a published version can have different
 * ancestors (PRD §13.3): collapsing them would attribute a draft-only edit to
 * the published document. The diff engine itself is `../diff.ts`.
 */
import {toPublishedId} from '../../../sanity-overlay-core/src/index'
import {EXIT} from '../exit'
import {diffValues, type DiffEntry} from '../diff'
import {loadRecords, openOverlay, requireHead, sortedHeads} from '../overlay'
import {VERSION_KINDS, ancestorFor, localVersion, tombstoned, type VersionKind} from '../records'
import {inline} from '../render'
import type {CommandContext} from '../types'

export interface DiffOptions {
  readonly document?: string
  readonly nameOnly?: boolean
  readonly exitCode?: boolean
  readonly system?: boolean
}

interface DiffDocument {
  readonly logicalId: string
  readonly schemaType: string
  readonly state: string
  readonly perspectives: Partial<Record<VersionKind, DiffEntry[]>>
  /** Present when the branch record could not be read; entries are then absent. */
  readonly unreadable?: string
}

const SYMBOL: Record<string, string> = {added: '+', removed: '-', changed: '~'}

export async function runDiff(ctx: CommandContext, options: DiffOptions): Promise<number> {
  const opened = await openOverlay(ctx.root, ctx.now)
  if (options.document !== undefined) requireHead(opened.manifest, options.document)

  const wanted = options.document === undefined ? null : toPublishedId(options.document)
  const loaded = await loadRecords(opened)
  const heads = sortedHeads(opened.manifest).filter(
    (head) => wanted === null || head.logicalId === wanted,
  )

  const documents: DiffDocument[] = []
  for (const head of heads) {
    const record = loaded.records[head.logicalId]
    if (record === undefined) {
      const failure = loaded.unreadable.find((entry) => entry.logicalId === head.logicalId)
      documents.push({
        logicalId: head.logicalId,
        schemaType: head.schemaType,
        state: head.state,
        perspectives: {},
        unreadable: failure?.message ?? 'record unavailable',
      })
      continue
    }

    const perspectives: Partial<Record<VersionKind, DiffEntry[]>> = {}
    for (const kind of VERSION_KINDS) {
      const local = localVersion(record, kind)
      if (tombstoned(record, kind)) {
        perspectives[kind] = []
        continue
      }
      if (local === null) continue
      perspectives[kind] = diffValues(
        ancestorFor(record, local) ?? undefined,
        local.materialized ?? undefined,
        {system: options.system === true},
      )
    }

    documents.push({
      logicalId: record.logicalId,
      schemaType: record.schemaType,
      state: head.state,
      perspectives,
    })
  }

  const changed = documents.filter(
    (doc) =>
      doc.state !== 'unchanged' ||
      Object.values(doc.perspectives).some((entries) => (entries?.length ?? 0) > 0),
  )

  ctx.emitJson({overlayId: opened.overlayId, documents})

  if (!ctx.json) {
    if (options.nameOnly === true) {
      for (const doc of changed) ctx.out(doc.logicalId)
    } else {
      for (const doc of documents) {
        ctx.out(`${doc.state}  ${doc.logicalId}  (${doc.schemaType})`)
        if (doc.unreadable !== undefined) {
          ctx.out(`  ! ${doc.unreadable}`)
          continue
        }
        for (const kind of VERSION_KINDS) {
          const entries = doc.perspectives[kind]
          if (entries === undefined || entries.length === 0) continue
          ctx.out(`  ${kind}`)
          for (const entry of entries) {
            ctx.out(`    ${SYMBOL[entry.kind] ?? '?'} ${entry.path}`)
            if (entry.kind !== 'added') ctx.out(`      - ${inline(entry.before)}`)
            if (entry.kind !== 'removed') ctx.out(`      + ${inline(entry.after)}`)
          }
        }
      }
    }
  }

  if (options.exitCode === true && changed.length > 0) return EXIT.FINDINGS
  return EXIT.OK
}
