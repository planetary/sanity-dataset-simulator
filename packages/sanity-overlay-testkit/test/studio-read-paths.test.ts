/**
 * EVERY read path a Studio uses must resolve through the overlay — PRD §5.5, §22.
 *
 * WHY THIS FILE EXISTS.
 *
 * A live browser check found the document list pane rendering the branch title
 * and the EDIT FORM for the same document rendering the base one. The editor
 * then replaced the field wholesale and the overlay merged their text with
 * content they had never been shown, because the diff was computed against an
 * ancestor the form never displayed. Nothing errored. That is a §5.5 silent
 * approximation and a data-correctness bug at once.
 *
 * The contrast localises it: Studio has (at least) TWO read paths.
 *
 *   1. GROQ — `client.fetch` — the list panes, reference inputs, previews.
 *      Answered from `runtime.branch()` / `overlaySourceFromBranch`, which
 *      `/state` hydration feeds. This one worked.
 *   2. DOCUMENT-BY-ID — `client.getDocuments` / `client.observable.getDocuments`
 *      — the pair listener's snapshot fetch, i.e. the value the EDIT FORM opens
 *      with. sanity 6.8.0 `lib/datastores-DqFH7RLd.js:1720` —
 *      `fetchInitialDocumentSnapshots()` calls
 *      `client.observable.getDocuments([publishedId, draftId, versionId])`
 *      whenever the listener says `welcome` or `reset`. Answered from
 *      `echo.getOverlayDocument`, which ONLY the commit path ever populated —
 *      so a session that had not yet written was branch-blind here.
 *
 * THE ORACLE IS NEVER THE CODE UNDER TEST. Every expectation below is checked
 * against a value the Studio code did not compute: a separate `GET /state`
 * round trip, or the canonical `intent.json` bytes read off disk with `node:fs`.
 * A facade that echoed its own input would satisfy neither.
 *
 * The overlay API is the REAL `sanity-overlay-next` server over a REAL temporary
 * `.sanity-overlay` tree. `examples/kitchen-sink/.sanity-overlay` is live state
 * a human is testing against and is never touched.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createClient, type ClientConfig} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {parse} from '../../sanity-overlay-core/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'studio-read-paths-000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

/* ─────────────────────────────────────────────── the real overlay API */

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

async function boot(): Promise<{root: string; server: Booted}> {
  const root = await mkdtemp(join(tmpdir(), 'studio-read-paths-'))
  roots.push(root)
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  running.push(server)
  return {root, server}
}

async function post(server: Booted, route: string, body: unknown): Promise<Rec> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return (await response.json()) as Rec
}

/** THE ORACLE: what the overlay API itself says it holds, fetched separately. */
async function overlayStateDraftTitle(server: Booted, logicalId: string): Promise<unknown> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  const body = (await response.json()) as {documents?: Array<Rec>}
  const entry = (body.documents ?? []).find((document) => document.logicalId === logicalId)
  return (entry?.draft as Rec | null | undefined)?.title
}

