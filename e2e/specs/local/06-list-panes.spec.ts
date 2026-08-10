/**
 * SCENARIO 6 — list panes show branch state: created documents appear, edited
 * documents show their branch title, tombstoned documents disappear.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE FAILURE THAT PASSED EVERY TEST.
 *
 * From the acceptance audit: *"a list pane that rendered staging while every
 * test passed"*. And from `MORNING-2026-08-05.md`, gap 1:
 *
 *     "Studio's structure list is empty in Mode 2. It uses a FINDABILITY query
 *      (`text::query` + `references`), not a type-list query; origin mode didn't
 *      implement it, and with no upstream to fall back to that means an empty
 *      pane."
 *
 * That is the whole point. A list pane does not ask "give me documents of type
 * X" — it asks the search service. `origin-data.test.ts` proves a type-list
 * query returns overlay documents, and it does; the pane never sends one. Every
 * unit test of the query layer can be green while the pane a person looks at is
 * empty, and only a browser can tell the difference.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SPECS BELOW CAN AND CANNOT SEE IN LOCAL MODE.
 *
 * `local` mode is Mode 2 (origin): no upstream, so the overlay root IS the whole
 * world. Branch-*created* documents and tombstones are therefore fully testable
 * here. Branch-*edited* documents — where the pane must show a branch title over
 * a base document that already existed — need a base, and there is none. That
 * half lives in `specs/live/`, and this file says so rather than faking a base.
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
import {STUDIO} from '../../playwright/selectors'

/**
 * The list of DOCUMENTS for one type.
 *
 * NOT `structure-tool-list-pane`, which is what this used to read. That id is
 * the *structure* pane — the root menu, `Content / Author / Article / Page /
 * Site settings` — and it renders at `data-pane-index="0"` on every screen, so
 * `.last()` resolved to it even at `/structure/article` and the assertion below
 * was reading the sidebar. The first real run reported it verbatim:
 * `Received string: "ContentAuthorArticlePageSite settings"`.
 *
 * The documents themselves are in `document-list-pane`, which is the pane whose
 * contents the findability path actually fills.
 */
function listPane(page: import('@playwright/test').Page) {
  return page.getByTestId(STUDIO.documentListPane).last()
}

async function openArticleList(page: import('@playwright/test').Page) {
  await page.goto('/structure/article', {waitUntil: 'domcontentloaded'})
  /* The document list, not just any pane: waiting on `pane` was satisfied by
   * the root menu before the type list had rendered at all. */
  await expect(listPane(page)).toBeVisible({timeout: 60_000})
}

