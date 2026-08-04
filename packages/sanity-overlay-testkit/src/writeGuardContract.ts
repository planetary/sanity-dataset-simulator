/**
 * The write-guard contract — the permanent, reusable classification suite that
 * every write-blocking implementation in this project must pass (PRD §35.14
 * security suite; §36.1 Track B "reject unknown write-capable endpoints").
 *
 * WHY THIS EXISTS
 * ---------------
 * Spike F attacked the client-side facade with 27 attacks and found six real
 * escapes (docs/plans/evidence/phase-1/spike-f-safety-boundary/report.md).
 * Four of the six were *classification* bugs — the guard looked at a raw URL
 * string with a regex and got the answer wrong:
 *
 *   gap 20  `request({url: 'data/mutate/parity'})` — no leading slash, because
 *           `@sanity/client`'s `_getUrl()` does `uri.replace(/^\//, '')`.
 *   gap 21  `/assets/*` was not in the guard at all.
 *   gap 23  `POST /agent/action/patch/<dataset>` was guarded by neither the
 *           facade nor the Track B proxy (whose allowlist passed `/agent/*`).
 *   gap 24  `client.datasets` (`PUT|PATCH|DELETE /datasets/<name>`) unguarded.
 *
 * (gaps 18/19 — `Patch.clone().commit()` / `Transaction.clone().commit()` — are
 * a facade object-wrapping defect, not a URL-classification defect, and belong
 * to the facade's own suite. Every network path they reach lands on one of the
 * endpoints classified here.)
 *
 * The project TDD rule is that a found bug earns tests for the instance *and*
 * the whole class. So this contract does not test four URLs; it tests four
 * classes: URL normalisation, write endpoints, read passthrough, and methods —
 * plus the fail-closed default that turns "endpoint we have never seen" into
 * "blocked" rather than "allowed".
 *
 * HOW TO JOIN
 * -----------
 * Any implementation that can answer "is this request a write?" runs the whole
 * suite in one line:
 *
 *     runWriteGuardContract('spikeB proxy', isWriteRequest)
 *
 * The predicate receives the *raw* request line — method plus whatever URL the
 * caller produced, unnormalised — because normalisation is precisely where the
 * historical bugs lived. A guard that only works on pre-cleaned input is a
 * guard that has not been tested.
 *
 * ENDPOINT INVENTORY
 * ------------------
 * The write endpoints below were derived from `@sanity/client@7.26.0`'s source
 * (`node_modules/.pnpm/@sanity+client@7.26.0/.../src`) by grepping every place
 * a request URL is constructed — `uri:` literals, `_getDataUrl()`,
 * `buildAssetUploadUrl()` and `resourceDataBase()`:
 *
 *   /data/<op>/<dataset>              `_getDataUrl()` — op ∈ mutate | actions |
 *                                     query | doc | listen | history |
 *                                     live/events
 *   assets/images/<dataset>           `buildAssetUploadUrl()` — note: NO leading
 *   assets/files/<dataset>            slash, exactly the gap-20 shape
 *   /agent/action/patch/<dataset>     agent/actions/patch.ts
 *   /agent/action/generate/<dataset>  agent/actions/generate.ts
 *   /agent/action/transform/<dataset> agent/actions/transform.ts
 *   /agent/action/translate/<dataset> agent/actions/translate.ts
 *   /agent/action/prompt/<dataset>    agent/actions/prompt.ts
 *   /datasets/<name>                  DatasetsClient `_modify()` PUT/PATCH/DELETE
 *   /datasets/<name>/settings/embeddings          PUT
 *   /projects/<id>/datasets/<name>/settings/embeddings   PUT (useProjectHostname:false)
 *   /canvases/<id>/assets/{images,files}          `buildAssetUploadUrl()`
 *   /dashboards/<id>/assets/{images,files}        `buildAssetUploadUrl()`
 *   /media-libraries/<id>/upload                  `buildAssetUploadUrl()`
 *   <resourceBase>/mutate, <resourceBase>/actions `resourceDataBase()` — the
 *     resource-scoped data plane, where resourceBase is
 *     /projects/<p>/datasets/<d> | /canvases/<id> | /media-libraries/<id> |
 *     /dashboards/<id>. These mutate Content Lake WITHOUT a `/data/` prefix.
 */
import {describe, expect, it} from 'vitest'

