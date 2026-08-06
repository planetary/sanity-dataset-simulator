/**
 * The overlay API transport (PRD §25, §33).
 *
 * Three outcomes, no fourth, because §11.3's last line is absolute — *"Never
 * fall back from failed overlay writes to native Sanity writes."*
 *
 *   `ok`       the overlay accepted and persisted it            → editor: saved
 *   `degraded` transient (5xx, offline, malformed answer)       → editor: saved, loudly
 *   `fatal`    401/403; it provably cannot ever land            → editor: NOT saved
 *
 * `degraded` is deliberately not a failure: the echo has already updated the
 * pane, an outage is transient, and shouting is more useful to the editor than
 * discarding their keystrokes. A 401 is not transient — that is the distinction.
 *
 * `fetch` is injected, so nothing here needs a network or a browser to test.
 */

import {
  assertNoStagingWrite,
  createStagingSafeFetch,
} from '../../../sanity-overlay-client/src/stagingHost'
import type {OverlayCommit} from './echo'

type Rec = Record<string, unknown>

export type OverlayTransportOutcome = 'ok' | 'degraded' | 'fatal'

/** One document as the overlay materializes it. */
export interface OverlayHydrationDocument {
  logicalId: string
  schemaType?: string
  runtimeRevision?: string
  updatedAt?: string
  draftTombstone?: boolean
  publishedTombstone?: boolean
  draft?: Rec | null
  published?: Rec | null
  /** PRD §13.11 conflicts, when the overlay reports them per document. */
  conflicts?: unknown[]
}

export interface OverlayTransportResult {
  outcome: OverlayTransportOutcome
  status?: number
  /** Parsed response body, whatever shape the endpoint answers with. */
  body?: Rec
  message?: string
  revision?: number
  overlayId?: string
  transactionId?: string
  unsupported?: string[]
  documents?: OverlayHydrationDocument[]
}

export interface OverlayTransportOptions {
  apiUrl: string
  fetch?: typeof fetch
  onError?: (message: string) => void
  onAuthFailure?: (failure: {status: number; source: 'write' | 'read'; message: string}) => void
  /** Extra headers, e.g. a preview session token. */
  headers?: Record<string, string>
}

export interface OverlayCommitContext {
  idempotencyKey: string
  baseDocuments?: unknown[]
  actor?: unknown
}

export interface OverlayResolveRequest {
  mode: 'perspective' | 'version'
  ids: string[]
  perspective?: 'published' | 'drafts'
  types?: string[]
}

export interface OverlayQueryRequest {
  query: string
  params?: Rec
  perspective?: string
}

export interface OverlayTransport {
  commit(commit: OverlayCommit, context: OverlayCommitContext): Promise<OverlayTransportResult>
  resolve(request: OverlayResolveRequest): Promise<OverlayTransportResult>
  query(request: OverlayQueryRequest): Promise<OverlayTransportResult>
  state(): Promise<OverlayTransportResult>
  /** The URL every call in this transport is anchored to. */
  apiUrl: string
}

const AUTH_STATUSES = new Set([401, 403])

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(body: Rec | undefined, fallback: string): string {
  const error = body?.error
  if (isRec(error) && typeof error.message === 'string') return error.message
  if (typeof body?.message === 'string') return body.message
  return fallback
}

