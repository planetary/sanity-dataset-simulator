/**
 * `/data/doc` — "DOES THIS DOCUMENT EXIST?", ASKED OF THE WRONG DATASET.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT.
 *
 * `sanity@6.8.0` asks the existence question five times, always as a raw
 * `client.request({uri: client.getDataUrl('doc', ids)})`, never as GROQ:
 *
 *   datastores-DqFH7RLd.js:244   `fetchDocumentReadabilityChunked`
 *       `?excludeContent=true`, read as `keyBy(response.omitted || [], …)`.
 *       This is what `observeDocumentAvailability` falls back to whenever the
 *       preview store has no `_rev` for an id — see §4 below for why a branch
 *       document never has one.
 *   datastores-DqFH7RLd.js:5533  `createBatchedGetDocumentExists`
 *       `availability.omitted.reduce(…)` — NO `|| []`, so a missing `omitted`
 *       is a TypeError.
 *   structureTool-EN0gOzyJ.js:739 `getDocumentExistence`
 *       `({omitted}) => omitted.filter(…)` — same, the delete-confirm and
 *       cross-dataset-reference probe.
 *   useBundleDocuments-BYW8M9LS.js:33275  `cross-dataset-refs.availability`
 *   useBundleDocuments-BYW8M9LS.js:34102  `gdr.availability`
 *
 * All five are answered by the BASE dataset, so a document the branch created
 * reads as MISSING and a document the branch deleted reads as PRESENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO WIRE SHAPES, NOT ONE. `excludeContent=true` is the FOURTH of those five
 * call sites, not all of them — and the fifth only looks like it:
 *
 *     // useBundleDocuments-BYW8M9LS.js:34100
 *     let requestOptions = {uri: client.getDataUrl('doc', id), json: !0,
 *                           excludeContent: 'true', tag: 'gdr.availability'}
 *
 * `excludeContent` is at the TOP LEVEL of the options bag, not inside `query`,
 * and `@sanity/client@7.26.0` `_requestObservable` builds the query string from
 * `options.query` ALONE (`dist/index.browser.js:1149-1176`). So that request
 * carries no `excludeContent` at all and its answer carries full document
 * CONTENT. Anything that claims this endpoint has to be right about both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS INDEPENDENT. Every assertion feeds the facade's answer into a
 * transcription of sanity 6.8.0's own reader, with the dist line noted, or into
 * `@sanity/client`'s own `documentsExists` reducer. Nothing asserts on a value
 * the code under test just computed for it.
 */
import {describe, expect, it} from 'vitest'

import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

const DATASET = 'parity'

/** Created in the branch, PUBLISHED form. Base has never heard of it. */
const BRANCH_PUBLISHED = 'author-branch-only'
const BRANCH_DRAFT = `drafts.${BRANCH_PUBLISHED}`
/** A document base holds and the branch has not touched. */
const BASE_ONLY = 'author-in-base'
/** A document base holds and the branch has DELETED. */
const BRANCH_DELETED = 'author-removed'

/* ================================================================== *
 * 1. sanity@6.8.0 and @sanity/client@7.26.0, transcribed
 * ================================================================== */

/**
 * `lib/datastores-DqFH7RLd.js:250-257` — `fetchDocumentReadabilityChunked`'s
 * map. `AVAILABILITY_READABLE` / `AVAILABILITY_NOT_FOUND` reduced to their
 * `available` flag, which is the only field `listenDocumentExists` reads.
 */
function readAvailability(response: unknown, ids: readonly string[]): Record<string, boolean> {
  const body = response as {omitted?: Array<{id: string; reason: string}>}
  const omitted: Record<string, string> = {}
  for (const entry of body.omitted || []) omitted[entry.id] = entry.reason
  const out: Record<string, boolean> = {}
  for (const id of ids) {
    const reason = omitted[id]
    if (reason === undefined) out[id] = true
    else if (reason === 'existence') out[id] = false
    else if (reason === 'permission') out[id] = false
    else throw new Error(`Unexpected reason for omission: "${reason}"`)
  }
  return out
}

/**
 * `lib/structureTool-EN0gOzyJ.js:744` — the delete-confirm / referring-documents
 * probe. NO `|| []`: it destructures `omitted` and calls `.filter` on it, so an
 * envelope without `omitted` throws. Answers the id whose existence the caller
 * should go on to ask about, or `undefined` when NEITHER form exists.
 */
function getDocumentExistence(
  response: unknown,
  draftId: string,
  publishedId: string,
): string | undefined {
  const {omitted} = response as {omitted: Array<{id: string; reason: string}>}
  const nonExistant = omitted.filter((doc) => doc.reason === 'existence')
  if (nonExistant.length !== 2) {
    return nonExistant.length === 0 || nonExistant.some((doc) => doc.id === draftId)
      ? publishedId
      : draftId
  }
  return undefined
}

