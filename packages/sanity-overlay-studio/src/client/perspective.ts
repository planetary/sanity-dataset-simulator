/**
 * PERSPECTIVE READS — how a `drafts` / `published` read is answered exactly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * `reads.ts` used to refuse every `client.fetch` carrying a perspective other
 * than `raw`, on the correct observation that "the overlay resolves documents
 * at their RAW addresses (`drafts.x` and `x` are two rows, PRD §13.9)". What was
 * never measured is the CONSEQUENCE: sanity@6.8.0 attaches a perspective to
 * every content read the structure tool makes —
 *
 *   `PaneContainer-Bp8RN3ON.js:883`      the list query, `perspective: perspectiveStack`
 *   `datastores-DqFH7RLd.js:910-913`     the row titles, `preview.document-paths`
 *
 * — so the refusal was total in practice, and a Studio with a branch full of
 * edits rendered base content in every pane. (Observed live, 2026-08-06:
 * `article-01` held `Article 1 — OVERLAY EDIT ✅ 日本語` in the overlay and the
 * list rendered `Article 1`.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ANSWER IS EXACT, NOT AN APPROXIMATION (PRD §5.5, §22.2).
 *
 * A perspective is a view over the DATASET, not a transform of an answer. The
 * hosted API collapses the version set of each logical document — draft wins
 * over published — and then evaluates the query. So this module collapses the
 * CANDIDATE POOL the same way, and `groq-js` evaluates the caller's own query
 * text over it, once, unchanged. Nothing post-processes an evaluated result,
 * which §22.2 forbids outright.
 *
 * COMPLETENESS. The version set of a logical id under these two perspectives is
 * exactly `{id, drafts.id}` — the same two-element argument `readPlan.ts`
 * already makes for `sanity::versionOf`, and the reason release versions are
 * excluded there is the reason a release perspective is refused here. An `ids`
 * request widened to both addresses selects that set in full; a raw `_type`
 * fetch returns both members by construction. A FIELD-EQUALITY plan is refused:
 * its base fetch evaluates the predicate against raw rows, so a published row
 * that matches while its draft does not would be collapsed into an answer the
 * hosted API leaves out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COLLAPSE, stated once so it is auditable. For logical id `L`:
 *
 *     draft      = tombstoned(drafts.L) ? ∅ : branch(drafts.L) ?? base(drafts.L)
 *     published  = tombstoned(L)        ? ∅ : branch(L)        ?? base(L)
 *     drafts     = draft ?? published
 *     published  = published
 *
 * and the surviving row is re-addressed to `L` with `_originalId` naming the
 * version it came from — which is precisely what the hosted API returns.
 *
 * Dependency-free apart from the query package's own port types.
 */

import type {BaseCandidateRequest, QueryBaseSource} from '../../../sanity-overlay-query/src/baseSource'
import type {OverlaySource} from '../../../sanity-overlay-query/src/overlaySource'
import type {QueryDocument} from '../../../sanity-overlay-query/src/types'
import {toDraftId, toPublishedId} from '../ids'
import {draftAddress} from './readSource'

/** The perspectives this layer can answer exactly. */
export type StudioPerspective = 'raw' | 'drafts' | 'published'

export type PerspectiveReading =
  | {readonly perspective: StudioPerspective}
  | {readonly refusal: string}

/**
 * `versions.<release>.<id>` and the release stack entries that select it.
 *
 * PRD §32 degrades Releases in overlay mode — this very plugin disables the
 * tool — so the overlay holds no release-version document and no base request
 * shape can enumerate that namespace. Answering a release perspective would
 * hand back a silent subset of the hosted result (§5.5), so it is refused.
 */
function releaseRefusal(spelling: string): string {
  return (
    `the read asks for the ${spelling} perspective, which selects release versions ` +
    '(`versions.<release>.<id>`). Releases are degraded in overlay mode (PRD §32), so the ' +
    'overlay holds none and no base request shape can enumerate that namespace — answering ' +
    'the rest would hand back a silent subset of the hosted result (PRD §5.5)'
  )
}

function unknownRefusal(spelling: string): string {
  return (
    `the read asks for the ${spelling} perspective, which this layer has no exact local ` +
    'reading of. Only `raw`, `drafts` and `published` collapse to a version set the overlay ' +
    'knows authoritatively (`<id>` and `drafts.<id>`), so anything else is passed through ' +
    'rather than guessed'
  )
}

