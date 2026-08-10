/**
 * `sanity-overlay-studio` — the client facade (PRD §21.4, §21.5 Strategy A,
 * §11.3 "Never let unsupported client calls silently reach the staging write API").
 *
 * TWO HAZARDS, BOTH WITH TEETH
 *
 * 1. IDENTITY STABILITY. sanity 6.8.0 reads client properties inside React
 *    effect dependency arrays on every render —
 *      `useEffect(() => { client.live.events(…).subscribe(…) }, [client.live])`
 *      (`lib/LiveQueries-rJao7vYj.js:36-45`)
 *    A wrapper that mints a fresh function per property access therefore tears
 *    the effect down and re-subscribes every render: unbounded, main thread
 *    saturated, black screen. The bound below is *one* subscribe over 20 000
 *    renders, and `naivelyWrap` is the negative control that reproduces the
 *    historical ~40 000-call storm at a specific number. If the oracle ever
 *    stops being able to see the storm, the control goes red first.
 *
 * 2. AUTH OBSERVATION. A 401 anywhere in the session's own plumbing means the
 *    write provably cannot land. Answering it with a synthetic success makes the
 *    editor lie to the user about content that exists nowhere. An earlier agent
 *    broke exactly this while wiring reads, so it is pinned from the *facade*
 *    side (what a Studio-shaped caller receives), not only from the protocol's.
 *
 * No browser. `@sanity/client`'s observable API is lazy, so building a request
 * observable and dropping it makes no network call.
 */
import {types} from 'node:util'
import {describe, expect, it, vi} from 'vitest'
import {
  createClient,
  type ClientConfig,
  type SanityClient,
} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {createOverlayEcho, type OverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const isProxy = types.isProxy

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

/**
 * The rxjs `Observable` `@sanity/client` actually answers with, read off a real
 * client rather than declared.
 *
 * EVERY observable double below is built with it. A `{subscribe}` literal is
 * exactly what let `client.observable.request(...).pipe is not a function` reach
 * a browser and kill Studio at boot: the double and the facade agreed with each
 * other and both disagreed with the library. Building the doubles from the real
 * class means these tests exercise the same path production does. The contract
 * itself is pinned in `studio-observable-contract.test.ts`.
 *
 * Cold: building a request observable and dropping it makes no network call.
 */
type ColdSubscriber = {
  next: (value: unknown) => void
  error: (error: unknown) => void
  complete: () => void
}
const RealObservable = Object.getPrototypeOf(
  createClient(CONFIG).observable.fetch('*[_id == "__facade_double_probe__"][0]'),
).constructor as new (
  subscribe: (subscriber: ColdSubscriber) => (() => void) | void,
) => {subscribe: (observer: unknown) => {unsubscribe: () => void}}

/** A real Observable that never emits — the shape a live listener has at rest. */
function silentObservable(): unknown {
  return new RealObservable(() => undefined)
}

/* ─────────────────────────────────────────────────────── test doubles */

interface RecordingTransport extends OverlayTransport {
  commits: {kind: string; idempotencyKey: string; payload: unknown}[]
}

function recordingTransport(
  answer: Partial<OverlayTransportResult> = {},
): RecordingTransport {
  const commits: RecordingTransport['commits'] = []
  return {
    apiUrl: 'http://localhost:3998',
    commits,
    commit: async (commit, context) => {
      commits.push({
        kind: commit.kind,
        idempotencyKey: context.idempotencyKey,
        payload: commit.payload,
      })
      return {outcome: 'ok', ...answer}
    },
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  }
}

/** A client-shaped object whose every network method records and never runs. */
function fakeClient(): Rec & {escaped: string[]} {
  const escaped: string[] = []
  const escape =
    (name: string) =>
    (...args: unknown[]): unknown => {
      escaped.push(name)
      return Promise.resolve({escaped: name, args})
    }
  const self: Rec & {escaped: string[]} = {
    escaped,
    fetch: escape('fetch'),
    getDocument: escape('getDocument'),
    getDocuments: escape('getDocuments'),
    create: escape('create'),
    createOrReplace: escape('createOrReplace'),
    createIfNotExists: escape('createIfNotExists'),
    delete: escape('delete'),
    mutate: escape('mutate'),
    action: escape('action'),
    dataRequest: escape('dataRequest'),
    request: escape('request'),
    listen: () => silentObservable(),
    config: () => ({...CONFIG}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
    assets: {upload: escape('assets.upload')},
    datasets: {create: escape('datasets.create'), list: escape('datasets.list')},
    releases: {publish: escape('releases.publish'), get: escape('releases.get')},
    agent: {action: {generate: escape('agent.action.generate')}},
    projects: {list: escape('projects.list')},
    users: {getById: escape('users.getById')},
    live: {events: escape('live.events')},
    mediaLibrary: {video: {getPlaybackInfo: escape('mediaLibrary.video.getPlaybackInfo')}},
  }
  self.observable = {
    fetch: escape('observable.fetch'),
    getDocuments: escape('observable.getDocuments'),
    action: escape('observable.action'),
    mutate: escape('observable.mutate'),
    listen: () => silentObservable(),
  }
  return self
}

interface Harness {
  client: Rec & {escaped: string[]}
  wrapped: Rec
  echo: OverlayEcho
  transport: RecordingTransport
  errors: string[]
}

function harness(overrides: {transport?: RecordingTransport} = {}): Harness {
  const errors: string[] = []
  const echo = createOverlayEcho({onError: (message) => errors.push(message)})
  const transport = overrides.transport ?? recordingTransport()
  const client = fakeClient()
  const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
    echo,
    transport,
    onError: (message) => errors.push(message),
  }) as unknown as Rec
  return {client, wrapped, echo, transport, errors}
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A cold, real `@sanity/client` observable: nothing runs until subscribe. */
function observableOf(value: unknown): unknown {
  return new RealObservable((subscriber) => {
    subscriber.next(value)
    subscriber.complete()
  })
}

/** Subscribe to an observable read and resolve with its first value. */
function drain(result: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const source = result as {
      subscribe: (o: {
        next: (v: unknown) => void
        error: (e: unknown) => void
        complete: () => void
      }) => unknown
    }
    let last: unknown
    source.subscribe({
      next: (value) => {
        last = value
      },
      error: reject,
      complete: () => resolve(last),
    })
  })
}

