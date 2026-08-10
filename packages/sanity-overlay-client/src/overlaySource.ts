/**
 * Turn the overlay records on disk into the query layer's {@link OverlaySource}
 * (PRD §18.1/§18.2 perspective resolution, §22.6 steps 6, 7 and 13).
 *
 * This is the join between the two packages, and the place the overlay-blind
 * bug would live if it lived anywhere:
 *
 *   - a MODIFIED document must arrive as its branch-resolved value, so the query
 *     evaluator substitutes it for the base row;
 *   - a BRANCH-CREATED document must arrive at all, because no base fetch can
 *     ever select an ID base has never held;
 *   - a TOMBSTONED document must arrive as a tombstone, not as a missing entry —
 *     a missing entry means "base wins", which is exactly the stale read.
 *
 * The resolution itself is core's: `resolveDocumentBatch` runs the full §17.3
 * three-way merge per document and applies the §18.2 fallback chain. Nothing
 * here decides what a document *is*.
 *
 * WHY IDs ARE NORMALIZED. Core addresses the drafts perspective by its §13.9
 * document ID, so a resolved draft carries `_id: "drafts.article-1"`. The query
 * layer evaluates against a perspective-resolved DATASET, where a draft appears
 * under its logical ID — the same convention the fixture perspectives use. Handing
 * the `drafts.`-prefixed form to the evaluator would silently break every
 * `_id == $id` lookup and every reference target, so the ID is normalized back to
 * the logical form here, once, at the boundary.
 */
import {
  overlayDocumentIds,
  resolveDocumentBatch,
  createBaseSource,
  isSyntheticRev,
  toPublishedId,
  type SanityDocument,
} from 'sanity-overlay-core'
import {
  OverlayQueryError,
  emptyOverlaySource,
  type OverlaySource,
  type QueryDocument,
  type QueryPerspective,
} from 'sanity-overlay-query'
import type {OverlayClientBaseSource, OverlayStateSnapshot} from './types'

export interface BuildOverlaySourceInput {
  readonly snapshot: OverlayStateSnapshot | null
  readonly base: OverlayClientBaseSource
  readonly perspective: QueryPerspective
  /** Injected clock stamped on any conflict the resolution raises (§13.11). */
  readonly now: string
}

/** A resolved document is only usable as a candidate if it can be addressed. */
function asQueryDocument(document: SanityDocument, logicalId: string): QueryDocument | null {
  if (typeof document._type !== 'string' || document._type.length === 0) return null
  return {...document, _id: logicalId} as QueryDocument
}

export async function buildOverlaySource(
  input: BuildOverlaySourceInput,
): Promise<OverlaySource> {
  const {snapshot, base, perspective, now} = input
  if (snapshot === null) return emptyOverlaySource()

  if (perspective !== 'published' && perspective !== 'drafts') {
    /* §18.3 `raw` is a multi-version envelope, not a document-valued view, so it
     * has no batch read and no candidate set. Refusing is the §5.5 answer;
     * quietly serving `drafts` instead would be an approximation. */
    throw new OverlayQueryError(
      'UNSUPPORTED_GROQ',
      `Perspective ${JSON.stringify(perspective)} has no document-valued batch read ` +
        `(PRD §18.3). Use "published" or "drafts".`,
      {perspective},
    )
  }

  /* §22.2 candidate discovery: every logical ID the branch touches, INCLUDING the
   * fully tombstoned ones — those are precisely the documents whose base row must
   * be suppressed, so omitting them would restore the stale read. */
  const ids = overlayDocumentIds(snapshot.records, {includeFullyTombstoned: true})
  if (ids.length === 0) return emptyOverlaySource()

  /* The merge needs `currentBase` for each touched document (§17.1). One bounded
   * `ids` request covers it: the branch cannot touch a document it has no record
   * for. A version with no `_rev`, or one carrying a synthetic overlay `_rev`
   * (§13.9), cannot anchor an ancestor and is dropped rather than repaired —
   * accepting one would make the overlay its own ancestor. */
  const baseDocuments = await base.fetchCandidates({kind: 'ids', ids})
  const usable = (baseDocuments as readonly SanityDocument[]).filter(
    (doc) => typeof doc._rev === 'string' && doc._rev.length > 0 && !isSyntheticRev(doc._rev),
  )

  const batch = resolveDocumentBatch({
    ids,
    perspective,
    now,
    records: snapshot.records,
    base: createBaseSource(usable),
  })

  const documents = new Map<string, QueryDocument>()
  const tombstones = new Set<string>()
  const conflicts = new Set<string>()

  for (const entry of batch.entries) {
    const logicalId = toPublishedId(entry.logicalId)
    if (entry.conflicts.length > 0) conflicts.add(logicalId)

    if (entry.document === null) {
      /* §22.6 step 7. The branch resolves this document to nothing in this
       * perspective; the base row must not be served in its place. */
      tombstones.add(logicalId)
      continue
    }

    const candidate = asQueryDocument(entry.document, logicalId)
    if (candidate === null) {
      /* A resolved document with no `_type` cannot participate in a type or
       * reference predicate. Reported by omission from `documents`, never
       * substituted with a guess. */
      continue
    }
    documents.set(logicalId, candidate)
  }

  return conflicts.size === 0 ? {documents, tombstones} : {documents, tombstones, conflicts}
}
