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
  selectPerspective,
  setField,
  waitForSettled,
} from '../../playwright/interactions'
import {seedArticleReferencing, seedPublishedAuthor} from '../../playwright/seed'

/**
 * `OVERLAY_ROUTED_ACTIONS` in `packages/sanity-overlay-studio/src/actions.ts`,
 * minus the one Sanity itself does not render in this perspective.
 *
 * `Unpublish` is NOT here, and its absence is stock `sanity@6.8.0`, not the
 * overlay: `useUnpublishAction` opens with
 *
 *     return release || isDraft || liveEditSchemaType ? null : …
 *
 * (`structureTool` dist ~9777) where `isDraft = selectedPerspective === 'drafts'`
 * — and Drafts is the perspective a Studio opens in. The action is not disabled,
 * it is not rendered at all, so no filter of the overlay's could put it back.
 * The first real run spent this assertion proving that, which is why it is now
 * pinned separately below rather than folded in here.
 */
const ROUTED_LABELS = ['Publish', 'Delete', 'Discard changes', 'Duplicate'] as const

/** `OVERLAY_BLOCKED_ACTIONS`, in the labels Sanity 6.8.0 renders for them. */
const BLOCKED_LABELS = ['Schedule', 'Edit in Canvas', 'Link to Canvas', 'Unlink from Canvas'] as const

/**
 * A branch-created draft with only its title set.
 *
 * Enough for the AVAILABILITY tests, which ask which buttons exist — not
 * whether they can be pressed. The effect tests need `publishableArticle`.
 */
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

/**
 * A draft that Sanity will actually let you publish.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT "RELAXING THE TEST".
 *
 * `usePublishAction` disables the button on `hasValidationErrors`
 * (`structureTool` dist ~9714), and `article` declares FOUR required fields.
 * A fixture that fills only `Title` therefore tests *Sanity's validation*, by
 * accident, in a spec whose subject is what `Publish` does to the overlay. The
 * first real run spent 90 s on it and reported
 * `waiting for getByRole('menuitem', { name: 'Publish' })` — the primary button
 * was there and disabled, so `runDocumentAction` fell through to the menu, where
 * an action that is already rendered as the primary button never appears.
 *
 * Three of the four are typed into the form here. The fourth, `author`, is a
 * strong reference and cannot be set through the UI in this stack at all — the
 * picker's search reaches an origin whose corpus is empty, and a strong
 * reference must resolve to a PUBLISHED document. Both facts, with their
 * measurements, are in `playwright/seed.ts`; the seed writes that one field and
 * nothing else, through the same `/commit` endpoint the Studio uses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A DOCUMENT ACTION AFTER A RELOAD — FIXED 2026-08-10, AND NOW PINNED.
 *
 * This comment used to end with an instruction: every document action in a spec
 * must happen in ONE page load. The reason was a product defect. The overlay's
 * idempotency ledger is durable and keyed by `idempotencyKey` alone
 * (`sanity-overlay-core/src/mutations/transaction.ts`), and the facade keys
 * document actions with `echo.nextTransactionId()`, which was a COUNTER RESET
 * ON EVERY PAGE LOAD (`client/echo.ts` — `overlay-1-7wdrqp`, `overlay-2-…`,
 * with a suffix that was a pure function of the counter, so it carried no
 * entropy at all). The first document action after a reload therefore replayed
 * the first document action of any earlier page load in the same overlay: the
 * server answered `200 {"committed": false, "replayed": true}` and the write
 * was silently dropped while Studio reported success.
 *
 * Measured directly at the time: an author published in one page load and an
 * article published after a `page.goto` both posted
 * `idempotencyKey: "overlay-1-7wdrqp"`, and the second commit's response was
 * `replayed: true` with the FIRST transaction's id.
 *
 * `nextTransactionId()` is now namespaced by a per-echo `crypto.randomUUID()`
 * session id, so two page loads cannot collide. THE INSTRUCTION IS THEREFORE
 * GONE, and the last test in this file is the one that would have caught it:
 * it deliberately performs a document action AFTER a fresh page load. The rest
 * still happen inside one page load, because that is what a person does — not
 * because they must.
 */
