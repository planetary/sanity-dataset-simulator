/**
 * THE EXAMPLES' DECLARED-SOURCE LOADER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS.
 *
 * Every example here used to read `process.env` directly. That is fine for a
 * port number and wrong for a project id, because the two fail differently:
 *
 *   • A wrong port fails immediately, visibly, and costs a retry.
 *   • A wrong project id SUCCEEDS. `pnpm dev` in a shell that happened to carry
 *     another project's `SANITY_PROJECT_ID` served that project's content and
 *     said nothing; `sanity dev` with an exported `SANITY_STUDIO_PROJECT_ID`
 *     opened a Studio on a foreign dataset and wrote branch intents naming its
 *     document ids into this repository's committed `.sanity-overlay/`; and the
 *     Spike B proxy forwarded the developer's real session cookie to whatever
 *     `SANITY_API_HOST` named.
 *
 * So the values that decide *whose data is touched* are read from a source
 * someone declared on purpose, and the ambient environment is CHECKED against
 * it rather than obeyed. `packages/sanity-overlay-testkit/src/env.ts` made the
 * same ruling for the test suite; this is the same contract for `examples/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A SEPARATE MODULE FROM THE TESTKIT'S, AND NOT AN IMPORT OF IT.
 *
 * Two hard constraints, neither negotiable:
 *
 *   1. `spikeB-proxy/proxy.mjs` documents that it stays loadable by a bare
 *      `node proxy.mjs` with no loader, no build step and no workspace
 *      resolution. Importing a `.ts` module from `packages/` would end that.
 *   2. `examples/` is what a consumer copies. A copied example that imports the
 *      repository's *test* package hands them a dev dependency they did not ask
 *      for, to configure a production Studio.
 *
 * What is shared instead is the CONTRACT, and `test/examples-explicit-env.test.ts`
 * pins it: absent-from-declared means absent, ambient-only means a warning
 * naming the key, and a disagreement is refused rather than resolved.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING ON DISAGREEMENT: REFUSE.
 *
 * "The declared value wins" reads like the safe answer and is not, because the
 * two values name DIFFERENT projects. Silently choosing produces a session
 * whose symptoms — a document that will not load, a reference picker full of
 * strangers, a 401 — all point at the wrong system. A refusal costs one
 * `unset` and states the problem in its own words.
 *
 * Equal values are not a disagreement and pass in silence.
 */
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'

/** Both sources named a key and they do not agree. Nothing is chosen. */
export class AmbientEnvConflictError extends Error {
  /** @param {string} message @param {string} key */
  constructor(message, key) {
    super(message)
    this.name = 'AmbientEnvConflictError'
    this.key = key
  }
}

/** Anything whose NAME claims it is a credential. Values are never printed. */
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|_KEY)$/

/** @param {string} key @param {string} value */
function show(key, value) {
  return SECRET_KEY.test(key) ? `<redacted, ${value.length} chars>` : JSON.stringify(value)
}

