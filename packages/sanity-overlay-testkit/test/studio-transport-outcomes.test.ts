/**
 * **EVERY ANSWER THE OVERLAY API CAN GIVE A WRITE, AND WHAT THE EDITOR SEES.**
 * PRD §25, §33, §5.5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES, OBSERVED LIVE ON 2026-08-09.
 *
 * A second process touched the overlay. From that moment every edit in the open
 * Studio silently stopped committing — no error, no toast, the revision frozen,
 * and an indefinite `Saving…`. Restarting the API "fixed" it.
 *
 * The server half has since been closed: commits carry
 * `expectedOverlayRevision`, a stale commit is reconciled once from disk, and a
 * commit that still cannot land answers **409**. What that leaves is the Studio
 * half, and the Studio half was worse than nothing: `transport.ts` mapped every
 * non-2xx that was not 401/403 to `degraded`, and `degraded` means, in this
 * codebase's own words, *"editor: saved, loudly"*. So a 409 — a write that did
 * not land and never will until the tab reloads — was reported to the banner as
 * a saved edit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLASS, NOT THE STATUS CODE.
 *
 * The root is the same one as the asset hang in `assets-studio-uploader.test.ts`:
 * **a response the caller treats as success while nothing happened.** So this
 * file enumerates every response shape the transport can receive and pins what
 * the user-facing surface receives for each. No row may end in a silent no-op or
 * in an unbounded pending state.
 *
 *   200 + committed:true                  → success
 *   200 + committed:false + a reason      → visible, naming the reason
 *   200 + committed:false + NO reason     → the contract breach, reported loudly
 *   409                                   → "this branch moved, reload"
 *   413 / 422                             → refused; retrying changes nothing
 *   503 / 5xx / socket error              → transient; held locally, retried
 *   accepted and never answered           → bounded, then stated
 *   401 / 403                             → fatal (unchanged)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LOAD-BEARING 409 IS A REAL ONE.
 *
 * Mocking the transport is how the inert-action defect survived its tests, so
 * the conflict here is produced by two real overlay API servers on one real
 * directory, and the 409 comes out of `FsOverlayStore`'s own
 * `expectedOverlayRevision` precondition, over real HTTP.
 *
 * ONE THING IS FORCED, AND ONLY ONE: the second writer commits again during the
 * first server's reconciliation, which is what makes the retry fail too. That is
 * a TIMING, injected by wrapping the live store's `commitTransaction` so it
 * advances the disk before delegating to the real implementation. Every line of
 * server, store and HTTP code on the path is the shipped one. Without the forced
 * timing the reconciliation succeeds — which is itself asserted below, because
 * "a single external write recovers" and "a continuous one is refused" are two
 * different claims and both matter.
 *
 * ORACLES: the manifest and the intent files on disk, read with `node:fs`, never
 * the transport's own return value.
 */
import {readFile} from 'node:fs/promises'
import {mkdtemp, rm} from 'node:fs/promises'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import type {
  OverlayTransport,
  OverlayTransportResult,
} from '../../sanity-overlay-studio/src/client/transport'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime} from '../../sanity-overlay-studio/src/runtime'
import {deriveOverlayStatus} from '../../sanity-overlay-studio/src/status'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'transport-outcomes-000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

function makeClock(prefix: string): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
  void prefix
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'transport-outcomes-'))
  cleanups.push(() => rm(root, {recursive: true, force: true}))
  return root
}

async function boot(root: string, storeOptions?: Rec): Promise<OverlayApiServer> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock('api'),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    ...(storeOptions === undefined ? {} : {storeOptions}),
  })
  cleanups.push(() => server.close())
  return server
}

function transportFor(
  apiUrl: string,
  sink: {errors: string[]; auth: unknown[]},
  extra: Rec = {},
): OverlayTransport {
  return createOverlayTransport({
    apiUrl,
    onError: (message) => sink.errors.push(message),
    onAuthFailure: (failure) => sink.auth.push(failure),
    headers: {origin: STUDIO_ORIGIN},
    ...extra,
  })
}

function sink(): {errors: string[]; auth: unknown[]} {
  return {errors: [], auth: []}
}

/**
 * A `@sanity/client`-shaped double whose every network method resolves without a
 * socket. Own properties on purpose: the facade must never call a double it has
 * not proved to be a real `@sanity/client`.
 */
