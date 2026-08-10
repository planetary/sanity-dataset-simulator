/**
 * The overlay API transport (PRD §25, §33, §5.5).
 *
 * FOUR OUTCOMES, and the axis that separates them is *what the editor should
 * believe about their keystrokes*, not what the HTTP status happens to be:
 *
 *   `ok`       the overlay accepted and persisted it            → saved
 *   `degraded` transient (5xx, offline, timeout, bad answer)    → saved, loudly;
 *                                                                 retrying can work
 *   `stale`    409; this session's view of the branch is behind → NOT saved, and
 *                                                                 resending will not
 *                                                                 help — reload
 *   `fatal`    401/403/413/422; it provably cannot ever land    → NOT saved
 *
 * `degraded` is deliberately not a failure: the echo has already updated the
 * pane, an outage is transient, and shouting is more useful to the editor than
 * discarding their keystrokes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `stale` EXISTS, ADDED 2026-08-09.
 *
 * It used to be `degraded`, along with every other non-2xx that was not 401/403.
 * `degraded` means "saved, loudly" — so a 409, which is a write that did NOT
 * land and will not land until the tab reloads, was reported to the banner as a
 * saved edit. Observed in a browser the same day: after a second process touched
 * the overlay, every edit in the open Studio stopped committing with no error,
 * no toast and a frozen revision, and only restarting the API cleared it.
 *
 * The server now distinguishes the two facts (`errors.ts`: 409 says "your view
 * is stale", 400 says "your payload was wrong"), and this is the half that acts
 * on it. `stale` is NOT retryable and NOT an auth failure: the credential is
 * fine, the branch moved.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A 2xx IS NOT AUTOMATICALLY A SAVE.
 *
 * The API answers `200 {ok: true, committed: false}` in four situations, and
 * exactly one of them is a success:
 *
 *   `replayed: true`   the idempotency ledger already holds this key. The
 *                      transaction it names is saved; THIS call applied nothing.
 *                      Reported, never rendered as a fresh save — see
 *                      {@link readNotCommitted}.
 *   `unsupported: […]` the write had no overlay spelling. Nothing landed.
 *   `documents: […]`   a rebase blocked by §28.5 preconditions. Nothing landed.
 *   `checkpoint: {…}`  a checkpoint export, which records no transaction.
 *
 * A `committed: false` carrying NONE of those is a server contract breach, and
 * the one shape that would otherwise reach the editor as a silent no-op. It is
 * reported as `degraded` with a message that says exactly that, because "did
 * nothing and will not say why" must never render as "saved".
 *
 * ─────────────────────────────────────────────────────────────────────────────
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
} from 'sanity-overlay-client/stagingHost'
import {isOverlayRefusal, type OverlayCommit} from './echo'

type Rec = Record<string, unknown>

export type OverlayTransportOutcome = 'ok' | 'degraded' | 'stale' | 'fatal'

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
  /**
   * The server's machine-readable error code, verbatim.
   *
   * The MESSAGE is for a human and the code is for a caller, and collapsing the
   * two is how `PAYLOAD_TOO_LARGE` and `OVERLAY_STORE_UNAVAILABLE` came to be
   * indistinguishable to everything downstream of here.
   */
  code?: string
  /**
   * Can resending this exact request ever succeed?
   *
   * Not derivable from `outcome`: `degraded` is retryable and `stale`/`fatal`
   * are not, but a caller that wants to know whether to hold the edit in the
   * local buffer is asking THIS question, and it should not have to re-derive it
   * from a status code the transport already looked at.
   */
  retryable: boolean
  /** The server's own `committed` flag, when it stated one. */
  committed?: boolean
  /** The server's own `replayed` flag — the write had already landed. */
  replayed?: boolean
  /**
   * Why nothing was committed, in one sentence, when `committed === false`.
   *
   * Always present when `committed === false`, including for the contract
   * breach — "the overlay reported no reason" is itself the reason.
   */
  notCommittedReason?: string
}

export interface OverlayTransportOptions {
  apiUrl: string
  fetch?: typeof fetch
  /**
   * Every message this transport wants a human to see, with the CONTEXT needed
   * to tell "the server never answered" from "the server answered, and said no".
   *
   * The second argument was added on 2026-08-09 because the runtime read every
   * message as a connectivity failure and rendered `offline` — "Edits are held
   * locally and will be retried" — over a 409, which is neither offline nor
   * retryable. `status === undefined` is the only shape that means no HTTP
   * response arrived.
   */
  onError?: (message: string, context: {status?: number; outcome: OverlayTransportOutcome}) => void
  onAuthFailure?: (failure: {status: number; source: 'write' | 'read'; message: string}) => void
  /** Extra headers, e.g. a preview session token. */
  headers?: Record<string, string>
  /**
   * Deadline for one call. See {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   * `0` or negative disables it.
   */
  requestTimeoutMs?: number
}

