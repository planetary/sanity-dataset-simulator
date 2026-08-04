/**
 * `diffMatchPatch` coordinates are **UTF-8 bytes**, not UTF-16 code units.
 *
 * ## The live failure this file pins
 *
 * A real Studio edit — typing ` — OVERLAY EDIT` after `Article 1` — produced
 *
 * ```text
 * @@ -2,8 +2,25 @@
 *  rticle 1
 * + %E2%80%94 OVERLAY EDIT
 * ```
 *
 * and the overlay commit was rejected with
 * `Hunk declares length2 25 but its context and insertions total 23 characters`.
 * The header is right and the engine was wrong: `rticle 1` (8) plus
 * ` — OVERLAY EDIT` (15 UTF-16 code units, 17 UTF-8 bytes) is 23 *characters*
 * but 25 *bytes*, and 25 is what `patch_toText` writes. The two agree only for
 * ASCII, which is why an all-ASCII suite never saw it.
 *
 * ## Why the offsets matter as much as the lengths
 *
 * `@@ -start1,length1 +start2,length2 @@` carries byte offsets too. A byte
 * offset read as a character index does not usually throw — it silently lands
 * the hunk somewhere else, which for a CMS is worse than a visible rejection.
 * `@sanity/diff-match-patch` additionally emits both starts in *rolling*
 * coordinates: each hunk's start is measured in the text as patched by the hunks
 * before it, so a leading hunk that changes byte length shifts every later
 * hunk's start.
 *
 * ## Three different numbers
 *
 * For an astral character (emoji, U+10000 and above) the code-unit count, the
 * code-point count and the byte count all differ. diff-match-patch's own
 * `countUtf8Bytes` walks *code units* and asks `codePointAt` at each one, so it
 * charges 4 bytes for the lead surrogate and a further 3 for the trailing one —
 * **7**, not the 4 a `TextEncoder` reports. `patch_make` and `patch_fromText`
 * use that convention symmetrically, so it — not the true UTF-8 length — is what
 * the wire format means. The fixtures below pin it.
 *
 * ## Provenance of the fixtures
 *
 * Every `patch` string and every `expected` string here was produced by
 * `@sanity/diff-match-patch@3.2.0` (`makePatches` → `stringifyPatches`, then
 * `parsePatch` → `applyPatches`) — the library Sanity Studio itself ships — and
 * pasted in verbatim. They are an independent oracle: no value in this file was
 * computed by the code under test.
 */
import {describe, expect, it} from 'vitest'
import {
  OverlayDiffMatchPatchError,
  applyDiffMatchPatch,
  parseDiffMatchPatch,
} from '../../sanity-overlay-core/src/index'

/** The exact patch Studio sent in the session that exposed the bug. */
const LIVE_PATCH = '@@ -2,8 +2,25 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n'
const LIVE_BASE = 'Article 1'
const LIVE_RESULT = 'Article 1 — OVERLAY EDIT'

function thrown(fn: () => unknown): OverlayDiffMatchPatchError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(OverlayDiffMatchPatchError)
    return error as OverlayDiffMatchPatchError
  }
  throw new Error('expected the call to throw, but it returned')
}

interface Fixture {
  readonly name: string
  readonly base: string
  readonly patch: string
  readonly expected: string
}

function runAll(fixtures: readonly Fixture[], verb: string): void {
  for (const fixture of fixtures) {
    it(`${verb} ${fixture.name}`, () => {
      expect(applyDiffMatchPatch(fixture.base, fixture.patch)).toBe(fixture.expected)
    })
  }
}

/* ------------------------------------------------------------------ *
 * 1. The live regression, verbatim
 * ------------------------------------------------------------------ */

describe('the live Studio em-dash edit (regression)', () => {
  it('applies the patch Studio actually sent instead of rejecting it', () => {
    expect(applyDiffMatchPatch(LIVE_BASE, LIVE_PATCH)).toBe(LIVE_RESULT)
  })

  it('reads the header coordinates as UTF-8 bytes', () => {
    /* 8 context bytes in, 25 bytes out: " — OVERLAY EDIT" is 15 code units but
     * 17 bytes, and 8 + 17 = 25. */
    expect(parseDiffMatchPatch(LIVE_PATCH)[0]).toMatchObject({
      start1: 1,
      length1: 8,
      start2: 1,
      length2: 25,
    })
  })
})

/* ------------------------------------------------------------------ *
 * 2. Insertions, one per character class
 * ------------------------------------------------------------------ */

