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
 * THE POLICY THIS CONTRACT ENCODES: DEFAULT-DENY
 * ----------------------------------------------
 * The first version of this contract was default-allow with fail-closed islands
 * (`/data/*`, `/assets/*`, `/agent/*`, `/datasets/*`). That is the wrong shape:
 * it requires the guard's author to have heard of every write endpoint Sanity
 * ships, and Spike F's whole lesson is that they had not. `POST /projects/<p>/
 * tokens` (mint a write-capable token), `PUT /users/me/keyvalue/<k>`,
 * `POST /schedules/<p>/<d>` (deferred publish) and `POST /descriptors/claim`
 * all sailed through, none of them under a guarded prefix.
 *
 * So the policy is inverted. A request is a READ only if it matches the
 * explicit read allowlist below; **everything else is a write and is blocked**,
 * including GET/HEAD to paths the allowlist has never heard of.
 *
 *   | class                                   | ruling                        |
 *   |-----------------------------------------|-------------------------------|
 *   | OPTIONS, any path                       | never a write (preflight)     |
 *   | GET/HEAD on an allowlisted read endpoint| read                          |
 *   | POST /data/query, <resource>/query      | read (long-GROQ fallback)     |
 *   | GET/HEAD on an unknown path             | WRITE (blocked)               |
 *   | any other method, any path              | WRITE (blocked)               |
 *
 * The read allowlist is derived from two independent sources, not from
 * imagination: (a) `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl`, 422
 * real request lines from a live Studio session against the Track B proxy, and
 * (b) the `@sanity/client` URL-builder inventory below. Blocking a read the
 * Studio actually performs breaks the Studio loudly and in one place; allowing
 * a write we have never heard of corrupts staging silently. The allowlist is
 * therefore the thing that gets extended, always with a log line to justify it.
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

/** The classes of defect this contract covers. */
export type WriteGuardGroup =
  | 'url-normalisation'
  | 'encoded-delimiter'
  | 'write-endpoints'
  | 'read-passthrough'
  | 'methods'
  | 'fail-closed'
  | 'default-deny'
  | 'spike-f-attacks'

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
  /** Spike F attack number this case is the promoted request shape of, if any. */
  attack?: number
  /** `attackPass.ts` spec name, for traceability back to the suite. */
  attackName?: string
  /** The body shape the attack sends — recorded, not asserted on. */
  body?: string
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

    /* ---- dot segments that REDUCE a write to a read (gap 20, other half) ---
     * Every `..` case above climbs *towards* the write endpoint, and any guard
     * that resolves dot segments catches those for free. The dangerous
     * direction is the opposite one: `..` climbing back *out* of a write
     * segment so the canonical path is a read while the request line still
     * says `/data/mutate`.
     *
     * That matters because the proxy forwards the RAW request line upstream —
     * it does not send the canonical path it classified. So the guard and
     * Content Lake are looking at two different strings, and the guard picked
     * the harmless reading of it. Under default-deny the ruling is the reverse:
     * a path that needs `.`/`..` resolved to become a read is not a read.
     * Nothing @sanity/client builds contains a dot segment; against a proxy
     * their only function is to make the two ends disagree.
     */
    [
      '/data/mutate/' + DS + '/../../query/' + DS,
      '".." climbing back OUT of the write path — canonically a read, on the wire still /data/mutate',
    ],
    ['/data/actions/' + DS + '/../../query/' + DS, 'the same reduction against the Actions API'],
    [
      '/data/mutate/' + DS + '/%2e%2e/%2e%2e/query/' + DS,
      'percent-encoded dot segments reducing the write path — decoding must not launder it',
    ],
    [
      '/data/query/' + DS + ';/../mutate/' + DS,
      'a path parameter absorbed by ".." — the segment count hides the mutate that follows',
      20,
    ],
    ['/data/mutate/' + DS + '/./../query/' + DS, 'a "." segment mixed into the reduction'],
    [
      '/assets/images/' + DS + '/../../data/query/' + DS,
      'the same trick reducing an asset upload to a data-plane read',
      21,
    ],
    [
      '/data/mutate/' + DS + '/../../../../../../ping',
      'enough ".." to land on an allowlisted root read — the generic form of the reduction',
    ],
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
 * 1b. The DANGEROUS direction of delimiter truncation (P1-1)
 * ------------------------------------------------------------------ *
 * The security review of 2026-08-06 found that every guard in this project
 * re-cut the path at `?`/`#` **after each decode pass**. A percent-encoded `?`
 * is a path character (RFC 3986 §3.3), not a delimiter, so decoding it and
 * cutting there does not reveal more path — it DISCARDS path, including the
 * `..` segments the dot-segment rule exists to refuse:
 *
 *     POST /data/query%3F/../actions/<ds>
 *          guard sees  /data/query           -> "GROQ over POST", ALLOWED
 *          wire says   /data/query%3F/../actions/<ds>
 *          RFC 3986 §5.2.4 resolves that to  /data/actions/<ds>   <- a write
 *
 * WHY THE CONTRACT DID NOT CATCH IT. `'/data/mutate/<ds>%3Ffake=1'` above
 * asserts "a percent-encoded `?` must not hide the path" — but that is the
 * SAFE direction: truncating a write path leaves a write path, so the case
 * passes whether the bug is present or not. The dangerous direction, where
 * truncation collapses a write onto an allowlisted read PREFIX, had no case at
 * all. One direction of an asymmetric rule is not a test of the rule.
 *
 * So this group is generated as a cross product rather than enumerated: every
 * allowlisted read prefix × every spelling of the delimiter × every write the
 * `..` can climb back down to. A future normaliser that truncates anywhere
 * after its decision point fails here by construction, not by luck.
 *
 * THE RAW `#` IS IN THE SET DELIBERATELY. Cutting at `#` is correct and stays —
 * but `proxy.mjs` forwards `pathname + search`, and `splitPath` only cuts at
 * `?`, so a literal `#` and everything after it is relayed to the upstream
 * verbatim. Node's HTTP parser accepts `#` in an origin-form request target and
 * hands it through unchanged, so the guard and Content Lake are again looking
 * at two different strings. A `#` AFTER a `?` is harmless — it lives in the
 * query, which never reaches the path — and the negatives below pin that, so
 * the rule cannot be over-applied into blocking GROQ text.
 */

