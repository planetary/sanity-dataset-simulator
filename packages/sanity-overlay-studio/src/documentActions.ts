/**
 * The three §21.7 document actions that had no built-in to route through:
 * `OverlayRebaseAction`, `OverlayConflictResolutionAction` and
 * `OverlayCheckpointAction`.
 *
 * `actions.ts` handles the other six by *availability* — publish, unpublish,
 * delete, discard, duplicate and restore already reach the network through the
 * intercepted client, so replacing their components would only add a second,
 * weaker copy of the guarantee. These three have no built-in at all: nothing in
 * Sanity spells "rebase this document onto the current base". They have to be
 * new actions.
 *
 * A CONTROLLER, NOT A COMPONENT.
 *
 * A Sanity document action is a React hook — `(props) => DocumentActionDescription`
 * — and a hook is exactly the shape that cannot be tested in a Node suite. So
 * every decision lives in this controller: what the action is called, whether it
 * is enabled, what the confirmation says, what is sent, and what the answer
 * meant. `describe()` returns a plain `DocumentActionDescription`-shaped object
 * — sanity 6.8.0's `dialog: {type: 'confirm', tone, message, onConfirm, onCancel}`
 * is a plain object too (`lib/structureTool-EN0gOzyJ.js:5113`), so the whole
 * confirmation flow is drivable without a renderer. The React binding in
 * `index.ts` is a `useSyncExternalStore` over `state()` and nothing else.
 *
 * DESTRUCTION IS CONFIRMED, ALWAYS.
 *
 * `onHandle()` never sends. It opens the confirm dialog whose message IS the
 * loss report, and only `dialog.onConfirm()` reaches the transport. That is the
 * same order `sanity-overlay rebase` uses — print the report, then refuse
 * without `--confirm` — and the reason it is enforced here rather than left to
 * the component is that a component is the one place this suite cannot check.
 */

import {
  conflictPanelModel,
  type ConflictPanelModel,
  type OverlayConflictReport,
} from './conflicts'
import {
  documentConflictIndicator,
  planConflictResolution,
  type ConflictLoss,
  type ConflictResolutionInput,
} from './conflictPanel'
import {
  planCheckpoint,
  planRebase,
  readRebaseOutcome,
  type OperationLoss,
  type OverlayOperationCommand,
  type StudioRebaseMode,
} from './operations'
import {toPublishedId} from '../../sanity-overlay-core/src/index'
import type {OverlayConflict} from '../../sanity-overlay-core/src/index'
import type {OverlayHydrationDocument, OverlayTransport} from './client/transport'

/* ------------------------------------------------------------------ *
 * The descriptor
 * ------------------------------------------------------------------ */

export type OverlayActionTone = 'default' | 'primary' | 'positive' | 'caution' | 'critical'

