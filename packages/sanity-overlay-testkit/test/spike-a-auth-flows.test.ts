/**
 * SPIKE A — auth failure, logout and post-logout writes (Gate A + Gate B breadth).
 *
 * `gate-review.md` lists *"auth-failure/reconnect/logout paths untested"* as a
 * standing condition on Gate A and as unfinished breadth on Gate B, and
 * `listener-matrix.md` closes with **"Auth failure, token refresh and logout
 * paths"** under *still requires a browser or a human*. This file removes the
 * protocol half of that from the browser-only list. (Reconnect is criterion 3
 * and already lives in `listener-matrix.test.ts`; the auth-drop variant is added
 * there rather than duplicated here.)
 *
 * THE QUESTION THAT MATTERS
 * The facade answers every intercepted write with a synthetic `{transactionId}`
 * success. That is correct while the write is *going somewhere* — in-memory when
 * `SPIKE_OVERLAY_PERSIST` is off, on disk when it is on. It stops being correct
 * the moment the write provably cannot land: a 401/403 means the session is over,
 * retrying will not help, and telling Studio "saved" makes the editor lie to the
 * user about content that exists nowhere. So:
 *
 *   | situation                          | Studio is told |
 *   |------------------------------------|----------------|
 *   | persistence off, session live      | success (in-memory echo — pinned below) |
 *   | persistence on, commit accepted    | success        |
 *   | persistence on, commit 5xx/offline | success, loudly degraded (pinned below) |
 *   | 401/403 anywhere in the session    | **failure**    |
 *   | after logout                       | **failure**    |
 *
 * The 5xx row is deliberately not a failure: persistence is a strict *addition*
 * to the echo (`localEcho.ts` header), an outage is transient, and the layer
 * already shouts through `__SPIKE_ECHO__.errors` + `console.error`. A 401 is not
 * transient, which is the whole distinction this file pins.
 *
 * TWO SEAMS, NO BROWSER
 * 1. `echoProtocol.ts` — the pure session/ack layer (`sessionState`,
 *    `noteAuthFailure`, `logout`, `acknowledgeWrite`) plus the request-path
 *    matchers the facade guards with.
 * 2. `localEcho.ts` — driven through `wrapWithLocalEcho` against a fake client
 *    and a stubbed `fetch`, so the assertions are about what a *Studio-shaped
 *    caller* actually receives, not about the protocol agreeing with itself.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  authStatusOf,
  createEchoProtocol,
  isLogoutEndpoint,
  isMutationEndpoint,
  requestPath,
  type EchoMutationEvent,
  type EchoProtocol,
} from '../../../examples/kitchen-sink/spikeA/echoProtocol'

type Rec = Record<string, unknown>

const PUBLISHED = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

const DRAFT = {
  _id: 'drafts.article-1',
  _type: 'article',
  _rev: 'lake-draft-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-02T00:00:00.000Z',
  title: 'Article 1 draft',
}

const PAIR_IDS = ['article-1', 'drafts.article-1'] as const

function seeded(errors: string[] = []): EchoProtocol {
  let tick = 0
  const protocol = createEchoProtocol({
    now: () => Date.UTC(2026, 0, 1) + (tick += 1000),
    onError: (message) => errors.push(message),
  })
  protocol.seedFromResult([PUBLISHED, DRAFT], true)
  return protocol
}

function editAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      patch: {set: {title}},
    },
  ]
}

/* ================================================================== *
 * 1. Recognising an auth failure on the wire
 * ================================================================== */

