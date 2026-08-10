/**
 * THE IDEMPOTENCY KEY IS AN IDENTITY, AND AN IDENTITY THAT REPEATS IS A DATA LOSS.
 *
 * `echo.nextTransactionId()` was a closure counter seeded at 0 on every page
 * load, with a suffix that was a pure function of the counter — so EVERY page
 * load emitted `overlay-1-…`, `overlay-2-…` in the same order for ever. The
 * facade uses that value as the `idempotencyKey` of a document action, and the
 * ledger under `.runtime/indexes/idempotency/` is DURABLE. The Nth document
 * action after any reload therefore replayed the Nth of an earlier page load:
 * `200 {"committed": false, "replayed": true}`, nothing applied, and the pane
 * told the editor it had saved.
 *
 * Ordinary edits were never affected — Studio supplies its own uuid
 * `transactionId` for those and the facade prefers it — so this hit exactly the
 * six §18.4-§18.9 document actions plus rebase and checkpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE EXISTING SUITE WAS GREEN THROUGH IT.
 *
 * `studio-echo.test.ts` asserted 1000 ids from ONE echo are distinct — which is
 * true, and is the wrong question. The question is whether two SEPARATE echoes
 * over the same overlay root can collide, and nothing asked it. The e2e specs
 * perform every document action inside one page load and say so in a comment.
 *
 * So every assertion below reads an INDEPENDENT ORACLE: bytes under
 * `.sanity-overlay/`, a second freshly-constructed `FsOverlayStore`, or a
 * separate `GET /state`. Never the response of the call under test — that
 * response is exactly what lied.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {parse} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {createOverlayActionController} from '../../sanity-overlay-studio/src/documentActions'
import {
  wrapWithOverlay,
  type OverlayWriteRecord,
} from '../../sanity-overlay-studio/src/client/facade'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import type {
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'

type Rec = Record<string, unknown>

const OVERLAY_ID = 'studio-idempotency-0000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const BASE_IDENTITY = {projectId: 'b1n03q3z', dataset: 'parity', apiVersion: '2025-02-19'}
const SOURCE_IDENTITY = {repositoryId: 'github:planetary/sanity-branch-overlay', branch: 'test'}

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

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

async function boot(): Promise<{root: string; server: Booted}> {
  const root = await mkdtemp(join(tmpdir(), 'studio-idem-'))
  roots.push(root)
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: BASE_IDENTITY,
    source: SOURCE_IDENTITY,
  })
  running.push(server)
  return {root, server}
}

async function post(server: Booted, route: string, body: unknown): Promise<Rec> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return (await response.json()) as Rec
}

function baseDocument(id: string): Rec {
  return {
    _id: id,
    _type: 'article',
    _rev: 'lake-rev-1',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: `Base ${id}`,
  }
}

/** Seed one edited draft, straight through the API — never through the facade. */
async function seedDraft(server: Booted, id: string, title: string): Promise<void> {
  const answer = await post(server, '/commit', {
    idempotencyKey: `seed-${id}`,
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: `drafts.${id}`,
        publishedId: id,
        patch: {set: {title}},
      },
    ],
    baseDocuments: [baseDocument(id)],
  })
  /* A seed that silently failed would make every assertion below meaningless. */
  if (answer.committed !== true) throw new Error(`seeding ${id} failed: ${JSON.stringify(answer)}`)
}

/**
 * ONE PAGE LOAD.
 *
 * Exactly the wiring `runtime.ts` performs — a fresh echo, a fresh transport
 * over the same `apiUrl`, and a fresh `@sanity/client` object through
 * `wrapWithOverlay`. The client object must be fresh too: `facadeCache` in
 * `facade.ts` is keyed by the client instance, so reusing one would hand back
 * the PREVIOUS load's facade and the previous load's echo, and the test would
 * be simulating nothing at all.
 */
