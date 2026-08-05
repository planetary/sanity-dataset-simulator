/**
 * Batch virtual-document resolution (PRD §18.1, §18.2, §22.1) — workstream W3's
 * read surface.
 *
 * WHY A BATCH LAYER EXISTS AT ALL
 * `resolvePerspective` answers "what is the virtual view of *this* document".
 * Every read surface in a Studio asks the plural question — a list pane wants a
 * hundred IDs, a reference picker a handful, the pair listener exactly two — and
 * two facts only exist at the set level:
 *
 *   1. a **tombstoned** document must be *absent from the set*. Resolving it
 *      one-at-a-time and keeping the `null` in place would leave a hole where
 *      callers expect a document; dropping the base document is the whole point
 *      (§18.8), and a caller that renders "the base title, still" has silently
 *      shown content the branch deleted.
 *   2. a **branch-created** document must be *in the set* even though no base
 *      query would ever return its ID (§22.2 "add branch-created and modified
 *      candidates"). {@link overlayDocumentIds} is how a caller learns the IDs to
 *      ask for.
 *
 * PURITY (plan §3, PRD §16.1)
 * Nothing here fetches. Base documents arrive through the existing
 * {@link BaseDocumentSource} port, overlay records arrive as the §13.3 projection,
 * time arrives as `now`, and schema validation arrives as the injected §17.3
 * step 9 validator. There is no GROQ here either: turning a *query* into a set of
 * candidate IDs is the query layer's job (§22.6); this module answers only once
 * the IDs are known.
 */
import {toPublishedId, isDraftId} from '../encoding'
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayDocumentRecord} from '../types/record'
import type {MergeAbsence} from '../merge/types'
import type {MergeValidationIssue, MergeValidator} from '../merge/validation'
import {EMPTY_BASE_SOURCE, type BaseDocumentSource} from '../mutations/ports'
import {documentIdFor, type VersionKind} from '../mutations/state'
import {
  resolveDraftsPerspective,
  resolvePublishedPerspective,
  type PerspectiveBase,
  type PerspectiveRequest,
  type PerspectiveResolution,
  type PerspectiveSource,
} from '../perspectives/resolve'

/* ------------------------------------------------------------------ *
 * Request / response shapes
 * ------------------------------------------------------------------ */

/** The §13.3 record projection a read resolves against, keyed by logical ID. */
export type OverlayRecordMap = Readonly<Record<string, OverlayDocumentRecord>>

export interface BatchReadRequestBase {
  /**
   * Document IDs exactly as the caller addresses them. A `drafts.` prefix is
   * accepted and normalized: which *version* it selects depends on the entry
   * point ({@link resolveDocumentBatch} ignores it, {@link resolveVersionBatch}
   * obeys it).
   */
  ids: readonly string[]
  /** Injected clock stamped on any conflict the resolution raises (§13.11). */
  now: string
  records: OverlayRecordMap
  /** Read-only base view (§16.1). Defaults to "base holds nothing". */
  base?: BaseDocumentSource
  /** PRD §17.3 step 9 validation port. */
  validate?: MergeValidator
  /** §20.5 timing label handed to the validator. */
  validationAction?: string
}

export interface DocumentBatchRequest extends BatchReadRequestBase {
  perspective: 'published' | 'drafts'
}

export type VersionBatchRequest = BatchReadRequestBase

/**
 * Where the answer came from, in the vocabulary a *reader* cares about.
 *
 * `untouched` — the branch has no record at all; this is pure base passthrough.
 * `overlay`   — the branch holds a record for a document that exists in base.
 * `branch-created` — the branch invented the document (§17.2 precedence rule 2).
 */
export type BatchReadOrigin = 'untouched' | 'overlay' | 'branch-created'

export interface BatchReadEntry {
  /** The ID as the caller spelled it, so positional reads stay aligned. */
  requestedId: string
  /** Published (logical) form of {@link BatchReadEntry.requestedId} (§6). */
  logicalId: string
  /** The document ID the answered version is addressed by (PRD §13.9). */
  documentId: string
  /** The virtual document, or `null` when the overlay resolves it to nothing. */
  document: SanityDocument | null
  source: PerspectiveSource
  absence: MergeAbsence | null
  origin: BatchReadOrigin
  conflicts: OverlayConflict[]
  /** PRD §17.3 step 10 checksum of the resolved document. */
  checksum: string | null
  validation: readonly MergeValidationIssue[]
}

