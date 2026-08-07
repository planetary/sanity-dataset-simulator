/**
 * SCENARIO 8 — the local site renders branch content, and `mode: off` renders
 * staging.
 *
 * PRD §38.1: *"Preview updates after edit"* (the §38.2 spelling) and the whole
 * point of the system: *"Edit a document in Studio, reload this site, see your
 * edit. Staging is untouched."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIFFERENTIAL IS THE ASSERTION.
 *
 * Two servers, **the same code, the same base dataset, one environment variable
 * apart**:
 *
 *     :4000   SANITY_OVERLAY_MODE=fs    branch view
 *     :4001   SANITY_OVERLAY_MODE=off   staging view
 *
 * A site that rendered the branch value on both would mean the overlay had
 * leaked into base. A site that rendered it on neither would mean the read path
 * never consulted the overlay. Only the difference between them says anything,
 * which is why both are asserted in every test here rather than one.
 *
 * `mode: off` is genuinely inert, not a flag consulted late: the client never
 * calls the overlay port at all (`client-modes.test.ts` proves that by handing
 * it a loader that throws on any access). So `:4001` is a real independent
 * oracle for "what the base says", not a second view of the same state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SITE IS NOT A `page` TEST.
 *
 * `examples/local-site` renders server-side HTML with no client JavaScript and
 * no test ids. Fetching it is closer to what it is, avoids a browser context per
 * assertion, and makes the assertion about bytes the server produced rather than
 * about a DOM a renderer built.
 */
import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {URLS} from '../../harness/paths.mjs'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {headers: {accept: 'text/html'}})
  expect(response.ok, `${url} answered ${response.status}`).toBe(true)
  return response.text()
}

/** Ask the site to re-read the overlay rather than waiting out its probe. */
async function revalidate(): Promise<void> {
  await fetch(`${URLS.siteBranch}/revalidate`, {method: 'POST'}).catch(() => undefined)
}

test.describe('the consumer site reads the branch, and mode: off reads the base', () => {
  test('both servers are up and are the same application', async () => {
    const branch = await fetchText(`${URLS.siteBranch}/`)
    const staging = await fetchText(`${URLS.siteStaging}/`)

    /* The footer is the site's only state marker (`src/render.ts`,
     * `renderContext()`), and it is how a reader tells the two apart. */
    expect(branch).toContain('mode: fs')
    expect(staging).toContain('mode: off')
    expect(staging).toContain('reading the base dataset directly — no overlay is consulted')
  })

  test('a branch-created document appears on :4000 and NOT on :4001', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-site-created'
    const title = 'Only on the branch'

    await studio.openDocument('article', id)
    await setField(page, 'Title', title)
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)

    await revalidate()

    await expect
      .poll(async () => (await fetchText(`${URLS.siteBranch}/`)).includes(title), {
        timeout: 30_000,
        message: 'the branch view never picked up the new overlay document',
      })
      .toBe(true)

    const staging = await fetchText(`${URLS.siteStaging}/`)
    expect(
      staging.includes(title),
      'the branch value reached the STAGING view — the overlay has leaked into base',
    ).toBe(false)
  })

  test('the branch view reports a rising overlay revision; the staging view reports none', async ({
    page,
    studio,
    overlay,
  }) => {
    const before = overlay.manifest()?.revision ?? 0

    await studio.openDocument('article', 'e2e-site-revision')
    await setField(page, 'Title', 'Revision probe')
    await waitForSettled(page)
    await overlay.waitForIntent(
      'e2e-site-revision',
      (value) => overrideAt(value, ['title']) === 'Revision probe',
    )

    const after = overlay.manifest()!.revision
    expect(after, 'the manifest revision did not advance').toBeGreaterThan(before)

    await revalidate()
    await expect
      .poll(async () => await fetchText(`${URLS.siteBranch}/`), {timeout: 30_000})
      .toContain(`overlay revision: ${after}`)

    const staging = await fetchText(`${URLS.siteStaging}/`)
    expect(staging).not.toContain('overlay revision:')
  })

  test('a tombstoned document 404s on the branch view while the base still has it', async ({
    overlay,
  }) => {
    /**
     * SCAFFOLDED, not asserted.
     *
     * The strong form — *"Delete an article in Studio. Reload: it is gone from
     * the list, and its own URL returns 404, not the stale staging row"* — needs
     * a document that exists in `base-dataset.ndjson` AND in the Studio's world.
     * In `local` mode the Studio's world is the empty run overlay, so there is
     * no shared id to delete. `specs/live/` is where the base and the Studio
     * agree on ids.
     */
    test.skip(true, 'needs a shared base document — see specs/live/')
    expect(overlay.ids()).toBeDefined()
  })
})