function pageLoad(server: Booted): {
  client: Rec
  writes: OverlayWriteRecord[]
  settled: () => Promise<void>
} {
  const echo = createOverlayEcho()
  const transport = createOverlayTransport({apiUrl: server.url, requestTimeoutMs: 10_000})
  const writes: OverlayWriteRecord[] = []
  let pending: Array<() => void> = []

  const real: Rec = {
    action: (): Promise<unknown> => Promise.reject(new Error('the real client must never be hit')),
    fetch: (): Promise<unknown> => Promise.resolve([]),
    getDocument: (): Promise<unknown> => Promise.resolve(undefined),
    getDocuments: (ids: readonly string[]): Promise<unknown> =>
      Promise.resolve(ids.map(() => null)),
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
  }
  real.withConfig = (): unknown => real
  real.clone = (): unknown => real

  const client = wrapWithOverlay(real, {
    echo,
    transport,
    onWrite: (record) => {
      writes.push(record)
      for (const resolve of pending.splice(0)) resolve()
    },
  }) as Rec

  return {
    client,
    writes,
    /* `blockedResult` answers Studio synchronously and persists afterwards, so
     * the write is only over when the ledger records it. */
    settled: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve)
      }),
  }
}

async function publish(load: ReturnType<typeof pageLoad>, id: string): Promise<void> {
  const done = load.settled()
  await (load.client.action as (actions: unknown[]) => Promise<unknown>)([
    {
      actionType: 'sanity.action.document.publish',
      draftId: `drafts.${id}`,
      publishedId: id,
    },
  ])
  await done
}

/* ─────────────────────────── the independent oracles ─────────────────────── */

/** ORACLE 1 — the bytes on disk, read with `node:fs`. */
async function intentOnDisk(root: string, id: string): Promise<Rec | null> {
  try {
    return parse(
      await readFile(join(root, '.sanity-overlay', 'documents', id, 'intent.json'), 'utf8'),
    ) as Rec
  } catch {
    return null
  }
}

/** ORACLE 2 — a SECOND, freshly-constructed store over the same root. */
async function localBlockFromFreshStore(root: string, id: string): Promise<Rec | undefined> {
  const store = new FsOverlayStore({root, now: makeClock()})
  const read = await store.readDocumentByLogicalId(OVERLAY_ID, id)
  return (read?.record as Rec | undefined)?.local as Rec | undefined
}

/** ORACLE 3 — a separate `GET /state`, on a round trip the Studio never made. */
async function apiState(server: Booted): Promise<{revision: number; documents: Rec[]}> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  return (await response.json()) as {revision: number; documents: Rec[]}
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('a document action after a page reload (PRD §34.6)', () => {
  it('commits, instead of replaying the first action of the previous page load', async () => {
    const {root, server} = await boot()
    await seedDraft(server, 'article-one', 'One')
    await seedDraft(server, 'article-two', 'Two')

    /* PAGE LOAD 1 — publish the first article. */
    const first = pageLoad(server)
    await publish(first, 'article-one')
    expect(first.writes[0]?.committed).toBe('ok')

    /* ── the reload. A new tab, a new echo, the SAME overlay on disk. ── */
    const second = pageLoad(server)
    await publish(second, 'article-two')

    /* ORACLE 1 — the bytes. §13.3's canonical intent carries the branch's
     * opinion per ADDRESS: a seeded, unpublished article holds `draft` and no
     * `published`; a published one holds exactly the opposite. */
    const intent = await intentOnDisk(root, 'article-two')
    expect(intent, 'the overlay holds no intent at all for article-two').not.toBeNull()
    expect(
      intent?.published,
      'article-two was published after a reload but the branch holds no published intent: ' +
        'the commit was swallowed by an idempotency-key collision with page load 1',
    ).toBeTruthy()
    expect(intent?.draft, 'the draft survived a publish').toBeUndefined()

    /* ORACLE 2 — a second store, constructed from nothing but the root. */
    const local = await localBlockFromFreshStore(root, 'article-two')
    expect(local?.published).toBeTruthy()
    expect(local?.draft).toBeNull()

    /* ORACLE 3 — the API, asked separately. Two publishes, two revisions on top
     * of the two seeds. */
    const state = await apiState(server)
    const entry = state.documents.find((document) => document.logicalId === 'article-two')
    expect((entry?.published as Rec | undefined)?.title).toBe('Two')
    expect(entry?.draft ?? null).toBeNull()
  })

  it('sends a different idempotency key on the first action of each page load', async () => {
    const {server} = await boot()
    await seedDraft(server, 'article-one', 'One')
    await seedDraft(server, 'article-two', 'Two')

    const keys: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/commit')) {
        const body = JSON.parse(String(init.body)) as Rec
        if (typeof body.idempotencyKey === 'string') keys.push(body.idempotencyKey)
      }
      return original(input as never, init as never)
    }) as typeof fetch

    try {
      await publish(pageLoad(server), 'article-one')
      await publish(pageLoad(server), 'article-two')
    } finally {
      globalThis.fetch = original
    }

    expect(keys).toHaveLength(2)
    expect(
      keys[0],
      'two page loads issued the same idempotency key, so the second write replays the first',
    ).not.toBe(keys[1])
  })
})

