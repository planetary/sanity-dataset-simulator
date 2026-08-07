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
  markOverlayRefusal,
  type OverlayEcho,
  type OverlayEchoPlan,
  type PlannedEvent,
} from './echo'
import {STAGING_WRITE_POLICY, isStagingWrite} from '../../../sanity-overlay-client/src/stagingHost'
import type {StudioReadRouter} from './reads'
import type {
  OverlayHydrationDocument,
  OverlayTransport,
  OverlayTransportResult,
} from './transport'
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
  /**
   * Overlay-aware GROQ reads (PRD §22.6). ABSENT MEANS UNCHANGED: `fetch` is
   * delegated to the real client exactly as it was before reads were wired, so
   * a caller that has not opted in cannot be altered by this path.
   */
  reads?: StudioReadRouter
  /**
   * Every hydration document a commit answered with, so the caller can keep the
   * read side's view of the branch current without polling `/state`. The echo
   * map cannot serve this: it stores `null` as a DELETE of its own entry, which
   * spells "no opinion" and loses the tombstone the read path needs.
   */
  onHydration?: (documents: readonly OverlayHydrationDocument[]) => void
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

type SubscribeFn<T> = (subscriber: Required<MinimalSubscriber<T>>) => (() => void) | void

type ObservableCtor = new <T>(subscribe: SubscribeFn<T>) => MinimalObservable<T>

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VALUE THIS LAYER HANDS BACK MUST BE AN rxjs `Observable`, NOT A LOOKALIKE.
 *
 * `@sanity/client`'s observable surface answers with rxjs `Observable`s, and
 * Studio treats them as such the moment it gets one:
 *
 *     client.observable.request({uri: `/projects/${projectId}`}).pipe(…)
 *         — sanity 6.8.0 `createProjectStore`
 *
 * This module used to return a hand-rolled `{subscribe}`. Studio's very first
 * datastore therefore died with `…request(...).pipe is not a function`, inside
 * `<StudioTelemetryProvider>`, before anything rendered.
 *
 * A `{subscribe, pipe}` duck would not have been enough either. rxjs operators
 * are `lift`-based — `operate()` throws `Unable to lift unknown Observable type`
 * on anything that is not a genuine `Observable` — so `pipe(map(…))` would still
 * have failed. The only correct answer is the real class.
 *
 * It is adopted from the client being wrapped rather than imported, so the
 * facade cannot introduce a SECOND rxjs copy: Studio's own `isObservable()` is
 * an `instanceof` check, and a foreign copy would fail it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const OBSERVABLE_PROBE_QUERY = '*[_id == "__sanity_overlay_observable_probe__"][0]'

/**
 * Is this an `@sanity/client` client instance, as opposed to any other object
 * that happens to have a `fetch`?
 *
 * The probe below *calls* a method on whatever this admits, so admitting too
 * much would mean calling a caller's code behind its back. Both real clients are
 * class instances and carry these methods on a PROTOTYPE; an object literal — a
 * test double, a stub — carries them as own properties and is rejected.
 *
 * Structural rather than `x instanceof SanityClient`, because that would need a
 * RUNTIME import of `@sanity/client`, which the package declares only as a peer:
 * it does not resolve in a workspace that has not installed one.
 */
function isSanityClientInstance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  /* All four are class methods on BOTH `SanityClient` and
   * `ObservableSanityClient` in @sanity/client 7.26.0. `listen` deliberately is
   * not among them: it is assigned to the INSTANCE, so it proves nothing about
   * the class. The whole chain is walked rather than one level, since a
   * `withConfig()` clone may sit a level down. */
  const required = ['fetch', 'getUrl', 'getDataUrl', 'withConfig']
  const found = new Set<string>()
  let proto = Object.getPrototypeOf(value) as Rec | null
  while (proto !== null && proto !== Object.prototype) {
    for (const name of required) {
      if (typeof proto[name] === 'function') found.add(name)
    }
    proto = Object.getPrototypeOf(proto) as Rec | null
  }
  return required.every((name) => found.has(name))
}

/**
 * Last resort, used only if the rxjs constructor could not be adopted — which in
 * a real Studio cannot happen, since `@sanity/client` is a required peer and
 * every wrapped client descends from it. `pipe` is a plain left-fold, so
 * `lift`-based operators will NOT work against it: reaching this class is itself
 * the bug, which is why `makeObservable` reports it.
 */
