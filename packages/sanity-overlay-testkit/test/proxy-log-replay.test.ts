/**
 * The live-log replay harness (evidence review 2026-08-04, findings F4 and F3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `writeGuard.mjs` is default-deny: a request is a read only if the allowlist
 * names it. That is the correct policy — it is the only shape that covers the
 * *class* of write endpoints rather than the ones its author had heard of — but
 * it has a failure mode the enumerate-the-writers design did not: it can break
 * the Studio, silently, in a way no unit test notices, because the unit tests
 * only assert the requests somebody thought to write down.
 *
 * `examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl` is the one artifact in
 * this repository that records what a real Studio actually asked for: 422
 * request lines, 88 distinct `method + path` pairs, written server-side by the
 * proxy itself. This suite replays every one of them through the guard that is
 * in the tree right now and asserts:
 *
 *   1. every request the live session COMPLETED (status < 400) is still
 *      classified a read — unless it is on the explicit, individually
 *      justified degradation list below;
 *   2. the full set of "used to reach Sanity, now 403s" is exactly the pinned
 *      set — so widening or narrowing it is a reviewable diff, never a silent
 *      behaviour change;
 *   3. nothing the live session BLOCKED is now allowed through.
 *
 * The review's finding F4 is what this harness would have caught: the guard
 * had never met a live Studio, and four request lines the Studio previously
 * completed would now 403.
 *
 * THE RULING APPLIED TO EACH OF THE FOUR
 * --------------------------------------
 * Allow only if `@sanity/client@7.26.0` / `sanity@6.8.0` source establishes the
 * endpoint is genuinely non-mutating. Otherwise it stays blocked and is
 * recorded as a known Studio degradation, with the source citation that says
 * why. Widening the allowlist so a hypothesis can work is exactly how Gate E
 * failed the first time; nothing here is allowed on a guess.
 *
 * The log is EVIDENCE. This suite only ever reads it.
 */
import {describe, expect, it} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// @ts-expect-error — plain-JS guard shared with the Node proxy; no .d.ts by design
import {classifyRequest, isWriteRequest} from '../../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG_PATH = path.resolve(HERE, '../../../examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl')

interface LogRow {
  at: string
  method: string
  path: string
  status: number
  ms: number
  blocked: boolean
  upgrade?: boolean
  /* --- websocket frame-audit rows (F5b) ---------------------------------- *
   * Since the frame guard landed, the proxy also writes ONE ROW PER CLIENT
   * FRAME on an upgraded socket. Those rows carry `frame: true` and the
   * pseudo-method `WS`, because a frame has no HTTP request line. They are NOT
   * requests and must never be fed to `classifyRequest` — `WS` is not an HTTP
   * method, so default-deny classifies it a write and the replay harness would
   * report the Studio's own listener socket as "newly blocked". Keeping the two
   * populations separate is what stops that false positive.
   */
  frame?: boolean
  opcode?: number
  rpc?: string | null
  rpcId?: string | null
  wouldBlock?: boolean
  reason?: string
}

/** One distinct `method + path` pair, with everything the session observed about it. */
interface RequestLine {
  key: string
  method: string
  path: string
  occurrences: number
  statuses: number[]
  /** The proxy's own write guard rejected it at least once during that session. */
  wasBlocked: boolean
  /** The session got a non-error answer from Sanity at least once. */
  everSucceeded: boolean
}

function readLog(): LogRow[] {
  const raw = fs.readFileSync(LOG_PATH, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogRow)
}