/** Allowlisted reads, with the verb that makes each one a read. */
const TRUNCATION_READ_PREFIXES: [string, string][] = [
  ['POST', '/data/query'],
  ['GET', '/data/query/' + DS],
  ['GET', '/data/doc/' + DS],
  ['GET', '/data/listen/' + DS],
  ['GET', '/data/history/' + DS],
  ['POST', '/projects/' + PID + '/datasets/' + DS + '/query'],
  ['GET', '/projects/' + PID + '/datasets/' + DS + '/acl'],
  ['GET', '/ping'],
  ['GET', '/users/me'],
  ['GET', '/projects/' + PID],
  ['GET', '/schedules/' + PID],
  ['GET', '/journey/trial'],
  ['GET', '/features'],
  ['GET', '/socket/' + DS],
  ['GET', '/assets/images/' + DS],
]

/** Every spelling of the delimiter that truncated the classified path. */
const TRUNCATION_DELIMITERS: [string, string][] = [
  ['%3f', 'percent-encoded "?", lower-case hex'],
  ['%3F', 'percent-encoded "?", upper-case hex'],
  ['%23', 'percent-encoded "#"'],
  ['%253f', 'DOUBLE-encoded "?" — the decode loop only reaches it on pass 2'],
  ['%25253F', 'TRIPLE-encoded "?" — pass 3'],
  ['#', 'a RAW "#": the proxy relays it upstream, so only the guard is truncated'],
]

/** Where the `..` chain lands once the truncated prefix has been climbed out of. */
const TRUNCATION_WRITE_TARGETS: [string, string][] = [
  ['/data/mutate/' + DS, 'the Mutation API'],
  ['/data/actions/' + DS, 'the Actions API'],
  ['/agent/action/patch/' + DS, 'an Agent Action'],
]

/**
 * `<read prefix><delimiter>` then enough `..` to climb back to the root, then
 * the write. The guard truncates at the delimiter and sees the bare read
 * prefix; RFC 3986 §5.2.4 `remove_dot_segments` — which needs no decoding at
 * all, because `query%3F` is simply a segment to be popped — resolves the RAW
 * request line to the write.
 */
export function encodedDelimiterVector(
  readPrefix: string,
  delimiter: string,
  writeTarget: string,
): string {
  const depth = readPrefix.split('/').filter(Boolean).length
  return `${readPrefix}${delimiter}${'/..'.repeat(depth)}${writeTarget}`
}

const ENCODED_DELIMITER: WriteGuardCase[] = TRUNCATION_READ_PREFIXES.flatMap(
  ([method, readPrefix]) =>
    TRUNCATION_DELIMITERS.flatMap(([delimiter, delimiterWhy]) =>
      TRUNCATION_WRITE_TARGETS.map(([writeTarget, targetWhy]) => ({
        group: 'encoded-delimiter' as const,
        method,
        url: encodedDelimiterVector(readPrefix, delimiter, writeTarget),
        write: true,
        why:
          `${delimiterWhy} truncates the classified path to the allowlisted read ` +
          `${readPrefix}, while the raw request line resolves to ${targetWhy}`,
      })),
    ),
)

