/**
 * Injection points W2 depends on but does not implement.
 *
 * Every port is injectable and every port has a default. The reference and
 * validation defaults are genuine no-ops — W4 supplies the real ones. The **merge**
 * port is different: its default is the real W3 three-way merge
 * ({@link threeWayMerge}), because a merge no-op is not a neutral choice but a
 * documented violation of PRD §17.2 rule 4 and invariant §34.12.
 */
import type {OverlayConflict} from '../types/conflict'
import type {SanityDocument} from '../types/document'
import type {OverlayMutation} from '../types/operations'
import type {OverlayPath} from '../types/path'
import type {OverlayBaseStatus, OverlayDocumentOrigin} from '../types/record'
import {mergeDocument} from '../merge/merge'

/* ------------------------------------------------------------------ *
 * Base dataset (read-only view of the upstream Content Lake state)
 * ------------------------------------------------------------------ */

export interface BaseSnapshot {
  /** Content Lake revision. Never a synthetic overlay `_rev` (PRD §13.9). */
  revision: string
  document: SanityDocument
  capturedAt?: string
}

/**
 * Read-only port over the current base dataset (PRD §17.1 `currentBase`).
 *
 * Core never fetches: the adapter/query layer supplies base documents. Existence
 * questions (`createIfNotExists`, `setIfMissing`) are answered against base plus
 * overlay plus tombstones through this port (PRD §35.4).
 */
export interface BaseDocumentSource {
  getPublished(logicalId: string): BaseSnapshot | null
  getDraft(logicalId: string): BaseSnapshot | null
}

/** A base source that reports every document as absent. */
export const EMPTY_BASE_SOURCE: BaseDocumentSource = Object.freeze({
  getPublished: () => null,
  getDraft: () => null,
})

/**
 * Build a {@link BaseDocumentSource} over a fixed set of base documents.
 *
 * Documents are bucketed by their `_id`: a `drafts.` prefix makes it the base
 * draft, anything else the base published version. `_rev` supplies the Content
 * Lake revision; a document without one is rejected, because a base version with
 * no revision cannot anchor a merge ancestor (PRD §13.4).
 */
export function createBaseSource(
  documents: readonly SanityDocument[],
  options: {capturedAt?: string} = {},
): BaseDocumentSource {
  const published = new Map<string, BaseSnapshot>()
  const drafts = new Map<string, BaseSnapshot>()

  for (const document of documents) {
    const isDraft = document._id.startsWith('drafts.')
    const logicalId = isDraft ? document._id.slice('drafts.'.length) : document._id
    if (typeof document._rev !== 'string' || document._rev.length === 0) {
      throw new Error(`Base document ${document._id} requires a "_rev" (PRD §13.4)`)
    }
    const snapshot: BaseSnapshot = {
      revision: document._rev,
      document,
      ...(options.capturedAt === undefined ? {} : {capturedAt: options.capturedAt}),
    }
    ;(isDraft ? drafts : published).set(logicalId, snapshot)
  }

  return {
    getPublished: (logicalId) => published.get(logicalId) ?? null,
    getDraft: (logicalId) => drafts.get(logicalId) ?? null,
  }
}

/* ------------------------------------------------------------------ *
 * Merge (W3)
 * ------------------------------------------------------------------ */

export interface MergeInput {
  /** Base snapshot captured at first touch (PRD §17.1). */
  ancestor: SanityDocument | null
  currentBase: SanityDocument | null
  localMaterialized: SanityDocument
  localTouchedPaths: readonly OverlayPath[]
  localTombstone: boolean
  /**
   * Everything below is context §17.3 needs and §17.1's pseudo-code leaves
   * implicit. All optional, so a resolver built by a caller that only has §17.1's
   * five inputs still type-checks; {@link threeWayMerge} derives sane values for
   * the two it cannot do without.
   */
  /** Logical ID stamped on any conflict raised (§13.11). */
  documentId?: string
  /** Injected clock value used as `OverlayConflict.detectedAt` (§13.11). */
  now?: string
  /** Paths suppressed by an explicit unset (§17.5, invariant §34.11). */
  unsetPaths?: readonly OverlayPath[]
  /** `branch` outranks base entirely (§17.2 precedence rule 2). */
  origin?: OverlayDocumentOrigin
  /** Distinguishes "base deleted" from "base not present" (§16.4). */
  baseStatus?: OverlayBaseStatus
  /**
   * Observer for the conflicts the merge raised (§17.4).
   *
   * The port returns a document, not a `MergeResult`, so a caller that wants the
   * §34.13 "conflict recorded" half of touched-path preservation supplies this
   * sink. Purely observational: it never changes the resolved document, and a
   * resolver that has no conflicts to report simply never calls it.
   */
  onConflict?: (conflict: OverlayConflict) => void
}

