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

import type {OverlayAssetUploader} from './assets'
import {
  authStatusOf,
  markOverlayRefusal,
  type OverlayEcho,
  type OverlayEchoPlan,
  type PlannedEvent,
} from './echo'
import {STAGING_WRITE_POLICY, isStagingWrite} from 'sanity-overlay-client/stagingHost'
import {
  classifyOverlayDocRead,
  overlayDocAnswer,
  overlayDocOpinion,
  type OverlayBranchLookup,
  type OverlayDocOpinion,
} from './docReads'
import {classifyOverlayHistoryRead, emptyOverlayHistoryAnswer} from './history'
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
  /**
   * `stale` is the §14.4 case: the overlay refused the write with 409 because
   * this session's view of the branch is behind another writer's. It is neither
   * `degraded` (which means "saved, loudly" and would be a lie) nor `fatal`
   * (which the runtime reads as a dead credential).
   */
  /**
   * `replayed` is the §34.6 ledger answering "I already hold this key". NOTHING
   * WAS APPLIED BY THIS CALL, so it is not `ok` — but it is not a failure
   * either: the write it names did land, at some point, under this key.
   *
   * It is recorded distinctly because the two readings are opposite. A genuine
   * retry after a timeout is benign; a replay the editor did not ask for means
   * their keystrokes went nowhere, and the only difference visible from here is
   * that the second one used to be indistinguishable from a save.
   */
  committed: 'ok' | 'degraded' | 'stale' | 'fatal' | 'refused' | 'replayed'
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
  /**
   * Branch-local asset uploads (PRD §24.3). ABSENT MEANS REFUSED, exactly as
   * before this port existed: `client.assets.upload` rejects with a stated
   * reason and the bytes go nowhere. Present, it is the ONLY destination —
   * `@sanity/client`'s own upload is never called, so no asset can reach Sanity.
   */
  assets?: OverlayAssetUploader
  /**
   * Origin every asset URL `@sanity/image-url` builds must point at (PRD §24.7).
   *
   * ABSENT MEANS UNCHANGED: `config()` is delegated verbatim and Studio's image
   * previews keep resolving against `cdn.sanity.io`, which is right for a
   * deployment where the overlay does not serve `/images/...`. See
   * `assetOriginFor`, which is what decides whether a given mounting can.
   */
  assetOrigin?: string
  /**
   * Does the branch hold state for this document ADDRESS (`drafts.x` or `x`)?
   *
   * SYNCHRONOUS, because the call site is `request()` and the decision has to
   * be made before the delegation happens. The overlay's own view already
   * answers it — `overlaySourceFromBranch` keys `documents` and `tombstones` by
   * exactly these addresses — so nothing new is fetched to ask.
   *
   * WHAT IT IS NOT. It is NOT "this document was created in the branch". That
   * question cannot be answered here at all: it needs to know what BASE holds,
   * which is a network round trip this call cannot make. The two differ for a
   * base document the branch has edited, and this predicate says `true` for
   * both. See {@link OverlayFacadeOptions.branchHolds} usage in the `request`
   * branch for why that is the safe side to err on.
   *
   * ABSENT MEANS UNCHANGED: every history read is delegated exactly as it was
   * before this option existed.
   */
  branchHolds?: (documentId: string) => boolean
  /**
   * The branch as a lookup by document ADDRESS, for the `/data/doc` existence
   * probe (`docReads.ts`).
   *
   * SEPARATE FROM {@link OverlayFacadeOptions.branchHolds} because the two
   * questions are different, not because one is a better spelling of the other.
   * `branchHolds` answers "does the branch have anything to say about this id",
   * which is all a history read needs. The existence probe needs to know WHICH
   * thing — a body or a tombstone — because those produce opposite answers, and
   * for a content-carrying probe it needs the body itself.
   *
   * SYNCHRONOUS, for the same reason `branchHolds` is: the call site is
   * `request()` and the decision has to be made before the delegation happens.
   *
   * ABSENT MEANS UNCHANGED: every `/data/doc` read is delegated to base exactly
   * as it was before this option existed.
   */
  branchView?: () => OverlayBranchLookup
  /**
   * Deadline for one DELEGATED read, in ms. See {@link DEFAULT_READ_TIMEOUT_MS}.
   * `0` or a negative number disables it.
   */
  readTimeoutMs?: number
  /** Injected clock for the write ledger. */
  now?: () => number
}

