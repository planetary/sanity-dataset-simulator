/**
 * MODE 2 (origin) — THE CORPUS IS READ FROM DISK, NOT REMEMBERED FROM BOOT.
 *
 * THE DEFECT THIS FILE PINS
 * ─────────────────────────
 * `origin.mjs` hydrated its in-memory projection ONCE, in `createOriginHandler`,
 * and thereafter mutated it only inside its own `/data/mutate` and
 * `/data/actions` handlers. That is sound only while the origin is the sole
 * writer of `.sanity-overlay/`, and in the shipped Mode 2 stack it is not:
 *
 *   playwright.config.ts starts `runOrigin.mjs --root=$OVERLAY_ROOT` on :3999
 *   e2e/harness/overlayHarness.mjs starts the overlay API on the SAME root
 *
 * With `sanity-overlay-studio` active, an edit goes to the overlay API's
 * `/commit`, which writes the overlay root. The origin is never told. Its
 * projection therefore stays at whatever the disk held when the process started
 * — for the E2E stack, EMPTY, for the whole run.
 *
 * WHY THAT IS THE WORST KIND OF BUG AND NOT A MISSING FEATURE
 * ──────────────────────────────────────────────────────────
 * The origin is where the Studio facade DELEGATES. A GROQ read the branch
 * planner declines to answer exactly is recorded as a `passthrough` and sent to
 * the data plane — which in Mode 2 is this origin. So a passthrough was not a
 * fallback to a less convenient source; it was a confident `[]` from a source
 * that had been told nothing since boot. PRD §5.5: a query returns the right
 * answer or states that it cannot. An empty array shaped exactly like a real
 * answer is neither.
 *
 * THE USER-VISIBLE SYMPTOM, MEASURED RATHER THAN ASSUMED
 * ─────────────────────────────────────────────────────
 * Studio's reference picker is scored, so `createSearchQuery` emits
 * `… | score(boost(<path> match text::query($__query), <w>), …) [_score > 0] …`.
 * `findability.ts` refuses a TYPED term on the Studio side and says why, so the
 * read is delegated here. The origin implements `text::query` as the right-hand
 * side of a `match` for real (`resolveTextQueries`), so the GROQ is not the
 * problem: booted against a populated root it answers the exact same query with
 * the exact document. Booted before the write, it answers `[]` and reports
 * `matched: 0`. The corpus was the bug.
 *
 * WHAT THE ORACLES ARE
 * ────────────────────
 * Never the value the origin just returned.
 *
 *   - `diskHeads()` opens a SECOND, freshly-constructed `FsOverlayStore` on the
 *     same root and reads the manifest and the document heads. That is the bytes
 *     on disk, reached through no shared object with the handler under test.
 *   - the reference-picker case is proven by asking the RUNNING origin the query
 *     Studio actually sends, over HTTP, and requiring the document back — not by
 *     unit-testing a planner.
 *
 * THE CLASS, NOT THE INSTANCE
 * ───────────────────────────
 * The document corpus is one boot-cached value; every read path that consults it
 * is a separate way to observe the same staleness, and the WRITE path consults
 * it too — `applyTransaction(state, …)` builds the next document from whatever
 * `state` holds, so a stale ancestor is content loss rather than a stale read.
 * Additions, removals, the `/data/doc` batch route, the reported overlay
 * revision and an origin write layered on top of an external one are all
 * exercised below.
 */
