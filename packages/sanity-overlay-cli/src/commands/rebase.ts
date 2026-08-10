/**
 * `rebase` — PRD §28.5 automatic rebase and §28.4 rebase modes.
 *
 * Three deliberate constraints:
 *
 * 1. **`--base` is required.** A rebase replaces the merge ancestor with the
 *    CURRENT base document, and in `fs` mode nothing is talking to the Content
 *    Lake. Guessing "the base has not moved" would silently produce a rebase
 *    that changed nothing while claiming it did, so the command refuses instead.
 * 2. **It is destructive, so `--confirm` is mandatory.** The audit report is
 *    printed either way; without `--confirm` nothing is written.
 * 3. **Blocked preconditions exit FINDINGS and write nothing at all** — not even
 *    for the documents that would have succeeded. A partially rebased overlay
 *    is a worse state to be in than an un-rebased one, and §28.5 step 4 wants
 *    one audit transaction per rebase.
 *
 * The chosen perspective is reported per document, because core's `autoRebase`
 * evaluates one (ancestor, local) pair while the §13.3 base block it replaces is
 * shared. Draft wins when present; see `../records.ts`.
 */
import {readFile} from 'node:fs/promises'
import {
  REBASE_MODES,
  applyRebaseMode,
  applySyntheticSystemFields,
  autoRebase,
  canonicalEquals,
  createBaseSource,
  currentBaseForAncestor,
} from 'sanity-overlay-core'
import type {
  AutoRebaseRequest,
  BaseDocumentSource,
  LocalDocumentVersion,
  OverlayActor,
  OverlayDocumentRecord,
  RebaseMode,
  SanityDocument,
} from 'sanity-overlay-core'
import {confirmationRequired, usageError} from '../errors'
import {EXIT} from '../exit'
import {loadRecords, openOverlay, requireHead, sortedHeads} from '../overlay'
import {
  ancestorFor,
  ancestorRevisionFor,
  localVersion,
  primaryVersion,
  tombstoned,
  type VersionKind,
} from '../records'
import {formatPath, plural, table} from '../render'
import type {CommandContext} from '../types'

export interface RebaseOptions {
  readonly document?: string
  /** Path to a JSON file holding the CURRENT base documents. Required. */
  readonly base?: string
  readonly mode?: string
  readonly confirm?: boolean
  readonly dryRun?: boolean
}

const REBASE_ACTOR: OverlayActor = {
  type: 'agent',
  id: 'sanity-overlay-cli',
  displayName: 'sanity-overlay CLI',
}

const MODES: readonly string[] = ['auto', ...REBASE_MODES]

/**
 * Read `--base` as an array of documents, or as an `{id: document}` map.
 *
 * THE RESULT IS PERSPECTIVE-AWARE, not a single map keyed by id. This used to
 * return `Map<_id, document>` and the caller only ever looked up the PUBLISHED
 * address, so a base draft supplied in the file was silently ignored — including
 * for a record whose §17.1 ancestor was captured from the base draft, which is
 * every record whose document had an unpublished draft when the branch first
 * touched it. `createBaseSource` keeps the two addresses apart and
 * `currentBaseForAncestor` picks the one the record's `ancestorKind` names; the
 * same pair of functions the overlay API's rebase endpoint uses, so the CLI and
 * the endpoint cannot answer differently.
 */
async function readBaseDocuments(path: string): Promise<BaseDocumentSource> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw usageError(`--base file ${path} could not be read`, {path})
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw usageError(
      `--base file ${path} is not valid JSON: ${(error as Error).message}`,
      {path},
    )
  }
  const documents =
    Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : null
  if (documents === null) {
    throw usageError(`--base file ${path} must hold an array of documents or an id→document map`, {
      path,
    })
  }
  const usable: SanityDocument[] = []
  for (const document of documents) {
    if (document === null || typeof document !== 'object') continue
    const candidate = document as SanityDocument
    /* `createBaseSource` throws on a missing `_rev` (§13.4) with a bare Error.
     * Skipping here keeps the CLI's own refusal — "no current base for X" —
     * as the message the operator sees, rather than a stack from core. */
    if (typeof candidate._id !== 'string') continue
    if (typeof candidate._rev !== 'string' || candidate._rev.length === 0) continue
    usable.push(candidate)
  }
  return createBaseSource(usable)
}

