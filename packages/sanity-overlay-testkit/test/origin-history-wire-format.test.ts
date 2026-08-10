/**
 * MODE 2 — the three `/data/history` endpoints, in the shapes Studio really
 * decodes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT, observed live 2026-08-09, three-plus times per branch document:
 *
 *     Error fetching events TypeError: Cannot read properties of undefined
 *       (reading 'drafts.e2e-unicode-multihunk')   at getEditEvents
 *
 * `origin.mjs` answered all three history endpoints through `jsonAnswer`, which
 * is right for two of them and wrong for the third:
 *
 *   transactions  `sanity@6.8.0` reads this as **NDJSON**, over the global
 *                 `fetch` (`useBundleDocuments…:4812 getTransactionsLogs` →
 *                 `datastores…:6879 getStream`, which splits the body on "\n"
 *                 and `JSON.parse`s every non-empty line). So the JSON envelope
 *                 `{"transactions":[]}` does not decode to "no transactions":
 *                 it decodes to exactly ONE transaction — the envelope — with
 *                 no `effects`, and `getEditEvents`'s
 *                 `tx.effects[documentId]` throws with the document id in the
 *                 message. That IS the reported error.
 *   events        read as `response.events[documentId]?.map(…) || []`, so
 *                 `events` is an OBJECT KEYED BY DOCUMENT ID. `{events: []}` is
 *                 an array; the `?.` swallows it and every pane silently shows
 *                 no history where it should show none *for a known reason*,
 *                 and `nextCursor: undefined` rides into `loadMore`.
 *   documents     read as `response.documents[0]` with NO optional chaining.
 *                 `{documents: []}` was already right, and is pinned here so it
 *                 stays that way.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS STUDIO'S DECODER, NOT AN ASSERTION ABOUT BYTES.
 *
 * Asserting `body === ''` alone would pass for a server that also answered `''`
 * with `content-type: application/json`, and would say nothing about the crash.
 * So each test below re-implements the decode Studio performs — the newline
 * split, the `tx.effects[documentId]` reach — from the cited sources, runs it
 * over what the origin really served, and additionally runs it over the OLD
 * body to show the same decoder DOES throw. A regression test whose oracle
 * cannot produce the original failure is not a regression test.
 *
 * `packages/sanity-overlay-studio/src/client/history.ts` states the same
 * contract for the client side. It is imported rather than restated so the two
 * cannot drift into disagreeing about what "empty" means.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'
import {
  EMPTY_TRANSLOG_NDJSON,
  emptyOverlayHistoryAnswer,
} from '../../sanity-overlay-studio/src/client/history'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'
const DOC_A = 'drafts.e2e-unicode-multihunk'
const DOC_B = 'e2e-unicode-multihunk'

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-history-'))
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-history-test',
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
})

afterAll(async () => {
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, {recursive: true, force: true})
})

async function get(target: string) {
  const response = await fetch(`${baseUrl}${target}`)
  const text = await response.text()
  return {status: response.status, text, headers: response.headers}
}

/* ------------------------------------------------------------------ *
 * Studio's own decoders, reimplemented from the cited dist sources
 * ------------------------------------------------------------------ */

/**
 * `datastores-DqFH7RLd.js:6879 getStream` — split on "\n", `JSON.parse` every
 * non-empty line, and at EOF parse whatever remains in the buffer as one more.
 */
function decodeNdjson(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const parts = body.split('\n')
  const trailer = parts.pop() ?? ''
  for (const line of parts) {
    if (line === '') continue
    out.push(JSON.parse(line) as Record<string, unknown>)
  }
  if (trailer.trim() !== '') out.push(JSON.parse(trailer) as Record<string, unknown>)
  return out
}

/**
 * `useBundleDocuments-BYW8M9LS.js:4965 getEditEvents` — the exact reach that
 * threw. No optional chaining, deliberately: adding one here would hide the
 * defect this file exists to pin.
 */
function getEditEvents(
  transactions: Array<Record<string, unknown>>,
  documentId: string,
): unknown[] {
  return transactions.filter(
    (tx) => (tx.effects as Record<string, unknown>)[documentId] !== undefined,
  )
}

/** `useBundleDocuments-BYW8M9LS.js:5006` — `response.events[id]?.map(…) || []`. */
function readEvents(response: any, documentId: string): unknown[] {
  return response.events[documentId]?.map((event: unknown) => event) || []
}

/* ══════════════════════════════════════════════════════════════════ 1 ══ */

