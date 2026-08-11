/**
 * SCENARIO 9 — THE THREE FIXES OF 2026-08-10, ASSERTED IN A BROWSER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Three defects were found and fixed on 2026-08-10, each with substantial unit
 * coverage. None of the three had a single assertion in this suite, and all
 * three are defects a unit test structurally cannot see — each one is a
 * DIFFERENT PROCESS disagreeing with the branch:
 *
 *   1. THE REFERENCE PICKER SHOWED "No results" for documents sitting in the
 *      branch. The Studio's read planner declines the picker's findability
 *      query and records a `passthrough`; in Mode 2 that passthrough is answered
 *      by `origin.mjs`, which projected the overlay root ONCE at boot and never
 *      again. So it answered a confident `[]` — the shape of a real answer, from
 *      a source that had been told nothing since startup (§5.5).
 *      Fixed by `refreshFromDisk` in `origin.mjs`.
 *
 *   2. EVERY DRAFT EDIT THREW IN THE CONSOLE:
 *          TypeError: Cannot read properties of undefined (reading 'apply')
 *            at Object.onMutationReceived  (sanity/lib/index.js:5688)
 *      because the overlay echo's listener frames omitted mendoza `effects`,
 *      and `remoteMutation.effects.apply` is a PATCH PROPERTY, not
 *      `Function.prototype.apply`. Fixed in `client/echo.ts`.
 *
 *   3. A STRONG REFERENCE TO A BRANCH DOCUMENT was decided by `/data/doc`, an
 *      existence probe answered by the base dataset. Fixed in
 *      `client/docReads.ts`.
 *
 * Their unit suites are thorough and are not repeated here. What is asserted
 * here is only what needs a real Studio: that the surfaces a person looks at
 * agree with the branch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND ONE REGRESSION THIS FILE WOULD HAVE CAUGHT SOONER.
 *
 * Fixes 1 and 3 together made `getDocumentExistence` answer truthfully for the
 * first time in Mode 2 — which unblocked a request the Studio had never been
 * able to issue before:
 *
 *     GET /data/references/<ds>/documents/<id>/to  ->  403 OVERLAY_WRITE_BLOCKED
 *
 * `/references` was missing from the proxy's read allowlist, because the
 * allowlist was built from observed traffic and no observation could reach it.
 * The 403 propagated out of the delete-confirm dialog into React's error
 * boundary, and `Delete` and `Unpublish` silently stopped writing tombstones.
 * Four specs failed and not one of them named a reference index. The permanent
 * coverage for that class lives in
 * `packages/sanity-overlay-testkit/test/write-guard.test.ts` (derived from the
 * shipped Studio bundle) and `test/origin-referring-documents.test.ts`; the
 * console assertion below is what makes it visible HERE, because a torn-down
 * component tree is exactly what it looked like from the browser.
 */
import {test, expect} from '../../playwright/fixtures'
import type {ConsoleMessage, Page} from '@playwright/test'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {seedArticleReferencing, seedPublishedAuthor} from '../../playwright/seed'
import {STUDIO} from '../../playwright/selectors'

/**
 * Every error the page reported, from before the first navigation.
 *
 * BOTH CHANNELS, because the two defects in scope surface differently: an
 * uncaught listener error reaches `pageerror`, while React's error-boundary
 * report and `console.error` from an rxjs teardown reach `console`. Attaching
 * only one of them would make a green run mean nothing.
 */
