/**
 * SPIKE A — the READ half of the Studio facade.
 *
 * THE GAP THIS CLOSES
 * ───────────────────
 * Writes were already intercepted, echoed, and persisted to `.sanity-overlay/`.
 * Reads were not: `fetch`, `getDocument` and `getDocuments` were *tapped* —
 * observed for their `_rev`, never resolved against the overlay. The open
 * document pane looked right only because the listener echo replayed mutations
 * into it. Everything else in Studio was still reading staging:
 *
 *   - rename a document, and every list still showed the old title;
 *   - a branch-created document was returned by nothing;
 *   - a locally deleted document kept answering with its base content;
 *   - reference pickers and previews resolved to staging values.
 *
 * WHAT IS UNDER TEST
 * A real overlay server on a real port, holding a real `.sanity-overlay/` on
 * disk, plus `wrapWithLocalEcho` over a stub client whose upstream answers are
 * declared in each test. So "the overlay answered" is provable: the stub's own
 * value is a *different string*, and every assertion names which one it expects.
 *
 * WHAT IS DELIBERATELY NOT SUBSTITUTED
 * A slot the upstream answered `null` is left `null` by `getDocument(s)`. That is
 * not an oversight — see the `_rev` chain notes below and in `localEcho.ts`.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {startOverlayServer} from '../../../examples/kitchen-sink/spikeA/overlayServer.mjs'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

type Rec = Record<string, unknown>

/* ───────────────────────────────────────────────────── browser-global stubs */

class StubStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new StubStorage()
const win: Record<string, unknown> = {localStorage: storage}
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).localStorage = storage

interface EchoWindow {
  __SPIKE_ECHO__?: {
    errors: string[]
    session: {state: string; restored: number}
    persist: {failed: number; hydrated: boolean | null}
    reads: {
      resolved: number
      substituted: number
      exact: number
      approximated: number
      strict: boolean
      failed: number
      unsupported: Array<{query: string; reason: string; count: number}>
    }
  }
}

type EchoModule = typeof import('../../../examples/kitchen-sink/spikeA/localEcho')

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function loadEcho(flags: Record<string, string>): Promise<EchoModule> {
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

/* ────────────────────────────────────────────────────── the overlay server */

const roots: string[] = []
const running: Array<{close: () => Promise<void>}> = []

interface Booted {
  url: string
  close(): Promise<void>
}

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

async function bootServer(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'spike-a-read-'))
  roots.push(root)
  const server = (await startOverlayServer({
    root,
    port: 0,
    overlayId: 'spike-a-read-000000000000000',
    now: makeClock(),
  })) as Booted
  running.push(server)
  return server
}

/** The published document staging holds, unchanged by anything the branch does. */
const BASE_ARTICLE: Rec = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'STAGING TITLE',
  slug: {_type: 'slug', current: 'staging-slug'},
}

const BASE_DRAFT: Rec = {...BASE_ARTICLE, _id: 'drafts.article-1', _rev: 'lake-rev-1d'}

