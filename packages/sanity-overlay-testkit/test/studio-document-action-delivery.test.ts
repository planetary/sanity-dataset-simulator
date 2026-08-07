/**
 * `sanity-overlay-studio` — do the §21.7 actions actually REACH a Studio?
 *
 * THE SEAM THIS FILE OWNS, AND WHY IT WAS MISSING.
 *
 * `test/studio-actions.test.ts` proves `overlayDocumentActionsResolver` appends
 * three fake entries when it is *handed* three. `test/studio-conflict-panel-ui`
 * and friends prove a controller behaves when it is *handed* a runtime. Both
 * take the thing under test as an argument, so both stayed green while a real
 * Studio rendered `publish`, `Duplicate`, `Delete` and nothing else: the three
 * overlay actions were never in the list at all.
 *
 * The gap is between "the action object behaves correctly when constructed" and
 * "Studio constructs it at all, with a runtime in scope". So this file hands
 * NOTHING in. It builds a config the way a consumer does, resolves
 * `document.actions` the way sanity 6.8.0 resolves it, and renders the result
 * the way sanity 6.8.0 renders it — then asks whether rebase, resolve-conflict
 * and checkpoint are there.
 *
 * THE ORACLE IS SANITY'S OWN ALGORITHM, TRANSCRIBED FROM THE INSTALLED PACKAGE
 * rather than inferred from our types. Line references are into
 * `examples/kitchen-sink/node_modules/sanity@6.8.0`:
 *
 *  - `flattenConfig`               `lib/useBundleDocuments-BYW8M9LS.js:2928`
 *      `[...allPlugins, rootConfig]` — the ROOT CONFIG IS LAST, which is the
 *      whole reason the overlay installs its resolver there.
 *  - `documentActionsReducer`      `lib/WorkspaceLoader-BRx2afZV.js:1447`
 *      array ⇒ concat, function ⇒ call, anything else ⇒ throw.
 *  - `initialDocumentActions = []` `lib/WorkspaceLoader-BRx2afZV.js:1409`
 *  - `structureTool`'s resolver    `lib/structureTool-EN0gOzyJ.js:12597`
 *      the six built-ins, with `delete`/`discardChanges` sorted to the end.
 *  - `defineHookStateComponent`    `lib/useStudioUrl-90xCJc-c.js:26`
 *      calls the action as a hook with ONE argument and drops a `null` return;
 *      a non-null return is re-stamped with `useHook.action`.
 *  - `DocumentActionsProvider`     `lib/structureTool-EN0gOzyJ.js:2274`
 *      the argument is `{...editState, release, revision, initialValueResolved,
 *      onComplete}` — note there is NO `workspace` in it, which is why the
 *      actions must find their runtime through the registry.
 *  - `RenderActionCollectionState` `lib/structureTool-EN0gOzyJ.js:5071`
 *      `(state.group || ['default']).includes('default')` for the status bar.
 */
import {beforeEach, describe, expect, it} from 'vitest'

import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {
  defineOverlayConfig as defineOverlayConfigFromConfigModule,
  overlayWorkspacePatch,
} from '../../sanity-overlay-studio/src/config'
import {OverlayDocumentActions} from '../../sanity-overlay-studio/src/bindings'
import {clearOverlayRuntimes} from '../../sanity-overlay-studio/src/runtime'
import {createOverlayDocumentActions} from '../../sanity-overlay-studio/src/ui/documentActions'
import type {ReactLike} from '../../sanity-overlay-studio/src/ui/statusLayout'

type Rec = Record<string, unknown>

/* ══════════════════════════════════════════════════ sanity 6.8.0, transcribed */

interface ActionHook {
  (props: Rec): Rec | null
  action?: string
  displayName?: string
}

interface FlatConfig {
  config: Rec
  path: string[]
}

/** `lib/useBundleDocuments-BYW8M9LS.js:2928`. Plugins first, root config LAST. */
function flattenConfig(input: Rec, path: string[] = []): FlatConfig[] {
  const {plugins = [], ...currentConfig} = input as {plugins?: Rec[]} & Rec
  const rootConfig: FlatConfig = {
    config: currentConfig,
    path: [...path, String(currentConfig.name)],
  }
  const allPlugins = (plugins as Rec[]).flatMap((plugin) =>
    flattenConfig(plugin, [...path, String(currentConfig.name)]),
  )
  return [...allPlugins, rootConfig]
}

