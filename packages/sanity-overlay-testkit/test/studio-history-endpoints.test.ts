/**
 * SANITY'S HISTORY MACHINERY, POINTED AT A BRANCH DOCUMENT — the live defect
 * and its whole class.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OBSERVED FAILURE (browser console, overlay Studio, every branch document,
 * three-plus times each):
 *
 *     Error fetching events TypeError: Cannot read properties of undefined
 *       (reading 'drafts.e2e-unicode-multihunk')   at getEditEvents
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT ACTUALLY MAKES `tx.effects` UNDEFINED — and it is NOT the events
 * endpoint.
 *
 * `sanity@6.8.0` reads the transaction log with the GLOBAL `fetch`, as
 * **NDJSON**, one JSON object per line:
 *
 *   lib/useBundleDocuments-BYW8M9LS.js:4812  getTransactionsLogs
 *       getJsonStream(client.getUrl(`/data/history/<ds>/transactions/<ids>?…`))
 *   lib/datastores-DqFH7RLd.js:6868          getJsonStream → getStream
 *       splits the body on "\n", JSON.parses every non-empty line, and enqueues
 *       whatever is left in the buffer at EOF as one more line.
 *   lib/useBundleDocuments-BYW8M9LS.js:4965  getEditEvents
 *       transactions.filter((tx) => getEffectState(tx.effects[documentId]) === …)
 *
 * So a body of `{"transactions":[]}` — a JSON envelope on an NDJSON endpoint —
 * does not decode to "no transactions". It decodes to **exactly one
 * transaction**: the envelope itself. That object has no `effects`, and
 * `tx.effects[documentId]` throws with the document id in the message, which is
 * the reported error verbatim.
 *
 * The empty translog is therefore an **empty body**, not `{"transactions":[]}`
 * and not `[]`. {@link EMPTY_TRANSLOG_NDJSON} is that answer, stated once.
 *
 * The `events/documents/<id>` endpoint, by contrast, cannot throw: sanity reads
 * it as `response.events[documentId]?.map(…) || []` (`:5006`), which tolerates
 * an array. It is still answered in the wrong SHAPE by a base that has never
 * heard of the document — `events` is an object keyed by document id, not an
 * array — and it is the one history read the facade can actually see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLASS: every read the facade DELEGATES whose answer Studio then indexes
 * by a branch document id. Transcribed from `facade.ts`'s own enumeration and
 * checked against the pinned dist:
 *
 *   endpoint                                  indexed by            throws?
 *   ──────────────────────────────────────────────────────────────────────────
 *   /data/history/<ds>/events/documents/<id>  events[documentId]    no  (?.)
 *   /data/history/<ds>/transactions/<ids>     tx.effects[documentId] YES
 *   /data/history/<ds>/documents/<ids>        documents[0]          YES (:5101)
 *   /data/doc/<ds>/<ids>?excludeContent=true  omitted.reduce/filter YES (:5533,
 *                                                                   structureTool
 *                                                                   :744)
 *
 * Two of the four travel on `client.request` / `client.observable.request` and
 * are interceptable. The translog does not — it is a global `fetch` against
 * `client.getUrl(…)` — so its contract is pinned here as an executable spec for
 * whatever serves `apiHost`, and asserted NOT to be claimed by the facade.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS INDEPENDENT. Every assertion below feeds the response the
 * facade produced into a transcription of sanity 6.8.0's own reader, with the
 * dist line noted. Nothing asserts on a value the facade just computed.
 */
import {describe, expect, it} from 'vitest'

import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {
  EMPTY_TRANSLOG_NDJSON,
  classifyOverlayHistoryRead,
} from '../../sanity-overlay-studio/src/client/history'
import type {
  OverlayHydrationDocument,
  OverlayTransport,
} from '../../sanity-overlay-studio/src/client/transport'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'

type Rec = Record<string, unknown>

const DATASET = 'parity'
const BRANCH_DRAFT = 'drafts.e2e-unicode-multihunk'
const BRANCH_PUBLISHED = 'e2e-unicode-multihunk'
const BASE_DRAFT = 'drafts.article-01'