function distinctRequestLines(rows: LogRow[]): RequestLine[] {
  const byKey = new Map<string, RequestLine>()
  for (const row of rows) {
    const key = `${row.method} ${row.path}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        key,
        method: row.method,
        path: row.path,
        occurrences: 0,
        statuses: [],
        wasBlocked: false,
        everSucceeded: false,
      }
      byKey.set(key, entry)
    }
    entry.occurrences += 1
    if (!entry.statuses.includes(row.status)) entry.statuses.push(row.status)
    if (row.blocked) entry.wasBlocked = true
    // A 3xx counts: `304 Not Modified` is how the Studio's conditional reads
    // succeed, and treating it as a failure would hide a real regression.
    if (row.status < 400) entry.everSucceeded = true
  }
  return [...byKey.values()]
}

const ALL_ROWS = readLog()
/** The websocket frame-audit rows — one per client frame, method `WS`. */
const FRAME_ROWS = ALL_ROWS.filter((row) => row.frame === true)
/** The HTTP request rows. Everything the replay harness reasons about. */
const ROWS = ALL_ROWS.filter((row) => row.frame !== true)
const REQUEST_LINES = distinctRequestLines(ROWS)

/* ------------------------------------------------------------------ *
 * the accepted degradations — the entire policy surface of F4
 * ------------------------------------------------------------------ */

interface AcceptedDegradation {
  method: string
  path: string
  /** What the endpoint does, established from vendored source, with the citation. */
  finding: string
  /** What the Studio loses, and why that is survivable for a preview. */
  consequence: string
}

/**
 * Every request line the live session sent that the current guard blocks.
 *
 * A `null` `finding` is not an option: an entry only lives here because
 * somebody read the vendored source and wrote down what the endpoint does.
 * Deleting an entry does not make the harness pass — it makes it fail with the
 * request line named, which is the point.
 */
const ACCEPTED_STUDIO_DEGRADATIONS: readonly AcceptedDegradation[] = Object.freeze([
  {
    method: 'POST',
    path: '/v2025-02-19/descriptors/claim',
    finding:
      'A WRITE, established from source rather than inferred. sanity@6.8.0 ' +
      'lib/WorkspaceLoader-BRx2afZV.js:5890-5930 — `uploadSchema()`, documented ' +
      '"Uploads the schema to Content Lake, returning a schema descriptor ID". It ' +
      'POSTs {descriptorId, contextKey} to /descriptors/claim and then loops up to ' +
      'five POSTs to /descriptors/synchronize uploading the schema chunks the ' +
      'server says it is missing. Its own caller gates it on ' +
      '`fetchCanDeployStudio()` (line 5886), i.e. on the `deployStudio` GRANT — ' +
      'Sanity itself classifies this as a deploy-time write, not a read.',
    consequence:
      'sanity@6.8.0 already treats failure as non-fatal: the call site at ' +
      'WorkspaceLoader-BRx2afZV.js:8417-8425 is `(...)().catch((err) => debug(' +
      '"Uploading schema failed", {err}))`, so `schemaDescriptorId` resolves to ' +
      'undefined and the workspace still loads. What degrades is anything keyed on ' +
      'the workspace schemaId — the Canvas link preflight (line 7209) and the ' +
      'schema-aware Agent Actions. Both are write features a preview must not have ' +
      'anyway. Cost: a 403 line in the log and a debug warning in the console.',
  },
  {
    method: 'POST',
    path: '/v2023-12-18/intake/batch',
    finding:
      'A write, and not to Content Lake: it is the @sanity/telemetry ingest ' +
      'endpoint (@sanity/telemetry@1.1.0, and the same URI in ' +
      '@sanity/cli/dist/services/telemetry.js). It POSTs a batch of studio ' +
      'telemetry events to Sanity. No read semantics exist at this path.',
    consequence:
      'None observable, now confirmed live. The pre-guard occurrence answered ' +
      '401, so the session never delivered a batch even with the proxy ' +
      'forwarding it; the 2026-08-04 session then hit it three times and got ' +
      '403 each time with no user-visible effect. The consent probe it is paired ' +
      'with, GET /v2023-12-18/intake/telemetry-status, is a read and still ' +
      'answers 200 — so the Studio resolves consent normally and merely drops ' +
      'the batch. A preview environment posting telemetry from a branch build is ' +
      'a leak, not a feature: blocking it is the outcome we would choose anyway.',
  },
  {
    method: 'GET',
    path: '/',
    finding:
      'Not Studio API traffic at all. This row (proxy-log.jsonl:258) is followed ' +
      '281 ms later by `GET /favicon.ico` (line 259) — the signature of a human ' +
      'opening the proxy origin in a browser tab, not of a client call. No URL ' +
      'builder in @sanity/client@7.26.0 emits a bare `/`: every path goes through ' +
      '`_getDataUrl()`, `buildAssetUploadUrl()` or a `uri:` literal, all of which ' +
      'are at least one segment deep under a version prefix.',
    consequence:
      'None. The API-host root is not an endpoint the Studio reads. Allowing it ' +
      'would put the widest possible path — `/` — on a default-deny allowlist to ' +
      'serve a manual browser visit.',
  },
  {
    method: 'GET',
    path: '/favicon.ico',
    finding:
      'The browser-issued sibling of the row above (proxy-log.jsonl:259), and the ' +
      'live session did not complete it either: Sanity answered 404. Nothing in ' +
      'sanity@6.8.0 or @sanity/client@7.26.0 requests a favicon from the API host.',
    consequence:
      'None. A tab opened directly against the proxy origin shows no favicon.',
  },
])

const DEGRADATION_KEYS = new Set(
  ACCEPTED_STUDIO_DEGRADATIONS.map((entry) => `${entry.method} ${entry.path}`),
)

/* ------------------------------------------------------------------ *
 * non-vacuity — the harness must fail if the evidence disappears
 * ------------------------------------------------------------------ */

describe('proxy-log replay · the evidence itself', () => {
  it('reads the committed proxy log', () => {
    expect(fs.existsSync(LOG_PATH)).toBe(true)
    // Pinned so a truncated, rotated or emptied log cannot turn this suite into
    // a green no-op. Every assertion below is quantified over these rows; with
    // zero rows they all pass vacuously.
    // Re-pinned 2026-08-04 after a second live Studio session was appended to
    // the log. Growth is expected — the log is append-only evidence — but it
    // must be a REVIEWED diff, which is what pinning the totals forces.
    expect(ALL_ROWS.length).toBe(730)
    expect(ROWS.length).toBe(669)
    expect(FRAME_ROWS.length).toBe(61)
    expect(REQUEST_LINES.length).toBe(96)
  })

  it('the log contains request lines that actually succeeded', () => {
    const succeeded = REQUEST_LINES.filter((line) => line.everSucceeded)
    expect(succeeded.length).toBeGreaterThanOrEqual(80)
  })

  it('the log contains the server-side blocked rows Spike F relies on', () => {
    const blocked = ROWS.filter((row) => row.blocked)
    // Six at the time of evidence review F3; fourteen after the 2026-08-04
    // session, which added three `descriptors/claim` and three `intake/batch`
    // 403s plus two more `data/actions`. Every one of them is a POST the guard
    // refused server-side.
    expect(blocked.length).toBe(14)
    expect(blocked.every((row) => row.status === 403)).toBe(true)
    expect(blocked.every((row) => row.method === 'POST')).toBe(true)
  })

  it('every accepted degradation names a real request line in the log', () => {
    const known = new Set(REQUEST_LINES.map((line) => line.key))
    const phantom = [...DEGRADATION_KEYS].filter((key) => !known.has(key))
    // An entry for a request the Studio never made is a licence granted against
    // no evidence — the exact move this harness exists to prevent.
    expect(phantom).toEqual([])
  })

  it('every accepted degradation carries a source-backed justification', () => {
    for (const entry of ACCEPTED_STUDIO_DEGRADATIONS) {
      expect(entry.finding.length).toBeGreaterThan(120)
      expect(entry.consequence.length).toBeGreaterThan(40)
    }
  })
})

/* ------------------------------------------------------------------ *
 * the harness proper
 * ------------------------------------------------------------------ */

describe('proxy-log replay · default-deny must not silently break the Studio', () => {
  it.each(REQUEST_LINES.filter((line) => line.everSucceeded))(
    'a request the live session completed is still allowed: $method $path (x$occurrences, $statuses)',
    ({method, path: requestPath, key}) => {
      const verdict = classifyRequest({method, url: requestPath})
      if (!verdict.write) return
      // Blocked, and the session completed it: this must be a deliberate,
      // individually justified casualty, not an accident of the allowlist.
      expect(
        DEGRADATION_KEYS.has(key),
        `${key} succeeded in the live session but the current guard blocks it ` +
          `(${verdict.reason}). Either add it to the read allowlist with a source ` +
          `citation, or record it in ACCEPTED_STUDIO_DEGRADATIONS with what the ` +
          `Studio loses.`,
      ).toBe(true)
    },
  )

  it('the set of request lines the guard blocks is exactly the pinned set', () => {
    const blockedByGuard = REQUEST_LINES.filter((line) =>
      isWriteRequest({method: line.method, url: line.path}),
    )
      .map((line) => line.key)
      .sort()

    // Not "at most seven" — exactly these seven, spelled out. A guard that stops
    // blocking one of them has widened the allowlist and must say so in this
    // diff; a guard that blocks an eighth has broken something the Studio does.
    expect(blockedByGuard).toEqual(
      [
        'GET /',
        'GET /favicon.ico',
        'POST /v2023-12-18/intake/batch',
        'POST /v2025-02-19/assets/images/parity',
        'POST /v2025-02-19/data/actions/parity',
        'POST /v2025-02-19/data/mutate/parity',
        'POST /v2025-02-19/descriptors/claim',
      ].sort(),
    )
  })

  it('every line the guard blocks is either evidenced blocked live, or an accepted degradation', () => {
    // The policy, stated once as a closed rule rather than as a list. Nothing
    // may be blocked for which no one has either a server-side 403 or a written,
    // source-cited justification.
    const unjustified = REQUEST_LINES.filter(
      (line) =>
        isWriteRequest({method: line.method, url: line.path}) &&
        !line.wasBlocked &&
        !DEGRADATION_KEYS.has(line.key),
    ).map((line) => line.key)
    expect(unjustified).toEqual([])
  })

  it('the 2026-08-04 session put descriptors/claim and intake/batch behind real 403s', () => {
    // F4, closed by live evidence rather than by argument. Both rulings were
    // made from vendored source BEFORE this session ran; the session then
    // exercised both endpoints for real and the guard refused them, server-side,
    // three times each. That is what makes the degradation list observed rather
    // than predicted.
    for (const requestPath of ['/v2025-02-19/descriptors/claim', '/v2023-12-18/intake/batch']) {
      const blocked = ROWS.filter((row) => row.path === requestPath && row.blocked)
      expect(blocked.length, `${requestPath} has no blocked rows`).toBe(3)
      expect(blocked.every((row) => row.status === 403 && row.method === 'POST')).toBe(true)
      expect(DEGRADATION_KEYS.has(`POST ${requestPath}`)).toBe(true)
    }
  })

  it('nothing the live session blocked is allowed through now', () => {
    const regressions = REQUEST_LINES.filter(
      (line) => line.wasBlocked && !isWriteRequest({method: line.method, url: line.path}),
    ).map((line) => line.key)
    expect(regressions).toEqual([])
  })

  it.each(REQUEST_LINES.filter((line) => line.wasBlocked))(
    'a request the live session blocked is still blocked: $method $path',
    ({method, path: requestPath}) => {
      expect(isWriteRequest({method, url: requestPath})).toBe(true)
    },
  )

  it('the guard still passes the overwhelming majority of the live session', () => {
    const allowed = REQUEST_LINES.filter(
      (line) => !isWriteRequest({method: line.method, url: line.path}),
    )
    // 89 of 96 after the 2026-08-04 session (81 of 88 before it). Pinned as a
    // floor so "default-deny" can never quietly become "deny the Studio" — the
    // same non-vacuity guard the write-guard contract applies to its read cases.
    expect(allowed.length).toBeGreaterThanOrEqual(89)
  })
})

/* ------------------------------------------------------------------ *
 * F5b — the frame audit, evidenced by a live Studio
 * ------------------------------------------------------------------ */

describe('F5b · the websocket frame audit ran against a real Studio', () => {
  it('the live session upgraded and the guard classified every client frame', () => {
    // The upgrade path is not theory: a real Studio completed the RFC 6455
    // handshake through the proxy and the guard read its traffic frame by frame.
    const upgrades = ROWS.filter((row) => row.upgrade && row.status === 101)
    expect(upgrades.length).toBeGreaterThanOrEqual(4)
    expect(upgrades.every((row) => row.path === '/v2022-06-30/socket/parity')).toBe(true)

    expect(FRAME_ROWS.length).toBe(61)
    // Every frame row carries a verdict. A row without one would mean the guard
    // forwarded bytes it had not classified.
    expect(FRAME_ROWS.every((row) => typeof row.reason === 'string' && row.reason.length > 0)).toBe(
      true,
    )
    expect(FRAME_ROWS.every((row) => row.frame === true && row.method === 'WS')).toBe(true)
  })

  it('every RPC method the live Studio sent is one the allowlist names', () => {
    // The allowlist was written from @sanity/bifur-client's source before this
    // session existed. This is the check that it matches what Studio actually
    // sends — i.e. that enforcing it does not break the real client.
    const rpcMethods = [...new Set(FRAME_ROWS.map((row) => row.rpc).filter(Boolean))].sort()
    expect(rpcMethods).toEqual([
      'authorization',
      'presence_announce',
      'presence_disconnect',
      'presence_rollcall',
      'presence_subscribe',
    ])
    // Not one frame the real Studio sent would have been refused.
    expect(FRAME_ROWS.filter((row) => row.wouldBlock)).toEqual([])
    // And `mutate` — the method that motivated the whole guard — never appeared,
    // which is exactly why it could only ever be ruled on from source.
    expect(rpcMethods).not.toContain('mutate')
  })

  it('the frames the guard saw are text and control frames only', () => {
    // 0x1 text (the JSON-RPC envelopes), 0x8 close, 0xa pong. A binary or
    // reserved opcode from the real client would mean the allowlist was written
    // against the wrong protocol.
    const opcodes = [...new Set(FRAME_ROWS.map((row) => row.opcode))].sort(
      (a, b) => Number(a) - Number(b),
    )
    expect(opcodes).toEqual([1, 8, 10])
  })

  it('no frame row ever recorded a payload', () => {
    // The first frame bifur sends is `{method:'authorization', params:{
    // authorization:'Bearer <token>'}}`. A guard that logged params would have
    // written the user's credential to this file. Assert the SHAPE of every row
    // rather than grepping for a token: the property is "no payload field
    // exists", not "this particular secret is absent".
    const permitted = new Set([
      'at',
      'method',
      'path',
      'status',
      'ms',
      'blocked',
      'upgrade',
      'frame',
      'opcode',
      'rpc',
      'rpcId',
      'wouldBlock',
      'reason',
    ])
    for (const row of FRAME_ROWS) {
      const unexpected = Object.keys(row).filter((key) => !permitted.has(key))
      expect(unexpected, `frame row at ${row.at} carries ${unexpected.join(',')}`).toEqual([])
    }
    expect(JSON.stringify(FRAME_ROWS)).not.toMatch(/Bearer|"params"/)
  })
})

/* ------------------------------------------------------------------ *
 * the HTTP/1.1 connection-pool starvation, as the live log records it
 * ------------------------------------------------------------------ *
 * The 2026-08-04 session hung the structure tool with
 *   `Socket timed out on request to .../data/doc/parity/drafts.author-2`.
 * The mechanism is reproduced end to end in `proxy-concurrency.test.ts`; what is
 * pinned HERE is the live artifact that mechanism explains, so the finding
 * cannot be quietly dropped by editing a comment somewhere.
 */

describe('the starved-request signature in the live log', () => {
  /** `at` is written on COMPLETION, so a request's start is `at - ms`. */
  const interval = (row: LogRow) => {
    const end = new Date(row.at).getTime()
    return {start: end - row.ms, end}
  }

  it('the request Studio reported as timed out has preflights but no GET row', () => {
    const hung = '/v2025-02-19/data/doc/parity/drafts.author-2'
    const window = ROWS.filter((row) => row.path === hung && row.at < '2026-08-04T20:50:00')

    // Two 204 preflights at 20:47:43.65x ...
    expect(window.map((row) => row.method)).toEqual(['OPTIONS', 'OPTIONS'])
    expect(window.every((row) => row.status === 204)).toBe(true)
    // ... and no GET. Rows are written on completion, so a GET with no row never
    // completed. The browser never sent it: it was queued behind the listeners.
    expect(window.filter((row) => row.method === 'GET')).toEqual([])
  })

  it('the same endpoint answered normally once the page had settled', () => {
    // Load-dependent starvation, not a broken route. Without this the diagnosis
    // would be "the endpoint is blocked", which is false, and would send the fix
    // to the write guard instead of to the transport.
    const later = ROWS.find(
      (row) => row.path === '/v2025-02-19/data/doc/parity/drafts.author-2' && row.method === 'GET',
    )
    expect(later).toBeDefined()
    expect(later!.status).toBe(200)
    expect(later!.ms).toBeLessThan(1000)
    expect(later!.at > '2026-08-04T20:50:00').toBe(true)
  })

  it('long-lived listener streams saturated the browsers six-connection budget', () => {
    // The cause, measured. Chrome allows six HTTP/1.1 connections per host; the
    // session held at least that many listener streams open at once.
    const longLived = ROWS.filter(
      (row) => row.method === 'GET' && /\/listen/.test(row.path) && row.ms > 10_000,
    ).map(interval)
    expect(longLived.length).toBeGreaterThanOrEqual(7)

    const events = longLived.flatMap(({start, end}) => [
      {t: start, d: 1},
      {t: end, d: -1},
    ])
    events.sort((a, b) => a.t - b.t || a.d - b.d)
    let open = 0
    let peak = 0
    for (const {d} of events) {
      open += d
      peak = Math.max(peak, open)
    }
    expect(peak).toBeGreaterThanOrEqual(6)
  })

  it('listener GETs outnumber their completions, the signature of streams left hanging', () => {
    // A preflight with no completed GET is a request that never finished. Across
    // the session the listener path was preflighted far more often than it
    // completed — the accumulation that eventually starved everything else.
    const listen = (method: string) =>
      ROWS.filter((row) => row.method === method && row.path === '/v2025-02-19/data/listen/parity')
        .length
    expect(listen('OPTIONS')).toBe(18)
    expect(listen('GET')).toBe(8)
    expect(listen('OPTIONS')).toBeGreaterThan(listen('GET'))
  })
})

/* ------------------------------------------------------------------ *
 * F3 — the "re-verified live" claim, made checkable at the classifier
 * ------------------------------------------------------------------ *
 * `docs/plans/evidence/phase-1/spike-f-safety-boundary/report.md:64` claims a
 * live smoke run in which seven request shapes all returned 403. The committed
 * proxy log contains six blocked rows, none of them these shapes, and zero
 * DELETE/PUT/PATCH requests of any kind — so the live half of that claim has no
 * server-side artifact and cannot be manufactured from here.
 *
 * What CAN be established here is the classifier half: each of the seven shapes
 * is a write according to the guard that would answer them. The live half is
 * converted into a checklist of exact log lines a future browser run must
 * produce — see `examples/kitchen-sink/spikeB-proxy/README.md`, "Substantiating
 * a re-verified-live claim".
 */

interface ClaimedShape {
  method: string
  path: string
  claim: string
}

/** The seven shapes named in spike-f-safety-boundary/report.md:64, verbatim. */
const SPIKE_F_RE_VERIFIED_SHAPES: readonly ClaimedShape[] = Object.freeze([
  {method: 'POST', path: '/v2025-02-19/assets/images/parity', claim: '/assets/images/*'},
  {method: 'POST', path: '/v2025-02-19/agent/action/patch/parity', claim: '/agent/action/patch'},
  {method: 'DELETE', path: '/v2025-02-19/datasets/parity', claim: 'DELETE /datasets/*'},
  {
    method: 'POST',
    path: '/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate',
    claim: '/projects/*/datasets/*/mutate',
  },
  {method: 'POST', path: '/v2025-02-19//data//mutate//parity', claim: '//data//mutate//'},
  {method: 'POST', path: '/v2025-02-19/DATA/MUTATE/parity', claim: '/DATA/MUTATE/'},
  {method: 'POST', path: '/v2025-02-19/data/..%2Fmutate/parity', claim: '/data/..%2Fmutate/'},
])

/** The guard Spike F defeated, kept as this block's non-vacuity oracle. */
function naivePreSpikeFGuard({method, url}: {method: string; url: string}): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  return /\/data\/(mutate|actions)\b/.test(url)
}

