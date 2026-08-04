// SPIKE A — the overlay persistence server's entry point (PRD §14, §36.1).
//
//   pnpm --filter kitchen-sink overlay:server
//   node --experimental-strip-types examples/kitchen-sink/spikeA/runOverlayServer.mjs
//
// Options, in precedence order (flag beats env beats default):
//
//   --root=<dir>    SPIKE_OVERLAY_ROOT     the directory that CONTAINS
//                                          `.sanity-overlay/`; default is
//                                          `examples/kitchen-sink`
//   --port=<n>      SPIKE_OVERLAY_PORT     default 3998
//   --origin=<url>  SPIKE_OVERLAY_ORIGIN   CORS grant; default http://localhost:3333
//   --id=<string>   SPIKE_OVERLAY_ID       overlay id; default spike-a-local-echo
//
// It registers the `.ts` resolve fallback BEFORE importing the server, because
// `overlayServer.mjs` pulls in `sanity-overlay-core`, whose internal specifiers
// are extensionless (see tsExtensionHook.mjs).
import {register} from 'node:module'
import process from 'node:process'

register('./tsExtensionHook.mjs', import.meta.url)

const {startOverlayServer, DEFAULT_ORIGIN, DEFAULT_PORT} = await import('./overlayServer.mjs')

/** `--key=value` and `--key value` both work; unknown flags are a hard error. */
function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const [name, inline] = token.slice(2).split('=')
    if (!['root', 'port', 'origin', 'id'].includes(name)) {
      throw new Error(`unknown flag --${name}`)
    }
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))

const server = await startOverlayServer({
  ...(flags.root === undefined ? {} : {root: flags.root}),
  ...(flags.id === undefined ? {} : {overlayId: flags.id}),
  port: Number(flags.port ?? process.env.SPIKE_OVERLAY_PORT ?? DEFAULT_PORT),
  origins: [flags.origin ?? process.env.SPIKE_OVERLAY_ORIGIN ?? DEFAULT_ORIGIN],
  /* The whole point of the spike is that a dropped write is never silent, so the
   * server's log goes to the terminal rather than into a void. */
  log: (level, message) => {
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    write(`[overlay] ${message}`)
  },
})

console.log(`[overlay] listening on ${server.url}`)
console.log(`[overlay] overlay id   ${server.overlayId}`)
console.log(`[overlay] root         ${server.root}`)
console.log(`[overlay] revision     ${server.revision}`)
console.log(`[overlay] CORS origin  ${flags.origin ?? process.env.SPIKE_OVERLAY_ORIGIN ?? DEFAULT_ORIGIN}`)
console.log('[overlay] in Studio:   localStorage.SPIKE_LOCAL_ECHO = "1"; localStorage.SPIKE_OVERLAY_PERSIST = "1"')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log(`\n[overlay] ${signal} — draining in-flight commits…`)
    /* `close()` waits for any commit still inside the store, so Ctrl-C between a
     * keystroke and its rename cannot leave a half-written transaction. */
    server.close().then(
      () => {
        console.log('[overlay] closed')
        process.exit(0)
      },
      (error) => {
        console.error(`[overlay] failed to close cleanly: ${error?.stack ?? error}`)
        process.exit(1)
      },
    )
  })
}