/* ══════════════════════════════════════ no write reaches the real client */

describe('every write plane is intercepted (PRD §11.3)', () => {
  it.each([
    ['create', (c: Rec) => (c.create as CallableFunction)({_id: 'a', _type: 'article'})],
    [
      'createOrReplace',
      (c: Rec) => (c.createOrReplace as CallableFunction)({_id: 'a', _type: 'article'}),
    ],
    [
      'createIfNotExists',
      (c: Rec) => (c.createIfNotExists as CallableFunction)({_id: 'a', _type: 'article'}),
    ],
    ['delete', (c: Rec) => (c.delete as CallableFunction)('a')],
    ['mutate', (c: Rec) => (c.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}])],
    [
      'action',
      (c: Rec) =>
        (c.action as CallableFunction)({
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.a',
          publishedId: 'a',
        }),
    ],
    [
      'dataRequest(mutate)',
      (c: Rec) => (c.dataRequest as CallableFunction)('mutate', {mutations: []}),
    ],
    [
      'dataRequest(actions)',
      (c: Rec) => (c.dataRequest as CallableFunction)('actions', {actions: []}),
    ],
    [
      'request(/data/mutate)',
      (c: Rec) =>
        (c.request as CallableFunction)({uri: '/data/mutate/parity', method: 'POST', body: {}}),
    ],
    [
      'request(data/mutate, no leading slash)',
      (c: Rec) =>
        (c.request as CallableFunction)({url: 'data/mutate/parity', method: 'POST', body: {}}),
    ],
    [
      'request(resource-scoped actions)',
      (c: Rec) =>
        (c.request as CallableFunction)({
          uri: '/projects/p/datasets/parity/actions',
          method: 'POST',
          body: {},
        }),
    ],
  ])('%s never reaches the real client', async (_label, invoke) => {
    const {client, wrapped} = harness()
    await Promise.resolve(invoke(wrapped)).catch(() => undefined)
    await settle()
    expect(client.escaped).toEqual([])
  })

  it.each([
    ['assets.upload', (c: Rec) => ((c.assets as Rec).upload as CallableFunction)('image', 'x')],
    [
      'agent.action.generate',
      (c: Rec) =>
        (((c.agent as Rec).action as Rec).generate as CallableFunction)({schemaId: 's'}),
    ],
    ['datasets.create', (c: Rec) => ((c.datasets as Rec).create as CallableFunction)('x')],
    ['releases.publish', (c: Rec) => ((c.releases as Rec).publish as CallableFunction)('r')],
  ])('refuses %s, which has no overlay spelling', async (_label, invoke) => {
    const {client, wrapped} = harness()
    await expect(Promise.resolve(invoke(wrapped))).rejects.toThrow()
    expect(client.escaped).toEqual([])
  })

  it('blocks a fluent patch builder’s commit', async () => {
    const {client, wrapped} = harness()
    const patch = (wrapped.patch as CallableFunction | undefined) ?? null
    expect(patch).toBeNull()
    /* The fake client has no `patch`; the real-client case is covered below. */
    expect(client.escaped).toEqual([])
  })

  it('routes a publish action to the overlay as a documentActions commit', async () => {
    const {wrapped, transport} = harness()
    await (wrapped.action as CallableFunction)({
      actionType: 'sanity.action.document.publish',
      draftId: 'drafts.a',
      publishedId: 'a',
    })
    await settle()
    expect(transport.commits.map((commit) => commit.kind)).toEqual(['documentActions'])
  })

  it('answers a blocked write with a synthetic transaction id, so the pane can settle', async () => {
    const {wrapped} = harness()
    const result = (await (wrapped.mutate as CallableFunction)([
      {patch: {id: 'a', set: {x: 1}}},
    ])) as Rec
    expect(typeof result.transactionId).toBe('string')
  })

  it('uses Studio’s own transaction id when it supplies one', async () => {
    const {wrapped, transport} = harness()
    await (wrapped.action as CallableFunction)(
      {actionType: 'sanity.action.document.publish', draftId: 'drafts.a', publishedId: 'a'},
      {transactionId: 'studio-tx-9'},
    )
    await settle()
    /*
     * DERIVED FROM IT, NOT EQUAL TO IT — changed 2026-08-10.
     *
     * The subject of this test is that the facade adopts Studio's transaction id
     * rather than minting one of its own, and it still does. What changed is
     * that one Studio call can plan MORE THAN ONE commit, so the ledger key is
     * now per BATCH — see the test below and `facade.ts` `persistAndEcho`.
     */
    expect(transport.commits[0]?.idempotencyKey).toBe('studio-tx-9#0')
  })

  /**
   * ONE KEY PER BATCH — the §34.6 property, asserted where it is decided.
   *
   * One `client.action([...])` can plan two commits, and they used to be posted
   * under one idempotency key: one key, two different writes. That survives
   * today only because the two overlay endpoints file the key into disjoint
   * spaces (`commitMutations` verbatim, `commitDocumentActions` as `${key}#0`),
   * which is a coincidence of routing in another package rather than a
   * guarantee. This is the test that goes red if the keys are collapsed again.
   */
  it('gives every batch of one Studio call its own idempotency key', async () => {
    const {wrapped, transport} = harness()
    /* sanity 6.8.0's "save this edit, then publish it". */
    await (wrapped.action as CallableFunction)(
      [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.a',
          publishedId: 'a',
          patch: {set: {title: 'edited'}},
        },
        {actionType: 'sanity.action.document.publish', draftId: 'drafts.a', publishedId: 'a'},
      ],
      {transactionId: 'studio-tx-10'},
    )
    await settle()

    expect(transport.commits.map((commit) => commit.kind)).toEqual([
      'actions',
      'documentActions',
    ])
    const keys = transport.commits.map((commit) => commit.idempotencyKey)
    expect(new Set(keys).size, `both batches posted ${keys[0]}`).toBe(2)
  })
})

