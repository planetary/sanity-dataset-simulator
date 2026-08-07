/**
 * The network audit as a command.
 *
 *     node e2e/audit/runAudit.mjs
 *     node e2e/audit/runAudit.mjs --proxy-log=<path> --overlay-log=<path> --since=<iso>
 *
 * Exit code 0 is the whole gate. Every FAIL line names the predicate.
 *
 * `network-audit.spec.ts` calls the same functions in-process so the suite and
 * the command can never drift — there is one implementation of the policy, in
 * `predicates.mjs`, and two ways to invoke it.
 */
import {existsSync, readFileSync} from 'node:fs'
import process from 'node:process'

import {auditAll, formatResults} from './predicates.mjs'
import {
  OVERLAY_LOG,
  PINNED_PROXY_LOG,
  PINNED_PROXY_LOG_LINES,
  PROXY_LOG,
  REPO_ROOT,
  RUN_MANIFEST,
} from '../harness/paths.mjs'

function flag(name, fallback) {
  const hit = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

function runStartedAt() {
  const explicit = flag('since', undefined)
  if (explicit !== undefined) return explicit
  if (existsSync(RUN_MANIFEST)) {
    try {
      return JSON.parse(readFileSync(RUN_MANIFEST, 'utf8')).runStartedAt
    } catch {
      /* fall through to the loud failure below */
    }
  }
  return undefined
}

const since = runStartedAt()
if (since === undefined) {
  process.stderr.write(
    'No run timestamp. Either run the suite (global setup writes e2e/.artifacts/run/run.json)\n' +
      'or pass --since=<ISO timestamp>. Without it the freshness predicates cannot be evaluated,\n' +
      'and a predicate that cannot be evaluated counts as FAIL.\n',
  )
  process.exit(2)
}

const results = auditAll({
  proxyLogPath: flag('proxy-log', PROXY_LOG),
  overlayLogPath: flag('overlay-log', OVERLAY_LOG),
  runStartedAt: since,
  pinnedPath: PINNED_PROXY_LOG,
  expectedPinnedLines: PINNED_PROXY_LOG_LINES,
  repoRoot: REPO_ROOT,
  expectCommits: flag('expect-commits', '1') !== '0',
})

const {ok, text} = formatResults(results)
process.stdout.write(`${text}\n`)
process.exit(ok ? 0 : 1)
