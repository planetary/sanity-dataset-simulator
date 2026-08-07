/**
 * Selectors, with their provenance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE WAS INVENTED.
 *
 * Studio-side test ids were read out of the **pinned build** —
 * `examples/kitchen-sink/node_modules/sanity/lib/*.js`, `sanity@6.8.0` — not
 * guessed from the docs and not copied from a blog post. `selectors.test.mjs`
 * re-extracts them from that same dist at test time and fails if one disappears,
 * so a Studio upgrade that renames a test id turns this file red instead of
 * turning twelve specs into mysterious timeouts. That is the same discipline
 * `spike-a-facade-gaps.test.ts` uses against the installed client's prototypes.
 *
 * Overlay-side test ids come from `sanity-overlay-studio/src/ui/statusLayout.ts`
 * and are the only two the overlay ships.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOCUMENT-ACTION IDS ARE DERIVED FROM LABELS, NOT FROM ACTION NAMES.
 *
 * `sanity@6.8.0` builds the primary action button as
 *
 *     data-testid={`action-${toLowerCaseNoSpaces(firstActionState.label)}`}
 *
 * so the id is a function of the **rendered, translated label** — `Publish` →
 * `action-publish`, `Discard changes` → `action-discardchanges`. It is not the
 * stable `action` identifier the overlay filters on. Two consequences the specs
 * must respect: the ids below are en-US only, and an action whose label changes
 * with document state (`Publish` vs `Published`) changes its id with it. Where
 * that matters the specs locate by role and accessible name instead, which is
 * what a person reads.
 */
import type {Locator, Page} from '@playwright/test'

/* ══════════════════════════════════════════════ overlay-owned test ids ══ */

/** `statusLayout.ts:161`. Present iff the overlay runtime is registered. */
export const OVERLAY_BANNER = 'overlay-status-banner'

/** `statusLayout.ts:172`. Replaces the whole Studio in a fatal state. */
export const OVERLAY_FATAL = 'overlay-fatal'

/** `status.ts` — the value of `data-overlay-state` on the banner. */
export type OverlayBannerState =
  | 'healthy'
  | 'saving'
  | 'offline'
  | 'soft-conflict'
  | 'hard-conflict'
  | 'schema-mismatch'
  | 'unauthenticated'
  | 'identity-mismatch'
  | 'disabled-unexpectedly'

/** Headlines, verbatim from `packages/sanity-overlay-studio/src/status.ts`. */
export const HEADLINE = {
  healthy: 'Branch overlay active. Edits stay local and never reach the shared dataset.',
  overlayOff: 'Overlay off — this Studio is editing the native Sanity dataset.',
  loggedOut: 'Signed out. The overlay will not acknowledge writes; reload after signing in.',
  /** The FALSE banner a guard 403 used to produce. A spec asserts it is absent. */
  sessionLost:
    'Your Sanity session is no longer authenticated. Editing is read-only until the token refreshes.',
  identityMismatch:
    'Overlay identity mismatch: the stored overlay was written for a different branch, ' +
    'repository or dataset. Reads and writes are stopped.',
} as const

/* ═════════════════════════════════════════ sanity@6.8.0 dist test ids ══ */

/**
 * Every id below appears literally in `sanity/lib/*.js`. Keep this object in
 * sync with `selectors.test.mjs`, which is what proves that claim.
 */
export const STUDIO = {
  layout: 'studio-layout',
  navbar: 'studio-navbar',
  errorScreen: 'studio-error-screen',
  search: 'studio-search',
  userMenu: 'user-menu',

  structureListPane: 'structure-tool-list-pane',
  documentListPane: 'document-list-pane',
  pane: 'pane',
  paneContent: 'pane-content',
  paneHeader: 'pane-header',
  paneFooterStatus: 'pane-footer-document-status',

  documentPane: 'document-pane',
  documentTitle: 'document-panel-document-title',
  formView: 'form-view',
  stringInput: 'string-input',
  ptEditor: 'pt-editor',
  previewHeading: 'default-preview__heading',
  newDocumentButton: 'new-document-button',
  actionMenuButton: 'action-menu-button',
  confirmButton: 'confirm-button',
  confirmPopoverConfirm: 'confirm-popover-confirm-button',

  /* Hosted surfaces. Their ABSENCE is the assertion. */
  hosted: {
    commentsList: 'comments-list',
    commentInput: 'comment-input',
    tasksBadge: 'tasks-badge',
    tasksToolbar: 'tasks-toolbar',
    releasesToolLink: 'releases-tool-link',
    releaseMenuButton: 'release-menu-button',
    createNewReleaseButton: 'create-new-release-button',
    scheduledDraftsMenuItem: 'scheduled-drafts-menu-item',
    scheduleDraftMenuButton: 'scheduled-draft-menu-button',
    schedulePublishMenuItem: 'schedule-publish-menu-item',
    scheduleButton: 'schedule-button',
    confirmScheduleDialog: 'confirm-schedule-dialog',
  },
} as const

/**
 * The primary document-action button.
 *
 * `toLowerCaseNoSpaces` is `label.toLowerCase()` with whitespace removed, so
 * pass the label as a user sees it: `action('Discard changes')` →
 * `[data-testid="action-discardchanges"]`.
 */
export function actionTestId(label: string): string {
  return `action-${label.toLowerCase().replace(/\s+/g, '')}`
}

/* ═════════════════════════════════════════════════════════ locators ══ */

export const banner = (page: Page): Locator => page.getByTestId(OVERLAY_BANNER)

/** The `data-overlay-state` currently on the banner. */
export async function bannerState(page: Page): Promise<string | null> {
  return banner(page).getAttribute('data-overlay-state')
}

/**
 * Force a banner refresh instead of waiting out the 5 s poll.
 *
 * `createOverlayStatusLayout` polls `runtime.refresh()` on an interval, so a
 * state change driven by the server can lag by up to `pollMs`. The devtools
 * handle exists precisely so a test does not have to sleep — and calling it is
 * not "asking the page whether it is healthy", it is asking the page to re-read
 * the server. Every assertion afterwards is still against the DOM or the disk.
 */
export async function refreshOverlay(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const handle = (window as unknown as {__SANITY_OVERLAY__?: {refresh: () => Promise<void>}})
      .__SANITY_OVERLAY__
    if (handle !== undefined) await handle.refresh()
  })
}

/** Is the product path installed at all? `undefined` means `mode: off`. */
export async function overlayHandleInstalled(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof (window as unknown as Record<string, unknown>).__SANITY_OVERLAY__ !== 'undefined',
  )
}

/** Deep-link straight to a document pane, skipping list navigation. */
export function documentUrl(type: string, id: string): string {
  return `/structure/${encodeURIComponent(type)};${encodeURIComponent(id)}`
}
