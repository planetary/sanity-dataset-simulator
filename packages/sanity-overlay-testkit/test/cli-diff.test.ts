/**
 * `diff` — what this branch changed versus its base, per document and per path.
 *
 * The oracle is the base dataset the fixture seeded from, not anything the CLI
 * computed: `title` was `Base article title` in base and `Branch article title`
 * after the edit, so the diff must say exactly that, at exactly the path
 * `title`. Keyed array identity is asserted through `_key`, never through an
 * index, because an index-addressed diff is wrong the moment an item moves.
 */
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT, diffValues} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

afterEach(cleanupOverlayFixtures)

interface DiffEntry {
  path: string
  kind: string
  before?: unknown
  after?: unknown
}

interface DiffDocument {
  logicalId: string
  schemaType: string
  state: string
  perspectives: {draft?: DiffEntry[]; published?: DiffEntry[]}
}

async function diffJson(root: string, argv: string[] = []): Promise<any> {
  const run = await runCliCapture(['diff', '--json', ...argv], {cwd: root})
  return {run, parsed: JSON.parse(run.stdout)}
}

describe('diff', () => {
  it('reports a scalar change with both sides at the exact path', async () => {
    const {root} = await createOverlayFixture()
    const {run, parsed} = await diffJson(root)
    expect(run.code).toBe(EXIT.OK)

    const article: DiffDocument = parsed.documents.find(
      (doc: DiffDocument) => doc.logicalId === 'article-1',
    )
    expect(article.state).toBe('modified')
    const title = article.perspectives.draft!.find((entry) => entry.path === 'title')
    expect(title).toEqual({
      path: 'title',
      kind: 'changed',
      before: 'Base article title',
      after: 'Branch article title',
    })
  })

  it('addresses a keyed array item by _key, not by index', async () => {
    const {root} = await createOverlayFixture()
    const {parsed} = await diffJson(root)
    const article = parsed.documents.find((doc: DiffDocument) => doc.logicalId === 'article-1')
    const entry = article.perspectives.draft.find(
      (item: DiffEntry) => item.path === 'body[_key=="block-b"].text',
    )
    expect(entry).toEqual({
      path: 'body[_key=="block-b"].text',
      kind: 'changed',
      before: 'second',
      after: 'second, edited',
    })
  })

  it('reports an unset as a removal carrying the base value', async () => {
    const {root} = await createOverlayFixture()
    const {parsed} = await diffJson(root)
    const article = parsed.documents.find((doc: DiffDocument) => doc.logicalId === 'article-1')
    const entry = article.perspectives.draft.find((item: DiffEntry) => item.path === 'tags')
    expect(entry.kind).toBe('removed')
    expect(entry.before).toEqual(['base'])
    expect(entry).not.toHaveProperty('after')
  })

  it('reports a branch-created document as created with every field added', async () => {
    const {root} = await createOverlayFixture()
    const {parsed} = await diffJson(root)
    const created = parsed.documents.find((doc: DiffDocument) => doc.logicalId === 'article-2')
    expect(created.state).toBe('created')
    const paths = created.perspectives.published.map((entry: DiffEntry) => entry.path)
    expect(paths).toEqual(expect.arrayContaining(['title', 'slug.current']))
    for (const entry of created.perspectives.published) expect(entry.kind).toBe('added')
  })

  it('reports a delete as a deleted document with no path entries', async () => {
    const {root} = await createOverlayFixture({edits: [{kind: 'delete', id: 'page-home'}]})
    const {parsed} = await diffJson(root)
    const deleted = parsed.documents.find((doc: DiffDocument) => doc.logicalId === 'page-home')
    expect(deleted.state).toBe('deleted')
    expect(deleted.perspectives.draft ?? []).toEqual([])
    expect(deleted.perspectives.published ?? []).toEqual([])
  })

  it('hides churning system fields by default and shows them with --system', async () => {
    const {root} = await createOverlayFixture()
    const quiet = await diffJson(root)
    const loud = await diffJson(root, ['--system'])

    const quietPaths = JSON.stringify(quiet.parsed)
    expect(quietPaths).not.toContain('"_rev"')
    expect(quietPaths).not.toContain('"_updatedAt"')
    expect(JSON.stringify(loud.parsed)).toContain('_updatedAt')
  })

  /**
   * A draft's materialized `_id` is `drafts.<logicalId>` BY CONSTRUCTION
   * (PRD §13.9), so diffing it against a base published snapshot always reports
   * `_id` as changed. That is a property of the perspective, not an edit anyone
   * made, and reporting it trains the reader to ignore the diff.
   */
  it('never reports the §13.9 perspective _id as an edit', async () => {
    const {root} = await createOverlayFixture()
    const {parsed} = await diffJson(root)
    const article = parsed.documents.find((doc: DiffDocument) => doc.logicalId === 'article-1')
    expect(article.perspectives.draft.map((entry: DiffEntry) => entry.path)).not.toContain('_id')
  })

  /** The whole hidden-by-default family, and its escape hatch, in one place. */
  it.each(['_rev', '_updatedAt', '_id'])(
    'hides %s by default and shows it with --system',
    async (fieldName) => {
      const {root} = await createOverlayFixture()
      const quiet = await diffJson(root)
      const loud = await diffJson(root, ['--system'])

      const paths = (result: any): string[] =>
        result.documents.flatMap((doc: DiffDocument) =>
          Object.values(doc.perspectives).flatMap((entries) =>
            (entries ?? []).map((entry) => entry.path),
          ),
        )

      expect(paths(quiet.parsed)).not.toContain(fieldName)
      expect(paths(loud.parsed)).toContain(fieldName)
    },
  )

  it('--document restricts to one document', async () => {
    const {root} = await createOverlayFixture()
    const {parsed} = await diffJson(root, ['--document', 'article-1'])
    expect(parsed.documents.map((doc: DiffDocument) => doc.logicalId)).toEqual(['article-1'])
  })

  it('--name-only lists changed document IDs in sorted order', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['diff', '--name-only'], {cwd: root})
    expect(run.code).toBe(EXIT.OK)
    expect(run.stdout.trim().split('\n')).toEqual(['article-1', 'article-2'])
  })

  it('--exit-code exits FINDINGS when the branch diverges and OK when it does not', async () => {
    const changed = await createOverlayFixture()
    const untouched = await createOverlayFixture({edits: []})

    const dirty = await runCliCapture(['diff', '--exit-code'], {cwd: changed.root})
    const clean = await runCliCapture(['diff', '--exit-code'], {cwd: untouched.root})

    expect(dirty.code).toBe(EXIT.FINDINGS)
    expect(clean.code).toBe(EXIT.OK)
  })

  it('is byte-stable across runs', async () => {
    const {root} = await createOverlayFixture()
    const first = await runCliCapture(['diff'], {cwd: root})
    const second = await runCliCapture(['diff'], {cwd: root})
    expect(second.stdout).toBe(first.stdout)
    expect(first.stdout.length).toBeGreaterThan(0)
  })

  it('orders path entries deterministically regardless of edit order', async () => {
    const forward = await createOverlayFixture({
      edits: [
        {
          kind: 'edit',
          id: 'article-1',
          operations: [
            {type: 'set', path: ['title'], value: 'X'},
            {type: 'set', path: ['author', '_ref'], value: 'author-9'},
          ],
        },
      ],
    })
    const reverse = await createOverlayFixture({
      edits: [
        {
          kind: 'edit',
          id: 'article-1',
          operations: [
            {type: 'set', path: ['author', '_ref'], value: 'author-9'},
            {type: 'set', path: ['title'], value: 'X'},
          ],
        },
      ],
    })

    const a = await runCliCapture(['diff'], {cwd: forward.root})
    const b = await runCliCapture(['diff'], {cwd: reverse.root})
    expect(b.stdout).toBe(a.stdout)
  })

  it('human output shows the before and after of a change', async () => {
    const {root} = await createOverlayFixture()
    const run = await runCliCapture(['diff'], {cwd: root})
    expect(run.stdout).toContain('article-1')
    expect(run.stdout).toContain('- "Base article title"')
    expect(run.stdout).toContain('+ "Branch article title"')
  })
})