/**
 * Sixty seconds on one overlay API call.
 *
 * `fetch` has no timeout of its own, so a server that accepts the connection and
 * never writes a response leaves the commit promise pending for the life of the
 * tab — and a pending commit is exactly the indefinite `Saving…` this file's
 * header describes, with nothing in any channel to explain it. §5.5: a stated
 * failure beats an unbounded pending state.
 *
 * Shorter than the asset uploader's two minutes because the payloads differ by
 * three orders of magnitude: a commit is a JSON document patch, not an image. A
 * commit that has not been answered in a minute is not slow, it is gone.
 *
 * The timeout is reported as `degraded`, i.e. RETRYABLE, and that is the right
 * reading: an unanswered request may still have landed, so the edit is kept in
 * the pane and the idempotency key makes the retry safe (§34.6).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

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

/** The server's `{error: {code}}`, or a top-level `code`. */
function codeOf(body: Rec | undefined): string | undefined {
  const error = body?.error
  if (isRec(error) && typeof error.code === 'string') return error.code
  if (typeof body?.code === 'string') return body.code
  return undefined
}

/**
 * The one place a status becomes a verdict.
 *
 * A TABLE, not a chain of `if`s scattered through `call()`, because the property
 * that matters is TOTALITY: every status reaches the editor as something, and
 * the only way to keep that true as statuses are added is to have one function
 * whose output type forces it.
 *
 * `retryable` is stated per row rather than derived from `outcome` because the
 * two answer different questions, and the row where they come apart is the one
 * that caused this work: a 409 is not retryable and not fatal.
 */
function classifyStatus(status: number): {
  outcome: OverlayTransportOutcome
  retryable: boolean
  /** Prefixed to the server's own message, when the code alone would not explain it. */
  advice?: string
} {
  if (AUTH_STATUSES.has(status)) return {outcome: 'fatal', retryable: false}

  /* §22.9 / `errors.ts`: "your view of this resource is stale". The server has
   * already reconciled once and re-derived the request; a second refusal means
   * something else is writing continuously. Resending cannot fix that. */
  if (status === 409) {
    return {
      outcome: 'stale',
      retryable: false,
      advice:
        'the branch moved underneath this session and this edit was NOT saved. Reload the ' +
        'Studio to pick up the current branch state before editing again — retrying will not ' +
        'help, and nothing was written to Sanity',
    }
  }

  /* Refusals about the REQUEST. Resending the identical bytes reproduces them
   * exactly, which is why they are not `degraded`: a client that treats them as
   * transient retries forever, which is the loop `errors.ts` names. */
  if (status === 413 || status === 422 || status === 415) {
    return {
      outcome: 'fatal',
      retryable: false,
      advice: 'the overlay API refused this request as it stands, and resending it will not help',
    }
  }

  /* Everything else — 5xx, 429, 404, a stray 400 — is treated as transient.
   * Wrong in the safe direction: the edit stays in the pane and is retried,
   * rather than being discarded over a status nobody has classified yet. */
  return {outcome: 'degraded', retryable: true}
}

/**
 * Why a 2xx did not commit, and whether that is alarming.
 *
 * `breach: true` is reserved for the shape the server's own contract forbids —
 * see below. Everything else stays `ok` and travels on `notCommittedReason`.
 */