class ShimObservable<T> implements MinimalObservable<T> {
  readonly #onSubscribe: SubscribeFn<T>

  constructor(onSubscribe: SubscribeFn<T>) {
    this.#onSubscribe = onSubscribe
  }

  subscribe(observer: MinimalSubscriber<T> | ((value: T) => void)): MinimalSubscription {
    const target = normalizeObserver(observer)
    let closed = false
    const teardown = this.#onSubscribe({
      next: (value: T): void => {
        if (!closed) target.next?.(value)
      },
      error: (error: unknown): void => {
        if (!closed) target.error?.(error)
      },
      complete: (): void => {
        if (!closed) target.complete?.()
      },
    })
    return {
      unsubscribe: (): void => {
        if (closed) return
        closed = true
        teardown?.()
      },
    }
  }

  pipe(...operators: Array<(source: unknown) => unknown>): unknown {
    return operators.reduce<unknown>((source, operator) => operator(source), this)
  }
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

/**
 * The version family: top-level document writes that reach the wire WITHOUT
 * going through `mutate`, `action`, `dataRequest` or `request` — each calls
 * `_dataRequest` with the raw client — so no other guard here could see them.
 *
 * sanity 6.8.0 calls all four from `useBundleDocuments` and
 * `useScheduledDraftMenuActions`: they are Content Releases plumbing, the same
 * plane `client.releases.*` is already refused on. Refused rather than echoed
 * for the same reason: the overlay has no spelling for a release, and letting
 * one through writes to the shared dataset (PRD §11.3).
 */
const RELEASE_VERSION_METHODS = new Set([
  'createVersion',
  'replaceVersion',
  'discardVersion',
  'unpublishVersion',
])

const RELEASE_PLANE_REASON =
  'Content Releases are hosted version infrastructure the overlay does not reproduce'

const READ_TAP_METHODS = new Set(['getDocument', 'getDocuments'])
/**
 * The ONE read Studio itself resets its base revision from: the document pair
 * listener's snapshot fetch is `getDocuments`. Every other read still answers
 * with the stale Content Lake revision once writes are intercepted, so only
 * this one may overwrite an echo-owned revision. See `tapRead`.
 */
const AUTHORITATIVE_READ_METHODS = new Set(['getDocuments'])
const MUTATING_DATA_ENDPOINTS = new Set(['mutate', 'actions'])
/**
 * Methods that are DECLARED to hand back a client. Kept as a named set because
 * `withConfig` is on the critical path (Studio reaches the Actions API through
 * `client.withConfig({apiVersion}).observable.action(...)`), but it is no longer
 * the only thing standing between a caller and a bare client — see
 * {@link isSanityClientInstance}'s use in the default branch of `wrap`.
 *
 * `withUrlSourceMapping` does not exist in `@sanity/client@7.26.0`; it is kept
 * so a reintroduction is covered on arrival rather than on discovery.
 */
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
  if (path === 'releases') return RELEASE_PLANE_REASON
  return 'this namespace method is not one the overlay knows how to represent'
}

/** `*[_id in $ids]` — the document *pair* listener, the only one worth echoing. */
const PAIR_QUERY_RE = /^\*\[\s*_id\s+in\s+\$ids\s*\]$/

/**
 * Teach the echo what the branch holds, from an overlay hydration answer.
 *
 * ONE SPELLING, TWO FEEDS, AND THAT IS THE WHOLE POINT OF THIS FUNCTION. The
 * overlay API states its inventory in exactly two places — the `documents` array
 * on every `POST /commit` answer, and the same array on `GET /state` — and the
 * document-by-id read tap (`tapRead`) can only substitute a body the echo has
 * been told about.
 *
 * Only the commit feed was ever wired. A Studio session that had not yet written
 * anything therefore had an EMPTY overlay-document map, so the pair listener's
 * `getDocuments` snapshot — the value the edit form opens with — fell straight
 * through to the base dataset while the list panes (fed from `/state` through
 * `overlaySourceFromBranch`) showed the branch. The editor then edited the base
 * body, and the overlay merged the result against an ancestor they were never
 * shown. `runtime.ts` now feeds this from `/state` as well.
 *
 * A TOMBSTONE IS NOT AN ABSENT BODY. `draft: null` with `draftTombstone: true`
 * means the branch removed that address; `draft: null` without it means the
 * branch simply holds no local draft and base is the honest answer. Storing both
 * as "forget this id" put deleted documents back in front of the editor.
 */