/** `lib/WorkspaceLoader-BRx2afZV.js:1447`. */
function documentActionsReducer(
  prev: readonly ActionHook[],
  config: Rec,
  context: Rec,
): readonly ActionHook[] {
  const document = config.document as {actions?: unknown} | undefined
  const actions = document?.actions
  if (!actions) return prev
  if (typeof actions === 'function') {
    return (actions as (p: readonly ActionHook[], c: Rec) => ActionHook[])(prev, context)
  }
  if (Array.isArray(actions)) return [...prev, ...(actions as ActionHook[])]
  throw new Error('Expected `document.actions` to be an array or a function')
}

/** `resolveConfigProperty` over `document.actions`, `lib/WorkspaceLoader-BRx2afZV.js:8443`. */
function resolveDocumentActions(config: Rec, context: Rec): readonly ActionHook[] {
  return flattenConfig(config).reduce<readonly ActionHook[]>(
    (acc, entry) => documentActionsReducer(acc, entry.config, context),
    [],
  )
}

function builtIn(action: string, label: string): ActionHook {
  const hook: ActionHook = () => ({label, disabled: false})
  hook.action = action
  hook.displayName = `${label.replace(/\s/g, '')}Action`
  return hook
}

/** `lib/structureTool-EN0gOzyJ.js:12580` — the six, and the destructive reorder. */
const STRUCTURE_TOOL_ACTIONS: ActionHook[] = [
  builtIn('publish', 'Publish'),
  builtIn('unpublish', 'Unpublish'),
  builtIn('discardChanges', 'Discard changes'),
  builtIn('duplicate', 'Duplicate'),
  builtIn('delete', 'Delete'),
  builtIn('restore', 'Restore'),
]
const DESTRUCTIVE = ['delete', 'discardChanges']

function structureTool(): Rec {
  return {
    name: 'sanity/structure',
    document: {
      actions: (prev: readonly ActionHook[]): ActionHook[] => {
        const combined = Array.from(new Set([...prev, ...STRUCTURE_TOOL_ACTIONS]))
        return [
          ...combined.filter((a) => !DESTRUCTIVE.includes(a.action ?? '')),
          ...combined.filter((a) => DESTRUCTIVE.includes(a.action ?? '')),
        ]
      },
    },
  }
}

/**
 * `DocumentActionsProvider`, `lib/structureTool-EN0gOzyJ.js:2274`.
 *
 * The ONE argument every document action receives. Reproduced key for key
 * because the absence of `workspace` is load-bearing: an action that expected
 * one would never find its runtime, and no test that invents its own props
 * would notice.
 */
const ACTION_PROPS: Rec = {
  id: 'article-01',
  type: 'article',
  draft: {_id: 'drafts.article-01', _type: 'article', title: 'Branch edit'},
  published: null,
  liveEdit: false,
  ready: true,
  transactionSyncLock: null,
  version: undefined,
  release: undefined,
  revision: undefined,
  initialValueResolved: true,
  onComplete: () => {},
}

/**
 * A hook host per action, because sanity gives each one its own component
 * (`defineHookStateComponent`). Slots are indexed per render and reset each
 * pass, exactly as React does, so `useState` in the action behaves like the
 * real thing rather than returning its initial value forever.
 */
function hookHost(): {react: ReactLike; call: (hook: ActionHook, props: Rec) => Rec | null} {
  const slots: unknown[] = []
  let index = 0
  let rerender: () => void = () => {}

  const react: ReactLike = {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => ({
      type,
      props: props ?? {},
      children,
    }),
    useEffect: (effect) => {
      const slot = index++
      if (slots[slot] === undefined) {
        slots[slot] = true
        effect()
      }
    },
    useState: <S,>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] => {
      const slot = index++
      if (!(slot in slots)) {
        slots[slot] = typeof initial === 'function' ? (initial as () => S)() : initial
      }
      return [
        slots[slot] as S,
        (next) => {
          slots[slot] =
            typeof next === 'function' ? (next as (prev: S) => S)(slots[slot] as S) : next
          rerender()
        },
      ]
    },
  }

  return {
    react,
    call(hook, props) {
      let out: Rec | null = null
      rerender = () => {
        index = 0
        out = hook(props)
      }
      rerender()
      return out
    },
  }
}