describe('authStatusOf — the error shapes @sanity/client throws', () => {
  /**
   * Read off `@sanity/client` 7.26.0's own typings: `ClientError` carries
   * `statusCode`, `response`, `responseBody` and `details`; the shared
   * `HttpError` interface carries `statusCode` plus a `response` that repeats it.
   * A `fetch` Response-shaped rejection uses `status`. All four reach this layer
   * depending on whether the failure came from the requester, the observable
   * pipeline or the overlay server's own `fetch`.
   */
  const AUTH_SHAPES: Array<[string, unknown]> = [
    ['ClientError statusCode', Object.assign(new Error('Unauthorized'), {statusCode: 401})],
    ['ClientError 403', Object.assign(new Error('Forbidden'), {statusCode: 403})],
    ['HttpError response.statusCode', {response: {statusCode: 401, body: {}}}],
    ['fetch Response status', {status: 403}],
    ['nested response.status', {response: {status: 401}}],
    ['API error body in details', {details: {error: 'Unauthorized', statusCode: 401}}],
    ['API error body in response.body', {response: {body: {statusCode: 403}}}],
    ['numeric string', {statusCode: '401'}],
  ]

  for (const [label, error] of AUTH_SHAPES) {
    it(`recognises ${label}`, () => {
      expect([401, 403]).toContain(authStatusOf(error))
    })
  }

  /** Everything else must stay invisible: over-reporting blocks writes. */
  const NON_AUTH: Array<[string, unknown]> = [
    ['server error', Object.assign(new Error('boom'), {statusCode: 500})],
    ['not found', {statusCode: 404}],
    ['conflict', {statusCode: 409}],
    ['transport failure', new TypeError('fetch failed')],
    ['null', null],
    ['undefined', undefined],
    ['string', 'Unauthorized'],
    ['bare number', 401],
    ['a 401 inside a message only', new Error('request failed with 401')],
  ]

  for (const [label, error] of NON_AUTH) {
    it(`does not treat ${label} as an auth failure`, () => {
      expect(authStatusOf(error)).toBeUndefined()
    })
  }
})

/* ================================================================== *
 * 2. Auth failure mid-session — on the listener
 * ================================================================== */

describe('auth failure on the listener', () => {
  it('surfaces the failure instead of swallowing it', () => {
    const errors: string[] = []
    const protocol = seeded(errors)

    protocol.noteAuthFailure({status: 401, source: 'listener', message: 'token expired'})

    expect(protocol.sessionState()).toBe('unauthenticated')
    expect(protocol.authFailures()).toEqual([
      {status: 401, source: 'listener', message: 'token expired'},
    ])
    /* `onError` is what reaches `__SPIKE_ECHO__.errors` and `console.error` in
     * the browser — a failure nobody can see is the same as a swallowed one. */
    expect(errors.join('\n')).toContain('401')
    expect(errors.join('\n')).toContain('listener')
  })

  it('does not corrupt the revision chain', () => {
    const protocol = seeded()
    const before = protocol.revisions()

    protocol.noteAuthFailure({status: 403, source: 'listener'})

    /* An expired token says nothing about what the Content Lake holds. Dropping
     * or inventing a revision here would break `sequentializeListenerEvents`'
     * `previousRev -> resultRev` chain on reconnect, 30 s later and far from the
     * cause. */
    expect(protocol.revisions()).toEqual(before)
    expect(protocol.revisionOf('drafts.article-1')).toBe(DRAFT._rev)
  })

  it('keeps panes subscribed — a dropped stream is not a logout', () => {
    const protocol = seeded()
    protocol.subscribe(PAIR_IDS, () => {})

    protocol.noteAuthFailure({status: 401, source: 'listener'})

    /* Studio reconnects its listener after an auth refresh; releasing the pane
     * here would leave it permanently deaf even after the token comes back. */
    expect(protocol.subscriberCount()).toBe(1)
  })

  it('recovers on token refresh and chains off the revision it kept', () => {
    const protocol = seeded()
    const frames: EchoMutationEvent[] = []
    protocol.subscribe(PAIR_IDS, (event) => frames.push(event))

    protocol.noteAuthFailure({status: 401, source: 'listener'})
    protocol.restoreSession()

    expect(protocol.sessionState()).toBe('active')
    expect(protocol.acknowledgeWrite()).toEqual({ok: true})
    protocol.emit(protocol.planActions(editAction('After refresh')).plans, 'tx-after-refresh')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.previousRev).toBe(DRAFT._rev)
  })
})

/* ================================================================== *
 * 3. Auth failure mid-session — on a write
 * ================================================================== */

