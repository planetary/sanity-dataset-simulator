/**
 * THE ONE EXPLICIT LOADER FOR TEST CONFIGURATION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT REPLACED A `.env` GAP-FILLER.
 *
 * The previous `loadEnv()` read the repo-root `.env` and copied a key into
 * `process.env` **only where that key was undefined**. Two consequences, both
 * backwards:
 *
 *   1. An exported shell variable BEAT the repository's own `.env`. A developer
 *      with another project's `SANITY_PROJECT_ID` in `~/.zshrc`, or a CI runner
 *      with one in its environment, silently redirected the hosted parity oracle
 *      and the live E2E oracle at a project nobody had chosen.
 *   2. Once the values were in `process.env`, nothing downstream could tell an
 *      explicit value from an ambient one. The distinction was destroyed by the
 *      loading, not by the reading.
 *
 * So this loader **returns** values and never writes them anywhere. There is no
 * point after which "where did this come from?" stops being answerable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT.
 *
 *   • The declared source is `EXPLICIT_ENV_FILE` — the repo-root `.env`, and
 *     only that. It is gitignored, so CI has no such file, by design.
 *   • Absent key ⇒ absent. There is no ambient fallback for a `MANAGED_KEYS`
 *     entry, ever. Callers turn absence into a **skip**, which is exactly what
 *     they did before with no credentials, so CI stays green with no secrets.
 *   • Ambient set, explicit unset ⇒ a **warning naming the key**. Silently
 *     ignoring beats silently using, but a developer who exported a variable and
 *     then watched the suite skip is owed the reason.
 *   • Ambient set, explicit set, values **disagree** ⇒ **refuse**. See below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING ON DISAGREEMENT: REFUSE, DO NOT RESOLVE.
 *
 * "Explicit wins" is the tempting answer and it is the wrong one here, because
 * the two values name *different datasets*. Picking either silently produces a
 * run whose failure — a GROQ result that does not match the pinned fixture, an
 * upstream `_rev` for a document that was never seeded — is reported as a parity
 * defect when it is a configuration defect. That is the most expensive class of
 * red there is: it sends someone to debug the wrong system.
 *
 * A refusal costs one shell command (`unset SANITY_PROJECT_ID`) and states the
 * problem in its own words. It also cannot fire in CI, where the declared file
 * does not exist, so nothing is ever refused for a key that is only ambient —
 * that case warns and skips.
 *
 * Equal values are not a disagreement and pass in silence.
 */
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * The declared source. `packages/sanity-overlay-testkit/src` → repo root.
 *
 * One file, named here, not searched for: a loader that walked up looking for
 * the nearest `.env` would reintroduce the ambient problem in a different shape
 * (whose `.env` did it find?).
 */
export const EXPLICIT_ENV_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.env',
)

/**
 * The keys the ambient environment may never supply.
 *
 * These are the ones that decide *which Sanity project and dataset the tests
 * talk to* and *with whose credential*. Everything else a test process reads
 * from `process.env` — `CI`, `E2E_MODE`, the CLI's own flags — is a switch about
 * this repository's behaviour, not a pointer at someone's data, and is
 * deliberately out of scope.
 *
 * All three token spellings are listed because `e2e/playwright/upstream.ts`
 * accepts all three; a key that is honoured somewhere but unmanaged here would
 * be an ambient hole.
 */
export const MANAGED_KEYS = Object.freeze([
  'SANITY_PROJECT_ID',
  'SANITY_BASE_DATASET',
  'SANITY_API_VERSION',
  'SANITY_API_READ_TOKEN',
  'SANITY_READ_TOKEN',
  'SANITY_API_READONLY_TOKEN',
  'SANITY_STUDIO_PROJECT_ID',
  'SANITY_STUDIO_DATASET',
] as const)

/** What the declared file resolved to. Frozen: it is a reading, not a scratchpad. */
export type ExplicitEnv = Readonly<Record<string, string | undefined>>

export interface LoadExplicitEnvOptions {
  /** The declared source. Defaults to {@link EXPLICIT_ENV_FILE}. */
  file?: string
  /**
   * The ambient environment to *check against* — never to read values from.
   * Defaults to `process.env`. Injectable so a test can present a contaminated
   * shell without contaminating the test runner's own process.
   */
  ambient?: Record<string, string | undefined>
  /**
   * Where the "I am ignoring this" notices go. Defaults to `console.warn`, which
   * is de-duplicated per key per process; a caller-supplied sink is not, because
   * a test wants every notice it provoked.
   */
  warn?: (message: string) => void
}