function collectErrors(page: Page): {messages: string[]} {
  const messages: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') messages.push(message.text())
  })
  page.on('pageerror', (error: Error) => {
    messages.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`)
  })
  return {messages}
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * 1. The reference picker
 * ══════════════════════════════════════════════════════════════════════════ */

test.describe('the reference picker searches the branch, not an empty corpus', () => {
  /**
   * THE STALE COMMENT THIS TEST RETIRES.
   *
   * `playwright/seed.ts` used to state, as a measured fact, that `author`
   * "cannot be set through the UI in this stack at all — the picker's search
   * reaches an origin whose corpus is empty". That was true, and it was a
   * PRODUCT DEFECT being worked around by a fixture rather than a property of
   * the stack. Now that the origin follows the overlay root, the picker works,
   * and this test is what says so — a fixture's workaround is not evidence, and
   * the day it silently starts being needed again this goes red.
   *
   * The seed still writes `author` for the OTHER specs, deliberately: their
   * subject is what a document action does to the overlay, and they should not
   * also depend on a search index. This spec is the one that owns the picker.
   */
  test('finds a branch-created author and sets a strong reference through the UI', async ({
    page,
    studio,
    overlay,
  }) => {
    const articleId = 'e2e-picker-article'
    const authorId = 'e2e-picker-author'
    const authorName = 'Written into the branch, never upstream'

    /* Published, because a STRONG reference only resolves to a published
     * document — and created through `/commit`, the same endpoint the Studio
     * writes with, so nothing here bypasses the overlay. */
    await seedPublishedAuthor(authorId, authorName)

    await studio.openDocument('article', articleId)
    await setField(page, 'Title', 'Reference picker probe')
    await waitForSettled(page)

    /*
     * The picker's own input, BY ROLE AND ACCESSIBLE NAME rather than by a
     * `field-*` test id.
     *
     * The first attempt scoped to `[data-testid^="field-author"]` and found
     * nothing: `field-${field.name}` is what the OBJECT input stamps on its
     * members, and a top-level reference field on this form is not one of
     * those. What the reference input actually renders — read back out of the
     * failing run's own accessibility snapshot — is `combobox "Author"`, which
     * is also what a person navigating with a screen reader reaches, so it is
     * the better locator on its own merits.
     */
    const search = page
      .getByTestId(STUDIO.documentPane)
      .last()
      .getByRole('combobox', {name: 'Author', exact: true})
    await expect(search).toBeVisible({timeout: 30_000})
    await search.click()
    await search.fill('Written into the branch')

    /*
     * THE ASSERTION, IN BOTH DIRECTIONS.
     *
     * "No results" is the verbatim empty state the picker rendered for every
     * branch document before the fix, so its absence is the regression half;
     * the author appearing is the positive half. A picker that rendered neither
     * — still loading, or broken — passes neither.
     */
    const option = page.getByRole('option', {name: new RegExp(authorName, 'i')}).first()
    await expect(option, 'the picker found no branch document').toBeVisible({timeout: 30_000})
    await expect(
      page.getByText(/no results/i),
      'the picker is showing its empty state while the branch holds the author',
    ).toHaveCount(0)

    await option.click()
    await waitForSettled(page)

    /*
     * THE ORACLE IS THE DISK, never the pane. What the picker displays is the
     * thing under test; what landed in `intent.json` is what a consumer will
     * read, and the two were not the same on 2026-08-04.
     */
    const intent = await overlay.waitForIntent(
      articleId,
      (value) => {
        const author = overrideAt(value, ['author']) as {_ref?: string} | undefined
        return author?._ref === authorId
      },
      {what: 'the reference the picker set to reach intent.json'},
    )
    const author = overrideAt(intent, ['author']) as {_ref?: string; _weak?: boolean}
    expect(author._ref).toBe(authorId)
    /* Strong, as `article.ts:17` declares it — a picker that quietly weakened
     * the reference would satisfy every assertion above and change §18.8's
     * delete-protection semantics. */
    expect(author._weak).toBeUndefined()
  })
})

/* ══════════════════════════════════════════════════════════════════════════ *
 * 2. The console
 * ══════════════════════════════════════════════════════════════════════════ */

test.describe('an ordinary edit throws nothing into the console', () => {
  /**
   * WHY A CONSOLE ASSERTION IS A REAL ASSERTION HERE, AND NOT NOISE.
   *
   * It is scoped to two named failures, both of which were observed on every
   * single draft edit and neither of which fails any other test in this suite:
   *
   *   - `onMutationReceived` reading `.apply` off an absent `effects`. The pane
   *     still saved, so nothing went red; the timeline and the events panel
   *     were quietly dead, and `getEffectState` could never report a create or
   *     a delete.
   *   - React tearing a component tree down to its error boundary. That is what
   *     the `/data/references` 403 looked like from the browser, and it is the
   *     shape of any future refusal reaching a Studio surface.
   *
   * A blanket "no console errors" would be noise — this stack legitimately logs
   * refusals — so the filter names what must never appear and lets everything
   * else through.
   */
  test('no `onMutationReceived` TypeError, and no torn-down component tree', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-console-clean'
    const errors = collectErrors(page)

    await studio.openDocument('article', id)
    await setField(page, 'Title', 'Typed while the console was watched')
    await waitForSettled(page)
    /* The write really happened — otherwise "no errors" would be the trivial
     * consequence of nothing having occurred. */
    await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title']) === 'Typed while the console was watched',
    )

    /* A second edit, because the first frame of a document is a create and the
     * defect was on the UPDATE path: `previousRev` present, `effects.revert`
     * describing a body the echo had to remember. */
    await setField(page, 'Title', 'And again, so the frame is an update')
    await waitForSettled(page)
    await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title']) === 'And again, so the frame is an update',
    )

    const listenerErrors = errors.messages.filter(
      (message) =>
        message.includes('onMutationReceived') ||
        /Cannot read properties of undefined \(reading 'apply'\)/.test(message),
    )
    expect(listenerErrors, 'the pair listener threw — `effects` is missing again').toEqual([])

    const tornDown = errors.messages.filter((message) =>
      /recreate this component tree from scratch/i.test(message),
    )
    expect(tornDown, 'a Studio component tree fell back to its error boundary').toEqual([])

    /*
     * THE THIRD ONE, FOUND BY THIS FILE ON ITS FIRST RUN.
     *
     *   Cannot update a component (`OverlayStatusLayout`) while rendering a
     *   different component (`DocumentEventsPane`).
     *
     * `announceEmptyHistory` — the §5.5 statement that a branch document's
     * timeline is withheld — was delivered on the caller's stack, and that
     * caller is a React render. React discards and re-runs the interrupted
     * render, which is how a benign-looking warning becomes the torn-down tree
     * asserted above. Fixed by deferring the announcement to a microtask
     * (`client/facade.ts`), and pinned at the unit layer by
     * `studio-doc-existence.test.ts` "does NOT announce synchronously".
     */
    const renderPhaseUpdates = errors.messages.filter((message) =>
      /Cannot update a component .* while rendering a different component/i.test(message),
    )
    expect(
      renderPhaseUpdates,
      'the overlay pushed state into React during a render pass',
    ).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════════════ *
 * 3. Strong-reference validation
 * ══════════════════════════════════════════════════════════════════════════ */

test.describe('a strong reference is decided by the branch', () => {
  /**
   * THE ORACLE IS `Publish`, AND THE DIFFERENTIAL IS THE POINT.
   *
   * `usePublishAction` disables the button on `hasValidationErrors`
   * (`structureTool` dist ~9714), so an enabled Publish on a document whose
   * only unfillable required field is a strong reference IS the statement
   * "`validation:object.reference-not-published` did not fire". Asserting that
   * alone would be weak — a Studio with validation switched off would pass it —
   * so the ghost-reference case runs the identical flow against an id NOTHING
   * holds, and must stay disabled. One of the two has to be wrong for either
   * result to be an accident.
   */
  async function fillRequiredFieldsExceptAuthor(page: Page, title: string): Promise<void> {
    await setField(page, 'Title', title)
    await setField(page, 'Slug', title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    await setField(page, 'Published At', '2026-08-10 12:00')
    await waitForSettled(page)
  }

  test('a reference to a BRANCH-ONLY published author validates', async ({
    page,
    studio,
    overlay,
  }) => {
    const articleId = 'e2e-refval-branch'
    const authorId = 'e2e-refval-branch-author'

    await seedPublishedAuthor(authorId, 'Exists only on the branch')
    await seedArticleReferencing(articleId, authorId)

    await studio.openDocument('article', articleId)
    await fillRequiredFieldsExceptAuthor(page, 'Branch reference validates')
    await overlay.waitForIntent(
      articleId,
      (value) => overrideAt(value, ['title']) === 'Branch reference validates',
    )

    await expect(
      page.getByTestId('action-publish').last(),
      'the strong reference to a branch-created author was judged unpublished',
    ).toBeEnabled({timeout: 40_000})
  })

  test('CONTROL: a reference to an id NOTHING holds does not', async ({page, studio, overlay}) => {
    const articleId = 'e2e-refval-ghost'

    /* No `seedPublishedAuthor`. This id is in neither the branch nor the base,
     * and the probe is the only thing that can say so. */
    await seedArticleReferencing(articleId, 'e2e-refval-ghost-author')

    await studio.openDocument('article', articleId)
    await fillRequiredFieldsExceptAuthor(page, 'Ghost reference must not validate')
    await overlay.waitForIntent(
      articleId,
      (value) => overrideAt(value, ['title']) === 'Ghost reference must not validate',
    )

    /*
     * Validation is asynchronous and starts optimistic, so a bare `toBeDisabled`
     * could pass on a pane that had not finished thinking. `toPass` re-reads for
     * the full window and requires the button to be disabled and STAY disabled
     * — the same shape as the positive case's `toBeEnabled`, so neither can
     * succeed merely by being asked at a lucky moment.
     */
    const publish = page.getByTestId('action-publish').last()
    await expect(publish).toBeVisible({timeout: 40_000})
    await expect(async () => {
      expect(await publish.isDisabled()).toBe(true)
    }).toPass({timeout: 40_000, intervals: [1_000, 2_000, 5_000]})
  })
})
