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
import type {WriteGuardCase, WriteGuardRequest} from '../src/writeGuardContract'

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

/* ------------------------------------------------------------------ *
 * P1-1 — delimiter truncation, and why the generated cases are real
 * ------------------------------------------------------------------ *
 * The security review of 2026-08-06 found that `analysePath` re-cut the path at
 * `?`/`#` after every decode pass, so a percent-encoded `?` deleted the `..`
 * segments that `readReason` step 0 exists to refuse, and a write classified as
 * a read.
 *
 * A generated case set is only worth anything if the vectors it generates are
 * genuinely dangerous, so this block does not take the contract's word for it.
 * `removeDotSegments` below is RFC 3986 §5.2.4 written out from the RFC — an
 * oracle that shares no code with the guard — and it is used to prove that the
 * RAW request line of every generated vector resolves to a write endpoint.
 * Without that, "these 250 URLs are writes" would be an assertion about a
 * string-building helper rather than about routing.
 */

/**
 * RFC 3986 §5.2.4 `remove_dot_segments`, transcribed from the RFC.
 *
 * `#` is treated as an ordinary path character on purpose: `proxy.mjs` relays
 * `pathname + search`, `splitPath` only cuts at `?`, and Node's HTTP parser
 * hands a literal `#` through in an origin-form request target unchanged
 * (verified). So this is what the bytes on the wire mean to a router that does
 * not special-case it — which is exactly the second meaning default-deny exists
 * to refuse.
 */
function removeDotSegments(path: string): string {
  let input = path
  let output = ''
  while (input.length > 0) {
    if (input.startsWith('../')) input = input.slice(3)
    else if (input.startsWith('./')) input = input.slice(2)
    else if (input.startsWith('/./')) input = `/${input.slice(3)}`
    else if (input === '/.') input = '/'
    else if (input.startsWith('/../')) {
      input = `/${input.slice(4)}`
      output = output.slice(0, Math.max(0, output.lastIndexOf('/')))
    } else if (input === '/..') {
      input = '/'
      output = output.slice(0, Math.max(0, output.lastIndexOf('/')))
    } else if (input === '.' || input === '..') input = ''
    else {
      const next = input.indexOf('/', input.startsWith('/') ? 1 : 0)
      const segment = next === -1 ? input : input.slice(0, next)
      output += segment
      input = next === -1 ? '' : input.slice(next)
    }
  }
  return output
}

/**
 * Endpoints that write to Content Lake, spelled independently of the guard:
 * the global data plane, an Agent Action, and `resourceDataBase()`'s
 * resource-scoped data plane, which mutates without a `/data/` prefix at all.
 */
const WRITE_ENDPOINT_PATTERNS = [
  /^\/data\/(?:mutate|actions)\//,
  /^\/agent\/action\/(?:patch|generate|transform|translate|prompt)\//,
  /^\/projects\/[^/]+\/datasets\/[^/]+\/(?:mutate|actions)$/,
]

const resolvesToWriteEndpoint = (path: string) =>
  WRITE_ENDPOINT_PATTERNS.some((pattern) => pattern.test(path))

describe('write-guard · encoded/raw delimiter truncation (P1-1)', () => {
  const truncationCases: WriteGuardCase[] = WRITE_GUARD_CASES.filter(
    (c) => c.group === 'encoded-delimiter' && c.write,
  )

  it('has a generated corpus to work with', () => {
    expect(truncationCases.length).toBeGreaterThanOrEqual(200)
  })

  it.each(truncationCases)(
    'the RAW request line of $method $url resolves to a write endpoint',
    ({url}) => {
      // Independent oracle: no decoding at all, because `query%3F` is simply a
      // segment to be popped. This is the meaning a CDN or origin router that
      // applies RFC 3986 to the bytes it received will arrive at.
      const resolved = removeDotSegments(url)
      expect(
        resolvesToWriteEndpoint(resolved),
        `${url} resolves to ${resolved}, which is not a write endpoint — the vector is not dangerous`,
      ).toBe(true)
    },
  )

  it.each(truncationCases)('$method $url is classified as a write', ({method, url}) => {
    expect(isWriteRequest({method, url})).toBe(true)
  })

  it('refuses because the path is ambiguous, not merely unrecognised', () => {
    // The RIGHT REASON check. A guard that happened to block these by failing
    // the allowlist lookup would be blocking them for the wrong reason and
    // would fall over on the next spelling.
    for (const {method, url} of truncationCases) {
      const verdict = classifyRequest({method, url}) as {write: boolean; reason: string}
      expect(verdict.write, `${method} ${url}`).toBe(true)
      // The two ambiguity rulings, and nothing else: a `..` the two ends would
      // resolve differently, or a `#` only one end will cut at. "Not on the
      // allowlist" here would mean the guard got the right answer by accident.
      expect(verdict.reason, `${method} ${url}`).toMatch(/"\." or "\.\."|literal "#"/)
    }
  })
})

