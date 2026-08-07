/**
 * PROVENANCE CHECK FOR EVERY SELECTOR THE SUITE USES.
 *
 *     node --test e2e/playwright/selectors.test.mjs
 *
 * Runs today. Needs no Playwright and no browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 *
 * A selector that no longer exists does not fail loudly — it times out, in a
 * spec about something else, with a message about a locator rather than about
 * the product. Twelve of those after a Studio upgrade is how a suite gets
 * disabled "until someone has time".
 *
 * So the ids are checked against their source instead:
 *
 *   - Studio ids must appear literally in the PINNED BUILD,
 *     `examples/kitchen-sink/node_modules/sanity/lib/*.js` (`sanity@6.8.0`).
 *   - Overlay ids and banner headlines must appear literally in
 *     `packages/sanity-overlay-studio/src/**`.
 *
 * That makes the upgrade signal arrive here, once, naming the id — which is also
 * the "upgrade compatibility baseline" half of the Phase 5 exit that the suite
 * can contribute to mechanically.
 */
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {REPO_ROOT} from '../harness/paths.mjs'

const SANITY_LIB = join(REPO_ROOT, 'examples/kitchen-sink/node_modules/sanity/lib')
const STUDIO_SRC = join(REPO_ROOT, 'packages/sanity-overlay-studio/src')

/** The pinned versions these selectors were read off. */
const PINNED = {sanity: '6.8.0', client: '7.26.0'}

function readAll(dir, filter) {
  return readdirSync(dir)
    .filter(filter)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

function readTree(dir) {
  let out = ''
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out += readTree(full)
    else if (/\.tsx?$/.test(entry.name)) out += `${readFileSync(full, 'utf8')}\n`
  }
  return out
}

const SANITY_DIST = readAll(SANITY_LIB, (name) => name.endsWith('.js'))
const OVERLAY_SRC = readTree(STUDIO_SRC)

/* ═══════════════════════════════════════════════════ the pinned version ══ */

describe('§ the build these selectors were read from', () => {
  it('is still sanity@6.8.0 and @sanity/client@7.26.0', () => {
    const sanity = JSON.parse(
      readFileSync(join(REPO_ROOT, 'examples/kitchen-sink/node_modules/sanity/package.json'), 'utf8'),
    )
    const client = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'examples/kitchen-sink/node_modules/@sanity/client/package.json'),
        'utf8',
      ),
    )
    assert.equal(sanity.version, PINNED.sanity, 'Studio upgraded — re-verify every selector below')
    assert.equal(client.version, PINNED.client, 'client upgraded — re-verify the facade oracles too')
  })
})

/* ═════════════════════════════════════════════════ Studio-side test ids ══ */

/** Kept in step with `STUDIO` in `selectors.ts` by hand — and by this test. */
const STUDIO_IDS = [
  'studio-layout',
  'studio-navbar',
  'studio-error-screen',
  'studio-search',
  'user-menu',
  'structure-tool-list-pane',
  'document-list-pane',
  'pane',
  'pane-content',
  'pane-header',
  'pane-footer-document-status',
  'document-pane',
  'document-panel-document-title',
  'form-view',
  'string-input',
  'pt-editor',
  'default-preview__heading',
  'new-document-button',
  'action-menu-button',
  'confirm-button',
  'confirm-popover-confirm-button',
]

const HOSTED_IDS = [
  'comments-list',
  'comment-input',
  'tasks-badge',
  'tasks-toolbar',
  'releases-tool-link',
  'release-menu-button',
  'create-new-release-button',
  'scheduled-drafts-menu-item',
  'scheduled-draft-menu-button',
  'schedule-publish-menu-item',
  'schedule-button',
  'confirm-schedule-dialog',
]

describe('§ every Studio test id exists in the pinned dist', () => {
  for (const id of [...STUDIO_IDS, ...HOSTED_IDS]) {
    it(`"${id}"`, () => {
      assert.ok(
        SANITY_DIST.includes(`"${id}"`),
        `data-testid "${id}" is not in sanity@${PINNED.sanity} — the selector is stale`,
      )
    })
  }
})

