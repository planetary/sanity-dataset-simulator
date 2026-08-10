/**
 * Every path and port the E2E stack uses, in one place.
 *
 * WHY A FIXED RUN DIRECTORY AND NOT A TIMESTAMPED ONE
 * ───────────────────────────────────────────────────
 * Playwright runs specs in worker processes that do not share module state, so a
 * run id minted at import time would differ per worker and every worker would
 * audit a different log. A single fixed directory, wiped once by global setup,
 * gives every process the same answer without any coordination — and it is also
 * the "self-cleaning" property: the run before this one cannot survive into it,
 * because the first thing the suite does is delete this tree.
 *
 * THE ONE PATH THAT IS NEVER WRITTEN
 * ──────────────────────────────────
 * `PINNED_PROXY_LOG` is committed evidence of a 2026-08-04 session and a suite
 * assertion pins it at exactly 730 lines. It appears here ONLY so the audit can
 * assert it was not touched. Nothing in `e2e/` may ever open it for writing —
 * `PROXY_LOG` is always pointed into `.artifacts/run/`.
 */
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Wiped at the start of every run. Nothing durable lives here. */
export const RUN_DIR = resolve(E2E_ROOT, '.artifacts/run')

/** The directory that CONTAINS `.sanity-overlay/`. Self-initialises when empty. */
export const OVERLAY_ROOT = resolve(RUN_DIR, 'overlay-root')

/** Server-side logs — the only evidence the network audit will look at. */
export const PROXY_LOG = resolve(RUN_DIR, 'proxy-log.jsonl')
export const OVERLAY_LOG = resolve(RUN_DIR, 'overlay-log.jsonl')

/**
 * Where the proxy mints the certificate its HTTP/2 listener serves.
 *
 * INSIDE THE RUN DIRECTORY, which is wiped at the start of every run, so the key
 * is thrown away with it and nothing durable or trusted is ever created on the
 * machine. `PROXY_TLS_SOURCE=self-signed` pins the rung as well: the `auto`
 * ladder would use `mkcert` when a developer happens to have it installed and
 * `openssl` when they do not, and a suite must not measure a different thing on
 * a different laptop. mkcert is also wrong for CI on its own terms — its trust
 * rung needs `mkcert -install`, which writes to the system trust store and asks
 * for a password, and `tlsMaterial.mjs` says out loud that it will not run it
 * for you. The browser context sets `ignoreHTTPSErrors`, which is what makes a
 * throwaway self-signed certificate the correct unattended answer.
 */
export const PROXY_TLS_DIR = resolve(RUN_DIR, 'tls')

/** Written by global setup; carries the timestamp the freshness predicates use. */
export const RUN_MANIFEST = resolve(RUN_DIR, 'run.json')

/** COMMITTED EVIDENCE. Read-only, forever. 730 lines. */
export const PINNED_PROXY_LOG = resolve(
  REPO_ROOT,
  'examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl',
)
export const PINNED_PROXY_LOG_LINES = 730

export const KITCHEN_SINK = resolve(REPO_ROOT, 'examples/kitchen-sink')
export const LOCAL_SITE = resolve(REPO_ROOT, 'examples/local-site')

/**
 * Ports.
 *
 * 3333 is not negotiable: the overlay API grants CORS to `http://localhost:3333`
 * and one origin only, so a Studio that fell back to 3334 would fail every
 * `/state` and `/commit` call and the banner would sit in `offline` — a failure
 * that looks like a product bug and is not one. The config therefore refuses to
 * reuse or shift ports; a busy 3333 is a loud error, by design.
 */
