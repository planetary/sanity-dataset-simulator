/**
 * `sanity-overlay-next` — the read half and the HTTP surface (PRD §18.1, §18.2,
 * §22, §37 Phase 2 "document endpoints", "status endpoint").
 *
 * Real server, real port, real HTTP. The two things this file is most concerned
 * with are the ones a shape-only assertion cannot see:
 *
 *   - A READ MUST SHOW THE BRANCH, not the base it was fetched from. Every
 *     positive case below supplies a base document the branch has edited and
 *     asserts on the BRANCH value. A server that ignored the overlay entirely
 *     would still return a well-formed document.
 *   - AN UNSUPPORTED QUERY IS REFUSED, WITH A REASON (PRD §22.5, §5.5), and
 *     `/query/plan` refuses it as DATA while `/query` refuses it as a 4xx. That
 *     asymmetry is what lets a caller distinguish "the overlay refused this"
 *     from "the overlay is down" — the distinction the §22.5 passthrough licence
 *     rests on.
 *
 * The App Router mounting is exercised directly rather than assumed: PRD §10.1
 * requires this package to expose App Router handlers, and a handler that only
 * works when its path is exactly `/state` does not.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {M_LOCAL_QUERIES} from '../../sanity-overlay-query/src/index'
import {createOverlayApi, startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'next-reads-overlay-000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-reads-'))
  roots.push(root)
  return root
}

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

interface Booted {
  url: string
  close(): Promise<void>
}

async function boot(root: string): Promise<Booted> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  running.push(server)
  return server
}

const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Staging title',
  tags: ['staging'],
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

async function post(server: Booted, route: string, body: unknown) {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
    headers: response.headers,
  }
}

async function get(server: Booted, route: string) {
  const response = await fetch(`${server.url}${route}`, {headers: {origin: STUDIO_ORIGIN}})
  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
    headers: response.headers,
  }
}

/** Put one branch edit on `article-1` so every read below has something to show. */
async function withBranchEdit(server: Booted, title = 'Branch title'): Promise<void> {
  const result = await post(server, '/commit', {
    idempotencyKey: `edit:${title}`,
    kind: 'actions',
    payload: editAction(title),
    baseDocuments: [BASE_ARTICLE],
  })
  expect(result.json.committed).toBe(true)
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

describe('GET /health and GET /state', () => {
  it('reports the overlay it opened', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await get(server, '/health')
    expect(status).toBe(200)
    expect(json).toMatchObject({ok: true, overlayId: OVERLAY_ID})
    expect(typeof json.revision).toBe('number')
  })

  it('is empty before anything is committed', async () => {
    const server = await boot(await makeRoot())
    const {json} = await get(server, '/state')
    expect(json.ok).toBe(true)
    expect(json.documents).toEqual([])
  })

  it('addresses the hydration payload as Studio addresses documents (§13.9)', async () => {
    const server = await boot(await makeRoot())
    await withBranchEdit(server, 'Hydrated')

    const {json} = await get(server, '/state')
    expect(json.documents).toHaveLength(1)
    const [document] = json.documents
    expect(document.logicalId).toBe('article-1')
    expect(document.schemaType).toBe('article')
    expect(document.draft._id).toBe('drafts.article-1')
    expect(document.draft.title).toBe('Hydrated')
    expect(document.published).toBeNull()
    expect(document.draftTombstone).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * POST /resolve — PRD §18.1, §18.2, §22.2
 * ------------------------------------------------------------------ */

describe('POST /resolve', () => {
  it('answers with the branch value, not the base it was handed', async () => {
    const server = await boot(await makeRoot())
    await withBranchEdit(server, 'Branch wins')

    const {status, json} = await post(server, '/resolve', {
      mode: 'perspective',
      perspective: 'drafts',
      ids: ['article-1'],
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(200)
    expect(json.perspective).toBe('drafts')
    expect(json.entries).toHaveLength(1)
    expect(json.entries[0].document.title).toBe('Branch wins')
    /* And the untouched field still comes through from base — this is a merge,
     * not a replacement. */
    expect(json.entries[0].document.tags).toEqual(['staging'])
  })

  it('passes an untouched document straight through from base', async () => {
    const server = await boot(await makeRoot())
    const other = {...BASE_ARTICLE, _id: 'article-2', title: 'Untouched'}

    const {json} = await post(server, '/resolve', {
      mode: 'perspective',
      perspective: 'drafts',
      ids: ['article-2'],
      baseDocuments: [other],
    })
    expect(json.entries[0].origin).toBe('untouched')
    expect(json.entries[0].document.title).toBe('Untouched')
  })

  it('adds branch-created candidates the caller could not have asked for (§22.2)', async () => {
    const server = await boot(await makeRoot())
    await post(server, '/commit', {
      idempotencyKey: 'create',
      kind: 'mutations',
      payload: [
        {create: {_id: 'drafts.article-branch', _type: 'article', title: 'Born in the branch'}},
      ],
    })

    const {json} = await post(server, '/resolve', {
      mode: 'perspective',
      perspective: 'drafts',
      ids: [],
      types: ['article'],
    })

    /* Reported separately, because a caller merging this into a base result has
     * to know which IDs it did not ask for. */
    expect(json.addedIds).toEqual(['article-branch'])
    expect(json.documents.map((d: any) => d.title)).toEqual(['Born in the branch'])
  })

  it('rejects a malformed request rather than guessing', async () => {
    const server = await boot(await makeRoot())
    expect((await post(server, '/resolve', {ids: 'article-1'})).status).toBe(400)
    expect((await post(server, '/resolve', {mode: 'sideways', ids: []})).status).toBe(400)
    expect(
      (await post(server, '/resolve', {mode: 'perspective', perspective: 'raw', ids: []})).status,
    ).toBe(400)
  })
})

/* ------------------------------------------------------------------ *
 * POST /query/plan and POST /query — PRD §22
 * ------------------------------------------------------------------ */

const BY_ID = M_LOCAL_QUERIES.find((definition) => definition.id === 'article-by-id')!

describe('POST /query/plan', () => {
  it('returns the base requests the caller must execute', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await post(server, '/query/plan', {
      query: BY_ID.query,
      params: {id: 'article-1'},
    })

    expect(status).toBe(200)
    expect(json.supported).toBe(true)
    expect(json.queryId).toBe('article-by-id')
    expect(json.queryChecksum).toBe(BY_ID.queryChecksum)
    expect(json.maxCandidates).toBe(BY_ID.maxCandidates)
    expect(json.baseRequests).toEqual([{kind: 'ids', ids: ['article-1']}])
  })

  it('resolves by queryId as well as by the text checksum', async () => {
    const server = await boot(await makeRoot())
    const {json} = await post(server, '/query/plan', {
      queryId: 'article-by-id',
      params: {id: 'article-1'},
    })
    expect(json.supported).toBe(true)
    expect(json.baseRequests).toEqual([{kind: 'ids', ids: ['article-1']}])
  })

  it('refuses an unregistered query as DATA, with a reason a human can read', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await post(server, '/query/plan', {
      query: '*[_type == "article" && secret == $s]',
      params: {s: 1},
    })

    /* 200, deliberately: a 4xx here is indistinguishable from "the overlay is
     * down", which is the one distinction §22.5's passthrough licence needs. */
    expect(status).toBe(200)
    expect(json.supported).toBe(false)
    expect(json.reason).toMatch(/not in the overlay query registry/)
  })

  it('refuses a query whose text drifted from its registered checksum', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await post(server, '/query/plan', {
      queryId: 'article-by-id',
      query: `${BY_ID.query} // edited without re-registering`,
      params: {id: 'article-1'},
    })
    /* PRD §22.9 assigns 422 to `QUERY_CHANGED`. It was 400 until the §22.9 table
     * was wired into `failure()` — see `failure-api.test.ts`. */
    expect(status).toBe(422)
    expect(json.error.code).toBe('QUERY_CHANGED')
  })
})

describe('POST /query', () => {
  it('evaluates against the branch, not the base candidates it was handed', async () => {
    const server = await boot(await makeRoot())
    await withBranchEdit(server, 'Branch answer')

    const {status, json} = await post(server, '/query', {
      query: BY_ID.query,
      params: {id: 'article-1'},
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(200)
    expect(json.queryId).toBe('article-by-id')
    /* The falsifier: `Staging title` is what the base document says, and it is
     * exactly what a server that forgot to overlay would return. */
    expect(json.result).toEqual({title: 'Branch answer', tags: ['staging']})
    expect(json.diagnostics.exact).toBe(true)
  })

  it('suppresses a document the branch deleted', async () => {
    const server = await boot(await makeRoot())
    await post(server, '/commit', {
      idempotencyKey: 'delete',
      kind: 'mutations',
      payload: [{delete: {id: 'article-1'}}],
      baseDocuments: [BASE_ARTICLE],
    })

    const {json} = await post(server, '/query', {
      query: BY_ID.query,
      params: {id: 'article-1'},
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    expect(json.result).toBeNull()
  })

  it('refuses an unregistered query with a 4xx, never an approximation', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await post(server, '/query', {
      query: '*[_type == "article" && secret == $s]',
      params: {s: 1},
      baseDocuments: [BASE_ARTICLE],
    })
    /* §33 "Query not registered → Return 422", and §5.5's refusal in the body. */
    expect(status).toBe(422)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe('UNSUPPORTED_QUERY')
    expect(json.error.message).toMatch(/never approximated/)
  })

  it('requires a query or a queryId', async () => {
    const server = await boot(await makeRoot())
    expect((await post(server, '/query', {params: {}})).status).toBe(400)
  })
})

/* ------------------------------------------------------------------ *
 * The HTTP surface itself
 * ------------------------------------------------------------------ */

describe('CORS and routing', () => {
  it('answers a preflight from the Studio origin', async () => {
    const server = await boot(await makeRoot())
    const preflight = await fetch(`${server.url}/commit`, {
      method: 'OPTIONS',
      headers: {
        origin: STUDIO_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    )
  })

  it('carries the grant on the actual request too', async () => {
    /* Without this the browser drops the response after a successful preflight,
     * which looks exactly like the server being unreachable. */
    const server = await boot(await makeRoot())
    const {headers} = await get(server, '/health')
    expect(headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
    expect(headers.get('vary')).toBe('Origin')
  })

  it('grants nothing to an origin that was not configured', async () => {
    const server = await boot(await makeRoot())
    const response = await fetch(`${server.url}/health`, {
      headers: {origin: 'http://evil.example'},
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('grants no cross-origin access by default', async () => {
    /*
     * The default matters more than the configured case. This API serves the
     * whole branch — every draft, every unpublished edit — over plain HTTP on
     * localhost, and a wildcard default would let ANY page open in the same
     * browser read all of it. A developer who never sets `origins` must get the
     * safe answer, not the convenient one.
     */
    const root = await makeRoot()
    const store = new FsOverlayStore({root, now: makeClock()})
    const api = await createOverlayApi({store, overlayId: OVERLAY_ID, now: makeClock()})

    const response = await api.handle(
      new Request('https://example.test/api/sanity-overlay/health', {
        method: 'GET',
        headers: {origin: 'https://anywhere.example'},
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()

    await api.close()
  })

  it('grants the Studio dev origin by default when started as a dev server', async () => {
    /* The local mounting exists for exactly one client, so its default names
     * that client rather than making the developer discover the setting. */
    const server = await startOverlayApiServer({
      root: await makeRoot(),
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
    })
    running.push(server)

    const granted = await fetch(`${server.url}/health`, {headers: {origin: STUDIO_ORIGIN}})
    expect(granted.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)

    const refused = await fetch(`${server.url}/health`, {headers: {origin: 'http://evil.example'}})
    expect(refused.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('404s an unknown route instead of falling through to a handler', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await get(server, '/promote')
    expect(status).toBe(404)
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('rejects a body that is not JSON', async () => {
    const server = await boot(await makeRoot())
    const response = await fetch(`${server.url}/commit`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: '{not json',
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_JSON')
  })
})

/* ------------------------------------------------------------------ *
 * The App Router mounting — PRD §10.1
 * ------------------------------------------------------------------ */

describe('createOverlayApi().handle is mountable from a route.ts', () => {
  it('serves the same routes under an App Router path prefix', async () => {
    const root = await makeRoot()
    const store = new FsOverlayStore({root, now: makeClock()})
    const api = await createOverlayApi({store, overlayId: OVERLAY_ID, now: makeClock()})

    /* Exactly what `app/api/sanity-overlay/state/route.ts` would hand it. */
    const state = await api.handle(
      new Request('https://example.test/api/sanity-overlay/state', {method: 'GET'}),
    )
    expect(state.status).toBe(200)
    expect((await state.json()).overlayId).toBe(OVERLAY_ID)

    const plan = await api.handle(
      new Request('https://example.test/api/sanity-overlay/query/plan', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({queryId: 'article-by-id', params: {id: 'article-1'}}),
      }),
    )
    expect(plan.status).toBe(200)
    expect((await plan.json()).queryId).toBe('article-by-id')

    await api.close()
  })

  it('does not turn an arbitrary path into a route', async () => {
    const root = await makeRoot()
    const store = new FsOverlayStore({root, now: makeClock()})
    const api = await createOverlayApi({store, overlayId: OVERLAY_ID, now: makeClock()})

    /* `state` is a known route NAME; `/state/anything` is not that route, and a
     * suffix match that accepted it would also accept `/commit/../state`. */
    const response = await api.handle(
      new Request('https://example.test/api/sanity-overlay/state/extra', {method: 'GET'}),
    )
    expect(response.status).toBe(404)

    await api.close()
  })
})
