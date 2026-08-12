/**
 * Every DOM interaction the specs perform, in one file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE DEBUGGING A TIMEOUT.
 *
 * The test ids in `selectors.ts` are verified against the pinned `sanity@6.8.0`
 * dist by `selectors.test.mjs`, which runs today. **The interactions below are
 * not, and cannot be** — whether `Title` is the accessible name of the title
 * input, or whether the pane footer says `Saved`, is a fact about a rendered
 * Studio, and no static check can establish it. They were written from the
 * Studio's documented form structure and must be confirmed on the first real
 * run.
 *
 * They are all in this file for exactly that reason: when the first run finds
 * one wrong, the fix is one edit here, not twelve edits across the specs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOCATE BY WHAT A PERSON READS.
 *
 * Fields are located by accessible name rather than by test id, because the
 * Studio does not give each field a stable one — the ids it does emit
 * (`string-input`, `pt-editor`) identify the *widget kind*, and a document with
 * three string fields has three of them. An accessible name is also the thing
 * that breaks if the form stops being usable, which is the property worth
 * asserting.
 */
import {type Locator, type Page, expect} from '@playwright/test'

import {STUDIO, actionTestId, fieldTestId} from './selectors'

/** The pane the document form lives in. Scopes every field locator. */
export function documentPane(page: Page): Locator {
  return page.getByTestId(STUDIO.documentPane).last()
}

/** A scalar field, by its rendered label. */
export function field(page: Page, label: string): Locator {
  return documentPane(page).getByRole('textbox', {name: label, exact: true})
}

/**
 * Replace a field's whole value.
 *
 * `fill()` rather than `type()`: the point of these specs is the persisted
 * result, and keystroke-level behaviour — cursor jumps, dropped characters
 * under a remote patch — is PRD §35.12's *"Active scalar and Portable Text
 * fields remain client-authoritative without cursor jumps or lost keystrokes"*,
 * which needs a different and much more delicate spec than any of these. It is
 * not covered here and `e2e/README.md` says so.
 */
export async function setField(page: Page, label: string, value: string): Promise<void> {
  const input = field(page, label)
  await expect(input).toBeVisible()
  await input.fill(value)
  /* Blur commits the value and starts the autosave debounce. */
  await input.blur()
}

/**
 * Wait for Studio to report the document settled.
 *
 * THIS IS NOT THE ASSERTION. It is a *wait*. Every spec that calls it then
 * checks the disk, because "the pane says Saved" is the exact claim that was
 * false for every non-ASCII edit on 2026-08-04 while `intent.json` stayed empty.
 * Treat this as "stop typing now", never as evidence.
 */
export async function waitForSettled(page: Page, timeout = 15_000): Promise<boolean> {
  /**
   * WHICH FOOTER SURFACE, AND WHY IT IS NOT THE OBVIOUS ONE.
   *
   * The first real run found `pane-footer-document-status` absent on every
   * spec: that surface is the *last edited / last published* button and needs a
   * timestamp the document does not have until something has published it. The
   * sync state lives on `…-pulse`, which is what says `Saving...` and `Saved`
   * (`structureTool` dist ~7216).
   *
   * ───────────────────────────────────────────────────────────────────────────
   * AND WHY REACHING `Saved` IS NOT REQUIRED HERE.
   *
   * `Saved` is `documentStore.pair.consistencyStatus`, and consistency in
   * `@sanity/mutator` means *the listener delivered my own transaction back*.
   * With the overlay active the write goes to the overlay API and the base-plane
   * listener never learns of it, so the pane can sit on `Saving...` forever
   * while the file on disk is complete and correct. That is a real product
   * defect and `02-edit-persists.spec.ts` asserts it as one, by name — it must
   * not also be re-asserted implicitly by every other spec in the suite, where
   * it would show up as thirty mysterious timeouts instead of one finding.
   *
   * So: waiting for the pulse to APPEAR is required — that proves the editor
   * accepted the keystroke and started writing, and a spec whose keystroke never
   * landed must not go on to poll the disk. Waiting for it to LEAVE `Saving...`
   * is best-effort, and the caller is told which happened.
   */
  const status = page
    .getByTestId(STUDIO.paneFooterStatusPulse)
    .or(page.getByTestId(STUDIO.paneFooterStatus))
    .last()
  await expect(status).toBeVisible({timeout})
  try {
    await expect(status).not.toContainText(/saving/i, {timeout})
    return true
  } catch {
    return false
  }
}

