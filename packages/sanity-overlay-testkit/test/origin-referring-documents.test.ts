/**
 * MODE 2 — `/data/references`, THE DELETE-CONFIRM DIALOG'S SECOND HOP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT, measured 2026-08-10 in the local E2E stack:
 *
 *     GET /v2025-02-19/data/references/parity/documents/e2e-actions-delete/to
 *       -> 403   gate: write-guard   refusal: OVERLAY_WRITE_BLOCKED
 *
 * Four specs failed and not one of them mentioned a reference index. What the
 * developer saw was `Delete` and `Unpublish` leaving `tombstones: {draft:
 * false, published: false}` on disk, a document pane rendering "Untitled" with
 * empty fields, and React announcing it would "recreate this component tree
 * from scratch using the error boundary you provided".
 *
 * THE CHAIN, transcribed from `sanity@6.8.0 lib/structureTool-EN0gOzyJ.js`:
 *
 *   :737  `getDocumentExistence` probes `/data/doc/<ds>/<draft>,<published>`
 *         and returns the id to check — or `undefined` when BOTH forms are
 *         omitted for `existence`.
 *   :753  `fetchCrossDatasetReferences` short-circuits to
 *         `{totalCount: 0, references: []}` on `undefined`, and OTHERWISE
 *         requests `/data/references/<ds>/documents/<id>/to`.
 *   :763  that request is wrapped in
 *             catchError(e => { if (isClientError(e) && e.statusCode === 404)
 *                                 return of({totalCount: 0, references: []})
 *                               throw e })
 *
 * So **404 is a contract, not a gap**: Sanity itself reads it as "no
 * cross-dataset references", and rethrows every other status. A 403 propagates
 * out of `referringDocuments`, through the confirm dialog, into the error
 * boundary — and the delete never happens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT WAS UNREACHABLE UNTIL THIS BATCH, which is the whole lesson.
 *
 * Hop 1 gates hop 2. In Mode 2 the origin used to answer every existence probe
 * from a corpus it had projected once at boot — empty for the E2E stack — so
 * `getDocumentExistence` always resolved `undefined` and hop 2 was never
 * issued. The proxy's read allowlist was built from a 422-line log of real
 * Studio traffic, and `/data/references` is not in that log for exactly this
 * reason: the traffic could not reach it.
 *
 * Teaching the overlay to answer existence truthfully (`client/docReads.ts`,
 * `origin.mjs` `refreshFromDisk`) is what made hop 2 reachable — a guard hole
 * that opened because a NEIGHBOURING component stopped lying. No enumerated
 * list of observed requests could have found it; the derived check in
 * `test/write-guard.test.ts` enumerates `/data/<op>` out of the shipped Studio
 * bundle instead, and is the general answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS SANITY'S OWN `catchError`, RUN OVER A REAL `ClientError`.
 *
 * Asserting "the origin answers 404" would be an assertion about our own
 * server. What has to be true is that STUDIO survives the answer, so every case
 * below drives a real `@sanity/client` request through the real proxy and
 * feeds the real rejection to `:763` reimplemented verbatim. The 403 CONTROL
 * runs the identical oracle and shows it rethrowing — a regression test whose
 * oracle cannot produce the original failure is not a regression test.
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
// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {classifyRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'
import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '2025-02-19'
const DOC = 'e2e-actions-delete'

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>}
let client: ReturnType<typeof createClient>

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-references-'))
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-references-test',
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

  /* `useProjectHostname: false` keeps the client on the loopback address the
   * proxy is actually bound to; with it on, @sanity/client would dial
   * `b1n03q3z.127.0.0.1`, which is not a name. Nothing else about the request
   * differs — the path, verb and error shape are the client's own. */
  client = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: V,
    useCdn: false,
    useProjectHostname: false,
    apiHost: baseUrl,
  })
})

afterAll(async () => {
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, {recursive: true, force: true})
})

/** The URL `structureTool-EN0gOzyJ.js:762` builds, character for character. */
const REFERENCES_URL =
  `/data/references/${DATASET}/documents/${DOC}/to` +
  '?excludeInternalReferences=true&excludePaths=true'

/* ------------------------------------------------------------------ *
 * sanity 6.8.0, transcribed
 * ------------------------------------------------------------------ */

/** `structureTool-EN0gOzyJ.js:729`. Deliberately duck-typed, exactly as shipped. */
function isClientError(e: unknown): boolean {
  return typeof e !== 'object' || !e ? false : 'statusCode' in e && 'response' in e
}

type ReferencesAnswer = {totalCount: number; references: unknown[]}

/**
 * `structureTool-EN0gOzyJ.js:763` — the `catchError` around the request.
 * Returns the empty answer on a 404 and RETHROWS anything else.
 */
function crossDatasetReferencesCatch(error: unknown): ReferencesAnswer {
  if (isClientError(error) && (error as {statusCode?: number}).statusCode === 404) {
    return {totalCount: 0, references: []}
  }
  throw error
}

