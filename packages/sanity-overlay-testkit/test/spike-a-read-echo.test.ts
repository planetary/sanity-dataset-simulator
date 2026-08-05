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

  const getDocument = (id: string): Promise<Rec | null> =>
    Promise.resolve(documents[id] ?? null)
  const getDocuments = (ids: string[]): Promise<Array<Rec | null>> =>
    Promise.resolve(ids.map((id) => documents[id] ?? null))
  const doFetch = (query: string, params?: unknown): unknown => {
    fetchCalls.push({query, params})
    return Promise.resolve(upstream.fetch?.(query, params) ?? null)
  }

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
        return observableOf(upstream.fetch?.(query, params) ?? null)
      },
      getDocument: (id: string) => observableOf(documents[id] ?? null),
      getDocuments: (ids: string[]) => observableOf(ids.map((id) => documents[id] ?? null)),
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

describe('fetch — queries the overlay cannot answer exactly', () => {
  const LIST_QUERY = '*[_type == "article"] | order(_updatedAt desc) [0...100]'

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
    await (client.fetch as (q: string) => Promise<unknown>)('*[_type == "author"]')

    const overlayWarnings = warnings.filter((line) => line.includes('overlay'))
    expect(overlayWarnings).toHaveLength(2)
    expect(echoLog().reads.unsupported).toHaveLength(2)
  })

  it('names the query and the reason in the warning', async () => {
    const server = await bootServer()
    const {client} = await wrap(server, {fetch: () => []})
    await (client.fetch as (q: string) => Promise<unknown>)('*[_id == $id][0]{title}', {
      id: 'a',
    } as never)

    expect(warnings.join('\n')).toContain('projection')
  })

  it('rejects instead of approximating in strict mode', async () => {
    /* PRD §22.5 "[MUST] Reject unregistered queries in strict preview mode". */
    const server = await bootServer()
    const {client, stub} = await wrap(server, {fetch: () => []}, {SPIKE_OVERLAY_STRICT_QUERIES: '1'})

    expect(echoLog().reads.strict).toBe(true)
    await expect(
      (client.fetch as (q: string) => Promise<unknown>)(LIST_QUERY),
    ).rejects.toThrow(/spike-a/)
    /* And it never reached staging: a refusal is a refusal. */
    expect(stub.fetchCalls).toHaveLength(0)
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
