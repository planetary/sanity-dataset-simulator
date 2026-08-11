/**
 * THE ACCEPTANCE TEST: DOES A STRONG REFERENCE AGREE WITH THE BRANCH?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHAIN. sanity 6.8.0 decides `validation:object.reference-not-published`
 * in four hops, and only one of them is GROQ:
 *
 *   1. `validateDocumentWithReferences` (`datastores-DqFH7RLd.js:5763`) builds
 *      `getDocumentExists` out of
 *      `listenDocumentExists(ctx.observeDocumentPairAvailability, refId, …)`.
 *   2. `listenDocumentExists` (`:5752`) is
 *          published.available || version?.available || false
 *      — the DRAFT's availability is deliberately ignored.
 *   3. `observeDocumentPairAvailability` (`:292`) combines
 *      `observeDocumentAvailability(draftId)` and `(publishedId)`.
 *   4. `observeDocumentAvailability` (`:267`) asks the preview store for a
 *      `_rev` — that is the GROQ hop — and when there is none falls THROUGH to
 *      `fetchDocumentReadability`, a raw
 *      `request({uri: getDataUrl('doc', ids), query: {excludeContent: 'true'}})`
 *      answered by the base dataset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MEASURING IT ACTUALLY SHOWED — three different answers, and only one of
 * them was a defect.
 *
 *  A. A document the branch CREATED already validated, and by a route nobody
 *     had asserted. The preview store's field fetch is
 *
 *         [*[_id in ["author-x"]][0...1]{_id,_type,_rev,…}][0...1]
 *
 *     (`datastores:856-861` `toSubQuery`/`toQuery`), and the §22.6 planner DOES
 *     derive an `ids` candidate plan from it — so hop 4 never runs and the
 *     probe is never issued. §1 below pins that, because it was load-bearing
 *     and unpinned.
 *
 *  B. A document the branch DELETED did NOT. The GROQ hop applies the tombstone
 *     and answers `null`, so `hasRev` is false and hop 4 runs — and staging
 *     still holds the document, so it answers "readable". A strong reference to
 *     a document the branch removed VALIDATED. That is the defect, and §2 is
 *     the red test for it.
 *
 *  C. A document that is only a DRAFT does not validate, in the branch or in
 *     the base dataset. That is hop 2 doing exactly what it says, and it is
 *     hosted parity rather than an overlay defect — §3 asserts the two agree,
 *     which is what makes it parity rather than a coincidence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ALTITUDE. This file does not test the adapter. It builds sanity 6.8.0's
 * REAL `createDocumentPreviewStore` over the REAL `@sanity/client`, wired
 * through the REAL overlay runtime's `clientFactory`, talking real HTTP to a
 * loopback stand-in for the Content Lake and to a real overlay API server over a
 * real temporary store. Only `listenDocumentExists` itself is transcribed — it
 * is one line, and it is not exported.
 *
 * WHAT IS NOT REAL, NAMED RATHER THAN GLOSSED:
 *
 *  a. `globalThis.document`. `createObserveFields` evaluates
 *     `fromEvent(document, 'visibilitychange')` at construction
 *     (`datastores:937`), so the preview store cannot be built in a bare Node
 *     process at all. A four-property stand-in is installed for the duration.
 *     It is never the thing under test: the poll it feeds is the CROSS-DATASET
 *     field observer, and every id here is same-dataset.
 *  b. The Content Lake. A loopback server answers `/data/doc`, `/data/query`
 *     (evaluated by the real `groq-js`) and `/data/listen` (a real SSE stream).
 *     The request is still built, sent and parsed by the real `@sanity/client`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLES ARE INDEPENDENT: an out-of-band `GET /state` on the overlay API
 * made with bare `fetch`; the lake queried directly with bare `fetch`; the
 * lake's own request log; and — for the defect — a DIFFERENTIAL, the same chain
 * in the same session over a document with identical lake state and no branch
 * opinion.
 */
import {createServer, type Server} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {register} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {evaluate, parse} from 'groq-js'

/**
 * `sanity@6.8.0` imports stylesheets from its own dependencies, and Node has no
 * loader for `.css`. This makes such an import evaluate to an empty module,
 * which is what a bundler does with it in the Studio build too. A LOADER, not a
 * stub of anything under test — nothing here is about CSS.
 */
