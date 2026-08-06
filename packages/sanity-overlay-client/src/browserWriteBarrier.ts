/**
 * The browser write barrier — **BEST-EFFORT, and it must never be described as
 * anything else.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR
 *
 * The Studio's own code reaches `api.sanity.io` by routes no `@sanity/client`
 * wrapper can see. Two are shipped and both were observed live:
 *
 *   `sanity@6.8.0` `lib/index.js:1431`
 *       FEEDBACK_TUNNEL_URL = "https://api.sanity.io/vX/intake/feedback"
 *     handed to a Sentry `BrowserClient` with `transport: makeFetchTransport` —
 *     a raw `fetch` POST to an ABSOLUTE URL. `apiHost` injection cannot move it
 *     and the facade never sees it. A CDP capture caught four of these going
 *     direct, past the Track B proxy.
 *
 *   `sanity@6.8.0` `lib/index.js:13064`
 *       navigator.sendBeacon(client.getUrl('/intake/batch'), …)
 *     — a beacon is always a POST and is issued outside the client's request
 *     pipeline entirely.
 *
 * This module closes both, cheaply, at the one place they have in common: the
 * browser globals. It is worth having because the traffic it actually catches
 * is Studio's own accidental egress.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS NOT
 *
 * It is NOT a security boundary. A script that wants an unpatched `fetch` takes
 * two lines to get one out of a same-origin iframe, and nothing here can stop
 * that — the negative control in `test/preview-write-impossibility.test.ts`
 * asserts exactly this so no reader can mistake the barrier for enforcement.
 * Against a motivated attacker the only layers that hold are the browser's own
 * CSP (`previewCsp.ts`) and a server-side default-deny guard
 * (`previewWriteGuard.ts`).
 *
 * Its ledger is a DIAGNOSTIC. An empty ledger is not evidence that nothing
 * escaped: browser-side detection has produced a false all-clear three times in
 * this project, and server-side logs remain the only trustworthy evidence.
 *
 * Dependency-free apart from `stagingHost.ts`, so it can be imported from a
 * Studio bundle, from Node and from a test with no DOM.
 */

import {
  StagingWriteRefusedError,
  isSanityApiHost,
  isStagingWrite,
  normalizeMethod,
} from './stagingHost'

type Rec = Record<string, unknown>

export interface BrowserWriteBarrierRequest {
  method?: unknown
  url?: unknown
}

export interface BrowserWriteRefusal {
  method: string
  url: string
  channel: 'fetch' | 'xhr' | 'beacon' | 'websocket'
  at: number
}

export interface BrowserWriteBarrier {
  /** `refuse` when this request would write to a real Sanity host. */
  classify(request: BrowserWriteBarrierRequest): 'allow' | 'refuse'
  /**
   * A WebSocket is judged on its DESTINATION alone, not its method.
   *
   * `sanity@6.8.0` `lib/WorkspaceLoader-BRx2afZV.js:8300` opens
   * `wss://<p>.api.sanity.io/v2022-06-30/socket/<ds>` with the editor's token
   * and hands it to `@sanity/bifur-client`, whose `RequestMethod` union
   * (`src/types.ts:6-15`) declares **`'mutate'`**. The handshake is a GET; what
   * it is a tunnel to is not. A browser cannot inspect frames, so the only
   * answer available at this layer is to refuse the connection.
   */
  classifyRealtime(url: unknown): 'allow' | 'refuse'
  /** Everything refused so far, newest last. Diagnostic only — see the header. */
  refusals(): readonly BrowserWriteRefusal[]
  note(refusal: Omit<BrowserWriteRefusal, 'at'>): void
}

export interface BrowserWriteBarrierHandle {
  /** `false` when a barrier was already installed on this target. */
  installed: boolean
  barrier: BrowserWriteBarrier
  uninstall(): void
}