/**
 * `lib/datastores-DqFH7RLd.js:5541-5549` — `createBatchedGetDocumentExists`.
 * `availability.omitted.reduce(…)` with no guard, which is the second place a
 * missing `omitted` is a TypeError rather than a wrong answer.
 */
function getDocumentExists(response: unknown, ids: readonly string[]): Record<string, boolean> {
  const availability = response as {omitted: Array<{id: string; reason: string}>}
  const omittedIds = availability.omitted.reduce<Record<string, string>>((acc, next) => {
    acc[next.id] = next.reason
    return acc
  }, {})
  const out: Record<string, boolean> = {}
  for (const id of ids) out[id] = !(omittedIds[id] && omittedIds[id] === 'existence')
  return out
}

/**
 * `@sanity/client@7.26.0` `dist/index.browser.js:998-1002` — `documentsExists`.
 * A THIRD independent reader of the same envelope, and the one that proves the
 * shape is `@sanity/client`'s contract and not only Studio's.
 */
function documentsExists(response: unknown, ids: readonly string[]): Set<string> {
  const body = response as {omitted?: Array<{id: string; reason: string}>}
  const missing = new Set<string>()
  for (const omitted of body.omitted || []) {
    if (omitted.reason === 'existence') missing.add(omitted.id)
  }
  return new Set(ids.filter((id) => !missing.has(id)))
}

/** `lib/datastores-DqFH7RLd.js:7137` — the CONTENT reader, for the other shape. */
function documentBodies(response: unknown): Rec[] {
  return ((response as {documents?: Rec[]}).documents || []) as Rec[]
}

/* ================================================================== *
 * 2. the harness — a client that is nothing but a delegation recorder
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
  /** Every request object that reached the REAL client, in order. */
  delegated: unknown[]
  messages: string[]
  setBaseAnswer(answer: unknown): void
  failBase(error: unknown): void
}

/**
 * `branch` is the overlay's `/state` hydration, put through the SAME
 * `overlaySourceFromBranch` the GROQ read path consumes. `null` leaves the
 * option off entirely, which is the "ABSENT MEANS UNCHANGED" control.
 */
function harness(branch: readonly OverlayHydrationDocument[] | null): Harness {
  const delegated: unknown[] = []
  const messages: string[] = []
  let baseAnswer: unknown = {documents: [], omitted: []}
  let baseError: unknown

  const answerBase = (): unknown => {
    if (baseError !== undefined) throw baseError
    return baseAnswer
  }

  const client: Rec = {
    fetch: () => Promise.resolve(null),
    getUrl: (uri: string) => `https://b1n03q3z.api.example.test/v2025-02-19${uri}`,
    getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
    config: () => ({projectId: 'b1n03q3z', dataset: DATASET, apiHost: 'https://api.example.test'}),
    withConfig: (): unknown => client,
    request: (request: unknown): unknown => {
      delegated.push(request)
      try {
        return Promise.resolve(answerBase())
      } catch (error) {
        return Promise.reject(error as Error)
      }
    },
  }
  client.observable = {
    fetch: () => Promise.resolve(null),
    request: (request: unknown): unknown => {
      delegated.push(request)
      return {
        subscribe(observer: {
          next: (v: unknown) => void
          error: (e: unknown) => void
          complete: () => void
        }) {
          try {
            observer.next(answerBase())
            observer.complete()
          } catch (error) {
            observer.error(error)
          }
          return {unsubscribe: () => undefined}
        },
      }
    },
  }

  const view = branch === null ? null : overlaySourceFromBranch(branch)

  const wrapped = wrapWithOverlay(client as never, {
    echo: createOverlayEcho(),
    transport: silentTransport(),
    onError: (message) => messages.push(message),
    ...(view === null ? {} : {branchView: () => view}),
  }) as unknown as Rec

  return {
    wrapped,
    delegated,
    messages,
    setBaseAnswer: (answer) => {
      baseAnswer = answer
    },
    failBase: (error) => {
      baseError = error
    },
  }
}

const docUri = (ids: readonly string[]): string => `/data/doc/${DATASET}/${ids.join(',')}`

function ask(h: Harness, ids: readonly string[], extra: Rec = {}): Promise<unknown> {
  return (h.wrapped.request as (r: unknown) => Promise<unknown>)({
    uri: docUri(ids),
    json: true,
    ...extra,
  })
}