describe('reads are delegated, not blocked', () => {
  it.each([
    ['fetch', (c: Rec) => (c.fetch as CallableFunction)('*[_type=="article"]')],
    ['datasets.list', (c: Rec) => ((c.datasets as Rec).list as CallableFunction)()],
    ['projects.list', (c: Rec) => ((c.projects as Rec).list as CallableFunction)()],
    ['releases.get', (c: Rec) => ((c.releases as Rec).get as CallableFunction)('r')],
    [
      'mediaLibrary.video.getPlaybackInfo',
      (c: Rec) =>
        (((c.mediaLibrary as Rec).video as Rec).getPlaybackInfo as CallableFunction)('v'),
    ],
  ])('%s reaches the real client', async (label, invoke) => {
    const {client, wrapped} = harness()
    await Promise.resolve(invoke(wrapped)).catch(() => undefined)
    expect(client.escaped).toContain(label)
  })

  it('live.events is the one read that is NOT delegated', async () => {
    /* It was in the table above until 2026-08-06, and that was the defect.
     * Sanity Live streams a result the Content Lake evaluated itself, so an
     * event arrives after the overlay-resolved render and replaces the branch
     * with staging content (PRD §23.3, §37 Phase 5). The refusal arrives on the
     * error channel of an Observable because that is what `events()` returns
     * and what sanity 6.8.0 subscribes to. Class-level coverage — the
     * observable client, the cached namespace reference, and the
     * `client.listen()` boundary that must NOT be swept up with it — is in
     * `studio-live-bypass.test.ts`. */
    const {client, wrapped} = harness()
    const result = ((wrapped.live as Rec).events as CallableFunction)()

    expect(typeof (result as Rec).subscribe).toBe('function')
    await expect(drain(result)).rejects.toThrow(/blocked live\.events/)
    expect(client.escaped).not.toContain('live.events')
  })

  it('passes a read `request` straight through', async () => {
    const {client, wrapped} = harness()
    await (wrapped.request as CallableFunction)({uri: '/projects/p/grants'})
    expect(client.escaped).toContain('request')
  })

  it('passes a GET to a write URL through — the method decides, not only the path', async () => {
    const {client, wrapped} = harness()
    await (wrapped.request as CallableFunction)({uri: '/data/actions/parity', method: 'GET'})
    expect(client.escaped).toContain('request')
  })
})

