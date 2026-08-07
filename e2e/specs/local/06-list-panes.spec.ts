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
import {STUDIO} from '../../playwright/selectors'

/** The structure list for one document type. */
function listPane(page: import('@playwright/test').Page) {
  return page.getByTestId(STUDIO.structureListPane).last()
}

async function openArticleList(page: import('@playwright/test').Page) {
  await page.goto('/structure/article', {waitUntil: 'domcontentloaded'})
  await expect(page.getByTestId(STUDIO.pane).first()).toBeVisible({timeout: 60_000})
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

  test('a TOMBSTONED document disappears from the list', async ({page, studio, overlay}) => {
    const id = 'e2e-list-tombstoned'
    const title = 'Doomed article'

    await studio.openDocument('article', id)
    await setField(page, 'Title', title)
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)

    await openArticleList(page)
    await expect(listPane(page)).toContainText(title, {timeout: 30_000})

    await studio.openDocument('article', id)
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
    await expect(listPane(page).getByTestId(STUDIO.previewHeading).first()).toBeVisible({
      timeout: 30_000,
    })
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
