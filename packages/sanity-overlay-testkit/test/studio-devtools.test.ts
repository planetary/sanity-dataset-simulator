/**
 * THE INSTRUMENT. `window.__SANITY_OVERLAY__`.
 *
 * The spike exposed `window.__SPIKE_ECHO__` with a read ledger, and every
 * previous diagnosis of "the pane is showing staging" was made by reading it.
 * The shipped plugin exposed NOTHING — a live browser session on 2026-08-06
 * found only `__SPIKE_ES__` on `window` — so the same diagnosis cost a browser
 * session instead of a minute.
 *
 * `reads.ts` calls its ledger "the diagnostic surface §22.5 requires: a read
 * recorded as `passthrough` was answered by the base dataset and may not
 * reflect branch edits, and the only way an editor can know that is if
 * something keeps the list". A list nothing can reach is not a surface.
 *
 * WHAT IT HAS TO CARRY, and why each one:
 *
 *   `reads()`     which query was answered from the branch, which was sent to
 *                 staging, and WITH WHAT REASON — the passthrough reason is the
 *                 whole diagnosis
 *   `branch()`    what the read path believes the branch holds. "Is hydration
 *                 empty?" is the first question every time and it must not need
 *                 a second tool
 *   `status()`    the §21.3 state the banner renders, so a wrong banner can be
 *                 attributed to the state or to the rendering
 *   `session()`   the §18.9 session state plus the auth-failure log — defect 1's
 *                 surface
 *   `messages()`  the log the banner shows on demand
 *   `refresh()`   force a `/state` poll rather than waiting out the 5 s timer
 *
 * NO `window` IN THE MODULE UNDER TEST. The target object is injected, exactly
 * as React is injected into the banner, so this file runs in plain Node.
 */
import {describe, expect, it} from 'vitest'

import {
  OVERLAY_DEVTOOLS_GLOBAL,
  installOverlayDevtools,
  type OverlayDevtools,
} from '../../sanity-overlay-studio/src/devtools'
import {overlayWorkspacePatch} from '../../sanity-overlay-studio/src/config'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {clearOverlayRuntimes, createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-01',
    schemaType: 'article',
    draft: {_id: 'drafts.article-01', _type: 'article', title: 'Article 1 — OVERLAY EDIT ✅ 日本語'},
    published: null,
  },
  {logicalId: 'article-02', schemaType: 'article', draftTombstone: true},
]

const STAGING: Rec[] = [
  {_id: 'article-01', _type: 'article', title: 'Article 1'},
  {_id: 'drafts.article-01', _type: 'article', title: 'Article 1'},
]

function stagingClient(): Rec {
  return {
    fetch: async (query: string, params: Rec = {}): Promise<unknown> => {
      const {parse, evaluate} = await import('groq-js')
      return await (await evaluate(parse(query), {dataset: STAGING, params})).get()
    },
  }
}

function stateFetch(documents: OverlayHydrationDocument[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ok: true, revision: 2, documents}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    })) as unknown as typeof fetch
}

function runtimeWith(documents: OverlayHydrationDocument[]): ReturnType<typeof createOverlayRuntime> {
  return createOverlayRuntime({
    resolved: resolveOverlayOptions({mode: 'fs', apiUrl: 'http://localhost:3998'}, {}),
    createClient: () => stagingClient(),
    fetch: stateFetch(documents),
  })
}

/* ══════════════════════════════════════════════════════════════════ §1 */

