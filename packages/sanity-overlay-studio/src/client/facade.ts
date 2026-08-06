/**
 * The overlay client facade — PRD §21.4 / §21.5 Strategy A.
 *
 * Every `SanityClient` Studio holds descends from `unstable_clientFactory`, so
 * wrapping there covers 100% of Studio's client traffic. This module is that
 * wrapper. Its contract:
 *
 *   - a **write** never reaches the real client. It is planned into overlay
 *     operations, committed to the overlay API, echoed back to the document
 *     pane, and answered with a synthetic `{transactionId}` success — or refused
 *     honestly when the overlay has no spelling for it.
 *   - a **read** is delegated, with the overlay's materialization substituted
 *     where it has one.
 *   - the two **session signals** (`/auth/logout`, the identity probes) are
 *     observed in passing and never altered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDENTITY STABILITY IS LOAD-BEARING, NOT AN OPTIMISATION.
 *
 * sanity 6.8.0 reads client properties inside React effect dependency arrays on
 * every render (`lib/LiveQueries-rJao7vYj.js:36-45`):
 *
 *     useEffect(() => { client.live.events(…).subscribe(…) }, [client.live])
 *
 * A Proxy that mints a fresh function or sub-proxy per property access therefore
 * tears that effect down and re-subscribes on every render — unbounded, main
 * thread saturated, black screen. So: one proxy per target, one wrapper function
 * per method, both memoised in module-level WeakMaps. Pinned at 20 000 renders
 * in `test/studio-facade.test.ts`, with an identity-unstable wrapper as the
 * negative control.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  authStatusOf,
  type OverlayEcho,
  type OverlayEchoPlan,
  type PlannedEvent,
} from './echo'
import type {OverlayTransport, OverlayTransportResult} from './transport'
import {
  classifyWriteEndpoint,
  identityProofFrom,
  isIdentityProbeEndpoint,
  isLogoutEndpoint,
  namespaceMethodKind,
  NAMESPACE_ROOTS,
  NESTED_NAMESPACES,
  type WritePlane,
} from './writeGuard'

type Rec = Record<string, unknown>

/** One intercepted write, as the status banner sees it. */
export interface OverlayWriteRecord {
  method: string
  transactionId: string
  /** Did the echo produce at least one listener frame for the pane? */
  echoed: boolean
  committed: 'ok' | 'degraded' | 'fatal' | 'refused'
  unsupported: string[]
  at: number
}

export interface OverlayFacadeOptions {
  echo: OverlayEcho
  transport: OverlayTransport
  onError?: (message: string) => void
  onWrite?: (record: OverlayWriteRecord) => void
  /** Injected clock for the write ledger. */
  now?: () => number
}

/* ------------------------------------------------------------ observables */

interface MinimalSubscriber<T> {
  next?: (value: T) => void
  error?: (error: unknown) => void
  complete?: () => void
}

interface MinimalSubscription {
  unsubscribe: () => void
}

interface MinimalObservable<T> {
  subscribe: (observer: MinimalSubscriber<T> | ((value: T) => void)) => MinimalSubscription
}

function normalizeObserver<T>(
  observer: MinimalSubscriber<T> | ((value: T) => void),
): MinimalSubscriber<T> {
  return typeof observer === 'function' ? {next: observer} : observer
}

/**
 * A cold observable with just enough of the contract for Studio's consumers.
 *
 * Deliberately minimal rather than rxjs: this package must not add a dependency
 * the consumer's Studio does not already pin, and every consumer of these values
 * inside Studio calls `.subscribe()`.
 */
function makeObservable<T>(
  onSubscribe: (subscriber: Required<MinimalSubscriber<T>>) => (() => void) | void,
): MinimalObservable<T> {
  return {
    subscribe(observer) {
      const target = normalizeObserver(observer)
      let closed = false
      const safe = {
        next: (value: T): void => {
          if (!closed) target.next?.(value)
        },
        error: (error: unknown): void => {
          if (!closed) target.error?.(error)
        },
        complete: (): void => {
          if (!closed) target.complete?.()
        },
      }
      const teardown = onSubscribe(safe)
      return {
        unsubscribe: (): void => {
          if (closed) return
          closed = true
          teardown?.()
        },
      }
    },
  }
}