/**
 * Two minutes on a read that has been handed to the base dataset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A READ NEEDS A DEADLINE AT ALL.
 *
 * `fetch` has none, and neither does `@sanity/client`. A base that accepts the
 * connection and never answers leaves the promise pending for the life of the
 * tab. That is survivable for a list pane — it renders a spinner and the editor
 * reloads — and it is NOT survivable for a read something else is gated on.
 *
 * §24's asset-deduplication probe was exactly that: `uploadSanityAsset` does not
 * send a single byte until `client.observable.fetch(…sha1hash…)` emits
 * (`sanity@6.8.0 lib/useBundleDocuments-BYW8M9LS.js:13450`). Delegated to a base
 * that never answered, it produced an image field stuck on "Uploading" with no
 * error anywhere — observed live 2026-08-09. `assetDedup.ts` takes that
 * particular read off the network entirely, which fixes the instance; this
 * deadline is the CLASS, because the next gated read will not be an asset one
 * and nobody will know it was gated until it wedges.
 *
 * TWO MINUTES, matching {@link DEFAULT_UPLOAD_TIMEOUT_MS}, and for the same
 * reason: long enough that no healthy query on a bad connection reaches it,
 * short enough that a wedged session becomes a sentence rather than a spinner.
 * It bounds the WHOLE read, not an idle period, because the failure being
 * prevented is a server that accepts and never replies.
 */
export const DEFAULT_READ_TIMEOUT_MS = 120_000

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

/**
 * The dataset this facade is FOR, read once from the client it is built around.
 *
 * READ AT WRAP TIME, NEVER AT CALL TIME, and that is the entire point.
 * `client.withConfig({projectId, dataset})` produces a clone pointed at somebody
 * else's dataset, and `CLONING_METHODS` re-wraps that clone with THIS facade —
 * so a call-time `t.config().dataset` would answer with the foreign dataset and
 * the check would agree with itself. sanity 6.8.0 makes exactly that call:
 * `useBundleDocuments:33273` `fetchDocumentAvailability` is the cross-dataset
 * reference probe, and it asks `/data/doc/<theirDataset>/<id>`.
 *
 * `undefined` when the client will not say, which leaves the `/data/doc` claim
 * off entirely rather than guessing — a fail-closed default for a check whose
 * whole job is to stop one dataset answering for another.
 */
function homeDatasetOf(client: object): string | undefined {
  const config = (client as Rec).config
  if (typeof config !== 'function') return undefined
  try {
    const value = (config as () => unknown).call(client)
    return isRec(value) && typeof value.dataset === 'string' ? value.dataset : undefined
  } catch {
    return undefined
  }
}

export function wrapWithOverlay<T extends object>(client: T, options: OverlayFacadeOptions): T {
  const cached = facadeCache.get(client)
  if (cached) return cached as T
  const facade = createFacade(options, homeDatasetOf(client))
  const proxy = facade.wrap(client, 'promise')
  facadeCache.set(client, proxy)
  return proxy
}

