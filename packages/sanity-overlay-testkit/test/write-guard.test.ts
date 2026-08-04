/**
 * The write-guard contract, run against the Spike B proxy's guard (PRD §35.14).
 *
 * The second block is the permanent record of this suite's RED baseline: the
 * pre-Spike-F predicate is kept here forever and re-checked on every run, so a
 * future edit that quietly weakens the contract until the old, broken guard
 * would pass it fails loudly instead. A contract no bad implementation can
 * fail is not a contract.
 */
import {describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {isWriteRequest, normalizePath} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
import {
  SPIKE_F_WITNESS_GAPS,
  WRITE_GUARD_CASES,
  runWriteGuardContract,
  spikeFWitnesses,
} from '../src/writeGuardContract'
import type {WriteGuardRequest} from '../src/writeGuardContract'

runWriteGuardContract('spikeB-proxy writeGuard.isWriteRequest', isWriteRequest)

/**
 * The guard Spike F defeated: `/\/data\/(mutate|actions)\b/` over the raw URL,
 * with GET/HEAD/OPTIONS short-circuited to "not a write".
 */
function naivePreSpikeFGuard({method, url}: WriteGuardRequest): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  return /\/data\/(mutate|actions)\b/.test(url)
}

describe('write-guard contract · non-vacuity (the RED baseline, kept)', () => {
  it('the pre-Spike-F guard fails a substantial part of the contract', () => {
    const misclassified = WRITE_GUARD_CASES.filter(
      (c) => naivePreSpikeFGuard(c) !== c.write,
    )
    // 63 of 124 at the moment the contract was written. Pinned as a floor so
    // the suite can grow but cannot be hollowed out.
    expect(misclassified.length).toBeGreaterThanOrEqual(60)
  })

  it.each(spikeFWitnesses())(
    'Spike F gap $gap · $method $url — old guard escapes, new guard blocks',
    ({method, url, write}) => {
      expect(naivePreSpikeFGuard({method, url})).not.toBe(write)
      expect(isWriteRequest({method, url})).toBe(write)
    },
  )

  it('carries a witness for every URL-classification gap Spike F found', () => {
    const gaps = new Set(spikeFWitnesses().map((c) => c.gap))
    for (const gap of SPIKE_F_WITNESS_GAPS) expect(gaps.has(gap)).toBe(true)
  })
})

describe('normalizePath', () => {
  it.each([
    ['data/mutate/parity', '/data/mutate/parity'],
    ['/v2025-02-19/data/mutate/parity', '/data/mutate/parity'],
    ['//data//mutate//parity//', '/data/mutate/parity'],
    ['/%2Fdata%2Fmutate%2Fparity', '/data/mutate/parity'],
    ['/x/../data/./mutate/parity?tag=a#b', '/data/mutate/parity'],
    ['https://p.api.sanity.io/vX/data/mutate/parity', '/data/mutate/parity'],
    ['/../../../etc/passwd', '/etc/passwd'],
    ['', '/'],
    ['/v1', '/'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected)
  })

  it('never throws on a malformed percent-escape', () => {
    expect(() => normalizePath('/data/mutate/%zz%')).not.toThrow()
    expect(normalizePath('/data/mutate/%zz%')).toBe('/data/mutate/%zz%')
  })
})
