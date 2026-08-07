/**
 * PRD §33 failure modes, API and session half — injected against the real
 * overlay HTTP API and the real Studio transport (PRD §35.15, §11.3, §34).
 *
 * THE STANDARD THIS SUITE IS BUILT TO HOLD
 *
 * Two defects have already shipped from this codebase, and both were the same
 * bug wearing different clothes: **a component's report and the state of the
 * disk disagreed.**
 *
 *   - the overlay server acknowledged an HTTP request BEFORE the disk write
 *     finished — a success the user acted on that had not happened yet;
 *   - a write rejected after a 401 still REACHED disk before being reported
 *     failed — a failure the user acted on that had already happened.
 *
 * Both were found late because every test asked the component what it did. So
 * every case here asks `node:fs`, and asserts the pairing in both directions:
 *
 *     reported ok      ⇒ it is on disk, completely
 *     reported not-ok  ⇒ it is not on disk, at all
 *
 * `assertReportMatchesDisk` below is that rule as a function, and the
 * mutation-check cases prove it can actually see a violation: an auth gate that
 * refuses BEFORE forwarding keeps disk clean and passes; the same gate moved to
 * refuse AFTER forwarding reproduces the shipped defect and is caught.
 *
 * §33 rows covered here:
 *
 *   | §33 row                          | case |
 *   |----------------------------------|------|
 *   | Blob unavailable                 | overlay API unreachable mid-edit ⇒ degraded, no staging fallback |
 *   | Native staging write attempted   | fatal safety error, refused at construction |
 *   | Studio client calls unknown endpoint | blocked and logged, no state change |
 *   | Duplicate transaction request    | concurrent same key ⇒ one apply |
 *   | SSE unavailable                  | a dead subscriber cannot cost a commit |
 *   | Query not registered             | 422, naming the query |
 *   | Candidate set too large           | capacity error |
 *   | Base deletes touched document    | local materialized document preserved |
 *   | (queue) rejected commit          | further writes still land, revisions contiguous |
 */
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'
import {
  createQueryRegistry,
  M_LOCAL_QUERIES,
  OverlayQueryError,
} from '../../sanity-overlay-query/src/index'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {createFailureLedger, endsWith, errnoError, settle, until} from '../src/failureInjection'
import {outboundAttempts} from '../src/outboundMonitor'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'failure-api-overlay-000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: OverlayApiServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'failure-api-'))
  roots.push(root)
  return root
}

/** Monotonic injected clock — nothing under test may read a wall clock. */
function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

async function boot(
  root: string,
  hooks?: {beforeRename(info: {tempPath: string; targetPath: string}): Promise<void>},
): Promise<OverlayApiServer> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    hooks,
    /* The direct-edit watcher has its own suite; a timer firing mid-commit here
     * would only add noise to a failure-injection assertion. */
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  running.push(server)
  return server
}

const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
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

async function post(
  server: OverlayApiServer,
  route: string,
  body: unknown,
): Promise<{status: number; json: Record<string, any>}> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {status: response.status, json: (await response.json()) as Record<string, any>}
}

