/**
 * The §28.3 conflict panel as a THING ON SCREEN, and the §21.7 document actions
 * that open it.
 *
 * Everything the panel decides was already built and tested — `conflictPanel.ts`
 * for the rows, filters, previews and `planConflictResolution`, `conflicts.ts`
 * for the four §28.3 value rows, `documentActions.ts` for the controller. None
 * of it was reachable: there was no component, and `config.ts` installed only
 * the availability filter, so `overlayDocumentActionsResolver` — the function
 * that puts the overlay's own actions in the menu — was never called by
 * anything. A conflict an editor cannot see is a conflict §28.1 does not
 * prevent.
 *
 * WHAT IS TESTED HERE, AND WHY IT IS TESTABLE IN NODE
 * ──────────────────────────────────────────────────
 * The package's existing rule holds: React is INJECTED, never imported, so a
 * component is a pure factory over `createElement`. Two layers, tested apart:
 *
 *  1. `conflictPanelView` — a pure function from conflicts plus the operator's
 *     in-progress form state to everything the panel shows. Every judgement
 *     lives here: which action is enabled, what the fourth §28.3 row previews,
 *     what a destructive action would lose, why a refusal was a refusal.
 *  2. `createOverlayConflictPanel` — `createElement` calls over that view, and
 *     the event handlers that feed it back. Driven below through a fake React
 *     that really does re-render on `setState`, so a click, a typed value and a
 *     ticked confirmation are exercised as a sequence rather than asserted as
 *     an intention.
 *
 * WHAT STILL NEEDS A BROWSER: that Sanity renders `dialog: {type: 'dialog'}`
 * with our `content`, that the action appears in the real document menu, and
 * that the panel is legible. Everything upstream of the renderer is here.
 */
import {describe, expect, it, vi} from 'vitest'
import {
  CONFLICT_RESOLUTION_ACTIONS,
  applicableResolutionActions,
} from '../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../sanity-overlay-core/src/index'
import {createOverlayActionController} from '../../sanity-overlay-studio/src/documentActions'
import type {OverlayActionController} from '../../sanity-overlay-studio/src/documentActions'
import {readConflictReport} from '../../sanity-overlay-studio/src/conflicts'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {
  EMPTY_CONFLICT_PANEL_UI,
  conflictPanelView,
  createOverlayConflictPanel,
  parseManualEditSource,
} from '../../sanity-overlay-studio/src/ui/conflictPanel'
import {
  OVERLAY_ACTION_NAMES,
  createOverlayActionControllers,
  createOverlayDocumentActions,
} from '../../sanity-overlay-studio/src/ui/documentActions'
import type {ReactLike} from '../../sanity-overlay-studio/src/ui/statusLayout'
import {
  clearOverlayRuntimes,
  createOverlayRuntime,
  getOverlayRuntime,
  registerOverlayRuntime,
} from '../../sanity-overlay-studio/src/runtime'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {overlayWorkspacePatch} from '../../sanity-overlay-studio/src/config'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SAME_PATH: OverlayConflict = {
  id: 'c1',
  documentId: 'article-1',
  severity: 'soft',
  type: 'SAME_PATH_CHANGED',
  path: ['title'],
  ancestorValue: 'Ancestor',
  baseValue: 'Current staging',
  localValue: 'Branch value',
  detectedAt: '2026-08-01T00:00:00.000Z',
}

const BASE_DELETED: OverlayConflict = {
  id: 'c2',
  documentId: 'article-1',
  severity: 'hard',
  type: 'BASE_DOCUMENT_DELETED',
  localValue: {_id: 'article-1', title: 'Branch copy'},
  detectedAt: '2026-08-02T00:00:00.000Z',
}

const COLLISION: OverlayConflict = {
  id: 'c3',
  documentId: 'article-1',
  severity: 'hard',
  type: 'LOCAL_ID_COLLISION',
  detectedAt: '2026-08-03T00:00:00.000Z',
  localValue: {_id: 'article-1', title: 'Mine'},
  baseValue: {_id: 'article-1', title: 'Theirs'},
}

const RESOLVED: OverlayConflict = {
  ...SAME_PATH,
  id: 'c4',
  resolution: {
    type: 'keep-local',
    resolvedAt: '2026-08-04T00:00:00.000Z',
    resolvedBy: {type: 'user', id: 'v'},
  },
}

