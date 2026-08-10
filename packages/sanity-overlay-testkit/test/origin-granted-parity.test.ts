/**
 * Mode 2's origin allowlist has exactly ONE definition.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DRIFT THIS FILE EXISTS FOR
 *
 * `examples/kitchen-sink/spikeB-proxy/origin.mjs` kept a private copy of
 * `isGrantedOrigin`, duplicating the one `originSafety.mjs` exports and
 * `proxy.mjs` imports. Two copies of a security predicate is the shape of the
 * bug that produced the 2026-08-06 CORS hole (P2-4) in the first place: the two
 * agreed when they were written and nothing made them keep agreeing.
 *
 * They had ALREADY diverged. The private copy read
 *
 *     if (allowed.has('*') || allowed.has(value)) return true
 *
 * where the shared one has no wildcard clause at all — `normalizeGrantedOrigins`
 * refuses `'*'` outright, because the proxy reflects the granted origin back
 * with `Access-Control-Allow-Credentials: true` and a wildcard there is the hole
 * restated as configuration. `origin.mjs` never called that normaliser, so
 * `createOriginHandler({origins: ['*']})` granted `https://evil.example` a
 * state-changing request against the branch, and the proxy's own front door
 * would have refused the same list.
 *
 * WHAT THIS FILE ASSERTS
 *
 *   1. EQUIVALENCE, over a corpus, run against BOTH implementations at once:
 *      the origin handler's live decision on a real HTTP write is compared with
 *      `isGrantedOrigin` from `originSafety.mjs` — the shared oracle — for every
 *      origin shape. This case passes before AND after the copy is deleted, and
 *      is what makes the deletion provably not a behaviour change.
 *   2. THE ONE DIVERGENCE, closed in the SAFE direction: with `origins: ['*']`
 *      the handler must now refuse a hostile origin. The swap can only ever
 *      narrow — the shared predicate grants a strict subset of what the private
 *      copy granted, for any allowlist — so no control is weakened by it.
 *   3. NO SECOND DEFINITION SURVIVES, structurally.
 *
 * The oracle is never a value the handler produced: `isGrantedOrigin` is
 * imported from the other module and evaluated independently, and the handler's
 * answer is read off an HTTP status.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'
import {
  isGrantedOrigin,
  // @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
} from '../../../examples/kitchen-sink/spikeB-proxy/originSafety.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'

/**
 * Every origin shape the predicate has to decide, in one list.
 *
 * Loopback in its several spellings, the near-misses that a substring or suffix
 * check would wrongly admit, the opaque and unparseable values a hostile iframe
 * sends, and a non-loopback origin that is only granted because it was NAMED.
 */
const CORPUS: readonly string[] = Object.freeze([
  'http://localhost:3333',
  'http://localhost',
  'http://127.0.0.1:5173',
  'http://127.0.0.1',
  'https://127.0.0.1:8443',
  'http://127.1.2.3:3000',
  'http://[::1]:3333',
  'http://[0:0:0:0:0:0:0:1]:3333',
  'https://evil.example',
  'http://evil.example:3333',
  'http://localhost.evil.example',
  'http://127.0.0.1.evil.example',
  'http://notlocalhost',
  'null',
  'not a url',
  'ftp://127.0.0.1',
  'file://',
  'http://named.example',
])

/** The one non-loopback origin an allowlist names explicitly. */
const NAMED = 'http://named.example'

interface Mode2 {
  readonly url: string
  readonly close: () => Promise<void>
}

const started: Mode2[] = []
const roots: string[] = []

async function startMode2(origins?: readonly string[]): Promise<Mode2> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-granted-parity-'))
  roots.push(root)
  const handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-granted-parity',
    ...(origins === undefined ? {} : {origins: [...origins]}),
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
  const mode2: Mode2 = {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  started.push(mode2)
  return mode2
}

let sequence = 0

/**
 * Does the LIVE handler grant this origin a state-changing request?
 *
 * Read off the wire: `403 OVERLAY_ORIGIN_FORBIDDEN_ORIGIN` is the refusal the
 * allowlist produces, and it is the only one this request can provoke — the
 * content type is correct and `Sec-Fetch-Site` is absent, so the other two
 * clauses of `assertWriteIsNotForged` cannot fire.
 */