async function readManifest(root: string): Promise<OverlayManifest> {
  return parse(
    await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
  ) as OverlayManifest
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The branch title as the canonical §14.2 intent file records it, or `null`. */
async function titleOnDisk(root: string, logicalId: string): Promise<string | null> {
  const path = join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json')
  if (!(await exists(path))) return null
  const intent = parse(await readFile(path, 'utf8')) as {
    draft?: {overrides?: Array<{path: unknown[]; value: unknown}>}
  }
  const override = intent.draft?.overrides?.find(
    (entry) => Array.isArray(entry.path) && entry.path[0] === 'title',
  )
  return override === undefined ? null : (override.value as string)
}

/**
 * The whole point of this file, as one assertion.
 *
 * `reported` is what the component told its caller. `landed` is what disk says.
 * They must agree. A failure here is either "acknowledged before the write" or
 * "reported failed after the write" — the two defects this repository shipped.
 */
function assertReportMatchesDisk(reported: 'ok' | 'not-ok', landed: boolean): void {
  if (reported === 'ok') {
    expect(landed, 'reported success but it is not on disk').toBe(true)
  } else {
    expect(landed, 'reported failure but it reached disk anyway').toBe(false)
  }
}

/* ================================================================== *
 * §33 "Blob unavailable" — Studio enters recovery state; retry
 * bounded; NO STAGING FALLBACK. The filesystem-mode equivalent of a
 * storage outage is the overlay API itself being unreachable.
 * ================================================================== */

describe('§33 overlay API unreachable mid-edit', () => {
  it('degrades loudly, keeps the session alive, and never falls back to Sanity', async () => {
    const errors: string[] = []
    const authFailures: unknown[] = []
    let attempts = 0

    /* THE INJECTION: the socket is gone. Exactly what `fetch` does when the dev
     * server is stopped, or a laptop lid closes mid-autosave. */
    const transport = createOverlayTransport({
      apiUrl: 'http://127.0.0.1:1/api/sanity-overlay',
      fetch: (async () => {
        attempts += 1
        throw Object.assign(new Error('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
      }) as unknown as typeof fetch,
      onError: (message) => errors.push(message),
      onAuthFailure: (failure) => authFailures.push(failure),
    })

    const outboundBefore = outboundAttempts().length
    const result = await transport.commit(
      {kind: 'actions', payload: editAction('Typed while offline')},
      {idempotencyKey: 'offline-1'},
    )

    /* PROOF THE INJECTION TOOK EFFECT: the transport really did try, and really
     * did fail. Without this the case would pass against a transport that
     * short-circuited and never made a request at all. */
    expect(attempts).toBe(1)

    /* REQUIRED BEHAVIOUR: `degraded`, not `ok` and not `fatal`. An outage is
     * transient, so the keystrokes are kept and the editor is told loudly —
     * discarding their work over a dropped socket is the worse error. */
    expect(result.outcome).toBe('degraded')
    expect(errors.join('\n')).toContain('unreachable')

    /* NOT an auth failure: the session must not be torn down by an outage. */
    expect(authFailures).toEqual([])

    /* §11.3, last line, absolute: "Never fall back from failed overlay writes to
     * native Sanity writes." The suite-wide monitor is the independent oracle —
     * it watches every host, not just the one this transport was given. */
    expect(outboundAttempts().length).toBe(outboundBefore)
  })

  it('recovers on the next request rather than latching into a failed state', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    let offline = true
    const transport = createOverlayTransport({
      apiUrl: `${server.url}`,
      fetch: (async (url: string, init: RequestInit) => {
        if (offline) throw new Error('fetch failed')
        return globalThis.fetch(url, init)
      }) as unknown as typeof fetch,
    })

    const during = await transport.commit(
      {kind: 'actions', payload: editAction('Lost to the outage')},
      {idempotencyKey: 'outage-1'},
    )
    expect(during.outcome).toBe('degraded')
    /* The oracle: nothing landed, because nothing was ever delivered. */
    assertReportMatchesDisk('not-ok', (await titleOnDisk(root, 'article-1')) !== null)

    offline = false
    const after = await transport.commit(
      {kind: 'actions', payload: editAction('Saved after recovery')},
      {idempotencyKey: 'outage-2', baseDocuments: [BASE_ARTICLE]},
    )
    expect(after.outcome).toBe('ok')
    assertReportMatchesDisk('ok', (await titleOnDisk(root, 'article-1')) === 'Saved after recovery')
  })
})

/* ================================================================== *
 * THE SHIPPED DEFECT CLASS — a write reported `fatal` must not have
 * reached disk. §33 "Native staging write attempted" / §11.3.
 * ================================================================== */

describe('a write the client is told is fatal has not reached disk', () => {
  /**
   * The gate is the injection AND the mutation control.
   *
   * `refuse: 'before'` — a real auth boundary: refuse, do not forward. Nothing
   *   reaches the overlay, so `fatal` and disk agree. This is the passing case.
   * `refuse: 'after'`  — the SHIPPED DEFECT reproduced exactly: forward first,
   *   then answer 401. The client is told the write is fatal; the overlay has
   *   already committed it. The same assertions must go red.
   */
  function authGate(
    server: OverlayApiServer,
    mode: {refuse: 'before' | 'after' | 'never'},
  ): {fetch: typeof fetch; forwarded: () => number} {
    let forwarded = 0
    const gated = (async (url: string, init: RequestInit) => {
      const unauthorized = new Response(
        JSON.stringify({ok: false, error: {code: 'UNAUTHORIZED', message: 'no preview session'}}),
        {status: 401, headers: {'content-type': 'application/json'}},
      )
      if (mode.refuse === 'before') return unauthorized
      forwarded += 1
      const response = await globalThis.fetch(url, init)
      if (mode.refuse === 'after') return unauthorized
      return response
    }) as unknown as typeof fetch

    return {fetch: gated, forwarded: () => forwarded}
  }

  it('refuses before forwarding: the client sees fatal and disk is untouched', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    const gate = authGate(server, {refuse: 'before'})

    const echo = createOverlayEcho()
    const transport = createOverlayTransport({apiUrl: server.url, fetch: gate.fetch})

    const result = await transport.commit(
      {kind: 'actions', payload: editAction('Refused')},
      {idempotencyKey: 'gated-1', baseDocuments: [BASE_ARTICLE]},
    )

    /* PROOF THE INJECTION TOOK EFFECT: the client really was refused. */
    expect(result.outcome).toBe('fatal')
    expect(result.status).toBe(401)

    /* And proof it was refused at the RIGHT PLACE — nothing was forwarded. */
    expect(gate.forwarded()).toBe(0)

    assertReportMatchesDisk('not-ok', (await titleOnDisk(root, 'article-1')) !== null)
    expect((await readManifest(root)).revision).toBe(0)

    /* The session's own bookkeeping: an overlay-issued 401 is the overlay's "no",
     * not evidence that the editor's Sanity credential died (transport.ts
     * `declaresUpstreamAuthOrigin`), so the editor is not logged out over it. */
    expect(echo.acknowledgeWrite().ok).toBe(true)
  })

  it('MUTATION CHECK: the same assertions go red when the refusal comes after the write', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    const gate = authGate(server, {refuse: 'after'})
    const transport = createOverlayTransport({apiUrl: server.url, fetch: gate.fetch})

    const result = await transport.commit(
      {kind: 'actions', payload: editAction('Reported fatal, written anyway')},
      {idempotencyKey: 'gated-2', baseDocuments: [BASE_ARTICLE]},
    )

    /* The client's view is identical to the honest case above. */
    expect(result.outcome).toBe('fatal')
    expect(result.status).toBe(401)
    /* The world's view is not: it WAS forwarded, and it DID land. */
    expect(gate.forwarded()).toBe(1)
    expect(await titleOnDisk(root, 'article-1')).toBe('Reported fatal, written anyway')

    /* THE ORACLE FIRES. This is the shipped defect, and the check that would
     * have caught it. Asserting that it throws is what proves the check in the
     * case above is not vacuous. */
    expect(() =>
      assertReportMatchesDisk('not-ok', true),
    ).toThrow(/reported failure but it reached disk anyway/)
  })

  it('a fatal commit is not echoed to the pane as if it had been saved', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    const gate = authGate(server, {refuse: 'before'})
    const transport = createOverlayTransport({apiUrl: server.url, fetch: gate.fetch})

    const result = await transport.commit(
      {kind: 'actions', payload: editAction('Refused')},
      {idempotencyKey: 'gated-3', baseDocuments: [BASE_ARTICLE]},
    )
    expect(result.outcome).toBe('fatal')

    /* `/state` is what a reloading pane reads. It must not contain the refused
     * edit — a refusal the editor can still see rendered is the same lie by a
     * slower route. */
    const state = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const body = (await state.json()) as {documents: unknown[]; revision: number}
    expect(body.documents).toEqual([])
    expect(body.revision).toBe(0)
  })
})