test.describe('list panes render branch state', () => {
  test('a branch-CREATED document appears in the list', async ({page, studio, overlay}) => {
    const id = 'e2e-list-created'
    const title = 'Created on the branch'

    await studio.openDocument('article', id)
    await setField(page, 'Title', title)
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)

    await openArticleList(page)

    /* The pane, not the document. A document pane that renders the title is the
     * read path; the LIST is the findability path, and they are different code. */
    await expect(listPane(page), 'the branch-created document is missing from the list pane').toContainText(
      title,
      {timeout: 30_000},
    )
  })

  test('two branch-created documents both appear — not just the most recent', async ({
    page,
    studio,
    overlay,
  }) => {
    const documents = [
      ['e2e-list-two-a', 'First branch article'],
      ['e2e-list-two-b', 'Second branch article'],
    ] as const

    for (const [id, title] of documents) {
      await studio.openDocument('article', id)
      await setField(page, 'Title', title)
      await waitForSettled(page)
      await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)
    }

    await openArticleList(page)
    for (const [, title] of documents) {
      await expect(listPane(page)).toContainText(title, {timeout: 30_000})
    }
  })

  /**
   * A TOMBSTONE NEEDS A PUBLISHED DOCUMENT, AND THE PUBLISH NEEDS A VALID ONE.
   *
   * Two constraints shape this test, both of them facts about the product
   * rather than preferences. `04-document-actions.spec.ts` states each at
   * length; the short forms:
   *
   *   - Deleting a never-published document cannot tombstone. `del.execute`
   *     sends `version.discard` for an empty version list when there is no
   *     published snapshot, so the request is empty or clears the draft, and
   *     `tombstones` stays `{draft: false, published: false}`. This test used to
   *     ask for exactly that state and timed out on it every time.
   *   - `Publish` is disabled until all four required fields are set, and the
   *     required `author` reference can only be set by the seed (the picker
   *     cannot see overlay documents; a strong reference must resolve to a
   *     published document — `playwright/seed.ts`).
   *
   * And one about the harness: every document action here happens in ONE page
   * load. The facade keys document actions with a per-page-load counter against
   * a durable idempotency ledger, so the first action after a reload replays the
   * first action of an earlier load. The list assertions are page loads, so both
   * `Publish` and `Delete` are performed in the load between them.
   */
  test('a TOMBSTONED document disappears from the list', async ({page, studio, overlay}) => {
    const id = 'e2e-list-tombstoned'
    const title = 'Doomed article'

    await seedPublishedAuthor(`${id}-author`, 'Reference target')
    await seedArticleReferencing(id, `${id}-author`)

    await studio.openDocument('article', id)
    await setField(page, 'Title', title)
    await setField(page, 'Slug', id)
    await setField(page, 'Published At', '2026-08-06 12:00')
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)

    await openArticleList(page)
    await expect(listPane(page)).toContainText(title, {timeout: 30_000})

    await studio.openDocument('article', id)
    await expect(page.getByTestId('action-publish').last()).toBeEnabled({timeout: 40_000})
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title'], 'published') === title, {
      what: 'the published layer, which is the only thing a delete can tombstone',
    })

    await runDocumentAction(page, 'Delete')
    await confirmIfAsked(page)
    await overlay.waitForIntent(
      id,
      (value) => value.tombstones.draft === true || value.tombstones.published === true,
      {what: 'the tombstone to land on disk before checking the pane'},
    )

    await openArticleList(page)
    /* The tombstone is on disk; the pane must reflect it. A list that still
     * shows the row is showing base state through a deletion, which is the
     * §18.8 tombstone doing nothing. */
    await expect(listPane(page), 'a tombstoned document is still listed').not.toContainText(title, {
      timeout: 30_000,
    })
  })

  test('the list pane is not empty when the overlay holds content', async ({
    page,
    studio,
    overlay,
  }) => {
    /* The narrowest possible regression test for the Mode 2 findability gap: the
     * overlay demonstrably holds a document, and the pane must not be blank. */
    const id = 'e2e-list-nonempty'
    await studio.openDocument('article', id)
    await setField(page, 'Title', 'Findability probe')
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === 'Findability probe')
    expect(overlay.ids()).toContain(id)

    await openArticleList(page)

    /**
     * THE EMPTY-STATE STRING, NOT A PREVIEW TEST ID.
     *
     * This asked for `default-preview__heading` inside the pane and never found
     * one on the first real run, while the sibling tests above happily matched
     * the title text in the same pane — so the id is not what a document row in
     * a `document-list-pane` renders, and asserting it was asserting the
     * harness's guess rather than the product.
     *
     * `No documents of this type` is what the pane renders when findability
     * returned nothing (seen verbatim in the run's own snapshots), which is the
     * precise failure this test exists for. Both halves are asserted: the empty
     * state is gone AND the document is there, so a pane that rendered neither —
     * still loading, or broken — cannot pass.
     */
    await expect(
      listPane(page),
      'the pane is showing its empty state while the overlay holds a document',
    ).not.toContainText('No documents of this type', {timeout: 30_000})
    await expect(listPane(page)).toContainText('Findability probe', {timeout: 30_000})
  })

  /**
   * SCAFFOLDED — needs a base dataset, which `local` (Mode 2) does not have.
   *
   * "Branch-EDITED documents show branch titles in list panes" requires a
   * document that exists upstream and is overridden locally, so the pane has
   * something to render the branch value *over*. `specs/live/` carries it.
   */
  test.skip('branch-EDITED documents show branch titles — see specs/live/', () => {})
})
