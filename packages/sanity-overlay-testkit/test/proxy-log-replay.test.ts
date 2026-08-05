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

/**
 * One line of `proxy-log.jsonl` as it comes off the disk — untyped by kind,
 * because that is the state the file is in: the proxy writes two different
 * record types into one stream.
 */
interface RawLogLine {
  at: string
  method: string
  path: string
  status: number
  ms: number
  blocked: boolean
  upgrade?: boolean
  frame?: boolean
  opcode?: number
  rpc?: string | null
  rpcId?: string | null
  wouldBlock?: boolean
  reason?: string
}

/** Everything both record types carry. */
interface LogRecordBase {
  at: string
  path: string
  status: number
  ms: number
  blocked: boolean
  upgrade?: boolean
}

/**
 * An HTTP request line. This — and only this — is what `classifyRequest` may be
 * asked about, because it is the only record type that HAS a request line.
 */
interface RequestRecord extends LogRecordBase {
  kind: 'request'
  method: string
}

/**
 * One client frame on an upgraded socket (F5b). `proxy.mjs:736` writes the
 * pseudo-method `WS` here because a frame has no request line at all.
 *
 * THIS IS NOT A REQUEST, and the distinction is load-bearing rather than
 * cosmetic. The guard is default-deny: `WS` matches no read method, so
 * `classifyRequest({method: 'WS', ...})` returns `write: true`. Frame rows carry
 * status 101, which the replay harness reads as "the live session completed
 * this" — so a frame record that leaks into the request population makes the
 * harness report the Studio's own listener socket as newly blocked by the guard.
 *
 * The tag below is the fix. Not a `method === 'WS'` special case anywhere
 * downstream, and emphatically not `WS` on the guard's read allowlist: a real
 * request line spelling `WS` would then be waved through. One kind, decided
 * once, at the parse boundary.
 */
interface FrameRecord extends LogRecordBase {
  kind: 'frame'
  method: 'WS'
  frame: true
  opcode?: number
  rpc?: string | null
  rpcId?: string | null
  wouldBlock?: boolean
  reason?: string
}

type LogRecord = RequestRecord | FrameRecord

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

function readRawLog(logPath: string): RawLogLine[] {
  const raw = fs.readFileSync(logPath, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawLogLine)
}

/** The only door into this suite: every raw line is tagged here or refused here. */
function readLog(logPath: string = LOG_PATH): LogRecord[] {
  return readRawLog(logPath).map(toLogRecord)
}

function distinctRequestLines(rows: RequestRecord[]): RequestLine[] {
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

const HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
])

/**
 * Decide, once, which kind of record a raw line is.
 *
 * The third branch is deliberate. "Not a frame" does not mean "a request": if
 * `proxy.mjs` ever writes a third record type, folding it into the request
 * population is exactly how `WS` ended up in front of a default-deny HTTP guard.
 * Default-deny applied to the log schema itself — an unrecognised record stops
 * the harness instead of being classified by something that cannot classify it.
 */
function toLogRecord(raw: RawLogLine): LogRecord {
  if (raw.frame === true) {
    if (raw.method !== 'WS') {
      throw new Error(
        `log line at ${raw.at} is a frame record with method ${JSON.stringify(raw.method)}; ` +
          `proxy.mjs writes the pseudo-method 'WS' on every frame row`,
      )
    }
    return {...raw, kind: 'frame', frame: true, method: 'WS'}
  }
  if (!HTTP_METHODS.has(raw.method)) {
    throw new Error(
      `log line at ${raw.at} is neither a frame record nor an HTTP request line ` +
        `(method ${JSON.stringify(raw.method)}). Teach the harness the new record ` +
        `kind — do not let it reach a guard that classifies request lines.`,
    )
  }
  const {frame: _frame, opcode: _opcode, rpc: _rpc, rpcId: _rpcId, wouldBlock: _wouldBlock, reason: _reason, ...request} = raw
  return {...request, kind: 'request'}
}

const isFrameRecord = (record: LogRecord): record is FrameRecord => record.kind === 'frame'
const isRequestRecord = (record: LogRecord): record is RequestRecord => record.kind === 'request'