/**
 * One field's wrapper, by schema name. The anchor for array and PT fields,
 * which render no textbox and cannot be located by accessible name the way
 * `field()` does — `add-single-primitive-button` names the widget kind, and a
 * document with two arrays has two of them.
 */
export function fieldRoot(page: Page, name: string): Locator {
  return documentPane(page).getByTestId(fieldTestId(name)).last()
}

/**
 * Type into the Portable Text editor.
 *
 * TWO DELIBERATE DEPARTURES from `setField()`:
 *
 * 1. The editor renders INERT behind a full-size "Click to activate" overlay
 *    (`ActivateOnFocus` in the dist). Typing without dismissing it goes
 *    nowhere, silently — the exact failure shape this suite exists to catch,
 *    so the overlay is clicked when present and the contenteditable is
 *    required to be focused before any key is pressed.
 *
 * 2. `pressSequentially()` rather than `fill()`. The PT editor is a synthetic-
 *    event editor: it builds its model from `beforeinput` events, and `fill()`
 *    sets the value in one programmatic step the editor never hears about.
 *    This is NOT the §35.12 keystroke spec (no concurrent remote patch, no
 *    cursor assertions) — it is just the only way to get text in at all.
 */
export async function typePortableText(page: Page, name: string, text: string): Promise<void> {
  const editor = fieldRoot(page, name).getByTestId(STUDIO.ptEditor)
  await expect(editor).toBeVisible()

  const overlay = editor.getByTestId(STUDIO.ptActivateOverlay)
  if ((await overlay.count()) > 0 && (await overlay.first().isVisible())) {
    await overlay.first().click()
  }

  const surface = editor.locator('[contenteditable="true"]').first()
  await expect(surface).toBeVisible()
  await surface.click()
  await expect(surface).toBeFocused()
  await surface.pressSequentially(text)
  await surface.blur()
}

/**
 * The open array-item edit dialog, whichever of the two ids this build gave it
 * (see `editObjectDialog` in `selectors.ts` — confirmed on a real run).
 */
export function objectEditDialog(page: Page): Locator {
  return page
    .getByTestId(STUDIO.nestedObjectDialog)
    .or(page.getByTestId(STUDIO.editPortalDialog))
    .or(page.getByTestId(STUDIO.editObjectDialog))
    .last()
}

/**
 * Add an item to an ARRAY-OF-OBJECTS field and leave its edit dialog open.
 *
 * Which button renders is a fact about the schema, not the data: one member
 * type gets `add-single-object-button`; several get `add-multiple-object-
 * button` plus a menu of member-type labels. Both paths end in the same place
 * — Studio opens the item's edit dialog.
 */
