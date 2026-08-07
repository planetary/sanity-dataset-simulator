/**
 * NEGATIVE CONTROLS FOR THE NETWORK AUDIT.
 *
 *     node --test e2e/audit/
 *
 * Runs today. Needs no Playwright, no browser, no running stack.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN `e2e/`
 *
 * "The audit passed" is worth nothing unless the audit could have failed. Every
 * predicate below is fed an input that must make it go red, and the assertion is
 * on the red. A predicate with no failing input is a predicate that certifies
 * whatever it is given — which is what a browser-side "no requests to Sanity"
 * check was, three times.
 *
 * The strongest control is `§ the committed log`: `proxy-log.jsonl` is a real,
 * clean, 730-line session log from 2026-08-04 that this project trusts. It must
 * FAIL this audit — on freshness, because it is not this run — and it must PASS
 * the escape predicates, because no write escaped in it either. A checklist that
 * accepted it would accept any old log offered in place of a run that never
 * happened.
 */
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {auditOverlayLog, auditProxyLog} from './predicates.mjs'
import {readLog} from './logModel.mjs'
import {canonicalise, classify} from './readAllowlist.mjs'
import {PINNED_PROXY_LOG} from '../harness/paths.mjs'

const RUN_START = '2026-08-06T12:00:00.000Z'
const DURING = '2026-08-06T12:00:30.000Z'
const BEFORE = '2026-08-04T04:52:10.362Z'

const scratch = mkdtempSync(join(tmpdir(), 'overlay-e2e-audit-'))
let counter = 0

/** Write records to a scratch JSONL file and read it back as the audit would. */
function logOf(records) {
  const path = join(scratch, `log-${(counter += 1)}.jsonl`)
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))
  return readLog(path)
}

const verdict = (results, id) => results.find((result) => result.id === id)
const passed = (results, id) => verdict(results, id)?.pass === true
const failed = (results, id) => verdict(results, id)?.pass === false

/** A minimal log that passes everything, so each control changes exactly one thing. */
function healthyProxyRecords() {
  return [
    {at: DURING, method: 'GET', path: '/v2025-02-19/ping', status: 200, ms: 3, blocked: false},
    {at: DURING, method: 'GET', path: '/v2025-02-19/users/me', status: 200, ms: 9, blocked: false},
    {at: DURING, method: 'GET', path: '/v2025-02-19/data/query/parity', status: 200, ms: 40, blocked: false},
    {at: DURING, method: 'POST', path: '/v2025-02-19/data/query/parity', status: 200, ms: 55, blocked: false},
    {at: DURING, method: 'POST', path: '/v2025-02-19/data/mutate/parity', status: 403, ms: 0, blocked: true},
    {at: DURING, method: 'OPTIONS', path: '/v2025-02-19/data/actions/parity', status: 204, ms: 0, blocked: false},
  ]
}

function healthyOverlayRecords() {
  return [
    {at: DURING, plane: 'overlay', method: 'GET', path: '/health', status: 200, ms: 1},
    {at: DURING, plane: 'overlay', method: 'GET', path: '/state', status: 200, ms: 4},
    {at: DURING, plane: 'overlay', method: 'POST', path: '/commit', status: 200, ms: 22, kind: 'mutation', idempotencyKey: 'k-1'},
  ]
}

const auditProxy = (records) => auditProxyLog({log: logOf(records), runStartedAt: RUN_START})
const auditOverlay = (records, expectCommits = true) =>
  auditOverlayLog({log: logOf(records), runStartedAt: RUN_START, expectCommits})

/* ══════════════════════════════════════════════ the baseline must be green ══ */

describe('the healthy fixture passes every predicate', () => {
  it('proxy plane', () => {
    const results = auditProxy(healthyProxyRecords())
    const failures = results.filter((result) => !result.pass)
    assert.deepEqual(
      failures.map((result) => `${result.id}: ${result.note}`),
      [],
      'the baseline fixture must pass, or every control below proves nothing',
    )
  })

  it('overlay plane', () => {
    const failures = auditOverlay(healthyOverlayRecords()).filter((result) => !result.pass)
    assert.deepEqual(failures.map((result) => `${result.id}: ${result.note}`), [])
  })
})

/* ═════════════════════════════════════════════════════════ escape controls ══ */