const ALL_RECORDS: LogRecord[] = readLog()
/** The websocket frame-audit records — one per client frame, method `WS`. */
const FRAME_ROWS: FrameRecord[] = ALL_RECORDS.filter(isFrameRecord)
/** The HTTP request records. Everything the replay harness reasons about. */
const ROWS: RequestRecord[] = ALL_RECORDS.filter(isRequestRecord)
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
    expect(ALL_RECORDS.length).toBe(730)
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
    // session. The whole-log breakdown, counted from the file rather than
    // recalled: `data/actions` x4, `descriptors/claim` x4, `intake/batch` x4,
    // `data/mutate` x1, `assets/images` x1. Every one of them is a POST the
    // guard refused server-side.
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
 * the record-type boundary — one log file, two populations
 * ------------------------------------------------------------------ *
 * `proxy-log.jsonl` is not a log of request lines. Since the frame guard landed
 * it interleaves two record types in one stream: HTTP request lines, and one
 * record per client frame on an upgraded socket. A frame has no request line, so
 * the proxy writes the pseudo-method `WS` in the `method` field
 * (proxy.mjs:736) — and `WS` is not an HTTP method.
 *
 * That matters because the guard is DEFAULT-DENY. `classifyRequest` answers
 * "is this on the read allowlist?", `WS` matches no read method, and the answer
 * comes back `write: true`. Replay a frame record through the harness and it is
 * reported as a request the live session completed (status 101) that the current
 * guard now blocks — i.e. the harness accuses the guard of breaking the Studio's
 * own listener socket, which is the one thing this suite exists to detect
 * truthfully.
 *
 * The fix is NOT to teach the guard the string `WS`: that would put a
 * non-HTTP token on an HTTP allowlist, and a real request line carrying
 * `WS` would then be waved through. The fix is that a frame is a DIFFERENT KIND
 * OF RECORD, tagged as such at the parse boundary, so it cannot reach a function
 * that classifies request lines.
 */

