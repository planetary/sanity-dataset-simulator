/**
 * Persisting conflicts onto the §13.3 record and counting them for §13.1
 * (plan §6; PRD §13.1 `conflictSummary`, §13.3 `conflicts`, §17.4, §17.11,
 * §28.6).
 *
 * The merge engine *detects*; this module decides what a record should still be
 * carrying afterwards. PRD §17.11 fixes the rule for the overlay-vs-overlay race
 * and §17.4 generalizes it: a conflict "is persisted on the document only when it
 * remains unresolved". So the persisted list is not an append-only log — it is
 * the set of disagreements that are *currently* true, plus the resolutions that
 * currently apply to them. The audit trail of a resolution lives in the §28.1
 * conflict-resolution transaction, not here, which is what keeps this list
 * bounded by the number of live disagreements rather than by history.
 *
 * Three rules, in order:
 *
 * 1. **Detected and not previously known** → persisted, unresolved.
 * 2. **Detected and previously known** → the previous instance is kept, so its
 *    §13.11 `detectedAt` still names when the disagreement was *first* seen and
 *    an existing `resolution` still stands — but only while the three compared
 *    values are unchanged. A moved base or local value is a *new* disagreement
 *    wearing the same identity, and §28.6's "a new base or local revision
 *    invalidates the acknowledgement" says it must be raised again.
 * 3. **Previously known and no longer detected** → dropped, resolved or not
 *    (§17.11 "persisted only while unresolved").
 *
 * Everything here is pure and total: no clock, no ID source, no mutation of the
 * inputs. Conflict identity is already derived (`conflicts/create.ts`), so two
 * evaluations over the same inputs produce byte-identical output.
 */
import {canonicalEquals} from '../serialize'
import type {OverlayConflict} from '../types/conflict'
import type {OverlayDocumentRecord} from '../types/record'
import {summarizeConflicts} from './create'

/** The conflicts on a record that still await §28.3 resolution (PRD §13.1, §17.11). */
export function unresolvedConflicts(
  record: Pick<OverlayDocumentRecord, 'conflicts'>,
): OverlayConflict[] {
  return record.conflicts.filter((conflict) => conflict.resolution === undefined)
}

/**
 * Do two instances of the same conflict describe the same disagreement?
 *
 * Identity (`documentId:type:path`) is deliberately coarse — it has to be, so a
 * conflict keeps one stable ID across re-detections. Sameness for the purpose of
 * §28.6 is finer: the three §13.11 compared values must also be unchanged.
 */
export function describesSameDisagreement(a: OverlayConflict, b: OverlayConflict): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.severity === b.severity &&
    canonicalEquals(a.ancestorValue ?? null, b.ancestorValue ?? null) &&
    canonicalEquals(a.baseValue ?? null, b.baseValue ?? null) &&
    canonicalEquals(a.localValue ?? null, b.localValue ?? null)
  )
}

/**
 * Fold a freshly detected conflict set into a record (PRD §13.3, §17.11).
 *
 * The output order is the detection order, which the merge engine already makes
 * deterministic (§17.3 step 10), so the resulting record serializes identically
 * for identical inputs (§34.17).
 */
export function persistConflicts(
  record: OverlayDocumentRecord,
  detected: readonly OverlayConflict[],
): OverlayDocumentRecord {
  const previous = new Map(record.conflicts.map((conflict) => [conflict.id, conflict]))
  const next: OverlayConflict[] = []
  const seen = new Set<string>()

  for (const conflict of detected) {
    if (seen.has(conflict.id)) continue
    seen.add(conflict.id)
    const existing = previous.get(conflict.id)
    // Rule 2: the same disagreement keeps its first detection time and its
    // resolution. Anything else is rule 1 all over again.
    next.push(
      existing !== undefined && describesSameDisagreement(existing, conflict)
        ? existing
        : conflict,
    )
  }

  // Rule 3 is implicit: anything not re-detected simply never entered `next`.
  if (
    next.length === record.conflicts.length &&
    next.every((conflict, index) => conflict === record.conflicts[index])
  ) {
    return record
  }
  return {...record, conflicts: next}
}

/**
 * The §13.1 `conflictSummary` for a whole overlay, counting **unresolved**
 * conflicts only — the same rule the store adapters apply when they recompute the
 * manifest field from stored records.
 */
export function overlayConflictSummary(state: {
  documents: Readonly<Record<string, OverlayDocumentRecord>>
}): {total: number; hard: number; soft: number} {
  const all: OverlayConflict[] = []
  for (const record of Object.values(state.documents)) all.push(...unresolvedConflicts(record))
  return summarizeConflicts(all)
}