register(
  `data:text/javascript,${encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return {format: 'module', source: 'export default {}', shortCircuit: true}
  }
  return nextLoad(url, context)
}
`)}`,
)

type Rec = Record<string, unknown>

/**
 * The PINNED dist, by path rather than by bare specifier.
 *
 * `sanity@6.8.0` and `@sanity/client@7.26.0` are peers of
 * `sanity-overlay-studio`, not dependencies of this package, so neither
 * resolves from here by name. Every line number this file cites is a line
 * number IN these two files, which makes an explicit path the honest spelling
 * rather than a workaround: the oracle and the citation are the same bytes.
 */
const SANITY_ENTRY = new URL(
  '../../sanity-overlay-studio/node_modules/sanity/lib/index.js',
  import.meta.url,
).href
const SANITY_CLIENT_ENTRY = new URL(
  '../../sanity-overlay-studio/node_modules/@sanity/client/dist/index.js',
  import.meta.url,
).href

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const API_VERSION = '2025-02-19'
const STUDIO_ORIGIN = 'http://localhost:3333'
const OVERLAY_ID = 'reference-validation'

/** Created in the branch, PUBLISHED form. The lake has never heard of it. */
const BRANCH_AUTHOR = 'author-branch-only'
/** Nobody has ever heard of this one — the non-vacuity control. */
const GHOST_AUTHOR = 'author-does-not-exist'
/** The lake holds this one, published. The positive control. */
const BASE_AUTHOR = 'author-in-base'
/** The lake holds it published; the BRANCH deleted it. */
const DELETED_AUTHOR = 'author-deleted-in-branch'
/** The branch holds only `drafts.<id>`. Nothing published, anywhere. */
const DRAFT_ONLY_AUTHOR = 'author-draft-only'
/** The LAKE holds only `drafts.<id>` — the hosted-parity control for the above. */
const BASE_DRAFT_ONLY = 'author-base-draft-only'

/* ══════════════════════════════════════ sanity@6.8.0, transcribed */

interface DocumentAvailability {
  available: boolean
  reason: string
}
interface PairAvailability {
  draft: DocumentAvailability
  published: DocumentAvailability
  version?: DocumentAvailability
}

/**
 * `lib/datastores-DqFH7RLd.js:5752`, verbatim apart from the arrow syntax.
 * Not exported by `sanity`, so it is transcribed rather than imported; it is the
 * only transcription in this file.
 */
function listenDocumentExists(pair: PairAvailability): boolean {
  return !pair.version?.available && pair.version?.reason === 'VERSION_DELETED'
    ? false
    : pair.published.available || pair.version?.available || false
}

/* ══════════════════════════════════════ the DOM stand-in — see header (a) */

function installDocumentStandIn(): () => void {
  const had = 'document' in globalThis
  const previous = (globalThis as Rec).document
  ;(globalThis as Rec).document = {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }
  return () => {
    if (had) (globalThis as Rec).document = previous
    else delete (globalThis as Rec).document
  }
}

/* ══════════════════════════════════════ the loopback "lake" */

interface Lake {
  origin: string
  requests: string[]
  close(): Promise<void>
}

/**
 * `@sanity/client` dials `<protocol>//<projectId>.<apiHost>` when
 * `useProjectHostname` is on (its default, and the Studio's), so the URL is
 * `http://b1n03q3z.localhost:<port>`. RFC 6761 makes every `*.localhost` name
 * resolve to loopback — ephemeral port, no DNS, no network.
 */
async function startLake(documents: readonly Rec[]): Promise<Lake> {
  const byId = new Map(documents.map((document) => [String(document._id), document]))
  const requests: string[] = []
  const streams = new Set<{end: () => void}>()

  const server: Server = createServer((incoming, out) => {
    const path = incoming.url ?? '/'
    requests.push(path)
    const url = new URL(path, 'http://lake.invalid')

    /* The listener. A real SSE stream: one `welcome`, then held open. The
     * preview store's whole invalidation channel hangs off this event, and
     * without it `observePaths` never emits and hop 4 never runs. */
    if (/^\/v[^/]+\/data\/listen\//.test(url.pathname)) {
      out.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      out.write('event: welcome\ndata: {"listenerName":"test"}\n\n')
      const entry = {end: () => out.end()}
      streams.add(entry)
      incoming.on('close', () => streams.delete(entry))
      return
    }

    /* `GET /data/doc/<ds>/<ids>` — the existence probe, answered the way the
     * Content Lake answers it: found bodies in `documents`, everything else in
     * `omitted` with `reason: 'existence'`. */
    const doc = /^\/v[^/]+\/data\/doc\/([^/]+)\/(.*)$/.exec(url.pathname)
    if (doc !== null) {
      const ids = decodeURIComponent(doc[2] as string).split(',')
      const found: Rec[] = []
      const omitted: Rec[] = []
      for (const id of ids) {
        const document = byId.get(id)
        if (document === undefined) omitted.push({id, reason: 'existence'})
        else found.push(document)
      }
      out.writeHead(200, {'content-type': 'application/json'})
      out.end(
        JSON.stringify({
          ms: 1,
          documents: url.searchParams.get('excludeContent') === 'true' ? [] : found,
          omitted,
        }),
      )
      return
    }

    if (/^\/v[^/]+\/data\/query\//.test(url.pathname)) {
      const query = url.searchParams.get('query') ?? ''
      void (async () => {
        let result: unknown = null
        try {
          const tree = parse(query)
          const value = await evaluate(tree, {dataset: [...byId.values()]})
          result = await value.get()
        } catch {
          /* An unparseable query is answered `null`, which is what a base that
           * has never heard of the document effectively answers anyway. */
          result = null
        }
        out.writeHead(200, {'content-type': 'application/json'})
        out.end(JSON.stringify({ms: 1, query, result}))
      })()
      return
    }

    out.writeHead(200, {'content-type': 'application/json'})
    out.end(JSON.stringify({}))
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    origin: `http://localhost:${port}`,
    requests,
    async close() {
      for (const stream of streams) stream.end()
      streams.clear()
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    },
  }
}

/* ══════════════════════════════════════ the session */

interface Session {
  lake: Lake
  overlayUrl: string
  client(): Rec
  state(): Promise<{documents: Array<Rec>}>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** What the lake holds unless a test says otherwise. */
const LAKE_DOCUMENTS: readonly Rec[] = [
  {_id: BASE_AUTHOR, _type: 'author', name: 'From the lake', _rev: 'lake-1'},
  {_id: DELETED_AUTHOR, _type: 'author', name: 'Deleted in the branch', _rev: 'lake-2'},
  {_id: `drafts.${BASE_DRAFT_ONLY}`, _type: 'author', name: 'Never published', _rev: 'lake-3'},
]

/** What the branch holds unless a test says otherwise. */
const BRANCH_MUTATIONS: readonly Rec[] = [
  {createOrReplace: {_id: BRANCH_AUTHOR, _type: 'author', name: 'Invented in the branch'}},
  {createOrReplace: {_id: `drafts.${DRAFT_ONLY_AUTHOR}`, _type: 'author', name: 'Draft only'}},
  {delete: {id: DELETED_AUTHOR}},
]

/**
 * One overlay + one lake + one real client, wired the way `runtime.ts` wires a
 * Studio's `unstable_clientFactory`.
 */
async function boot(): Promise<Session> {
  cleanups.push(installDocumentStandIn())

  const root = await mkdtemp(join(tmpdir(), 'reference-validation-'))
  cleanups.push(() => rm(root, {recursive: true, force: true}))

  const {startOverlayApiServer} = await import('../../sanity-overlay-next/src/index')
  const api = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  cleanups.push(() => api.close())

  const lake = await startLake(LAKE_DOCUMENTS)
  cleanups.push(() => lake.close())

  /* A SECOND WRITER puts the branch into shape over real HTTP, before this
   * session exists — so nothing below is reading its own write echo. */
  const seeded = await fetch(`${api.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify({
      idempotencyKey: 'seed-branch-authors',
      kind: 'mutations',
      payload: BRANCH_MUTATIONS,
      baseDocuments: LAKE_DOCUMENTS.filter((document) => document._id === DELETED_AUTHOR),
    }),
  })
  expect(seeded.status).toBe(200)

  const {resolveOverlayOptions} = await import('../../sanity-overlay-studio/src/options')
  const {createOverlayRuntime} = await import('../../sanity-overlay-studio/src/runtime')
  const {createClient} = await import(SANITY_CLIENT_ENTRY)

  const resolved = resolveOverlayOptions(
    {mode: 'fs', apiUrl: api.url, apiHost: lake.origin, strictQueries: false},
    {},
  )
  const runtime = createOverlayRuntime({
    resolved,
    createClient: (options) => createClient(options as never) as unknown as object,
  })

  /* Hydrate the read side from `GET /state`, which is what the banner's poll
   * does in a browser. Without it the branch view is empty and every path here
   * is branch-blind by design. */
  await runtime.refresh()

  return {
    lake,
    overlayUrl: api.url,
    client: () =>
      runtime.clientFactory({
        projectId: PROJECT_ID,
        dataset: DATASET,
        apiVersion: API_VERSION,
        useCdn: false,
      }) as unknown as Rec,
    async state() {
      const response = await fetch(`${api.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
      expect(response.status).toBe(200)
      return (await response.json()) as {documents: Array<Rec>}
    },
  }
}

/** The first value `observeDocumentPairAvailability` emits, with a deadline. */
function firstPair(observable: unknown, timeoutMs = 15_000): Promise<PairAvailability> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription?.unsubscribe()
      reject(new Error(`no availability emitted within ${timeoutMs}ms`))
    }, timeoutMs)
    const subscription = (
      observable as {
        subscribe: (o: {
          next: (v: PairAvailability) => void
          error: (e: unknown) => void
        }) => {unsubscribe: () => void}
      }
    ).subscribe({
      next: (value) => {
        clearTimeout(timer)
        queueMicrotask(() => subscription.unsubscribe())
        resolve(value)
      },
      error: (error) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    })
  })
}