const INSERTIONS: readonly Fixture[] = [
  {
    name: 'an em dash (U+2014) — the live case',
    base: LIVE_BASE,
    patch: LIVE_PATCH,
    expected: LIVE_RESULT,
  },
  {
    name: 'a curly apostrophe (U+2019), the character editors type constantly',
    base: 'The editors dont stop here',
    patch: '@@ -8,16 +8,19 @@\n tors don\n+%E2%80%99\n t stop h\n',
    expected: 'The editors don’t stop here',
  },
  {
    name: 'accented Latin (U+00E9) across two hunks',
    base: 'Cafe society in Montreal',
    patch:
      '@@ -1,12 +1,13 @@\n Caf\n-e\n+%C3%A9\n  society\n@@ -15,11 +15,12 @@\n in Montr\n-e\n+%C3%A9\n al\n',
    expected: 'Café society in Montréal',
  },
  {
    name: 'CJK (3 bytes per character)',
    base: 'Chapter one starts here now',
    patch: '@@ -4,16 +4,23 @@\n pter one\n+ %E4%B8%96%E7%95%8C\n  starts \n',
    expected: 'Chapter one 世界 starts here now',
  },
  {
    name: 'an emoji / surrogate pair (2 code units, 1 code point, 7 dmp bytes)',
    base: 'Release party is tonight ok',
    patch: '@@ -6,16 +6,24 @@\n se party\n+ %F0%9F%8E%89\n  is toni\n',
    expected: 'Release party \u{1F389} is tonight ok',
  },
  {
    name: 'RTL Arabic',
    base: 'title one two three four',
    patch: '@@ -1,13 +1,24 @@\n title\n+ %D9%85%D8%B1%D8%AD%D8%A8%D8%A7\n  one two\n',
    expected: 'title مرحبا one two three four',
  },
  {
    name: 'ASCII and non-ASCII mixed inside one insertion',
    base: 'plain ascii tail text here',
    patch: '@@ -1,13 +1,32 @@\n plain\n+ %E2%80%94 %C3%A9 %E4%B8%96 %F0%9F%8E%89\n  ascii t\n',
    expected: 'plain — é 世 \u{1F389} ascii tail text here',
  },
]

describe('non-ASCII insertions', () => {
  runAll(INSERTIONS, 'applies')
})

/* ------------------------------------------------------------------ *
 * 3. Non-ASCII in the *context*, not the insertion
 * ------------------------------------------------------------------ */

const CONTEXT: readonly Fixture[] = [
  {
    name: 'a 3-byte BMP character (U+20AC) in the trailing context',
    base: 'Prix 12 € euros here abc',
    patch: '@@ -3,11 +3,11 @@\n ix 1\n-2\n+5\n  %E2%82%AC e\n',
    expected: 'Prix 15 € euros here abc',
  },
  {
    name: 'CJK in the leading context',
    base: 'aaaa 世界 bbbb cccc dddd',
    patch: '@@ -9,18 +9,18 @@\n %E7%95%8C bbbb c\n-c\n+Z\n cc dddd\n',
    expected: 'aaaa 世界 bbbb cZcc dddd',
  },
  {
    name: 'an emoji in the leading context',
    base: 'aaaa \u{1F389} bbbb cccc dddd',
    patch: '@@ -6,22 +6,22 @@\n %F0%9F%8E%89 bbbb c\n-c\n+Z\n cc dddd\n',
    expected: 'aaaa \u{1F389} bbbb cZcc dddd',
  },
  {
    name: 'a combining sequence (e + U+0301) split by the hunk boundary',
    base: 'é aaaa bbbb cccc',
    patch: '@@ -2,17 +2,17 @@\n %CC%81 aaaa b\n-b\n+Z\n bb cccc\n',
    expected: 'é aaaa bZbb cccc',
  },
]

describe('non-ASCII in the hunk context', () => {
  runAll(CONTEXT, 'applies with')
})

/* ------------------------------------------------------------------ *
 * 4. Non-ASCII *before* the hunk — the start offset shifts
 * ------------------------------------------------------------------ */

const BEFORE_HUNK: readonly Fixture[] = [
  {
    name: '2-byte characters before the hunk (start 20 bytes = index 17)',
    base: '«Überschrift» aaaa bbbb cccc dddd eeee',
    patch: '@@ -21,17 +21,17 @@\n a bbbb c\n-c\n+Z\n cc dddd \n',
    expected: '«Überschrift» aaaa bbbb cZcc dddd eeee',
  },
  {
    name: '3-byte CJK before the hunk (start 22 bytes = index 10)',
    base: '世界世界世界 aaaa bbbb cccc dddd eeee',
    patch: '@@ -23,17 +23,17 @@\n a bbbb c\n-c\n+Z\n cc dddd \n',
    expected: '世界世界世界 aaaa bbbb cZcc dddd eeee',
  },
  {
    name: 'surrogate pairs before the hunk (start 18 bytes = index 8)',
    base: '\u{1F389}\u{1F389} aaaa bbbb cccc dddd eeee',
    patch: '@@ -19,17 +19,17 @@\n a bbbb c\n-c\n+Z\n cc dddd \n',
    expected: '\u{1F389}\u{1F389} aaaa bbbb cZcc dddd eeee',
  },
]

