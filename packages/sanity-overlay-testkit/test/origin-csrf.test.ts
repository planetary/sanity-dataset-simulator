/**
 * MODE 2 (origin) — cross-site request forgery on the two write routes, and the
 * CORS grant that decides who may read the branch.
 *
 * THE DEFECT THIS FILE PINS
 * `docs/plans/evidence/phase-1/security-review-2026-08-06.md` P2-4, both halves:
 *
 *   1. `POST /v…/data/mutate/<ds>` and `/data/actions/<ds>` reached the overlay
 *      with no `Origin` and no `Content-Type` check. `POST` +
 *      `Content-Type: text/plain` is CORS-SAFELISTED, so no preflight fires and
 *      any page the developer has open can drive the write. Mode 2's identity is
 *      synthetic and FULLY GRANTED by design (`originSafety.mjs`), so there is no
 *      authentication anywhere behind these routes.
 *   2. The transport reflects the request `Origin` verbatim together with
 *      `Access-Control-Allow-Credentials: true`, which lets ANY site read every
 *      response — i.e. the entire branch, including every unpublished draft.
 *
 * The loopback bind (`originSafety.mjs`) stops a LAN attacker and is sound. It
 * stops nothing here: a page running in the developer's own browser is on
 * loopback by definition.
 *
 * WHERE THE FIX LIVES, AND WHERE IT CANNOT
 * `corsHeaders` is computed in `examples/kitchen-sink/spikeB-proxy/proxy.mjs`,
 * which is another agent's file. What Mode 2 CAN do — and what these tests
 * require — is refuse to serve a grant it would not have issued itself: every
 * byte of branch content in Mode 2 leaves through `origin.mjs`, so sanitising
 * the inherited CORS headers there closes the exfiltration for the data that
 * actually matters, whatever the transport computed. The residual — the
 * preflight answered at `proxy.mjs:508`, and Mode 1 forwarding — is reported
 * rather than edited.
 *
 * THE POLICY
 *   - a state-changing route requires `Content-Type: application/json`, which
 *     takes the request out of the safelisted set and forces a preflight;
 *   - `Sec-Fetch-Site: cross-site` is refused (browsers set it, page JS cannot
 *     forge it);
 *   - an `Origin` that is present must be a LOOPBACK origin, or explicitly
 *     named. Loopback is derived structurally, exactly as the bind check is:
 *     Mode 2 binds loopback-only and its one client is a local dev server whose
 *     port cannot be known in advance. A page at `https://evil.example` — or one
 *     DNS-rebound to 127.0.0.1, which keeps its own origin — is refused;
 *   - `Origin` absent is allowed: curl and the recorded-session replays carry no
 *     ambient browser credential and are not the threat.
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

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'
const EVIL_ORIGIN = 'https://evil.example'
const STUDIO_ORIGIN = 'http://localhost:3333'

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>; revision: number}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-csrf-'))
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-csrf-test',
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

interface Answer {
  status: number
  json: any
  headers: Headers
}

let sequence = 0

function creation(): unknown {
  sequence += 1
  return {
    mutations: [
      {createOrReplace: {_id: `csrf-${sequence}`, _type: 'article', title: 'forged'}},
    ],
  }
}

async function send(
  target: string,
  headers: Record<string, string>,
  body: unknown,
  method = 'POST',
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text),
    headers: response.headers,
  }
}

const WRITE_ROUTES = [`${V}/data/mutate/${DATASET}`, `${V}/data/actions/${DATASET}`]

function bodyFor(route: string): unknown {
  return route.includes('/actions/')
    ? {
        actions: [
          {
            actionType: 'sanity.action.document.create',
            publishedId: `csrf-a-${(sequence += 1)}`,
            attributes: {_id: `csrf-a-${sequence}`, _type: 'article', title: 'forged'},
          },
        ],
      }
    : creation()
}

/* ------------------------------------------------------------------ *
 * 1. Both state-changing routes refuse a forged cross-site write
 * ------------------------------------------------------------------ */