/**
 * Three-way merge port (PRD §17.1-§17.3), owned by workstream W3.
 *
 * The default is {@link threeWayMerge} — the real engine. Injection remains
 * available for callers that need a different `documentId`/`now`/validator
 * binding (see `createMergeResolver` in `../merge/merge`), or for a test that
 * deliberately wants the {@link localWinsMerge} stub.
 */
export type MergeResolver = (input: MergeInput) => SanityDocument

/**
 * The W3 three-way merge (PRD §17.3), adapted to this port. **This is the
 * default**: `resolveDraft`, `resolvePublished` and therefore every §18.4-§18.9
 * document action resolve through the full ten-step algorithm.
 *
 * `documentId` and `now` fall back to the local materialized document's own `_id`
 * and `_updatedAt`, both of which W2 stamps on every local version (§13.9), so the
 * resolver stays a pure function of its input even when a caller supplies only
 * §17.1's five fields.
 */
export const threeWayMerge: MergeResolver = (input) => {
  const result = mergeDocument({
    documentId: input.documentId ?? input.localMaterialized._id,
    now: input.now ?? input.localMaterialized._updatedAt ?? '',
    ancestor: input.ancestor,
    currentBase: input.currentBase,
    localMaterialized: input.localMaterialized,
    localTouchedPaths: input.localTouchedPaths,
    localTombstone: input.localTombstone,
    ...(input.unsetPaths === undefined ? {} : {unsetPaths: input.unsetPaths}),
    ...(input.origin === undefined ? {} : {origin: input.origin}),
    ...(input.baseStatus === undefined ? {} : {baseStatus: input.baseStatus}),
  })

  if (input.onConflict !== undefined) {
    for (const conflict of result.conflicts) input.onConflict(conflict)
  }

  // An applicable tombstone resolves to no document; the tombstone branches in
  // `./resolve` answer that question before they ever reach the port, so the
  // fallback only guards a caller invoking the resolver directly.
  return result.document ?? input.localMaterialized
}

/**
 * The W2-era stub: the local materialized document wins wholesale.
 *
 * That is §17.2 precedence rule 3 **without** rule 4's untouched-path
 * inheritance, so it drops every upstream change on a path the branch never
 * touched and violates invariant §34.12. It is kept exported for tests that want
 * to isolate W2 from the merge engine, and for the mutation checks that prove the
 * default is doing real work — it is **not** what production gets.
 */
export const localWinsMerge: MergeResolver = (input) => input.localMaterialized

/* ------------------------------------------------------------------ *
 * Schema validation (W3/W4 — PRD §17.3 step 9, §20.5)
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  level: 'error' | 'warning'
  message: string
  path?: OverlayPath
}

export interface ValidationContext {
  logicalId: string
  action: string
}

/**
 * Schema validation port. Core never imports Studio code (PRD §10.1); the branch
 * schema arrives as an injected artifact (§20.1). Default: no issues.
 */
export type DocumentValidator = (
  document: SanityDocument,
  context: ValidationContext,
) => readonly ValidationIssue[]

export const noopValidator: DocumentValidator = () => []

/* ------------------------------------------------------------------ *
 * Reference integrity (W4 — PRD §18.5, §18.6, §18.8, §19.4, §19.5)
 * ------------------------------------------------------------------ */

export interface StrongReferenceIssue {
  /** The document holding the reference. */
  referringDocumentId: string
  /** Path of the reference inside the referring document (PRD §19.1). */
  path: OverlayPath
  /** The reference target's logical ID. */
  targetId: string
  strength: 'strong' | 'weak'
  reason: 'target-deleted' | 'target-draft-only' | 'target-unpublished'
}

export interface StrongReferenceCheckInput {
  action: 'delete' | 'publish' | 'unpublish'
  /** Logical ID of the document being acted on. */
  documentId: string
  /** Document IDs mutated by the same transaction (PRD §18.8 "unless" clause). */
  transactionDocumentIds: readonly string[]
  mutations: readonly OverlayMutation[]
}

/**
 * Incoming strong-reference check (PRD §18.8, §19.4, §19.5), owned by W4.
 *
 * W2 calls it and applies the §18.8 "unless the same transaction updates or
 * deletes all referring documents" filter to whatever it returns; it never walks
 * the reference graph itself. Default: no issues.
 */
export type StrongReferenceCheck = (
  input: StrongReferenceCheckInput,
) => readonly StrongReferenceIssue[]

export const noopStrongReferenceCheck: StrongReferenceCheck = () => []
