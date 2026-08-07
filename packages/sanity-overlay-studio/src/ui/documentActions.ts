/**
 * The three §21.7 overlay document actions, as things Sanity can put in a menu.
 *
 * `documentActions.ts` already owns every decision — what the action is called,
 * whether it is enabled, what the confirmation says, what is sent, what the
 * answer meant. It stops at a controller on purpose: a Sanity document action is
 * a React hook, and a hook is the one shape a Node suite cannot drive. This file
 * is the missing binding, and it is deliberately thin. If a judgement ever
 * appears here, it has appeared in the one place that is not tested.
 *
 * WHERE THE RUNTIME COMES FROM
 * ────────────────────────────
 * A document action receives `{id, type, …}` and no workspace, so it finds its
 * runtime through the same registry the status banner uses (`runtime.ts`),
 * falling back to `'*'` — correct for the overwhelmingly common single-workspace
 * Studio and the only thing available in a multi-workspace one. The controllers
 * are cached per runtime in a `WeakMap`, because a controller holds the open
 * dialog's state: rebuilding one on every render would close the dialog the
 * moment anything re-rendered.
 *
 * THE IDENTITY RULE APPLIES HERE TOO. `config.ts` installs these components once
 * and the resolver returns the same objects on every call, so Studio's
 * `useMemo`/dependency comparisons see a stable list. `spike-a-client-identity`
 * exists because an unstable reference in this position cost 20,000 resubscribes.
 */

import {
  createOverlayActionController,
  type OverlayActionContext,
  type OverlayActionController,
  type OverlayActionDescription,
  type OverlayActionKind,
} from '../documentActions'
import type {StudioRebaseMode} from '../operations'
import {getOverlayRuntime, type OverlayRuntime} from '../runtime'
import {createOverlayConflictPanel} from './conflictPanel'
import type {ReactLike} from './statusLayout'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The `action` key each component declares.
 *
 * `overlayDocumentActionsResolver` de-duplicates on it, so these strings are the
 * whole of its idempotence: two components with the same key are one action, and
 * a component with none would be appended on every resolve pass.
 */
export const OVERLAY_ACTION_NAMES = Object.freeze({
  rebase: 'overlayRebase',
  conflictResolution: 'overlayResolveConflict',
  checkpoint: 'overlayCheckpoint',
}) as Readonly<Record<OverlayActionKind, string>>

/** The order the three appear in the menu. Rebase, then resolve, then checkpoint. */
const ACTION_ORDER: readonly OverlayActionKind[] = [
  'rebase',
  'conflictResolution',
  'checkpoint',
]

export interface OverlayControllerSet {
  rebase: OverlayActionController
  conflictResolution: OverlayActionController
  checkpoint: OverlayActionController
}

export interface OverlayActionControllersOptions {
  /** Renders the §28.3 panel into the conflict action's custom dialog. */
  renderConflictPanel?: (controller: OverlayActionController, documentId: string) => unknown
  rebaseMode?: StudioRebaseMode
  requireCleanConflicts?: boolean
  actor?: unknown
  now?: () => number
}

/**
 * Build the three controllers for one runtime.
 *
 * React-free, so the wiring is testable without a renderer. Every input is a
 * THUNK over the runtime rather than a snapshot: a controller built at config
 * time would otherwise describe the branch as it was before the first `/state`
 * poll, and go on doing so forever.
 */
export function createOverlayActionControllers(
  runtime: OverlayRuntime,
  options: OverlayActionControllersOptions = {},
): OverlayControllerSet {
  const shared = {
    transport: runtime.transport,
    refresh: () => runtime.refresh(),
    documents: () => runtime.documents(),
    conflicts: () => runtime.conflicts(),
    /* §16.1: the Studio is the only party holding a Sanity credential, so it is
     * the only party that can state the current base a §17 rebase needs. */
    baseDocuments: (logicalIds: readonly string[]) => runtime.baseDocuments(logicalIds),
    ...(options.actor === undefined ? {} : {actor: options.actor}),
    ...(options.now === undefined ? {} : {now: options.now}),
  }

  return {
    rebase: createOverlayActionController({
      ...shared,
      kind: 'rebase',
      ...(options.rebaseMode === undefined ? {} : {rebaseMode: options.rebaseMode}),
    }),
    conflictResolution: createOverlayActionController({
      ...shared,
      kind: 'conflictResolution',
      ...(options.renderConflictPanel === undefined
        ? {}
        : {renderConflictPanel: options.renderConflictPanel}),
    }),
    checkpoint: createOverlayActionController({
      ...shared,
      kind: 'checkpoint',
      ...(options.requireCleanConflicts === undefined
        ? {}
        : {requireCleanConflicts: options.requireCleanConflicts}),
    }),
  }
}

/* ------------------------------------------------------------------ */

/** The props Sanity hands a document action, narrowed to what is used. */
export interface OverlayDocumentActionProps {
  id: string
  type?: string
  /** Workspace name, when the host can supply one. Defaults to the registry's `'*'`. */
  workspace?: string
}

export interface OverlayDocumentActionComponent {
  (props: OverlayDocumentActionProps): OverlayActionDescription | null
  action: string
  displayName: string
}

export interface CreateOverlayDocumentActionsOptions extends OverlayActionControllersOptions {
  /** Injected for tests; defaults to the workspace registry. */
  getRuntime?: (workspace: string) => OverlayRuntime | undefined
}

/**
 * Build the three document action components, bound to a host's React.
 *
 * Returned in menu order and as the SAME objects every call, so a resolver that
 * appends them can be idempotent.
 */
export function createOverlayDocumentActions(
  react: ReactLike,
  options: CreateOverlayDocumentActionsOptions = {},
): OverlayDocumentActionComponent[] {
  const lookup = options.getRuntime ?? getOverlayRuntime
  const panel = createOverlayConflictPanel(react)
  /* One set per runtime, kept for the lifetime of that runtime. A controller
   * holds the open dialog's state, so a fresh one per render would slam the
   * dialog shut on the first keystroke inside it. */
  const controllers = new WeakMap<OverlayRuntime, OverlayControllerSet>()

  function setFor(runtime: OverlayRuntime): OverlayControllerSet {
    const existing = controllers.get(runtime)
    if (existing !== undefined) return existing
    const built = createOverlayActionControllers(runtime, {
      ...options,
      renderConflictPanel: (controller, documentId) =>
        react.createElement(panel as any, {controller, documentId}),
    })
    controllers.set(runtime, built)
    return built
  }

  return ACTION_ORDER.map((kind) => {
    function OverlayDocumentAction(
      props: OverlayDocumentActionProps,
    ): OverlayActionDescription | null {
      const runtime = lookup(props.workspace ?? '*')
      const [, setTick] = react.useState(0)

      /* Subscribed BEFORE the `runtime === undefined` branch: hooks must run in
       * the same order on every render, and an overlay that appears later (a
       * second workspace registering) must still re-render this action. */
      react.useEffect(() => {
        if (runtime === undefined) return undefined
        const controller = setFor(runtime)[kind]
        return controller.subscribe(() => setTick((tick) => tick + 1))
      }, [runtime])

      if (runtime === undefined) return null

      const context: OverlayActionContext = {
        id: props.id,
        ...(props.type === undefined ? {} : {type: props.type}),
      }
      return setFor(runtime)[kind].describe(context)
    }

    OverlayDocumentAction.action = OVERLAY_ACTION_NAMES[kind]
    OverlayDocumentAction.displayName = OVERLAY_ACTION_NAMES[kind]
    return OverlayDocumentAction as OverlayDocumentActionComponent
  })
}
