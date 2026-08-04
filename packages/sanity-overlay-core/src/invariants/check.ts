/**
 * One entry point for all twelve Phase-2-scoped §34 invariants (plan §8.3).
 *
 * Everything is optional: pass whatever the caller has. A test hands in one
 * merge; a debug endpoint hands in the whole state, the manifest and the storage
 * inventory. Checks whose inputs are absent are skipped rather than guessed, so
 * a partial call never manufactures a violation it cannot substantiate.
 */
import type {MergeRequest, MergeResult} from '../merge/types'
import type {OverlayState} from '../mutations/state'
import type {PerspectiveBase} from '../perspectives/resolve'
import type {OverlayDocumentRecord} from '../types/record'
import type {OverlayManifest} from '../types/manifest'
import {checkCheckpointDeterminism} from './checkpoint'
import {checkManifestHeads, checkOrphanVisibility} from './manifest'
import {checkMergeResultInvariants} from './merge'
import {
  checkIdempotencyLedger,
  checkRecordChecksums,
  checkRevisionIncrements,
  checkSingleCurrentVersions,
  checkStateChecksums,
  checkTombstoneSuppression,
  type TombstoneSuppressionOptions,
} from './state'
import type {OverlayInvariantViolation} from './types'

const NO_BASE: PerspectiveBase = {published: null, draft: null}

export interface OverlayInvariantInput {
  /** §34.1, §34.2, §34.4, §34.5, §34.6. */
  state?: OverlayState
  /** Current base documents keyed by logical ID, for the §34.2 resolution. */
  base?: Readonly<Record<string, PerspectiveBase>>
  /** Extra records to check outside a state (§34.2, §34.4). */
  records?: readonly OverlayDocumentRecord[]
  /** §34.3 and §34.8. */
  manifest?: OverlayManifest
  /** Storage inventory for §34.3. */
  knownRefs?: readonly string[]
  /** Storage inventory for §34.8. */
  storedRefs?: readonly string[]
  /** Observable refs for §34.8; §34.8 is skipped when absent. */
  visibleRefs?: readonly string[]
  checkpointRefs?: readonly string[]
  /** §34.11-§34.14, one entry per merge to audit. */
  merges?: readonly {request: MergeRequest; result: MergeResult}[]
  /** §34.17 — two or more renderings of the same logical state. */
  checkpointRenderings?: readonly unknown[]
  /** Injected clock for the §34.2 perspective resolution. */
  now?: string
  /** Injected perspective resolvers for §34.2. */
  perspectives?: TombstoneSuppressionOptions
}

/** Run every Phase-2-scoped §34 invariant the input supports. */
export function checkOverlayInvariants(
  input: OverlayInvariantInput,
): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const baseFor = (logicalId: string): PerspectiveBase => input.base?.[logicalId] ?? NO_BASE

  if (input.state !== undefined) {
    const state = input.state
    violations.push(...checkSingleCurrentVersions(state))
    violations.push(...checkStateChecksums(state))
    violations.push(...checkRevisionIncrements(state))
    violations.push(...checkIdempotencyLedger(state))
    for (const record of Object.values(state.documents)) {
      violations.push(
        ...checkTombstoneSuppression(
          {
            record,
            base: baseFor(record.logicalId),
            ...(input.now === undefined ? {} : {now: input.now}),
          },
          input.perspectives ?? {},
        ),
      )
    }
  }

  for (const record of input.records ?? []) {
    violations.push(...checkRecordChecksums(record))
    violations.push(
      ...checkTombstoneSuppression(
        {
          record,
          base: baseFor(record.logicalId),
          ...(input.now === undefined ? {} : {now: input.now}),
        },
        input.perspectives ?? {},
      ),
    )
  }

  if (input.manifest !== undefined) {
    violations.push(
      ...checkManifestHeads(
        input.manifest,
        input.knownRefs === undefined ? {} : {knownRefs: input.knownRefs},
      ),
    )
    if (input.visibleRefs !== undefined) {
      violations.push(
        ...checkOrphanVisibility({
          manifest: input.manifest,
          visibleRefs: input.visibleRefs,
          ...(input.storedRefs === undefined ? {} : {storedRefs: input.storedRefs}),
          ...(input.checkpointRefs === undefined ? {} : {checkpointRefs: input.checkpointRefs}),
        }),
      )
    }
  }

  for (const merge of input.merges ?? []) {
    violations.push(...checkMergeResultInvariants(merge.request, merge.result))
  }

  if (input.checkpointRenderings !== undefined) {
    violations.push(...checkCheckpointDeterminism(input.checkpointRenderings))
  }

  return violations
}