/** sanity 6.8.0's confirm dialog, which is a plain object. */
export interface OverlayConfirmDialog {
  type: 'confirm'
  tone: OverlayActionTone
  message: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/** A custom dialog, when the caller injected a renderer for one. */
export interface OverlayCustomDialog {
  type: 'dialog'
  header: string
  content: unknown
  onClose: () => void
}

export interface OverlayActionDescription {
  label: string
  title?: string
  tone?: OverlayActionTone
  disabled: boolean
  onHandle?: () => void
  dialog?: OverlayConfirmDialog | OverlayCustomDialog | false
}

export interface OverlayActionState {
  dialogOpen: boolean
  busy: boolean
  /** The document the open dialog is about. */
  documentId?: string
  error?: string
  result?: string
}

export interface OverlayActionContext {
  id: string
  type?: string
}

export type ConflictResolutionOutcome =
  | {ok: true; message: string}
  | {ok: false; reason: string; loss?: ConflictLoss}

export interface OverlayActionController {
  kind: OverlayActionKind
  state(): OverlayActionState
  subscribe(listener: () => void): () => void
  describe(context: OverlayActionContext): OverlayActionDescription | null
  /** Conflict action only: the §28.3 panel models for one document. */
  conflictPanel?(documentId: string): ConflictPanelModel[]
  /**
   * Conflict action only: the raw §13.11 conflicts for one document.
   *
   * A `ConflictPanelModel` is already a projection — labels and four value rows
   * — and `resolvedPreviewValue` / `planConflictResolution` both need the record
   * itself. A renderer that only had the model would have to re-derive the
   * conflict to preview a button, which is the second, weaker copy of the
   * decision this package exists to avoid.
   */
  conflictsFor?(documentId: string): readonly OverlayConflict[]
  /** Conflict action only: drive one §28.3 action. */
  resolve?(input: ConflictResolutionInput & {conflictId: string; documentId: string}):
    Promise<ConflictResolutionOutcome>
}

export type OverlayActionKind = 'rebase' | 'conflictResolution' | 'checkpoint'

export interface OverlayActionControllerOptions {
  kind: OverlayActionKind
  transport: OverlayTransport
  /** Re-read `/state` after a successful operation. */
  refresh: () => Promise<void>
  /** The overlay's current inventory. Read fresh on every `describe`. */
  documents: readonly OverlayHydrationDocument[] | (() => readonly OverlayHydrationDocument[])
  conflicts: OverlayConflictReport | (() => OverlayConflictReport)
  /** §28.5 default. `auto` tries the safe rebase and reports what blocked it. */
  rebaseMode?: StudioRebaseMode
  /** §28.1 — require no hard conflict before a checkpoint. */
  requireCleanConflicts?: boolean
  actor?: unknown
  /** Monotonic counter for idempotency keys; injected so tests are deterministic. */
  now?: () => number
  /**
   * Render the §28.3 panel into a custom dialog. Without it the conflict action
   * still works (`resolve()` drives every action) but has no dialog of its own —
   * a Node suite has no renderer, and pretending otherwise would put an
   * untestable component in the one place this file exists to keep testable.
   */
  renderConflictPanel?: (controller: OverlayActionController, documentId: string) => unknown
}

/* ------------------------------------------------------------------ */

const LABELS: Readonly<Record<OverlayActionKind, string>> = Object.freeze({
  rebase: 'Rebase onto current base',
  conflictResolution: 'Resolve conflicts',
  checkpoint: 'Create checkpoint',
})

function unwrap<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

export function createOverlayActionController(
  options: OverlayActionControllerOptions,
): OverlayActionController {
  const listeners = new Set<() => void>()
  const clock = options.now ?? ((): number => Date.now())
  let state: OverlayActionState = {dialogOpen: false, busy: false}

  function notify(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        /* One broken subscriber must not stop the others being told. */
      }
    }
  }

  function setState(next: Partial<OverlayActionState>): void {
    state = {...state, ...next}
    notify()
  }

  const documents = (): readonly OverlayHydrationDocument[] => unwrap(options.documents)
  const conflicts = (): OverlayConflictReport => unwrap(options.conflicts)

  async function send(command: OverlayOperationCommand): Promise<boolean> {
    setState({busy: true, error: undefined, result: undefined})
    const result = await options.transport.operation({
      kind: command.kind,
      payload: command,
      idempotencyKey: `studio-${command.kind}-${clock()}`,
      ...(options.actor === undefined ? {} : {actor: options.actor}),
    })

    if (result.outcome !== 'ok') {
      setState({
        busy: false,
        dialogOpen: false,
        error:
          result.message ??
          `The overlay API did not accept the ${command.kind} (${result.outcome}). Nothing was ` +
            'changed, and the branch is in the state it was in before.',
      })
      return false
    }

    if (command.kind === 'rebase') {
      /* §28.5's preconditions come back in the answer, not as an error. A 200
       * that reports a blocked document is a rebase that did NOT happen. */
      const outcome = readRebaseOutcome(result.body)
      if (!outcome.ok) {
        setState({
          busy: false,
          dialogOpen: false,
          error: outcome.reported
            ? `The overlay could not rebase ${outcome.blocked
                .map((entry) => `${entry.logicalId} (${entry.blockedBy.join(', ') || 'blocked'})`)
                .join('; ')}. PRD §28.5 blocks an automatic rebase whose preconditions fail; ` +
              'resolve it with accept-base or keep-local.'
            : 'The overlay API accepted the rebase but reported no per-document outcome, so ' +
              'whether it applied is unknown. Re-read the overlay state before relying on it.',
        })
        await options.refresh()
        return false
      }
    }

    await options.refresh()
    setState({busy: false, dialogOpen: false, result: `${command.kind} applied`})
    return true
  }

  /* ---------------------------------------------------------------- *
   * describe
   * ---------------------------------------------------------------- */

  function rebaseDescription(context: OverlayActionContext): OverlayActionDescription {
    const plan = planRebase({
      mode: options.rebaseMode ?? 'auto',
      documents: documents(),
      documentId: context.id,
      confirmed: false,
    })

    /* Nothing to rebase: the plan refused with no loss report at all. */
    if (!plan.ok && plan.needsConfirmation !== true) {
      return {label: LABELS.rebase, title: plan.reason, disabled: true, dialog: false}
    }

    const loss: OperationLoss = plan.ok ? plan.loss : plan.loss
    const message =
      `${loss.summary}\n\n` +
      loss.documents
        .map(
          (entry) =>
            `  ${entry.logicalId}` +
            `${entry.schemaType === undefined ? '' : ` (${entry.schemaType})`}` +
            `${entry.lastLocalRevision === undefined ? '' : ` at ${entry.lastLocalRevision}`}` +
            `${entry.hasConflict ? ' — has an unresolved conflict' : ''}`,
        )
        .join('\n')

    return {
      label: LABELS.rebase,
      title: loss.summary,
      tone: loss.destructive ? 'critical' : 'default',
      disabled: state.busy,
      onHandle: () => setState({dialogOpen: true, documentId: context.id, error: undefined}),
      dialog:
        state.dialogOpen && state.documentId === context.id
          ? {
              type: 'confirm',
              tone: loss.destructive ? 'critical' : 'default',
              message,
              onConfirm: async () => {
                const confirmed = planRebase({
                  mode: options.rebaseMode ?? 'auto',
                  documents: documents(),
                  documentId: context.id,
                  confirmed: true,
                })
                if (!confirmed.ok) {
                  setState({dialogOpen: false, error: confirmed.reason})
                  return
                }
                await send(confirmed.command)
              },
              onCancel: () => setState({dialogOpen: false}),
            }
          : false,
    }
  }

  function checkpointDescription(context: OverlayActionContext): OverlayActionDescription {
    const plan = planCheckpoint({
      conflicts: conflicts(),
      ...(options.requireCleanConflicts === undefined
        ? {}
        : {requireCleanConflicts: options.requireCleanConflicts}),
    })

    if (!plan.ok) {
      return {label: LABELS.checkpoint, title: plan.reason, disabled: true, dialog: false}
    }

    const inventory = documents()
    return {
      label: LABELS.checkpoint,
      /* Overlay-wide, not per document: §29.1 renders the whole overlay. */
      title:
        `Writes the whole overlay — ${inventory.length} document` +
        `${inventory.length === 1 ? '' : 's'} — to the Git-facing checkpoint (PRD §29.1). ` +
        'Nothing in the branch is changed or removed.',
      tone: 'primary',
      disabled: state.busy,
      onHandle: () => setState({dialogOpen: true, documentId: context.id, error: undefined}),
      dialog:
        state.dialogOpen && state.documentId === context.id
          ? {
              type: 'confirm',
              tone: 'primary',
              message:
                `Create a checkpoint of all ${inventory.length} overlay document` +
                `${inventory.length === 1 ? '' : 's'}? A checkpoint only writes files — no ` +
                'branch state is changed and nothing is lost.',
              onConfirm: async () => {
                await send(plan.command)
              },
              onCancel: () => setState({dialogOpen: false}),
            }
          : false,
    }
  }

  function conflictDescription(context: OverlayActionContext): OverlayActionDescription | null {
    const indicator = documentConflictIndicator(conflicts(), context.id)
    /* Nothing to resolve, and nothing unknown to warn about: no action at all.
     * An always-present "Resolve conflicts" that is disabled 99% of the time is
     * noise, and noise is how a real conflict gets missed. */
    if (indicator.state === 'none') return null

    if (indicator.state === 'unknown') {
      return {
        label: 'Conflict state unknown',
        title: indicator.label,
        tone: 'caution',
        disabled: true,
        dialog: false,
      }
    }

    const open = state.dialogOpen && state.documentId === context.id
    return {
      label: `${LABELS.conflictResolution} (${indicator.total})`,
      title: indicator.label,
      tone: indicator.state === 'hard' ? 'critical' : 'caution',
      disabled: state.busy,
      onHandle: () => setState({dialogOpen: true, documentId: context.id, error: undefined}),
      dialog:
        open && options.renderConflictPanel !== undefined
          ? {
              type: 'dialog',
              header: `Conflicts on ${toPublishedId(context.id)}`,
              content: options.renderConflictPanel(controller, context.id),
              onClose: () => setState({dialogOpen: false}),
            }
          : false,
    }
  }

  function describe(context: OverlayActionContext): OverlayActionDescription | null {
    if (options.kind === 'rebase') return rebaseDescription(context)
    if (options.kind === 'checkpoint') return checkpointDescription(context)
    return conflictDescription(context)
  }

  /* ---------------------------------------------------------------- *
   * The conflict panel half
   * ---------------------------------------------------------------- */

  function conflictsFor(documentId: string): readonly OverlayConflict[] {
    return conflicts().byDocument[toPublishedId(documentId)] ?? []
  }

  function conflictPanel(documentId: string): ConflictPanelModel[] {
    return conflictsFor(documentId).map((conflict) => conflictPanelModel(conflict))
  }

  async function resolve(
    input: ConflictResolutionInput & {conflictId: string; documentId: string},
  ): Promise<ConflictResolutionOutcome> {
    const logicalId = toPublishedId(input.documentId)
    const conflict = (conflicts().byDocument[logicalId] ?? []).find(
      (entry) => entry.id === input.conflictId,
    )
    if (conflict === undefined) {
      const reason =
        `The overlay reports no conflict ${input.conflictId} on ${logicalId}. It may have been ` +
        'resolved elsewhere — re-read the overlay state before resolving again.'
      setState({error: reason})
      return {ok: false, reason}
    }

    const plan = planConflictResolution(conflict, input)
    if (!plan.ok) {
      setState({error: plan.reason})
      return {
        ok: false,
        reason: plan.reason,
        ...(plan.loss === undefined ? {} : {loss: plan.loss}),
      }
    }

    const sent = await send(plan.command)
    if (!sent) return {ok: false, reason: state.error ?? 'the overlay API did not accept it'}
    return {ok: true, message: `Resolved ${conflict.id} as ${plan.command.resolution}`}
  }

  const controller: OverlayActionController = {
    kind: options.kind,
    state: () => ({...state}),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    describe,
    ...(options.kind === 'conflictResolution' ? {conflictPanel, conflictsFor, resolve} : {}),
  }

  return controller
}
