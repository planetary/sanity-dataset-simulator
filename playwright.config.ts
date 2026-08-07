/**
 * Studio E2E — the suite roadmap Phase 5 exits on.
 *
 * Read `e2e/README.md` first. The two decisions encoded here that are worth
 * stating up front:
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. THE SUITE STARTS THE STACK. It is not a precondition.
 *
 * Four processes have to agree on: which overlay root is being written, which
 * JSONL log the network audit will read, and which ports everything is on. A
 * hand-started stack gets one of those wrong silently, and the failure mode is
 * not a red test — it is a green run that audited the wrong file. That has
 * already happened twice on this project, both times by someone forgetting
 * `PROXY_LOG` and appending to the pinned 730-line evidence log.
 *
 * `reuseExistingServer` is **false everywhere**, including locally. A Studio
 * someone already had running has unknown env: possibly `mode: off`, possibly
 * pointed at `examples/kitchen-sink/.sanity-overlay/` — in which case the suite
 * would edit real committed overlay state and still pass. A busy port is a loud
 * failure telling you to stop your dev stack, and that is the correct trade.
 *
 * The one thing the suite cannot start is a Sanity account, which is why the
 * live project is opt-in (below).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. TWO MODES, ONE CONFIG, CHOSEN BY `E2E_MODE`.
 *
 *   E2E_MODE=local (default)  Mode 2 "origin". No Sanity project, no account,
 *                             no upstream socket at all — the proxy answers
 *                             everything from `.sanity-overlay/` on disk and
 *                             hands out a fabricated `local-dev` identity.
 *                             Hermetic: runs on any machine, in CI, offline.
 *                             "Staging is untouched" is *structural* here —
 *                             there is no staging to touch.
 *
 *   E2E_MODE=live             Mode 1 "proxy". A real project, a real login, the
 *                             data plane intercepted by the Track B proxy in
 *                             default-deny mode. This is the only mode that can
 *                             assert "staging is untouched" *against the
 *                             upstream API*, which is the assertion the exit
 *                             criterion actually asks for — so the two modes are
 *                             complements, not alternatives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHROMIUM ONLY, AND NOT AS A SHORTCUT.
 *
 * `@sanity/client` builds `<projectId>.<apiHost>`, so a Studio told
 * `apiHost: http://localhost:3999` requests `http://b1n03q3z.localhost:3999`.
 * Chromium and Firefox resolve `*.localhost` to loopback per RFC 6761; WebKit
 * does not, and the request never reaches the proxy. Adding WebKit would mean
 * an `/etc/hosts` entry as a precondition, which is exactly the class of hidden
 * setup this config exists to remove.
 */
import {defineConfig, devices} from '@playwright/test'

import {ensureRunDir} from './e2e/harness/runDir.mjs'
import {
  DATASET,
  KITCHEN_SINK,
  LOCAL_SITE,
  OVERLAY_ROOT,
  PORTS,
  PROJECT_ID,
  PROXY_LOG,
  REPO_ROOT,
  URLS,
} from './e2e/harness/paths.mjs'

/* Ordering-independent: this happens at config import, before any server. */
const RUN_STARTED_AT = ensureRunDir()

const MODE = process.env.E2E_MODE === 'live' ? 'live' : 'local'
const IS_CI = Boolean(process.env.CI)

/**
 * Environment every process in the stack shares.
 *
 * `SANITY_STUDIO_*` is the only prefix a Vite-built Studio bundle can see, so
 * the browser-facing settings are spelled that way; the servers read the bare
 * and `SANITY_`-prefixed forms. `overlayEnvValue` accepts all three, so setting
 * both spellings is coherent rather than redundant.
 *
 * Every value here is DECLARED, not inherited. `SANITY_STUDIO_DATASET` used to
 * be `process.env.SANITY_STUDIO_DATASET ?? 'parity'`, so a variable exported in
 * the developer's shell decided which dataset five processes agreed on — while
 * `PROJECT_ID` beside it came from the repo. The two could disagree, and the
 * disagreement would be invisible.
 */
const SHARED_ENV: Record<string, string> = {
  SANITY_STUDIO_PROJECT_ID: PROJECT_ID,
  SANITY_STUDIO_DATASET: DATASET,

  SANITY_STUDIO_OVERLAY_MODE: 'fs',
  SANITY_OVERLAY_MODE: 'fs',
  SANITY_STUDIO_OVERLAY_API_URL: URLS.overlayApi,
  SANITY_STUDIO_OVERLAY_API_HOST: URLS.proxy,

  /* The run's own overlay root. NOT `examples/kitchen-sink`, which holds
   * committed overlay state the suite must never write to. */
  OVERLAY_ROOT,
  SANITY_OVERLAY_ROOT: OVERLAY_ROOT,
  SPIKE_OVERLAY_ROOT: OVERLAY_ROOT,

  /* NEVER the pinned log. */
  PROXY_LOG,
  PROXY_BLOCK_WRITES: '1',
}