function askObservable(h: Harness, ids: readonly string[], extra: Rec = {}): Promise<unknown> {
  const observable = ((h.wrapped.observable as Rec).request as (r: unknown) => unknown)({
    uri: docUri(ids),
    json: true,
    ...extra,
  })
  return new Promise((resolve, reject) => {
    let settled = false
    ;(
      observable as {
        subscribe: (o: {
          next: (v: unknown) => void
          error: (e: unknown) => void
          complete: () => void
        }) => unknown
      }
    ).subscribe({
      next: (value) => {
        settled = true
        resolve(value)
      },
      error: (error) => reject(error as Error),
      complete: () => {
        if (!settled) resolve(undefined)
      },
    })
  })
}

/** The branch as `GET /state` reports it: one author invented in the branch. */
const BRANCH_CREATED: OverlayHydrationDocument[] = [
  {
    logicalId: BRANCH_PUBLISHED,
    schemaType: 'author',
    published: {_id: BRANCH_PUBLISHED, _type: 'author', name: 'Invented here', _rev: 'ov-1'},
  },
]

/** The branch as `GET /state` reports it: one base author the branch deleted. */
const BRANCH_TOMBSTONE: OverlayHydrationDocument[] = [
  {
    logicalId: BRANCH_DELETED,
    schemaType: 'author',
    publishedTombstone: true,
    draftTombstone: true,
  },
]

/* ================================================================== *
 * 3. the branch-created document, through every reader sanity has
 * ================================================================== */