describe('F3 · the seven shapes Spike F claims were re-verified live', () => {
  it('there are seven of them', () => {
    expect(SPIKE_F_RE_VERIFIED_SHAPES.length).toBe(7)
  })

  it.each(SPIKE_F_RE_VERIFIED_SHAPES)(
    'the current guard blocks $method $path ($claim)',
    ({method, path: requestPath}) => {
      expect(isWriteRequest({method, url: requestPath})).toBe(true)
    },
  )

  it('most of the seven escape the guard Spike F defeated', () => {
    // Non-vacuity: without this, "the guard blocks all seven" would also be
    // satisfied by a guard that blocks everything, and by the broken guard for
    // the two shapes that happen to contain a literal `/data/mutate`.
    const escaped = SPIKE_F_RE_VERIFIED_SHAPES.filter(
      (shape) => !naivePreSpikeFGuard({method: shape.method, url: shape.path}),
    )
    expect(escaped.length).toBeGreaterThanOrEqual(5)
  })

  it('exactly one of the seven has a committed server-side blocked row', () => {
    // This is F3, pinned precisely rather than rhetorically. `/assets/images/*`
    // IS evidenced — one 403 row at 04:52:10.828. The other six are not. When a
    // real run lands and the log is recommitted, this assertion goes red and
    // must be updated to the new count, which is the only honest way for the
    // claim to become evidence rather than to stay prose.
    const blockedPaths = ROWS.filter((row) => row.blocked).map((row) => row.path)
    const evidenced = SPIKE_F_RE_VERIFIED_SHAPES.filter((shape) =>
      blockedPaths.includes(shape.path),
    )
    expect(evidenced.map((shape) => shape.claim)).toEqual(['/assets/images/*'])
  })

  it('the log holds no DELETE, PUT or PATCH request of any kind', () => {
    // Three of the seven claimed shapes are non-POST verbs. A log with no such
    // verb in it cannot be the log of the run that exercised them.
    const methods = new Set(ROWS.map((row) => row.method))
    expect([...methods].sort()).toEqual(['GET', 'OPTIONS', 'POST'])
  })
})