/** THE OTHER ORACLE: the canonical review-facing bytes on disk (PRD §14.2). */
async function intentOnDisk(root: string, logicalId: string): Promise<Rec> {
  return parse(
    await readFile(join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json'), 'utf8'),
  ) as Rec
}

/* ─────────────────────────────────────────────────── the base dataset */

const BASE_PUBLISHED = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

const BASE_DRAFT = {
  ...BASE_PUBLISHED,
  _id: 'drafts.article-1',
}

/**
 * The astral round-trip the live check proved correct. Kept verbatim so a fix to
 * the read path cannot quietly regress the UTF-8 byte-offset handling that
 * `core-dmp-unicode` covers from the other side.
 */
const BRANCH_TITLE = 'Article 1 — OVERLAY EDIT ✅ 日本語'

/* ─────────────────────────────────────────────────────── the client */

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

type ColdSubscriber = {
  next: (value: unknown) => void
  error: (error: unknown) => void
  complete: () => void
}

/** `@sanity/client`'s own rxjs Observable, read off a real client. */
const RealObservable = Object.getPrototypeOf(
  createClient(CONFIG).observable.fetch('*[_id == "__read_paths_probe__"][0]'),
).constructor as new (
  subscribe: (subscriber: ColdSubscriber) => (() => void) | void,
) => {subscribe: (observer: unknown) => {unsubscribe: () => void}}

function coldOf(value: unknown): unknown {
  return new RealObservable((subscriber) => {
    subscriber.next(value)
    subscriber.complete()
    return undefined
  })
}

interface BaseClient extends Rec {
  reads: string[]
}

/**
 * Staging, exactly as the Content Lake would answer it: it has never heard of
 * the branch edit. Anything overlay-aware in the result therefore came from the
 * overlay, not from here.
 */
function baseClient(): BaseClient {
  const reads: string[] = []
  const documentsFor = (ids: readonly string[]): unknown[] =>
    ids.map((id) =>
      id === 'article-1' ? {...BASE_PUBLISHED} : id === 'drafts.article-1' ? {...BASE_DRAFT} : null,
    )

  const self: BaseClient = {
    reads,
    fetch: (query: string): Promise<unknown> => {
      reads.push(`fetch:${query}`)
      return Promise.resolve([{...BASE_PUBLISHED}, {...BASE_DRAFT}])
    },
    getDocument: (id: string): Promise<unknown> => {
      reads.push(`getDocument:${id}`)
      return Promise.resolve(documentsFor([id])[0] ?? undefined)
    },
    getDocuments: (ids: readonly string[]): Promise<unknown> => {
      reads.push(`getDocuments:${ids.join(',')}`)
      return Promise.resolve(documentsFor(ids))
    },
    listen: (): unknown => new RealObservable(() => undefined),
    config: () => ({...CONFIG}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
  }
  self.observable = {
    fetch: (query: string): unknown => {
      reads.push(`observable.fetch:${query}`)
      return coldOf([{...BASE_PUBLISHED}, {...BASE_DRAFT}])
    },
    getDocuments: (ids: readonly string[]): unknown => {
      reads.push(`observable.getDocuments:${ids.join(',')}`)
      return coldOf(documentsFor(ids))
    },
    listen: (): unknown => new RealObservable(() => undefined),
  }
  return self
}

const RESOLVED = (apiUrl: string): ReturnType<typeof resolveOverlayOptions> =>
  resolveOverlayOptions({mode: 'fs', apiUrl, strictQueries: false}, {})

/** One value out of a promise or a cold observable. */
function first(result: unknown): Promise<unknown> {
  if (result !== null && typeof result === 'object' && 'then' in (result as Rec)) {
    return result as Promise<unknown>
  }
  return new Promise((resolve, reject) => {
    ;(result as {subscribe: (o: Rec) => unknown}).subscribe({
      next: (value: unknown) => resolve(value),
      error: (error: unknown) => reject(error),
    })
  })
}

/**
 * A branch that already holds an edit, committed through the real API, and then
 * a BRAND NEW Studio session over it — the page-reload case, where nothing in
 * this browser tab has written anything.
 */
async function sessionOverExistingBranch(): Promise<{
  root: string
  server: Booted
  client: BaseClient
  wrapped: Rec
}> {
  const {root, server} = await boot()

  await post(server, '/commit', {
    idempotencyKey: 'seed-1',
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {set: {title: BRANCH_TITLE}},
      },
    ],
    baseDocuments: [BASE_PUBLISHED],
  })

  const client = baseClient()
  const runtime = createOverlayRuntime({
    resolved: RESOLVED(server.url),
    createClient: () => client,
  })
  /* The one poll the §21.3 banner performs on mount. Nothing else has run. */
  await runtime.refresh()

  return {root, server, client, wrapped: runtime.clientFactory({}) as Rec}
}

/* ══════════════════════════════════════════════════════════════════════ */

describe('the document-by-id read path — what the EDIT FORM opens with', () => {
  it('answers `getDocuments` from the branch on a session that has written nothing', async () => {
    const {root, server, wrapped} = await sessionOverExistingBranch()

    const answered = (await first(
      (wrapped.getDocuments as (ids: string[]) => unknown)(['article-1', 'drafts.article-1']),
    )) as Array<Rec | null>

    const oracle = await overlayStateDraftTitle(server, 'article-1')
    expect(oracle).toBe(BRANCH_TITLE)
    expect((await intentOnDisk(root, 'article-1')).logicalId).toBe('article-1')

    expect((answered[1] as Rec)?.title).toBe(oracle)
  })

  it('answers `observable.getDocuments` — the pair listener snapshot fetch — from the branch', async () => {
    const {server, wrapped} = await sessionOverExistingBranch()
    const observable = wrapped.observable as Rec

    const answered = (await first(
      (observable.getDocuments as (ids: string[]) => unknown)(['article-1', 'drafts.article-1']),
    )) as Array<Rec | null>

    expect((answered[1] as Rec)?.title).toBe(await overlayStateDraftTitle(server, 'article-1'))
  })

  it('answers a single `getDocument` from the branch', async () => {
    const {server, wrapped} = await sessionOverExistingBranch()

    const answered = (await first(
      (wrapped.getDocument as (id: string) => unknown)('drafts.article-1'),
    )) as Rec

    expect(answered?.title).toBe(await overlayStateDraftTitle(server, 'article-1'))
  })

  it('still reaches staging for a document the branch does not hold', async () => {
    const {wrapped, client} = await sessionOverExistingBranch()

    const answered = (await first(
      (wrapped.getDocuments as (ids: string[]) => unknown)(['article-1']),
    )) as Array<Rec | null>

    expect((answered[0] as Rec)?.title).toBe('Article 1')
    expect(client.reads).toContain('getDocuments:article-1')
  })
})

