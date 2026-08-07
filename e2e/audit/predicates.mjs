/**
 * THE NETWORK AUDIT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STANDING RULE THIS IMPLEMENTS
 *
 * *Server-side logs are the only trustworthy escape evidence.* Browser-side
 * detection has produced false all-clears on this project three times — a fatal
 * boot crash hidden by `{subscribe}` doubles, silently lost Unicode, a list pane
 * rendering staging while every test passed. Nothing here reads anything the
 * page says about itself. Every input is a file a server wrote.
 *
 * The pattern is lifted deliberately from
 * `examples/kitchen-sink/spikeB-proxy/README.md` Step 4: mechanical predicates
 * over a JSONL log, with **liveness** controls (so a dead proxy cannot pass),
 * **freshness** controls (so yesterday's log cannot be offered in place of this
 * run), a **leak** control, and a **negative control** proving the committed log
 * itself fails them. `predicates.test.mjs` is that negative control and it runs
 * today, without Playwright.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PLANES, BECAUSE ONE IS NOT ENOUGH
 *
 * The proxy log proves the NEGATIVE: nothing Studio sent towards Sanity was a
 * write. It cannot prove the POSITIVE, and the acceptance audit says so
 * (`docs/plans/evidence/phase-3/acceptance-audit.md` §3.2.3): in plugin mode the
 * facade writes to the overlay API at :3998 and those requests never traverse
 * the proxy at all. A run where the editor did nothing whatsoever produces a
 * spotless proxy log.
 *
 * So the audit reads both:
 *
 *   A-predicates  proxy log     — no write escaped towards Sanity
 *   B-predicates  overlay log   — the writes happened, and landed on the overlay
 *   C-predicates  cross-cutting — the pinned evidence file was not touched
 *
 * A run that passes A while failing B is not a clean run; it is a run that
 * tested nothing. That asymmetry is the whole point of B2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE OVERLAPPING NETS OVER THE SAME QUESTION
 *
 * A3 asks it in verbs and knows nothing about Sanity's API. A4 asks it through
 * an allowlist re-derived independently of the guard (`readAllowlist.mjs`). A5
 * asks whether the guard and that allowlist disagree in the dangerous direction.
 * Any one of them can catch an escape the other two are blind to; all three
 * failing at once is what an actual escape looks like.
 */
import {execFileSync} from 'node:child_process'

import {classify as classifyIndependently} from './readAllowlist.mjs'
import {
  HTTP_METHODS,
  describe,
  frameRecords,
  isSuccess,
  readLog,
  requestRecords,
  timeOf,
} from './logModel.mjs'

/** The guard the proxy actually used. Imported ONLY to detect disagreement. */
let guardClassify = null
try {
  const module = await import('../../examples/kitchen-sink/spikeB-proxy/writeGuard.mjs')
  guardClassify = module.classifyRequest
} catch {
  guardClassify = null
}

const RESULT = (id, title, pass, note = '') => ({id, title, pass, note})

/* ═══════════════════════════════════════════════════ A — the Sanity plane ══ */

/**
 * Verbs that cannot mutate. The one exception the API genuinely needs is
 * `POST …/query`, the fallback Studio uses when a GROQ query is too long for a
 * query string — so it is named explicitly rather than left to a classifier.
 */
function isVerbSafe(record) {
  const verb = String(record.method ?? '').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return true
  if (verb !== 'POST') return false

  const segments = String(record.path ?? '')
    .split('?')[0]
    .split('/')
    .filter((segment) => segment.length > 0)

  /* A path that spells a dot segment is never safe: the proxy matches a
   * canonical path but forwards the raw request line, so the bytes on the wire
   * may still say `mutate`. */
  if (segments.some((segment) => segment === '.' || segment === '..')) return false

  const index = segments.indexOf('query')
  if (index < 1) return false
  /* `/vX/data/query/<ds>` — the data-plane long-GROQ fallback. */
  if (segments[index - 1] === 'data') return true
  /* `/vX/projects/<p>/datasets/<d>/query` — the resource-scoped spelling. */
  return index >= 2 && segments[index - 2] === 'datasets'
}