/* ------------------------------------------------------------------ *
 * A fake React that actually re-renders
 * ------------------------------------------------------------------ */

interface FakeElement {
  /** A host tag stays a string; a component element keeps its function, as React does. */
  type: string | ((props: never) => unknown)
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * A hook host, so `useState` in the component under test behaves like React's.
 *
 * Without it a component test can only assert the first frame, which means the
 * interactive half — select an action, type a value, tick the confirmation —
 * would be asserted as intent rather than exercised. Slots are indexed per
 * render and reset each pass, exactly as React does.
 */
function renderer() {
  const slots: unknown[] = []
  const cleanups: Array<() => void> = []
  let index = 0
  let render: () => void = () => {}

  const react: ReactLike = {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]): FakeElement => ({
      /* A component element carries its function and is NOT rendered here —
       * that is React's job, and pretending otherwise would let a test assert a
       * tree the host would never build. */
      type: typeof type === 'function' ? (type as (props: never) => unknown) : String(type),
      props: (props ?? {}) as Record<string, unknown>,
      children: children.filter((child) => child !== null && child !== undefined),
    }),
    useEffect: (effect) => {
      const slot = index++
      if (slots[slot] === undefined) {
        slots[slot] = true
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
    useState: <S,>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] => {
      const slot = index++
      if (!(slot in slots)) {
        slots[slot] = typeof initial === 'function' ? (initial as () => S)() : initial
      }
      const set = (next: S | ((prev: S) => S)): void => {
        slots[slot] =
          typeof next === 'function' ? (next as (prev: S) => S)(slots[slot] as S) : next
        render()
      }
      return [slots[slot] as S, set]
    },
  }

  let tree: unknown

  return {
    react,
    mount(Component: (props: never) => unknown, props: unknown): unknown {
      render = () => {
        index = 0
        tree = Component(props as never)
      }
      render()
      return tree
    },
    get tree(): unknown {
      return tree
    },
    cleanup(): void {
      for (const fn of cleanups.splice(0)) fn()
    },
  }
}

function flatten(node: unknown, out: FakeElement[] = []): FakeElement[] {
  if (typeof node !== 'object' || node === null) return out
  const element = node as FakeElement
  if (typeof element.type === 'string') out.push(element)
  for (const child of element.children ?? []) flatten(child, out)
  return out
}

function byTestId(node: unknown, id: string): FakeElement[] {
  return flatten(node).filter((element) => element.props['data-testid'] === id)
}

function textOf(node: unknown): string {
  return flatten(node)
    .flatMap((element) => element.children.filter((child) => typeof child === 'string'))
    .join(' | ')
}

/* ------------------------------------------------------------------ *
 * A controller over a fake transport
 * ------------------------------------------------------------------ */

interface Sent {
  kind: string
  payload: unknown
}

function controllerFor(
  conflicts: readonly OverlayConflict[],
  options: {outcome?: 'ok' | 'degraded'} = {},
): {controller: OverlayActionController; sent: Sent[]; refreshed: () => number} {
  const sent: Sent[] = []
  let refreshes = 0
  const transport = {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok' as const}),
    operation: async (request: {kind: string; payload: unknown}) => {
      sent.push({kind: request.kind, payload: request.payload})
      return {outcome: options.outcome ?? ('ok' as const), message: 'the overlay refused it'}
    },
    resolve: async () => ({outcome: 'ok' as const}),
    state: async () => ({outcome: 'ok' as const}),
  } as unknown as OverlayTransport

  const report = readConflictReport({
    documents: [{logicalId: 'article-1', schemaType: 'article', conflicts: [...conflicts]}],
  })

  const controller = createOverlayActionController({
    kind: 'conflictResolution',
    transport,
    refresh: async () => {
      refreshes += 1
    },
    documents: [],
    conflicts: report,
    now: () => 1,
  })

  return {controller, sent, refreshed: () => refreshes}
}

/* ================================================================== *
 * 1. The view model
 * ================================================================== */