/* ══════════════════════════════════════════════ the rest of the class */

/**
 * The seeding bug was one instance. The read tap could get a document-by-id
 * answer wrong in three ways, and all three put content in front of an editor
 * that the branch does not hold:
 *
 *   1. the branch holds an EDITED body and the tap has never heard of it,
 *   2. the branch has TOMBSTONED the address and base is served instead,
 *   3. the branch CREATED the document, base answers `null`, and the tap has no
 *      `_id` to key on because there is no body to read one from.
 */
describe('the rest of the document-by-id class', () => {
  it('answers `null` for an address the branch has deleted, never the base body', async () => {
    const {root, server} = await boot()

    await post(server, '/commit', {
      idempotencyKey: 'seed-edit',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {title: BRANCH_TITLE}},
        },
      ],
      baseDocuments: [BASE_PUBLISHED],
    })
    await post(server, '/commit', {
      idempotencyKey: 'seed-delete',
      kind: 'documentActions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          publishedId: 'article-1',
          draftId: 'drafts.article-1',
        },
      ],
      baseDocuments: [BASE_PUBLISHED],
    })

    /* THE ORACLE: the API's own inventory, fetched separately. */
    const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const body = (await response.json()) as {documents?: Array<Rec>}
    const entry = (body.documents ?? []).find((document) => document.logicalId === 'article-1')
    expect(entry?.draftTombstone).toBe(true)
    expect((await intentOnDisk(root, 'article-1')).logicalId).toBe('article-1')

    const client = baseClient()
    const runtime = createOverlayRuntime({
      resolved: RESOLVED(server.url),
      createClient: () => client,
    })
    await runtime.refresh()
    const wrapped = runtime.clientFactory({}) as Rec

    const answered = (await first(
      (wrapped.getDocuments as (ids: string[]) => unknown)(['article-1', 'drafts.article-1']),
    )) as Array<Rec | null>

    /* Staging still has `drafts.article-1`; the branch says it is gone. */
    expect(client.reads).toContain('getDocuments:article-1,drafts.article-1')
    expect(answered[1]).toBeNull()
  })

  it('answers a branch-created document the base has never heard of', async () => {
    const {server} = await boot()

    await post(server, '/commit', {
      idempotencyKey: 'seed-create',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.create',
          attributes: {_id: 'drafts.article-9', _type: 'article', title: 'Born in the branch'},
        },
      ],
    })

    const client = baseClient()
    const runtime = createOverlayRuntime({
      resolved: RESOLVED(server.url),
      createClient: () => client,
    })
    await runtime.refresh()
    const wrapped = runtime.clientFactory({}) as Rec

    const answered = (await first(
      (wrapped.getDocuments as (ids: string[]) => unknown)(['article-9', 'drafts.article-9']),
    )) as Array<Rec | null>

    /* THE ORACLE: `/state`, fetched separately. Base answers `null` for both. */
    const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const body = (await response.json()) as {documents?: Array<Rec>}
    const entry = (body.documents ?? []).find((document) => document.logicalId === 'article-9')
    expect((entry?.draft as Rec | undefined)?.title).toBe('Born in the branch')

    expect((answered[1] as Rec)?.title).toBe((entry?.draft as Rec).title)
  })
})

describe('the GROQ read path stays overlay-aware (the control)', () => {
  it('answers a list query from the branch, as it already did', async () => {
    const {server, wrapped} = await sessionOverExistingBranch()

    const rows = (await (wrapped.fetch as (query: string) => Promise<unknown>)(
      '*[_type == "article"]{_id, title}',
    )) as Array<Rec>

    const branchRow = rows.find((row) => row._id === 'drafts.article-1')
    expect(branchRow?.title).toBe(await overlayStateDraftTitle(server, 'article-1'))
  })
})