/**
 * The reviewer's five reproduced vectors, spelled exactly as reported, so the
 * report and the suite can be read against each other line by line.
 */
const ENCODED_DELIMITER_REPORTED: WriteGuardCase[] = (
  [
    ['POST', '/data/query%3f/../actions/' + DS],
    ['POST', '/data/query%3F/../mutate/' + DS],
    ['POST', '/projects/p/datasets/d/query%3f/../mutate'],
    ['GET', '/ping%3f/../data/mutate/' + DS],
    ['POST', '/data/query%23/../actions/' + DS],
  ] as [string, string][]
)
  /* `/ping%3f/../data/mutate/<ds>` is also produced by the generator above;
   * keeping both would be a duplicate rather than a second assertion. */
  .filter(([, url]) => !ENCODED_DELIMITER.some((generated) => generated.url === url))
  .map(([method, url]) => ({
    group: 'encoded-delimiter' as const,
    method,
    url,
    write: true,
    why: 'reproduced verbatim in docs/plans/evidence/phase-1/security-review-2026-08-06.md §P1-1',
  }))

/**
 * The rule is "never discard path the wire still carries", NOT "anything with a
 * `%` or a `#` in it is a write". These are the reads the fix must not eat —
 * without them, the P1-1 fix could be "block everything containing %3F" and the
 * contract would applaud.
 */
