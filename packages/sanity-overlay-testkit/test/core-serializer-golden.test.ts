/**
 * Committed golden bytes for the canonical serializer (PRD §14.3, §34.17,
 * plan §10 "Serializer output is byte-identical for the same logical state").
 *
 * The existing serializer tests compare two values produced **in the same
 * process** — different key-insertion orders, repeated evaluation — which proves
 * the emitter is a function of its input but says nothing about drift between
 * runs, between checkouts or between engine versions. A checksum is a promise
 * about *bytes*, and §13.2 hashes exactly these bytes, so the only test that can
 * catch a drift is one whose expectation was produced by a different process and
 * committed to the repository. That is this file.
 *
 * The expected text below was derived **by hand from the §14.3 rules**, not
 * captured from a run:
 *
 * - keys sorted by UTF-16 code unit, recursively (so `""` < `"10"` < `"2"` <
 *   `"_id"` — digits `0x30-0x39`, then `_` `0x5F`, then lowercase `0x61+`);
 * - two-space indent, one trailing newline;
 * - arrays keep their order — order is data;
 * - `-0` normalized to `0`;
 * - empty object and empty array emitted inline;
 * - non-ASCII and well-formed surrogate pairs emitted raw, `\\` and `\t` escaped.
 *
 * The §10 checklist also asks for verification "across platforms and Node
 * versions in CI". There is no CI in this repository (no `.github/`, no workflow
 * file of any kind), so that half cannot be satisfied here and is **not** claimed
 * by this file. A committed golden closes the cross-run and cross-checkout half
 * without one.
 */
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {checksum, parse, serialize} from '../../sanity-overlay-core/src/index'

/* ------------------------------------------------------------------ *
 * The subject
 * ------------------------------------------------------------------ */

/**
 * One document exercising every rule that could drift: integer-like keys (which
 * JavaScript reorders ahead of string keys in `Object.keys`), the empty-string
 * key, `_`-prefixed system fields, nesting, an empty object and an empty array,
 * `-0`, `null` inside an array, a backslash, a tab, a non-BMP emoji and
 * non-ASCII letters and punctuation.
 */
function goldenDocument(): Record<string, unknown> {
  return {
    _id: 'drafts.article-1',
    _type: 'article',
    '10': 'ten',
    '2': 'two',
    '': 'empty key',
    title: 'Ünïcødé — “quoted” \\ backslash\ttab',
    emoji: '👋🏽',
    zero: -0,
    nested: {b: [1, 2, {z: true, a: null}], a: {}},
    list: [],
    flag: false,
  }
}

/** The same logical value, built in a different key-insertion order. */
function goldenDocumentShuffled(): Record<string, unknown> {
  return {
    zero: -0,
    nested: {a: {}, b: [1, 2, {a: null, z: true}]},
    flag: false,
    '2': 'two',
    title: 'Ünïcødé — “quoted” \\ backslash\ttab',
    '': 'empty key',
    list: [],
    _type: 'article',
    emoji: '👋🏽',
    '10': 'ten',
    _id: 'drafts.article-1',
  }
}

/** Hand-derived from the §14.3 rules. Lines are joined with `\n`, plus a final one. */
const GOLDEN_LINES = [
  '{',
  '  "": "empty key",',
  '  "10": "ten",',
  '  "2": "two",',
  '  "_id": "drafts.article-1",',
  '  "_type": "article",',
  '  "emoji": "👋🏽",',
  '  "flag": false,',
  '  "list": [],',
  '  "nested": {',
  '    "a": {},',
  '    "b": [',
  '      1,',
  '      2,',
  '      {',
  '        "a": null,',
  '        "z": true',
  '      }',
  '    ]',
  '  },',
  '  "title": "Ünïcødé — “quoted” \\\\ backslash\\ttab",',
  '  "zero": 0',
  '}',
]

const GOLDEN_BYTES = `${GOLDEN_LINES.join('\n')}\n`

/**
 * SHA-256 of `GOLDEN_BYTES` as UTF-8, hex. Committed so a drift in *either* the
 * serializer or the checksum is caught by a literal that no run can rewrite.
 */
const GOLDEN_SHA256 = '493fa2a2b7d7fdfb0acc2bbf7c84a33653cde2aaf4359530443ea2a8d0faa303'

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

describe('canonical serializer golden bytes (PRD §14.3, §34.17, plan §10)', () => {
  it('emits exactly the committed bytes', () => {
    expect(serialize(goldenDocument())).toBe(GOLDEN_BYTES)
  })

  it('emits the same bytes from a different key-insertion order', () => {
    expect(serialize(goldenDocumentShuffled())).toBe(GOLDEN_BYTES)
  })

  it('hashes to the committed digest, cross-checked against node:crypto', () => {
    // Independent oracle: `node:crypto` never sees core's checksum code.
    const oracle = createHash('sha256').update(GOLDEN_BYTES, 'utf8').digest('hex')
    expect(oracle).toBe(GOLDEN_SHA256)
    // And core's §13.2 checksum is taken over exactly these bytes.
    expect(checksum(goldenDocument())).toBe(GOLDEN_SHA256)
    expect(checksum(goldenDocumentShuffled())).toBe(GOLDEN_SHA256)
  })

  it('round-trips the committed bytes through parse (§14.3 fixpoint)', () => {
    expect(serialize(parse(GOLDEN_BYTES))).toBe(GOLDEN_BYTES)
  })

  it('pins the byte length, so an invisible whitespace drift cannot pass', () => {
    // Counted in UTF-8 bytes, not UTF-16 code units: the emoji is 8 bytes and the
    // non-ASCII letters and punctuation are 2-3 each.
    expect(new TextEncoder().encode(GOLDEN_BYTES).length).toBe(350)
    expect(GOLDEN_BYTES.endsWith('}\n')).toBe(true)
    expect(GOLDEN_BYTES.includes('\n\n')).toBe(false)
  })
})
