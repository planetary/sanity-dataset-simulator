/**
 * The §28.3 document conflict panel — the surface an editor actually touches.
 *
 * Everything it decides was already built: `conflicts.ts` produces the four
 * §28.3 value rows and the applicable action labels, `conflictPanel.ts` owns
 * `resolvedPreviewValue` and `planConflictResolution`. What did not exist was
 * anything a human could see or click, so a conflict was reachable only from a
 * test. §28.1 says conflicts are never hidden; an unrendered panel hides all of
 * them.
 *
 * TWO LAYERS, AND THE SPLIT IS THE WHOLE DESIGN.
 *
 *   {@link conflictPanelView}          pure. Conflicts + the operator's
 *                                      in-progress form state → everything the
 *                                      panel shows, including WHY a button is
 *                                      disabled. Every judgement lives here.
 *   {@link createOverlayConflictPanel} `createElement` calls over that view,
 *                                      plus the handlers that feed it back.
 *
 * REACT IS INJECTED, NOT IMPORTED — the same rule `statusLayout.ts` states and
 * for the same two reasons: `react` is a peer dependency and a direct import
 * risks a second copy in a pnpm workspace, and injection is what makes the
 * component testable in a Node suite with no DOM.
 *
 * THE PANEL NEVER DECIDES A RESOLUTION. Each button carries the
 * `ConflictResolutionInput` that `planConflictResolution` already accepted, and
 * hands it to `controller.resolve()`, which re-plans it and sends the command.
 * Two validations of the same input by the same function: the panel cannot
 * enable something the controller would refuse, and cannot refuse something the
 * controller would accept. A reason shown to the operator is the planner's own
 * wording, never a second paraphrase that could drift from it.
 */

import {
  applicableResolutionActions,
  toPublishedId,
  type ConflictResolutionAction,
  type OverlayConflict,
  type OverlayConflictResolutionType,
  type OverlayConflictSeverity,
} from '../../../sanity-overlay-core/src/index'
import {
  conflictPanelModel,
  formatConflictPath,
  type ConflictPanelValue,
} from '../conflicts'
import {
  planConflictResolution,
  resolvedPreviewValue,
  type ConflictLoss,
  type ConflictResolutionInput,
  type ResolvedPreview,
} from '../conflictPanel'
import type {OverlayActionController} from '../documentActions'
import type {ReactLike} from './statusLayout'

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *
 * The operator's in-progress form state
 * ------------------------------------------------------------------ */

/**
 * What the operator has typed and ticked, keyed so one open panel can hold
 * several conflicts without their forms bleeding into each other.
 *
 * `confirmed` is keyed by `${conflictId}:${action}` on purpose: confirming that
 * you accept losing the branch value is a statement about ONE action. Ticking
 * it for "accept current staging" must not pre-confirm "accept base deletion",
 * which throws away the whole document.
 */
export interface ConflictPanelUiState {
  selected: Record<string, ConflictResolutionAction>
  /** conflictId → the manual-edit value, as source text. */
  drafts: Record<string, string>
  /** conflictId → the new ID typed for `rename-branch-id`. */
  renames: Record<string, string>
  /** `${conflictId}:${action}` → the loss was acknowledged. */
  confirmed: Record<string, boolean>
}

export const EMPTY_CONFLICT_PANEL_UI: ConflictPanelUiState = Object.freeze({
  selected: {},
  drafts: {},
  renames: {},
  confirmed: {},
}) as ConflictPanelUiState

export function confirmKey(conflictId: string, action: ConflictResolutionAction): string {
  return `${conflictId}:${action}`
}

/* ------------------------------------------------------------------ *
 * The manual edit box
 * ------------------------------------------------------------------ */

export type ManualEditParse = {ok: true; value: unknown} | {ok: false; error: string}

/**
 * Parse what the operator typed into the manual-edit box.
 *
 * JSON, with exactly one extra token: the literal `undefined`, which is §28.3's
 * "remove this field" instruction. `planConflictResolution` distinguishes a
 * present `value` key holding `undefined` (remove the field) from an absent one
 * (an unfinished form), and the box needs a way to say the first — JSON has no
 * spelling for it.
 *
 * An empty box is NOT "remove": it is a form nobody has filled in, and reading
 * it as an instruction would silently unset the very field being merged.
 */
