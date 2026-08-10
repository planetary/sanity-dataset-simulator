/**
 * The overlay echo protocol — PRD §18.4–§18.9 and §21.4.1.
 *
 * Studio's document pane is driven by a listener. When a write is intercepted,
 * the Content Lake never sees the mutation, so the real listener will never
 * report it and the pane sits at "Saving…" forever. This module decides which
 * overlay operations a Studio write corresponds to, and synthesises the listener
 * frames the pane is waiting for.
 *
 * Pure data-in/data-out: no `window`, no client, no un-injected clock. Every
 * question worth asking here is answerable without a browser.
 */

import {toDraftId, toPublishedId} from '../ids'

type Rec = Record<string, unknown>

/* ------------------------------------------------------------------ types */

/** A listener mutation event, in the shape sanity 6.8.0's pair listener emits. */
export interface OverlayMutationEvent {
  type: 'mutation'
  eventId: string
  documentId: string
  transactionId: string
  transition: 'update' | 'appear' | 'disappear'
  identity: string
  mutations: Rec[]
  previousRev?: string
  resultRev: string
  timestamp: string
  visibility: 'transaction'
  transactionCurrentEvent: number
  transactionTotalEvents: number
  projection: null
}

/**
 * "I cannot describe what just happened to these documents — re-read them."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REFUSAL HAS TO BE AN EVENT AND NOT ONLY A LOG LINE.
 *
 * A write the echo cannot spell as a frame leaves `BufferedDocument.submitted`
 * non-empty for ever. That is not a cosmetic defect: `consistencyStatus` never
 * flips, so `publish`, `unpublish`, `discardChanges` and `delete` — every
 * `REQUIRES_CONSISTENCY` operation in `sanity@6.8.0` — silently never execute,
 * and the pane reports `Saving…` until the tab is closed. Logging the reason
 * tells whoever opens the console; it does not un-wedge the editor.
 *
 * `reset` is `sanity`'s OWN spelling for this. `getPairListener` maps a `reset`
 * (or `welcome`) straight onto `fetchInitialDocumentSnapshots()`
 * (`lib/datastores-DqFH7RLd.js:1681`), and a `snapshot` event rebuilds the
 * BufferedDocument from what that fetch returns — which, through the facade's
 * read tap, is the branch state the overlay just persisted. So the recovery is
 * "go and read the truth", which is the only honest thing left to say, and it is
 * a protocol path Studio already implements rather than one invented here.
 *
 * BOUNDED, because an unbounded one is a livelock: a resync re-commits whatever
 * the buffer still holds, and if that write is unechoable too the pair would
 * loop. After {@link MAX_RESYNCS_PER_DOCUMENT} the echo stops asking and says
 * so, which leaves a stated dead end instead of a spinning one.
 */
export interface OverlayResyncEvent {
  type: 'reset'
  /** One sentence naming what could not be echoed. */
  reason: string
  /** The addresses whose frames could not be built. */
  documentIds: readonly string[]
}

/** Everything the echo can put on a merged listener channel. */
export type OverlayListenerEvent = OverlayMutationEvent | OverlayResyncEvent

/** What the echo intends to tell Studio about one document. */
export interface PlannedEvent {
  documentId: string
  transition: 'update' | 'appear' | 'disappear'
  /** Patch body (without `id`) for edit actions. */
  patch?: Rec
  /** Pre-built mutations, used by the raw-mutate and document-action paths. */
  mutations?: Rec[]
  /** When creating a draft: id of the published document to clone from. */
  cloneFrom?: string
  /**
   * Build a `createOrReplace` from the current known body of this document,
   * re-`_id`'d onto {@link PlannedEvent.documentId}. Resolved at delivery time so
   * a publish echoes the body the overlay just persisted, not a stale snapshot.
   */
  copyFrom?: string
}

export interface OverlayDocState {
  rev?: string
  updatedAt?: string
  /** Last known full document, used to seed a synthetic draft create. */
  doc?: Rec
  /** True once the revision chain for this document is echo-owned. */
  synthetic?: boolean
  /**
   * True when `rev` is the revision the PANE was handed — the overlay body the
   * read tap substituted — rather than the one base reported.
   *
   * SEPARATE FROM {@link OverlayDocState.synthetic}, and the separation is
   * load-bearing. `synthetic` says "this overlay minted the revision AND the
   * stored `doc` must not be offered as a merge ancestor" (`runtime.ts`
   * `baseDocuments`, §16.1/§17.1). Substituting a body into a read says only the
   * first half: `doc` still holds the RAW base answer, which is exactly the
   * ancestor a rebase needs. Collapsing the two silently emptied
   * `baseDocuments`, which disables the rebase action with "no current base".
   *
   * Both flags protect the revision from being clobbered by a later
   * non-authoritative read — see {@link seedFromDocument}.
   */
  paneRev?: boolean
}

/**
 * `active` — the normal state; blocked writes may be acknowledged.
 * `unauthenticated` — a 401/403 was observed; recoverable by a token refresh.
 * `logged-out` — terminal. A new session arrives with a new page load.
 */
export type OverlaySessionState = 'active' | 'unauthenticated' | 'logged-out'

export interface OverlayAuthFailure {
  status: number
  source: 'listener' | 'read' | 'write'
  message: string
}

/** Whether a blocked write may be answered with a synthetic success. */
export interface OverlayWriteAck {
  ok: boolean
  error?: {status?: number; message: string}
}

/** One commit the echo owes the overlay API. */
export interface OverlayCommit {
  kind: 'actions' | 'mutations' | 'documentActions'
  payload: unknown[]
}

export interface OverlayEchoPlan {
  plans: PlannedEvent[]
  commits: OverlayCommit[]
  unsupported: string[]
}

export interface OverlaySubscription {
  unsubscribe: () => void
}

export interface OverlayEchoOptions {
  /** Injected epoch-ms clock, so frame timestamps are deterministic in tests. */
  now?: () => number
  identity?: string
  onError?: (message: string) => void
  onEmit?: (event: OverlayMutationEvent, subscribers: number) => void
  /**
   * The namespace every {@link OverlayEcho.nextTransactionId} sits in — see
   * {@link newOverlaySessionId} for why it exists.
   *
   * INJECTED ONLY FOR DETERMINISM, AND THE DEFAULT IS NOT WEAKENED TO SUIT IT. A
   * test that wants the old fixed `overlay-…-1`, `overlay-…-2` sequence states a
   * session id and gets it; production never does, and gets a fresh unique one
   * per echo. Nothing may make this default to a constant.
   */
  sessionId?: string
}

