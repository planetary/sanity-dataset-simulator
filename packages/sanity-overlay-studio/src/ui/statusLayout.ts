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
import type {OverlaySeverity, OverlayStatus} from '../status'

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
    flexWrap: 'wrap',
    gap: '4px 16px',
    alignItems: 'baseline',
    borderBottom: '1px solid rgba(255,255,255,0.2)',
  }
}

export interface OverlayBannerViewModel {
  status: OverlayStatus
  conflicts: ConflictPanelModel[]
  conflictNote?: string
  messages: readonly string[]
}

/**
 * Everything the banner shows, derived from a runtime. Pure — this is the
 * function the tests assert on.
 */
export function overlayBannerViewModel(runtime: OverlayRuntime): OverlayBannerViewModel {
  const report = runtime.conflicts()
  const conflicts = Object.values(report.byDocument)
    .flat()
    .map((conflict) => conflictPanelModel(conflict))
  return {
    status: runtime.status(),
    conflicts,
    conflictNote: report.note,
    messages: runtime.messages(),
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

    const children: unknown[] = [
      react.createElement(
        'strong',
        {key: 'title', style: {letterSpacing: '0.08em'}},
        'BRANCH OVERLAY',
      ),
      react.createElement('span', {key: 'headline'}, status.headline),
      ...status.lines.map((line) =>
        react.createElement(
          'span',
          {key: line.label, style: {opacity: '0.75'}},
          `${line.label}: ${line.value}`,
        ),
      ),
    ]

    if (model.conflictNote !== undefined) {
      children.push(
        react.createElement('span', {key: 'conflict-note', style: {opacity: '0.75'}}, model.conflictNote),
      )
    }

    for (const conflict of model.conflicts) {
      children.push(
        react.createElement(
          'span',
          {key: `conflict-${conflict.id}`, style: {opacity: '0.9'}},
          `${conflict.severity === 'hard' ? '⛔' : '⚠'} ${conflict.documentId} ` +
            `${conflict.pathLabel} — ${conflict.actions.map((action) => action.label).join(' / ')}`,
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
      ...children,
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