describe('conflictPanelView — every §28.3 decision, before anything is rendered', () => {
  it('renders one row per conflict, in the order the overlay reported them', () => {
    const view = conflictPanelView({
      documentId: 'drafts.article-1',
      conflicts: [SAME_PATH, BASE_DELETED, COLLISION],
    })

    expect(view.documentId).toBe('article-1')
    expect(view.rows.map((row) => row.conflictId)).toEqual(['c1', 'c2', 'c3'])
    expect(view.empty).toBe(false)
  })

  it('says so when there is nothing to resolve, rather than showing a blank panel', () => {
    const view = conflictPanelView({documentId: 'article-1', conflicts: []})

    expect(view.empty).toBe(true)
    expect(view.rows).toEqual([])
    expect(view.emptyReason).toBeDefined()
    expect(view.emptyReason!.length).toBeGreaterThan(20)
  })

  it('shows the four §28.3 rows, in §28.3 order', () => {
    const [row] = conflictPanelView({documentId: 'article-1', conflicts: [SAME_PATH]}).rows

    expect(row!.values.map((value) => value.label)).toEqual([
      'Ancestor',
      'Current staging',
      'Branch value',
      'Resolved preview value',
    ])
    expect(row!.values[0]!.value).toBe('Ancestor')
    expect(row!.values[1]!.value).toBe('Current staging')
    expect(row!.values[2]!.value).toBe('Branch value')
  })

  it('offers exactly the actions core says apply, and never invents one', () => {
    for (const conflict of [SAME_PATH, BASE_DELETED, COLLISION]) {
      const [row] = conflictPanelView({documentId: 'article-1', conflicts: [conflict]}).rows
      expect(row!.actions.map((entry) => entry.action)).toEqual(
        applicableResolutionActions(conflict),
      )
      for (const entry of row!.actions) {
        expect(CONFLICT_RESOLUTION_ACTIONS).toContain(entry.action)
        expect(entry.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('previews each action separately — the fourth row is per button, not per row', () => {
    const [row] = conflictPanelView({documentId: 'article-1', conflicts: [SAME_PATH]}).rows
    const preview = (action: string): unknown =>
      row!.actions.find((entry) => entry.action === action)!.preview

    expect(preview('keep-branch-value')).toEqual({kind: 'value', value: 'Branch value'})
    expect(preview('accept-current-staging')).toEqual({kind: 'value', value: 'Current staging'})
    expect(preview('remove-local-override')).toEqual({kind: 'inherited', value: 'Current staging'})
  })

  it('tracks the selected action in the fourth §28.3 row', () => {
    const view = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      ui: {...EMPTY_CONFLICT_PANEL_UI, selected: {c1: 'accept-current-staging'}},
    })
    const [row] = view.rows

    expect(row!.selectedAction).toBe('accept-current-staging')
    expect(row!.values[3]!.label).toBe('Resolved preview value')
    expect(row!.values[3]!.value).toBe('Current staging')
    expect(row!.actions.find((entry) => entry.action === 'accept-current-staging')!.selected).toBe(
      true,
    )
  })

  it.each(['accept-current-staging', 'remove-local-override'] as const)(
    'holds %s back until the loss is confirmed, and states the loss',
    (action) => {
      const unconfirmed = conflictPanelView({
        documentId: 'article-1',
        conflicts: [SAME_PATH],
      }).rows[0]!.actions.find((entry) => entry.action === action)!

      expect(unconfirmed.needsConfirmation).toBe(true)
      expect(unconfirmed.enabled).toBe(false)
      expect(unconfirmed.loss?.destructive).toBe(true)
      /* The loss NAMES the branch value it is about to throw away — the summary
       * says which path on which document, the entry carries the actual value
       * so the operator can see what they are agreeing to lose. */
      expect(unconfirmed.loss!.summary).toContain('title')
      expect(unconfirmed.loss!.summary).toContain('article-1')
      expect(unconfirmed.loss!.losing).toEqual([
        {path: 'title', value: 'Branch value', replacedBy: 'Current staging'},
      ])
      expect(unconfirmed.reason).toContain(unconfirmed.loss!.summary)

      const confirmed = conflictPanelView({
        documentId: 'article-1',
        conflicts: [SAME_PATH],
        ui: {...EMPTY_CONFLICT_PANEL_UI, confirmed: {[`c1:${action}`]: true}},
      }).rows[0]!.actions.find((entry) => entry.action === action)!

      expect(confirmed.enabled).toBe(true)
      expect(confirmed.input).toMatchObject({action, confirmed: true})
    },
  )

  it('needs no confirmation to keep the branch value', () => {
    const keep = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
    }).rows[0]!.actions.find((entry) => entry.action === 'keep-branch-value')!

    expect(keep.needsConfirmation).toBe(false)
    expect(keep.enabled).toBe(true)
    expect(keep.loss).toBeUndefined()
  })

  it('refuses a manual edit until a value has actually been typed', () => {
    const untouched = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
    }).rows[0]!.actions.find((entry) => entry.action === 'manual-edit')!

    expect(untouched.enabled).toBe(false)
    expect(untouched.reason).toBeDefined()
    expect(untouched.input).toBeUndefined()
  })

  it('reports a manual edit that is not valid JSON as a parse error, not as a value', () => {
    const view = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      ui: {
        ...EMPTY_CONFLICT_PANEL_UI,
        selected: {c1: 'manual-edit'},
        drafts: {c1: '{not json'},
      },
    })
    const [row] = view.rows

    expect(row!.manualEdit?.source).toBe('{not json')
    expect(row!.manualEdit?.parseError).toBeDefined()
    expect(row!.actions.find((entry) => entry.action === 'manual-edit')!.enabled).toBe(false)
  })

  it('passes a parsed manual edit through, and refuses one equal to the branch value', () => {
    const good = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      ui: {...EMPTY_CONFLICT_PANEL_UI, selected: {c1: 'manual-edit'}, drafts: {c1: '"Merged"'}},
    }).rows[0]!.actions.find((entry) => entry.action === 'manual-edit')!

    expect(good.enabled).toBe(true)
    expect(good.input).toEqual({action: 'manual-edit', value: 'Merged'})
    expect(good.preview).toEqual({kind: 'value', value: 'Merged'})

    const same = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      ui: {
        ...EMPTY_CONFLICT_PANEL_UI,
        selected: {c1: 'manual-edit'},
        drafts: {c1: '"Branch value"'},
      },
    }).rows[0]!.actions.find((entry) => entry.action === 'manual-edit')!

    /* `planConflictResolution` is the authority; the panel reports its reason
     * verbatim rather than inventing a second wording. */
    expect(same.enabled).toBe(false)
    expect(same.reason).toContain('identical to the branch value')
  })

  it('accepts the one non-JSON token that means "remove this field"', () => {
    expect(parseManualEditSource('undefined')).toEqual({ok: true, value: undefined})
    expect(parseManualEditSource('null')).toEqual({ok: true, value: null})
    expect(parseManualEditSource('')).toMatchObject({ok: false})
    expect(parseManualEditSource('   ')).toMatchObject({ok: false})

    const removed = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      ui: {...EMPTY_CONFLICT_PANEL_UI, selected: {c1: 'manual-edit'}, drafts: {c1: 'undefined'}},
    }).rows[0]!.actions.find((entry) => entry.action === 'manual-edit')!

    expect(removed.enabled).toBe(true)
    /* The KEY must be present — that is what distinguishes "remove the field"
     * from an unfinished form (`conflictPanel.ts` `planConflictResolution`). */
    expect(removed.input).toBeDefined()
    expect('value' in removed.input!).toBe(true)
    expect(removed.preview).toEqual({kind: 'removed', value: undefined})
  })

  it('refuses a rename with no new ID, and one to the ID it already has', () => {
    const blank = conflictPanelView({
      documentId: 'article-1',
      conflicts: [COLLISION],
    }).rows[0]!.actions.find((entry) => entry.action === 'rename-branch-id')!
    expect(blank.enabled).toBe(false)

    const same = conflictPanelView({
      documentId: 'article-1',
      conflicts: [COLLISION],
      ui: {...EMPTY_CONFLICT_PANEL_UI, renames: {c3: 'article-1'}},
    }).rows[0]!.actions.find((entry) => entry.action === 'rename-branch-id')!
    expect(same.enabled).toBe(false)
    expect(same.reason).toContain('already has')

    const renamed = conflictPanelView({
      documentId: 'article-1',
      conflicts: [COLLISION],
      ui: {...EMPTY_CONFLICT_PANEL_UI, renames: {c3: 'article-1-branch'}},
    }).rows[0]!.actions.find((entry) => entry.action === 'rename-branch-id')!
    expect(renamed.enabled).toBe(true)
    expect(renamed.input).toEqual({action: 'rename-branch-id', newId: 'article-1-branch'})
  })

  it('marks a resolved conflict resolved and offers nothing further', () => {
    const [row] = conflictPanelView({documentId: 'article-1', conflicts: [RESOLVED]}).rows

    expect(row!.resolved).toBe(true)
    expect(row!.actions).toEqual([])
  })

  it('carries the controller’s busy flag and last error onto the surface', () => {
    const view = conflictPanelView({
      documentId: 'article-1',
      conflicts: [SAME_PATH],
      busy: true,
      error: 'the overlay refused it',
    })

    expect(view.busy).toBe(true)
    expect(view.error).toBe('the overlay refused it')
    /* Nothing is clickable mid-flight: a second send against a state the first
     * one is about to change is how a resolution lands twice. */
    for (const action of view.rows[0]!.actions) expect(action.enabled).toBe(false)
  })
})