/* ------------------------------------------------------------------ *
 * F3 · grading the live run the README asks for
 * ------------------------------------------------------------------ *
 * `examples/kitchen-sink/spikeB-proxy/README.md`, "Substantiating a
 * re-verified-live claim", tells the orchestrator to run the seven shapes
 * through a live proxy with `PROXY_LOG=…/proxy-log-reverify.jsonl` and commit
 * the result. This block is the machine that grades it, so "re-verified live"
 * stops being prose the moment the file lands.
 *
 * The grader is tested against synthetic logs FIRST — including the committed
 * `proxy-log.jsonl`, which must FAIL, because that is precisely the substitution
 * F3 caught: an old log offered in place of the run that never happened.
 */

const REVERIFY_LOG_PATH = path.resolve(
  HERE,
  '../../../examples/kitchen-sink/spikeB-proxy/proxy-log-reverify.jsonl',
)

interface ShapeVerdict {
  claim: string
  ok: boolean
  reason: string
}

/**
 * Exactly the rule the README's `node -e` snippet applies, so the two cannot
 * drift: one row per shape with `blocked: true` and `status: 403`, no row on
 * that shape that was NOT blocked, and at least one allowlisted read that
 * succeeded in the same log.
 */
function gradeReverifyLog(rows: LogRow[]): {shapes: ShapeVerdict[]; liveness: ShapeVerdict} {
  const shapes = SPIKE_F_RE_VERIFIED_SHAPES.map((shape) => {
    const onShape = rows.filter((row) => row.method === shape.method && row.path === shape.path)
    const blocked = onShape.find((row) => row.blocked === true && row.status === 403)
    const leaked = onShape.find((row) => row.blocked !== true)
    if (leaked) {
      return {
        claim: shape.claim,
        ok: false,
        reason: `reached upstream (status ${leaked.status}, blocked=${leaked.blocked})`,
      }
    }
    if (!blocked) return {claim: shape.claim, ok: false, reason: 'no blocked 403 row in the log'}
    return {claim: shape.claim, ok: true, reason: 'blocked 403, server-side'}
  })

  const alive = rows.some(
    (row) => row.method === 'GET' && !row.blocked && row.status >= 200 && row.status < 300,
  )
  return {
    shapes,
    liveness: {
      claim: 'proxy answered an allowlisted read in the same session',
      ok: alive,
      // Without this a proxy that 403s absolutely everything scores 7/7.
      reason: alive ? 'at least one 2xx GET' : 'no allowlisted read succeeded',
    },
  }
}