export const PORTS = Object.freeze({
  studio: 3333,
  /**
   * The transport proxy (Track B), and Studio's `apiHost`. ONE PORT, BOTH
   * FRAMINGS.
   *
   * Chromium allows six concurrent HTTP/1.1 connections per origin and
   * `sanity@6.8.0` holds six listener streams open against the data host, so
   * over HTTP/1.1 the seventh request — the document pair's initial snapshot —
   * is queued forever and no pane ever loads. Content Lake is HTTP/2 and has no
   * such limit.
   *
   * The suite used to fix that with its own TLS+h2 terminator on 3995
   * (`dataPlaneFront.mjs`), relaying here over HTTP/1.1. The proxy now
   * terminates h2 itself — `createProxyStack` peeks the first byte of every
   * connection and hands a TLS ClientHello (0x16) to `http2.createSecureServer`
   * and everything else to the HTTP/1.1 server, on this one socket. So the
   * workaround is gone, and with it the last thing standing between the browser
   * and the component under test: what the network audit reads is now written by
   * the process the browser actually spoke to.
   */
  proxy: 3999,
  /** What the Studio talks to. The recording pass-through, not the real server. */
  overlayApi: 3998,
  /** The real overlay server, behind the recorder. Never addressed by a browser. */
  overlayUpstream: 3997,
  /** Harness control plane: reset between specs. Never addressed by a browser. */
  control: 3996,
  /** The consumer site, reading the branch overlay. */
  siteBranch: 4000,
  /** The same site with `mode: off` — the staging view. */
  siteStaging: 4001,
})

export const URLS = Object.freeze({
  studio: `http://localhost:${PORTS.studio}`,
  /** Cleartext, for anything on this host that speaks HTTP/1.1 to the proxy. */
  proxy: `http://localhost:${PORTS.proxy}`,
  /**
   * What the browser is told, and the same socket as `proxy`. TLS, because
   * browsers only negotiate h2 over TLS.
   */
  dataPlane: `https://localhost:${PORTS.proxy}`,
  overlayApi: `http://localhost:${PORTS.overlayApi}`,
  control: `http://127.0.0.1:${PORTS.control}`,
  siteBranch: `http://127.0.0.1:${PORTS.siteBranch}`,
  siteStaging: `http://127.0.0.1:${PORTS.siteStaging}`,
})

/**
 * The Sanity project the kitchen-sink Studio is configured for.
 *
 * DECLARED HERE, IN THE REPOSITORY — NOT READ FROM THE ENVIRONMENT.
 * ────────────────────────────────────────────────────────────────
 * These used to be `process.env.SANITY_STUDIO_PROJECT_ID || 'b1n03q3z'`. That
 * let a variable exported in a developer's shell — for a different repository,
 * from a `~/.zshrc`, from a CI runner — silently repoint the *whole* E2E stack:
 * the proxy's project hostname, the browser origin, and, worst, `upstream.ts`'s
 * before/after fingerprints. A live run would then have asserted "staging is
 * untouched" about a dataset the Studio never spoke to. The e2e README already
 * names that failure mode: *"a green run that audited the wrong file"*.
 *
 * There is exactly one project this harness drives, and this line is where it is
 * said. `upstream.ts` cross-checks the repo-root `.env` against these constants
 * and refuses on disagreement, so the live oracle and the harness cannot drift
 * apart quietly either.
 *
 * `.mjs` is why the declaration lives here rather than being read through the
 * explicit loader: this module is imported by plain-Node scripts
 * (`e2e/audit/runAudit.mjs`, `node --test e2e/**`) that cannot import a `.ts`.
 */
export const PROJECT_ID = 'b1n03q3z'
export const DATASET = 'parity'
export const API_VERSION = '2025-02-19'

/**
 * `@sanity/client` does not use `apiHost` verbatim: with `useProjectHostname`
 * (the default) it builds `<projectId>.<apiHost>`. So a Studio told
 * `apiHost: https://localhost:3999` actually requests
 * `https://b1n03q3z.localhost:3999`. Chromium resolves `*.localhost` to loopback
 * per RFC 6761; WebKit does not, which is why the suite is Chromium-only.
 *
 * The proxy's certificate therefore has to carry this EXACT name, not just a
 * `DNS:*.localhost` wildcard: `*.localhost` has a single-label parent, which is
 * the wildcard shape verifiers decline (`tlsMaterial.mjs` has the measurement).
 * `browserHostnames()` derives its extra names from the configured upstream,
 * which Mode 2 does not have — so the config passes this one explicitly through
 * `PROXY_TLS_NAMES`.
 */
export const PROXY_BROWSER_ORIGIN = `https://${PROJECT_ID}.localhost:${PORTS.proxy}`
