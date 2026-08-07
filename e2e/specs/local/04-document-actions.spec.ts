/**
 * SCENARIO 4 — document actions: publish, unpublish, delete, discard,
 * duplicate, restore.
 *
 * PRD §21.2: *"[MUST] Replace publish, unpublish, delete, discard, duplicate,
 * and restore actions."*
 * PRD §35.12: *"Publish action works. Unpublish action works. Discard works.
 * Delete and restore work. Duplicate works."*
 * PRD §38.1: *"Draft and branch publish work. Delete uses tombstone."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO LAYERS, AND THEY FAIL DIFFERENTLY.
 *
 * `actions.ts` is explicit that the overlay does NOT replace the six actions'
 * components — it lets Sanity's own built-ins render, and intercepts their
 * network calls in the facade. So there are two separable properties:
 *
 *   *Availability* — the six are offered, and the six that depend on hosted
 *   version infrastructure (`schedule`, `discardVersion`, `unpublishVersion`,
 *   the three Canvas ones) are gone. A blocked action that is still clickable
 *   produces a confusing failure in the middle of an edit, which is what §21.10
 *   exists to prevent.
 *
 *   *Effect* — clicking `Publish` changes the overlay on disk. This is where a
 *   double cannot help: the built-in action reaches the network through
 *   `client.action(...)`, and whether the facade plans that into a §18 overlay
 *   operation is a fact about the whole stack.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELETE IS A TOMBSTONE, NOT AN ABSENCE.
 *
 * §38.1 says *"Delete uses tombstone"* and §39.2 says deletion and unpublish use
 * tombstones. The intent file must therefore still EXIST after a delete, with
 * `tombstones.published` (or `.draft`) set — an overlay that simply removed the
 * file would resurrect the base document, which is the opposite of the intent.
 * A spec that asserted "the file is gone" would be asserting the bug.
 */
import type {Page} from '@playwright/test'

import {test, expect} from '../../playwright/fixtures'
import type {OverlayHandle, StudioHandle} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {
  actionIsPresent,
  confirmIfAsked,
  runDocumentAction,
  setField,
  waitForSettled,
} from '../../playwright/interactions'

/** `OVERLAY_ROUTED_ACTIONS` in `packages/sanity-overlay-studio/src/actions.ts`. */
const ROUTED_LABELS = ['Publish', 'Unpublish', 'Delete', 'Discard changes', 'Duplicate'] as const

/** `OVERLAY_BLOCKED_ACTIONS`, in the labels Sanity 6.8.0 renders for them. */
const BLOCKED_LABELS = ['Schedule', 'Edit in Canvas', 'Link to Canvas', 'Unlink from Canvas'] as const

async function draftArticle(
  page: Page,
  studio: StudioHandle,
  overlay: OverlayHandle,
  id: string,
  title: string,
) {
  await studio.openDocument('article', id)
  await setField(page, 'Title', title)
  await waitForSettled(page)
  return overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)
}

test.describe('availability — which actions exist at all', () => {
  test('the six overlay-routed actions are offered on a draft', async ({page, studio, overlay}) => {
    await draftArticle(page, studio, overlay, 'e2e-actions-availability', 'Availability probe')

    for (const label of ROUTED_LABELS) {
      expect(
        await actionIsPresent(page, label),
        `"${label}" is one of the six §18.4–§18.9 actions the overlay implements`,
      ).toBe(true)
    }
  })

  test('actions tied to hosted version infrastructure are removed', async ({
    page,
    studio,
    overlay,
  }) => {
    await draftArticle(page, studio, overlay, 'e2e-actions-blocked', 'Blocked probe')

    for (const label of BLOCKED_LABELS) {
      expect(
        await actionIsPresent(page, label),
        `"${label}" reaches infrastructure the overlay does not reproduce and must not be clickable`,
      ).toBe(false)
    }
  })

  /**
   * NOT ASSERTED, ON PURPOSE.
   *
   * `documentActions.ts` defines `Rebase onto current base`, `Resolve conflicts`
   * and `Create checkpoint`, but `config.ts` composes only the *filter*
   * (`resolveOverlayDocumentActions`) — `createOverlayActionController` has no
   * production call site. Asserting those buttons exist would encode a feature
   * that is not wired, and asserting they are absent would freeze a gap.
   */
  test.skip('overlay-contributed actions (rebase / resolve / checkpoint) — NOT WIRED', () => {})
})

