// SPIKE A — the listener protocol, extracted from `localEcho.ts` (PRD §21.4.1).
//
// WHY THIS FILE EXISTS
// `localEcho.ts` cannot be unit tested: it needs a live Studio, an rxjs
// constructor captured off a real client, `window`, and an open document pane.
// But the question Gate B actually asks — *do the synthetic listener frames form
// a protocol Studio can converge on?* — is pure data in / data out. So the
// protocol lives here and `localEcho.ts` becomes browser wiring around it.
//
// Same constraint as `overlayTranslate.ts`: this module is imported from three
// runtimes (browser via Vite, plain Node via type stripping, vitest), so it must
// stay dependency-free — no `@sanity/client`, no `sanity-overlay-core`, no
// `node:*`, no `window`, no wall clock that is not injectable.
//
// THE FOUR LOAD-BEARING RULES (evidence: sanity 6.8.0 sources, see
// `listener-event-shapes.md` and `write-block-validation.md`)
//
//  1. The frame must carry Studio's OWN transactionId. `BufferedDocument`
//     generates it and passes it into `client.action(...)`; `consumeUnresolved`
//     matches on it, so a fabricated id leaves the pane unsaved forever.
//  2. `sequentializeListenerEvents` seeds its base revision from the pair
//     snapshot fetch and requires an unbroken `previousRev -> resultRev` chain.
//     Revisions must therefore be learned from real reads, never invented.
//  3. `Document.considerIncoming` only accepts a mutation whose FIRST entry is a
//     create when the document does not exist yet, and drops any frame whose
//     timestamp predates HEAD._updatedAt.
//  4. `transactionTotalEvents` is scoped to the documents matching *that
//     listener's* filter. `allPendingTransactionEventsReceived` buffers a
//     transaction until it has seen that many frames, so a shared count across
//     subscribers parks every pane that only matches part of the transaction.
//     Counters are consequently stamped per subscriber at delivery time.

/* ------------------------------------------------------------------ types */

type Rec = Record<string, unknown>

/** Listener mutation event, matching the shape captured from the pair listener. */
export interface EchoMutationEvent {
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

/** What the echo layer intends to tell Studio about one document. */
export interface PlannedEvent {
  documentId: string
  transition: 'update' | 'appear' | 'disappear'
  /** patch body (without `id`) for edit actions */
  patch?: Rec
  /** pre-built mutations, used by the raw-mutate and document-action paths */
  mutations?: Rec[]
  /** when creating a draft: id of the published document to clone from */
  cloneFrom?: string
  /**
   * Build a `createOrReplace` from the current known body of this document,
   * re-`_id`'d onto {@link PlannedEvent.documentId}. Resolved at delivery time so
   * a publish echoes the body the overlay just persisted, not a stale snapshot.
   */
  copyFrom?: string
}

export interface EchoDocState {
  rev?: string
  updatedAt?: string
  /** last known full document, used to seed a synthetic draft create */
  doc?: Rec
  /** true once the revision chain for this doc is local-echo-owned */
  synthetic?: boolean
}

/**
 * Where the session stands.
 *
 * `active` — the normal state; blocked writes may be acknowledged.
 * `unauthenticated` — a 401/403 was observed. Recoverable: Studio refreshes the
 *   token and calls {@link EchoProtocol.restoreSession}.
 * `logged-out` — terminal for this protocol instance. Studio tore the session
 *   down; a new one arrives with a new page load and a new protocol.
 */
export type EchoSessionState = 'active' | 'unauthenticated' | 'logged-out'

export interface EchoAuthFailure {
  status: number
  /** Which part of the session's own plumbing reported it. */
  source: 'listener' | 'read' | 'write'
  message: string
}

/** Whether a blocked write may be answered with a synthetic success. */
export interface EchoWriteAck {
  ok: boolean
  error?: {status?: number; message: string}
}

/** One `/commit` POST the echo layer owes the overlay server. */
export interface EchoCommit {
  kind: 'actions' | 'mutations' | 'documentActions'
  payload: unknown[]
}

export interface EchoPlan {
  plans: PlannedEvent[]
  commits: EchoCommit[]
  unsupported: string[]
}

export interface EchoSubscription {
  unsubscribe: () => void
}

export interface EchoProtocolOptions {
  /** Injected epoch-ms clock, so frame timestamps are deterministic in tests. */
  now?: () => number
  identity?: string
  onError?: (message: string) => void
  onEmit?: (event: EchoMutationEvent, delivered: number) => void
}

export interface EchoProtocol {
  seedFromResult(value: unknown, authoritative: boolean): void
  observeUpstreamEvent(event: unknown): void
  getDocState(id: string): EchoDocState | undefined
  setDocState(id: string, patch: EchoDocState): void
  revisionOf(id: string): string | undefined
  revisions(): Record<string, string | undefined>
  /** Overlay-materialized bodies, refreshed from every `/commit` response. */
  setOverlayDocument(id: string, document: Rec | null): void
  getOverlayDocument(id: string): Rec | undefined
  subscribe(ids: readonly string[], handler: (event: EchoMutationEvent) => void): EchoSubscription
  subscriberCount(): number
  nextTransactionId(): string
  planActions(payload: unknown): EchoPlan
  planMutations(body: unknown): EchoPlan
  planWrite(method: string, arg: unknown, options?: unknown): EchoPlan
  emit(plans: readonly PlannedEvent[], transactionId: string): EchoMutationEvent[]
  contractVersions(): {sanity: string; client: string}

