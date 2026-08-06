/**
 * `sanity-overlay-studio` — the status banner component (PRD §21.3, §28.3).
 *
 * React is *injected* into the layout factory, so the component's real decisions
 * can be asserted in plain Node against a fake `createElement`: no DOM, no
 * renderer, no jsdom dependency added to the suite. What is checked here is what
 * a browser check could only check more slowly —
 *
 *   - the banner is shown on every screen and **never replaces** the Studio,
 *     because a layout that does not call `renderDefault` silently kills every
 *     downstream layout including Sanity's own;
 *   - a fatal state DOES replace it, because §21.3 says "Fatal screen. No reads
 *     or writes" and leaving the editor mounted invites the writes the state
 *     exists to prevent;
 *   - conflicts and their §28.3 actions reach the surface (§28.1 "conflicts are
 *     never hidden").
 */
import {describe, expect, it, vi} from 'vitest'
import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {
  clearOverlayRuntimes,
  createOverlayRuntime,
  registerOverlayRuntime,
} from '../../sanity-overlay-studio/src/runtime'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {
  createOverlayStatusLayout,
  overlayBannerViewModel,
  type ReactLike,
} from '../../sanity-overlay-studio/src/ui/statusLayout'

interface FakeElement {
  type: string
  props: Record<string, unknown>
  children: FakeElement[]
}

function fakeReact(): ReactLike & {effects: (() => void | (() => void))[]} {
  const effects: (() => void | (() => void))[] = []
  return {
    effects,
    createElement: (type: unknown, props?: unknown, ...children: unknown[]): FakeElement => ({
      type: String(type),
      props: (props ?? {}) as Record<string, unknown>,
      children: children.filter(Boolean) as FakeElement[],
    }),
    useEffect: (effect) => {
      effects.push(effect)
    },
    useState: <S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] => [
      typeof initial === 'function' ? (initial as () => S)() : initial,
      () => {},
    ],
  }
}

function flatten(node: unknown, out: FakeElement[] = []): FakeElement[] {
  if (typeof node !== 'object' || node === null) return out
  const element = node as FakeElement
  if (typeof element.type === 'string') out.push(element)
  for (const child of element.children ?? []) flatten(child, out)
  return out
}

function textOf(node: unknown): string {
  return flatten(node)
    .flatMap((element) => element.children.filter((child) => typeof child === 'string'))
    .join(' | ')
}

function findBanner(node: unknown): FakeElement | undefined {
  return flatten(node).find((element) => element.props['data-testid'] === 'overlay-status-banner')
}

interface HarnessOptions {
  fetchResult?: unknown
  fetchThrows?: boolean
}

function harness(options: HarnessOptions = {}) {
  clearOverlayRuntimes()
  const resolved = resolveOverlayOptions({mode: 'fs'}, {})
  const runtime = createOverlayRuntime({
    resolved,
    createClient: (clientOptions) => createClient(clientOptions as never),
    fetch: (async () => {
      if (options.fetchThrows) throw new Error('ECONNREFUSED')
      return {
        status: 200,
        text: async () =>
          JSON.stringify(options.fetchResult ?? {ok: true, revision: 3, documents: []}),
      } as never
    }) as unknown as typeof fetch,
  })
  registerOverlayRuntime('*', runtime)
  return {runtime, react: fakeReact()}
}

describe('the banner is additive, never a replacement', () => {
  it('calls renderDefault and keeps its output in the tree', () => {
    const {react} = harness()
    const Layout = createOverlayStatusLayout(react)
    const renderDefault = vi.fn(() => react.createElement('main', {'data-testid': 'studio'}))

    const tree = Layout({renderDefault})

    expect(renderDefault).toHaveBeenCalledTimes(1)
    expect(flatten(tree).some((element) => element.props['data-testid'] === 'studio')).toBe(true)
    expect(findBanner(tree)).toBeDefined()
  })

  it('renders the Studio untouched when no overlay runtime is registered', () => {
    clearOverlayRuntimes()
    const react = fakeReact()
    const Layout = createOverlayStatusLayout(react)
    const tree = Layout({renderDefault: () => react.createElement('main', {'data-testid': 'studio'})})
    expect(findBanner(tree)).toBeUndefined()
  })
})

