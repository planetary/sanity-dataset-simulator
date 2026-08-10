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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND ALL THREE ASK IT OF A RECORDED FACT, NOT OF AN ABSENCE
 *
 * A3/A4 used to decide "was this forwarded?" with `record.blocked !== true`.
 * `blocked: true` means one thing only — the write guard refused it — so a
 * request refused by any OTHER gate recorded `blocked: false` and was read as
 * forwarded. The audit's last run reported six escaped writes that never left
 * the process (Mode 2's CSRF check answered them 415, and Mode 2 has no upstream
 * to dial). The mirror image is what makes it unusable rather than merely noisy:
 * a genuine escape answering anything but 403 was modelled the same way, in the
 * direction of a PASSING predicate.
 *
 * So the proxy now records `disposition` — `local` or `upstream`, decided where
 * the decision is made — and these predicates read it via
 * {@link dispositionOf}, which infers nothing. A record that does not say is
 * `unknown`, and unknown FAILS: default-deny, exactly as `readAllowlist.mjs`
 * already treats an endpoint it has not heard of. The failure note separates
 * RELAYED (the log says it left) from UNPROVEN (the log cannot say), because
 * those are different findings and only one of them is an escape.
 */
import {execFileSync} from 'node:child_process'

import {classify as classifyIndependently} from './readAllowlist.mjs'
import {
  HTTP_METHODS,
  describe,
  describeRelay,
  describeUnproven,
  dispositionOf,
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

/** `formatResults` indents a note by 12 columns; a second line must match. */
const NOTE_BREAK = '\n            '

/**
 * Score a population of write-capable records on WHERE THEIR BYTES WENT.
 *
 * Two failure categories, never merged:
 *
 *   RELAYED   the log says the proxy dialled an upstream and relayed this. That
 *             is an escape, and the destination is part of the finding —
 *             "forwarded" with no host:port cannot distinguish a test double
 *             from api.sanity.io.
 *   UNPROVEN  the log says nothing. Not an escape, and not a clean bill of
 *             health either: the run produced no evidence in either direction,
 *             so it fails, the same way an unknown endpoint fails the read
 *             allowlist.
 *
 * Reporting the second as the first is what made this audit cry wolf over six
 * requests that never left the process. Reporting the second as a PASS is what
 * would make it worthless.
 */
function egressVerdict(id, title, suspects, cleanNote) {
  const relayed = suspects.filter((record) => dispositionOf(record) === 'upstream')
  const unproven = suspects.filter((record) => dispositionOf(record) === 'unknown')

  const parts = []
  if (relayed.length > 0) {
    parts.push(`RELAYED (${relayed.length}): ${relayed.slice(0, 5).map(describeRelay).join(' | ')}`)
  }
  if (unproven.length > 0) {
    parts.push(
      `UNPROVEN (${unproven.length}): ${unproven.slice(0, 5).map(describeUnproven).join(' | ')}`,
    )
  }
  return RESULT(
    id,
    title,
    parts.length === 0,
    parts.length === 0 ? cleanNote : parts.join(NOTE_BREAK),
  )
}

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

/**
 * @param {{log: object, runStartedAt: string, expectNoUpstream?: boolean}} options
 *   `expectNoUpstream` declares that this run had NO upstream at all — Mode 2 /
 *   `E2E_MODE=local`, where the branch is served from disk. It turns on A12, the
 *   structural control; see there for why it is opt-in rather than inferred.
 */
export function auditProxyLog({log, runStartedAt, expectNoUpstream = false}) {
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

  /* ── A3, the classifier-free net ─────────────────────────────────────── *
   *
   * `blocked` is deliberately NOT consulted. The question is where the bytes
   * went, and only `disposition` answers it; a guard refusal is simply one of
   * the ways a record comes to be `local`. */
  const verbWrites = R.filter((record) => !isVerbSafe(record))
  results.push(
    egressVerdict(
      'A3',
      'every request with a mutating verb was answered locally (classifier-free)',
      verbWrites,
      `${R.length} request records; ${verbWrites.length} carried a mutating verb and every ` +
        'one of those was answered locally, with no upstream socket',
    ),
  )

  /* ── A4, the independent allowlist ───────────────────────────────────── */
  const allowlistWrites = R.filter((record) => !classifyIndependently(record).read)
  results.push(
    egressVerdict(
      'A4',
      'every request the independent read allowlist calls a write was answered locally',
      allowlistWrites,
      `${allowlistWrites.length} of ${R.length} request records classify as writes, and every ` +
        'one was answered locally',
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

  /* ── A10, completeness — the predicate that makes A3/A4 mean something ── *
   *
   * A3 and A4 fail an UNPROVEN record, so a log with no dispositions at all
   * already fails them — but only where a write-capable request happens to
   * appear. A10 asks the question of every record, so "the audit could not see"
   * is reported as its own finding rather than inferred from the shape of the
   * traffic that happened to occur. */
  const undecided = R.filter((record) => dispositionOf(record) === 'unknown')
  results.push(
    RESULT(
      'A10',
      'COMPLETENESS: every request record says what happened to its bytes',
      undecided.length === 0,
      undecided.length === 0
        ? `all ${R.length} request records carry a disposition`
        : `${undecided.length} of ${R.length} request records carry no usable disposition — ` +
          `a record that cannot answer is not evidence: ` +
          undecided.slice(0, 3).map(describeUnproven).join(' | '),
    ),
  )

  /* ── A11, writer consistency ─────────────────────────────────────────── *
   *
   * `blocked` keeps its narrow meaning — the WRITE GUARD refused this — so it is
   * now redundant with, and must never contradict, the disposition. A record
   * claiming `blocked: true` while its bytes went upstream, or while some other
   * gate answered it, means the two writers have drifted, and the audit reads
   * only one of them. Evaluated over records that HAVE a disposition: a record
   * without one is A10's finding, not this one's. */
  const decided = R.filter((record) => dispositionOf(record) !== 'unknown')
  const guardRefusals = decided.filter((record) => record.blocked === true)
  const inconsistent = guardRefusals.filter(
    (record) => !(dispositionOf(record) === 'local' && record.gate === 'write-guard'),
  )
  results.push(
    RESULT(
      'A11',
      'a record marked `blocked` was refused locally, by the write guard, and by nothing else',
      inconsistent.length === 0,
      inconsistent.length === 0
        ? `${guardRefusals.length} guard refusals, every one recorded local/write-guard`
        : `INCONSISTENT (${inconsistent.length}): ` +
          inconsistent
            .slice(0, 5)
            .map(
              (record) =>
                `${describe(record)} disposition=${dispositionOf(record)} ` +
                `gate=${record.gate ?? '(none)'}`,
            )
            .join(' | '),
    ),
  )

  /* ── A12, structural egress control ──────────────────────────────────── *
   *
   * A3/A4 ask whether a WRITE left. This asks whether ANYTHING did. When the
   * proxy ran with no upstream configured at all — Mode 2, `E2E_MODE=local` —
   * the claim available is much stronger than "no writes escaped": no byte of
   * this run's traffic reached the network, and one `upstream` record anywhere,
   * even on a GET or a WebSocket frame, falsifies it.
   *
   * OPT-IN, AND SAID OUT LOUD WHEN IT IS OFF. It is a property of how the run
   * was launched, which no log can establish about itself: a Mode 1 run that
   * simply made no upstream request produces a log indistinguishable from a
   * Mode 2 one. Emitting this as a PASS whenever nobody claimed it would be the
   * exact vacuous certification this file exists to refuse.
   *
   * But OMITTING it is the same bug wearing the other hat, and it is the bug
   * this whole file was just rewritten to remove: a reader who scans the report
   * and sees no A12 line reads the absence as "nothing to say here", which is
   * indistinguishable from "this run never claimed it". So the line is always
   * printed, and when it is not asserted it is printed as NOT ASSERTED with the
   * reason — `pass: null`, which `formatResults` renders distinctly from PASS
   * and does not count towards `ok`. An absence must never be readable as
   * safety, including the absence of a predicate. */
  const egress = records.filter((record) => dispositionOf(record) === 'upstream')
  const silent = records.filter((record) => dispositionOf(record) === 'unknown')
  results.push(
    expectNoUpstream === true
      ? RESULT(
          'A12',
          'STRUCTURAL: this run had no upstream, and not one record says otherwise',
          egress.length === 0,
          egress.length === 0
            ? `${records.length} records, none upstream ` +
              `(${silent.length} carry no disposition — A10 owns those)`
            : `EGRESS FROM A RUN THAT HAD NO UPSTREAM (${egress.length}): ` +
              egress.slice(0, 5).map(describeRelay).join(' | '),
        )
      : RESULT(
          'A12',
          'STRUCTURAL: no byte of this run reached the network',
          null,
          'NOT ASSERTED — the caller did not declare `expectNoUpstream`, and no log can ' +
            'establish that a proxy HAD no upstream: a Mode 1 run that happened to relay ' +
            `nothing looks identical. ${egress.length} records are recorded as upstream.`,
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
 *          expectCommits?: boolean, expectNoUpstream?: boolean}} options
 */
export function auditAll(options) {
  return [
    ...auditProxyLog({
      log: readLog(options.proxyLogPath),
      runStartedAt: options.runStartedAt,
      expectNoUpstream: options.expectNoUpstream ?? false,
    }),
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

/**
 * Human-readable report. Returns `{ok, text}`.
 *
 * THREE VERDICTS, NOT TWO. `pass: null` means the predicate was NOT EVALUATED,
 * and it prints as `n/a ` rather than being dropped: a reader who sees no line
 * for a predicate cannot tell "nothing to report" from "nobody asked", and that
 * is the identical absence-read-as-safety bug the disposition schema exists to
 * remove. A non-evaluated predicate is not a failure — `ok` ignores it — but it
 * is never invisible.
 */
export function formatResults(results) {
  const ok = results.every((result) => result.pass !== false)
  const label = (result) => (result.pass === null ? 'n/a ' : result.pass ? 'PASS' : 'FAIL')
  const text = results
    .map((result) => `${label(result)}  ${result.id.padEnd(4)} ${result.title}${result.note ? `\n            ${result.note}` : ''}`)
    .join('\n')
  return {ok, text: `${text}\n\n${ok ? 'NETWORK AUDIT PASSES' : 'NETWORK AUDIT FAILED'}`}
}
