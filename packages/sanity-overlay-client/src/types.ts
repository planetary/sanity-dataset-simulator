/**
 * The client's ports and configuration model — PRD §9.2 (`mode`), §11.1
 * (`overlay.mode`), §22.4 (registry), roadmap Phase 3 "local API and client".
 *
 * Types only. Everything the client needs from the outside world arrives through
 * one of the two ports below, which is what lets `mode: 'off'` be provably inert:
 * the overlay port is a separate object from the base port, so "did the client
 * read the overlay" is an observable fact rather than a claim.
 */
import type {OverlayRecordMap} from 'sanity-overlay-core'
import type {
  OverlayQueryDefinition,
  OverlayQueryDiagnostics,
  QueryBaseSource,
  QueryCaller,
  QueryPerspective,
} from 'sanity-overlay-query'

/**
 * PRD §11.1 `overlay.mode`, restricted to what this slice implements.
 *
 * `off` — the overlay is not consulted at all; reads go straight to base
 *         (PRD §9.2: "a project can turn the overlay off entirely").
 * `fs`  — reads resolve against `.sanity-overlay/` layered over base.
 *
 * `memory` and `blob` from §11.1 are deliberately absent rather than accepted
 * and ignored: an accepted-but-unimplemented mode is a silent downgrade.
 */
export type OverlayClientMode = 'off' | 'fs'

export const OVERLAY_CLIENT_MODES = ['off', 'fs'] as const

/**
 * The base dataset port.
 *
 * {@link QueryBaseSource.fetchCandidates} is the structured candidate port the
 * query layer plans against (PRD §22.6 step 5). {@link OverlayClientBaseSource.query}
 * is optional and exists for one reason: in `mode: 'off'` a hosted client can
 * answer the whole query itself, and delegating to it is a genuine passthrough
 * rather than a local re-implementation of the dataset.
 */
export interface OverlayClientBaseSource extends QueryBaseSource {
  query?<T>(queryText: string, params: Record<string, unknown>): Promise<T>
}

/** A point-in-time view of the overlay on disk. */
export interface OverlayStateSnapshot {
  readonly overlayId: string
  /** PRD §13.1 `revision`. */
  readonly revision: number
  /** The §13.3 records, keyed by logical document ID. */
  readonly records: OverlayRecordMap
  /**
   * Opaque change token. Two snapshots with the same token describe the same
   * overlay state; a different token means "reload". It is what the client's
   * cache is keyed on, and the substitution point for a Next.js cache tag.
   */
  readonly token: string
}

/**
 * The overlay port. Separate from the base port on purpose — see the module
 * header. `mode: 'off'` never calls any of these.
 */
export interface OverlayStateLoader {
  /** Full load. `null` means "no overlay exists at this location". */
  load(): Promise<OverlayStateSnapshot | null> | OverlayStateSnapshot | null
  /**
   * Cheap change probe returning the same token {@link OverlayStateLoader.load}
   * would produce, without materialising the records.
   */
  probe(): Promise<string | null> | string | null
  /** Optional push-based change notification. Returns an unsubscribe function. */
  watch?(onChange: () => void): () => void
}

export interface OverlayClientOptions {
  readonly mode: OverlayClientMode
  readonly base: OverlayClientBaseSource
  /** Required for `mode: 'fs'`; ignored — never called — for `mode: 'off'`. */
  readonly overlay?: OverlayStateLoader
  /** Defaults to the `[M-LOCAL]` registry (`M_LOCAL_QUERIES`). */
  readonly queries?: readonly OverlayQueryDefinition[]
  readonly caller?: QueryCaller
  readonly perspective?: QueryPerspective
  /** Injected clock for the §17.3 merge that resolves the overlay view. */
  readonly now?: () => string
  /**
   * Probe the overlay for changes before every read (default `true`).
   *
   * `false` pins the client to the snapshot it first loaded until
   * {@link OverlayClient.revalidate} is called — the explicit-invalidation model
   * a Next.js `revalidateTag` deployment uses.
   */
  readonly autoRevalidate?: boolean
}

/** Per-call overrides. */
export interface OverlayFetchOptions {
  readonly perspective?: QueryPerspective
  readonly caller?: QueryCaller
  /**
   * The caller's own copy of the query text, verified against the registered
   * checksum (PRD §22.5, §22.9 `QUERY_CHANGED`).
   */
  readonly query?: string
}

export interface OverlayClient {
  readonly mode: OverlayClientMode
  fetch<T = unknown>(
    queryId: string,
    params?: Record<string, unknown>,
    options?: OverlayFetchOptions,
  ): Promise<T>
  fetchWithDiagnostics<T = unknown>(
    queryId: string,
    params?: Record<string, unknown>,
    options?: OverlayFetchOptions,
  ): Promise<{result: T; diagnostics: OverlayQueryDiagnostics}>
  /**
   * Drop the cached overlay view so the next read re-loads from disk.
   *
   * This is the named revalidation trigger the roadmap asks for: a Next.js port
   * calls `revalidateTag(OVERLAY_CACHE_TAG)` from the same place instead of, or
   * as well as, calling this.
   */
  revalidate(): void
  /** The overlay revision currently being read, or `null` in `mode: 'off'`. */
  overlayRevision(): Promise<number | null>
  /** Subscribe to overlay changes; revalidates before invoking `onChange`. */
  watch(onChange?: () => void): () => void
}
