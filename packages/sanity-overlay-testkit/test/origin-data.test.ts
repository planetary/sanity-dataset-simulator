/**
 * MODE 2 (origin) — the data plane, with an EMPTY BASE.
 *
 * This is the case the rest of the project has never had to face. Mode 1 always
 * has a live staging dataset behind it (PRD §0.2), so every read has something
 * to fall back to and `origin: 'base'` records are the common case. In Mode 2
 * there is no base at all: `EMPTY_BASE_SOURCE` for every lookup, every record
 * `origin: 'branch'`, every document branch-created (PRD §17.2 precedence rule
 * 2). An empty base is where bad assumptions about "there is always something
 * upstream" surface, so the suite drives that path deliberately:
 *
 *   - create a document through the wire API Studio actually uses, with nothing
 *     upstream, and read it back through the wire API Studio actually uses;
 *   - query it with GROQ and get overlay content;
 *   - survive a restart, because the overlay is on disk and the process is not;
 *   - patch, publish, delete — and see the perspective rules hold with no base
 *     version to fall back to.
 *
 * Reads and writes go over HTTP through the real proxy, not through the handler
 * object, because the thing under test is "Studio can do this", and Studio only
 * has HTTP.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>}

async function boot(): Promise<void> {
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-data-test',
  })
  server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: path.join(root, 'log.jsonl'),
    env: {},
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
}

async function stop(): Promise<void> {
  /* Handler first: it owns the SSE streams and upgraded sockets, and
   * `server.close()` waits for every open connection. */
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-data-'))
  await boot()
})

afterAll(async () => {
  await stop()
  fs.rmSync(root, {recursive: true, force: true})
})

/* ------------------------------------------------------------------ *
 * the wire API, as @sanity/client speaks it
 * ------------------------------------------------------------------ */

