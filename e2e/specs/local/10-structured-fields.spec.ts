/**
 * SCENARIO 10 — STRUCTURED FIELDS reach `intent.json`: Portable Text, keyed
 * object arrays, objects, and primitive arrays.
 *
 * PRD §17.7 (array semantics: `_key` identity for object arrays, full-array
 * touch for non-keyed primitives), §35.12 ("Edit Portable Text"), §38.1.
 * `e2e/README.md` listed exactly this as a named gap: *"Reference selection,
 * keyed-array reorder, Portable Text editing — §35.12 items with no spec
 * here."* This closes the Portable Text / array / object part of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT REDUNDANT WITH THE ~10,000 NODE TESTS.
 *
 * The Node suites drive the mutation engine with patches THEY construct. This
 * suite drives it with the patches `sanity@6.8.0` ACTUALLY EMITS from a real
 * editor — `setIfMissing` + keyed `insert` for arrays, span-level diffs for
 * Portable Text — which is the half no fixture can vouch for. The 2026-08-04
 * lesson is the standing reason: 2048 green tests could not see that every
 * non-ASCII edit was dropped, because none of them typed into the editor.
 *
 * THE ORACLE IS THE FILE. Every document here is branch-created (Mode 2 has no
 * base), so the intent is `mode: 'replace'` and `overrideAt()` walks the
 * replacement. The pane is only ever a wait, never evidence.
 *
 * DELIBERATELY OUT OF SCOPE, still named in the README's gap list: keyed-array
 * REORDER (drag), reference-picker authoring inside arrays, and the §35.12
 * keystroke line (concurrent remote patch, cursor stability).
 */
import {test, expect} from '../../playwright/fixtures'
import {overrideAt} from '../../playwright/disk'
import {
  addArrayObjectItem,
  addPrimitiveArrayItem,
  closeObjectDialog,
  setDialogField,
  setField,
  typePortableText,
  waitForSettled,
} from '../../playwright/interactions'
import {STUDIO, refreshOverlay} from '../../playwright/selectors'

const ARTICLE = 'e2e-structured-fields'

/* The em dash is not decoration: byte-counted patch headers are the class of
 * defect that silently dropped every non-ASCII edit on 2026-08-04, and the
 * Portable Text span path must prove itself against it too. */
const PT_TEXT = 'Portable Text on the branch — proven on disk'
const QUOTE = 'The overlay is the whole world.'
const ATTRIBUTION = 'Mode 2'
const STATS_HEADING = 'Branch stats'
const STATS_COUNT = '42'
const TAGS = ['overlay', 'e2e']

/** The concatenated visible text of one Portable Text block. */
function blockText(block: unknown): string {
  const children = (block as {children?: Array<{text?: unknown}>}).children ?? []
  return children.map((span) => (typeof span.text === 'string' ? span.text : '')).join('')
}