/** One request through the real client, resolved to either an answer or its error. */
async function requestReferences(url: string): Promise<{ok: true; value: unknown} | {ok: false; error: unknown}> {
  try {
    return {ok: true, value: await client.request({url})}
  } catch (error) {
    return {ok: false, error}
  }
}

/* ══════════════════════════════════════════════════════════════════ 1 ══ */

describe('the write guard lets the referring-documents probe through', () => {
  it('classifies it as a READ, with a reason that names the data plane', () => {
    const verdict = classifyRequest({method: 'GET', url: `/v${V}${REFERENCES_URL}`}) as {
      write: boolean
      path: string
      reason: string
    }
    expect(verdict.write).toBe(false)
    expect(verdict.path).toBe(`/data/references/${DATASET}/documents/${DOC}/to`)
    expect(verdict.reason).toMatch(/data-plane read/i)
  })

  it('does not answer 403 — the status that produced the reported failure', async () => {
    const response = await fetch(`${baseUrl}/v${V}${REFERENCES_URL}`)
    expect(response.status).not.toBe(403)
  })

  it('CONTROL: the guard still refuses a WRITE verb on the same path', () => {
    /* Admitting the read must not have admitted the namespace. `/data/references`
     * has no write semantics in Sanity, and default-deny is what says so. */
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((classifyRequest({method, url: `/v${V}${REFERENCES_URL}`}) as {write: boolean}).write).toBe(
        true,
      )
    }
  })
})

/* ══════════════════════════════════════════════════════════════════ 2 ══ */

describe('the origin answers it the one way sanity 6.8.0 knows how to absorb', () => {
  it('answers 404 — which `fetchCrossDatasetReferences` reads as an empty index', async () => {
    const outcome = await requestReferences(REFERENCES_URL)
    expect(outcome.ok, 'Mode 2 has no cross-dataset index and must not pretend to').toBe(false)
    if (outcome.ok) return
    expect((outcome.error as {statusCode?: number}).statusCode).toBe(404)
  })

  it('and the rejection satisfies sanity’s own `isClientError`', async () => {
    /* The duck-type at :729 needs BOTH `statusCode` and `response` on the
     * error. A server whose 404 arrived as a network failure or a bare `Error`
     * would fail the predicate and be rethrown, 404 or not. */
    const outcome = await requestReferences(REFERENCES_URL)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(isClientError(outcome.error)).toBe(true)
  })

  it('so the delete-confirm dialog receives `{totalCount: 0, references: []}`', async () => {
    const outcome = await requestReferences(REFERENCES_URL)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(crossDatasetReferencesCatch(outcome.error)).toEqual({totalCount: 0, references: []})
  })

  it('CONTROL: a 403 on the same hop rethrows — the reported failure, reproduced', () => {
    /* The exact shape the guard used to produce. If the oracle above could not
     * fail, the three cases above would be unfalsifiable. */
    const blocked = Object.assign(new Error('Writes to Content Lake are blocked by the overlay proxy'), {
      statusCode: 403,
      response: {statusCode: 403, body: {error: {code: 'OVERLAY_WRITE_BLOCKED'}}},
    })
    expect(isClientError(blocked)).toBe(true)
    expect(() => crossDatasetReferencesCatch(blocked)).toThrow(/blocked by the overlay proxy/)
  })

  it('CONTROL: a 500 rethrows too — only 404 is absorbed', () => {
    const broken = Object.assign(new Error('origin exploded'), {
      statusCode: 500,
      response: {statusCode: 500, body: {}},
    })
    expect(() => crossDatasetReferencesCatch(broken)).toThrow(/origin exploded/)
  })
})

/* ══════════════════════════════════════════════════════════════════ 3 ══ */

describe('the id shapes the dialog can ask about all reach the origin', () => {
  /*
   * `fetchCrossDatasetReferences` passes whichever id `getDocumentExistence`
   * returned — the PUBLISHED id when both forms exist or only the draft is
   * missing, the DRAFT id otherwise (`:745`). Both must clear the guard, and so
   * must the bare path with no query string, which is what a future caller
   * that drops `excludeInternalReferences` would send.
   */
  it.each([
    [`/data/references/${DATASET}/documents/${DOC}/to`, 'published id, no query string'],
    [`/data/references/${DATASET}/documents/drafts.${DOC}/to`, 'draft id'],
    [REFERENCES_URL, 'published id with the query string structureTool sends'],
  ])('%s — %s', async (url) => {
    expect((classifyRequest({method: 'GET', url: `/v${V}${url}`}) as {write: boolean}).write).toBe(
      false,
    )
    const outcome = await requestReferences(url)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(crossDatasetReferencesCatch(outcome.error)).toEqual({totalCount: 0, references: []})
  })
})
