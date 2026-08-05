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
// The `.ts` resolve fallback is registered BEFORE the site is imported, because
// the workspace packages use extensionless relative specifiers (see
// tsExtensionHook.mjs).
import {register} from 'node:module'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

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

const env = {
  ...process.env,
  SANITY_OVERLAY_MODE: flags.mode ?? process.env.SANITY_OVERLAY_MODE ?? 'fs',
  SANITY_OVERLAY_ROOT:
    flags.root ??
    (flags.demo === true ? DEMO_OVERLAY_ROOT : undefined) ??
    process.env.SANITY_OVERLAY_ROOT ??
    DEFAULT_OVERLAY_ROOT,
  ...(flags.perspective === undefined ? {} : {SANITY_OVERLAY_PERSPECTIVE: flags.perspective}),
  ...(flags.dataset === undefined ? {} : {SITE_BASE_DATASET: flags.dataset}),
}

const {createSiteClient} = await import('./src/createClient.ts')
const {startLocalSite, DEFAULT_PORT} = await import('./src/server.ts')

const {client, summary} = createSiteClient(env)

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
