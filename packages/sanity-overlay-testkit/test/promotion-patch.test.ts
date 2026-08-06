import {readdirSync, readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {
  diffDocuments,
  PROMOTION_IGNORED_FIELDS,
} from '../../sanity-overlay-core/src/promotion/index'
import type {SanityDocument} from '../../sanity-overlay-core/src/index'

// Phase 8 — minimal patch generation (PRD §30.4 steps 7-8, §14.3, §29.2).
//
// "Calculate minimal target patches where safe. Use full create or replace only
// when required." Every expectation below is an independently written operation
// list, never a value `diffDocuments` computed.

const TARGET: SanityDocument = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'rev-target-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Old title',
  legacy: 'drop me',
  seo: {description: 'old description', keywords: ['a', 'b']},
  sections: [
    {_key: 'sec-a', _type: 'block', heading: 'A'},
    {_key: 'sec-b', _type: 'block', heading: 'B'},
  ],
}

describe('diffDocuments — minimal patches (PRD §30.4 step 7)', () => {
  it('emits one set for one changed scalar, and nothing else', () => {
    const desired: SanityDocument = {...TARGET, title: 'New title'}

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'set', path: ['title'], value: 'New title'}])
    expect(result.wholeDocument).toBe(false)
  })

  it('never emits replaceDocument for a document that only changed a field', () => {
    const desired: SanityDocument = {...TARGET, title: 'New title'}

    const result = diffDocuments(TARGET, desired)

    expect(result.operations.map((operation) => operation.type)).not.toContain('replaceDocument')
  })

  it('descends into nested objects instead of setting the whole object', () => {
    const desired: SanityDocument = {
      ...TARGET,
      seo: {description: 'new description', keywords: ['a', 'b']},
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([
      {type: 'set', path: ['seo', 'description'], value: 'new description'},
    ])
  })

  it('unsets fields removed from the desired document', () => {
    const {legacy: _dropped, ...rest} = TARGET
    const desired = rest as SanityDocument

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'unset', path: ['legacy']}])
  })

  it('sets a field the target does not have yet', () => {
    const desired: SanityDocument = {...TARGET, subtitle: 'Added'}

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'set', path: ['subtitle'], value: 'Added'}])
  })

  it('ignores synthetic overlay system fields (PRD §13.9, §22 timestamp policy)', () => {
    const desired: SanityDocument = {
      ...TARGET,
      _id: 'drafts.article-1',
      _rev: 'overlay:7:abc',
      _createdAt: '2026-08-04T00:00:00.000Z',
      _updatedAt: '2026-08-04T00:00:00.000Z',
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([])
    expect(result.identical).toBe(true)
    expect([...PROMOTION_IGNORED_FIELDS].sort()).toEqual([
      '_createdAt',
      '_id',
      '_rev',
      '_updatedAt',
    ])
  })

  it('descends into keyed array items by _key, not by index', () => {
    const desired: SanityDocument = {
      ...TARGET,
      sections: [
        {_key: 'sec-a', _type: 'block', heading: 'A'},
        {_key: 'sec-b', _type: 'block', heading: 'B changed'},
      ],
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([
      {type: 'set', path: ['sections', {_key: 'sec-b'}, 'heading'], value: 'B changed'},
    ])
  })

  it('unsets a removed keyed array item by key', () => {
    const desired: SanityDocument = {
      ...TARGET,
      sections: [{_key: 'sec-a', _type: 'block', heading: 'A'}],
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'unset', path: ['sections', {_key: 'sec-b'}]}])
  })

  it('inserts a new keyed item after its predecessor rather than resetting the array', () => {
    const desired: SanityDocument = {
      ...TARGET,
      sections: [
        {_key: 'sec-a', _type: 'block', heading: 'A'},
        {_key: 'sec-c', _type: 'block', heading: 'C'},
        {_key: 'sec-b', _type: 'block', heading: 'B'},
      ],
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([
      {
        type: 'insert',
        path: ['sections', {_key: 'sec-a'}],
        position: 'after',
        items: [{_key: 'sec-c', _type: 'block', heading: 'C'}],
      },
    ])
  })

  it('inserts before the first surviving item when the new item leads the array', () => {
    const desired: SanityDocument = {
      ...TARGET,
      sections: [
        {_key: 'sec-z', _type: 'block', heading: 'Z'},
        {_key: 'sec-a', _type: 'block', heading: 'A'},
        {_key: 'sec-b', _type: 'block', heading: 'B'},
      ],
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([
      {
        type: 'insert',
        path: ['sections', {_key: 'sec-a'}],
        position: 'before',
        items: [{_key: 'sec-z', _type: 'block', heading: 'Z'}],
      },
    ])
  })

  it('falls back to setting the whole array when surviving keys were reordered', () => {
    const reordered = [
      {_key: 'sec-b', _type: 'block', heading: 'B'},
      {_key: 'sec-a', _type: 'block', heading: 'A'},
    ]
    const desired: SanityDocument = {...TARGET, sections: reordered}

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'set', path: ['sections'], value: reordered}])
    // A reorder is a whole-*array* fallback, never a whole-*document* one.
    expect(result.wholeDocument).toBe(false)
  })

  it('sets the whole array when items are unkeyed (PRD §13.6 numeric-index rule)', () => {
    const target: SanityDocument = {_id: 'x', _type: 'thing', tags: ['a', 'b']}
    const desired: SanityDocument = {_id: 'x', _type: 'thing', tags: ['a', 'c']}

    const result = diffDocuments(target, desired)

    expect(result.operations).toEqual([{type: 'set', path: ['tags'], value: ['a', 'c']}])
  })

  it('sets the whole value when a path changes shape (object becomes scalar)', () => {
    const desired: SanityDocument = {...TARGET, seo: 'flattened'}

    const result = diffDocuments(TARGET, desired)

    expect(result.operations).toEqual([{type: 'set', path: ['seo'], value: 'flattened'}])
  })

  it('is a whole-document replace only when _type changed', () => {
    const desired: SanityDocument = {...TARGET, _type: 'note'}

    const result = diffDocuments(TARGET, desired)

    expect(result.wholeDocument).toBe(true)
    expect(result.typeChanged).toBe(true)
    expect(result.operations).toEqual([{type: 'replaceDocument', document: desired}])
  })

  it('creates the whole document when the target is absent', () => {
    const result = diffDocuments(null, TARGET)

    expect(result.wholeDocument).toBe(true)
    expect(result.operations).toEqual([{type: 'replaceDocument', document: TARGET}])
  })

  it('orders operations deterministically: unsets, then sets, then inserts', () => {
    const desired: SanityDocument = {
      _id: 'article-1',
      _type: 'article',
      title: 'New title',
      seo: {description: 'old description', keywords: ['a', 'b']},
      sections: [
        {_key: 'sec-a', _type: 'block', heading: 'A'},
        {_key: 'sec-b', _type: 'block', heading: 'B'},
        {_key: 'sec-c', _type: 'block', heading: 'C'},
      ],
    }

    const result = diffDocuments(TARGET, desired)

    expect(result.operations.map((operation) => operation.type)).toEqual(['unset', 'set', 'insert'])
    expect(result.operations[0]).toEqual({type: 'unset', path: ['legacy']})
    expect(result.operations[1]).toEqual({type: 'set', path: ['title'], value: 'New title'})
  })

  it('is deterministic: the same inputs produce byte-identical operations', () => {
    const desired: SanityDocument = {...TARGET, title: 'New title', subtitle: 'Added'}

    expect(JSON.stringify(diffDocuments(TARGET, desired).operations)).toBe(
      JSON.stringify(diffDocuments(TARGET, desired).operations),
    )
  })

  it('reports every changed path so a reviewer can be shown field-level changes', () => {
    const {legacy: _dropped, ...rest} = TARGET
    const desired: SanityDocument = {...rest, title: 'New title', subtitle: 'Added'}

    const result = diffDocuments(TARGET, desired)

    expect(result.changes).toEqual([
      {path: ['legacy'], kind: 'remove', before: 'drop me'},
      {path: ['subtitle'], kind: 'add', after: 'Added'},
      {path: ['title'], kind: 'change', before: 'Old title', after: 'New title'},
    ])
  })
})

