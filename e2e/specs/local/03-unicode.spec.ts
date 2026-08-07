/**
 * SCENARIO 3 — non-ASCII content survives the round trip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE SPEC THE WHOLE SUITE EXISTS FOR.
 *
 * From `docs/plans/HANDOFF.md` §3:
 *
 *     "Every non-ASCII edit was silently lost. diff-match-patch headers count
 *      UTF-8 BYTES; the parser counted JS CHARACTERS. The editor showed success
 *      while the overlay stayed empty. Found only by typing an em dash in a live
 *      browser — 2048 green tests could not see it."
 *
 * Two further defects surfaced in the same code and both are covered below:
 *
 *   - **astral characters count 7 bytes, not 4.** A `TextEncoder`-based "fix"
 *     computes 4 and rejects valid patches. So an emoji outside the BMP is not
 *     the same test as an emoji inside it, and both are here.
 *   - **hunk starts are rolling.** `start1 + offset` misplaced hunk 2 of *any*
 *     multi-hunk patch, including pure ASCII. A single edit produces one hunk
 *     and cannot see it; the multi-hunk case is the last test in this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASSERTION IS BYTES ON DISK, AND IT IS EXACT.
 *
 * `toContainText` would pass on a value that lost a character in the middle, and
 * a normalising comparison would pass on NFC/NFD drift. Every assertion here is
 * `toBe` against the exact string, plus an explicit code-point-count check —
 * because "the title looks right" is precisely what was true while the data was
 * being dropped.
 */
import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {setField, waitForSettled} from '../../playwright/interactions'
import {STUDIO} from '../../playwright/selectors'

/**
 * The exact string from the live 2026-08-04 session that first exposed the bug,
 * kept verbatim: an em dash (U+2014), a BMP emoji with a variation selector, and
 * CJK. It is already on disk in `examples/kitchen-sink/.sanity-overlay/` as
 * evidence of that session.
 */
const THE_ORIGINAL_CASE = 'Article 1 — OVERLAY EDIT ✅ 日本語'

const CASES: ReadonlyArray<readonly [name: string, value: string]> = [
  ['the original live case', THE_ORIGINAL_CASE],
  ['em dash alone — the character that found the bug', 'Before — after'],
  ['astral emoji (surrogate pair, 7 diff-match-patch bytes)', 'Deploy 🚀 now'],
  ['emoji with variation selector and ZWJ sequence', 'Team 👩‍💻 ships ✅'],
  ['CJK', '日本語のタイトル'],
  ['RTL', 'العنوان بالعربية'],
  ['combining marks that NFC and NFD disagree about', 'Café vs Café'],
  ['a character above the BMP that is not an emoji', '𝕭𝖗𝖆𝖓𝖈𝖍'],
]

test.describe('non-ASCII content survives the round trip', () => {
  for (const [name, value] of CASES) {
    test(`${name}`, async ({page, studio, overlay}) => {
      const id = `e2e-unicode-${CASES.findIndex(([label]) => label === name)}`

      await studio.openDocument('article', id)
      await setField(page, 'Title', value)
      await waitForSettled(page)

      const intent = await overlay.waitForIntent(
        id,
        (candidate) => overrideAt(candidate, ['title']) !== undefined,
        {what: `any title override for ${id} — an EMPTY overlay is the historical failure`},
      )

      const stored = overrideAt(intent, ['title'])

      /* Exact, not `toContain`. A patch that dropped the character after the
       * multi-byte one produces a value that still "contains" the prefix. */
      expect(stored).toBe(value)

      /* And an independent count, because two strings can compare equal in a
       * message that renders identically while differing in normalisation. */
      expect([...String(stored)].length).toBe([...value].length)
      expect(Buffer.byteLength(String(stored), 'utf8')).toBe(Buffer.byteLength(value, 'utf8'))
    })
  }

  test('the value reads back through the form after a reload, not just off disk', async ({
    page,
    studio,
    overlay,
  }) => {
    const id = 'e2e-unicode-readback'
    await studio.openDocument('article', id)
    await setField(page, 'Title', THE_ORIGINAL_CASE)
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === THE_ORIGINAL_CASE)

    await page.reload({waitUntil: 'domcontentloaded'})
    await studio.openDocument('article', id)

    await expect(page.getByTestId(STUDIO.documentPane).last()).toContainText(THE_ORIGINAL_CASE, {
      timeout: 30_000,
    })
  })

  /**
   * THE MULTI-HUNK CASE.
   *
   * `start1 + offset` misplaced hunk 2 of any patch with more than one hunk —
   * including pure ASCII, which is why a Unicode-only suite would have missed
   * it. Two edits far apart in a long string is the smallest input that produces
   * two hunks.
   */
  test('a two-hunk patch places BOTH hunks correctly', async ({page, studio, overlay}) => {
    const id = 'e2e-unicode-multihunk'
    const filler = ' middle text that is long enough to separate the two hunks '.repeat(4)
    const first = `START${filler}END`
    const second = `START—CHANGED${filler}CHANGED—END`

    await studio.openDocument('article', id)
    await setField(page, 'Title', first)
    await waitForSettled(page)
    await overlay.waitForIntent(id, (value) => overrideAt(value, ['title']) === first)

    await setField(page, 'Title', second)
    await waitForSettled(page)
    const intent = await overlay.waitForIntent(
      id,
      (value) => overrideAt(value, ['title']) !== first,
      {what: 'the second, two-hunk edit to land'},
    )

    expect(overrideAt(intent, ['title'])).toBe(second)
  })
})