/* ================================================================== *
 * 1. sanity@6.8.0, transcribed. The independent oracle.
 * ================================================================== */

/**
 * `lib/datastores-DqFH7RLd.js:6879` `getStream`, reduced to the single-chunk
 * case: split on "\n", parse every complete non-empty line, then parse whatever
 * is left in the buffer at EOF if it is non-empty.
 */
function readNdjson(body: string): unknown[] {
  const out: unknown[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i].trim()
    if (line.length !== 0) out.push(JSON.parse(line))
  }
  const tail = lines[lines.length - 1].trim()
  if (tail.length !== 0) out.push(JSON.parse(tail))
  return out
}

/** `lib/useBundleDocuments-BYW8M9LS.js:4956` */
function isDeletePatch(patch: unknown): boolean {
  const tuple = patch as unknown[]
  return tuple[0] === 0 && tuple[1] === null
}

/** `lib/useBundleDocuments-BYW8M9LS.js:4952` */
function getEffectState(effect: unknown): string {
  const modified = !!effect
  const deleted = effect && isDeletePatch((effect as Rec | undefined)?.apply)
  const created = effect && isDeletePatch((effect as Rec | undefined)?.revert)
  return deleted ? 'deleted' : created ? 'created' : modified ? 'modified' : 'noop'
}

/**
 * `lib/useBundleDocuments-BYW8M9LS.js:4965`, the filter only — the merge-window
 * folding below it never runs when the filter throws, and the reported stack
 * frame is the filter.
 */
function getEditEvents(transactions: readonly unknown[], documentId: string): unknown[] {
  return transactions.filter(
    (tx) => getEffectState(((tx as Rec).effects as Rec)[documentId]) === 'modified',
  )
}

/** `lib/useBundleDocuments-BYW8M9LS.js:5006` — the events response reader. */
function readEventsResponse(response: unknown, documentId: string): unknown[] {
  const events = (response as Rec).events as Rec
  return (events[documentId] as unknown[] | undefined)?.map((event) => event) || []
}

/** `lib/useBundleDocuments-BYW8M9LS.js:5101` — `getDocumentAtRevision`. */
function readDocumentAtRevision(response: unknown): {document: unknown; revisionId: unknown} {
  const document = ((response as Rec).documents as unknown[])[0]
  return {document, revisionId: (document as Rec | undefined)?._rev}
}

/** `lib/datastores-DqFH7RLd.js:5533` — `createBatchedGetDocumentExists`. */
function readAvailability(availability: unknown, ids: readonly string[]): Rec {
  const omittedIds = ((availability as Rec).omitted as Rec[]).reduce<Rec>((acc, next) => {
    acc[next.id as string] = next.reason
    return acc
  }, {})
  const out: Rec = {}
  for (const id of ids) out[id] = !(omittedIds[id] && omittedIds[id] === 'existence')
  return out
}

/* ================================================================== *
 * 2. the facade under test
 * ================================================================== */