test.describe('Portable Text, keyed object arrays and primitive arrays land on disk', () => {
  test('A · a typed Portable Text paragraph lands as a keyed block', async ({
    page,
    studio,
    overlay,
  }) => {
    expect(overlay.ids(), 'the overlay must start empty').toEqual([])

    await studio.openDocument('article', ARTICLE)
    await typePortableText(page, 'body', PT_TEXT)
    await waitForSettled(page)

    const intent = await overlay.waitForIntent(
      ARTICLE,
      (value) => {
        const body = overrideAt(value, ['body'])
        return Array.isArray(body) && body.some((block) => blockText(block) === PT_TEXT)
      },
      {what: `a body block reading "${PT_TEXT}" in intent.json`},
    )

    const body = overrideAt(intent, ['body']) as Array<Record<string, unknown>>
    const block = body.find((candidate) => blockText(candidate) === PT_TEXT)!

    /* `_key` identity is what §17.7 merge semantics stand on; a block that
     * reached disk without one would merge by index and corrupt on rebase. */
    expect(block._type).toBe('block')
    expect(typeof block._key).toBe('string')
    expect((block._key as string).length).toBeGreaterThan(0)
    const spans = block.children as Array<Record<string, unknown>>
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      expect(typeof span._key).toBe('string')
      expect(span._type).toBe('span')
    }

    /* The exact string, em dash included — not a substring match. */
    expect(blockText(block)).toBe(PT_TEXT)

    expect(intent.touchedPaths.some((path) => path[0] === 'body')).toBe(true)
    expect(overlay.transactions().length).toBeGreaterThan(0)
  })

  test('B · keyed object-array items land with _key, typed fields and a real number', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)

    /* Two member types, so the multiple-button + menu path is the one under
     * test — and both member types are inserted, because "the first menu item
     * works" is a weaker claim than "the menu routes by type". */
    await addArrayObjectItem(page, 'sections', 'Quote Section')
    await setDialogField(page, 'Quote', QUOTE)
    await setDialogField(page, 'Attribution', ATTRIBUTION)
    await closeObjectDialog(page)

    await addArrayObjectItem(page, 'sections', 'Stats Section')
    await setDialogField(page, 'Heading', STATS_HEADING)
    await setDialogField(page, 'Count', STATS_COUNT)
    await closeObjectDialog(page)
    await waitForSettled(page)

    const intent = await overlay.waitForIntent(
      ARTICLE,
      (value) => {
        const sections = overrideAt(value, ['sections'])
        return (
          Array.isArray(sections) &&
          sections.length === 2 &&
          sections.some((item) => (item as {quote?: unknown}).quote === QUOTE) &&
          sections.some((item) => (item as {heading?: unknown}).heading === STATS_HEADING)
        )
      },
      {what: 'both sections, with their field values, in intent.json'},
    )

    const sections = overrideAt(intent, ['sections']) as Array<Record<string, unknown>>
    const quote = sections.find((item) => item._type === 'quoteSection')!
    const stats = sections.find((item) => item._type === 'statsSection')!

    expect(quote).toBeDefined()
    expect(stats).toBeDefined()
    expect(quote.quote).toBe(QUOTE)
    expect(quote.attribution).toBe(ATTRIBUTION)
    expect(stats.heading).toBe(STATS_HEADING)

    /* A number field that lands as the STRING "42" is a silent schema
     * corruption GROQ comparisons would then miss. */
    expect(stats.count).toBe(42)

    for (const item of sections) {
      expect(typeof item._key).toBe('string')
      expect((item._key as string).length).toBeGreaterThan(0)
    }
    expect(quote._key).not.toBe(stats._key)

    expect(intent.touchedPaths.some((path) => path[0] === 'sections')).toBe(true)
  })

  test('C · editing a field of an EXISTING keyed item updates by _key, not by rewrite', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await addArrayObjectItem(page, 'sections', 'Quote Section')
    await setDialogField(page, 'Quote', 'first value')
    await closeObjectDialog(page)
    await overlay.waitForIntent(ARTICLE, (value) => {
      const sections = overrideAt(value, ['sections'])
      return Array.isArray(sections) && (sections[0] as {quote?: unknown})?.quote === 'first value'
    })
    const before = overrideAt(overlay.intent(ARTICLE), ['sections']) as Array<
      Record<string, unknown>
    >
    const keyBefore = before[0]._key

    /* Reopen the SAME item through its row, edit, and the _key must survive —
     * a rewrite that re-keys the array merges as delete+insert and destroys
     * any concurrent edit to the same item. The row renders as a plain button
     * named by the item's preview title ("Untitled" — quoteSection declares no
     * preview), not as a `default-preview__heading` (confirmed on a real run). */
    await page
      .getByTestId('field-sections')
      .getByRole('button', {name: 'Untitled', exact: true})
      .first()
      .click()
    await setDialogField(page, 'Quote', QUOTE)
    await closeObjectDialog(page)

    const intent = await overlay.waitForIntent(ARTICLE, (value) => {
      const sections = overrideAt(value, ['sections'])
      return Array.isArray(sections) && (sections[0] as {quote?: unknown})?.quote === QUOTE
    })
    const after = overrideAt(intent, ['sections']) as Array<Record<string, unknown>>
    expect(after).toHaveLength(1)
    expect(after[0]._key).toBe(keyBefore)
  })

  test('D · primitive array items land in order, as strings', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    for (const tag of TAGS) {
      await addPrimitiveArrayItem(page, 'tags', tag)
    }
    await waitForSettled(page)

    const intent = await overlay.waitForIntent(
      ARTICLE,
      (value) => JSON.stringify(overrideAt(value, ['tags'])) === JSON.stringify(TAGS),
      {what: `tags ${JSON.stringify(TAGS)} in intent.json`},
    )
    expect(intent.touchedPaths.some((path) => path[0] === 'tags')).toBe(true)
  })

  test('E · every structured value survives a full reload, in the form AND on disk', async ({
    page,
    studio,
    overlay,
  }) => {
    await studio.openDocument('article', ARTICLE)
    await setField(page, 'Title', 'Structured fields article')
    await typePortableText(page, 'body', PT_TEXT)
    await addArrayObjectItem(page, 'sections', 'Quote Section')
    await setDialogField(page, 'Quote', QUOTE)
    await closeObjectDialog(page)
    await addPrimitiveArrayItem(page, 'tags', TAGS[0])
    await waitForSettled(page)

    await overlay.waitForIntent(ARTICLE, (value) => {
      const body = overrideAt(value, ['body'])
      const sections = overrideAt(value, ['sections'])
      const tags = overrideAt(value, ['tags'])
      return (
        Array.isArray(body) &&
        body.some((block) => blockText(block) === PT_TEXT) &&
        Array.isArray(sections) &&
        (sections[0] as {quote?: unknown})?.quote === QUOTE &&
        Array.isArray(tags) &&
        tags[0] === TAGS[0]
      )
    })

    await page.reload({waitUntil: 'domcontentloaded'})
    await studio.openDocument('article', ARTICLE)
    await refreshOverlay(page)

    /* The read path, through the form a person sees. The tag is an <input>
     * VALUE, which `toContainText` cannot see — text content assertions only
     * cover rendered text like the PT block. */
    const pane = page.getByTestId(STUDIO.documentPane).last()
    await expect(pane).toContainText(PT_TEXT, {timeout: 30_000})
    await expect(
      pane.getByTestId('field-tags').getByRole('textbox').first(),
    ).toHaveValue(TAGS[0])

    /* And the files did not change shape under the reload. */
    const intent = overlay.intent(ARTICLE)
    const body = overrideAt(intent, ['body']) as Array<Record<string, unknown>>
    expect(body.some((block) => blockText(block) === PT_TEXT)).toBe(true)
    const sections = overrideAt(intent, ['sections']) as Array<Record<string, unknown>>
    expect((sections[0] as {quote?: unknown}).quote).toBe(QUOTE)
    expect(overrideAt(intent, ['tags'])).toEqual([TAGS[0]])
  })
})
