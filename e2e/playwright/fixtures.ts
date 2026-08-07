/**
 * Fixtures: a clean overlay per spec, and the two helpers every spec needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESET IS A SERVER RESTART, NOT A `rm -rf`.
 *
 * Deleting `.sanity-overlay/` under a live overlay server is not safe:
 * `FsOverlayStore` holds an open manifest and serialises commits through one
 * promise chain, so a directory that vanishes mid-queue produces errors that
 * look like product bugs. The harness therefore stops the server, empties the
 * root, and starts it again — `openOverlay(..., {ifNotExists: true})`
 * re-initialises an empty directory, so there is no seed fixture to drift and
 * nothing is copied out of `examples/`.
 *
 * It costs about a second per spec. A suite that leaves state behind rots within
 * a week; a suite that is one second slower does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE FIXTURES DELIBERATELY DO NOT DO.
 *
 * They never assert. Every assertion lives in a spec, against the DOM, the disk,
 * or a server log — never against a value this file computed. The oracle problem
 * on this project has always been the same one: a helper that both performs the
 * edit and reports that it worked.
 */
import {test as base, expect} from '@playwright/test'

import {OVERLAY_ROOT, URLS} from '../harness/paths.mjs'
import {
  type OverlayIntent,
  type OverlayManifest,
  overlayDocumentIds,
  readIntent,
  readManifest,
  transactionIds,
  waitForDisk,
} from './disk'
import {OVERLAY_BANNER, STUDIO, documentUrl} from './selectors'

export interface OverlayHandle {
  readonly root: string
  /** Stop the overlay server, empty the root, start it again. */
  reset(): Promise<void>
  manifest(): OverlayManifest | null
  intent(logicalId: string): OverlayIntent | null
  ids(): string[]
  transactions(): string[]
  /** Poll the disk until `logicalId` has an intent satisfying `predicate`. */
  waitForIntent(
    logicalId: string,
    predicate: (intent: OverlayIntent) => boolean,
    options?: {timeout?: number; what?: string},
  ): Promise<OverlayIntent>
  /** Poll the disk until `logicalId` has no intent at all. */
  waitForAbsent(logicalId: string, options?: {timeout?: number}): Promise<void>
}

export interface StudioHandle {
  /** Navigate to the Studio root and wait for the overlay banner to render. */
  open(): Promise<void>
  /** Deep-link to one document's pane and wait for its form. */
  openDocument(type: string, id: string): Promise<void>
}

export const test = base.extend<{overlay: OverlayHandle; studio: StudioHandle}>({
  overlay: async ({}, use) => {
    const handle: OverlayHandle = {
      root: OVERLAY_ROOT,

      async reset() {
        const response = await fetch(`${URLS.control}/reset`, {method: 'POST'})
        if (!response.ok) {
          throw new Error(`overlay reset failed: ${response.status} ${await response.text()}`)
        }
      },

      manifest: () => readManifest(OVERLAY_ROOT),
      intent: (logicalId) => readIntent(logicalId, OVERLAY_ROOT),
      ids: () => overlayDocumentIds(OVERLAY_ROOT),
      transactions: () => transactionIds(OVERLAY_ROOT),

      async waitForIntent(logicalId, predicate, options = {}) {
        const intent = await waitForDisk(
          () => readIntent(logicalId, OVERLAY_ROOT),
          (value): value is OverlayIntent => value !== null && predicate(value),
          {
            timeout: options.timeout ?? 25_000,
            what: options.what ?? `intent.json for "${logicalId}" on disk`,
          },
        )
        return intent as OverlayIntent
      },

      async waitForAbsent(logicalId, options = {}) {
        await waitForDisk(
          () => readIntent(logicalId, OVERLAY_ROOT),
          (value) => value === null,
          {timeout: options.timeout ?? 25_000, what: `"${logicalId}" to disappear from the overlay`},
        )
      },
    }

    /* Before the spec, not after: a failed spec leaves its overlay on disk for
     * whoever is debugging it, and the next spec still starts clean. */
    await handle.reset()
    await use(handle)
  },

  studio: async ({page}, use) => {
    /**
     * The escape hatch that would silently test a different program.
     *
     * `examples/kitchen-sink/sanity.config.ts` falls back to the Spike A path if
     * ANY `SPIKE_*` key is a non-blank string in `localStorage` — and on that
     * path `defineOverlayConfig` never runs: no banner, no feature filtering, no
     * `__SANITY_OVERLAY__`. A fresh Playwright context has empty storage, so
     * this cannot happen today; the guard is here because the four-terminal
     * recipe in `examples/local-site/README.md` tells a human to set exactly
     * those flags, and someone will eventually run the suite against a profile
     * that has them.
     */
    await page.addInitScript(() => {
      for (const flag of [
        'SPIKE_LOCAL_ECHO',
        'SPIKE_API_HOST',
        'SPIKE_INSTRUMENT',
        'SPIKE_OVERLAY_PERSIST',
        'SPIKE_STRICT_QUERIES',
      ]) {
        try {
          window.localStorage.removeItem(flag)
        } catch {
          /* storage may be unavailable before first navigation; harmless */
        }
      }
    })

    const handle: StudioHandle = {
      async open() {
        await page.goto('/', {waitUntil: 'domcontentloaded'})
        /* The banner is the product path's signature: it renders only when
         * `defineOverlayConfig` registered a runtime. Waiting for it is
         * therefore also the assertion that the product path booted. */
        await expect(page.getByTestId(OVERLAY_BANNER)).toBeVisible({timeout: 60_000})
      },

      async openDocument(type, id) {
        await page.goto(documentUrl(type, id), {waitUntil: 'domcontentloaded'})
        await expect(page.getByTestId(OVERLAY_BANNER)).toBeVisible({timeout: 60_000})
        await expect(page.getByTestId(STUDIO.documentPane).first()).toBeVisible({timeout: 60_000})
      },
    }

    await use(handle)
  },
})

export {expect}