describe('a document the branch created is not missing, and every reader must say so', () => {
  it('answers `omitted: []` for a published id base has never heard of', async () => {
    const h = harness(BRANCH_CREATED)
    /* What the BASE dataset says, verbatim: it does not have this document. */
    h.setBaseAnswer({documents: [], omitted: [{id: BRANCH_PUBLISHED, reason: 'existence'}]})

    const answer = await ask(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})

    /* ORACLE 1 — `datastores:250`, the preview-availability reader. */
    expect(readAvailability(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
    /* ORACLE 2 — `datastores:5542`, the batched existence reader. */
    expect(getDocumentExists(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
    /* ORACLE 3 — `@sanity/client`'s own `documentsExists`. */
    expect(documentsExists(answer, [BRANCH_PUBLISHED])).toEqual(new Set([BRANCH_PUBLISHED]))
  })

  it('does not ask base at all when the branch has an opinion about every id', async () => {
    const h = harness(BRANCH_CREATED)
    await ask(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})
    /* A round trip whose answer is known before it is sent is a request that
     * can hang. §5.5: no dependency nobody needs. */
    expect(h.delegated).toEqual([])
  })

  it('survives a base that is DOWN, when the branch already knows the answer', async () => {
    const h = harness(BRANCH_CREATED)
    h.failBase(new Error('ECONNREFUSED'))
    const answer = await ask(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})
    expect(readAvailability(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
  })

  it('carries the branch BODY when the caller did not ask to exclude content', async () => {
    /* `useBundleDocuments:34100` is exactly this shape: `excludeContent` sits on
     * the options bag where @sanity/client never reads it, so the request is a
     * CONTENT read and its answer must carry documents. */
    const h = harness(BRANCH_CREATED)
    const answer = await ask(h, [BRANCH_PUBLISHED], {excludeContent: 'true'})

    const bodies = documentBodies(answer)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?._id).toBe(BRANCH_PUBLISHED)
    expect(bodies[0]?.name).toBe('Invented here')
    /* …and the existence answer is the same one, from the same envelope. */
    expect(readAvailability(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
  })

  it('sends NO body when the caller really did ask to exclude content', async () => {
    const h = harness(BRANCH_CREATED)
    const answer = await ask(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})
    expect(documentBodies(answer)).toEqual([])
  })

  it('reads `excludeContent` out of the URI query string too', async () => {
    const h = harness(BRANCH_CREATED)
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      uri: `${docUri([BRANCH_PUBLISHED])}?excludeContent=true`,
    })
    expect(documentBodies(answer)).toEqual([])
    expect(readAvailability(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
  })

  it('answers the observable spelling identically — that is the one Studio uses', async () => {
    const h = harness(BRANCH_CREATED)
    const answer = await askObservable(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})
    expect(readAvailability(answer, [BRANCH_PUBLISHED])).toEqual({[BRANCH_PUBLISHED]: true})
  })
})

/* ================================================================== *
 * 4. the branch-DELETED document — the mirror defect
 * ================================================================== */

describe('a document the branch deleted is missing, and every reader must say so', () => {
  it('reports `existence` for an id base still holds', async () => {
    const h = harness(BRANCH_TOMBSTONE)
    /* Base is perfectly happy: it still has the document. */
    h.setBaseAnswer({
      documents: [{_id: BRANCH_DELETED, _type: 'author', name: 'Still in base'}],
      omitted: [],
    })

    const answer = await ask(h, [BRANCH_DELETED], {query: {excludeContent: 'true'}})

    expect(readAvailability(answer, [BRANCH_DELETED])).toEqual({[BRANCH_DELETED]: false})
    expect(getDocumentExists(answer, [BRANCH_DELETED])).toEqual({[BRANCH_DELETED]: false})
    expect(documentsExists(answer, [BRANCH_DELETED])).toEqual(new Set())
  })

  it('overrules a `permission` omission — "not there" beats "not yours to read"', async () => {
    const h = harness(BRANCH_TOMBSTONE)
    h.setBaseAnswer({documents: [], omitted: [{id: BRANCH_DELETED, reason: 'permission'}]})
    const answer = await ask(h, [BRANCH_DELETED, BASE_ONLY])
    expect((answer as {omitted: Rec[]}).omitted).toEqual([
      {id: BRANCH_DELETED, reason: 'existence'},
    ])
    /* NON-VACUITY: `permission` is a reason `readAvailability` handles, and it
     * is NOT the one the branch means — `datastores:256` throws on anything
     * else, so the vocabulary has to be exact. */
    expect(readAvailability(answer, [BRANCH_DELETED])).toEqual({[BRANCH_DELETED]: false})
  })

  it('leaves an `existence` omission it AGREES with exactly as it came', async () => {
    /* The Mode-2 origin hangs an `overlayAbsence` diagnostic off this entry
     * (`origin.mjs:1163`). Rewriting a verdict we agree with would drop it. */
    const h = harness(BRANCH_TOMBSTONE)
    const fromBase = {id: BRANCH_DELETED, reason: 'existence', overlayAbsence: 'tombstone'}
    h.setBaseAnswer({documents: [], omitted: [fromBase]})
    const answer = await ask(h, [BRANCH_DELETED, BASE_ONLY])
    expect((answer as {omitted: Rec[]}).omitted).toEqual([fromBase])
  })

  it('drops the base BODY too, so a content read cannot resurrect it', async () => {
    const h = harness(BRANCH_TOMBSTONE)
    h.setBaseAnswer({
      documents: [{_id: BRANCH_DELETED, _type: 'author', name: 'Still in base'}],
      omitted: [],
    })
    const answer = await ask(h, [BRANCH_DELETED])
    expect(documentBodies(answer)).toEqual([])
  })
})

/* ================================================================== *
 * 5. the MIXED request — the shape Studio actually sends
 * ================================================================== */

describe('one request, one id per verdict', () => {
  /* `structureTool:739` asks `getDataUrl('doc', `${draftId},${publishedId}`)`
   * and `datastores:5533` batches up to 100 unrelated ids into one call. A
   * branch opinion about one of them must not erase base's answer about the
   * others. */
  const MIXED: OverlayHydrationDocument[] = [...BRANCH_CREATED, ...BRANCH_TOMBSTONE]

  it('keeps base authoritative for every id the branch has no opinion about', async () => {
    const h = harness(MIXED)
    h.setBaseAnswer({
      documents: [{_id: BASE_ONLY, _type: 'author', name: 'From base'}],
      omitted: [
        {id: BRANCH_PUBLISHED, reason: 'existence'},
        {id: 'author-forbidden', reason: 'permission'},
      ],
    })

    const answer = await ask(h, [
      BRANCH_PUBLISHED,
      BRANCH_DELETED,
      BASE_ONLY,
      'author-forbidden',
    ])

    expect(
      readAvailability(answer, [BRANCH_PUBLISHED, BRANCH_DELETED, BASE_ONLY, 'author-forbidden']),
    ).toEqual({
      [BRANCH_PUBLISHED]: true,
      [BRANCH_DELETED]: false,
      [BASE_ONLY]: true,
      'author-forbidden': false,
    })
    /* Base really was asked — the merge is a merge, not a replacement. */
    expect(h.delegated).toHaveLength(1)
  })

  it('leaves the base document bodies it did not rule on exactly as they came', async () => {
    const h = harness(MIXED)
    const fromBase = {_id: BASE_ONLY, _type: 'author', name: 'From base', _rev: 'lake-1'}
    h.setBaseAnswer({documents: [fromBase], omitted: []})

    const answer = await ask(h, [BASE_ONLY, BRANCH_PUBLISHED])
    const bodies = documentBodies(answer)
    expect(bodies.find((body) => body._id === BASE_ONLY)).toEqual(fromBase)
    expect(bodies.find((body) => body._id === BRANCH_PUBLISHED)?.name).toBe('Invented here')
  })

  it('answers `getDocumentExistence` — the delete-confirm probe — about the BRANCH', async () => {
    /* `structureTool:737`. The branch holds only the published form, so exactly
     * one of the pair is non-existent and the probe must name the published
     * one. Against base BOTH are missing and the probe answers `undefined`,
     * which is the "no such document, nothing to confirm" branch. */
    const h = harness(BRANCH_CREATED)
    h.setBaseAnswer({
      documents: [],
      omitted: [
        {id: BRANCH_DRAFT, reason: 'existence'},
        {id: BRANCH_PUBLISHED, reason: 'existence'},
      ],
    })

    const answer = await ask(h, [BRANCH_DRAFT, BRANCH_PUBLISHED], {
      query: {excludeContent: 'true'},
    })
    expect(getDocumentExistence(answer, BRANCH_DRAFT, BRANCH_PUBLISHED)).toBe(BRANCH_PUBLISHED)

    /* NON-VACUITY: the same reader on base's own answer says "neither exists". */
    expect(
      getDocumentExistence(
        {
          documents: [],
          omitted: [
            {id: BRANCH_DRAFT, reason: 'existence'},
            {id: BRANCH_PUBLISHED, reason: 'existence'},
          ],
        },
        BRANCH_DRAFT,
        BRANCH_PUBLISHED,
      ),
    ).toBeUndefined()
  })

  it('propagates a base failure when base was the only one who could answer', async () => {
    const h = harness(BRANCH_CREATED)
    h.failBase(new Error('ECONNREFUSED'))
    await expect(ask(h, [BRANCH_PUBLISHED, BASE_ONLY])).rejects.toThrow('ECONNREFUSED')
  })
})

/* ================================================================== *
 * 6. the boundaries — what this must NOT claim
 * ================================================================== */

describe('the boundaries of the claim', () => {
  it('ABSENT MEANS UNCHANGED: with no branch view every /data/doc read delegates', async () => {
    const h = harness(null)
    const base = {documents: [], omitted: [{id: BRANCH_PUBLISHED, reason: 'existence'}]}
    h.setBaseAnswer(base)
    const answer = await ask(h, [BRANCH_PUBLISHED], {query: {excludeContent: 'true'}})
    expect(answer).toEqual(base)
    expect(h.delegated).toHaveLength(1)
  })

  it('delegates byte-for-byte when the branch has no opinion about ANY id', async () => {
    const h = harness(BRANCH_CREATED)
    const base = {ms: 4, documents: [{_id: BASE_ONLY, _type: 'author'}], omitted: []}
    h.setBaseAnswer(base)
    const answer = await ask(h, [BASE_ONLY])
    /* The SAME object, not an equal one: a read the branch cannot change must
     * not even be re-serialised on its way past. */
    expect(answer).toBe(base)
    expect(h.delegated).toHaveLength(1)
  })

  it('never answers a non-GET aimed at a /data/doc path', async () => {
    const h = harness(BRANCH_CREATED)
    h.setBaseAnswer({ok: true})
    const answer = await ask(h, [BRANCH_PUBLISHED], {method: 'POST', body: {}})
    expect(answer).toEqual({ok: true})
    expect(h.delegated).toHaveLength(1)
  })

  it('does not answer for ANOTHER dataset, however the client got pointed at one', async () => {
    /*
     * `useBundleDocuments:33273` `fetchDocumentAvailability` is the
     * cross-dataset reference probe. It travels on
     * `client.withConfig({projectId, dataset})` — a clone of this very proxy,
     * because a clone of a wrapped client is a wrapped client — and asks
     * `/data/doc/<theirDataset>/<id>`. The branch has never seen that dataset,
     * and an id that happens to collide must not decide anything in it.
     */
    const h = harness(BRANCH_CREATED)
    const base = {documents: [], omitted: [{id: BRANCH_PUBLISHED, reason: 'existence'}]}
    h.setBaseAnswer(base)
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      uri: `/data/doc/some-other-dataset/${BRANCH_PUBLISHED}`,
      query: {excludeContent: 'true'},
    })
    /* Untouched, and by identity: the same id in OUR dataset is answered
     * `true` by the very first test in this file. */
    expect(answer).toBe(base)
    expect(h.delegated).toHaveLength(1)
  })

  it('FAILS CLOSED when the client will not say which dataset it is', async () => {
    /* The gate is the only thing standing between this branch and somebody
     * else's dataset, so "I could not check" has to mean "delegate". */
    const delegated: unknown[] = []
    const base = {documents: [], omitted: [{id: BRANCH_PUBLISHED, reason: 'existence'}]}
    const client: Rec = {
      fetch: () => Promise.resolve(null),
      getUrl: (uri: string) => uri,
      getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
      config: () => ({projectId: 'b1n03q3z'}),
      withConfig: (): unknown => client,
      request: (request: unknown): unknown => {
        delegated.push(request)
        return Promise.resolve(base)
      },
    }
    client.observable = {fetch: () => Promise.resolve(null), request: client.request}

    const view = overlaySourceFromBranch(BRANCH_CREATED)
    const wrapped = wrapWithOverlay(client as never, {
      echo: createOverlayEcho(),
      transport: silentTransport(),
      branchView: () => view,
    }) as unknown as Rec

    const answer = await (wrapped.request as (r: unknown) => Promise<unknown>)({
      uri: docUri([BRANCH_PUBLISHED]),
      query: {excludeContent: 'true'},
    })
    expect(answer).toBe(base)
    expect(delegated).toHaveLength(1)
  })

  it('does not claim /data/query, /data/history or /data/mutate', async () => {
    const h = harness(BRANCH_CREATED)
    const base = {result: []}
    h.setBaseAnswer(base)
    for (const uri of [
      `/data/query/${DATASET}?query=*`,
      `/data/history/${DATASET}/documents/${BRANCH_PUBLISHED}`,
      `/data/doctor/${DATASET}/${BRANCH_PUBLISHED}`,
    ]) {
      const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({uri})
      expect(answer).toBe(base)
    }
    expect(h.delegated).toHaveLength(3)
  })

  it('preserves whatever else the base envelope carried', async () => {
    const h = harness(BRANCH_CREATED)
    h.setBaseAnswer({ms: 7, documents: [], omitted: [], anythingElse: 'kept'})
    const answer = await ask(h, [BRANCH_PUBLISHED, BASE_ONLY])
    expect((answer as Rec).ms).toBe(7)
    expect((answer as Rec).anythingElse).toBe('kept')
  })
})

