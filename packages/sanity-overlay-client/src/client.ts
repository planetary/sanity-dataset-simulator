/**
 * The environment-aware read client (roadmap Phase 3 "local API and client";
 * PRD §9.2, §11.1, §22).
 *
 * ONE factory, two behaviours, chosen by configuration:
 *
 *   `mode: 'off'` — the overlay port is never touched. Reads go to the base
 *     dataset: delegated whole when the base can answer a query itself, and
 *     otherwise planned and evaluated over base candidates only. This is PRD
 *     §9.2's "a project can turn the overlay off entirely", and it is a
 *     structural property here rather than a flag consulted deep inside a read.
 *
 *   `mode: 'fs'` — reads resolve `.sanity-overlay/` layered over base. The
 *     overlay view is produced by `sanity-overlay-core` (§17.3 merge, §18.1/§18.2
 *     perspectives, §22.2 candidate discovery) and handed to
 *     `sanity-overlay-query`'s evaluator, which does the §22.6 candidate planning
 *     and the single pinned `groq-js` evaluation. Nothing in this file re-implements
 *     merge, perspective resolution, planning or evaluation.
 *
 * CACHING AND REVALIDATION. The resolved overlay view is cached per perspective
 * and keyed on the loader's change token. `revalidate()` drops it. That method
 * is the named substitution point for a Next.js port: `revalidateTag(OVERLAY_CACHE_TAG)`
 * goes exactly where `client.revalidate()` goes today.
 */
import {
  OverlayQueryError,
  createQueryRegistry,
  emptyOverlaySource,
  evaluateOverlayQuery,
  M_LOCAL_QUERIES,
  type OverlayQueryDefinition,
  type OverlayQueryDiagnostics,
  type OverlayQueryRegistry,
  type OverlaySource,
  type QueryCaller,
  type QueryDocument,
  type QueryPerspective,
} from 'sanity-overlay-query'
import {buildOverlaySource} from './overlaySource'
import type {
  OverlayClient,
  OverlayClientOptions,
  OverlayFetchOptions,
  OverlayStateSnapshot,
} from './types'

/**
 * The cache tag a Next.js deployment would attach to every overlay-backed fetch,
 * and pass to `revalidateTag`. Exported so the name is shared rather than
 * re-typed at the call site.
 */
export const OVERLAY_CACHE_TAG = 'sanity-overlay'

/** The empty overlay `mode: 'off'` evaluates against — frozen, and never populated. */
const NO_OVERLAY: OverlaySource = Object.freeze(emptyOverlaySource())

/** Diagnostics for a read the base source answered whole (`mode: 'off'` passthrough). */
function passthroughDiagnostics(queryId: string, durationMs: number): OverlayQueryDiagnostics {
  return {
    queryId,
    candidateCount: 0,
    baseRequestCount: 1,
    referenceDepth: 0,
    durationMs,
    conflictsTouched: [],
    unsupportedFeatures: [],
    /* The base dataset answered the registered query itself; there is no
     * candidate set to be inexact about. */
    exact: true,
    planSelectedCount: 0,
    baseFetchDocuments: 0,
    referenceExpansions: 0,
    evaluatorInvocations: 0,
    candidateBytes: 0,
    candidateIds: [],
  }
}

