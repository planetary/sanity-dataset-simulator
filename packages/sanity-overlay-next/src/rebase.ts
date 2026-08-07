/**
 * §17 / §28.4 / §28.5 rebase, as the local API performs it.
 *
 * WHAT THIS FILE OWNS: assembling core's inputs from a stored §13.3 record, and
 * assembling the next record from core's outputs. It owns no merge semantics —
 * `autoRebase` and `applyRebaseMode` decide everything, exactly as they do for
 * `sanity-overlay rebase`, and the two must not drift.
 *
 * WHY THE CALLER SUPPLIES THE CURRENT BASE.
 *
 * `autoRebase` needs the base document as it stands NOW, and neither core (§16.1
 * — core never fetches base) nor this server holds a Sanity credential. The CLI
 * refuses to run without `--base` for exactly this reason rather than assuming
 * the base has not moved; this endpoint refuses in the same way. A rebase
 * performed against an assumed-unchanged base is not a rebase, it is a
 * revision-number bump that tells the editor their branch is current when it is
 * not — the silent approximation §5.5 forbids.
 *
 * ONE TRANSACTION FOR THE WHOLE RUN, matching the CLI: `commitTransaction` with
 * an empty mutation list and the full post-state records. The record IS the
 * payload; there is no mutation that spells "the ancestor moved".
 */
