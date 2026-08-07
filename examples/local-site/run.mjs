// The local site's entry point.
//
//   pnpm --filter local-site dev
//   node --experimental-strip-types examples/local-site/run.mjs
//
// Options, in precedence order (flag beats env beats default):
//
//   --mode=off|fs     SANITY_OVERLAY_MODE          default: fs
//   --root=<dir>      SANITY_OVERLAY_ROOT          the directory CONTAINING
//                                                  `.sanity-overlay/`; default
//                                                  is examples/kitchen-sink
//   --demo                                         use the overlay `seed.mjs`
//                                                  writes, instead of the Studio's
//   --perspective=…   SANITY_OVERLAY_PERSPECTIVE   published|drafts (default drafts)
//   --port=<n>        SITE_PORT                    default 4000 (3998 is the
//                                                  overlay server, 3999 the proxy)
//   --dataset=<file>  SITE_BASE_DATASET            NDJSON base dataset
//
// WHICH DATASET THE SITE READS IS NOT ONE OF THOSE.
//
// This file used to build the site's environment as `{...process.env, …}`, and
// `src/createClient.ts` reads SANITY_PROJECT_ID + SANITY_DATASET out of it to
// choose between the committed NDJSON snapshot and the HOSTED query API. So an
// exported pair — from any other project, in any shell — moved this site's
// reads onto that project's content, with SANITY_READ_TOKEN attached, and said
// nothing about it.
//
// Nothing ambient is spread in any more. The switches above are still read from
// the environment, because a port or a mode is a statement about this machine.
// The four values that decide WHOSE DATA IS READ come from `./.env` and nowhere
// else (see ../explicitEnv.mjs); with no such file the site reads the committed
// snapshot, which is what it did before and what the tests assert.
//
// The `.ts` resolve fallback is registered BEFORE the site is imported, because
// the workspace packages use extensionless relative specifiers (see
// tsExtensionHook.mjs).
import {register} from 'node:module'
import {fileURLToPath} from 'node:url'
import process from 'node:process'
import {loadExplicitEnv} from '../explicitEnv.mjs'

register('./tsExtensionHook.mjs', import.meta.url)

const KNOWN = ['mode', 'root', 'perspective', 'port', 'dataset']
/** Value-less flags. */
const KNOWN_SWITCHES = ['demo']

function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    /* `pnpm run <script> -- --port=4001` forwards the bare `--` verbatim. */
    if (token === '--') continue
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const [name, inline] = token.slice(2).split('=')
    if (KNOWN_SWITCHES.includes(name)) {
      flags[name] = true
      continue
    }
    if (!KNOWN.includes(name)) {
      throw new Error(`unknown flag --${name} (known: ${[...KNOWN, ...KNOWN_SWITCHES].join(', ')})`)
    }
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))

/** Where the Studio's overlay server writes `.sanity-overlay/` by default. */
const DEFAULT_OVERLAY_ROOT = fileURLToPath(new URL('../kitchen-sink/', import.meta.url))
/** `--demo`: the overlay `seed.mjs` writes, so the loop is visible without Studio. */
const DEMO_OVERLAY_ROOT = fileURLToPath(new URL('./.overlay-demo/', import.meta.url))

/** This example's own `.env` — the only place a hosted base may be declared. */
const HERE = fileURLToPath(new URL('./', import.meta.url))

/**
 * The keys that decide whose content this site renders.
 *
 * Taken from `createClient.ts` rather than restated here, so the launcher cannot
 * guard a spelling the resolver does not read, or miss one that it does — the
 * shape of the bug this example already had once.
 *
 * No `defaults`: unlike `examples/kitchen-sink`, this example declares no
 * hosted identity at all. Absent means absent, which sends `createSiteBaseSource`
 * to the committed NDJSON snapshot — offline, deterministic, and the state every
 * test in `local-site-routes.test.ts` is written against. An ambient value here
 * therefore produces a WARNING and is dropped rather than a refusal: there is
 * no declared value for it to disagree with.
 */
const {SITE_BASE_KEYS, createSiteClient} = await import('./src/createClient.ts')

const env = {
  ...loadExplicitEnv({dirs: [HERE], keys: SITE_BASE_KEYS, who: 'local-site'}),
  /* Behaviour, read ambiently on purpose: which overlay to layer, from where,
   * through which perspective, and which snapshot file stands in for staging.
   * None of them can point this process at another project's content. */
  SANITY_OVERLAY_MODE: flags.mode ?? process.env.SANITY_OVERLAY_MODE ?? 'fs',
  SANITY_OVERLAY_ROOT:
    flags.root ??
    (flags.demo === true ? DEMO_OVERLAY_ROOT : undefined) ??
    process.env.SANITY_OVERLAY_ROOT ??
    DEFAULT_OVERLAY_ROOT,
  SANITY_OVERLAY_PERSPECTIVE: flags.perspective ?? process.env.SANITY_OVERLAY_PERSPECTIVE,
  SITE_BASE_DATASET: flags.dataset ?? process.env.SITE_BASE_DATASET,
}

const {startLocalSite, DEFAULT_PORT} = await import('./src/server.ts')

const {client, summary, warnings} = createSiteClient(env)

/* Deprecated spellings and the like. On stderr, before the banner: a notice
 * about configuration must not be lost in a stdout pipe, and must arrive before
 * the line it is qualifying. */
for (const warning of warnings) process.stderr.write(`${warning}\n`)

const running = await startLocalSite({
  client,
  port: Number(flags.port ?? process.env.SITE_PORT ?? DEFAULT_PORT),
  watch: true,
  log: (message) => console.log(`[site] ${message}`),
})

console.log(`[site] listening on ${running.url}`)
console.log(`[site] ${summary}`)
console.log(`[site] routes    /  and  /articles/<slug>`)
console.log(`[site] revalidate  curl -X POST ${running.url}/revalidate`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log(`\n[site] ${signal} — closing`)
    running.close().then(
      () => process.exit(0),
      (error) => {
        console.error(`[site] failed to close cleanly: ${error?.stack ?? error}`)
        process.exit(1)
      },
    )
  })
}