/**
 * Read `client.fetch`'s third-argument `perspective` (PRD §22.5).
 *
 * `@sanity/client` accepts a string or a stack; sanity 6.8.0's structure tool
 * passes the STACK (`usePerspective().perspectiveStack`). An empty stack means
 * "no perspective", which the client itself treats as raw
 * (`datastores-DqFH7RLd.js:928`: `perspective && perspective.length > 0`).
 */
export function readPerspective(value: unknown): PerspectiveReading {
  if (value === undefined || value === null) return {perspective: 'raw'}

  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === 'string')
    if (entries.length !== value.length) return {refusal: unknownRefusal(JSON.stringify(value))}
    if (entries.length === 0) return {perspective: 'raw'}
    /* A stack of more than one entry is a release stack: the only multi-entry
     * stacks sanity builds are `[<release>, 'drafts']` and its siblings. */
    if (entries.length > 1) return {refusal: releaseRefusal(JSON.stringify(value))}
    return readPerspective(entries[0])
  }

  if (typeof value !== 'string') return {refusal: unknownRefusal(String(value))}
  if (value === 'raw' || value === 'drafts' || value === 'published') return {perspective: value}
  /* Everything else is either a release name — the only other thing sanity puts
   * in a perspective — or a spelling this layer has never seen. Both refuse;
   * the message names the release case because it is the likely one. */
  return {refusal: `${unknownRefusal(JSON.stringify(value))}. ${releaseRefusal('a release')}`}
}

/** Why a plan shape cannot be answered under a perspective, or `null`. */
export function perspectivePlanRefusal(
  planType: string,
  perspective: StudioPerspective,
): string | null {
  if (perspective === 'raw') return null
  if (planType !== 'slug') return null
  return (
    'the read asks for a perspective AND filters on a local field. The candidate fetch ' +
    'evaluates that predicate against the RAW rows, so a published document that matches ' +
    'while its draft does not would be collapsed into an answer the hosted API leaves out. ' +
    'Refused rather than half-answered (PRD §5.5)'
  )
}

/* ------------------------------------------------------------------ *
 * The collapse
 * ------------------------------------------------------------------ */

/**
 * Re-address a version's body to its logical id, naming where it came from.
 *
 * `_originalId` is not decoration: it is what the hosted API returns under a
 * perspective, and sanity 6.8.0 projects it in both the document-list query and
 * the preview selection, so an answer without it is a different shape.
 */
function collapsed(logicalId: string, source: QueryDocument): QueryDocument {
  return {...source, _id: logicalId, _originalId: source._id}
}

/**
 * The branch as the perspective sees it.
 *
 * Keyed by LOGICAL id, so it composes with the collapsed candidate pool below:
 * `resolveVirtualDocument` (§22.6 steps 7, 13) then reads both in the same
 * address space, which is the whole reason both are collapsed rather than one.
 *
 * A tombstone survives collapse only when the branch suppressed EVERY version
 * the perspective could fall back to. A branch that discarded its draft has not
 * deleted the document — the published row is still the answer — and recording
 * that as a tombstone would make it vanish from the pane.
 */
