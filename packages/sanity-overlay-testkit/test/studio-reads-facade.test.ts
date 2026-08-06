/**
 * `sanity-overlay-studio` — the READ path as a Studio actually reaches it
 * (PRD §22.5 registration policy, §22.6 candidate planning, §5.5 no silent
 * approximation, §11.3 nothing unsupported reaches staging silently).
 *
 * THE HOLE THIS CLOSES. `studio-reads-overlay.test.ts` pins the two modules that
 * can answer a GROQ query over a branch. Nothing called them. `client.fetch` —
 * the method every list pane, every search box and every custom structure
 * resolver in a Studio goes through — was handled by the facade's default arm
 * and delegated whole to the Content Lake. A document renamed in the branch
 * therefore rendered its STAGING title everywhere except the one open document
 * pane, which looked right only because the listener echo replayed the mutation
 * into it.
 *
 * So the assertions here are about what a Studio-shaped caller RECEIVES from
 * `client.fetch` and `client.observable.fetch`, never about an internal:
 *
 *   §1  a renamed document answers with the branch title; a branch-created one
 *       appears; a tombstoned one does not — with staging as the negative
 *       control in each case.
 *   §2  the query that leaves for staging is the CANDIDATE request, not the
 *       caller's GROQ, and it is bounded.
 *   §3  GROQ with no provable candidate plan is passed through to staging AND
 *       recorded with a readable reason (§22.5 "[MUST] log unregistered
 *       queries"). Silence is the failure mode this pins.
 *   §4  strict mode refuses instead of approximating — and does not refuse a
 *       read that an empty branch cannot have changed.
 *   §5  a facade built without a reader delegates byte for byte, as before.
 *   §6  the runtime wires it end to end from the overlay API's own `/state`.
 *
 * The only doubles are the CLIENT (standing in for the Content Lake) and the
 * transport. The plan derivation, the candidate assembly and the evaluation are
 * the real `sanity-overlay-query`.
 */
import {describe, expect, it} from 'vitest'

import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {
  createStudioReader,
  type StudioReadRecord,
} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {
  OverlayHydrationDocument,
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'
import type {OverlaySource} from '../../sanity-overlay-query/src/overlaySource'

type Rec = Record<string, unknown>

/* ──────────────────────────────────────────────────────────── fixtures */

/** Staging, as the Content Lake holds it. */
const STAGING: Rec[] = [
  {_id: 'article-1', _type: 'article', title: 'published one', _rev: 'base-1'},
  {_id: 'drafts.article-1', _type: 'article', title: 'staging one', _rev: 'base-2'},
  {_id: 'drafts.article-2', _type: 'article', title: 'staging two', _rev: 'base-3'},
  {_id: 'author-1', _type: 'author', name: 'staging author', _rev: 'base-4'},
]

/**
 * The branch, in the hydration shape `POST /state` and `POST /commit` answer
 * with. Renamed draft, deleted draft, invented draft.
 */
const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-1',
    schemaType: 'article',
    draft: {_id: 'drafts.article-1', _type: 'article', title: 'branch one'},
    published: null,
  },
  {logicalId: 'article-2', schemaType: 'article', draftTombstone: true},
  {
    logicalId: 'article-9',
    schemaType: 'article',
    draft: {_id: 'drafts.article-9', _type: 'article', title: 'branch nine'},
  },
]

const LIST_QUERY = '*[_type == "article"]{_id, title}'
/** No bounded candidate plan: an unconstrained `*` over the whole dataset. */
const UNPLANNABLE = 'count(*)'

/* ─────────────────────────────────────────────────────── test doubles */

interface StagingClient extends Rec {
  /** Every GROQ that actually left for staging, in order. */
  readonly issued: {query: string; params: Rec}[]
}

/**
 * A Content-Lake-shaped double that evaluates GROQ over {@link STAGING} with the
 * same pinned `groq-js` the hosted dataset would use.
 *
 * `fetch` is an own property, not a prototype method, deliberately: the facade
 * must never *call* a double it has not proven to be a real `@sanity/client`,
 * and this keeps the observable-constructor probe away from it.
 */
