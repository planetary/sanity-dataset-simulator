/**
 * `sanity-overlay-studio` — the overlay API transport (PRD §25, §33).
 *
 * The one rule that outranks everything else here is §11.3's last line:
 * **"Never fall back from failed overlay writes to native Sanity writes."** So
 * this layer has exactly three outcomes and no fourth:
 *
 *   | outcome    | meaning                                    | editor is told |
 *   |------------|--------------------------------------------|----------------|
 *   | `ok`       | the overlay accepted and persisted it      | saved          |
 *   | `degraded` | transient (5xx, offline, malformed answer) | saved, loudly  |
 *   | `fatal`    | 401/403 — it provably cannot ever land     | **not saved**  |
 *
 * `degraded` is not a failure on purpose: an outage is transient, the echo has
 * already updated the pane, and shouting is more useful than throwing away the
 * user's keystrokes. A 401 is not transient, which is the whole distinction.
 *
 * `fetch` is injected. No network is touched by any test in this file.
 */
import {describe, expect, it, vi} from 'vitest'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

interface StubCall {
  url: string
  method: string
  body: Rec
}

function stubFetch(
  responder: (call: StubCall) => {status?: number; body?: unknown; text?: string} | Promise<never>,
): {fetch: typeof fetch; calls: StubCall[]} {
  const calls: StubCall[] = []
  const impl = (async (input: unknown, init?: Rec): Promise<unknown> => {
    const call: StubCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    }
    calls.push(call)
    const answer = await responder(call)
    const status = answer.status ?? 200
    const text = answer.text ?? JSON.stringify(answer.body ?? {ok: true})
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    }
  }) as unknown as typeof fetch
  return {fetch: impl, calls}
}

const OK_COMMIT = {
  ok: true,
  committed: true,
  replayed: false,
  overlayId: 'local',
  revision: 7,
  transactionId: 'tx-1',
  unsupported: [],
  documents: [
    {
      logicalId: 'article-1',
      schemaType: 'article',
      draft: {_id: 'drafts.article-1', _type: 'article', title: 'edited'},
      published: null,
    },
  ],
}

