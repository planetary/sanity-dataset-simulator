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
 * ENDING THE SESSION IS A SEPARATE DECISION FROM `fatal`. This transport only
 * ever talks to the overlay, so a 401/403 here is our own server's refusal and
 * says nothing about the editor's Sanity credential. It is reported as an auth
 * failure — which logs the editor out — only when the overlay explicitly
 * declares the refusal came from upstream. See {@link declaresUpstreamAuthOrigin}.
 *
 * `fetch` is injected, so nothing here needs a network or a browser to test.
 */

import {
  assertNoStagingWrite,
  createStagingSafeFetch,
} from '../../../sanity-overlay-client/src/stagingHost'
import {isOverlayRefusal, type OverlayCommit} from './echo'

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
  /* ---- The §28.2 conflict-list columns, when the overlay reports them. ----
   *
   * Every one of these is OPTIONAL, and the panel says so rather than filling a
   * blank with a plausible value: §5.5 forbids silent approximation, and a
   * "current base revision" the overlay never stated is exactly that. */
  /** §13.3 `base.firstTouchedAt` revision — the ancestor the branch forked from. */
  baseRevisionAtFirstTouch?: string
  /** The base revision as it stands now. Differs from the above ⇒ base moved. */
  currentBaseRevision?: string
  /** §28.2 "Touched since checkpoint". `undefined` means the overlay did not say. */
  touchedSinceCheckpoint?: boolean
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

/**
 * One §21.7 overlay operation — a rebase, a conflict resolution, a checkpoint.
 *
 * A separate channel from {@link OverlayTransport.commit} on purpose: a commit
 * carries a list of Studio-issued mutations the echo has already applied to the
 * pane, an operation carries ONE instruction the overlay applies with core and
 * that the Studio has no local echo for. Sharing the shape would let a caller
 * pass an operation where an echo-backed commit was expected, which is the kind
 * of confusion that ends with an unacknowledged write.
 */
export interface OverlayOperationRequest {
  kind: string
  /** The command object, as `operations.ts` built it. */
  payload: unknown
  idempotencyKey: string
  actor?: unknown
  /**
   * The base as it stands NOW, for the documents in scope (PRD §16.1).
   *
   * A rebase recomputes the merge against the current base, and neither core nor
   * the overlay API may fetch it: the Studio holds the only Sanity credential in
   * the topology. Sent for the same reason `commit` sends it — an operation the
   * server had to guess an ancestor for is not the operation the editor asked
   * for.
   */
  baseDocuments?: unknown[]
}

/**
 * The overlay endpoints a Studio session can reach.
 *
 * THERE IS NO `query()`, DELIBERATELY. `POST /query` is one half of a two-party
 * protocol (`sanity-overlay-next` `queries.ts`): the overlay derives a §22.6
 * candidate plan, the CALLER fetches those base documents — it is the only
 * party holding a Sanity credential — and the overlay evaluates the query over
 * the branch plus the documents it was handed.
 *
 * A `query(request)` method used to sit here. Nothing ever called it, and it
 * could not have worked: it sent `{query, params}` with no `queryId`, so the
 * endpoint could only recognise the text by checksum against the §22.5 registry
 * and answered a Studio-composed query with `400 UNSUPPORTED_QUERY`; and it
 * sent no `baseDocuments`, so a query that DID match was evaluated against an
 * empty base and answered `[]` — a silent approximation, which §5.5 forbids and
 * which no error would have surfaced. Studio reads therefore evaluate in the
 * browser, in `client/reads.ts`, where the credential is.
 *
 * If a server-side read is ever wanted, it is two calls (`/query/plan`, then a
 * base fetch through the wrapped client, then `/query` carrying the result) —
 * not a method on this interface pretending to be one.
 */
export interface OverlayTransport {
  commit(commit: OverlayCommit, context: OverlayCommitContext): Promise<OverlayTransportResult>
  operation(request: OverlayOperationRequest): Promise<OverlayTransportResult>
  resolve(request: OverlayResolveRequest): Promise<OverlayTransportResult>
  state(): Promise<OverlayTransportResult>
  /** The URL every call in this transport is anchored to. */
  apiUrl: string
}

const AUTH_STATUSES = new Set([401, 403])

/**
 * Origins the overlay may declare for a 401/403 it is REPORTING rather than
 * ISSUING. Structured values only — see {@link declaresUpstreamAuthOrigin}.
 */
const UPSTREAM_ORIGINS: ReadonlySet<string> = new Set(['sanity', 'content-lake', 'upstream'])

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Did the overlay say this 401/403 came from SANITY, not from itself?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY THE DEFAULT IS "NO".
 *
 * `onAuthFailure` drives `echo.noteAuthFailure`, which moves the session to
 * `unauthenticated` — the "your Sanity credential is gone" state that stops
 * further writes and tells the editor to log in again.
 *
 * This transport never talks to Sanity. `assertNoStagingWrite` refuses to
 * construct one whose `apiUrl` points at the Content Lake, so *every* 401/403
 * `call()` observes was issued by our own overlay server. Mapping that to a
 * Sanity credential failure logged an editor out because our server said no —
 * which is a different thing entirely, and the more expensive mistake, because
 * it discards work over a refusal that was never about their token.
 *
 * So the default is inverted: an overlay-API 401/403 is the overlay's own "no"
 * unless the overlay DECLARES otherwise. It is the only party that knows whether
 * it proxied the call, so it is the only party that can say.
 *
 * The failure stays `fatal` either way — it provably cannot land, whoever
 * refused — so nothing is silently retried and no write falls back to Sanity.
 *
 * STRUCTURED FIELDS ONLY, NEVER PROSE, matching `echo.ts` `authStatusOf`: an
 * error whose *message* happens to mention Sanity is still the overlay's own.
 * And an `OVERLAY_*` code outranks any declaration, because a body carrying one
 * was written by one of our own guards.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function declaresUpstreamAuthOrigin(body: Rec | undefined): boolean {
  if (body === undefined) return false
  /* Our own guard's refusal, wherever in the body it sits. Never an auth signal. */
  if (isOverlayRefusal(body)) return false

  const carriers: unknown[] = [body, body.error, body.details]
  for (const carrier of carriers) {
    if (!isRec(carrier)) continue
    const origin = carrier.origin
    if (typeof origin === 'string' && UPSTREAM_ORIGINS.has(origin.toLowerCase())) return true
  }
  return false
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
      /* Fatal either way. Session-ending only when the overlay declared that the
       * refusal came from Sanity rather than from itself. */
      if (declaresUpstreamAuthOrigin(body)) options.onAuthFailure?.({status, source, message})
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
    /* Same queue as `commit`, so an operation cannot interleave with the edit
     * whose revision chain it is about to rewrite. Same `'write'` source, so a
     * 401 on a rebase ends the session exactly as a 401 on an edit does. */
    operation: (request) =>
      enqueue(() =>
        call(
          '/commit',
          {
            method: 'POST',
            body: {
              idempotencyKey: request.idempotencyKey,
              kind: request.kind,
              payload: request.payload,
              ...(request.actor === undefined ? {} : {actor: request.actor}),
              ...(request.baseDocuments === undefined
                ? {}
                : {baseDocuments: request.baseDocuments}),
            },
          },
          'write',
        ),
      ),
    resolve: (request) => call('/resolve', {method: 'POST', body: request}, 'read'),
    state: () => call('/state', {method: 'GET'}, 'read'),
  }
}
