/**
 * Native Sanity Live must not reach a branch editor's Studio (PRD §23.3, §37
 * Phase 5 "Disable native Sanity Live in overlay mode").
 *
 * WHY THIS IS A CORRECTNESS HOLE, NOT A TIDINESS ITEM
 * ──────────────────────────────────────────────────
 * Every other overlay read is a PULL: the caller asks, §22.6 plans a candidate
 * set, the overlay is merged in, `groq-js` evaluates. Sanity Live is a PUSH,
 * and it arrives from the far side of that pipeline — the Content Lake
 * evaluates the query itself and streams the ALREADY-EVALUATED result to the
 * subscriber. A live event therefore does not merely miss the overlay: it
 * arrives AFTER the overlay-resolved render and replaces it with staging
 * content, on a timer nobody controls, in a pane the editor believes is showing
 * their branch. §23.3 states the mechanism outright — "Sanity Live and
 * `client.listen()` observe Content Lake changes, not Blob or filesystem
 * mutations" — and requires overlay SSE or refetch signals instead.
 *
 * THE CLASS OF THE BUG, WHICH IS WHY THIS FILE IS NOT ONE ASSERTION
 * ────────────────────────────────────────────────────────────────
 * The instance was `client.live.events()`. The class is *a read whose delegation
 * is itself the defect* — and the read/write axis the namespace policy was built
 * on cannot express it. So this file covers:
 *
 *   - the classification (`namespaceMethodKind` must have a third answer, and
 *     `live.events` must not be a plain delegated read);
 *   - the interception, MEASURED — the underlying function must not run, on the
 *     promise client and on the observable client, through a cached namespace
 *     reference and a fresh one;
 *   - the shape of the refusal — `live.events()` is declared to return an
 *     Observable and sanity 6.8.0 calls `.subscribe({next, error})` on the
 *     result directly (`LiveQueries-rJao7vYj.js`,
 *     `PresentationToolGrantsCheck-CITNu5DG.js`), so a rejected Promise would be
 *     a TypeError at the call site rather than a refusal the host can report;
 *   - the boundary — `client.listen()` is the OTHER Content Lake push channel
 *     and is deliberately NOT refused: `wrapListen` merges it with the overlay's
 *     own local update channel (§21.9), so the pane still settles after an
 *     intercepted write. A fix that swept `listen` up with `live` would break
 *     every document pane, so the difference is pinned;
 *   - and that no OTHER namespace read was collaterally refused.
 */
import {describe, expect, it} from 'vitest'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {
  CLIENT_NAMESPACE_POLICY,
  namespaceMethodKind,
} from '../../sanity-overlay-studio/src/client/writeGuard'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const TRANSPORT = {
  apiUrl: 'http://localhost:3998',
  commit: async () => ({outcome: 'ok'}),
  operation: async () => ({outcome: 'ok'}),
  resolve: async () => ({outcome: 'ok'}),
  state: async () => ({outcome: 'ok'}),
} as unknown as OverlayTransport

/**
 * A client shaped like `@sanity/client` far enough to reach every namespace this
 * file touches, with each underlying function recording that it ran.
 *
 * The oracle is the RECORD, not the policy table: a test that only asserts the
 * classification would pass against a facade that classified correctly and
 * delegated anyway.
 */
function hostedClient(): {client: Rec; reached: string[]} {
  const reached: string[] = []
  const record =
    (label: string, result: unknown = {ok: true}) =>
    (...args: unknown[]): unknown => {
      reached.push(label)
      void args
      return result
    }

  const subscribable = {subscribe: () => ({unsubscribe: () => {}})}
  const live = {events: record('live.events', subscribable)}
  const client: Rec = {
    live,
    projects: {list: record('projects.list', Promise.resolve([]))},
    users: {getById: record('users.getById', Promise.resolve({id: 'u'}))},
    listen: record('listen', subscribable),
    fetch: async () => null,
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    getUrl: (uri: string) => `https://p.api.sanity.io${uri}`,
    getDataUrl: (op: string) => `/data/${op}/d`,
    withConfig: () => client,
  }
  /* The observable client shares the same `live` object in @sanity/client, so
   * an interception that only covered one side would still leave the other
   * open. Shared here for the same reason. */
  client.observable = {
    live,
    listen: record('observable.listen', subscribable),
    fetch: () => subscribable,
    config: () => ({projectId: 'p', dataset: 'd'}),
    getUrl: (uri: string) => `https://p.api.sanity.io${uri}`,
    getDataUrl: (op: string) => `/data/${op}/d`,
    withConfig: () => client.observable,
  }
  return {client, reached}
}

function wrapped(): {facade: Rec; reached: string[]} {
  const {client, reached} = hostedClient()
  const facade = wrapWithOverlay(client as object, {
    echo: createOverlayEcho({onError: () => {}}),
    transport: TRANSPORT,
    onError: () => {},
  }) as unknown as Rec
  return {facade, reached}
}

/** Drain an observable-shaped value to a promise, so a refusal is assertable. */
function drain(value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const source = value as {
      subscribe: (observer: {
        next?: (v: unknown) => void
        error?: (e: unknown) => void
        complete?: () => void
      }) => unknown
    }
    if (typeof source?.subscribe !== 'function') {
      reject(new Error(`not observable-shaped: ${typeof value}`))
      return
    }
    let last: unknown
    source.subscribe({
      next: (v) => {
        last = v
      },
      error: reject,
      complete: () => resolve(last),
    })
  })
}

/* ------------------------------------------------------------------ *
 * The classification
 * ------------------------------------------------------------------ */

