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
import {
  classifyRequest,
  isWriteRequest,
  normalizePath,
} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
import {
  SPIKE_F_ATTACK_NUMBERS,
  SPIKE_F_UNCLASSIFIABLE_ATTACKS,
  SPIKE_F_WITNESS_GAPS,
  WRITE_GUARD_CASES,
  runWriteGuardContract,
  spikeFAttackVectors,
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

/**
 * The other degenerate guard: block everything. It passes every write case in
 * the contract, so without this check the suite could be satisfied by a guard
 * that also 403s the whole Studio. Pinning it proves the read allowlist is
 * load-bearing — the mirror image of the naive-guard check above.
 */
function denyEverythingGuard(): boolean {
  return true
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

  it('a block-everything guard fails every read case in the contract', () => {
    const reads = WRITE_GUARD_CASES.filter((c) => !c.write)
    const misclassified = reads.filter((c) => denyEverythingGuard() !== c.write)
    expect(misclassified.length).toBe(reads.length)
    // 51 read cases when default-deny landed: 41 read-passthrough + the
    // normalisation negatives + the OPTIONS preflight row + attack 24's probe.
    // Pinned as a floor so "default-deny" can never be implemented as
    // "deny everything" by quietly deleting the reads it has to keep serving.
    expect(reads.length).toBeGreaterThanOrEqual(45)
  })

  it('the pre-Spike-F guard escapes several of the promoted Spike F attacks', () => {
    const escaped = spikeFAttackVectors().filter((c) => naivePreSpikeFGuard(c) !== c.write)
    // Attacks 20, 21, 22, 23 and 24's three write shapes at minimum.
    expect(escaped.length).toBeGreaterThanOrEqual(5)
  })

  it.each(spikeFAttackVectors().filter((c) => c.write))(
    'Spike F attack $attack ($attackName) — the promoted request shape is blocked',
    ({method, url}) => {
      expect(isWriteRequest({method, url})).toBe(true)
    },
  )

  it('accounts for all 27 Spike F attacks', () => {
    const covered = new Set([
      ...spikeFAttackVectors().map((c) => c.attack),
      ...SPIKE_F_UNCLASSIFIABLE_ATTACKS.map((a) => a.attack),
    ])
    expect(SPIKE_F_ATTACK_NUMBERS.filter((n) => !covered.has(n))).toEqual([])
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

/**
 * The dot-segment reduction class, generated rather than enumerated.
 *
 * Every `..` case in the hand-written table climbs *towards* a write endpoint,
 * which any guard that resolves dot segments catches for free. The dangerous
 * direction is the other one: `..` climbing back *out* of the write segment so
 * that the canonical path is an allowlisted read while the request line still
 * says `/data/mutate`. The proxy forwards the RAW request line upstream, so a
 * guard that classifies only the canonical form has quietly agreed to disagree
 * with Content Lake about which endpoint is being addressed.
 *
 * The oracle here is independent of the guard: the write-endpoint inventory in
 * the contract. If a URL is a write, no amount of dot-segment decoration may
 * turn it into `/ping`.
 */
describe('write-guard · dot segments can never launder a write into a read', () => {
  const writeEndpoints = WRITE_GUARD_CASES.filter((c) => c.group === 'write-endpoints' && c.write)

  it('has a write-endpoint inventory to generate from', () => {
    expect(writeEndpoints.length).toBeGreaterThanOrEqual(20)
  })

  it.each(writeEndpoints)(
    'GET $url/../../../../../../ping is still a write ($why)',
    ({url}) => {
      // Six ".." is more than any of these paths has segments, so every one of
      // them canonicalises to `/ping` — an allowlisted GET read.
      const laundered = `${url.startsWith('/') ? url : `/${url}`}/../../../../../../ping`
      expect(normalizePath(laundered)).toBe('/ping')
      expect(isWriteRequest({method: 'GET', url: laundered})).toBe(true)
    },
  )

  it.each(writeEndpoints)('POST $url/../../data/query/parity is still a write ($why)', ({url}) => {
    expect(isWriteRequest({method: 'POST', url: `${url}/../../data/query/parity`})).toBe(true)
  })

  it('still allows the canonical reads those spellings were trying to impersonate', () => {
    // The mirror assertion: the rule is "dot segments are not a read", not
    // "anything ending in /ping is a write".
    expect(isWriteRequest({method: 'GET', url: '/v2025-02-19/ping'})).toBe(false)
    expect(isWriteRequest({method: 'POST', url: '/v2025-02-19/data/query/parity'})).toBe(false)
  })
})

/**
 * Under default-deny a 403 no longer means "you hit a known write endpoint" —
 * it means "nothing on the allowlist matched", which is a very different thing
 * to debug at 2am. The guard therefore has to be able to say which rule spoke.
 */
describe('classifyRequest — the reason a request was allowed or blocked', () => {
  it('agrees with isWriteRequest on every case in the contract', () => {
    const disagreements = WRITE_GUARD_CASES.filter(
      ({method, url}) => classifyRequest({method, url}).write !== isWriteRequest({method, url}),
    )
    expect(disagreements).toEqual([])
  })

  it('names the rule that allowed a read, and reports the normalised path', () => {
    const verdict = classifyRequest({method: 'GET', url: '/v2025-02-19/data/query/parity?query=*'})
    expect(verdict.write).toBe(false)
    expect(verdict.path).toBe('/data/query/parity')
    expect(verdict.reason).toMatch(/read/i)
  })

  it('reports default-deny — not a rule name — when nothing matched', () => {
    const verdict = classifyRequest({method: 'POST', url: '/v2025-02-19/projects/b1n03q3z/tokens'})
    expect(verdict.write).toBe(true)
    expect(verdict.path).toBe('/projects/b1n03q3z/tokens')
    expect(verdict.reason).toMatch(/default-deny/i)
  })

  it('reports the path the guard actually matched, not the one the caller sent', () => {
    // The whole gap-20 class in one assertion: the reason line must show the
    // canonical path so a log reader can see what the guard saw.
    expect(classifyRequest({method: 'POST', url: '/x/../%64ata//mutate/parity/'}).path).toBe(
      '/data/mutate/parity',
    )
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