export function createOverlayClient(options: OverlayClientOptions): OverlayClient {
  const mode = options.mode
  const base = options.base
  const registry: OverlayQueryRegistry = createQueryRegistry(
    (options.queries ?? M_LOCAL_QUERIES) as readonly OverlayQueryDefinition[],
  )
  const defaultCaller: QueryCaller = options.caller ?? 'frontend'
  const defaultPerspective: QueryPerspective = options.perspective ?? 'drafts'
  const now = options.now ?? (() => new Date().toISOString())
  const autoRevalidate = options.autoRevalidate ?? true

  if (mode === 'fs' && options.overlay === undefined) {
    throw new Error("createOverlayClient({mode: 'fs'}) requires an `overlay` state loader")
  }
  const loader = options.overlay

  /* ---------------------------------------------------------------- *
   * Overlay view cache — only ever reached in `mode: 'fs'`.
   * ---------------------------------------------------------------- */

  const bySnapshot = new Map<QueryPerspective, OverlaySource>()
  let cachedToken: string | null | undefined
  let cachedSnapshot: OverlayStateSnapshot | null | undefined

  function dropCache(): void {
    bySnapshot.clear()
    cachedToken = undefined
    cachedSnapshot = undefined
  }

  async function currentSnapshot(): Promise<OverlayStateSnapshot | null> {
    /* istanbul ignore next -- `mode: 'fs'` guarantees a loader. */
    if (!loader) throw new Error('no overlay loader')
    if (cachedSnapshot !== undefined && !autoRevalidate) return cachedSnapshot
    if (cachedSnapshot !== undefined) {
      const token = await loader.probe()
      if (token === cachedToken) return cachedSnapshot
      dropCache()
    }
    const snapshot = await loader.load()
    cachedSnapshot = snapshot
    cachedToken = snapshot?.token ?? null
    return snapshot
  }

  async function overlaySourceFor(perspective: QueryPerspective): Promise<OverlaySource> {
    const snapshot = await currentSnapshot()
    const cached = bySnapshot.get(perspective)
    if (cached) return cached
    const source = await buildOverlaySource({snapshot, base, perspective, now: now()})
    bySnapshot.set(perspective, source)
    return source
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  async function read<T>(
    queryId: string,
    params: Record<string, unknown>,
    fetchOptions: OverlayFetchOptions,
  ): Promise<{result: T; diagnostics: OverlayQueryDiagnostics}> {
    const caller = fetchOptions.caller ?? defaultCaller
    const perspective = fetchOptions.perspective ?? defaultPerspective

    if (mode === 'off') {
      /* §22.5 discipline applies with the overlay off too: an unregistered or
       * unsupported query is refused, never approximated, in either mode. */
      const def = registry.resolve(queryId, fetchOptions.query)
      registry.assertCallerAllowed(def, caller)
      registry.assertPerspectiveRegistered(def, perspective)
      if (def.status === 'unsupported') {
        throw new OverlayQueryError(
          'UNSUPPORTED_GROQ',
          `Query ${def.id} is registered as unsupported and cannot be evaluated exactly ` +
            `(PRD §22.2, §5.5).`,
          {queryId: def.id, status: def.status},
        )
      }

      if (typeof base.query === 'function') {
        const startedAt = Date.now()
        const result = await base.query<T>(def.query, params)
        return {result, diagnostics: passthroughDiagnostics(def.id, Date.now() - startedAt)}
      }

      /* No whole-query base API: plan the registered query's base candidates and
       * evaluate over them. `NO_OVERLAY` is frozen and empty, so the candidate
       * set is exactly what base returned — no branch record can enter it. */
      return await evaluateOverlayQuery<T>({
        registry,
        queryId: def.id,
        ...(fetchOptions.query === undefined ? {} : {query: fetchOptions.query}),
        params,
        base,
        overlay: NO_OVERLAY,
        caller,
        perspective,
      })
    }

    const overlay = await overlaySourceFor(perspective)
    return await evaluateOverlayQuery<T>({
      registry,
      queryId,
      ...(fetchOptions.query === undefined ? {} : {query: fetchOptions.query}),
      params,
      base,
      overlay,
      caller,
      perspective,
    })
  }

  return {
    mode,

    async fetch<T>(
      queryId: string,
      params: Record<string, unknown> = {},
      fetchOptions: OverlayFetchOptions = {},
    ): Promise<T> {
      const {result} = await read<T>(queryId, params, fetchOptions)
      return result
    },

    async fetchWithDiagnostics<T>(
      queryId: string,
      params: Record<string, unknown> = {},
      fetchOptions: OverlayFetchOptions = {},
    ): Promise<{result: T; diagnostics: OverlayQueryDiagnostics}> {
      return await read<T>(queryId, params, fetchOptions)
    },

    revalidate(): void {
      if (mode === 'off') return
      dropCache()
    },

    async overlayRevision(): Promise<number | null> {
      if (mode === 'off') return null
      const snapshot = await currentSnapshot()
      return snapshot?.revision ?? null
    },

    watch(onChange?: () => void): () => void {
      if (mode === 'off' || loader?.watch === undefined) return () => {}
      return loader.watch(() => {
        dropCache()
        onChange?.()
      })
    },
  }
}

export type {QueryDocument}