/** Marker property, so a second install is a no-op rather than a double wrap. */
const INSTALLED_FLAG = '__sanityOverlayWriteBarrier__'

const MAX_REFUSALS = 200

export function createBrowserWriteBarrier(options: {now?: () => number} = {}): BrowserWriteBarrier {
  const clock = options.now ?? ((): number => Date.now())
  const ledger: BrowserWriteRefusal[] = []

  return {
    classify: (request) => (isStagingWrite(request) ? 'refuse' : 'allow'),
    classifyRealtime: (url) => {
      const host = hostOf(url)
      return host !== '' && isSanityApiHost(host) ? 'refuse' : 'allow'
    },
    refusals: () => ledger.slice(),
    note: (refusal) => {
      ledger.push({...refusal, at: clock()})
      if (ledger.length > MAX_REFUSALS) ledger.splice(0, ledger.length - MAX_REFUSALS)
    },
  }
}

function hostOf(value: unknown): string {
  const raw = typeof value === 'string' ? value : value instanceof URL ? value.href : ''
  if (raw === '') return ''
  try {
    return new URL(raw.startsWith('//') ? `https:${raw}` : raw).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return ''
  }
}

function urlOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  if (typeof value === 'object' && value !== null) {
    const url = (value as {url?: unknown}).url
    if (typeof url === 'string') return url
  }
  return String(value ?? '')
}

function refusal(method: string, url: string, context: string): StagingWriteRefusedError {
  return new StagingWriteRefusedError({method, host: hostOf(url), url, context})
}

/**
 * Patch the network globals on `target` so a write to a real Sanity host does
 * not leave the page.
 *
 * `target` defaults to `globalThis`, which is `window` in a Studio bundle. It is
 * injected so this module is testable with no DOM and so a host can install the
 * barrier onto an iframe's contentWindow if it wants to.
 *
 * Idempotent: installing twice leaves the first barrier in place and reports
 * `installed: false`, because a double wrap would double-count the ledger and
 * make `uninstall` restore a patched function rather than the original.
 */