function silentTransport(): OverlayTransport {
  return {
    commit: async () => ({outcome: 'ok', committed: true}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  } as unknown as OverlayTransport
}

interface Harness {
  wrapped: Rec
  /** Every `request()` the facade let through to the base client. */
  delegated: unknown[]
  /** What the base answers. Defaults to the Mode-2 origin's real answer. */
  setBaseAnswer(answer: unknown): void
}

/**
 * @param branch document ADDRESSES the branch holds (`drafts.x` and/or `x`), or
 *   `null` to leave the option off entirely.
 */
function harness(branch: readonly string[] | null): Harness {
  const delegated: unknown[] = []
  /* The body `origin.mjs:1591` really answers `events/documents/<id>` with. */
  let baseAnswer: unknown = {events: []}

  const observableRequest = (request: unknown): unknown => {
    delegated.push(request)
    const value = baseAnswer
    return {
      subscribe(observer: {next: (v: unknown) => void; complete: () => void}) {
        observer.next(value)
        observer.complete()
        return {unsubscribe: () => undefined}
      },
    }
  }

  const client: Rec = {
    fetch: () => Promise.resolve(null),
    getUrl: (uri: string) => `https://b1n03q3z.api.example.test/v2025-02-19${uri}`,
    getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
    config: () => ({projectId: 'b1n03q3z', dataset: DATASET, apiHost: 'https://api.example.test'}),
    withConfig: (): unknown => client,
    request: (request: unknown): unknown => {
      delegated.push(request)
      return Promise.resolve(baseAnswer)
    },
  }
  client.observable = {
    fetch: () => Promise.resolve(null),
    request: observableRequest,
  }

  const wrapped = wrapWithOverlay(client as never, {
    echo: createOverlayEcho(),
    transport: silentTransport(),
    ...(branch === null ? {} : {branchHolds: (id: string) => branch.includes(id)}),
  }) as unknown as Rec

  return {
    wrapped,
    delegated,
    setBaseAnswer: (answer) => {
      baseAnswer = answer
    },
  }
}

function drain(result: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ;(
      result as {
        subscribe: (o: {
          next: (v: unknown) => void
          error: (e: unknown) => void
          complete: () => void
        }) => unknown
      }
    ).subscribe({
      next: (value) => resolve(value),
      error: (error) => reject(error as Error),
      complete: () => resolve(undefined),
    })
  })
}

const eventsUrl = (id: string): string => `/data/history/${DATASET}/events/documents/${id}`
const revisionUrl = (ids: string, qs = '?revision=abc123'): string =>
  `/data/history/${DATASET}/documents/${ids}${qs}`
const translogUrl = (ids: string): string =>
  `/data/history/${DATASET}/transactions/${ids}` +
  `?tag=sanity.studio.documents.history&effectFormat=mendoza&excludeContent=true&limit=50`

/* ================================================================== *
 * 3. the reported defect, isolated to the endpoint that causes it
 * ================================================================== */

describe('the transaction log is NDJSON, and that is what makes `tx.effects` undefined', () => {
  it('decodes the observed `{"transactions":[]}` body as ONE transaction with no effects', () => {
    /* The body the Mode-2 origin answers today (`origin.mjs:1592`). */
    const decoded = readNdjson('{"transactions":[]}')

    /* Not "no transactions" — the envelope itself became a transaction. */
    expect(decoded).toEqual([{transactions: []}])
    expect(decoded).toHaveLength(1)

    /* …and that is the reported crash, reproduced through sanity's own reader. */
    expect(() => getEditEvents(decoded, BRANCH_DRAFT)).toThrowError(
      /Cannot read properties of undefined \(reading 'drafts\.e2e-unicode-multihunk'\)/,
    )
  })

  it('states the empty translog as an empty NDJSON body, which decodes to nothing', () => {
    expect(EMPTY_TRANSLOG_NDJSON).toBe('')
    expect(readNdjson(EMPTY_TRANSLOG_NDJSON)).toEqual([])
    expect(getEditEvents(readNdjson(EMPTY_TRANSLOG_NDJSON), BRANCH_DRAFT)).toEqual([])
  })

  it('re-arms the same throw for ANY line lacking `effects`, empty answer or not', () => {
    /* `excludeContent=true` strips CONTENT, never `effects`; `effectFormat=
     * mendoza` is what puts `effects` on the wire. A server that honours the
     * first and drops the second reproduces the identical TypeError, so "the
     * body was empty" is not the whole invariant — every line must carry an
     * `effects` object keyed by document id. */
    const withoutEffects = readNdjson(
      '{"id":"tx1","timestamp":"2026-08-09T00:00:00Z","author":"u1"}',
    )
    expect(() => getEditEvents(withoutEffects, BRANCH_DRAFT)).toThrowError(
      /Cannot read properties of undefined \(reading 'drafts\.e2e-unicode-multihunk'\)/,
    )

    const wellFormed = readNdjson(
      '{"id":"tx1","timestamp":"2026-08-09T00:00:00Z","author":"u1","effects":{}}',
    )
    expect(() => getEditEvents(wellFormed, BRANCH_DRAFT)).not.toThrow()
  })
})

