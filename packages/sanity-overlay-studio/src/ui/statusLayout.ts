/**
 * The overlay status banner (PRD §21.3, §32) and the §28.3 conflict list.
 *
 * REACT IS INJECTED, NOT IMPORTED.
 *
 * Two reasons, and the second is the one that matters. The first: `react` is a
 * peer dependency, and a package that imports it directly can end up with a
 * second copy in a pnpm workspace — the classic "invalid hook call". The second:
 * injection is what lets this module be a *pure factory*, unit-tested against a
 * fake `createElement` with no DOM and no renderer, which is the only way the
 * banner's actual decisions (what is shown, in what state, with what severity)
 * get tested at all in a Node test suite.
 *
 * The component itself derives nothing: `deriveOverlayStatus` in `status.ts`
 * owns every judgement, and this renders its output.
 */

import type {ConflictPanelModel} from '../conflicts'
import {conflictPanelModel} from '../conflicts'
import type {OverlayRuntime} from '../runtime'
import {getOverlayRuntime} from '../runtime'
import type {OverlaySeverity, OverlayStatus, OverlayStatusLine} from '../status'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The slice of React this module needs. */
export interface ReactLike {
  createElement: (type: any, props?: any, ...children: any[]) => any
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
  useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void]
  useSyncExternalStore?: <S>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => S,
  ) => S
}

export interface OverlayLayoutProps {
  renderDefault: (props: OverlayLayoutProps) => unknown
  /** Studio passes the workspace through context; the name is looked up when present. */
  name?: string
}

const BACKGROUND: Readonly<Record<OverlaySeverity, string>> = Object.freeze({
  neutral: '#1f2933',
  warning: '#8a5a00',
  critical: '#8b1a1a',
})

/** Colours are inline so the banner never depends on the Studio theme loading. */
function bannerStyle(severity: OverlaySeverity): Record<string, string> {
  return {
    background: BACKGROUND[severity],
    color: '#ffffff',
    font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '6px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    borderBottom: '1px solid rgba(255,255,255,0.2)',
  }
}

/** Shared by both tiers: one wrapping row of baseline-aligned fields. */
function bannerRowStyle(): Record<string, string> {
  return {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 16px',
    alignItems: 'baseline',
  }
}

export interface OverlayBannerViewModel {
  status: OverlayStatus
  conflicts: ConflictPanelModel[]
  conflictNote?: string
  messages: readonly string[]
  /** Tier 1: the one line that survives collapse — see the module comment. */
  summaryLines: OverlayStatusLine[]
  /** Tier 2: every other status line, shown only when Details is expanded. */
  detailLines: OverlayStatusLine[]
}

/**
 * Everything the banner shows, derived from a runtime. Pure — this is the
 * function the tests assert on.
 */
export function overlayBannerViewModel(runtime: OverlayRuntime): OverlayBannerViewModel {
  const report = runtime.conflicts()
  const conflicts = Object.values(report.byDocument)
    .flat()
    /* The banner is "what needs you". A RESOLVED conflict is history — the
     * panel shows it; a ⛔ row with zero action labels and a dangling "—" is
     * how it rendered here before this filter (seen live 2026-08-11, minutes
     * after resolution first worked: summary said zero, rows said danger). */
    .filter((conflict) => conflict.resolution === undefined)
    .map((conflict) => conflictPanelModel(conflict))
  const status = runtime.status()
  /* Every line except "Overlay revision" moves to Tier 2 (2026-08-11 redesign):
   * identity, storage, base, checkpoint and the API endpoint are context, not
   * something that needs you the way a blocking conflict does. Revision is the
   * one number worth a glance at all times. */
  const summaryLines = status.lines.filter((line) => line.label === 'Overlay revision')
  const detailLines = status.lines.filter((line) => line.label !== 'Overlay revision')
  return {
    status,
    conflicts,
    conflictNote: report.note,
    messages: runtime.messages(),
    summaryLines,
    detailLines,
  }
}

/**
 * Build the `studio.components.layout` component.
 *
 * A layout component **must** call `props.renderDefault(props)` — not calling it
 * short-circuits every downstream layout, including the Studio's own. The banner
 * is rendered above it, never instead of it.
 */