/* ================================================================== *
 * 2. The component
 * ================================================================== */

describe('createOverlayConflictPanel — the rendered §28.3 panel', () => {
  function mount(conflicts: readonly OverlayConflict[], options: {outcome?: 'ok' | 'degraded'} = {}) {
    const host = renderer()
    const {controller, sent, refreshed} = controllerFor(conflicts, options)
    const Panel = createOverlayConflictPanel(host.react)
    host.mount(Panel as (props: never) => unknown, {controller, documentId: 'drafts.article-1'})
    return {host, controller, sent, refreshed}
  }

  it('renders one row per conflict, tagged for a browser check', () => {
    const {host} = mount([SAME_PATH, BASE_DELETED])
    const rows = byTestId(host.tree, 'overlay-conflict-row')

    expect(rows.map((row) => row.props['data-conflict-id'])).toEqual(['c1', 'c2'])
    expect(rows.map((row) => row.props['data-severity'])).toEqual(['soft', 'hard'])
    expect(byTestId(host.tree, 'overlay-conflict-panel')[0]?.props['data-document-id']).toBe(
      'article-1',
    )
  })

  it('shows the four §28.3 labels on screen', () => {
    const {host} = mount([SAME_PATH])
    const labels = byTestId(host.tree, 'overlay-conflict-value').map(
      (element) => element.props['data-label'],
    )

    expect(labels).toEqual([
      'Ancestor',
      'Current staging',
      'Branch value',
      'Resolved preview value',
    ])
    expect(textOf(host.tree)).toContain('Branch value')
  })

  it('renders a button per applicable action, disabled exactly when the plan refuses', () => {
    const {host} = mount([SAME_PATH])
    const buttons = byTestId(host.tree, 'overlay-conflict-action')

    expect(buttons.map((button) => button.props['data-action'])).toEqual(
      applicableResolutionActions(SAME_PATH),
    )
    const byAction = (action: string): FakeElement =>
      buttons.find((button) => button.props['data-action'] === action)!

    expect(byAction('keep-branch-value').props.disabled).toBe(false)
    expect(byAction('accept-current-staging').props.disabled).toBe(true)
    expect(String(byAction('accept-current-staging').props.title)).toContain('Confirm the loss')
  })

  it('sends the resolution when an enabled action is clicked', async () => {
    const {host, sent} = mount([SAME_PATH])
    const keep = byTestId(host.tree, 'overlay-conflict-action').find(
      (button) => button.props['data-action'] === 'keep-branch-value',
    )!

    await (keep.props.onClick as () => Promise<void>)()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('conflictResolution')
    expect(sent[0]!.payload).toMatchObject({
      kind: 'conflictResolution',
      conflictId: 'c1',
      documentId: 'article-1',
      action: 'keep-branch-value',
      resolution: 'keep-local',
    })
  })

  it('will not send a destructive action until the confirmation is ticked', async () => {
    const {host, sent} = mount([SAME_PATH])

    const accept = (): FakeElement =>
      byTestId(host.tree, 'overlay-conflict-action').find(
        (button) => button.props['data-action'] === 'accept-current-staging',
      )!

    /* Selecting it surfaces the loss report; it is still refused. */
    await (accept().props.onClick as () => Promise<void>)()
    expect(sent).toEqual([])

    const confirm = byTestId(host.tree, 'overlay-conflict-confirm').find(
      (element) => element.props['data-action'] === 'accept-current-staging',
    )
    expect(confirm).toBeDefined()
    expect(textOf(host.tree)).toContain('not recoverable')

    ;(confirm!.props.onChange as (event: unknown) => void)({target: {checked: true}})

    expect(accept().props.disabled).toBe(false)
    await (accept().props.onClick as () => Promise<void>)()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toMatchObject({action: 'accept-current-staging'})
  })

  it('takes a typed manual edit and sends the parsed value', async () => {
    const {host, sent} = mount([SAME_PATH])

    const manual = (): FakeElement =>
      byTestId(host.tree, 'overlay-conflict-action').find(
        (button) => button.props['data-action'] === 'manual-edit',
      )!

    /* Clicking selects it — there is nothing to send yet. */
    await (manual().props.onClick as () => Promise<void>)()
    expect(sent).toEqual([])

    const box = byTestId(host.tree, 'overlay-conflict-manual-edit')[0]
    expect(box).toBeDefined()
    ;(box!.props.onChange as (event: unknown) => void)({target: {value: '"Merged"'}})

    expect(manual().props.disabled).toBe(false)
    await (manual().props.onClick as () => Promise<void>)()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toMatchObject({action: 'manual-edit', value: 'Merged'})
  })

  it('shows a parse error instead of sending unparseable JSON', async () => {
    const {host, sent} = mount([SAME_PATH])
    const manual = (): FakeElement =>
      byTestId(host.tree, 'overlay-conflict-action').find(
        (button) => button.props['data-action'] === 'manual-edit',
      )!

    await (manual().props.onClick as () => Promise<void>)()
    ;(
      byTestId(host.tree, 'overlay-conflict-manual-edit')[0]!.props.onChange as (
        event: unknown,
      ) => void
    )({target: {value: '{nope'}})

    expect(byTestId(host.tree, 'overlay-conflict-parse-error')).toHaveLength(1)
    expect(manual().props.disabled).toBe(true)
    await (manual().props.onClick as () => Promise<void>)()
    expect(sent).toEqual([])
  })

  it('offers no action at all on a resolved conflict', () => {
    const {host} = mount([RESOLVED])

    expect(byTestId(host.tree, 'overlay-conflict-row')[0]?.props['data-resolved']).toBe(true)
    expect(byTestId(host.tree, 'overlay-conflict-action')).toEqual([])
  })

  it('surfaces a refusal from the overlay API rather than silently doing nothing', async () => {
    const {host} = mount([SAME_PATH], {outcome: 'degraded'})
    const keep = byTestId(host.tree, 'overlay-conflict-action').find(
      (button) => button.props['data-action'] === 'keep-branch-value',
    )!

    await (keep.props.onClick as () => Promise<void>)()

    const error = byTestId(host.tree, 'overlay-conflict-error')
    expect(error).toHaveLength(1)
    expect(textOf(error[0])).toContain('refused')
  })

  it('says there is nothing to resolve rather than rendering an empty box', () => {
    const {host} = mount([])

    expect(byTestId(host.tree, 'overlay-conflict-empty')).toHaveLength(1)
    expect(byTestId(host.tree, 'overlay-conflict-row')).toEqual([])
  })
})

