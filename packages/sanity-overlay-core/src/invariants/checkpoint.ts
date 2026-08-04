/**
 * §34.17 — "Checkpoint output is deterministic for the same logical state."
 * Plan §8.3 scopes this to a serializer-level assertion; checkpoint I/O is
 * Phase 3/7.
 */
import {parse, serialize} from '../serialize'
import type {OverlayInvariantViolation} from './types'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Assert that every rendering of one logical state produces the same canonical
 * bytes, and that each rendering survives a serialize/parse round trip
 * unchanged.
 *
 * Both halves are needed. Byte equality alone would accept two values that agree
 * only because the serializer lost the same information twice; the fixpoint
 * alone would accept a checkpoint that quietly embeds a timestamp. A value the
 * canonical serializer rejects outright (`NaN`, `Infinity`, a bigint) is not
 * checkpointable at all and is reported here rather than thrown, so a debug
 * caller gets the whole list.
 */
export function checkCheckpointDeterminism(
  renderings: readonly unknown[],
): OverlayInvariantViolation[] {
  const violations: OverlayInvariantViolation[] = []
  const bytes: string[] = []

  renderings.forEach((rendering, index) => {
    let canonical: string
    try {
      canonical = serialize(rendering)
    } catch (error) {
      violations.push({
        invariant: '34.17',
        message: `Checkpoint rendering ${index} is not canonically serializable, so its output cannot be deterministic: ${describe(error)}`,
      })
      return
    }

    try {
      const roundTripped = serialize(parse(canonical))
      if (roundTripped !== canonical) {
        violations.push({
          invariant: '34.17',
          message: `Checkpoint rendering ${index} is not a serialization fixpoint: serialize(parse(serialize(x))) differs from serialize(x)`,
        })
      }
    } catch (error) {
      violations.push({
        invariant: '34.17',
        message: `Checkpoint rendering ${index} does not survive a canonical round trip: ${describe(error)}`,
      })
      return
    }

    bytes[index] = canonical
  })

  const first = bytes.find((value) => value !== undefined)
  if (first === undefined) return violations

  bytes.forEach((value, index) => {
    if (value === undefined || value === first) return
    violations.push({
      invariant: '34.17',
      message: `Checkpoint renderings of the same logical state are not byte-identical: rendering ${index} differs from the first`,
    })
  })

  return violations
}