/* ══════════════════════════════════════════════════════ auth observation */

describe('auth observation — a 401 stops writes being acknowledged', () => {
  it.each([401, 403])('ends the session when a read answers %s', async (status) => {
    const {wrapped, echo, client} = harness()
    client.fetch = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('nope'), {statusCode: status}))

    await (wrapped.fetch as CallableFunction)('*').catch(() => undefined)
    expect(echo.sessionState()).toBe('unauthenticated')

    await expect(
      (wrapped.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}]),
    ).rejects.toThrow(/not authenticated/i)
  })

  it('does not end the session for a 500', async () => {
    const {wrapped, echo, client} = harness()
    client.fetch = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('boom'), {statusCode: 500}))
    await (wrapped.fetch as CallableFunction)('*').catch(() => undefined)
    expect(echo.sessionState()).toBe('active')
  })

  it('ends the session when the overlay API itself answers 401 on a commit', async () => {
    const transport = recordingTransport()
    const failing: RecordingTransport = {
      ...transport,
      commit: async () => ({outcome: 'fatal', status: 401, message: 'nope'}),
    }
    const {wrapped, echo} = harness({transport: failing})
    await (wrapped.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}]).catch(
      () => undefined,
    )
    await settle()
    expect(echo.sessionState()).toBe('unauthenticated')
  })

  it('brings the session back when an identity probe proves a live credential', async () => {
    const {wrapped, echo, client} = harness()
    echo.noteAuthFailure({status: 401, source: 'read'})
    client.request = (): Promise<unknown> => Promise.resolve({id: 'user-1', name: 'V'})
    await (wrapped.request as CallableFunction)({uri: '/users/me'})
    expect(echo.sessionState()).toBe('active')
  })

  it('does NOT bring the session back on a 200 with a null identity', async () => {
    const {wrapped, echo, client} = harness()
    echo.noteAuthFailure({status: 401, source: 'read'})
    client.request = (): Promise<unknown> => Promise.resolve(null)
    await (wrapped.request as CallableFunction)({uri: '/users/me'})
    expect(echo.sessionState()).toBe('unauthenticated')
  })

  it('treats users.getById("me") as the same credential proof as /users/me', async () => {
    const {wrapped, echo, client} = harness()
    echo.noteAuthFailure({status: 401, source: 'read'})
    ;(client.users as Rec).getById = (): Promise<unknown> => Promise.resolve({id: 'user-1'})
    await ((wrapped.users as Rec).getById as CallableFunction)('me')
    expect(echo.sessionState()).toBe('active')
  })

  it('ends the session at logout, and forwards the logout so no live token is left behind', async () => {
    const {wrapped, echo, client} = harness()
    await (wrapped.request as CallableFunction)({uri: '/auth/logout', method: 'POST'})
    expect(echo.sessionState()).toBe('logged-out')
    expect(client.escaped).toContain('request')
  })

  it('refuses every write after logout', async () => {
    const {wrapped, client} = harness()
    await (wrapped.request as CallableFunction)({uri: '/auth/logout', method: 'POST'})
    await expect(
      (wrapped.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}]),
    ).rejects.toThrow(/logged out/i)
    expect(client.escaped).toEqual(['request'])
  })
})

/* ══════════════════════════════════════════════ identity stability */

/** The pre-fix wrapper: a fresh function per property access. */
function naivelyWrap<T extends object>(target: T, meter: {calls: number}): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop)
      if (prop === 'observable' && typeof value === 'object' && value !== null) {
        return naivelyWrap(value as object, meter)
      }
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        meter.calls += 1
        return (value as (...a: unknown[]) => unknown).apply(t, args)
      }
    },
  }) as T
}