export function installBrowserWriteBarrier(
  target: unknown = globalThis,
  options: {barrier?: BrowserWriteBarrier} = {},
): BrowserWriteBarrierHandle {
  const host = (typeof target === 'object' && target !== null ? target : {}) as Rec
  const existing = host[INSTALLED_FLAG]
  if (existing !== undefined) {
    return existing as BrowserWriteBarrierHandle
  }

  const barrier = options.barrier ?? createBrowserWriteBarrier()
  const restores: Array<() => void> = []

  /* ------------------------------------------------------------- fetch */

  const originalFetch = host.fetch
  if (typeof originalFetch === 'function') {
    const impl = originalFetch as (input: unknown, init?: unknown) => Promise<unknown>
    host.fetch = (input: unknown, init?: Rec): Promise<unknown> => {
      const method = normalizeMethod(
        init?.method ??
          (typeof input === 'object' && input !== null ? (input as Rec).method : undefined),
      )
      const url = urlOf(input)
      if (barrier.classify({method, url}) === 'refuse') {
        barrier.note({method, url, channel: 'fetch'})
        /* Rejects rather than throwing synchronously: `fetch` never throws
         * synchronously, and a wrapper that did would escape every `.catch()`
         * its caller already has. */
        return Promise.reject(refusal(method, url, 'browser write barrier (fetch)'))
      }
      return impl.call(host, input, init)
    }
    restores.push(() => {
      host.fetch = originalFetch
    })
  }

  /* -------------------------------------------------------- sendBeacon */

  const navigator = host.navigator
  if (typeof navigator === 'object' && navigator !== null) {
    const nav = navigator as Rec
    const originalBeacon = nav.sendBeacon
    if (typeof originalBeacon === 'function') {
      const impl = originalBeacon as (url: unknown, data?: unknown) => boolean
      nav.sendBeacon = (url: unknown, data?: unknown): boolean => {
        /* A beacon is always a POST — there is no other verb it can issue. */
        const target_ = urlOf(url)
        if (barrier.classify({method: 'POST', url: target_}) === 'refuse') {
          barrier.note({method: 'POST', url: target_, channel: 'beacon'})
          /* `false` is `sendBeacon`'s own "could not queue" signal, so a caller
           * that checks the return value sees a shape it already handles. */
          return false
        }
        return impl.call(nav, url, data)
      }
      restores.push(() => {
        nav.sendBeacon = originalBeacon
      })
    }
  }

  /* --------------------------------------------------------- WebSocket */

  const originalWebSocket = host.WebSocket
  if (typeof originalWebSocket === 'function') {
    const Original = originalWebSocket as unknown as new (...args: unknown[]) => object
    function GuardedWebSocket(this: unknown, ...args: unknown[]): unknown {
      const url = urlOf(args[0])
      if (barrier.classifyRealtime(url) === 'refuse') {
        barrier.note({method: 'WEBSOCKET', url, channel: 'websocket'})
        throw refusal('WEBSOCKET', url, 'browser write barrier (WebSocket)')
      }
      return Reflect.construct(Original, args)
    }
    const guarded = GuardedWebSocket as unknown as Rec
    /* Inherit statics (`OPEN`, `CLOSING`, …) and keep `instanceof` working. */
    Object.setPrototypeOf(guarded, Original)
    guarded.prototype = (Original as unknown as Rec).prototype
    host.WebSocket = guarded
    restores.push(() => {
      host.WebSocket = originalWebSocket
    })
  }

  /* --------------------------------------------------- XMLHttpRequest */

  const originalXhr = host.XMLHttpRequest
  if (typeof originalXhr === 'function') {
    const proto = (originalXhr as unknown as {prototype?: Rec}).prototype
    if (proto !== undefined && typeof proto.open === 'function' && typeof proto.send === 'function') {
      const openImpl = proto.open as (...args: unknown[]) => unknown
      const sendImpl = proto.send as (...args: unknown[]) => unknown
      /* Keyed by instance so two concurrent requests cannot read each other's
       * target, and so nothing is written onto an object the page owns. */
      const pending = new WeakMap<object, {method: string; url: string}>()

      proto.open = function patchedOpen(this: object, ...args: unknown[]): unknown {
        pending.set(this, {method: normalizeMethod(args[0]), url: urlOf(args[1])})
        return openImpl.apply(this, args)
      }
      proto.send = function patchedSend(this: object, ...args: unknown[]): unknown {
        const record = pending.get(this)
        if (record !== undefined && barrier.classify(record) === 'refuse') {
          barrier.note({...record, channel: 'xhr'})
          /* `XMLHttpRequest.send` DOES throw synchronously on a rejected
           * request (`InvalidStateError`, `NetworkError`), so throwing here is
           * the shape a caller already has to handle. */
          throw refusal(record.method, record.url, 'browser write barrier (XMLHttpRequest)')
        }
        return sendImpl.apply(this, args)
      }
      restores.push(() => {
        proto.open = openImpl
        proto.send = sendImpl
      })
    }
  }

  /*
   * `EventSource` is deliberately NOT patched. It can only ever issue a GET —
   * there is no API on it to choose a method or send a body — so refusing it
   * would break `client.listen()` and the Live Events stream while closing
   * nothing. Its origin is governed by `connect-src` like every other channel.
   */

  const handle: BrowserWriteBarrierHandle = {
    installed: true,
    barrier,
    uninstall: () => {
      if (host[INSTALLED_FLAG] === undefined) return
      delete host[INSTALLED_FLAG]
      for (const restore of restores.reverse()) restore()
    },
  }

  Object.defineProperty(host, INSTALLED_FLAG, {
    value: {...handle, installed: false},
    configurable: true,
    enumerable: false,
    writable: true,
  })

  return handle
}
