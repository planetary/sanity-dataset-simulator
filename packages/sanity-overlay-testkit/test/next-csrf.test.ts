/**
 * `sanity-overlay-next` — cross-site request forgery on the write route, and the
 * CORS policy that decides who may read the branch.
 *
 * THE DEFECT THIS FILE PINS
 * `docs/plans/evidence/phase-1/security-review-2026-08-06.md` P2-4: `POST
 * /commit` accepted a body with no `Origin` check and no `Content-Type` check.
 * `POST` + `Content-Type: text/plain` is CORS-SAFELISTED, so no preflight ever
 * fires and any page the developer happens to have open can drive the write:
 *
 *   fetch('http://localhost:3998/commit', {
 *     method: 'POST', mode: 'no-cors',
 *     headers: {'Content-Type': 'text/plain'},
 *     body: JSON.stringify({idempotencyKey: 'x', kind: 'mutations', payload: […]}),
 *   })
 *
 * The loopback bind is no defence at all here: a page running in the
 * developer's own browser IS on loopback.
 *
 * THE POLICY THIS FILE PINS, AND WHY EACH HALF EXISTS
 *
 *   1. A state-changing route requires `Content-Type: application/json`.
 *      That single requirement takes the request out of the CORS-safelisted set,
 *      so a cross-origin browser must send a PREFLIGHT first — and the preflight
 *      is answered by the existing allowlist, which grants nothing by default.
 *      It is the cheapest control that closes the whole simple-request class.
 *   2. `Sec-Fetch-Site: cross-site` is refused. Browsers set it; page JS cannot
 *      forge it (it is a forbidden header name). It is what survives a client
 *      that omits `Origin`.
 *   3. An `Origin` that is present must be the request's own origin, or on the
 *      allowlist. Same-origin is recognised structurally rather than
 *      allowlisted, so an App Router mounting — which is same-origin by
 *      construction and grants no origins — keeps working.
 *   4. `Origin` ABSENT is allowed. curl, a Node client and the CLI have no
 *      ambient browser credentials and are not the threat this control exists
 *      for; refusing them would break every non-browser caller to no benefit.
 *
 * AND THE READ HALF: this API serves the ENTIRE branch — every draft, every
 * unpublished edit — so the CORS grant is an exfiltration control, not a
 * convenience. It must never reflect an arbitrary origin, and it must never
 * advertise `Access-Control-Allow-Credentials` at all.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayApi, startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApi} from '../../sanity-overlay-next/src/index'

type Rec = Record<string, unknown>

const OVERLAY_ID = 'next-csrf-overlay-0000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'
const EVIL_ORIGIN = 'https://evil.example'
const API_ORIGIN = 'http://localhost:3998'

const roots: string[] = []
const closers: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const closer of closers.splice(0)) await closer.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 7, 6, 0, 0, tick)).toISOString()
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-csrf-'))
  roots.push(root)
  return root
}

async function boot(origins: readonly string[] = [STUDIO_ORIGIN]): Promise<OverlayApi> {
  const root = await makeRoot()
  const now = makeClock()
  const api = await createOverlayApi({
    store: new FsOverlayStore({root, now}),
    overlayId: OVERLAY_ID,
    now,
    origins,
  })
  closers.push(api)
  return api
}

const SEED_PAYLOAD = [{createOrReplace: {_id: 'article-1', _type: 'article', title: 'seed'}}]

function commitRequest(headers: Record<string, string>, key = 'csrf-1'): Request {
  return new Request(`${API_ORIGIN}/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({idempotencyKey: key, kind: 'mutations', payload: SEED_PAYLOAD}),
  })
}

async function answer(api: OverlayApi, request: Request): Promise<{status: number; json: Rec}> {
  const response = await api.handle(request)
  return {status: response.status, json: (await response.json()) as Rec}
}

/* ------------------------------------------------------------------ *
 * 1. The state-changing route refuses a forged cross-origin write
 * ------------------------------------------------------------------ */