const RENDERS = 20_000

interface StormResult {
  resubscribes: number
  clientCalls: number
}

/** React effect semantics, modelled literally. */
function simulateStudio(
  readDeps: () => readonly unknown[],
  subscribe: () => void,
  renders = RENDERS,
): StormResult {
  let previous: readonly unknown[] | null = null
  let resubscribes = 0
  let calls = 0
  for (let i = 0; i < renders; i++) {
    const deps = readDeps()
    const changed =
      previous === null ||
      deps.length !== previous.length ||
      deps.some((dep, index) => !Object.is(dep, (previous as readonly unknown[])[index]))
    if (changed) {
      resubscribes += 1
      const before = calls
      subscribe()
      calls = before + 2
    }
    previous = deps
  }
  return {resubscribes, clientCalls: calls}
}

function pairListenerSubscribe(client: SanityClient): void {
  client.observable.getDocuments(['article-11', 'drafts.article-11'])
  client.observable.listen('*[_id in $ids]', {ids: ['article-11']})
}

function studioDeps(client: SanityClient): readonly unknown[] {
  return [
    client,
    (client as unknown as Rec).live,
    client.observable,
    client.observable.listen,
    client.observable.getDocuments,
    client.fetch,
  ]
}

function distinct<T>(read: () => T, times: number): Set<T> {
  const seen = new Set<T>()
  for (let i = 0; i < times; i++) seen.add(read())
  return seen
}

function overlayClient(): SanityClient {
  const echo = createOverlayEcho()
  return wrapWithOverlay(createClient(CONFIG), {echo, transport: recordingTransport()})
}

describe('the oracle can see the storm (negative control)', () => {
  it('reports one subscribe for a dependency tuple that never changes', () => {
    const frozen = [Symbol('client'), Symbol('live')]
    const result = simulateStudio(
      () => frozen,
      () => {},
    )
    expect(result.resubscribes).toBe(1)
  })

  it(
    'reproduces the ~40k-call storm against an identity-unstable wrapper',
    {timeout: 120_000},
    () => {
      const meter = {calls: 0}
      const unstable = naivelyWrap(createClient(CONFIG), meter)
      const result = simulateStudio(
        () => studioDeps(unstable),
        () => pairListenerSubscribe(unstable),
      )
      expect(result.resubscribes).toBe(RENDERS)
      expect(result.clientCalls).toBe(40_000)
      expect(meter.calls).toBeGreaterThanOrEqual(40_000)
    },
  )

  it('shows the instability is per-property-access, not per-client', () => {
    const meter = {calls: 0}
    const unstable = naivelyWrap(createClient(CONFIG), meter)
    expect(distinct(() => unstable.fetch, 500).size).toBe(500)
    expect(distinct(() => unstable.observable, 500).size).toBe(500)
  })
})

describe('the overlay facade is identity-stable', () => {
  it('survives 20 000 renders with exactly one subscribe and two client calls', () => {
    const client = overlayClient()
    const result = simulateStudio(
      () => studioDeps(client),
      () => pairListenerSubscribe(client),
    )
    expect(result.resubscribes).toBe(1)
    expect(result.clientCalls).toBe(2)
  })

  it('returns the same function object for every method, every access', () => {
    const client = overlayClient() as unknown as Rec
    for (const property of ['fetch', 'listen', 'mutate', 'action', 'create', 'getDocuments']) {
      expect(distinct(() => client[property], 500).size, property).toBe(1)
    }
  })

  it('returns the same proxy for every namespace, every access', () => {
    const client = overlayClient() as unknown as Rec
    for (const namespace of [
      'observable',
      'assets',
      'datasets',
      'projects',
      'users',
      'releases',
      'live',
      'agent',
      'mediaLibrary',
    ]) {
      expect(distinct(() => client[namespace], 500).size, namespace).toBe(1)
    }
  })

  it('descends the nested agent.action and mediaLibrary.video namespaces stably', () => {
    const client = overlayClient() as unknown as Rec
    expect(distinct(() => (client.agent as Rec).action, 200).size).toBe(1)
    expect(distinct(() => (client.mediaLibrary as Rec).video, 200).size).toBe(1)
    expect(isProxy((client.agent as Rec).action as object)).toBe(true)
  })

  it('is stable through the withConfig chain Studio uses for the Actions API', () => {
    const client = overlayClient()
    const configured = client.withConfig({apiVersion: '2025-02-19'})
    expect(isProxy(configured as unknown as object)).toBe(true)
    expect(distinct(() => configured.observable.action, 200).size).toBe(1)
  })

  it("is stable through Studio's memoised getClient (WorkspaceLoader:8306)", () => {
    const client = overlayClient()
    const clients: Record<string, SanityClient> = {}
    const getClient = (options: {apiVersion: string}): SanityClient =>
      (clients[options.apiVersion] ||= client.withConfig(options))
    const seen = new Set<SanityClient>()
    for (let i = 0; i < 500; i++) seen.add(getClient({apiVersion: '2025-02-19'}))
    expect(seen.size).toBe(1)
  })

  it('keeps clone() results wrapped and stable', () => {
    const client = overlayClient()
    const cloned = client.clone()
    expect(isProxy(cloned as unknown as object)).toBe(true)
    expect(distinct(() => cloned.fetch, 200).size).toBe(1)
  })

  it('wraps the same underlying client to the same proxy', () => {
    const real = createClient(CONFIG)
    const echo = createOverlayEcho()
    const transport = recordingTransport()
    expect(wrapWithOverlay(real, {echo, transport})).toBe(
      wrapWithOverlay(real, {echo, transport}),
    )
  })
})