function observableOf<T>(value: T, onDelivered?: () => void): MinimalObservable<T> {
  return makeObservable<T>((subscriber) => {
    subscriber.next(value)
    subscriber.complete()
    onDelivered?.()
  })
}

function observableThrowing<T>(error: unknown): MinimalObservable<T> {
  return makeObservable<T>((subscriber) => {
    subscriber.error(error)
  })
}

function isObservableLike(value: unknown): value is MinimalObservable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Rec).subscribe === 'function'
  )
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Rec).then === 'function'
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ---------------------------------------------------------------- policy */

type Kind = 'promise' | 'observable'

const WRITE_METHODS = new Set([
  'create',
  'createIfNotExists',
  'createOrReplace',
  'delete',
  'mutate',
])

const READ_TAP_METHODS = new Set(['getDocument', 'getDocuments'])
const MUTATING_DATA_ENDPOINTS = new Set(['mutate', 'actions'])
const CLONING_METHODS = new Set(['withConfig', 'clone', 'withUrlSourceMapping'])

const UNECHOABLE_REASON: Readonly<Record<WritePlane, string>> = Object.freeze({
  documents: 'this document write could not be planned',
  asset: 'asset uploads are binary and live outside the document overlay',
  'agent-action': 'Agent Actions mutate documents server-side, where the overlay cannot follow',
  'dataset-admin': 'dataset administration is a project-plane operation, not a document edit',
})

function namespaceRefusalReason(path: string): string {
  if (path === 'assets') return UNECHOABLE_REASON.asset
  if (path === 'agent.action') return UNECHOABLE_REASON['agent-action']
  if (path === 'datasets') return UNECHOABLE_REASON['dataset-admin']
  if (path === 'releases') {
    return 'Content Releases are hosted version infrastructure the overlay does not reproduce'
  }
  return 'this namespace method is not one the overlay knows how to represent'
}

/** `*[_id in $ids]` — the document *pair* listener, the only one worth echoing. */
const PAIR_QUERY_RE = /^\*\[\s*_id\s+in\s+\$ids\s*\]$/

/* ------------------------------------------------------------ the facade */

/** One wrapper per real client, so `wrapWithOverlay(x)` is referentially stable. */
const facadeCache = new WeakMap<object, object>()

export function wrapWithOverlay<T extends object>(client: T, options: OverlayFacadeOptions): T {
  const cached = facadeCache.get(client)
  if (cached) return cached as T
  const facade = createFacade(options)
  const proxy = facade.wrap(client, 'promise')
  facadeCache.set(client, proxy)
  return proxy
}