export async function addArrayObjectItem(
  page: Page,
  name: string,
  memberTypeLabel?: string,
): Promise<Locator> {
  const root = fieldRoot(page, name)
  const multiple = root.getByTestId(STUDIO.addMultipleObjectButton)
  const single = root.getByTestId(STUDIO.addSingleObjectButton)

  /* `count()` answers about the DOM AS IT IS, and asking before the form has
   * rendered answers 0 for both buttons — which silently picks the wrong
   * branch (seen once as a 90 s timeout on a button `sections` never renders).
   * Wait until whichever button this schema gets exists, THEN branch. */
  await expect(multiple.or(single).first()).toBeVisible()

  if ((await multiple.count()) > 0) {
    if (memberTypeLabel === undefined) {
      throw new Error(`array "${name}" has several member types; pass the label to insert`)
    }
    await multiple.first().click()
    await page.getByRole('menuitem', {name: memberTypeLabel, exact: false}).first().click()
  } else {
    await single.first().click()
  }

  const dialog = objectEditDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Set one field INSIDE the open array-item dialog.
 *
 * Strings and `text` areas are textboxes; numbers are spinbuttons — both
 * located by rendered label, same doctrine as `field()`. `fill()` is correct
 * here: these are plain inputs, not synthetic-event editors.
 */
export async function setDialogField(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  const dialog = objectEditDialog(page)
  const input = dialog
    .getByRole('textbox', {name: label, exact: true})
    .or(dialog.getByRole('spinbutton', {name: label, exact: true}))
  await expect(input.first()).toBeVisible()
  await input.first().fill(value)
  await input.first().blur()
}

/** Close the array-item dialog. Edits are already committed per keystroke. */
export async function closeObjectDialog(page: Page): Promise<void> {
  const dialog = objectEditDialog(page)
  const close = dialog.getByRole('button', {name: 'Close dialog', exact: true})
  if ((await close.count()) > 0) await close.first().click()
  else await page.keyboard.press('Escape')
  for (const id of [STUDIO.nestedObjectDialog, STUDIO.editPortalDialog, STUDIO.editObjectDialog]) {
    await expect(page.getByTestId(id)).toHaveCount(0)
  }
}

/**
 * Append one value to a PRIMITIVE array field (`tags`).
 *
 * By role + rendered label: the enabled "Add item" button of a primitive
 * array carries NO test id in the pinned build (the only
 * `add-single-primitive-button` in the dist is a disabled placeholder —
 * confirmed on a real run, where the test-id locator timed out against a
 * perfectly clickable button). The new item is the last unlabelled textbox
 * in the field.
 */
export async function addPrimitiveArrayItem(
  page: Page,
  name: string,
  value: string,
): Promise<void> {
  const root = fieldRoot(page, name)
  const add = root.getByRole('button', {name: 'Add item', exact: true})
  await expect(add.first()).toBeVisible()
  const before = await root.getByRole('textbox').count()
  await add.first().click()
  const input = root.getByRole('textbox').nth(before)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.blur()
}

/**
 * Invoke a document action by its rendered label.
 *
 * The primary button carries `data-testid="action-<lowercased label, no
 * spaces>"`; everything else lives behind `action-menu-button`. Both are tried,
 * primary first, because which one an action lands in depends on document state.
 */
export async function runDocumentAction(page: Page, label: string): Promise<void> {
  const primary = page.getByTestId(actionTestId(label))
  if ((await primary.count()) > 0 && (await primary.first().isEnabled())) {
    await primary.first().click()
    return
  }

  const menu = page.getByTestId(STUDIO.actionMenuButton).last()
  await expect(menu).toBeVisible()
  await menu.click()
  await page.getByRole('menuitem', {name: label, exact: false}).first().click()
}

/**
 * Confirm whichever confirmation surface the action raised.
 *
 * Sanity uses a popover for some destructive actions and a dialog for others,
 * and which one appears is not stable across actions — so both are tried and
 * neither being present is fine (some actions do not confirm at all).
 */
export async function confirmIfAsked(page: Page): Promise<void> {
  for (const testId of [STUDIO.confirmPopoverConfirm, STUDIO.confirmButton]) {
    const button = page.getByTestId(testId)
    if ((await button.count()) > 0) {
      await button.first().click()
      return
    }
  }
}

/**
 * Switch the Studio's global perspective.
 *
 * NOT A CONVENIENCE. Which document actions Sanity renders is a function of the
 * selected perspective, so a spec about `Unpublish` that never leaves Drafts is
 * asserting about a button that cannot exist there
 * (`useUnpublishAction`: `release || isDraft || … ? null : …`). Driving the
 * switcher is how a person reaches that action, and it is a client-side
 * navigation — no reload, which matters for the reason
 * `04-document-actions.spec.ts` gives at length.
 */
export async function selectPerspective(page: Page, label: string): Promise<void> {
  const button = page.getByTestId(STUDIO.globalPerspectiveMenuButton)
  await expect(button).toBeVisible()
  await button.click()
  const item = page
    .getByRole('menuitem', {name: label, exact: false})
    .or(page.getByRole('menuitemradio', {name: label, exact: false}))
  await expect(item.first()).toBeVisible()
  await item.first().click()
}

/** Is a document action offered at all? The availability half of §21.2. */
export async function actionIsPresent(page: Page, label: string): Promise<boolean> {
  if ((await page.getByTestId(actionTestId(label)).count()) > 0) return true
  const menu = page.getByTestId(STUDIO.actionMenuButton).last()
  if ((await menu.count()) === 0) return false
  await menu.click()
  const item = page.getByRole('menuitem', {name: label, exact: false})
  const present = (await item.count()) > 0
  await page.keyboard.press('Escape')
  return present
}
