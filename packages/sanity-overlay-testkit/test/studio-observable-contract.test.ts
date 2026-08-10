/**
 * `sanity-overlay-studio` — THE OBSERVABLE RETURN-TYPE CONTRACT.
 *
 * WHAT WENT WRONG
 * ───────────────
 * The facade answered `client.observable.*` with a hand-rolled object that had
 * `subscribe` and nothing else. Studio's own datastores do
 *
 *     client.observable.request({uri: `/projects/${projectId}`}).pipe(…)
 *
 * (`createProjectStore`), so the very first thing Studio did with a wrapped
 * observable was call a method that did not exist:
 *
 *     TypeError: client.observable.request(...).pipe is not a function
 *
 * Full-screen error inside `<StudioTelemetryProvider>`. Studio never rendered.
 *
 * WHY THE UNIT SUITE MISSED IT
 * ────────────────────────────
 * `studio-facade.test.ts` drives a hand-written double whose observables are
 * `{subscribe}` — the same shape the facade produced. Double and subject agreed
 * with each other and both disagreed with `@sanity/client`. So this file takes
 * its oracle from the LIBRARY, never from the facade:
 *
 *   - `RealObservable` is read off a real `@sanity/client@7.26.0` observable's
 *     prototype. Nothing here declares what an Observable is.
 *   - every case is invoked against the REAL client first, and its answer is
 *     what the wrapper is then held to. If `@sanity/client` changes what a
 *     method returns, the oracle moves with it.
 *   - `instanceof RealObservable` is the assertion, not "has a subscribe". rxjs
 *     operators are `lift`-based: `operate()` throws
 *     `TypeError: Unable to lift unknown Observable type` unless the source is a
 *     genuine `Observable`. A duck-typed `{subscribe, pipe}` would pass a
 *     shape check and still break `pipe(map(…))`, which is the thing Studio
 *     actually does.
 *
 * COVERAGE IS ENFORCED, NOT CURATED
 * ─────────────────────────────────
 * `every method the real observable client ships is classified` walks the real
 * prototype chain and the real namespace objects at run time. A `@sanity/client`
 * upgrade that adds a method makes this file red rather than silently reopening
 * the hole.
 *
 * NO NETWORK. `@sanity/client`'s observable API is cold — building a request
 * observable and dropping it makes no call. Only observables the facade
 * *synthesises* (blocked writes, refusals, the local echo channel) are ever
 * subscribed to here.
 */