export interface OverlayEcho {
  seedFromResult(value: unknown, authoritative: boolean): void
  observeUpstreamEvent(event: unknown): void
  getDocState(id: string): OverlayDocState | undefined
  revisionOf(id: string): string | undefined
  revisions(): Record<string, string | undefined>
  setOverlayDocument(id: string, document: Rec | null): void
  getOverlayDocument(id: string): Rec | undefined
  /**
   * Mark (or clear) an address the branch has TOMBSTONED — §18.6 delete, §18.7
   * discard-draft, §18.5 unpublish.
   *
   * A separate channel from {@link OverlayEcho.setOverlayDocument} because the
   * two say different things and only one of them can be spelled as a body.
   * "The branch holds no body for this address" (no local edit yet) must fall
   * through to base; "the branch has removed this address" must not. Collapsing
   * them onto `null` — which is what storing `null` as *absence* did — put a
   * document the editor had deleted back in front of them, silently.
   */
  setOverlaySuppressed(id: string, suppressed: boolean): void
  isOverlaySuppressed(id: string): boolean
  /**
   * Record what the pane was ACTUALLY handed for one address, after the read tap
   * substituted the branch's body (or its tombstone) into a base answer.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE INVARIANT THIS EXISTS TO KEEP: the revision the echo chains the next
   * frame off must be the revision the pane's HEAD actually carries.
   *
   * `seedFromResult` records the RAW base answer, and it has to — that body is
   * the merge ancestor §17 recomputes against, and overwriting it with an
   * overlay body would make the overlay its own ancestor. But the pane is not
   * given the raw answer. It is given `echo.getOverlayDocument(id)`, whose `_rev`
   * is a SYNTHETIC overlay revision (§13.9), or `null` for a tombstoned address.
   *
   * Without this the two diverge silently, and the divergence is fatal in both
   * directions:
   *
   *   - base answered `null`, branch body substituted → the echo believes there
   *     is no revision and omits `previousRev`, while `Document.considerIncoming`
   *     looks for `previousRev === HEAD._rev` and finds nothing. Nothing is ever
   *     applied. Reopening a branch-created document therefore wedged the pane
   *     at `Saving…` for the life of the tab.
   *   - base answered a document, branch tombstoned it → the pane's HEAD is
   *     `null` and needs `appliesToMissingDocument`, while the echo would build a
   *     patch frame chained off the base revision. Same wedge, opposite cause.
   *
   * `doc` is deliberately NOT touched: only the revision chain moves.
   */
  notePaneSnapshot(id: string, document: Rec | null): void
  subscribe(
    ids: readonly string[],
    handler: (event: OverlayListenerEvent) => void,
  ): OverlaySubscription
  subscriberCount(): number
  /**
   * A transaction id no other page load, tab or process will ever issue.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * IT IS NOT A NAME. IT IS THE DEDUPLICATION AUTHORITY.
   *
   * `facade.ts` uses this value as the `idempotencyKey` of every write Studio
   * did not supply its own uuid `transactionId` for — which is precisely the
   * §18.4-§18.9 document actions: publish, unpublish, discard, delete,
   * duplicate, restore. The ledger those keys are resolved against is DURABLE
   * (`.runtime/indexes/idempotency/`), so it outlives the tab.
   *
   * This used to be `overlay-${counter}-${hash(counter)}` over a closure counter
   * seeded at 0 per page load. The hash carried no entropy — it was a pure
   * function of the counter — so every page load emitted the identical sequence
   * and the Nth document action after any reload REPLAYED the Nth of an earlier
   * one: `200 {"committed": false, "replayed": true}`, nothing applied, and the
   * editor told it had saved. `examples/kitchen-sink/spikeA/localEcho.ts` had
   * already found this and fixed it with a per-page-load `sessionId()` prefix;
   * the prefix was lost when the spike was rewritten into this package.
   *
   * The counter survives as the ORDINAL, because that is what it was worth:
   * ordered, readable ids in the write ledger and in a devtools trace. Only the
   * namespace it lives in became unique. See {@link OverlayEchoOptions.sessionId}.
   */
  nextTransactionId(): string
  /**
   * Ask every pane watching these addresses to discard its model and re-read.
   *
   * Called by {@link emit} whenever a plan produced no frame, and by the facade
   * for a commit that provably did NOT land (`fatal`, `stale`) — in both cases
   * the pane holds a submitted transaction that nothing will ever answer, and
   * the difference between "wrong" and "wedged" is whether it is told so.
   * Bounded per address; see {@link OverlayResyncEvent}.
   */
  requestResync(documentIds: readonly string[], reason: string): void
  planActions(payload: unknown): OverlayEchoPlan
  planMutations(body: unknown): OverlayEchoPlan
  planWrite(method: string, arg: unknown, options?: unknown): OverlayEchoPlan
  emit(plans: readonly PlannedEvent[], transactionId: string): OverlayMutationEvent[]

  sessionState(): OverlaySessionState
  noteAuthFailure(failure: {
    status: number
    source: OverlayAuthFailure['source']
    message?: string
  }): void
  authFailures(): readonly OverlayAuthFailure[]
  restoreSession(): void
  logout(): void
  acknowledgeWrite(): OverlayWriteAck
}

/* ------------------------------------------------------------- constants */

/** The pseudo-field the Actions API always unsets first. */
const GUARD_FIELD = '_empty_action_guard_pseudo_field_'
const DEFAULT_IDENTITY = 'sanity-overlay'

/**
 * One unique identity per echo — i.e. per page load, per tab, per process.
 *
 * THE SAME SCHEME STUDIO'S OWN EDITS ALREADY USE, deliberately, rather than a
 * second one. An ordinary edit reaches the facade carrying a `transactionId`
 * that sanity 6.8.0 minted with `@sanity/uuid`, which is an RFC 4122 v4 uuid
 * drawn from the platform CSPRNG — that is exactly what `crypto.randomUUID()`
 * returns, so edits and document actions now share one notion of "unique".
 *
 * The fallback is not decoration. `crypto` is unavailable on a non-secure origin
 * in some browsers and absent from older Node, and an echo with no session id at
 * all would silently reinstate the collision this function exists to remove. So
 * it degrades through `getRandomValues` to a time-plus-`Math.random()` value:
 * weaker, still not a constant, and never zero entropy.
 */