/* ================================================================== *
 * 3. The wiring
 * ================================================================== */

function fakeRuntime(conflicts: readonly OverlayConflict[] = []) {
  clearOverlayRuntimes()
  const resolved = resolveOverlayOptions({mode: 'fs'}, {})
  return createOverlayRuntime({
    resolved,
    createClient: () => ({}),
    fetch: (async () =>
      ({
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            revision: 1,
            overlayId: null,
            documents: [
              {logicalId: 'article-1', schemaType: 'article', conflicts: [...conflicts]},
            ],
          }),
      }) as never) as unknown as typeof fetch,
  })
}

describe('the runtime exposes what a document action needs', () => {
  it('reports the branch inventory the rebase and checkpoint plans read', async () => {
    const runtime = fakeRuntime()
    expect(runtime.documents()).toEqual([])

    await runtime.refresh()

    expect(runtime.documents().map((document) => document.logicalId)).toEqual(['article-1'])
  })
})

describe('createOverlayActionControllers — the three §21.7 actions, bound to a runtime', () => {
  it('builds one controller per kind, over the runtime’s own transport and state', async () => {
    const runtime = fakeRuntime([SAME_PATH])
    await runtime.refresh()
    const controllers = createOverlayActionControllers(runtime)

    expect(controllers.rebase.kind).toBe('rebase')
    expect(controllers.checkpoint.kind).toBe('checkpoint')
    expect(controllers.conflictResolution.kind).toBe('conflictResolution')

    /* The conflict controller sees the conflicts the runtime read from
     * `/state` — not a copy taken when it was constructed. */
    expect(controllers.conflictResolution.conflictPanel!('article-1')).toHaveLength(1)
    expect(controllers.conflictResolution.describe({id: 'article-1'})?.label).toContain(
      'Resolve conflicts',
    )
  })

  it('reads the runtime live, so a later refresh changes what the action says', async () => {
    const runtime = fakeRuntime([])
    const controllers = createOverlayActionControllers(runtime)
    await runtime.refresh()

    /* No conflicts: §28.3's action is absent entirely rather than disabled. */
    expect(controllers.conflictResolution.describe({id: 'article-1'})).toBeNull()
  })
})