async function evaluateOverStaging(query: string, params: Rec): Promise<unknown> {
  const {parse, evaluate} = await import('groq-js')
  const value = await evaluate(parse(query), {dataset: STAGING, params})
  return await value.get()
}

function stagingClient(): StagingClient {
  const issued: {query: string; params: Rec}[] = []
  const client: StagingClient = {
    issued,
    fetch: (query: string, params: Rec = {}): Promise<unknown> => {
      issued.push({query, params})
      return evaluateOverStaging(query, params)
    },
  }
  /* The observable sibling, built from the same recorded fetch. */
  client.observable = {
    fetch: (query: string, params: Rec = {}): unknown => {
      const promise = (client.fetch as (q: string, p: Rec) => Promise<unknown>)(query, params)
      return {
        subscribe(observer: Rec | ((value: unknown) => void)) {
          const target = typeof observer === 'function' ? {next: observer} : observer
          let closed = false
          void promise.then(
            (value) => {
              if (closed) return
              ;(target.next as ((v: unknown) => void) | undefined)?.(value)
              ;(target.complete as (() => void) | undefined)?.()
            },
            (error) => {
              if (!closed) (target.error as ((e: unknown) => void) | undefined)?.(error)
            },
          )
          return {
            unsubscribe: (): void => {
              closed = true
            },
          }
        },
      }
    },
  }
  return client
}

function inertTransport(answer: Partial<OverlayTransportResult> = {}): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok'}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok', ...answer}),
  }
}

interface Rig {
  client: StagingClient
  wrapped: Rec
  records: StudioReadRecord[]
  errors: string[]
}

function rig(
  options: {branch?: OverlayHydrationDocument[]; strict?: boolean} = {},
): Rig {
  const client = stagingClient()
  const records: StudioReadRecord[] = []
  const errors: string[] = []
  const overlay: OverlaySource = overlaySourceFromBranch(options.branch ?? BRANCH)
  const wrapped = wrapWithOverlay(client, {
    echo: createOverlayEcho({onError: (message) => errors.push(message)}),
    transport: inertTransport(),
    onError: (message) => errors.push(message),
    reads: createStudioReader({
      overlay: () => overlay,
      strict: () => options.strict === true,
      onRecord: (record) => records.push(record),
      onLog: (message) => errors.push(message),
    }),
  }) as unknown as Rec

  return {client, wrapped, records, errors}
}

const fetchOf = (rigged: Rig) => rigged.wrapped.fetch as (q: string, p?: Rec, o?: Rec) => Promise<unknown>

function drain(observable: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ;(observable as {subscribe: (o: Rec) => unknown}).subscribe({
      next: resolve,
      error: reject,
    })
  })
}

/* ══════════════════════════════════════════════════════════════════ §1 */

