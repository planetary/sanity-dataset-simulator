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

const ROWS = readLog()
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
      'None observable. The single occurrence in the log answered 401, so the ' +
      'session never delivered a batch even with the proxy forwarding it. A ' +
      'preview environment posting telemetry from a branch build is a leak, not a ' +
      'feature — blocking it is the outcome we would choose anyway.',
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
    expect(ROWS.length).toBe(422)
    expect(REQUEST_LINES.length).toBe(88)
  })

  it('the log contains request lines that actually succeeded', () => {
    const succeeded = REQUEST_LINES.filter((line) => line.everSucceeded)
    expect(succeeded.length).toBeGreaterThanOrEqual(80)
  })

  it('the log contains the six server-side blocked rows Spike F relies on', () => {
    const blocked = ROWS.filter((row) => row.blocked)
    expect(blocked.length).toBe(6)
    expect(blocked.every((row) => row.status === 403)).toBe(true)
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

  it('the set of newly-blocked request lines is exactly the pinned set', () => {
    const newlyBlocked = REQUEST_LINES.filter(
      (line) => !line.wasBlocked && isWriteRequest({method: line.method, url: line.path}),
    ).map((line) => line.key)

    // Not "at most four" — exactly these four. A guard that stops blocking one
    // of them has widened the allowlist and must say so here; a guard that
    // blocks a fifth has broken something the Studio was doing.
    expect(newlyBlocked.sort()).toEqual([...DEGRADATION_KEYS].sort())
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
    // 81 of 88 at the time of writing. Pinned as a floor so "default-deny" can
    // never quietly become "deny the Studio" — the same non-vacuity guard the
    // write-guard contract applies to its read cases.
    expect(allowed.length).toBeGreaterThanOrEqual(81)
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
