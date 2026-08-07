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
 *   | request | `frame` absent   | a real verb  | at, method, path, status, ms, blocked, upgrade? |
 *   | frame   | `frame: true`    | always "WS"  | + opcode, rpc, rpcId, wouldBlock, reason |
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
