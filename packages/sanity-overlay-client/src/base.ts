/**
 * Base dataset adapters — the "staging" side of every read.
 *
 * Two are supplied. Neither writes: this whole module is `GET`-only, which is
 * how "staging is untouched" stops being a promise and becomes a property of the
 * code (PRD §9.1, §26 write guard).
 *
 *   - {@link createDocumentBaseSource} — an in-memory dataset, for fixtures,
 *     tests and an offline example site.
 *   - {@link createHttpBaseSource} — the hosted Content Lake query API over
 *     `fetch`. It issues only GET requests to `/query/<dataset>`.
 */
import {createMemoryBaseSource, type QueryDocument} from 'sanity-overlay-query'
import {createStagingSafeFetch} from './stagingHost'
import type {OverlayClientBaseSource} from './types'

/**
 * In-memory base dataset.
 *
 * Deliberately does NOT implement the optional `query` passthrough: it holds
 * documents, not a GROQ engine, and claiming otherwise would make `mode: 'off'`
 * silently evaluate through the overlay package's evaluator while pretending the
 * base answered.
 */
export function createDocumentBaseSource(
  documents: readonly QueryDocument[],
): OverlayClientBaseSource {
  return createMemoryBaseSource(documents)
}

export interface HttpBaseSourceOptions {
  readonly projectId: string
  readonly dataset: string
  /** Content Lake API version, e.g. `2025-02-19`. */
  readonly apiVersion: string
  /** Read token for a private dataset. Omit for a public one. */
  readonly token?: string
  /** `published` or `drafts`; forwarded as the `perspective` search parameter. */
  readonly perspective?: 'published' | 'drafts' | 'raw'
  /** Override the API host (a proxy, or a test double). */
  readonly baseUrl?: string
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** The three structured request shapes, as the GROQ the hosted API understands. */
const REQUEST_QUERIES = {
  ids: '*[_id in $ids]',
  types: '*[_type in $types]',
} as const

/**
 * Hosted base dataset over the Content Lake query API.
 *
 * Requests are GET, and every value travels as a `$`-parameter rather than being
 * interpolated into the query text — PRD §22.5 forbids assembling query text from
 * call input, and a parameterised GET cannot be turned into a mutation by a
 * hostile slug.
 */
export function createHttpBaseSource(options: HttpBaseSourceOptions): OverlayClientBaseSource {
  const rawFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof rawFetch !== 'function') {
    throw new Error('createHttpBaseSource needs a `fetch` implementation')
  }
  /* This module is GET-only by design; the guard makes that structural rather
   * than conventional, so an edit that introduces a non-GET here fails at the
   * call site instead of writing to the shared dataset (owner ruling,
   * 2026-08-05 — see `stagingHost.ts`). */
  const doFetch = createStagingSafeFetch(rawFetch, 'the base dataset source is read-only')
  const host = options.baseUrl ?? `https://${options.projectId}.api.sanity.io`

  async function run<T>(query: string, params: Record<string, unknown>): Promise<T> {
    const url = new URL(`/v${options.apiVersion}/data/query/${options.dataset}`, host)
    url.searchParams.set('query', query)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(`$${key}`, JSON.stringify(value))
    }
    if (options.perspective !== undefined) {
      url.searchParams.set('perspective', options.perspective)
    }

    const response = await doFetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.token === undefined ? {} : {authorization: `Bearer ${options.token}`}),
      },
    })
    if (!response.ok) {
      throw new Error(
        `base dataset query failed: ${response.status} ${response.statusText} (${url.pathname})`,
      )
    }
    const body = (await response.json()) as {result?: unknown}
    return body.result as T
  }

  return {
    async fetchCandidates(request) {
      switch (request.kind) {
        case 'ids':
          return request.ids.length === 0
            ? []
            : await run<QueryDocument[]>(REQUEST_QUERIES.ids, {ids: request.ids})
        case 'types':
          return await run<QueryDocument[]>(REQUEST_QUERIES.types, {types: request.types})
        case 'field-equality': {
          /* The path is registry-controlled (PRD §22.4 `candidatePlan`), never
           * caller-controlled, so building the traversal from it does not
           * reintroduce dynamic query construction from user input. */
          const path = request.path.map(assertPlainFieldName).join('.')
          return await run<QueryDocument[]>(`*[_type in $types && ${path} == $value]`, {
            types: request.types,
            value: request.value,
          })
        }
        default: {
          const exhaustive: never = request
          throw new Error(`unhandled base request ${JSON.stringify(exhaustive)}`)
        }
      }
    },
    query: run,
  }
}

/** A registry path segment must be a bare GROQ attribute name. */
function assertPlainFieldName(segment: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
    throw new Error(
      `candidate plan path segment ${JSON.stringify(segment)} is not a plain field name`,
    )
  }
  return segment
}