/**
 * `defineHookStateComponent` + `RenderActionCollectionState`, together: render
 * every action, drop the `null`s, re-stamp `.action`, keep the `default` group.
 */
function renderActionStates(
  actions: readonly ActionHook[],
  host: {call: (hook: ActionHook, props: Rec) => Rec | null},
): Rec[] {
  const states: Rec[] = []
  for (const hook of actions) {
    const state = host.call(hook, ACTION_PROPS)
    /* A `null` return is how an action says "not for this document", and sanity
     * drops it (`useStudioUrl-90xCJc-c.js:31` — `handleNext(id, hookState)`
     * DELETES the entry). */
    if (state === null || state === undefined) continue
    const stamped: Rec = {...state, action: hook.action}
    const group = stamped.group
    const groups: string[] = Array.isArray(group) ? (group as string[]) : ['default']
    if (groups.includes('default')) states.push(stamped)
  }
  return states
}

/* ══════════════════════════════════════════════════════ the overlay API stub */

/** What the running overlay API answered when the defect was observed. */
const STATE_BODY = {
  ok: true,
  revision: 2,
  documents: [
    {
      logicalId: 'article-01',
      schemaType: 'article',
      runtimeRevision: 'r-2',
      draft: {_id: 'drafts.article-01', _type: 'article'},
      currentBaseRevision: 'base-9',
      baseRevisionAtFirstTouch: 'base-7',
    },
    {
      logicalId: 'origin-proof-1',
      schemaType: 'article',
      runtimeRevision: 'r-1',
      published: {_id: 'origin-proof-1', _type: 'article'},
    },
  ],
}

/**
 * The same branch, with the overlay API reporting a hard conflict.
 *
 * `conflicts` on a document is what `readConflictReport` keys off: its ABSENCE
 * everywhere means "this API does not report conflicts", which is a different
 * answer from "there are none" and produces a different action.
 */
const STATE_BODY_WITH_CONFLICT = {
  ...STATE_BODY,
  documents: [
    {
      ...STATE_BODY.documents[0],
      conflicts: [
        {
          id: 'cf-1',
          documentId: 'article-01',
          severity: 'hard',
          type: 'concurrent-edit',
          path: ['title'],
        },
      ],
    },
    {...STATE_BODY.documents[1], conflicts: []},
  ],
}

