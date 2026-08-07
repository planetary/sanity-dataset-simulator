/**
 * PRD §37 Phase 5, Frontend migration: "Disable native Sanity Live in overlay
 * mode."
 *
 * ==========================================================================
 * WHY THIS IS A CORRECTNESS HOLE AND NOT A TIDINESS ITEM
 *
 * Every other overlay read is a PULL: the caller asks, §22.6 plans a candidate
 * set, the overlay is merged in, and `groq-js` evaluates the original query
 * over the resolved documents. Sanity Live is a PUSH, and it arrives from the
 * other side of that pipeline — the Content Lake evaluates the query itself and
 * streams the ALREADY-EVALUATED result to the subscriber.
 *
 * So a live event does not merely miss the overlay. It ARRIVES AFTER the
 * overlay-resolved render and replaces it with base content, on a timer nobody
 * controls, in a page the editor believes is showing their branch. That is
 * §22.1's core constraint stated backwards: post-processing a native result is
 * not sufficient, and a live push is a native result with no processing at all.
 *
 * THREE PLACES CAN CLOSE IT. This file pins the state of all three, because
 * "disabled" is only true if it is true everywhere:
 *
 *   1. THE FRONTEND CLIENT — closed, structurally. `createOverlayClient`
 *      returns an OverlayClient, not a `@sanity/client`. There is no `.live`
 *      to call, so a migrated frontend cannot subscribe even by accident.
 *   2. THE SOURCE GATE — closed. The §22.5 lint rule reports `live-bypass`,
 *      the codemod refuses the file, and both run in CI.
 *   3. THE STUDIO FACADE — closed, 2026-08-06. `client.live.events()` is
 *      classified `push` — a read that must not be delegated — and refused on
 *      the error channel of a real Observable. See section 3; the class-level
 *      coverage is `studio-live-bypass.test.ts`.
 * ==========================================================================
 */
import {describe, expect, it} from 'vitest'
import {
  M_LOCAL_QUERIES,
  checkSourceForUnregisteredQueries,
  rewriteClientImports,
} from '../../sanity-overlay-query/src/index'
import type {RegisteredQuerySummary} from '../../sanity-overlay-query/src/index'
import {createMemoryBaseSource} from '../../sanity-overlay-query/src/index'
import {createOverlayClient} from '../../sanity-overlay-client/src/client'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {
  CLIENT_NAMESPACE_POLICY,
  namespaceMethodKind,
} from '../../sanity-overlay-studio/src/client/writeGuard'

const REGISTRY: RegisteredQuerySummary[] = M_LOCAL_QUERIES.map((d) => ({id: d.id, query: d.query}))

/* ------------------------------------------------------------------ *
 * 1. The frontend client cannot subscribe, because there is nothing
 *    to subscribe to. Structure beats a flag: a flag can be unset.
 * ------------------------------------------------------------------ */