async function commit(server: Booted, body: Rec): Promise<Rec> {
  const response = await fetch(`${server.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as Rec
  expect(json.ok).toBe(true)
  return json
}

/** Rename `article-1`'s draft in the branch, exactly as a Studio edit would. */
async function renameDraft(server: Booted, title: string): Promise<void> {
  await commit(server, {
    idempotencyKey: `rename:${title}`,
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {set: {title}},
      },
    ],
    baseDocuments: [BASE_ARTICLE],
  })
}

/* ─────────────────────────────────────────────────────────── stub client */

/**
 * A minimal rxjs-shaped observable.
 *
 * `subscribe` *and* `pipe` are both present so `localEcho`'s
 * `captureObservableCtor` adopts this constructor — the same path it takes with
 * the real `@sanity/client`. Without `pipe` it would silently fall back to its
 * internal shim, and the observable tests would be exercising the wrong code.
 */
class TestObservable<T> {
  readonly #onSubscribe: (subscriber: {
    next: (value: T) => void
    error: (error: unknown) => void
    complete: () => void
  }) => (() => void) | void

  constructor(onSubscribe: TestObservable<T>['onSubscribeType']) {
    this.#onSubscribe = onSubscribe as never
  }

  declare onSubscribeType: (subscriber: {
    next: (value: T) => void
    error: (error: unknown) => void
    complete: () => void
  }) => (() => void) | void

  subscribe(observer: Partial<{next: (v: T) => void; error: (e: unknown) => void; complete: () => void}>) {
    let closed = false
    const teardown = this.#onSubscribe({
      next: (value) => {
        if (!closed) observer.next?.(value)
      },
      error: (error) => {
        if (!closed) {
          closed = true
          observer.error?.(error)
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
      },
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipe(...operators: Array<(source: any) => any>): unknown {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return operators.reduce<any>((source, operator) => operator(source), this)
  }
}

function observableOf<T>(value: T): TestObservable<T> {
  return new TestObservable<T>((subscriber) => {
    setTimeout(() => {
      subscriber.next(value)
      subscriber.complete()
    }, 0)
  })
}

interface StubUpstream {
  documents?: Record<string, Rec | null>
  fetch?: (query: string, params?: unknown) => unknown
  /** When set, every read fails with this error instead of answering. */
  readError?: unknown
}

interface StubClient extends Rec {
  fetchCalls: Array<{query: string; params?: unknown}>
}

/**
 * A client whose upstream answers are declared per test.
 *
 * Nothing here talks to Sanity. `documents` is what staging would return, keyed
 * exactly as Studio addresses it; anything not listed answers `null`, which is
 * what the Content Lake does for a draft that has never existed.
 */
function stubClient(upstream: StubUpstream = {}): StubClient {
  const documents = upstream.documents ?? {}
  const fetchCalls: StubClient['fetchCalls'] = []

  const failing = upstream.readError !== undefined

  const getDocument = (id: string): Promise<Rec | null> =>
    failing ? Promise.reject(upstream.readError) : Promise.resolve(documents[id] ?? null)
  const getDocuments = (ids: string[]): Promise<Array<Rec | null>> =>
    failing
      ? Promise.reject(upstream.readError)
      : Promise.resolve(ids.map((id) => documents[id] ?? null))
  const doFetch = (query: string, params?: unknown): unknown => {
    fetchCalls.push({query, params})
    if (failing) return Promise.reject(upstream.readError)
    return Promise.resolve(upstream.fetch?.(query, params) ?? null)
  }

  const observableFailing = <T>(): TestObservable<T> =>
    new TestObservable<T>((subscriber) => {
      setTimeout(() => subscriber.error(upstream.readError), 0)
    })

  const client: StubClient = {
    fetchCalls,
    fetch: doFetch,
    getDocument,
    getDocuments,
    listen: () => observableOf({type: 'welcome'}),
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    observable: {
      fetch: (query: string, params?: unknown) => {
        fetchCalls.push({query, params})
        if (failing) return observableFailing()
        return observableOf(upstream.fetch?.(query, params) ?? null)
      },
      getDocument: (id: string) =>
        failing ? observableFailing() : observableOf(documents[id] ?? null),
      getDocuments: (ids: string[]) =>
        failing ? observableFailing() : observableOf(ids.map((id) => documents[id] ?? null)),
      listen: () => observableOf({type: 'welcome'}),
    },
  }
  return client
}

/** Subscribe to whatever the facade returned and resolve with its single value. */
function firstValue(result: unknown): Promise<unknown> {
  const candidate = result as {
    subscribe?: (observer: Rec) => unknown
    then?: (onValue: (value: unknown) => unknown) => unknown
  }
  if (typeof candidate?.then === 'function') return result as Promise<unknown>
  return new Promise((resolve, reject) => {
    let seen: unknown
    let got = false
    candidate.subscribe?.({
      next: (value: unknown) => {
        seen = value
        got = true
      },
      error: reject,
      complete: () => (got ? resolve(seen) : resolve(undefined)),
    })
  })
}

/* ──────────────────────────────────────────────────────────────── harness */

let warnings: string[] = []
let errors: string[] = []

beforeEach(() => {
  warnings = []
  errors = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => {
    warnings.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

const ECHO_ON = {SPIKE_LOCAL_ECHO: '1', SPIKE_OVERLAY_PERSIST: '1'}

async function wrap(
  server: Booted | null,
  upstream: StubUpstream,
  extraFlags: Record<string, string> = {},
): Promise<{client: Rec; stub: StubClient}> {
  const echo = await loadEcho({
    ...ECHO_ON,
    ...extraFlags,
    ...(server === null ? {SPIKE_OVERLAY_URL: 'http://127.0.0.1:1'} : {SPIKE_OVERLAY_URL: server.url}),
  })
  const stub = stubClient(upstream)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = echo.wrapWithLocalEcho(stub as any) as unknown as Rec
  await settle()
  return {client, stub}
}

/* ================================================================== *
 * 1. getDocument / getDocuments resolve against the overlay
 * ================================================================== */

describe('getDocument / getDocuments — the virtual document, not the base one', () => {
  it('returns the branch title for a document the branch renamed', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {documents: {'drafts.article-1': BASE_DRAFT}})

    const document = (await (client.getDocument as (id: string) => Promise<Rec>)(
      'drafts.article-1',
    )) as Rec

    expect(document.title).toBe('BRANCH TITLE')
    expect(echoLog().reads.substituted).toBeGreaterThan(0)
  })

  it('keeps the upstream revision on the substituted document', async () => {
    /* Non-negotiable: `sequentializeListenerEvents` seeds its base revision from
     * this very snapshot and then requires an unbroken previousRev→resultRev
     * chain. Handing back the overlay's synthetic `_rev` would break the chain
     * and park every later frame until the 30 s deadline fires. */
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {documents: {'drafts.article-1': BASE_DRAFT}})

    const document = (await (client.getDocument as (id: string) => Promise<Rec>)(
      'drafts.article-1',
    )) as Rec

    expect(document._rev).toBe('lake-rev-1d')
    expect(document._id).toBe('drafts.article-1')
    expect(document._createdAt).toBe(BASE_ARTICLE._createdAt)
  })

  it('leaves a document the branch never touched exactly as staging returned it', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const untouched = {...BASE_ARTICLE, _id: 'article-9', _rev: 'lake-rev-9', title: 'UNTOUCHED'}
    const {client} = await wrap(server, {documents: {'article-9': untouched}})

    const document = (await (client.getDocument as (id: string) => Promise<Rec>)(
      'article-9',
    )) as Rec
    expect(document).toEqual(untouched)
  })

  it('answers null for a document the branch deleted, never its stale base body', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'delete-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    const {client} = await wrap(server, {
      documents: {'article-1': BASE_ARTICLE, 'drafts.article-1': BASE_DRAFT},
    })

    const documents = (await (client.getDocuments as (ids: string[]) => Promise<unknown[]>)([
      'article-1',
      'drafts.article-1',
    ])) as unknown[]

    expect(documents).toEqual([null, null])
  })

  it('keeps one slot per requested ID, in request order', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {
      documents: {'article-1': BASE_ARTICLE, 'drafts.article-1': BASE_DRAFT},
    })

    const documents = (await (client.getDocuments as (ids: string[]) => Promise<unknown[]>)([
      'article-1',
      'drafts.article-1',
      'article-404',
    ])) as Array<Rec | null>

    expect(documents).toHaveLength(3)
    /* The published version was not edited, so it still reads as staging. */
    expect(documents[0]?.title).toBe('STAGING TITLE')
    expect(documents[1]?.title).toBe('BRANCH TITLE')
    expect(documents[2]).toBeNull()
  })

  it('does not invent a document in a slot staging answered null for', async () => {
    /* A branch-created draft has no upstream `_rev` to chain from, and the
     * hydration replay already owns that case. Synthesising one here is exactly
     * the failure `localEcho`'s header note 2 documents. */
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'create-1',
      kind: 'mutations',
      payload: [{create: {_id: 'drafts.article-new', _type: 'article', title: 'BRANCH CREATED'}}],
      baseDocuments: [],
    })
    const {client} = await wrap(server, {documents: {}})

    const document = await (client.getDocument as (id: string) => Promise<unknown>)(
      'drafts.article-new',
    )
    expect(document).toBeNull()
  })

  it('resolves through the observable surface too', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {documents: {'drafts.article-1': BASE_DRAFT}})

    const observable = (client.observable as Rec).getDocument as (id: string) => unknown
    const document = (await firstValue(observable('drafts.article-1'))) as Rec
    expect(document.title).toBe('BRANCH TITLE')
  })

  it('keeps the read methods identity-stable', async () => {
    /* The ~40 000-call resubscribe storm: a fresh function per property access
     * puts Studio into an infinite re-subscribe. Every new wrapper must be
     * memoised per target+property, and reads are no exception. */
    const server = await bootServer()
    const {client} = await wrap(server, {documents: {}})
    expect(client.getDocument).toBe(client.getDocument)
    expect(client.getDocuments).toBe(client.getDocuments)
    expect(client.fetch).toBe(client.fetch)
    expect((client.observable as Rec).getDocument).toBe((client.observable as Rec).getDocument)
  })
})

/* ================================================================== *
 * 2. Degradation — loud, and still usable
 * ================================================================== */

describe('read resolution degrades loudly when the overlay is unreachable', () => {
  it('returns the staging document and reports the failure', async () => {
    const {client} = await wrap(null, {documents: {'drafts.article-1': BASE_DRAFT}})

    const document = (await (client.getDocument as (id: string) => Promise<Rec>)(
      'drafts.article-1',
    )) as Rec

    expect(document.title).toBe('STAGING TITLE')
    expect(echoLog().reads.failed).toBeGreaterThan(0)
    expect(errors.join('\n')).toMatch(/overlay/i)
  })

  it('changes nothing at all when persistence is off', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')

    const echo = await loadEcho({SPIKE_LOCAL_ECHO: '1', SPIKE_OVERLAY_URL: server.url})
    const stub = stubClient({documents: {'drafts.article-1': BASE_DRAFT}})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = echo.wrapWithLocalEcho(stub as any) as unknown as Rec

    const document = (await (client.getDocument as (id: string) => Promise<Rec>)(
      'drafts.article-1',
    )) as Rec

    /* Persistence off means the overlay is not consulted at all — the flag has
     * to mean *nothing changed*, reads included. */
    expect(document).toEqual(BASE_DRAFT)
    expect(echoLog().reads.resolved).toBe(0)
  })
})

/* ================================================================== *
 * 2b. The upstream error path the new wrapper must not swallow
 * ================================================================== *
 *
 * REGRESSION CLASS, found while reviewing the read wrapper: `getDocument(s)`
 * used to run through `tapRead(..., keepDocuments = true)`, whose error handler
 * called `noteAuthFailureFrom(err, 'read')`. That is the signal that ends the
 * session, and it is what stops the write path acknowledging edits that can
 * provably never land. A new wrapper that forwards the error but drops the
 * *observation* is silently worse than the old one: the pane keeps saying
 * "saved" while every write 401s.
 *
 * The class is "an error path the new wrapper reroutes", so all four members are
 * pinned: promise and observable, and both directions of the deliberate
 * asymmetry — a 401 on the session's own read plumbing counts, a 403 on an
 * arbitrary `fetch` does not (it may be a dataset ACL, and over-reporting stops
 * every later write).
 */

describe('a failed read still reports what it used to report', () => {
  function authError(status: number): Error {
    const error = new Error(`Unauthorized (${status})`)
    ;(error as unknown as Rec).statusCode = status
    return error
  }

  it('notes a 401 from getDocument and ends the session', async () => {
    const server = await bootServer()
    const {client} = await wrap(server, {readError: authError(401)})

    await expect(
      (client.getDocument as (id: string) => Promise<unknown>)('drafts.article-1'),
    ).rejects.toThrow(/Unauthorized/)

    expect(echoLog().session.state).toBe('unauthenticated')
  })

  it('notes a 403 from getDocuments, through the observable surface too', async () => {
    const server = await bootServer()
    const {client} = await wrap(server, {readError: authError(403)})

    const observable = (client.observable as Rec).getDocuments as (ids: string[]) => unknown
    await expect(firstValue(observable(['article-1']))).rejects.toThrow(/Unauthorized/)

    expect(echoLog().session.state).toBe('unauthenticated')
  })

  it('forwards a non-auth read failure unchanged, without ending the session', async () => {
    const server = await bootServer()
    const boom = new Error('the network went away')
    const {client} = await wrap(server, {readError: boom})

    await expect(
      (client.getDocument as (id: string) => Promise<unknown>)('drafts.article-1'),
    ).rejects.toBe(boom)
    expect(echoLog().session.state).toBe('active')
  })

  it('does NOT end the session on a 403 from an arbitrary query', async () => {
    /* Deliberate asymmetry, and it predates this change: a 403 on a query can be
     * a dataset ACL rather than a dead token, and over-reporting it would refuse
     * every later write. */
    const server = await bootServer()
    const {client} = await wrap(server, {readError: authError(403)})

    await expect(
      (client.fetch as (q: string, p?: unknown) => Promise<unknown>)('*[_id == $id][0]', {
        id: 'article-1',
      }),
    ).rejects.toThrow(/Unauthorized/)
    expect(echoLog().session.state).toBe('active')
  })
})

/* ================================================================== *
 * 3. fetch — the exact slice, and an honest refusal for the rest
 * ================================================================== */

describe('fetch — queries the overlay can answer exactly', () => {
  it('answers a by-ID query with the branch document', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {
      documents: {},
      fetch: () => BASE_DRAFT,
    })

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<Rec>)(
      '*[_id == $id][0]',
      {id: 'drafts.article-1'},
    )) as Rec

    expect(result.title).toBe('BRANCH TITLE')
    expect(echoLog().reads.exact).toBeGreaterThan(0)
    expect(echoLog().reads.approximated).toBe(0)
  })

  it('answers with a branch-created document staging has never held', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'create-1',
      kind: 'mutations',
      payload: [{create: {_id: 'drafts.article-new', _type: 'article', title: 'BRANCH CREATED'}}],
      baseDocuments: [],
    })
    const {client} = await wrap(server, {fetch: () => null})

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<Rec>)(
      '*[_id == $id][0]',
      {id: 'drafts.article-new'},
    )) as Rec

    expect(result?.title).toBe('BRANCH CREATED')
  })

  it('removes a locally deleted document from a by-IDs query', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'delete-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    const {client} = await wrap(server, {fetch: () => [BASE_ARTICLE]})

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<unknown[]>)(
      '*[_id in $ids]',
      {ids: ['article-1']},
    )) as unknown[]

    expect(result).toEqual([])
  })

  it('finds a document by the slug the branch gave it, not the staging slug', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'reslug-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {'slug.current': 'branch-slug'}},
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    /* Staging knows nothing about `branch-slug`, so its answer is empty. */
    const {client} = await wrap(server, {fetch: () => null})

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<Rec>)(
      '*[_type == "article" && slug.current == $slug][0]',
      {slug: 'branch-slug'},
    )) as Rec

    expect(result?._id).toBe('drafts.article-1')
    expect(result?.title).toBe('STAGING TITLE')
  })

  it('drops a staging document whose slug the branch moved away', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'reslug-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {'slug.current': 'branch-slug'}},
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    const {client} = await wrap(server, {fetch: () => BASE_DRAFT})

    const result = await (client.fetch as (q: string, p?: unknown) => Promise<unknown>)(
      '*[_type == "article" && slug.current == $slug][0]',
      {slug: 'staging-slug'},
    )

    /* The branch renamed the slug, so the virtual document no longer matches. */
    expect(result).toBeNull()
  })
})

/* ================================================================== *
 * 3b. The Studio list pane — the shape a live session actually issues
 * ================================================================== *
 *
 * Observed 2026-08-04 against a real Studio: the Article list pane does NOT
 * issue `*[_type == "article"]{…}`. It issues a literal ID set wrapped in a
 * projection, a slice and an outer array:
 *
 *   [*[_id in ["article-01",…]][0...23]{_id,_rev,_type,title,…}][0...1]
 *
 * The candidate set is as provable as it gets — the IDs are in the query text —
 * so the only thing that ever blocked it was that the old ad-hoc classifier
 * could not evaluate a projection. It now goes through `sanity-overlay-query`'s
 * pinned `groq-js`, over a candidate set the overlay has already resolved.
 */

describe('fetch — the Studio list pane renders the branch, not staging', () => {
  const OTHER: Rec = {
    _id: 'article-9',
    _type: 'article',
    _rev: 'lake-rev-9',
    title: 'ANOTHER STAGING TITLE',
  }

  /** The list pane's own shape, over the two documents these tests use. */
  const LIST_PANE =
    '[*[_id in ["article-9","drafts.article-1"]][0...23]{_id,_type,title}][0...1]'

  it('renders the BRANCH title for a document renamed in the overlay', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(server, {fetch: () => [OTHER, BASE_DRAFT]})

    const result = (await (client.fetch as (q: string) => Promise<unknown[]>)(
      LIST_PANE,
    )) as Array<Array<Rec>>

    expect(result[0]).toEqual([
      {_id: 'article-9', _type: 'article', title: 'ANOTHER STAGING TITLE'},
      {_id: 'drafts.article-1', _type: 'article', title: 'BRANCH TITLE'},
    ])
    expect(echoLog().reads.exact).toBeGreaterThan(0)
    expect(echoLog().reads.approximated).toBe(0)
  })

  it('includes a branch-created document in a type list, in `_id` order', async () => {
    /* Two claims at once, and the order one is the subtle half: `evaluate.ts`
     * admits base candidates before branch-created ones, so an unordered list
     * would append `article-0` at the end and the pane would be reporting where
     * a document came from rather than what it is. */
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'create-first',
      kind: 'mutations',
      payload: [{create: {_id: 'article-0', _type: 'article', title: 'BRANCH CREATED'}}],
      baseDocuments: [],
    })
    const {client} = await wrap(server, {fetch: () => [OTHER]})

    const result = (await (client.fetch as (q: string) => Promise<unknown[]>)(
      '*[_type == "article"]{_id, title}',
    )) as Rec[]

    expect(result).toEqual([
      {_id: 'article-0', title: 'BRANCH CREATED'},
      {_id: 'article-9', title: 'ANOTHER STAGING TITLE'},
    ])
  })

  it('drops a tombstoned document from a list result', async () => {
    const server = await bootServer()
    await commit(server, {
      idempotencyKey: 'delete-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    const {client} = await wrap(server, {fetch: () => [BASE_ARTICLE, BASE_DRAFT, OTHER]})

    const result = (await (client.fetch as (q: string) => Promise<unknown[]>)(
      '*[_type == "article"]{_id}',
    )) as Rec[]

    expect(result).toEqual([{_id: 'article-9'}])
  })

  it('asks staging for the candidate set the plan named, not for the original query', async () => {
    /* The exact path stops passing the caller's query to staging: a projected,
     * sliced answer is not a candidate set. It issues the plan's own base
     * request instead — the `BaseCandidateRequest` shapes §22.6 step 5 defines —
     * which is also why a projection no longer costs exactness. */
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client, stub} = await wrap(server, {fetch: () => [BASE_DRAFT]})

    await (client.fetch as (q: string) => Promise<unknown>)(LIST_PANE)

    const issued = stub.fetchCalls
      .map((call) => call.query)
      .filter((query) => !query.includes('__spike_echo_probe__'))
    expect(issued).toHaveLength(1)
    expect(issued[0]).not.toBe(LIST_PANE)
    expect(issued[0]).toMatch(/_id in \$/)
    expect(stub.fetchCalls.at(-1)?.params).toMatchObject({
      __spikeAIds: ['article-9', 'drafts.article-1'],
    })
  })

  it('degrades to staging, loudly, when the overlay cannot answer the list', async () => {
    const {client} = await wrap(null, {fetch: () => [BASE_DRAFT]})

    const result = (await (client.fetch as (q: string) => Promise<unknown>)(LIST_PANE)) as unknown[]

    expect(result).toEqual([BASE_DRAFT])
    expect(echoLog().reads.failed).toBeGreaterThan(0)
    expect(errors.join('\n')).toMatch(/overlay/i)
  })
})

describe('fetch — queries the overlay cannot answer exactly', () => {
  /* Studio's own search/findability query. `text::query` is answered by the
   * hosted search index, so no candidate set proves complete — the honest
   * refusal, and the one the PRD degrades (§22.3 Tier C). */
  const LIST_QUERY =
    '*[_type in $__types && ([@, _id] match text::query($__query))]{_id} | order(_id asc)'

  it('passes the query through to staging rather than failing the pane', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client, stub} = await wrap(server, {fetch: () => [BASE_ARTICLE]})

    const result = (await (client.fetch as (q: string) => Promise<unknown[]>)(
      LIST_QUERY,
    )) as unknown[]

    expect(result).toEqual([BASE_ARTICLE])
    expect(stub.fetchCalls.map((call) => call.query)).toContain(LIST_QUERY)
  })

  it('records the approximation where a user can see it', async () => {
    /* PRD §5.5 forbids *silent* approximation. This is the "not silent" part:
     * the query, the reason and a count, on `window.__SPIKE_ECHO__`. */
    const server = await bootServer()
    const {client} = await wrap(server, {fetch: () => []})

    await (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    await (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)

    const reads = echoLog().reads
    expect(reads.approximated).toBe(2)
    expect(reads.exact).toBe(0)
    expect(reads.unsupported).toHaveLength(1)
    expect(reads.unsupported[0]?.query).toBe(LIST_QUERY)
    expect(reads.unsupported[0]?.count).toBe(2)
    expect(reads.unsupported[0]?.reason.length).toBeGreaterThan(0)
  })

  it('warns once per distinct query shape, not once per call', async () => {
    const server = await bootServer()
    const {client} = await wrap(server, {fetch: () => []})

    await (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    await (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    await (client.fetch as (q: string) => Promise<unknown>)('*')

    const overlayWarnings = warnings.filter((line) => line.includes('overlay'))
    expect(overlayWarnings).toHaveLength(2)
    expect(echoLog().reads.unsupported).toHaveLength(2)
  })

  it('names the query and the reason in the warning', async () => {
    const server = await bootServer()
    const {client} = await wrap(server, {fetch: () => []})
    await (client.fetch as (q: string) => Promise<unknown>)(
      '*[_type == "system.release" && _id in path("_.releases.*")]{_id}',
    )

    expect(warnings.join('\n')).toMatch(/path\(\)|system/)
  })

  it('refuses, rather than guessing, when a query parameter is missing', async () => {
    /* The candidate set for `_id == $id` is the parameter. Absent, the honest
     * answer is "cannot plan this", never "matches nothing" — which would be an
     * approximation delivered with a straight face. */
    const server = await bootServer()
    const {client} = await wrap(server, {fetch: () => []})

    await (client.fetch as (q: string, p?: unknown) => Promise<unknown>)('*[_id == $id][0]', {})

    expect(echoLog().reads.unsupported[0]?.reason).toMatch(/\$id/)
    expect(echoLog().reads.approximated).toBe(1)
  })

  it('rejects instead of approximating in strict mode', async () => {
    /* PRD §22.5 "[MUST] Reject unregistered queries in strict preview mode". */
    const server = await bootServer()
    const {client, stub} = await wrap(server, {fetch: () => []}, {SPIKE_OVERLAY_STRICT_QUERIES: '1'})

    expect(echoLog().reads.strict).toBe(true)
    await expect(
      (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY),
    ).rejects.toThrow(/spike-a/)
    /* And it never reached staging: a refusal is a refusal. (The only call the
     * stub sees is `localEcho`'s own cold rxjs-constructor probe, which runs
     * against the unwrapped client at boot.) */
    expect(stub.fetchCalls.map((call) => call.query)).not.toContain(LIST_QUERY)
    expect(
      stub.fetchCalls.filter((call) => !call.query.includes('__spike_echo_probe__')),
    ).toHaveLength(0)
  })

  it('still answers the exact shapes in strict mode', async () => {
    const server = await bootServer()
    await renameDraft(server, 'BRANCH TITLE')
    const {client} = await wrap(
      server,
      {fetch: () => BASE_DRAFT},
      {SPIKE_OVERLAY_STRICT_QUERIES: '1'},
    )

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<Rec>)(
      '*[_id == $id][0]',
      {id: 'drafts.article-1'},
    )) as Rec
    expect(result.title).toBe('BRANCH TITLE')
  })

  it('falls back to staging, loudly, when the overlay cannot be reached', async () => {
    const {client} = await wrap(null, {fetch: () => BASE_DRAFT})

    const result = (await (client.fetch as (q: string, p?: unknown) => Promise<Rec>)(
      '*[_id == $id][0]',
      {id: 'drafts.article-1'},
    )) as Rec

    expect(result.title).toBe('STAGING TITLE')
    expect(echoLog().reads.failed).toBeGreaterThan(0)
    expect(errors.join('\n')).toMatch(/overlay/i)
  })
})

/* ================================================================== *
 * The query-plan cache identity
 * ================================================================== *
 *
 * `planFor` caches a `/query/plan` decision under a key built from the query
 * text AND the parameters. A key collision here is not a missed cache — it is a
 * HIT ON THE WRONG PLAN: one query answered with another query’s
 * `baseRequests`, or refused with another query’s reason. The read path then
 * returns exact-looking results derived from the wrong candidate set.
 *
 * The key used to be `query + NUL + stableStringify(params)`. That NUL made git
 * treat the whole of `localEcho.ts` as binary (see `repo-hygiene.test.ts`), and
 * the de-NUL is the reason this suite exists: the obvious replacement — swapping
 * the NUL for a printable separator — reintroduces the classic delimiter hazard
 * the moment either part can contain the separator. `planCacheKey` therefore has
 * no separator at all: `JSON.stringify(query)` is quoted and escaped, so the
 * boundary is structural.
 *
 * The cases below are adversarial in exactly that direction: every one of them
 * plants a candidate separator at the seam.
 */
describe('planCacheKey — one identity per (query, params) pair', () => {
  const SEPARATORS = ['\u0000', ' ', ',', '|', '\n', '\t', '"', '{', '}']
  const BASE_QUERY = '*[_id == $id][0]'

  interface Case {
    query: string
    params: Record<string, unknown>
  }

  function adversarialCases(): Case[] {
    const cases: Case[] = [
      {query: BASE_QUERY, params: {}},
      {query: BASE_QUERY, params: {id: 'a'}},
      {query: BASE_QUERY, params: {id: 'b'}},
      /* Differ only in the query. */
      {query: '*[_id == $id][1]', params: {id: 'a'}},
    ]
    for (const separator of SEPARATORS) {
      cases.push(
        /* The seam moved into the query. */
        {query: `${BASE_QUERY}${separator}`, params: {}},
        {query: `${BASE_QUERY}${separator}{}`, params: {}},
        {query: `${BASE_QUERY}${separator}{"id":"a"}`, params: {}},
        /* The seam moved into the parameters. */
        {query: BASE_QUERY, params: {id: `${separator}{}`}},
        {query: BASE_QUERY, params: {[`${separator}id`]: 'a'}},
        /* Both sides carry it, split differently. */
        {query: `${BASE_QUERY}${separator}x`, params: {id: 'a'}},
        {query: BASE_QUERY, params: {id: `${separator}x`, extra: 'a'}},
      )
    }
    return cases
  }

  it('never gives two distinct pairs the same key', async () => {
    const echo = await loadEcho({})
    const cases = adversarialCases()

    /* Independent oracle: two cases are the same input only if their query is
     * the same string AND their parameters are the same JSON. Anything else is
     * a distinct pair and owes a distinct key. */
    const identity = (item: Case): string => JSON.stringify([item.query, item.params])
    const distinctInputs = new Set(cases.map(identity))
    expect(distinctInputs.size).toBe(cases.length)

    const byKey = new Map<string, Case>()
    const collisions: Array<[Case, Case]> = []
    for (const item of cases) {
      const key = echo.planCacheKey(item.query, item.params)
      const seen = byKey.get(key)
      if (seen === undefined) byKey.set(key, item)
      else collisions.push([seen, item])
    }

    expect(collisions).toEqual([])
    expect(byKey.size).toBe(cases.length)
  })

  it('still collapses re-renders of the same query onto one key', async () => {
    const echo = await loadEcho({})

    /* The cache has to keep working: Studio re-issues the same query with an
     * equal-but-not-identical params object on every render, and parameter
     * insertion order is not meaningful. */
    expect(echo.planCacheKey(BASE_QUERY, {id: 'a', limit: 10})).toBe(
      echo.planCacheKey(BASE_QUERY, {limit: 10, id: 'a'}),
    )
  })
})