import {afterEach, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {createOverlayApi} from '../../sanity-overlay-next/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const OVERLAY_ID = 'origin-corpus-freshness'
const V = '/v2025-02-19'

/**
 * The reference picker's own GROQ.
 *
 * Shape lifted from `createSearchQuery` in `sanity@6.8.0`
 * (`lib/useBundleDocuments-*.js`): `baseMatch` is
 * `([@, _id] match text::query($__query) || references($__rawQuery))`, the score
 * list is `boost(<path> match text::query($__query), <weight>)` per weighted
 * field with `baseMatch` concatenated last, and a scored sort adds
 * `[_score > 0]` and `order(_score desc)`. `findability-mvi:5` is the comment
 * the module prepends to every one.
 */
const REFERENCE_PICKER_QUERY = [
  '// findability-mvi:5',
  '*[_type in $__types] | score(' +
    'boost(_type in ["author"] && name match text::query($__query), 10), ' +
    '([@, _id] match text::query($__query) || references($__rawQuery))' +
    ') [_score > 0] ' +
    '{_type, _id, _originalId, "orderings": [_updatedAt]} | order(_score desc) [0...$__limit]',
].join('\n')

interface Stack {
  readonly baseUrl: string
  readonly root: string
  readonly handler: {close: () => Promise<void>; revision: number; overlayId: string}
  readonly commit: (mutations: unknown[], key: string) => Promise<{status: number; json: any}>
  readonly get: (target: string) => Promise<{status: number; json: any}>
  readonly post: (target: string, body: unknown) => Promise<{status: number; json: any}>
  readonly query: (
    groq: string,
    params?: Record<string, unknown>,
  ) => Promise<{status: number; json: any}>
  readonly diskHeads: () => Promise<{revision: number; logicalIds: string[]}>
  readonly diskDocument: (logicalId: string) => Promise<any>
  readonly stop: () => Promise<void>
}

const live: Array<() => Promise<void>> = []

afterEach(async () => {
  while (live.length > 0) await live.pop()!()
})

/**
 * The shipped Mode 2 stack in miniature: ONE overlay root, the origin in front
 * of it, and the overlay API — the thing the Studio plugin actually writes
 * through — behind the same root. Nothing here is a stub; both halves are the
 * modules `playwright.config.ts` and `overlayHarness.mjs` start.
 */
async function startStack(): Promise<Stack> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-freshness-'))
  const now = (): string => new Date().toISOString()

  const handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: OVERLAY_ID,
  })
  const server: http.Server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: path.join(root, 'log.jsonl'),
    env: {},
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`

  /* The overlay API, on the same root — a SEPARATE store instance, exactly as
   * the two processes in the real stack are separate. */
  const apiStore = new FsOverlayStore({root, now})
  const api = await createOverlayApi({store: apiStore, overlayId: OVERLAY_ID, now, origins: ['*']})

  const stop = async (): Promise<void> => {
    await handler.close()
    await api.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(root, {recursive: true, force: true})
  }
  live.push(stop)

  const get = async (target: string): Promise<{status: number; json: any}> => {
    const response = await fetch(`${baseUrl}${target}`)
    const text = await response.text()
    return {status: response.status, json: text === '' ? null : JSON.parse(text)}
  }
  const post = async (target: string, body: unknown): Promise<{status: number; json: any}> => {
    const response = await fetch(`${baseUrl}${target}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return {status: response.status, json: text === '' ? null : JSON.parse(text)}
  }

  return {
    baseUrl,
    root,
    handler,
    stop,
    get,
    post,

    /** A write through the overlay API — what the Studio plugin does. */
    async commit(mutations, key) {
      const response = await api.handle(
        new Request('http://overlay/commit', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({kind: 'mutations', idempotencyKey: key, payload: {mutations}}),
        }),
      )
      const text = await response.text()
      return {status: response.status, json: text === '' ? null : JSON.parse(text)}
    },

    query(groq, params = {}) {
      const search = new URLSearchParams({query: groq})
      for (const [key, value] of Object.entries(params)) {
        search.set(`$${key}`, JSON.stringify(value))
      }
      return get(`${V}/data/query/${DATASET}?${search.toString()}`)
    },

    /** INDEPENDENT ORACLE — a store constructed now, reading the bytes on disk. */
    async diskHeads() {
      const oracle = new FsOverlayStore({root, now})
      const manifest = await oracle.inspect()
      const heads = await oracle.listChangedDocuments(manifest.overlayId, {includeUnchanged: true})
      return {
        revision: manifest.revision,
        logicalIds: heads.map((head: {logicalId: string}) => head.logicalId).sort(),
      }
    },

    async diskDocument(logicalId) {
      const oracle = new FsOverlayStore({root, now})
      const manifest = await oracle.inspect()
      const read = await oracle.readDocumentByLogicalId(manifest.overlayId, logicalId)
      return read?.record ?? null
    },
  }
}

const AUTHOR = {
  _id: 'drafts.freshness-author',
  _type: 'author',
  name: 'Bornholm Nine',
  bio: 'created through the overlay API, after the origin booted',
}

/* ================================================================== *
 * 1. the corpus — every read path, in both directions
 * ================================================================== */

