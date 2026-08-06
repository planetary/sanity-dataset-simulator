/**
 * `sanity-overlay-next` — the write half of the local API (PRD §37 Phase 2
 * "Local API and client": mutation endpoint, actions endpoint, status endpoint).
 *
 * WHAT IS UNDER TEST
 * A real `node:http` server, bound to a real port, driven by real HTTP round
 * trips, writing to a real temporary directory through the real `FsOverlayStore`.
 * Nothing here is a fake, and every persistence claim is checked by reading the
 * canonical file off disk with `node:fs` — never by trusting the server's own
 * response body. A server that lied about what it wrote would satisfy the
 * response assertions and fail the disk ones.
 *
 * THE BEHAVIOURS THAT MUST NOT REGRESS
 * `examples/kitchen-sink/spikeA/overlayServer.mjs` bought four of these with
 * real defects, and they are re-derived here from first principles rather than
 * inherited:
 *
 *   1. DURABILITY PRECEDES ACKNOWLEDGEMENT. The HTTP response is the browser's
 *      only signal that an edit survived. A response sent before the store
 *      passed its commit point is a lie the user acts on.
 *   2. A REJECTED COMMIT MUST NOT WEDGE THE QUEUE. Studio autosaves faster than
 *      a commit round trip, so commits are serialised; one poisoned write must
 *      not stall every later autosave behind it.
 *   3. `close()` DRAINS. Closing the socket does not cancel a commit already
 *      inside the store; abandoning one half-written leaves immutable artifacts
 *      the manifest never names.
 *   4. IDEMPOTENCY REPLAY (PRD §34.6), and specifically replay BEFORE the
 *      mutation engine runs. The store deduplicates its own writes, so a server
 *      that replayed only at the store would still apply the mutations a second
 *      time to its in-memory projection — and then serve a `/state` that disk
 *      disagrees with. The `inc` case below is the falsifier.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {CheckpointDocumentIntent} from '../../sanity-overlay-store-fs/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayApi, startOverlayApiServer} from '../../sanity-overlay-next/src/index'

/* Real ports, real disk, one shared worker pool. Nothing below sleeps on a
 * guessed duration — `until()` polls a predicate — so a bigger budget changes no
 * assertion, it only stops a busy machine being reported as a server defect. */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'next-api-overlay-0000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-api-'))
  roots.push(root)
  return root
}

/** A monotonic injected clock — nothing under test may read a wall clock. */
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

interface Hooks {
  beforeRename?(info: {tempPath: string; targetPath: string}): void | Promise<void>
}

/**
 * Hold the COMMIT POINT — the manifest rename — open until `release()`.
 *
 * Armed explicitly after boot, because `createOverlay` writes that same file
 * long before any request exists; a gate that fired during boot would only
 * prove the server cannot start.
 */
interface Gate {
  hooks: Hooks
  arm(): void
  reached(): boolean
  release(): void
}

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

async function boot(root: string, hooks?: Hooks): Promise<Booted> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    hooks,
    /* The direct-edit watcher has its own suite; a timer firing mid-commit here
     * would only add noise. */
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  running.push(server)
  return server
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Drain microtasks and a few macrotasks, so "pending" means genuinely pending. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

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
  void tracked.catch(() => undefined)
  return {settled: () => settled, promise: tracked}
}

const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
  views: 1,
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

interface Posted {
  status: number
  json: Record<string, any>
  headers: Headers
}

async function post(server: Booted, route: string, body: unknown): Promise<Posted> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
    headers: response.headers,
  }
}

async function getJson(server: Booted, route: string): Promise<Record<string, any>> {
  const response = await fetch(`${server.url}${route}`, {headers: {origin: STUDIO_ORIGIN}})
  return (await response.json()) as Record<string, any>
}

/** Read the canonical, review-facing intent straight off disk (PRD §14.2). */
async function readIntent(root: string, logicalId: string): Promise<CheckpointDocumentIntent> {
  const path = join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json')
  return parse(await readFile(path, 'utf8')) as CheckpointDocumentIntent
}