export interface BatchReadResult {
  /** `mixed` when each ID chose its own version ({@link resolveVersionBatch}). */
  perspective: 'published' | 'drafts' | 'mixed'
  /** One entry per requested ID, in request order, including repeats. */
  entries: BatchReadEntry[]
  /** The present documents only — what a caller feeds to a query evaluator. */
  documents: SanityDocument[]
  /** Requested IDs that resolve to no document (tombstoned or simply absent). */
  missing: string[]
  /** Every conflict raised while resolving, de-duplicated by conflict ID. */
  conflicts: OverlayConflict[]
}

/* ------------------------------------------------------------------ *
 * Shared resolution
 * ------------------------------------------------------------------ */

function baseFor(source: BaseDocumentSource, logicalId: string): PerspectiveBase {
  return {
    published: source.getPublished(logicalId)?.document ?? null,
    draft: source.getDraft(logicalId)?.document ?? null,
  }
}

function originOf(record: OverlayDocumentRecord | null): BatchReadOrigin {
  if (record === null) return 'untouched'
  return record.origin === 'branch' ? 'branch-created' : 'overlay'
}

function perspectiveRequest(
  request: BatchReadRequestBase,
  logicalId: string,
  source: BaseDocumentSource,
): PerspectiveRequest {
  return {
    logicalId,
    now: request.now,
    record: request.records[logicalId] ?? null,
    base: baseFor(source, logicalId),
    ...(request.validate === undefined ? {} : {validate: request.validate}),
    ...(request.validationAction === undefined ? {} : {validationAction: request.validationAction}),
  }
}

/**
 * Dispatch on the two *document-valued* perspectives.
 *
 * `resolvePerspective` also answers `raw`, whose §18.3 view is a synthetic
 * multi-version envelope with no single `document` — not a shape a batch read can
 * return. Calling the two typed resolvers directly keeps that impossible rather
 * than merely unlikely.
 */
function resolveOne(
  perspective: 'published' | 'drafts',
  request: PerspectiveRequest,
): PerspectiveResolution {
  return perspective === 'published'
    ? resolvePublishedPerspective(request)
    : resolveDraftsPerspective(request)
}

function entryFrom(
  requestedId: string,
  logicalId: string,
  version: VersionKind,
  record: OverlayDocumentRecord | null,
  resolution: PerspectiveResolution,
): BatchReadEntry {
  return {
    requestedId,
    logicalId,
    documentId: documentIdFor(logicalId, version),
    document: resolution.document,
    source: resolution.source,
    absence: resolution.absence,
    origin: originOf(record),
    conflicts: resolution.conflicts,
    checksum: resolution.checksum,
    validation: resolution.validation,
  }
}

/**
 * Collect entries into the shared result envelope.
 *
 * `conflicts` are de-duplicated by conflict ID rather than concatenated: the same
 * logical document may legitimately appear twice in one request (a repeated ID,
 * or both of its versions), and reporting one conflict twice would make a caller
 * that counts conflicts wrong.
 */
function collect(
  perspective: BatchReadResult['perspective'],
  entries: BatchReadEntry[],
): BatchReadResult {
  const documents: SanityDocument[] = []
  const missing: string[] = []
  const conflicts: OverlayConflict[] = []
  const seenConflicts = new Set<string>()

  for (const entry of entries) {
    if (entry.document === null) missing.push(entry.requestedId)
    else documents.push(entry.document)
    for (const conflict of entry.conflicts) {
      /* `OverlayConflict.id` (§13.11) — the identity, not `documentId`: one
       * document can hold several distinct conflicts at once. */
      if (seenConflicts.has(conflict.id)) continue
      seenConflicts.add(conflict.id)
      conflicts.push(conflict)
    }
  }

  return {perspective, entries, documents, missing, conflicts}
}

/* ------------------------------------------------------------------ *
 * §18.1 / §18.2 — perspective batch
 * ------------------------------------------------------------------ */

/**
 * Resolve a set of documents under **one** perspective (PRD §18.1, §18.2).
 *
 * This is the list-pane / query-candidate read: the caller has decided it is
 * looking at `published` or at `drafts`, and every ID answers in that
 * perspective, fallback chain and all. A `drafts.` prefix on a requested ID is
 * normalized away — the perspective, not the spelling, decides which version
 * answers.
 */