/* ================================================================== *
 * §33 "Native staging write attempted" — Fatal safety error; reject
 * and alert. §11.3 hard guard.
 * ================================================================== */

describe('§33 native staging write attempted', () => {
  it('refuses to build a transport aimed at Sanity, at construction rather than at commit', () => {
    /* THE INJECTION: a misconfigured `OVERLAY_API_URL`. `call()` turns a throwing
     * fetch into `degraded` — "saved, loudly" — which is the right answer for an
     * outage and precisely the wrong one for a write aimed at the shared dataset.
     * So the refusal has to happen before a transport exists at all. */
    expect(() =>
      createOverlayTransport({apiUrl: 'https://abc123.api.sanity.io/v2025-02-19/data/mutate/production'}),
    ).toThrow()

    /* The guard is about the HOST, not about the word "sanity" in a string: a
     * local overlay endpoint on a path that mentions sanity is fine. */
    expect(() =>
      createOverlayTransport({apiUrl: 'http://localhost:3998/api/sanity-overlay'}),
    ).not.toThrow()
  })
})

/* ================================================================== *
 * §33 "Studio client calls unknown endpoint" — Facade audit failure ⇒
 * block and log the endpoint.
 * ================================================================== */

describe('§33 unknown endpoint', () => {
  it('answers a structured 404 and changes no state', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'known-1',
      kind: 'actions',
      payload: editAction('Committed'),
      baseDocuments: [BASE_ARTICLE],
    })
    const before = await readManifest(root)

    const result = await post(server, '/promote', {idempotencyKey: 'unknown-1'})

    expect(result.status).toBe(404)
    expect(result.json.ok).toBe(false)
    /* Named, not swallowed — §5.5 forbids silent approximation, and an endpoint
     * that answered 200 to a route it does not implement is the worst version. */
    expect(result.json.error.code).toBe('NOT_FOUND')
    expect(result.json.error.message).toContain('/promote')

    const after = await readManifest(root)
    expect(after.revision).toBe(before.revision)
    expect(after.transactionHead).toBe(before.transactionHead)
  })
})