describe('POST /commit refuses a cross-site write', () => {
  it('refuses the CORS-safelisted `text/plain` simple request outright', async () => {
    const api = await boot()
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'text/plain', origin: EVIL_ORIGIN}),
    )
    expect(status).toBe(415)
    expect((json.error as Rec).code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(api.revision).toBe(0)
  })

  it('refuses `text/plain` even from the allowlisted Studio origin', async () => {
    /* The content-type requirement is what forces a preflight; it cannot be a
     * function of who is asking, or the safelisted shape stays reachable. */
    const api = await boot()
    const {status} = await answer(
      api,
      commitRequest({'content-type': 'text/plain', origin: STUDIO_ORIGIN}),
    )
    expect(status).toBe(415)
    expect(api.revision).toBe(0)
  })

  for (const contentType of [
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json-patch+json',
    '',
  ]) {
    it(`refuses content-type ${JSON.stringify(contentType)}`, async () => {
      const api = await boot()
      const {status} = await answer(
        api,
        commitRequest(
          contentType === ''
            ? {origin: STUDIO_ORIGIN}
            : {'content-type': contentType, origin: STUDIO_ORIGIN},
        ),
      )
      expect(status).toBe(415)
      expect(api.revision).toBe(0)
    })
  }

  it('refuses a non-allowlisted Origin even with a JSON content type', async () => {
    const api = await boot()
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'application/json', origin: EVIL_ORIGIN}),
    )
    expect(status).toBe(403)
    expect((json.error as Rec).code).toBe('FORBIDDEN_ORIGIN')
    expect(api.revision).toBe(0)
  })

  it('refuses `Sec-Fetch-Site: cross-site` even when Origin is absent', async () => {
    const api = await boot()
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'application/json', 'sec-fetch-site': 'cross-site'}),
    )
    expect(status).toBe(403)
    expect((json.error as Rec).code).toBe('FORBIDDEN_ORIGIN')
    expect(api.revision).toBe(0)
  })

  it('refuses the `null` opaque origin', async () => {
    /* A sandboxed iframe or a `data:` document sends `Origin: null`. It is not a
     * name that can be allowlisted, so it can only ever be refused. */
    const api = await boot()
    const {status} = await answer(
      api,
      commitRequest({'content-type': 'application/json', origin: 'null'}),
    )
    expect(status).toBe(403)
    expect(api.revision).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 2. The callers that must keep working
 * ------------------------------------------------------------------ */

describe('POST /commit still accepts every legitimate caller', () => {
  it('accepts the allowlisted Studio origin', async () => {
    const api = await boot()
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'application/json', origin: STUDIO_ORIGIN}),
    )
    expect(status).toBe(200)
    expect(json.committed).toBe(true)
  })

  it('accepts a same-origin request even when NO origin is allowlisted', async () => {
    /* The App Router mounting: same-origin by construction, `origins: []`. */
    const api = await boot([])
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'application/json', origin: API_ORIGIN}),
    )
    expect(status).toBe(200)
    expect(json.committed).toBe(true)
  })

  it('accepts `Sec-Fetch-Site: same-origin` when the Origin header is rewritten by a proxy', async () => {
    const api = await boot([])
    const {status, json} = await answer(
      api,
      commitRequest({
        'content-type': 'application/json',
        origin: 'https://app.example.com',
        'sec-fetch-site': 'same-origin',
      }),
    )
    expect(status).toBe(200)
    expect(json.committed).toBe(true)
  })

  it('accepts a non-browser caller that sends no Origin at all', async () => {
    const api = await boot([])
    const {status, json} = await answer(api, commitRequest({'content-type': 'application/json'}))
    expect(status).toBe(200)
    expect(json.committed).toBe(true)
  })

  it('accepts a charset parameter on the content type', async () => {
    const api = await boot()
    const {status, json} = await answer(
      api,
      commitRequest({'content-type': 'application/json; charset=utf-8', origin: STUDIO_ORIGIN}),
    )
    expect(status).toBe(200)
    expect(json.committed).toBe(true)
  })

  it('does not impose the content type on the READ routes', async () => {
    /* `/state` and `/health` are GETs; `/resolve` and `/query` are POSTs that
     * change nothing. CORS already stops a cross-origin page reading their
     * answers, and 415-ing them would break callers for no security gain. */
    const api = await boot()
    const response = await api.handle(
      new Request(`${API_ORIGIN}/resolve`, {
        method: 'POST',
        headers: {origin: STUDIO_ORIGIN},
        body: JSON.stringify({ids: ['article-1']}),
      }),
    )
    expect(response.status).toBe(200)
  })
})

/* ------------------------------------------------------------------ *
 * 3. The CORS grant is an exfiltration control
 * ------------------------------------------------------------------ */

describe('the CORS grant never reflects an arbitrary origin', () => {
  for (const route of ['/health', '/state']) {
    it(`${route} gives an arbitrary origin no grant`, async () => {
      const api = await boot()
      const response = await api.handle(
        new Request(`${API_ORIGIN}${route}`, {headers: {origin: EVIL_ORIGIN}}),
      )
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()
      expect(response.headers.get('vary')).toMatch(/origin/i)
    })
  }

  it('never advertises Access-Control-Allow-Credentials, even to an allowlisted origin', async () => {
    /* Reflecting an origin AND advertising credentials is the combination that
     * turns a local dev server into a data-exfiltration endpoint. This API needs
     * no ambient credential, so the header is simply never emitted — which means
     * a future widening of the allowlist cannot resurrect the hole. */
    const api = await boot()
    for (const route of ['/health', '/state']) {
      const response = await api.handle(
        new Request(`${API_ORIGIN}${route}`, {headers: {origin: STUDIO_ORIGIN}}),
      )
      expect(response.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    }
  })

  it('answers a preflight from an arbitrary origin with no grant', async () => {
    const api = await boot()
    const response = await api.handle(
      new Request(`${API_ORIGIN}/commit`, {
        method: 'OPTIONS',
        headers: {
          origin: EVIL_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    )
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('answers a preflight from the Studio origin with a grant that names it', async () => {
    const api = await boot()
    const response = await api.handle(
      new Request(`${API_ORIGIN}/commit`, {
        method: 'OPTIONS',
        headers: {origin: STUDIO_ORIGIN, 'access-control-request-method': 'POST'},
      }),
    )
    expect(response.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
    expect(response.headers.get('access-control-allow-methods')).toMatch(/POST/)
  })
})

/* ------------------------------------------------------------------ *
 * 4. The same policy over a real socket
 * ------------------------------------------------------------------ */

describe('the node:http mounting enforces the same policy', () => {
  it('refuses the forged simple request over a real socket and writes nothing', async () => {
    const root = await makeRoot()
    const server = await startOverlayApiServer({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
    })
    closers.push(server)

    const forged = await fetch(`${server.url}/commit`, {
      method: 'POST',
      headers: {'content-type': 'text/plain', origin: EVIL_ORIGIN},
      body: JSON.stringify({idempotencyKey: 'forged', kind: 'mutations', payload: SEED_PAYLOAD}),
    })
    expect(forged.status).toBe(415)
    expect(server.revision).toBe(0)

    const legitimate = await fetch(`${server.url}/commit`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: JSON.stringify({idempotencyKey: 'ok', kind: 'mutations', payload: SEED_PAYLOAD}),
    })
    expect(legitimate.status).toBe(200)
    expect(server.revision).toBeGreaterThan(0)
  })
})
