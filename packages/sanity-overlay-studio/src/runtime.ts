/**
 * The overlay runtime — one per workspace.
 *
 * Holds the pieces that must be shared between the client factory (which
 * intercepts writes) and the status banner (which reports what happened to
 * them): the echo protocol, the transport, the write ledger, and the derived
 * §21.3 status.
 *
 * Pure apart from an injected `fetch`: no React, no DOM, no globals. The banner
 * component subscribes to {@link OverlayRuntime.subscribe} and renders
 * {@link OverlayRuntime.status}; it derives nothing itself.
 */

import {createOverlayEcho, type OverlayEcho} from './client/echo'
import {wrapWithOverlay, type OverlayWriteRecord} from './client/facade'
import {createOverlayTransport, type OverlayTransport} from './client/transport'
import {readConflictReport, type OverlayConflictReport} from './conflicts'
import type {ResolvedOverlayOptions} from './options'
import {deriveOverlayStatus, type OverlayStatus} from './status'

type Rec = Record<string, unknown>

export interface OverlayRuntimeOptions {
  resolved: ResolvedOverlayOptions
  fetch?: typeof fetch
  /**
   * Injected `createClient`. The Studio's own `@sanity/client` is the default in
   * the shipped entry point; tests pass a stub so nothing touches the network.
   */
  createClient: (options: Rec) => object
  now?: () => number
  onLog?: (message: string) => void
}

export interface OverlayRuntime {
  readonly resolved: ResolvedOverlayOptions
  readonly echo: OverlayEcho
  readonly transport: OverlayTransport
  /** The `unstable_clientFactory` this runtime installs. */
  clientFactory(options: Rec): object
  status(): OverlayStatus
  conflicts(): OverlayConflictReport
  /** Recent messages, newest last, for the banner's detail view. */
  messages(): readonly string[]
  subscribe(listener: () => void): () => void
  /** Poll the overlay API once, updating connection, revision and conflicts. */
  refresh(): Promise<void>
}

const MAX_MESSAGES = 50

export function createOverlayRuntime(options: OverlayRuntimeOptions): OverlayRuntime {
  const {resolved} = options
  const listeners = new Set<() => void>()
  const messages: string[] = []

  let connection: 'ok' | 'unreachable' = 'ok'
  let revision: number | undefined
  let conflictReport: OverlayConflictReport = readConflictReport(undefined)
  let pendingWrites = 0
  let degradedWrites = 0
  let uncheckpointedEdits = 0
  let identityMismatch = false

  function notify(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        /* A subscriber that throws must not stop the others being told. */
      }
    }
  }

  function log(message: string): void {
    messages.push(message)
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES)
    options.onLog?.(message)
    notify()
  }

  for (const warning of resolved.warnings) log(warning)

  const echo = createOverlayEcho({onError: log})

  const transport = createOverlayTransport({
    apiUrl: resolved.apiUrl,
    fetch: options.fetch,
    onError: (message) => {
      connection = 'unreachable'
      log(message)
    },
    onAuthFailure: (failure) => echo.noteAuthFailure(failure),
  })

  function onWrite(record: OverlayWriteRecord): void {
    if (record.committed === 'ok') {
      connection = 'ok'
      /* §29.6: every accepted write is an edit the checkpoint has not seen. */
      uncheckpointedEdits += 1
    }
    if (record.committed === 'degraded') degradedWrites += 1
    if (pendingWrites > 0) pendingWrites -= 1
    notify()
  }

  function clientFactory(clientOptions: Rec): object {
    const withHost =
      resolved.apiHost === null ? clientOptions : {...clientOptions, apiHost: resolved.apiHost}
    const real = options.createClient(withHost)
    if (!resolved.enabled) return real
    return wrapWithOverlay(real, {
      echo,
      transport,
      onError: log,
      onWrite,
      now: options.now,
    })
  }

  async function refresh(): Promise<void> {
    const result = await transport.state()
    if (result.outcome === 'ok') {
      connection = 'ok'
      revision = result.revision
      if (
        resolved.overlayId !== null &&
        result.overlayId !== undefined &&
        result.overlayId !== resolved.overlayId
      ) {
        /* §21.3 "Overlay identity mismatch: Fatal screen. No reads or writes." */
        identityMismatch = true
        log(
          `[sanity-overlay-studio] the overlay API reports overlay "${result.overlayId}" but ` +
            `this Studio is configured for "${resolved.overlayId}". Editing is stopped.`,
        )
      }
      conflictReport = readConflictReport(result.body)
    } else if (result.outcome === 'degraded') {
      connection = 'unreachable'
    }
    notify()
  }

  return {
    resolved,
    echo,
    transport,
    clientFactory,
    status: () =>
      deriveOverlayStatus({
        enabled: resolved.enabled,
        expectedEnabled: resolved.enabled,
        mode: resolved.mode,
        apiUrl: resolved.apiUrl,
        overlayId: resolved.overlayId,
        connection,
        session: echo.sessionState(),
        revision,
        pendingWrites,
        degradedWrites,
        uncheckpointedEdits,
        conflicts: {hard: conflictReport.summary.hard, soft: conflictReport.summary.soft},
        identityMismatch,
      }),
    conflicts: () => conflictReport,
    messages: () => messages.slice(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
  }
}

/* ------------------------------------------------------------------ *
 * The workspace registry
 * ------------------------------------------------------------------ *
 *
 * The client factory and the banner are wired into the Studio through two
 * unrelated seams — `unstable_clientFactory` on the workspace and a layout
 * component inside a plugin — and neither can pass a value to the other. The
 * registry is the seam between them, keyed by workspace name so a
 * multi-workspace config does not cross wires.
 */

const registry = new Map<string, OverlayRuntime>()

export function registerOverlayRuntime(workspace: string, runtime: OverlayRuntime): void {
  registry.set(workspace, runtime)
}

export function getOverlayRuntime(workspace: string): OverlayRuntime | undefined {
  return registry.get(workspace) ?? registry.get('*')
}

export function clearOverlayRuntimes(): void {
  registry.clear()
}