/* ================================================================== *
 * 7. `/data/history` stays a gap — and a gap that is SAID OUT LOUD
 * ================================================================== */

describe('the history gap is stated, not left to be deduced from an empty list', () => {
  /**
   * WHY IT IS STILL A GAP. Sanity's history plane is three endpoints that only
   * make sense together: `events`, `documents?revision=<rev>`, and the
   * transaction log. The revision ids the first two are keyed BY come out of
   * the translog — and the translog is fetched with the global `fetch()`
   * (`datastores:6868` `getJsonStream`, called at `:7097`;
   * `useBundleDocuments:4822`), which no wrapper around a client method can
   * reach. Serving two of three would hand a diff view revision ids that
   * nothing can resolve.
   *
   * WHY IT HAS TO BE ANNOUNCED. The empty answer is exactly true for a document
   * the branch created and NOT true for a base document the branch edited —
   * that one has a real upstream lineage, and `branchHolds` cannot tell the two
   * apart. Both are told the same thing, so §5.5 requires that "the branch's
   * history is not shown here" be a sentence rather than an inference from a
   * blank timeline.
   */
  function historyHarness(): Harness {
    const h = harness(BRANCH_CREATED)
    return h
  }

  it('says so, once, when a branch document is answered with an empty history', async () => {
    /* `branchHolds` is the history oracle and this file otherwise wires only
     * `branchView`, so it is supplied here explicitly. */
    const messages: string[] = []
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

    const wrapped = wrapWithOverlay(client as never, {
      echo: createOverlayEcho(),
      transport: silentTransport(),
      onError: (message) => messages.push(message),
      branchHolds: (id: string) => id === BRANCH_PUBLISHED,
    }) as unknown as Rec

    const url = `/data/history/${DATASET}/events/documents/${BRANCH_PUBLISHED}`
    await (wrapped.request as (r: unknown) => Promise<unknown>)({url})
    await (wrapped.request as (r: unknown) => Promise<unknown>)({url})

    /* Nothing left for base, so the empty answer really is this facade's. */
    expect(delegated).toEqual([])
    /* ONCE per document, not once per read: the timeline machinery re-asks on
     * every pane focus. */
    const announcements = messages.filter((message) => message.includes(BRANCH_PUBLISHED))
    expect(announcements).toHaveLength(1)
    /* It has to name the document AND say what was withheld and why. */
    expect(announcements[0]).toContain('history is NOT shown')
    expect(announcements[0]).toContain('base dataset')
  })

  it('does NOT announce synchronously — `request()` is called from a React render', async () => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * THE DEFECT THIS PINS, measured in the browser on 2026-08-10:
     *
     *   Cannot update a component (`OverlayStatusLayout`) while rendering a
     *   different component (`DocumentEventsPane`).
     *
     * `DocumentEventsPane` subscribes to the history read during ITS OWN
     * render. `onError` is `runtime.ts`'s `log`, which appends to `messages`
     * and then calls `notify()` — and `notify()` runs the status banner's
     * subscriber, i.e. `setState` on a DIFFERENT component, inside a render
     * pass. React's warning is not cosmetic: the render it interrupts is
     * discarded and re-run, and in the same session the surrounding tree fell
     * back to its error boundary.
     *
     * The announcement itself is right and must stay (§5.5) — what has to
     * change is WHEN it is delivered. The one thing this facade controls is
     * that it does not happen on the caller's stack.
     *
     * NOT A TEST ABOUT REACT. There is no React here, deliberately: the
     * property is "the observer is not called on the caller's stack", which is
     * exactly what a render-phase update violates and is checkable without
     * rendering anything.
     * ─────────────────────────────────────────────────────────────────────────
     */
    const messages: string[] = []
    const client: Rec = {
      fetch: () => Promise.resolve(null),
      getUrl: (uri: string) => uri,
      getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
      config: () => ({projectId: 'b1n03q3z', dataset: DATASET}),
      withConfig: (): unknown => client,
      request: () => Promise.resolve({events: []}),
    }
    client.observable = {fetch: () => Promise.resolve(null), request: client.request}

    const wrapped = wrapWithOverlay(client as never, {
      echo: createOverlayEcho(),
      transport: silentTransport(),
      onError: (message) => messages.push(message),
      branchHolds: (id: string) => id === BRANCH_PUBLISHED,
    }) as unknown as Rec

    const url = `/data/history/${DATASET}/events/documents/${BRANCH_PUBLISHED}`
    const pending = (wrapped.request as (r: unknown) => Promise<unknown>)({url})

    /* THE ASSERTION: nothing was pushed at the caller while it was still on the
     * stack that asked. */
    expect(messages, 'the announcement landed on the caller’s stack').toEqual([])

    /* …and it is still delivered, promptly. A "fix" that dropped the message
     * would pass the line above and fail here. */
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.filter((message) => message.includes(BRANCH_PUBLISHED))).toHaveLength(1)
  })

  it('says nothing for a document it delegated — there is no gap to declare', async () => {
    const messages: string[] = []
    const client: Rec = {
      fetch: () => Promise.resolve(null),
      getUrl: (uri: string) => uri,
      getDataUrl: (op: string, ids: string) => `/data/${op}/${DATASET}/${ids}`,
      config: () => ({projectId: 'b1n03q3z', dataset: DATASET}),
      withConfig: (): unknown => client,
      request: () => Promise.resolve({events: []}),
    }
    client.observable = {fetch: () => Promise.resolve(null), request: client.request}

    const wrapped = wrapWithOverlay(client as never, {
      echo: createOverlayEcho(),
      transport: silentTransport(),
      onError: (message) => messages.push(message),
      branchHolds: () => false,
    }) as unknown as Rec

    await (wrapped.request as (r: unknown) => Promise<unknown>)({
      url: `/data/history/${DATASET}/events/documents/${BASE_ONLY}`,
    })
    expect(messages).toEqual([])
  })

  it('keeps history and existence on separate oracles', async () => {
    /* A harness with only `branchView` must NOT start answering history reads:
     * an existence opinion is not a statement about a timeline. */
    const h = historyHarness()
    h.setBaseAnswer({events: {[BRANCH_PUBLISHED]: [{id: 'e1'}]}, nextCursor: ''})
    const answer = await (h.wrapped.request as (r: unknown) => Promise<unknown>)({
      url: `/data/history/${DATASET}/events/documents/${BRANCH_PUBLISHED}`,
    })
    expect(h.delegated).toHaveLength(1)
    expect((answer as Rec).events).toEqual({[BRANCH_PUBLISHED]: [{id: 'e1'}]})
    expect(h.messages).toEqual([])
  })
})