describe('the namespace policy has a third answer for a push read', () => {
  it('does not call live.events a plain delegated read', () => {
    expect(namespaceMethodKind('live', 'events')).not.toBe('read')
  })

  it('does not call it a write either — it mutates nothing', () => {
    /* Filing it under `write` would have made the refusal happen and misreported
     * why: every message, log line and CI report about `live.events` would then
     * claim the overlay blocked an attempted mutation of the shared dataset. */
    expect(namespaceMethodKind('live', 'events')).not.toBe('write')
    expect(CLIENT_NAMESPACE_POLICY.live!.write).not.toContain('events')
  })

  it('names it a push — a read that must not be delegated', () => {
    expect(namespaceMethodKind('live', 'events')).toBe('push')
    expect(CLIENT_NAMESPACE_POLICY.live!.push).toContain('events')
    expect(CLIENT_NAMESPACE_POLICY.live!.read).not.toContain('events')
  })

  it('still declares every method the installed client.live has, across all three lists', () => {
    /* The policy's own completeness rule (`spike-a-facade-gaps.test.ts`) is that
     * no shipped method is undeclared. Adding a third list must not create a
     * hole in it. */
    const policy = CLIENT_NAMESPACE_POLICY.live!
    const declared = [...policy.read, ...policy.write, ...(policy.push ?? [])]
    expect(declared).toContain('events')
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('leaves every other namespace read a read', () => {
    expect(namespaceMethodKind('projects', 'list')).toBe('read')
    expect(namespaceMethodKind('users', 'getById')).toBe('read')
    expect(namespaceMethodKind('releases', 'get')).toBe('read')
    expect(namespaceMethodKind('mediaLibrary.video', 'getPlaybackInfo')).toBe('read')
  })

  it('still treats an unknown method as a write, so a push list cannot widen the hole', () => {
    expect(namespaceMethodKind('live', 'someFutureStream')).toBe('write')
  })
})

/* ------------------------------------------------------------------ *
 * The interception, measured
 * ------------------------------------------------------------------ */

describe('client.live.events never reaches the Content Lake through the facade', () => {
  it('does not run the underlying function', () => {
    const {facade, reached} = wrapped()
    const live = facade.live as {events: (...args: unknown[]) => unknown}

    live.events({includeDrafts: true, tag: 'presentation-loader'})

    expect(reached).toEqual([])
  })

  it('does not run it on the observable client either', () => {
    const {facade, reached} = wrapped()
    const live = (facade.observable as Rec).live as {events: (...args: unknown[]) => unknown}

    live.events()

    expect(reached).toEqual([])
  })

  it('refuses on the error channel of a real Observable, not as a rejected promise', async () => {
    const {facade} = wrapped()
    const live = facade.live as {events: (...args: unknown[]) => unknown}
    const result = live.events()

    /* sanity 6.8.0 calls `.subscribe({next, error})` on this value directly. A
     * Promise would be a TypeError at that call site — an unattributable crash
     * instead of a refusal the host can render. */
    expect(typeof (result as Rec).subscribe).toBe('function')
    await expect(drain(result)).rejects.toThrow(/sanity-overlay-studio/)
  })

  it('says what was refused and why, naming the requirement', async () => {
    const {facade} = wrapped()
    const live = facade.live as {events: (...args: unknown[]) => unknown}

    const error = await drain(live.events()).catch((caught: unknown) => caught)

    const message = String((error as Error).message)
    expect(message).toContain('live.events')
    /* §5.5 forbids silent approximation: the message has to say that the branch
     * is not what would have arrived, not merely that something was blocked. */
    expect(message).toMatch(/Content Lake/i)
    expect(message).toMatch(/§23\.3|23\.3/)
  })

  it('is refused identically through a cached namespace reference', () => {
    const {facade, reached} = wrapped()
    const first = facade.live as Rec
    const second = facade.live as Rec

    /* Namespace identity is load-bearing elsewhere (the 40k-resubscribe
     * constraint), so the refusal must survive the cache rather than depend on
     * a fresh proxy each time. */
    expect(first).toBe(second)
    expect(first.events).toBe(second.events)
    ;(first.events as () => unknown)()
    ;(second.events as () => unknown)()
    expect(reached).toEqual([])
  })

  it('reports the refusal to the host through onError', () => {
    const {client} = hostedClient()
    const messages: string[] = []
    const facade = wrapWithOverlay(client as object, {
      echo: createOverlayEcho({onError: () => {}}),
      transport: TRANSPORT,
      onError: (message) => messages.push(message),
    }) as unknown as Rec

    ;((facade.live as Rec).events as () => unknown)()

    expect(messages.filter((message) => message.includes('live.events'))).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * The boundary — what must NOT have been swept up
 * ------------------------------------------------------------------ */

describe('the fix stops at Sanity Live', () => {
  it('leaves client.listen() intercepted-and-merged, not refused', () => {
    /* §21.9: `wrapListen` merges the real listener with the overlay's local
     * update channel, so a pane waiting on an intercepted write still settles.
     * Refusing `listen` would have been the over-reach, and it would have
     * broken every document pane rather than one loader. */
    const {facade} = wrapped()
    const result = (facade.listen as (...args: unknown[]) => unknown)('*[_id in $ids]', {
      ids: ['drafts.article-1'],
    })
    expect(typeof (result as Rec).subscribe).toBe('function')
  })

  it('still delegates the ordinary namespace reads', async () => {
    const {facade, reached} = wrapped()

    await ((facade.projects as Rec).list as () => Promise<unknown>)()
    await ((facade.users as Rec).getById as (id: string) => Promise<unknown>)('someone')

    expect(reached).toEqual(['projects.list', 'users.getById'])
  })
})