function createFacade(
  options: OverlayFacadeOptions,
  homeDataset: string | undefined,
): {
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

  /**
   * A promise, delivered on the observable channel — one value then complete,
   * or the rejection.
   *
   * `closed` is not decoration: `client.observable.request` is what Studio
   * unsubscribes from when a pane closes mid-flight, and a `next` after that
   * would push a value into a torn-down rxjs chain.
   */
  function observableFrom<T>(work: Promise<T>): MinimalObservable<T> {
    return makeObservable<T>((subscriber) => {
      let closed = false
      void work.then(
        (value) => {
          if (closed) return
          subscriber.next(value)
          subscriber.complete()
        },
        (error: unknown) => {
          if (closed) return
          subscriber.error(error)
        },
      )
      return () => {
        closed = true
      }
    })
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * `/data/history` IS A GAP, AND A GAP THE EDITOR IS NOT TOLD ABOUT IS A LIE.
   *
   * The facade answers a branch document's history reads with an EMPTY history
   * (`history.ts`) rather than base's, and that is the right answer — but it is
   * an answer, and a diff view or a restore affordance built on it describes a
   * document with no past. For a document the branch CREATED that is simply
   * true. For a base document the branch has EDITED it is not: the document has
   * a real upstream lineage, and `branchHolds` cannot tell the two apart
   * (see its own doc comment). Both are therefore told the same thing, and
   * §5.5 requires that "the branch's history is not shown here" be said rather
   * than deduced from an empty list.
   *
   * WHY IT IS NOT SERVED FOR REAL. Sanity's history plane is three endpoints
   * that only make sense together: `events`, `documents?revision=<rev>` and the
   * transaction log. The revisions the first two are keyed by come OUT of the
   * translog — and the translog is fetched with the global `fetch()`, which no
   * wrapper around a client method can reach (see the class table in the
   * `request` branch). Serving two of three would hand the diff view revision
   * ids nothing can resolve, which is a worse failure than an empty timeline
   * and a sentence saying why.
   *
   * ONCE PER DOCUMENT, not once per read: the timeline machinery re-asks on
   * every pane focus, and a message per read would bury everything else in the
   * status panel.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const announcedEmptyHistory = new Set<string>()

  /**
   * OFF THE CALLER'S STACK, and that is not tidiness.
   *
   * The read this announces is subscribed to by `DocumentEventsPane` DURING ITS
   * OWN RENDER, and `onError` is `runtime.ts`'s `log`, which ends in `notify()`
   * — the status banner's subscriber, i.e. `setState` on a different component.
   * Delivered synchronously that is a render-phase update, and React said so:
   *
   *   Cannot update a component (`OverlayStatusLayout`) while rendering a
   *   different component (`DocumentEventsPane`).
   *
   * Not a warning to silence: React discards and re-runs the interrupted
   * render, and in the session that produced this the surrounding tree fell
   * back to its error boundary. The set is still updated synchronously, so
   * "once per document" holds even if two panes ask in the same tick.
   *
   * `queueMicrotask` rather than `setTimeout`: the message must reach the panel
   * in the same frame a person is looking at, and a microtask runs after the
   * current stack unwinds but before paint. A host without it falls back to a
   * resolved promise, which schedules on the same queue.
   */
  const deferAnnouncement =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (task: () => void): void => {
          void Promise.resolve().then(task)
        }

  function announceEmptyHistory(ids: readonly string[]): void {
    const fresh = ids.filter((id) => !announcedEmptyHistory.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) announcedEmptyHistory.add(id)
    deferAnnouncement(() => {
      noteError(
        `[sanity-overlay-studio] this document's history is NOT shown: ${fresh.join(', ')} ` +
          `is held by the branch, and the branch keeps its own edit log rather than Sanity's. ` +
          `The timeline was answered EMPTY rather than with the base dataset's history, which ` +
          `belongs to different content than the pane is showing. If this document also exists ` +
          `in the base dataset, its history is still there — it is just not reachable from here.`,
      )
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

    for (const [index, commit] of plan.commits.entries()) {
      const result: OverlayTransportResult = await transport.commit(commit, {
        /*
         * ONE KEY PER BATCH, NOT ONE PER WRITE.
         *
         * `planActions` splits a single `client.action([...])` into an `actions`
         * commit and a `documentActions` commit whenever the call carries both —
         * which is exactly how sanity 6.8.0 spells "save this edit, then publish
         * it", and how a restore of a deleted document arrives. Every batch used
         * to be posted under the bare `transactionId`, i.e. one idempotency key
         * presented two or three times for two or three different writes.
         *
         * NOT A LIVE LOSS TODAY, AND SAID PLAINLY RATHER THAN OVERSTATED: it
         * survives only because the two endpoints happen to key into disjoint
         * spaces — `commitMutations` files the key verbatim while
         * `commitDocumentActions` files `${key}#0` — so the second batch misses
         * the first batch's ledger entry by coincidence. Measured: with one
         * shared key both batches still commit.
         *
         * That coincidence is the whole safety margin, it lives in a different
         * package, and nothing enforces it. A third batch kind, or an endpoint
         * that files the caller's key verbatim like the first one does, silently
         * reinstates a dropped write — the exact failure this file has now been
         * bitten by once. `#index` is the overlay API's own spelling for a
         * derived step key (`sanity-overlay-next` `api.ts` `stepKey`), so a
         * retry still replays exactly the batches it already ran, and the
         * uniqueness stops depending on where the batch happens to be routed.
         */
        idempotencyKey: `${transactionId}#${index}`,
        baseDocuments: baseDocumentsFor(plan.plans),
      })
      if (result.outcome === 'fatal') {
        committed = 'fatal'
        /*
         * ONLY 401/403 ENDS THE SESSION.
         *
         * `fatal` used to mean nothing but "the overlay said 401/403", so this
         * branch could assume one. It now also covers 413/415/422 — refusals
         * about the REQUEST — and `noteAuthFailure` moves the session to
         * `unauthenticated`, which stops all further writes and tells the editor
         * their Sanity login has gone. Doing that because one image was too
         * large would discard a whole session's work over a payload limit.
         */
        if (result.status === 401 || result.status === 403) {
          echo.noteAuthFailure({
            status: result.status,
            source: 'write',
            message: result.message ?? 'the overlay API rejected the write',
          })
        }
        break
      }
      /* §14.4: the branch moved. Recorded distinctly and NOT retried — the
       * server already reconciled once and refused anyway. */
      if (result.outcome === 'stale') {
        committed = 'stale'
        break
      }
      if (result.outcome === 'degraded') committed = 'degraded'
      /* §34.6 replay. NOT a save: this call applied nothing, so it must not
       * echo — a frame is a claim about what the overlay now holds, and the
       * overlay does not now hold what this write asked for. Recorded after
       * `degraded` so the loud, retryable outcome of an earlier batch is not
       * overwritten by a later batch's replay. */
      if (result.replayed === true && result.committed === false && committed === 'ok') {
        committed = 'replayed'
      }
      if (result.documents !== undefined) options.onHydration?.(result.documents)
      seedOverlayDocuments(echo, result.documents ?? [])
      for (const entry of result.unsupported ?? []) {
        noteError(
          `[sanity-overlay-studio] the overlay could not represent ${entry}; the editor's view ` +
            `and the overlay may now differ for that operation`,
        )
      }
    }

    /*
     * ───────────────────────────────────────────────────────────────────────────
     * A FRAME IS A CLAIM ABOUT WHAT THE OVERLAY NOW HOLDS, SO ONLY A COMMIT THAT
     * LANDED MAY PRODUCE ONE.
     *
     *   `ok`       persisted            → echo
     *   `degraded` may have landed, retryable, the edit stays in the pane → echo
     *   `stale`    409, did NOT land and resending will not help          → do not
     *   `fatal`    401/403/413/422, provably cannot land                  → do not
     *   `replayed` §34.6 said the key was already spent; THIS call applied
     *              nothing, so there is nothing to claim                   → do not
     *
     * `stale` used to echo, and that was the 2026-08-04 defect wearing a new hat:
     * the pane would go `Saved` over a write the disk never took.
     *
     * BUT NOT ECHOING IS NOT ENOUGH ON ITS OWN. Studio has already been handed a
     * synthetic success for this transaction — it must be, because
     * `consumeUnresolved` only matches a frame against a transaction it has
     * registered — so silence here leaves `BufferedDocument.submitted` holding it
     * for ever, and the pane at `Saving…` with four document actions quietly
     * disabled. The honest recovery is the same one the echo uses for a frame it
     * cannot build: tell the pane to re-read, so it shows the state the write did
     * NOT reach. The banner says separately, and loudly, why.
     */
    const landed = committed === 'ok' || committed === 'degraded'
    const frames = landed ? echo.emit(plan.plans, transactionId) : []
    if (!landed && plan.plans.length > 0) {
      echo.requestResync(
        plan.plans.map((entry) => entry.documentId),
        committed === 'replayed'
          ? `the overlay replayed ${method} from its §34.6 ledger instead of applying it, so ` +
            `there is nothing to echo and the pane is holding a transaction that will never be ` +
            `answered`
          : `the overlay did not accept ${method} (${committed}), so there is nothing to echo and ` +
            `the pane is holding a transaction that will never be answered`,
      )
    }

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

  /* ------------------------------------------------------------- assets */

  /**
   * `client.assets.upload(assetType, body, options)` — PRD §24.3, both shapes.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE HANG THIS REPLACES.
   *
   * This call used to be refused outright, and the refusal never reached the
   * editor: an image dropped into a field patched `_upload: {progress: 2}` into
   * the draft and stayed there forever — no asset, no error, no toast
   * (observed 2026-08-06). The bytes now go to the overlay API, which stores
   * them under `.sanity-overlay/` and commits a synthetic asset document, so
   * `asset._ref` resolves through the ordinary reference machinery.
   *
   * TWO SHAPES, BECAUSE `@sanity/client@7.26.0` HAS TWO. `AssetsClient.upload`
   * resolves to the asset DOCUMENT; `ObservableAssetsClient.upload` emits the
   * raw request events, and sanity 6.8.0's `uploadSanityAsset` completes on
   * `event.type === 'response'` reading `event.body.document._id`. Answering the
   * wrong one is indistinguishable from a hang at the call site.
   *
   * NO SYNTHETIC PROGRESS. `fetch` reports none, and emitting a percentage
   * nobody measured is the §5.5 approximation this exercise exists to remove.
   * The stream carries the one event that is true.
   * ───────────────────────────────────────────────────────────────────────────
   */
  function uploadAsset(kind: Kind, uploader: OverlayAssetUploader, args: unknown[]): unknown {
    const document = uploader({
      assetType: args[0],
      body: args[1],
      ...(args[2] === undefined ? {} : {options: args[2]}),
    }).then((outcome) => {
      /* The asset is an ordinary overlay document the API has already
       * committed. Seeding it here — the same two feeds a commit uses — is what
       * lets `asset->url`, the asset dialog and the file input's download link
       * resolve without waiting for the next `/state` poll. */
      const id = outcome.document._id
      if (typeof id === 'string' && id !== '') {
        const rows: OverlayHydrationDocument[] = [{logicalId: id, published: outcome.document}]
        seedOverlayDocuments(echo, rows)
        options.onHydration?.(rows)
      }
      return outcome.document
    })

    if (kind !== 'observable') return document

    return makeObservable((subscriber) => {
      let closed = false
      void document.then(
        (value) => {
          if (closed) return
          /* The shape `_requestObservable` emits, which is the shape
           * `uploadSanityAsset` destructures. */
          subscriber.next({
            type: 'response',
            statusCode: 200,
            method: 'POST',
            body: {document: value},
          })
          subscriber.complete()
        },
        (error: unknown) => {
          if (closed) return
          /* ERROR, never silence: sanity 6.8.0's image input clears `_upload`
           * and raises a toast from `subscribe({error})`, and from nowhere
           * else. An observable that merely completes leaves "Uploading" on
           * screen for the life of the tab. */
          subscriber.error(error)
        },
      )
      return () => {
        closed = true
      }
    })
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
      if (echo.isOverlaySuppressed(id)) {
        if (authoritative) echo.notePaneSnapshot(id, null)
        return null
      }
      const overlay = echo.getOverlayDocument(id)
      if (overlay === undefined) return value
      /*
       * THE SUBSTITUTION HAS TO BE RECORDED, NOT JUST PERFORMED.
       *
       * `seedFromResult` above learned the revision of the RAW base answer,
       * which is right — that body is the merge ancestor §17 needs. But this is
       * the value the pane's `BufferedDocument` is actually constructed from,
       * and its `_rev` is the SYNTHETIC overlay one. Leaving the echo chaining
       * the next frame off the base revision (or off nothing at all, when base
       * answered `null`) makes every subsequent frame unapplicable, and the
       * symptom is an indefinite `Saving…` with no error anywhere.
       *
       * Only for the AUTHORITATIVE read — the pair listener's `getDocuments`
       * snapshot — because that is the only read Studio rebuilds its document
       * model from. See {@link AUTHORITATIVE_READ_METHODS}.
       */
      if (authoritative) echo.notePaneSnapshot(id, overlay)
      return overlay
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
  /**
   * The same promise, but it cannot outlive the deadline.
   *
   * REJECTS rather than resolving with a sentinel: the caller of a read is
   * `groq-js`, a React hook, or — the case that motivated this —
   * `uploadSanityAsset`'s `mergeMap`. Every one of them has an error channel
   * that reaches a human, and none of them has a "still waiting" channel that
   * does. §5.5: a stated failure beats an unbounded pending state.
   */
  function withReadDeadline(work: Promise<unknown>, label: string): Promise<unknown> {
    const limit = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    if (!(limit > 0)) return work
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          markOverlayRefusal(
            new Error(
              `[sanity-overlay-studio] the base dataset did not answer this read within ` +
                `${limit}ms, so it was abandoned rather than left pending. Nothing was written ` +
                `and nothing was approximated. Query: ${label}`,
            ),
          ),
        )
      }, limit)
    })
    /* ALWAYS cleared. An uncleared two-minute timer keeps a Node process — and
     * every test runner that hosts one — alive long after the work is done. */
    return Promise.race([work, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  function interceptFetch(
    target: object,
    fn: (...args: unknown[]) => unknown,
    args: unknown[],
    kind: Kind,
  ): unknown {
    const router = options.reads
    const delegate = (): unknown => tapReadErrors(fn.apply(target, args))
    if (router === undefined || typeof args[0] !== 'string') return delegate()

    const label = args[0]
    const answered = router({
      query: args[0],
      params: args[1],
      options: args[2],
      /* The CANDIDATE fetch is bounded too, and it has to be: an evaluation the
       * planner proved complete is still gated on staging answering it. */
      baseFetch: (query, params) =>
        withReadDeadline(firstValueOf(fn.call(target, query, params)), query),
    }).then((answer) =>
      answer.answered ? answer.result : withReadDeadline(firstValueOf(delegate()), label),
    )

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
        } else if (path === 'assets' && name === 'upload' && options.assets !== undefined) {
          /* The ONE namespace write with an overlay spelling. Everything else
           * under `assets` — and `upload` itself when no port is configured —
           * falls through to the refusal below, unweakened. */
          const uploader = options.assets
          wrapped = (...args: unknown[]): unknown => uploadAsset(kind, uploader, args)
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
             * THE RAW-`request` READ CLASS, AND WHAT EACH MEMBER GETS.
             *
             * A raw `request({uri})` READ used to be delegated to the base
             * dataset untouched, in every case. Some of those carry document
             * CONTENT or document EXISTENCE, and staging's answer to those is
             * not the branch's. Transcribed from sanity 6.8.0
             * (`node_modules/sanity/lib/…`), with the verdict for each:
             *
             *  INTERCEPTED — answered from the branch (`docReads.ts`):
             *   datastores-DqFH7RLd.js:244   `/data/doc/<ds>/<ids>?excludeContent=true`
             *                                  preview availability, the fallback
             *                                  inside `observeDocumentAvailability`
             *   datastores-DqFH7RLd.js:5533  `createBatchedGetDocumentExists`
             *   structureTool-EN0gOzyJ.js:739  delete-confirm existence probe
             *   useBundleDocuments…:34102    `gdr.availability` — and note that
             *                                  this one's `excludeContent` sits
             *                                  where @sanity/client never reads
             *                                  it, so it is a CONTENT read
             *
             *  INTERCEPTED — answered EMPTY, and said out loud (`history.ts`):
             *   useBundleDocuments…:5009     `/data/history/<ds>/events/documents/<id>`
             *   useBundleDocuments…:5101     `/data/history/<ds>/documents/<id>?revision=`
             *   datastores-DqFH7RLd.js:7122, :7133  `getHistory`,
             *                                  `getDocumentAtRevision`
             *
             *  DELEGATED, and wrong about the branch by construction:
             *   useBundleDocuments…:33275    `/data/doc/<OTHER ds>/<id>` —
             *                                  `cross-dataset-refs.availability`.
             *                                  Same endpoint as the five above
             *                                  but addressed to a dataset this
             *                                  overlay is not for, and the
             *                                  dataset gate refuses to answer
             *                                  it. A branch-created or
             *                                  branch-deleted document is
             *                                  invisible to it either way, which
             *                                  is correct: it is asking about
             *                                  somebody else's dataset, where
             *                                  this branch does not exist.
             *   structureTool-EN0gOzyJ.js:761 `/data/references/<ds>/documents/<id>/to`
             *                                  — a CROSS-DATASET index only the
             *                                  Content Lake maintains. A branch
             *                                  reference is invisible to it and
             *                                  a branch-deleted one still counts.
             *                                  Nothing here can compute it: it
             *                                  spans datasets this session has no
             *                                  credential for. Gated behind
             *                                  `getDocumentExistence`, which IS
             *                                  intercepted, so a branch-deleted
             *                                  document now answers "no such
             *                                  document" before this runs.
             *   datastores-DqFH7RLd.js:7158  `/data/history/<ds>/transactions/…`
             *                                  through `client.request` — see the
             *                                  translog note below; the same
             *                                  NDJSON body, on a path this facade
             *                                  deliberately does not claim.
             *
             *  DELEGATED, and correct: everything else on the list is a PROJECT-
             *  plane read — `/projects/*`, `/users/*`, `/auth/*`, `/features`,
             *  `/access/*`, `/journey/*`, `/schedules/*`, `/media-libraries/*`,
             *  `/intake/*`, `/subscriptions/*`, `/help`. None of them is about a
             *  document, so the branch has nothing to say about any of them.
             *
             *  UNREACHABLE from any client proxy, still: the timeline reads its
             *  transaction log with the GLOBAL `fetch()`, built from
             *  `client.getUrl()` + `client.config().token`
             *  (`datastores-DqFH7RLd.js:6868` `getJsonStream`, called at `:7097`;
             *  `useBundleDocuments…:4822`). No wrapper around a client method can
             *  see those at all — and it is the translog, not the events feed,
             *  that produced the live `getEditEvents` TypeError, because
             *  `{"transactions":[]}` on an NDJSON endpoint decodes to one bogus
             *  transaction with no `effects`. `EMPTY_TRANSLOG_NDJSON` states the
             *  contract that closes it; enforcing it belongs to whatever serves
             *  `apiHost`, which is why the constant is exported rather than used.
             * ─────────────────────────────────────────────────────────────────
             */
            if (!isWrite) {
              /*
               * THE EXISTENCE PROBE, ANSWERED ABOUT THE BRANCH.
               *
               * `docReads.ts` carries the whole argument for why this is a
               * lookup rather than a second read path. Two properties decide
               * the shape of the call here:
               *
               *   - base is asked whenever ANY requested id is one the branch
               *     has no opinion about, and its envelope is EDITED rather
               *     than replaced. A batch of a hundred ids with one branch
               *     document in it still gets base's answer for the other 99.
               *   - base is NOT asked when the branch can answer every id. That
               *     is not an optimisation: it removes a network dependency
               *     from a probe whose answer is already known, and a request
               *     nobody needs is a request that can hang (§5.5).
               *
               * The method test is load-bearing for the same reason it is on
               * the history read: `/data/doc` carries no write plane, so a POST
               * aimed at one of these paths reaches here.
               */
              const branchView = options.branchView
              const docRead =
                branchView === undefined || (method !== 'GET' && method !== 'HEAD')
                  ? undefined
                  : classifyOverlayDocRead(request)
              if (
                docRead !== undefined &&
                branchView !== undefined &&
                /* THE DATASET GATE. See `homeDatasetOf`: a cross-dataset probe
                 * travels on a clone of this very proxy, and the branch has
                 * nothing to say about somebody else's dataset.
                 *
                 * This is ALSO the fail-closed case, without a second test for
                 * it: a client that would not state a dataset leaves
                 * `homeDataset` undefined, and no string equals `undefined`, so
                 * "I could not check" delegates. Written as one comparison
                 * rather than two so there is no branch a test cannot reach. */
                docRead.dataset === homeDataset
              ) {
                const view = branchView()
                const opinions: OverlayDocOpinion[] = docRead.ids.map((id) =>
                  overlayDocOpinion(view, id),
                )
                if (opinions.some((opinion) => opinion !== undefined)) {
                  if (opinions.every((opinion) => opinion !== undefined)) {
                    const answer = overlayDocAnswer({read: docRead, base: undefined, opinions})
                    return kind === 'observable'
                      ? observableOf(answer)
                      : Promise.resolve(answer)
                  }
                  const merged = firstValueOf(tapReadErrors(fn.apply(t, args))).then((base) =>
                    overlayDocAnswer({read: docRead, base, opinions}),
                  )
                  return kind === 'observable' ? observableFrom(merged) : merged
                }
              }

              /*
               * A BRANCH DOCUMENT'S UPSTREAM HISTORY IS EMPTY, AND SAYING SO IS
               * NOT AN APPROXIMATION.
               *
               * Only for a document the branch holds, and only when EVERY id in
               * the request is one — a base id in the list has a real timeline
               * and one branch id must not erase it.
               *
               * `branchHolds` cannot tell "created in the branch" from "base
               * document the branch edited", and this errs towards answering
               * empty for both. That is the safe side, for two reasons. The
               * pane shows BRANCH content, so a base timeline beside it is a
               * lineage the displayed document does not have — §5.5's "no
               * silent approximation" cuts against showing it, and the revert /
               * compare-versions affordances hanging off it would diff branch
               * content against base revisions. And the native history
               * inspector is already removed from an overlay workspace
               * (`features.ts` `DISABLED_HOSTED_INSPECTOR_NAMES`), whose
               * declared residue is precisely "the document-events/timeline
               * machinery still runs". This tells that residue the truth
               * instead of letting it read someone else's past.
               *
               * The method test is load-bearing: `/data/history` carries no
               * write plane, so a POST aimed at one of these paths reaches this
               * branch, and answering it with an empty history would swallow
               * it.
               */
              const branchHolds = options.branchHolds
              const historyRead =
                branchHolds === undefined || (method !== 'GET' && method !== 'HEAD')
                  ? undefined
                  : classifyOverlayHistoryRead(url)
              /* `(id) => branchHolds(id)`, never `.every(branchHolds)`: `every`
               * passes an index as the second argument, and a caller who wrote
               * `branchHolds: set.has.bind(set)`-shaped code would get it. */
              if (
                historyRead !== undefined &&
                branchHolds !== undefined &&
                historyRead.ids.every((id) => branchHolds(id))
              ) {
                announceEmptyHistory(historyRead.ids)
                const answer = emptyOverlayHistoryAnswer(historyRead)
                return kind === 'observable' ? observableOf(answer) : Promise.resolve(answer)
              }
              return tapReadErrors(fn.apply(t, args))
            }
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
        } else if (name === 'config' && options.assetOrigin !== undefined) {
          /**
           * ───────────────────────────────────────────────────────────────────
           * THE IMAGE PIPELINE, POINTED AT THE OVERLAY — PRD §24.7, §24.1.
           *
           * Studio's image preview never reads the asset document's `url`. It
           * renders `createImageUrlBuilder(client).image(ref).url()`, and
           * `@sanity/image-url@2.1.1` builds that string from `client.config()`
           * and nothing else:
           *
           *     baseUrl = (apiHost || 'https://api.sanity.io')
           *                 .replace(/^https:\/\/api\./, 'https://cdn.')
           *     src     = `${baseUrl}/images/${projectId}/${dataset}/…`
           *
           * So a branch image renders if and only if `apiHost` — AS READ HERE —
           * names something that answers that path. The overlay API does, and it
           * answers for BASE assets too, with a 302 to `cdn.sanity.io` (§24.1),
           * which is how one field can hold one of each.
           *
           * THIS DOES NOT MOVE ANY DATA TRAFFIC. `@sanity/client` builds request
           * URLs from its own private `#clientConfig`, never from this method,
           * and this facade's own staging-write guard reads the RAW client
           * (`absoluteRequestUrl(t, …)`), not the proxy — so a write aimed at
           * `*.api.sanity.io` is still recognised and still refused. What
           * changes is only what an OUTSIDE reader of `config()` is told the
           * asset origin is, which is the one thing it is consulted for here.
           *
           * `config(newConfig)` MUTATES IN PLACE AND RETURNS `this`
           * (`SanityClient.ts:1220-1236`). That branch must keep returning a
           * WRAPPED client — handing back the raw one was a live facade escape —
           * so the rewrite applies only to the zero-argument read.
           * ───────────────────────────────────────────────────────────────────
           */
          const assetOrigin = options.assetOrigin
          wrapped = (...args: unknown[]): unknown => {
            /* `guardArguments` and `wrapIfClient` are the DEFAULT branch's two
             * halves, kept verbatim: this branch adds a rewrite to the read, it
             * does not opt out of the guard that made `config` safe. */
            const result = fn.apply(t, guardArguments(args, name, kind))
            if (args.length > 0) return wrapIfClient(result, kind)
            return isRec(result) ? {...result, apiHost: assetOrigin} : result
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
