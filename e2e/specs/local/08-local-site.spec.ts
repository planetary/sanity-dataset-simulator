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
import {
  confirmIfAsked,
  runDocumentAction,
  setField,
  waitForSettled,
} from '../../playwright/interactions'
import {seedArticleReferencing, seedPublishedAuthor} from '../../playwright/seed'
import {URLS} from '../../harness/paths.mjs'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {headers: {accept: 'text/html'}})
  expect(response.ok, `${url} answered ${response.status}`).toBe(true)
  return response.text()
}

/** The same fetch, for a route whose ABSENCE is the assertion. */
async function fetchPage(url: string): Promise<{status: number; body: string}> {
  const response = await fetch(url, {headers: {accept: 'text/html'}})
  return {status: response.status, body: await response.text()}
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

  /**
   * PRD §38.1's strongest local form: *"Delete an article in Studio. Reload: it
   * is gone from the list, and its own URL returns 404, not the stale staging
   * row."*
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THIS WAS SKIPPED, AND THE SKIP WAS WRONG ON BOTH OF ITS CLAIMS.
   *
   * It read `test.skip(true, 'needs a shared base document — see specs/live/')`,
   * on the reasoning that *"in local mode the Studio's world is the empty run
   * overlay, so there is no shared id to delete"*.
   *
   *   - `specs/live/01-staging-untouched.spec.ts` does not carry this test. It
   *     has the branch-title cases and no tombstone case at all, so the pointer
   *     named a home that does not exist.
   *   - "the Studio has no base" is not "no id can be shared". The id is shared
   *     by the SITE, which is the process holding both halves: the Studio can
   *     address `article-02`, and `examples/local-site/base-dataset.ndjson`
   *     contains `article-02`. Nothing had to exist upstream for that to be true.
   *
   * The real difference the skip was circling — that a Mode 2 Studio can only
   * produce a BRANCH-CREATED tombstone, while `local-site-routes.test.ts` seeds
   * a base-derived one — is measured in
   * `packages/sanity-overlay-testkit/test/site-branch-tombstone-over-base.test.ts`,
   * which drives exactly the Mode 2 record shape and shows the suppression holds.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE DIFFERENTIAL IS STILL THE ASSERTION. `:4001` is asserted to be serving
   * the row BEFORE and AFTER, so "the branch 404s" cannot pass by the site being
   * broken, the slug being wrong, or the base dataset having changed.
   */
  test('a tombstoned document 404s on the branch view while the base still has it', async ({
    page,
    studio,
    overlay,
  }) => {
    /* An id that `base-dataset.ndjson` really holds, and the slug it routes by. */
    const id = 'article-02'
    const slug = 'article-2'
    const branchTitle = 'About to be deleted on the branch'

    /* BEFORE: the staging view serves it, so the row demonstrably exists. */
    const stagingBefore = await fetchPage(`${URLS.siteStaging}/articles/${slug}`)
    expect(stagingBefore.status, 'the base dataset no longer routes this slug').toBe(200)

    /* `article` declares a required STRONG reference to a PUBLISHED author, and
     * no amount of typing in the form can satisfy it — see `playwright/seed.ts`.
     * Publish stays disabled without this, and a document that cannot be
     * published cannot be tombstoned. */
    await seedPublishedAuthor(`${id}-author`, 'Tombstone target author')
    await seedArticleReferencing(id, `${id}-author`)

    await studio.openDocument('article', id)
    await setField(page, 'Title', branchTitle)
    await setField(page, 'Slug', slug)
    await setField(page, 'Published At', '2026-08-10 12:00')
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === branchTitle)

    /* Only a PUBLISHED version can be tombstoned (§18.8). */
    await expect(page.getByTestId('action-publish').last()).toBeEnabled({timeout: 40_000})
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title'], 'published') === branchTitle,
      {what: 'the published layer, which is the only thing a delete can tombstone'},
    )

    await runDocumentAction(page, 'Delete')
    await confirmIfAsked(page)
    await overlay.waitForIntent(
      id,
      (value) => value.tombstones.draft === true || value.tombstones.published === true,
      {what: 'the tombstone to land on disk before asking the site'},
    )

    await revalidate()

    /* THE ASSERTION: the branch view refuses to serve it… */
    await expect
      .poll(async () => (await fetchPage(`${URLS.siteBranch}/articles/${slug}`)).status, {
        timeout: 30_000,
        message: 'the branch view still serves a tombstoned document',
      })
      .toBe(404)

    const branchList = await fetchText(`${URLS.siteBranch}/`)
    expect(branchList, 'the tombstoned article is still linked from the branch list').not.toContain(
      `/articles/${slug}`,
    )

    /* …while the base is untouched and the staging view still serves it. A
     * 404 on both would mean the site broke, not that the overlay suppressed. */
    const stagingAfter = await fetchPage(`${URLS.siteStaging}/articles/${slug}`)
    expect(stagingAfter.status, 'the branch delete reached the STAGING view').toBe(200)
    expect(await fetchText(`${URLS.siteStaging}/`)).toContain(`/articles/${slug}`)
  })
})
