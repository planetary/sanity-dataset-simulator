/**
 * LIVE — staging is untouched, asserted against the UPSTREAM API.
 *
 *     E2E_MODE=live pnpm exec playwright test
 *
 * PRD §38.1: *"Staging cannot be mutated."*
 * Roadmap Phase 5 exit: *"network audit shows no staging writes."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CANNOT BE DONE IN THE HERMETIC PROJECT.
 *
 * `specs/local/` runs Mode 2, where there is no upstream at all — the proxy
 * answers everything from disk and refuses any bind but loopback. That is a
 * *structural* guarantee and a strong one, but it is not the claim the exit
 * criterion makes. "Staging is untouched" is a statement about a real dataset,
 * and the only witness that can make it is the dataset.
 *
 * So this spec, alone in the suite, needs a real project and a READ token. It is
 * skipped with a stated reason when they are absent — never silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE INDEPENDENT WITNESSES, IN INCREASING STRENGTH.
 *
 *   1. **`_rev` is unchanged.** Content Lake changes `_rev` on every mutation.
 *      An unchanged `_rev` across a full editing session is a positive statement
 *      about the document, not an absence of observation.
 *   2. **No `drafts.<id>` was created.** The classic leak: an overlay edit that
 *      fell through to the native draft path leaves a draft upstream even when
 *      the published document is untouched. §35.12's *"No network write reaches
 *      Sanity"* is not discharged by checking the published document alone.
 *   3. **The proxy log has no forwarded write.** Asserted by
 *      `specs/local/99-network-audit.spec.ts` over the same predicates; repeated
 *      here against the live-mode log because the *escape surface is different*
 *      when there is a real upstream to escape to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE BYPASSES THE PROXY, ON PURPOSE.
 *
 * `upstream.ts` calls `<project>.api.sanity.io` directly from Node. Reading
 * through :3999 would let a proxy that quietly served overlay content report the
 * dataset unchanged because it was answering from `.sanity-overlay/`.
 */
import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {STUDIO} from '../../playwright/selectors'
import {
  fingerprint,
  getUpstreamDocument,
  liveCredentialsAvailable,
  upstreamQuery,
} from '../../playwright/upstream'
import {auditProxyLog, formatResults} from '../../audit/predicates.mjs'
import {readLog} from '../../audit/logModel.mjs'
import {PROXY_LOG} from '../../harness/paths.mjs'
import {runStartedAt} from '../../harness/runDir.mjs'

/**
 * A document that exists in the `parity` dataset. `article-01` is the one every
 * evidence document in this repo uses, so a failure here is comparable with
 * previous sessions rather than being about a new fixture.
 */
const BASE_DOCUMENT = 'article-01'
const BRANCH_TITLE = 'Branch override — staging must not see this ✅ 日本語'

test.skip(
  !liveCredentialsAvailable(),
  'no Sanity READ token found (SANITY_API_READ_TOKEN in .env). The live project ' +
    'cannot assert against the upstream API without one, and asserting anything ' +
    'weaker here would be worse than skipping.',
)

test.describe('editing on the branch leaves staging byte-identical', () => {
  test('the base document exists upstream before we start', async () => {
    const document = await getUpstreamDocument(BASE_DOCUMENT)
    expect(
      document,
      `${BASE_DOCUMENT} is not in the dataset. Re-seed with:\n` +
        `  cd examples/kitchen-sink && pnpm exec sanity dataset import ` +
        `../../packages/sanity-overlay-testkit/fixtures/dataset.ndjson parity --replace`,
    ).not.toBeNull()
    expect(typeof document!._rev).toBe('string')
  })

  test('a full edit session changes the overlay and NOT the dataset', async ({
    page,
    studio,
    overlay,
  }) => {
    /* Witness 1, captured before anything happens. */
    const before = await fingerprint(BASE_DOCUMENT)
    const draftsBefore = await upstreamQuery<string[]>(
      `*[_id == "drafts.${BASE_DOCUMENT}"]._id`,
    )

    await studio.openDocument('article', BASE_DOCUMENT)
    await setField(page, 'Title', BRANCH_TITLE)
    await waitForSettled(page)

    /* The edit landed — on the OVERLAY. Without this the rest of the test is
     * "nothing changed because nothing happened", which passes trivially. */
    await overlay.waitForIntent(
      BASE_DOCUMENT,
      (value) => overrideAt(value, ['title']) === BRANCH_TITLE,
      {what: 'the branch override on disk — otherwise the session wrote nothing'},
    )

    const after = await fingerprint(BASE_DOCUMENT)
    expect(after, `staging document ${BASE_DOCUMENT} was MUTATED`).toBe(before)

    /* Witness 2: no native draft appeared. */
    const draftsAfter = await upstreamQuery<string[]>(`*[_id == "drafts.${BASE_DOCUMENT}"]._id`)
    expect(draftsAfter, 'a drafts.<id> document was created upstream').toEqual(draftsBefore)
  })

  test('the branch title is what the Studio shows, while the dataset still says otherwise', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', BASE_DOCUMENT)
    await setField(page, 'Title', BRANCH_TITLE)
    await waitForSettled(page)
    await overlay.waitForIntent(
      BASE_DOCUMENT,
      (value) => overrideAt(value, ['title']) === BRANCH_TITLE,
    )

    await expect(page.getByTestId(STUDIO.documentPane).last()).toContainText(BRANCH_TITLE, {
      timeout: 30_000,
    })

    /* The same document, read from the dataset, still carries the base title.
     * Two different answers to the same id at the same moment is exactly what a
     * branch overlay is, and it is only observable with a real upstream. */
    const upstream = await getUpstreamDocument(BASE_DOCUMENT)
    expect(upstream!.title).not.toBe(BRANCH_TITLE)
  })

  test('a branch-EDITED document shows its BRANCH title in the list pane', async ({
    page,
    studio,
    overlay,
  }) => {
    /* The half `specs/local/06-list-panes.spec.ts` cannot reach: the pane must
     * render the overlay value *over* a base document that already exists. This
     * is the shape of the defect the acceptance audit records as "a list pane
     * that rendered staging while every test passed". */
    await studio.openDocument('article', BASE_DOCUMENT)
    await setField(page, 'Title', BRANCH_TITLE)
    await waitForSettled(page)
    await overlay.waitForIntent(
      BASE_DOCUMENT,
      (value) => overrideAt(value, ['title']) === BRANCH_TITLE,
    )

    await page.goto('/structure/article', {waitUntil: 'domcontentloaded'})
    const pane = page.getByTestId(STUDIO.structureListPane).last()
    await expect(pane, 'the list pane is rendering the STAGING title over a branch edit').toContainText(
      BRANCH_TITLE,
      {timeout: 30_000},
    )
  })

  test('and the server-side proxy log records no forwarded write', () => {
    const results = auditProxyLog({log: readLog(PROXY_LOG), runStartedAt: runStartedAt()})
    const {ok, text} = formatResults(results)
    expect(ok, `\n${text}\n`).toBe(true)
  })
})