export function seedOverlayDocuments(
  echo: Pick<OverlayEcho, 'setOverlayDocument' | 'setOverlaySuppressed'>,
  documents: readonly OverlayHydrationDocument[],
): void {
  for (const document of documents) {
    if (!isRec(document) || typeof document.logicalId !== 'string' || document.logicalId === '') {
      continue
    }
    const draftId = `drafts.${document.logicalId}`
    if (document.draft !== undefined) {
      echo.setOverlayDocument(draftId, document.draft ?? null)
    }
    if (document.published !== undefined) {
      echo.setOverlayDocument(document.logicalId, document.published ?? null)
    }
    /* `undefined` means this overlay API does not report tombstones at all, and
     * §5.5 forbids reading silence as "clean" — so the flag is only ever CLEARED
     * by an explicit `false`. */
    if (document.draftTombstone !== undefined) {
      echo.setOverlaySuppressed(draftId, document.draftTombstone === true)
    }
    if (document.publishedTombstone !== undefined) {
      echo.setOverlaySuppressed(document.logicalId, document.publishedTombstone === true)
    }
  }
}

/**
 * The absolute URL a raw `request({url | uri})` would actually be sent to, using
 * the WRAPPED CLIENT'S OWN URL builder.
 *
 * Asking the client rather than reconstructing the host is the whole point: in
 * the Track B topology `apiHost` is a local proxy, so `/data/mutate/<ds>` is not
 * a staging write and must not be refused as one. `getUrl` is `@sanity/client`'s
 * public accessor for exactly this (`getUrl(uri, canUseCdn)`), and it already
 * applies the `useProjectHostname` and resource-scoping rules that a hand-rolled
 * reconstruction would get wrong.
 *
 * Returns `''` when the destination cannot be determined — a test double with no
 * `getUrl` and no `config`, typically. The path-anchored guards below still run;
 * this one abstains rather than guessing (see `stagingHost.ts`).
 */