/* ------------------------------------------------------------------ *
 * Regression — separator collisions in keyed-array reorder detection
 * ------------------------------------------------------------------ *
 *
 * `diffValues` has to answer "were the surviving keys reordered?", and a diff
 * that answers "no" to a real reorder is worse than no diff at all: it reports
 * a document as unchanged at that path, so a reviewer approves a promotion that
 * silently rewrites array order.
 *
 * Answering it by joining both key sequences into one string and comparing the
 * strings makes the answer depend on whether a `_key` contains the separator.
 * Nothing validates `_key` against that, and the collision is not exotic: for
 * ANY separator S, the two distinct orderings of the keys `k` and `k + S + k`
 * both join to `k + S + k + S + k`, so a genuine reorder compares equal and no
 * entry is emitted. The comparison must be element-wise, which is separator-free
 * by construction — hence the whole family below rather than one instance.
 *
 * The separator originally chosen here was a literal NUL byte written into
 * `src/diff.ts`, which carried a second consequence: git classifies a file
 * containing NUL as binary, so `git diff` reports only "Binary files differ" and
 * `grep`/`rg` skip it. `repo-hygiene.test.ts` guards that half repo-wide.
 */

const REORDER_SEPARATORS: ReadonlyArray<{name: string; char: string}> = [
  {name: 'a NUL', char: '\u0000'},
  {name: 'a space', char: ' '},
  {name: 'a comma', char: ','},
  {name: 'a pipe', char: '|'},
  {name: 'a newline', char: '\n'},
  {name: 'a tab', char: '\t'},
]

function bodyOf(
  keys: readonly string[],
  texts: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  return {
    body: keys.map((key) => ({
      _key: key,
      _type: 'block',
      ...(texts[key] === undefined ? {} : {text: texts[key]}),
    })),
  }
}

describe('keyed-array reorder detection is separator-independent (PRD §17.7, §34.17)', () => {
  for (const {name, char} of REORDER_SEPARATORS) {
    /* The collision pair: `k` and `k + S + k` joined by S are order-invariant. */
    const short = 'ab'
    const long = `ab${char}ab`

    it(`reports a real reorder when a _key contains ${name}`, () => {
      const entries = diffValues(bodyOf([short, long]), bodyOf([long, short]))

      /* Independent oracle: the two documents hold the same two items in
       * genuinely opposite order, and relative order is not addressable by key,
       * so the array itself is the only correct place to report it. */
      expect(entries).toEqual([
        {path: 'body', kind: 'changed', before: [short, long], after: [long, short]},
      ])
    })

    it(`reports only the field edit when order is unchanged and a _key contains ${name}`, () => {
      const entries = diffValues(bodyOf([short, long]), bodyOf([short, long], {[short]: 'edited'}))

      expect(entries).toEqual([{path: `body[_key=="${short}"].text`, kind: 'added', after: 'edited'}])
    })
  }
})
