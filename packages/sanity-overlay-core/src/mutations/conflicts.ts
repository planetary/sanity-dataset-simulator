/**
 * Conflict detection at the commit boundary (PRD §17.4, §17.11, §13.1, §13.3).
 *
 * The merge engine raises conflicts while it resolves a document, but a read is
 * not a place to record anything. §17.11 says the conflict is "first surfaced to
 * the writing client at commit time", so the commit is where detection is run and
 * where the answer is written down: after a transaction has produced its new
 * records, every document it touched is re-resolved against the *current* base
 * and the resulting conflicts are folded onto the record by
 * {@link persistConflicts}.
 *
 * Two deliberate limits:
 *
 * - **A base view is required.** Core never fetches base (§16.1); it is handed in.
 *   With no base source at all, `currentBase` is `null` for every document, which
 *   the merge engine correctly reads as "base deleted" (§16.4) — a *hard*
 *   conflict. Manufacturing that from an omitted option would be wrong, so a
 *   transaction with no base view detects nothing and leaves the record's existing
 *   conflicts alone.
 * - **A tombstoned record is not evidence.** A tombstone suppresses resolution
 *   (§17.2 rule 1, §34.2), so a merge cannot run and nothing can be learned about
 *   the document's conflicts — but the branch still owns an intent that a
 *   `restore` (§18.8) brings back, so nothing is erased either. `restore` makes
 *   the record resolvable again and re-detects.
 *
 * An *empty* local block is the opposite case and is not treated the same way: a
 * record with no local versions and no tombstones has no branch intent left at
 * all, so §17.2 rule 4 inherits everything and there is nothing for the base to
 * disagree with. That is a positive finding of "no conflicts", not an absence of
 * evidence — which is why `discardDraft` (§18.7) on the last local version clears
 * the record rather than leaving a conflict nobody can resolve.
 *
 * The module lives under `mutations/` rather than `conflicts/` on purpose: it
 * needs the resolver, and `conflicts/` must stay importable by the merge engine.
 */
import {persistConflicts} from '../conflicts/persist'
import type {OverlayConflict} from '../types/conflict'
import type {ResolveContext} from './resolve'
import {resolveDraft, resolvePublished} from './resolve'
import {getRecord, withRecord, type OverlayState} from './state'

/**
 * The conflicts a record's current local state has against the current base, or
 * `null` when nothing can be learned (no base view, no record, or no resolvable
 * local version).
 *
 * Both local versions are resolved when both exist. Conflict identity does not
 * carry the version (`documentId:type:path`), so the two lists are deduplicated
 * by ID with the first occurrence winning — published first, then draft.
 */
export function detectDocumentConflicts(
  state: OverlayState,
  logicalId: string,
  context: ResolveContext,
): OverlayConflict[] | null {
  if (context.base === undefined) return null
  const record = getRecord(state, logicalId)
  if (record === null) return null

  const resolvablePublished = record.local.published !== null && !record.local.publishedTombstone
  const resolvableDraft = record.local.draft !== null && !record.local.draftTombstone
  if (!resolvablePublished && !resolvableDraft) {
    const tombstoned = record.local.publishedTombstone || record.local.draftTombstone
    // Tombstoned: no evidence either way, keep what the record knew.
    // Empty: a positive "nothing is owned locally", so nothing is in conflict.
    return tombstoned ? null : []
  }

  const found: OverlayConflict[] = []
  const seen = new Set<string>()
  const collect = (conflict: OverlayConflict): void => {
    if (seen.has(conflict.id)) return
    seen.add(conflict.id)
    found.push(conflict)
  }

  const observing: ResolveContext = {...context, onConflict: collect}
  if (resolvablePublished) resolvePublished(state, record.logicalId, observing)
  if (resolvableDraft) resolveDraft(state, record.logicalId, observing)

  return found
}

/**
 * Re-detect and persist the conflicts of every document a transaction touched.
 *
 * Returns the next state plus the conflicts this commit surfaced, in the order
 * the affected documents were listed (PRD §13.10 `affectedDocumentIds`), so the
 * caller's report is deterministic.
 */
export function persistTransactionConflicts(
  state: OverlayState,
  affectedDocumentIds: readonly string[],
  context: ResolveContext,
): {state: OverlayState; conflicts: OverlayConflict[]} {
  let next = state
  const surfaced: OverlayConflict[] = []

  for (const logicalId of affectedDocumentIds) {
    const detected = detectDocumentConflicts(next, logicalId, context)
    const record = getRecord(next, logicalId)
    if (record === null) continue
    if (detected !== null) {
      const updated = persistConflicts(record, detected)
      if (updated !== record) next = withRecord(next, updated)
      surfaced.push(...updated.conflicts)
    } else {
      surfaced.push(...record.conflicts)
    }
  }

  return {state: next, conflicts: surfaced}
}
