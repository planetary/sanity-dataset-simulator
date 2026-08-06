/**
 * The packaged default-deny write guard, under the same contract as the proxy.
 *
 * `test/write-guard.test.ts` runs `runWriteGuardContract` against
 * `examples/kitchen-sink/spikeB-proxy/writeGuard.mjs` — a local Node process
 * that **does not exist in a deployed preview**. This file runs the identical
 * 236-case contract against `sanity-overlay-client`'s packaged classifier, the
 * one a deployment's own origin can actually import and run server-side.
 *
 * Two implementations, one contract. The contract is the oracle for both, so
 * neither can drift without a failure, and the port cannot be "verified" by the
 * code that was ported.
 */
import {describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {isWriteRequest as proxyIsWriteRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
import {runWriteGuardContract, WRITE_GUARD_CASES} from '../src/writeGuardContract'
import {
  ALLOWED_REALTIME_RPC_METHODS,
  classifyPreviewRequest,
  classifyRealtimeRpcMethod,
  isPreviewWriteRequest,
  normalizePreviewPath,
} from '../../sanity-overlay-client/src/previewWriteGuard'

runWriteGuardContract('sanity-overlay-client previewWriteGuard', isPreviewWriteRequest)

describe('the packaged guard and the proxy guard agree, case for case', () => {
  /**
   * The contract already pins both to the same expected answers. This asserts
   * the stronger property the contract cannot: that they agree on EVERY case
   * simultaneously, so a future contract edit that relaxed an expectation could
   * not let one implementation quietly diverge from the other.
   */
  it('answers identically for all contract cases', () => {
    const disagreements: string[] = []
    for (const testCase of WRITE_GUARD_CASES) {
      const request = {method: testCase.method, url: testCase.url}
      const packaged = isPreviewWriteRequest(request)
      const proxy = proxyIsWriteRequest(request) as boolean
      if (packaged !== proxy) {
        disagreements.push(`${testCase.method} ${testCase.url}: packaged=${packaged} proxy=${proxy}`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('normalises paths identically for the whole corpus', () => {
    /* Normalisation is where every historical bug lived, so the two are
     * compared on the canonical string as well as the verdict. */
    const paths = new Set(WRITE_GUARD_CASES.map((c) => c.url))
    for (const url of paths) {
      expect(`${url} -> ${normalizePreviewPath(url)}`).toBe(
        `${url} -> ${classifyPreviewRequest({method: 'GET', url}).path}`,
      )
    }
  })
})

describe('the verdict explains itself, because default-deny 403s are opaque otherwise', () => {
  it('names the canonical path it matched on, not the one the caller sent', () => {
    const verdict = classifyPreviewRequest({
      method: 'POST',
      url: '/v2025-02-19//data/./mutate//parity/',
    })
    expect(verdict.write).toBe(true)
    expect(verdict.path).toBe('/data/mutate/parity')
  })

  it('distinguishes "not on the allowlist" from "path is ambiguous"', () => {
    expect(classifyPreviewRequest({method: 'POST', url: '/descriptors/claim'}).reason).toMatch(
      /allowlist/i,
    )
    expect(
      classifyPreviewRequest({method: 'GET', url: '/data/mutate/parity/../../query/parity'}).reason,
    ).toMatch(/\.\./)
  })

  it('names the read that let a request through', () => {
    expect(classifyPreviewRequest({method: 'GET', url: '/v1/data/query/parity'}).reason).toMatch(
      /data-plane read/i,
    )
    expect(classifyPreviewRequest({method: 'GET', url: '/v1/users/me'}).reason).toMatch(
      /allowlisted read namespace/i,
    )
    expect(classifyPreviewRequest({method: 'OPTIONS', url: '/data/mutate/parity'}).reason).toMatch(
      /preflight/i,
    )
  })
})

describe('the realtime leg — the bifur socket declares a `mutate` RPC method', () => {
  it('refuses `mutate`, which is the whole reason this classifier exists', () => {
    expect(classifyRealtimeRpcMethod('mutate').write).toBe(true)
    expect(ALLOWED_REALTIME_RPC_METHODS.has('mutate')).toBe(false)
  })

  it.each([
    'authorization',
    'presence',
    'presence_rollcall',
    'presence_announce',
    'presence_disconnect',
    'listen',
    'doc',
    'query',
    'presence_subscribe',
    'presence_unsubscribe',
    'listen_subscribe',
    'listen_unsubscribe',
    'authorization_subscribe',
    'authorization_unsubscribe',
  ])('allows the read/session method %s', (method) => {
    expect(classifyRealtimeRpcMethod(method).write).toBe(false)
  })

  it.each([
    ['whitespace padding', '  mutate  '],
    ['upper case', 'MUTATE'],
    ['a derived form of a non-subscribe method', 'doc_subscribe'],
    ['a derived form of the blocked method', 'mutate_subscribe'],
    ['a plausible neighbour', 'mutation'],
    ['empty', ''],
  ])('refuses %s — method names are exact tokens', (_label, method) => {
    expect(classifyRealtimeRpcMethod(method).write).toBe(true)
  })

  it.each([undefined, null, 42, {method: 'query'}, ['query']])(
    'refuses a frame whose method is %s',
    (method) => {
      expect(classifyRealtimeRpcMethod(method).write).toBe(true)
    },
  )
})