export function createOverlayStatusLayout(
  react: ReactLike,
  options: {pollMs?: number} = {},
): (props: OverlayLayoutProps) => unknown {
  const pollMs = options.pollMs ?? 5000

  return function OverlayStatusLayout(props: OverlayLayoutProps): unknown {
    const runtime = getOverlayRuntime(props.name ?? '*')
    const [, setTick] = react.useState(0)
    const [expanded, setExpanded] = react.useState(false)

    react.useEffect(() => {
      if (runtime === undefined) return undefined
      const unsubscribe = runtime.subscribe(() => setTick((tick) => tick + 1))
      void runtime.refresh()
      const timer = setInterval(() => void runtime.refresh(), pollMs)
      return () => {
        unsubscribe()
        clearInterval(timer)
      }
    }, [runtime])

    const rendered = props.renderDefault(props)
    if (runtime === undefined) return rendered

    const model = overlayBannerViewModel(runtime)
    const {status} = model

    /* Tier 1: always visible. Identity, revision and blocking facts only — see
     * the module comment and the 2026-08-11 redesign note in the test suite for
     * why the rest moved to Tier 2. */
    const summary: unknown[] = [
      react.createElement(
        'strong',
        {key: 'title', style: {letterSpacing: '0.08em'}},
        'BRANCH OVERLAY',
      ),
      react.createElement('span', {key: 'headline'}, status.headline),
      ...model.summaryLines.map((line) =>
        react.createElement(
          'span',
          {key: line.label, style: {opacity: '0.75'}},
          `${line.label}: ${line.value}`,
        ),
      ),
    ]

    if (model.conflictNote !== undefined) {
      summary.push(
        react.createElement('span', {key: 'conflict-note', style: {opacity: '0.75'}}, model.conflictNote),
      )
    }

    for (const conflict of model.conflicts) {
      summary.push(
        react.createElement(
          'span',
          {key: `conflict-${conflict.id}`, style: {opacity: '0.9'}},
          `${conflict.severity === 'hard' ? '⛔' : '⚠'} ${conflict.documentId} ` +
            `${conflict.pathLabel} — ${conflict.actions.map((action) => action.label).join(' / ')}`,
        ),
      )
    }

    summary.push(
      react.createElement(
        'button',
        {
          key: 'details-toggle',
          'data-testid': 'overlay-banner-details-toggle',
          onClick: () => setExpanded((current) => !current),
        },
        expanded ? 'Hide details' : 'Details',
      ),
    )

    const rows: unknown[] = [react.createElement('div', {key: 'summary', style: bannerRowStyle()}, ...summary)]

    /* Tier 2: everything else, rendered only when expanded — the fake `react`
     * in the test suite that starts `useState(false)` at `true` is how DOM
     * coverage is exercised, since a fake `useState` cannot be flipped by a
     * click with no renderer behind it. */
    if (expanded) {
      const details: unknown[] = model.detailLines.map((line) =>
        react.createElement(
          'span',
          {key: line.label, style: {opacity: '0.75'}},
          `${line.label}: ${line.value}`,
        ),
      )
      for (const [index, message] of model.messages.entries()) {
        details.push(react.createElement('span', {key: `message-${index}`, style: {opacity: '0.75'}}, message))
      }
      rows.push(
        react.createElement(
          'div',
          {key: 'details', 'data-testid': 'overlay-banner-details', style: bannerRowStyle()},
          ...details,
        ),
      )
    }

    const banner = react.createElement(
      'div',
      {
        style: bannerStyle(status.severity),
        'data-overlay-state': status.state,
        'data-overlay-severity': status.severity,
        'data-testid': 'overlay-status-banner',
      },
      ...rows,
    )

    /* A fatal state replaces the Studio entirely: §21.3 says "Fatal screen. No
     * reads or writes", and leaving the editor mounted invites exactly the
     * writes that state exists to prevent. */
    if (status.fatal) {
      return react.createElement(
        'div',
        {style: {padding: '0', minHeight: '100vh', background: '#111'}, 'data-testid': 'overlay-fatal'},
        banner,
      )
    }

    return react.createElement(
      'div',
      {style: {display: 'flex', flexDirection: 'column', height: '100%'}},
      banner,
      react.createElement('div', {style: {flex: '1', minHeight: '0'}}, rendered),
    )
  }
}