interface PreviewStore {
  unstable_observeDocumentPairAvailability: (id: string) => unknown
}

async function previewStore(session: Session): Promise<PreviewStore> {
  const {createDocumentPreviewStore} = (await import(SANITY_ENTRY)) as {
    createDocumentPreviewStore: (options: {client: unknown}) => PreviewStore
  }
  return createDocumentPreviewStore({client: session.client()})
}

async function referenceExists(session: Session, id: string): Promise<boolean> {
  const store = await previewStore(session)
  const pair = await firstPair(store.unstable_observeDocumentPairAvailability(id))
  return listenDocumentExists(pair)
}

/** Whether the lake was asked about an id over `/data/doc`, exactly. */
function probedForDoc(session: Session, id: string): boolean {
  return session.lake.requests.some((path) => {
    const match = /^\/v[^/]+\/data\/doc\/[^/]+\/([^?]*)/.exec(path)
    if (match === null) return false
    return decodeURIComponent(match[1] as string).split(',').includes(id)
  })
}

/* ══════════════════════════════════════ 1. the branch-CREATED document */

describe('a strong reference to a document the branch created', () => {
  /**
   * ALREADY CORRECT, AND NOTHING PINNED IT UNTIL NOW.
   *
   * The `/data/doc` probe is a FALLBACK: `observeDocumentAvailability`
   * (`datastores:267`) only reaches it when `observePaths` produced no `_rev`.
   * The preview store's field fetch is GROQ —
   *
   *     [*[_id in ["author-branch-only"]][0...1]{_id,_type,_rev,…}][0...1]
   *
   * (`datastores:856-861`) — and §22.6's planner DOES derive an `ids` candidate
   * plan from it, evaluating over branch ∪ base. So the published form of a
   * branch-created document already carries a `_rev` and already reads
   * READABLE, and the probe is never issued for it.
   *
   * This test therefore locks in a property that holds by a route nobody had
   * asserted: it fails the moment the planner stops handling that query shape.
   */
  it('validates — and never needs the existence probe to say so', async () => {
    const session = await boot()

    /* ORACLE 1 — an independent `GET /state`, bare `fetch`, nothing to do with
     * the client under test. The branch really does hold this author. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === BRANCH_AUTHOR)
    expect((entry?.published as Rec | undefined)?.name).toBe('Invented in the branch')

    expect(await referenceExists(session, BRANCH_AUTHOR)).toBe(true)

    /* ORACLE 2 — the lake's own request log, and the lake's own answer. The
     * published form was resolved WITHOUT the probe; had it been probed, the
     * lake would have said `existence` and the reference would have failed. */
    expect(probedForDoc(session, BRANCH_AUTHOR)).toBe(false)
    const lakeAnswer = await fetch(
      `${session.lake.origin}/v${API_VERSION}/data/doc/${DATASET}/${BRANCH_AUTHOR}`,
    )
    expect(((await lakeAnswer.json()) as Rec).omitted).toEqual([
      {id: BRANCH_AUTHOR, reason: 'existence'},
    ])
  }, 40_000)

  it('still refuses a reference to a document NEITHER the branch nor base holds', async () => {
    const session = await boot()
    expect(await referenceExists(session, GHOST_AUTHOR)).toBe(false)
    /* THIS one really did go to the probe — the control that proves the probe
     * is live in this harness rather than dead code. */
    expect(probedForDoc(session, GHOST_AUTHOR)).toBe(true)
  }, 40_000)

  it('still validates a reference to a document only BASE holds', async () => {
    const session = await boot()
    expect(await referenceExists(session, BASE_AUTHOR)).toBe(true)
  }, 40_000)
})