// ---------------------------------------------------------------------------
// Regression — separator collisions in keyed-array reorder detection, and the
// source-hygiene defect that hid one of them from review.
//
// `diffKeyedArray` has to answer "were the surviving keys reordered?" That
// answer picks between a targeted per-item patch and a whole-array `set`, so
// getting it wrong silently emits operations that produce the wrong array — a
// data-correctness bug, not a cosmetic one.
//
// Answering it by joining both key sequences into strings and comparing the
// strings makes the answer depend on whether a `_key` contains the separator.
// Nothing validates `_key` against that, and the collision is not exotic: for
// any separator S, the two distinct orderings of the keys `k` and `k + S + k`
// both join to `k + S + k + S + k`, so a genuine reorder compares equal and the
// diff takes the targeted branch it was supposed to reject.
//
// The separator originally chosen was a literal NUL byte written into the
// source file, which carried a second and worse consequence: git classifies a
// file containing NUL as binary, so `git diff` reports only "Binary files
// differ" and every content change in it becomes invisible to diff review.
// `grep`/`rg` skip the file for the same reason. Source files must stay text.

const SEPARATORS: ReadonlyArray<{name: string; char: string}> = [
  {name: 'a NUL', char: '\u0000'},
  {name: 'a space', char: ' '},
  {name: 'a comma', char: ','},
  {name: 'a pipe', char: '|'},
  {name: 'a newline', char: '\n'},
]