async function publishableArticle(
  page: Page,
  studio: StudioHandle,
  overlay: OverlayHandle,
  id: string,
  title: string,
) {
  const authorId = `${id}-author`
  await seedPublishedAuthor(authorId, 'Reference target')
  await seedArticleReferencing(id, authorId)

  await studio.openDocument('article', id)
  await setField(page, 'Title', title)
  await setField(page, 'Slug', id)
  await setField(page, 'Published At', '2026-08-06 12:00')
  await waitForSettled(page)

  const intent = await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === title)

  /* The button must become enabled, and the reason it is enabled must be the
   * form — not a race. Waiting on it here also means a spec that fails later
   * fails on its own assertion rather than on a click into a disabled button. */
  await expect(
    page.getByTestId('action-publish').last(),
    'Publish is still disabled after every required field is filled — read `playwright/seed.ts`',
  ).toBeEnabled({timeout: 40_000})

  return intent
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

  /**
   * PINNED, NOT ASSUMED.
   *
   * `Unpublish` is one of the six §21.2 actions the overlay routes, and in the
   * Drafts perspective Sanity does not render it — so the overlay's unpublish
   * path is unreachable from the view a Studio opens in. That is a fact about
   * `sanity@6.8.0`, and it is exactly the kind of fact that quietly changes
   * under a minor upgrade and turns a real regression into "the test was always
   * like that". Asserting the absence, with the reason, makes the upgrade break
   * here instead.
   */
  test('Unpublish is absent in the Drafts perspective — stock Sanity, not the overlay', async ({
    page,
    studio,
    overlay,
  }) => {
    await draftArticle(page, studio, overlay, 'e2e-actions-unpublish-absent', 'Unpublish probe')
    expect(
      await actionIsPresent(page, 'Unpublish'),
      '`useUnpublishAction` returns null while `selectedPerspective === "drafts"`; if this ' +
        'is now present, Sanity changed and the overlay must be re-checked against it',
    ).toBe(false)
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
   * ─────────────────────────────────────────────────────────────────────────
   * THE SKIP THIS REPLACES WAS WRONG WHEN IT WAS WRITTEN.
   *
   * It read: *"`documentActions.ts` defines `Rebase onto current base`,
   * `Resolve conflicts` and `Create checkpoint`, but `config.ts` composes only
   * the filter (`resolveOverlayDocumentActions`) — `createOverlayActionController`
   * has no production call site."*
   *
   * Every clause of that is false, and `git show 4ee709f` shows it always was:
   * the wiring and the "NOT WIRED" comment landed in the SAME commit.
   *
   *   - `config.ts` composes `overlayDocumentActionsResolver`, which filters
   *     AND APPENDS (`actions.ts`).
   *   - `createOverlayActionController` is called three times from
   *     `ui/documentActions.ts`.
   *   - It is on by default: `config.ts` defaults `documentActions` to
   *     `OverlayDocumentActions`, built in `bindings.ts`.
   *
   * So the code moved and the test did not. The code is right and this is the
   * assertion that now says what it does.
   *
   * WHAT IS DELIBERATE AND WHAT IS NOT:
   *
   *   `Create checkpoint` is OVERLAY-WIDE by §29.1 — `documentActions.ts` says
   *   so in as many words — so it appears on every document by design, not by
   *   accident. It is not scoped to the document whose pane it renders in, and
   *   pinning its presence here is what stops that being quietly re-scoped.
   *
   *   `Resolve conflicts` suppresses itself when the document carries none
   *   (`conflictDescription` returns `null`), which is why a clean draft must
   *   NOT offer it.
   */
  test('the overlay contributes its own actions, and hides the one with nothing to do', async ({
    page,
    studio,
    overlay,
  }) => {
    await draftArticle(page, studio, overlay, 'e2e-actions-overlay-own', 'Overlay actions probe')

    expect(
      await actionIsPresent(page, 'Create checkpoint'),
      '§29.1 checkpoint is overlay-wide and always offered; `bindings.ts` wires it by default',
    ).toBe(true)
    expect(
      await actionIsPresent(page, 'Rebase onto current base'),
      '§28.5 rebase is offered and disables itself with a reason when it cannot run — a ' +
        'missing button and a disabled one say different things to an editor',
    ).toBe(true)
    expect(
      await actionIsPresent(page, 'Resolve conflicts'),
      'this draft has no conflicts, so §28.3 resolution has nothing to resolve and must not ' +
        'be offered at all',
    ).toBe(false)
  })
})

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED HERE, AND WHY THE OLD REASON IS GONE.
 *
 * These tests used to be pinned as expected-red against a consistency deadlock:
 * `sanity@6.8.0` gates `publish`, `unpublish`, `discardChanges` and `delete` on
 * `isConsistent$` (`datastores` dist ~2450), which only settles when the pair
 * listener delivers the submitted transaction back, and the echo refused to
 * build that frame for a branch-created document. That is fixed: measured on
 * 2026-08-10, `Publish` on a branch-created article commits and the published
 * layer appears on disk. The comment is kept as history rather than deleted,
 * because "the tests were always like that" is how a fixed defect gets
 * un-fixed quietly.
 *
 * `duplicate` remains the control: it is the only one of the six that was never
 * in `REQUIRES_CONSISTENCY`, and it passed throughout.
 */
