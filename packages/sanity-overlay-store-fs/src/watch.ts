/**
 * The direct-edit watcher — PRD §14.3 "Watch intent, snapshot, and manifest
 * files for direct agent edits", §14.4 steps 2-8 and 10, §37 Phase 2.
 *
 * ## Why polling
 *
 * A watcher is a *trigger*, not a behaviour: everything it does is
 * {@link FsOverlayStore.revalidate}. `fs.watch` reports platform-specific,
 * coalesced, sometimes duplicated events and drops them entirely on network
 * filesystems and inside some containers — none of which changes what the store
 * must do, and all of which would make the trigger untestable without testing
 * Node's event loop. A poll is uniform on every platform, and the interval is the
 * caller's to choose.
 *
 * ## Durability before notification
 *
 * `onChange` is invoked only after `revalidate()` has resolved, and `revalidate`
 * awaits every checksum repair it writes. A subscriber therefore never sees a
 * change announced before the corresponding bytes are on disk — the failure mode
 * this repository has already hit once, when the overlay server acknowledged an
 * HTTP request before its write completed.
 *
 * Passes never overlap: a second {@link OverlayWatchHandle.poll} while one is in
 * flight joins the running pass instead of starting a racing one, so two
 * revalidations can never interleave their repair writes.
 */
import type {OverlayRevalidationReport} from 'sanity-overlay-core'
import type {FsOverlayStore} from './fsStore'

export interface OverlayWatchOptions {
  /**
   * Called after a pass that observed something: a changed file, a repaired
   * checksum, an invalid file, or a rewritten manifest. Never called for a pass
   * that found the tree exactly as the store left it, and never after
   * {@link OverlayWatchHandle.close}.
   */
  onChange?(report: OverlayRevalidationReport): void
  /** Called when a background pass throws. Explicit `poll()` rejects instead. */
  onError?(error: unknown): void
  /** Poll period in milliseconds. `0` disables the timer, leaving `poll()` manual. */
  intervalMs?: number
  /** Forwarded to `revalidate` (PRD §14.3 recompute rule); on by default. */
  repairChecksums?: boolean
}

export interface OverlayWatchHandle {
  /**
   * Run one revalidation pass now.
   *
   * Resolves only once every write the pass performed is durable. Concurrent
   * callers share one pass and therefore one report.
   */
  poll(): Promise<OverlayRevalidationReport>
  close(): void
  readonly closed: boolean
}

/** True when a pass observed anything worth telling a subscriber about. */
export function revalidationIsNotable(report: OverlayRevalidationReport): boolean {
  return (
    report.manifestChanged ||
    report.changed.length > 0 ||
    report.repairedChecksums.length > 0 ||
    report.invalid.length > 0
  )
}

/**
 * Watch an overlay's canonical files for direct edits (PRD §14.4).
 *
 * The store owns the recovery semantics — refuse malformed JSON, keep serving the
 * last valid state, write a `.broken` diagnostic copy, repair a stale checksum on
 * a file that still validates. This function only decides *when* to ask.
 */
export function watchOverlay(
  store: FsOverlayStore,
  overlayId: string,
  options: OverlayWatchOptions = {},
): OverlayWatchHandle {
  const intervalMs = options.intervalMs ?? 250
  let inFlight: Promise<OverlayRevalidationReport> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const runOnce = async (): Promise<OverlayRevalidationReport> => {
    const report = await store.revalidate(
      overlayId,
      options.repairChecksums === undefined ? {} : {repairChecksums: options.repairChecksums},
    )
    /* Everything `revalidate` wrote is already durable here. */
    if (!closed && options.onChange !== undefined && revalidationIsNotable(report)) {
      options.onChange(report)
    }
    return report
  }

  const poll = (): Promise<OverlayRevalidationReport> => {
    if (inFlight !== null) return inFlight
    const pass = runOnce()
    const guarded = pass.finally(() => {
      if (inFlight === guarded) inFlight = null
    })
    inFlight = guarded
    return guarded
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void poll().catch((error: unknown) => options.onError?.(error))
    }, intervalMs)
    /* Never hold a process (or a test runner) open. */
    timer.unref?.()
  }

  return {
    poll,
    close(): void {
      closed = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    get closed(): boolean {
      return closed
    },
  }
}
