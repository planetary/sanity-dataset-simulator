/**
 * SCENARIO 7 — a guard 403 does NOT log the editor out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT, observed live on 2026-08-06.
 *
 * Studio booted against the write-blocking proxy and rendered
 *
 *     "Your Sanity session is no longer authenticated.
 *      Editing is read-only until the token refreshes."
 *
 * The session was fine. The proxy log for that session held exactly two 4xx
 * responses and both were **our own write guard doing its job**:
 *
 *     403 POST /v2025-02-19/descriptors/claim     (uploadSchema)
 *     403 POST /v2023-12-18/intake/batch          (telemetry ingest)
 *
 * `echo.ts` saw a 403 and ended the session, because `AUTH_STATUSES` was
 * `{401, 403}` and nothing else was consulted. A refusal *this system produced*
 * was read as *Sanity revoking the editor's credential*.
 *
 * `studio-guard-refusals.test.ts` pins the whole class at the unit layer against
 * the real `@sanity/client` `ClientError` and the literal 4xx bodies the guards
 * send. What it cannot do is drive the actual browser session through an actual
 * 403 from an actual proxy and look at the actual banner — which is the only
 * place the symptom ever appeared.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DISCRIMINATOR IS ORIGIN, NOT STATUS.
 *
 * A genuine 401 from Sanity, and a genuine 403 meaning *your token lacks this
 * grant*, MUST still end the session. So the fix could not be "ignore 403". It
 * is that this system stamps its own refusals — an `OVERLAY_*` error code on the
 * JSON its guards answer with — and only those are exempted. The last test in
 * this file asserts that half, so a future "fix" that simply stopped observing
 * 403s would break here.
 */
import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {HEADLINE, OVERLAY_BANNER, bannerState, refreshOverlay} from '../../playwright/selectors'
import {PROJECT_ID, PORTS} from '../../harness/paths.mjs'

/** The proxy's browser-facing origin: `@sanity/client` prepends the project id. */
const PROXY_ORIGIN = `http://${PROJECT_ID}.localhost:${PORTS.proxy}`

/**
 * The two endpoints that produced the false logout, plus the mutation plane.
 *
 * `credentials: 'omit'` on every probe. The guard blocks *before* the upstream
 * socket is dialled, so a blocked probe carries no credential anywhere; if the
 * guard were to fail, the escaped request arrives unauthenticated and 401s
 * instead of writing. The point is to evidence the guard, not to gamble a
 * dataset — and in `local` mode there is no upstream at all.
 */
const REFUSED_PROBES = [
  ['POST', '/v2025-02-19/descriptors/claim'],
  ['POST', '/v2023-12-18/intake/batch'],
  ['POST', '/v2025-02-19/data/mutate/parity'],
  ['POST', '/v2025-02-19/data/actions/parity'],
] as const

test.describe('a refusal this system issued is not a failure of the user’s session', () => {
  test('the guard really does refuse these, with an OVERLAY_* code', async ({page, studio}) => {
    await studio.open()

    const results = await page.evaluate(
      async ({origin, probes}) => {
        const out: Array<{path: string; status: number | string; code?: string; body?: string}> = []
        for (const [method, path] of probes) {
          try {
            const response = await fetch(origin + path, {method, credentials: 'omit'})
            const text = await response.text()
            let code: string | undefined
            try {
              code = JSON.parse(text)?.error?.code
            } catch {
              code = undefined
            }
            out.push({path, status: response.status, code, body: text.slice(0, 200)})
          } catch (error) {
            out.push({path, status: 'NETWORK_ERROR', body: String(error)})
          }
        }
        return out
      },
      {origin: PROXY_ORIGIN, probes: REFUSED_PROBES as unknown as string[][]},
    )

    for (const result of results) {
      expect(result.status, `${result.path} should have been refused: ${result.body}`).toBe(403)
      expect(
        String(result.code ?? ''),
        `${result.path} must carry an OVERLAY_* code — that code is the ONLY thing that ` +
          `distinguishes our refusal from Sanity revoking the credential`,
      ).toMatch(/^OVERLAY_/)
    }

    /* The browser-side statuses above are a convenience, not the evidence.
     * `99-network-audit.spec.ts` asserts the same refusals from the proxy's own
     * server-side log, which is the artefact this project trusts. */
  })

  test('the banner does NOT report the session as lost after those 403s', async ({page, studio}) => {
    await studio.open()
    await expect(page.getByTestId(OVERLAY_BANNER)).toHaveAttribute('data-overlay-state', 'healthy')

    await page.evaluate(
      async ({origin, probes}) => {
        for (const [method, path] of probes) {
          await fetch(origin + path, {method, credentials: 'omit'}).catch(() => undefined)
        }
      },
      {origin: PROXY_ORIGIN, probes: REFUSED_PROBES as unknown as string[][]},
    )

    await refreshOverlay(page)

    const banner = page.getByTestId(OVERLAY_BANNER)
    await expect(banner).not.toContainText(HEADLINE.sessionLost)
    await expect(banner).not.toContainText(HEADLINE.loggedOut)
    expect(await bannerState(page)).not.toBe('unauthenticated')
    await expect(banner).toHaveAttribute('data-overlay-state', 'healthy')
  })

  test('and editing still works afterwards — read-only is the symptom, not just the banner', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-guard-403-still-editable'
    await studio.open()

    await page.evaluate(
      async ({origin, probes}) => {
        for (const [method, path] of probes) {
          await fetch(origin + path, {method, credentials: 'omit'}).catch(() => undefined)
        }
      },
      {origin: PROXY_ORIGIN, probes: REFUSED_PROBES as unknown as string[][]},
    )

    await studio.openDocument('article', id)
    await setField(page, 'Title', 'Still editable after a guard refusal')
    await waitForSettled(page)

    /* The disk is the proof. A session marked unauthenticated stops
     * acknowledging writes, so an intent file appearing here is the strongest
     * available statement that the false logout did not happen. */
    await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title']) === 'Still editable after a guard refusal',
      {what: 'a write to succeed AFTER the guard refusals'},
    )
  })

  /**
   * THE OTHER HALF, which the fix must not break.
   *
   * A genuine upstream 401/403 must STILL end the session. It cannot be provoked
   * in `local` mode — there is no upstream to refuse anything, and the overlay
   * API would have to declare `origin: 'sanity'` on a 401 body, which nothing
   * does. `studio-guard-refusals.test.ts` §3 covers it at the unit layer against
   * the real `ClientError`; recorded here so the asymmetry is visible in the
   * browser suite too.
   */
  test.skip('a GENUINE Sanity 401 still ends the session — unit-covered, not reachable here', () => {})
})