import {
  applyRebaseMode,
  applySyntheticSystemFields,
  autoRebase,
  canonicalEquals,
} from '../../sanity-overlay-core/src/index'
import type {
  AutoRebaseRequest,
  LocalDocumentVersion,
  OverlayActor,
  OverlayDocumentRecord,
  RebaseMode,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'

export type StudioRebaseMode = RebaseMode | 'auto'

type VersionKind = 'draft' | 'published'

/** One document's outcome, in the shape `operations.ts` `readRebaseOutcome` reads. */
export interface RebaseDocumentOutcome {
  logicalId: string
  applied: boolean
  blockedBy: string[]
  /** Present when the document was passed over rather than evaluated. */
  skipped?: string
  perspective?: VersionKind
  removedTouchedPaths?: string[]
  ancestorRevisionBefore?: string | null
  ancestorRevisionAfter?: string | null
}

export interface RebaseRunResult {
  outcomes: RebaseDocumentOutcome[]
  /** The post-state records to persist. Empty ⇒ nothing to commit. */
  records: OverlayDocumentRecord[]
}

/* ---------------------------------------------------------------- *
 * Reading a §13.3 record the way §17.1 means it
 *
 * Transcribed from `sanity-overlay-cli/src/records.ts`, which is the same
 * reading `sanity-overlay rebase` uses. It lives in the CLI's private module
 * rather than in core, and a server importing across that package boundary
 * would couple the API to a command-line tool; the four functions are five
 * lines each, so they are re-derived rather than reached for.
 * ---------------------------------------------------------------- */

function localVersion(
  record: OverlayDocumentRecord,
  kind: VersionKind,
): LocalDocumentVersion | null {
  return kind === 'draft' ? record.local.draft : record.local.published
}

function tombstoned(record: OverlayDocumentRecord, kind: VersionKind): boolean {
  return kind === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone
}

/**
 * The perspective a rebase acts on. `autoRebase` evaluates ONE (ancestor, local)
 * pair while the §13.3 base block is shared by both, so one has to be chosen;
 * the draft wins because that is where Studio editing lands, and the choice is
 * reported back in the outcome rather than left implicit.
 */
function primaryVersion(record: OverlayDocumentRecord): VersionKind | null {
  if (record.local.draft !== null) return 'draft'
  if (record.local.published !== null) return 'published'
  return null
}

function ancestorFor(
  record: OverlayDocumentRecord,
  local: LocalDocumentVersion,
): SanityDocument | null {
  switch (local.ancestorKind) {
    case 'base-published':
      return record.base?.published?.snapshot ?? null
    case 'base-draft':
      return record.base?.draft?.snapshot ?? null
    case 'local-published':
      return record.local.published?.materialized ?? null
    default:
      return null
  }
}

function ancestorRevisionFor(
  record: OverlayDocumentRecord,
  local: LocalDocumentVersion,
): string | null {
  if (local.ancestorRevision !== undefined) return local.ancestorRevision
  switch (local.ancestorKind) {
    case 'base-published':
      return record.base?.published?.revision ?? null
    case 'base-draft':
      return record.base?.draft?.revision ?? null
    default:
      return null
  }
}

function withLocal(
  record: OverlayDocumentRecord,
  kind: VersionKind,
  local: LocalDocumentVersion | null,
): OverlayDocumentRecord['local'] {
  return kind === 'draft' ? {...record.local, draft: local} : {...record.local, published: local}
}

/* ---------------------------------------------------------------- */

export interface RebaseRunOptions {
  mode: StudioRebaseMode
  records: readonly OverlayDocumentRecord[]
  /** The base as it stands now, keyed by logical id. */
  currentBase: ReadonlyMap<string, SanityDocument>
  overlayRevision: number
  now: string
  actor: OverlayActor
  transactionId: (logicalId: string) => string
  /** §28.4 operator selection; omitted means "every touched path". */
  paths?: readonly string[]
}

/**
 * Run one rebase over a set of records. PURE — nothing here writes.
 *
 * A document with no base block is SKIPPED rather than reported blocked: a
 * branch-created document has no merge ancestor, so there is nothing for a
 * rebase to replace, and feeding it to `autoRebase` would report the whole run
 * blocked on a document that was never in scope.
 */
export function runRebase(options: RebaseRunOptions): RebaseRunResult {
  const outcomes: RebaseDocumentOutcome[] = []
  const records: OverlayDocumentRecord[] = []

  for (const record of options.records) {
    if (record.base === null) {
      outcomes.push({
        logicalId: record.logicalId,
        applied: false,
        blockedBy: [],
        skipped: 'branch-created document has no merge ancestor to rebase (PRD §17.2)',
      })
      continue
    }

    const kind = primaryVersion(record)
    if (kind === null) {
      outcomes.push({
        logicalId: record.logicalId,
        applied: false,
        blockedBy: [],
        skipped: 'document has no local version to rebase',
      })
      continue
    }

    const local = localVersion(record, kind)
    /* `primaryVersion` already proved one exists; this narrows for the compiler
     * without a non-null assertion. */
    if (local === null) continue

    const currentBase = options.currentBase.get(record.logicalId) ?? null
    const ancestorRevision = ancestorRevisionFor(record, local)

    const request: AutoRebaseRequest = {
      documentId: record.logicalId,
      now: options.now,
      transactionId: options.transactionId(record.logicalId),
      actor: options.actor,
      ancestor: ancestorFor(record, local),
      currentBase,
      localMaterialized: local.materialized,
      localTouchedPaths: local.touchedPaths,
      operations: local.operations,
      baseBlock: record.base,
      origin: record.origin,
      localTombstone: tombstoned(record, kind),
      ...(record.base?.baseStatus === undefined ? {} : {baseStatus: record.base.baseStatus}),
      ...(ancestorRevision === null ? {} : {ancestorRevision}),
      ...(typeof currentBase?._rev === 'string' ? {currentBaseRevision: currentBase._rev} : {}),
    }

    const auto = options.mode === 'auto'
    const result = auto
      ? autoRebase(request)
      : applyRebaseMode({
          ...request,
          mode: options.mode as RebaseMode,
          ...(options.paths === undefined
            ? {}
            : {paths: options.paths.map((path) => path as never)}),
        })

    const applied = auto ? (result as ReturnType<typeof autoRebase>).applied : result.audit !== null
    const blockedBy = auto ? [...(result as ReturnType<typeof autoRebase>).blockedBy] : []

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
                overlayRevision: options.overlayRevision + 1,
                now: options.now,
                ...(materialized._createdAt === undefined
                  ? {}
                  : {createdAt: materialized._createdAt}),
              })
            : materialized,
          touchedPaths: result.touchedPaths,
          updatedAt: options.now,
        }
      }
      let next: OverlayDocumentRecord = {
        ...record,
        base: result.baseBlock,
        local: withLocal(record, kind, nextLocal),
        updatedAt: options.now,
        updatedBy: options.actor,
      }
      if (nextLocal !== null && nextLocal.materialized._rev !== undefined) {
        next = {...next, runtimeRevision: nextLocal.materialized._rev}
      }
      records.push(next)
    }

    outcomes.push({
      logicalId: record.logicalId,
      applied,
      blockedBy,
      perspective: kind,
      removedTouchedPaths: result.removedTouchedPaths.map((path) => path.join('.')),
      ancestorRevisionBefore: result.audit?.ancestorRevisionBefore ?? null,
      ancestorRevisionAfter: result.audit?.ancestorRevisionAfter ?? null,
    })
  }

  return {outcomes, records}
}