export function perspectiveOverlaySource(
  overlay: OverlaySource,
  perspective: StudioPerspective,
): OverlaySource {
  if (perspective === 'raw') return overlay

  const logicalIds = new Set<string>()
  for (const address of overlay.documents.keys()) logicalIds.add(toPublishedId(address))
  for (const address of overlay.tombstones) logicalIds.add(toPublishedId(address))

  const documents = new Map<string, QueryDocument>()
  const tombstones = new Set<string>()
  const conflicts = new Set<string>()
  const sourceConflicts = overlay.conflicts ?? new Set<string>()

  for (const logicalId of [...logicalIds].sort()) {
    const draftId = toDraftId(logicalId)
    const draftTombstoned = overlay.tombstones.has(draftId)
    const publishedTombstoned = overlay.tombstones.has(logicalId)
    const branchDraft = draftTombstoned ? undefined : overlay.documents.get(draftId)
    const branchPublished = publishedTombstoned ? undefined : overlay.documents.get(logicalId)

    /*
     * THE BRANCH MAY ONLY CLAIM THE ADDRESS THE PERSPECTIVE ACTUALLY SELECTS.
     *
     * Under `drafts` the DRAFT ADDRESS wins over the published one whoever
     * supplies each, and this view cannot see base. So the branch's published
     * body is promoted only once the branch has PROVED no draft exists — by
     * tombstoning it. Otherwise the decision is deferred to the candidate pool,
     * which sees both sides; the branch's own row is in that pool either way
     * (`createBranchCandidateSource` unions it in), so nothing is lost by
     * deferring and a base draft is no longer overruled by a branch publish.
     */
    const winner =
      perspective === 'drafts'
        ? (branchDraft ?? (draftTombstoned ? branchPublished : undefined))
        : branchPublished
    if (winner !== undefined) {
      documents.set(logicalId, collapsed(logicalId, winner))
    } else if (
      perspective === 'drafts' ? draftTombstoned && publishedTombstoned : publishedTombstoned
    ) {
      tombstones.add(logicalId)
    }

    if (sourceConflicts.has(draftId) || sourceConflicts.has(logicalId)) conflicts.add(logicalId)
  }

  return {documents, tombstones, conflicts}
}

/**
 * Widen one candidate request into the RAW address space it must be answered
 * from.
 *
 * Only `ids` needs it: a perspective read names logical ids, and both versions
 * of each are needed before the collapse can pick a winner. A `types` fetch
 * already returns both versions, and `field-equality` never reaches here (see
 * {@link perspectivePlanRefusal}).
 */
export function widenRequest(request: BaseCandidateRequest): BaseCandidateRequest {
  if (request.kind !== 'ids') return request
  const widened: string[] = []
  const seen = new Set<string>()
  for (const id of request.ids) {
    for (const address of [toPublishedId(id), draftAddress(toPublishedId(id))]) {
      if (seen.has(address)) continue
      seen.add(address)
      widened.push(address)
    }
  }
  return {...request, ids: widened}
}

/**
 * Wrap a RAW candidate source so it answers in the perspective's address space.
 *
 * The inner source is the ordinary one (staging plus the branch, keyed raw);
 * this widens what is asked of it, collapses what comes back, and then applies
 * the request's own selection a second time — because the widening deliberately
 * over-fetches and a caller that asked for two ids must not receive four rows.
 */
export function perspectiveBaseSource(
  inner: QueryBaseSource,
  overlay: OverlaySource,
  perspective: StudioPerspective,
): QueryBaseSource {
  if (perspective === 'raw') return inner

  return {
    async fetchCandidates(request) {
      const rows = await inner.fetchCandidates(widenRequest(request))

      const byAddress = new Map<string, QueryDocument>()
      const logicalIds = new Set<string>()
      for (const row of rows) {
        if (typeof row?._id !== 'string') continue
        byAddress.set(row._id, row)
        logicalIds.add(toPublishedId(row._id))
      }

      const out: QueryDocument[] = []
      for (const logicalId of [...logicalIds].sort()) {
        const draftId = toDraftId(logicalId)
        const draft = overlay.tombstones.has(draftId) ? undefined : byAddress.get(draftId)
        const published = overlay.tombstones.has(logicalId) ? undefined : byAddress.get(logicalId)
        const winner = perspective === 'drafts' ? (draft ?? published) : published
        if (winner === undefined) continue
        out.push(collapsed(logicalId, winner))
      }

      /* Re-apply the caller's own selection in the COLLAPSED space. The
       * widening deliberately over-fetches, and `maxCandidates` counts what the
       * evaluator is handed (§22.9) — so a request for one id must not be
       * charged for two rows. Correctness does not depend on this: `groq-js`
       * re-evaluates the caller's real filter at step 14, so a caller that
       * named `drafts.X` under a perspective still matches nothing, exactly as
       * the hosted API answers it. */
      if (request.kind === 'ids') {
        const wanted = new Set(request.ids.map((id) => toPublishedId(id)))
        return out.filter((row) => wanted.has(row._id))
      }
      if (request.kind === 'types') {
        const types = new Set(request.types)
        return out.filter((row) => types.has(row._type))
      }
      return out
    },
  }
}