/** The five classes of defect this contract covers. */
export type WriteGuardGroup =
  | 'url-normalisation'
  | 'write-endpoints'
  | 'read-passthrough'
  | 'methods'
  | 'fail-closed'

export interface WriteGuardRequest {
  method: string
  url: string
}

/** One classification assertion. */
export interface WriteGuardCase extends WriteGuardRequest {
  group: WriteGuardGroup
  /** Expected answer: `true` = this request writes and must be blocked. */
  write: boolean
  /** Why — read out loud in the test name, so a failure explains itself. */
  why: string
  /** Spike F attack number this case is a regression witness for, if any. */
  gap?: number
}

/** The predicate under test. */
export type WriteGuardPredicate = (req: WriteGuardRequest) => boolean

const DS = 'parity'
const PID = 'b1n03q3z'

/* ------------------------------------------------------------------ *
 * 1. URL normalisation — the same endpoint, spelled every legal way
 * ------------------------------------------------------------------ */

const NORMALISATION: WriteGuardCase[] = (
  [
    ['/data/mutate/' + DS, 'canonical mutate path'],
    ['data/mutate/' + DS, 'no leading slash — @sanity/client `_getUrl` strips it', 20],
    ['data/actions/' + DS, 'no leading slash on the Actions API (the real write path)', 20],
    ['//data/mutate/' + DS, 'duplicated leading slash'],
    ['/data//mutate//' + DS, 'duplicated slashes mid-path'],
    ['/v2025-02-19/data/mutate/' + DS, 'dated API-version prefix'],
    ['/v2026-05-04/data/actions/' + DS, 'a different dated API version'],
    ['/vX/data/mutate/' + DS, 'the `X` (experimental) API version'],
    ['/v1/data/mutate/' + DS, 'a numeric API version'],
    ['/v1/v2025-02-19/data/mutate/' + DS, 'stacked API-version prefixes'],
    ['/data/mutate/' + DS + '/', 'trailing slash'],
    ['/DATA/MUTATE/' + DS, 'upper-case path'],
    ['/Data/Actions/' + DS, 'mixed-case path'],
    ['/%64ata/mutate/' + DS, 'percent-encoded letter (%64 = "d")'],
    ['/%2Fdata%2Fmutate%2F' + DS, 'percent-encoded separators'],
    ['%2fdata%2fmutate%2f' + DS, 'percent-encoded separators, lower-case hex, no leading slash'],
    ['/%252Fdata%252Fmutate%252F' + DS, 'double percent-encoded separators'],
    ['/data/mutate/' + DS + '%zz', 'malformed percent-escape must not crash the decoder'],
    ['/data/./mutate/' + DS, 'a "." segment'],
    ['/x/../data/mutate/' + DS, 'a ".." segment climbing back to the write path'],
    ['/data/query/../mutate/' + DS, '".." turning a read path into the write path'],
    ['/data/mutate/' + DS + '?returnIds=true&tag=x', 'query string on the write path'],
    ['/data/mutate/' + DS + '#fragment', 'fragment on the write path'],
    ['/v2025-02-19//data/./actions//' + DS + '/', 'every trick at once'],
    [
      'https://' + PID + '.api.sanity.io/v2025-02-19/data/mutate/' + DS,
      'fully-qualified URL rather than a request-line path',
    ],
    ['/data/mutate/' + DS + '%3Ffake=1', 'percent-encoded "?" must not hide the path'],
  ] as [string, string, number?][]
).map(([url, why, gap]) => ({
  group: 'url-normalisation' as const,
  method: 'POST',
  url,
  write: true,
  why,
  ...(gap === undefined ? {} : {gap}),
}))

/** Normalisation must not manufacture writes out of reads, either. */
const NORMALISATION_NEGATIVE: WriteGuardCase[] = [
  {
    group: 'url-normalisation',
    method: 'GET',
    url: '/ping?next=/data/mutate/' + DS,
    write: false,
    why: 'a write path inside a query string is not a write path',
  },
  {
    group: 'url-normalisation',
    method: 'POST',
    url: '/v2025-02-19/data/query/' + DS + '?query=*[_id=="/data/mutate/x"]',
    write: false,
    why: 'GROQ text mentioning /data/mutate must not block a legal query',
  },
  {
    group: 'url-normalisation',
    method: 'GET',
    url: '/v2025-02-19/data/query/' + DS + '/',
    write: false,
    why: 'trailing slash on a read path is still a read',
  },
  {
    group: 'url-normalisation',
    method: 'GET',
    url: '/DATA/QUERY/' + DS,
    write: false,
    why: 'case folding must not turn a read into a write',
  },
  {
    group: 'url-normalisation',
    method: 'GET',
    url: '/datasets',
    write: false,
    why: '/datasets must not be confused with /data/... by prefix matching',
  },
]