function stubFetch(body: unknown = STATE_BODY): typeof fetch {
  return (async () => ({
    status: 200,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch
}

const ENV = {SANITY_STUDIO_OVERLAY_MODE: 'fs'}

function workspace(): Rec {
  return {
    name: 'kitchen-sink',
    title: 'Kitchen Sink (overlay test target)',
    projectId: 'b1n03q3z',
    dataset: 'parity',
    plugins: [structureTool()],
    schema: {types: []},
  }
}

/** The `context` sanity builds for the resolver, `structureTool-…:8115`. */
const ACTION_CONTEXT: Rec = {
  schemaType: 'article',
  documentId: 'article-01',
  versionType: 'draft',
  releaseId: undefined,
}

const OVERLAY_ACTIONS = ['overlayRebase', 'overlayResolveConflict', 'overlayCheckpoint']

beforeEach(() => {
  clearOverlayRuntimes()
})

/* ══════════════════════════════════════════════════════════════ the seam */

describe('a config a consumer writes delivers the §21.7 actions to Studio', () => {
  /**
   * THE OBSERVED DEFECT, as a test.
   *
   * `examples/kitchen-sink/sanity.config.ts` calls exactly this — the
   * `defineOverlayConfig` exported by the internal `config` module, with `env`,
   * `createClient` and `layout` — and the running Studio showed publish,
   * Duplicate and Delete with nothing matching rebase / resolve / checkpoint.
   */
  it('installs them when the config module is driven the way the example drives it', () => {
    const config = defineOverlayConfigFromConfigModule(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(),
      layout: () => null,
    }) as Rec

    const resolved = resolveDocumentActions(config, ACTION_CONTEXT)

    expect(resolved.map((entry) => entry.action)).toEqual(expect.arrayContaining(OVERLAY_ACTIONS))
  })

  it('renders rebase and checkpoint for a document the branch holds', async () => {
    const host = hookHost()
    /*
     * The SHIPPED actions are bound to the host's real React (`bindings.ts`),
     * and a real React hook cannot be called outside a renderer — Node gets
     * "Invalid hook call". So this test drives the same three components bound
     * to a re-rendering fake instead, and pins that the stand-in is the same
     * three by `.action` key rather than assuming it.
     */
    const drivable = createOverlayDocumentActions(host.react)
    expect(drivable.map((entry) => entry.action)).toEqual(
      OverlayDocumentActions.map((entry) => entry.action),
    )

    const patch = overlayWorkspacePatch(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(),
      layout: () => null,
      documentActions: drivable,
    })
    /* The branch as `/state` describes it — two documents, revision 2. Read
     * through the transport rather than assembled here, so the counts the
     * actions report come from the API's answer and not from this file. */
    await patch.runtime?.refresh()

    const resolved = resolveDocumentActions(patch.workspace, ACTION_CONTEXT)
    const states = renderActionStates(resolved, host)

    const labels = states.map((state) => String(state.label))
    expect(labels).toEqual(
      expect.arrayContaining([expect.stringMatching(/rebase/i), expect.stringMatching(/checkpoint/i)]),
    )

    /* Not merely present — live. A rebase offered on a document the branch does
     * not hold would be disabled, which is the same invisibility one click in. */
    const rebase = states.find((state) => state.action === 'overlayRebase')
    expect(rebase?.disabled).toBe(false)
    expect(typeof rebase?.onHandle).toBe('function')

    /* The checkpoint reports the inventory the API sent, not a number this file
     * computed: two documents. */
    const checkpoint = states.find((state) => state.action === 'overlayCheckpoint')
    expect(String(checkpoint?.title)).toContain('2 documents')
  })

  it('leaves the built-ins in place and puts the overlay’s three last', () => {
    const config = defineOverlayConfigFromConfigModule(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(),
      layout: () => null,
    }) as Rec

    const actions = resolveDocumentActions(config, ACTION_CONTEXT).map((entry) => entry.action)

    expect(actions).toContain('publish')
    expect(actions).toContain('duplicate')
    expect(actions).toContain('delete')
    expect(actions.slice(-3)).toEqual(OVERLAY_ACTIONS)
  })

  it('does not grow the menu when Studio re-resolves per document', () => {
    const config = defineOverlayConfigFromConfigModule(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(),
      layout: () => null,
    }) as Rec

    const once = resolveDocumentActions(config, ACTION_CONTEXT)
    const resolver = (config.document as Rec).actions as (
      prev: readonly ActionHook[],
      context: Rec,
    ) => ActionHook[]
    const twice = resolver(once, ACTION_CONTEXT)

    expect(twice.filter((entry) => entry.action === 'overlayRebase')).toHaveLength(1)
    expect(twice).toHaveLength(once.length)
  })
})

describe('the action finds its runtime the way sanity calls it', () => {
  /**
   * Sanity passes ONE argument and it contains no workspace, so the only route
   * to a runtime is the registry `config.ts` writes at patch time. Handing the
   * component a runtime — which every existing test does — cannot fail here,
   * which is precisely why every existing test stayed green.
   */
  it('returns a description from the registry alone, with no workspace prop', async () => {
    const host = hookHost()
    const patch = overlayWorkspacePatch(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(),
      layout: () => null,
      documentActions: createOverlayDocumentActions(host.react),
    })
    await patch.runtime?.refresh()

    const resolved = resolveDocumentActions(patch.workspace, ACTION_CONTEXT)
    const rebase = resolved.find((entry) => entry.action === 'overlayRebase')
    expect(rebase).toBeDefined()
    expect(Object.keys(ACTION_PROPS)).not.toContain('workspace')

    const state = host.call(rebase as ActionHook, ACTION_PROPS)
    expect(state).not.toBeNull()
    expect(String((state as Rec).label)).toMatch(/rebase/i)
  })

  it('renders nothing rather than throwing when no overlay is registered', () => {
    const host = hookHost()
    const [rebase] = createOverlayDocumentActions(host.react)
    clearOverlayRuntimes()
    expect(host.call(rebase as unknown as ActionHook, ACTION_PROPS)).toBeNull()
  })
})