export function parseManualEditSource(source: string): ManualEditParse {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      error:
        'Type the resolved value as JSON — for example "text", 42, or {"_type": "block"}. ' +
        'Type `undefined` to remove the field instead; an empty box is an unfinished form, ' +
        'not an instruction.',
    }
  }
  if (trimmed === 'undefined') return {ok: true, value: undefined}
  try {
    return {ok: true, value: JSON.parse(trimmed)}
  } catch (error) {
    return {
      ok: false,
      error: `That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/* ------------------------------------------------------------------ *
 * The view model
 * ------------------------------------------------------------------ */

export interface ConflictPanelActionView {
  action: ConflictResolutionAction
  label: string
  resolution: OverlayConflictResolutionType
  selected: boolean
  /** §28.3's fourth row, for THIS action. Shown before anything is sent. */
  preview: ResolvedPreview
  /** Present when the action destroys branch work. */
  loss?: ConflictLoss
  needsConfirmation: boolean
  confirmed: boolean
  enabled: boolean
  /** `planConflictResolution`'s own wording, never a paraphrase. */
  reason?: string
  /** The input to hand `controller.resolve()`. Present only when `enabled`. */
  input?: ConflictResolutionInput
}

export interface ConflictPanelRowView {
  conflictId: string
  documentId: string
  severity: OverlayConflictSeverity
  conflictType: string
  pathLabel: string
  detectedAt: string
  resolved: boolean
  /** The four §28.3 rows, in §28.3 order, tracking the selected action. */
  values: ConflictPanelValue[]
  actions: ConflictPanelActionView[]
  selectedAction?: ConflictResolutionAction
  /** Present when `manual-edit` is selected. */
  manualEdit?: {source: string; parseError?: string}
  /** Present when `rename-branch-id` applies. */
  rename?: {newId: string}
}

export interface ConflictPanelView {
  documentId: string
  rows: ConflictPanelRowView[]
  /** Nothing to resolve. Stated, never a blank box. */
  empty: boolean
  emptyReason?: string
  busy: boolean
  error?: string
}

export interface ConflictPanelViewInput {
  documentId: string
  conflicts: readonly OverlayConflict[]
  ui?: Partial<ConflictPanelUiState>
  /** A send is in flight. Everything is held until it lands. */
  busy?: boolean
  /** The controller's last refusal, shown rather than swallowed. */
  error?: string
}

const EMPTY_REASON =
  'The overlay reports no conflicts on this document. Nothing here needs a decision — ' +
  'if you expected one, re-read the overlay state; a conflict resolved elsewhere is gone.'

function inputFor(
  conflict: OverlayConflict,
  action: ConflictResolutionAction,
  ui: ConflictPanelUiState,
): ConflictResolutionInput | {refusal: string} {
  const confirmed = ui.confirmed[confirmKey(conflict.id, action)] === true

  if (action === 'manual-edit') {
    const source = ui.drafts[conflict.id] ?? ''
    const parsed = parseManualEditSource(source)
    if (!parsed.ok) return {refusal: parsed.error}
    /* The KEY is present even when the value is `undefined` — that is the
     * difference between "remove this field" and "the form is unfinished". */
    return {action, value: parsed.value, ...(confirmed ? {confirmed} : {})}
  }

  if (action === 'rename-branch-id') {
    return {action, newId: ui.renames[conflict.id] ?? '', ...(confirmed ? {confirmed} : {})}
  }

  return {action, ...(confirmed ? {confirmed} : {})}
}

function actionView(
  conflict: OverlayConflict,
  action: ConflictResolutionAction,
  label: string,
  resolution: OverlayConflictResolutionType,
  ui: ConflictPanelUiState,
  busy: boolean,
): ConflictPanelActionView {
  const confirmed = ui.confirmed[confirmKey(conflict.id, action)] === true
  const selected = ui.selected[conflict.id] === action
  const built = inputFor(conflict, action, ui)

  /* A form-level refusal (unparseable JSON, an empty box) never reaches the
   * planner: there is no input to plan. The preview falls back to the action's
   * shape so the fourth row is not blank while the operator is typing. */
  if ('refusal' in built) {
    return {
      action,
      label,
      resolution,
      selected,
      preview: resolvedPreviewValue(conflict, {action}),
      needsConfirmation: false,
      confirmed,
      enabled: false,
      reason: built.refusal,
    }
  }

  const plan = planConflictResolution(conflict, built)
  const loss = plan.loss
  const needsConfirmation = plan.ok ? false : plan.needsConfirmation === true

  return {
    action,
    label,
    resolution,
    selected,
    preview: plan.ok ? plan.preview : resolvedPreviewValue(conflict, built),
    ...(loss === undefined ? {} : {loss}),
    needsConfirmation,
    confirmed,
    /* `busy` disables everything: a second send against a state the first one is
     * about to change is how one resolution lands twice. */
    enabled: plan.ok && !busy,
    ...(plan.ok ? {} : {reason: plan.reason}),
    ...(plan.ok ? {input: built} : {}),
  }
}

/**
 * Everything the §28.3 panel shows for one document.
 *
 * Pure, and the only place a decision is made. The component below reads it and
 * renders; it derives nothing.
 */
export function conflictPanelView(input: ConflictPanelViewInput): ConflictPanelView {
  const ui: ConflictPanelUiState = {
    selected: input.ui?.selected ?? {},
    drafts: input.ui?.drafts ?? {},
    renames: input.ui?.renames ?? {},
    confirmed: input.ui?.confirmed ?? {},
  }
  const busy = input.busy === true
  const documentId = toPublishedId(input.documentId)

  const rows = input.conflicts.map((conflict): ConflictPanelRowView => {
    const selectedAction = ui.selected[conflict.id]
    const applicable = applicableResolutionActions(conflict)

    /* The fourth §28.3 row follows the SELECTED action, and falls back to the
     * branch value when nothing is selected — which is what the branch would
     * hold if the operator walked away. */
    const previewValue =
      selectedAction === undefined
        ? undefined
        : resolvedPreviewValue(
            conflict,
            (() => {
              const built = inputFor(conflict, selectedAction, ui)
              return 'refusal' in built ? {action: selectedAction} : built
            })(),
          ).value

    const model = conflictPanelModel(
      conflict,
      selectedAction === undefined ? undefined : {resolvedValue: previewValue},
    )

    const actions = model.actions.map((entry) =>
      actionView(conflict, entry.action, entry.label, entry.resolution, ui, busy),
    )
    void applicable

    return {
      conflictId: conflict.id,
      documentId: conflict.documentId,
      severity: conflict.severity,
      conflictType: conflict.type,
      pathLabel: formatConflictPath(conflict.path as readonly (string | number)[] | undefined),
      detectedAt: conflict.detectedAt,
      resolved: conflict.resolution !== undefined,
      values: model.values,
      actions,
      ...(selectedAction === undefined ? {} : {selectedAction}),
      ...(selectedAction === 'manual-edit'
        ? {
            manualEdit: (() => {
              const source = ui.drafts[conflict.id] ?? ''
              const parsed = parseManualEditSource(source)
              return parsed.ok ? {source} : {source, parseError: parsed.error}
            })(),
          }
        : {}),
      ...(model.actions.some((entry) => entry.action === 'rename-branch-id')
        ? {rename: {newId: ui.renames[conflict.id] ?? ''}}
        : {}),
    }
  })

  return {
    documentId,
    rows,
    empty: rows.length === 0,
    ...(rows.length === 0 ? {emptyReason: EMPTY_REASON} : {}),
    busy,
    ...(input.error === undefined ? {} : {error: input.error}),
  }
}

/* ------------------------------------------------------------------ *
 * The component
 * ------------------------------------------------------------------ */

export interface OverlayConflictPanelProps {
  controller: OverlayActionController
  documentId: string
}

const PANEL_STYLE: Record<string, string> = {
  font: '13px/1.5 ui-sans-serif, system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  maxHeight: '70vh',
  overflow: 'auto',
  padding: '4px',
}

const ROW_STYLE: Record<string, string> = {
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: '4px',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const VALUE_STYLE: Record<string, string> = {
  display: 'grid',
  gridTemplateColumns: 'minmax(140px, max-content) 1fr',
  gap: '8px',
  alignItems: 'baseline',
}

const CODE_STYLE: Record<string, string> = {
  font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  margin: '0',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/** JSON for display. `undefined` has no JSON spelling, so it is named. */
function show(value: unknown): string {
  if (value === undefined) return '(no value)'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Build the §28.3 panel component.
 *
 * Rendered into `OverlayCustomDialog.content` by the conflict document action —
 * see `ui/documentActions.ts`, which is what passes `renderConflictPanel` to
 * `createOverlayActionController`.
 */
export function createOverlayConflictPanel(
  react: ReactLike,
): (props: OverlayConflictPanelProps) => unknown {
  return function OverlayConflictPanel(props: OverlayConflictPanelProps): unknown {
    const {controller, documentId} = props
    const [ui, setUi] = react.useState<ConflictPanelUiState>(() => ({
      selected: {},
      drafts: {},
      renames: {},
      confirmed: {},
    }))
    const [, setTick] = react.useState(0)

    react.useEffect(() => {
      return controller.subscribe(() => setTick((tick) => tick + 1))
    }, [controller])

    const state = controller.state()
    const conflicts = controller.conflictsFor?.(documentId) ?? []
    const view = conflictPanelView({
      documentId,
      conflicts,
      ui,
      busy: state.busy,
      ...(state.error === undefined ? {} : {error: state.error}),
    })

    function patch(next: Partial<ConflictPanelUiState>): void {
      setUi((previous) => ({...previous, ...next}))
    }

    function select(conflictId: string, action: ConflictResolutionAction): void {
      patch({selected: {...ui.selected, [conflictId]: action}})
    }

    async function run(
      row: ConflictPanelRowView,
      entry: ConflictPanelActionView,
    ): Promise<void> {
      /* One click does two things, in this order, and never skips the first:
       * SELECT the action — which surfaces its loss report, its manual-edit box
       * or its rename field — and send it only if it is already sendable. So a
       * destructive action's first click can never be its last. */
      if (!entry.selected) select(row.conflictId, entry.action)
      if (!entry.enabled || entry.input === undefined) return
      await controller.resolve?.({
        ...entry.input,
        conflictId: row.conflictId,
        documentId: row.documentId,
      })
    }

    if (view.empty) {
      return react.createElement(
        'div',
        {
          style: PANEL_STYLE,
          'data-testid': 'overlay-conflict-panel',
          'data-document-id': view.documentId,
        },
        react.createElement(
          'p',
          {'data-testid': 'overlay-conflict-empty', style: {margin: '0'}},
          view.emptyReason,
        ),
      )
    }

    const children: unknown[] = []

    if (view.error !== undefined) {
      children.push(
        react.createElement(
          'p',
          {
            key: 'error',
            'data-testid': 'overlay-conflict-error',
            style: {margin: '0', color: '#b3261e', fontWeight: '600'},
          },
          view.error,
        ),
      )
    }

    for (const row of view.rows) {
      const rowChildren: unknown[] = [
        react.createElement(
          'h3',
          {key: 'heading', style: {margin: '0', fontSize: '13px'}},
          `${row.severity === 'hard' ? '⛔' : '⚠'} ${row.conflictType} — ${row.pathLabel}`,
        ),
      ]

      for (const value of row.values) {
        rowChildren.push(
          react.createElement(
            'div',
            {
              key: `value-${value.label}`,
              'data-testid': 'overlay-conflict-value',
              'data-label': value.label,
              style: VALUE_STYLE,
            },
            react.createElement('span', {style: {opacity: '0.75'}}, value.label),
            react.createElement('pre', {style: CODE_STYLE}, show(value.value)),
          ),
        )
      }

      if (row.resolved) {
        rowChildren.push(
          react.createElement(
            'p',
            {key: 'resolved', style: {margin: '0', opacity: '0.75'}},
            'Already resolved. Resolving it again would record a second decision for a ' +
              'disagreement that is settled.',
          ),
        )
      }

      if (row.manualEdit !== undefined) {
        rowChildren.push(
          react.createElement('textarea', {
            key: 'manual-edit',
            'data-testid': 'overlay-conflict-manual-edit',
            'data-conflict-id': row.conflictId,
            rows: 4,
            value: row.manualEdit.source,
            placeholder: 'JSON, or `undefined` to remove the field',
            style: {...CODE_STYLE, width: '100%'},
            onChange: (event: any) =>
              patch({drafts: {...ui.drafts, [row.conflictId]: String(event?.target?.value ?? '')}}),
          }),
        )
        if (row.manualEdit.parseError !== undefined) {
          rowChildren.push(
            react.createElement(
              'p',
              {
                key: 'manual-edit-error',
                'data-testid': 'overlay-conflict-parse-error',
                style: {margin: '0', color: '#b3261e'},
              },
              row.manualEdit.parseError,
            ),
          )
        }
      }

      if (row.rename !== undefined) {
        rowChildren.push(
          react.createElement('input', {
            key: 'rename',
            'data-testid': 'overlay-conflict-rename',
            'data-conflict-id': row.conflictId,
            type: 'text',
            value: row.rename.newId,
            placeholder: 'New branch-created document ID',
            style: {...CODE_STYLE, width: '100%'},
            onChange: (event: any) =>
              patch({
                renames: {...ui.renames, [row.conflictId]: String(event?.target?.value ?? '')},
              }),
          }),
        )
      }

      for (const entry of row.actions) {
        if (entry.loss !== undefined) {
          rowChildren.push(
            react.createElement(
              'p',
              {
                key: `loss-${entry.action}`,
                'data-testid': 'overlay-conflict-loss',
                'data-action': entry.action,
                style: {margin: '0', color: '#8a5a00'},
              },
              entry.loss.summary,
            ),
            react.createElement(
              'label',
              {
                key: `confirm-${entry.action}`,
                'data-testid': 'overlay-conflict-confirm',
                'data-action': entry.action,
                style: {display: 'flex', gap: '6px', alignItems: 'center'},
                onChange: (event: any) =>
                  patch({
                    confirmed: {
                      ...ui.confirmed,
                      [confirmKey(row.conflictId, entry.action)]: event?.target?.checked === true,
                    },
                  }),
              },
              react.createElement('input', {
                type: 'checkbox',
                checked: entry.confirmed,
                readOnly: true,
              }),
              react.createElement('span', {}, `I accept this loss — ${entry.label}`),
            ),
          )
        }
      }

      rowChildren.push(
        react.createElement(
          'div',
          {key: 'actions', style: {display: 'flex', flexWrap: 'wrap', gap: '8px'}},
          ...row.actions.map((entry) =>
            react.createElement(
              'button',
              {
                key: entry.action,
                type: 'button',
                'data-testid': 'overlay-conflict-action',
                'data-action': entry.action,
                'data-selected': entry.selected,
                disabled: !entry.enabled,
                title: entry.reason ?? `Resolved preview: ${show(entry.preview.value)}`,
                onClick: () => run(row, entry),
                style: {
                  padding: '4px 10px',
                  borderRadius: '3px',
                  border: entry.selected
                    ? '2px solid currentColor'
                    : '1px solid rgba(128,128,128,0.6)',
                },
              },
              entry.label,
            ),
          ),
        ),
      )

      children.push(
        react.createElement(
          'section',
          {
            key: row.conflictId,
            'data-testid': 'overlay-conflict-row',
            'data-conflict-id': row.conflictId,
            'data-severity': row.severity,
            'data-resolved': row.resolved,
            style: ROW_STYLE,
          },
          ...rowChildren,
        ),
      )
    }

    return react.createElement(
      'div',
      {
        style: PANEL_STYLE,
        'data-testid': 'overlay-conflict-panel',
        'data-document-id': view.documentId,
        'data-busy': view.busy,
      },
      ...children,
    )
  }
}
