/**
 * The branch as `sanity-overlay-query` consumes it, and the candidate pool the
 * evaluator reads (PRD §22.6 steps 6, 7, 13).
 *
 * TWO PORTS, DELIBERATELY SEPARATE.
 *
 * `overlaySourceFromBranch` turns the overlay API's hydration answer into an
 * {@link OverlaySource}: which ADDRESS the branch owns a body for, and which
 * address the branch has SUPPRESSED. `createBranchCandidateSource` is the
 * {@link QueryBaseSource} the evaluator pulls candidates through. Suppression
 * lives in exactly one of them — the first — because `resolveVirtualDocument`
 * is the single place §22.6 step 7 is decided, and a second implementation in
 * the candidate port would keep the suite green after the real one was deleted.
 *
 * ADDRESSING. Studio reads a raw dataset: `drafts.x` and `x` are two documents,
 * not two views of one (PRD §13.9). So the overlay is keyed by ADDRESS, and a
 * branch that owns only a draft says nothing at all about the published row.
 *
 * `published: null` IS NOT A DELETION. The hydration shape spells "the branch
 * deleted this version" as the tombstone flag and "the branch has no opinion
 * about this version" as a null body. Reading the second as the first would
 * make every published document disappear from the Studio the moment anyone
 * edited its draft.
 */

import type {QueryBaseSource} from 'sanity-overlay-query/baseSource'
import type {OverlaySource} from 'sanity-overlay-query/overlaySource'
import type {QueryDocument} from 'sanity-overlay-query/types'
import type {OverlayHydrationDocument} from './transport'

type Rec = Record<string, unknown>

/** `drafts.<logicalId>` — the address a draft answers at in a raw read. */
export const draftAddress = (logicalId: string): string => `drafts.${logicalId}`

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Stamp the addressed identity onto a materialized body.
 *
 * The address wins over whatever `_id` the body carries: the body is a
 * materialization and the address is what the query layer must be able to
 * resolve, dereference and de-duplicate by. `_type` falls back to the record's
 * `schemaType` because `QueryDocument` requires one and a body may omit it.
 */
function asQueryDocument(
  id: string,
  body: unknown,
  schemaType: string | undefined,
): QueryDocument | null {
  if (!isRec(body)) return null
  const type = typeof body._type === 'string' ? body._type : schemaType
  if (typeof type !== 'string' || type.length === 0) return null
  return {...body, _id: id, _type: type}
}

/**
 * Build the §22.6 overlay view from the overlay API's hydration documents —
 * the same shape `POST /state` and `POST /commit` already answer with, so the
 * read path and the write echo agree by construction rather than by luck.
 */
export function overlaySourceFromBranch(
  hydration: readonly OverlayHydrationDocument[],
): OverlaySource {
  const documents = new Map<string, QueryDocument>()
  const tombstones = new Set<string>()
  const conflicts = new Set<string>()

  /* Sorted, so the view is a deterministic function of the branch rather than
   * of the order transactions happened to arrive in. */
  const entries = [...hydration].sort((left, right) =>
    left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0,
  )

  for (const entry of entries) {
    const logicalId = entry.logicalId
    if (typeof logicalId !== 'string' || logicalId.length === 0) continue
    const conflicted = Array.isArray(entry.conflicts) && entry.conflicts.length > 0

    const versions: {address: string; tombstoned: boolean; body: unknown}[] = [
      {
        address: draftAddress(logicalId),
        tombstoned: entry.draftTombstone === true,
        body: entry.draft,
      },
      {
        address: logicalId,
        tombstoned: entry.publishedTombstone === true,
        body: entry.published,
      },
    ]

    for (const version of versions) {
      if (version.tombstoned) {
        tombstones.add(version.address)
        if (conflicted) conflicts.add(version.address)
        continue
      }
      const document = asQueryDocument(version.address, version.body, entry.schemaType)
      if (document === null) continue
      documents.set(version.address, document)
      if (conflicted) conflicts.add(version.address)
    }
  }

  return {documents, tombstones, conflicts}
}