describe('§ an escaped write is caught', () => {
  it('A3/A4 go red when a mutation was FORWARDED rather than blocked', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'POST', path: '/v2025-02-19/data/mutate/parity', status: 200, ms: 88, blocked: false},
    ])
    assert.ok(failed(results, 'A3'), 'the classifier-free verb net must catch it')
    assert.ok(failed(results, 'A4'), 'the independent allowlist must catch it')
    assert.match(verdict(results, 'A3').note, /ESCAPED/)
  })

  it('A3/A4 go red on an endpoint neither classifier has ever seen', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'PUT', path: '/v2025-02-19/users/me/keyvalue/studio-prefs', status: 200, ms: 12, blocked: false},
    ])
    assert.ok(failed(results, 'A3'))
    assert.ok(failed(results, 'A4'), 'default-deny is what makes an unknown endpoint a write')
  })

  it('A4 goes red on the four Spike F laundering spellings', () => {
    for (const path of [
      '/v2025-02-19//data//mutate//parity',
      '/v2025-02-19/DATA/MUTATE/parity',
      '/v2025-02-19/data/..%2Fmutate/parity',
      '/v2025-02-19/projects/b1n03q3z/datasets/parity/mutate',
    ]) {
      const results = auditProxy([
        ...healthyProxyRecords(),
        {at: DURING, method: 'POST', path, status: 200, ms: 5, blocked: false},
      ])
      assert.ok(failed(results, 'A4'), `${path} must classify as an escaped write`)
    }
  })

  it('A4 does NOT fire on the long-GROQ POST read, which is genuinely a read', () => {
    const results = auditProxy(healthyProxyRecords())
    assert.ok(passed(results, 'A4'))
    assert.ok(passed(results, 'A3'))
  })

  it('A9 goes red when a "mutate" RPC frame was forwarded on the WebSocket leg', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'WS', path: '/v2022-06-30/socket/parity', status: 101, upgrade: true, frame: true, opcode: 1, rpc: 'mutate', rpcId: 'evil-1', blocked: false, reason: 'forwarded'},
    ])
    assert.ok(failed(results, 'A9'))
    assert.match(verdict(results, 'A9').note, /FORWARDED/)
  })

  it('A9 goes red when a frame was forwarded with no classification at all', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'WS', path: '/v2022-06-30/socket/parity', status: 101, upgrade: true, frame: true, opcode: 1, rpc: 'query', blocked: false},
    ])
    assert.ok(failed(results, 'A9'))
  })
})

/* ══════════════════════════════════════════════════════ vacuity controls ══ */

describe('§ a run that proves nothing does not pass', () => {
  it('A0 goes red on a missing log, and no later predicate passes vacuously', () => {
    const results = auditProxyLog({
      log: readLog(join(scratch, 'does-not-exist.jsonl')),
      runStartedAt: RUN_START,
    })
    assert.ok(failed(results, 'A0'))
    assert.equal(results.length, 1, 'evaluation must stop — zero records satisfy A3/A4/A8 vacuously')
  })

  it('A0 goes red on an empty log', () => {
    assert.ok(failed(auditProxy([]), 'A0'))
  })

  it('A0 goes red on a log with a corrupt line', () => {
    const path = join(scratch, 'corrupt.jsonl')
    writeFileSync(path, `${JSON.stringify(healthyProxyRecords()[0])}\nnot json at all\n`)
    const results = auditProxyLog({log: readLog(path), runStartedAt: RUN_START})
    assert.ok(failed(results, 'A0'))
    assert.match(verdict(results, 'A0').note, /line 2 is not JSON/)
  })

  it('A6 goes red when the proxy blocked everything — including the reads', () => {
    const results = auditProxy([
      {at: DURING, method: 'POST', path: '/v2025-02-19/data/mutate/parity', status: 403, ms: 0, blocked: true},
      {at: DURING, method: 'GET', path: '/v2025-02-19/ping', status: 403, ms: 0, blocked: true},
    ])
    assert.ok(failed(results, 'A6'), 'seven 403s from a proxy that 403s everything prove nothing')
    assert.ok(passed(results, 'A4'), 'and the escape predicates still pass — which is the trap')
  })

  it('B2 goes red when the browser wrote nothing at all', () => {
    const results = auditOverlay(healthyOverlayRecords().filter((record) => record.path !== '/commit'))
    assert.ok(failed(results, 'B2'))
    assert.match(verdict(results, 'B2').note, /NO COMMITS/)
  })

  it('B2 goes red when a commit was attempted and failed', () => {
    const results = auditOverlay([
      ...healthyOverlayRecords().filter((record) => record.path !== '/commit'),
      {at: DURING, plane: 'overlay', method: 'POST', path: '/commit', status: 500, ms: 12},
    ])
    assert.ok(failed(results, 'B2'), 'a 500 is not a write')
  })
})

/* ═══════════════════════════════════════════════════ freshness controls ══ */