async function post(target: string, body: unknown): Promise<{status: number; json: any}> {
  const response = await fetch(`${baseUrl}${target}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {status: response.status, json: text === '' ? null : JSON.parse(text)}
}

async function get(target: string): Promise<{status: number; json: any}> {
  const response = await fetch(`${baseUrl}${target}`)
  const text = await response.text()
  return {status: response.status, json: text === '' ? null : JSON.parse(text)}
}

const mutate = (mutations: unknown[]) => post(`${V}/data/mutate/${DATASET}`, {mutations})
const doc = (ids: string) => get(`${V}/data/doc/${DATASET}/${ids}`)
const query = (groq: string, params: Record<string, unknown> = {}) => {
  const search = new URLSearchParams({query: groq})
  for (const [key, value] of Object.entries(params)) search.set(`$${key}`, JSON.stringify(value))
  return get(`${V}/data/query/${DATASET}?${search.toString()}`)
}

/* ================================================================== *
 * 1. an empty overlay is empty — and says so rather than erroring
 * ================================================================== */

describe('Mode 2 · an empty base', () => {
  it('starts with no documents at all', async () => {
    const answer = await query('*')
    expect(answer.status).toBe(200)
    expect(answer.json.result).toEqual([])
  })

  it('reports a document that has never existed as omitted, not as an error', async () => {
    const answer = await doc('drafts.nothing-here')
    expect(answer.status).toBe(200)
    expect(answer.json.documents).toEqual([])
  })

  it('counts nothing without dividing by zero anywhere', async () => {
    const answer = await query('count(*[_type == "article"])')
    expect(answer.status).toBe(200)
    expect(answer.json.result).toBe(0)
  })
})

/* ================================================================== *
 * 2. branch-create with no base, then read it back
 * ================================================================== */

describe('Mode 2 · a document created with no base', () => {
  it('accepts a create over POST /data/mutate', async () => {
    const answer = await mutate([
      {
        create: {
          _id: 'drafts.article-01',
          _type: 'article',
          title: 'Written with no Sanity project',
        },
      },
    ])
    expect(answer.status).toBe(200)
    expect(typeof answer.json.transactionId).toBe('string')
    expect(answer.json.results).toEqual([
      {id: 'drafts.article-01', operation: 'create'},
    ])
  })

  it('reads it back through GET /data/doc', async () => {
    const answer = await doc('drafts.article-01')
    expect(answer.status).toBe(200)
    expect(answer.json.documents).toHaveLength(1)
    const document = answer.json.documents[0]
    expect(document._id).toBe('drafts.article-01')
    expect(document._type).toBe('article')
    expect(document.title).toBe('Written with no Sanity project')
    /* PRD §13.9: the overlay stamps a synthetic revision. Studio needs *a*
     * `_rev` for its optimistic-concurrency bookkeeping; what it must never get
     * is a Content Lake revision the overlay invented. */
    expect(typeof document._rev).toBe('string')
    expect(document._rev.length).toBeGreaterThan(0)
  })

  it('reads it back through a comma-separated multi-id fetch, the shape Studio uses', async () => {
    /* `GET /data/doc/<ds>/article-01,drafts.article-01` x7 in proxy-log.jsonl —
     * Studio asks for the published and draft form of a pane's document in one
     * request, and expects the missing one to be simply absent. */
    const answer = await doc('article-01,drafts.article-01')
    expect(answer.status).toBe(200)
    const ids = answer.json.documents.map((d: {_id: string}) => d._id)
    expect(ids).toEqual(['drafts.article-01'])
    /* The published form has never existed — no base, and no branch publish
     * yet. Content Lake reports that in `omitted` with reason `existence`, and
     * Studio branches on that vocabulary, so the origin speaks it too. */
    expect(answer.json.omitted).toEqual([
      {id: 'article-01', reason: 'existence', overlayAbsence: expect.anything()},
    ])
  })

  it('returns it from a GROQ query — the overlay IS the dataset', async () => {
    const answer = await query('*[_type == "article"]{_id, title}')
    expect(answer.status).toBe(200)
    expect(answer.json.result).toEqual([
      {_id: 'drafts.article-01', title: 'Written with no Sanity project'},
    ])
    expect(typeof answer.json.ms).toBe('number')
    expect(answer.json.query).toBe('*[_type == "article"]{_id, title}')
  })

  it('supports parameters, so Studio\'s $ids-style queries work', async () => {
    const answer = await query('*[_id in $ids][].title', {ids: ['drafts.article-01']})
    expect(answer.status).toBe(200)
    expect(answer.json.result).toEqual(['Written with no Sanity project'])
  })

  it('accepts the POST long-query fallback with the same answer', async () => {
    const answer = await post(`${V}/data/query/${DATASET}`, {
      query: '*[_type == "article"]{title}',
      params: {},
    })
    expect(answer.status).toBe(200)
    expect(answer.json.result).toEqual([{title: 'Written with no Sanity project'}])
  })
})

/* ================================================================== *
 * 3. patching, with nothing upstream to merge against
 * ================================================================== */

describe('Mode 2 · patching a branch-created document', () => {
  it('applies set and setIfMissing', async () => {
    const answer = await mutate([
      {
        patch: {
          id: 'drafts.article-01',
          set: {title: 'Retitled locally'},
          setIfMissing: {slug: {_type: 'slug', current: 'retitled-locally'}},
        },
      },
    ])
    expect(answer.status).toBe(200)

    const after = await doc('drafts.article-01')
    expect(after.json.documents[0].title).toBe('Retitled locally')
    expect(after.json.documents[0].slug.current).toBe('retitled-locally')
  })

  it('applies unset', async () => {
    await mutate([{patch: {id: 'drafts.article-01', unset: ['slug']}}])
    const after = await doc('drafts.article-01')
    expect(after.json.documents[0].slug).toBeUndefined()
    expect(after.json.documents[0].title).toBe('Retitled locally')
  })

  it('applies a nested path', async () => {
    await mutate([
      {patch: {id: 'drafts.article-01', set: {'meta.seoTitle': 'SEO'}}},
    ])
    const after = await doc('drafts.article-01')
    expect(after.json.documents[0].meta).toEqual({seoTitle: 'SEO'})
  })

  it('applies inc and dec', async () => {
    await mutate([{patch: {id: 'drafts.article-01', setIfMissing: {views: 10}}}])
    await mutate([{patch: {id: 'drafts.article-01', inc: {views: 5}}}])
    await mutate([{patch: {id: 'drafts.article-01', dec: {views: 2}}}])
    const after = await doc('drafts.article-01')
    expect(after.json.documents[0].views).toBe(13)
  })

  it('refuses a mutation shape it does not implement instead of dropping it silently', async () => {
    const answer = await mutate([{patch: {id: 'drafts.article-01', ifRevisionID: 'nope', set: {}}, thisIsNot: 'a mutation'}])
    expect(answer.status).toBe(400)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_UNSUPPORTED_MUTATION')
    /* The name of the thing it could not do, so the failure is actionable. */
    expect(JSON.stringify(answer.json)).toContain('thisIsNot')
  })

  it('refuses a patch aimed at a document that does not exist', async () => {
    const answer = await mutate([{patch: {id: 'drafts.never-created', set: {title: 'x'}}}])
    expect(answer.status).toBe(409)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_MUTATION_FAILED')
  })
})

/* ================================================================== *
 * 4. the Actions API — the path Studio 4 actually writes through
 * ================================================================== */

describe('Mode 2 · the Actions API with no base', () => {
  it('publishes a branch-created draft into a branch-created published document', async () => {
    const answer = await post(`${V}/data/actions/${DATASET}`, {
      actions: [
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-01',
          publishedId: 'article-01',
        },
      ],
    })
    expect(answer.status).toBe(200)
    expect(typeof answer.json.transactionId).toBe('string')

    const published = await doc('article-01')
    expect(published.json.documents).toHaveLength(1)
    expect(published.json.documents[0]._id).toBe('article-01')
    expect(published.json.documents[0].title).toBe('Retitled locally')

    /* PRD §18.5: the local draft is removed after a branch publish. With no
     * base draft to fall back to, `drafts.article-01` must now resolve to
     * nothing — not to the published document wearing a drafts id. */
    const draft = await doc('drafts.article-01')
    expect(draft.json.documents).toEqual([])
  })

  it('creates through the Actions API', async () => {
    const answer = await post(`${V}/data/actions/${DATASET}`, {
      actions: [
        {
          actionType: 'sanity.action.document.create',
          publishedId: 'article-02',
          attributes: {_id: 'drafts.article-02', _type: 'article', title: 'Second'},
        },
      ],
    })
    expect(answer.status).toBe(200)
    const created = await doc('drafts.article-02')
    expect(created.json.documents[0].title).toBe('Second')
  })

  it('discards a draft', async () => {
    await post(`${V}/data/actions/${DATASET}`, {
      actions: [{actionType: 'sanity.action.document.discard', draftId: 'drafts.article-02'}],
    })
    const after = await doc('drafts.article-02')
    expect(after.json.documents).toEqual([])
  })

  it('deletes a document', async () => {
    await post(`${V}/data/actions/${DATASET}`, {
      actions: [
        {actionType: 'sanity.action.document.delete', publishedId: 'article-01', includeDrafts: []},
      ],
    })
    const after = await doc('article-01,drafts.article-01')
    expect(after.json.documents).toEqual([])
    const remaining = await query('*[_type == "article"]')
    expect(remaining.json.result).toEqual([])
  })

  it('refuses an action type it does not implement instead of pretending', async () => {
    const answer = await post(`${V}/data/actions/${DATASET}`, {
      actions: [{actionType: 'sanity.action.document.version.create', publishedId: 'article-09'}],
    })
    expect(answer.status).toBe(400)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_UNSUPPORTED_ACTION')
    expect(JSON.stringify(answer.json)).toContain('sanity.action.document.version.create')
  })
})

/* ================================================================== *
 * 5. it is really on disk
 * ================================================================== */

describe('Mode 2 · durability with no upstream', () => {
  it('writes the §14.1 canonical overlay layout under the root', async () => {
    await mutate([
      {create: {_id: 'drafts.durable-01', _type: 'article', title: 'Survives a restart'}},
    ])
    expect(fs.existsSync(path.join(root, '.sanity-overlay'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.sanity-overlay', 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.sanity-overlay', 'documents', 'durable-01'))).toBe(true)
  })

  it('still serves the document after a full restart — nothing lives only in memory', async () => {
    await stop()
    await boot()
    const answer = await doc('drafts.durable-01')
    expect(answer.status).toBe(200)
    expect(answer.json.documents[0].title).toBe('Survives a restart')

    const queried = await query('*[_id == "drafts.durable-01"].title')
    expect(queried.json.result).toEqual(['Survives a restart'])
  })
})

/* ================================================================== *
 * 6. the listen channel
 * ================================================================== */

describe('Mode 2 · the listen stream', () => {
  it('opens an SSE stream and sends a welcome event, which is what unblocks a pane', async () => {
    const controller = new AbortController()
    const response = await fetch(
      `${baseUrl}${V}/data/listen/${DATASET}?query=${encodeURIComponent('*[_id == "drafts.durable-01"]')}&includeResult=true`,
      {signal: controller.signal},
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 5000
    while (!buffer.includes('event: welcome') && Date.now() < deadline) {
      const {value, done} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
    }
    expect(buffer).toContain('event: welcome')
    controller.abort()
    await reader.cancel().catch(() => {})
  })

  it('emits a mutation event when the overlay changes', async () => {
    const controller = new AbortController()
    const response = await fetch(
      `${baseUrl}${V}/data/listen/${DATASET}?query=${encodeURIComponent('*')}&includeResult=false`,
      {signal: controller.signal},
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    /* Drain the welcome first so the listener is definitely registered. */
    const deadline = Date.now() + 5000
    while (!buffer.includes('event: welcome') && Date.now() < deadline) {
      const {value, done} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
    }

    await mutate([{create: {_id: 'drafts.listened-01', _type: 'article', title: 'Live'}}])

    while (!buffer.includes('event: mutation') && Date.now() < deadline) {
      const {value, done} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
    }
    expect(buffer).toContain('event: mutation')
    expect(buffer).toContain('drafts.listened-01')
    controller.abort()
    await reader.cancel().catch(() => {})
  })
})

/* ================================================================== *
 * 7. errors are structured, never approximate
 * ================================================================== */

describe('Mode 2 · query errors', () => {
  it('reports a GROQ parse error rather than an empty result', async () => {
    const answer = await query('*[_type == ')
    expect(answer.status).toBe(400)
    expect(answer.json.error.description).toMatch(/groq|parse|syntax/i)
  })

  it('requires a query parameter', async () => {
    const answer = await get(`${V}/data/query/${DATASET}`)
    expect(answer.status).toBe(400)
  })

  it('refuses a dataset it does not serve rather than answering for the wrong one', async () => {
    const answer = await get(`${V}/data/query/scratch?query=*`)
    expect(answer.status).toBe(404)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_UNKNOWN_DATASET')
  })
})