function createFacade(options: OverlayFacadeOptions): {
  wrap: <T extends object>(target: T, kind: Kind) => T
} {
  const {echo, transport} = options
  const noteError = options.onError ?? ((): void => {})
  const clock = options.now ?? ((): number => Date.now())

  /* Per-facade caches. Module-level would be wrong: two workspaces get two
   * facades, and their proxies must not be shared. */
  const proxyCache = new WeakMap<object, object>()
  const methodCache = new WeakMap<object, Map<PropertyKey, unknown>>()
  const namespaceCache = new WeakMap<object, object>()
  const namespaceMethodCache = new WeakMap<object, Map<PropertyKey, unknown>>()

  function recordWrite(record: OverlayWriteRecord): void {
    options.onWrite?.(record)
  }

  function noteAuthFailureFrom(error: unknown, source: 'listener' | 'read' | 'write'): void {
    const status = authStatusOf(error)
    if (status === undefined) return
    echo.noteAuthFailure({
      status,
      source,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /* ------------------------------------------------------ commit + echo */

  /**
   * Persist a planned write, then echo it.
   *
   * ORDER MATTERS. The echo runs *after* the commit answers, so `copyFrom` /
   * `cloneFrom` frames are built from the body the overlay actually
   * materialized rather than a stale read snapshot (a publish, for instance,
   * must echo the edited draft, not the version the pane last fetched).
   */
  async function persistAndEcho(
    method: string,
    plan: OverlayEchoPlan,
    transactionId: string,
  ): Promise<void> {
    let committed: OverlayWriteRecord['committed'] = 'ok'

    for (const commit of plan.commits) {
      const result: OverlayTransportResult = await transport.commit(commit, {
        idempotencyKey: transactionId,
        baseDocuments: baseDocumentsFor(plan.plans),
      })
      if (result.outcome === 'fatal') {
        committed = 'fatal'
        echo.noteAuthFailure({
          status: result.status ?? 401,
          source: 'write',
          message: result.message ?? 'the overlay API rejected the write',
        })
        break
      }
      if (result.outcome === 'degraded') committed = 'degraded'
      for (const document of result.documents ?? []) {
        if (document.draft !== undefined) {
          echo.setOverlayDocument(`drafts.${document.logicalId}`, document.draft ?? null)
        }
        if (document.published !== undefined) {
          echo.setOverlayDocument(document.logicalId, document.published ?? null)
        }
      }
      for (const entry of result.unsupported ?? []) {
        noteError(
          `[sanity-overlay-studio] the overlay could not represent ${entry}; the editor's view ` +
            `and the overlay may now differ for that operation`,
        )
      }
    }

    const frames = committed === 'fatal' ? [] : echo.emit(plan.plans, transactionId)

    recordWrite({
      method,
      transactionId,
      echoed: frames.length > 0,
      committed,
      unsupported: plan.unsupported,
      at: clock(),
    })
  }

  /** The base documents core needs as a merge ancestor for the touched ids. */
  function baseDocumentsFor(plans: readonly PlannedEvent[]): Rec[] {
    const ids = new Set<string>()
    for (const plan of plans) {
      ids.add(plan.documentId)
      if (plan.cloneFrom) ids.add(plan.cloneFrom)
      if (plan.copyFrom) ids.add(plan.copyFrom)
    }
    const out: Rec[] = []
    for (const id of ids) {
      const state = echo.getDocState(id)
      if (state?.doc !== undefined && state.synthetic !== true) out.push(state.doc)
    }
    return out
  }

  /**
   * The one answer this layer must be capable of giving: **no**.
   *
   * A blocked write is answered with a synthetic success only while it is going
   * somewhere. Once the session is provably unable to persist it, telling Studio
   * "saved" makes the editor lie to the user about content that exists nowhere.
   */
  function blockedResult(
    kind: Kind,
    method: string,
    plan: OverlayEchoPlan,
    transactionId: string,
    withDocuments: boolean,
  ): unknown {
    const ack = echo.acknowledgeWrite()
    if (!ack.ok) {
      const error = Object.assign(
        new Error(
          `[sanity-overlay-studio] refusing to acknowledge ${method}: ${ack.error?.message ?? 'the session cannot persist writes'}`,
        ),
        ack.error?.status === undefined ? {} : {statusCode: ack.error.status},
      )
      noteError(error.message)
      recordWrite({
        method,
        transactionId,
        echoed: false,
        committed: 'refused',
        unsupported: plan.unsupported,
        at: clock(),
      })
      return kind === 'observable' ? observableThrowing(error) : Promise.reject(error)
    }

    if (plan.unsupported.length > 0) {
      noteError(
        `[sanity-overlay-studio] ${method} contains operations with no overlay spelling: ` +
          `${plan.unsupported.join(', ')}`,
      )
    }

    const value: Rec = {transactionId, ...(withDocuments ? {documentIds: [], results: []} : {})}
    const run = (): void => {
      void persistAndEcho(method, plan, transactionId)
    }

    /* The echo is scheduled on delivery, not before: Studio's `consumeUnresolved`
     * matches the frame against a transaction it has only registered once the
     * write's result has been observed. */
    return kind === 'observable'
      ? observableOf(value, run)
      : Promise.resolve().then(() => {
          run()
          return value
        })
  }

  function refuseUnechoable(kind: Kind, label: string, reason: string): unknown {
    const error = new Error(
      `[sanity-overlay-studio] blocked ${label}: ${reason}. Letting it through would put the ` +
        `editor and the overlay out of sync, and could write to the shared dataset.`,
    )
    noteError(error.message)
    return kind === 'observable' ? observableThrowing(error) : Promise.reject(error)
  }

  /* ------------------------------------------------------------- taps */

  /**
   * Watch an identity probe go by and, if it proves a live credential, bring the
   * session back. A TAP: the response is forwarded untouched, errors included.
   *
   * The signal is Studio's own — after a 401 it refreshes the token and the
   * reissued token drives `GET /users/me` (or `/auth/id`). So this piggybacks on
   * a round trip that already happens at exactly the right moment and polls
   * nothing.
   */
  function tapIdentityProbe(result: unknown, label: string): unknown {
    const observed = (value: unknown): void => {
      if (identityProofFrom(value) === undefined) return
      if (echo.sessionState() !== 'unauthenticated') return
      echo.restoreSession()
      noteError(`[sanity-overlay-studio] ${label} returned a live identity — writes resume`)
    }

    if (isObservableLike(result)) {
      const source = result
      return makeObservable((subscriber) => {
        const subscription = source.subscribe({
          next: (value) => {
            observed(value)
            subscriber.next(value)
          },
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        })
        return () => subscription.unsubscribe()
      })
    }
    if (isPromiseLike(result)) {
      return result.then((value) => {
        observed(value)
        return value
      })
    }
    observed(result)
    return result
  }

  /**
   * Learn revisions from a read; substitute the overlay body where we have one.
   *
   * `authoritative` marks the ONE read Studio itself resets its base revision
   * from — the pair listener's `getDocuments` snapshot fetch. Every other read
   * still returns the *stale* Content Lake revision once writes are intercepted,
   * so letting one overwrite an echo-owned revision breaks the
   * `previousRev -> resultRev` chain. That failure only surfaces ~30 s later as a
   * `sequentializeListenerEvents` deadline, which reads as a hang rather than a
   * bug — so it is fenced here rather than diagnosed there.
   */
  function tapRead(result: unknown, requestedIds: string[], authoritative: boolean): unknown {
    const substitute = (value: unknown): unknown => {
      echo.seedFromResult(value, authoritative)
      if (Array.isArray(value)) {
        return value.map((entry) => substituteOne(entry))
      }
      return substituteOne(value)
    }

    const substituteOne = (value: unknown): unknown => {
      if (!isRec(value) || typeof value._id !== 'string') {
        /* `getDocument` on a missing document answers `undefined`; the overlay
         * may still hold a branch-created body for the requested id. */
        if (value === undefined && requestedIds.length === 1) {
          return echo.getOverlayDocument(requestedIds[0]) ?? value
        }
        return value
      }
      return echo.getOverlayDocument(value._id) ?? value
    }

    if (isPromiseLike(result)) {
      return result.then(substitute, (error: unknown) => {
        noteAuthFailureFrom(error, 'read')
        throw error
      })
    }
    if (isObservableLike(result)) {
      const source = result
      return makeObservable((subscriber) => {
        const subscription = source.subscribe({
          next: (value) => subscriber.next(substitute(value)),
          error: (error) => {
            noteAuthFailureFrom(error, 'read')
            subscriber.error(error)
          },
          complete: () => subscriber.complete(),
        })
        return () => subscription.unsubscribe()
      })
    }
    return substitute(result)
  }

  function tapReadErrors(result: unknown): unknown {
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          echo.seedFromResult(value, false)
          return value
        },
        (error: unknown) => {
          noteAuthFailureFrom(error, 'read')
          throw error
        },
      )
    }
    if (isObservableLike(result)) {
      const source = result
      return makeObservable((subscriber) => {
        const subscription = source.subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => {
            noteAuthFailureFrom(error, 'read')
            subscriber.error(error)
          },
          complete: () => subscriber.complete(),
        })
        return () => subscription.unsubscribe()
      })
    }
    return result
  }

  /* ------------------------------------------------------------- listen */

  /**
   * Merge the real listener with the overlay's local update channel (§21.9).
   *
   * The Content Lake never saw the intercepted mutation, so the real listener
   * will never report it; without this merge the pane would sit at "Saving…"
   * forever. Only the document *pair* listener gets a local channel — a
   * type-wide listener has no transaction the pane is waiting on.
   */
  function wrapListen(
    real: (...args: unknown[]) => unknown,
    self: object,
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]): unknown => {
      const query = args[0]
      const params = args[1]
      const ids =
        typeof query === 'string' &&
        PAIR_QUERY_RE.test(query.trim()) &&
        isRec(params) &&
        Array.isArray(params.ids)
          ? params.ids.filter((id): id is string => typeof id === 'string')
          : []

      const upstream = real.apply(self, args)
      if (ids.length === 0) return tapReadErrors(upstream)

      return makeObservable((subscriber) => {
        const local = echo.subscribe(ids, (event) => subscriber.next(event))
        let remote: MinimalSubscription | null = null
        if (isObservableLike(upstream)) {
          remote = upstream.subscribe({
            next: (event) => {
              echo.observeUpstreamEvent(event)
              subscriber.next(event)
            },
            error: (error) => {
              noteAuthFailureFrom(error, 'listener')
              subscriber.error(error)
            },
          })
        }
        return () => {
          local.unsubscribe()
          remote?.unsubscribe()
        }
      })
    }
  }

  /* -------------------------------------------------- fluent builders */

  /**
   * Block `.commit()` on a `patch()` / `transaction()` builder.
   *
   * The builder is the *other* way a write leaves the client, and it holds the
   * mutation list internally. `serialize()` is `@sanity/client`'s own accessor
   * for it, so the plan is built from the real operations rather than guessed.
   */
  function blockFluentCommit<B extends object>(builder: B, label: string, kind: Kind): B {
    const cachedBuilder = proxyCache.get(builder)
    if (cachedBuilder) return cachedBuilder as B

    const proxy = new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop)
        const name = String(prop)
        if (typeof value !== 'function') return value

        let perTarget = methodCache.get(target)
        if (!perTarget) {
          perTarget = new Map()
          methodCache.set(target, perTarget)
        }
        const existing = perTarget.get(prop)
        if (existing) return existing

        const fn = value as (...args: unknown[]) => unknown
        let wrapped: (...args: unknown[]) => unknown

        if (name === 'commit') {
          wrapped = (...args: unknown[]): unknown => {
            const mutations = serializeBuilder(target)
            const transactionId =
              transactionIdFromOptions(args[0]) ?? echo.nextTransactionId()
            const plan = echo.planMutations({mutations})
            return blockedResult(kind, label, plan, transactionId, true)
          }
        } else {
          wrapped = (...args: unknown[]): unknown => {
            const result = fn.apply(target, args)
            /* Builders are fluent: `set()` returns the builder. Re-wrap so the
             * chain cannot hand back an unguarded `commit`. */
            return result === target || (isRec(result) && typeof result.commit === 'function')
              ? blockFluentCommit(result as object, label, kind)
              : result
          }
        }

        perTarget.set(prop, wrapped)
        return wrapped
      },
    }) as B

    proxyCache.set(builder, proxy)
    return proxy
  }

  function serializeBuilder(builder: object): unknown[] {
    const serialize = (builder as Rec).serialize
    if (typeof serialize !== 'function') return []
    try {
      const value = (serialize as () => unknown).call(builder)
      if (Array.isArray(value)) return value
      /* A `patch` builder serializes to one mutation body, not an array. */
      return isRec(value) ? [{patch: value}] : []
    } catch {
      return []
    }
  }

  function transactionIdFromOptions(value: unknown): string | undefined {
    if (!isRec(value)) return undefined
    return typeof value.transactionId === 'string' ? value.transactionId : undefined
  }

  /* ------------------------------------------------------- namespaces */

  function wrapNamespace<N extends object>(target: N, path: string, kind: Kind): N {
    const cached = namespaceCache.get(target)
    if (cached) return cached as N

    const proxy = new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop)
        const name = String(prop)

        if (NESTED_NAMESPACES[path] === name && isRec(value)) {
          return wrapNamespace(value as object, `${path}.${name}`, kind)
        }
        if (typeof value !== 'function') return value

        let perTarget = namespaceMethodCache.get(t)
        if (!perTarget) {
          perTarget = new Map()
          namespaceMethodCache.set(t, perTarget)
        }
        const existing = perTarget.get(prop)
        if (existing) return existing

        const fn = value as (...args: unknown[]) => unknown
        const label = `${path}.${name}`
        let wrapped: (...args: unknown[]) => unknown

        if (namespaceMethodKind(path, name) === 'write') {
          wrapped = (): unknown => refuseUnechoable(kind, label, namespaceRefusalReason(path))
        } else if (path === 'users' && name === 'getById') {
          /* `client.users.getById('me')` builds the same `/users/me` URL as the
           * raw `request`, so the refresh signal must not depend on spelling. */
          wrapped = (...args: unknown[]): unknown =>
            args[0] === 'me' ? tapIdentityProbe(fn.apply(t, args), label) : fn.apply(t, args)
        } else {
          wrapped = (...args: unknown[]): unknown => tapReadErrors(fn.apply(t, args))
        }

        perTarget.set(prop, wrapped)
        return wrapped
      },
    }) as N

    namespaceCache.set(target, proxy)
    return proxy
  }

  /* ----------------------------------------------------- the main proxy */

  function wrap<T extends object>(target: T, kind: Kind): T {
    const cached = proxyCache.get(target)
    if (cached) return cached as T

    const proxy = new Proxy(target, {
      get(t, prop) {
        /* `receiver` intentionally defaults to `t`: forwarding the proxy would
         * break any @sanity/client getter that reads a private class field. */
        const value = Reflect.get(t, prop)
        const name = String(prop)

        if (name === 'observable' && isRec(value)) return wrap(value as object, 'observable')
        if (NAMESPACE_ROOTS.has(name) && isRec(value)) {
          return wrapNamespace(value as object, name, kind)
        }
        if (typeof value !== 'function') return value

        let perTarget = methodCache.get(t)
        if (!perTarget) {
          perTarget = new Map()
          methodCache.set(t, perTarget)
        }
        const existing = perTarget.get(prop)
        if (existing) return existing

        const fn = value as (...args: unknown[]) => unknown
        let wrapped: (...args: unknown[]) => unknown

        if (name === 'listen') {
          wrapped = wrapListen(fn, t)
        } else if (name === 'action') {
          wrapped = (...args: unknown[]): unknown => {
            const transactionId =
              transactionIdFromOptions(args[1]) ?? echo.nextTransactionId()
            const plan = echo.planActions(args[0])
            return blockedResult(kind, 'action', plan, transactionId, false)
          }
        } else if (name === 'dataRequest') {
          wrapped = (...args: unknown[]): unknown => {
            const endpoint = typeof args[0] === 'string' ? args[0] : ''
            if (!MUTATING_DATA_ENDPOINTS.has(endpoint)) return tapReadErrors(fn.apply(t, args))
            const body = args[1]
            const transactionId =
              (isRec(body) && typeof body.transactionId === 'string'
                ? body.transactionId
                : undefined) ??
              transactionIdFromOptions(args[2]) ??
              echo.nextTransactionId()
            const plan =
              endpoint === 'mutate'
                ? echo.planMutations(body)
                : echo.planActions(isRec(body) ? body.actions : undefined)
            return blockedResult(
              kind,
              `dataRequest:${endpoint}`,
              plan,
              transactionId,
              endpoint === 'mutate',
            )
          }
        } else if (name === 'request') {
          wrapped = (...args: unknown[]): unknown => {
            const request = args[0]
            const url = isRec(request) ? (request.url ?? request.uri) : undefined
            const method = isRec(request) ? String(request.method ?? 'GET').toUpperCase() : 'GET'

            /* Studio's logout is `request({uri: '/auth/logout', method: 'POST'})`
             * on a middleware-stripped clone. It is passed straight through —
             * swallowing it would leave a live token behind — but the session
             * ends here, synchronously: Studio does not await the response, and
             * neither may the pane release. */
            if (isLogoutEndpoint(url)) {
              echo.logout()
              return fn.apply(t, args)
            }
            if (isIdentityProbeEndpoint(url)) {
              return tapIdentityProbe(fn.apply(t, args), `request(${String(url)})`)
            }

            const plane = classifyWriteEndpoint(url)
            const isWrite = plane !== undefined && method !== 'GET' && method !== 'HEAD'
            if (!isWrite) return tapReadErrors(fn.apply(t, args))
            if (plane !== 'documents') {
              return refuseUnechoable(kind, `request(${String(url)})`, UNECHOABLE_REASON[plane])
            }

            const body = isRec(request) ? request.body : undefined
            const transactionId =
              (isRec(body) && typeof body.transactionId === 'string'
                ? body.transactionId
                : undefined) ?? echo.nextTransactionId()
            const plan = echo.planMutations(body)
            return blockedResult(kind, 'request', plan, transactionId, true)
          }
        } else if (WRITE_METHODS.has(name)) {
          wrapped = (...args: unknown[]): unknown => {
            const transactionId =
              transactionIdFromOptions(args[1]) ??
              transactionIdFromOptions(args[2]) ??
              echo.nextTransactionId()
            /* `args[1]` carries the `tag`, which is the only trace of §18.9
             * duplicate on the wire: Studio's duplicate is
             * `client.create(copy, {tag: 'document.duplicate'})`, not an action. */
            const plan = echo.planWrite(name, args[0], args[1])
            return blockedResult(kind, name, plan, transactionId, true)
          }
        } else if (name === 'patch' || name === 'transaction') {
          wrapped = (...args: unknown[]): unknown => {
            const result = fn.apply(t, args)
            return isRec(result) ? blockFluentCommit(result as object, name, kind) : result
          }
        } else if (CLONING_METHODS.has(name)) {
          /* CRITICAL: Studio reaches the Actions API through
           * `client.withConfig({apiVersion}).observable.action(...)`. A bare
           * client here would let the write escape the facade entirely. */
          wrapped = (...args: unknown[]): unknown => {
            const result = fn.apply(t, args)
            return isRec(result) ? wrap(result as object, kind) : result
          }
        } else if (READ_TAP_METHODS.has(name)) {
          wrapped = (...args: unknown[]): unknown =>
            tapRead(fn.apply(t, args), requestedIdsFrom(args))
        } else {
          wrapped = (...args: unknown[]): unknown => tapReadErrors(fn.apply(t, args))
        }

        perTarget.set(prop, wrapped)
        return wrapped
      },
    }) as T

    proxyCache.set(target, proxy)
    return proxy
  }

  return {wrap}
}

function requestedIdsFrom(args: unknown[]): string[] {
  const first = args[0]
  if (typeof first === 'string') return [first]
  if (Array.isArray(first)) return first.filter((id): id is string => typeof id === 'string')
  return []
}