describe('§ yesterday’s log cannot be offered in place of this run', () => {
  it('A7 goes red when any record predates the run', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: BEFORE, method: 'GET', path: '/v2025-02-19/ping', status: 200, ms: 2, blocked: false},
    ])
    assert.ok(failed(results, 'A7'))
    assert.match(verdict(results, 'A7').note, /predate the run/)
  })

  it('A7 goes red when the run timestamp itself is unusable', () => {
    const results = auditProxyLog({log: logOf(healthyProxyRecords()), runStartedAt: 'not a date'})
    assert.ok(failed(results, 'A7'), 'a predicate that cannot be evaluated counts as FAIL')
  })

  it('B3 goes red on a stale overlay record', () => {
    const results = auditOverlay([
      ...healthyOverlayRecords(),
      {at: BEFORE, plane: 'overlay', method: 'GET', path: '/state', status: 200, ms: 3},
    ])
    assert.ok(failed(results, 'B3'))
  })
})

/* ═══════════════════════════════════════════════ credential-hygiene control ══ */

describe('§ a log that leaked a credential fails', () => {
  it('A8 goes red on the string "Bearer"', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'GET', path: '/v2025-02-19/ping', status: 200, ms: 1, blocked: false, note: 'Authorization: Bearer sk-live-xxx'},
    ])
    assert.ok(failed(results, 'A8'))
  })

  it('A8 goes red on a logged frame payload', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'WS', path: '/v2022-06-30/socket/parity', status: 101, upgrade: true, frame: true, opcode: 1, rpc: 'authorization', reason: 'allowed', blocked: false, params: {authorization: 'redacted'}},
    ])
    assert.ok(failed(results, 'A8'))
  })

  it('B4 goes red when the overlay log records a commit payload', () => {
    const results = auditOverlay([
      ...healthyOverlayRecords(),
      {at: DURING, plane: 'overlay', method: 'POST', path: '/commit', status: 200, ms: 5, payload: {title: 'secret'}},
    ])
    assert.ok(failed(results, 'B4'))
  })
})

/* ════════════════════════════════════════════════ record-kind confusion ══ */

describe('§ frames and request lines are different kinds of record', () => {
  it('a WebSocket frame is never fed to the request-line classifiers', () => {
    /* `WS` is on no read allowlist, so a frame handed to A3/A4 would be reported
     * as an escaped write and the Studio’s own listener socket would look like
     * an attack. This is the exact trap `proxy-log-replay.test.ts` pins. */
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'WS', path: '/v2022-06-30/socket/parity', status: 101, upgrade: true, frame: true, opcode: 1, rpc: 'query', rpcId: '3', blocked: false, reason: 'read method'},
    ])
    assert.ok(passed(results, 'A3'))
    assert.ok(passed(results, 'A4'))
    assert.ok(passed(results, 'A9'))
  })

  it('A1 goes red when a frame record is missing its upgrade marker', () => {
    const results = auditProxy([
      ...healthyProxyRecords(),
      {at: DURING, method: 'WS', path: '/v2022-06-30/socket/parity', status: 101, frame: true, opcode: 1, rpc: 'query', reason: 'read method'},
    ])
    assert.ok(failed(results, 'A1'))
  })
})

/* ═════════════════════════════════════════════════════ the committed log ══ */

