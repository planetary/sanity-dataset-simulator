/**
 * The overlay-plane recorder and supervisor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * `docs/plans/evidence/phase-3/acceptance-audit.md` §3.2 point 3 names the hole
 * this closes, exactly:
 *
 *     "In plugin mode the proxy is structurally blind to the write path. The
 *      facade sends writes to the overlay API at :3998; they never traverse the
 *      proxy at all. So the proxy log cannot audit them even in principle, and
 *      no other server-side artifact does."
 *
 * The Track B proxy log is a complete record of what Studio sent *towards
 * Sanity* and therefore proves the negative — no write escaped. It cannot prove
 * the positive — that the write went somewhere, and that somewhere was the
 * overlay. Without the positive half, a run in which the editor silently did
 * nothing at all produces a perfectly clean proxy log, and "no staging writes"
 * passes vacuously. That is precisely the false all-clear this project has
 * already had three times.
 *
 * So the suite interposes a recording pass-through between the Studio and the
 * real overlay server, and the audit reads BOTH logs:
 *
 *     browser :3333 ──► recorder :3998 ──► real overlay server :3997 ──► disk
 *                          │
 *                          └──► overlay-log.jsonl   (server-side, per request)
 *
 * The recorder is transparent. It rewrites nothing, decides nothing, and is not
 * a guard — a guard here would be a fourth copy of a classification this repo
 * already has three of. It is a witness.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT ALSO SUPERVISES
 *
 * Specs must not inherit each other's overlay state. Wiping `.sanity-overlay/`
 * under a live server is not safe — `FsOverlayStore` holds an open manifest and
 * a serialised commit queue — so a reset restarts the real server against a
 * freshly emptied root. `openOverlay(..., {ifNotExists: true})` re-initialises
 * an empty directory, so no seed fixture is needed and none is copied out of
 * `examples/`.
 *
 * The control plane listens on its own loopback port (3996) that no browser
 * origin is ever told about. It is not reachable from the Studio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER LOGGED
 *
 * Headers and bodies. `commit` payloads carry document content and the
 * `Authorization` header carries a credential; the proxy's own frame guard
 * learned this the hard way (`proxy-ws-frames.test.ts` asserts its log contains
 * neither the token nor the string `Bearer`). This log records method, path,
 * status, duration, byte counts, and — for `/commit` only — the two routing
 * fields `kind` and `idempotencyKey`, which are identifiers, not content.
 */
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {request as httpRequest} from 'node:http'
import {appendFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import process from 'node:process'

import {DATASET, KITCHEN_SINK, OVERLAY_LOG, OVERLAY_ROOT, PORTS, PROJECT_ID} from './paths.mjs'

/** Routes the real overlay server implements. Anything else is a 404 there. */
export const OVERLAY_ROUTES = Object.freeze([
  '/health',
  '/events',
  '/state',
  '/resolve',
  '/query',
  '/query/plan',
  '/commit',
])

const UPSTREAM_HOST = '127.0.0.1'

/* ───────────────────────────────────────────────────────────── logging ── */

/**
 * Synchronous append, like the proxy's own logger: a `SIGTERM` between the
 * response and an async flush would lose exactly the record that mattered.
 */
function makeLogger(logPath) {
  mkdirSync(dirname(logPath), {recursive: true})
  writeFileSync(logPath, '')
  return function log(record) {
    appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  }
}

/** Query strings are stripped: they are not needed and may carry parameters. */
function pathOf(url) {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

/** Identifiers only — never the payload. Returns `{}` for anything else. */
function routingFieldsOf(route, bodyBuffer) {
  if (route !== '/commit') return {}
  try {
    const body = JSON.parse(bodyBuffer.toString('utf8'))
    const out = {}
    if (typeof body?.kind === 'string') out.kind = body.kind
    if (typeof body?.idempotencyKey === 'string') out.idempotencyKey = body.idempotencyKey
    return out
  } catch {
    return {bodyUnparseable: true}
  }
}

/* ────────────────────────────────────────────────────── child lifecycle ── */

/**
 * Which overlay API server sits behind the recorder.
 *
 * `product` is `examples/kitchen-sink/overlayApiServer.mjs`, a thin launcher for
 * `sanity-overlay-next`'s `startOverlayApiServer` — the endpoints a consumer
 * actually deploys, and therefore the ones an E2E suite must exercise. `spike`
 * is `spikeA/runOverlayServer.mjs`, kept behind `E2E_OVERLAY_SERVER=spike`
 * because it is what every Phase-1 evidence procedure was written against and
 * bisecting between the two is occasionally the fastest way to localise a
 * regression.
 *
 * They differ in their environment vocabulary — `OVERLAY_*` versus
 * `SPIKE_OVERLAY_*` — which is exactly the kind of divergence that produced a
 * deployment reading one spelling while another package wrote the other. Both
 * are spelled out here rather than guessed at.
 */
const SERVERS = {
  product: {
    argv: (root, port) => ['overlayApiServer.mjs', `--root=${root}`, `--port=${port}`],
    env: (root, port) => ({
      OVERLAY_ROOT: root,
      OVERLAY_PORT: String(port),
      OVERLAY_ORIGIN: `http://localhost:${PORTS.studio}`,
    }),
  },
  spike: {
    argv: (root, port) => [
      '--experimental-strip-types',
      'spikeA/runOverlayServer.mjs',
      `--root=${root}`,
      `--port=${port}`,
    ],
    env: (root, port) => ({
      SPIKE_OVERLAY_ROOT: root,
      SPIKE_OVERLAY_PORT: String(port),
      SPIKE_OVERLAY_ORIGIN: `http://localhost:${PORTS.studio}`,
    }),
  },
}

function startRealServer({root, port}) {
  const which = process.env.E2E_OVERLAY_SERVER === 'spike' ? 'spike' : 'product'
  const server = SERVERS[which]

  const child = spawn(process.execPath, server.argv(root, port), {
    cwd: KITCHEN_SINK,
    env: {
      ...process.env,
      /* Which project and dataset the child serves is DECLARED, never inherited.
       * The spread above is how the child gets PATH and NODE_OPTIONS, but it is
       * also how an ambient `SANITY_STUDIO_PROJECT_ID` used to reach
       * `examples/kitchen-sink/spikeA/overlayServer.mjs`, which reads exactly
       * that key. Under Playwright these two are already pinned by SHARED_ENV;
       * this closes the standalone path the header documents
       * (`node e2e/harness/overlayHarness.mjs`), where nothing else would. */
      SANITY_STUDIO_PROJECT_ID: PROJECT_ID,
      SANITY_STUDIO_DATASET: DATASET,
      ...server.env(root, port),
      /* The recorder forwards the browser's `Origin` verbatim, so whichever
       * server is behind it still sees `http://localhost:3333` and its
       * single-origin CORS grant keeps working unchanged. */
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[overlay:${which}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[overlay:${which}] ${chunk}`))
  return child
}

function stopChild(child) {
  return new Promise((resolvePromise) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    child.kill('SIGTERM')
  })
}

/** Poll the real server's own `/health`. Bounded, and loud when it never comes. */
async function waitForUpstream(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${UPSTREAM_HOST}:${port}/health`)
      if (response.ok) return
      lastError = `status ${response.status}`
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`overlay server on :${port} never became healthy (${lastError})`)
}

/* ──────────────────────────────────────────────────────────── the proxy ── */

function forward({req, res, upstreamPort, log, bodyBuffer}) {
  const started = Date.now()
  const route = pathOf(req.url)
  const headers = {...req.headers}
  delete headers.host
  delete headers['content-length']

  const upstream = httpRequest(
    {host: UPSTREAM_HOST, port: upstreamPort, method: req.method, path: req.url, headers},
    (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(name, value)
      }

      /* `/events` is SSE and is held open for the lifetime of a pane. Chunks are
       * pumped rather than buffered, with backpressure, and Nagle is disabled on
       * both sockets — a buffered event stream would make the Studio look hung
       * and the failure would be blamed on the product. */
      const isStream = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
      if (isStream) {
        res.flushHeaders?.()
        req.socket?.setNoDelay?.(true)
        upstreamRes.socket?.setNoDelay?.(true)
      }

      let bytesOut = 0
      upstreamRes.on('data', (chunk) => {
        bytesOut += chunk.length
        if (!res.write(chunk)) {
          upstreamRes.pause()
          res.once('drain', () => upstreamRes.resume())
        }
      })
      upstreamRes.on('end', () => {
        res.end()
        log({
          at: new Date().toISOString(),
          plane: 'overlay',
          method: req.method,
          path: route,
          status: res.statusCode,
          ms: Date.now() - started,
          bytesIn: bodyBuffer.length,
          bytesOut,
          stream: isStream,
          ...routingFieldsOf(route, bodyBuffer),
        })
      })
    },
  )

  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, {'content-type': 'application/json'})
    res.end(JSON.stringify({ok: false, error: {code: 'E2E_RECORDER_UPSTREAM', message: String(error?.message ?? error)}}))
    log({
      at: new Date().toISOString(),
      plane: 'overlay',
      method: req.method,
      path: route,
      status: 502,
      ms: Date.now() - started,
      bytesIn: bodyBuffer.length,
      bytesOut: 0,
      upstreamError: true,
    })
  })

  /* The client can abort a held-open `/events` stream at any time; releasing the
   * upstream socket is what makes unsubscribe actually free the resource. */
  res.on('close', () => upstream.destroy())

  if (bodyBuffer.length > 0) upstream.write(bodyBuffer)
  upstream.end()
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/* ─────────────────────────────────────────────────────────────── public ── */

/**
 * Start the whole overlay plane: a clean root, the real server behind it, the
 * recorder in front, and a control socket that can reset the pair.
 */
export async function startOverlayHarness({
  root = OVERLAY_ROOT,
  logPath = OVERLAY_LOG,
  port = PORTS.overlayApi,
  upstreamPort = PORTS.overlayUpstream,
  controlPort = PORTS.control,
} = {}) {
  const log = makeLogger(logPath)

  let child = null

  async function bootUpstream({wipe}) {
    await stopChild(child)
    if (wipe) {
      rmSync(root, {recursive: true, force: true})
      mkdirSync(root, {recursive: true})
    }
    child = startRealServer({root, port: upstreamPort})
    await waitForUpstream(upstreamPort)
  }

  await bootUpstream({wipe: true})

  const recorder = createServer((req, res) => {
    void readBody(req)
      .then((bodyBuffer) => forward({req, res, upstreamPort, log, bodyBuffer}))
      .catch((error) => {
        if (!res.headersSent) res.writeHead(400)
        res.end(String(error?.message ?? error))
      })
  })
  /* Studio holds `/events` open indefinitely. */
  recorder.requestTimeout = 0
  recorder.headersTimeout = 0
  recorder.timeout = 0
  await new Promise((r) => recorder.listen(port, '127.0.0.1', r))

  const control = createServer((req, res) => {
    const route = pathOf(req.url)
    const reply = (status, body) => {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && route === '/health') {
      reply(200, {ok: true, root, logPath})
      return
    }
    if (req.method === 'POST' && route === '/reset') {
      void bootUpstream({wipe: true}).then(
        () => {
          log({at: new Date().toISOString(), plane: 'control', method: 'POST', path: '/reset', status: 200})
          reply(200, {ok: true, reset: true})
        },
        (error) => reply(500, {ok: false, error: String(error?.message ?? error)}),
      )
      return
    }
    reply(404, {ok: false, error: `no control route for ${req.method} ${route}`})
  })
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r))

  async function close() {
    await new Promise((r) => control.close(r))
    await new Promise((r) => recorder.close(r))
    await stopChild(child)
  }

  return {root, logPath, port, upstreamPort, controlPort, close}
}

/* Run directly: `node e2e/harness/overlayHarness.mjs` */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const harness = await startOverlayHarness()
  process.stdout.write(
    `[overlay-harness] recording :${harness.port} -> :${harness.upstreamPort}\n` +
      `[overlay-harness] root     ${harness.root}\n` +
      `[overlay-harness] log      ${harness.logPath}\n` +
      `[overlay-harness] control  http://127.0.0.1:${harness.controlPort}\n`,
  )
  const shutdown = () => void harness.close().then(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
