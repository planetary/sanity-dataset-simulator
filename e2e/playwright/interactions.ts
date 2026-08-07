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

import {STUDIO, actionTestId} from './selectors'

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
export async function waitForSettled(page: Page, timeout = 20_000): Promise<void> {
  const status = page.getByTestId(STUDIO.paneFooterStatus).last()
  await expect(status).toBeVisible({timeout})
  await expect(status).not.toContainText(/saving/i, {timeout})
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