describe('commit — the request', () => {
  it('POSTs to <apiUrl>/commit with the kind, payload and idempotency key', async () => {
    const {fetch, calls} = stubFetch(() => ({body: OK_COMMIT}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})

    await transport.commit({kind: 'mutations', payload: [{patch: {id: 'a'}}]}, {
      idempotencyKey: 'tx-1',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:3998/commit')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({
      kind: 'mutations',
      payload: [{patch: {id: 'a'}}],
      idempotencyKey: 'tx-1',
    })
  })

  it('does not double the slash when the apiUrl carries a trailing one', async () => {
    const {fetch, calls} = stubFetch(() => ({body: OK_COMMIT}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998/', fetch})
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'tx-1'})
    expect(calls[0].url).toBe('http://localhost:3998/commit')
  })

  it('sends the base documents the overlay needs as a merge ancestor', async () => {
    const {fetch, calls} = stubFetch(() => ({body: OK_COMMIT}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const base = [{_id: 'article-1', _type: 'article', _rev: 'lake-1'}]
    await transport.commit(
      {kind: 'actions', payload: []},
      {idempotencyKey: 'tx-1', baseDocuments: base},
    )
    expect(calls[0].body.baseDocuments).toEqual(base)
  })
})

describe('commit — the three outcomes', () => {
  it('reports ok and hands back the materialized documents', async () => {
    const {fetch} = stubFetch(() => ({body: OK_COMMIT}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(result.outcome).toBe('ok')
    expect(result.revision).toBe(7)
    expect(result.documents?.[0]?.logicalId).toBe('article-1')
  })

  it.each([500, 502, 503, 409, 400])('treats HTTP %s as degraded, not fatal', async (status) => {
    const errors: string[] = []
    const {fetch} = stubFetch(() => ({status, body: {ok: false, error: {message: 'boom'}}}))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onError: (message) => errors.push(message),
    })
    const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(result.outcome).toBe('degraded')
    expect(errors.join(' ')).toMatch(/boom/)
  })

  it('treats a thrown fetch (offline) as degraded', async () => {
    const errors: string[] = []
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
      onError: (message) => errors.push(message),
    })
    const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(result.outcome).toBe('degraded')
    expect(errors.join(' ')).toMatch(/fetch failed/)
  })

  it('treats an unparseable answer as degraded rather than crashing the editor', async () => {
    const {fetch} = stubFetch(() => ({text: '<html>gateway</html>'}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(result.outcome).toBe('degraded')
  })

  /* ────────────────────────────────────────────────────────────────────────
   * 401/403 — WHOSE "no" WAS IT?
   *
   * `onAuthFailure` drives `echo.noteAuthFailure`, which puts the session into
   * `unauthenticated` — the "your Sanity credential is gone, stop writing" state.
   *
   * This transport, by construction, never talks to Sanity: `assertNoStagingWrite`
   * refuses to build one whose `apiUrl` points at the Content Lake. So every
   * 401/403 it sees came from OUR OWN overlay server, and treating that as a
   * Sanity credential failure logged an editor out because our server said no.
   *
   * The discriminator is STRUCTURED ORIGIN, not status. An overlay-API 401/403 is
   * a real Sanity auth signal only when the overlay explicitly says the failure
   * came from upstream — it is the only party that knows.
   * ──────────────────────────────────────────────────────────────────────── */

  it.each([401, 403])(
    'treats HTTP %s as fatal — it provably cannot land, whoever refused',
    async (status) => {
      const {fetch} = stubFetch(() => ({status, body: {ok: false, error: {message: 'nope'}}}))
      const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
      const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
      expect(result.outcome).toBe('fatal')
    },
  )

  it.each([401, 403])(
    'does NOT mark the session unauthenticated for an undeclared overlay-API %s',
    async (status) => {
      const auth: unknown[] = []
      const {fetch} = stubFetch(() => ({status, body: {ok: false, error: {message: 'nope'}}}))
      const transport = createOverlayTransport({
        apiUrl: 'http://localhost:3998',
        fetch,
        onAuthFailure: (failure) => auth.push(failure),
      })
      await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
      expect(auth).toEqual([])
    },
  )

  it.each([
    'OVERLAY_WRITE_BLOCKED',
    'OVERLAY_ORIGIN_UNIMPLEMENTED',
    'STAGING_WRITE_REFUSED',
    'UNSUPPORTED_GROQ',
  ])('never reports %s as an auth failure — it is this system’s own refusal', async (code) => {
    const auth: unknown[] = []
    const {fetch} = stubFetch(() => ({status: 403, body: {ok: false, error: {code, message: 'no'}}}))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onAuthFailure: (failure) => auth.push(failure),
    })
    const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(result.outcome).toBe('fatal')
    expect(auth).toEqual([])
  })

  /**
   * The other direction, which matters just as much: a REAL credential failure
   * must still end the session. The overlay declares it, because only the
   * overlay knows it proxied the call.
   */
  it.each([401, 403])(
    'DOES mark the session unauthenticated when the overlay declares a Sanity-origin %s',
    async (status) => {
      const auth: unknown[] = []
      const {fetch} = stubFetch(() => ({
        status,
        body: {ok: false, error: {origin: 'sanity', message: 'nope'}},
      }))
      const transport = createOverlayTransport({
        apiUrl: 'http://localhost:3998',
        fetch,
        onAuthFailure: (failure) => auth.push(failure),
      })
      const result = await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
      expect(result.outcome).toBe('fatal')
      expect(auth).toEqual([{status, source: 'write', message: expect.stringContaining('nope')}])
    },
  )

  it('accepts the origin declaration at the top level of the body too', async () => {
    const auth: unknown[] = []
    const {fetch} = stubFetch(() => ({
      status: 401,
      body: {ok: false, origin: 'sanity', error: {message: 'nope'}},
    }))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onAuthFailure: (failure) => auth.push(failure),
    })
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(auth).toHaveLength(1)
  })

  /**
   * STRUCTURED FIELDS ONLY, NEVER PROSE — the same standard `authStatusOf`
   * already holds. An overlay error whose *message* mentions Sanity is still the
   * overlay's own refusal.
   */
  it('does not read a Sanity origin out of prose', async () => {
    const auth: unknown[] = []
    const {fetch} = stubFetch(() => ({
      status: 403,
      body: {ok: false, error: {message: 'could not reach sanity origin upstream'}},
    }))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onAuthFailure: (failure) => auth.push(failure),
    })
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(auth).toEqual([])
  })

  it('an OVERLAY_* code outranks a declared Sanity origin', async () => {
    const auth: unknown[] = []
    const {fetch} = stubFetch(() => ({
      status: 403,
      body: {ok: false, error: {code: 'OVERLAY_WRITE_BLOCKED', origin: 'sanity', message: 'no'}},
    }))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onAuthFailure: (failure) => auth.push(failure),
    })
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(auth).toEqual([])
  })

  it('reports a declared Sanity-origin read failure with source "read"', async () => {
    const auth: {source?: string}[] = []
    const {fetch} = stubFetch(() => ({
      status: 401,
      body: {ok: false, error: {origin: 'sanity', message: 'nope'}},
    }))
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch,
      onAuthFailure: (failure) => auth.push(failure),
    })
    await transport.state()
    expect(auth[0]?.source).toBe('read')
  })

  it('surfaces the overlay’s own "unsupported" list instead of swallowing it', async () => {
    const {fetch} = stubFetch(() => ({
      body: {...OK_COMMIT, unsupported: ['sanity.action.document.version.create']},
    }))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const result = await transport.commit({kind: 'actions', payload: []}, {idempotencyKey: 'a'})
    expect(result.unsupported).toEqual(['sanity.action.document.version.create'])
  })
})

