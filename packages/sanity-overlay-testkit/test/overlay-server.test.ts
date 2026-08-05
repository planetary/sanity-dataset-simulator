/**
 * SPIKE A — persistence for the Studio write facade (PRD §36.1 Track A, §14).
 *
 * Two units are under test, and they are deliberately separate:
 *
 * 1. `overlayTranslate.ts` — the **pure** browser→store translation. It turns an
 *    intercepted Studio write (Actions API payload or raw `mutate` body) into the
 *    PRD §13.7 `OverlayMutation` shape. It touches no DOM, no network and no
 *    filesystem, so it is unit-testable without a browser — which is the whole
 *    point of extracting it out of `localEcho.ts`.
 *
 * 2. `overlayServer.mjs` — the minimal HTTP JSON API in front of
 *    {@link FsOverlayStore}. Its job is the milestone: an edit typed in Studio
 *    must exist on disk, and must come back after a reload *and* after a server
 *    restart.
 *
 * Assertion discipline: every persistence claim is checked by reading the
 * canonical file from disk with `node:fs`, never by trusting the server's own
 * response body. A server that lied about what it wrote would pass the second
 * kind of assertion and fail the first.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {isSyntheticRev, parse} from '../../sanity-overlay-core/src/index'
import type {CheckpointDocumentIntent} from '../../sanity-overlay-store-fs/src/index'
import {
  parseSanityPath,
  translateInterceptedWrite,
} from '../../../examples/kitchen-sink/spikeA/overlayTranslate'
import {startOverlayServer} from '../../../examples/kitchen-sink/spikeA/overlayServer.mjs'

/**
 * Per-test budget (ms).
 *
 * These tests boot a real overlay server on a real port, drive real HTTP through
 * it and write to a real temp directory. Measured worst case over six full-suite
 * runs: 3.28 s against vitest's 5 s default — 66 % of budget with the machine
 * otherwise idle, and the whole repository shares one worker pool.
 *
 * Nothing here waits on a guessed duration: `until()` below polls a predicate and
 * `settle()` drains the task queue, so a bigger budget changes no assertion — it
 * only stops a busy machine from being reported as a server defect.
 */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'spike-a-overlay-000000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const roots: string[] = []
const running: Array<{close: () => Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spike-a-overlay-'))
  roots.push(root)
  return root
}

/** A monotonic injected clock — the store must never read a wall clock itself. */
function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

interface Booted {
  url: string
  port: number
  close(): Promise<void>
}

interface BeforeRenameHook {
  beforeRename(info: {tempPath: string; targetPath: string}): void | Promise<void>
}

async function boot(root: string, hooks?: BeforeRenameHook): Promise<Booted> {
  const server = (await startOverlayServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    hooks,
  })) as Booted
  running.push(server)
  return server
}

/** Resolve once `predicate` holds, so a test never sleeps on a guessed duration. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Drain the microtask queue and a few macrotasks, so "still pending" means
 * genuinely pending rather than "not scheduled yet".
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Track whether a promise has settled, without consuming its result. */
function watch<T>(promise: Promise<T>): {settled: () => boolean; promise: Promise<T>} {
  let settled = false
  const tracked = promise.then(
    (value) => {
      settled = true
      return value
    },
    (error) => {
      settled = true
      throw error
    },
  )
  /* The caller may assert on `settled` long before it awaits `tracked`; without
   * this no-op handler a rejection in between is an unhandled rejection of the
   * test's own making. */
  void tracked.catch(() => undefined)
  return {settled: () => settled, promise: tracked}
}

/** The published document Studio already holds when the user starts typing. */
const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

/** Exactly the payload `client.observable.action(...)` carries for a field edit. */
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