describe('§1 client.fetch answers from the branch, not from staging', () => {
  it('renders the BRANCH title for a document the branch renamed', async () => {
    const rigged = rig()
    const rows = (await fetchOf(rigged)(LIST_QUERY)) as Rec[]
    expect(rows.find((row) => row._id === 'drafts.article-1')).toEqual({
      _id: 'drafts.article-1',
      title: 'branch one',
    })
    /* The negative control: staging really does say something else. */
    expect(STAGING.find((doc) => doc._id === 'drafts.article-1')?.title).toBe('staging one')
  })

  it('includes a branch-created document staging has never held', async () => {
    const rows = (await fetchOf(rig())(LIST_QUERY)) as Rec[]
    expect(rows.find((row) => row._id === 'drafts.article-9')).toEqual({
      _id: 'drafts.article-9',
      title: 'branch nine',
    })
    expect(STAGING.map((doc) => doc._id)).not.toContain('drafts.article-9')
  })

  it('drops a document the branch tombstoned, though staging still holds it', async () => {
    const rows = (await fetchOf(rig())(LIST_QUERY)) as Rec[]
    expect(rows.map((row) => row._id)).not.toContain('drafts.article-2')
    expect(STAGING.map((doc) => doc._id)).toContain('drafts.article-2')
  })

  it('answers the whole list, written out by hand', async () => {
    const rows = await fetchOf(rig())(LIST_QUERY)
    expect(rows).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('answers an `_id in $ids` read — the shape Studio issues most', async () => {
    const rows = await fetchOf(rig())('*[_id in $ids]{_id, title}', {
      ids: ['drafts.article-1', 'drafts.article-2'],
    })
    expect(rows).toEqual([{_id: 'drafts.article-1', title: 'branch one'}])
  })

  it('answers `observable.fetch` from the branch too', async () => {
    const rigged = rig()
    const observable = ((rigged.wrapped.observable as Rec).fetch as (q: string) => unknown)(
      LIST_QUERY,
    )
    expect(await drain(observable)).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('leaves a type the branch never touched exactly as staging has it', async () => {
    expect(await fetchOf(rig())('*[_type == "author"]{name}')).toEqual([
      {name: 'staging author'},
    ])
  })

  it('records the read as answered by the overlay, with its candidate count', async () => {
    const rigged = rig()
    await fetchOf(rigged)(LIST_QUERY)
    expect(rigged.records).toEqual([
      expect.objectContaining({outcome: 'overlay', query: LIST_QUERY, candidateCount: 3}),
    ])
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 */

describe('§2 what leaves for staging is the candidate request', () => {
  it('does not send the caller’s GROQ to staging when it can answer locally', async () => {
    const rigged = rig()
    await fetchOf(rigged)(LIST_QUERY)
    expect(rigged.client.issued.map((call) => call.query)).not.toContain(LIST_QUERY)
    expect(rigged.client.issued).toHaveLength(1)
  })

  it('asks staging for the candidate TYPE, bounded by the plan’s ceiling', async () => {
    const rigged = rig()
    await fetchOf(rigged)(LIST_QUERY)
    const [call] = rigged.client.issued
    expect(call.params).toEqual({__overlayTypes: ['article']})
    /* Bounded: PRD §22.9 forbids an unbounded transfer, so the base fetch
     * carries the plan's ceiling as a literal slice rather than trusting the
     * dataset to be small. */
    expect(call.query).toMatch(/\[0\.\.\.\d+\]$/)
    expect(call.query.startsWith('*[_type in $__overlayTypes]')).toBe(true)
  })

  it('asks staging for exactly the named ids on an id read', async () => {
    const rigged = rig()
    await fetchOf(rigged)('*[_id == $id][0]{title}', {id: 'drafts.article-1'})
    expect(rigged.client.issued[0]?.params).toEqual({
      __overlayIds: ['drafts.article-1'],
    })
  })

  it('answers a branch-created id staging cannot return at all', async () => {
    expect(await fetchOf(rig())('*[_id == $id][0]{title}', {id: 'drafts.article-9'})).toEqual({
      title: 'branch nine',
    })
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 */

describe('§3 an unplannable read is passed through AND recorded', () => {
  it('answers with staging’s own result', async () => {
    /* `count(*)` reaches an unconstrained `*`. Staging holds four documents. */
    expect(await fetchOf(rig())(UNPLANNABLE)).toBe(4)
  })

  it('sends the caller’s own query to staging, unaltered', async () => {
    const rigged = rig()
    await fetchOf(rigged)(UNPLANNABLE)
    expect(rigged.client.issued.map((call) => call.query)).toEqual([UNPLANNABLE])
  })

  it('records the passthrough with a reason a human can act on', async () => {
    const rigged = rig()
    await fetchOf(rigged)(UNPLANNABLE)
    expect(rigged.records).toHaveLength(1)
    const [record] = rigged.records
    expect(record.outcome).toBe('passthrough')
    expect(record.query).toBe(UNPLANNABLE)
    expect(record.reason).toMatch(/unconstrained/)
  })

  it('logs it as well as recording it — §22.5 "[MUST] log unregistered queries"', async () => {
    const rigged = rig()
    await fetchOf(rigged)(UNPLANNABLE)
    expect(rigged.errors.some((message) => message.includes(UNPLANNABLE))).toBe(true)
  })

  it('logs a repeated query once, so the surface stays readable', async () => {
    const rigged = rig()
    await fetchOf(rigged)(UNPLANNABLE)
    await fetchOf(rigged)(UNPLANNABLE)
    await fetchOf(rigged)(UNPLANNABLE)
    /* Recorded every time — the ledger is a count. Logged once. */
    expect(rigged.records).toHaveLength(3)
    expect(rigged.errors.filter((message) => message.includes(UNPLANNABLE))).toHaveLength(1)
  })

  it('passes through a perspective the raw overlay cannot answer, and says so', async () => {
    const rigged = rig()
    const rows = await fetchOf(rigged)(LIST_QUERY, {}, {perspective: 'published'})
    expect(rows).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'staging one'},
      {_id: 'drafts.article-2', title: 'staging two'},
    ])
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/perspective/)
  })

  it('passes through when the caller asked for a result source map', async () => {
    const rigged = rig()
    await fetchOf(rigged)(LIST_QUERY, {}, {resultSourceMap: true})
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.client.issued.map((call) => call.query)).toEqual([LIST_QUERY])
  })
})

/* ══════════════════════════════════════════════════════════════ §3b */

describe('§3b the envelope `filterResponse: false` asks for', () => {
  /*
   * `client.fetch(q, p, {filterResponse: false})` does not answer with the
   * result — it answers with `{query, ms, result}`. A caller that asked for the
   * envelope and got a bare array reads `undefined` for every field, so the
   * overlay must reproduce the shape it replaced rather than the shape it
   * happens to compute.
   */
  it('wraps an overlay answer in the same envelope', async () => {
    const rigged = rig()
    const envelope = (await fetchOf(rigged)(LIST_QUERY, {}, {filterResponse: false})) as Rec
    expect(envelope.query).toBe(LIST_QUERY)
    expect(typeof envelope.ms).toBe('number')
    expect(envelope.result).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('omits the query when the caller asked it to', async () => {
    const rigged = rig()
    const envelope = (await fetchOf(rigged)(LIST_QUERY, {}, {
      filterResponse: false,
      returnQuery: false,
    })) as Rec
    expect('query' in envelope).toBe(false)
    expect((envelope.result as Rec[]).map((row) => row._id)).toEqual([
      'article-1',
      'drafts.article-1',
      'drafts.article-9',
    ])
  })
})

/* ══════════════════════════════════════════════════════════════════ §4 */

describe('§4 strict mode refuses rather than approximating', () => {
  it('rejects an unplannable read while the branch holds state', async () => {
    const rigged = rig({strict: true})
    await expect(fetchOf(rigged)(UNPLANNABLE)).rejects.toThrow(/unconstrained/)
    expect(rigged.records[0]?.outcome).toBe('refused')
  })

  it('never lets a refused read reach staging', async () => {
    const rigged = rig({strict: true})
    await fetchOf(rigged)(UNPLANNABLE).catch(() => undefined)
    expect(rigged.client.issued).toEqual([])
  })

  it('does NOT refuse when the branch is empty, because base is then exact', async () => {
    /* An empty branch cannot have changed any answer, so a passthrough is the
     * exact hosted result rather than an approximation of it — §5.5 bans silent
     * approximation, not correct delegation. */
    const rigged = rig({branch: [], strict: true})
    expect(await fetchOf(rigged)(UNPLANNABLE)).toBe(4)
    expect(rigged.records[0]?.outcome).toBe('passthrough')
  })

  it('still answers a plannable read exactly under strict', async () => {
    const rigged = rig({strict: true})
    expect(await fetchOf(rigged)(LIST_QUERY)).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('refuses an observable read the same way', async () => {
    const rigged = rig({strict: true})
    const observable = ((rigged.wrapped.observable as Rec).fetch as (q: string) => unknown)(
      UNPLANNABLE,
    )
    await expect(drain(observable)).rejects.toThrow(/unconstrained/)
  })
})

/* ══════════════════════════════════════════════════════════════════ §5 */

describe('§5 a facade with no reader is exactly the old facade', () => {
  it('delegates fetch untouched when no reader is configured', async () => {
    const client = stagingClient()
    const wrapped = wrapWithOverlay(client, {
      echo: createOverlayEcho({onError: () => {}}),
      transport: inertTransport(),
    }) as unknown as Rec
    const rows = await (wrapped.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    /* Staging's answer, branch-blind — the pre-wiring behaviour, kept so a
     * consumer that has not opted in cannot be changed by this work. */
    expect(rows).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'staging one'},
      {_id: 'drafts.article-2', title: 'staging two'},
    ])
    expect(client.issued.map((call) => call.query)).toEqual([LIST_QUERY])
  })

  it('keeps `fetch` referentially stable across accesses', () => {
    const rigged = rig()
    const seen = new Set<unknown>()
    for (let index = 0; index < 500; index++) seen.add(rigged.wrapped.fetch)
    expect(seen.size).toBe(1)
  })
})

/* ══════════════════════════════════════════════════════════════════ §6 */

describe('§6 the runtime wires the branch into every client it hands out', () => {
  const resolved = resolveOverlayOptions(
    {mode: 'fs', apiUrl: 'http://localhost:3998', strictQueries: false},
    {},
  )

  it('answers a read from the branch the overlay API reports at /state', async () => {
    const client = stagingClient()
    const runtime = createOverlayRuntime({
      resolved,
      createClient: () => client,
      fetch: (async () =>
        new Response(JSON.stringify({ok: true, revision: 3, documents: BRANCH}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })) as unknown as typeof fetch,
    })
    await runtime.refresh()

    const wrapped = runtime.clientFactory({}) as Rec
    expect(await (wrapped.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('is branch-blind before /state has been read, rather than guessing', async () => {
    const client = stagingClient()
    const runtime = createOverlayRuntime({
      resolved,
      createClient: () => client,
      fetch: (async () => new Response('{}', {status: 200})) as unknown as typeof fetch,
    })
    const wrapped = runtime.clientFactory({}) as Rec
    expect(await (wrapped.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'staging one'},
      {_id: 'drafts.article-2', title: 'staging two'},
    ])
  })

  it('exposes the read ledger so the banner can surface degraded reads', async () => {
    const client = stagingClient()
    const runtime = createOverlayRuntime({
      resolved,
      createClient: () => client,
      fetch: (async () =>
        new Response(JSON.stringify({ok: true, documents: BRANCH}), {status: 200})) as unknown as typeof fetch,
    })
    await runtime.refresh()
    const wrapped = runtime.clientFactory({}) as Rec
    await (wrapped.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    await (wrapped.fetch as (q: string) => Promise<unknown>)(UNPLANNABLE)

    expect(runtime.reads().map((record) => record.outcome)).toEqual(['overlay', 'passthrough'])
  })

  it('does not intercept reads at all in `off` mode', async () => {
    const client = stagingClient()
    const runtime = createOverlayRuntime({
      resolved: resolveOverlayOptions({mode: 'off', apiUrl: 'http://localhost:3998'}, {}),
      createClient: () => client,
      fetch: (async () => new Response('{}', {status: 200})) as unknown as typeof fetch,
    })
    const bare = runtime.clientFactory({}) as Rec
    await (bare.fetch as (q: string) => Promise<unknown>)(LIST_QUERY)
    expect(client.issued.map((call) => call.query)).toEqual([LIST_QUERY])
    expect(runtime.reads()).toEqual([])
  })
})
