/**
 * sanity 6.8.0's own config-resolution algorithm, transcribed from the installed
 * package so a test can ask "what does Studio actually end up with?" instead of
 * "what did we hand ourselves?".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A PRIVATE COPY IN ONE TEST.
 *
 * The transcription was made in `test/studio-document-action-delivery.test.ts`
 * and lived there, private. The moment a SECOND file needed the same oracle
 * (`test/studio-boot-smoke.test.ts`) the choice was between a second hand copy —
 * which is how two "identical" oracles drift until one of them is wrong and
 * nobody can tell which — and lifting the first one out. This is the lift. The
 * delivery test still carries its own copy because this agent does not own that
 * file; it should import from here when someone who does owns it next touches it.
 *
 * Line references are into `examples/kitchen-sink/node_modules/sanity@6.8.0`:
 *
 *  - `flattenConfig`               `lib/useBundleDocuments-BYW8M9LS.js:2928`
 *      `[...allPlugins, rootConfig]` — the ROOT CONFIG IS LAST, which is the
 *      whole reason the overlay installs its resolver there.
 *  - `documentActionsReducer`      `lib/WorkspaceLoader-BRx2afZV.js:1447`
 *      array ⇒ concat, function ⇒ call, anything else ⇒ throw.
 *  - `initialDocumentActions = []` `lib/WorkspaceLoader-BRx2afZV.js:1409`
 *  - `resolveConfigProperty`       `lib/WorkspaceLoader-BRx2afZV.js:8443`
 *  - `defineHookStateComponent`    `lib/useStudioUrl-90xCJc-c.js:26`
 *      calls the action as a hook with ONE argument and DELETES a `null` return;
 *      a non-null return is re-stamped with `useHook.action`.
 *  - `RenderActionCollectionState` `lib/structureTool-EN0gOzyJ.js:5071`
 *      `(state.group || ['default']).includes('default')` for the status bar.
 *
 * DEPENDENCY-FREE ON PURPOSE. `repo-manifests.test.ts` pins every cross-package
 * import out of `packages/sanity-overlay-testkit/src`, and this file must not
 * add one: it is an oracle, and an oracle that imports the thing it judges is
 * not one. Everything here is plain-object work over `Record<string, unknown>`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Rec = Record<string, unknown>

/** A Sanity document action: a React hook that returns a menu-item description. */
export interface SanityActionHook {
  (props: Rec): Rec | null
  action?: string
  displayName?: string
}

export interface FlatConfigEntry {
  config: Rec
  path: string[]
}

/** `lib/useBundleDocuments-BYW8M9LS.js:2928`. Plugins first, root config LAST. */
export function flattenConfig(input: Rec, path: string[] = []): FlatConfigEntry[] {
  const {plugins = [], ...currentConfig} = input as {plugins?: Rec[]} & Rec
  const rootConfig: FlatConfigEntry = {
    config: currentConfig,
    path: [...path, String(currentConfig.name)],
  }
  const allPlugins = (plugins as Rec[]).flatMap((plugin) =>
    flattenConfig(plugin, [...path, String(currentConfig.name)]),
  )
  return [...allPlugins, rootConfig]
}

/** `lib/WorkspaceLoader-BRx2afZV.js:1447`. */
export function documentActionsReducer(
  prev: readonly SanityActionHook[],
  config: Rec,
  context: Rec,
): readonly SanityActionHook[] {
  const document = config.document as {actions?: unknown} | undefined
  const actions = document?.actions
  if (!actions) return prev
  if (typeof actions === 'function') {
    return (actions as (p: readonly SanityActionHook[], c: Rec) => SanityActionHook[])(prev, context)
  }
  if (Array.isArray(actions)) return [...prev, ...(actions as SanityActionHook[])]
  throw new Error('Expected `document.actions` to be an array or a function')
}

/**
 * `resolveConfigProperty` over `document.actions`, starting from the empty
 * initial list sanity uses (`WorkspaceLoader-BRx2afZV.js:1409`).
 */
export function resolveDocumentActions(
  config: Rec,
  context: Rec,
): readonly SanityActionHook[] {
  return flattenConfig(config).reduce<readonly SanityActionHook[]>(
    (acc, entry) => documentActionsReducer(acc, entry.config, context),
    [],
  )
}

/* ══════════════════════════════════════════════════════ driving the hooks */

/** The slice of React the overlay's components are bound to. */
export interface ReactSlice {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
}

export interface HookHost {
  react: ReactSlice
  /** Render one action hook once, re-rendering whenever its state is set. */
  call(hook: SanityActionHook, props: Rec): Rec | null
}

/**
 * A hook host per action, because sanity gives each one its own component
 * (`defineHookStateComponent`). Slots are indexed per render and reset each
 * pass, exactly as React does, so `useState` in the action behaves like the real
 * thing rather than returning its initial value forever.
 *
 * THIS IS THE ONE SUBSTITUTION IN THE SMOKE PATH, AND IT IS NAMED. A Sanity
 * document action is a React hook; a real React hook cannot be invoked outside a
 * renderer (Node answers "Invalid hook call"), and this package has no DOM
 * environment available to run one in. Callers that use this must pin that the
 * components they drive are the same ones the shipped config installs — by
 * `.action` key and by count and order — rather than assuming it.
 */
export function createHookHost(): HookHost {
  const slots: unknown[] = []
  let index = 0
  let rerender: () => void = () => {}

  const react: ReactSlice = {
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
export function renderActionStates(
  actions: readonly SanityActionHook[],
  host: Pick<HookHost, 'call'>,
  props: Rec,
): Rec[] {
  const states: Rec[] = []
  for (const hook of actions) {
    const state = host.call(hook, props)
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