describe('the environment-aware client has no native live surface', () => {
  const client = createOverlayClient({mode: 'off', base: createMemoryBaseSource([])})

  it('exposes no `live` property at all', () => {
    expect('live' in (client as unknown as Record<string, unknown>)).toBe(false)
    expect((client as unknown as Record<string, unknown>).live).toBeUndefined()
  })

  it('exposes no `listen` either — the other push channel', () => {
    expect((client as unknown as Record<string, unknown>).listen).toBeUndefined()
  })

  it('offers the overlay-aware replacement instead, so the need is met', () => {
    // §37 Phase 5 pairs "disable native Sanity Live" with "add overlay event
    // refetch". Removing a capability without the replacement would just be a
    // regression, so both halves are asserted.
    expect(typeof client.watch).toBe('function')
    expect(typeof client.revalidate).toBe('function')
  })

  it('the surface is exactly the overlay read API, so nothing pushes into it', () => {
    const surface = Object.keys(client).sort()
    expect(surface).toEqual([
      'fetch',
      'fetchWithDiagnostics',
      'mode',
      'overlayRevision',
      'revalidate',
      'watch',
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 2. The source gate. Both §22.5 tools see a live subscription, and
 *    they disagree about the fix in the right direction: the lint rule
 *    names it, the codemod refuses to "migrate" it.
 * ------------------------------------------------------------------ */

describe('the §22.5 gates report native Sanity Live', () => {
  const source = `import {defineLive} from 'next-sanity'\nexport const {sanityFetch} = defineLive({client})\n`

  it('the lint rule reports live-bypass in error mode', () => {
    const findings = checkSourceForUnregisteredQueries({
      file: 'app/live.ts',
      source,
      registry: REGISTRY,
      mode: 'strict',
    })
    expect(findings.map((f) => f.code)).toEqual(['live-bypass'])
    expect(findings[0].severity).toBe('error')
  })

  it('the codemod refuses the file rather than swapping the import', () => {
    const result = rewriteClientImports({file: 'app/live.ts', source}, {registry: REGISTRY})
    expect(result.refusals.map((r) => r.construct)).toEqual(['live-subscription'])
    expect(result.changed).toBe(false)
    expect(result.code).toBe(source)
  })

  it('the refusal explains that a swap would leave the subscription running', () => {
    const [refusal] = rewriteClientImports({file: 'a.ts', source}, {registry: REGISTRY}).refusals
    expect(refusal.reason).toMatch(/Content Lake/i)
    expect(refusal.reason).toMatch(/remove/i)
  })
})

/* ------------------------------------------------------------------ *
 * 3. THE STUDIO FACADE — THE HOLE THAT IS STILL OPEN.
 *
 * `packages/sanity-overlay-studio/**` is owned by another agent, so this
 * section is EVIDENCE and a REQUIREMENT, not a fix. It is written to be
 * self-cleaning: the moment the facade stops delegating `live.events`,
 * the `.fails` cases below go red and whoever changed it has to come
 * here and promote them to ordinary `it(…)`.
 * ------------------------------------------------------------------ */

/** A client shaped like `@sanity/client` far enough to reach `live.events`. */
function fakeHostedClient(): {client: Record<string, unknown>; reached: string[]} {
  const reached: string[] = []
  const client: Record<string, unknown> = {
    live: {
      events: (...args: unknown[]) => {
        reached.push(`live.events(${JSON.stringify(args)})`)
        return {subscribe: () => ({unsubscribe: () => {}})}
      },
    },
    fetch: async () => null,
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    getUrl: (uri: string) => `https://p.api.sanity.io${uri}`,
    listen: () => ({subscribe: () => ({unsubscribe: () => {}})}),
  }
  return {client, reached}
}

function wrapped(): {reached: string[]; client: Record<string, unknown>} {
  const {client, reached} = fakeHostedClient()
  const facade = wrapWithOverlay(client as object, {
    echo: createOverlayEcho({onError: () => {}}),
    transport: {
      apiUrl: 'http://localhost:3998',
      commit: async () => ({outcome: 'ok'}) as never,
      resolve: async () => ({outcome: 'ok'}) as never,
      query: async () => ({outcome: 'ok'}) as never,
      state: async () => ({outcome: 'ok'}) as never,
    } as never,
    onError: () => {},
  }) as unknown as Record<string, unknown>
  return {reached, client: facade}
}

describe('THE STUDIO FACADE — closed, 2026-08-06', () => {
  /*
   * ───────────────────────────────────────────────────────────────────────────
   * These two assertions were pinned `.fails` while the hole was open, next to
   * two "MEASURED TODAY" cases recording the bypass as it then was. The fix has
   * landed in `packages/sanity-overlay-studio/src/client/`, so both `.fails`
   * markers and both evidence cases are gone — a measurement of a defect that
   * no longer exists is a test asserting the wrong thing.
   *
   * WHAT CHANGED:
   *
   *   writeGuard.ts   `NamespacePolicy` gained a third list, `push`, and
   *                   `namespaceMethodKind` a third answer. `live.events`
   *                   mutates nothing, so calling it a write would have
   *                   misreported every message about it as a blocked mutation
   *                   of the shared dataset; the read/write axis could not
   *                   express "a read whose delegation is the defect".
   *
   *   facade.ts       `wrapNamespace` refuses a `push` method through
   *                   `refuseLivePush`, which returns an ERRORING OBSERVABLE on
   *                   both the promise and observable clients — `live.events()`
   *                   is declared to return one and sanity 6.8.0 calls
   *                   `.subscribe({next, error})` on the result directly, so a
   *                   rejected Promise would have been a TypeError at the call
   *                   site rather than a refusal. Refusal, not a partial stream
   *                   fed from the echo: §5.5 forbids presenting an
   *                   approximation as the real thing.
   *
   * The class of the bug — other push reads, the observable client, the cached
   * namespace reference, and the `client.listen()` boundary that must NOT be
   * swept up with it — is covered in `studio-live-bypass.test.ts`.
   * ───────────────────────────────────────────────────────────────────────────
   */

  it('the write guard no longer classifies live.events as an ordinary read', () => {
    expect(namespaceMethodKind('live', 'events')).toBe('push')
    expect(CLIENT_NAMESPACE_POLICY.live.read).not.toContain('events')
  })

  it('live.events must NOT reach the hosted client through the facade', () => {
    const {reached, client} = wrapped()
    const live = client.live as {events: (...args: unknown[]) => unknown}
    try {
      live.events({includeDrafts: true})
    } catch {
      /* A refusal is a correct outcome; reaching the Content Lake is not. */
    }
    expect(reached).toEqual([])
  })

  it('live.events must not be classified as a plain delegated read', () => {
    expect(namespaceMethodKind('live', 'events')).not.toBe('read')
  })
})