async function postCommit(
  server: Booted,
  body: Record<string, unknown>,
): Promise<{status: number; json: Record<string, unknown>; headers: Headers}> {
  const response = await fetch(`${server.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  }
}

async function getState(server: Booted): Promise<Record<string, any>> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, any>
}

/** Read the canonical, review-facing intent straight off disk (PRD §14.2). */
async function readIntent(root: string, logicalId: string): Promise<CheckpointDocumentIntent> {
  const path = join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json')
  return parse(await readFile(path, 'utf8')) as CheckpointDocumentIntent
}

/* ------------------------------------------------------------------ *
 * The pure translation (browser → PRD §13.7 mutations)
 * ------------------------------------------------------------------ */

describe('intercepted Studio write → overlay mutation translation', () => {
  it('parses Sanity patch paths into PRD §13.6 overlay paths', () => {
    expect(parseSanityPath('title')).toEqual(['title'])
    expect(parseSanityPath('meta.seo.title')).toEqual(['meta', 'seo', 'title'])
    expect(parseSanityPath('body[0]')).toEqual(['body', 0])
    expect(parseSanityPath('body[_key=="abc"].text')).toEqual(['body', {_key: 'abc'}, 'text'])
    expect(parseSanityPath("body[_key=='abc'].children[2].text")).toEqual([
      'body',
      {_key: 'abc'},
      'children',
      2,
      'text',
    ])
  })

  it('translates an edit action into a draft patch', () => {
    const result = translateInterceptedWrite({kind: 'actions', payload: editAction('Edited')})

    expect(result.unsupported).toEqual([])
    expect(result.documentIds).toEqual(['drafts.article-1'])
    expect(result.mutations).toEqual([
      {
        type: 'patch',
        id: 'drafts.article-1',
        operations: [{type: 'set', path: ['title'], value: 'Edited'}],
      },
    ])
  })

  it('drops the revision precondition — overlay revisions are synthetic (PRD §13.9)', () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {title: 'x'}, ifRevisionID: 'lake-rev-1'},
        },
      ],
    })

    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0]).not.toHaveProperty('ifRevision')
  })

  it("drops Studio's empty-action guard pseudo field and the patch's own id", () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {
            id: 'drafts.article-1',
            unset: ['_empty_action_guard_pseudo_field_'],
            set: {title: 'Kept'},
          },
        },
      ],
    })

    expect(result.mutations).toEqual([
      {
        type: 'patch',
        id: 'drafts.article-1',
        operations: [{type: 'set', path: ['title'], value: 'Kept'}],
      },
    ])
  })

  it('emits nothing for a patch that is only the guard field', () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {unset: ['_empty_action_guard_pseudo_field_']},
        },
      ],
    })

    expect(result.mutations).toEqual([])
    expect(result.unsupported).toEqual([])
  })

  it('translates every raw mutate creation form', () => {
    const document = {_id: 'article-9', _type: 'article', title: 'New'}
    for (const key of ['create', 'createIfNotExists', 'createOrReplace'] as const) {
      const result = translateInterceptedWrite({kind: 'mutations', payload: [{[key]: document}]})
      expect(result.mutations).toEqual([{type: key, document}])
      expect(result.documentIds).toEqual(['article-9'])
    }
  })

  it('translates a raw delete mutation', () => {
    const result = translateInterceptedWrite({
      kind: 'mutations',
      payload: [{delete: {id: 'article-9'}}],
    })
    expect(result.mutations).toEqual([{type: 'delete', id: 'article-9'}])
  })

  it('translates every patch operation kind in Content Lake apply order', () => {
    const result = translateInterceptedWrite({
      kind: 'mutations',
      payload: [
        {
          patch: {
            id: 'drafts.article-1',
            diffMatchPatch: {'body[_key=="b1"].text': '@@ -1 +1 @@'},
            inc: {views: 2},
            dec: {stock: 1},
            insert: {after: 'body[-1]', items: [{_key: 'b2', _type: 'block'}]},
            set: {title: 'S'},
            unset: ['subtitle'],
            setIfMissing: {slug: {current: 'a'}},
          },
        },
      ],
    })

    expect(result.unsupported).toEqual([])
    expect(result.mutations).toEqual([
      {
        type: 'patch',
        id: 'drafts.article-1',
        operations: [
          {type: 'setIfMissing', path: ['slug'], value: {current: 'a'}},
          {type: 'unset', path: ['subtitle']},
          {type: 'set', path: ['title'], value: 'S'},
          {type: 'inc', path: ['views'], amount: 2},
          {type: 'dec', path: ['stock'], amount: 1},
          {
            type: 'insert',
            path: ['body', -1],
            position: 'after',
            items: [{_key: 'b2', _type: 'block'}],
          },
          {type: 'diffMatchPatch', path: ['body', {_key: 'b1'}, 'text'], patch: '@@ -1 +1 @@'},
        ],
      },
    ])
  })

  it('translates a create action, honouring its ifExists mode', () => {
    const attributes = {_id: 'drafts.article-9', _type: 'article', title: 'Fresh'}

    expect(
      translateInterceptedWrite({
        kind: 'actions',
        payload: [
          {actionType: 'sanity.action.document.create', publishedId: 'article-9', attributes},
        ],
      }).mutations,
    ).toEqual([{type: 'create', document: attributes}])

    expect(
      translateInterceptedWrite({
        kind: 'actions',
        payload: [
          {
            actionType: 'sanity.action.document.create',
            publishedId: 'article-9',
            attributes,
            ifExists: 'ignore',
          },
        ],
      }).mutations,
    ).toEqual([{type: 'createIfNotExists', document: attributes}])
  })

  it('translates a delete action into a full delete of the logical document', () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
    })

    /* PRD §18.8: a `delete` mutation tombstones both perspectives, so it is keyed
     * on the published (logical) ID, not on the draft. */
    expect(result.mutations).toEqual([{type: 'delete', id: 'article-1'}])
  })

  it('reports a draft discard as unsupported — it is an action, not a mutation (PRD §18.7)', () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {actionType: 'sanity.action.document.discard', draftId: 'drafts.article-1'},
      ],
    })

    expect(result.mutations).toEqual([])
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]).toContain('sanity.action.document.discard')
  })

  it('reports a publish-style action as unsupported instead of dropping it silently', () => {
    const result = translateInterceptedWrite({
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
    })

    expect(result.mutations).toEqual([])
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]).toContain('sanity.action.document.publish')
  })

  it('reports an unknown write shape as unsupported', () => {
    expect(
      translateInterceptedWrite({kind: 'mutations', payload: [{somethingNew: {id: 'x'}}]})
        .unsupported,
    ).toHaveLength(1)
    expect(
      translateInterceptedWrite({kind: 'actions', payload: [{actionType: 'sanity.action.made.up'}]})
        .unsupported,
    ).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * The overlay server (HTTP → FsOverlayStore → disk)
 * ------------------------------------------------------------------ */

describe('spikeA overlay server', () => {
  it('writes an intercepted edit to the canonical overlay file on disk', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('Edited in Studio'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(200)
    expect(json).toMatchObject({ok: true, committed: true, replayed: false})

    /* The claim under test is on the filesystem, not in the response body. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.logicalId).toBe('article-1')
    expect(intent.type).toBe('article')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Edited in Studio'}])

    const manifest = parse(
      await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ) as {overlayId: string; revision: number; documentHeads: Record<string, unknown>}
    expect(manifest.overlayId).toBe(OVERLAY_ID)
    expect(manifest.revision).toBeGreaterThan(0)
    expect(Object.keys(manifest.documentHeads)).toEqual(['article-1'])
  })

  it('serves a hydration payload the echo layer can replay after a reload', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('Survives reload'),
      baseDocuments: [BASE_ARTICLE],
    })

    const state = await getState(server)
    expect(state.ok).toBe(true)
    expect(state.overlayId).toBe(OVERLAY_ID)
    expect(state.documents).toHaveLength(1)

    const [document] = state.documents
    expect(document.logicalId).toBe('article-1')
    expect(document.schemaType).toBe('article')
    expect(document.draftTombstone).toBe(false)
    expect(document.published).toBeNull()
    /* Materialized draft, addressed as Studio addresses it (PRD §13.9 `_id`). */
    expect(document.draft._id).toBe('drafts.article-1')
    expect(document.draft.title).toBe('Survives reload')
    expect(typeof document.draft._rev).toBe('string')

    /* Hydration and disk agree — no in-memory-only state. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Survives reload'}])
  })

  it('answers a CORS preflight from the Studio origin', async () => {
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

    /* The actual request carries the header too, otherwise the browser drops the
     * response after a successful preflight. */
    const {headers} = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('CORS'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
  })

  it('keeps overlay state across a server restart on the same root', async () => {
    const root = await makeRoot()

    const first = await boot(root)
    await postCommit(first, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('Written before the restart'),
      baseDocuments: [BASE_ARTICLE],
    })
    await first.close()
    running.length = 0

    const second = await boot(root)
    const state = await getState(second)
    expect(state.documents).toHaveLength(1)
    expect(state.documents[0].draft.title).toBe('Written before the restart')

    /* A restarted server keeps writing onto the same record rather than starting
     * a second, parallel one. */
    const {json} = await postCommit(second, {
      idempotencyKey: 'session-b:local-echo-1',
      kind: 'actions',
      payload: editAction('Written after the restart'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([
      {path: ['title'], value: 'Written after the restart'},
    ])
    const after = await getState(second)
    expect(after.documents).toHaveLength(1)
    expect(after.documents[0].draft.title).toBe('Written after the restart')
  })

  it('replays a repeated idempotency key instead of committing twice (PRD §34.6)', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const body = {
      idempotencyKey: 'session-a:local-echo-7',
      kind: 'actions',
      payload: editAction('Once'),
      baseDocuments: [BASE_ARTICLE],
    }

    const first = await postCommit(server, body)
    const second = await postCommit(server, body)

    expect(first.json).toMatchObject({ok: true, committed: true, replayed: false})
    expect(second.json).toMatchObject({ok: true, replayed: true})
    expect(second.json.revision).toBe(first.json.revision)
  })

  it('reports an untranslatable write loudly rather than dropping it', async () => {
    const server = await boot(await makeRoot())

    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-2',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(200)
    expect(json).toMatchObject({ok: true, committed: false})
    expect(json.unsupported).toHaveLength(1)
  })

  it('rejects a malformed commit body with a structured error', async () => {
    const server = await boot(await makeRoot())

    const response = await fetch(`${server.url}/commit`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: '{not json',
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {ok: boolean; error: {message: string}}
    expect(body.ok).toBe(false)
    expect(typeof body.error.message).toBe('string')

    const missingKey = await postCommit(server, {
      kind: 'actions',
      payload: editAction('No key'),
    })
    expect(missingKey.status).toBe(400)
    expect(missingKey.json.ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Regression class — a non-ASCII diffMatchPatch must reach disk intact
 * ------------------------------------------------------------------ *
 *
 * The live failure this pins: typing ` — OVERLAY EDIT` after `Article 1` in a
 * real Studio produced a `diffMatchPatch` whose hunk header counts UTF-8 bytes.
 * Core counted UTF-16 code units, so `length2 25` was measured as 23, the patch
 * was rejected, and the edit never reached disk. Studio's autosave has nowhere
 * to show a commit error, so the user simply lost the character they typed.
 *
 * `test/core-dmp-unicode.test.ts` pins the unit. This pins the whole *path*:
 * Studio-shaped action → HTTP → `translateInterceptedWrite` → `applyTransaction`
 * → `FsOverlayStore` → `documents/<id>/intent.json`. Every assertion reads that
 * file back with `node:fs`; a server that answered `committed: true` while
 * writing nothing — or writing mojibake — passes an assertion on its own
 * response body and fails these.
 */

/** Exactly the payload `client.observable.action(...)` carries for a dmp edit. */
function diffMatchPatchAction(patch: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      patch: {diffMatchPatch: {title: patch}},
    },
  ]
}

function articleTitled(title: string): Record<string, unknown> {
  return {...BASE_ARTICLE, title}
}

/**
 * Patches emitted by `@sanity/diff-match-patch@3.2.0` — the library Studio
 * itself ships — and pasted in verbatim. No value here was computed by the code
 * under test.
 */
const DMP_OVER_HTTP: ReadonlyArray<{
  readonly name: string
  readonly base: string
  readonly patch: string
  readonly expected: string
}> = [
  {
    /* THE live-session patch, byte for byte. This exact string is what failed in
     * the browser; `length2` is 25 bytes for 23 code units. */
    name: 'the em dash Studio actually sent',
    base: 'Article 1',
    patch: '@@ -2,8 +2,25 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n',
    expected: 'Article 1 — OVERLAY EDIT',
  },
  {
    name: 'an emoji, which dmp charges 7 bytes for the surrogate pair',
    base: 'Release party is tonight ok',
    patch: '@@ -6,16 +6,24 @@\n se party\n+ %F0%9F%8E%89\n  is toni\n',
    expected: 'Release party \u{1F389} is tonight ok',
  },
  {
    name: 'CJK, at 3 bytes per character',
    base: 'Chapter one starts here now',
    patch: '@@ -4,16 +4,23 @@\n pter one\n+ %E4%B8%96%E7%95%8C\n  starts \n',
    expected: 'Chapter one 世界 starts here now',
  },
  {
    /* Two hunks, the first inserting an astral character: hunk 2's start is
     * measured in the text hunk 1 already produced, so a byte/character mix-up
     * *or* an absolute-start reading lands the `Y` in the wrong place — and
     * silently, because the context still matches there. */
    name: 'a multi-hunk patch whose second start rolls over an astral insertion',
    base: `alpha e beta${'PAD'.repeat(19)} omega x delta`,
    patch:
      '@@ -1,15 +1,21 @@\n alpha \n-e\n+%F0%9F%8E%89\n  betaPAD\n@@ -79,9 +79,9 @@\n ega \n-x\n+Y\n  del\n',
    expected: `alpha \u{1F389} beta${'PAD'.repeat(19)} omega Y delta`,
  },
]

describe('spikeA overlay server — a non-ASCII diffMatchPatch lands on disk', () => {
  for (const fixture of DMP_OVER_HTTP) {
    it(`commits ${fixture.name}`, async () => {
      const root = await makeRoot()
      const server = await boot(root)

      const {status, json} = await postCommit(server, {
        idempotencyKey: 'session-a:local-echo-dmp',
        kind: 'actions',
        payload: diffMatchPatchAction(fixture.patch),
        baseDocuments: [articleTitled(fixture.base)],
      })

      /* Asserted together so a rejection reports the core error verbatim rather
       * than a bare `expected 400 to be 200`. The live session failed exactly
       * here, with `OVERLAY_DMP_PATCH_INVALID: Hunk declares length2 25 but its
       * context and insertions total 23`. */
      expect({status, error: json.error}).toEqual({status: 200, error: undefined})
      expect(json).toMatchObject({ok: true, committed: true})

      /* The claim under test, read back off the filesystem. */
      const intent = await readIntent(root, 'article-1')
      expect(intent.draft?.overrides).toEqual([{path: ['title'], value: fixture.expected}])
    })
  }

  it('writes the em dash as UTF-8 bytes, not mojibake or an escape', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-dmp',
      kind: 'actions',
      payload: diffMatchPatchAction('@@ -2,8 +2,25 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n'),
      baseDocuments: [BASE_ARTICLE],
    })

    /* Compared as raw bytes, so the claim cannot be satisfied by a decode that
     * happens to be symmetric with a broken encode. `TextEncoder` is the oracle
     * rather than core's own `utf8Encode`, so the two sides are independent;
     * U+2014 must appear as E2 80 94. */
    const bytes = new Uint8Array(
      await readFile(join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json')),
    )
    const expected = new TextEncoder().encode('Article 1 \u{2014} OVERLAY EDIT')

    const found = bytes.some((_byte, at) =>
      expected.every((byte, index) => bytes[at + index] === byte),
    )
    expect(found).toBe(true)
  })

  it('survives a restart — the patched value is rehydrated from disk, not memory', async () => {
    const root = await makeRoot()

    const first = await boot(root)
    await postCommit(first, {
      idempotencyKey: 'session-a:local-echo-dmp',
      kind: 'actions',
      payload: diffMatchPatchAction('@@ -2,8 +2,25 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n'),
      baseDocuments: [BASE_ARTICLE],
    })
    await first.close()
    running.length = 0

    const second = await boot(root)
    const state = await getState(second)
    expect(state.documents[0].draft.title).toBe('Article 1 — OVERLAY EDIT')
  })

  it('still refuses a patch whose context genuinely does not match', async () => {
    const server = await boot(await makeRoot())

    /* The live patch against a different base. The byte-aware engine must not
     * have become "accept everything": a mismatch is a loud failure, because
     * §17.9 makes the applied string the stored value. */
    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-dmp',
      kind: 'actions',
      payload: diffMatchPatchAction('@@ -2,8 +2,25 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n'),
      baseDocuments: [articleTitled('Something else entirely — really')],
    })

    /* 400, not 500: the server maps a core error carrying a `code` onto a
     * structured client error. What matters is *which* code — a byte-aware
     * engine must reject this as a context mismatch, never as a bad patch and
     * never at all. */
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect((json.error as {code: string}).code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })
})

/* ------------------------------------------------------------------ *
 * Regression class — no store work may outlive the request that started it
 * ------------------------------------------------------------------ *
 *
 * The bug these pin: the commit was issued as a detached promise
 * (`void store.commitTransaction(...)`), so the server answered 200 while the
 * write was still in flight. Two things follow, and both are silent:
 *
 *   - the browser is told an edit is durable before it is on disk, so a reload
 *     (or a `SIGINT`) in that window loses it;
 *   - the orphaned promise escapes every `try` in the server, so a failure
 *     lands as an unhandled rejection rather than an HTTP error. In the test
 *     suite it surfaced as `ENOENT` from `#writeText` *after* the temp root had
 *     been removed — the store was still writing into a deleted directory.
 *
 * So the class is: every async path a request starts must be finished, or
 * reported, before the thing that started it claims to be done. That is the
 * response for `/commit`, and `close()` for the server as a whole. The gate is
 * the store's own `beforeRename` hook, which holds a commit open at its commit
 * point deterministically — no sleeping on a guessed duration.
 */

interface Gate {
  hooks: BeforeRenameHook
  arm(): void
  reached(): boolean
  release(): void
}

/** Hold the *commit point* (the manifest rename) open until `release()`. */
function manifestGate(mode: 'hold' | 'throw' = 'hold'): Gate {
  let armed = false
  let reached = false
  let release: () => void = () => undefined
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    hooks: {
      async beforeRename({targetPath}) {
        /* Only the commit is gated: `createOverlay` writes this same file during
         * boot, long before any request exists. */
        if (!armed || !targetPath.endsWith('manifest.json')) return
        if (mode === 'throw') {
          /* One-shot, so a later request can prove the server recovered. */
          armed = false
          reached = true
          throw new Error('the disk went away mid-commit')
        }
        reached = true
        await open
      },
    },
    arm: () => {
      armed = true
    },
    reached: () => reached,
    release: () => release(),
  }
}

describe('spikeA overlay server — no store work outlives its request', () => {
  it('does not answer a commit until the store has passed its commit point', async () => {
    const root = await makeRoot()
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    const response = watch(
      postCommit(server, {
        idempotencyKey: 'session-a:local-echo-1',
        kind: 'actions',
        payload: editAction('Durable before answered'),
        baseDocuments: [BASE_ARTICLE],
      }),
    )

    await until(gate.reached, 'the store to reach the manifest commit point')
    await settle()

    /* The whole point: a 200 here would be a lie about durability. */
    expect(response.settled()).toBe(false)

    gate.release()
    const {status, json} = await response.promise
    expect(status).toBe(200)
    expect(json).toMatchObject({ok: true, committed: true})

    /* And by the time it *is* answered, the claim is true on disk. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Durable before answered'}])
  })

  it('does not resolve close() while a commit is still writing to disk', async () => {
    const root = await makeRoot()
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    /* Deliberately not awaited: this models the browser tab going away, or the
     * dev server being stopped, mid-commit. */
    const response = watch(
      postCommit(server, {
        idempotencyKey: 'session-a:local-echo-1',
        kind: 'actions',
        payload: editAction('Written while shutting down'),
        baseDocuments: [BASE_ARTICLE],
      }),
    )

    await until(gate.reached, 'the store to reach the manifest commit point')
    const closing = watch(server.close())
    await settle()

    /* A `close()` that resolves here hands the caller a green light to delete
     * the overlay root — which is exactly how the temp-dir teardown started
     * racing a live `#writeText`. */
    expect(closing.settled()).toBe(false)

    gate.release()
    await closing.promise
    running.length = 0

    /* Closed *and* consistent: the in-flight transaction reached its commit
     * point rather than being abandoned half-written. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([
      {path: ['title'], value: 'Written while shutting down'},
    ])

    /* The socket is gone with the server, so this request has no answer; it is
     * awaited only so the test owns its outcome instead of leaking it. */
    await response.promise.catch(() => undefined)
  })

  it('answers a commit that fails inside the store with an error, not a rejection', async () => {
    const root = await makeRoot()
    const gate = manifestGate('throw')
    const server = await boot(root, gate.hooks)
    gate.arm()

    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('Never lands'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(gate.reached()).toBe(true)
    expect(status).toBe(500)
    expect(json.ok).toBe(false)
    expect(String((json.error as {message: string}).message)).toContain('the disk went away')

    /* A failed commit must not be reported as overlay state. */
    const state = await getState(server)
    expect(state.documents).toEqual([])
    expect(state.revision).toBe(0)
  })

  it('keeps serving after a failed commit, and the retry lands', async () => {
    const root = await makeRoot()
    const gate = manifestGate('throw')
    const server = await boot(root, gate.hooks)
    gate.arm()

    const failed = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-1',
      kind: 'actions',
      payload: editAction('Never lands'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(failed.json.ok).toBe(false)

    /* The commit queue must survive a rejected task — one poisoned write cannot
     * be allowed to wedge every later autosave. */
    const retry = await postCommit(server, {
      idempotencyKey: 'session-a:local-echo-2',
      kind: 'actions',
      payload: editAction('Lands on retry'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(retry.json).toMatchObject({ok: true, committed: true})
  })
})

/* ------------------------------------------------------------------ *
 * Reads — resolving the overlay, not merely recording it
 * ------------------------------------------------------------------ *
 *
 * Writes were solved first, and the result was a Studio that could *save* into a
 * store the rest of it could not *see*: rename a document and the list pane still
 * showed the old title, a branch-created document appeared nowhere, and every
 * reference picker showed staging values. `POST /resolve` closes that: given the
 * IDs a reader is asking about and whatever base documents it already holds, the
 * server answers with the virtual documents — core's own §18.1/§18.2 resolution
 * run over the records on disk.
 *
 * The server owns no read semantics either. `resolveDocumentBatch` /
 * `resolveVersionBatch` do the resolving; this endpoint is HTTP plus the base
 * source, exactly as `/commit` is HTTP plus the store.
 */

interface ResolveEntry {
  requestedId: string
  logicalId: string
  documentId: string
  document: Record<string, any> | null
  source: string
  absence: string | null
  origin: string
}

interface ResolveResponse {
  ok?: boolean
  mode?: string
  perspective?: string
  revision?: number
  entries?: ResolveEntry[]
  documents?: Record<string, any>[]
  missing?: string[]
  addedIds?: string[]
  conflicts?: unknown[]
  error?: {code: string; message: string}
}

async function postResolve(
  server: Booted,
  body: Record<string, unknown>,
): Promise<{status: number; json: ResolveResponse; headers: Headers}> {
  const response = await fetch(`${server.url}/resolve`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as ResolveResponse,
    headers: response.headers,
  }
}

/** Commit one Studio-shaped field edit and assert it landed. */
async function editTitle(server: Booted, key: string, title: string): Promise<void> {
  const {json} = await postCommit(server, {
    idempotencyKey: key,
    kind: 'actions',
    payload: editAction(title),
    baseDocuments: [BASE_ARTICLE],
  })
  expect(json).toMatchObject({ok: true, committed: true})
}

describe('spikeA overlay server — POST /resolve', () => {
  it('returns the branch title for a document the branch renamed', async () => {
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-r:1', 'Renamed in the branch')

    const {status, json} = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.entries?.[0]?.document?.title).toBe('Renamed in the branch')
    expect(json.entries?.[0]?.origin).toBe('overlay')
    /* Base still says "Article 1" — the server did not simply echo what it was
     * handed. */
    expect(BASE_ARTICLE.title).toBe('Article 1')
  })

  it('passes an untouched document straight through from the supplied base', async () => {
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-r:1', 'Renamed in the branch')

    const other = {...BASE_ARTICLE, _id: 'article-9', _rev: 'lake-rev-9', title: 'Untouched nine'}
    const {json} = await postResolve(server, {
      ids: ['article-9'],
      perspective: 'drafts',
      baseDocuments: [other],
    })

    expect(json.entries?.[0]?.document?.title).toBe('Untouched nine')
    expect(json.entries?.[0]?.origin).toBe('untouched')
  })

  it('reports a locally deleted document as absent, never as stale base content', async () => {
    const server = await boot(await makeRoot())

    const {json: deleted} = await postCommit(server, {
      idempotencyKey: 'session-r:del',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    expect(deleted).toMatchObject({ok: true, committed: true})

    for (const perspective of ['published', 'drafts']) {
      const {json} = await postResolve(server, {
        ids: ['article-1'],
        perspective,
        baseDocuments: [BASE_ARTICLE],
      })

      expect(json.entries?.[0]?.document).toBeNull()
      expect(json.entries?.[0]?.absence).toBe('tombstone')
      expect(json.missing).toEqual(['article-1'])
      expect(json.documents).toEqual([])
      expect(JSON.stringify(json)).not.toContain('Article 1')
    }
  })

  it('returns a branch-created document that base has never held', async () => {
    const server = await boot(await makeRoot())

    const {json: created} = await postCommit(server, {
      idempotencyKey: 'session-r:new',
      kind: 'mutations',
      payload: [
        {create: {_id: 'drafts.article-new', _type: 'article', title: 'Born in the branch'}},
      ],
      baseDocuments: [],
    })
    expect(created).toMatchObject({ok: true, committed: true})

    const {json} = await postResolve(server, {
      ids: ['article-new'],
      perspective: 'drafts',
      baseDocuments: [],
    })

    expect(json.entries?.[0]?.document?.title).toBe('Born in the branch')
    expect(json.entries?.[0]?.origin).toBe('branch-created')
  })

  it('widens a read with the overlay documents of a requested type', async () => {
    /* The list-pane fix: base can never return an ID it has never held, so the
     * *server* has to add branch-created candidates to the set. */
    const server = await boot(await makeRoot())
    await postCommit(server, {
      idempotencyKey: 'session-r:new',
      kind: 'mutations',
      payload: [
        {create: {_id: 'drafts.article-new', _type: 'article', title: 'Born in the branch'}},
        {create: {_id: 'drafts.author-new', _type: 'author', name: 'Nobody'}},
      ],
      baseDocuments: [],
    })

    const {json} = await postResolve(server, {
      ids: ['article-1'],
      types: ['article'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })

    expect(json.addedIds).toEqual(['article-new'])
    expect(json.documents?.map((document) => document._id).sort()).toEqual([
      'article-1',
      'drafts.article-new',
    ])
    /* The author is a different type and must not be smuggled in. */
    expect(JSON.stringify(json)).not.toContain('author-new')
  })

  it('answers by-version IDs the way getDocument does — no draft fallback', async () => {
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-r:1', 'Renamed in the branch')

    const {json} = await postResolve(server, {
      mode: 'version',
      ids: ['article-1', 'drafts.article-1', 'drafts.article-9'],
      baseDocuments: [
        BASE_ARTICLE,
        {...BASE_ARTICLE, _id: 'article-9', _rev: 'lake-rev-9', title: 'Untouched nine'},
      ],
    })

    expect(json.mode).toBe('version')
    /* published untouched, draft carries the branch edit, and a draft that does
     * not exist is null rather than a published document in disguise. */
    expect(json.entries?.map((entry) => entry.document?.title ?? null)).toEqual([
      'Article 1',
      'Renamed in the branch',
      null,
    ])
    expect(json.entries?.[1]?.documentId).toBe('drafts.article-1')
  })

  it('ignores a base document carrying a synthetic overlay revision', async () => {
    /* PRD §13.9: a synthetic `_rev` is something this overlay produced. Feeding
     * it back as base would make the overlay its own merge ancestor. The overlay
     * record must answer instead — silently trusting the echo would be a loop. */
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-r:1', 'Renamed in the branch')

    /* The §13.9 spelling, written out rather than computed — and checked against
     * core's own recogniser, so a format change fails here loudly instead of
     * quietly turning this into a test of nothing. */
    const SYNTHETIC = 'overlay.1.0123456789ab'
    expect(isSyntheticRev(SYNTHETIC)).toBe(true)

    const echoed = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [{...BASE_ARTICLE, _rev: SYNTHETIC, title: 'Echoed back'}],
    })

    expect(echoed.json.entries?.[0]?.document?.title).toBe('Renamed in the branch')
    expect(JSON.stringify(echoed.json)).not.toContain('Echoed back')
  })

  it('reads the overlay off disk after a restart', async () => {
    const root = await makeRoot()
    const first = await boot(root)
    await editTitle(first, 'session-r:1', 'Survives the restart')
    await first.close()
    running.length = 0

    const second = await boot(root)
    const {json} = await postResolve(second, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    expect(json.entries?.[0]?.document?.title).toBe('Survives the restart')
  })

  it('reports the overlay revision the answer was resolved at', async () => {
    const server = await boot(await makeRoot())
    const before = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    await editTitle(server, 'session-r:1', 'Bumped')
    const after = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })

    expect(before.json.revision).toBe(0)
    expect(after.json.revision).toBeGreaterThan(0)
  })

  it('grants CORS to the Studio origin and answers the preflight', async () => {
    const server = await boot(await makeRoot())
    const {status, headers} = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    /* Status asserted too: a 404 also carries CORS headers, so the header check
     * alone would pass against a server with no `/resolve` route at all. */
    expect(status).toBe(200)
    expect(headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)

    const preflight = await fetch(`${server.url}/resolve`, {
      method: 'OPTIONS',
      headers: {origin: STUDIO_ORIGIN},
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
  })

  it('rejects a malformed resolve request with a structured error', async () => {
    const server = await boot(await makeRoot())

    const noIds = await postResolve(server, {perspective: 'drafts'})
    expect(noIds.status).toBe(400)
    expect(noIds.json.ok).toBe(false)
    expect(noIds.json.error?.code).toBe('INVALID_REQUEST')

    const badPerspective = await postResolve(server, {ids: ['article-1'], perspective: 'sideways'})
    expect(badPerspective.status).toBe(400)
    expect(badPerspective.json.error?.code).toBe('INVALID_REQUEST')

    const broken = await fetch(`${server.url}/resolve`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: '{not json',
    })
    expect(broken.status).toBe(400)
  })

  it('accepts an empty ID list without inventing a result', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await postResolve(server, {
      ids: [],
      perspective: 'drafts',
      baseDocuments: [],
    })
    expect(status).toBe(200)
    expect(json.entries).toEqual([])
    expect(json.documents).toEqual([])
  })

  it('does not queue behind an in-flight commit, and never sees a half-applied one', async () => {
    /* A read is not a write: making it wait on the commit mutex would stall every
     * pane behind an autosave. What it must never do is observe a transaction
     * that has not reached its commit point. */
    const root = await makeRoot()
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    const commitPromise = watch(
      postCommit(server, {
        idempotencyKey: 'session-r:gated',
        kind: 'actions',
        payload: editAction('Only after the commit point'),
        baseDocuments: [BASE_ARTICLE],
      }),
    )
    await until(gate.reached, 'the store to reach the manifest commit point')

    const during = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    /* Answered — not blocked — and carrying pre-commit state. */
    expect(during.status).toBe(200)
    expect(during.json.entries?.[0]?.document?.title).toBe('Article 1')
    expect(commitPromise.settled()).toBe(false)

    gate.release()
    await commitPromise.promise

    const after = await postResolve(server, {
      ids: ['article-1'],
      perspective: 'drafts',
      baseDocuments: [BASE_ARTICLE],
    })
    expect(after.json.entries?.[0]?.document?.title).toBe('Only after the commit point')
  })
})

/* ------------------------------------------------------------------ *
 * POST /query/plan and POST /query — the GROQ read path (PRD §22)
 * ------------------------------------------------------------------ *
 *
 * WHY THESE LIVE ON THE SERVER AND NOT IN THE BROWSER
 * `sanity-overlay-query` enforces §22.9 `CANDIDATE_LIMIT_EXCEEDED` inside
 * `evaluateOverlayQuery`, and derives the candidate plan that decides what may
 * be fetched at all. Boundedness decided in a browser tab is boundedness a
 * reload can lose, so both sit next to the overlay store. The browser keeps the
 * one job only it can do — it holds the Sanity credential, so it executes the
 * base requests the plan asks for and posts the documents back.
 *
 * The split is visible in these tests: `/query/plan` is asked what to fetch,
 * `/query` is given the documents and returns the answer.
 */

interface PlanResponse {
  ok?: boolean
  supported?: boolean
  reason?: string
  queryId?: string
  baseRequests?: Array<Record<string, unknown>>
  error?: {code: string; message: string}
}

interface QueryResponse {
  ok?: boolean
  result?: unknown
  diagnostics?: Record<string, any>
  error?: {code: string; message: string}
}

async function postJson<T>(
  server: Booted,
  route: string,
  body: Record<string, unknown>,
): Promise<{status: number; json: T}> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {status: response.status, json: (await response.json()) as T}
}

const BASE_DRAFT = {...BASE_ARTICLE, _id: 'drafts.article-1', _rev: 'lake-rev-1d'}
const BASE_ARTICLE_9 = {
  _id: 'article-9',
  _type: 'article',
  _rev: 'lake-rev-9',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 9',
}

/** The shape a live Studio Article list pane actually issues (observed 2026-08-04). */
const LIST_PANE_QUERY =
  '[*[_id in ["drafts.article-1","article-9"]][0...23]{_id,_type,title}][0...1]'

describe('spikeA overlay server — POST /query/plan', () => {
  it('answers with the base requests the credential holder must fetch', async () => {
    const server = await boot(await makeRoot())

    const {status, json} = await postJson<PlanResponse>(server, '/query/plan', {
      query: LIST_PANE_QUERY,
    })

    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.supported).toBe(true)
    expect(json.baseRequests).toEqual([{kind: 'ids', ids: ['drafts.article-1', 'article-9']}])
  })

  it('resolves a parameterised plan against the call parameters', async () => {
    const server = await boot(await makeRoot())
    const {json} = await postJson<PlanResponse>(server, '/query/plan', {
      query: '*[_id == $id][0]',
      params: {id: 'article-1'},
    })
    expect(json.baseRequests).toEqual([{kind: 'ids', ids: ['article-1']}])
  })

  it('reports an unsupported query as data, with a reason — not as an HTTP error', async () => {
    /* §22.5 "[MUST] log unregistered queries" needs the reason to reach the
     * caller so it can be recorded and shown. A 4xx would be indistinguishable
     * from a broken server, and the caller would stop distinguishing "the
     * overlay cannot answer this" from "the overlay is down". */
    const server = await boot(await makeRoot())
    const {status, json} = await postJson<PlanResponse>(server, '/query/plan', {
      query: '*[_type in $t && [@, _id] match text::query($q)]{_id}',
      params: {t: ['article'], q: 'x'},
    })

    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.supported).toBe(false)
    expect(json.reason).toMatch(/text::query/)
    expect(json.baseRequests).toBeUndefined()
  })

  it('rejects a body with no query', async () => {
    const server = await boot(await makeRoot())
    const {status, json} = await postJson<PlanResponse>(server, '/query/plan', {})
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
  })
})

describe('spikeA overlay server — POST /query', () => {
  it('answers the real list-pane shape with the BRANCH title', async () => {
    /* The load-bearing one: a projection, a slice and an outer array wrapper
     * over an ID set the query names literally. Before this, the pane rendered
     * "Article 1" while the overlay held the rename. */
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-q:1', 'RENAMED IN THE BRANCH')

    const {status, json} = await postJson<QueryResponse>(server, '/query', {
      query: LIST_PANE_QUERY,
      baseDocuments: [BASE_DRAFT, BASE_ARTICLE_9],
    })

    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.result).toEqual([
      [
        {_id: 'article-9', _type: 'article', title: 'Article 9'},
        {_id: 'drafts.article-1', _type: 'article', title: 'RENAMED IN THE BRANCH'},
      ],
    ])
  })

  it('includes a branch-created document a base fetch could never return', async () => {
    const server = await boot(await makeRoot())
    await postCommit(server, {
      idempotencyKey: 'session-q:create',
      kind: 'mutations',
      payload: [{create: {_id: 'drafts.article-0', _type: 'article', title: 'BRANCH CREATED'}}],
      baseDocuments: [],
    })

    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_type == "article"]{_id, title}',
      baseDocuments: [BASE_ARTICLE_9],
    })

    expect(json.result).toEqual([
      {_id: 'article-9', title: 'Article 9'},
      {_id: 'drafts.article-0', title: 'BRANCH CREATED'},
    ])
  })

  it('orders a type list by `_id`, not base-then-branch', async () => {
    /* `evaluate.ts` admits base candidates first and branch-created ones after,
     * and an unordered `*[…]` observes that order. A branch-created document
     * whose ID sorts FIRST must still come first, or the pane is reporting where
     * a document came from rather than what it is. */
    const server = await boot(await makeRoot())
    await postCommit(server, {
      idempotencyKey: 'session-q:create-first',
      kind: 'mutations',
      payload: [{create: {_id: 'article-0', _type: 'article', title: 'BRANCH CREATED'}}],
      baseDocuments: [],
    })

    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_type == "article"]{_id}',
      baseDocuments: [BASE_ARTICLE_9],
    })

    expect(json.result).toEqual([{_id: 'article-0'}, {_id: 'article-9'}])
  })

  it('drops a document the branch deleted, instead of its stale base body', async () => {
    const server = await boot(await makeRoot())
    await postCommit(server, {
      idempotencyKey: 'session-q:delete',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })

    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_type == "article"]{_id}',
      baseDocuments: [BASE_ARTICLE, BASE_DRAFT, BASE_ARTICLE_9],
    })

    expect(json.result).toEqual([{_id: 'article-9'}])
  })

  it('reports the package’s diagnostics, so the candidate set is inspectable', async () => {
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-q:diag', 'Renamed')

    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_type == "article"]{_id}',
      baseDocuments: [BASE_ARTICLE, BASE_ARTICLE_9],
    })

    expect(json.diagnostics?.candidateIds).toEqual(['article-1', 'article-9', 'drafts.article-1'])
    expect(json.diagnostics?.evaluatorInvocations).toBe(1)
    expect(json.diagnostics?.exact).toBe(true)
  })

  it('answers an ordered slice exactly, because the candidate set is the whole type', async () => {
    /* An `order()[0…K]` is only exact when nothing outside the candidate set
     * could have sorted into the window. A `types` plan materialises the whole
     * type, so it can — which is why the ordering is left to `groq-js` on the
     * complete set rather than approximated over a base answer. */
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-q:ordered', 'ZZZ LAST')

    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_type == "article"] | order(title asc) [0...2]{title}',
      baseDocuments: [BASE_ARTICLE, BASE_DRAFT, BASE_ARTICLE_9],
    })

    expect(json.result).toEqual([{title: 'Article 1'}, {title: 'Article 9'}])
  })

  it('refuses a query with no derivable candidate plan, with a structured error', async () => {
    /* §22.2: what cannot be evaluated exactly MUST fail structurally. The
     * passthrough licence of §22.5 belongs to the CALLER — it still holds the
     * credential and can ask staging itself — and is not this endpoint's to
     * grant. */
    const server = await boot(await makeRoot())
    const {status, json} = await postJson<QueryResponse>(server, '/query', {
      query: '*',
      baseDocuments: [BASE_ARTICLE],
    })

    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error?.code).toBe('UNSUPPORTED_QUERY')
    expect(json.error?.message).toMatch(/unconstrained/)
  })

  it('never lets a base document carrying a synthetic overlay revision act as base', async () => {
    /* Same guard the write path uses (§13.9): a document this overlay produced
     * cannot be its own merge ancestor. Here it would also let the browser feed
     * an already-overlaid document back in as if staging had said so. */
    const server = await boot(await makeRoot())
    await editTitle(server, 'session-q:synthetic', 'BRANCH')

    const echoed = {...BASE_DRAFT, _rev: 'overlay-local-1', title: 'ECHOED BACK'}
    const {json} = await postJson<QueryResponse>(server, '/query', {
      query: '*[_id == "drafts.article-1"][0]{title}',
      baseDocuments: [echoed],
    })

    expect(json.result).toEqual({title: 'BRANCH'})
  })
})
