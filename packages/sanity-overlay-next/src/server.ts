/**
 * The local development mounting of {@link createOverlayApi}.
 *
 * `api.handle` is a Web Fetch handler so an App Router `route.ts` can mount it
 * directly (PRD §10.1). Local development has no App Router in front of it — the
 * Studio dev server talks to a bare port — so this file adapts the same handler
 * onto `node:http`. It contains no routing, no validation and no overlay logic:
 * everything here is IncomingMessage → Request and Response → ServerResponse,
 * plus the direct-edit poll timer. Two mountings, one route table.
 */
import {createServer} from 'node:http'
import type {IncomingMessage, Server, ServerResponse} from 'node:http'
import {isAbsolute, resolve as resolvePath} from 'node:path'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import type {FsOverlayStoreHooks} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayApi} from './api'
import type {OverlayApi, OverlayApiOptions} from './api'

/** The port the Studio plugin's default `apiUrl` points at. */
export const DEFAULT_API_PORT = 3998

/**
 * The Studio dev server origin, and the only origin this mounting grants unless
 * told otherwise.
 *
 * `createOverlayApi` grants none by default — see its `origins` option. The dev
 * server narrows that to one named client rather than widening it to `*`,
 * because the branch it serves is the whole unpublished editorial state.
 */
export const DEFAULT_STUDIO_ORIGIN = 'http://localhost:3333'

/**
 * Direct-edit poll period (ms).
 *
 * `0` turns the watcher off entirely, leaving `/events` a commit-only bridge.
 * The interval is a latency knob and nothing else: every §14.4 behaviour lives
 * in `FsOverlayStore.revalidate`, which the pass only triggers.
 */
const DEFAULT_WATCH_INTERVAL_MS = 250

export interface StartOverlayApiServerOptions
  extends Omit<OverlayApiOptions, 'store' | 'now'> {
  /**
   * The directory that CONTAINS `.sanity-overlay/` (PRD §14.1). Relative paths
   * resolve against the process cwd.
   */
  root: string
  port?: number
  host?: string
  now?: () => string
  /** The store's own fault-injection surface; production code leaves it unset. */
  hooks?: FsOverlayStoreHooks
  watchIntervalMs?: number
}

export interface OverlayApiServer {
  url: string
  port: number
  host: string
  root: string
  overlayId: string
  store: FsOverlayStore
  api: OverlayApi
  readonly revision: number
  close(): Promise<void>
}

/** IncomingMessage → Request, body included. */
async function toRequest(request: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(request.url ?? '/', origin)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
    else headers.set(name, value)
  }

  const method = request.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return new Request(url, {method, headers})
  }

  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return new Request(url, {method, headers, body: Buffer.concat(chunks)})
}

/**
 * Response → ServerResponse.
 *
 * The body is pumped chunk by chunk rather than buffered, because `/events` is
 * an SSE stream that never ends: `await response.text()` on it would hang
 * forever and the bridge would deliver nothing.
 */
async function writeResponse(response: Response, out: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  out.writeHead(response.status, headers)

  if (response.body === null) {
    out.end()
    return
  }

  const reader = response.body.getReader()
  /*
   * A subscriber that goes away closes its socket; nothing else tells the
   * handler. Cancelling the reader here is what runs the stream's own `cancel`
   * callback, which is where `/events` forgets the subscriber — without it a
   * closed tab stays in the broadcast set forever and every emit pays for it.
   */
  out.on('close', () => {
    void reader.cancel().catch(() => undefined)
  })
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once('drain', resolve))
      }
    }
  } catch {
    /* The subscriber went away, or the stream was closed by `api.close()`.
     * Neither is a server fault; end the socket cleanly rather than crash. */
  } finally {
    out.end()
  }
}

export async function startOverlayApiServer(
  options: StartOverlayApiServerOptions,
): Promise<OverlayApiServer> {
  const root = isAbsolute(options.root) ? options.root : resolvePath(process.cwd(), options.root)
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_API_PORT
  const now = options.now ?? (() => new Date().toISOString())

  const store = new FsOverlayStore({root, now, hooks: options.hooks})
  const api = await createOverlayApi({
    ...options,
    store,
    now,
    origins: options.origins ?? [DEFAULT_STUDIO_ORIGIN],
  })

  /**
   * Every request currently being handled.
   *
   * `close()` waits on these, not merely on the API's commit queue. Draining the
   * queue only proves the STORE finished; the handler still has to write the
   * response afterwards, and destroying the socket in that window hands the
   * caller a transport error for a write that actually landed — the durability
   * lie again, wearing a different hat.
   */
  const inflight = new Set<Promise<void>>()

  const server: Server = createServer((incoming, out) => {
    const handled = (async () => {
      const request = await toRequest(incoming, `http://${incoming.headers.host ?? 'localhost'}`)
      /* Without this, Nagle holds a small SSE frame back until the next one
       * arrives — so the last edit before a pause is the one never announced. */
      incoming.socket?.setNoDelay?.(true)
      const response = await api.handle(request)
      await writeResponse(response, out)
    })().catch((error) => {
      try {
        out.writeHead(500, {'content-type': 'application/json; charset=utf-8'})
        out.end(
          `${JSON.stringify({
            ok: false,
            error: {code: 'INTERNAL', message: String((error as Error)?.message ?? error)},
          })}\n`,
        )
      } catch {
        out.destroy()
      }
    })
    inflight.add(handled)
    void handled.finally(() => inflight.delete(handled))
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  /* Started only once the socket is bound, so a failed listen leaves no timer
   * behind polling a store nobody can reach. */
  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  let watchTimer: NodeJS.Timeout | null = null
  if (watchIntervalMs > 0) {
    watchTimer = setInterval(() => {
      void api.pollDirectEdits().catch(() => undefined)
    }, watchIntervalMs)
    /* Never hold the process (or the test runner) open. */
    watchTimer.unref?.()
  }

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    host,
    root,
    overlayId: api.overlayId,
    store,
    api,
    get revision() {
      return api.revision
    },
    async close() {
      /* Stop scheduling first, so no pass is queued behind the drain below and
       * nothing polls a root the caller is about to delete. */
      if (watchTimer !== null) {
        clearInterval(watchTimer)
        watchTimer = null
      }
      /* Ends every SSE stream, then drains in-flight commits. Both must happen
       * before the socket wait below: an open event-stream response is a
       * connection `server.close()` would otherwise wait on forever. */
      await api.close()

      /* Then let every response finish being written. Only now is destroying a
       * socket harmless. */
      await Promise.allSettled([...inflight])

      await new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    },
  }
}