/** Blank is absent. An exported-but-empty variable configures nothing. */
function present(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `KEY=value` per line. `#` comments and blanks skipped, surrounding quotes
 * stripped, first `=` wins so a token containing `=` survives.
 *
 * Deliberately the same five rules as the testkit's parser: a `.env` that means
 * one thing to the suite and another to the example is its own defect class.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {}
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

/**
 * The declared files in one directory, lowest precedence first.
 *
 * `.env` then any `.env.<mode>` then any `*.local` — Vite's order, because a
 * Studio's `.env` files are loaded by Vite and a loader that disagreed with it
 * would refuse runs that were in fact correctly configured.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
export function declaredFilesIn(dir) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter(
    (name) => /^\.env(\..+)?$/.test(name) && statSync(join(dir, name)).isFile(),
  )
  const rank = (name) => (name.endsWith('.local') ? 2 : name === '.env' ? 0 : 1)
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return names.map((name) => join(dir, name))
}

/** Default-sink de-duplication, so one launcher says each thing once. */
const alreadyWarned = new Set()

/**
 * Written to `process.stderr`, not `console.warn`.
 *
 * These launchers print their banners on stdout and a developer pipes stdout;
 * a notice about configuration belongs on the stream that is not being piped
 * into a browser tab.
 */
function writeToStderr(message) {
  process.stderr.write(`${message}\n`)
}

/**
 * Resolve identity values from the declared source. Touches nothing.
 *
 * @param {object} options
 * @param {string[]} [options.dirs] directories whose `.env*` files are declared
 *   sources, lowest precedence first
 * @param {readonly string[]} options.keys the keys this call site is responsible
 *   for — the ones that decide whose data is touched
 * @param {Record<string, string>} [options.defaults] the identity this
 *   repository declares in code, the lowest-precedence declared source of all.
 *   Present for `examples/kitchen-sink`, which ships pointed at this project's
 *   own `b1n03q3z/parity` so it works on a fresh clone; absent for
 *   `examples/local-site`, which has no hosted identity to declare.
 * @param {Record<string, string|undefined>} [options.ambient] the environment to
 *   CHECK AGAINST — never to read values from. Injectable so a test can present
 *   a contaminated shell without contaminating its own process.
 * @param {(message: string) => void} [options.warn]
 * @param {string} [options.who] the label the messages speak as
 * @returns {Readonly<Record<string, string|undefined>>}
 * @throws {AmbientEnvConflictError} on a disagreement.
 */
export function loadExplicitEnv(options) {
  const dirs = options.dirs ?? []
  const keys = options.keys
  const defaults = options.defaults ?? {}
  const ambient = options.ambient ?? process.env
  const sink = options.warn
  const warn = sink ?? writeToStderr
  const who = options.who ?? 'sanity-overlay example'

  const files = dirs.flatMap((dir) => declaredFilesIn(dir))
  /** @type {Record<string, string>} */
  const declared = {...defaults}
  /** Which layer each value actually came from — quoted verbatim in the messages. */
  /** @type {Record<string, string>} */
  const origin = {}
  for (const key of Object.keys(defaults)) origin[key] = "this example's declared default"
  for (const file of files) {
    const parsed = parseEnvFile(readFileSync(file, 'utf8'))
    Object.assign(declared, parsed)
    for (const key of Object.keys(parsed)) origin[key] = file
  }

  /* Where a value SHOULD go, which is not the same question as where the
   * current one came from. Both appear in every message, so neither "why is it
   * this?" nor "where do I change it?" is left to guesswork. */
  const declareIn =
    dirs.length > 0 ? join(dirs[dirs.length - 1], '.env') : 'this example, in code'

  /** @type {Record<string, string|undefined>} */
  const resolved = {}

  for (const key of keys) {
    const mine = present(declared[key])
    /* Assigned even when absent, so the key is OWN-PRESENT with the value
     * `undefined`. A caller that spreads this map over another one then
     * overwrites rather than falls through — absence stays absence. */
    resolved[key] = mine

    const theirs = present(ambient[key])
    if (theirs === undefined) continue

    if (mine === undefined) {
      const notice =
        `[${who}] IGNORING the ambient ${key}. This example reads it from ${declareIn} ` +
        `only, and nothing there defines ${key}, so it resolves ABSENT. If you meant to use ` +
        `it, declare it there; if you did not, this message is why the example is not using it.`
      if (sink === undefined) {
        if (alreadyWarned.has(key)) continue
        alreadyWarned.add(key)
      }
      warn(notice)
      continue
    }

    if (mine !== theirs) {
      throw new AmbientEnvConflictError(
        `[${who}] REFUSING to guess: ${key} is set in two places and they disagree.\n` +
          `  declared  ${show(key, mine)}  (${origin[key] ?? 'declared source'})\n` +
          `  ambient   ${show(key, theirs)}  (exported in your shell)\n` +
          `These name different projects, and choosing either one silently is how an example ` +
          `ends up reading — or writing branch state about — content nobody selected.\n` +
          `Unset the ambient ${key}, or put the value you want in ${declareIn}.`,
        key,
      )
    }
  }

  return Object.freeze(resolved)
}