describe('commit ordering', () => {
  it('never lets a second commit overtake the first', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const impl = (async (input: unknown, init?: Rec): Promise<unknown> => {
      const body = JSON.parse(String(init?.body)) as Rec
      order.push(`start:${String(body.idempotencyKey)}`)
      if (body.idempotencyKey === 'tx-1') await gate
      order.push(`end:${String(body.idempotencyKey)}`)
      return {ok: true, status: 200, text: async () => JSON.stringify(OK_COMMIT)}
    }) as unknown as typeof fetch

    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch: impl})
    const first = transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'tx-1'})
    const second = transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'tx-2'})

    /* The queue hands off through a microtask, so let the loop turn once before
     * asserting. The claim under test is the ORDER, not synchronous dispatch. */
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['start:tx-1'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start:tx-1', 'end:tx-1', 'start:tx-2', 'end:tx-2'])
  })

  it('does not let one failed commit strand the queue', async () => {
    let n = 0
    const impl = (async (): Promise<unknown> => {
      n += 1
      if (n === 1) throw new Error('offline')
      return {ok: true, status: 200, text: async () => JSON.stringify(OK_COMMIT)}
    }) as unknown as typeof fetch
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch: impl})
    const [a, b] = await Promise.all([
      transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'tx-1'}),
      transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'tx-2'}),
    ])
    expect(a.outcome).toBe('degraded')
    expect(b.outcome).toBe('ok')
  })
})

describe('reads', () => {
  it('resolves documents through POST /resolve', async () => {
    const {fetch, calls} = stubFetch(() => ({
      body: {ok: true, entries: [{id: 'article-1', document: {_id: 'article-1'}}]},
    }))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const result = await transport.resolve({mode: 'version', ids: ['article-1']})
    expect(calls[0].url).toBe('http://localhost:3998/resolve')
    expect(calls[0].body).toMatchObject({mode: 'version', ids: ['article-1']})
    expect(result.outcome).toBe('ok')
  })

  it('runs a GROQ read through POST /query', async () => {
    const {fetch, calls} = stubFetch(() => ({body: {ok: true, result: []}}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    await transport.query({query: '*[_type == $t]', params: {t: 'article'}})
    expect(calls[0].url).toBe('http://localhost:3998/query')
    expect(calls[0].body).toMatchObject({query: '*[_type == $t]', params: {t: 'article'}})
  })

  it('reads the overlay state for the status banner', async () => {
    const {fetch, calls} = stubFetch(() => ({
      body: {ok: true, overlayId: 'local', revision: 12, documents: []},
    }))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    const result = await transport.state()
    expect(calls[0].url).toBe('http://localhost:3998/state')
    expect(calls[0].method).toBe('GET')
    expect(result.outcome).toBe('ok')
    expect(result.revision).toBe(12)
  })

  it('reports an unreachable overlay server as degraded, with the URL in the message', async () => {
    const errors: string[] = []
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
      onError: (message) => errors.push(message),
    })
    const result = await transport.state()
    expect(result.outcome).toBe('degraded')
    expect(errors.join(' ')).toMatch(/localhost:3998/)
  })
})

describe('the transport never invents a native fallback', () => {
  it('has no code path that returns a Sanity URL', async () => {
    const {fetch, calls} = stubFetch(() => ({status: 500, body: {ok: false}}))
    const transport = createOverlayTransport({apiUrl: 'http://localhost:3998', fetch})
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    await transport.state().catch(() => undefined)
    expect(calls.every((call) => call.url.startsWith('http://localhost:3998'))).toBe(true)
  })

  it('retries nothing by itself — retry policy belongs to the caller', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    const transport = createOverlayTransport({
      apiUrl: 'http://localhost:3998',
      fetch: fetchSpy as unknown as typeof fetch,
    })
    await transport.commit({kind: 'mutations', payload: []}, {idempotencyKey: 'a'})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
