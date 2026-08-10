/**
 * SCENARIO 2 — an edit lands in `intent.json` ON DISK and survives a reload.
 *
 * PRD §38.1: *"Existing document can be edited"*, *"New document can be
 * created"*, *"Studio writes canonical files"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS THE FILE, NEVER THE PANE.
 *
 * On 2026-08-04 the editor reported success on every non-ASCII edit while the
 * overlay stayed empty — diff-match-patch counts UTF-8 bytes and the parser
 * counted JS characters. 2048 green tests could not see it. The only witness
 * that disagreed with the UI was `intent.json`.
 *
 * So every assertion below reads `.sanity-overlay/documents/<id>/intent.json`
 * off the run's overlay root. `waitForSettled()` appears only as a *wait*, and
 * the spec would still fail if the pane lied.
 *
 * THREE SEPARABLE CLAIMS, and they fail for different reasons:
 *
 *   A. the write reached disk                → the commit path works
 *   B. the file says what was typed          → the patch encoder works
 *   C. it is still there after a full reload → the read path works, and the
 *                                              value was not merely in memory
 *
 * B is the one that was false. C is the one a `{subscribe}` double cannot test.
 */
import {join} from 'node:path'

import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {STUDIO, refreshOverlay} from '../../playwright/selectors'

const ARTICLE = 'e2e-edit-persists'
const TITLE = 'Edited on the branch'

test.describe('an edit lands on disk and survives a reload', () => {
  test('A · the edit reaches intent.json, with a transaction to match', async ({
    page,
    studio,
    overlay,
  }) => {
    expect(overlay.ids(), 'the overlay must start empty').toEqual([])

    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', TITLE)
    await waitForSettled(page)

    const intent = await overlay.waitForIntent(
      ARTICLE,
      (value) => overrideAt(value, ['title']) === TITLE,
      {what: `title override "${TITLE}" in intent.json`},
    )

    expect(intent.logicalId).toBe(ARTICLE)
    expect(intent.touchedPaths).toContainEqual(['title'])
    expect(intent.tombstones).toEqual({draft: false, published: false})

    /* The second server-side witness: the store reached its commit point. The
     * HTTP log saying `/commit` was answered and the transaction log saying the
     * store committed are independent; either alone can be argued with. */
    expect(overlay.transactions().length).toBeGreaterThan(0)
  })

  test('B · the manifest records the document head the file claims', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', TITLE)
    await waitForSettled(page)
    await overlay.waitForIntent(ARTICLE, (value) => overrideAt(value, ['title']) === TITLE)

    const manifest = overlay.manifest()!
    const head = manifest.documentHeads[ARTICLE]
    expect(head, `manifest has no head for ${ARTICLE}`).toBeDefined()
    expect(head.logicalId).toBe(ARTICLE)
    expect(manifest.revision).toBeGreaterThan(0)

    /* Manifest and intent are written by different code paths at different
     * points in the commit; a checksum that disagrees means one of them is
     * stale, which is exactly the class of bug a reload would then expose. */
    expect(typeof head.checksum).toBe('string')
    expect(head.checksum.length).toBeGreaterThan(0)
  })

  test('C · a full page reload still shows the branch value, not the base value', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', TITLE)
    await waitForSettled(page)
    await overlay.waitForIntent(ARTICLE, (value) => overrideAt(value, ['title']) === TITLE)

    await page.reload({waitUntil: 'domcontentloaded'})
    await studio.openDocument('article', ARTICLE)
    await refreshOverlay(page)

    /* Read back through the form, which is the path a person uses. The disk
     * assertion above already proved persistence; this proves the READ path
     * resolves the overlay rather than falling through to the base. */
    await expect(page.getByTestId(STUDIO.documentPane).last()).toContainText(TITLE, {
      timeout: 30_000,
    })

    /* And the file is still the file — a reload that re-committed an empty
     * patch would leave the pane right and the overlay wrong. */
    expect(overrideAt(overlay.intent(ARTICLE), ['title'])).toBe(TITLE)
  })

  /**
   * THE PANE MUST STOP SAYING `Saving...`.
   *
   * This is a separate test on purpose, and it is expected to be RED until the
   * product is fixed. It is the same class of defect as 2026-08-04, inverted:
   * then the pane said *Saved* and the file was empty; now the file is right and
   * the pane never stops saying *Saving...*. Both are the editor lying about the
   * state of the write, and an editor a person cannot trust about that is not
   * shippable whatever the disk says.
   *
   * The mechanism, from `sanity@6.8.0`: the pulse is
   * `documentStore.pair.consistencyStatus`, which is `@sanity/mutator`'s
   * `BufferedDocument.onConsistencyChanged`, which flips to consistent only when
   * the PAIR LISTENER delivers the submitted transaction id back. The overlay
   * intercepts the write and commits it to the overlay API; the base-plane
   * listener at the transport never hears about it, so nothing ever arrives and
   * the buffer stays dirty forever.
   *
   * Every other spec treats settling as best-effort (`waitForSettled` returns a
   * boolean) so this defect is reported ONCE, here, by name — rather than as a
   * timeout in every spec that types a character.
   */
  test('the pane stops reporting "Saving..." once the write has landed on disk', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', TITLE)

    /* The file is complete before the assertion below, so a failure here is
     * unambiguously the STATUS being wrong rather than the write being slow. */
    await overlay.waitForIntent(ARTICLE, (value) => overrideAt(value, ['title']) === TITLE)

    const settled = await waitForSettled(page, 30_000)
    expect(
      settled,
      'the document is on disk and correct, but the pane still reports "Saving..." — ' +
        'consistency is driven by the base-plane listener echoing the transaction back, ' +
        'and the overlay write never traverses it',
    ).toBe(true)
  })

  test('the overlay root that was written is the RUN root, not the committed one', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', TITLE)
    await waitForSettled(page)
    await overlay.waitForIntent(ARTICLE, (value) => overrideAt(value, ['title']) === TITLE)

    /* `examples/kitchen-sink/.sanity-overlay/` is COMMITTED state — it holds
     * `article-01` and `origin-proof-1` from real sessions. A suite that wrote
     * there would corrupt evidence and still pass every assertion above. */
    expect(overlay.root).toContain(join('e2e', '.artifacts'))
    expect(overlay.root).not.toContain('kitchen-sink')
  })
})
