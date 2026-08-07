/**
 * The run directory, created exactly once per `playwright test` invocation.
 *
 * WHY THIS IS NOT A `globalSetup`
 * ──────────────────────────────
 * Playwright's ordering of `globalSetup` relative to `webServer` has changed
 * between versions, and the suite cannot depend on which one wins: if the
 * servers start first, a `globalSetup` that wipes the run directory deletes the
 * proxy's log file out from under a running proxy, and the network audit then
 * reads a truncated log without any predicate noticing.
 *
 * The config module, by contrast, is imported before anything at all is started
 * — it is what *describes* the servers — so doing the work at its import time is
 * ordering-independent. Worker processes import the same config, so the guard is
 * an environment variable: the parent sets it, workers inherit it, and only the
 * first caller ever deletes anything.
 */
import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import process from 'node:process'

import {OVERLAY_ROOT, RUN_DIR, RUN_MANIFEST} from './paths.mjs'

const GUARD = 'OVERLAY_E2E_RUN_STARTED_AT'

/**
 * Wipe and recreate the run directory, and stamp it with the timestamp the
 * freshness predicates compare against. Idempotent per process tree.
 *
 * @returns {string} the ISO timestamp this run started at
 */
export function ensureRunDir() {
  const existing = process.env[GUARD]
  if (existing !== undefined && existing.trim() !== '') return existing

  /* One second of slack. Server clocks and `Date.now()` agree here (same host),
   * but a log line stamped in the same millisecond the directory was created
   * must not read as "before the run". */
  const runStartedAt = new Date(Date.now() - 1000).toISOString()

  rmSync(RUN_DIR, {recursive: true, force: true})
  mkdirSync(OVERLAY_ROOT, {recursive: true})
  writeFileSync(
    RUN_MANIFEST,
    `${JSON.stringify({runStartedAt, overlayRoot: OVERLAY_ROOT, pid: process.pid}, null, 2)}\n`,
  )

  process.env[GUARD] = runStartedAt
  return runStartedAt
}

/** The timestamp for this run, without creating anything. */
export function runStartedAt() {
  return process.env[GUARD] ?? ensureRunDir()
}