export function createOverlayTransport(options: OverlayTransportOptions): OverlayTransport {
  const base = options.apiUrl.replace(/\/+$/, '')

  /**
   * REFUSE AT CONSTRUCTION, NOT AT COMMIT.
   *
   * `call()` below converts any throwing `fetch` into `degraded`, which the
   * editor renders as "saved, loudly" — the right answer for a transient outage
   * and precisely the wrong one for a write aimed at the shared dataset. So a
   * misconfigured `apiUrl` has to fail before a transport exists at all. The
   * commit path POSTs, so this is the one place where an `OVERLAY_API_URL`
   * pointing at Sanity would otherwise turn every branch edit into a staging
   * write (owner ruling, 2026-08-05).
   */
  assertNoStagingWrite(
    {method: 'POST', url: `${base}/commit`},
    'the overlay API URL must point at the overlay, never at Sanity',
  )

  const noteError = options.onError ?? ((): void => {})
  const rawFetch =
    options.fetch ??
    (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  /* Defence in depth: even a relative or later-rewritten target is re-checked. */
  const doFetch =
    rawFetch === undefined ? undefined : createStagingSafeFetch(rawFetch, 'overlay API transport')

  /**
   * Commits are serialized.
   *
   * The echo's revision chain is a sequence: transaction N+1 declares
   * `previousRev` = transaction N's `resultRev`. Letting two commits race means
   * the overlay can apply them in the other order, and the pane's chain and the
   * stored one diverge with no signal until a much later read.
   */
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    /* `.then` on both sides so one rejection cannot strand every later commit. */
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function call(
    path: string,
    init: {method: 'GET' | 'POST'; body?: unknown},
    source: 'write' | 'read',
  ): Promise<OverlayTransportResult> {
    const url = `${base}${path}`
    if (doFetch === undefined) {
      const message = `[sanity-overlay-studio] no fetch implementation available for ${url}`
      noteError(message)
      return {outcome: 'degraded', message}
    }

    let status = 0
    let text = ''
    try {
      const response = (await doFetch(url, {
        method: init.method,
        headers: {'content-type': 'application/json', ...(options.headers ?? {})},
        ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}),
      })) as unknown as {status: number; text: () => Promise<string>}
      status = response.status
      text = await response.text()
    } catch (error) {
      const message =
        `[sanity-overlay-studio] the overlay API at ${url} is unreachable: ` +
        `${error instanceof Error ? error.message : String(error)}`
      noteError(message)
      return {outcome: 'degraded', message}
    }

    let body: Rec | undefined
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      body = isRec(parsed) ? parsed : {result: parsed}
    } catch {
      const message =
        `[sanity-overlay-studio] the overlay API at ${url} answered ${status} with a body that ` +
        `is not JSON (${text.slice(0, 120)})`
      noteError(message)
      return {outcome: 'degraded', status, message}
    }

    if (AUTH_STATUSES.has(status)) {
      const message = `[sanity-overlay-studio] ${url} answered ${status}: ${messageOf(body, 'unauthorized')}`
      noteError(message)
      options.onAuthFailure?.({status, source, message})
      return {outcome: 'fatal', status, body, message}
    }

    if (status < 200 || status >= 300 || body.ok === false) {
      const message = `[sanity-overlay-studio] ${url} answered ${status}: ${messageOf(body, 'no detail')}`
      noteError(message)
      return {outcome: 'degraded', status, body, message}
    }

    return {
      outcome: 'ok',
      status,
      body,
      revision: typeof body.revision === 'number' ? body.revision : undefined,
      overlayId: typeof body.overlayId === 'string' ? body.overlayId : undefined,
      transactionId: typeof body.transactionId === 'string' ? body.transactionId : undefined,
      unsupported: Array.isArray(body.unsupported)
        ? body.unsupported.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      documents: Array.isArray(body.documents)
        ? (body.documents as OverlayHydrationDocument[])
        : undefined,
    }
  }

  return {
    apiUrl: base,
    commit: (commit, context) =>
      enqueue(() =>
        call(
          '/commit',
          {
            method: 'POST',
            body: {
              idempotencyKey: context.idempotencyKey,
              kind: commit.kind,
              payload: commit.payload,
              ...(context.baseDocuments === undefined
                ? {}
                : {baseDocuments: context.baseDocuments}),
              ...(context.actor === undefined ? {} : {actor: context.actor}),
            },
          },
          'write',
        ),
      ),
    resolve: (request) => call('/resolve', {method: 'POST', body: request}, 'read'),
    query: (request) => call('/query', {method: 'POST', body: request}, 'read'),
    state: () => call('/state', {method: 'GET'}, 'read'),
  }
}