/* ══════════════════════════════════════ 2. the branch-DELETED document */

describe('a strong reference to a document the branch DELETED', () => {
  /**
   * THE DEFECT `/data/doc` ALONE DECIDES.
   *
   * The GROQ path applies the tombstone and answers `null`, so `hasRev` is
   * false and `observeDocumentAvailability` falls THROUGH to
   * `fetchDocumentReadability` — the raw `/data/doc` probe. Base still holds
   * the document, answers no `omitted` entry, and the reader
   * (`datastores:253`) reads that as `AVAILABILITY_READABLE`.
   *
   * So a reference to a document the branch removed validates, the delete
   * confirmation says it is still referenced, and both are answers about
   * STAGING given to a caller asking about the BRANCH. §5.5.
   */
  it('does NOT validate — the branch removed it, and the probe must say so', async () => {
    const session = await boot()

    /* ORACLE 1 — an independent `GET /state`: the branch really does report a
     * published tombstone for this id. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === DELETED_AUTHOR)
    expect(entry?.publishedTombstone).toBe(true)

    expect(await referenceExists(session, DELETED_AUTHOR)).toBe(false)

    /* ORACLE 2 — THE DIFFERENTIAL. `author-in-base` sits in the lake in exactly
     * the same shape and has NO branch opinion, and the same chain in the same
     * session resolves it `true`. The tombstone is the only difference that can
     * have produced the `false` above. */
    expect(await referenceExists(session, BASE_AUTHOR)).toBe(true)

    /* Snapshotted BEFORE the bare-`fetch` oracle below, which would otherwise
     * appear in the log it is being read from. */
    const probedDeleted = probedForDoc(session, DELETED_AUTHOR)

    /* ORACLE 3 — the lake, asked directly with bare `fetch`: it really does
     * still hold the deleted document, and really would have answered
     * "readable" to the probe. */
    const lakeAnswer = await fetch(
      `${session.lake.origin}/v${API_VERSION}/data/doc/${DATASET}/${DELETED_AUTHOR}`,
    )
    const body = (await lakeAnswer.json()) as {documents: Rec[]; omitted: Rec[]}
    expect(body.omitted).toEqual([])
    expect(body.documents[0]?._id).toBe(DELETED_AUTHOR)

    /* …and the probe for the deleted pair was never sent at all: BOTH of its
     * forms are tombstoned, so the branch could answer the whole request and
     * the round trip was skipped rather than made and then overruled. (That the
     * probe is live in this harness at all is pinned by the ghost-author case
     * above, which does reach it.) */
    expect(probedDeleted).toBe(false)
  }, 40_000)
})