/** Both sources named a key and they do not agree. Nothing is chosen. */
export class AmbientEnvConflictError extends Error {
  readonly key: string
  constructor(message: string, key: string) {
    super(message)
    this.name = 'AmbientEnvConflictError'
    this.key = key
  }
}

/** Anything whose *name* claims it is a credential. Values are never printed. */
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|_KEY)$/

function show(key: string, value: string): string {
  return SECRET_KEY.test(key) ? `<redacted, ${value.length} chars>` : JSON.stringify(value)
}

/** Blank is absent. An exported-but-empty variable configures nothing. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `KEY=value` per line. `#` comments and blanks skipped, surrounding quotes
 * stripped, first `=` wins so a token containing `=` survives.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at === -1) continue
    const key = trimmed.slice(0, at).trim().replace(/^export\s+/, '')
    if (key === '') continue
    const value = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
    if (value.trim() !== '') out[key] = value
  }
  return out
}

/** Default-sink de-duplication, so a 125-file suite says each thing once. */
const alreadyWarned = new Set<string>()

/**
 * The default sink writes to `process.stderr` and NOT to `console.warn`.
 *
 * Measured, not assumed: vitest replaces `console` with an interceptor and
 * discards anything written during module *collection* — which is exactly when
 * this fires, because callers resolve their config at module scope. Under
 * `vitest run` a `console.warn` here is invisible unless you happen to pass
 * `--disableConsoleIntercept`, and a warning nobody sees is the silent-ignore
 * this change exists to abolish. A raw stream write survives.
 */
function writeToStderr(message: string): void {
  const stderr = (globalThis as {process?: {stderr?: {write?: (s: string) => void}}}).process?.stderr
  if (typeof stderr?.write === 'function') stderr.write(`${message}\n`)
  else console.warn(message)
}

/**
 * Read the declared source. Returns its values; touches nothing.
 *
 * @throws {AmbientEnvConflictError} when a managed key is set in both the
 * declared source and the ambient environment with different values.
 */
export function loadExplicitEnv(options: LoadExplicitEnvOptions = {}): ExplicitEnv {
  const file = options.file ?? EXPLICIT_ENV_FILE
  const ambient = options.ambient ?? process.env
  const sink = options.warn
  const warn = sink ?? writeToStderr

  const explicit = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}

  for (const key of MANAGED_KEYS) {
    const theirs = present(ambient[key])
    if (theirs === undefined) continue

    const mine = present(explicit[key])
    if (mine === undefined) {
      const notice =
        `[sanity-overlay-testkit] IGNORING the ambient ${key}. Test configuration is ` +
        `read from ${file} only, and that file does not define ${key}, so it resolves ` +
        `ABSENT and the credentialed suites will SKIP. If you meant to use it, put it ` +
        `in that file; if you did not, this message is why nothing ran.`
      if (sink === undefined) {
        if (alreadyWarned.has(key)) continue
        alreadyWarned.add(key)
      }
      warn(notice)
      continue
    }

    if (mine !== theirs) {
      throw new AmbientEnvConflictError(
        `[sanity-overlay-testkit] REFUSING to guess: ${key} is set in two places and they ` +
          `disagree.\n` +
          `  declared in ${file}: ${show(key, mine)}\n` +
          `  ambient environment: ${show(key, theirs)}\n` +
          `Choosing either one silently is how a suite ends up asserting against a project ` +
          `nobody picked, and reporting it as a parity failure. Unset the ambient ${key}, or ` +
          `make the two agree.`,
        key,
      )
    }
  }

  return Object.freeze({...explicit})
}

/**
 * Back-compatible name.
 *
 * `src/index.ts` re-exports `loadEnv` as part of the package's public surface
 * (plan §8.6) and is not this change's to rewrite. The behaviour behind the name
 * is the contract above — it returns values and mutates nothing — so the old
 * call shape `loadEnv()` still compiles while its old *semantics* are gone.
 *
 * @deprecated Prefer {@link loadExplicitEnv}; the name says what it does.
 */
export {loadExplicitEnv as loadEnv}
