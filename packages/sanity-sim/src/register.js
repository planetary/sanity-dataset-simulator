/**
 * Node preload: `node --import sanity-sim/register` (sanity-sim sets this in
 * NODE_OPTIONS for the dev processes it starts).
 *
 * Rewrites every request to Sanity's hosts — `<project>.api.sanity.io`,
 * `<project>.apicdn.sanity.io`, `api.sanity.io`, `cdn.sanity.io` — to the
 * simulator, for `fetch` and for `http(s).request`. That covers
 * `@sanity/client`, `next-sanity`, `@sanity/image-url` URLs fetched
 * server-side, and plain fetch calls, with no change to the app's code.
 *
 * Inert unless SANITY_SIM_URL is set.
 */
import http from 'node:http'
import https from 'node:https'
import {syncBuiltinESMExports} from 'node:module'
import tls from 'node:tls'

const target = process.env.SANITY_SIM_URL
const SANITY_HOST = /(^|\.)(api|apicdn)\.sanity\.io$|^cdn\.sanity\.io$/

if (target && !globalThis.__sanitySimRegistered) {
  globalThis.__sanitySimRegistered = true
  const sim = new URL(target)

  const rewrite = (input) => {
    let url
    try {
      url = new URL(String(input))
    } catch {
      return null
    }
    if (!SANITY_HOST.test(url.hostname)) return null
    const next = new URL(url.pathname + url.search, sim)
    /* The project subdomain is how Content Lake tells projects apart; keep it visible to the sim. */
    return next
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = function sanitySimFetch(input, init) {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    const rewritten = href ? rewrite(href) : null
    if (!rewritten) return originalFetch.call(this, input, init)
    if (typeof input === 'string' || input instanceof URL) return originalFetch.call(this, rewritten, init)
    return originalFetch.call(this, new Request(rewritten, input), init)
  }

  const patch = (module, defaultProtocol) => {
    for (const name of ['request', 'get']) {
      const original = module[name]
      module[name] = function sanitySimRequest(...args) {
        const redirected = redirectArgs(args, defaultProtocol)
        if (!redirected) return original.apply(this, args)
        const transport = redirected.protocol === 'https:' ? https : http
        const fn = name === 'get' ? transport.get : transport.request
        return (fn.__sanitySimOriginal ?? fn).apply(this, redirected.args)
      }
      module[name].__sanitySimOriginal = original
    }
  }

  /** Normalize request(url, options, cb) / request(options, cb) and rewrite the target. */
  const redirectArgs = (args, defaultProtocol) => {
    let [first, second, third] = args
    let options
    let callback
    if (typeof first === 'string' || first instanceof URL) {
      const url = new URL(String(first))
      options = {protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, ...(typeof second === 'object' ? second : {})}
      callback = typeof second === 'function' ? second : third
    } else {
      options = {...first}
      callback = second
    }
    const hostname = options.hostname ?? options.host?.split(':')[0]
    if (!hostname || !SANITY_HOST.test(hostname)) return null
    const protocol = sim.protocol
    const rewritten = {
      ...options,
      protocol,
      hostname: sim.hostname,
      host: undefined,
      port: sim.port || (protocol === 'https:' ? 443 : 80),
      headers: {...options.headers, host: sim.host},
      agent: undefined,
    }
    return {protocol, args: callback ? [rewritten, callback] : [rewritten]}
  }

  patch(http, 'http:')
  patch(https, 'https:')

  /* The catch-all: clients with their own HTTP stack (get-it bundles npm
   * `undici` and passes its own dispatcher, so neither patch above sees it)
   * still open TLS through `tls.connect`. Connections to Sanity's hosts are
   * redirected to the simulator, keeping the original SNI; the simulator
   * answers with a certificate from sanity-sim's Node-only CA, which these
   * processes trust via NODE_EXTRA_CA_CERTS. Needs the simulator's TLS port. */
  const tlsPort = process.env.SANITY_SIM_TLS_PORT
  if (tlsPort) {
    const originalConnect = tls.connect
    tls.connect = function sanitySimConnect(...args) {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : typeof args[1] === 'object' && args[1] !== null ? args[1] : null
      const host = options?.servername ?? options?.host ?? (typeof args[1] === 'string' ? args[1] : undefined)
      if (!host || !SANITY_HOST.test(host) || options?.socket) return originalConnect.apply(this, args)
      const callback = args.find((arg) => typeof arg === 'function')
      const redirected = {...options, host: '127.0.0.1', port: Number(tlsPort), servername: host}
      delete redirected.path
      return callback ? originalConnect.call(this, redirected, callback) : originalConnect.call(this, redirected)
    }
  }
  /* Named ESM imports of builtins (`import {request} from 'node:https'`) see the patch only after this. */
  syncBuiltinESMExports()
}