/* ================================================================== *
 * 4. the classifier: which delegated reads are history reads at all
 * ================================================================== */

describe('classifyOverlayHistoryRead', () => {
  it('claims the two history reads that travel on client.request', () => {
    expect(classifyOverlayHistoryRead(eventsUrl(BRANCH_DRAFT))).toEqual({
      kind: 'events',
      ids: [BRANCH_DRAFT],
    })
    expect(classifyOverlayHistoryRead(revisionUrl(BRANCH_DRAFT))).toEqual({
      kind: 'documents',
      ids: [BRANCH_DRAFT],
    })
  })

  it('splits and decodes comma-joined ids the way `ids.join(",")` wrote them', () => {
    expect(classifyOverlayHistoryRead(revisionUrl(`${BRANCH_PUBLISHED},${BRANCH_DRAFT}`))).toEqual({
      kind: 'documents',
      ids: [BRANCH_PUBLISHED, BRANCH_DRAFT],
    })
    expect(classifyOverlayHistoryRead(revisionUrl(encodeURIComponent('drafts.a b')))).toEqual({
      kind: 'documents',
      ids: ['drafts.a b'],
    })
  })

  it('reads an absolute URL as well as the relative one client.request is given', () => {
    expect(
      classifyOverlayHistoryRead(
        `https://b1n03q3z.api.example.test/v2025-02-19${eventsUrl(BRANCH_DRAFT)}`,
      ),
    ).toEqual({kind: 'events', ids: [BRANCH_DRAFT]})
  })

  it('does NOT claim the transaction log — no client method ever carries it', () => {
    /* Claiming it would be worse than useless: `client.request` JSON-parses a
     * whole body, and the translog is a stream the facade never sees. */
    expect(classifyOverlayHistoryRead(translogUrl(BRANCH_DRAFT))).toBeUndefined()
  })

  it('does NOT claim /data/doc availability, which is an existence read', () => {
    expect(
      classifyOverlayHistoryRead(`/data/doc/${DATASET}/${BRANCH_DRAFT},${BRANCH_PUBLISHED}`),
    ).toBeUndefined()
    expect(classifyOverlayHistoryRead(`/data/query/${DATASET}?query=*`)).toBeUndefined()
    expect(classifyOverlayHistoryRead(undefined)).toBeUndefined()
    expect(classifyOverlayHistoryRead(42)).toBeUndefined()
  })
})

/* ================================================================== *
 * 5. the facade, endpoint by endpoint
 * ================================================================== */

describe('facade · /data/history/<ds>/events/documents/<id>', () => {
  it('answers a branch document with an events map keyed by its id', async () => {
    const h = harness([BRANCH_DRAFT])
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: eventsUrl(BRANCH_DRAFT),
      tag: 'get-document-events',
    })

    /* Fed to sanity's own reader (`:5006`) — an array `events` would silently
     * produce `[]` here too, so the SHAPE is asserted as well. */
    expect(readEventsResponse(answer, BRANCH_DRAFT)).toEqual([])
    expect(Array.isArray((answer as Rec).events)).toBe(false)
    expect((answer as Rec).events).toEqual({[BRANCH_DRAFT]: []})
    expect((answer as Rec).nextCursor).toBe('')
    expect(h.delegated).toEqual([])
  })

  it('answers the observable spelling sanity actually uses', async () => {
    /* `getInitialFetchEvents` calls `client.observable.request({url, tag})`
     * (`:5006`), never the promise form. */
    const h = harness([BRANCH_DRAFT])
    const request = (h.wrapped.observable as Rec).request as (r: unknown) => unknown
    const answer = await drain(request({url: eventsUrl(BRANCH_DRAFT), tag: 'get-document-events'}))
    expect(readEventsResponse(answer, BRANCH_DRAFT)).toEqual([])
    expect((answer as Rec).events).toEqual({[BRANCH_DRAFT]: []})
    expect((answer as Rec).nextCursor).toBe('')
    expect(h.delegated).toEqual([])
  })

  it('answers the published id spelling from its own branch address', async () => {
    const h = harness([BRANCH_PUBLISHED])
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: eventsUrl(BRANCH_PUBLISHED),
    })
    expect((answer as Rec).events).toEqual({[BRANCH_PUBLISHED]: []})
    expect(h.delegated).toEqual([])
  })

  it('DELEGATES a document the branch does not hold — base history is real there', async () => {
    const h = harness([BRANCH_DRAFT])
    h.setBaseAnswer({events: {[BASE_DRAFT]: [{id: 'ev1', type: 'editDocumentVersion'}]}, nextCursor: 'c1'})
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: eventsUrl(BASE_DRAFT),
    })
    expect(readEventsResponse(answer, BASE_DRAFT)).toHaveLength(1)
    expect(h.delegated).toHaveLength(1)
  })
})

