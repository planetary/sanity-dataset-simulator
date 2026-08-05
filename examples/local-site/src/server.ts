/**
 * The only file that knows about sockets.
 *
 * `createSite().handle()` already returns a complete response; this adapts it to
 * `node:http`. A Next.js port deletes this file and keeps everything below it.
 */
import {createServer, type Server} from 'node:http'
import type {OverlayClient} from '../../../packages/sanity-overlay-client/src/index'
import {createSite, type LocalSite} from './site'

export interface StartLocalSiteOptions {
  readonly client: OverlayClient
  readonly port?: number
  readonly host?: string
  /**
   * Re-render on overlay changes by subscribing to the loader's watcher. The
   * client also probes before every read, so this only shortens the window; it
   * is the hook a live-reload transport would attach to.
   */
  readonly watch?: boolean
  readonly log?: (message: string) => void
}

export interface RunningLocalSite {
  readonly url: string
  readonly port: number
  readonly site: LocalSite
  readonly server: Server
  close(): Promise<void>
}

/**
 * 4000, not 3999: the Spike B transport proxy already owns 3999 and the overlay
 * server owns 3998, so a default that collided would fail only for the person
 * running the whole loop — which is everyone this example is for.
 */
export const DEFAULT_PORT = 4000

export async function startLocalSite(
  options: StartLocalSiteOptions,
): Promise<RunningLocalSite> {
  const log = options.log ?? (() => {})
  const site = createSite({client: options.client})
  const host = options.host ?? '127.0.0.1'

  const server = createServer((request, response) => {
    const started = Date.now()
    void site
      .handle({method: request.method ?? 'GET', url: request.url ?? '/'})
      .then((result) => {
        response.writeHead(result.status, result.headers)
        response.end(request.method === 'HEAD' ? undefined : result.body)
        log(`${request.method} ${request.url} -> ${result.status} (${Date.now() - started}ms)`)
      })
      .catch((error: unknown) => {
        /* A throw here is a bug in the adapter, not in a read: `handle` already
         * turns a failed read into a response. It must still not hang. */
        log(`${request.method} ${request.url} -> 500 ${String(error)}`)
        response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'})
        response.end('internal error\n')
      })
  })

  const unwatch =
    options.watch === true
      ? options.client.watch(() => log('overlay changed — next render will reload it'))
      : () => {}

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? DEFAULT_PORT)

  return {
    url: `http://${host}:${port}`,
    port,
    site,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        unwatch()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