function absoluteRequestUrl(client: object, target: unknown): string {
  const path = typeof target === 'string' ? target : ''
  const getUrl = (client as Rec).getUrl
  if (typeof getUrl === 'function') {
    try {
      const resolved = (getUrl as (uri: string) => unknown).call(client, path)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    } catch {
      /* Fall through to the config-derived host. */
    }
  }

  const config = (client as Rec).config
  if (typeof config !== 'function') return ''
  try {
    const resolved = (config as () => unknown).call(client)
    if (!isRec(resolved)) return ''
    const apiHost = typeof resolved.apiHost === 'string' ? resolved.apiHost : 'https://api.sanity.io'
    const projectId = typeof resolved.projectId === 'string' ? resolved.projectId : ''
    /* `@sanity/client` defaults `useProjectHostname` to true. */
    const useProjectHostname = resolved.useProjectHostname !== false && projectId !== ''
    const host = useProjectHostname
      ? apiHost.replace(/^(https?:\/\/)/i, (scheme) => `${scheme}${projectId}.`)
      : apiHost
    return `${host.replace(/\/+$/, '')}/${path.replace(/^\//, '')}`
  } catch {
    return ''
  }
}

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
  /* Guarded callbacks, keyed by the caller's own function then by the guard it
   * was built for. Identity matters: sanity 6.8.0 reads client properties inside
   * effect dependency arrays, and a fresh wrapper per access is what caused the
   * historical resubscribe storm. The same reasoning applies to an argument a
   * caller passes twice. */
  const callbackCache = new WeakMap<object, Map<string, unknown>>()
  const namespaceMethodCache = new WeakMap<object, Map<PropertyKey, unknown>>()

  /* ------------------------------------------- the client's own Observable */

  let observableCtor: ObservableCtor | undefined
  let shimReported = false

  /**
   * Adopt the constructor of a real observable that just went past. Free, and it
   * pins the wrapper to the exact rxjs copy the wrapped client returns.
   */
  function captureObservableCtor(value: unknown): void {
    if (observableCtor || typeof value !== 'object' || value === null) return
    const proto = Object.getPrototypeOf(value) as Rec | null
    if (!proto || typeof proto.subscribe !== 'function' || typeof proto.pipe !== 'function') return
    const ctor = proto.constructor
    if (typeof ctor === 'function') observableCtor = ctor as unknown as ObservableCtor
  }

  /**
   * Adopt it before anything has flowed, so a write that happens to be the first
   * observable call of the session is answered as correctly as a read.
   *
   * Cold: `_requestObservable` in `@sanity/client` v7 is
   * `new Observable(sub => httpRequest(…).subscribe(sub))`, so building one and
   * dropping it makes no request. Gated on {@link isSanityClientInstance} rather
   * than on the presence of a `fetch` method, so a test double is never called
   * behind the caller's back — only a real `@sanity/client` is probed.
   */
  function probeObservableCtor(target: object): void {
    if (observableCtor) return
    /* The PROMISE client's `fetch` answers with a Promise, so the observable
     * sibling is the one that can hand back the class. */
    const sibling = (target as Rec).observable
    const source = isSanityClientInstance(sibling)
      ? (sibling as Rec)
      : isSanityClientInstance(target)
        ? (target as Rec)
        : undefined
    if (!source) return
    try {
      const fetch = source.fetch
      if (typeof fetch !== 'function') return
      captureObservableCtor((fetch as (query: string) => unknown).call(source, OBSERVABLE_PROBE_QUERY))
    } catch (error) {
      noteError(
        `[sanity-overlay-studio] could not adopt @sanity/client's Observable: ${String(error)}`,
      )
    }
  }

  function makeObservable<T>(onSubscribe: SubscribeFn<T>): MinimalObservable<T> {
    const Ctor = observableCtor
    if (Ctor) return new Ctor<T>(onSubscribe)
    if (!shimReported) {
      shimReported = true
      noteError(
        `[sanity-overlay-studio] answering an observable call without @sanity/client's own ` +
          `Observable — rxjs operators (.pipe) will not compose against the fallback`,
      )
    }
    return new ShimObservable<T>(onSubscribe)
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
      if (result.documents !== undefined) options.onHydration?.(result.documents)
      seedOverlayDocuments(echo, result.documents ?? [])
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
      /* Marked as our own refusal: it carries the DEAD session's 401/403 so a
       * host reads it the way it reads a real `ClientError`, and re-observing
       * that status as fresh evidence would let a refused write re-arm the very
       * state a token refresh had just cleared. */
      const error = markOverlayRefusal(
        Object.assign(
          new Error(
            `[sanity-overlay-studio] refusing to acknowledge ${method}: ${ack.error?.message ?? 'the session cannot persist writes'}`,
          ),
          ack.error?.status === undefined ? {} : {statusCode: ack.error.status},
        ),
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

  /**
   * Refuse a Content Lake PUSH stream (PRD §23.3, §37 Phase 5).
   *
   * ALWAYS an Observable, on both the promise client and the observable one,
   * and NOT parameterised by `kind`. `LiveClient.events()` is declared to return
   * an Observable and `client.live` is the same object on both sides in
   * `@sanity/client@7.26.0`; sanity 6.8.0 calls `.subscribe({next, error})` on
   * the result directly (`LiveQueries-rJao7vYj.js`,
   * `PresentationToolGrantsCheck-CITNu5DG.js`). A rejected Promise here would
   * be a `TypeError: .subscribe is not a function` at the call site — an
   * unattributable crash instead of a refusal the host can report.
   *
   * REFUSAL, NOT SILENCE, AND NOT A PARTIAL STREAM. An Observable that simply
   * never emits would leave the loader waiting forever with no explanation; one
   * fed from the overlay's own echo would carry local writes only and would be
   * an approximation presented as Sanity Live, which §5.5 forbids outright.
   * Both call sites above route `error` into their own state, so this surfaces
   * where a Studio user can see it.
   */
  function refuseLivePush(label: string): unknown {
    const error = markOverlayRefusal(
      new Error(
        `[sanity-overlay-studio] blocked ${label}: Sanity Live streams query results the ` +
          'Content Lake evaluated itself, so an event would arrive after the overlay-resolved ' +
          'render and replace the branch with staging content (PRD §23.3, §37 Phase 5). Use the ' +
          'overlay event stream or a refetch signal instead — there is no partial live stream ' +
          'that would be honest to show.',
      ),
    )
    noteError(error.message)
    return observableThrowing(error)
  }

  function refuseUnechoable(kind: Kind, label: string, reason: string): unknown {
    /* Marked, because a host that funnels this back through the session
     * observer must not read our own "no" as Sanity revoking the credential. */
    const error = markOverlayRefusal(
      new Error(
        `[sanity-overlay-studio] blocked ${label}: ${reason}. Letting it through would put the ` +
          `editor and the overlay out of sync, and could write to the shared dataset.`,
      ),
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
      captureObservableCtor(source)
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
        /* POSITIONAL. `getDocuments(ids)` answers an array aligned with `ids`
         * (@sanity/client 7.26.0), and sanity 6.8.0's pair listener destructures
         * it that way — `lib/datastores-DqFH7RLd.js:1727`. The requested id is
         * therefore the only thing that identifies a slot whose base answer is
         * `null`, which is exactly the branch-created document the form must
         * still be able to open. */
        return value.map((entry, index) => substituteOne(entry, requestedIds[index]))
      }
      return substituteOne(value, requestedIds.length === 1 ? requestedIds[0] : undefined)
    }

    const substituteOne = (value: unknown, requestedId: string | undefined): unknown => {
      const id = isRec(value) && typeof value._id === 'string' ? value._id : requestedId
      if (id === undefined) return value
      /* The branch has DELETED this address (§18.6, §18.7). Falling through to
       * the base body would put a document the branch removed back into the
       * editor, which is the same silent approximation §5.5 forbids. */
      if (echo.isOverlaySuppressed(id)) return null
      return echo.getOverlayDocument(id) ?? value
    }

    if (isPromiseLike(result)) {
      return result.then(substitute, (error: unknown) => {
        noteAuthFailureFrom(error, 'read')
        throw error
      })
    }
    if (isObservableLike(result)) {
      const source = result
      captureObservableCtor(source)
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

  /* ------------------------------------------------------- GROQ reads */

  /** The first value of whatever a client method answered with, as a Promise. */
  function firstValueOf(result: unknown): Promise<unknown> {
    if (isPromiseLike(result)) return Promise.resolve(result)
    if (isObservableLike(result)) {
      const source = result
      captureObservableCtor(source)
      return new Promise((resolve, reject) => {
        let settled = false
        const subscription = source.subscribe({
          next: (value) => {
            if (settled) return
            settled = true
            resolve(value)
            /* Defensive: a cold single-value observable completes on its own,
             * but nothing here should hold a subscription open once the value
             * it asked for has arrived. */
            queueMicrotask(() => subscription?.unsubscribe())
          },
          error: (error) => {
            if (settled) return
            settled = true
            reject(error)
          },
          complete: () => {
            if (settled) return
            settled = true
            resolve(undefined)
          },
        })
      })
    }
    return Promise.resolve(result)
  }

  /**
   * `client.fetch` / `client.observable.fetch` — PRD §22.6 in the one place a
   * Studio actually reads content from.
   *
   * The router decides; this function only plumbs. When it declines, the
   * caller's own arguments are replayed against the REAL method, so a delegated
   * read is byte-identical to the un-wrapped one — including its errors, which
   * still reach {@link noteAuthFailureFrom}.
   *
   * `baseFetch` deliberately calls `fn` (the real method) and never the proxy:
   * routing a candidate fetch back through this wrapper would recurse.
   *
   * AN OVERLAY-ANSWERED READ IS NOT SEEDED INTO THE ECHO, and that is the point
   * rather than an omission. `tapReadErrors` seeds `docState` from what a read
   * returned so revisions can be learned from base traffic; an answer this
   * function produced is branch state projected through the caller's own GROQ,
   * so seeding it would teach the revision store an overlay body as though the
   * Content Lake had said it. A DELEGATED read still seeds, because that really
   * is base traffic.
   */
  function interceptFetch(
    target: object,
    fn: (...args: unknown[]) => unknown,
    args: unknown[],
    kind: Kind,
  ): unknown {
    const router = options.reads
    const delegate = (): unknown => tapReadErrors(fn.apply(target, args))
    if (router === undefined || typeof args[0] !== 'string') return delegate()

    const answered = router({
      query: args[0],
      params: args[1],
      options: args[2],
      baseFetch: (query, params) => firstValueOf(fn.call(target, query, params)),
    }).then((answer) => (answer.answered ? answer.result : firstValueOf(delegate())))

    if (kind !== 'observable') {
      return answered.catch((error: unknown) => {
        noteAuthFailureFrom(error, 'read')
        throw error
      })
    }
    return makeObservable((subscriber) => {
      let closed = false
      void answered.then(
        (value) => {
          if (closed) return
          subscriber.next(value)
          subscriber.complete()
        },
        (error: unknown) => {
          if (closed) return
          noteAuthFailureFrom(error, 'read')
          subscriber.error(error)
        },
      )
      return () => {
        closed = true
      }
    })
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * **A CLIENT HANDED BACK BY A WRAPPED CLIENT IS STILL A WRAPPED CLIENT.**
   *
   * THE DEFECT THIS CLOSES. `SanityClient.config(newConfig)` *mutates in place
   * and returns `this`* (`@sanity/client@7.26.0` `SanityClient.ts:1220-1236`).
   * It was not in `CLONING_METHODS` — nothing new is constructed, so it did not
   * look like a clone — and so it fell to the default branch and handed the
   * caller the RAW client. One line defeated the entire facade:
   *
   *     wrapped.config({apiHost: 'https://api.sanity.io'}).mutate([…])
   *
   * and the same call re-pointed the client at the Content Lake on its way past.
   * `ObservableSanityClient.config` is the identical hole one level down. Spike
   * F recorded the request shape as attack 17 (`writeGuardContract.ts`), where
   * the PROXY stops it; in a deployed preview there is no proxy, so it was live.
   *
   * THE CLASS, not the instance. The fix is not "add `config` to the list": the
   * list is an inventory, and Spike F's standing lesson is that an inventory is
   * never complete. Any method — present or future, ours to know about or not —
   * whose return value IS a `@sanity/client` is re-wrapped here, so the next
   * `this`-returning method @sanity/client ships is covered on arrival.
   *
   * `isSanityClientInstance` is prototype-based, so this cannot capture a plain
   * object: `config()` with NO argument returns `{...clientConfig}` and must
   * keep being a plain configuration object, not a proxy.
   * ─────────────────────────────────────────────────────────────────────────
   */
  function wrapIfClient(result: unknown, kind: Kind): unknown {
    if (isSanityClientInstance(result)) return wrap(result as object, kind)
    return tapReadErrors(result)
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * **THE SAME RULE, FOR THE OTHER DIRECTION.**
   *
   * `wrapIfClient` closes one channel: a capability handed BACK as a return
   * value. A capability can also be handed FORWARD, as an argument to a callback
   * the library invokes on the caller's behalf — and the "structural" claim
   * above did not cover that, because such an object never crosses a return.
   *
   * THE DEFECT THIS CLOSES (security review P1-3). `@sanity/client@7.26.0`:
   *
   *     patch(patchOrDocumentId, patchOps) {
   *       const isBuilder = typeof patchOps == "function"
   *       if (isBuilder) {
   *         const patch = patchOps(new Patch(patchOrDocumentId, {}, this.#client))
   *
   * (`dist/index.js:631-641`; `ObservableTransaction.patch` at `:668-678`.) The
   * facade calls the real method with `target` = the RAW `Transaction`, so
   * `this.#client` is the raw client and the `Patch` the callback receives holds
   * it. `p.commit()` inside that callback is `rawClient.mutate(...)`:
   *
   *     wrapped.transaction().patch('article-01', (p) => {
   *       p.set({title: 'owned'}); p.commit(); return p
   *     })
   *
   * — a live write to the Sanity API, reaching neither the overlay nor the
   * proxy, from a Studio that believes writing is impossible.
   *
   * THE CLASS, not the instance. Two things are guarded on the way out, by the
   * same predicates the return path uses: a `@sanity/client`, and a builder
   * (anything carrying a `commit`). So the next method @sanity/client ships that
   * hands a capability into a callback is covered on arrival, whatever it is
   * called and whichever argument slot it reads.
   *
   * INSTANCEOF SURVIVES. `Transaction.patch` throws unless the callback returns
   * something `instanceof Patch`. A `Proxy` forwards `getPrototypeOf`, so the
   * guarded patch is still a `Patch` — and `serialize()` on it still reads the
   * real operations.
   * ─────────────────────────────────────────────────────────────────────────
   */
  function guardOutward(value: unknown, label: string, kind: Kind): unknown {
    if (isSanityClientInstance(value)) return wrap(value as object, kind)
    if (isRec(value) && typeof value.commit === 'function') {
      return blockFluentCommit(value as object, label, kind)
    }
    return value
  }

  /**
   * Guard every function argument, so anything the library hands INTO it is
   * guarded before the caller can touch it.
   *
   * Non-function arguments are returned untouched, and a guarded callback's
   * return value is passed back to the library unchanged — the library's own
   * checks on it (`instanceof Patch`) must still see what it expects.
   */
  function guardArguments(args: unknown[], label: string, kind: Kind): unknown[] {
    let guarded: unknown[] | undefined
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (typeof arg !== 'function') continue
      if (guarded === undefined) guarded = [...args]
      guarded[index] = guardCallback(arg as (...a: unknown[]) => unknown, label, kind)
    }
    return guarded ?? args
  }

  function guardCallback(
    callback: (...args: unknown[]) => unknown,
    label: string,
    kind: Kind,
  ): (...args: unknown[]) => unknown {
    let perCallback = callbackCache.get(callback)
    if (!perCallback) {
      perCallback = new Map()
      callbackCache.set(callback, perCallback)
    }
    const key = `${kind}:${label}`
    const existing = perCallback.get(key)
    if (existing) return existing as (...args: unknown[]) => unknown

    const guarded = (...args: unknown[]): unknown =>
      callback(...args.map((value) => guardOutward(value, label, kind)))

    perCallback.set(key, guarded)
    return guarded
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
      captureObservableCtor(source)
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
      captureObservableCtor(upstream)
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
            /* THE ARGUMENT CHANNEL. `Transaction.patch(id, fn)` constructs a
             * raw-client-bound `Patch` and hands it to `fn` — see
             * `guardOutward`. This is the call that used to let it through. */
            const result = fn.apply(target, guardArguments(args, label, kind))
            /* A builder holds its client in a private field, so it cannot hand
             * one back today — but `wrapIfClient` costs one prototype walk and
             * removes the need for that to stay true. */
            if (isSanityClientInstance(result)) return wrapIfClient(result, kind)
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

        const methodKind = namespaceMethodKind(path, name)

        if (methodKind === 'push') {
          /* Not `kind`-dependent: see `refuseLivePush`. */
          wrapped = (): unknown => refuseLivePush(label)
        } else if (methodKind === 'write') {
          wrapped = (): unknown => refuseUnechoable(kind, label, namespaceRefusalReason(path))
        } else if (path === 'users' && name === 'getById') {
          /* `client.users.getById('me')` builds the same `/users/me` URL as the
           * raw `request`, so the refresh signal must not depend on spelling. */
          wrapped = (...args: unknown[]): unknown =>
            args[0] === 'me' ? tapIdentityProbe(fn.apply(t, args), label) : fn.apply(t, args)
        } else {
          /* Same rule as the main proxy, in both directions: a namespace method
           * that hands back — or hands INTO a callback — a client or a builder
           * hands out a guarded one. None does today; the rule is the point,
           * not the current inventory. */
          wrapped = (...args: unknown[]): unknown =>
            wrapIfClient(fn.apply(t, guardArguments(args, path, kind)), kind)
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
    probeObservableCtor(target)

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
        } else if (name === 'fetch') {
          wrapped = (...args: unknown[]): unknown => interceptFetch(t, fn, args, kind)
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
            /**
             * The identity probes are `GET /users/me` and `GET /auth/id`. The
             * method test is load-bearing, not decoration:
             * `IDENTITY_PROBE_RE` matches any path UNDER `/users/me`, so
             * `PUT /users/me/keyvalue/<k>` — a real, write-capable
             * `@sanity/client` endpoint that the write-guard contract names as
             * one of the four nobody had heard of — was read as a probe and
             * DELEGATED. Restricting the tap to safe methods drops the whole
             * family through to the write classification below instead.
             */
            if (isIdentityProbeEndpoint(url) && (method === 'GET' || method === 'HEAD')) {
              return tapIdentityProbe(fn.apply(t, args), `request(${String(url)})`)
            }

            /**
             * THE HOST-LEVEL REFUSAL, and the gap it closes.
             *
             * `classifyWriteEndpoint` below is an inventory of write PATHS, and
             * Spike F's finding was that no such inventory is complete:
             * `POST /projects/<p>/tokens`, `PUT /users/me/keyvalue/<k>`,
             * `POST /schedules/<p>/<d>` and `POST /descriptors/claim` all fall
             * through it and were delegated straight to `*.api.sanity.io`.
             *
             * This asks a question that needs no inventory — *is an unsafe
             * method about to leave for a real Sanity API host?* — and it runs
             * AFTER the two session signals above, because `/auth/logout` is a
             * POST that must still reach Sanity: it destroys a token rather than
             * writing content, and swallowing it would leave a live credential
             * behind (Gate E).
             */
            if (isStagingWrite({method, url: absoluteRequestUrl(t, url)})) {
              return refuseUnechoable(
                kind,
                `request(${String(url)})`,
                `${STAGING_WRITE_POLICY}, and this request is addressed to a real Sanity API host`,
              )
            }

            const plane = classifyWriteEndpoint(url)
            const isWrite = plane !== undefined && method !== 'GET' && method !== 'HEAD'
            /*
             * ─────────────────────────────────────────────────────────────────
             * A DOCUMENTED READ GAP, NOT AN OVERSIGHT. §5.5 forbids pretending.
             *
             * A raw `request({uri})` READ is delegated to the base dataset
             * untouched, and some of those really do carry document content or
             * document EXISTENCE. Transcribed from sanity 6.8.0, the ones that
             * matter (`node_modules/sanity/lib/…`):
             *
             *   datastores-DqFH7RLd.js:249   `/data/doc/<ds>/<ids>?excludeContent=true`
             *                                — preview availability: does this
             *                                  document exist? A branch-created
             *                                  document reads as missing.
             *   datastores-DqFH7RLd.js:5533  `/data/doc/<ds>/<ids>`
             *                                — validation's reference-exists probe.
             *   datastores-DqFH7RLd.js:7122  `/data/history/<ds>/documents/…`
             *   datastores-DqFH7RLd.js:7133  ditto — `getDocumentAtRevision`,
             *                                  which feeds the diff view and
             *                                  history restore.
             *   useBundleDocuments…:5009     `/data/history/<ds>/events/documents/<id>`
             *   useBundleDocuments…:5101     `/data/history/<ds>/documents/<id>?revision=`
             *   structureTool-EN0gOzyJ.js:744, :761 — delete-confirm existence
             *                                  probe and cross-dataset references.
             *
             * They are answered by the BASE DATASET, so anything a branch created
             * looks absent to them and anything a branch deleted looks present.
             * Intercepting them means teaching this facade the `/data/doc` and
             * `/data/history` wire formats — a second, weaker copy of the overlay
             * read path — so it is recorded here rather than half-done.
             *
             * Strictly worse, and genuinely UNREACHABLE from any client proxy:
             * the timeline reads its transaction log with the GLOBAL `fetch()`,
             * built from `client.getUrl()` + `client.config().token`
             * (`datastores-DqFH7RLd.js:6876`, `:7097`;
             * `useBundleDocuments…:4822`). No wrapper around a client method can
             * see those at all.
             * ─────────────────────────────────────────────────────────────────
             */
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
        } else if (RELEASE_VERSION_METHODS.has(name)) {
          wrapped = (): unknown => refuseUnechoable(kind, name, RELEASE_PLANE_REASON)
        } else if (name === 'patch' || name === 'transaction') {
          wrapped = (...args: unknown[]): unknown => {
            const result = fn.apply(t, guardArguments(args, name, kind))
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
          const authoritative = AUTHORITATIVE_READ_METHODS.has(name)
          wrapped = (...args: unknown[]): unknown =>
            tapRead(fn.apply(t, args), requestedIdsFrom(args), authoritative)
        } else {
          /* The default branch guards BOTH directions: whatever an unclassified
           * method returns, and whatever it hands into a callback. Everything
           * above either refuses outright or owns its own argument handling. */
          wrapped = (...args: unknown[]): unknown =>
            wrapIfClient(fn.apply(t, guardArguments(args, name, kind)), kind)
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