describe('facade · /data/history/<ds>/documents/<ids>', () => {
  it('answers a branch document with a documents array, not a bare envelope', async () => {
    const h = harness([BRANCH_DRAFT])
    /* The negative control: what the base really answers today throws in
     * sanity's own reader before the facade is asked anything. */
    expect(() => readDocumentAtRevision({events: []})).toThrow(TypeError)

    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: revisionUrl(BRANCH_DRAFT),
      tag: 'get-document-revision',
    })
    expect(readDocumentAtRevision(answer)).toEqual({document: undefined, revisionId: undefined})
    expect(h.delegated).toEqual([])
  })

  it('covers the ?time= and lastRevision=true spellings of the same endpoint', async () => {
    const h = harness([BRANCH_DRAFT, BRANCH_PUBLISHED])
    for (const qs of ['?time=2026-08-09T00:00:00.000Z', '?lastRevision=true', '']) {
      const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
        url: revisionUrl(`${BRANCH_PUBLISHED},${BRANCH_DRAFT}`, qs),
      })
      expect(readDocumentAtRevision(answer).document).toBeUndefined()
    }
    expect(h.delegated).toEqual([])
  })

  it('DELEGATES a mixed id set — one branch id cannot speak for a base one', async () => {
    const h = harness([BRANCH_DRAFT])
    h.setBaseAnswer({documents: [{_id: BASE_DRAFT, _rev: 'r1'}]})
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: revisionUrl(`${BRANCH_DRAFT},${BASE_DRAFT}`),
    })
    expect(readDocumentAtRevision(answer).revisionId).toBe('r1')
    expect(h.delegated).toHaveLength(1)
  })
})

describe('facade · the reads it deliberately does NOT claim', () => {
  it('leaves the transaction log delegated — it is unreachable, not unhandled', async () => {
    const h = harness([BRANCH_DRAFT])
    h.setBaseAnswer({transactions: []})
    await (h.wrapped.request as (r: unknown) => Promise<unknown>)({url: translogUrl(BRANCH_DRAFT)})
    expect(h.delegated).toHaveLength(1)
  })

  it('leaves /data/doc availability to the HISTORY oracle alone — it is a different question', async () => {
    /*
     * `branchHolds` is the history oracle and it is deliberately not enough to
     * answer an EXISTENCE probe: it collapses "the branch holds a body" and
     * "the branch holds a tombstone", which are opposite answers to
     * `/data/doc`. So this harness — which wires `branchHolds` and nothing else
     * — must still delegate the probe untouched.
     *
     * The probe IS answered from the branch, through the separate `branchView`
     * oracle; `studio-doc-existence.test.ts` owns that, and
     * `studio-reference-validation.test.ts` drives it through sanity's own
     * validation chain. What this pins is that the two oracles stay separate:
     * a history option must never start deciding existence by accident.
     */
    const h = harness([BRANCH_DRAFT, BRANCH_PUBLISHED])
    h.setBaseAnswer({documents: [], omitted: [{id: BRANCH_DRAFT, reason: 'existence'}]})
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      uri: `/data/doc/${DATASET}/${BRANCH_DRAFT},${BRANCH_PUBLISHED}`,
      query: {excludeContent: 'true'},
    })
    expect(h.delegated).toHaveLength(1)
    /* Same class, same crash shape if the envelope loses `omitted` — pinned so
     * the next server that answers `{}` here is caught by a test and not by a
     * console. */
    expect(readAvailability(answer, [BRANCH_DRAFT, BRANCH_PUBLISHED])).toEqual({
      [BRANCH_DRAFT]: false,
      [BRANCH_PUBLISHED]: true,
    })
    expect(() => readAvailability({}, [BRANCH_DRAFT])).toThrow(TypeError)
  })

  it('ABSENT MEANS UNCHANGED: with no branch oracle every history read delegates', async () => {
    const h = harness(null)
    await (h.wrapped.request as (r: unknown) => Promise<unknown>)({url: eventsUrl(BRANCH_DRAFT)})
    await (h.wrapped.request as (r: unknown) => Promise<unknown>)({url: revisionUrl(BRANCH_DRAFT)})
    expect(h.delegated).toHaveLength(2)
  })

  it('never answers a non-GET aimed at a history path', async () => {
    const h = harness([BRANCH_DRAFT])
    h.setBaseAnswer({ok: true})
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: eventsUrl(BRANCH_DRAFT),
      method: 'POST',
      body: {},
    })
    expect(answer).toEqual({ok: true})
    expect(h.delegated).toHaveLength(1)
  })
})