describe('§ the document-action test id is built from the LABEL, not the action name', () => {
  it('the template is still `action-${toLowerCaseNoSpaces(label)}`', () => {
    assert.ok(
      SANITY_DIST.includes('`action-${toLowerCaseNoSpaces('),
      'sanity no longer derives the action test id from the label — actionTestId() is wrong',
    )
  })

  it('so `Discard changes` is `action-discardchanges`, which is NOT the `discardChanges` action id', () => {
    const actionTestId = (label) => `action-${label.toLowerCase().replace(/\s+/g, '')}`
    assert.equal(actionTestId('Publish'), 'action-publish')
    assert.equal(actionTestId('Unpublish'), 'action-unpublish')
    assert.equal(actionTestId('Discard changes'), 'action-discardchanges')
    assert.notEqual(actionTestId('Discard changes'), 'action-discardChanges')
  })
})

/* ════════════════════════════════════════════════ overlay-side test ids ══ */

describe('§ the overlay-side test ids the specs depend on', () => {
  for (const id of ['overlay-status-banner', 'overlay-fatal']) {
    it(`"${id}" is rendered by statusLayout.ts`, () => {
      assert.ok(OVERLAY_SRC.includes(`'data-testid': '${id}'`), `${id} is not rendered any more`)
    })
  }

  it('the banner still carries data-overlay-state and data-overlay-severity', () => {
    assert.ok(OVERLAY_SRC.includes("'data-overlay-state'"))
    assert.ok(OVERLAY_SRC.includes("'data-overlay-severity'"))
  })

  /**
   * Every `overlay-*` test id the package renders, listed so the surface is
   * visible — but asserted as a SUPERSET, not an equality.
   *
   * An earlier version of this test asserted the exact set and went red the
   * moment the conflict panel shipped its eleven ids. That is the wrong signal:
   * a new overlay-owned test id is a feature landing, not a regression, and a
   * suite that fails on other people's additions is a suite that gets deleted.
   * What must not happen is one DISAPPEARING, and that is what this checks.
   */
  it('the ids the browser specs use are all still rendered', () => {
    const rendered = new Set(
      [...OVERLAY_SRC.matchAll(/'data-testid':\s*'([^']+)'/g)].map((match) => match[1]),
    )
    for (const id of ['overlay-status-banner', 'overlay-fatal']) {
      assert.ok(rendered.has(id), `${id} vanished — the specs that locate it will time out`)
    }
    /* Informational: everything else the package currently renders. */
    assert.ok(rendered.size >= 2, `found ${rendered.size} overlay test ids`)
  })
})

/* ══════════════════════════════════════════════════════════ headlines ══ */

describe('§ banner headlines are quoted verbatim from status.ts', () => {
  const cases = [
    ['healthy', 'Branch overlay active. Edits stay local and never reach the shared dataset.'],
    ['overlay off', 'Overlay off — this Studio is editing the native Sanity dataset.'],
    ['signed out', 'Signed out. The overlay will not acknowledge writes; reload after signing in.'],
  ]
  for (const [name, headline] of cases) {
    it(`"${name}"`, () => {
      assert.ok(OVERLAY_SRC.includes(headline), `headline drifted: ${headline}`)
    })
  }

  it('the false "session lost" headline still exists — a spec asserts it does NOT appear', () => {
    /* Wrapped across two source lines, so match the halves. */
    assert.ok(OVERLAY_SRC.includes('Your Sanity session is no longer authenticated.'))
    assert.ok(OVERLAY_SRC.includes('token refreshes.'))
  })
})

/* ═══════════════════════════════════════ the localStorage config switch ══ */

describe('§ the Spike A escape hatch the suite must never trip', () => {
  const config = readFileSync(join(REPO_ROOT, 'examples/kitchen-sink/sanity.config.ts'), 'utf8')

  it('any non-blank SPIKE_* key in localStorage replaces the product path entirely', () => {
    for (const flag of [
      'SPIKE_LOCAL_ECHO',
      'SPIKE_API_HOST',
      'SPIKE_INSTRUMENT',
      'SPIKE_OVERLAY_PERSIST',
      'SPIKE_STRICT_QUERIES',
    ]) {
      assert.ok(config.includes(flag), `${flag} is no longer a switch — update the boot spec`)
    }
    assert.ok(config.includes('defineOverlayConfig'), 'the product path is gone')
  })
})