function sectionsDoc(keys: readonly string[], headings?: Readonly<Record<string, string>>): SanityDocument {
  return {
    _id: 'article-1',
    _type: 'article',
    _rev: 'rev-1',
    sections: keys.map((key) => ({
      _key: key,
      _type: 'block',
      ...(headings?.[key] === undefined ? {} : {heading: headings[key]}),
    })),
  }
}

describe('keyed-array reorder detection is separator-independent (PRD §13.6, §17.7)', () => {
  for (const {name, char} of SEPARATORS) {
    // The collision pair: `k` and `k + S + k` joined by S are order-invariant.
    const short = 'ab'
    const long = `ab${char}ab`

    it(`detects a real reorder when a _key contains ${name}`, () => {
      const before = sectionsDoc([short, long])
      const after = sectionsDoc([long, short])

      const result = diffDocuments(before, after)

      // Independent oracle: the surviving keys genuinely swapped places, and
      // relative order is not addressable by key, so the whole array is the
      // only correct target.
      expect(result.operations).toEqual([
        {type: 'set', path: ['sections'], value: sectionsDoc([long, short]).sections},
      ])
    })

    it(`still patches in place when order is unchanged and a _key contains ${name}`, () => {
      const before = sectionsDoc([short, long])
      const after = sectionsDoc([short, long], {[short]: 'edited'})

      const result = diffDocuments(before, after)

      expect(result.operations).toEqual([
        {type: 'set', path: ['sections', {_key: short}, 'heading'], value: 'edited'},
      ])
    })
  }
})

describe('promotion sources are reviewable plain text', () => {
  it('contains no NUL or control bytes, so git diff and grep still work', () => {
    // Both halves of the module: the sources and the tests that read them. A
    // NUL in either one is a file git will not show a content diff for.
    const roots = [
      {dir: fileURLToPath(new URL('../../sanity-overlay-core/src/promotion/', import.meta.url)), match: (n: string) => n.endsWith('.ts')},
      {dir: fileURLToPath(new URL('./', import.meta.url)), match: (n: string) => n.startsWith('promotion-') && n.endsWith('.ts')},
    ]

    const offenders: string[] = []
    for (const {dir, match} of roots) {
      for (const name of readdirSync(dir).sort()) {
        if (!match(name)) continue
        const bytes = readFileSync(dir + name)
        for (let index = 0; index < bytes.length; index += 1) {
          const byte = bytes[index] as number
          const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 13
          if (byte < 32 && !isAllowedWhitespace) {
            offenders.push(`${name}: byte 0x${byte.toString(16).padStart(2, '0')} at offset ${index}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