describe('auth failure on a write', () => {
  it('refuses to acknowledge a write it could not persist', () => {
    const protocol = seeded()
    expect(protocol.acknowledgeWrite()).toEqual({ok: true})

    protocol.noteAuthFailure({status: 403, source: 'write', message: 'POST /commit responded 403'})

    const ack = protocol.acknowledgeWrite()
    expect(ack.ok).toBe(false)
    expect(ack.error?.status).toBe(403)
    expect(ack.error?.message).toContain('403')
  })

  it('keeps acknowledging while the failure is transient, not authentication', () => {
    /* The boundary this file exists to draw. A 500 or an offline overlay server
     * is what `localEcho.ts`'s "persistence is a strict addition to the echo"
     * degradation is for: it is loud (§ `persistFailure`) but it does not end the
     * session. Only 401/403 does, and only 401/403 may stop the acknowledgement. */
    const protocol = seeded()
    protocol.setDocState('drafts.article-1', {}) // no-op; state untouched by 5xx
    expect(protocol.acknowledgeWrite()).toEqual({ok: true})
    expect(protocol.sessionState()).toBe('active')
  })

  it('does not advance the revision chain for the refused write', () => {
    const protocol = seeded()
    protocol.noteAuthFailure({status: 401, source: 'write'})

    /* The refusal happens in `localEcho`'s `blockedResult`, which never calls the
     * echo scheduler for a refused write. What the protocol must guarantee is the
     * other half: nothing about the failure itself moves HEAD. */
    expect(protocol.revisionOf('drafts.article-1')).toBe(DRAFT._rev)
    expect(protocol.getDocState('drafts.article-1')?.synthetic).toBe(false)
  })

  it('records every failure in order for forensics', () => {
    const protocol = seeded()
    protocol.noteAuthFailure({status: 401, source: 'listener'})
    protocol.noteAuthFailure({status: 403, source: 'write'})

    expect(protocol.authFailures().map((f) => [f.source, f.status])).toEqual([
      ['listener', 401],
      ['write', 403],
    ])
  })
})

/* ================================================================== *
 * 4. Logout
 * ================================================================== */

describe('logout', () => {
  it('releases every subscription', () => {
    const protocol = seeded()
    protocol.subscribe(PAIR_IDS, () => {})
    protocol.subscribe(['article-1'], () => {})
    expect(protocol.subscriberCount()).toBe(2)

    protocol.logout()

    /* §21.4.1 criterion 4's rule, applied to the whole session rather than one
     * pane: "unsubscription stops updates and releases resources". */
    expect(protocol.subscriberCount()).toBe(0)
    expect(protocol.sessionState()).toBe('logged-out')
  })

  it('delivers no further events', () => {
    const protocol = seeded()
    const frames: EchoMutationEvent[] = []
    protocol.subscribe(PAIR_IDS, (event) => frames.push(event))

    protocol.logout()
    protocol.emit(protocol.planActions(editAction('After logout')).plans, 'tx-after-logout')

    expect(frames).toEqual([])
  })

  it('does not register a subscription taken out after logout', () => {
    const protocol = seeded()
    protocol.logout()

    const frames: EchoMutationEvent[] = []
    const late = protocol.subscribe(PAIR_IDS, (event) => frames.push(event))
    protocol.emit(protocol.planActions(editAction('Ghost')).plans, 'tx-ghost')

    expect(protocol.subscriberCount()).toBe(0)
    expect(frames).toEqual([])
    expect(() => late.unsubscribe()).not.toThrow()
  })

  it('does not fabricate a success for a write attempted after logout', () => {
    const protocol = seeded()
    protocol.logout()

    const ack = protocol.acknowledgeWrite()
    expect(ack.ok).toBe(false)
    expect(ack.error?.message).toContain('logged out')
  })

  it('leaves the revision chain untouched', () => {
    const protocol = seeded()
    const before = protocol.revisions()

    protocol.logout()
    protocol.emit(protocol.planActions(editAction('Ghost')).plans, 'tx-ghost')

    /* An emit that reached the revision store but no subscriber would be the
     * worst of both: the next session's first frame would chain off a revision
     * no pane ever saw. */
    expect(protocol.revisions()).toEqual(before)
  })

  it('is terminal — a token refresh cannot resurrect the session', () => {
    const protocol = seeded()
    protocol.logout()

    protocol.restoreSession()

    expect(protocol.sessionState()).toBe('logged-out')
    expect(protocol.acknowledgeWrite().ok).toBe(false)
  })

  it('reports the logout so it is visible in __SPIKE_ECHO__', () => {
    const errors: string[] = []
    const protocol = seeded(errors)
    protocol.logout()
    expect(errors.join('\n')).toContain('logged out')
  })
})

