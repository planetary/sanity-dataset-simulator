/**
 * SCENARIO 9 — the network audit. *"Network audit shows no staging writes."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNS LAST, AND THE FILENAME IS WHY.
 *
 * With `workers: 1` Playwright runs spec files in path order, so `99-` puts this
 * after every spec that produces traffic. It audits the whole run, not its own
 * page — which is also why it opens almost no page at all. Reading a log written
 * by servers during eight other specs is the point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE ASKS THE BROWSER ANYTHING.
 *
 * *Server-side logs are the only trustworthy escape evidence.* Playwright can
 * report every request the page made — `page.on('request')`, CDP capture — and
 * on this project that class of evidence has produced a false all-clear three
 * times, most concretely when CDP capture missed four `POST
 * api.sanity.io/vX/intake/feedback` going direct. So this spec reads two files:
 *
 *     .artifacts/run/proxy-log.jsonl     written by the transport proxy
 *     .artifacts/run/overlay-log.jsonl   written by the overlay recorder
 *
 * and applies `e2e/audit/predicates.mjs`, whose negative controls
 * (`e2e/audit/predicates.test.mjs`) prove each predicate has an input that makes
 * it fail — including the committed 730-line `proxy-log.jsonl`, which fails on
 * freshness *and* on escape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE PLANE IS NOT ENOUGH, AND B2 IS WHY.
 *
 * The acceptance audit (§3.2.3) is blunt: *"In plugin mode the proxy is
 * structurally blind to the write path. The facade sends writes to the overlay
 * API at :3998; they never traverse the proxy at all."* A run in which the
 * editor silently did nothing produces a spotless proxy log. B2 — *at least one
 * write was committed to the overlay* — is what makes a clean A-side mean
 * something.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DIRECTORY IS `local/`, SO THIS RUN HAD NO UPSTREAM AT ALL.
 *
 * `E2E_MODE=local` starts the proxy in Mode 2, which serves the branch from
 * `.sanity-overlay/` and never dials anything. That licenses a much stronger
 * claim than "no write escaped": NOTHING escaped, not even a GET. A12 asserts
 * it, and it has to be told — no log can establish it about itself, since a
 * Mode 1 run that merely happened to make no upstream request writes an
 * identical file. Hence `expectNoUpstream: true`, here and nowhere else.
 */
import {test, expect} from '@playwright/test'

import {auditOverlayLog, auditPinnedEvidence, auditProxyLog, formatResults} from '../../audit/predicates.mjs'
import {readLog} from '../../audit/logModel.mjs'
import {
  OVERLAY_LOG,
  PINNED_PROXY_LOG,
  PINNED_PROXY_LOG_LINES,
  PROXY_LOG,
  REPO_ROOT,
} from '../../harness/paths.mjs'
import {runStartedAt} from '../../harness/runDir.mjs'

const RUN_STARTED_AT = runStartedAt()

/** Mode 2 has no upstream. See the header: A12 is opt-in because it must be. */
const EXPECT_NO_UPSTREAM = true

/** Report every failure at once — a one-at-a-time audit hides the second one. */
function assertAll(results: ReturnType<typeof auditProxyLog>) {
  const {ok, text} = formatResults(results)
  expect(ok, `\n${text}\n`).toBe(true)
}