import {realpathSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'
import type {AddressInfo} from 'node:net'
import {fileURLToPath} from 'node:url'
import {types} from 'node:util'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {
  createClient,
  type ClientConfig,
  type SanityClient,
} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>
type AnyFn = (...args: never[]) => unknown

const HERE = dirname(fileURLToPath(import.meta.url))

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

/* ───────────────────────────────────────────────── the library's own rxjs */

/**
 * The exact rxjs `@sanity/client` was installed with — resolved through the
 * package's *real* path so pnpm's isolated layout hands back the same copy the
 * client itself imports, not a second one that would fail `instanceof`.
 */
interface RxModule {
  Observable: new (subscribe: (subscriber: never) => unknown) => unknown
  isObservable: (value: unknown) => boolean
  map: (project: (value: never) => unknown) => (source: never) => unknown
  firstValueFrom: (source: never) => Promise<unknown>
  lastValueFrom: (source: never) => Promise<unknown>
}

const rx = createRequire(
  realpathSync(resolve(HERE, '../../../examples/kitchen-sink/node_modules/@sanity/client/package.json')),
)('rxjs') as RxModule

/** Read off the library, never declared: what `@sanity/client` returns. */
const RealObservable = Object.getPrototypeOf(
  createClient(CONFIG).observable.fetch('*[_id == "__contract_probe__"][0]'),
).constructor as new (...args: never[]) => unknown

/* ────────────────────────────────────────────────────────── a local origin */

/**
 * The Content Lake, on loopback.
 *
 * The promise surface cannot be observed without *running* it — a real
 * `client.fetch()` has to reach something before it is a settled Promise — and
 * this file refuses to make that something the internet. So `apiHost` points at
 * a server on 127.0.0.1 that answers every route, `useProjectHostname: false`
 * keeps the URL free of DNS, and `/listen/` is answered as a live SSE stream
 * that never emits, so a merged pair listener only ever carries overlay frames.
 *
 * The observable cases still never subscribe: `@sanity/client` is cold, and this
 * server exists for the promise surface, not for them.
 */
let origin: Server | undefined
let apiHost = 'https://api.sanity.io'
const openStreams = new Set<{end: () => void}>()

beforeAll(async () => {
  origin = createServer((request, response) => {
    if ((request.url ?? '').includes('/listen/')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(': welcome\n\n')
      openStreams.add(response)
      request.on('close', () => openStreams.delete(response))
      return
    }
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({result: null, ms: 1, documents: [], omitted: [], data: []}))
  })
  await new Promise<void>((done) => origin?.listen(0, '127.0.0.1', done))
  apiHost = `http://127.0.0.1:${(origin?.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const stream of openStreams) stream.end()
  openStreams.clear()
  origin?.closeAllConnections()
  await new Promise<void>((done) => origin?.close(() => done()))
})

/* ─────────────────────────────────────────────────────────────── harness */

function transportDouble(): OverlayTransport {
  const answer = async (): Promise<OverlayTransportResult> => ({outcome: 'ok'})
  return {
    apiUrl: 'http://localhost:3998',
    commit: answer,
    resolve: answer,
    query: answer,
    state: answer,
  }
}

interface Harness {
  real: SanityClient
  wrapped: SanityClient
  echo: ReturnType<typeof createOverlayEcho>
  errors: string[]
}

/** The same config, pointed at the loopback origin. */
function localConfig(): ClientConfig {
  return {...CONFIG, useProjectHostname: false, apiHost}
}

function harness(): Harness {
  const errors: string[] = []
  const real = createClient(localConfig())
  const echo = createOverlayEcho({onError: (message) => errors.push(message)})
  const wrapped = wrapWithOverlay(real, {
    echo,
    transport: transportDouble(),
    onError: (message) => errors.push(message),
  })
  return {real, wrapped, echo, errors}
}

function observableClientOf(client: SanityClient): Rec {
  return (client as unknown as Rec).observable as Rec
}

/* ─────────────────────────────────────────────────────────────── the cases */

interface Case {
  /** The method being exercised, as `namespace.method` where nested. */
  name: string
  call: (observableClient: Rec) => unknown
}

const call = (host: Rec, path: string, ...args: unknown[]): unknown => {
  const segments = path.split('.')
  let owner: Rec = host
  for (const segment of segments.slice(0, -1)) owner = owner[segment] as Rec
  const method = owner[segments[segments.length - 1]] as AnyFn
  return (method as (...a: unknown[]) => unknown).apply(owner, args)
}

/** Every `client.observable.*` entry point the REAL client answers with an Observable. */
const OBSERVABLE_CASES: Case[] = [
  /* reads — delegated to the real client, tapped on the way back */
  {name: 'fetch', call: (o) => call(o, 'fetch', '*[_id == "article-01"][0]')},
  {name: 'getDocument', call: (o) => call(o, 'getDocument', 'article-01')},
  {name: 'getDocuments', call: (o) => call(o, 'getDocuments', ['article-01', 'drafts.article-01'])},
  {name: 'documentsExists', call: (o) => call(o, 'documentsExists', ['article-01'])},
  {name: 'listen (type-wide)', call: (o) => call(o, 'listen', '*[_type == "article"]')},
  {
    name: 'listen (document pair)',
    call: (o) => call(o, 'listen', '*[_id in $ids]', {ids: ['article-01', 'drafts.article-01']}),
  },
  {
    name: 'request (plain read — the createProjectStore shape)',
    call: (o) => call(o, 'request', {uri: '/projects/b1n03q3z'}),
  },
  {name: 'request (identity probe)', call: (o) => call(o, 'request', {uri: '/users/me'})},

  /* writes — intercepted, answered with a synthetic success */
  {name: 'create', call: (o) => call(o, 'create', {_id: 'article-99', _type: 'article'})},
  {
    name: 'createIfNotExists',
    call: (o) => call(o, 'createIfNotExists', {_id: 'article-99', _type: 'article'}),
  },
  {
    name: 'createOrReplace',
    call: (o) => call(o, 'createOrReplace', {_id: 'article-99', _type: 'article'}),
  },
  {name: 'delete', call: (o) => call(o, 'delete', 'article-99')},
  {name: 'mutate', call: (o) => call(o, 'mutate', [{patch: {id: 'article-01', set: {title: 'x'}}}])},
  {
    name: 'action',
    call: (o) =>
      call(o, 'action', {
        actionType: 'sanity.action.document.publish',
        draftId: 'drafts.article-01',
        publishedId: 'article-01',
      }),
  },
  {
    name: 'request (document write)',
    call: (o) =>
      call(o, 'request', {uri: '/data/mutate/parity', method: 'POST', body: {mutations: []}}),
  },
  {
    name: 'request (refused plane)',
    call: (o) => call(o, 'request', {uri: '/assets/images/b1n03q3z/parity', method: 'POST'}),
  },

  /* the version family — @sanity/client 7.26.0 ships these on both surfaces */
  {
    name: 'createVersion',
    call: (o) => call(o, 'createVersion', {publishedId: 'article-01', baseId: 'article-01', releaseId: 'r'}),
  },
  {
    name: 'replaceVersion',
    call: (o) =>
      call(o, 'replaceVersion', {
        document: {_id: 'versions.r.article-01', _type: 'article'},
        publishedId: 'article-01',
        releaseId: 'r',
      }),
  },
  {
    name: 'discardVersion',
    call: (o) => call(o, 'discardVersion', {releaseId: 'r', publishedId: 'article-01'}),
  },
  {
    name: 'unpublishVersion',
    call: (o) => call(o, 'unpublishVersion', {releaseId: 'r', publishedId: 'article-01'}),
  },

  /* fluent builders — the OTHER way a write leaves the client */
  {name: 'patch(…).commit()', call: (o) => (call(o, 'patch', 'article-01') as Rec & {set: AnyFn; commit: AnyFn}).set({title: 'x'}).commit()},
  {
    name: 'transaction(…).commit()',
    call: (o) =>
      (call(o, 'transaction') as Rec & {create: AnyFn; commit: AnyFn})
        .create({_id: 'article-99', _type: 'article'})
        .commit(),
  },
  {
    name: 'patch(…).clone().commit()',
    call: (o) =>
      (call(o, 'patch', 'article-01') as Rec & {clone: AnyFn})
        .clone()
        .set({title: 'x'})
        .commit(),
  },
  {
    name: 'transaction(…).clone().commit()',
    call: (o) =>
      (call(o, 'transaction') as Rec & {clone: AnyFn})
        .clone()
        .create({_id: 'article-99', _type: 'article'})
        .commit(),
  },

  /* namespaces — each holds its own httpRequest, so `request` never saw them */
  {name: 'users.getById', call: (o) => call(o, 'users.getById', 'me')},
  {name: 'users.getById (other)', call: (o) => call(o, 'users.getById', 'p8xDvUMxC')},
  {name: 'projects.list', call: (o) => call(o, 'projects.list')},
  {name: 'projects.getById', call: (o) => call(o, 'projects.getById', 'b1n03q3z')},
  {name: 'datasets.list', call: (o) => call(o, 'datasets.list')},
  {name: 'datasets.getEmbeddingsSettings', call: (o) => call(o, 'datasets.getEmbeddingsSettings')},
  {name: 'datasets.create', call: (o) => call(o, 'datasets.create', 'scratch')},
  {name: 'datasets.edit', call: (o) => call(o, 'datasets.edit', 'scratch', {aclMode: 'private'})},
  {name: 'datasets.delete', call: (o) => call(o, 'datasets.delete', 'scratch')},
  {
    name: 'datasets.editEmbeddingsSettings',
    call: (o) => call(o, 'datasets.editEmbeddingsSettings', 'scratch', {}),
  },
  {name: 'releases.get', call: (o) => call(o, 'releases.get', {releaseId: 'r'})},
  {name: 'releases.fetchDocuments', call: (o) => call(o, 'releases.fetchDocuments', {releaseId: 'r'})},
  {name: 'releases.create', call: (o) => call(o, 'releases.create', {releaseId: 'r'})},
  {name: 'releases.edit', call: (o) => call(o, 'releases.edit', {releaseId: 'r', patch: {}})},
  {name: 'releases.publish', call: (o) => call(o, 'releases.publish', {releaseId: 'r'})},
  {name: 'releases.archive', call: (o) => call(o, 'releases.archive', {releaseId: 'r'})},
  {name: 'releases.unarchive', call: (o) => call(o, 'releases.unarchive', {releaseId: 'r'})},
  {name: 'releases.schedule', call: (o) => call(o, 'releases.schedule', {releaseId: 'r', publishAt: '2030-01-01'})},
  {name: 'releases.unschedule', call: (o) => call(o, 'releases.unschedule', {releaseId: 'r'})},
  {name: 'releases.delete', call: (o) => call(o, 'releases.delete', {releaseId: 'r'})},
  {name: 'assets.upload', call: (o) => call(o, 'assets.upload', 'image', 'x')},
  {name: 'live.events', call: (o) => call(o, 'live.events')},
  {
    name: 'agent.action.generate',
    call: (o) => call(o, 'agent.action.generate', {schemaId: 's', documentId: 'article-01', instruction: 'hi'}),
  },
  {
    name: 'agent.action.transform',
    call: (o) => call(o, 'agent.action.transform', {schemaId: 's', documentId: 'article-01', instruction: 'hi'}),
  },
  {
    name: 'agent.action.translate',
    call: (o) => call(o, 'agent.action.translate', {schemaId: 's', documentId: 'article-01', toLanguage: {id: 'ja'}}),
  },
  {
    /* A Global Dataset Reference: the one identifier shape that carries its own
     * library id, so no `resource` config is needed to build the URL. */
    name: 'mediaLibrary.video.getPlaybackInfo',
    call: (o) => call(o, 'mediaLibrary.video.getPlaybackInfo', 'media-library:mlABC:video-xyz'),
  },
]

/**
 * The rest of the observable surface, and what it answers with instead. Listed
 * so the coverage guard below can prove nothing was quietly skipped.
 */
const NON_OBSERVABLE_METHODS = [
  'patch', // ObservablePatch builder
  'transaction', // ObservableTransaction builder
  'clone', // ObservableSanityClient
  'withConfig', // ObservableSanityClient
  'config', // plain object
  'getUrl', // string
  'getDataUrl', // string
] as const

/* ════════════════════════════════════ 0. the oracle is the library's own */

describe('the oracle', () => {
  it('resolves the same rxjs copy @sanity/client returns', () => {
    expect(rx.Observable).toBe(RealObservable)
  })

  it('recognises a real client observable, and does not recognise a bare {subscribe}', () => {
    const real = createClient(CONFIG)
    expect(rx.isObservable(real.observable.fetch('*[0]'))).toBe(true)
    expect(rx.isObservable({subscribe: () => ({unsubscribe: (): void => {}})})).toBe(false)
  })

  /**
   * The negative control for this whole file: the exact shape the facade used
   * to return. If `instanceof RealObservable` ever stops being able to see the
   * difference, this goes red first.
   */
  it('a {subscribe}-only object cannot be piped, which is the defect', () => {
    const duck = {subscribe: () => ({unsubscribe: (): void => {}})} as Rec
    expect(duck.pipe).toBeUndefined()
    expect(duck).not.toBeInstanceOf(RealObservable)
  })
})

/* ═══════════════════════════ 1. the class: every observable-shaped answer */

describe('every observable method answers with a real Observable', () => {
  it.each(OBSERVABLE_CASES.map((entry) => [entry.name, entry] as const))(
    'observable.%s',
    (_name, entry) => {
      const {real, wrapped} = harness()

      /* Oracle first: this is what @sanity/client itself does. */
      const fromReal = entry.call(observableClientOf(real))
      expect(fromReal).toBeInstanceOf(RealObservable)

      /* The claim: the wrapper must answer in kind. */
      const fromWrapper = entry.call(observableClientOf(wrapped))
      expect(fromWrapper).toBeInstanceOf(RealObservable)
      expect(typeof (fromWrapper as Rec).pipe).toBe('function')
      expect(typeof (fromWrapper as Rec).subscribe).toBe('function')
      expect(rx.isObservable(fromWrapper)).toBe(true)
    },
  )

  /**
   * `pipe` existing is not enough. rxjs operators go through `lift`, and
   * `operate()` throws `Unable to lift unknown Observable type` on anything that
   * is not a real `Observable`. This is the assertion that would have caught the
   * boot failure, because it is literally what `createProjectStore` does.
   */
  it.each(OBSERVABLE_CASES.map((entry) => [entry.name, entry] as const))(
    'observable.%s composes through a real rxjs operator',
    (_name, entry) => {
      const {wrapped} = harness()
      const source = entry.call(observableClientOf(wrapped)) as Rec & {
        pipe: (op: unknown) => unknown
      }
      const piped = source.pipe(rx.map((value) => value))
      expect(piped).toBeInstanceOf(RealObservable)
    },
  )
})

/* ═══════════════════════════════════════ 2. composition actually delivers */

describe('a piped chain delivers through the facade', () => {
  it('an intercepted write is observed through pipe(map(…))', async () => {
    const {wrapped} = harness()
    const source = observableClientOf(wrapped).create as (doc: Rec) => Rec & {
      pipe: (op: unknown) => unknown
    }
    const value = (await rx.firstValueFrom(
      source({_id: 'article-99', _type: 'article'}).pipe(
        rx.map((result) => ({seen: (result as Rec).transactionId})),
      ) as never,
    )) as Rec
    expect(typeof value.seen).toBe('string')
  })

  it('a refused namespace write errors through pipe(map(…))', async () => {
    const {wrapped} = harness()
    const source = (observableClientOf(wrapped).assets as Rec).upload as (
      ...args: unknown[]
    ) => Rec & {pipe: (op: unknown) => unknown}
    await expect(
      rx.firstValueFrom(source('image', 'x').pipe(rx.map((v) => v)) as never),
    ).rejects.toThrow(/blocked/)
  })

  /**
   * The end-to-end shape: Studio's document pair listener is a piped stream, and
   * the overlay's local channel is the ONLY place an intercepted write can
   * surface on it — the Content Lake never saw the mutation. If the merged
   * listener is not a real Observable, the pane sits at "Saving…" forever.
   */
  it('the local echo channel reaches a piped pair listener', async () => {
    const {wrapped, echo} = harness()
    /*
     * The document has to be one the echo can spell a frame for, and that is a
     * precondition rather than scaffolding. `[{patch: …}]` fails
     * `@sanity/mutator`'s `appliesToMissingDocument()`, so a patch frame at an
     * address the pane holds no revision for would be buffered for ever instead
     * of applied — the echo now refuses to emit one and asks the pane to re-read
     * instead (`studio-echo-refusals.test.ts`). This test is about the OBSERVABLE
     * plumbing, so it uses a document where the frame exists.
     */
    echo.seedFromResult({_id: 'drafts.article-01', _type: 'article', _rev: 'lake-1'}, true)
    const listen = observableClientOf(wrapped).listen as (
      query: string,
      params: Rec,
    ) => Rec & {pipe: (op: unknown) => unknown}
    const stream = listen('*[_id in $ids]', {ids: ['article-01', 'drafts.article-01']}).pipe(
      rx.map((event) => (event as Rec).transactionId),
    )
    expect(stream).toBeInstanceOf(RealObservable)

    const seen: unknown[] = []
    const subscription = (
      stream as unknown as {
        subscribe: (o: {next: (v: unknown) => void; error: (e: unknown) => void}) => {
          unsubscribe: () => void
        }
      }
    ).subscribe({next: (value) => seen.push(value), error: () => undefined})

    const mutate = observableClientOf(wrapped).mutate as (m: unknown) => never
    const answer = (await rx.firstValueFrom(
      mutate([{patch: {id: 'drafts.article-01', set: {title: 'piped'}}}]),
    )) as Rec
    for (let i = 0; i < 8; i += 1) await new Promise((done) => setTimeout(done, 0))

    subscription.unsubscribe()
    expect(seen).toContain(answer.transactionId)
  })
})

/* ══════════════════ 2b. the version family, found by the enumeration above */

/**
 * Enumerating the real surface turned up a SECOND defect, of a different class:
 * `createVersion`, `replaceVersion`, `discardVersion` and `unpublishVersion` are
 * document writes that the facade delegated straight to the real client, on both
 * surfaces. They do not route through `mutate`, `action` or `request` — each
 * calls `_dataRequest` with the raw client — so nothing else could catch them.
 *
 * They are Content Releases plumbing: sanity 6.8.0 calls all four from
 * `useBundleDocuments` and `useScheduledDraftMenuActions`, the release
 * operations. That is the same plane `client.releases.*` is already refused on,
 * so they get the same honest refusal rather than a silent trip to the shared
 * dataset (PRD §11.3).
 */
const VERSION_WRITES: Array<[string, unknown[]]> = [
  ['createVersion', [{publishedId: 'article-01', baseId: 'article-01', releaseId: 'r'}]],
  [
    'replaceVersion',
    [
      {
        document: {_id: 'versions.r.article-01', _type: 'article'},
        publishedId: 'article-01',
        releaseId: 'r',
      },
    ],
  ],
  ['discardVersion', [{releaseId: 'r', publishedId: 'article-01'}]],
  ['unpublishVersion', [{releaseId: 'r', publishedId: 'article-01'}]],
]

describe('the version write family never reaches the dataset', () => {
  /**
   * The oracle is "was the underlying method invoked at all" — an own-property
   * tripwire on the real client instance, which the facade reads through
   * `Reflect.get`. Nothing here trusts the facade's own report.
   */
  function tripwire(client: SanityClient, name: string, escaped: string[]): void {
    for (const host of [client as unknown as object, observableClientOf(client)]) {
      Object.defineProperty(host, name, {
        value: (): never => {
          escaped.push(name)
          throw new Error(`${name} escaped the facade`)
        },
        configurable: true,
        writable: true,
      })
    }
  }

  it.each(VERSION_WRITES)('observable.%s is refused, not delegated', async (name, args) => {
    const {real, wrapped} = harness()
    const escaped: string[] = []
    tripwire(real, name, escaped)

    const method = observableClientOf(wrapped)[name] as (...a: unknown[]) => never
    const answer = method(...args)
    expect(answer).toBeInstanceOf(RealObservable)
    await expect(rx.firstValueFrom(answer)).rejects.toThrow(/blocked/)
    expect(escaped).toEqual([])
  })

  it.each(VERSION_WRITES)('client.%s is refused, not delegated', async (name, args) => {
    const {real, wrapped} = harness()
    const escaped: string[] = []
    tripwire(real, name, escaped)

    const method = (wrapped as unknown as Rec)[name] as (...a: unknown[]) => Promise<unknown>
    await expect(method(...args)).rejects.toThrow(/blocked/)
    expect(escaped).toEqual([])
  })

  /**
   * Completeness, computed rather than curated: every method the real client
   * ships is either a read the facade may delegate, or a write it must not.
   * A `@sanity/client` upgrade that adds a fifth version method lands here.
   */
  it('leaves no un-intercepted write on the real top-level surface', () => {
    const real = createClient(localConfig())
    const INTERCEPTED = new Set([
      'create',
      'createIfNotExists',
      'createOrReplace',
      'delete',
      'mutate',
      'action',
      'dataRequest',
      'request',
      'patch',
      'transaction',
      ...VERSION_WRITES.map(([name]) => name),
    ])
    const DELEGATED_READS = new Set([
      'fetch',
      'getDocument',
      'getDocuments',
      'documentsExists',
      'listen',
      'clone',
      'withConfig',
      'config',
      'getUrl',
      'getDataUrl',
    ])
    const names: string[] = []
    let cursor: object | null = Object.getPrototypeOf(real as unknown as object) as object | null
    while (cursor && cursor !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(cursor)) {
        if (key === 'constructor') continue
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
        if (descriptor && typeof descriptor.value === 'function') names.push(key)
      }
      cursor = Object.getPrototypeOf(cursor) as object | null
    }
    expect(names.filter((name) => !INTERCEPTED.has(name) && !DELEGATED_READS.has(name))).toEqual([])
  })
})

/* ═════════════════════════════ 3. the promise surface is NOT observablised */

describe('the promise surface keeps its own contract', () => {
  const PROMISE_CASES: Case[] = [
    {name: 'fetch', call: (c) => call(c, 'fetch', '*[_id == "article-01"][0]')},
    {name: 'getDocument', call: (c) => call(c, 'getDocument', 'article-01')},
    {name: 'getDocuments', call: (c) => call(c, 'getDocuments', ['article-01'])},
    {name: 'create', call: (c) => call(c, 'create', {_id: 'article-99', _type: 'article'})},
    {name: 'mutate', call: (c) => call(c, 'mutate', [{patch: {id: 'article-01', set: {a: 1}}}])},
    {
      name: 'action',
      call: (c) =>
        call(c, 'action', {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-01',
          publishedId: 'article-01',
        }),
    },
    {name: 'dataRequest', call: (c) => call(c, 'dataRequest', 'mutate', {mutations: []})},
    {name: 'request', call: (c) => call(c, 'request', {uri: '/projects/b1n03q3z'})},
    {name: 'users.getById', call: (c) => call(c, 'users.getById', 'me')},
    {name: 'projects.list', call: (c) => call(c, 'projects.list')},
  ]

  it.each(PROMISE_CASES.map((entry) => [entry.name, entry] as const))(
    'client.%s still answers with a thenable, exactly as the real client does',
    async (_name, entry) => {
      const {real, wrapped} = harness()

      /* Oracle: `types.isPromise` is Node's own brand check, not a duck test —
       * an Observable cannot pass it however many methods it grows. */
      const fromReal = entry.call(real as unknown as Rec)
      expect(types.isPromise(fromReal)).toBe(true)
      await (fromReal as Promise<unknown>).catch(() => undefined)

      const fromWrapper = entry.call(wrapped as unknown as Rec)
      expect(types.isPromise(fromWrapper)).toBe(true)
      expect(fromWrapper).not.toBeInstanceOf(RealObservable)
      await (fromWrapper as Promise<unknown>).catch(() => undefined)
    },
  )

  /**
   * `listen` is the asymmetry: it is an Observable on BOTH surfaces. The promise
   * client is where Studio's document pair listener lives, so this is the one
   * that must not be answered with a promise.
   */
  it.each([
    ['listen (type-wide)', (c: Rec) => call(c, 'listen', '*[_type == "article"]')],
    [
      'listen (document pair)',
      (c: Rec) => call(c, 'listen', '*[_id in $ids]', {ids: ['article-01']}),
    ],
    ['live.events', (c: Rec) => call(c, 'live.events')],
  ])('client.%s answers with an Observable on the promise client too', (_name, invoke) => {
    const {real, wrapped} = harness()
    expect(invoke(real as unknown as Rec)).toBeInstanceOf(RealObservable)
    const fromWrapper = invoke(wrapped as unknown as Rec)
    expect(fromWrapper).toBeInstanceOf(RealObservable)
    expect((fromWrapper as Rec & {pipe: (op: unknown) => unknown}).pipe(rx.map((v) => v))).toBeInstanceOf(
      RealObservable,
    )
  })
})

/* ═════════════════════════════════════════════ 4. coverage is not curated */

describe('the surface is enumerated from the real client, not from a list', () => {
  function methodNames(target: object): string[] {
    const out = new Set<string>()
    let cursor: object | null = target
    while (cursor && cursor !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(cursor)) {
        if (key === 'constructor') continue
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
        if (descriptor && typeof descriptor.value === 'function') out.add(key)
      }
      cursor = Object.getPrototypeOf(cursor) as object | null
    }
    return [...out].sort()
  }

  const covered = new Set(
    OBSERVABLE_CASES.map((entry) => entry.name.replace(/\s*\(.*\)$/, '').replace(/\(.*$/, '')),
  )

  it('every method on the real observable client is classified', () => {
    const real = createClient(CONFIG)
    const names = methodNames(observableClientOf(real))
    const unclassified = names.filter(
      (name) => !covered.has(name) && !NON_OBSERVABLE_METHODS.includes(name as never),
    )
    expect(unclassified).toEqual([])
  })

  it('every namespace method on the real observable client is classified', () => {
    const real = createClient(CONFIG)
    const observable = observableClientOf(real)
    const unclassified: string[] = []
    for (const [root, nested] of [
      ['assets', undefined],
      ['datasets', undefined],
      ['projects', undefined],
      ['users', undefined],
      ['releases', undefined],
      ['live', undefined],
      ['agent', 'action'],
      ['mediaLibrary', 'video'],
    ] as const) {
      const rootValue = observable[root] as Rec | undefined
      if (!rootValue) continue
      const target = nested ? (rootValue[nested] as Rec) : rootValue
      const path = nested ? `${root}.${nested}` : root
      for (const method of methodNames(target)) {
        if (!covered.has(`${path}.${method}`)) unclassified.push(`${path}.${method}`)
      }
    }
    expect(unclassified).toEqual([])
  })

  /**
   * The asymmetry the read layer already learned the hard way: the promise and
   * observable clients are NOT mirrors. Pinned so a future refactor cannot
   * assume they are.
   */
  it('records where the two surfaces disagree in @sanity/client 7.26.0', () => {
    const real = createClient(CONFIG)
    const promiseOnly = methodNames(real as unknown as object).filter(
      (name) => !methodNames(observableClientOf(real)).includes(name),
    )
    expect(promiseOnly).toEqual(['dataRequest', 'observable'].filter((n) => promiseOnly.includes(n)))
    expect(promiseOnly).toContain('dataRequest')

    const promiseAgent = methodNames((real as unknown as Rec).agent as Rec)
    const observableAgent = methodNames(observableClientOf(real).agent as Rec)
    expect(methodNames(((real as unknown as Rec).agent as Rec).action as Rec)).toEqual([
      'generate',
      'patch',
      'prompt',
      'transform',
      'translate',
    ])
    expect(methodNames((observableClientOf(real).agent as Rec).action as Rec)).toEqual([
      'generate',
      'transform',
      'translate',
    ])
    expect(promiseAgent).toEqual(observableAgent)
  })
})