/* ══════════════════════════════════════ 3. the draft-only document */

describe('a strong reference to a document that is only a DRAFT', () => {
  /**
   * NOT A DEFECT — HOSTED PARITY, AND THE THING THE MEASUREMENT ACTUALLY SAW.
   *
   * `listenDocumentExists` is `published.available || version?.available`
   * (`datastores:5752`). The draft's availability is not consulted AT ALL,
   * deliberately: `validation:object.reference-not-published` means what it
   * says. A strong reference to a never-published document is invalid in a
   * hosted Sanity dataset too, and making it validate under the overlay would
   * be an overlay-only behaviour that breaks the moment the branch is merged.
   *
   * The two cases below are the same document in two datasets, and they agree.
   * That agreement is the evidence: this is Sanity's rule, not the overlay's.
   */
  it('refuses a branch draft with no published form — as base does for its own', async () => {
    const session = await boot()

    const branchDraftOnly = await referenceExists(session, DRAFT_ONLY_AUTHOR)
    const baseDraftOnly = await referenceExists(session, BASE_DRAFT_ONLY)

    expect(branchDraftOnly).toBe(false)
    /* THE PARITY ORACLE: a document the LAKE holds only as a draft, resolved
     * through the same chain, is refused identically. */
    expect(baseDraftOnly).toBe(false)

    /* …and both drafts really do exist, so "false" is about publication and not
     * about absence. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === DRAFT_ONLY_AUTHOR)
    expect((entry?.draft as Rec | undefined)?.name).toBe('Draft only')
    const lakeAnswer = await fetch(
      `${session.lake.origin}/v${API_VERSION}/data/doc/${DATASET}/drafts.${BASE_DRAFT_ONLY}`,
    )
    expect(((await lakeAnswer.json()) as {documents: Rec[]}).documents[0]?._id).toBe(
      `drafts.${BASE_DRAFT_ONLY}`,
    )
  }, 40_000)
})