describe('the Mode 2 corpus follows the overlay root', () => {
  it('a GROQ read sees a document written after the origin booted', async () => {
    const stack = await startStack()

    /* Boot-time truth: nothing anywhere. Establishes that what follows is the
     * write landing and not a document that was already there. */
    expect((await stack.query('*[]{_id}')).json.result).toEqual([])

    const committed = await stack.commit([{create: AUTHOR}], 'freshness-1')
    expect(committed.status).toBe(200)

    /* ORACLE: the bytes on disk, via a store this test just constructed. */
    const disk = await stack.diskHeads()
    expect(disk.logicalIds).toEqual(['freshness-author'])

    const answered = await stack.query('*[]{_id}')
    expect(answered.status).toBe(200)
    expect(answered.json.result).toEqual([{_id: 'drafts.freshness-author'}])
  })

  it('the /data/doc batch route sees it too — not just GROQ', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'freshness-2')

    expect((await stack.diskHeads()).logicalIds).toEqual(['freshness-author'])

    const read = await stack.get(`${V}/data/doc/${DATASET}/drafts.freshness-author`)
    expect(read.status).toBe(200)
    expect(read.json.documents).toHaveLength(1)
    expect(read.json.documents[0]).toMatchObject({_id: 'drafts.freshness-author', name: AUTHOR.name})
    expect(read.json.omitted ?? []).toEqual([])
  })

  it('a document REMOVED through the overlay API stops being answered', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'freshness-3a')
    expect((await stack.query('*[]{_id}')).json.result).toEqual([{_id: 'drafts.freshness-author'}])

    await stack.commit([{delete: {id: 'drafts.freshness-author'}}], 'freshness-3b')

    /* ORACLE: the record on disk now carries a draft tombstone. */
    const record = await stack.diskDocument('freshness-author')
    expect(record?.local?.draftTombstone ?? record?.local?.draft).toBeTruthy()

    expect((await stack.query('*[]{_id}')).json.result).toEqual([])
    const read = await stack.get(`${V}/data/doc/${DATASET}/drafts.freshness-author`)
    expect(read.json.documents).toEqual([])
    expect(read.json.omitted).toHaveLength(1)
  })

  it('the reported overlay revision is the one on disk', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'freshness-4a')
    await stack.commit([{create: {...AUTHOR, _id: 'drafts.freshness-other'}}], 'freshness-4b')

    /* A read is what makes the origin consult the disk; asking for the getter
     * alone would be asking it to poll, which it is not required to do. */
    await stack.query('*[]{_id}')

    const disk = await stack.diskHeads()
    expect(stack.handler.revision).toBe(disk.revision)
  })
})

/* ================================================================== *
 * 1b. the overlay root going away is a STATE, not an error
 * ================================================================== *
 *
 * `e2e/harness/overlayHarness.mjs` `POST /reset` does `rmSync(root)` and then
 * restarts the overlay API against the empty directory — and it does that
 * BEFORE EVERY SINGLE E2E TEST (`e2e/playwright/fixtures.ts`). The origin on
 * :3999 is not restarted, so it observes the whole cycle: a populated root, then
 * no `.sanity-overlay/` at all, then a fresh empty one.
 *
 * The first version of the freshness fix answered 503 for the middle of that
 * cycle, reasoning that "the branch is momentarily not there" and "the branch is
 * empty" are different facts. Run against the real stack it produced 72
 * `OVERLAY_ORIGIN_BRANCH_UNAVAILABLE` responses and took five specs down with
 * it — and the reasoning was wrong on its own terms. In Mode 2 the overlay IS
 * the dataset, so an overlay that does not exist holds zero documents, and `[]`
 * is not a plausible-looking guess there: it is the answer. What §5.5 forbids is
 * a STALE corpus dressed as a fresh one, which is the opposite of this.
 *
 * A write is a different matter and stays loud: `store.commitTransaction`
 * refuses against an overlay that is not there, and the refusal is named.
 */

describe('an overlay root that is wiped and recreated underneath the origin', () => {
  it('answers an empty corpus rather than an error, then picks the new overlay up', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'reset-1')
    expect((await stack.query('*[]{_id}')).json.result).toEqual([
      {_id: 'drafts.freshness-author'},
    ])

    /* Exactly what the harness does between specs. */
    fs.rmSync(path.join(stack.root, '.sanity-overlay'), {recursive: true, force: true})

    const wiped = await stack.query('*[]{_id}')
    expect(wiped.status, 'a wiped root must not read as a server error').toBe(200)
    expect(wiped.json.result).toEqual([])

    const doc = await stack.get(`${V}/data/doc/${DATASET}/drafts.freshness-author`)
    expect(doc.status).toBe(200)
    expect(doc.json.documents).toEqual([])

    /* The overlay API comes back up against the empty root, as the harness's
     * restarted child does, and writes something new. */
    const store = new FsOverlayStore({root: stack.root, now: () => new Date().toISOString()})
    const api = await createOverlayApi({
      store,
      overlayId: OVERLAY_ID,
      now: () => new Date().toISOString(),
      origins: ['*'],
    })
    try {
      const response = await api.handle(
        new Request('http://overlay/commit', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            kind: 'mutations',
            idempotencyKey: 'reset-2',
            payload: {
              mutations: [
                {create: {_id: 'drafts.after-the-reset', _type: 'author', name: 'After the reset'}},
              ],
            },
          }),
        }),
      )
      expect(response.status).toBe(200)
    } finally {
      await api.close()
    }

    /* ORACLE: the bytes on disk, through a store constructed after the reset. */
    expect((await stack.diskHeads()).logicalIds).toEqual(['after-the-reset'])

    const answered = await stack.query('*[]{_id}')
    expect(answered.json.result).toEqual([{_id: 'drafts.after-the-reset'}])
  })
})