/* ------------------------------------------------------------------ *
 * 2. Write endpoints — every write-capable endpoint in @sanity/client
 * ------------------------------------------------------------------ */

const WRITE_ENDPOINTS: WriteGuardCase[] = (
  [
    ['POST', '/data/mutate/' + DS, 'Mutation API'],
    ['POST', '/data/actions/' + DS, 'Actions API — the Studio 4 write path'],
    ['POST', '/assets/images/' + DS, 'image upload', 21],
    ['POST', '/assets/files/' + DS, 'file upload', 21],
    [
      'POST',
      'assets/images/' + DS,
      'the exact string `buildAssetUploadUrl()` returns — no leading slash',
      21,
    ],
    ['POST', '/agent/action/patch/' + DS, 'Agent Actions patch writes documents', 23],
    ['POST', '/agent/action/generate/' + DS, 'Agent Actions generate writes documents', 23],
    ['POST', '/agent/action/transform/' + DS, 'Agent Actions transform writes documents', 23],
    ['POST', '/agent/action/translate/' + DS, 'Agent Actions translate writes documents', 23],
    [
      'POST',
      '/agent/action/prompt/' + DS,
      'Agent Actions prompt — indistinguishable from its writing siblings at the transport layer',
      23,
    ],
    ['PUT', '/datasets/' + DS, 'DatasetsClient.create', 24],
    ['PATCH', '/datasets/' + DS, 'DatasetsClient.edit', 24],
    ['DELETE', '/datasets/' + DS, 'DatasetsClient.delete — deletes the whole dataset', 24],
    ['PUT', '/datasets/' + DS + '/settings/embeddings', 'DatasetsClient.editEmbeddingsSettings'],
    [
      'PUT',
      '/projects/' + PID + '/datasets/' + DS + '/settings/embeddings',
      'embeddings settings with useProjectHostname:false',
    ],
    ['PUT', '/projects/' + PID + '/datasets/' + DS, 'dataset administration under a project host'],
    [
      'POST',
      '/projects/' + PID + '/datasets/' + DS + '/mutate',
      'resource-scoped mutate — `resourceDataBase()` builds it with no /data prefix',
    ],
    [
      'POST',
      '/projects/' + PID + '/datasets/' + DS + '/actions',
      'resource-scoped actions — no /data prefix',
    ],
    ['POST', '/canvases/canvas-1/mutate', 'canvas resource-scoped mutate'],
    ['POST', '/media-libraries/ml-1/mutate', 'media-library resource-scoped mutate'],
    ['POST', '/dashboards/db-1/actions', 'dashboard resource-scoped actions'],
    ['POST', '/canvases/canvas-1/assets/images', 'canvas asset upload'],
    ['POST', '/dashboards/db-1/assets/files', 'dashboard asset upload'],
    ['POST', '/media-libraries/ml-1/upload', 'media-library asset upload'],
  ] as [string, string, string, number?][]
).map(([method, url, why, gap]) => ({
  group: 'write-endpoints' as const,
  method,
  url,
  write: true,
  why,
  ...(gap === undefined ? {} : {gap}),
}))

/* ------------------------------------------------------------------ *
 * 3. Read passthrough — blocking these breaks the Studio
 * ------------------------------------------------------------------ */