describe('§1 the global is installed and documented', () => {
  it('is named, and the name is exported rather than typed from memory', () => {
    expect(OVERLAY_DEVTOOLS_GLOBAL).toBe('__SANITY_OVERLAY__')
  })

  it('installs onto the injected target', () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    expect(typeof target[OVERLAY_DEVTOOLS_GLOBAL]).toBe('object')
  })

  it('carries a one-line help string, so the surface documents itself', () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    expect(devtools.help).toContain('reads()')
    expect(devtools.help).toContain('branch()')
  })

  it('does not throw when there is no target at all (server render, Node)', () => {
    expect(() => installOverlayDevtools(runtimeWith(BRANCH), undefined)).not.toThrow()
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 */

describe('§2 the read ledger is reachable, with its reasons', () => {
  it('shows an overlay-answered read and a passthrough side by side', async () => {
    const target: Rec = {}
    const runtime = runtimeWith(BRANCH)
    await runtime.refresh()
    installOverlayDevtools(runtime, target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools

    const client = runtime.clientFactory({}) as Rec
    const fetch = client.fetch as (q: string, p?: Rec, o?: Rec) => Promise<unknown>
    await fetch('*[_type == "article"]{_id, title}')
    await fetch('count(*)').catch(() => undefined)

    expect(devtools.reads().map((record) => record.outcome)).toEqual(['overlay', 'passthrough'])
  })

  it('carries the passthrough REASON — the thing a diagnosis is actually made from', async () => {
    const target: Rec = {}
    const runtime = runtimeWith(BRANCH)
    await runtime.refresh()
    installOverlayDevtools(runtime, target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools

    const client = runtime.clientFactory({}) as Rec
    /* A release perspective: the branch holds no release version and none can
     * be enumerated, so this is a genuine passthrough and the reason says why. */
    await (client.fetch as (q: string, p?: Rec, o?: Rec) => Promise<unknown>)(
      '*[_type == "article"]{_id}',
      {},
      {perspective: ['rSummer', 'drafts']},
    ).catch(() => undefined)

    const [record] = devtools.reads()
    expect(record.outcome).toBe('passthrough')
    expect(record.reason).toMatch(/perspective/i)
  })

  it('is live, not a snapshot taken at install time', async () => {
    const target: Rec = {}
    const runtime = runtimeWith(BRANCH)
    installOverlayDevtools(runtime, target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    expect(devtools.reads()).toEqual([])

    await runtime.refresh()
    const client = runtime.clientFactory({}) as Rec
    await (client.fetch as (q: string) => Promise<unknown>)('*[_type == "article"]{_id}')
    expect(devtools.reads()).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 */

describe('§3 branch() answers "is the branch even loaded?" without a second tool', () => {
  it('is empty before /state has been read', () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    expect(devtools.branch()).toEqual(
      expect.objectContaining({documents: [], tombstones: [], revision: undefined}),
    )
  })

  it('lists the addresses the branch holds and suppresses, once /state has landed', async () => {
    const target: Rec = {}
    const runtime = runtimeWith(BRANCH)
    await runtime.refresh()
    installOverlayDevtools(runtime, target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools

    expect(devtools.branch()).toEqual(
      expect.objectContaining({
        documents: ['drafts.article-01'],
        tombstones: ['drafts.article-02'],
        revision: 2,
        connection: 'ok',
      }),
    )
  })

  it('refresh() forces a poll rather than waiting out the banner timer', async () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    await devtools.refresh()
    expect(devtools.branch().documents).toEqual(['drafts.article-01'])
  })
})

/* ══════════════════════════════════════════════════════════════════ §4 */

describe('§4 status, session and messages', () => {
  it('exposes the §21.3 state the banner renders', () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    expect(devtools.status().state).toBe('healthy')
  })

  it('exposes the session state and the auth-failure log — defect 1’s surface', () => {
    const target: Rec = {}
    const runtime = runtimeWith(BRANCH)
    installOverlayDevtools(runtime, target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools

    expect(devtools.session()).toEqual({state: 'active', failures: []})
    runtime.echo.noteAuthFailure({status: 401, source: 'read', message: 'token expired'})
    expect(devtools.session()).toEqual({
      state: 'unauthenticated',
      failures: [{status: 401, source: 'read', message: 'token expired'}],
    })
  })

  it('exposes the message log', () => {
    const target: Rec = {}
    installOverlayDevtools(runtimeWith(BRANCH), target)
    const devtools = target[OVERLAY_DEVTOOLS_GLOBAL] as OverlayDevtools
    expect(Array.isArray(devtools.messages())).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════ §5 */

describe('§5 the shipped config installs it, and `off` mode does not', () => {
  it('installs the global when the overlay is enabled', () => {
    clearOverlayRuntimes()
    const target: Rec = {}
    overlayWorkspacePatch(
      {name: 'default'},
      {
        mode: 'fs',
        apiUrl: 'http://localhost:3998',
        env: {},
        createClient: () => stagingClient(),
        fetch: stateFetch(BRANCH),
        devtoolsTarget: target,
      },
    )
    expect(target[OVERLAY_DEVTOOLS_GLOBAL]).toBeDefined()
  })

  it('installs NOTHING in `off` mode — native Sanity is restored exactly', () => {
    clearOverlayRuntimes()
    const target: Rec = {}
    overlayWorkspacePatch(
      {name: 'default'},
      {mode: 'off', env: {}, createClient: () => stagingClient(), devtoolsTarget: target},
    )
    expect(target[OVERLAY_DEVTOOLS_GLOBAL]).toBeUndefined()
  })
})