describe('createOverlayDocumentActions — components Sanity can put in the menu', () => {
  it('names each action, so the resolver can keep itself idempotent', () => {
    const host = renderer()
    const actions = createOverlayDocumentActions(host.react)

    expect(actions.map((action) => action.action)).toEqual([
      OVERLAY_ACTION_NAMES.rebase,
      OVERLAY_ACTION_NAMES.conflictResolution,
      OVERLAY_ACTION_NAMES.checkpoint,
    ])
    for (const action of actions) expect(typeof action).toBe('function')
  })

  it('renders nothing when no overlay runtime is registered', () => {
    clearOverlayRuntimes()
    const host = renderer()
    const [rebase] = createOverlayDocumentActions(host.react)

    expect(host.mount(rebase as (props: never) => unknown, {id: 'article-1'})).toBeNull()
  })

  it('describes the conflict action from the live runtime, and opens the §28.3 panel', async () => {
    const runtime = fakeRuntime([SAME_PATH])
    /* A document action gets `{id, type}` and no workspace, so it finds its
     * runtime through the registry — exactly as the status banner does. */
    registerOverlayRuntime('*', runtime)
    await runtime.refresh()
    const host = renderer()
    const actions = createOverlayDocumentActions(host.react)
    const resolveAction = actions.find(
      (action) => action.action === OVERLAY_ACTION_NAMES.conflictResolution,
    )!

    const first = host.mount(resolveAction as (props: never) => unknown, {
      id: 'article-1',
      type: 'article',
      workspace: 'default',
    }) as {label: string; onHandle?: () => void; dialog?: unknown}

    expect(first.label).toContain('Resolve conflicts (1)')
    expect(first.dialog).toBe(false)

    /* `onHandle` opens the dialog; it never sends. */
    first.onHandle!()
    const opened = host.tree as {dialog?: {type: string; header: string; content: unknown}}
    expect(opened.dialog?.type).toBe('dialog')
    expect(opened.dialog?.header).toContain('article-1')

    /* `content` is an ELEMENT, not a rendered tree — Sanity renders it, and a
     * test that asserted a tree here would be asserting something the host never
     * builds. What is checked is that it points at the §28.3 panel with the
     * live controller, and that rendering it really does produce the rows. */
    const content = opened.dialog!.content as FakeElement
    expect(typeof content.type).toBe('function')
    expect(content.props.documentId).toBe('article-1')

    const dialogHost = renderer()
    const rendered = dialogHost.mount(
      content.type as (props: never) => unknown,
      content.props,
    )
    expect(byTestId(rendered, 'overlay-conflict-row')).toHaveLength(1)
    expect(byTestId(rendered, 'overlay-conflict-action').length).toBeGreaterThan(0)
  })
})