/** The shape of a log the README's checklist would accept. */
function syntheticPassingLog(): LogRow[] {
  const rows: LogRow[] = SPIKE_F_RE_VERIFIED_SHAPES.map((shape, index) => ({
    at: new Date(Date.UTC(2026, 7, 5, 12, 0, index)).toISOString(),
    method: shape.method,
    path: shape.path,
    status: 403,
    ms: 0,
    blocked: true,
  }))
  rows.push({
    at: new Date(Date.UTC(2026, 7, 5, 12, 0, 30)).toISOString(),
    method: 'GET',
    path: '/v2025-02-19/ping',
    status: 200,
    ms: 12,
    blocked: false,
  })
  return rows
}

describe('F3 · the grader for a future live re-verification run', () => {
  it('accepts a log that satisfies the README checklist', () => {
    const graded = gradeReverifyLog(syntheticPassingLog())
    expect(graded.shapes.filter((verdict) => !verdict.ok)).toEqual([])
    expect(graded.liveness.ok).toBe(true)
  })

  it('rejects the committed proxy-log.jsonl — which is exactly what F3 found', () => {
    // The whole finding, as an executable assertion: offering the existing log
    // as evidence for the seven shapes fails on six of them. If this ever goes
    // green against `proxy-log.jsonl`, the log has been overwritten and the
    // repository has lost the session it records.
    const graded = gradeReverifyLog(ROWS)
    const passed = graded.shapes.filter((verdict) => verdict.ok).map((verdict) => verdict.claim)
    expect(passed).toEqual(['/assets/images/*'])
    expect(graded.shapes.filter((verdict) => !verdict.ok)).toHaveLength(6)
  })

  it('rejects a log missing the non-POST verbs', () => {
    const rows = syntheticPassingLog().filter((row) => row.method === 'POST' || !row.blocked)
    const graded = gradeReverifyLog(rows)
    const failed = graded.shapes.filter((verdict) => !verdict.ok).map((verdict) => verdict.claim)
    expect(failed).toEqual(['DELETE /datasets/*'])
  })

  it('rejects a log in which a shape reached upstream', () => {
    const rows = syntheticPassingLog()
    const escapee = rows.find((row) => row.path.endsWith('/DATA/MUTATE/parity'))!
    escapee.blocked = false
    escapee.status = 200
    const graded = gradeReverifyLog(rows)
    const failed = graded.shapes.filter((verdict) => !verdict.ok)
    expect(failed.map((verdict) => verdict.claim)).toEqual(['/DATA/MUTATE/'])
    expect(failed[0].reason).toContain('reached upstream')
  })

  it('rejects a log from a proxy that blocked everything', () => {
    // Non-vacuity in the other direction: 7/7 blocked is not evidence unless a
    // read got through in the same session.
    const rows = syntheticPassingLog().filter((row) => row.blocked)
    const graded = gradeReverifyLog(rows)
    expect(graded.shapes.every((verdict) => verdict.ok)).toBe(true)
    expect(graded.liveness.ok).toBe(false)
  })
})

describe('F3 · has the live re-verification actually happened?', () => {
  const present = fs.existsSync(REVERIFY_LOG_PATH)

  it('the live re-verification has not happened yet', () => {
    // A PINNED LITERAL, not a skip. `describe.skipIf` would let the whole leg
    // vanish silently (evidence review F7); this cannot. Committing
    // proxy-log-reverify.jsonl turns this assertion red, and flipping it to
    // `true` is what switches the block below on. The claim in
    // spike-f-safety-boundary/report.md:64 therefore cannot be marked verified
    // without the server-side artifact landing in the same diff.
    expect(present).toBe(false)
  })

  it('grades the re-verification log when one exists', () => {
    if (!present) {
      // Not a silent pass: the assertion above is what fails if this branch is
      // taken after the log lands.
      expect(present).toBe(false)
      return
    }
    const rows = fs
      .readFileSync(REVERIFY_LOG_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogRow)
    const graded = gradeReverifyLog(rows)
    expect(graded.shapes.filter((verdict) => !verdict.ok)).toEqual([])
    expect(graded.liveness.ok).toBe(true)
  })
})
