/**
 * SCENARIO 1 — Studio boots on the product path and the banner renders healthy.
 *
 * PRD §21.2: *"[MUST] Show an overlay status banner on every Studio screen."*
 * PRD §35.12: *"Workspace boots in local overlay mode."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A BOOT SPEC IS NOT TRIVIAL HERE.
 *
 * The Studio plugin shipped once in a state where it *could never have been
 * installed*: `src/index.ts` imported `@sanity/client` without declaring it, so
 * a consumer got `ERR_MODULE_NOT_FOUND` at boot. In-repo it was invisible,
 * because the workspace root hoists the dependency into a place Node happens to
 * find. Nothing short of loading the real bundle in a real browser could see it.
 *
 * This spec is that load. It asserts three separable things, in order of what
 * they would catch:
 *
 *   1. the bundle evaluates at all (no Studio error screen, no page error);
 *   2. `defineOverlayConfig` ran — the banner and `__SANITY_OVERLAY__` exist,
 *      and the Spike A fallback did NOT take over;
 *   3. the overlay reached its API and is healthy — not `offline`, which is what
 *      a CORS or port mistake looks like.
 */
import {test, expect} from '../../playwright/fixtures'
import {
  HEADLINE,
  OVERLAY_BANNER,
  OVERLAY_FATAL,
  STUDIO,
  bannerState,
  overlayHandleInstalled,
  refreshOverlay,
} from '../../playwright/selectors'

test.describe('Studio boots on the product path', () => {
  test('the bundle evaluates: no Studio error screen and no uncaught page error', async ({
    page,
    studio,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))

    await studio.open()

    await expect(page.getByTestId(STUDIO.errorScreen)).toHaveCount(0)
    await expect(page.getByTestId(STUDIO.layout)).toBeVisible()
    expect(pageErrors, `uncaught errors during boot:\n${pageErrors.join('\n')}`).toEqual([])
  })

  test('the PRODUCT path ran, not the Spike A fallback', async ({page, studio}) => {
    await studio.open()

    /* The banner exists only when `defineOverlayConfig` registered a runtime.
     * On the Spike A path the config is a plain `defineConfig` and there is no
     * banner, no feature filtering and no devtools handle — a Studio that looks
     * fine and is a different program. */
    await expect(page.getByTestId(OVERLAY_BANNER)).toBeVisible()
    expect(await overlayHandleInstalled(page)).toBe(true)

    const flags = await page.evaluate(() =>
      ['SPIKE_LOCAL_ECHO', 'SPIKE_API_HOST', 'SPIKE_INSTRUMENT', 'SPIKE_OVERLAY_PERSIST', 'SPIKE_STRICT_QUERIES']
        .map((key) => [key, window.localStorage.getItem(key)] as const)
        .filter(([, value]) => (value ?? '').trim() !== ''),
    )
    expect(flags, 'a SPIKE_* flag would have replaced the product path entirely').toEqual([])
  })

  test('the banner is healthy — it reached the overlay API, and it is not fatal', async ({
    page,
    studio,
  }) => {
    await studio.open()
    await refreshOverlay(page)

    const banner = page.getByTestId(OVERLAY_BANNER)
    await expect(banner).toHaveAttribute('data-overlay-state', 'healthy')
    await expect(banner).toHaveAttribute('data-overlay-severity', 'neutral')
    await expect(banner).toContainText('BRANCH OVERLAY')
    await expect(banner).toContainText(HEADLINE.healthy)

    /* `offline` is what a wrong port or a CORS mistake looks like, and it is the
     * single likeliest way this suite goes wrong without being wrong about the
     * product — the overlay API grants CORS to `http://localhost:3333` and to no
     * other origin. Naming it here makes that failure self-diagnosing. */
    expect(await bannerState(page)).not.toBe('offline')
    await expect(page.getByTestId(OVERLAY_FATAL)).toHaveCount(0)
  })

  test('the banner reports the overlay identity the server actually opened', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.open()
    await refreshOverlay(page)

    const manifest = overlay.manifest()
    expect(manifest, 'the overlay server did not initialise its root').not.toBeNull()

    const banner = page.getByTestId(OVERLAY_BANNER)
    /* §21.3 requires storage and revision on the banner. The revision is read
     * off the manifest the SERVER wrote, so agreement here is the banner
     * reporting the world rather than reporting itself.
     *
     * Two tiers since the 2026-08-11 redesign: the revision stays on the
     * always-visible line; storage and the conflict summary are context and
     * live behind the Details toggle — so this spec now drives the toggle the
     * way a person reaches those facts. */
    await expect(banner).toContainText(`Overlay revision: ${manifest!.revision}`)
    await expect(banner.getByTestId('overlay-banner-details')).toHaveCount(0)

    await banner.getByTestId('overlay-banner-details-toggle').click()
    const details = banner.getByTestId('overlay-banner-details')
    await expect(details).toBeVisible()
    await expect(details).toContainText('Storage:')
    await expect(details).toContainText('Conflicts: 0 soft, 0 hard')
  })

  test('the banner is on every screen, not just the first one', async ({page, studio}) => {
    await studio.open()
    await expect(page.getByTestId(OVERLAY_BANNER)).toBeVisible()

    /* §21.2 says "on every Studio screen". A layout component that renders the
     * banner instead of calling `renderDefault` would pass the first assertion
     * and break every pane below it, so both are checked after navigating. */
    await studio.openDocument('article', 'e2e-boot-probe')
    await expect(page.getByTestId(OVERLAY_BANNER)).toBeVisible()
    await expect(page.getByTestId(STUDIO.documentPane).first()).toBeVisible()
  })
})
