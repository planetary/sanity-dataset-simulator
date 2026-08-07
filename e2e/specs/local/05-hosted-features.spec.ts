/**
 * SCENARIO 5 — hosted features are absent: Comments, Tasks, Releases,
 * Scheduled Drafts, Vision.
 *
 * PRD §21.2: *"[MUST] Disable hosted-only features that could write to shared
 * datasets or show misleading state."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THIS A BROWSER TEST AND NOT A CONFIG TEST.
 *
 * `studio-features.test.ts` already proves the *config* is right: the flags are
 * spread into the workspace, the tool resolver removes `vision`, the inspector
 * resolver removes comments. What it cannot prove is that the running Studio
 * honours them — and `features.ts`'s own header is a catalogue of the ways it
 * nearly did not:
 *
 *   - `tasks` and `scheduledPublishing` *are not keys on `PluginOptions` at
 *     all*, so a plugin cannot turn them off; only the root config can.
 *   - `releases.enabled` IS a key on `PluginOptions` and is **silently ignored**
 *     there for both registration and `Source.releases`.
 *   - `scheduledDrafts.enabled` from a plugin flips the runtime flag but not
 *     registration.
 *
 * Three different failure modes, all of which look identical in a unit test of
 * the config object and all of which produce a visible, clickable, dataset-
 * writing surface in the browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ADMISSIONS THIS FILE MAKES OUT LOUD.
 *
 *   **Vision.** `examples/kitchen-sink/sanity.config.ts` installs only
 *   `structureTool()`. Vision was never in the plugin array, so its absence here
 *   is not evidence that the tool filter removes it. The assertion is kept
 *   because a regression that *added* Vision would matter, and the weakness is
 *   labelled rather than hidden.
 *
 *   **History.** `features.ts` reports history removal as `partial`: the
 *   inspector and the revert button go, but the document-events machinery still
 *   runs and `?rev=` / `?since=` deep links stay reachable. Asserting history is
 *   gone would assert something untrue.
 */
import {test, expect} from '../../playwright/fixtures'
import {setField, waitForSettled} from '../../playwright/interactions'
import {STUDIO} from '../../playwright/selectors'

const HOSTED_SURFACES: ReadonlyArray<readonly [feature: string, testIds: readonly string[]]> = [
  ['Comments', [STUDIO.hosted.commentsList, STUDIO.hosted.commentInput]],
  ['Tasks', [STUDIO.hosted.tasksBadge, STUDIO.hosted.tasksToolbar]],
  [
    'Releases',
    [
      STUDIO.hosted.releasesToolLink,
      STUDIO.hosted.releaseMenuButton,
      STUDIO.hosted.createNewReleaseButton,
    ],
  ],
  [
    'Scheduled Drafts',
    [
      STUDIO.hosted.scheduledDraftsMenuItem,
      STUDIO.hosted.scheduleDraftMenuButton,
      STUDIO.hosted.schedulePublishMenuItem,
      STUDIO.hosted.scheduleButton,
      STUDIO.hosted.confirmScheduleDialog,
    ],
  ],
]

test.describe('hosted features are absent from the running Studio', () => {
  for (const [feature, testIds] of HOSTED_SURFACES) {
    test(`${feature} renders no surface anywhere`, async ({page, studio, overlay}) => {
      /* A real document, open, with a draft: the state in which every one of
       * these surfaces would appear if it were registered. An empty Studio
       * proves nothing about a document-scoped inspector. */
      await studio.openDocument('article', `e2e-hosted-${feature.toLowerCase().replace(/\s+/g, '-')}`)
      await setField(page, 'Title', `Hosted feature probe: ${feature}`)
      await waitForSettled(page)

      for (const testId of testIds) {
        await expect(
          page.getByTestId(testId),
          `${feature} surface "${testId}" is still rendered — it can write to the shared dataset`,
        ).toHaveCount(0)
      }
    })
  }

  test('the navbar offers no Vision tool (weak: Vision was never installed here)', async ({
    page,
    studio,
  }) => {
    await studio.open()
    const navbar = page.getByTestId(STUDIO.navbar)
    await expect(navbar).toBeVisible()
    await expect(navbar.getByRole('link', {name: /vision/i})).toHaveCount(0)
    await expect(navbar.getByRole('button', {name: /vision/i})).toHaveCount(0)
  })

  test('the navbar offers no Releases or Tasks entry', async ({page, studio}) => {
    await studio.open()
    const navbar = page.getByTestId(STUDIO.navbar)
    for (const name of [/releases/i, /tasks/i, /schedules/i]) {
      await expect(navbar.getByRole('link', {name})).toHaveCount(0)
      await expect(navbar.getByRole('button', {name})).toHaveCount(0)
    }
  })

  test('opening a document raises no comments inspector in the document menu', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', 'e2e-hosted-inspectors')
    await setField(page, 'Title', 'Inspector probe')
    await waitForSettled(page)

    const menu = page.getByTestId('pane-context-menu-button').last()
    if ((await menu.count()) > 0) {
      await menu.click()
      await expect(page.getByRole('menuitem', {name: /comments/i})).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
  })

  /**
   * NOT ASSERTED — history removal is `partial` by the product's own report.
   *
   * `sanity@6.8.0` has no on/off key for native History. The inspector and the
   * restore action are removed and call sites degrade, but `?rev=` deep links
   * stay reachable. Recorded here so the gap is visible in the suite rather than
   * only in `features.ts`.
   */
  test.skip('native History is fully disabled — IT IS NOT, and cannot be in 6.8.0', () => {})
})