export interface BranchCandidateSourceInput {
  /** What the credential holder fetched for the plan's base requests. */
  readonly baseDocuments: readonly QueryDocument[]
  readonly overlay: OverlaySource
}

/** Read `path` out of a document, following plain objects only. */
function readPath(document: QueryDocument, path: readonly string[]): unknown {
  let cursor: unknown = document
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Rec)[segment]
  }
  return cursor
}

/**
 * The candidate pool the evaluator reads — and the answer to the candidate-order
 * caveat `evaluate.ts` states in its own header.
 *
 * THE CAVEAT. The evaluator admits candidates base-fetch → branch-created →
 * reference-expanded, and GROQ can observe that order: an unordered `*[…]`
 * answers in dataset order. `evaluate.ts` calls it immaterial "while at most one
 * candidate can match", which holds for a lookup and does NOT hold for a list.
 * Left alone, a list pane would answer with every branch-created document
 * appended after every staging one — an order that is a property of *where a
 * document came from*, which is exactly what an overlay must not leak.
 *
 * THE ANSWER. Establish the order here, where the pool is assembled: every
 * request is served from the union of staging and branch documents, **sorted by
 * `_id`**. Dataset order is then a total order that is a pure function of the
 * answer, identical whether a document came from staging or the branch. Nothing
 * post-processes an evaluated result, which §22.2 forbids outright.
 *
 * WHY THE UNION IS HERE AND NOT ONLY IN §22.6 STEP 6. Returning branch records
 * from this port widens `ids`/`types` selections to documents staging does not
 * hold — the same documents step 6 unions in a moment later, so the candidate
 * SET is unchanged and only its order differs. `field-equality` is widened the
 * same way and for the same reason step 6 does it: a branch edit can make a
 * document newly match a predicate the base fetch evaluated against pre-branch
 * content.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: suppress tombstones. See the module note.
 */
export function createBranchCandidateSource(
  input: BranchCandidateSourceInput,
): QueryBaseSource {
  /**
   * "The branch has an OPINION about this address" — a body it owns, or a
   * tombstone it recorded. Both are opinions, and both are reasons a staging row
   * may no longer belong in the answer the way the base fetch selected it.
   *
   * Asking `overlay.documents.has(id)` alone was a bug of exactly this class: a
   * tombstoned address is deliberately absent from `documents` (see the module
   * note), so the widened selection silently skipped every document the branch
   * had deleted. That kept them out of the candidate set, and so out of
   * `conflictsTouched` and out of `resolveVirtualDocument`'s reach — suppression
   * that happens by never arriving is suppression this port is not allowed to
   * perform. This port only ever WIDENS.
   */
  const branchTouched = (id: string): boolean =>
    input.overlay.documents.has(id) || input.overlay.tombstones.has(id)

  const byId = new Map<string, QueryDocument>()
  for (const document of input.baseDocuments) {
    if (typeof document?._id === 'string') byId.set(document._id, document)
  }
  /* §22.6 step 13: the branch record wins over the staging row at the same
   * address. Tombstoned addresses are absent from `documents`, so a staging row
   * under a tombstone survives to be suppressed by step 7. */
  for (const [id, document] of input.overlay.documents) byId.set(id, {...document, _id: id})

  const all = [...byId.values()].sort((left, right) =>
    left._id < right._id ? -1 : left._id > right._id ? 1 : 0,
  )

  return {
    async fetchCandidates(request) {
      switch (request.kind) {
        case 'ids': {
          const wanted = new Set(request.ids)
          return all.filter((document) => wanted.has(document._id))
        }
        case 'types': {
          const types = new Set(request.types)
          return all.filter((document) => types.has(document._type))
        }
        case 'field-equality': {
          const types = new Set(request.types)
          return all.filter(
            (document) =>
              types.has(document._type) &&
              (readPath(document, request.path) === request.value ||
                branchTouched(document._id)),
          )
        }
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled base request ${JSON.stringify(exhaustive)}`)
        }
      }
    },
  }
}