test.describe('network audit — server-side logs only', () => {
  test('the pinned evidence log was not touched by this run', () => {
    /* This has gone wrong twice, both times by forgetting `PROXY_LOG`. The
     * config always points it into `.artifacts/run/`; this is the assertion
     * that says so out loud, and it is checked first because a contaminated
     * pinned log invalidates a test in another package too. */
    assertAll(
      auditPinnedEvidence({
        pinnedPath: PINNED_PROXY_LOG,
        expectedLines: PINNED_PROXY_LOG_LINES,
        repoRoot: REPO_ROOT,
      }),
    )
  })

  test('no write escaped towards Sanity — the proxy plane', () => {
    assertAll(
      auditProxyLog({
        log: readLog(PROXY_LOG),
        runStartedAt: RUN_STARTED_AT,
        expectNoUpstream: EXPECT_NO_UPSTREAM,
      }),
    )
  })

  test('the writes actually happened, and landed on the overlay — the overlay plane', () => {
    assertAll(
      auditOverlayLog({
        log: readLog(OVERLAY_LOG),
        runStartedAt: RUN_STARTED_AT,
        expectCommits: true,
      }),
    )
  })

  test('the audit was not vacuous: both logs carry real traffic from this run', () => {
    const proxy = readLog(PROXY_LOG)
    const overlay = readLog(OVERLAY_LOG)

    expect(proxy.records, `proxy log unreadable: ${proxy.parseError}`).not.toBeNull()
    expect(overlay.records, `overlay log unreadable: ${overlay.parseError}`).not.toBeNull()

    /* A Studio boot alone is dozens of requests. Single figures means the stack
     * was not really exercised and every A-predicate above passed cheaply. */
    expect(
      proxy.records!.length,
      'the proxy log is too small for a real Studio session — did the Studio reach the proxy at all?',
    ).toBeGreaterThan(20)
    expect(
      overlay.records!.filter((record) => record.path === '/commit').length,
      'no commits reached the overlay API — the suite audited a run that wrote nothing',
    ).toBeGreaterThan(0)
  })

  test('the refusals from 07-guard-403 are visible in the SERVER log, by gate', () => {
    /**
     * `07-guard-403.spec.ts` reads statuses in the browser as a convenience.
     * This is the same claim made from the artefact the project trusts.
     *
     * IT USED TO ASK THE WRONG QUESTION. It required `blocked === true &&
     * status === 403` for `/data/mutate/` and `/data/actions/`, and in Mode 2
     * those are the two OVERLAY-OWNED write routes: the transport's guard passes
     * them through on purpose, and the origin refuses them 415
     * `OVERLAY_ORIGIN_UNSUPPORTED_MEDIA_TYPE`. So the assertion demanded a
     * record the design guarantees will not exist, and it demanded it in the
     * name of "was this refused?" — which is not a question `blocked` can
     * answer. That is the same conflation the disposition schema was added to
     * remove, one layer up.
     *
     * The claim worth making, and the one the log can now support, has two
     * halves and neither implies the other:
     *
     *   1. the write guard ran, and refused something with its own 403;
     *   2. the mutation plane WAS exercised, and every request on it was
     *      answered inside this process — `disposition: 'local'` — by a gate
     *      that named itself, with an `OVERLAY_*` code.
     */
    const proxy = readLog(PROXY_LOG)
    expect(proxy.records).not.toBeNull()
    const requests = proxy.records!.filter((record) => record.frame !== true)

    const guardRefusals = requests.filter(
      (record) =>
        record.blocked === true &&
        record.status === 403 &&
        record.disposition === 'local' &&
        record.gate === 'write-guard',
    )
    expect(
      guardRefusals.length,
      'the proxy log records no write-guard refusals at all — either the guard is off, ' +
        'or the probes never reached the proxy. Both invalidate the whole audit.',
    ).toBeGreaterThan(0)

    for (const path of ['/data/mutate/', '/data/actions/']) {
      const onPlane = requests.filter(
        (record) => String(record.path).includes(path) && record.method !== 'OPTIONS',
      )
      expect(
        onPlane.length,
        `no request on ${path} at all — the mutation plane was never exercised, so the ` +
          `clean audit above says nothing about it`,
      ).toBeGreaterThan(0)

      const escaped = onPlane.filter((record) => record.disposition !== 'local')
      expect(
        escaped.map((record) => `${record.method} ${record.path} → ${record.status}`),
        `a request on ${path} was not answered inside the proxy`,
      ).toEqual([])

      const unnamed = onPlane.filter((record) => !String(record.refusal ?? '').startsWith('OVERLAY_'))
      expect(
        unnamed.map((record) => `${record.method} ${record.path} → ${record.status}`),
        `a request on ${path} was answered locally but by no named gate — the refusal code ` +
          `is the only thing that distinguishes our refusal from an upstream one`,
      ).toEqual([])
    }
  })

  test('the audit as a whole passes, and the report is attached to the run', async ({}, testInfo) => {
    const results = [
      ...auditProxyLog({
        log: readLog(PROXY_LOG),
        runStartedAt: RUN_STARTED_AT,
        expectNoUpstream: EXPECT_NO_UPSTREAM,
      }),
      ...auditOverlayLog({log: readLog(OVERLAY_LOG), runStartedAt: RUN_STARTED_AT}),
      ...auditPinnedEvidence({
        pinnedPath: PINNED_PROXY_LOG,
        expectedLines: PINNED_PROXY_LOG_LINES,
        repoRoot: REPO_ROOT,
      }),
    ]
    const {ok, text} = formatResults(results)

    /* Attached so the report survives as an artefact of the run rather than
     * only as console output that scrolls away. */
    await testInfo.attach('network-audit.txt', {body: text, contentType: 'text/plain'})
    expect(ok, `\n${text}\n`).toBe(true)
  })
})