export function resolveDocumentBatch(request: DocumentBatchRequest): BatchReadResult {
  const source = request.base ?? EMPTY_BASE_SOURCE
  const version: VersionKind = request.perspective === 'drafts' ? 'draft' : 'published'

  const entries = request.ids.map((requestedId) => {
    const logicalId = toPublishedId(requestedId)
    const record = request.records[logicalId] ?? null
    const resolution = resolveOne(
      request.perspective,
      perspectiveRequest(request, logicalId, source),
    )
    return entryFrom(requestedId, logicalId, version, record, resolution)
  })

  return collect(request.perspective, entries)
}

/* ------------------------------------------------------------------ *
 * Concrete-version batch — `getDocument` / `getDocuments` semantics
 * ------------------------------------------------------------------ */

/**
 * Is a perspective resolution's answer actually a document of the version that
 * was asked for?
 *
 * §18.2's drafts perspective deliberately falls back to the published version
 * when no draft exists — correct for a *perspective* read, wrong for a *version*
 * read. `client.getDocument('drafts.x')` in hosted Sanity returns `null` when the
 * draft does not exist; it does not hand back the published document. Handing one
 * back would put an "unpublished changes" badge on a document that has none.
 */
function answersVersion(version: VersionKind, source: PerspectiveSource): boolean {
  if (version === 'published') return source === 'local-published' || source === 'base-published'
  return source === 'local-draft' || source === 'base-draft'
}

/** The reason a version read found nothing, when the perspective read found something. */
function versionAbsence(
  record: OverlayDocumentRecord | null,
  version: VersionKind,
): MergeAbsence {
  if (record === null) return 'missing'
  const tombstoned =
    version === 'draft' ? record.local.draftTombstone : record.local.publishedTombstone
  if (tombstoned) return 'tombstone'
  if (record.base?.baseStatus === 'deleted') return 'base-deleted'
  return 'missing'
}

/**
 * Resolve a set of documents **by the version their ID names** — `drafts.x` is
 * the draft, `x` is the published version (PRD §13.9).
 *
 * This is `getDocument` / `getDocuments` semantics: a raw addressed read, with no
 * §18.2 fallback between the two versions. The merge itself is still the full
 * §17.3 algorithm — only the fallback chain is suppressed.
 */
export function resolveVersionBatch(request: VersionBatchRequest): BatchReadResult {
  const source = request.base ?? EMPTY_BASE_SOURCE

  const entries = request.ids.map((requestedId) => {
    const logicalId = toPublishedId(requestedId)
    const version: VersionKind = isDraftId(requestedId) ? 'draft' : 'published'
    const record = request.records[logicalId] ?? null
    const resolution = resolveOne(
      version === 'draft' ? 'drafts' : 'published',
      perspectiveRequest(request, logicalId, source),
    )

    if (resolution.document !== null && !answersVersion(version, resolution.source)) {
      return entryFrom(requestedId, logicalId, version, record, {
        ...resolution,
        document: null,
        source: 'none',
        absence: versionAbsence(record, version),
        checksum: null,
      })
    }

    return entryFrom(requestedId, logicalId, version, record, resolution)
  })

  return collect('mixed', entries)
}

/* ------------------------------------------------------------------ *
 * Candidate discovery
 * ------------------------------------------------------------------ */

export interface OverlayDocumentIdOptions {
  /** Restrict to these schema types (§13.3 `schemaType`). Absent means every type. */
  types?: readonly string[]
  /**
   * Include documents whose every version is tombstoned. Off by default: such a
   * document can only ever *shrink* a result set, never widen one, and the caller
   * that needs it removed already learns that from its own base query.
   */
  includeFullyTombstoned?: boolean
}

/**
 * The logical IDs the overlay holds, sorted — how a caller learns that a
 * branch-created document exists (PRD §22.2 "add branch-created and modified
 * candidates").
 *
 * Sorted rather than insertion-ordered so the answer is a deterministic function
 * of the record set, not of the order transactions happened to arrive in.
 */
export function overlayDocumentIds(
  records: OverlayRecordMap,
  options: OverlayDocumentIdOptions = {},
): string[] {
  const types = options.types === undefined ? null : new Set(options.types)

  return Object.keys(records)
    .filter((logicalId) => {
      const record = records[logicalId]
      if (record === undefined) return false
      if (types !== null && !types.has(record.schemaType)) return false
      if (options.includeFullyTombstoned === true) return true
      return !(record.local.publishedTombstone && record.local.draftTombstone)
    })
    .sort()
}