describe('one Studio call that plans two commits (PRD §34.6)', () => {
  /**
   * `planActions` splits one `client.action([...])` into an `actions` commit and
   * a `documentActions` commit whenever the call carries both — which is exactly
   * how sanity 6.8.0 spells "save this edit, then publish it".
   *
   * WHAT THIS TEST IS AND IS NOT. It pins the end-to-end behaviour: both halves
   * of that call reach disk. It does NOT discriminate the per-batch idempotency
   * key, and saying so matters — measured under a deliberately reverted facade,
   * both batches still commit, because `commitMutations` files the caller's key
   * verbatim while `commitDocumentActions` files `${key}#0`, so a shared key
   * misses its own earlier entry by coincidence of routing.
   *
   * The test that DOES discriminate it is `studio-facade.test.ts` "gives every
   * batch of one Studio call its own idempotency key", which asserts the two
   * keys directly and goes red the moment they are collapsed.
   */
  it('lands both halves of a save-then-publish on disk', async () => {
    const {root, server} = await boot()
    await seedDraft(server, 'article-three', 'Three')

    const load = pageLoad(server)
    const done = load.settled()
    await (load.client.action as (actions: unknown[]) => Promise<unknown>)([
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-three',
        publishedId: 'article-three',
        patch: {set: {title: 'Three, edited'}},
      },
      {
        actionType: 'sanity.action.document.publish',
        draftId: 'drafts.article-three',
        publishedId: 'article-three',
      },
    ])
    await done

    /* ORACLE — disk, plus a second store. The edit landed AND the publish did. */
    const intent = await intentOnDisk(root, 'article-three')
    expect(intent?.published, 'the publish half of the call never reached disk').toBeTruthy()
    expect(intent?.draft).toBeUndefined()

    const local = await localBlockFromFreshStore(root, 'article-three')
    const published = local?.published as Rec | undefined
    expect(
      (published?.materialized as Rec | undefined)?.title,
      'the edit half of the call was dropped',
    ).toBe('Three, edited')
  })
})

/* ══════════════════════════ the generators themselves ════════════════════ */