describe('proxy-log replay · frames and request lines are different kinds of record', () => {
  it('every record the reader returns declares its kind', () => {
    const kinds = [...new Set(ALL_RECORDS.map((record) => record.kind))].sort()
    // Two kinds, both present. Not "request or undefined": an untagged record is
    // one whose routing depends on whoever happens to read it next.
    expect(kinds).toEqual(['frame', 'request'])
    expect(ALL_RECORDS.filter(isFrameRecord).length).toBe(61)
    expect(ALL_RECORDS.filter(isRequestRecord).length).toBe(669)
    // Total: no record falls out of the partition.
    expect(ALL_RECORDS.length).toBe(730)
  })

  it('only request records carry an HTTP method, and frame records never do', () => {
    for (const record of ALL_RECORDS) {
      if (record.kind === 'request') {
        expect(HTTP_METHODS.has(record.method), `${record.method} ${record.path}`).toBe(true)
      } else {
        expect(record.method).toBe('WS')
        expect(HTTP_METHODS.has(record.method)).toBe(false)
      }
    }
  })

  it('a frame record handed to the request classifier comes back a write', () => {
    // The mis-classification itself, pinned rather than described. This is the
    // reason the partition above must exist and must stay: every one of these
    // records has status 101 (so the replay harness would count it as a request
    // the live session completed) and the guard calls all 61 of them writes.
    const frames = ALL_RECORDS.filter(isFrameRecord)
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      const verdict = classifyRequest({method: frame.method, url: frame.path})
      expect(verdict.write).toBe(true)
      expect(verdict.reason).toBe('not on the read allowlist (default-deny)')
    }
    // ... while the same socket's HANDSHAKE — a real GET request line on the
    // same path — is correctly a read. So the defect is the record type, not
    // the path or the allowlist.
    expect(isWriteRequest({method: 'GET', url: '/v2022-06-30/socket/parity'})).toBe(false)
  })

  it('the replayed request population contains no frame record', () => {
    // The population every other assertion in this file quantifies over. A
    // frame record reaching it is the false positive described above.
    const pseudo = REQUEST_LINES.filter((line) => !HTTP_METHODS.has(line.method))
    expect(pseudo.map((line) => line.key)).toEqual([])
    expect(REQUEST_LINES.some((line) => line.key.includes('/socket/parity'))).toBe(true)
  })

  it('a record that is neither a frame nor an HTTP request line is refused, not assumed', () => {
    // Default-deny applied to the LOG SCHEMA. If `proxy.mjs` grows a third
    // record type, the harness must stop rather than quietly fold it into the
    // request population — the exact failure mode that put `WS` in front of the
    // guard in the first place.
    expect(() =>
      toLogRecord({at: '2026-08-05T00:00:00.000Z', method: 'TICK', path: '/', status: 0, ms: 0, blocked: false}),
    ).toThrow(/neither a frame record nor an HTTP request line/)
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
    // four times each. Counted over the WHOLE log, not over a hand-picked time
    // window: the window was an artifact of how this assertion was first
    // written, and a count that depends on where the author drew the window is
    // not evidence. The pre-guard occurrences are still visible in the same log
    // (descriptors/claim answered 200 x3 at 14:39-14:47, intake/batch 401 x1 at
    // 14:43) and are exactly what makes the 403s a change in behaviour.
    for (const requestPath of ['/v2025-02-19/descriptors/claim', '/v2023-12-18/intake/batch']) {
      const blocked = ROWS.filter((row) => row.path === requestPath && row.blocked)
      expect(blocked.length, `${requestPath} has no blocked rows`).toBe(4)
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
    // The RAW lines, not the tagged records: the property is about what the
    // proxy WROTE TO DISK. Asserting over `FRAME_ROWS` would be asserting over
    // objects this file constructed, which cannot leak a credential.
    const rawFrames = readRawLog(LOG_PATH).filter((row) => row.frame === true)
    expect(rawFrames.length).toBe(61)
    for (const row of rawFrames) {
      const unexpected = Object.keys(row).filter((key) => !permitted.has(key))
      expect(unexpected, `frame row at ${row.at} carries ${unexpected.join(',')}`).toEqual([])
    }
    expect(JSON.stringify(rawFrames)).not.toMatch(/Bearer|"params"/)
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
  const interval = (row: RequestRecord) => {
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
    // Whole-log counts. Rows are written on COMPLETION, so a preflight with no
    // matching GET row is a stream that never finished — 72 preflights against
    // 34 completions is 38 listener GETs the browser opened and never closed.
    expect(listen('OPTIONS')).toBe(72)
    expect(listen('GET')).toBe(34)
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
function gradeReverifyLog(rows: RequestRecord[]): {shapes: ShapeVerdict[]; liveness: ShapeVerdict} {
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
function syntheticPassingLog(): RequestRecord[] {
  const rows: RequestRecord[] = SPIKE_F_RE_VERIFIED_SHAPES.map((shape, index) => ({
    kind: 'request',
    at: new Date(Date.UTC(2026, 7, 5, 12, 0, index)).toISOString(),
    method: shape.method,
    path: shape.path,
    status: 403,
    ms: 0,
    blocked: true,
  }))
  rows.push({
    kind: 'request',
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

  it('the live re-verification has happened (2026-08-04)', () => {
    // A PINNED LITERAL, not a skip. `describe.skipIf` would let the whole leg
    // vanish silently (evidence review F7); this cannot. The tripwire did its
    // job: it went red the moment proxy-log-reverify.jsonl landed, forcing this
    // flip to be deliberate rather than incidental, and switching the grading
    // block below on. Deleting the artifact turns this red again — the claim in
    // spike-f-safety-boundary/report.md:64 cannot outlive its evidence.
    // Session recorded in docs/plans/evidence/phase-1/live-validation-2026-08-04.md §3.
    expect(present).toBe(true)
  })

  it('grades the re-verification log when one exists', () => {
    if (!present) {
      // Not a silent pass: the assertion above is what fails if this branch is
      // taken after the log lands.
      expect(present).toBe(true)
      return
    }
    // Through the SAME parse boundary as the committed log. A live run upgrades
    // the socket, so a real re-verification log will carry frame records too —
    // and the grader must never see them.
    const graded = gradeReverifyLog(readLog(REVERIFY_LOG_PATH).filter(isRequestRecord))
    expect(graded.shapes.filter((verdict) => !verdict.ok)).toEqual([])
    expect(graded.liveness.ok).toBe(true)
  })
})