interface RebaseOutcome {
  readonly logicalId: string
  readonly perspective: VersionKind | null
  readonly applied: boolean
  readonly blockedBy: readonly string[]
  readonly preconditions: readonly {id: string; satisfied: boolean; detail?: string}[]
  readonly removedTouchedPaths: readonly string[]
  readonly ancestorRevisionBefore: string | null
  readonly ancestorRevisionAfter: string | null
  readonly skipped?: string
  readonly record?: OverlayDocumentRecord
}

function withLocal(
  record: OverlayDocumentRecord,
  kind: VersionKind,
  local: LocalDocumentVersion | null,
): OverlayDocumentRecord['local'] {
  return kind === 'draft' ? {...record.local, draft: local} : {...record.local, published: local}
}

export async function runRebase(ctx: CommandContext, options: RebaseOptions): Promise<number> {
  const mode = options.mode ?? 'auto'
  if (!MODES.includes(mode)) {
    throw usageError(
      `Unknown --mode ${JSON.stringify(mode)}; expected one of ${MODES.join(', ')}`,
      {mode},
    )
  }
  if (options.base === undefined) {
    throw usageError(
      'rebase requires --base <file.json> holding the CURRENT base documents. In fs mode the CLI has no connection to the base dataset and will not assume the base has not moved.',
    )
  }

  const baseById = await readBaseDocuments(options.base)
  const opened = await openOverlay(ctx.root, ctx.now)
  if (options.document !== undefined) requireHead(opened.manifest, options.document)

  const wanted =
    options.document === undefined
      ? null
      : requireHead(opened.manifest, options.document).logicalId
  const loaded = await loadRecords(opened)
  const heads = sortedHeads(opened.manifest).filter(
    (head) => wanted === null || head.logicalId === wanted,
  )

  const now = ctx.now()
  const outcomes: RebaseOutcome[] = []

  for (const head of heads) {
    const record = loaded.records[head.logicalId]
    if (record === undefined) {
      outcomes.push({
        logicalId: head.logicalId,
        perspective: null,
        applied: false,
        blockedBy: [],
        preconditions: [],
        removedTouchedPaths: [],
        ancestorRevisionBefore: null,
        ancestorRevisionAfter: null,
        skipped: 'no readable branch record',
      })
      continue
    }

    if (record.base === null) {
      /* A branch-created document has no merge ancestor, so there is nothing for
       * a rebase to replace. Feeding it to `autoRebase` would report it blocked
       * and take the whole run down with it. */
      outcomes.push({
        logicalId: head.logicalId,
        perspective: null,
        applied: false,
        blockedBy: [],
        preconditions: [],
        removedTouchedPaths: [],
        ancestorRevisionBefore: null,
        ancestorRevisionAfter: null,
        skipped: 'branch-created document has no merge ancestor to rebase',
      })
      continue
    }

    const kind = primaryVersion(record)
    if (kind === null) {
      outcomes.push({
        logicalId: head.logicalId,
        perspective: null,
        applied: false,
        blockedBy: [],
        preconditions: [],
        removedTouchedPaths: [],
        ancestorRevisionBefore: null,
        ancestorRevisionAfter: null,
        skipped: 'document has no local version to rebase',
      })
      continue
    }

    const local = localVersion(record, kind)!
    const currentBase = currentBaseForAncestor(baseById, record.logicalId, local.ancestorKind)
    const request: AutoRebaseRequest = {
      documentId: record.logicalId,
      now,
      transactionId: `cli-rebase-r${opened.manifest.revision}-${record.logicalId}`,
      actor: REBASE_ACTOR,
      ancestor: ancestorFor(record, local),
      currentBase,
      localMaterialized: local.materialized,
      localTouchedPaths: local.touchedPaths,
      operations: local.operations,
      baseBlock: record.base,
      origin: record.origin,
      localTombstone: tombstoned(record, kind),
      ...(record.base?.baseStatus === undefined ? {} : {baseStatus: record.base.baseStatus}),
      ...(ancestorRevisionFor(record, local) === null
        ? {}
        : {ancestorRevision: ancestorRevisionFor(record, local)!}),
      ...(typeof currentBase?._rev === 'string' ? {currentBaseRevision: currentBase._rev} : {}),
    }

    const result =
      mode === 'auto'
        ? autoRebase(request)
        : applyRebaseMode({...request, mode: mode as RebaseMode})

    const applied = mode === 'auto' ? (result as ReturnType<typeof autoRebase>).applied : result.audit !== null
    const blockedBy =
      mode === 'auto' ? [...(result as ReturnType<typeof autoRebase>).blockedBy] : []
    const preconditions =
      mode === 'auto'
        ? (result as ReturnType<typeof autoRebase>).preconditions.map((entry) => ({
            id: entry.id,
            satisfied: entry.satisfied,
            ...(entry.detail === undefined ? {} : {detail: entry.detail}),
          }))
        : []

    let nextRecord: OverlayDocumentRecord | undefined
    if (applied) {
      const materialized = result.localMaterialized
      let nextLocal: LocalDocumentVersion | null = null
      if (materialized !== null) {
        const changed = !canonicalEquals(materialized, local.materialized)
        nextLocal = {
          ...local,
          /* A mode that adopts base values produces a NEW document, so the §13.9
           * synthetic `_rev` is restamped from its content. Carrying the old one
           * would leave the record claiming a revision its content no longer
           * hashes to. */
          materialized: changed
            ? applySyntheticSystemFields({
                document: materialized,
                documentId: materialized._id ?? record.logicalId,
                overlayRevision: opened.manifest.revision + 1,
                now,
                ...(materialized._createdAt === undefined
                  ? {}
                  : {createdAt: materialized._createdAt}),
              })
            : materialized,
          touchedPaths: result.touchedPaths,
          updatedAt: now,
        }
      }
      nextRecord = {
        ...record,
        base: result.baseBlock,
        local: withLocal(record, kind, nextLocal),
        updatedAt: now,
        updatedBy: REBASE_ACTOR,
      }
      if (nextLocal !== null && nextLocal.materialized._rev !== undefined) {
        nextRecord = {...nextRecord, runtimeRevision: nextLocal.materialized._rev}
      }
    }

    outcomes.push({
      logicalId: record.logicalId,
      perspective: kind,
      applied,
      blockedBy,
      preconditions,
      removedTouchedPaths: result.removedTouchedPaths.map(formatPath),
      ancestorRevisionBefore: result.audit?.ancestorRevisionBefore ?? null,
      ancestorRevisionAfter: result.audit?.ancestorRevisionAfter ?? null,
      ...(nextRecord === undefined ? {} : {record: nextRecord}),
    })
  }

  const blocked = outcomes.filter((outcome) => outcome.blockedBy.length > 0)
  const applicable = outcomes.filter((outcome) => outcome.record !== undefined)

  const report = {
    overlayId: opened.overlayId,
    mode,
    confirmed: options.confirm === true,
    dryRun: options.dryRun === true,
    applied: 0,
    blocked: blocked.length,
    documents: outcomes.map(({record: _record, ...rest}) => rest),
  }

  const emit = (appliedCount: number): void => {
    ctx.emitJson({...report, applied: appliedCount})
    if (ctx.json) return
    for (const line of table([
      ['DOCUMENT', 'PERSPECTIVE', 'RESULT', 'DETAIL'],
      ...outcomes.map((outcome) => [
        outcome.logicalId,
        outcome.perspective ?? '-',
        outcome.skipped !== undefined
          ? 'skipped'
          : outcome.blockedBy.length > 0
            ? 'blocked'
            : outcome.applied
              ? 'rebase'
              : 'no-op',
        outcome.skipped ?? (outcome.blockedBy.length > 0 ? outcome.blockedBy.join(', ') : '-'),
      ]),
    ])) {
      ctx.out(line)
    }
  }

  if (blocked.length > 0) {
    emit(0)
    if (!ctx.json) {
      ctx.out('')
      ctx.out(
        `${plural(blocked.length, 'document')} cannot be rebased automatically (PRD §28.5). Nothing was written; resolve with --mode accept-base or --mode keep-local.`,
      )
    }
    return EXIT.FINDINGS
  }

  if (options.confirm !== true) {
    emit(0)
    throw confirmationRequired(
      `rebase would replace the merge ancestor for ${plural(applicable.length, 'document')}. Rerun with --confirm, or --dry-run to see this report without the refusal.`,
      {documents: applicable.map((outcome) => outcome.logicalId)},
    )
  }

  if (options.dryRun === true || applicable.length === 0) {
    emit(0)
    return EXIT.OK
  }

  const records = applicable.map((outcome) => outcome.record!)
  await opened.store.commitTransaction(opened.overlayId, {
    idempotencyKey: `cli-rebase-r${opened.manifest.revision}-${mode}-${records
      .map((record) => record.logicalId)
      .join('.')}`,
    actor: REBASE_ACTOR,
    mutations: [],
    records,
    expectedOverlayRevision: opened.manifest.revision,
  })

  emit(records.length)
  return EXIT.OK
}