describe('§ the committed log — the control that stops a substitution', () => {
  const committed = readLog(PINNED_PROXY_LOG)

  it('exists, parses, and is the 730-line session this repo pins', () => {
    assert.equal(committed.exists, true)
    assert.equal(committed.parseError, null)
    assert.equal(committed.lines.length, 730)
  })

  /**
   * The freshness control, which is what stops an old log being offered in place
   * of a run that never happened. `proxy-log.jsonl` is 2026-08-04; nothing in it
   * can be evidence of a run today, whatever else it contains.
   */
  it('FAILS on freshness — every one of its 669 request records predates any run', () => {
    const results = auditProxyLog({log: committed, runStartedAt: RUN_START})
    assert.ok(failed(results, 'A7'))
    assert.match(verdict(results, 'A7').note, /predate the run/)
  })

  /**
   * AND IT FAILS ON ESCAPE — which was not the expectation when this file was
   * written, and is a finding rather than a bug in the audit.
   *
   * The session was recorded partly in observation mode and partly before the
   * default-deny guard landed, so five write-capable requests were forwarded:
   *
   *     POST /v2025-02-19/data/actions/parity   → 400   ×1
   *     POST /v2025-02-19/descriptors/claim     → 200   ×3
   *     POST /v2023-12-18/intake/batch          → 401   ×1
   *
   * None is a dataset content write — Sanity rejected the `actions` call with
   * 400 (the README documents that probe deliberately: "proves body passthrough
   * without writing") and the telemetry ingest with 401. `descriptors/claim`
   * did succeed; it is schema-descriptor upload, and it is one of the four
   * endpoints Spike F found sailing through the pre-default-deny guard.
   *
   * This is corroboration of history the project has already recorded — Gate A's
   * "0 direct requests to Sanity" is formally withdrawn — read out of a server
   * log by a mechanical predicate rather than out of a memory.
   */
  it('FAILS on escape — it records five forwarded write-capable requests', () => {
    const results = auditProxyLog({log: committed, runStartedAt: RUN_START})
    assert.ok(failed(results, 'A3'), 'the classifier-free verb net catches them')
    assert.ok(failed(results, 'A4'), 'so does the independent allowlist')

    const forwarded = committed.records
      .filter((record) => record.frame !== true)
      .filter((record) => record.blocked !== true && !['GET', 'HEAD', 'OPTIONS'].includes(record.method))
      .map((record) => `${record.method} ${record.path} -> ${record.status}`)

    /* An exact inventory, so a future change to either classifier that silently
     * reclassified one of these would break here rather than pass quietly. */
    const counted = {}
    for (const key of forwarded) counted[key] = (counted[key] ?? 0) + 1
    assert.deepEqual(counted, {
      /* the long-GROQ read, correctly NOT counted as an escape by A3/A4 */
      'POST /v2025-02-19/data/query/parity -> 200': 1,
      'POST /v2025-02-19/data/actions/parity -> 400': 1,
      'POST /v2025-02-19/descriptors/claim -> 200': 3,
      'POST /v2023-12-18/intake/batch -> 401': 1,
    })
  })

  it('PASSES liveness and credential hygiene, so the failures above are specific', () => {
    const results = auditProxyLog({log: committed, runStartedAt: RUN_START})
    assert.ok(passed(results, 'A6'), '575 successful forwarded reads — the proxy was alive')
    assert.ok(passed(results, 'A8'), 'no credential and no frame payload was written')
    assert.ok(passed(results, 'A9'), '61 frame records, every one classified')
    assert.ok(passed(results, 'A4b'), 'all 14 blocked requests were blocked with 403')
  })

  it('the guard and the independent allowlist agree across all 730 real records', () => {
    const results = auditProxyLog({log: committed, runStartedAt: RUN_START})
    assert.ok(passed(results, 'A5'), `A5: ${verdict(results, 'A5')?.note}`)
  })
})

/* ══════════════════════════════════════════ the independent classifier ══ */

describe('§ the independent read allowlist, on its own', () => {
  it('decodes doubly-escaped dot segments before judging them', () => {
    assert.equal(canonicalise('/v1/data/%252e%252e/mutate/parity').dotSegments, true)
    assert.equal(classify({method: 'GET', path: '/v1/data/%252e%252e/mutate/parity'}).read, false)
  })

  it('strips the API version segment but not a dataset that looks like one', () => {
    assert.deepEqual(canonicalise('/v2025-02-19/data/query/parity').segments, ['data', 'query', 'parity'])
    assert.deepEqual(canonicalise('/data/query/parity').segments, ['data', 'query', 'parity'])
  })

  it('calls the reads Studio actually makes reads', () => {
    for (const [method, path] of [
      ['GET', '/v2025-02-19/ping'],
      ['GET', '/v2025-02-19/users/me'],
      ['GET', '/v2025-02-19/projects/b1n03q3z'],
      ['GET', '/v2025-02-19/data/query/parity'],
      ['POST', '/v2025-02-19/data/query/parity'],
      ['GET', '/v2025-02-19/data/listen/parity'],
      ['GET', '/v2025-02-19/data/doc/parity/article-01'],
      ['GET', '/v2025-02-19/features'],
      ['OPTIONS', '/v2025-02-19/data/mutate/parity'],
    ]) {
      assert.equal(classify({method, path}).read, true, `${method} ${path} is a read`)
    }
  })

  it('calls every write plane a write, including the ones Spike F found', () => {
    for (const [method, path] of [
      ['POST', '/v2025-02-19/data/mutate/parity'],
      ['POST', '/v2025-02-19/data/actions/parity'],
      ['POST', '/v2025-02-19/assets/images/parity'],
      ['POST', '/v2025-02-19/agent/action/patch/parity'],
      ['GET', '/v2025-02-19/agent/action/patch/parity'],
      ['DELETE', '/v2025-02-19/datasets/parity'],
      ['POST', '/v2025-02-19/projects/b1n03q3z/tokens'],
      ['PUT', '/v2025-02-19/users/me/keyvalue/x'],
      ['POST', '/v2025-02-19/schedules/b1n03q3z/parity'],
      ['POST', '/v2025-02-19/descriptors/claim'],
      ['POST', '/v2023-12-18/intake/batch'],
    ]) {
      assert.equal(classify({method, path}).read, false, `${method} ${path} is a write`)
    }
  })
})