/* ================================================================== *
 * 6. the runtime, which is the only thing that puts the oracle in place
 * ================================================================== */

describe('runtime · the branch the overlay API reports is the history oracle', () => {
  const resolved = resolveOverlayOptions(
    {mode: 'fs', apiUrl: 'http://localhost:3998', strictQueries: false},
    {},
  )

  /* The branch as `POST /state` reports it: one invented draft, one base
   * document the branch has not touched at all. */
  const BRANCH: OverlayHydrationDocument[] = [
    {
      logicalId: BRANCH_PUBLISHED,
      schemaType: 'article',
      draft: {_id: BRANCH_DRAFT, _type: 'article', title: 'branch only'},
    },
  ]

  function runtimeHarness(): {factory: (o: Rec) => Rec; delegated: unknown[]; refresh(): Promise<void>} {
    const delegated: unknown[] = []
    const client: Rec = {
      fetch: () => Promise.resolve(null),
      getUrl: (uri: string) => uri,
      getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
      config: () => ({projectId: 'b1n03q3z', dataset: DATASET}),
      withConfig: (): unknown => client,
      request: (request: unknown): unknown => {
        delegated.push(request)
        return Promise.resolve({events: []})
      },
    }
    client.observable = {fetch: () => Promise.resolve(null), request: client.request}

    const runtime = createOverlayRuntime({
      resolved,
      createClient: () => client as never,
      fetch: (async () =>
        new Response(JSON.stringify({ok: true, revision: 1, documents: BRANCH}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })) as unknown as typeof fetch,
    })
    return {
      factory: runtime.clientFactory as (o: Rec) => Rec,
      delegated,
      refresh: () => runtime.refresh(),
    }
  }

  it('answers a branch draft empty and still delegates an untouched base document', async () => {
    const h = runtimeHarness()
    await h.refresh()
    const wrapped = h.factory({})
    const request = wrapped.request as (r: unknown) => Promise<unknown>

    const branch = await request({url: eventsUrl(BRANCH_DRAFT)})
    expect(readEventsResponse(branch, BRANCH_DRAFT)).toEqual([])
    expect((branch as Rec).events).toEqual({[BRANCH_DRAFT]: []})
    expect(h.delegated).toEqual([])

    await request({url: eventsUrl(BASE_DRAFT)})
    expect(h.delegated).toHaveLength(1)
  })

  it('is history-blind before /state has been read, rather than guessing', async () => {
    const h = runtimeHarness()
    const wrapped = h.factory({})
    await (wrapped.request as (r: unknown) => Promise<unknown>)({url: eventsUrl(BRANCH_DRAFT)})
    expect(h.delegated).toHaveLength(1)
  })
})