describe('config.ts installs the overlay document actions', () => {
  it('appends the three overlay actions and still removes the blocked ones', () => {
    clearOverlayRuntimes()
    const host = renderer()
    const documentActions = createOverlayDocumentActions(host.react)
    const patch = overlayWorkspacePatch(
      {name: 'default', projectId: 'p', dataset: 'staging'},
      {mode: 'fs', createClient: () => ({}), documentActions},
    )

    const resolver = (patch.workspace.document as {actions: (prev: unknown[]) => unknown[]}).actions
    const result = resolver([
      {action: 'publish'},
      {action: 'schedule'},
      {action: 'linkToCanvas'},
    ]) as Array<{action?: string}>

    const names = result.map((entry) => entry.action)
    /* §21.10 — the hosted features that cannot work are still removed... */
    expect(names).not.toContain('schedule')
    expect(names).not.toContain('linkToCanvas')
    /* ...the consumer's own action is untouched and stays first... */
    expect(names[0]).toBe('publish')
    /* ...and the overlay's three are appended. */
    expect(names).toContain(OVERLAY_ACTION_NAMES.rebase)
    expect(names).toContain(OVERLAY_ACTION_NAMES.conflictResolution)
    expect(names).toContain(OVERLAY_ACTION_NAMES.checkpoint)
  })

  it('is idempotent — resolving twice does not double the menu', () => {
    clearOverlayRuntimes()
    const host = renderer()
    const documentActions = createOverlayDocumentActions(host.react)
    const patch = overlayWorkspacePatch(
      {name: 'default', projectId: 'p', dataset: 'staging'},
      {mode: 'fs', createClient: () => ({}), documentActions},
    )
    const resolver = (patch.workspace.document as {actions: (prev: unknown[]) => unknown[]}).actions

    const once = resolver([{action: 'publish'}]) as Array<{action?: string}>
    const twice = resolver(once) as Array<{action?: string}>

    expect(twice.map((entry) => entry.action)).toEqual(once.map((entry) => entry.action))
  })

  it('adds nothing when the overlay is off', () => {
    clearOverlayRuntimes()
    const host = renderer()
    const workspace = {name: 'default', projectId: 'p', dataset: 'staging'}
    const patch = overlayWorkspacePatch(workspace, {
      mode: 'off',
      createClient: () => ({}),
      documentActions: createOverlayDocumentActions(host.react),
    })

    expect(patch.workspace).toBe(workspace)
    expect(getOverlayRuntime('default')).toBeUndefined()
  })

  it('the shipped entry point installs them by default, bound to the real React', async () => {
    /* Everything above drives an injected fake. This is the one case that goes
     * through `src/index.ts`, which is the only module in the package that
     * imports `react` — so it is where a binding mistake would live and the one
     * place a fake cannot catch it. */
    clearOverlayRuntimes()
    const studio = await import('../../sanity-overlay-studio/src/index')

    expect(studio.OverlayDocumentActions.map((action) => action.action)).toEqual([
      OVERLAY_ACTION_NAMES.rebase,
      OVERLAY_ACTION_NAMES.conflictResolution,
      OVERLAY_ACTION_NAMES.checkpoint,
    ])
    expect(typeof studio.OverlayConflictPanel).toBe('function')

    const config = studio.defineOverlayConfig(
      {name: 'default', projectId: 'p', dataset: 'staging'},
      {mode: 'fs', createClient: () => ({})},
    ) as {document: {actions: (prev: unknown[]) => Array<{action?: string}>}}

    const names = config.document.actions([{action: 'publish'}, {action: 'schedule'}]).map(
      (entry) => entry.action,
    )
    expect(names).not.toContain('schedule')
    expect(names).toContain(OVERLAY_ACTION_NAMES.conflictResolution)
  })

  it('composes with a consumer resolver rather than replacing it', () => {
    clearOverlayRuntimes()
    const host = renderer()
    const consumer = vi.fn((prev: Array<{action?: string}>) => [...prev, {action: 'consumerOwn'}])
    const patch = overlayWorkspacePatch(
      {
        name: 'default',
        projectId: 'p',
        dataset: 'staging',
        document: {actions: consumer},
      },
      {mode: 'fs', createClient: () => ({}), documentActions: createOverlayDocumentActions(host.react)},
    )

    const resolver = (patch.workspace.document as {actions: (prev: unknown[]) => unknown[]}).actions
    const names = (resolver([{action: 'publish'}]) as Array<{action?: string}>).map(
      (entry) => entry.action,
    )

    expect(consumer).toHaveBeenCalledTimes(1)
    expect(names).toContain('consumerOwn')
    expect(names).toContain(OVERLAY_ACTION_NAMES.conflictResolution)
  })
})