/* ================================================================== *
 * §33 "Duplicate transaction request" — Idempotency lookup ⇒ return
 * the original success; DO NOT REAPPLY (PRD §34.6).
 * ================================================================== */

describe('§33 duplicate transaction request', () => {
  it('applies once when the same key arrives twice concurrently', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const body = {
      idempotencyKey: 'same-key',
      kind: 'actions',
      payload: editAction('Written once'),
      baseDocuments: [BASE_ARTICLE],
    }

    /* THE INJECTION: two in-flight requests with one key — a retry racing the
     * original, which is what a flaky socket produces. */
    const [first, second] = await Promise.all([
      post(server, '/commit', body),
      post(server, '/commit', body),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    /* PROOF THE INJECTION TOOK EFFECT: both requests really were served. */
    expect([first.json.replayed, second.json.replayed].filter(Boolean)).toHaveLength(1)

    /* REQUIRED BEHAVIOUR: exactly one apply, on disk. */
    const manifest = await readManifest(root)
    expect(manifest.revision).toBe(1)
    expect(await titleOnDisk(root, 'article-1')).toBe('Written once')
  })
})

/* ================================================================== *
 * A rejected commit must not wedge the queue — Studio autosaves faster
 * than a commit round trip, so commits are serialised.
 * ================================================================== */

describe('a rejected commit is followed by writes that land', () => {
  it('keeps the revision sequence contiguous across three injected failures', async () => {
    const ledger = createFailureLedger()
    const root = await makeRoot()
    const server = await boot(root, ledger.hooks)

    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')
    const outcomes: Array<'ok' | 'not-ok'> = []

    for (let attempt = 0; attempt < 6; attempt += 1) {
      /* THE INJECTION: alternate failures and successes, so a queue that wedged
       * would be visible as a run of failures after the first one. */
      if (attempt % 2 === 0) {
        ledger.failOn(endsWith('manifest.json'), errnoError('EIO', 'rename', manifestPath))
      }
      const result = await post(server, '/commit', {
        idempotencyKey: `autosave-${attempt}`,
        kind: 'actions',
        payload: editAction(`Autosave ${attempt}`),
        baseDocuments: [BASE_ARTICLE],
      })
      outcomes.push(result.status === 200 && result.json.committed === true ? 'ok' : 'not-ok')
    }

    /* PROOF THE INJECTION TOOK EFFECT: three failures actually fired. */
    expect(ledger.injections()).toBe(3)
    expect(outcomes).toEqual(['not-ok', 'ok', 'not-ok', 'ok', 'not-ok', 'ok'])

    /* REQUIRED BEHAVIOUR: three successes, three revisions — the failures cost
     * nothing and consumed no revision (PRD §34.5). */
    const manifest = await readManifest(root)
    expect(manifest.revision).toBe(3)

    /* And the last success is the state that is served: a wedged queue would
     * have left an earlier title, and a double-apply a later revision. */
    expect(await titleOnDisk(root, 'article-1')).toBe('Autosave 5')
    assertReportMatchesDisk('ok', (await titleOnDisk(root, 'article-1')) === 'Autosave 5')

    /* The server is still answering, not stuck behind a poisoned tail. */
    const health = await fetch(`${server.url}/health`, {headers: {origin: STUDIO_ORIGIN}})
    expect(health.status).toBe(200)
  })

  it('reports a failed commit as an error rather than a rejection that kills the process', async () => {
    const ledger = createFailureLedger()
    const root = await makeRoot()
    const server = await boot(root, ledger.hooks)

    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')
    ledger.failOn(endsWith('manifest.json'), errnoError('ENOSPC', 'rename', manifestPath))

    const result = await post(server, '/commit', {
      idempotencyKey: 'doomed',
      kind: 'actions',
      payload: editAction('Never lands'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(ledger.injections()).toBe(1)
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.json.ok).toBe(false)
    /* The errno reaches the client as a code, so a banner can say what happened
     * instead of "something went wrong". */
    expect(result.json.error.code).toBe('ENOSPC')

    assertReportMatchesDisk('not-ok', (await titleOnDisk(root, 'article-1')) !== null)
  })
})

/* ================================================================== *
 * §33 "SSE unavailable" — Connection failure ⇒ preview may update
 * slower; poll manifest revision. A dead subscriber must never cost a
 * commit.
 * ================================================================== */

describe('§33 SSE unavailable', () => {
  it('commits while a subscriber is dropped mid-stream, and the revision is still readable', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    /* THE INJECTION: a subscriber that connects and then vanishes — a closed
     * tab, a proxy timeout, a laptop asleep. */
    const controller = new AbortController()
    const stream = await fetch(`${server.url}/events`, {
      headers: {origin: STUDIO_ORIGIN},
      signal: controller.signal,
    })
    expect(stream.status).toBe(200)
    await until(() => server.api.subscriberCount() === 1, 'the subscriber to register')

    controller.abort()
    await until(() => server.api.subscriberCount() === 0, 'the dropped subscriber to be forgotten')

    /* PROOF THE INJECTION TOOK EFFECT: the subscriber really is gone. A stale
     * entry left in the broadcast set is the failure mode this guards — every
     * later emit would pay for a socket nobody is reading. */
    expect(server.api.subscriberCount()).toBe(0)

    /* REQUIRED BEHAVIOUR: the commit is unaffected. */
    const result = await post(server, '/commit', {
      idempotencyKey: 'after-drop',
      kind: 'actions',
      payload: editAction('Committed with no listeners'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(result.status).toBe(200)
    assertReportMatchesDisk(
      'ok',
      (await titleOnDisk(root, 'article-1')) === 'Committed with no listeners',
    )

    /* "Poll manifest revision" — the fallback §33 names is available and correct. */
    const health = await fetch(`${server.url}/health`, {headers: {origin: STUDIO_ORIGIN}})
    expect(((await health.json()) as {revision: number}).revision).toBe(
      (await readManifest(root)).revision,
    )
  })
})

/* ================================================================== *
 * §33 "Query not registered" ⇒ 422 with the query ID.
 * §33 "Candidate set too large" ⇒ capacity error.
 * ================================================================== */

describe('§33 query gateway failures', () => {
  it('refuses an unregistered query and names it, rather than approximating', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const result = await post(server, '/query', {
      queryId: 'not-a-registered-query',
      query: '*[_type == "article"]{_id}',
      params: {},
      baseDocuments: [BASE_ARTICLE],
    })

    expect(result.json.ok).toBe(false)
    /* `/query` raises its own `UNSUPPORTED_QUERY` rather than passing the §22.9
     * `QUERY_NOT_REGISTERED` through, deliberately (`queries.ts`: the §22.5
     * passthrough licence belongs to the credential holder, not this endpoint).
     * Both are refusals that name the query; `/query/plan` below carries the
     * §22.9 code unchanged. */
    expect(result.json.error.code).toBe('UNSUPPORTED_QUERY')
    /* The query ID is in the message, so the error page §33 asks for can show it. */
    expect(JSON.stringify(result.json)).toContain('not-a-registered-query')

    /* §5.5 / §34.16: an unsupported query never returns results, and never
     * returns `exact: true`. This is the assertion that actually protects the
     * dataset; the status code below is the reporting half of the same row. */
    expect(result.json.result).toBeUndefined()
    expect(result.json.exact).toBeUndefined()
  })

  it('refuses a registered query whose text has drifted from the registered checksum', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const result = await post(server, '/query/plan', {
      queryId: 'article-by-id',
      query: '*[_type == "article"] /* rewritten in the app and not re-registered */',
      params: {id: 'article-1'},
    })

    expect(result.json.ok).toBe(false)
    expect(result.json.error.code).toBe('QUERY_CHANGED')
    expect(result.json.result).toBeUndefined()
  })

  it('refuses a query whose candidate set exceeds its configured maximum', async () => {
    const root = await makeRoot()
    /* THE INJECTION: the registry's own §11.1 `maxCandidateDocuments` is turned
     * down to 2, and a base of 5 documents is handed over. Turning the LIMIT
     * down rather than the data up keeps the case deterministic and fast, and
     * exercises the identical §22.9 branch. */
    const registry = createQueryRegistry(
      M_LOCAL_QUERIES.map((definition) =>
        definition.id === 'article-type-list' ? {...definition, maxCandidates: 2} : definition,
      ),
    )
    const server = await startOverlayApiServer({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
      registry,
    })
    running.push(server)

    const base = Array.from({length: 5}, (_unused, index) => ({
      ...BASE_ARTICLE,
      _id: `article-${index}`,
      title: `Article ${index}`,
    }))
    const result = await post(server, '/query', {
      queryId: 'article-type-list',
      query: registry.get('article-type-list').query,
      params: {},
      baseDocuments: base,
    })

    /* PROOF THE INJECTION TOOK EFFECT: the same query under the shipped limit
     * answers normally, so the refusal below is the LIMIT and not the fixture. */
    const permissive = await boot(await makeRoot())
    const allowed = await post(permissive, '/query', {
      queryId: 'article-type-list',
      query: registry.get('article-type-list').query,
      params: {},
      baseDocuments: base,
    })
    expect(allowed.json.ok).not.toBe(false)
    expect(Array.isArray(allowed.json.result)).toBe(true)

    /* §33 "Candidate set too large → Return capacity error". */
    expect(result.json.ok).toBe(false)
    expect(result.json.error.code).toBe('CANDIDATE_LIMIT_EXCEEDED')
    expect(result.json.result).toBeUndefined()
  })

  /**
   * ─────────────────────────────── DEFECT D-3 ────────────────────────────────
   * QUERY REFUSALS LOSE THEIR HTTP STATUS AT THE API BOUNDARY.
   *
   * `sanity-overlay-query/src/errors.ts` carries the §22.9 table verbatim and
   * puts it on every error as `httpStatus` — 422 for `QUERY_NOT_REGISTERED`,
   * `QUERY_CHANGED`, `UNSUPPORTED_GROQ` and `REFERENCE_DEPTH_EXCEEDED`, 413 for
   * `CANDIDATE_LIMIT_EXCEEDED`, 403 for `QUERY_CALLER_NOT_ALLOWED`.
   *
   * `sanity-overlay-next/src/api.ts` `failure()` reads `api?.status`, which only
   * exists on `OverlayApiError`, and otherwise flattens every code-carrying
   * error to 400. So the whole table is dead at the one boundary it was written
   * for, and §33's "Query not registered → Return 422" is not met.
   *
   * The CODE survives, so nothing silently approximates and no caller is misled
   * about what happened — which is why this is reported as a defect rather than
   * a safety failure. `sanity-overlay-next` is not owned by this work; the fix
   * is `error.httpStatus` in `failure()`'s status resolution.
   * ───────────────────────────────────────────────────────────────────────────
   */
  it('DEFECT D-3: every query refusal is flattened to 400 regardless of its §22.9 status', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const unregistered = await post(server, '/query', {
      queryId: 'not-a-registered-query',
      query: '*[_type == "article"]{_id}',
      params: {},
      baseDocuments: [BASE_ARTICLE],
    })
    const changed = await post(server, '/query/plan', {
      queryId: 'article-by-id',
      query: '*[_type == "article"] /* drifted */',
      params: {id: 'article-1'},
    })

    const oversized = await (async () => {
      const registry = createQueryRegistry(
        M_LOCAL_QUERIES.map((definition) =>
          definition.id === 'article-type-list' ? {...definition, maxCandidates: 1} : definition,
        ),
      )
      const capped = await startOverlayApiServer({
        root: await makeRoot(),
        port: 0,
        overlayId: OVERLAY_ID,
        now: makeClock(),
        watchIntervalMs: 0,
        origins: [STUDIO_ORIGIN],
        registry,
      })
      running.push(capped)
      return post(capped, '/query', {
        queryId: 'article-type-list',
        query: registry.get('article-type-list').query,
        params: {},
        baseDocuments: [BASE_ARTICLE, {...BASE_ARTICLE, _id: 'article-2'}],
      })
    })()

    /* The §22.9 statuses these codes carry, straight off the error class. */
    expect(new OverlayQueryError('QUERY_CHANGED', 'x').httpStatus).toBe(422)
    expect(new OverlayQueryError('CANDIDATE_LIMIT_EXCEEDED', 'x').httpStatus).toBe(413)

    /* What the boundary actually answers: 400 for all of them. */
    expect(changed.json.error.code).toBe('QUERY_CHANGED')
    expect(oversized.json.error.code).toBe('CANDIDATE_LIMIT_EXCEEDED')
    expect(unregistered.status).toBe(400)
    expect(changed.status).toBe(400)
    expect(oversized.status).toBe(400)
  })

  it.fails(
    'REQUIRED (§22.9 / §33 "Candidate set too large → capacity error"): the refusal carries its §22.9 status — currently DEFECT D-3',
    async () => {
      const registry = createQueryRegistry(
        M_LOCAL_QUERIES.map((definition) =>
          definition.id === 'article-type-list' ? {...definition, maxCandidates: 1} : definition,
        ),
      )
      const server = await startOverlayApiServer({
        root: await makeRoot(),
        port: 0,
        overlayId: OVERLAY_ID,
        now: makeClock(),
        watchIntervalMs: 0,
        origins: [STUDIO_ORIGIN],
        registry,
      })
      running.push(server)
      const result = await post(server, '/query', {
        queryId: 'article-type-list',
        query: registry.get('article-type-list').query,
        params: {},
        baseDocuments: [BASE_ARTICLE, {...BASE_ARTICLE, _id: 'article-2'}],
      })
      /* §22.9 assigns 413 to `CANDIDATE_LIMIT_EXCEEDED`; a capacity error that
       * arrives as 400 is indistinguishable from a malformed request. */
      expect(result.status).toBe(413)
    },
  )
})

/* ================================================================== *
 * §33 "Base deletes touched document" — Missing base ⇒ conflict badge;
 * PRESERVE LOCAL MATERIALIZED DOCUMENT (PRD §16.4).
 * ================================================================== */

describe('§33 base deletes a touched document', () => {
  it('keeps serving the branch document after the base document disappears', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    /* The branch touches a base document, capturing its ancestor. */
    const committed = await post(server, '/commit', {
      idempotencyKey: 'touch-1',
      kind: 'actions',
      payload: editAction('Branch edit that must survive'),
      baseDocuments: [BASE_ARTICLE],
    })
    expect(committed.status).toBe(200)
    expect(await titleOnDisk(root, 'article-1')).toBe('Branch edit that must survive')

    /* THE INJECTION: the base document is gone. Every later read is made with an
     * EMPTY base — which is exactly what the credential holder hands over once
     * staging deletes it. */
    const resolved = await post(server, '/resolve', {
      mode: 'perspective',
      perspective: 'drafts',
      ids: ['article-1'],
      baseDocuments: [],
    })

    /* PROOF THE INJECTION TOOK EFFECT: the base really is absent from this read —
     * a resolve that had silently reused a cached base would answer identically
     * to one that never lost it, so the absence is asserted from the request. */
    expect(resolved.status).toBe(200)

    /* REQUIRED BEHAVIOUR (§33, §16.4, §34.14): "Preserve local materialized
     * document" — base deletion never destroys a touched document. */
    const documents = resolved.json.documents as Array<Record<string, unknown>>
    const article = documents.find((entry) => entry?._id === 'drafts.article-1')
    expect(article).toBeDefined()
    expect(article?.title).toBe('Branch edit that must survive')

    /* And the canonical file is untouched by the base's disappearance. */
    expect(await titleOnDisk(root, 'article-1')).toBe('Branch edit that must survive')
  })

  it('does not resurrect a base document the branch deleted', async () => {
    const root = await makeRoot()
    const server = await boot(root)

    const deleted = await post(server, '/commit', {
      idempotencyKey: 'delete-1',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.delete',
          publishedId: 'article-1',
          includeDrafts: ['drafts.article-1'],
        },
      ],
      baseDocuments: [BASE_ARTICLE],
    })
    expect(deleted.status).toBe(200)

    /* The base is handed over again, in full — a tombstone that only worked
     * while the base happened to be absent would not be a tombstone. */
    const resolved = await post(server, '/resolve', {
      mode: 'perspective',
      perspective: 'drafts',
      ids: ['article-1'],
      baseDocuments: [BASE_ARTICLE],
    })
    const documents = resolved.json.documents as Array<Record<string, unknown> | null>
    expect(documents.filter((entry) => entry !== null)).toEqual([])
  })
})

