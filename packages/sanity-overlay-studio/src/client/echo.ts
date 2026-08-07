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
  subscribe(
    ids: readonly string[],
    handler: (event: OverlayMutationEvent) => void,
  ): OverlaySubscription
  subscriberCount(): number
  nextTransactionId(): string
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
    handler: (event: OverlayMutationEvent) => void
  }>()
  /** Transactions already delivered — a replay must never become a second frame. */
  const emitted = new Set<string>()

  let txCounter = 0
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
    if (!authoritative && current?.synthetic) return
    setDocState(id, {
      rev: typeof value._rev === 'string' ? value._rev : undefined,
      updatedAt: typeof value._updatedAt === 'string' ? value._updatedAt : undefined,
      doc: authoritative ? value : current?.doc,
      synthetic: false,
    })
  }

  function seedFromResult(value: unknown, authoritative: boolean): void {
    if (Array.isArray(value)) {
      for (const item of value) seedFromDocument(item, authoritative)
      return
    }
    seedFromDocument(value, authoritative)
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
    handler: (event: OverlayMutationEvent) => void,
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

  function buildFrame(
    plan: PlannedEvent,
    transactionId: string,
  ): Omit<OverlayMutationEvent, 'transactionCurrentEvent' | 'transactionTotalEvents'> | null {
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
      const copy: Rec = {...source, _id: plan.documentId}
      delete copy._rev
      delete copy._updatedAt
      delete copy._createdAt
      mutations = [{createOrReplace: copy}]
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
      /* Document unknown: the Actions API edit creates the draft from the current
       * published version first. Reproduce that, otherwise @sanity/mutator
       * refuses the event (`appliesToMissingDocument === false`). */
      const base = plan.cloneFrom ? bodyFor(plan.cloneFrom) : undefined
      if (!base) {
        noteError(
          `cannot echo ${plan.documentId}: no known revision and no published base to clone ` +
            `(open the document pane first so the snapshot fetch can seed it)`,
        )
        return null
      }
      const seed: Rec = {...base, _id: plan.documentId}
      delete seed._rev
      mutations = [
        {createIfNotExists: seed},
        {patch: {id: plan.documentId, unsetIsEmpty: false, ...(plan.patch ?? {})}},
      ]
      transition = 'appear'
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
    const built = plans
      .map((plan) => buildFrame(plan, transactionId))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
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

      if (type === 'sanity.action.document.create') {
        const attributes = isRec(action.attributes) ? action.attributes : undefined
        const id =
          attributes !== undefined && typeof attributes._id === 'string' ? attributes._id : undefined
        if (id !== undefined && supersededCreates.has(id)) continue
        mutationActions.push(action)
        unsupported.push(type)
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
      if (state.rev !== rev || state.synthetic === true) continue
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
    subscribe,
    subscriberCount: () => listeners.size,
    nextTransactionId: () => {
      txCounter += 1
      const suffix = ((txCounter * 2654435761) % 4294967296).toString(36).padStart(6, '0').slice(-6)
      return `overlay-${txCounter}-${suffix}`
    },
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