export function auditProxyLog({log, runStartedAt}) {
  const results = []
  const {exists, raw, lines, records, parseError} = log

  results.push(
    RESULT(
      'A0',
      'the proxy log exists, is non-empty, and every line parses as JSON',
      exists && records !== null && records.length > 0,
      parseError ?? `${lines.length} lines`,
    ),
  )

  /* Stop here on an empty or unparseable log. A2, A4, A6 and A7 are all
   * satisfied vacuously by zero records, and a vacuous PASS is precisely the
   * failure mode this checklist exists to prevent. */
  if (records === null || records.length === 0) return results

  const R = requestRecords(records)
  const F = frameRecords(records)

  results.push(
    RESULT(
      'A1',
      'record kinds are well-formed — request records carry a real verb, frame records carry "WS" on an upgrade',
      R.every((record) => HTTP_METHODS.has(String(record.method))) &&
        F.every((record) => record.method === 'WS' && record.upgrade === true),
      `${R.length} request records, ${F.length} frame records`,
    ),
  )

  results.push(
    RESULT(
      'A2',
      'every request record carries an ISO timestamp and a numeric status',
      R.every((record) => Number.isFinite(timeOf(record)) && typeof record.status === 'number'),
      `${R.length} request records`,
    ),
  )

  /* ── A3, the classifier-free net ─────────────────────────────────────── */
  const verbEscapes = R.filter((record) => record.blocked !== true && !isVerbSafe(record))
  results.push(
    RESULT(
      'A3',
      'no request with a mutating verb was forwarded (classifier-free)',
      verbEscapes.length === 0,
      verbEscapes.length === 0
        ? `${R.length} forwarded requests, all GET/HEAD/OPTIONS or POST …/query`
        : `ESCAPED: ${verbEscapes.slice(0, 5).map(describe).join(' | ')}`,
    ),
  )

  /* ── A4, the independent allowlist ───────────────────────────────────── */
  const allowlistEscapes = R.filter(
    (record) => !classifyIndependently(record).read && record.blocked !== true,
  )
  results.push(
    RESULT(
      'A4',
      'every request the independent read allowlist calls a write was blocked',
      allowlistEscapes.length === 0,
      allowlistEscapes.length === 0
        ? 'no unblocked writes'
        : `ESCAPED: ${allowlistEscapes.slice(0, 5).map(describe).join(' | ')}`,
    ),
  )

  results.push(
    RESULT(
      'A4b',
      'every blocked request was blocked with 403, not some other status',
      R.filter((record) => record.blocked === true).every((record) => record.status === 403),
      `${R.filter((record) => record.blocked === true).length} blocked requests`,
    ),
  )

  /* ── A5, disagreement in the dangerous direction only ────────────────── */
  if (guardClassify === null) {
    results.push(RESULT('A5', 'the proxy write guard and the independent allowlist agree', false,
      'writeGuard.mjs could not be imported — the cross-check could not be evaluated'))
  } else {
    const disagreements = R.filter((record) => {
      const guard = guardClassify({method: record.method, url: record.path})
      return guard.write === false && !classifyIndependently(record).read
    })
    results.push(
      RESULT(
        'A5',
        'the proxy write guard never calls "read" something the independent allowlist calls a write',
        disagreements.length === 0,
        disagreements.length === 0
          ? 'classifiers agree in the dangerous direction'
          : `GUARD MORE PERMISSIVE ON: ${disagreements.slice(0, 5).map(describe).join(' | ')}`,
      ),
    )
  }

  /* ── A6, liveness — without it, "no writes" is free ──────────────────── */
  const liveReads = R.filter((record) => isSuccess(record) && record.blocked !== true)
  results.push(
    RESULT(
      'A6',
      'LIVENESS: the proxy answered at least one request successfully',
      liveReads.length > 0,
      `${liveReads.length} successful forwarded requests` +
        (liveReads.length === 0 ? ' — a proxy that refuses everything proves nothing' : ''),
    ),
  )

  /* ── A7, freshness — what stops an old log being offered ─────────────── */
  const runStart = Date.parse(runStartedAt)
  const stale = R.filter((record) => timeOf(record) < runStart)
  results.push(
    RESULT(
      'A7',
      'FRESHNESS: every record was written during this run',
      Number.isFinite(runStart) && stale.length === 0,
      !Number.isFinite(runStart)
        ? 'run start timestamp is missing or unparseable'
        : stale.length === 0
          ? `all ${R.length} records at or after ${runStartedAt}`
          : `${stale.length} records predate the run — this is not this run's log (oldest ${stale[0]?.at})`,
    ),
  )

  /* ── A8, credential hygiene ──────────────────────────────────────────── */
  results.push(
    RESULT(
      'A8',
      'no credential or frame payload was ever written to the log',
      !/Bearer/.test(raw) && !/"params"/.test(raw),
      /Bearer/.test(raw) ? 'the log contains "Bearer"' : 'no "Bearer", no "params"',
    ),
  )

  /* ── A9, the realtime leg ────────────────────────────────────────────── */
  const unreasonedFrames = F.filter(
    (record) => typeof record.reason !== 'string' || record.reason.length === 0,
  )
  const forwardedMutations = F.filter((record) => record.rpc === 'mutate' && record.blocked !== true)
  results.push(
    RESULT(
      'A9',
      'every WebSocket frame was classified, and no "mutate" frame was forwarded',
      unreasonedFrames.length === 0 && forwardedMutations.length === 0,
      forwardedMutations.length > 0
        ? `A "mutate" RPC frame was FORWARDED (${forwardedMutations.length})`
        : unreasonedFrames.length > 0
          ? `${unreasonedFrames.length} frames carry no classification reason`
          : `${F.length} frame records, all classified`,
    ),
  )

  return results
}

/* ══════════════════════════════════════════════════ B — the overlay plane ══ */