describe('the real client, wrapped: writes still cannot escape', () => {
  it('blocks a fluent patch().commit()', async () => {
    const real = createClient(CONFIG)
    const transport = recordingTransport()
    const client = wrapWithOverlay(real, {echo: createOverlayEcho(), transport})
    const result = (await client
      .patch('article-1')
      .set({title: 'x'})
      .commit()) as unknown as Rec
    expect(typeof result.transactionId).toBe('string')
    await settle()
    expect(transport.commits.map((commit) => commit.kind)).toEqual(['mutations'])
  })

  it('blocks a fluent transaction().commit()', async () => {
    const real = createClient(CONFIG)
    const transport = recordingTransport()
    const client = wrapWithOverlay(real, {echo: createOverlayEcho(), transport})
    await client
      .transaction()
      .patch('article-1', (patch) => patch.set({title: 'x'}))
      .commit()
    await settle()
    expect(transport.commits.map((commit) => commit.kind)).toEqual(['mutations'])
  })

  it('keeps writes blocked on a withConfig-derived client', async () => {
    const real = createClient(CONFIG)
    const transport = recordingTransport()
    const client = wrapWithOverlay(real, {echo: createOverlayEcho(), transport})
    await client.withConfig({apiVersion: '2025-02-19'}).action({
      actionType: 'sanity.action.document.publish',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
    } as never)
    await settle()
    expect(transport.commits).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════ the local listener */

describe('the local update channel (§21.9)', () => {
  it('delivers the echo frame for a write to a listener on that document', async () => {
    const {wrapped, echo} = harness()
    echo.seedFromResult({_id: 'drafts.a', _type: 'article', _rev: 'r1'}, true)

    const seen: Rec[] = []
    const subscription = (
      (wrapped.listen as CallableFunction)('*[_id in $ids]', {
        ids: ['drafts.a'],
      }) as {subscribe: (observer: Rec) => Rec}
    ).subscribe({next: (event: Rec) => seen.push(event)})

    await (wrapped.mutate as CallableFunction)([{patch: {id: 'drafts.a', set: {title: 'x'}}}])
    await settle()

    expect(seen.map((event) => event.documentId)).toEqual(['drafts.a'])
    expect(seen[0]?.transition).toBe('update')
    expect((subscription as {unsubscribe?: () => void}).unsubscribe).toBeTypeOf('function')
  })

  it('releases the echo subscription on unsubscribe', async () => {
    const {wrapped, echo} = harness()
    const subscription = (
      (wrapped.listen as CallableFunction)('*[_id in $ids]', {ids: ['drafts.a']}) as {
        subscribe: (observer: Rec) => {unsubscribe: () => void}
      }
    ).subscribe({next: (): void => {}})
    expect(echo.subscriberCount()).toBe(1)
    subscription.unsubscribe()
    expect(echo.subscriberCount()).toBe(0)
  })

  it('does not attach a local channel to a listener that is not a document-pair listen', () => {
    const {wrapped, echo} = harness()
    ;(
      (wrapped.listen as CallableFunction)('*[_type == "article"]', {}) as {
        subscribe: (observer: Rec) => Rec
      }
    ).subscribe({next: (): void => {}})
    expect(echo.subscriberCount()).toBe(0)
  })
})

describe('the write ledger the banner reads', () => {
  it('records every intercepted write with its outcome', async () => {
    const seen: Rec[] = []
    const echo = createOverlayEcho()
    /*
     * The document has to be one the echo has a REVISION for, and that is not
     * scaffolding — it is the precondition for a patch frame existing at all.
     * `@sanity/mutator`'s `Document.considerIncoming` only consults
     * `appliesToMissingDocument()` when HEAD is null, and a `[{patch: …}]` frame
     * fails it, so a patch echoed at an address the pane holds no revision for is
     * buffered for ever rather than applied. The echo now refuses to emit one —
     * see the test below, which pins the refusal.
     */
    echo.seedFromResult({_id: 'a', _type: 'article', _rev: 'lake-1'}, true)
    const client = fakeClient()
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
      onWrite: (entry) => seen.push(entry as unknown as Rec),
    }) as unknown as Rec

    await (wrapped.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}])
    await settle()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({method: 'mutate', echoed: true, committed: 'ok'})
  })

  it('records a write it could not echo as unechoed, loudly, rather than as clean', async () => {
    const seen: Rec[] = []
    const errors: string[] = []
    const echo = createOverlayEcho({onError: (message) => errors.push(message)})
    const client = fakeClient()
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
      onWrite: (entry) => seen.push(entry as unknown as Rec),
      onError: (message) => errors.push(message),
    }) as unknown as Rec

    /* Nothing is known about `ghost`: no revision, no body. */
    await (wrapped.mutate as CallableFunction)([{patch: {id: 'ghost', set: {x: 1}}}])
    await settle()

    expect(seen[0]).toMatchObject({method: 'mutate', echoed: false, committed: 'ok'})
    expect(errors.join(' ')).toMatch(/ghost/)
    expect(errors.join(' ')).toMatch(/re-read|cannot echo/i)
  })

  it('marks a degraded commit rather than reporting it as clean', async () => {
    const seen: Rec[] = []
    const transport = recordingTransport()
    const degraded: RecordingTransport = {
      ...transport,
      commit: async () => ({outcome: 'degraded', message: 'offline'}),
    }
    const wrapped = wrapWithOverlay(fakeClient() as unknown as SanityClient, {
      echo: createOverlayEcho(),
      transport: degraded,
      onWrite: (entry) => seen.push(entry as unknown as Rec),
    }) as unknown as Rec

    await (wrapped.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}])
    await settle()
    expect(seen[0]).toMatchObject({committed: 'degraded'})
  })
})