describe('non-ASCII before the hunk shifts the start offset', () => {
  runAll(BEFORE_HUNK, 'lands the hunk correctly with')

  it('does not silently apply at the character index when the two differ', () => {
    /* A run longer than dmp's MAX_BITS cannot be made unique by `addContext`, so
     * the emitted context matches at *both* the correct byte-derived index (25)
     * and the wrong character-derived index (27). A byte/character confusion
     * therefore yields a plausible wrong answer instead of an error — worse than
     * the visible rejection the live bug produced. U+2014 is 3 bytes and 1 code
     * unit, so the indices differ by 2. */
    const base = '—' + 'a'.repeat(80)
    const patch = '@@ -28,32 +28,33 @@\n aaaaaaaaaaaaaaaa\n+Z\n aaaaaaaaaaaaaaaa\n'

    const correct = '—' + 'a'.repeat(40) + 'Z' + 'a'.repeat(40)
    const misplaced = '—' + 'a'.repeat(42) + 'Z' + 'a'.repeat(38)
    expect(correct).not.toBe(misplaced)
    expect(correct).toHaveLength(misplaced.length)

    expect(applyDiffMatchPatch(base, patch)).toBe(correct)
  })

  it('does not silently apply at the character index across a surrogate pair', () => {
    /* Same construction with an astral prefix: 🎉 is 2 code units but 7 bytes by
     * dmp's own accounting, so byte 31 is index 26 while a character reading
     * gives 31 — and both match the context. (The reference library's *fuzzy*
     * applier lands this one at 31 because `adjustIndiciesToUcs2` charges the
     * pair 4 bytes rather than the 7 `patch_make` charged it; the exact answer is
     * the text `makePatches` was given, which is what is asserted here.) */
    const base = '\u{1F389}' + 'a'.repeat(80)
    const patch = '@@ -32,32 +32,33 @@\n aaaaaaaaaaaaaaaa\n+Z\n aaaaaaaaaaaaaaaa\n'

    const correct = '\u{1F389}' + 'a'.repeat(40) + 'Z' + 'a'.repeat(40)
    const misplaced = '\u{1F389}' + 'a'.repeat(45) + 'Z' + 'a'.repeat(35)
    expect(correct).not.toBe(misplaced)

    expect(applyDiffMatchPatch(base, patch)).toBe(correct)
  })
})

/* ------------------------------------------------------------------ *
 * 5. Deletions of non-ASCII
 * ------------------------------------------------------------------ */

const DELETIONS: readonly Fixture[] = [
  {
    name: 'an em dash (length1 counts its 3 bytes)',
    base: 'abcdefgh — ijklmnop qrst',
    patch: '@@ -6,11 +6,8 @@\n fgh \n-%E2%80%94\n  ijk\n',
    expected: 'abcdefgh  ijklmnop qrst',
  },
  {
    name: 'an emoji (length1 counts its 7 dmp bytes)',
    base: 'abcdefgh \u{1F389} ijklmnop qrst',
    patch: '@@ -6,15 +6,8 @@\n fgh \n-%F0%9F%8E%89\n  ijk\n',
    expected: 'abcdefgh  ijklmnop qrst',
  },
  {
    name: 'curly quotes in two hunks',
    base: 'he said “hello there” loudly ok',
    patch:
      '@@ -5,11 +5,8 @@\n aid \n-%E2%80%9C\n hell\n@@ -16,11 +16,8 @@\n here\n-%E2%80%9D\n  lou\n',
    expected: 'he said hello there loudly ok',
  },
]

describe('non-ASCII deletions', () => {
  runAll(DELETIONS, 'deletes')
})

/* ------------------------------------------------------------------ *
 * 6. Multi-hunk: an early non-ASCII hunk shifts every later start
 * ------------------------------------------------------------------ */

const PAD = 'PAD'.repeat(19)
const P50 = 'P'.repeat(50)
const Q50 = 'Q'.repeat(50)

const MULTI_HUNK: readonly Fixture[] = [
  {
    name: 'a 2-byte insertion in hunk 1 shifting hunk 2 by one byte',
    base: `alpha e beta${PAD} omega x delta`,
    patch: '@@ -1,15 +1,16 @@\n alpha \n-e\n+%C3%A9\n  betaPAD\n@@ -74,9 +74,9 @@\n ega \n-x\n+Y\n  del\n',
    expected: `alpha é beta${PAD} omega Y delta`,
  },
  {
    name: 'a surrogate-pair insertion in hunk 1 shifting hunk 2 by six bytes',
    base: `alpha e beta${PAD} omega x delta`,
    patch:
      '@@ -1,15 +1,21 @@\n alpha \n-e\n+%F0%9F%8E%89\n  betaPAD\n@@ -79,9 +79,9 @@\n ega \n-x\n+Y\n  del\n',
    expected: `alpha \u{1F389} beta${PAD} omega Y delta`,
  },
  {
    name: 'three hunks, each start measured in the text the previous ones produced',
    base: `aa e bb${P50} cc x dd${Q50} ee z ff`,
    patch:
      '@@ -1,12 +1,13 @@\n aa \n-e\n+%C3%A9\n  bbPPPPP\n@@ -59,9 +59,11 @@\n  cc \n-x\n+%E2%80%94\n  ddQ\n@@ -119,8 +119,8 @@\n  ee \n-z\n+Z\n  ff\n',
    expected: `aa é bb${P50} cc — dd${Q50} ee Z ff`,
  },
]