/* ================================================================== *
 * 5. The request-path guards
 * ================================================================== *
 *
 * Studio's logout is `client.request({uri: '/auth/logout', method: 'POST'})` on
 * a middleware-stripped clone — read out of
 * `node_modules/sanity/lib/WorkspaceLoader-BRx2afZV.js:2751-2765`, not guessed.
 * `request` therefore has to recognise it, and the recogniser has to survive the
 * same path-normalisation variants Gate E's Spike F found the *write* guard
 * failing on ("leading-slash-less `request` to `/data/mutate`").
 */

describe('request-path normalisation', () => {
  const CASES: Array<[string, string]> = [
    ['/data/mutate/parity', '/data/mutate/parity'],
    ['data/mutate/parity', '/data/mutate/parity'],
    ['//data//mutate', '/data/mutate'],
    ['/data/mutate/', '/data/mutate'],
    ['/data/mutate?returnIds=true', '/data/mutate'],
    ['/data/mutate#frag', '/data/mutate'],
    ['/DATA/Mutate', '/data/mutate'],
    ['/v1/./data/../data/mutate', '/v1/data/mutate'],
    ['%2Fdata%2Fmutate', '/data/mutate'],
    ['https://p.api.sanity.io/v2025-02-19/data/mutate/parity', '/v2025-02-19/data/mutate/parity'],
    ['  /data/mutate  ', '/data/mutate'],
    ['', '/'],
  ]

  for (const [input, expected] of CASES) {
    it(`normalises ${JSON.stringify(input)}`, () => {
      expect(requestPath(input)).toBe(expected)
    })
  }

  it('normalises a non-string to the root path rather than throwing', () => {
    expect(requestPath(undefined)).toBe('/')
    expect(requestPath(null)).toBe('/')
    expect(requestPath({url: '/data/mutate'})).toBe('/')
  })
})

describe('isMutationEndpoint — the write guard, over the whole variant family', () => {
  const BLOCKED = [
    '/data/mutate/parity',
    'data/mutate/parity',
    '//data/mutate/parity',
    '/data/actions/parity',
    'data/actions/parity',
    '/v2025-02-19/data/mutate/parity',
    'https://p.api.sanity.io/v2025-02-19/data/mutate/parity',
    '/DATA/MUTATE/parity',
    '/data/mutate/parity?returnIds=true',
    '%2Fdata%2Fmutate%2Fparity',
    '/v1/./data/mutate',
  ]

  for (const url of BLOCKED) {
    it(`blocks ${url}`, () => {
      expect(isMutationEndpoint(url)).toBe(true)
    })
  }

  const ALLOWED = [
    '/data/query/parity',
    '/data/export/parity',
    '/data/listen/parity',
    '/users/me',
    '/projects',
    '/data/mutated/parity',
    '/data/mutateur',
    '/assets/images/parity',
  ]

  for (const url of ALLOWED) {
    it(`passes ${url} through`, () => {
      expect(isMutationEndpoint(url)).toBe(false)
    })
  }
})

describe('isLogoutEndpoint — the same family, for the logout signal', () => {
  const LOGOUT = [
    '/auth/logout',
    'auth/logout',
    '//auth//logout',
    '/auth/logout/',
    '/AUTH/Logout',
    '/auth/logout?redirect=%2F',
    'https://p.api.sanity.io/v2025-02-19/auth/logout',
    '%2Fauth%2Flogout',
  ]

  for (const url of LOGOUT) {
    it(`recognises ${url}`, () => {
      expect(isLogoutEndpoint(url)).toBe(true)
    })
  }

  const NOT_LOGOUT = ['/auth/login', '/auth/logout-all', '/authenticate/logout', '/data/mutate']

  for (const url of NOT_LOGOUT) {
    it(`does not treat ${url} as a logout`, () => {
      expect(isLogoutEndpoint(url)).toBe(false)
    })
  }
})

/* ================================================================== *
 * 6. Through the facade — what a Studio-shaped caller actually gets
 * ================================================================== *
 *
 * The protocol above decides; `localEcho.ts` is what Studio talks to. These
 * assertions are made on the value `client.create(...)` / `client.action(...)`
 * resolves or rejects with, so a protocol that decides correctly but is wired in
 * wrongly still fails.
 */

class StubStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new StubStorage()
const win: Record<string, unknown> = {localStorage: storage}
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).localStorage = storage

/**
 * A genuine rxjs-shaped Observable.
 *
 * `localEcho.probeObservableCtor` captures the constructor off the first
 * observable the real client produces and reuses it for every synthetic stream;
 * if it cannot, it falls back to `ShimObservable` and *says so* in
 * `__SPIKE_ECHO__.errors`. Supplying a real class here keeps the tested path the
 * same one the browser takes.
 */