/* ═════════════════════════════════════════════ the §28.3 panel, end to end */

/**
 * THE PANEL HAS A RENDERER AND HAS NEVER BEEN SEEN RENDERING.
 *
 * Two different reasons it can be absent, and only one of them is "clean":
 *
 *  - the overlay API reports conflicts and this document has none  ⇒ NO ACTION
 *    at all, deliberately (`documentActions.ts` — an always-present "Resolve
 *    conflicts" that is disabled 99% of the time is how a real one gets missed);
 *  - the overlay API does not report conflicts AT ALL ⇒ a DISABLED "Conflict
 *    state unknown", because silence is not evidence of a clean branch.
 *
 * The second is the state a kitchen-sink Studio is actually in:
 * `packages/sanity-overlay-next/src/api.ts` → `hydrationDocuments()` projects
 * `logicalId`, `schemaType`, `runtimeRevision`, `updatedAt`, the two tombstones
 * and the two bodies — and no `conflicts` key. So the panel is unreachable from
 * that server no matter what the branch holds. These tests pin both halves so
 * the difference is a fact rather than a guess.
 */
describe('the §28.3 conflict panel opens when the overlay API reports a conflict', () => {
  async function mount(body: unknown) {
    const host = hookHost()
    const patch = overlayWorkspacePatch(workspace(), {
      env: ENV,
      createClient: (options) => createClient(options as never) as unknown as object,
      fetch: stubFetch(body),
      layout: () => null,
      documentActions: createOverlayDocumentActions(host.react),
    })
    await patch.runtime?.refresh()
    const resolved = resolveDocumentActions(patch.workspace, ACTION_CONTEXT)
    const action = resolved.find(
      (entry) => entry.action === 'overlayResolveConflict',
    ) as ActionHook
    return {host, action}
  }

  it('offers the action, and clicking it opens a dialog carrying the panel', async () => {
    const {host, action} = await mount(STATE_BODY_WITH_CONFLICT)

    const first = host.call(action, ACTION_PROPS) as Rec
    expect(first).not.toBeNull()
    expect(String(first.label)).toBe('Resolve conflicts (1)')
    expect(first.tone).toBe('critical')
    expect(first.disabled).toBe(false)
    /* Closed until asked: a dialog on first render would open itself. */
    expect(first.dialog).toBe(false)

    /* What sanity's menu item does: `onAction(index)` then `onHandle()`
     * (`lib/structureTool-EN0gOzyJ.js:5449`). Then it re-renders. */
    ;(first.onHandle as () => void)()
    const opened = host.call(action, ACTION_PROPS) as Rec
    const dialog = opened.dialog as Rec

    /* `type: 'dialog'` with `header` / `content` / `onClose` is exactly what
     * sanity 6.8.0's `ModalDialog` consumes (`structureTool-…:5276`), reached
     * from `ActionStateDialog` (`:5358`). */
    expect(dialog.type).toBe('dialog')
    expect(String(dialog.header)).toContain('article-01')
    expect(typeof dialog.onClose).toBe('function')

    const content = dialog.content as {type: unknown; props: Rec}
    expect(typeof content.type).toBe('function')
    expect(content.props.documentId).toBe('article-01')
    expect(content.props.controller).toBeDefined()

    ;(dialog.onClose as () => void)()
    expect((host.call(action, ACTION_PROPS) as Rec).dialog).toBe(false)
  })

  it('says the state is UNKNOWN — not clean — when the API reports no conflicts field', async () => {
    /* `STATE_BODY` is the shipped `hydrationDocuments()` projection: no
     * `conflicts` key anywhere. The panel is unreachable, and the menu says so
     * rather than showing nothing. */
    const {host, action} = await mount(STATE_BODY)

    const state = host.call(action, ACTION_PROPS) as Rec
    expect(state).not.toBeNull()
    expect(String(state.label)).toBe('Conflict state unknown')
    expect(state.disabled).toBe(true)
    expect(state.dialog).toBe(false)
  })

  it('offers no action at all when the API reports conflicts and this document has none', async () => {
    const clean = {
      ...STATE_BODY,
      documents: STATE_BODY.documents.map((entry) => ({...entry, conflicts: []})),
    }
    const {host, action} = await mount(clean)
    expect(host.call(action, ACTION_PROPS)).toBeNull()
  })
})