describe('overlay reads', () => {
  it('answers getDocument from the overlay materialization when it has one', async () => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    client.getDocument = (): Promise<unknown> =>
      Promise.resolve({_id: 'drafts.a', _type: 'article', title: 'stale base'})
    echo.setOverlayDocument('drafts.a', {_id: 'drafts.a', _type: 'article', title: 'overlay'})
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    const result = (await (wrapped.getDocument as CallableFunction)('drafts.a')) as Rec
    expect(result.title).toBe('overlay')
  })

  /**
   * WHICH READS MAY RESET THE REVISION CHAIN — and the bug class behind it.
   *
   * Once writes are intercepted, the Content Lake still answers every read with
   * the STALE server revision. If any read is allowed to overwrite an echo-owned
   * (synthetic) revision, the `previousRev -> resultRev` chain breaks, and
   * `sequentializeListenerEvents` only notices ~30 s later as a deadline — far
   * from the cause, and looking like a hang rather than a bug.
   *
   * Exactly one read is authoritative: `getDocuments`, which is the pair
   * listener's own snapshot fetch and the thing Studio itself resets its base
   * revision from. Every other read path — `getDocument`, `fetch`, and every
   * namespace read — must leave a synthetic revision alone. The whole family is
   * pinned, not just the instance that was found.
   */
  it.each([
    ['getDocument', (c: Rec) => (c.getDocument as CallableFunction)('drafts.a')],
    ['fetch', (c: Rec) => (c.fetch as CallableFunction)('*[_id == "drafts.a"]')],
    [
      'observable.getDocument',
      (c: Rec) => drain((((c.observable as Rec).getDocument) as CallableFunction)('drafts.a')),
    ],
    [
      'observable.fetch',
      (c: Rec) => drain((((c.observable as Rec).fetch) as CallableFunction)('*')),
    ],
  ])('a stale %s must not reset an echo-owned revision', async (_label, invoke) => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    const stale = {_id: 'drafts.a', _type: 'article', _rev: 'lake-1', _updatedAt: '2020-01-01T00:00:00.000Z'}
    client.getDocument = (): Promise<unknown> => Promise.resolve(stale)
    client.fetch = (): Promise<unknown> => Promise.resolve(stale)
    ;(client.observable as Rec).getDocument = (): unknown => observableOf(stale)
    ;(client.observable as Rec).fetch = (): unknown => observableOf(stale)
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    echo.seedFromResult(stale, true)
    echo.emit([{documentId: 'drafts.a', transition: 'update', patch: {set: {t: 1}}}], 'tx-1')
    expect(echo.revisionOf('drafts.a')).toBe('tx-1')

    await invoke(wrapped)
    expect(echo.revisionOf('drafts.a')).toBe('tx-1')
  })

  /**
   * The authoritative read reaches Studio through BOTH client shapes: the pair
   * listener uses `observable.getDocuments`, so pinning only the promise
   * spelling would leave the shape Studio actually calls unguarded.
   */
  it('lets the observable pair snapshot fetch reset the chain too', async () => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    ;(client.observable as Rec).getDocuments = (): unknown =>
      observableOf([{_id: 'drafts.a', _type: 'article', _rev: 'lake-2'}])
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    echo.seedFromResult({_id: 'drafts.a', _type: 'article', _rev: 'lake-1'}, true)
    echo.emit([{documentId: 'drafts.a', transition: 'update', patch: {set: {t: 1}}}], 'tx-1')

    await drain((((wrapped.observable as Rec).getDocuments) as CallableFunction)(['drafts.a']))
    expect(echo.revisionOf('drafts.a')).toBe('lake-2')
  })

  it('lets the pair snapshot fetch reset the chain, because Studio resets from it too', async () => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    client.getDocuments = (): Promise<unknown> =>
      Promise.resolve([{_id: 'drafts.a', _type: 'article', _rev: 'lake-2'}])
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    echo.seedFromResult({_id: 'drafts.a', _type: 'article', _rev: 'lake-1'}, true)
    echo.emit([{documentId: 'drafts.a', transition: 'update', patch: {set: {t: 1}}}], 'tx-1')

    await (wrapped.getDocuments as CallableFunction)(['drafts.a'])
    expect(echo.revisionOf('drafts.a')).toBe('lake-2')
  })

  it('still substitutes the overlay body on a non-authoritative getDocument', async () => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    client.getDocument = (): Promise<unknown> =>
      Promise.resolve({_id: 'drafts.a', _type: 'article', _rev: 'lake-1', title: 'stale'})
    echo.setOverlayDocument('drafts.a', {_id: 'drafts.a', _type: 'article', title: 'overlay'})
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    expect(((await (wrapped.getDocument as CallableFunction)('drafts.a')) as Rec).title).toBe(
      'overlay',
    )
  })

  it('seeds the revision store from the pair snapshot fetch', async () => {
    const echo = createOverlayEcho()
    const client = fakeClient()
    client.getDocuments = (): Promise<unknown> =>
      Promise.resolve([{_id: 'drafts.a', _type: 'article', _rev: 'lake-1'}])
    const wrapped = wrapWithOverlay(client as unknown as SanityClient, {
      echo,
      transport: recordingTransport(),
    }) as unknown as Rec

    await (wrapped.getDocuments as CallableFunction)(['drafts.a'])
    expect(echo.revisionOf('drafts.a')).toBe('lake-1')
  })
})