  /* ------------------------------------------------------------ session */

  sessionState(): EchoSessionState
  /** Record a 401/403 seen anywhere in the session's own plumbing. */
  noteAuthFailure(failure: {
    status: number
    source: EchoAuthFailure['source']
    message?: string
  }): void
  authFailures(): readonly EchoAuthFailure[]
  /** Studio refreshed the token. No-op once the session is logged out. */
  restoreSession(): void
  /** Studio tore the session down: release every pane, deliver nothing more. */
  logout(): void
  /**
   * May a blocked write be answered with the synthetic `{transactionId}` success?
   *
   * `false` is the one answer this layer used to be incapable of giving, and it
   * is the only honest one once the write provably cannot land.
   */
  acknowledgeWrite(): EchoWriteAck
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const GUARD_FIELD = '_empty_action_guard_pseudo_field_'
const DEFAULT_IDENTITY = 'local-echo'

/** The versions §21.4.1's payload contract was captured against. */
const CONTRACT_VERSIONS = {sanity: '6.8.0', client: '7.26.0'} as const

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
/** The overlay's own spelling of §18.9 duplicate, synthesised by {@link planWrite}. */
export const DUPLICATE_ACTION = 'sanity.overlay.document.duplicate'

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPublishedId(id: string): string {
  return id.startsWith('drafts.') ? id.slice('drafts.'.length) : id
}

function toDraftId(id: string): string {
  return id.startsWith('drafts.') ? id : `drafts.${id}`
}

/* ------------------------------------------------------------------ *
 * Auth: recognising a 401/403, and the request paths the facade guards
 * ------------------------------------------------------------------ */

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

/**
 * The 401/403 inside whatever the transport threw, or `undefined`.
 *
 * @sanity/client 7.26.0 surfaces the status in four places depending on where the
 * failure happened: `ClientError.statusCode`, the shared `HttpError.response
 * .statusCode`, the API error body (`details` / `response.body`, shaped
 * `{error, message, statusCode}`), and a bare `fetch` Response's `status` when
 * the overlay server is being called directly. All four are checked.
 *
 * Deliberately narrow: a false positive stops every subsequent write in the
 * session, so a 500, a `TypeError: fetch failed`, or the digits "401" inside a
 * message must all read as *not* an auth failure.
 */
export function authStatusOf(error: unknown): number | undefined {
  if (!isRec(error)) return undefined
  const candidates: unknown[] = [error, error.response, error.details]
  if (isRec(error.response)) candidates.push(error.response.body)
  for (const candidate of candidates) {
    const status = authStatusIn(candidate)
    if (status !== undefined) return status
  }
  return undefined
}

/**
 * Normalise a `client.request({url | uri})` target down to a comparable path.
 *
 * Gate E's hardened Spike F found the facade's write guard escapable by a
 * *leading-slash-less* `request` to `/data/mutate` — a raw substring/regex test
 * against the caller's spelling. Any guard built on this function inherits one
 * normalisation instead of re-deriving it, so the whole variant family (absolute
 * URL, missing or doubled slash, trailing slash, query, fragment, case,
 * `.`/`..` segments, percent-encoding) collapses to the same string.
 *
 * Over-normalising is the safe direction here: a shortened path still matches
 * the guarded prefixes, so it fails closed.
 */
export function requestPath(target: unknown): string {
  if (typeof target !== 'string') return '/'
  let value = target.trim()

  /* Absolute URL: drop scheme and authority, keep the path. */
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
  if (scheme) {
    const rest = value.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    value = slash === -1 ? '' : rest.slice(slash)
  }

  try {
    value = decodeURIComponent(value)
  } catch {
    /* malformed escape — compare the raw spelling rather than give up */
  }

  const cut = Math.min(
    ...[value.indexOf('?'), value.indexOf('#')].map((at) => (at === -1 ? value.length : at)),
  )
  value = value.slice(0, cut)

  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`.toLowerCase()
}

/** `/data/mutate` and `/data/actions` — the write endpoints, at any API version. */
const MUTATION_PATH_RE = /(^|\/)data\/(mutate|actions)(\/|$)/

/** `/auth/logout` — sanity 6.8.0's own logout call (`WorkspaceLoader`, `logout()`). */
const LOGOUT_PATH_RE = /(^|\/)auth\/logout(\/|$)/

export function isMutationEndpoint(target: unknown): boolean {
  return MUTATION_PATH_RE.test(requestPath(target))
}

export function isLogoutEndpoint(target: unknown): boolean {
  return LOGOUT_PATH_RE.test(requestPath(target))
}

/* ------------------------------------------------------------------ *
 * The protocol
 * ------------------------------------------------------------------ */

export function createEchoProtocol(options: EchoProtocolOptions = {}): EchoProtocol {
  const clock = options.now ?? (() => Date.now())
  const identity = options.identity ?? DEFAULT_IDENTITY
  const noteError = options.onError ?? ((): void => {})

  const docs = new Map<string, EchoDocState>()
  /** Bodies the overlay server materialized, keyed as Studio addresses them. */
  const overlayDocs = new Map<string, Rec>()
  const listeners = new Set<{ids: Set<string>; handler: (event: EchoMutationEvent) => void}>()
  /** Transactions already delivered — a replay must never become a second frame. */
  const emitted = new Set<string>()

  let txCounter = 0

  /* ----------------------------------------------------------- session */

  let session: EchoSessionState = 'active'
  const authFailureLog: EchoAuthFailure[] = []

  function noteAuthFailure(failure: {
    status: number
    source: EchoAuthFailure['source']
    message?: string
  }): void {
    const message = failure.message ?? `HTTP ${failure.status}`
    authFailureLog.push({status: failure.status, source: failure.source, message})
    noteError(
      `auth failure ${failure.status} on the ${failure.source}: ${message} — the session is no ` +
        `longer authorized, so writes will not be acknowledged until the token is refreshed`,
    )
    /* Logout is terminal: a stale in-flight 401 must not downgrade it to a
     * merely-recoverable state and let a later `restoreSession` resurrect it. */
    if (session !== 'logged-out') session = 'unauthenticated'
  }

  function restoreSession(): void {
    if (session === 'unauthenticated') session = 'active'
  }

  function logout(): void {
    if (session === 'logged-out') return
    session = 'logged-out'
    /* Criterion 4's rule applied to the whole session: releasing here is what
     * makes "no further events are delivered" true even for a pane that never
     * got the chance to unsubscribe itself. */
    listeners.clear()
    noteError(
      'session logged out: every pair-listener subscription is released and no further ' +
        'write will be acknowledged',
    )
  }

  /**
   * The revision store is deliberately left alone by both transitions.
   *
   * An expired token says nothing about what the Content Lake holds, and a
   * dropped or invented revision would only show up 30 s later as a
   * `sequentializeListenerEvents` deadline, far from its cause.
   */
  function acknowledgeWrite(): EchoWriteAck {
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
      const status = last?.status
      return {
        ok: false,
        error: {
          status,
          message:
            `the session is not authenticated (HTTP ${status ?? '401/403'}): this write cannot ` +
            'be persisted and must not be reported to the editor as saved',
        },
      }
    }
    return {ok: true}
  }

  /* --------------------------------------------------------- revisions */

  function setDocState(id: string, patch: EchoDocState): void {
    docs.set(id, {...(docs.get(id) ?? {}), ...patch})
  }

  /**
   * `authoritative` = this read is the thing Studio itself resets its base
   * revision from (the pair listener's `getDocuments` snapshot fetch). A
   * non-authoritative read still returns the STALE server revision once writes
   * are blocked; letting it overwrite a synthetic revision would silently break
   * the chain and blow up 30 s later in `sequentializeListenerEvents`.
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
    handler: (event: EchoMutationEvent) => void,
  ): EchoSubscription {
    /* After logout the session is over: a late subscription (a pane torn down
     * asynchronously, a retrying listener) must not re-open a delivery channel. */
    if (session === 'logged-out') return {unsubscribe: () => {}}
    const entry = {ids: new Set(ids), handler}
    listeners.add(entry)
    let released = false
    return {
      unsubscribe: () => {
        if (released) return
        released = true
        listeners.delete(entry)
      },
    }
  }

  /* -------------------------------------------------------- frame build */

  /**
   * `Document.considerIncoming` drops incoming mutations whose timestamp predates
   * HEAD._updatedAt. Guard against a frozen or skewed clock by always moving
   * forward relative to the revision store's own view.
   */
  function nextTimestamp(state: EchoDocState | undefined): string {
    const wall = clock()
    const known = state?.updatedAt ? Date.parse(state.updatedAt) : NaN
    const ms = Number.isFinite(known) && known >= wall ? known + 1 : wall
    return new Date(ms).toISOString()
  }

  /**
   * The body a `copyFrom` / `cloneFrom` plan promotes.
   *
   * The overlay server's materialization wins, because it is the only party that
   * ran the intercepted patches through core. The last read snapshot is the
   * fallback — correct only while nothing has been edited, so a *synthetic*
   * revision on the source means the snapshot is provably behind and the caller
   * is told. Reported rather than refused: a publish that never settles is worse
   * for the user than one that settles on visibly stale content.
   */
  function bodyFor(id: string): Rec | undefined {
    const stored = overlayDocs.get(id)
    if (stored !== undefined) return stored
    const state = docs.get(id)
    if (state?.doc !== undefined && state.synthetic === true) {
      noteError(
        `echoing ${id} from a stale snapshot: this document has local edits the echo layer ` +
          `never materialized. Enable SPIKE_OVERLAY_PERSIST=1 so the overlay server can ` +
          `supply the current body.`,
      )
    }
    return state?.doc
  }

  function buildFrame(
    plan: PlannedEvent,
    transactionId: string,
  ): Omit<EchoMutationEvent, 'transactionCurrentEvent' | 'transactionTotalEvents'> | null {
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
            `(open the document pane first so the pair snapshot fetch can seed it)`,
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
      // Existing document: guard patch + real patch, exactly as captured from the
      // live pair listener (the Actions API always prepends the guard unset).
      mutations = [
        {patch: {id: plan.documentId, unset: [GUARD_FIELD], unsetIsEmpty: false}},
        {patch: {id: plan.documentId, unsetIsEmpty: false, ...(plan.patch ?? {})}},
      ]
    } else {
      // Document not known / does not exist: the Actions API edit creates the
      // draft from the current published version first. Reproduce that, otherwise
      // @sanity/mutator refuses the event (appliesToMissingDocument === false).
      const base = plan.cloneFrom ? bodyFor(plan.cloneFrom) : undefined
      if (!base) {
        noteError(
          `cannot echo ${plan.documentId}: no known revision and no published base to clone ` +
            `(open the document pane first so the pair snapshot fetch can seed it)`,
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
      eventId: `${transactionId}#${plan.documentId}@local`,
      documentId: plan.documentId,
      transactionId,
      transition,
      identity,
      mutations,
      // Omitted entirely (not `undefined`-valued) when unknown:
      // `sequentializeListenerEvents` compares `base.revision === chain[0].previousRev`,
      // and a missing draft has base revision `undefined`.
      ...(previousRev ? {previousRev} : {}),
      resultRev: transactionId,
      timestamp,
      visibility: 'transaction',
      projection: null,
      // `effects` deliberately omitted — only the global preview listener consumes
      // mendoza, and it never receives synthetic frames.
    }
  }