test.describe('effect — what each action does to the overlay on disk', () => {
  test('publish moves the value onto the published layer', async ({page, studio, overlay}) => {
    const id = 'e2e-actions-publish'
    await draftArticle(page, studio, overlay, id, 'Ready to publish')

    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)

    const intent = await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title'], 'published') === 'Ready to publish',
      {what: 'a published-layer override after Publish'},
    )
    expect(intent.tombstones.published).toBe(false)

    const head = overlay.manifest()!.documentHeads[id]
    expect(head.hasPublished, 'the manifest must record a published head').toBe(true)
  })

  test('unpublish tombstones the published layer and keeps the file', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-actions-unpublish'
    await draftArticle(page, studio, overlay, id, 'To be unpublished')
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title'], 'published') !== undefined)

    await runDocumentAction(page, 'Unpublish')
    await confirmIfAsked(page)

    const intent = await overlay.waitForIntent(id, (value) => value.tombstones.published === true, {
      what: 'a published tombstone after Unpublish',
    })

    /* The file survives. §39.2: unpublish is a tombstone, and an overlay that
     * deleted the record would let the base document reappear. */
    expect(intent.logicalId).toBe(id)
    expect(overlay.ids()).toContain(id)
  })

  test('delete tombstones rather than removing the record', async ({page, studio, overlay}) => {
    const id = 'e2e-actions-delete'
    await draftArticle(page, studio, overlay, id, 'To be deleted')

    await runDocumentAction(page, 'Delete')
    await confirmIfAsked(page)

    const intent = await overlay.waitForIntent(
      id,
      (value) => value.tombstones.draft === true || value.tombstones.published === true,
      {what: 'a tombstone after Delete — NOT the file disappearing'},
    )
    expect(intent.logicalId).toBe(id)
  })

  test('discard removes the local draft override', async ({page, studio, overlay}) => {
    const id = 'e2e-actions-discard'
    await draftArticle(page, studio, overlay, id, 'Will be discarded')

    await runDocumentAction(page, 'Discard changes')
    await confirmIfAsked(page)

    /* Either the draft override is gone or the record is, depending on whether
     * anything else touched the document — both are "the local draft is not
     * there any more", and pinning one spelling would encode an implementation
     * detail rather than the §18.7 behaviour. */
    await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title']) !== 'Will be discarded',
      {what: 'the discarded draft override to go'},
    ).catch(async () => {
      await overlay.waitForAbsent(id)
    })
  })

  test('duplicate creates a second, independent overlay document', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-actions-duplicate'
    await draftArticle(page, studio, overlay, id, 'Original')

    const before = overlay.ids()
    await runDocumentAction(page, 'Duplicate')
    await confirmIfAsked(page)

    const after = await (async () => {
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        const ids = overlay.ids()
        if (ids.length > before.length) return ids
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return overlay.ids()
    })()

    expect(after.length, `Duplicate did not add a document. Before: ${before.join(', ')}`).toBeGreaterThan(
      before.length,
    )
    const copyId = after.find((candidate) => !before.includes(candidate))!
    expect(copyId).not.toBe(id)
    expect(overrideAt(overlay.intent(copyId), ['title'])).toBe('Original')
  })

  /**
   * SCAFFOLDED, NOT ASSERTED.
   *
   * `Restore` restores a previous revision, and the only revisions this overlay
   * has are its own `.runtime/revisions/`. Native History is `partial` in
   * `features.ts` — the inspector and the revert button are removed and
   * `?rev=` deep links stay reachable — so there is no supported UI path to a
   * previous revision in this Studio, and §32.2 "Overlay revision history" is
   * listed as still to build. A spec that clicked something would be testing a
   * route the product does not offer.
   */
  test.fixme('restore works — blocked on §32.2 overlay revision history', () => {})
})