/* ================================================================== *
 * 2. the user-visible symptom — Studio's reference picker
 * ================================================================== */

describe("the reference picker's findability query, asked of the running origin", () => {
  it('finds a branch document the overlay API created after boot', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'picker-1')

    /* ORACLE: the document is on disk, under this exact logical id. */
    expect((await stack.diskHeads()).logicalIds).toEqual(['freshness-author'])

    const picked = await stack.query(REFERENCE_PICKER_QUERY, {
      __types: ['author'],
      __query: 'Bornholm*',
      __rawQuery: 'Bornholm',
      __limit: 1001,
    })

    expect(picked.status).toBe(200)
    expect(picked.json.result).toEqual([
      {
        _type: 'author',
        _id: 'drafts.freshness-author',
        _originalId: null,
        orderings: [expect.any(String)],
      },
    ])

    /* §5.5 — a typed term IS an approximation of the hosted index, and it must
     * still say so. It must not say it matched nothing. */
    const approximation = picked.json.overlayApproximation
    expect(approximation).toHaveLength(1)
    expect(approximation[0]).toMatchObject({function: 'text::query', term: 'Bornholm*', matched: 1})
  })

  it('an unfiltered picker (`$__query` = "*") lists the branch', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'picker-2')
    expect((await stack.diskHeads()).logicalIds).toEqual(['freshness-author'])

    const picked = await stack.query(REFERENCE_PICKER_QUERY, {
      __types: ['author'],
      __query: '*',
      __rawQuery: '',
      __limit: 1001,
    })

    expect(picked.json.result.map((row: {_id: string}) => row._id)).toEqual([
      'drafts.freshness-author',
    ])
    /* `"*"` is exact over a corpus that IS the overlay, so nothing is declared. */
    expect(picked.json.overlayApproximation).toBeUndefined()
  })
})

/* ================================================================== *
 * 3. the write path reads the same state — a stale ancestor is content loss
 * ================================================================== */

describe('an origin-side write is applied to the corpus on disk', () => {
  it('keeps the survivors, the tombstone and its own write all three', async () => {
    const stack = await startStack()
    /* Three externally-written documents, one of which is then removed. A
     * corpus that is merely "not empty" cannot pass this: the answer has to be
     * the SURVIVOR plus the origin's own write, with the tombstoned one absent
     * and not resurrected. */
    await stack.commit([{create: AUTHOR}], 'write-1a')
    await stack.commit([{create: {...AUTHOR, _id: 'drafts.freshness-survivor'}}], 'write-1b')
    await stack.commit([{delete: {id: 'drafts.freshness-author'}}], 'write-1c')

    const wrote = await stack.post(`${V}/data/mutate/${DATASET}`, {
      mutations: [{create: {_id: 'drafts.freshness-unrelated', _type: 'author', name: 'Unrelated'}}],
    })
    expect(wrote.status).toBe(200)

    /* ORACLE: on disk, the deleted document is still deleted. */
    const record = await stack.diskDocument('freshness-author')
    expect(record?.local?.draftTombstone ?? record?.local?.draft).toBeTruthy()

    const answered = await stack.query('*[]{_id}')
    expect(answered.json.result.map((row: {_id: string}) => row._id).sort()).toEqual([
      'drafts.freshness-survivor',
      'drafts.freshness-unrelated',
    ])
  })

  it('patches the version the overlay API wrote, not the one it booted with', async () => {
    const stack = await startStack()
    await stack.commit([{create: AUTHOR}], 'write-2a')
    await stack.commit(
      [{patch: {id: 'drafts.freshness-author', set: {bio: 'edited by the overlay API'}}}],
      'write-2b',
    )

    const wrote = await stack.post(`${V}/data/mutate/${DATASET}`, {
      mutations: [{patch: {id: 'drafts.freshness-author', set: {name: 'Edited by the origin'}}}],
    })
    expect(wrote.status).toBe(200)

    /* ORACLE: the document on disk carries BOTH edits. Losing `bio` is the
     * stale-ancestor clobber this test exists for. */
    const record = await stack.diskDocument('freshness-author')
    expect(record.local.draft.materialized).toMatchObject({
      name: 'Edited by the origin',
      bio: 'edited by the overlay API',
    })

    /* …and the origin answers with the merged document, not with whichever half
     * it happened to hold. */
    const answered = await stack.query('*[_id == $id][0]{name, bio}', {
      id: 'drafts.freshness-author',
    })
    expect(answered.json.result).toEqual({
      name: 'Edited by the origin',
      bio: 'edited by the overlay API',
    })
  })
})