  /* -------------------------------------------------------------- emit */

  function emit(plans: readonly PlannedEvent[], transactionId: string): EchoMutationEvent[] {
    if (plans.length === 0) return []
    /* Checked before `emitted` is touched, so a logged-out emit leaves no trace
     * at all: neither a delivered frame nor a revision the next session would
     * have to chain off but no pane ever saw. */
    if (session === 'logged-out') return []
    /* Rule: one transaction, one delivery. Studio may subscribe to a blocked
     * write's result observable more than once, and a retried commit reuses the
     * id; a second frame would apply the same mutation to HEAD twice and break
     * the chain on the next edit. */
    if (emitted.has(transactionId)) return []
    emitted.add(transactionId)

    /* Built before anything is delivered, so every frame in a transaction chains
     * off the revision that was current when the transaction started. */
    const built = plans
      .map((plan) => buildFrame(plan, transactionId))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
    if (built.length === 0) return []

    for (const entry of Array.from(listeners)) {
      // Rule 4: the count is per listener filter, exactly as the server scopes it.
      const matching = built.filter((frame) => entry.ids.has(frame.documentId))
      matching.forEach((frame, index) => {
        try {
          entry.handler({
            ...frame,
            transactionCurrentEvent: index + 1,
            transactionTotalEvents: matching.length,
          })
        } catch (error) {
          noteError(`echo listener threw: ${String(error)}`)
        }
      })
    }

    const delivered: EchoMutationEvent[] = []
    built.forEach((frame, index) => {
      const event: EchoMutationEvent = {
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

  function planActions(payload: unknown): EchoPlan {
    const actions = Array.isArray(payload)
      ? payload.filter(isRec)
      : isRec(payload)
        ? [payload]
        : []

    /* A restore of a *deleted* document arrives as a guarded create followed by a
     * `replaceDraft` for the same draft (`historyStore.restore`, `fromDeleted`).
     * The replaceDraft is a full-body `createOrReplace`, so it subsumes the
     * create; echoing both would emit two frames for one transaction and leave
     * the second unchainable. */
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
        // §18.5 order: copy the draft into published *first*, remove it second, so
        // a pane replaying the frames is never momentarily contentless.
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
        // §18.6 "[MUST] Remove local published state only after the draft is
        // safely stored" — that ordering rule is these two frames' order.
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
        /* Which drafts exist is Studio's answer, not ours: `del.execute` fills
         * `includeDrafts` from its own snapshots. Inventing a draft frame for a
         * draft that never existed would make the pane apply a delete to nothing. */
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
        const id = attributes !== undefined && typeof attributes._id === 'string' ? attributes._id : undefined
        if (id !== undefined && supersededCreates.has(id)) continue
        /* A standalone create is already persisted as a `create` mutation by
         * `translateActions`; it has no echo yet, so it stays reported. */
        mutationActions.push(action)
        unsupported.push(type)
        continue
      }

      unsupported.push(type)
    }

    const commits: EchoCommit[] = []
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

  function planMutations(body: unknown): EchoPlan {
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

    const plans = Array.from(byDoc.entries()).map(([documentId, entries]) => ({
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
   * Studio's duplicate is `client.create(omit({...source, _id, _type}, ['_createdAt',
   * '_updatedAt', '_system']))` — so the copy still carries the *source's* `_rev`,
   * which is the only identifying trace of the original left on the wire. Matching
   * it against the revision store recovers the source id; without a match the
   * write is an ordinary create and is persisted as one.
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

  const CREATE_METHODS = new Set(['create', 'createOrReplace', 'createIfNotExists'])

  function planWrite(method: string, arg: unknown, writeOptions?: unknown): EchoPlan {
    if (method === 'mutate') {
      return planMutations({mutations: Array.isArray(arg) ? arg : [arg]})
    }

    if (CREATE_METHODS.has(method) && isRec(arg) && typeof arg._id === 'string') {
      const document = arg
      const documentId = document._id as string
      const plans: PlannedEvent[] = [
        {
          documentId,
          transition: 'appear',
          mutations: [{createOrReplace: document}],
        },
      ]

      const tag = isRec(writeOptions) ? writeOptions.tag : undefined
      const source = tag === DUPLICATE_TAG ? duplicateSourceOf(document) : undefined
      if (source !== undefined) {
        // §18.9 — core owns "new logical id, base revision metadata removed,
        // origin branch, transforms applied"; the spike only names the source.
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

      return {plans, commits: [{kind: 'mutations', payload: [{[method]: document}]}], unsupported: []}
    }

    if (method === 'delete') {
      const id = typeof arg === 'string' ? arg : isRec(arg) && typeof arg.id === 'string' ? arg.id : undefined
      if (id === undefined) {
        return {plans: [], commits: [], unsupported: ['delete by query has no overlay equivalent']}
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
    setDocState,
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
    subscribe,
    subscriberCount: () => listeners.size,
    nextTransactionId: () => {
      txCounter += 1
      const suffix = ((txCounter * 2654435761) % 4294967296).toString(36).padStart(6, '0').slice(-6)
      return `local-echo-${txCounter}-${suffix}`
    },
    planActions,
    planMutations,
    planWrite,
    emit,
    contractVersions: () => ({...CONTRACT_VERSIONS}),
    sessionState: () => session,
    noteAuthFailure,
    authFailures: () => authFailureLog.map((failure) => ({...failure})),
    restoreSession,
    logout,
    acknowledgeWrite,
  }
}

export {toDraftId, toPublishedId}