describe('the Mode 2 write routes refuse a cross-site request', () => {
  for (const route of WRITE_ROUTES) {
    it(`${route} refuses the CORS-safelisted text/plain simple request`, async () => {
      const before = handler.revision
      const {status, json} = await send(
        route,
        {'content-type': 'text/plain', origin: EVIL_ORIGIN},
        bodyFor(route),
      )
      expect(status).toBe(415)
      expect(json?.error?.code).toBe('OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE')
      expect(handler.revision).toBe(before)
    })

    it(`${route} refuses a non-loopback Origin`, async () => {
      const before = handler.revision
      const {status, json} = await send(
        route,
        {'content-type': 'application/json', origin: EVIL_ORIGIN},
        bodyFor(route),
      )
      expect(status).toBe(403)
      expect(json?.error?.code).toBe('OVERLAY_ORIGIN_FORBIDDEN_ORIGIN')
      expect(handler.revision).toBe(before)
    })

    it(`${route} refuses Sec-Fetch-Site: cross-site with no Origin`, async () => {
      const before = handler.revision
      const {status} = await send(
        route,
        {'content-type': 'application/json', 'sec-fetch-site': 'cross-site'},
        bodyFor(route),
      )
      expect(status).toBe(403)
      expect(handler.revision).toBe(before)
    })

    it(`${route} refuses the opaque \`null\` origin`, async () => {
      const before = handler.revision
      const {status} = await send(
        route,
        {'content-type': 'application/json', origin: 'null'},
        bodyFor(route),
      )
      expect(status).toBe(403)
      expect(handler.revision).toBe(before)
    })

    it(`${route} refuses an origin that merely LOOKS loopback`, async () => {
      /* The DNS-rebinding shape: the page keeps its own origin however its name
       * resolves. `localhost.evil.example` is an ordinary name. */
      for (const origin of [
        'http://localhost.evil.example',
        'http://notlocalhost:3333',
        'http://127.0.0.1.evil.example',
        'https://evil.example:3333',
      ]) {
        const before = handler.revision
        const {status} = await send(
          route,
          {'content-type': 'application/json', origin},
          bodyFor(route),
        )
        expect(status).toBe(403)
        expect(handler.revision).toBe(before)
      }
    })
  }
})

/* ------------------------------------------------------------------ *
 * 2. The callers Mode 2 exists for keep working
 * ------------------------------------------------------------------ */

describe('the Mode 2 write routes still accept every legitimate caller', () => {
  it('accepts the local Studio dev origin', async () => {
    const {status} = await send(
      WRITE_ROUTES[0]!,
      {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      creation(),
    )
    expect(status).toBe(200)
  })

  for (const origin of ['http://127.0.0.1:3333', 'http://[::1]:3333', 'http://localhost:5173']) {
    it(`accepts the loopback origin ${origin}`, async () => {
      const {status} = await send(
        WRITE_ROUTES[0]!,
        {'content-type': 'application/json', origin},
        creation(),
      )
      expect(status).toBe(200)
    })
  }

  it('accepts a non-browser caller with no Origin at all', async () => {
    const {status} = await send(
      WRITE_ROUTES[0]!,
      {'content-type': 'application/json'},
      creation(),
    )
    expect(status).toBe(200)
  })

  it('accepts a charset parameter on the content type', async () => {
    const {status} = await send(
      WRITE_ROUTES[0]!,
      {'content-type': 'application/json; charset=utf-8', origin: STUDIO_ORIGIN},
      creation(),
    )
    expect(status).toBe(200)
  })

  it('leaves the read routes alone', async () => {
    /* A GET query carries no body and cannot be a forged write; imposing a
     * content type on it would break every read Studio makes. */
    const query = encodeURIComponent('*[_type == "article"][0..1]')
    const {status} = await send(
      `${V}/data/query/${DATASET}?query=${query}`,
      {origin: STUDIO_ORIGIN},
      undefined,
      'GET',
    )
    expect(status).toBe(200)
  })
})

/* ------------------------------------------------------------------ *
 * 3. The branch is not readable by an arbitrary origin
 * ------------------------------------------------------------------ */

describe('Mode 2 never hands an arbitrary origin a credentialled CORS grant', () => {
  const READ_ROUTES = [
    `${V}/data/query/${DATASET}?query=${encodeURIComponent('*[_type == "article"]')}`,
    `${V}/data/doc/${DATASET}/csrf-1`,
    `${V}/users/me`,
    `${V}/projects/${PROJECT_ID}`,
  ]

  for (const route of READ_ROUTES) {
    it(`${route.split('?')[0]} refuses to reflect an arbitrary origin`, async () => {
      const {headers} = await send(route, {origin: EVIL_ORIGIN}, undefined, 'GET')
      /* Reflecting the origin AND advertising credentials is the exact
       * combination that turns a local dev server into an exfiltration
       * endpoint for every unpublished draft in the branch. */
      expect(headers.get('access-control-allow-origin')).not.toBe(EVIL_ORIGIN)
      expect(headers.get('access-control-allow-credentials')).toBeNull()
    })
  }

  it('still grants the local Studio origin, with credentials, because it needs them', async () => {
    const {headers} = await send(
      `${V}/data/query/${DATASET}?query=${encodeURIComponent('*[_type == "article"][0]')}`,
      {origin: STUDIO_ORIGIN},
      undefined,
      'GET',
    )
    expect(headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
    expect(headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('leaves a non-browser caller unaffected', async () => {
    const {status} = await send(`${V}/users/me`, {}, undefined, 'GET')
    expect(status).toBe(200)
  })

  it('does not reflect an arbitrary origin on a REFUSAL either', async () => {
    /* A 403 body is small, but it still names the dataset and the mode. More to
     * the point: an error response that carries a grant is a grant. */
    const {headers} = await send(
      WRITE_ROUTES[0]!,
      {'content-type': 'application/json', origin: EVIL_ORIGIN},
      creation(),
    )
    expect(headers.get('access-control-allow-origin')).not.toBe(EVIL_ORIGIN)
    expect(headers.get('access-control-allow-credentials')).toBeNull()
  })
})
