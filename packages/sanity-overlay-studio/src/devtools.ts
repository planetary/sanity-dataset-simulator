/**
 * `window.__SANITY_OVERLAY__` — the diagnostic surface, reachable from a
 * browser console.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL.
 *
 * The read ledger is described in `runtime.ts` as *"the diagnostic surface
 * §22.5 requires: a read recorded as `passthrough` was answered by the base
 * dataset and may not reflect branch edits, and the only way an editor can know
 * that is if something keeps the list"*. It was kept, and nothing could reach
 * it. On 2026-08-06 a live session went looking for why a list pane rendered
 * base content and found only the SPIKE's `__SPIKE_ES__` on `window`; the
 * question ("is the branch loaded, and was this query answered from it?") cost
 * a browser session instead of one console line.
 *
 * Every previous diagnosis of that class was made by reading the spike's
 * `__SPIKE_ECHO__.reads`. This is the product's equivalent, and it is a
 * READ-ONLY VIEW: nothing here mutates the runtime except `refresh()`, which
 * does exactly what the banner's own 5 s timer does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE TARGET IS INJECTED.
 *
 * Same reason React is injected into the banner: this module is imported from
 * Node (vitest, tooling) as well as from the Studio bundle, so it must not
 * *reach for* `window`. `config.ts` passes `globalThis`; a test passes a plain
 * object. A missing target is not an error — a server render simply has none.
 */

import type {StudioReadRecord} from './client/reads'
import type {OverlayAuthFailure, OverlaySessionState} from './client/echo'
import type {OverlayBranchView, OverlayRuntime} from './runtime'
import type {OverlayStatus} from './status'

/** The property name. Exported so nothing has to be typed from memory. */
export const OVERLAY_DEVTOOLS_GLOBAL = '__SANITY_OVERLAY__'

export interface OverlayDevtoolsSession {
  state: OverlaySessionState
  failures: readonly OverlayAuthFailure[]
}

export interface OverlayDevtools {
  /** One line, printed by the console when the object is expanded. */
  readonly help: string
  /** The overlay API URL, mode and overlay id this Studio is configured for. */
  config(): {mode: string; apiUrl: string; overlayId: string | null; strictQueries: boolean}
  /** PRD §21.3 — the state the banner renders. */
  status(): OverlayStatus
  /**
   * Every GROQ read this session routed, newest last (PRD §22.8).
   *
   * `outcome: 'passthrough'` plus its `reason` is the diagnosis for "this pane
   * is showing base content": the read was answered by the base dataset and
   * cannot reflect branch edits.
   */
  reads(): readonly StudioReadRecord[]
  /** What the read path believes the branch holds. Empty ⇒ `/state` never landed. */
  branch(): OverlayBranchView
  /** The §18.9 session state and every auth failure observed. */
  session(): OverlayDevtoolsSession
  /** Recent log lines, newest last. */
  messages(): readonly string[]
  /** Poll `GET /state` now instead of waiting for the banner's timer. */
  refresh(): Promise<void>
  /** The runtime itself, for anything this surface does not name. */
  readonly runtime: OverlayRuntime
}

const HELP =
  'sanity-overlay-studio devtools — reads() every GROQ read with its outcome and passthrough ' +
  'reason; branch() the addresses the branch holds and suppresses (empty means /state never ' +
  'landed); status() the §21.3 banner state; session() the auth state; messages() the log; ' +
  'refresh() poll the overlay API now.'

/** Build the view. Pure — it holds no state of its own. */
export function createOverlayDevtools(runtime: OverlayRuntime): OverlayDevtools {
  return {
    help: HELP,
    config: () => ({
      mode: runtime.resolved.mode,
      apiUrl: runtime.resolved.apiUrl,
      overlayId: runtime.resolved.overlayId,
      strictQueries: runtime.resolved.strictQueries,
    }),
    status: () => runtime.status(),
    reads: () => runtime.reads(),
    branch: () => runtime.branch(),
    session: () => ({
      state: runtime.echo.sessionState(),
      failures: runtime.echo.authFailures(),
    }),
    messages: () => runtime.messages(),
    refresh: () => runtime.refresh(),
    runtime,
  }
}

/**
 * Install the view onto `target` (normally `globalThis`).
 *
 * Non-enumerable, so it cannot end up in anything that walks the global object,
 * and `configurable` so a second workspace — or a hot reload — replaces it
 * rather than throwing.
 */
export function installOverlayDevtools(runtime: OverlayRuntime, target: unknown): void {
  if (typeof target !== 'object' || target === null) return
  try {
    Object.defineProperty(target, OVERLAY_DEVTOOLS_GLOBAL, {
      value: createOverlayDevtools(runtime),
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* A frozen or otherwise hostile global is not a reason to fail booting the
     * Studio: the instrument is a diagnostic, never a dependency. */
  }
}