describe('unsupported writes are reported, never silently dropped', () => {
  it('shouts when an action has no overlay spelling', async () => {
    const {wrapped, errors} = harness()
    await (wrapped.action as CallableFunction)({
      actionType: 'sanity.action.document.version.create',
      versionId: 'versions.r.a',
    })
    await settle()
    expect(errors.join(' ')).toMatch(/version\.create/)
  })

  it('never delegates the unsupported action to the real client anyway', async () => {
    const {wrapped, client} = harness()
    await (wrapped.action as CallableFunction)({actionType: 'sanity.action.document.schedule'})
    await settle()
    expect(client.escaped).toEqual([])
  })
})

describe('facade wiring is inert when there is nothing to intercept', () => {
  it('leaves an unknown method untouched', async () => {
    const {wrapped, client} = harness()
    client.somethingNew = (): string => 'ok'
    expect(((wrapped.somethingNew as CallableFunction)() as string)).toBe('ok')
  })

  it('forwards non-function properties unchanged', () => {
    const {wrapped, client} = harness()
    client.someValue = 42
    expect(wrapped.someValue).toBe(42)
  })
})

describe('vi sanity', () => {
  it('has spies available (guards against a silently broken harness)', () => {
    const spy = vi.fn()
    spy()
    expect(spy).toHaveBeenCalled()
  })
})