describe('multi-hunk patches with non-ASCII in an early hunk', () => {
  runAll(MULTI_HUNK, 'applies')
})

/* ------------------------------------------------------------------ *
 * 7. The fix must not become "accept everything"
 * ------------------------------------------------------------------ */

describe('validation survives the byte-aware rewrite', () => {
  it('rejects a length2 that is a UTF-16 count instead of a byte count', () => {
    /* The live patch with 25 rewritten to 23 — exactly the number the broken
     * engine computed. A byte-aware engine must refuse it. */
    const error = thrown(() =>
      parseDiffMatchPatch('@@ -2,8 +2,23 @@\n rticle 1\n+ %E2%80%94 OVERLAY EDIT\n'),
    )
    expect(error.code).toBe('OVERLAY_DMP_PATCH_INVALID')
    expect(error.message).toMatch(/length2/)
  })

  it('rejects a length1 that is a UTF-16 count instead of a byte count', () => {
    // The real header is `-6,15`: "fgh " (4) + emoji (7) + " ijk" (4).
    const error = thrown(() =>
      parseDiffMatchPatch('@@ -6,10 +6,8 @@\n fgh \n-%F0%9F%8E%89\n  ijk\n'),
    )
    expect(error.code).toBe('OVERLAY_DMP_PATCH_INVALID')
    expect(error.message).toMatch(/length1/)
  })

  it('rejects a TextEncoder-style astral length, pinning diff-match-patch accounting', () => {
    /* `patch_toText` charges 7 bytes for a surrogate pair (4 for the code point
     * plus 3 for the trailing lone surrogate), not the 4 a TextEncoder reports.
     * The real header is `+6,24`; 21 is the TextEncoder answer. */
    const error = thrown(() =>
      parseDiffMatchPatch('@@ -6,16 +6,21 @@\n se party\n+ %F0%9F%8E%89\n  is toni\n'),
    )
    expect(error.code).toBe('OVERLAY_DMP_PATCH_INVALID')
    expect(error.message).toMatch(/length2/)
  })

  it('refuses a non-ASCII hunk whose context genuinely does not match', () => {
    const error = thrown(() =>
      applyDiffMatchPatch('a completely different string — really', LIVE_PATCH),
    )
    expect(error.code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })

  it('refuses when only the non-ASCII part of the context differs', () => {
    /* The CJK context fixture with 界 swapped for 世 in the target: the byte
     * offsets still line up, the text does not. */
    const error = thrown(() =>
      applyDiffMatchPatch(
        'aaaa 世世 bbbb cccc dddd',
        '@@ -9,18 +9,18 @@\n %E7%95%8C bbbb c\n-c\n+Z\n cc dddd\n',
      ),
    )
    expect(error.code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })

  it('refuses a byte offset that runs past the end of a non-ASCII target', () => {
    const error = thrown(() => applyDiffMatchPatch('—ab', '@@ -40,2 +40,3 @@\n ab\n+c\n'))
    expect(error.code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })

  it('refuses a byte offset that lands strictly inside a character', () => {
    /* Byte 1 is the second byte of the 3-byte em dash, so no UTF-16 index maps
     * to it and there is nothing to match the context against. */
    const error = thrown(() => applyDiffMatchPatch('—ab', '@@ -2,2 +2,3 @@\n ab\n+c\n'))
    expect(error.code).toBe('OVERLAY_DMP_CONTEXT_MISMATCH')
  })
})

/* ------------------------------------------------------------------ *
 * 8. ASCII is unaffected
 * ------------------------------------------------------------------ */

describe('ASCII behaviour is unchanged', () => {
  it('applies an all-ASCII multi-hunk patch as emitted by the reference library', () => {
    expect(
      applyDiffMatchPatch(
        'The quick brown fox jumps over the lazy dog.',
        '@@ -1,11 +1,12 @@\n Th\n-e\n+at\n  quick b\n@@ -22,18 +22,17 @@\n jump\n-s\n+ed\n  over \n-the\n+a\n  laz\n',
      ),
    ).toBe('That quick brown fox jumped over a lazy dog.')
  })
})
