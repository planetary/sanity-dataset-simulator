/**
 * `createHttpBaseSource` — the hosted base dataset adapter.
 *
 * This is the adapter the README points at when someone swaps the committed
 * NDJSON snapshot for their real dataset, so two claims made in that README are
 * under test here and not left as assertions in prose:
 *
 *   1. **It only ever reads.** Every request is a GET. There is no code path in
 *      the adapter that issues anything else, and the recorded method of every
 *      request the suite provokes is checked.
 *   2. **It never builds query text out of call input** (PRD §22.5, §5.5).
 *      Values travel as `$`-parameters. The one place a plan contributes to the
 *      query text — the field path of a `field-equality` request — is
 *      registry-controlled and is additionally re-validated, which is asserted
 *      with a hostile path.
 *
 * The oracle is an independent `node:http` stub that records what it received;
 * nothing here asserts on a value the adapter computed and handed back.
 *
 * DISCLOSURE (CLAUDE.md verification rule): this adapter was written before its
 * tests, contrary to the red-first rule. Rather than let "the tests pass" stand
 * as evidence, every assertion group below was mutation-checked against a
 * deliberately broken adapter and confirmed to go red.
 */
import {createServer, type IncomingMessage, type Server} from 'node:http'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {createHttpBaseSource} from '../../sanity-overlay-client/src/index'

interface RecordedRequest {
  method: string
  path: string
  query: string | null
  params: Record<string, string>
  authorization: string | undefined
}

let server: Server
let origin: string
let recorded: RecordedRequest[] = []
/** What the stub answers with; a test sets it before calling. */
let reply: {status: number; body: unknown} = {status: 200, body: {result: []}}

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.invalid')
    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (key !== 'query') params[key] = value
    }
    recorded.push({
      method: request.method ?? '',
      path: url.pathname,
      query: url.searchParams.get('query'),
      params,
      authorization: request.headers.authorization,
    })
    response.writeHead(reply.status, {'content-type': 'application/json'})
    response.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  origin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

function source(options: {token?: string; perspective?: 'published' | 'drafts'} = {}) {
  recorded = []
  return createHttpBaseSource({
    projectId: 'proj',
    dataset: 'staging',
    apiVersion: '2025-02-19',
    baseUrl: origin,
    ...options,
  })
}

const ARTICLE = {_id: 'article-01', _type: 'article', title: 'From the API'}

describe('createHttpBaseSource', () => {
  it('resolves an ids request as a parameterised GET', async () => {
    reply = {status: 200, body: {result: [ARTICLE]}}
    const base = source()

    const documents = await base.fetchCandidates({kind: 'ids', ids: ['article-01', 'article-02']})

    expect(documents).toEqual([ARTICLE])
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      method: 'GET',
      path: '/v2025-02-19/data/query/staging',
      query: '*[_id in $ids]',
    })
    expect(JSON.parse(recorded[0]?.params.$ids as string)).toEqual(['article-01', 'article-02'])
  })

  it('does not call the API at all for an empty id set', async () => {
    const base = source()

    await expect(base.fetchCandidates({kind: 'ids', ids: []})).resolves.toEqual([])

    expect(recorded).toHaveLength(0)
  })

  it('resolves a types request', async () => {
    reply = {status: 200, body: {result: [ARTICLE]}}
    const base = source()

    await base.fetchCandidates({kind: 'types', types: ['article', 'page']})

    expect(recorded[0]?.query).toBe('*[_type in $types]')
    expect(JSON.parse(recorded[0]?.params.$types as string)).toEqual(['article', 'page'])
  })

  it('resolves a field-equality request with the value as a parameter', async () => {
    reply = {status: 200, body: {result: [ARTICLE]}}
    const base = source()

    await base.fetchCandidates({
      kind: 'field-equality',
      types: ['article'],
      path: ['slug', 'current'],
      value: 'article-1',
    })

    expect(recorded[0]?.query).toBe('*[_type in $types && slug.current == $value]')
    /* The value is a parameter, never spliced into the query text. */
    expect(recorded[0]?.query).not.toContain('article-1')
    expect(JSON.parse(recorded[0]?.params.$value as string)).toBe('article-1')
  })

  it('refuses a candidate-plan path that is not a plain field name', async () => {
    const base = source()

    await expect(
      base.fetchCandidates({
        kind: 'field-equality',
        types: ['article'],
        path: ['slug', 'current == "x" || true'],
        value: 'x',
      }),
    ).rejects.toThrow(/not a plain field name/)

    expect(recorded).toHaveLength(0)
  })

  it('passes the whole query through for mode: off', async () => {
    reply = {status: 200, body: {result: {title: 'From the API'}}}
    const base = source()

    const result = await base.query?.('*[_id == $id][0]{title}', {id: 'article-01'})

    expect(result).toEqual({title: 'From the API'})
    expect(recorded[0]?.query).toBe('*[_id == $id][0]{title}')
    expect(JSON.parse(recorded[0]?.params.$id as string)).toBe('article-01')
  })

  it('sends a bearer token and a perspective when configured', async () => {
    reply = {status: 200, body: {result: []}}
    const base = source({token: 'sk-test', perspective: 'published'})

    await base.fetchCandidates({kind: 'types', types: ['article']})

    expect(recorded[0]?.authorization).toBe('Bearer sk-test')
    expect(recorded[0]?.params.perspective).toBe('published')
  })

  it('omits the authorization header when no token is configured', async () => {
    reply = {status: 200, body: {result: []}}
    const base = source()

    await base.fetchCandidates({kind: 'types', types: ['article']})

    expect(recorded[0]?.authorization).toBeUndefined()
  })

  it('raises on a non-ok response instead of returning an empty result', async () => {
    reply = {status: 403, body: {error: 'nope'}}
    const base = source()

    await expect(base.fetchCandidates({kind: 'types', types: ['article']})).rejects.toThrow(/403/)
  })

  it('never issues anything but GET', async () => {
    reply = {status: 200, body: {result: []}}
    const base = source()

    await base.fetchCandidates({kind: 'ids', ids: ['article-01']})
    await base.fetchCandidates({kind: 'types', types: ['article']})
    await base.fetchCandidates({
      kind: 'field-equality',
      types: ['article'],
      path: ['slug', 'current'],
      value: 'x',
    })
    await base.query?.('*[_id == $id][0]', {id: 'article-01'})

    expect(recorded).toHaveLength(4)
    expect([...new Set(recorded.map((r) => r.method))]).toEqual(['GET'])
  })
})
