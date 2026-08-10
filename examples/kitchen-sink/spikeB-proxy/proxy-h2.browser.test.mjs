/**
 * THE SIX-SOCKET CEILING, MEASURED AGAINST THE SHIPPING PROXY — and the HTTP/2
 * listener that lifts it.
 *
 *     node --test examples/kitchen-sink/spikeB-proxy/proxy-h2.browser.test.mjs
 *
 * Needs a browser (it downloads nothing; it uses the Chromium Playwright already
 * installed) and no running stack: the upstream is a small SSE server stood up
 * inside the test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A BROWSER, AND WHY THIS FILE IS NOT IN THE VITEST SUITE
 *
 * The claim under test is not about this repository's code. It is about what
 * CHROMIUM does with a plain-HTTP/1.1 origin asked for more than six concurrent
 * long-lived responses, and no assertion over Node sockets can establish it:
 * Node's own agent is `maxSockets: Infinity` and would happily open a hundred.
 * `packages/sanity-overlay-testkit/test/proxy-concurrency.test.ts` models the
 * budget with `new http.Agent({maxSockets: 6})` — faithful, but a model. The
 * oracle here is the browser, and every count it is checked against is read
 * from the SERVER, which the page cannot influence.
 *
 * It lives here, and runs under `node --test`, for the same reason
 * `e2e/harness/dataPlaneFront.test.mjs` does: `@playwright/test` is declared by
 * the repository root, not by `sanity-overlay-testkit`, and
 * `test/repo-manifests.test.ts` correctly refuses a package that imports what
 * it has not declared. The protocol-class tests that need no browser DO live in
 * the vitest suite, as `test/proxy-h2.test.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO ARMS
 *
 * ARM 1 is the bug report, and it runs against `createProxyServer()` — the
 * shipping entry point, unchanged. Twelve `EventSource`s, six reach `welcome`,
 * six sit in `readyState 0` forever, the follow-up `fetch` never resolves, and
 * the proxy accepts exactly six TCP connections. In a real Studio the seventh
 * request is the document pair's initial snapshot
 * (`GET /data/doc/<ds>/<id>,drafts.<id>`), so `editState` never becomes ready,
 * the pane sits on *Loading document…* and then flips to a read-only
 * *reconnecting* form, and no keystroke can be typed.
 *
 * If arm 1 ever stops capping at six — a Chromium that changed its budget, an
 * origin that stopped holding streams open — then the h2 listener has no reason
 * to exist, and this says so out loud rather than leaving dead machinery in the
 * product.
 *
 * ARM 2 is the requirement. Against the same proxy reached over TLS on the SAME
 * PORT, the browser negotiates h2, all twelve listener streams open as streams
 * on one session, a thirteenth ordinary request still answers promptly, and the
 * log — read back from disk by a separate process — accounts for every one of
 * them with a disposition.
 *
 * Both arms run with the write guard ON, which is the Mode 1 shipping
 * configuration.
 */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import {chromium} from '@playwright/test'

import {createProxyServer, createProxyStack} from './proxy.mjs'

/** Comfortably above Chromium's six. */
const STREAMS = 12

/** Chromium's per-origin HTTP/1.1 connection budget. Not a tunable of ours. */
const BROWSER_MAX_SOCKETS_PER_HOST = 6

/**
 * The hostname `@sanity/client` really builds: it appends the project id as a
 * label to the configured `apiHost`, so the browser asks for
 * `b1n03q3z.localhost` and the certificate has to cover that exact name.
 */
const PROJECT_HOST = 'b1n03q3z.localhost'
const DATASET = 'parity'
const PING = '/v2025-02-19/ping'
const LISTEN = `/v2025-02-19/data/listen/${DATASET}`

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-h2-browser-'))

/**
 * The log oracle, run in a SEPARATE PROCESS.
 *
 * Reading the bytes back from another interpreter is what makes the assertion
 * independent: nothing in the proxy's process — no spy, no captured array, no
 * value this test computed — stands between it and what is on disk.
 */