async function handlerGrants(mode2: Mode2, origin: string): Promise<boolean> {
  sequence += 1
  const response = await fetch(`${mode2.url}${V}/data/mutate/${DATASET}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin},
    body: JSON.stringify({
      mutations: [
        {
          createOrReplace: {
            _id: `granted-parity-${sequence}`,
            _type: 'article',
            title: 'probe',
          },
        },
      ],
    }),
  })
  const text = await response.text()
  const json = text === '' ? null : (JSON.parse(text) as {error?: {code?: string}})
  if (response.status === 403 && json?.error?.code === 'OVERLAY_ORIGIN_FORBIDDEN_ORIGIN') {
    return false
  }
  /* Any other refusal would mean the probe provoked the wrong clause, which
   * would make the comparison below meaningless rather than merely wrong. */
  expect(response.status, `unexpected refusal for ${origin}: ${text}`).toBeLessThan(400)
  return true
}

beforeAll(async () => {
  /* Two handlers, one per allowlist, so each case is a fresh decision rather
   * than a mutation of a shared one. */
})

afterAll(async () => {
  for (const mode2 of started.splice(0)) await mode2.close()
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true})
})

describe('the Mode 2 handler and the shared predicate agree, origin for origin', () => {
  const ALLOWLISTS: ReadonlyArray<{name: string; origins?: readonly string[]}> = [
    {name: 'the default (loopback only)'},
    {name: 'an explicitly named non-loopback origin', origins: [NAMED]},
  ]

  for (const allowlist of ALLOWLISTS) {
    it(`matches \`isGrantedOrigin\` for every corpus origin under ${allowlist.name}`, async () => {
      const mode2 = await startMode2(allowlist.origins)
      const allowed = new Set(allowlist.origins ?? [])

      const disagreements: string[] = []
      for (const origin of CORPUS) {
        /* The two implementations, on the same input. */
        const live = await handlerGrants(mode2, origin)
        const shared = isGrantedOrigin(origin, allowed) as boolean
        if (live !== shared) {
          disagreements.push(`${origin}: handler=${live} originSafety=${shared}`)
        }
      }

      expect(disagreements).toEqual([])

      /* THE FALSIFIER. If `isGrantedOrigin` were a function that always agreed
       * — say it returned whatever the handler did — the loop above would pass
       * vacuously. These two pin the oracle to opposite answers, from the
       * oracle alone, so an all-true or all-false predicate fails here. */
      expect(isGrantedOrigin('http://127.0.0.1:5173', allowed)).toBe(true)
      expect(isGrantedOrigin('https://evil.example', allowed)).toBe(false)
    }, 60_000)
  }
})

describe('a wildcard allowlist grants nothing it should not', () => {
  /**
   * THE DIVERGENCE THE PRIVATE COPY CARRIED.
   *
   * `origin.mjs` never ran its `origins` list through `normalizeGrantedOrigins`,
   * which refuses `'*'`, and its private predicate honoured `allowed.has('*')`.
   * So a wildcard list — refused at the proxy's own front door — granted a
   * hostile page a write against the branch here.
   */
  it('refuses a hostile origin even when the allowlist says `*`', async () => {
    const mode2 = await startMode2(['*'])

    expect(await handlerGrants(mode2, 'https://evil.example')).toBe(false)
    expect(await handlerGrants(mode2, 'http://localhost.evil.example')).toBe(false)
    /* Loopback is still granted — the fix narrows the wildcard, it does not
     * break the one client Mode 2 exists to serve. */
    expect(await handlerGrants(mode2, 'http://localhost:3333')).toBe(true)
  }, 60_000)

  it('agrees with the shared predicate on the wildcard list too', async () => {
    const mode2 = await startMode2(['*'])
    const allowed = new Set(['*'])

    for (const origin of CORPUS) {
      expect(await handlerGrants(mode2, origin), `origin ${origin}`).toBe(
        isGrantedOrigin(origin, allowed),
      )
    }
  }, 60_000)
})

describe('there is one definition of the allowlist, not two', () => {
  const SOURCE = fs.readFileSync(
    fileURLToPath(
      new URL('../../../examples/kitchen-sink/spikeB-proxy/origin.mjs', import.meta.url),
    ),
    'utf8',
  )

  it('declares no `isGrantedOrigin` of its own', () => {
    /* A second definition is the whole defect; a comment mentioning the name is
     * not, so the match is on a DECLARATION. */
    expect(SOURCE).not.toMatch(/^\s*(?:export\s+)?(?:async\s+)?function\s+isGrantedOrigin\b/m)
    expect(SOURCE).not.toMatch(/^\s*(?:const|let|var)\s+isGrantedOrigin\b/m)
  })

  it('imports it from `originSafety.mjs`, the module `proxy.mjs` imports', () => {
    const imports = /import\s*\{([^}]*)\}\s*from\s*'\.\/originSafety\.mjs'/.exec(SOURCE)
    expect(imports, 'origin.mjs must import from ./originSafety.mjs').not.toBeNull()
    expect((imports as RegExpExecArray)[1]).toMatch(/\bisGrantedOrigin\b/)
  })
})