export function newOverlaySessionId(): string {
  const source = (globalThis as {crypto?: Crypto}).crypto
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID()
    if (typeof source?.getRandomValues === 'function') {
      const bytes = source.getRandomValues(new Uint8Array(16))
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* A hardened environment can throw rather than omit; fall through. */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const EDIT_ACTIONS = new Set([
  'sanity.action.document.edit',
  'sanity.action.document.version.replace',
])

const DISCARD_ACTIONS = new Set([
  'sanity.action.document.discard',
  'sanity.action.document.version.discard',
])

/** Studio's duplicate is a tagged `create`, not an Actions API call. */
export const DUPLICATE_TAG = 'document.duplicate'
/** The overlay's own spelling of §18.9 duplicate. */
export const DUPLICATE_ACTION = 'sanity.overlay.document.duplicate'

const CREATE_METHODS = new Set(['create', 'createOrReplace', 'createIfNotExists'])

/** The Actions API's own spelling of "this document did not exist before". */
const CREATE_ACTION = 'sanity.action.document.create'

/**
 * How many times one address may be told to re-read itself before the echo gives
 * up and says so. See {@link OverlayResyncEvent}.
 */
export const MAX_RESYNCS_PER_DOCUMENT = 3

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------ auth status */

/** The two statuses that end a session. Everything else is transient. */
const AUTH_STATUSES = new Set([401, 403])

function authStatusIn(candidate: unknown): number | undefined {
  if (!isRec(candidate)) return undefined
  for (const key of ['statusCode', 'status'] as const) {
    const value = candidate[key]
    if (typeof value === 'number' && AUTH_STATUSES.has(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value) && AUTH_STATUSES.has(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

/* --------------------------------------------------------- own refusals */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFUSAL THIS SYSTEM ISSUED IS NOT A FAILURE OF THE USER'S SANITY SESSION.
 *
 * Observed live, 2026-08-06: Studio said *"Your Sanity session is no longer
 * authenticated. Editing is read-only"* while the session was fine. The only
 * 4xx responses in that session were the Track B write guard refusing
 * `POST /descriptors/claim` (`uploadSchema`) and `POST /intake/batch`
 * (telemetry) — both correctly, both 403, and both read here as Sanity revoking
 * the editor's credential.
 *
 * THE DISCRIMINATOR IS ORIGIN, NOT STATUS. Dropping 403 wholesale would be the
 * wrong fix: a genuine 403 from Sanity means *your token lacks this grant*, and
 * the editor has to be told. So this system stamps its own refusals instead, in
 * the two forms they can arrive in:
 *
 *   1. an `Error` this code constructed          → {@link markOverlayRefusal}
 *   2. a JSON body one of our own guards sent    → an `OVERLAY_*` error `code`
 *      (`proxy.mjs` `OVERLAY_WRITE_BLOCKED`, `origin.mjs` `OVERLAY_ORIGIN_*`)
 *      or a code in {@link OVERLAY_REFUSAL_CODES}
 *
 * Sanity's own error bodies never carry either, so the exemption cannot widen
 * to a real credential failure — the only direction in which a mistake here
 * loses an editor's work.
 *
 * STRUCTURED FIELDS ONLY, NEVER PROSE. `authStatusOf` already refuses to match
 * the digits "401" inside an unrelated message; the same standard applies to
 * the marker, so an error whose *description* happens to quote
 * `OVERLAY_WRITE_BLOCKED` is still a real auth failure.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const OVERLAY_REFUSAL_FLAG = 'sanityOverlayRefusal'

/** Every refusal code this system emits that is not `OVERLAY_*`-prefixed. */
export const OVERLAY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  /** `sanity-overlay-client/src/stagingHost.ts` — the host-level write guard. */
  'STAGING_WRITE_REFUSED',
  /** `client/reads.ts` — `OverlayReadRefusedError`, strict mode. */
  'UNSUPPORTED_GROQ',
])

const OVERLAY_REFUSAL_CODE_PREFIX = 'OVERLAY_'

function isRefusalCode(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(OVERLAY_REFUSAL_CODE_PREFIX) || OVERLAY_REFUSAL_CODES.has(value))
  )
}

/**
 * Stamp an error as this system's own refusal.
 *
 * Non-enumerable, so it cannot leak into a `JSON.stringify` of an error a host
 * logs, and cannot collide with a caller's own serialisation.
 */
export function markOverlayRefusal<E extends object>(error: E): E {
  Object.defineProperty(error, OVERLAY_REFUSAL_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return error
}

/**
 * Did this failure originate in one of this system's own guards?
 *
 * The carriers are every place `@sanity/client@7.26.0` puts a parsed error body
 * (`extractErrorProps`: `details` is the body's `error` object, `response.body`
 * is the whole body) plus the error itself, for a refusal we threw directly.
 */
export function isOverlayRefusal(error: unknown): boolean {
  if (!isRec(error)) return false
  if ((error as Rec)[OVERLAY_REFUSAL_FLAG] === true) return true

  const carriers: unknown[] = [error, error.details, error.body]
  if (isRec(error.response)) carriers.push(error.response.body)
  for (const carrier of [...carriers]) {
    if (isRec(carrier) && isRec(carrier.error)) carriers.push(carrier.error)
  }
  for (const carrier of carriers) {
    if (!isRec(carrier)) continue
    if (isRefusalCode(carrier.code)) return true
  }
  return false
}

/**
 * The 401/403 inside whatever the transport threw, or `undefined`.
 *
 * `@sanity/client@7.26.0` surfaces the status in four places depending on where
 * the failure happened: `ClientError.statusCode`, the shared
 * `HttpError.response.statusCode`, the API error body (`details` /
 * `response.body`), and a bare `fetch` Response's `status`.
 *
 * Deliberately narrow. A false positive stops every subsequent write in the
 * session, so a 500, a `TypeError: fetch failed`, the digits "401" inside a
 * message, and — see {@link isOverlayRefusal} — a refusal this system issued
 * must all read as *not* an auth failure.
 */
export function authStatusOf(error: unknown): number | undefined {
  if (!isRec(error)) return undefined
  if (isOverlayRefusal(error)) return undefined
  const candidates: unknown[] = [error, error.response, error.details]
  if (isRec(error.response)) candidates.push(error.response.body)
  for (const candidate of candidates) {
    const status = authStatusIn(candidate)
    if (status !== undefined) return status
  }
  return undefined
}

/* ------------------------------------------------------------- the echo */

export function createOverlayEcho(options: OverlayEchoOptions = {}): OverlayEcho {
  const clock = options.now ?? ((): number => Date.now())
  const identity = options.identity ?? DEFAULT_IDENTITY
  const noteError = options.onError ?? ((): void => {})

  const docs = new Map<string, OverlayDocState>()
  /** Bodies the overlay API materialized, keyed as Studio addresses them. */
  const overlayDocs = new Map<string, Rec>()
  /** Addresses the branch has tombstoned — see {@link OverlayEcho.setOverlaySuppressed}. */
  const overlaySuppressed = new Set<string>()
  const listeners = new Set<{
    ids: Set<string>
    handler: (event: OverlayListenerEvent) => void
  }>()
  /** Transactions already delivered — a replay must never become a second frame. */
  const emitted = new Set<string>()
  /** How many times each address has been asked to re-read itself. */
  const resyncs = new Map<string, number>()

  let txCounter = 0
  const sessionId = options.sessionId ?? newOverlaySessionId()
  let session: OverlaySessionState = 'active'
  const authFailureLog: OverlayAuthFailure[] = []

  /* ----------------------------------------------------------- session */

  function noteAuthFailure(failure: {
    status: number
    source: OverlayAuthFailure['source']
    message?: string
  }): void {
    const message = failure.message ?? `HTTP ${failure.status}`
    authFailureLog.push({status: failure.status, source: failure.source, message})
    noteError(
      `auth failure ${failure.status} on the ${failure.source}: ${message} — the session is no ` +
        `longer authorized, so writes will not be acknowledged until the token is refreshed`,
    )
    /* Logout is terminal: a stale in-flight 401 must not downgrade it and let a
     * later `restoreSession` resurrect the session. */
    if (session !== 'logged-out') session = 'unauthenticated'
  }

  function restoreSession(): void {
    if (session === 'unauthenticated') session = 'active'
  }

  function logout(): void {
    if (session === 'logged-out') return
    session = 'logged-out'
    /* Releasing here is what makes "no further events are delivered" true even
     * for a pane that never got the chance to unsubscribe itself. */
    listeners.clear()
    noteError(
      'session logged out: every listener subscription is released and no further write will ' +
        'be acknowledged',
    )
  }

  /**
   * The revision store is deliberately left alone by both transitions. An
   * expired token says nothing about what the Content Lake holds, and a dropped
   * or invented revision only shows up 30 s later as a
   * `sequentializeListenerEvents` deadline, far from its cause.
   */
  function acknowledgeWrite(): OverlayWriteAck {
    if (session === 'logged-out') {
      return {
        ok: false,
        error: {
          message:
            'the session is logged out: this write cannot be persisted and must not be ' +
            'reported to the editor as saved',
        },
      }
    }
    if (session === 'unauthenticated') {
      const last = authFailureLog[authFailureLog.length - 1]
      return {
        ok: false,
        error: {
          status: last?.status,
          message:
            `the session is not authenticated (HTTP ${last?.status ?? '401/403'}): this write ` +
            'cannot be persisted and must not be reported to the editor as saved',
        },
      }
    }
    return {ok: true}
  }

  /* --------------------------------------------------------- revisions */

  function setDocState(id: string, patch: OverlayDocState): void {
    docs.set(id, {...(docs.get(id) ?? {}), ...patch})
  }

  /**
   * `authoritative` = this read is the thing Studio itself resets its base
   * revision from (the pair listener's snapshot fetch). A non-authoritative read
   * still returns the STALE server revision once writes are blocked; letting it
   * overwrite a synthetic revision would silently break the chain.
   */
  function seedFromDocument(value: unknown, authoritative: boolean): void {
    if (!isRec(value)) return
    const id = value._id
    if (typeof id !== 'string') return
    const current = docs.get(id)
    if (!authoritative && (current?.synthetic === true || current?.paneRev === true)) return
    setDocState(id, {
      rev: typeof value._rev === 'string' ? value._rev : undefined,
      updatedAt: typeof value._updatedAt === 'string' ? value._updatedAt : undefined,
      doc: authoritative ? value : current?.doc,
      synthetic: false,
      paneRev: false,
    })
  }

  function seedFromResult(value: unknown, authoritative: boolean): void {
    if (Array.isArray(value)) {
      for (const item of value) seedFromDocument(item, authoritative)
      return
    }
    seedFromDocument(value, authoritative)
  }

  /** See {@link OverlayEcho.notePaneSnapshot}. */
  function notePaneSnapshot(id: string, document: Rec | null): void {
    if (document === null) {
      /* The branch removed this address, so the pane's HEAD is `null` and only a
       * create-shaped frame can ever apply to it again. */
      setDocState(id, {rev: undefined, updatedAt: undefined, paneRev: true})
      return
    }
    const rev = typeof document._rev === 'string' && document._rev !== '' ? document._rev : undefined
    if (rev === undefined) {
      /*
       * UNRECOVERABLE BY ANY FRAME, SO IT IS SAID OUT LOUD.
       *
       * `Document.considerIncoming` will only look for a successor when
       * `HEAD._rev` is truthy (`@sanity/mutator@6.8.0`): a HEAD that exists and
       * carries no revision accepts NOTHING, for ever. Core stamps every
       * materialized body with a synthetic `_rev` (`applySyntheticSystemFields`),
       * so reaching this means an overlay answered without one, and no frame this
       * module could build would help.
       */
      noteError(
        `the overlay body substituted for ${id} carries no _rev, so nothing this session ` +
          `echoes can ever be applied to it — @sanity/mutator only advances a HEAD that has a ` +
          `revision. The document pane will not settle until it is re-read.`,
      )
    }
    setDocState(id, {
      rev,
      updatedAt: typeof document._updatedAt === 'string' ? document._updatedAt : undefined,
      paneRev: true,
    })
  }

  /** Learn the real revision chain from an event another client produced. */
  function observeUpstreamEvent(event: unknown): void {
    if (!isRec(event) || event.type !== 'mutation') return
    if (typeof event.documentId !== 'string') return
    if (typeof event.resultRev !== 'string' || event.identity === identity) return
    setDocState(event.documentId, {
      rev: event.resultRev,
      updatedAt: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      synthetic: false,
    })
  }

  /* ------------------------------------------------------ subscriptions */

  function subscribe(
    ids: readonly string[],
    handler: (event: OverlayListenerEvent) => void,
  ): OverlaySubscription {
    /* After logout the session is over: a late subscription (a pane torn down
     * asynchronously, a retrying listener) must not re-open a delivery channel. */
    if (session === 'logged-out') return {unsubscribe: (): void => {}}
    const entry = {ids: new Set(ids), handler}
    listeners.add(entry)
    let released = false
    return {
      unsubscribe: (): void => {
        if (released) return
        released = true
        listeners.delete(entry)
      },
    }
  }

  /* -------------------------------------------------------- frame build */

  /**
   * `Document.considerIncoming` drops incoming mutations whose timestamp
   * predates HEAD._updatedAt. Guard against a frozen or skewed clock by always
   * moving forward relative to the revision store's own view.
   */
  function nextTimestamp(state: OverlayDocState | undefined): string {
    const wall = clock()
    const known = state?.updatedAt ? Date.parse(state.updatedAt) : NaN
    const ms = Number.isFinite(known) && known >= wall ? known + 1 : wall
    return new Date(ms).toISOString()
  }

  /**
   * The body a `copyFrom` / `cloneFrom` plan promotes. The overlay API's
   * materialization wins, because it is the only party that ran the intercepted
   * patches through core. The last read snapshot is the fallback — correct only
   * while nothing has been edited, so a *synthetic* revision on the source means
   * the snapshot is provably behind and the caller is told.
   */
  function bodyFor(id: string): Rec | undefined {
    const stored = overlayDocs.get(id)
    if (stored !== undefined) return stored
    const state = docs.get(id)
    if (state?.doc !== undefined && state.synthetic === true) {
      noteError(
        `echoing ${id} from a stale snapshot: this document has local edits the overlay never ` +
          `materialized back. The pane may show out-of-date content until the next read.`,
      )
    }
    return state?.doc
  }

  /**
   * A body re-addressed to `documentId`, with the revision metadata removed.
   *
   * `_rev` and `_updatedAt` are the frame's to state — `Mutation.compile` writes
   * `resultRev` and the frame timestamp over them — and leaving the SOURCE's
   * values in the payload would put a revision in the pane that no event ever
   * announced.
   */
  function reidentify(body: Rec, documentId: string, options: {keepCreatedAt: boolean}): Rec {
    const copy: Rec = {...body, _id: documentId}
    delete copy._rev
    delete copy._updatedAt
    if (!options.keepCreatedAt) delete copy._createdAt
    return copy
  }

  /**
   * `Mutation.appliesToMissingDocument`, transcribed from `@sanity/mutator@6.8.0`
   * (`lib/index.js:1220`) because it is the ONLY question the mutator asks of a
   * frame whose target document does not exist:
   *
   *     nextMut = this.HEAD
   *       ? (HEAD._rev ? incoming.find(m => m.previousRev === HEAD._rev) : undefined)
   *       : incoming.find(m => m.appliesToMissingDocument())
   *
   * A frame that fails it against a missing HEAD is not rejected — it is
   * BUFFERED, for ever, and the document is inconsistent for as long as it sits
   * there. Delivering one is therefore strictly worse than delivering nothing.
   */
  function appliesToMissingDocument(mutations: readonly Rec[]): boolean {
    const first = mutations[0]
    if (first === undefined) return true
    return Boolean(first.create ?? first.createIfNotExists ?? first.createOrReplace)
  }

  /** `buildFrame`'s third answer: nothing happened here that is worth saying. */
  const NOTHING_TO_SAY = 'nothing-to-say' as const

  function buildFrame(
    plan: PlannedEvent,
    transactionId: string,
  ):
    | Omit<OverlayMutationEvent, 'transactionCurrentEvent' | 'transactionTotalEvents'>
    | null
    | typeof NOTHING_TO_SAY {
    const state = docs.get(plan.documentId)
    const previousRev = state?.rev
    const timestamp = nextTimestamp(state)

    let mutations: Rec[]
    let transition = plan.transition

    if (plan.copyFrom !== undefined) {
      const source = bodyFor(plan.copyFrom)
      if (source === undefined) {
        noteError(
          `cannot echo ${plan.documentId}: no known body for ${plan.copyFrom} to copy from ` +
            `(open the document pane first so the snapshot fetch can seed it)`,
        )
        return null
      }
      mutations = [
        {createOrReplace: reidentify(source, plan.documentId, {keepCreatedAt: false})},
      ]
    } else if (plan.mutations) {
      mutations = plan.mutations
    } else if (previousRev) {
      /* Existing document: guard patch + real patch, exactly as the Actions API
       * emits it. */
      mutations = [
        {patch: {id: plan.documentId, unset: [GUARD_FIELD], unsetIsEmpty: false}},
        {patch: {id: plan.documentId, unsetIsEmpty: false, ...(plan.patch ?? {})}},
      ]
    } else {
      /*
       * ───────────────────────────────────────────────────────────────────────
       * THE PANE HOLDS NO REVISION FOR THIS ADDRESS, SO THE FRAME MUST CREATE IT.
       *
       * `@sanity/mutator`'s `Document.considerIncoming` only consults
       * `appliesToMissingDocument()` when `HEAD` is null, and that returns true
       * for exactly `create` / `createIfNotExists` / `createOrReplace`. A patch
       * frame here is not merely wrong, it is inert: it sits in `incoming` for
       * ever and the document never becomes consistent.
       *
       * Two ways to spell a create, and which one is TRUE depends on where the
       * document came from.
       */
      const base = plan.cloneFrom ? bodyFor(plan.cloneFrom) : undefined
      if (base) {
        /* A BASE document being drafted for the first time. The Actions API's
         * edit really does clone the published version and then patch it, so the
         * two-mutation form is what the Content Lake would have reported. The
         * patch is not double-applied: `base` is the PUBLISHED body, which this
         * edit has not touched. */
        mutations = [
          {createIfNotExists: reidentify(base, plan.documentId, {keepCreatedAt: true})},
          {patch: {id: plan.documentId, unsetIsEmpty: false, ...(plan.patch ?? {})}},
        ]
      } else {
        /*
         * A BRANCH-CREATED document: it exists nowhere upstream, so there is no
         * published version to clone and the refusal that used to stand here was
         * the whole §21.2 defect — in Mode 2 EVERY document takes this branch.
         *
         * The body the overlay just materialized is the honest answer, and it is
         * available because `persistAndEcho` seeds it from the commit's own
         * hydration before calling `emit`. So the frame says "after this
         * transaction this address holds exactly these bytes", which is a
         * statement about the disk rather than about what Studio asked for.
         *
         * ONE `createOrReplace`, NOT `createIfNotExists` + the patch. The
         * materialized body ALREADY has the patch folded in — core applied it —
         * so replaying the patch on top would apply it twice. That is invisible
         * for `set` and silently wrong for `inc`, `dec` and `insert`.
         */
        const branch = bodyFor(plan.documentId)
        if (branch === undefined) {
          noteError(
            `cannot echo ${plan.documentId}: the pane holds no revision for it, there is no ` +
              `published base to clone, and the overlay reported no body for it either — so ` +
              `there is nothing true to say about what this address now contains`,
          )
          return null
        }
        mutations = [
          {createOrReplace: reidentify(branch, plan.documentId, {keepCreatedAt: true})},
        ]
      }
      transition = 'appear'
    }

    /*
     * ───────────────────────────────────────────────────────────────────────────
     * THE APPLICABILITY GUARD — the class the two refusals above belong to.
     *
     * Everything so far asks "can I describe this change?". This asks the
     * question that actually decides whether the pane settles: "given what the
     * pane HOLDS, can the mutator apply what I am about to send?" A frame that
     * fails it is worse than a refusal, because it is delivered, looks fine in
     * every log, and wedges the document silently.
     *
     * Two reachable shapes, and they want opposite answers:
     *
     *   DELETE of an address the pane does not hold. `planActions` emits a
     *   `disappear` for the published id of a branch-created document that was
     *   never published, and the Content Lake would emit nothing at all there.
     *   Saying nothing is not a refusal — there is genuinely no change to report
     *   — so it must not trigger a resync either.
     *
     *   PATCH-FIRST mutations against a missing document. `planMutations` passes
     *   Studio's own mutation list through verbatim, and a live-edit type's first
     *   keystroke is `[{patch: …}]` against a published document that does not
     *   exist yet. The overlay has already created it by the time this runs, so
     *   the truthful frame is the body the overlay now holds.
     */
    if (!previousRev && !appliesToMissingDocument(mutations)) {
      if (transition === 'disappear') return NOTHING_TO_SAY
      const branch = bodyFor(plan.documentId)
      if (branch === undefined) {
        noteError(
          `cannot echo ${plan.documentId}: the pane holds no revision for it and this write ` +
            `starts with a patch, which @sanity/mutator can never apply to a missing document. ` +
            `The overlay reported no body to state instead.`,
        )
        return null
      }
      /* The materialization already has these mutations folded in, so it
       * REPLACES them rather than being prepended to them. */
      mutations = [{createOrReplace: reidentify(branch, plan.documentId, {keepCreatedAt: true})}]
    }

    /* A surviving document is `appear` exactly when the pane does not hold it yet
     * and `update` otherwise, whatever the plan guessed. The planner cannot know:
     * it runs when the write is intercepted, while the answer is only settled at
     * delivery time, after any earlier frame in the same burst has landed. */
    if (transition !== 'disappear') transition = previousRev ? 'update' : 'appear'

    return {
      type: 'mutation',
      eventId: `${transactionId}#${plan.documentId}@overlay`,
      documentId: plan.documentId,
      transactionId,
      transition,
      identity,
      mutations,
      /* Omitted entirely (not `undefined`-valued) when unknown:
       * `sequentializeListenerEvents` compares `base.revision === chain[0].previousRev`,
       * and a missing draft has base revision `undefined`. */
      ...(previousRev ? {previousRev} : {}),
      resultRev: transactionId,
      timestamp,
      visibility: 'transaction',
      projection: null,
    }
  }

  /* -------------------------------------------------------------- emit */

  /**
   * Tell every pane watching these addresses to throw its model away and re-read.
   *
   * The alternative is silence, and silence here is an indefinite `Saving…` plus
   * four document actions that never run. See {@link OverlayResyncEvent}.
   */
  function requestResync(documentIds: readonly string[], reason: string): void {
    const askable: string[] = []
    for (const id of documentIds) {
      const used = resyncs.get(id) ?? 0
      if (used >= MAX_RESYNCS_PER_DOCUMENT) {
        noteError(
          `${id} has already been re-read ${used} times and still cannot be echoed; this pane ` +
            `will not settle and no consistency-gated action (publish, unpublish, discard, ` +
            `delete) will run on it. Reload the Studio. Reason: ${reason}`,
        )
        continue
      }
      resyncs.set(id, used + 1)
      askable.push(id)
    }
    if (askable.length === 0) return

    noteError(
      `asking the document pane to re-read ${askable.join(', ')} because the change could not ` +
        `be echoed: ${reason}. The write itself is unaffected — this only replaces the pane's ` +
        `model with what the overlay actually holds.`,
    )
    const event: OverlayResyncEvent = {type: 'reset', reason, documentIds: askable}
    for (const entry of Array.from(listeners)) {
      if (!askable.some((id) => entry.ids.has(id))) continue
      try {
        entry.handler(event)
      } catch (error) {
        noteError(`overlay listener threw on resync: ${String(error)}`)
      }
    }
  }

  function emit(plans: readonly PlannedEvent[], transactionId: string): OverlayMutationEvent[] {
    if (plans.length === 0) return []
    /* Checked before `emitted` is touched, so a logged-out emit leaves no trace
     * at all: neither a delivered frame nor a revision the next session would
     * have to chain off but no pane ever saw. */
    if (session === 'logged-out') return []
    /* One transaction, one delivery. Studio may subscribe to a blocked write's
     * result observable more than once, and a retried commit reuses the id; a
     * second frame would apply the same mutation to HEAD twice. */
    if (emitted.has(transactionId)) return []
    emitted.add(transactionId)

    /* Built before anything is delivered, so every frame in a transaction chains
     * off the revision that was current when the transaction started. */
    const attempts = plans.map((plan) => ({plan, frame: buildFrame(plan, transactionId)}))

    /*
     * ───────────────────────────────────────────────────────────────────────────
     * ONE DOCUMENT, ONE FRAME PER TRANSACTION. THE CONTENT LAKE HAS NO OTHER SHAPE.
     *
     * A listener event carries a LIST of mutations precisely because a
     * transaction may touch one document several times; `previousRev` and
     * `resultRev` describe the transaction, not the individual mutation. Two
     * events for the same document in the same transaction would therefore both
     * claim `previousRev → resultRev`, and only the first can ever apply:
     * `Document.considerIncoming` advances `HEAD._rev` to `resultRev`, after
     * which the second no longer matches anything and sits in `incoming` for
     * ever, holding the document inconsistent.
     *
     * This is not hypothetical. `toActions` flatMaps mutations to actions
     * (`sanity@6.8.0 lib/datastores-DqFH7RLd.js:1766`), so the ordinary edit of
     * an EXISTING draft — `[{patch: unset guard}, {patch: …}]`, squashed into one
     * commit by `SquashingBuffer` — arrives here as TWO
     * `sanity.action.document.edit` actions for one draft. Every reopened
     * document took that path.
     *
     * Merging concatenates the mutation lists in plan order and keeps the LAST
     * transition, so a create-then-delete inside one transaction still ends as
     * `disappear`.
     */
    type BuiltFrame = Exclude<(typeof attempts)[number]['frame'], null | typeof NOTHING_TO_SAY>
    const byDocument = new Map<string, BuiltFrame>()
    const order: string[] = []
    for (const {frame} of attempts) {
      if (frame === null || frame === NOTHING_TO_SAY) continue
      const existing = byDocument.get(frame.documentId)
      if (existing === undefined) {
        byDocument.set(frame.documentId, frame)
        order.push(frame.documentId)
        continue
      }
      byDocument.set(frame.documentId, {
        ...existing,
        mutations: [...existing.mutations, ...frame.mutations],
        transition: frame.transition,
      })
    }
    const built = order.map((documentId) => byDocument.get(documentId)!)

    /*
     * A PLAN WITH NO FRAME IS A PANE THAT WILL NEVER SETTLE, so it is never left
     * silent. `buildFrame` has already said WHY on `noteError`; this says what is
     * being done about it, and does the one thing that can still be done.
     */
    const unechoed = attempts
      .filter((attempt) => attempt.frame === null)
      .map((attempt) => attempt.plan.documentId)
    if (unechoed.length > 0) {
      requestResync(
        unechoed,
        `transaction ${transactionId} could not be spelled as a listener frame`,
      )
    }

    if (built.length === 0) return []

    for (const entry of Array.from(listeners)) {
      /* Rule 4: the count is per listener filter, exactly as the server scopes it. */
      const matching = built.filter((frame) => entry.ids.has(frame.documentId))
      matching.forEach((frame, index) => {
        try {
          entry.handler({
            ...frame,
            transactionCurrentEvent: index + 1,
            transactionTotalEvents: matching.length,
          })
        } catch (error) {
          noteError(`overlay listener threw: ${String(error)}`)
        }
      })
    }

    const delivered: OverlayMutationEvent[] = []
    built.forEach((frame, index) => {
      const event: OverlayMutationEvent = {
        ...frame,
        transactionCurrentEvent: index + 1,
        transactionTotalEvents: built.length,
      }
      delivered.push(event)
      options.onEmit?.(event, listeners.size)

      if (event.transition === 'disappear') {
        setDocState(event.documentId, {
          rev: undefined,
          updatedAt: event.timestamp,
          doc: undefined,
          synthetic: true,
        })
      } else {
        setDocState(event.documentId, {
          rev: event.resultRev,
          updatedAt: event.timestamp,
          synthetic: true,
        })
      }
    })
    return delivered
  }

  /* ------------------------------------------------------ action plans */

  /** `disappear` frame for one perspective — the shape a real delete carries. */
  function disappearance(documentId: string): PlannedEvent {
    return {documentId, transition: 'disappear', mutations: [{delete: {id: documentId}}]}
  }

  /** The draft a `replaceDraft` targets: its own `_id`, else the derived one. */
  function replaceDraftTarget(action: Rec): string | undefined {
    const attributes = isRec(action.attributes) ? action.attributes : undefined
    if (attributes !== undefined && typeof attributes._id === 'string') return attributes._id
    if (typeof action.publishedId === 'string') return toDraftId(action.publishedId)
    return undefined
  }

  function planActions(payload: unknown): OverlayEchoPlan {
    const actions = Array.isArray(payload)
      ? payload.filter(isRec)
      : isRec(payload)
        ? [payload]
        : []

    /* A restore of a *deleted* document arrives as a guarded create followed by a
     * `replaceDraft` for the same draft. The replaceDraft is a full-body
     * `createOrReplace`, so it subsumes the create; echoing both would emit two
     * frames for one transaction and leave the second unchainable. */
    const supersededCreates = new Set<string>()
    for (const action of actions) {
      if (action.actionType !== 'sanity.action.document.replaceDraft') continue
      const target = replaceDraftTarget(action)
      if (target !== undefined) supersededCreates.add(target)
    }

    const plans: PlannedEvent[] = []
    const unsupported: string[] = []
    const mutationActions: unknown[] = []
    const documentActions: unknown[] = []

    for (const action of actions) {
      const type = typeof action.actionType === 'string' ? action.actionType : '<unknown>'
      const draftId = typeof action.draftId === 'string' ? action.draftId : undefined
      const publishedId = typeof action.publishedId === 'string' ? action.publishedId : undefined
      const versionId = typeof action.versionId === 'string' ? action.versionId : undefined
      const targetId = versionId ?? draftId ?? publishedId

      /* ------------------------------------------------ §18.4 edit */
      if (EDIT_ACTIONS.has(type)) {
        if (!targetId) {
          unsupported.push(`${type}: no target id`)
          continue
        }
        const patch = isRec(action.patch) ? ({...action.patch} as Rec) : {}
        delete patch.id
        delete patch.ifRevisionID
        plans.push({
          documentId: targetId,
          transition: 'update',
          patch,
          ...(publishedId === undefined ? {} : {cloneFrom: publishedId}),
        })
        mutationActions.push(action)
        continue
      }

      /* --------------------------------------------- §18.5 publish */
      if (type === 'sanity.action.document.publish') {
        const draft = draftId ?? (publishedId === undefined ? undefined : toDraftId(publishedId))
        if (!publishedId || !draft) {
          unsupported.push(`${type}: no draft/published id pair`)
          continue
        }
        /* §18.5 order: copy the draft into published *first*, remove it second,
         * so a pane replaying the frames is never momentarily contentless. */
        plans.push({documentId: publishedId, transition: 'update', copyFrom: draft})
        plans.push(disappearance(draft))
        documentActions.push(action)
        continue
      }

      /* ------------------------------------------- §18.6 unpublish */
      if (type === 'sanity.action.document.unpublish') {
        const draft = draftId ?? (publishedId === undefined ? undefined : toDraftId(publishedId))
        if (!publishedId || !draft) {
          unsupported.push(`${type}: no draft/published id pair`)
          continue
        }
        /* §18.6 "[MUST] Remove local published state only after the draft is
         * safely stored" — that ordering rule is these two frames' order. */
        plans.push({documentId: draft, transition: 'appear', copyFrom: publishedId})
        plans.push(disappearance(publishedId))
        documentActions.push(action)
        continue
      }

      /* ---------------------------------------- §18.7 discard draft */
      if (DISCARD_ACTIONS.has(type)) {
        const draft = versionId ?? draftId
        if (!draft) {
          unsupported.push(`${type}: no draft id`)
          continue
        }
        plans.push(disappearance(draft))
        documentActions.push(action)
        continue
      }

      /* ---------------------------------------------- §18.8 delete */
      if (type === 'sanity.action.document.delete') {
        if (!publishedId) {
          unsupported.push(`${type}: no published id`)
          continue
        }
        /* Which drafts exist is Studio's answer, not ours. Inventing a draft
         * frame for a draft that never existed would make the pane apply a
         * delete to nothing. */
        const drafts = Array.isArray(action.includeDrafts)
          ? action.includeDrafts.filter((id): id is string => typeof id === 'string')
          : []
        for (const draft of drafts) plans.push(disappearance(draft))
        plans.push(disappearance(publishedId))
        documentActions.push(action)
        continue
      }

      /* ---------------------- §18.8 restore (history / from deleted) */
      if (type === 'sanity.action.document.replaceDraft') {
        const target = replaceDraftTarget(action)
        const attributes = isRec(action.attributes) ? action.attributes : undefined
        if (!target || attributes === undefined) {
          unsupported.push(`${type}: no restored document body`)
          continue
        }
        plans.push({
          documentId: target,
          transition: 'update',
          mutations: [{createOrReplace: {...attributes, _id: target}}],
        })
        documentActions.push(action)
        continue
      }

      /* ------------------------------------------------- §18.4 create */
      /*
       * A CREATE IS NOT AN OPERATION WITHOUT AN OVERLAY SPELLING. IT IS THE
       * MOST COMMON ONE THERE IS.
       *
       * `sanity@6.8.0`'s first edit of a document that has no published version
       * is `draft.create(...)` followed immediately by `draft.commit()`
       * (`patch.execute`, `lib/datastores-DqFH7RLd.js:2338`), and `toActions`
       * turns that into `sanity.action.document.create` (`:1768`). In Mode 2 no
       * document has a published version, so this is the FIRST transaction of
       * every document in the branch — and it was being committed to the overlay
       * while being reported to the pane as unrepresentable, with no frame.
       *
       * The commit was never the problem: the create was already in
       * `mutationActions` and the bytes always landed. What was missing was the
       * frame, and `create` is the one mutation shape `@sanity/mutator` accepts
       * against a missing HEAD.
       */
      if (type === CREATE_ACTION) {
        const attributes = isRec(action.attributes) ? action.attributes : undefined
        const id =
          attributes !== undefined && typeof attributes._id === 'string' ? attributes._id : undefined
        /* A restore-from-deleted sends a guarded create AND a full-body
         * `replaceDraft` for the same draft; echoing both would put two frames in
         * one transaction and leave the second unchainable. */
        if (id !== undefined && supersededCreates.has(id)) continue
        if (attributes === undefined || id === undefined) {
          /* Nothing to create and nothing to say about it. Refused by name rather
           * than echoed as a guess. */
          mutationActions.push(action)
          unsupported.push(`${type}: no attributes carrying an _id`)
          continue
        }
        plans.push({
          documentId: id,
          transition: 'appear',
          /* The body Studio submitted and the overlay committed. Copied, because
           * `Mutation.compile` writes `_createdAt` into the payload in place. */
          mutations: [{create: {...attributes}}],
        })
        mutationActions.push(action)
        continue
      }

      unsupported.push(type)
    }

    const commits: OverlayCommit[] = []
    if (mutationActions.length > 0) commits.push({kind: 'actions', payload: mutationActions})
    if (documentActions.length > 0) {
      commits.push({kind: 'documentActions', payload: documentActions})
    }
    return {plans, commits, unsupported}
  }

  /* ----------------------------------------------------- mutation plans */

  function documentIdOf(mutation: Rec): string | undefined {
    for (const key of ['patch', 'delete'] as const) {
      const value = mutation[key]
      if (isRec(value) && typeof value.id === 'string') return value.id
    }
    for (const key of ['create', 'createOrReplace', 'createIfNotExists'] as const) {
      const value = mutation[key]
      if (isRec(value) && typeof value._id === 'string') return value._id
    }
    return undefined
  }

  function planMutations(body: unknown): OverlayEchoPlan {
    const mutations =
      isRec(body) && Array.isArray(body.mutations)
        ? body.mutations
        : Array.isArray(body)
          ? body
          : []

    const byDoc = new Map<string, Rec[]>()
    for (const mutation of mutations) {
      if (!isRec(mutation)) continue
      const id = documentIdOf(mutation)
      if (!id) continue
      const list = byDoc.get(id) ?? []
      list.push(mutation)
      byDoc.set(id, list)
    }

    const plans: PlannedEvent[] = Array.from(byDoc.entries()).map(([documentId, entries]) => ({
      documentId,
      transition: 'update' as const,
      mutations: entries,
    }))

    return {
      plans,
      commits:
        mutations.length > 0 ? [{kind: 'mutations' as const, payload: mutations as unknown[]}] : [],
      unsupported: [],
    }
  }

  /**
   * The logical id a duplicate was copied from.
   *
   * Studio's duplicate is `client.create(omit({...source, _id, _type}, [...]))`,
   * so the copy still carries the *source's* `_rev` — the only identifying trace
   * of the original left on the wire. Matching it against the revision store
   * recovers the source id; without a match the write is an ordinary create.
   */
  function duplicateSourceOf(document: Rec): string | undefined {
    const rev = document._rev
    if (typeof rev !== 'string' || rev.length === 0) return undefined
    for (const [id, state] of docs) {
      /* `paneRev` is excluded alongside `synthetic` for the same reason: both
       * mark a revision this overlay minted (§13.9), and a §18.9 duplicate names
       * its source by matching a revision the CONTENT LAKE issued. A duplicate of
       * a branch-only document therefore falls through to an ordinary create —
       * an existing gap, unchanged here, not a consequence of the split. */
      if (state.rev !== rev || state.synthetic === true || state.paneRev === true) continue
      if (id === document._id) continue
      const knownType = state.doc?._type
      if (knownType !== undefined && knownType !== document._type) continue
      return toPublishedId(id)
    }
    return undefined
  }

  function planWrite(method: string, arg: unknown, writeOptions?: unknown): OverlayEchoPlan {
    if (method === 'mutate') {
      return planMutations({mutations: Array.isArray(arg) ? arg : [arg]})
    }

    if (CREATE_METHODS.has(method) && isRec(arg) && typeof arg._id === 'string') {
      const document = arg
      const documentId = document._id as string
      const plans: PlannedEvent[] = [
        {documentId, transition: 'appear', mutations: [{createOrReplace: document}]},
      ]

      const tag = isRec(writeOptions) ? writeOptions.tag : undefined
      const source = tag === DUPLICATE_TAG ? duplicateSourceOf(document) : undefined
      if (source !== undefined) {
        /* §18.9 — core owns "new logical id, base revision metadata removed,
         * origin branch, transforms applied"; this layer only names the source. */
        return {
          plans,
          commits: [
            {
              kind: 'documentActions',
              payload: [
                {
                  actionType: DUPLICATE_ACTION,
                  publishedId: source,
                  newId: toPublishedId(documentId),
                  attributes: document,
                },
              ],
            },
          ],
          unsupported: [],
        }
      }

      return {
        plans,
        commits: [{kind: 'mutations', payload: [{[method]: document}]}],
        unsupported: [],
      }
    }

    if (method === 'delete') {
      const id =
        typeof arg === 'string'
          ? arg
          : isRec(arg) && typeof arg.id === 'string'
            ? arg.id
            : undefined
      if (id === undefined) {
        return {
          plans: [],
          commits: [],
          unsupported: ['delete by query has no overlay equivalent'],
        }
      }
      return {plans: [], commits: [{kind: 'mutations', payload: [{delete: {id}}]}], unsupported: []}
    }

    return {plans: [], commits: [], unsupported: [method]}
  }

  /* ------------------------------------------------------------ public */

  return {
    seedFromResult,
    observeUpstreamEvent,
    getDocState: (id) => docs.get(id),
    revisionOf: (id) => docs.get(id)?.rev,
    revisions: () => {
      const out: Record<string, string | undefined> = {}
      for (const [id, state] of docs) out[id] = state.rev
      return out
    },
    setOverlayDocument: (id, document) => {
      if (document === null) overlayDocs.delete(id)
      else overlayDocs.set(id, document)
    },
    getOverlayDocument: (id) => overlayDocs.get(id),
    setOverlaySuppressed: (id, suppressed) => {
      if (suppressed) overlaySuppressed.add(id)
      else overlaySuppressed.delete(id)
    },
    isOverlaySuppressed: (id) => overlaySuppressed.has(id),
    notePaneSnapshot,
    subscribe,
    subscriberCount: () => listeners.size,
    nextTransactionId: () => {
      txCounter += 1
      return `overlay-${sessionId}-${txCounter}`
    },
    requestResync,
    planActions,
    planMutations,
    planWrite,
    emit,
    sessionState: () => session,
    noteAuthFailure,
    authFailures: () => authFailureLog.map((failure) => ({...failure})),
    restoreSession,
    logout,
    acknowledgeWrite,
  }
}