describe('the transaction log is NDJSON, and an empty one is an empty body', () => {
  const target =
    `${V}/data/history/${DATASET}/transactions/${encodeURIComponent(DOC_A)}` +
    '?excludeContent=true&effectFormat=mendoza'

  it('answers 200 with a body of zero NDJSON lines', async () => {
    const {status, text} = await get(target)
    expect(status).toBe(200)
    /* NDJSON's empty document is zero lines. Imported, not restated: the client
     * package declares this constant and the origin must serve exactly it. */
    expect(text).toBe(EMPTY_TRANSLOG_NDJSON)
  })

  it('declares an NDJSON content type, not JSON', async () => {
    /* A body Studio parses line-by-line, labelled `application/json`, is a
     * server telling every other client the wrong thing about the same bytes. */
    const {headers} = await get(target)
    expect(String(headers.get('content-type'))).toMatch(/ndjson/)
  })

  it('DECODES to zero transactions through Studio’s own stream reader', async () => {
    const {text} = await get(target)
    expect(decodeNdjson(text)).toEqual([])
  })

  it('and `getEditEvents` therefore returns [] instead of throwing', async () => {
    const {text} = await get(target)
    expect(getEditEvents(decodeNdjson(text), DOC_A)).toEqual([])
  })

  it('CONTROL: the old `{"transactions":[]}` body reproduces the reported crash', () => {
    /* The oracle must be able to produce the original failure, or the four
     * assertions above are unfalsifiable. */
    const decoded = decodeNdjson('{"transactions":[]}')
    expect(decoded, 'a JSON envelope on an NDJSON endpoint IS one transaction').toHaveLength(1)
    expect(() => getEditEvents(decoded, DOC_A)).toThrow(
      /Cannot read properties of undefined \(reading '.*e2e-unicode-multihunk'\)/,
    )
  })

  it('CONTROL: so does `[]`, the other plausible "empty"', () => {
    expect(() => getEditEvents(decodeNdjson('[]'), DOC_A)).toThrow(TypeError)
  })
})

/* ══════════════════════════════════════════════════════════════════ 2 ══ */

describe('the events endpoint is an object keyed by document id', () => {
  const target = `${V}/data/history/${DATASET}/events/documents/${encodeURIComponent(DOC_A)},${encodeURIComponent(DOC_B)}`

  it('keys `events` by every id that was asked about', async () => {
    const {status, text} = await get(target)
    expect(status).toBe(200)
    const body = JSON.parse(text)
    expect(Array.isArray(body.events), '`events` is an object, not an array').toBe(false)
    expect(Object.keys(body.events).sort()).toEqual([DOC_B, DOC_A].sort())
    expect(body.events[DOC_A]).toEqual([])
  })

  it('carries a STRING nextCursor, so `loadMore` is not handed undefined', async () => {
    const body = JSON.parse((await get(target)).text)
    expect(typeof body.nextCursor).toBe('string')
  })

  it('reads back as [] through Studio’s own accessor', async () => {
    const body = JSON.parse((await get(target)).text)
    expect(readEvents(body, DOC_A)).toEqual([])
    expect(readEvents(body, DOC_B)).toEqual([])
  })

  it('matches the shape the client package declares for the same read', async () => {
    const body = JSON.parse((await get(target)).text)
    expect(body).toEqual(emptyOverlayHistoryAnswer({kind: 'events', ids: [DOC_A, DOC_B]}))
  })

  it('CONTROL: the old `{events: []}` answers an id it was never keyed by', () => {
    expect(readEvents({events: []}, DOC_A)).toEqual([])
    /* Which is why the assertion above is on the KEYS, not on the read-back:
     * the `?.` makes the wrong shape indistinguishable at the call site. */
    expect(Object.keys([] as unknown as Record<string, unknown>)).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════ 3 ══ */

describe('the documents endpoint keeps the envelope Studio indexes without a guard', () => {
  const target = `${V}/data/history/${DATASET}/documents/${encodeURIComponent(DOC_A)}`

  it('answers `{documents: []}`, so `response.documents[0]` cannot throw', async () => {
    const {status, text} = await get(target)
    expect(status).toBe(200)
    const body = JSON.parse(text)
    expect(body).toEqual(emptyOverlayHistoryAnswer({kind: 'documents', ids: [DOC_A]}))
    expect(() => body.documents[0]).not.toThrow()
    expect(body.documents[0]).toBeUndefined()
  })
})