function fakeClient(): Rec {
  const answer = (): Promise<unknown> => Promise.resolve({})
  const self: Rec = {
    fetch: answer,
    getDocument: answer,
    getDocuments: answer,
    create: answer,
    createOrReplace: answer,
    delete: answer,
    mutate: answer,
    request: answer,
    listen: () => ({subscribe: () => ({unsubscribe: (): void => {}})}),
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
  }
  self.observable = {fetch: answer, getDocuments: answer}
  return self
}

/** Exactly the payload `client.observable.action(...)` carries for a field edit. */
function editAction(title: string, id = 'article-1'): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: `drafts.${id}`,
      publishedId: id,
      patch: {set: {title}},
    },
  ]
}

let keySequence = 0
function nextKey(label: string): string {
  keySequence += 1
  return `${label}-${keySequence}`
}

/** The §16.1 ancestor the overlay may not fetch for itself. */
function baseArticle(id: string): Rec {
  return {
    _id: id,
    _type: 'article',
    _rev: `lake-rev-${id}`,
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: `Base ${id}`,
  }
}

async function commitEdit(
  transport: OverlayTransport,
  title: string,
  id = 'article-1',
): Promise<OverlayTransportResult> {
  return transport.commit(
    {kind: 'actions', payload: editAction(title, id)},
    {
      idempotencyKey: nextKey(title.replace(/\W+/g, '-')),
      baseDocuments: [baseArticle(id)],
    },
  )
}

/* ---------------------------------------------------------------- oracles */

async function manifestRevision(root: string): Promise<number> {
  const raw = await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8')
  return (JSON.parse(raw) as {revision: number}).revision
}

/** The branch value of one field, from the canonical §14.2 intent file. */
async function overrideOnDisk(
  root: string,
  logicalId: string,
  field: string,
): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(
      join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json'),
      'utf8',
    )
  } catch {
    return undefined
  }
  const intent = JSON.parse(raw) as {
    draft?: {overrides?: Array<{path: unknown[]; value: unknown}>}
  }
  const hit = intent.draft?.overrides?.find(
    (entry) => Array.isArray(entry.path) && entry.path[0] === field,
  )
  return hit?.value
}

/* ------------------------------------------------------------------ *
 * A stub HTTP origin, for the shapes a healthy overlay API never emits
 * ------------------------------------------------------------------ */

interface Stub {
  url: string
  answerWith(handler: (body: string) => {status: number; body?: unknown} | undefined): void
  close(): Promise<void>
}