async function readManifest(root: string): Promise<Record<string, any>> {
  const path = join(root, '.sanity-overlay', 'manifest.json')
  return parse(await readFile(path, 'utf8')) as Record<string, any>
}

/* ------------------------------------------------------------------ *
 * The endpoint does what it says
 * ------------------------------------------------------------------ */

describe('POST /commit — an intercepted Studio write becomes a file on disk', () => {
  it('writes the canonical intent for an edit action', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const result = await post(server, '/commit', {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: editAction('Edited in the branch'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(result.status).toBe(200)
    expect(result.json.committed).toBe(true)
    expect(result.json.unsupported).toEqual([])

    /* The oracle is the file, not the response. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.logicalId).toBe('article-1')
    expect(intent.type).toBe('article')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Edited in the branch'}])

    const manifest = await readManifest(root)
    expect(manifest.overlayId).toBe(OVERLAY_ID)
    expect(manifest.revision).toBeGreaterThan(0)
    expect(Object.keys(manifest.documentHeads)).toEqual(['article-1'])
  })

  it('rejects a commit with no idempotency key rather than inventing one', async () => {
    const server = await boot(await makeRoot())
    const result = await post(server, '/commit', {kind: 'actions', payload: editAction('x')})
    expect(result.status).toBe(400)
    expect(result.json.ok).toBe(false)
    expect(result.json.error.code).toBe('INVALID_REQUEST')
  })

  it('rejects an unknown commit kind', async () => {
    const server = await boot(await makeRoot())
    const result = await post(server, '/commit', {idempotencyKey: 'k', kind: 'telepathy'})
    expect(result.status).toBe(400)
    expect(result.json.error.code).toBe('INVALID_REQUEST')
  })

  it('reports what it could not translate instead of dropping it silently', async () => {
    const server = await boot(await makeRoot())
    const result = await post(server, '/commit', {
      idempotencyKey: 'k1',
      kind: 'mutations',
      payload: [{delete: {query: '*[_type == "article"]'}}],
    })
    expect(result.status).toBe(200)
    expect(result.json.committed).toBe(false)
    expect(result.json.unsupported).toEqual([expect.stringContaining('delete by query')])
  })
})

/* ------------------------------------------------------------------ *
 * 1. Durability precedes acknowledgement
 * ------------------------------------------------------------------ */

describe('the response is not sent before the store passes its commit point', () => {
  it('holds the HTTP response open across the whole disk write', async () => {
    const root = await makeRoot()

    /* `beforeRename` is the store's own fault-injection surface: it fires after
     * the temp file holds the complete bytes and BEFORE the rename that
     * publishes them. Holding it open holds the commit point open. */
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    const inflight = watch(
      post(server, '/commit', {
        idempotencyKey: 'k1',
        kind: 'actions',
        payload: editAction('Durable'),
        baseDocuments: [BASE_ARTICLE],
      }),
    )

    await until(gate.reached, 'the store to reach its commit point')
    await settle()

    /* The claim. If the response were produced before the write finished, this
     * would already be true. */
    expect(inflight.settled()).toBe(false)

    gate.release()
    const result = await inflight.promise
    expect(result.json.committed).toBe(true)

    /* And the file is there once the caller has been told so. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Durable'}])
  })
})

/* ------------------------------------------------------------------ *
 * 2. A rejected commit must not wedge the queue
 * ------------------------------------------------------------------ */

describe('the commit queue survives a rejected task', () => {
  it('commits the next autosave after one that failed inside the store', async () => {
    const root = await makeRoot()

    const gate = manifestGate('throw')
    const server = await boot(root, gate.hooks)
    gate.arm()

    const poisoned = await post(server, '/commit', {
      idempotencyKey: 'poison',
      kind: 'actions',
      payload: editAction('Never lands'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(poisoned.status).toBeGreaterThanOrEqual(500)
    expect(poisoned.json.ok).toBe(false)

    /* The whole point: the NEXT write still lands. A queue built on a promise
     * chain that only forwards fulfilment would be stuck forever here. */
    const recovered = await post(server, '/commit', {
      idempotencyKey: 'after-poison',
      kind: 'actions',
      payload: editAction('Lands anyway'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(recovered.status).toBe(200)
    expect(recovered.json.committed).toBe(true)

    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Lands anyway'}])
  })
})

/* ------------------------------------------------------------------ *
 * 3. close() drains
 * ------------------------------------------------------------------ */

describe('close() drains an in-flight commit', () => {
  it('does not resolve until the commit inside the store has finished', async () => {
    const root = await makeRoot()

    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    const inflight = watch(
      post(server, '/commit', {
        idempotencyKey: 'k1',
        kind: 'actions',
        payload: editAction('Drained'),
        baseDocuments: [BASE_ARTICLE],
      }),
    )
    await until(gate.reached, 'the store to reach its commit point')

    const closing = watch(server.close())
    await settle()
    expect(closing.settled()).toBe(false)

    gate.release()
    await closing.promise
    await inflight.promise
    running.splice(running.indexOf(server), 1)

    /* `close()` handed the caller a green light to delete the root; the write it
     * was holding had better be complete. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['title'], value: 'Drained'}])
  })

  it('drains at the API level, with no HTTP server to wait on connections', async () => {
    /*
     * THE FALSIFIER for the test above.
     *
     * `startOverlayApiServer` also waits for every in-flight HTTP handler before
     * it closes its socket, and that alone is enough to keep the test above
     * green with `createOverlayApi.close()` draining nothing. Verified by
     * mutation: deleting `await queue` from `close()` leaves the HTTP test
     * passing.
     *
     * But an App Router mounting has no such wait — Next owns the request
     * lifecycle and `api.close()` is all a shutdown hook gets. So the claim is
     * made against the API directly, where only the commit queue can satisfy it.
     */
    const root = await makeRoot()
    const gate = manifestGate()
    const store = new FsOverlayStore({root, now: makeClock(), hooks: gate.hooks})
    const api = await createOverlayApi({store, overlayId: OVERLAY_ID, now: makeClock()})
    gate.arm()

    const inflight = watch(
      api.handle(
        new Request('https://example.test/api/sanity-overlay/commit', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            idempotencyKey: 'k1',
            kind: 'actions',
            payload: editAction('Drained without a socket'),
            baseDocuments: [BASE_ARTICLE],
          }),
        }),
      ),
    )
    await until(gate.reached, 'the store to reach its commit point')

    const closing = watch(api.close())
    await settle()
    expect(closing.settled()).toBe(false)

    gate.release()
    await closing.promise
    const response = await inflight.promise
    expect(response.status).toBe(200)

    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([
      {path: ['title'], value: 'Drained without a socket'},
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 4. Idempotency replay — PRD §34.6
 * ------------------------------------------------------------------ */

describe('a repeated idempotency key replays instead of committing twice', () => {
  it('reports the replay and leaves the revision alone', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const body = {
      idempotencyKey: 'same-key',
      kind: 'actions',
      payload: editAction('Once'),
      baseDocuments: [BASE_ARTICLE],
    }

    const first = await post(server, '/commit', body)
    expect(first.json.committed).toBe(true)
    expect(first.json.replayed).toBe(false)

    const second = await post(server, '/commit', body)
    expect(second.json.committed).toBe(false)
    expect(second.json.replayed).toBe(true)
    expect(second.json.transactionId).toBe(first.json.transactionId)

    /* Independent oracle: the manifest on disk, not the response. */
    const manifest = await readManifest(root)
    expect(manifest.revision).toBe(first.json.revision)
  })

  it('does not re-apply the mutation to the in-memory projection', async () => {
    /*
     * THE FALSIFIER for replay-at-the-store-only.
     *
     * `FsOverlayStore.commitTransaction` deduplicates by idempotency key, so a
     * second commit persists nothing either way. What it cannot undo is the
     * mutation engine having ALREADY run: a server that translated and applied
     * before checking would increment `views` twice in memory, persist nothing,
     * and then serve a `/state` that the file on disk contradicts.
     *
     * `inc` is chosen deliberately — it is the one operation whose double
     * application is visible in the value rather than idempotent.
     */
    const root = await makeRoot()
    const server = await boot(root)

    const body = {
      idempotencyKey: 'inc-once',
      kind: 'mutations',
      payload: [{patch: {id: 'drafts.article-1', inc: {views: 1}}}],
      baseDocuments: [BASE_ARTICLE],
    }

    await post(server, '/commit', body)
    const afterFirst = await getJson(server, '/state')
    const first = afterFirst.documents.find((d: any) => d.logicalId === 'article-1')
    expect(first.draft.views).toBe(2)

    await post(server, '/commit', body)
    const afterReplay = await getJson(server, '/state')
    const replayed = afterReplay.documents.find((d: any) => d.logicalId === 'article-1')

    /* The projection must be exactly where it was. */
    expect(replayed.draft.views).toBe(2)

    /* And it must still agree with disk. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft?.overrides).toEqual([{path: ['views'], value: 2}])
  })
})

/* ------------------------------------------------------------------ *
 * Document actions — PRD §18.4-§18.9
 * ------------------------------------------------------------------ */

describe('POST /commit kind=documentActions dispatches to the core reducers', () => {
  it('publishes a branch draft onto the branch published perspective', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    await post(server, '/commit', {
      idempotencyKey: 'edit',
      kind: 'actions',
      payload: editAction('Ready to publish'),
      baseDocuments: [BASE_ARTICLE],
    })

    const published = await post(server, '/commit', {
      idempotencyKey: 'publish',
      kind: 'documentActions',
      payload: [{actionType: 'sanity.action.document.publish', publishedId: 'article-1'}],
      baseDocuments: [BASE_ARTICLE],
    })
    expect(published.status).toBe(200)
    expect(published.json.committed).toBe(true)

    /* §18.5 — the resolved draft is copied into local published and the local
     * draft is REMOVED (not tombstoned). Read off disk. */
    const intent = await readIntent(root, 'article-1')
    expect(intent.draft).toBeUndefined()
    const publishedTitle =
      (intent.published?.replacement as Record<string, unknown> | undefined)?.title ??
      intent.published?.overrides?.find((override) => override.path[0] === 'title')?.value
    expect(publishedTitle).toBe('Ready to publish')

    const state = await getJson(server, '/state')
    const document = state.documents.find((d: any) => d.logicalId === 'article-1')
    expect(document.published.title).toBe('Ready to publish')
    expect(document.draft).toBeNull()
  })

  it('replays a retried action request rather than running half of it twice', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    await post(server, '/commit', {
      idempotencyKey: 'edit',
      kind: 'actions',
      payload: editAction('Ready'),
      baseDocuments: [BASE_ARTICLE],
    })

    const body = {
      idempotencyKey: 'publish-once',
      kind: 'documentActions',
      payload: [{actionType: 'sanity.action.document.publish', publishedId: 'article-1'}],
      baseDocuments: [BASE_ARTICLE],
    }
    const first = await post(server, '/commit', body)
    const retry = await post(server, '/commit', body)

    expect(retry.json.replayed).toBe(true)
    expect(retry.json.committed).toBe(false)
    expect(retry.json.revision).toBe(first.json.revision)
  })
})

/* ------------------------------------------------------------------ *
 * Restart transparency — the server holds no state the store does not
 * ------------------------------------------------------------------ */

describe('a restarted server rebuilds its projection from disk', () => {
  it('serves the committed edit after a full restart', async () => {
    const root = await makeRoot()
    const first = await boot(root)

    await post(first, '/commit', {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: editAction('Survives a restart'),
      baseDocuments: [BASE_ARTICLE],
    })
    await first.close()
    running.splice(running.indexOf(first), 1)

    const second = await boot(root)
    const state = await getJson(second, '/state')
    const document = state.documents.find((d: any) => d.logicalId === 'article-1')
    expect(document.draft.title).toBe('Survives a restart')
  })
})