interface TinySubscriber<T> {
  next: (value: T) => void
  error: (error: unknown) => void
  complete: () => void
}

type TinyTeardown = (() => void) | {unsubscribe: () => void} | void

class TinyObservable<T> {
  readonly #onSubscribe: (subscriber: TinySubscriber<T>) => TinyTeardown

  constructor(onSubscribe: (subscriber: TinySubscriber<T>) => TinyTeardown) {
    this.#onSubscribe = onSubscribe
  }

  subscribe(observer: {
    next?: (v: T) => void
    error?: (e: unknown) => void
    complete?: () => void
  }): {unsubscribe: () => void} {
    let closed = false
    const teardown = this.#onSubscribe({
      next: (v) => {
        if (!closed) observer.next?.(v)
      },
      error: (e) => {
        if (!closed) {
          closed = true
          observer.error?.(e)
        }
      },
      complete: () => {
        if (!closed) {
          closed = true
          observer.complete?.()
        }
      },
    })
    return {
      unsubscribe: () => {
        closed = true
        if (typeof teardown === 'function') teardown()
        else if (teardown && typeof teardown.unsubscribe === 'function') teardown.unsubscribe()
      },
    }
  }

  pipe(...ops: Array<(src: unknown) => unknown>): unknown {
    return ops.reduce<unknown>((src, op) => op(src), this)
  }
}

interface FakeClient {
  observable: Rec
  [key: string]: unknown
}

/** The subset of `SanityClient` the facade touches, plus a "never reached" trap. */
function makeFakeClient(options: {upstream?: TinyObservable<unknown>} = {}): {
  client: FakeClient
  realCalls: string[]
} {
  const realCalls: string[] = []
  const upstream = options.upstream ?? new TinyObservable<unknown>(() => () => {})
  const shared = {
    fetch: (query: string): unknown => {
      realCalls.push(`fetch:${query.slice(0, 24)}`)
      return new TinyObservable<unknown>(() => () => {})
    },
    listen: (): unknown => {
      realCalls.push('listen')
      return upstream
    },
    getDocuments: (ids: string[]): unknown => {
      realCalls.push(`getDocuments:${ids.join(',')}`)
      return Promise.resolve(
        ids.map((id) => (id === PUBLISHED._id ? PUBLISHED : id === DRAFT._id ? DRAFT : null)),
      )
    },
    request: (opts: Rec): unknown => {
      realCalls.push(`request:${String(opts.uri ?? opts.url ?? '')}`)
      return Promise.resolve({ok: true})
    },
    action: (): never => {
      throw new Error('a write reached the real client')
    },
    create: (): never => {
      throw new Error('a write reached the real client')
    },
    mutate: (): never => {
      throw new Error('a write reached the real client')
    },
  }
  const client: FakeClient = {
    ...shared,
    observable: {...shared},
    withConfig: (): unknown => client,
  }
  return {client, realCalls}
}

interface EchoWindow {
  __SPIKE_ECHO__?: {
    errors: string[]
    emitted: Array<{documentId: string; transactionId: string}>
    revs: Record<string, string | undefined>
    persist: {failed: number; committed: number; hydrated: boolean | null}
    blocked: Array<{method: string; handled: boolean}>
  }
}

type EchoModule = typeof import('../../../examples/kitchen-sink/spikeA/localEcho')

/** Responses the stubbed `fetch` gives the overlay server, per test. */
interface OverlayStub {
  commitStatus: number
  commitBody: Rec
  calls: string[]
}

let overlay: OverlayStub

/**
 * Load a FRESH `localEcho` under a given flag set.
 *
 * `isEchoEnabled` / `isPersistEnabled` cache for the module's lifetime by design
 * (a mid-session flip would leave the revision chain half synthetic), and the
 * protocol instance is module-level, so a scenario can only be run on a module
 * instance that has never seen another one.
 */
async function loadEcho(flags: Record<string, string>): Promise<EchoModule> {
  /* `scheduleEcho` runs on a macrotask, so the *previous* test's module instance
   * can still be holding a pending timer. Flush it into the log it belongs to
   * before that log is replaced, or its frames land in this test's evidence. */
  await settle()
  storage.clear()
  for (const [key, value] of Object.entries(flags)) storage.setItem(key, value)
  ;(win as EchoWindow).__SPIKE_ECHO__ = undefined
  vi.resetModules()
  return import('../../../examples/kitchen-sink/spikeA/localEcho')
}