/**
 * The transport proxy.
 *
 * `local` runs it in origin mode, which refuses any bind but loopback and needs
 * `--origin` typed explicitly — a synthetic fully-granted identity is not
 * something a config should be able to imply.
 */
const proxyServer =
  MODE === 'live'
    ? {
        command: `node examples/kitchen-sink/spikeB-proxy/proxy.mjs`,
        env: {...SHARED_ENV, PROXY_PORT: String(PORTS.proxy)},
      }
    : {
        command:
          `node examples/kitchen-sink/spikeB-proxy/runOrigin.mjs --origin` +
          ` --root=${OVERLAY_ROOT} --port=${PORTS.proxy} --bind=127.0.0.1` +
          ` --project=${PROJECT_ID} --log=${PROXY_LOG}`,
        env: {...SHARED_ENV, OVERLAY_BASE: 'none'},
      }

export default defineConfig({
  testDir: './e2e/specs',
  /* `live/` needs credentials; `local/` needs the origin server. Never both. */
  testIgnore: MODE === 'live' ? ['**/local/**'] : ['**/live/**'],

  outputDir: './e2e/.artifacts/run/test-results',

  /**
   * SERIAL, DELIBERATELY. Specs reset the overlay between them by restarting the
   * overlay server against an emptied root; two workers doing that concurrently
   * would delete each other's documents mid-assertion. There is one Studio, one
   * overlay, one proxy — the stack is not shardable, and pretending otherwise
   * buys minutes and costs the determinism the whole suite is for.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: 0,

  /* Studio is a Vite dev server behind a proxy; first paint is not fast. */
  timeout: 90_000,
  expect: {timeout: 20_000},

  reporter: IS_CI
    ? [['github'], ['list'], ['html', {outputFolder: './e2e/.artifacts/run/report', open: 'never'}]]
    : [['list'], ['html', {outputFolder: './e2e/.artifacts/run/report', open: 'never'}]],

  use: {
    baseURL: URLS.studio,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    /* No stored session: the Spike A path in `sanity.config.ts` activates on ANY
     * non-blank `SPIKE_*` key in localStorage, and it replaces the entire
     * product path — no `defineOverlayConfig`, no banner, no feature filtering.
     * A leaked storage state would silently test a different program. */
    storageState: undefined,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            /**
             * EGRESS CONTROL, at the browser rather than in the page.
             *
             * In `local` mode nothing may reach Sanity, and the strongest way to
             * say so is to make it unroutable: any direct request to a Sanity
             * host fails at DNS. If the Studio still boots and edits still land,
             * that is proof by construction that no code path depended on direct
             * egress — a claim no page-side listener can make, and the exact
             * claim CDP capture got wrong when it found four `POST
             * api.sanity.io/vX/intake/feedback` going direct.
             *
             * `*.localhost` must stay resolvable: the proxy's browser-facing
             * origin is `b1n03q3z.localhost:3999`.
             */
            ...(MODE === 'local'
              ? ['--host-resolver-rules=MAP *.sanity.io ~NOTFOUND, MAP sanity.io ~NOTFOUND']
              : []),
          ],
        },
      },
    },
  ],

  webServer: [
    {
      ...proxyServer,
      cwd: REPO_ROOT,
      /* Port rather than URL: the proxy has no local health route, and in live
       * mode `/vX/ping` is answered by Sanity, so a URL check would make the
       * suite's readiness depend on the internet. */
      port: PORTS.proxy,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      /* The recording pass-through plus the real overlay server behind it. Its
       * control port answers only once the child reports healthy. */
      command: 'node e2e/harness/overlayHarness.mjs',
      cwd: REPO_ROOT,
      env: SHARED_ENV,
      url: `${URLS.control}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm exec sanity dev',
      cwd: KITCHEN_SINK,
      env: SHARED_ENV,
      /* 3333 is not negotiable — the overlay API grants CORS to exactly
       * `http://localhost:3333`. A Studio that fell back to 3334 would fail
       * every `/state` and `/commit` and the banner would sit in `offline`,
       * which looks like a product bug and is not one. */
      url: URLS.studio,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node --experimental-strip-types run.mjs',
      cwd: LOCAL_SITE,
      env: {...SHARED_ENV, SANITY_OVERLAY_MODE: 'fs', SITE_PORT: String(PORTS.siteBranch)},
      url: URLS.siteBranch,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      /* The same code, same base dataset, one environment variable apart. */
      command: 'node --experimental-strip-types run.mjs --mode=off',
      cwd: LOCAL_SITE,
      env: {...SHARED_ENV, SANITY_OVERLAY_MODE: 'off', SITE_PORT: String(PORTS.siteStaging)},
      url: URLS.siteStaging,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

  metadata: {mode: MODE, runStartedAt: RUN_STARTED_AT, overlayRoot: OVERLAY_ROOT, proxyLog: PROXY_LOG},
})