const OVERLAY_ROUTES = new Set([
  '/health',
  '/events',
  '/state',
  '/resolve',
  '/query',
  '/query/plan',
  '/commit',
  '/reset',
])

export function auditOverlayLog({log, runStartedAt, expectCommits = true}) {
  const results = []
  const {exists, raw, lines, records, parseError} = log

  results.push(
    RESULT(
      'B0',
      'the overlay-plane log exists, is non-empty, and every line parses as JSON',
      exists && records !== null && records.length > 0,
      parseError ?? `${lines.length} lines`,
    ),
  )
  if (records === null || records.length === 0) return results

  const overlay = records.filter((record) => record.plane === 'overlay')

  results.push(
    RESULT(
      'B1',
      'every overlay request hit a route the overlay server implements',
      overlay.every((record) => OVERLAY_ROUTES.has(record.path)),
      overlay
        .filter((record) => !OVERLAY_ROUTES.has(record.path))
        .map((record) => `${record.method} ${record.path}`)
        .slice(0, 5)
        .join(', ') || `${overlay.length} requests over ${OVERLAY_ROUTES.size} known routes`,
    ),
  )

  /* ── B2 is the anti-vacuity predicate for the whole audit ────────────── */
  const commits = overlay.filter((record) => record.path === '/commit' && isSuccess(record))
  results.push(
    RESULT(
      'B2',
      'LIVENESS: at least one write was committed to the overlay',
      expectCommits ? commits.length > 0 : true,
      commits.length > 0
        ? `${commits.length} successful commits` +
          ` (kinds: ${[...new Set(commits.map((record) => record.kind ?? '?'))].join(', ')})`
        : 'NO COMMITS — a clean proxy log from a run that wrote nothing proves nothing',
    ),
  )

  const runStart = Date.parse(runStartedAt)
  const stale = overlay.filter((record) => timeOf(record) < runStart)
  results.push(
    RESULT(
      'B3',
      'FRESHNESS: every overlay record was written during this run',
      Number.isFinite(runStart) && stale.length === 0,
      stale.length === 0 ? `all ${overlay.length} records at or after ${runStartedAt}` : `${stale.length} stale records`,
    ),
  )

  results.push(
    RESULT(
      'B4',
      'the overlay log carries no credential and no document content',
      !/Bearer/.test(raw) && !/"authorization"/i.test(raw) && !/"payload"/.test(raw),
      'method, path, status, byte counts and routing ids only',
    ),
  )

  return results
}

/* ═══════════════════════════════════════════════ C — the pinned evidence ══ */

/**
 * `proxy-log.jsonl` is committed evidence of a 2026-08-04 session and
 * `test/proxy-log-replay.test.ts` pins it. It has been contaminated twice by
 * someone forgetting to set `PROXY_LOG`. This predicate makes that mistake
 * impossible to ship rather than merely discouraged.
 */
export function auditPinnedEvidence({pinnedPath, expectedLines, repoRoot}) {
  const results = []
  let dirty = null
  try {
    dirty = execFileSync('git', ['status', '--porcelain', '--', pinnedPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  } catch (error) {
    dirty = `git failed: ${String(error?.message ?? error)}`
  }

  const {lines, exists} = readLog(pinnedPath)

  results.push(
    RESULT(
      'C0',
      'the committed proxy-log.jsonl is untouched by this run',
      dirty === '',
      dirty === '' ? 'clean in git' : `MODIFIED: ${dirty}`,
    ),
  )
  results.push(
    RESULT(
      'C1',
      `the committed proxy-log.jsonl still has exactly ${expectedLines} lines`,
      exists && lines.length === expectedLines,
      `${lines.length} lines`,
    ),
  )
  return results
}

/* ══════════════════════════════════════════════════════════════ runner ══ */

/**
 * Run the whole audit.
 *
 * @param {{proxyLogPath: string, overlayLogPath: string, runStartedAt: string,
 *          pinnedPath: string, expectedPinnedLines: number, repoRoot: string,
 *          expectCommits?: boolean}} options
 */
export function auditAll(options) {
  return [
    ...auditProxyLog({log: readLog(options.proxyLogPath), runStartedAt: options.runStartedAt}),
    ...auditOverlayLog({
      log: readLog(options.overlayLogPath),
      runStartedAt: options.runStartedAt,
      expectCommits: options.expectCommits ?? true,
    }),
    ...auditPinnedEvidence({
      pinnedPath: options.pinnedPath,
      expectedLines: options.expectedPinnedLines,
      repoRoot: options.repoRoot,
    }),
  ]
}

/** Human-readable report. Returns `{ok, text}`. */
export function formatResults(results) {
  const ok = results.every((result) => result.pass)
  const text = results
    .map((result) => `${result.pass ? 'PASS' : 'FAIL'}  ${result.id.padEnd(4)} ${result.title}${result.note ? `\n            ${result.note}` : ''}`)
    .join('\n')
  return {ok, text: `${text}\n\n${ok ? 'NETWORK AUDIT PASSES' : 'NETWORK AUDIT FAILED'}`}
}