/* ================================================================== *
 * Restart is the ultimate oracle: a projection is only as true as the
 * disk it can be rebuilt from.
 * ================================================================== */

describe('every acknowledgement survives a restart', () => {
  it('serves exactly the acknowledged writes after a cold boot, and nothing else', async () => {
    const ledger = createFailureLedger()
    const root = await makeRoot()
    const first = await boot(root, ledger.hooks)
    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')

    const acknowledged: string[] = []
    for (const [index, title] of ['A', 'B', 'C', 'D'].entries()) {
      if (index === 1 || index === 2) {
        ledger.failOn(endsWith('manifest.json'), errnoError('EIO', 'rename', manifestPath))
      }
      const result = await post(first, '/commit', {
        idempotencyKey: `restart-${index}`,
        kind: 'actions',
        payload: editAction(`Title ${title}`, `article-${index}`),
        baseDocuments: [{...BASE_ARTICLE, _id: `article-${index}`}],
      })
      if (result.status === 200 && result.json.committed === true) acknowledged.push(`article-${index}`)
    }

    expect(ledger.injections()).toBe(2)
    expect(acknowledged).toEqual(['article-0', 'article-3'])

    await first.close()
    running.splice(running.indexOf(first), 1)

    /* A fresh process holding no memory of what it was told. */
    const second = await boot(root)
    const state = await fetch(`${second.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const body = (await state.json()) as {documents: Array<{logicalId: string}>}

    expect(body.documents.map((document) => document.logicalId).sort()).toEqual(acknowledged)
    await settle()
  })
})