const READ_PASSTHROUGH: WriteGuardCase[] = (
  [
    ['GET', '/v2025-02-19/data/query/' + DS + '?query=*[_type=="article"]', 'GROQ over GET'],
    ['POST', '/v2025-02-19/data/query/' + DS, 'GROQ over POST is a read, not a write'],
    ['POST', 'data/query/' + DS, 'GROQ over POST, no leading slash, is still a read'],
    ['GET', '/v2025-02-19/data/listen/' + DS + '?query=*', 'the listener SSE stream'],
    ['GET', '/v2025-02-19/data/doc/' + DS + '/article-01', 'document fetch'],
    ['GET', '/v2025-02-19/data/history/' + DS + '/article-01', 'document history'],
    ['GET', '/v2025-02-19/data/export/' + DS, 'dataset export is a read'],
    ['GET', '/vX/data/live/events/' + DS, 'the Live Events SSE stream'],
    ['GET', '/v2026-05-04/users/me', 'current-user lookup — observed on every Studio boot'],
    ['GET', '/v2025-02-19/projects/' + PID, 'project metadata'],
    ['GET', '/v2025-02-19/projects', 'project list'],
    ['GET', '/v2025-02-19/datasets', 'dataset list'],
    ['GET', '/v2025-02-19/assets/images/' + DS + '/abc-100x100.png', 'reading an asset is a read'],
    ['GET', '/v2025-02-19/assets/files/' + DS, 'asset listing is a read'],
    ['GET', '/agent/instruct/bundles/mine/listen', 'agent bundle listener is a read'],
    ['GET', '/agent/action/bundles/mine/listen', 'agent bundle listener under /action is a read'],
    ['GET', '/v2025-02-19/ping', 'health check — observed in the Spike B proxy log'],
    ['HEAD', '/v2025-02-19/data/query/' + DS, 'HEAD on a read endpoint'],
  ] as [string, string, string][]
).map(([method, url, why]) => ({
  group: 'read-passthrough' as const,
  method,
  url,
  write: false,
  why,
}))

/* ------------------------------------------------------------------ *
 * 4. Methods — the write-method cross product
 * ------------------------------------------------------------------ */

const METHOD_CLASS_ENDPOINTS = [
  '/data/mutate/' + DS,
  '/data/actions/' + DS,
  '/assets/images/' + DS,
  '/assets/files/' + DS,
  '/agent/action/patch/' + DS,
  '/datasets/' + DS,
]

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

const METHODS: WriteGuardCase[] = [
  ...METHOD_CLASS_ENDPOINTS.flatMap((url) =>
    WRITE_METHODS.map((method) => ({
      group: 'methods' as const,
      method,
      url,
      write: true,
      why: `${method} on a write endpoint`,
    })),
  ),
  // CORS preflight is not a write: the browser must be allowed to ask.
  ...METHOD_CLASS_ENDPOINTS.map((url) => ({
    group: 'methods' as const,
    method: 'OPTIONS',
    url,
    write: false,
    why: 'CORS preflight must pass so the browser can receive the 403 that follows',
  })),
  {
    group: 'methods',
    method: 'post',
    url: '/data/mutate/' + DS,
    write: true,
    why: 'a lower-case method is the same method',
  },
  {
    group: 'methods',
    method: 'PoSt',
    url: 'data/mutate/' + DS,
    write: true,
    why: 'mixed-case method plus a stripped leading slash',
  },
  {
    group: 'methods',
    method: '',
    url: '/data/mutate/' + DS,
    write: true,
    why: 'a missing method on a write endpoint is fail-closed',
  },
  {
    group: 'methods',
    method: 'GET',
    url: '/data/mutate/' + DS,
    write: true,
    why: 'GET has no read semantics at the Mutation API — fail closed',
  },
  {
    group: 'methods',
    method: 'HEAD',
    url: '/data/actions/' + DS,
    write: true,
    why: 'HEAD has no read semantics at the Actions API — fail closed',
  },
  {
    group: 'methods',
    method: 'GET',
    url: '/agent/action/patch/' + DS,
    write: true,
    why: 'GET has no read semantics at an Agent Action — fail closed',
  },
  ...['GET', 'HEAD'].map((method) => ({
    group: 'methods' as const,
    method,
    url: '/v2025-02-19/data/doc/' + DS + '/article-01',
    write: false,
    why: `${method} on a read endpoint is a read`,
  })),
]

/* ------------------------------------------------------------------ *
 * 5. Fail-closed — unknown is not the same as safe
 * ------------------------------------------------------------------ */