describe('every Studio-side idempotency key is unique across sessions', () => {
  it('gives two independently constructed echoes disjoint transaction ids', () => {
    const left = createOverlayEcho()
    const right = createOverlayEcho()
    const leftIds = new Set(Array.from({length: 50}, () => left.nextTransactionId()))
    const rightIds = Array.from({length: 50}, () => right.nextTransactionId())

    expect(leftIds.size).toBe(50)
    for (const id of rightIds) {
      expect(leftIds.has(id), `${id} was issued by BOTH echoes`).toBe(false)
    }
  })

  /**
   * THE DETERMINISM THE COUNTER BOUGHT IS KEPT — BY INJECTION, NOT BY DEFAULT.
   *
   * The ordinal is still there and still ordered; only the namespace it sits in
   * became unique. A test that wants the old fixed sequence asks for it.
   */
  it('produces a pinned, ordered sequence when the session id is injected', () => {
    const echo = createOverlayEcho({sessionId: 'pinned'})
    expect([echo.nextTransactionId(), echo.nextTransactionId()]).toEqual([
      'overlay-pinned-1',
      'overlay-pinned-2',
    ])
    /* And the injection is what makes it repeat — the default must not. */
    expect(createOverlayEcho({sessionId: 'pinned'}).nextTransactionId()).toBe('overlay-pinned-1')
  })

  /**
   * `documentActions.ts` keyed rebase / checkpoint on `Date.now()` alone, whose
   * own JSDoc calls it "injected so tests are deterministic" — i.e. two page
   * loads with the same injected clock, two tabs in the same millisecond, or one
   * impatient double-click all produced the same key.
   */
  it('gives two action controllers different keys even on an identical clock', async () => {
    const keys: string[] = []
    const transport = {
      apiUrl: 'http://overlay.test',
      commit: async (): Promise<OverlayTransportResult> => ({outcome: 'ok', retryable: false}),
      operation: async (request: {idempotencyKey: string}): Promise<OverlayTransportResult> => {
        keys.push(request.idempotencyKey)
        return {outcome: 'ok', retryable: false, body: {checkpoint: {directory: '/tmp/x'}}}
      },
      resolve: async (): Promise<OverlayTransportResult> => ({outcome: 'ok', retryable: false}),
      state: async (): Promise<OverlayTransportResult> => ({outcome: 'ok', retryable: false}),
    } as unknown as OverlayTransport

    const make = (): ReturnType<typeof createOverlayActionController> =>
      createOverlayActionController({
        kind: 'checkpoint',
        transport,
        refresh: async () => {},
        documents: [{logicalId: 'article-1', schemaType: 'article'}],
        conflicts: {summary: {total: 0, hard: 0, soft: 0}, documents: []} as never,
        /* The pinned clock every existing test injects. */
        now: () => 1_000,
      })

    for (const controller of [make(), make()]) {
      const description = controller.describe({id: 'article-1', type: 'article'})
      description?.onHandle?.()
      const dialog = controller.describe({id: 'article-1', type: 'article'})?.dialog
      if (dialog !== undefined && dialog !== false) {
        await (dialog as {onConfirm: () => Promise<void>}).onConfirm()
      }
    }

    expect(keys).toHaveLength(2)
    expect(keys[0], 'two page loads produced the same operation key').not.toBe(keys[1])
  })
})

/* ═════════════════════════ `replayed` must be visible ════════════════════ */

describe('a replay is reported, never rendered as a fresh save', () => {
  function fakeClient(): Rec {
    const self: Rec = {
      fetch: (): Promise<unknown> => Promise.resolve([]),
      getDocument: (): Promise<unknown> => Promise.resolve(undefined),
      getDocuments: (ids: readonly string[]): Promise<unknown> =>
        Promise.resolve(ids.map(() => null)),
      createOrReplace: (): Promise<unknown> =>
        Promise.reject(new Error('the real client must never be hit')),
      config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    }
    self.withConfig = (): unknown => self
    self.clone = (): unknown => self
    return self
  }

  it('names the replay in the runtime messages and on the status panel', async () => {
    const messages: string[] = []
    const runtime = createOverlayRuntime({
      resolved: resolveOverlayOptions({mode: 'fs', apiUrl: 'http://overlay.test'}, {}),
      createClient: () => fakeClient(),
      onLog: (message) => messages.push(message),
      /* The exact shape the ledger answers a repeated key with. */
      fetch: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            committed: false,
            replayed: true,
            overlayId: OVERLAY_ID,
            revision: 7,
            transactionId: 'tx-from-a-previous-page-load',
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        )) as typeof fetch,
    })

    const client = runtime.clientFactory({}) as Rec
    await (client.createOrReplace as (document: Rec) => Promise<unknown>)({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'typed just now',
    })

    const deadline = Date.now() + 2_000
    while (!/replay/i.test(messages.join('\n')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(
      messages.join('\n'),
      'the overlay replayed the write and nothing said so anywhere',
    ).toMatch(/replay/i)

    const line = runtime.status().lines.find((entry) => /replay/i.test(entry.label))
    expect(line, 'the status panel does not mention the replay at all').toBeDefined()
    expect(line?.value).toMatch(/1/)
  })
})