test.describe('effect — what each action does to the overlay on disk', () => {
  test('publish moves the value onto the published layer', async ({page, studio, overlay}) => {
    const id = 'e2e-actions-publish'
    await publishableArticle(page, studio, overlay, id, 'Ready to publish')

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
    await publishableArticle(page, studio, overlay, id, 'To be unpublished')
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title'], 'published') !== undefined)

    /**
     * THE PERSPECTIVE SWITCH IS THE TEST'S SUBJECT ARRIVING, NOT A WORKAROUND.
     *
     * The sibling test above pins that Sanity renders no `Unpublish` at all
     * while `selectedPerspective === 'drafts'` — so a spec that stayed in
     * Drafts could only ever assert that absence a second time. Unpublish lives
     * in the Published perspective; going there is how a person reaches it, and
     * it is a client-side navigation, so the page load (and with it the
     * facade's document-action key space — see `publishableArticle`) is the
     * same one that just published.
     */
    await selectPerspective(page, 'Published')

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

  /**
   * DELETE IS TESTED ON A PUBLISHED DOCUMENT, BECAUSE THAT IS THE ONLY
   * DOCUMENT §18.8 IS ABOUT.
   *
   * `del.execute` (`datastores` dist ~2171) branches on `snapshots.published`:
   *
   *     snapshots.published
   *       ? action({actionType: 'sanity.action.document.delete', publishedId, …})
   *       : action(versions.map((v) => ({actionType: 'sanity.action.document.version.discard', versionId: v})))
   *
   * For a NEVER-PUBLISHED document the second branch is taken, and `versions`
   * comes from `useDocumentVersions`, which lists release versions — empty for a
   * plain draft. So Sanity posts `client.action([])`, an empty action list, and
   * nothing is asked of the overlay at all. Measured twice: in one run the
   * Delete click produced no `/commit` after the create and the edit; in
   * another, `versions` had loaded and the request that went out was
   * `sanity.action.document.version.discard`, which the overlay translates to
   * `discardDraft` (`sanity-overlay-next/src/translate.ts:535`) — the draft
   * override vanished and `tombstones` stayed `{draft: false, published: false}`.
   *
   * Neither path can produce a tombstone, and no correct overlay could make one
   * out of an empty request. `tombstones.draft === true` for a never-published
   * document is not a thing this product can be asked for — so the spec now
   * asks for what §18.8 actually specifies: a document that exists on the
   * published layer, deleted, leaving a tombstone and its record.
   */
  test('delete tombstones rather than removing the record', async ({page, studio, overlay}) => {
    const id = 'e2e-actions-delete'
    await publishableArticle(page, studio, overlay, id, 'To be deleted')

    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title'], 'published') !== undefined, {
      what: 'the published layer to exist before Delete — §18.8 is about a published document',
    })

    await runDocumentAction(page, 'Delete')
    await confirmIfAsked(page)

    const intent = await overlay.waitForIntent(
      id,
      (value) => value.tombstones.draft === true || value.tombstones.published === true,
      {what: 'a tombstone after Delete — NOT the file disappearing'},
    )
    expect(intent.logicalId).toBe(id)
    /* The record is still there. An overlay that removed the file would let the
     * base document reappear, which is the opposite of the intent. */
    expect(overlay.ids()).toContain(id)
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

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE ONE THAT WOULD HAVE CAUGHT IT — see this file's header.
   *
   * Two publishes, in two DIFFERENT page loads, against the same overlay.
   * `studio.openDocument` is a full `page.goto`, so the second article's
   * publish is the *first* document action of a brand-new echo — which is
   * exactly the position that used to be answered from the ledger with the
   * previous page load's transaction, `committed: false, replayed: true`,
   * nothing written, and `Published` in the pane.
   *
   * The oracle is the intent on disk, never the Studio's own report: the
   * Studio's report is precisely what was wrong.
   *
   * The first publish is asserted too, and not as ceremony — without it a
   * regression that broke publishing outright would show up here as "the
   * second one failed" and be misread as this defect returning.
   */
  test('a document action in a NEW page load is not replayed away', async ({
    page,
    studio,
    overlay,
  }) => {
    const first = 'e2e-actions-reload-first'
    const second = 'e2e-actions-reload-second'

    /* ── page load 1 ── */
    await publishableArticle(page, studio, overlay, first, 'Published before the reload')
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)
    await overlay.waitForIntent(
      first,
      (value) => overrideAt(value, ['title'], 'published') === 'Published before the reload',
      {what: 'the first publish, before any reload'},
    )

    /* ── page load 2. `openDocument` is a `page.goto`: a new document, a new
     *    client, a new echo, the same `.sanity-overlay` on disk. ── */
    await publishableArticle(page, studio, overlay, second, 'Published after the reload')
    await runDocumentAction(page, 'Publish')
    await confirmIfAsked(page)

    const intent = await overlay.waitForIntent(
      second,
      (value) => overrideAt(value, ['title'], 'published') === 'Published after the reload',
      {
        what:
          'a published-layer override for the SECOND article. If this times out, the first ' +
          'document action of the new page load was answered from the §34.6 ledger with the ' +
          'previous page load’s transaction and silently dropped — the reload defect is back',
      },
    )
    expect(intent.tombstones.published).toBe(false)
    expect(overlay.manifest()!.documentHeads[second].hasPublished).toBe(true)

    /* And the first article is untouched: a replay in the other direction would
     * have overwritten it rather than the second. */
    expect(overrideAt(overlay.intent(first), ['title'], 'published')).toBe(
      'Published before the reload',
    )
  })
})
