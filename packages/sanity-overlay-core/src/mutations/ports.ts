/**
 * Injection points W2 depends on but does not implement.
 *
 * Every port has a pure, no-op default so the mutation engine and the document
 * actions are testable and deterministic on their own. Workstreams W3 (merge)
 * and W4 (references, validation) replace the defaults.
 */
import type {SanityDocument} from '../types/document'
import type {OverlayMutation} from '../types/operations'
import type {OverlayPath} from '../types/path'

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
}

/**
 * Three-way merge port (PRD §17.1-§17.3), owned by workstream W3.
 *
 * **W2 default (stub):** the local materialized document wins wholesale. That is
 * the §17.2 precedence rule 3 without rule 4's untouched-path inheritance, which
 * needs the full ten-step §17.3 algorithm. Every W2 test fixes both sides so the
 * distinction is not exercised; nothing in W2 depends on the stub's inheritance
 * behaviour.
 */
export type MergeResolver = (input: MergeInput) => SanityDocument

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