/* ================================================================== *
 * 7. §18.2 — a branch-published document SUPPRESSES the base draft
 *
 * Found live, 2026-08-11, human validation over the real parity dataset:
 * the base holds `drafts.article-02` ("Article 2 (DRAFT: retitled)"). The
 * editor changed the title and clicked Publish. The branch then held a
 * published body and no draft — and the pane re-read `drafts.article-02`,
 * got NO branch opinion, fell through to base, and displayed the stale
 * upstream draft over the value the branch had just published.
 *
 * PRD §18.2 orders the fallthrough: local draft → local published → base
 * draft. Base draft answers ONLY when the branch holds neither. So when the
 * branch holds a published body and no draft, the draft ADDRESS must be
 * suppressed, not unknown.
 * ================================================================== */

/** Base document the branch has published over; base ALSO holds a draft. */
const OVERRIDDEN = 'article-published-over-base-draft'
const OVERRIDDEN_DRAFT = `drafts.${OVERRIDDEN}`

/** The branch as `GET /state` reports it after §18.5 publish: published body, no draft. */
const BRANCH_PUBLISHED_NO_DRAFT: OverlayHydrationDocument[] = [
  {
    logicalId: OVERRIDDEN,
    schemaType: 'article',
    published: {_id: OVERRIDDEN, _type: 'article', title: 'Branch value', _rev: 'ov-9'},
  },
]