const READ_LOG = path.join(TMP, 'read-log.cjs')
fs.writeFileSync(
  READ_LOG,
  `const fs = require('node:fs')
const [file, listenPath] = process.argv.slice(2)
const rows = fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  : []
const requests = rows.filter((row) => row.frame !== true)
process.stdout.write(
  JSON.stringify({
    total: requests.length,
    listens: requests.filter((row) => row.path === listenPath).length,
    undecided: requests.filter(
      (row) => row.disposition !== 'local' && row.disposition !== 'upstream',
    ).length,
    h2: requests.filter((row) => row.h2 === true).length,
  }),
)
`,
)

const teardowns = []

/* ------------------------------------------------------------------ *
 * a mock Content Lake that holds streams open
 * ------------------------------------------------------------------ */

async function startMockUpstream() {
  const held = new Set()
  const server = http.createServer((req, res) => {
    if (String(req.url).includes('/data/listen/')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('event: welcome\ndata: {"listenerName":"mock"}\n\n')
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    const body = JSON.stringify({ok: true})
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  server.timeout = 0
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = () =>
    new Promise((resolve) => {
      for (const res of held) res.destroy()
      server.closeAllConnections?.()
      server.close(resolve)
    })
  teardowns.push(close)
  return {origin: `http://127.0.0.1:${server.address().port}`, held: () => held.size}
}

/* ------------------------------------------------------------------ *
 * the measurement, run inside the page
 * ------------------------------------------------------------------ */

/**
 * Ask one page for `STREAMS` concurrent event streams and then — with every one
 * of them still open — time one ordinary request.
 *
 * The streams are deliberately LEFT OPEN when this resolves: the caller asserts
 * on how many the upstream is holding, and closing them here would make that
 * count zero. Tearing down the browser context is what releases them.
 */
function measure(page, base) {
  return page.goto(`${base}${PING}`).then(() =>
    page.evaluate(
      async ({n, listen, ping}) => {
        const opened = new Set()
        for (let index = 0; index < n; index += 1) {
          const source = new EventSource(`${listen}?i=${index}`)
          source.addEventListener('welcome', () => opened.add(index))
        }
        await new Promise((resolve) => setTimeout(resolve, 4000))

        const startedAt = performance.now()
        let followUpMs = -1
        try {
          await Promise.race([
            fetch(`${ping}?after=1`).then(() => {
              followUpMs = Math.round(performance.now() - startedAt)
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('queued')), 5000)),
          ])
        } catch {
          followUpMs = -1
        }

        const nav = performance.getEntriesByType('navigation')[0]
        return {opened: opened.size, protocol: nav?.nextHopProtocol ?? '?', followUpMs}
      },
      {n: STREAMS, listen: LISTEN, ping: PING},
    ),
  )
}

describe('spikeB-proxy · the six-connection ceiling and the h2 listener that lifts it', () => {
  let browser

  before(async () => {
    browser = await chromium.launch()
  })

  after(async () => {
    await browser?.close()
    while (teardowns.length) await teardowns.pop()()
  })

  /* ---------------------------------------------------------------- *
   * ARM 1 — the defect, against the shipping entry point
   * ---------------------------------------------------------------- */

  it('CONTROL: over HTTP/1.1 six of twelve streams open and everything after queues forever', async () => {
    const upstream = await startMockUpstream()
    const server = createProxyServer({
      env: {},
      upstream: upstream.origin,
      logPath: path.join(TMP, 'arm1.jsonl'),
      blockWrites: true,
      /* The mock upstream is an IP. Left on, the `<project>.localhost` ->
       * `<project>.api.sanity.io` rewrite would turn `127.0.0.1` into
       * `b1n03q3z.0.0.1` and every request would 502; `test/proxy-h2.test.ts`
       * is where the derivation itself is exercised. */
      deriveProjectHost: false,
    })
    /* The independent oracle: TCP connections counted by the SERVER. */
    const sockets = new Set()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address()
    teardowns.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections?.()
          server.close(resolve)
        }),
    )

    const context = await browser.newContext()
    const page = await context.newPage()
    const result = await measure(page, `http://${PROJECT_HOST}:${port}`)
    const socketsAtPeak = sockets.size
    const heldAtPeak = upstream.held()
    await context.close()

    assert.equal(result.protocol, 'http/1.1')
    assert.equal(
      result.opened,
      BROWSER_MAX_SOCKETS_PER_HOST,
      `Chromium's per-origin HTTP/1.1 budget is why the h2 listener exists; the page opened ` +
        `${result.opened} of ${STREAMS}. If this is no longer 6, re-read the header of ` +
        `tlsMaterial.mjs — the listener may no longer be needed.`,
    )
    assert.equal(socketsAtPeak, BROWSER_MAX_SOCKETS_PER_HOST, 'six sockets, counted by the server')
    assert.equal(heldAtPeak, BROWSER_MAX_SOCKETS_PER_HOST, 'and six streams held upstream')
    assert.equal(
      result.followUpMs,
      -1,
      'and the seventh request — in the real Studio, the document pair snapshot — never issues',
    )
  })

  /* ---------------------------------------------------------------- *
   * ARM 2 — the requirement
   * ---------------------------------------------------------------- */

  it('through the h2 listener all twelve open, a further request still answers, and the log accounts for every one', async () => {
    const upstream = await startMockUpstream()
    const logPath = path.join(TMP, 'arm2.jsonl')
    const stack = createProxyStack({
      env: {},
      upstream: upstream.origin,
      logPath,
      blockWrites: true,
      deriveProjectHost: false,
      tlsDir: fs.mkdtempSync(path.join(TMP, 'tls-')),
      /* Pin the machine-independent rung: which certificate a developer's
       * machine would choose is decided by `planTlsMaterial`, which
       * `test/proxy-h2.test.ts` tests as a function. */
      tlsCertSource: 'self-signed',
    })
    /* Two server-side oracles. `connections` counts accepted TCP connections;
     * `streamsPerSession` counts requests carried by each h2 session.
     * Multiplexing is the claim, and the claim is "one connection carried all
     * twelve" — not "exactly one connection existed", because Chrome also
     * preconnects. */
    let connections = 0
    const streamsPerSession = []
    stack.listener.on('connection', () => {
      connections += 1
    })
    stack.secure.on('session', (session) => {
      const index = streamsPerSession.push(0) - 1
      session.on('stream', () => {
        streamsPerSession[index] += 1
      })
    })
    const {port} = await stack.listen(0, '127.0.0.1')
    teardowns.push(() => stack.close())

    /* `ignoreHTTPSErrors` because the certificate minted above is self-signed
     * and nothing may add a trust anchor to the machine running a test. What a
     * developer does instead is the subject of `tlsMaterial.mjs`'s ladder. */
    const context = await browser.newContext({ignoreHTTPSErrors: true})
    const page = await context.newPage()
    const result = await measure(page, `https://${PROJECT_HOST}:${port}`)
    /* Read WHILE the streams are open. The proxy is a relay, not a fake:
     * twelve browser streams must be twelve held-open responses UPSTREAM. */
    const heldAtPeak = upstream.held()
    const connectionsAtPeak = connections
    await context.close()

    assert.equal(result.protocol, 'h2', 'the browser must have negotiated HTTP/2')
    assert.equal(result.opened, STREAMS, 'every listener stream must reach `welcome`')
    assert.equal(heldAtPeak, STREAMS, `the upstream must be holding ${STREAMS} streams`)
    assert.ok(
      result.followUpMs >= 0,
      'a request made while every listener is open must not be queued behind them',
    )
    assert.ok(
      Math.max(...streamsPerSession) >= STREAMS,
      `one h2 session must have carried all ${STREAMS} streams; the most any carried was ` +
        `${Math.max(...streamsPerSession)}`,
    )
    assert.ok(
      connectionsAtPeak < BROWSER_MAX_SOCKETS_PER_HOST,
      `twice the streams for fewer than ${BROWSER_MAX_SOCKETS_PER_HOST} connections; took ` +
        `${connectionsAtPeak}`,
    )

    /* A listen row is written when the stream ENDS, which is what closing the
     * browser context just did — so this polls rather than assuming the flush
     * has already happened. */
    const readLog = () =>
      JSON.parse(execFileSync(process.execPath, [READ_LOG, logPath, LISTEN], {encoding: 'utf8'}))
    let log = readLog()
    for (let attempt = 0; attempt < 50 && log.listens < STREAMS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      log = readLog()
    }

    assert.equal(log.listens, STREAMS, 'every stream must have produced a log record')
    assert.equal(
      log.undecided,
      0,
      'and every record must say what happened to its bytes — a record without a ' +
        'disposition reads as `unknown` to the network audit (predicates A10)',
    )
    assert.ok(log.h2 >= STREAMS, 'and must be recorded as what it was: an h2 stream')
  })
})