describe('what the banner says', () => {
  it('shows the §21.3 lines', () => {
    const {react} = harness()
    const Layout = createOverlayStatusLayout(react)
    const text = textOf(Layout({renderDefault: () => react.createElement('main')}))

    expect(text).toContain('BRANCH OVERLAY')
    expect(text).toMatch(/Storage: filesystem/)
    expect(text).toMatch(/Base: .*read only/)
    expect(text).toMatch(/Conflicts: 0 soft, 0 hard/)
    expect(text).toMatch(/Checkpoint: up to date/)
    expect(text).toMatch(/Overlay API: http:\/\/localhost:3998/)
  })

  it('exposes the state and severity as data attributes a browser check can assert on', () => {
    const {react} = harness()
    const Layout = createOverlayStatusLayout(react)
    const banner = findBanner(Layout({renderDefault: () => react.createElement('main')}))
    expect(banner?.props['data-overlay-state']).toBe('healthy')
    expect(banner?.props['data-overlay-severity']).toBe('neutral')
  })

  it('turns critical and hides the Studio when the session is over', () => {
    const {runtime, react} = harness()
    runtime.echo.logout()
    const Layout = createOverlayStatusLayout(react)
    const tree = Layout({renderDefault: () => react.createElement('main', {'data-testid': 'studio'})})
    const banner = findBanner(tree)
    expect(banner?.props['data-overlay-severity']).toBe('critical')
    expect(flatten(tree).some((element) => element.props['data-testid'] === 'overlay-fatal')).toBe(
      false,
    )
    /* read-only, not fatal: reads still work, so the editor stays mounted */
    expect(banner?.props['data-overlay-state']).toBe('unauthenticated')
  })

  it('reports the overlay API as unreachable once a refresh fails', async () => {
    const {runtime, react} = harness({fetchThrows: true})
    await runtime.refresh()
    const Layout = createOverlayStatusLayout(react)
    const banner = findBanner(Layout({renderDefault: () => react.createElement('main')}))
    expect(banner?.props['data-overlay-state']).toBe('offline')
  })

  it('picks up the overlay revision from a refresh', async () => {
    const {runtime, react} = harness({fetchResult: {ok: true, revision: 9, documents: []}})
    await runtime.refresh()
    const Layout = createOverlayStatusLayout(react)
    expect(textOf(Layout({renderDefault: () => react.createElement('main')}))).toMatch(
      /Overlay revision: 9/,
    )
  })
})

describe('conflicts reach the surface (§28.1)', () => {
  const CONFLICT = {
    id: 'c1',
    documentId: 'article-1',
    severity: 'hard',
    type: 'BASE_DOCUMENT_DELETED',
    detectedAt: '2026-08-01T00:00:00.000Z',
  }

  it('lists each conflict with its §28.3 actions', async () => {
    const {runtime, react} = harness({
      fetchResult: {
        ok: true,
        revision: 1,
        documents: [{logicalId: 'article-1', conflicts: [CONFLICT]}],
      },
    })
    await runtime.refresh()

    const model = overlayBannerViewModel(runtime)
    expect(model.conflicts).toHaveLength(1)
    expect(model.conflicts[0].actions.map((action) => action.action)).toEqual([
      'keep-as-branch-created',
      'accept-base-deletion',
    ])

    const Layout = createOverlayStatusLayout(react)
    const text = textOf(Layout({renderDefault: () => react.createElement('main')}))
    expect(text).toContain('article-1')
    expect(text).toContain('Accept base deletion')
  })

  it('turns the banner critical on a hard conflict and blocks publish', async () => {
    const {runtime, react} = harness({
      fetchResult: {ok: true, documents: [{logicalId: 'article-1', conflicts: [CONFLICT]}]},
    })
    await runtime.refresh()
    const Layout = createOverlayStatusLayout(react)
    const banner = findBanner(Layout({renderDefault: () => react.createElement('main')}))
    expect(banner?.props['data-overlay-state']).toBe('hard-conflict')
    expect(runtime.status().publishBlocked).toBe(true)
  })

  it('says so when the overlay API does not report conflicts at all', async () => {
    const {runtime, react} = harness({
      fetchResult: {ok: true, documents: [{logicalId: 'article-1'}]},
    })
    await runtime.refresh()
    const Layout = createOverlayStatusLayout(react)
    expect(textOf(Layout({renderDefault: () => react.createElement('main')}))).toMatch(
      /does not report conflicts/i,
    )
  })
})

describe('the fatal screen', () => {
  it('replaces the Studio when the overlay identity does not match', async () => {
    clearOverlayRuntimes()
    const runtime = createOverlayRuntime({
      resolved: resolveOverlayOptions({mode: 'fs', overlayId: 'branch-mine'}, {}),
      createClient: (clientOptions) => createClient(clientOptions as never),
      fetch: (async () =>
        ({
          status: 200,
          text: async () => JSON.stringify({ok: true, overlayId: 'branch-someone-else'}),
        }) as never) as unknown as typeof fetch,
    })
    registerOverlayRuntime('*', runtime)
    await runtime.refresh()

    const react = fakeReact()
    const Layout = createOverlayStatusLayout(react)
    const tree = Layout({renderDefault: () => react.createElement('main', {'data-testid': 'studio'})})

    expect(flatten(tree).some((element) => element.props['data-testid'] === 'overlay-fatal')).toBe(
      true,
    )
    expect(flatten(tree).some((element) => element.props['data-testid'] === 'studio')).toBe(false)
  })
})

describe('the effect wiring', () => {
  it('subscribes, polls and cleans up after itself', () => {
    const {runtime, react} = harness()
    const Layout = createOverlayStatusLayout(react, {pollMs: 10_000})
    Layout({renderDefault: () => react.createElement('main')})

    expect(react.effects).toHaveLength(1)
    const teardown = react.effects[0]()
    expect(runtime.status()).toBeDefined()
    expect(typeof teardown).toBe('function')
    ;(teardown as () => void)()
  })
})