/**
 * The RED baseline for P1-1, kept forever — the same device the pre-Spike-F
 * guard gets above.
 *
 * `truncatingNormaliser` is the shipped normaliser with the defect reinstated:
 * cut, decode, re-cut. Pinning it here means the contract can never be edited
 * back into a shape the broken normaliser would pass, which is precisely how
 * the 236-case suite came to have only the safe direction of this rule.
 */
function truncatingNormaliser(rawUrl: string): string {
  const cut = (value: string, marker: string) => {
    const index = value.indexOf(marker)
    return index === -1 ? value : value.slice(0, index)
  }
  const safeDecode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  let path = cut(cut(rawUrl, '#'), '?')
  for (let pass = 0; pass < 5; pass++) {
    const decoded = safeDecode(path)
    if (decoded === path) break
    path = cut(cut(decoded, '#'), '?') // <- the defect
  }
  if (!path.startsWith('/')) path = `/${path}`
  return path.replace(/\/{2,}/g, '/').toLowerCase().replace(/^\/v[^/]*(?=\/|$)/, '') || '/'
}

describe('write-guard · the P1-1 RED baseline, kept', () => {
  const truncationCases = WRITE_GUARD_CASES.filter(
    (c) => c.group === 'encoded-delimiter' && c.write,
  )

  it('the truncating normaliser collapses every vector onto a path with no dot segments', () => {
    // This is the bug, stated as a property: after the buggy normaliser runs,
    // there is nothing left for `readReason` step 0 to refuse.
    const survived = truncationCases.filter((c) => truncatingNormaliser(c.url).includes('..'))
    expect(survived.map((c) => c.url)).toEqual([])
  })

  it('the shipped normaliser lands on the SAME path RFC 3986 does', () => {
    /* For every vector whose delimiter is percent-encoded, the guard is allowed
     * to see the whole request line, so its canonical path must equal what
     * `remove_dot_segments` makes of the raw bytes. Equality against an
     * independent implementation is the strongest available statement that the
     * truncation is gone: a normaliser that still cut early would land on the
     * read prefix instead, and a normaliser that over-corrected would land
     * somewhere neither of us expects. */
    const encoded = truncationCases.filter((c) => !c.url.includes('#'))
    expect(encoded.length).toBeGreaterThanOrEqual(150)
    const disagreements = encoded
      .filter((c) => normalizePath(c.url) !== removeDotSegments(c.url))
      .map((c) => `${c.url}: guard=${normalizePath(c.url)} rfc=${removeDotSegments(c.url)}`)
    expect(disagreements).toEqual([])
  })

  it('a RAW "#" is cut, and the cut itself is what makes the request ambiguous', () => {
    /* The raw `#` is the one spelling the guard must keep cutting: `readAllowlist.mjs`
     * and every URL parser cut there too, so refusing to cut would put the two
     * classifiers into disagreement. What the guard must NOT do is treat the
     * truncated remainder as an ordinary read, because `proxy.mjs` forwards
     * `pathname + search` and `splitPath` never cuts at `#` — so the discarded
     * text really does reach the upstream. */
    const rawFragment = truncationCases.filter((c) => c.url.includes('#'))
    expect(rawFragment.length).toBeGreaterThanOrEqual(40)
    for (const c of rawFragment) {
      const canonical = normalizePath(c.url) as string
      expect(canonical.includes('#'), `${c.url} -> ${canonical}`).toBe(false)
      expect(isWriteRequest({method: c.method, url: c.url}), c.url).toBe(true)
    }
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