/** Boundary control: the branch holds BOTH — the draft must keep answering. */
const BRANCH_PUBLISHED_AND_DRAFT: OverlayHydrationDocument[] = [
  {
    logicalId: OVERRIDDEN,
    schemaType: 'article',
    published: {_id: OVERRIDDEN, _type: 'article', title: 'Branch value', _rev: 'ov-9'},
    draft: {_id: OVERRIDDEN_DRAFT, _type: 'article', title: 'Branch draft value', _rev: 'ov-10'},
  },
]

/** The stale upstream draft a base read would serve for the draft address. */
const BASE_DRAFT_ANSWER = {
  documents: [
    {_id: OVERRIDDEN_DRAFT, _type: 'article', title: 'STALE base draft', _rev: 'base-2'},
  ],
  omitted: [],
}

describe('§18.2 — branch-published suppresses the base draft', () => {
  it('the view itself: published held, draft address SUPPRESSED, not unknown', () => {
    const view = overlaySourceFromBranch(BRANCH_PUBLISHED_NO_DRAFT)
    expect(view.documents.get(OVERRIDDEN)?.title).toBe('Branch value')
    expect(view.documents.has(OVERRIDDEN_DRAFT)).toBe(false)
    /* THE RED LINE: no opinion means base answers with the stale draft. */
    expect(view.tombstones.has(OVERRIDDEN_DRAFT)).toBe(true)
  })

  it('boundary: a branch that holds a draft keeps serving it — no suppression', () => {
    const view = overlaySourceFromBranch(BRANCH_PUBLISHED_AND_DRAFT)
    expect(view.documents.get(OVERRIDDEN_DRAFT)?.title).toBe('Branch draft value')
    expect(view.tombstones.has(OVERRIDDEN_DRAFT)).toBe(false)
  })

  it('boundary: a draft-only edit leaves the published address to base — no suppression', () => {
    const view = overlaySourceFromBranch([
      {
        logicalId: OVERRIDDEN,
        schemaType: 'article',
        draft: {_id: OVERRIDDEN_DRAFT, _type: 'article', title: 'Branch draft value', _rev: 'ov-3'},
      },
    ])
    expect(view.documents.has(OVERRIDDEN)).toBe(false)
    expect(view.tombstones.has(OVERRIDDEN)).toBe(false)
  })

  it('the pair read the pane makes after publish: base draft must NOT come back', async () => {
    const h = harness(BRANCH_PUBLISHED_NO_DRAFT)
    h.setBaseAnswer(BASE_DRAFT_ANSWER)

    const answer = await ask(h, [OVERRIDDEN_DRAFT, OVERRIDDEN], {excludeContent: 'true'})
    const bodies = documentBodies(answer)

    /* The published body, and ONLY the published body. */
    expect(bodies.map((b) => b._id)).toEqual([OVERRIDDEN])
    expect(bodies[0]?.title).toBe('Branch value')
    /* The stale upstream draft is what the user saw. It must never appear. */
    expect(JSON.stringify(answer)).not.toContain('STALE base draft')
    /* And the draft address reads as NOT EXISTING, not as unanswered. */
    expect(readAvailability(answer, [OVERRIDDEN_DRAFT, OVERRIDDEN])).toEqual({
      [OVERRIDDEN_DRAFT]: false,
      [OVERRIDDEN]: true,
    })
  })

  it('…and base is not even asked: the branch has an opinion about both ids', async () => {
    const h = harness(BRANCH_PUBLISHED_NO_DRAFT)
    h.setBaseAnswer(BASE_DRAFT_ANSWER)
    await ask(h, [OVERRIDDEN_DRAFT, OVERRIDDEN], {query: {excludeContent: 'true'}})
    expect(h.delegated).toEqual([])
  })

  it('§18.6 sibling: after unpublish the draft answers and published is suppressed', () => {
    const view = overlaySourceFromBranch([
      {
        logicalId: OVERRIDDEN,
        schemaType: 'article',
        publishedTombstone: true,
        draft: {_id: OVERRIDDEN_DRAFT, _type: 'article', title: 'Preserved as draft', _rev: 'ov-4'},
      },
    ])
    expect(view.documents.get(OVERRIDDEN_DRAFT)?.title).toBe('Preserved as draft')
    expect(view.tombstones.has(OVERRIDDEN)).toBe(true)
  })
})