function echoLog(): NonNullable<EchoWindow['__SPIKE_ECHO__']> {
  const log = (win as EchoWindow).__SPIKE_ECHO__
  if (!log) throw new Error('__SPIKE_ECHO__ was never created')
  return log
}

/** Let the `setTimeout(…, 0)` echo scheduler and any pending fetch settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  overlay = {commitStatus: 200, commitBody: {ok: true, committed: true, documents: []}, calls: []}
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as Record<string, unknown>).fetch = async (
    url: string,
    init?: {method?: string},
  ): Promise<unknown> => {
    overlay.calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (String(url).endsWith('/state')) {
      return {ok: true, status: 200, json: async () => ({ok: true, documents: []})}
    }
    return {
      ok: overlay.commitStatus < 400,
      status: overlay.commitStatus,
      json: async () => overlay.commitBody,
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the facade under an auth failure', () => {
  it('answers a write with a synthetic success while the session is live', async () => {
    /* Prior art, pinned: with persistence OFF the layer is an in-memory echo and
     * the synthetic success is the correct answer. Everything below is a
     * deviation from THIS, so it has to be nailed down first. */
    const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

    const result = await (wrapped.create as (d: Rec) => Promise<Rec>)({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'In memory only',
    })

    expect(result).toMatchObject({transactionId: expect.stringContaining('local-echo-')})
    await settle()
    expect(echoLog().emitted.map((e) => e.documentId)).toEqual(['drafts.article-1'])
  })

  it('rejects a write the overlay refused with 401 instead of reporting it saved', async () => {
    const {wrapWithLocalEcho} = await loadEcho({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec
    overlay.commitStatus = 401
    overlay.commitBody = {ok: false, error: {message: 'token expired'}}

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({
        _id: 'drafts.article-1',
        _type: 'article',
        title: 'Never persisted',
      }),
    ).rejects.toThrow(/401/)

    await settle()
    /* The three things a fabricated success would have hidden. */
    expect(echoLog().emitted).toEqual([])
    expect(echoLog().revs['drafts.article-1']).toBeUndefined()
    expect(echoLog().errors.join('\n')).toContain('401')
  })

  it('errors the observable form too — Studio commits through client.observable.action', async () => {
    const {wrapWithLocalEcho} = await loadEcho({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec
    overlay.commitStatus = 403
    overlay.commitBody = {ok: false, error: {message: 'forbidden'}}

    const observable = (
      (wrapped.observable as Rec).action as (a: unknown, o: Rec) => TinyObservable<unknown>
    )(
      [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {title: 'Nope'}},
        },
      ],
      {transactionId: 'tx-403'},
    )

    const outcome = await new Promise<{next?: unknown; error?: unknown}>((resolve) => {
      observable.subscribe({
        next: (value) => resolve({next: value}),
        error: (error) => resolve({error}),
      })
    })

    expect(outcome.next).toBeUndefined()
    expect(String((outcome.error as Error)?.message)).toContain('403')
    await settle()
    expect(echoLog().emitted).toEqual([])
  })

  it('does not persist a write it has already decided to disown', async () => {
    /* The refusal is checked BEFORE the persistence attempt as well as after.
     * Without the first check a write made after the session died would still be
     * POSTed — landing on disk — and only then be reported as failed, which is
     * the mirror image of the bug this file exists to fix: content that exists
     * but is reported missing. */
    const {wrapWithLocalEcho} = await loadEcho({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec
    overlay.commitStatus = 401
    overlay.commitBody = {ok: false, error: {message: 'token expired'}}

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/401/)
    const afterFirst = overlay.calls.filter((call) => call.includes('/commit')).length
    expect(afterFirst).toBe(1)

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-2', _type: 'article'}),
    ).rejects.toThrow(/401/)

    expect(overlay.calls.filter((call) => call.includes('/commit'))).toHaveLength(afterFirst)
  })

  it('still degrades loudly (not fatally) when the overlay is merely broken', async () => {
    /* The other side of the boundary: a 500 is an outage, and `localEcho.ts`
     * exists to keep editing usable through one. It must stay loud — `failed` and
     * `errors` — but it must NOT fail the write, or a flaky dev server would look
     * identical to a revoked token. */
    const {wrapWithLocalEcho} = await loadEcho({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec
    overlay.commitStatus = 500
    overlay.commitBody = {ok: false, error: {message: 'boom'}}

    const result = await (wrapped.create as (d: Rec) => Promise<Rec>)({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'Degraded',
    })

    expect(result).toMatchObject({transactionId: expect.any(String)})
    await settle()
    expect(echoLog().persist.failed).toBeGreaterThan(0)
    expect(echoLog().emitted).toHaveLength(1)
  })

  it('surfaces a 401 arriving on the pair listener stream', async () => {
    const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
    let fail: ((error: unknown) => void) | undefined
    const upstream = new TinyObservable<unknown>((subscriber) => {
      fail = (error) => subscriber.error(error)
      return () => {}
    })
    const {client} = makeFakeClient({upstream})
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

    let seen: unknown
    const stream = (
      wrapped.listen as (q: string, p: Rec) => TinyObservable<unknown>
    )('*[_id in $ids]', {ids: [...PAIR_IDS]})
    stream.subscribe({error: (error) => (seen = error)})
    fail?.(Object.assign(new Error('Unauthorized'), {statusCode: 401}))

    /* The error still reaches Studio — the facade is a tap, not a filter — and it
     * is also recorded, which is what "surfaces rather than swallows" means. */
    expect((seen as Error)?.message).toContain('Unauthorized')
    expect(echoLog().errors.join('\n')).toContain('401')

    /* And the session is now closed to writes: a 401 on the listener means the
     * same token would 401 on the write. */
    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/401/)
  })
})