const FAIL_CLOSED: WriteGuardCase[] = [
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v2025-02-19/data/frobnicate/' + DS,
    write: true,
    why: 'an unknown non-GET /data/* endpoint is treated as a write',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v2025-02-19/data',
    write: true,
    why: 'a bare non-GET /data is treated as a write',
  },
  {
    group: 'fail-closed',
    method: 'DELETE',
    url: '/v2025-02-19/data/doc/' + DS + '/article-01',
    write: true,
    why: 'DELETE on a read-only document endpoint is not a read',
  },
  {
    group: 'fail-closed',
    method: 'PATCH',
    url: '/v2025-02-19/data/query/' + DS,
    write: true,
    why: 'only GET/HEAD/POST are query verbs; anything else is fail-closed',
  },
  {
    group: 'fail-closed',
    method: 'PUT',
    url: '/v2025-02-19/assets/anything',
    write: true,
    why: 'an unknown non-GET /assets/* endpoint is treated as a write',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/agent/action/some-future-verb/' + DS,
    write: true,
    why: 'an unknown non-GET /agent/* endpoint is treated as a write',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v2025-02-19/media-libraries/ml-1/some-future-write',
    write: true,
    why: 'an unknown non-GET resource-scoped endpoint is treated as a write',
  },
  {
    group: 'fail-closed',
    method: 'PROPFIND',
    url: '/v2025-02-19/data/mutate/' + DS,
    write: true,
    why: 'an unknown verb on a write endpoint is a write',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v2025-02-19/ping',
    write: false,
    why: 'fail-closed is scoped: the guard must not block everything it sees',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v1/auth/logout',
    write: false,
    why: 'platform/auth endpoints outside the data plane still pass',
  },
]

/** Every case in the contract, in group order. */
export const WRITE_GUARD_CASES: readonly WriteGuardCase[] = Object.freeze([
  ...NORMALISATION,
  ...NORMALISATION_NEGATIVE,
  ...WRITE_ENDPOINTS,
  ...READ_PASSTHROUGH,
  ...METHODS,
  ...FAIL_CLOSED,
])

const GROUP_ORDER: WriteGuardGroup[] = [
  'url-normalisation',
  'write-endpoints',
  'read-passthrough',
  'methods',
  'fail-closed',
]

const GROUP_TITLES: Record<WriteGuardGroup, string> = {
  'url-normalisation': 'URL normalisation class (Spike F gap 20)',
  'write-endpoints': 'write endpoint class (Spike F gaps 21, 23, 24)',
  'read-passthrough': 'read passthrough class (blocking these breaks the Studio)',
  methods: 'method class',
  'fail-closed': 'fail-closed class',
}

/** The six Spike F escapes this contract stands guard over. */
export const SPIKE_F_WITNESS_GAPS: readonly number[] = Object.freeze([20, 21, 23, 24])

/** Cases that are regression witnesses for a specific Spike F attack. */
export function spikeFWitnesses(): WriteGuardCase[] {
  return WRITE_GUARD_CASES.filter((c) => c.gap !== undefined)
}

/**
 * Run the whole contract against one write-guard predicate.
 *
 * @param name - Label for the implementation under test.
 * @param isWrite - The predicate: does this raw request write?
 */
export function runWriteGuardContract(name: string, isWrite: WriteGuardPredicate): void {
  describe(`write-guard contract · ${name}`, () => {
    for (const group of GROUP_ORDER) {
      const cases = WRITE_GUARD_CASES.filter((c) => c.group === group)
      describe(GROUP_TITLES[group], () => {
        for (const c of cases) {
          const verdict = c.write ? 'BLOCKS' : 'ALLOWS'
          const gap = c.gap === undefined ? '' : ` [Spike F gap ${c.gap}]`
          it(`${verdict} ${c.method || '<no method>'} ${c.url} — ${c.why}${gap}`, () => {
            expect(isWrite({method: c.method, url: c.url})).toBe(c.write)
          })
        }
      })
    }

    describe('contract integrity', () => {
      // A URL may legitimately appear in more than one group — the same request
      // is asserted there for a different reason. Within a group it is noise.
      it('has no duplicate cases inside a group', () => {
        const seen = new Set<string>()
        const dupes: string[] = []
        for (const c of WRITE_GUARD_CASES) {
          const key = `${c.group} ${c.method} ${c.url}`
          if (seen.has(key)) dupes.push(key)
          else seen.add(key)
        }
        expect(dupes).toEqual([])
      })

      it('never expects two different answers for the same request', () => {
        const answers = new Map<string, boolean>()
        const contradictions: string[] = []
        for (const c of WRITE_GUARD_CASES) {
          const key = `${c.method} ${c.url}`
          const previous = answers.get(key)
          if (previous !== undefined && previous !== c.write) contradictions.push(key)
          else answers.set(key, c.write)
        }
        expect(contradictions).toEqual([])
      })

      it('still carries a regression witness for every Spike F URL gap', () => {
        const covered = new Set(spikeFWitnesses().map((c) => c.gap))
        expect([...covered].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([...SPIKE_F_WITNESS_GAPS])
      })
    })
  })
}