const ENCODED_DELIMITER_NEGATIVE: WriteGuardCase[] = [
  {
    group: 'encoded-delimiter',
    method: 'GET',
    url: '/v2025-02-19/data/query/' + DS + '?query=*&tag=x#frag',
    write: false,
    why: 'a `#` AFTER the `?` is inside the query, which never reaches the path — still a read',
  },
  {
    group: 'encoded-delimiter',
    method: 'POST',
    url: '/v2025-02-19/data/query/' + DS + '?query=*[_id=="#anchor"]',
    write: false,
    why: 'GROQ text containing a raw `#` in the query string is still a read',
  },
  {
    group: 'encoded-delimiter',
    method: 'GET',
    url: '/v2025-02-19/data/query/' + DS + '?query=*[slug.current=="a%3Fb"]',
    write: false,
    why: 'a percent-encoded `?` inside the QUERY STRING is not path text and must not block a read',
  },
  {
    group: 'encoded-delimiter',
    method: 'GET',
    url: '/v2025-02-19/data/doc/' + DS + '/drafts.article-01',
    write: false,
    why: 'the plain document read, unchanged — the control for this whole group',
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
    [
      'POST',
      'assets/files/' + DS,
      'the file-upload half of the same builder — /assets/* means BOTH forms of BOTH kinds',
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

    /* ---- the allowlist, derived line-by-line from proxy-log.jsonl ---------
     * 422 request lines from a live Studio session through the Track B proxy.
     * Under default-deny every one of these would 403 unless it is named here,
     * so each entry is a load-bearing "the Studio still boots" assertion. The
     * count beside each is how many times the session issued it.
     */
    ['GET', '/v2025-02-19/data/ping/' + DS, 'dataset-scoped ping (x3 in the log)'],
    [
      'GET',
      '/v2025-02-19/data/history/' + DS + '/events/documents/drafts.article-11',
      'document-events history read (x4) — the real /data/history sub-shape',
    ],
    [
      'GET',
      '/v2025-02-19/data/history/' + DS + '/transactions/drafts.author-1',
      'transaction history read (x3)',
    ],
    ['GET', '/v1/help', 'API help index (x2)'],
    ['GET', '/v2025-02-19/features', 'feature flags (x3)'],
    ['GET', '/v2023-12-11/journey/trial', 'journey/trial banner data (x9)'],
    ['GET', '/v2024-09-19/journey/announcements', 'journey/announcements (x6)'],
    ['GET', '/v2025-02-19/journey/scheduled-drafts', 'journey/scheduled-drafts (x7)'],
    ['GET', '/v2023-12-18/intake/telemetry-status', 'telemetry opt-in status (x1)'],
    [
      'GET',
      '/v2022-06-30/socket/' + DS,
      'the presence WebSocket upgrade (x38) — a GET, and the busiest non-data endpoint in the log',
    ],
    ['GET', '/v2021-12-15/projects/' + PID, 'project metadata under an old API version (x8)'],
    ['GET', '/v2025-02-19/projects/' + PID + '/datasets', 'dataset list under the project host (x6)'],
    ['GET', '/v2025-02-19/projects/' + PID + '/grants', 'permission grants (x3)'],
    ['GET', '/v2024-09-01/projects/' + PID + '/user-applications', 'user applications (x3)'],
    [
      'GET',
      '/v2021-06-07/projects/' + PID + '/datasets/' + DS + '/acl',
      'dataset ACL read (x3) — resource-scoped, and NOT a /data operation',
    ],
    ['GET', '/v2025-02-19/schedules/' + PID + '/' + DS, 'scheduled-publishing list (x3)'],
    [
      'GET',
      '/v2025-02-19/users/me/keyvalue/studio.announcement.seen',
      'Studio key-value preference read (x3) — the write side of this is PUT and is blocked',
    ],
    [
      'GET',
      '/v2025-02-19/agent/oTu7RImef/bundles/mine/listen',
      'the real agent bundle listener shape (x3): /agent/<id>/bundles/mine/listen',
    ],
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
    write: true,
    why:
      'POLICY CHANGE (default-deny): /ping is allowlisted for GET/HEAD only. ' +
      'A POST to it is a verb nobody has documented, so it is a write',
  },
  {
    group: 'fail-closed',
    method: 'POST',
    url: '/v1/auth/logout',
    write: true,
    why:
      'POLICY CHANGE (default-deny): a POST outside the read allowlist is blocked even ' +
      'outside the data plane. The preview holds no session to log out of',
  },
]

/* ------------------------------------------------------------------ *
 * 6. Default-deny — the policy itself: not-a-known-read means blocked
 * ------------------------------------------------------------------ *
 * Every case here was ALLOWED by the previous default-allow guard. They are
 * the reason the policy was inverted: none of them lives under a `/data/*`,
 * `/assets/*`, `/agent/*` or `/datasets/*` prefix, so no amount of extending
 * the old island-shaped rule set would have caught the class — only the class's
 * complement would.
 */

const DEFAULT_DENY: WriteGuardCase[] = (
  [
    /* ---- the project/console write plane (gap class 4) ------------------- */
    ['POST', '/v2025-02-19/projects', 'creating a project is a write'],
    ['PATCH', '/v2025-02-19/projects/' + PID, 'editing project metadata is a write'],
    ['DELETE', '/v2025-02-19/projects/' + PID, 'deleting the project is the largest write there is'],
    [
      'POST',
      '/v2025-02-19/projects/' + PID + '/tokens',
      'minting a token — a write that also manufactures a credential the preview must not have',
    ],
    [
      'DELETE',
      '/v2025-02-19/projects/' + PID + '/tokens/tok-1',
      'revoking a token is a write to the project plane',
    ],
    ['POST', '/v2025-02-19/projects/' + PID + '/members', 'inviting a member is a write'],
    [
      'PUT',
      '/v2021-06-07/projects/' + PID + '/datasets/' + DS + '/acl',
      'the write side of the ACL endpoint whose GET the Studio really uses',
    ],
    ['POST', '/v2025-02-19/projects/' + PID + '/datasets/' + DS + '/copy', 'dataset copy is a write'],

    /* ---- endpoints the live Studio session actually POSTed --------------- */
    [
      'POST',
      '/v2025-02-19/descriptors/claim',
      'observed x3 in proxy-log.jsonl at HTTP 200 — a POST that claims server-side state, and was passed by the old guard',
    ],
    [
      'POST',
      '/v2023-12-18/intake/batch',
      'observed x1 in proxy-log.jsonl — telemetry ingest; a preview must not post from a branch build either',
    ],
    [
      'PUT',
      '/v2025-02-19/users/me/keyvalue/studio.structure-tool.layout.article',
      'the Studio persists pane layout with PUT /users/me/keyvalue — a real write, previously allowed',
    ],
    [
      'DELETE',
      '/v2025-02-19/users/me/keyvalue/studio.announcement.seen',
      'the delete side of the same key-value store',
    ],
    ['POST', '/v2025-02-19/users/me', 'any non-GET on the user endpoint is a write'],
    [
      'POST',
      '/v2025-02-19/schedules/' + PID + '/' + DS,
      'scheduling a publish is a deferred document write, and it lives nowhere near /data',
    ],
    [
      'DELETE',
      '/v2025-02-19/schedules/' + PID + '/' + DS + '/sched-1',
      'deleting a schedule is a write to the same plane',
    ],
    ['POST', '/v2022-06-30/socket/' + DS, 'the presence socket is a GET upgrade; a POST to it is not a read'],
    ['POST', '/v2023-12-11/journey/trial', 'non-GET on a journey endpoint is not a read'],
    ['POST', '/v2025-02-19/features', 'non-GET on the feature endpoint is not a read'],

    /* ---- the complement: paths nobody has ever enumerated ---------------- */
    ['PATCH', '/', 'the root path with a write verb is a write'],
    ['POST', '/', 'the root path with a write verb is a write'],
    ['PROPFIND', '/v2025-02-19/anything', 'an unrecognised verb on an unrecognised path is a write'],
    [
      'POST',
      '/v2025-02-19/agent/oTu7RImef/bundles/mine/listen',
      'the agent bundle listener is allowlisted for GET/HEAD only — a POST to it is a write',
    ],
    [
      'POST',
      'projects/' + PID + '/tokens',
      'the whole normalisation class applies to default-deny too: no leading slash is the same endpoint',
    ],

    /* ---- GET/HEAD to unknown paths (the documented ruling) --------------- *
     * RULING: GET/HEAD passthrough is allowlist-only. An unknown path is
     * blocked whatever the verb. The tradeoff — a Sanity read endpoint nobody
     * has observed yet returns 403 until it is added — is accepted: the
     * failure is loud, local and one log line away from a fix, whereas the
     * other direction (allow unknown GET) reinstates exactly the assumption
     * Spike F destroyed, that we can recognise a writer by looking at it.
     */
    [
      'GET',
      '/v2025-02-19/data/frobnicate/' + DS,
      'an unknown data-plane operation is blocked for GET too — /data is where writers live',
    ],
    ['HEAD', '/v2025-02-19/data/frobnicate/' + DS, 'HEAD on an unknown data-plane operation'],
    ['GET', '/v2025-02-19/some/future/api', 'GET to a path outside the read allowlist'],
    ['GET', '/nonexistent/endpoint', 'GET to a path nobody has ever observed'],
    ['HEAD', '/v2025-02-19/telemetry/whatever', 'HEAD to a path outside the read allowlist'],
    ['GET', '/', 'the API-host root is not a read endpoint of ours'],
    [
      'GET',
      '/v2025-02-19/projects/' + PID + '/datasets/' + DS + '/frobnicate',
      'an unknown resource-scoped operation is blocked even for GET',
    ],
  ] as [string, string, string][]
).map(([method, url, why]) => ({
  group: 'default-deny' as const,
  method,
  url,
  write: true,
  why,
}))

/**
 * Gap class 6 in full: *every* mutating verb against paths the allowlist has
 * never heard of. Written as a cross product rather than a handful of examples
 * because the rule being pinned is "the verb does not matter and the path does
 * not matter" — one POST and one PUT would leave a guard that special-cases
 * DELETE looking perfectly healthy.
 */
const UNRECOGNISED_PATHS: [string, string][] = [
  ['/v2025-02-19/some/future/api', 'an endpoint that does not exist yet'],
  ['/nonexistent/endpoint', 'a path nobody has ever observed'],
  ['/v2025-02-19/projects/' + PID + '/datasets/' + DS + '/frobnicate', 'an unknown resource-scoped op'],
  ['/v2025-02-19/data/frobnicate/' + DS, 'an unknown data-plane op'],
  ['/v2025-02-19/agent/some-future-surface', 'an unknown /agent/* surface'],
  ['/v2025-02-19/assets/some-future-surface', 'an unknown /assets/* surface'],
]

const DEFAULT_DENY_VERB_MATRIX: WriteGuardCase[] = UNRECOGNISED_PATHS.flatMap(([url, what]) =>
  WRITE_METHODS.map((method) => ({
    group: 'default-deny' as const,
    method,
    url,
    write: true,
    why: `${method} to ${what} — default-deny applies to every mutating verb`,
  })),
)

/* ------------------------------------------------------------------ *
 * 7. Spike F attack shapes, promoted into permanent classifier vectors
 * ------------------------------------------------------------------ *
 * PRD §35.14 / Spike F follow-up: "promote attacks 18–27 into the permanent
 * security suite so regressions re-surface." All 27 are here, not just the ten
 * that escaped — the ones that were blocked are exactly the ones a future
 * refactor could un-block without noticing.
 *
 * Each vector is the request line the attack puts on the wire (from
 * `examples/kitchen-sink/spikeF/attackPass.ts` plus @sanity/client's URL
 * builders), with the body shape recorded for traceability. Several attacks
 * share a request line — that is the finding, not a duplicate: eight different
 * client-side escape hatches all land on `POST /data/mutate`, which is why the
 * network layer, not the facade, is where they are stopped.
 */

interface AttackVectorSpec {
  attack: number
  attackName: string
  method: string
  url: string
  body: string
  write: boolean
  why: string
  gap?: number
}

const ATTACK_VECTOR_SPECS: AttackVectorSpec[] = [
  {attack: 1, attackName: '01.client.create', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&returnDocuments=true&visibility=sync', body: '{"mutations":[{"create":{…}}]}', write: true, why: 'client.create()'},
  {attack: 2, attackName: '02.client.createOrReplace', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&visibility=sync', body: '{"mutations":[{"createOrReplace":{…}}]}', write: true, why: 'client.createOrReplace()'},
  {attack: 3, attackName: '03.client.createIfNotExists', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&returnDocuments=true', body: '{"mutations":[{"createIfNotExists":{…}}]}', write: true, why: 'client.createIfNotExists()'},
  {attack: 4, attackName: '04.client.delete', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true', body: '{"mutations":[{"delete":{"id":"…"}}]}', write: true, why: 'client.delete() — a destructive write over the mutation endpoint'},
  {attack: 5, attackName: '05.client.mutate.promise', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS, body: '{"mutations":[…]}', write: true, why: 'client.mutate(), promise flavour'},
  {attack: 6, attackName: '06.client.observable.mutate', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?visibility=sync', body: '{"mutations":[…]}', write: true, why: 'client.observable.mutate() — a different object, the same request line'},
  {attack: 7, attackName: '07.client.patch.commit', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&returnDocuments=true', body: '{"mutations":[{"patch":{"id":"…","set":{…}}}]}', write: true, why: 'patch().commit()'},
  {attack: 8, attackName: '08.client.transaction.commit', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnDocuments=false', body: '{"mutations":[…]}', write: true, why: 'transaction().commit()'},
  {attack: 9, attackName: '09.client.action.publish', method: 'POST', url: '/v2025-02-19/data/actions/' + DS, body: '{"actions":[{"actionType":"sanity.action.document.publish",…}]}', write: true, why: 'client.action() — the Studio 4 publish path'},
  {attack: 10, attackName: '10.client.withConfig.observable.action', method: 'POST', url: '/v2025-02-19/data/actions/' + DS, body: '{"actions":[{"actionType":"sanity.action.document.publish",…}]}', write: true, why: 'withConfig().observable.action() — a re-configured clone reaching the Actions API'},
  {attack: 11, attackName: '11.client.request.dataMutate', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS, body: '{"mutations":[{"createOrReplace":{…}}]}', write: true, why: 'raw request({url:"/data/mutate/…"})'},
  {attack: 12, attackName: '12.client.dataRequest.mutate', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&returnDocuments=true&visibility=sync', body: '{"mutations":[…]}', write: true, why: "dataRequest('mutate') — one level below client.mutate()"},
  {attack: 13, attackName: '13.client.dataRequest.actions', method: 'POST', url: '/v2025-02-19/data/actions/' + DS, body: '{"actions":[{"actionType":"sanity.action.document.create",…}]}', write: true, why: "dataRequest('actions')"},
  {attack: 14, attackName: '14.client.withConfig.datasetOverride', method: 'POST', url: '/v2025-02-19/data/mutate/scratch', body: '{"mutations":[{"create":{…}}]}', write: true, why: 'a dataset-swapped clone writes to a DIFFERENT dataset — the rule is per-endpoint, not per-dataset (PRD §11.3)'},
  {attack: 15, attackName: '15.client.withConfig.apiVersion.mutate', method: 'POST', url: '/v2021-03-25/data/mutate/' + DS, body: '{"mutations":[…]}', write: true, why: 'an old API version is still the mutation endpoint'},
  {attack: 16, attackName: '16.client.clone.mutate', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?visibility=async', body: '{"mutations":[…]}', write: true, why: 'clone().mutate()'},
  {attack: 17, attackName: '17.client.config.reconfigureEscape', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnDocuments=true', body: '{"mutations":[{"create":{…}}]}', write: true, why: 'config(newConfig) hands back the UNWRAPPED client — which still has to use this endpoint'},
  {attack: 18, attackName: '18.patch.clone.commit', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&returnDocuments=true&visibility=sync', body: '{"mutations":[{"patch":{…}}]}', write: true, why: 'Patch.clone() escaped the facade (Spike F gap 18) — the proxy is where it is stopped'},
  {attack: 19, attackName: '19.transaction.clone.commit', method: 'POST', url: '/v2025-02-19/data/mutate/' + DS + '?returnIds=true&visibility=sync', body: '{"mutations":[{"createOrReplace":{…}}]}', write: true, why: 'Transaction.clone() escaped the facade (Spike F gap 19)'},
  {attack: 20, attackName: '20.client.request.relativeUrlBypass', method: 'POST', url: 'data/mutate/' + DS, body: '{"mutations":[{"createOrReplace":{…}}]}', write: true, why: 'no leading slash — the exact string _getUrl() produces', gap: 20},
  {attack: 21, attackName: '21.client.request.assetsEndpoint', method: 'POST', url: '/assets/images/' + DS + '?filename=spike-f-canary.txt', body: 'raw bytes (text/plain masquerading as image/png)', write: true, why: 'raw request() to the asset endpoint', gap: 21},
  {attack: 22, attackName: '22.client.assets.upload', method: 'POST', url: 'assets/images/' + DS + '?filename=spike-f-canary.png', body: 'Blob (image/png)', write: true, why: 'client.assets.upload() — buildAssetUploadUrl() emits NO leading slash, so this is gaps 20 and 21 at once', gap: 21},
  {attack: 23, attackName: '23.client.agent.action.patch', method: 'POST', url: '/v2025-02-19/agent/action/patch/' + DS, body: '{"schemaId":"…","documentId":"…","target":{"operation":"set",…}}', write: true, why: 'Agent Actions patch — the endpoint the old proxy allowlist explicitly passed', gap: 23},
  {attack: 24, attackName: '24.client.datasets.reachable (probe)', method: 'GET', url: '/v2025-02-19/datasets', body: '(none)', write: false, why: 'the probe itself is datasets.list(), a read — recorded so the vector set matches the attack suite exactly'},
  {attack: 24, attackName: '24.client.datasets.reachable (create)', method: 'PUT', url: '/v2025-02-19/datasets/spike-f-canary-ds', body: '{"aclMode":"private"}', write: true, why: 'what the reachable sub-client can actually do: datasets.create()', gap: 24},
  {attack: 24, attackName: '24.client.datasets.reachable (delete)', method: 'DELETE', url: '/v2025-02-19/datasets/' + DS, body: '(none)', write: true, why: 'datasets.delete() — the whole dataset', gap: 24},
  {attack: 24, attackName: '24.client.datasets.reachable (copy)', method: 'POST', url: '/v2025-02-19/datasets/' + DS + '/copy', body: '{"targetDataset":"…"}', write: true, why: 'datasets.copy() writes a new dataset'},
  {attack: 25, attackName: '25.freshClient.create', method: 'POST', url: 'https://' + PID + '.api.sanity.io/v2025-02-19/data/mutate/' + DS, body: '{"mutations":[{"create":{…}}]}', write: true, why: 'a brand-new createClient() never touches the facade — but it still has to cross the proxy'},
  {attack: 26, attackName: '26.rawFetch.dataMutate', method: 'POST', url: 'https://' + PID + '.api.sanity.io/v2025-02-19/data/mutate/' + DS + '?returnIds=true', body: '{"mutations":[{"createOrReplace":{…}}]}', write: true, why: 'raw fetch() with a stolen token — the architectural hole a network guard exists to close'},
]

const SPIKE_F_ATTACKS: WriteGuardCase[] = ATTACK_VECTOR_SPECS.map((spec) => ({
  group: 'spike-f-attacks' as const,
  method: spec.method,
  url: spec.url,
  write: spec.write,
  why: spec.why,
  attack: spec.attack,
  attackName: spec.attackName,
  body: spec.body,
  ...(spec.gap === undefined ? {} : {gap: spec.gap}),
}))

/**
 * Spike F attacks with no request shape to classify. Recorded explicitly so
 * the coverage test can prove all 27 are accounted for rather than silently
 * skipping the awkward one.
 */
export const SPIKE_F_UNCLASSIFIABLE_ATTACKS: readonly {
  attack: number
  attackName: string
  why: string
}[] = Object.freeze([
  {
    attack: 27,
    attackName: '27.credentials.exfiltration',
    why:
      'Reading a write-capable token out of localStorage / client.config() puts NOTHING on the wire, ' +
      'so no request classifier can see it. It is closed by §5.2 (no write-capable credential in the ' +
      'preview environment) and by the CI token scan (§11.3), not by this guard. Its consequence — ' +
      'the write the stolen token then performs — is attack 26, which IS classified above.',
  },
])

/** Every Spike F attack number, 1..27. */
export const SPIKE_F_ATTACK_NUMBERS: readonly number[] = Object.freeze(
  Array.from({length: 27}, (_unused, index) => index + 1),
)

/** The promoted attack vectors, for callers that want just this group. */
export function spikeFAttackVectors(): WriteGuardCase[] {
  return SPIKE_F_ATTACKS.slice()
}

/** Every case in the contract, in group order. */
export const WRITE_GUARD_CASES: readonly WriteGuardCase[] = Object.freeze([
  ...NORMALISATION,
  ...NORMALISATION_NEGATIVE,
  ...ENCODED_DELIMITER,
  ...ENCODED_DELIMITER_REPORTED,
  ...ENCODED_DELIMITER_NEGATIVE,
  ...WRITE_ENDPOINTS,
  ...READ_PASSTHROUGH,
  ...METHODS,
  ...FAIL_CLOSED,
  ...DEFAULT_DENY,
  ...DEFAULT_DENY_VERB_MATRIX,
  ...SPIKE_F_ATTACKS,
])

const GROUP_ORDER: WriteGuardGroup[] = [
  'url-normalisation',
  'encoded-delimiter',
  'write-endpoints',
  'read-passthrough',
  'methods',
  'fail-closed',
  'default-deny',
  'spike-f-attacks',
]

const GROUP_TITLES: Record<WriteGuardGroup, string> = {
  'url-normalisation': 'URL normalisation class (Spike F gap 20)',
  'encoded-delimiter':
    'delimiter-truncation class, UNSAFE direction (P1-1, security review 2026-08-06)',
  'write-endpoints': 'write endpoint class (Spike F gaps 21, 23, 24)',
  'read-passthrough': 'read passthrough class (blocking these breaks the Studio)',
  methods: 'method class',
  'fail-closed': 'fail-closed class',
  'default-deny': 'default-deny class (unknown endpoint = blocked write)',
  'spike-f-attacks': 'Spike F attack shapes, promoted (PRD §35.14)',
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
          const attack = c.attackName === undefined ? '' : `${c.attackName} · `
          it(`${verdict} ${attack}${c.method || '<no method>'} ${c.url} — ${c.why}${gap}`, () => {
            expect(isWrite({method: c.method, url: c.url})).toBe(c.write)
          })
        }
      })
    }

    describe('contract integrity', () => {
      // A URL may legitimately appear in more than one group — the same request
      // is asserted there for a different reason. Within a group it is noise,
      // EXCEPT in the Spike F group: eight distinct client-side escape hatches
      // put the identical request line on the wire, and recording each attack
      // separately is the point of promoting them. There the key is the attack.
      it('has no duplicate cases inside a group', () => {
        const seen = new Set<string>()
        const dupes: string[] = []
        for (const c of WRITE_GUARD_CASES) {
          const key =
            c.attack === undefined
              ? `${c.group} ${c.method} ${c.url}`
              : `${c.group} #${c.attack} ${c.method} ${c.url}`
          if (seen.has(key)) dupes.push(key)
          else seen.add(key)
        }
        expect(dupes).toEqual([])
      })

      it('carries a classifier vector for every one of the 27 Spike F attacks', () => {
        const classified = new Set(SPIKE_F_ATTACKS.map((c) => c.attack))
        const excused = new Set(SPIKE_F_UNCLASSIFIABLE_ATTACKS.map((a) => a.attack))
        const missing = SPIKE_F_ATTACK_NUMBERS.filter(
          (n) => !classified.has(n) && !excused.has(n),
        )
        expect(missing).toEqual([])
      })

      it('does not excuse an attack that has a request shape', () => {
        // The escape hatch (SPIKE_F_UNCLASSIFIABLE_ATTACKS) must stay tiny and
        // justified, or "promoted" degrades into "listed".
        const excused = SPIKE_F_UNCLASSIFIABLE_ATTACKS.map((a) => a.attack)
        expect(excused).toEqual([27])
        for (const entry of SPIKE_F_UNCLASSIFIABLE_ATTACKS) {
          expect(entry.why.length).toBeGreaterThan(80)
        }
      })

      it('asserts BLOCKED for every Spike F attack that puts a write on the wire', () => {
        // Attack 24's probe is a read (datasets.list()); everything else in the
        // promoted set is a write and must be expected to block.
        const notBlocked = SPIKE_F_ATTACKS.filter((c) => !c.write).map((c) => c.attackName)
        expect(notBlocked).toEqual(['24.client.datasets.reachable (probe)'])
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

      it('covers the UNSAFE direction of delimiter truncation, not only the safe one', () => {
        /* P1-1's root cause: the one pre-existing case (`/data/mutate/<ds>%3Ffake=1`)
         * asserted only that truncating a WRITE path leaves a write. That passes
         * with the bug present. This pins the other direction as a floor so the
         * group cannot be quietly emptied back to the asymmetry that hid it. */
        const group = WRITE_GUARD_CASES.filter((c) => c.group === 'encoded-delimiter')
        const unsafe = group.filter((c) => c.write)
        expect(unsafe.length).toBeGreaterThanOrEqual(200)
        for (const [delimiter, why] of TRUNCATION_DELIMITERS) {
          expect(
            unsafe.some((c) => c.url.includes(delimiter)),
            `no unsafe-direction case spells the delimiter as ${delimiter} (${why})`,
          ).toBe(true)
        }
        for (const [, readPrefix] of TRUNCATION_READ_PREFIXES) {
          expect(
            unsafe.some((c) => c.url.startsWith(readPrefix)),
            `no unsafe-direction case truncates onto the read prefix ${readPrefix}`,
          ).toBe(true)
        }
        /* And the mirror: the group keeps real reads, so "block anything with a
         * % or a # in it" cannot pass for a fix. */
        expect(group.filter((c) => !c.write).length).toBeGreaterThanOrEqual(4)
      })

      it('still carries a regression witness for every Spike F URL gap', () => {
        const covered = new Set(spikeFWitnesses().map((c) => c.gap))
        expect([...covered].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([...SPIKE_F_WITNESS_GAPS])
      })
    })
  })
}