describe('the facade at logout', () => {
  it('releases the pair subscription and stops delivering', async () => {
    const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
    const {client} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

    const frames: unknown[] = []
    ;(wrapped.listen as (q: string, p: Rec) => TinyObservable<unknown>)('*[_id in $ids]', {
      ids: [...PAIR_IDS],
    }).subscribe({next: (event) => frames.push(event)})

    await (wrapped.create as (d: Rec) => Promise<Rec>)({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'Before logout',
    })
    await settle()
    expect(frames).toHaveLength(1)

    /* Exactly what sanity 6.8.0 issues on logout
     * (`WorkspaceLoader-BRx2afZV.js:2751-2765`), including the middleware-stripped
     * clone it issues it on. */
    const stripped = (wrapped.withConfig as (c: Rec) => Rec)({_requestHandler: undefined})
    await (stripped.request as (o: Rec) => Promise<unknown>)({
      uri: '/auth/logout',
      method: 'POST',
    })

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({
        _id: 'drafts.article-1',
        _type: 'article',
        title: 'After logout',
      }),
    ).rejects.toThrow(/logged out/i)
    await settle()
    expect(frames).toHaveLength(1)
  })

  it('still performs the real logout request', async () => {
    const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
    const {client, realCalls} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

    await (wrapped.request as (o: Rec) => Promise<unknown>)({
      uri: '/auth/logout',
      method: 'POST',
    })

    /* Swallowing the logout would leave a live session token behind — a Gate E
     * problem, not a convenience one. */
    expect(realCalls).toContain('request:/auth/logout')
  })
})

describe('the facade’s write guard, over the path family Gate E found it failing on', () => {
  const VARIANTS = ['/data/mutate/parity', 'data/mutate/parity', '/data/actions/parity']

  for (const uri of VARIANTS) {
    it(`blocks request({uri: ${JSON.stringify(uri)}})`, async () => {
      const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
      const {client, realCalls} = makeFakeClient()
      const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

      const result = await (wrapped.request as (o: Rec) => Promise<Rec>)({
        uri,
        method: 'POST',
        body: {mutations: [{patch: {id: 'drafts.article-1', set: {title: 'Escaped'}}}]},
      })

      expect(result).toMatchObject({transactionId: expect.any(String)})
      expect(realCalls.filter((call) => call.startsWith('request:'))).toEqual([])
    })
  }

  it('lets a read through untouched', async () => {
    const {wrapWithLocalEcho} = await loadEcho({SPIKE_LOCAL_ECHO: '1'})
    const {client, realCalls} = makeFakeClient()
    const wrapped = wrapWithLocalEcho(client as never) as unknown as Rec

    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/data/query/parity'})

    expect(realCalls).toContain('request:/data/query/parity')
  })
})
