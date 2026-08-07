// The kitchen-sink overlay API server — the REAL package, not the spike.
//
//   pnpm --filter kitchen-sink overlay:server
//   node examples/kitchen-sink/overlayApiServer.mjs --port=3998
//
// `sanity-overlay-next` owns the endpoints (`startOverlayApiServer`), so this
// file is a launcher and nothing else: flags, a resolve hook, a banner and a
// clean shutdown. There is no overlay logic here, and there must never be —
// anything this file decided would be a behaviour the test suite never sees.
//
// Options, in precedence order (flag beats env beats default):
//
//   --root=<dir>    OVERLAY_ROOT     the directory that CONTAINS
//                                    `.sanity-overlay/`; default is this
//                                    example's own directory
//   --port=<n>      OVERLAY_PORT     default `DEFAULT_API_PORT` (3998); `0`
//                                    binds an ephemeral port and prints it
//   --origin=<url>  OVERLAY_ORIGIN   CORS grant; default `DEFAULT_STUDIO_ORIGIN`
//   --id=<string>   OVERLAY_ID       overlay id for a fresh overlay
//
// WHY THE RESOLVE HOOK
// Node strips TypeScript types natively but its ESM resolver still requires an
// explicit file extension, and every package in this workspace imports across
// package boundaries by extensionless relative path (`../../sanity-overlay-
// store-fs/src/index`) — the convention the bundlers here already resolve. The
// hook retries a failed relative resolution as `.ts` and `/index.ts`, which is
// the smallest thing that makes `node` agree with vitest. It is registered from
// a `data:` URL so this launcher stays a single file with no build step: hooks
// load in their own thread and cannot close over anything here anyway.
//
// `spikeA/runOverlayServer.mjs` is deliberately still present and still works;
// PRD §36.1 evidence procedures and `overlay-server.test.ts` are written against
// it. This launcher replaces it as the thing a developer runs, not as the thing
// Phase 1 evidence refers to.
import {register} from 'node:module'
import {dirname} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const TS_RESOLVE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return nextResolve(specifier, context)
  }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch {
        /* try the next shape; the original error is rethrown if none work */
      }
    }
    throw error
  }
}
`

register(`data:text/javascript,${encodeURIComponent(TS_RESOLVE_HOOK)}`)

const HERE = dirname(fileURLToPath(import.meta.url))
const NEXT_PACKAGE = new URL('../../packages/sanity-overlay-next/src/index.ts', import.meta.url).href

const {startOverlayApiServer, DEFAULT_API_PORT, DEFAULT_STUDIO_ORIGIN} = await import(NEXT_PACKAGE)

/** `--key=value` and `--key value` both work; an unknown flag is a hard error. */
function parseFlags(argv) {
  const known = ['root', 'port', 'origin', 'id']
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const [name, inline] = token.slice(2).split('=')
    if (!known.includes(name)) throw new Error(`unknown flag --${name} (known: ${known.join(', ')})`)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))

const root = flags.root ?? process.env.OVERLAY_ROOT ?? HERE
const port = Number(flags.port ?? process.env.OVERLAY_PORT ?? DEFAULT_API_PORT)
const origin = flags.origin ?? process.env.OVERLAY_ORIGIN ?? DEFAULT_STUDIO_ORIGIN
const overlayId = flags.id ?? process.env.OVERLAY_ID

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`--port must be an integer between 0 and 65535, got ${JSON.stringify(port)}`)
}

const server = await startOverlayApiServer({
  root,
  port,
  origins: [origin],
  ...(overlayId === undefined ? {} : {overlayId}),
  /* A dropped write must never be silent, so the API's log reaches the
   * terminal rather than a void. */
  log: (level, message) => {
    const write = level === 'error' ? console.error : console.warn
    write(`[overlay] ${message}`)
  },
})

console.log(`[overlay] listening on ${server.url}`)
console.log(`[overlay] overlay id   ${server.overlayId}`)
console.log(`[overlay] root         ${server.root}`)
console.log(`[overlay] revision     ${server.revision}`)
console.log(`[overlay] CORS origin  ${origin}`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log(`\n[overlay] ${signal} — ending event streams and draining commits…`)
    /* `close()` ends every SSE stream, drains the commit queue and waits for
     * in-flight responses, so Ctrl-C between a keystroke and its rename cannot
     * leave a half-written transaction or an unacknowledged write. */
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
