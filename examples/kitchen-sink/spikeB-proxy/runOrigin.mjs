// MODE 2 (origin) — the entry point.
//
//   node --experimental-strip-types examples/kitchen-sink/spikeB-proxy/runOrigin.mjs --origin
//
// `--origin` is REQUIRED and there is no way to imply it. Mode 2 serves a
// fabricated, fully-granted `local-dev` identity from a loopback-only socket;
// starting it must always be something someone typed on purpose. Running this
// file without the flag prints what it would have done and exits non-zero.
//
// Flags (each also readable from the environment):
//
//   --origin                              REQUIRED. Also OVERLAY_BASE=none.
//   --root=<dir>     OVERLAY_ROOT         directory that CONTAINS `.sanity-overlay/`;
//                                         default `examples/kitchen-sink`
//   --port=<n>       PROXY_PORT           default 3999
//   --bind=<addr>    PROXY_BIND           default 127.0.0.1; a non-loopback
//                                         address is REFUSED, with no override
//   --project=<id>   SANITY_STUDIO_PROJECT_ID   the project id Studio is configured with
//   --dataset=<name> SANITY_STUDIO_DATASET      the one dataset this origin serves
//   --overlay=<id>   OVERLAY_ID           overlay id; default overlay-origin-local
//   --log=<path>     PROXY_LOG            JSONL request log
//
// It registers the `.ts` resolve fallback BEFORE importing `origin.mjs`, which
// pulls in `sanity-overlay-core` (see tsResolveHook.mjs).
import {register} from 'node:module'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

register('./tsResolveHook.mjs', import.meta.url)

const {createProxyServer} = await import('./proxy.mjs')
const {isOriginModeRequested, originStartupBanner} = await import('./originSafety.mjs')

const KNOWN = ['origin', 'root', 'port', 'bind', 'project', 'dataset', 'overlay', 'log']

/** `--key=value`, `--key value` and bare `--origin` all work; unknown flags are fatal. */
function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const [name, inline] = token.slice(2).split('=')
    if (!KNOWN.includes(name)) throw new Error(`unknown flag --${name} (known: ${KNOWN.join(', ')})`)
    if (name === 'origin') {
      flags.origin = inline === undefined ? true : inline !== 'false'
      continue
    }
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))
const env = process.env

if (!isOriginModeRequested({origin: flags.origin}, env)) {
  process.stderr.write(
    'runOrigin.mjs starts MODE 2, which serves a synthetic fully-granted identity with no\n' +
      'Sanity account behind it. That is never inferred. Pass --origin (or set\n' +
      'OVERLAY_BASE=none) to say you meant it.\n\n' +
      'For MODE 1 — a real Sanity project with only the data plane intercepted — run\n' +
      '`node proxy.mjs` instead; see README.md.\n',
  )
  process.exit(2)
}

const root =
  flags.root ??
  env.OVERLAY_ROOT ??
  fileURLToPath(new URL('../', import.meta.url)) /* examples/kitchen-sink */

const projectId = flags.project ?? env.SANITY_STUDIO_PROJECT_ID ?? 'b1n03q3z'
const dataset = flags.dataset ?? env.SANITY_STUDIO_DATASET ?? 'parity'
const port = Number(flags.port ?? env.PROXY_PORT ?? 3999)
const bind = flags.bind ?? env.PROXY_BIND ?? '127.0.0.1'

const {createOriginHandler} = await import('./origin.mjs')

const handler = await createOriginHandler({
  root,
  projectId,
  dataset,
  overlayId: flags.overlay ?? env.OVERLAY_ID ?? 'overlay-origin-local',
  log: (level, message) => {
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    write(`[origin] ${message}`)
  },
})

const server = createProxyServer({
  origin: true,
  originHandler: handler,
  port,
  bind,
  ...(flags.log === undefined ? {} : {logPath: flags.log}),
})

server.on('error', (error) => {
  process.stderr.write(`[proxy] server error: ${error.stack || error.message}\n`)
  process.exit(1)
})

server.listen(port, bind, () => {
  process.stderr.write(
    `${originStartupBanner({bind, port, root: handler.root, projectId, dataset})}\n` +
      `[proxy] overlay id  : ${handler.overlayId} (revision ${handler.revision})\n` +
      '[proxy] write-guard : ON and not overridable in Mode 2\n' +
      '[proxy] in Studio   : set apiHost to http://localhost:' +
      `${port} in sanity.config.ts\n`,
  )
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    process.stderr.write(`\n[proxy] ${signal} — draining\n`)
    /* Handler first: it owns the SSE streams and upgraded sockets, and
     * `server.close()` waits for every open connection. */
    handler
      .close()
      .then(() => new Promise((resolve) => server.close(resolve)))
      .then(
        () => process.exit(0),
        (error) => {
          process.stderr.write(`[proxy] failed to close cleanly: ${error?.stack ?? error}\n`)
          process.exit(1)
        },
      )
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