function readNotCommitted(body: Rec): {reason: string; alarming: boolean; breach: boolean} {
  if (body.replayed === true) {
    /*
     * REPORTED, NOT SILENT — CHANGED 2026-08-10.
     *
     * This used to be `alarming: false`, on the reasoning that "the write DID
     * land, earlier, and shouting about it would train an editor to ignore this
     * channel". That reasoning holds only for a replay the client MEANT to
     * cause — a retry after a timeout, where the key is being reused on purpose.
     *
     * It did not hold for the failure this comment replaces. `echo.ts` issued
     * the same idempotency key on every page load, so the first document action
     * after any reload was answered from the ledger with somebody else's
     * transaction, and this branch was the one place that could have said so. It
     * said nothing, and the editor was shown a save.
     *
     * The generator is fixed, so a replay is now a rare and genuinely
     * interesting event rather than routine noise — which is exactly when a
     * channel should speak. Still NOT `breach`: the outcome stays `ok` and no
     * retry is advertised, because the named write really is in the ledger.
     */
    return {
      reason:
        'this write had already been committed under the same idempotency key, so the overlay ' +
        'replayed the earlier transaction and applied NOTHING now (PRD §34.6). If you did not ' +
        'retry this write, what you just did was not saved — re-read the document before ' +
        'relying on it',
      alarming: true,
      breach: false,
    }
  }

  const unsupported = Array.isArray(body.unsupported)
    ? body.unsupported.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (unsupported.length > 0) {
    return {
      reason: `the overlay could not represent this write: ${unsupported.join('; ')}`,
      alarming: true,
      breach: false,
    }
  }

  if (isRec(body.checkpoint)) {
    return {
      reason:
        'a checkpoint was exported. Checkpoints record no transaction, so `committed` is false ' +
        'by design and nothing is missing',
      alarming: false,
      breach: false,
    }
  }

  const blocked = Array.isArray(body.documents)
    ? body.documents.filter(
        (entry) => isRec(entry) && Array.isArray(entry.blockedBy) && entry.blockedBy.length > 0,
      )
    : []
  if (blocked.length > 0) {
    const reasons = blocked
      .map((entry) => {
        const row = entry as Rec
        const by = (row.blockedBy as unknown[]).join(', ')
        return `${String(row.logicalId)} (${by})`
      })
      .join('; ')
    return {reason: `blocked and not applied: ${reasons}`, alarming: true, breach: false}
  }

  /*
   * THE CONTRACT BREACH, and the reason this function returns a reason rather
   * than `undefined`. The overlay API's own contract is that a `committed:
   * false` always carries `replayed`, `unsupported`, `checkpoint` or a blocked
   * `documents` list. One that carries none of them did nothing and will not say
   * why — which, reported as `ok`, is precisely the silent no-op §5.5 forbids
   * and precisely what an editor experiences as a frozen revision.
   */
  return {
    reason:
      'the overlay API answered 2xx with `committed: false` and gave no `replayed`, ' +
      '`unsupported`, `checkpoint` or blocked-document reason. Nothing was saved and the ' +
      'server did not say why — treat this edit as unsaved and reload',
    alarming: true,
    breach: true,
  }
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
      noteError(message, {outcome: 'degraded'})
      return {outcome: 'degraded', retryable: false, message}
    }

    /* THE DEADLINE. Cleared in `finally`, always: an uncleared 60-second timer
     * keeps a Node process — and any test runner hosting one — alive. */
    const limit = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const controller =
      limit > 0 && typeof AbortController === 'function' ? new AbortController() : undefined
    let timedOut = false
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            controller.abort()
          }, limit)

    let status = 0
    let text = ''
    try {
      const response = (await doFetch(url, {
        method: init.method,
        headers: {'content-type': 'application/json', ...(options.headers ?? {})},
        ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}),
        ...(controller === undefined ? {} : {signal: controller.signal}),
      })) as unknown as {status: number; text: () => Promise<string>}
      status = response.status
      text = await response.text()
    } catch (error) {
      /* RETRYABLE, and deliberately so: an unanswered request may still have
       * landed, so the edit stays in the pane and §34.6's idempotency key makes
       * the retry safe. What must not happen is that it stays pending. */
      const message = timedOut
        ? `[sanity-overlay-studio] the overlay API at ${url} did not answer within ${limit}ms; ` +
          `the request was abandoned. The edit is still in the editor and nothing was sent to ` +
          `Sanity — if the overlay did receive it, the idempotency key makes a retry safe.`
        : `[sanity-overlay-studio] the overlay API at ${url} is unreachable: ` +
          `${error instanceof Error ? error.message : String(error)}`
      noteError(message, {outcome: 'degraded'})
      return {outcome: 'degraded', retryable: true, message}
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    let body: Rec | undefined
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      body = isRec(parsed) ? parsed : {result: parsed}
    } catch {
      const message =
        `[sanity-overlay-studio] the overlay API at ${url} answered ${status} with a body that ` +
        `is not JSON (${text.slice(0, 120)})`
      noteError(message, {outcome: 'degraded', status})
      return {outcome: 'degraded', retryable: true, status, message}
    }

    const code = codeOf(body)

    if (status < 200 || status >= 300 || body.ok === false) {
      const verdict = classifyStatus(status)
      const message =
        `[sanity-overlay-studio] ${url} answered ${status}` +
        `${code === undefined ? '' : ` (${code})`}: ${messageOf(body, 'no detail')}` +
        `${verdict.advice === undefined ? '' : `. ${verdict.advice}`}`
      noteError(message, {outcome: verdict.outcome, status})
      /* Fatal either way for a 401/403. Session-ending only when the overlay
       * declared that the refusal came from Sanity rather than from itself. */
      if (AUTH_STATUSES.has(status) && declaresUpstreamAuthOrigin(body)) {
        options.onAuthFailure?.({status, source, message})
      }
      return {
        outcome: verdict.outcome,
        retryable: verdict.retryable,
        status,
        body,
        message,
        ...(code === undefined ? {} : {code}),
      }
    }

    /* A 2xx. Success unless the body itself says otherwise. */
    const committed = typeof body.committed === 'boolean' ? body.committed : undefined
    const notCommitted = committed === false ? readNotCommitted(body) : undefined

    if (notCommitted !== undefined && notCommitted.alarming) {
      noteError(`[sanity-overlay-studio] ${url} answered ${status} but ${notCommitted.reason}`, {
        outcome: notCommitted.breach ? 'degraded' : 'ok',
        status,
      })
    }

    return {
      /* The contract breach — nothing committed and no stated reason — is the
       * one 2xx that must not read as a save. Every other `committed: false`
       * has an explanation the caller can act on, so it stays `ok` and travels
       * on `notCommittedReason` instead of being dressed up as a failure. */
      outcome: notCommitted?.breach === true ? 'degraded' : 'ok',
      retryable: notCommitted?.breach === true,
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
      ...(code === undefined ? {} : {code}),
      ...(committed === undefined ? {} : {committed}),
      ...(typeof body.replayed === 'boolean' ? {replayed: body.replayed} : {}),
      ...(notCommitted === undefined ? {} : {notCommittedReason: notCommitted.reason}),
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