async function startStub(): Promise<Stub> {
  let handler: (body: string) => {status: number; body?: unknown} | undefined = () => ({
    status: 200,
    body: {ok: true, committed: true, revision: 1},
  })
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const answer = handler(Buffer.concat(chunks).toString('utf8'))
      /* `undefined` = accept the request and never answer. The socket stays
       * open, which is the one server behaviour `fetch` will wait on forever. */
      if (answer === undefined) return
      response.writeHead(answer.status, {'content-type': 'application/json'})
      response.end(JSON.stringify(answer.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    answerWith: (next) => {
      handler = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  cleanups.push(() => stub.close())
  return stub
}

/* ══════════════════════════════════════════════════════════════════ *
 * PART 1 — a real 409 from a real overlay API
 * ══════════════════════════════════════════════════════════════════ */

describe('the branch moved underneath this session (409)', () => {
  /**
   * The benign case FIRST, so the refusal below cannot be confused with it.
   * One external write is reconciled by the server and the session never sees
   * a 409 — turning every external write into a dead session would be the
   * browser symptom made permanent.
   */
  it('a single external write is reconciled and the session keeps saving', async () => {
    const root = await makeRoot()
    const mine = await boot(root)
    const other = await boot(root)
    const seen = sink()
    const transport = transportFor(mine.url, seen)

    /* The other writer moves the branch. */
    const otherSeen = sink()
    const otherResult = await commitEdit(
      transportFor(other.url, otherSeen),
      'from the other writer',
    )
    expect(otherResult.outcome, otherSeen.errors.join('\n')).toBe('ok')

    const result = await commitEdit(transport, 'from my session')

    expect(result.outcome).toBe('ok')
    expect(await overrideOnDisk(root, 'article-1', 'title')).toBe('from my session')
  })

  it('a conflict that survives reconciliation is reported as stale, not as saved', async () => {
    const root = await makeRoot()
    const mine = await boot(root)
    const other = await boot(root)
    const otherTransport = transportFor(other.url, sink())
    const seen = sink()
    const transport = transportFor(mine.url, seen)

    /* Seed something for the other writer to own, and let both servers see it. */
    await commitEdit(otherTransport, 'other one', 'article-1')

    /* THE FORCED TIMING, and the only thing forced: the disk moves again on
     * every attempt my server makes, including the reconciled retry. */
    const realCommit = mine.store.commitTransaction.bind(mine.store)
    let attempts = 0
    ;(mine.store as unknown as Rec).commitTransaction = async (...args: unknown[]) => {
      attempts += 1
      await commitEdit(otherTransport, `other ${attempts}`, 'article-2')
      return (realCommit as (...a: unknown[]) => Promise<unknown>)(...args)
    }

    const result = await commitEdit(transport, 'mine, too late')

    /* Two attempts: the first, and the one reconciliation re-derived. */
    expect(attempts).toBe(2)
    expect(result.status).toBe(409)
    expect(result.outcome).toBe('stale')
    expect(result.retryable).toBe(false)

    /* The editor is TOLD, in words that name the remedy. */
    expect(seen.errors.join('\n')).toMatch(/branch moved|reload/i)
    /* And it is not read as the credential dying. */
    expect(seen.auth).toEqual([])

    /* THE ORACLE IS DISK: my edit did not land, and the other writer's did. */
    expect(await overrideOnDisk(root, 'article-1', 'title')).toBe('other one')
    expect(await overrideOnDisk(root, 'article-2', 'title')).toBe('other 2')
  })

  /**
   * THE WHOLE CHAIN, from a real 409 to the surface a human reads.
   *
   * The three tests above prove the transport's verdict and the banner's
   * rendering separately. This one proves they are CONNECTED — which is the
   * thing the defect actually was: the server was already answering 409 and the
   * Studio did nothing with it.
   */
  it('reaches the banner and the messages channel through the whole runtime', async () => {
    const root = await makeRoot()
    const mine = await boot(root)
    const other = await boot(root)
    const otherTransport = transportFor(other.url, sink())
    await commitEdit(otherTransport, 'other one', 'article-1')

    const messages: string[] = []
    const runtime = createOverlayRuntime({
      resolved: resolveOverlayOptions({mode: 'fs', apiUrl: mine.url, overlayId: OVERLAY_ID}, {}),
      createClient: () => fakeClient(),
      onLog: (message) => messages.push(message),
    })
    const client = runtime.clientFactory({}) as unknown as Rec

    expect(runtime.status().state).not.toBe('branch-moved')

    const realCommit = mine.store.commitTransaction.bind(mine.store)
    ;(mine.store as unknown as Rec).commitTransaction = async (...args: unknown[]) => {
      await commitEdit(otherTransport, `other ${Date.now()}`, 'article-2')
      return (realCommit as (...a: unknown[]) => Promise<unknown>)(...args)
    }

    await (client.createOrReplace as (document: Rec) => Promise<unknown>)({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'mine, too late',
    })

    /* The facade schedules the commit on DELIVERY of the write's result
     * (`persistAndEcho` is `void`-ed), so the call above returns before the
     * overlay has answered. Polled on the condition rather than slept on. */
    const deadline = Date.now() + 5000
    while (runtime.status().state !== 'branch-moved' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const status = runtime.status()
    expect(status.state, messages.join('\n')).toBe('branch-moved')
    expect(status.editing).toBe('read-only')
    expect(status.publishBlocked).toBe(true)
    expect(runtime.messages().join('\n')).toMatch(/branch moved underneath this session/i)
    /* And NOT read as an outage: the server answered, it just said no. `offline`
     * outranks `branch-moved` and tells the editor their edits "will be
     * retried", which for a 409 is false. */
    expect(status.state).not.toBe('offline')
    expect(runtime.branch().connection).toBe('ok')

    /* DISK, not the runtime's own bookkeeping. */
    expect(await overrideOnDisk(root, 'article-1', 'title')).toBe('other one')
  })

  it('drives the banner to a reload instruction, not to “saving”', async () => {
    const status = deriveOverlayStatus({
      enabled: true,
      mode: 'fs',
      apiUrl: 'http://localhost:3998',
      overlayId: OVERLAY_ID,
      connection: 'ok',
      session: 'active',
      pendingWrites: 1,
      degradedWrites: 0,
      uncheckpointedEdits: 0,
      conflicts: {hard: 0, soft: 0},
      branchMoved: true,
    })
    expect(status.state).toBe('branch-moved')
    expect(status.severity).toBe('critical')
    expect(status.editing).toBe('read-only')
    expect(status.headline).toMatch(/reload/i)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 2 — the rest of the table
 * ══════════════════════════════════════════════════════════════════ */

describe('every other answer reaches the editor as itself (PRD §33)', () => {
  it('413 — refused, and says retrying will not help', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 413,
      body: {ok: false, error: {code: 'PAYLOAD_TOO_LARGE', message: 'request body is too large'}},
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'huge')

    expect(result.outcome).toBe('fatal')
    expect(result.code).toBe('PAYLOAD_TOO_LARGE')
    expect(result.retryable).toBe(false)
    expect(seen.errors.join('\n')).toContain('PAYLOAD_TOO_LARGE')
    /* A refusal by our own server is not the editor's Sanity session dying. */
    expect(seen.auth).toEqual([])
  })

  it('422 — refused, named, and distinct from a malformed-payload 400', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 422,
      body: {ok: false, error: {code: 'UNSUPPORTED_QUERY', message: 'not registered'}},
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'unsupported')

    expect(result.outcome).toBe('fatal')
    expect(result.code).toBe('UNSUPPORTED_QUERY')
    expect(result.retryable).toBe(false)
  })

  it('503 — transient, retryable, and held locally rather than discarded', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 503,
      body: {
        ok: false,
        error: {code: 'OVERLAY_STORE_UNAVAILABLE', message: 'could not take the lock'},
      },
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'busy')

    expect(result.outcome).toBe('degraded')
    expect(result.code).toBe('OVERLAY_STORE_UNAVAILABLE')
    expect(result.retryable).toBe(true)
    expect(seen.errors.join('\n')).toContain('OVERLAY_STORE_UNAVAILABLE')
  })

  it('a socket that dies — transient, and never an auth failure', async () => {
    const seen = sink()
    const transport = createOverlayTransport({
      apiUrl: 'http://127.0.0.1:1/api/sanity-overlay',
      fetch: (async () => {
        throw Object.assign(new Error('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
      }) as unknown as typeof fetch,
      onError: (message) => seen.errors.push(message),
      onAuthFailure: (failure) => seen.auth.push(failure),
    })

    const result = await commitEdit(transport, 'offline')
    expect(result.outcome).toBe('degraded')
    expect(result.retryable).toBe(true)
    expect(seen.auth).toEqual([])
  })

  it('401 — still fatal, and still only session-ending when Sanity is named', async () => {
    const stub = await startStub()
    const ours = sink()
    stub.answerWith(() => ({
      status: 401,
      body: {ok: false, error: {code: 'INVALID_REQUEST', message: 'our own no'}},
    }))
    expect((await commitEdit(transportFor(stub.url, ours), 'x')).outcome).toBe('fatal')
    expect(ours.auth).toEqual([])

    const upstream = sink()
    stub.answerWith(() => ({
      status: 401,
      body: {ok: false, error: {origin: 'sanity', message: 'token expired'}},
    }))
    expect((await commitEdit(transportFor(stub.url, upstream), 'y')).outcome).toBe('fatal')
    expect(upstream.auth).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 3 — a 200 that did nothing
 * ══════════════════════════════════════════════════════════════════ */

describe('a 200 carrying `committed: false` is never read as a save', () => {
  it('names the reason when the overlay could not represent the write', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 200,
      body: {
        ok: true,
        committed: false,
        replayed: false,
        revision: 7,
        unsupported: ['patch.diffMatchPatch has no overlay spelling'],
      },
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'unrepresentable')

    expect(result.committed).toBe(false)
    expect(result.notCommittedReason).toContain('diffMatchPatch')
    expect(seen.errors.join('\n')).toContain('diffMatchPatch')
  })

  /**
   * REPORTED, NOT SILENT — changed 2026-08-10.
   *
   * This used to assert `seen.errors` was EMPTY, on the reasoning that a replay
   * is a write that already landed and shouting about it trains an editor to
   * ignore the channel. That holds only for a replay the client MEANT to cause.
   *
   * `echo.ts` issued the same idempotency key on every page load, so the first
   * document action after any reload was answered from the ledger with another
   * page load's transaction — and this line is why nothing anywhere said so.
   * The generator is fixed, which is exactly what makes a replay rare enough to
   * be worth reporting.
   *
   * The VERDICT is unchanged and still asserted below: `ok`, not retryable, not
   * a breach. The write named in the ledger really is saved. What is new is that
   * a human is told, because THIS call saved nothing.
   */
  it('reports a replay instead of letting it pass for a fresh save', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 200,
      body: {ok: true, committed: false, replayed: true, revision: 7, transactionId: 't-1'},
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'again')

    expect(result.outcome).toBe('ok')
    expect(result.committed).toBe(false)
    expect(result.replayed).toBe(true)
    expect(result.notCommittedReason).toMatch(/already/i)
    /* Not dressed up as a failure: nothing here asks the caller to retry. */
    expect(result.retryable).toBe(false)
    /* But said out loud, and in terms an editor can act on. */
    expect(seen.errors.join('\n')).toMatch(/replay/i)
    expect(seen.errors.join('\n')).toMatch(/applied NOTHING now/)
  })

  it('a blocked rebase is reported as blocked, not as applied', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 200,
      body: {
        ok: true,
        committed: false,
        replayed: false,
        revision: 7,
        documents: [{logicalId: 'article-1', applied: false, blockedBy: ['hard conflict']}],
      },
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'rebase')

    expect(result.committed).toBe(false)
    expect(result.notCommittedReason).toMatch(/blocked/i)
    expect(seen.errors.join('\n')).toMatch(/blocked/i)
  })

  it('THE CONTRACT BREACH: `committed:false` with nothing explaining it', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status: 200,
      body: {ok: true, committed: false, revision: 7},
    }))

    const result = await commitEdit(transportFor(stub.url, seen), 'nothing happened')

    /* This is the silent no-op the whole file is about. It cannot be `ok`. */
    expect(result.outcome).toBe('degraded')
    expect(result.committed).toBe(false)
    expect(seen.errors.join('\n')).toMatch(/`committed: false`/)
    expect(seen.errors.join('\n')).toMatch(/did not say why/i)
    expect(result.notCommittedReason).toMatch(/did not say why/i)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 4 — a server that accepts and never answers
 * ══════════════════════════════════════════════════════════════════ */

describe('no write is left pending forever (PRD §5.5)', () => {
  it('gives up on its own deadline and states it', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => undefined)

    const started = Date.now()
    const result = await commitEdit(
      transportFor(stub.url, seen, {requestTimeoutMs: 300}),
      'into the void',
    )
    const elapsed = Date.now() - started

    expect(result.outcome).toBe('degraded')
    expect(result.retryable).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(seen.errors.join('\n')).toMatch(/did not answer|timed out/i)
  })

  it('a slow-but-alive server is not cut off', async () => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({status: 200, body: {ok: true, committed: true, revision: 3}}))

    const result = await commitEdit(
      transportFor(stub.url, seen, {requestTimeoutMs: 5000}),
      'in time',
    )
    expect(result.outcome).toBe('ok')
    expect(result.revision).toBe(3)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 5 — the whole table, as one exhaustiveness claim
 * ══════════════════════════════════════════════════════════════════ */

describe('the mapping is total: no status reaches the editor as nothing', () => {
  const STATUSES = [200, 202, 400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503]

  it.each(STATUSES)('%i produces an outcome and, unless ok, a message', async (status) => {
    const stub = await startStub()
    const seen = sink()
    stub.answerWith(() => ({
      status,
      body:
        status >= 200 && status < 300
          ? {ok: true, committed: true, revision: 1}
          : {ok: false, error: {code: `CODE_${status}`, message: `refused with ${status}`}},
    }))

    const result = await commitEdit(transportFor(stub.url, seen), `s${status}`)

    expect(['ok', 'degraded', 'stale', 'fatal']).toContain(result.outcome)
    expect(typeof result.retryable).toBe('boolean')
    if (result.outcome !== 'ok') {
      expect(seen.errors.length, `${status} produced no message`).toBeGreaterThan(0)
      expect(result.message ?? '').toContain(String(status))
    }
  })
})
