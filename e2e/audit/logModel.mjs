/**
 * The record model both audited logs share, and the one thing a naive grep gets
 * wrong about the proxy log.
 *
 * Since the frame guard landed, `proxy-log*.jsonl` carries TWO KINDS OF RECORD
 * in one stream, and every predicate is defined over one kind or the other
 * (`examples/kitchen-sink/spikeB-proxy/README.md`, "Step 3"):
 *
 *   | kind    | discriminator    | method       | extra fields                       |
 *   |---------|------------------|--------------|------------------------------------|
 *   | request | `frame` absent   | a real verb  | at, method, path, status, ms, blocked, disposition, gate?/upstream?, refusal?, upgrade? |
 *   | frame   | `frame: true`    | always "WS"  | + opcode, rpc, rpcId, wouldBlock, reason |
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `disposition` — WHAT HAPPENED TO THE BYTES
 *
 * The one question the audit exists to answer is *did this leave the machine?*,
 * and until this field landed nothing in the log said. Every record was
 * `{at, method, path, status, ms, blocked}`, and `blocked: true` means exactly
 * one thing: THE WRITE GUARD REFUSED IT. A request refused by any other gate — a
 * CORS preflight answered locally, Mode 2's CSRF content-type check, an origin
 * handler that threw — recorded `blocked: false`, and A3/A4 read that absence as
 * "forwarded to Sanity". The last E2E run reported six escaped writes that never
 * left the process. The symmetric case is the dangerous one: a REAL escape
 * answering anything but 403 was modelled identically, in the direction of a
 * passing predicate.
 *
 *   `local`     the proxy produced the whole response itself and NO upstream
 *               socket was created. `gate` names the stage that answered
 *               (`preflight`, `write-guard`, `origin`, `origin-error`, …) and
 *               `refusal` carries the refusing gate's own code when it has one.
 *   `upstream`  the proxy dialled the upstream and relayed. `upstream` carries
 *               the real `host:port`, because "forwarded" with no destination
 *               cannot tell a test double from api.sanity.io. A dial that was
 *               ATTEMPTED and failed is still `upstream`, flagged `dialFailed`:
 *               an attempted egress must never be recorded as local.
 *
 * The field is set where the proxy DECIDES, never reconstructed afterwards, and
 * {@link dispositionOf} reads it and nothing else.
 *
 * Consequences that have already bitten someone:
 *   - `"status":101` matches an accepted upgrade AND every non-refused frame on
 *     it, so counting it does not count sockets;
 *   - `"blocked":true` matches a refused frame (`status: 1008`) as well as a
 *     refused request (`status: 403`), so `blocked` must always be paired with
 *     `status`;
 *   - `"method":"WS"` is a pseudo-method. Feeding a frame record to anything
 *     that classifies request lines reports the Studio's own listener socket as
 *     an escaped write.
 *
 * `path` is the pathname only — the proxy strips the query string before
 * logging, so no GROQ text or parameter ever reaches these files.
 */
import {existsSync, readFileSync} from 'node:fs'

export const HTTP_METHODS = Object.freeze(
  new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']),
)

/**
 * Read a JSONL log.
 *
 * A missing or unparseable file is reported, never thrown and never silently
 * treated as empty: zero records satisfy almost every predicate vacuously, and a
 * vacuous pass is the single failure mode this whole module exists to prevent.
 *
 * @returns {{path: string, exists: boolean, raw: string, lines: string[],
 *            records: object[]|null, parseError: string|null}}
 */
export function readLog(path) {
  if (!existsSync(path)) {
    return {path, exists: false, raw: '', lines: [], records: null, parseError: 'file does not exist'}
  }
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  const records = []
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      return {
        path,
        exists: true,
        raw,
        lines,
        records: null,
        parseError: `line ${index + 1} is not JSON: ${String(error?.message ?? error)}`,
      }
    }
  }
  return {path, exists: true, raw, lines, records, parseError: null}
}

/** Request records: everything that is not a WebSocket frame. */
export function requestRecords(records) {
  return records.filter((record) => record.frame !== true)
}

/** Frame records: the client→upstream leg of an accepted WebSocket upgrade. */
export function frameRecords(records) {
  return records.filter((record) => record.frame === true)
}

/** `2xx` — the proxy forwarded this and Content Lake answered it. */
export function isSuccess(record) {
  return typeof record.status === 'number' && record.status >= 200 && record.status < 300
}

/** Millisecond epoch of a record's `at`, or `NaN` when it has none. */
export function timeOf(record) {
  return Date.parse(record?.at ?? '')
}

/** A short, quotable description for a failure message. */
export function describe(record) {
  const blocked = record.blocked === true ? 'blocked' : 'forwarded'
  return `${record.method} ${record.path} → ${record.status} (${blocked}) at ${record.at}`
}

/**
 * What the log SAYS happened to this record's bytes.
 *
 * READS THE RECORDED FIELD AND NOTHING ELSE. There is deliberately no fallback:
 * a record with no `disposition`, or with anything other than the two words the
 * proxy writes, is `'unknown'` — which the predicates treat as a failure, the
 * same default-deny `readAllowlist.mjs` applies to an endpoint it has not heard
 * of.
 *
 * Inferring from `blocked` is the specific bug this replaced, and the pinned
 * 730-line log is the specific reason there is no "repair" path: it predates the
 * field, so every one of its records is honestly unknown. Guessing values for a
 * session nobody can re-run would be fabricating evidence.
 *
 * @returns {'local'|'upstream'|'unknown'}
 */
export function dispositionOf(record) {
  const value = record?.disposition
  if (value === 'local' || value === 'upstream') return value
  return 'unknown'
}

/** `POST /path → 200 → api.sanity.io:443` — a record the log says was relayed. */
export function describeRelay(record) {
  const where =
    typeof record?.upstream === 'string' && record.upstream !== ''
      ? record.upstream
      : '(destination not recorded)'
  return `${record.method} ${record.path} → ${record.status} → ${where}`
}

/** `POST /path → 403 (no disposition recorded)` — a record that cannot answer. */
export function describeUnproven(record) {
  return `${record.method} ${record.path} → ${record.status} (no disposition recorded)`
}
