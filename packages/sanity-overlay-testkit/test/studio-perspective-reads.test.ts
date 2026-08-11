/**
 * THE LIST PANE SHOWED STAGING, AND THE REASON WAS THE PERSPECTIVE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT, observed live on 2026-08-06.
 *
 * The overlay held an edited `article-01`
 * (`Article 1 — OVERLAY EDIT ✅ 日本語`, overlay revision 2, a DRAFT edit).
 * The Studio article list rendered `Article 1`, `Article 2 (DRAFT: retitled)`,
 * `Article 3` — staging, every row.
 *
 * THE CAUSE, and it is not the planner. `reads.ts` refused every read carrying
 * a `perspective` other than `'raw'`, and **sanity@6.8.0 attaches one to every
 * content read the structure tool makes**:
 *
 *   - the list's own content query — `PaneContainer-Bp8RN3ON.js:883`,
 *     `perspective: perspectiveStack` → `listenSearchQuery` → `createSearch`
 *     → `useBundleDocuments-BYW8M9LS.js:20292`
 *     `client.observable.fetch(query, params, options)` with
 *     `options = {tag, perspective}`;
 *   - **the row titles** — `datastores-DqFH7RLd.js:910-913`,
 *     `apiClient.observable.fetch(toQuery(chunk), {}, {tag: 'preview.document-paths', perspective})`.
 *
 * So the refusal was total in practice: 100% of the list pane's content reads
 * were recorded passthroughs and answered by the base dataset. The refusal was
 * deliberate and documented ("a perspective the hosted API collapses
 * server-side cannot be reproduced exactly here") — it is the *consequence*
 * that was never measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE COLLAPSE IS EXACT AND NOT AN APPROXIMATION (PRD §5.5, §22.2).
 *
 * A perspective is a view over the DATASET, not a transform of an answer. So it
 * is applied to the candidate pool — draft wins over published, per logical id —
 * and `groq-js` then evaluates the caller's own query text over that pool,
 * exactly once, unchanged. Nothing post-processes an evaluated result.
 *
 * The pool is provably complete because the version set of a logical id is
 * `{id, drafts.id}` — the same two-element argument `readPlan.ts` already makes
 * for `sanity::versionOf` — so an `ids` request widened to both addresses
 * selects it in full, and a raw `_type` fetch returns both by construction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE QUERY TEXT IS PINNED FROM THE LIBRARY, NOT REMEMBERED. Every query below
 * is built by the same rules as the installed `sanity@6.8.0` with its file:line
 * cited, and §5 asserts those constructs are still present in the installed
 * package — so an upgrade that changes them turns this file red rather than
 * quietly making it fiction.
 */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {createStudioReader, type StudioReadRecord} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {
  OverlayHydrationDocument,
  OverlayTransport,
} from '../../sanity-overlay-studio/src/client/transport'
import type {OverlaySource} from '../../sanity-overlay-query/src/overlaySource'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────── the live fixture */

/** Staging, as the parity dataset holds it. `Article 2` has a retitled draft. */
const STAGING: Rec[] = [
  {_id: 'article-01', _type: 'article', _rev: 'base-1', title: 'Article 1'},
  {_id: 'drafts.article-01', _type: 'article', _rev: 'base-2', title: 'Article 1'},
  {_id: 'article-02', _type: 'article', _rev: 'base-3', title: 'Article 2'},
  {_id: 'drafts.article-02', _type: 'article', _rev: 'base-4', title: 'Article 2 (DRAFT: retitled)'},
  {_id: 'article-03', _type: 'article', _rev: 'base-5', title: 'Article 3'},
]

const OVERLAY_TITLE = 'Article 1 — OVERLAY EDIT ✅ 日本語'

/**
 * The branch, exactly as `.sanity-overlay/manifest.json` records it for the
 * live session: `article-01`, `hasDraft: true`, `hasPublished: false`.
 */
const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-01',
    schemaType: 'article',
    draft: {_id: 'drafts.article-01', _type: 'article', title: OVERLAY_TITLE},
    published: null,
  },
]

/* ─────────────────────────────────────────── the queries sanity 6.8.0 issues */

/**
 * `datastores-DqFH7RLd.js:855-861` — `toQuery([toSubQuery({ids, fields})])`,
 * with `INCLUDE_FIELDS_QUERY = ['_id','_rev','_type']` (`:141-144`) ahead of the
 * preview's own fields. This is the query that decides what a LIST ROW SAYS.
 */
function previewDocumentPathsQuery(ids: string[], fields: string[] = ['title']): string {
  const idList = ids.map((id) => JSON.stringify(id)).join(',')
  const allFields = ['_id', '_rev', '_type', ...fields].join(',')
  return `[*[_id in [${idList}]][0...${ids.length}]{${allFields}}][0...1]`
}

/**
 * `useBundleDocuments-BYW8M9LS.js:20141-20185` — the groq2024 list query, with
 * no search term (`skipSortByScore`, so `isScored` is false and `baseMatch` is
 * a filter rather than a score).
 */
const LIST_CONTENT_QUERY =
  '// findability-mvi:5\n// findability-source: list\n' +
  '*[_type in $__types && ([@, _id] match text::query($__query) || references($__rawQuery))] ' +
  '{_type, _id, _originalId, "orderings": [@._createdAt]} | order(_createdAt desc) [0...$__limit]'

/** `PaneContainer-Bp8RN3ON.js:653` — the type probe the list runs first. */
const LIST_TYPE_PROBE = 'array::unique(*[_type == "article"][]._type)'

/**
 * `PaneContainer-Bp8RN3ON.js:850,883` — `usePerspective().perspectiveStack`,
 * which is `['drafts']` with no release selected. An ARRAY, not a string.
 */
const DRAFTS_STACK = ['drafts']

/* ─────────────────────────────────────────────────────────────── the rig */

function inertTransport(): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok'}),
    operation: async () => ({outcome: 'ok'}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  }
}

interface Rig {
  wrapped: Rec
  issued: {query: string; params: Rec}[]
  records: StudioReadRecord[]
}

function rig(branch: OverlayHydrationDocument[] = BRANCH): Rig {
  const issued: {query: string; params: Rec}[] = []
  const records: StudioReadRecord[] = []
  const overlay: OverlaySource = overlaySourceFromBranch(branch)

  const client: Rec = {
    fetch: async (query: string, params: Rec = {}): Promise<unknown> => {
      issued.push({query, params})
      const {parse, evaluate} = await import('groq-js')
      return await (await evaluate(parse(query), {dataset: STAGING, params})).get()
    },
  }

  const wrapped = wrapWithOverlay(client, {
    echo: createOverlayEcho(),
    transport: inertTransport(),
    reads: createStudioReader({
      overlay: () => overlay,
      strict: () => false,
      onRecord: (record) => records.push(record),
    }),
  }) as unknown as Rec

  return {wrapped, issued, records}
}

const read = (rigged: Rig, query: string, params: Rec = {}, options?: unknown): Promise<unknown> =>
  (rigged.wrapped.fetch as (q: string, p?: Rec, o?: unknown) => Promise<unknown>)(
    query,
    params,
    options,
  )

/* ══════════════════════════════════════════════════════════════════ §1 */

describe('§1 the reported defect: the row title Studio actually asks for', () => {
  it('CONTROL — with no perspective, the raw read already answers from the branch', async () => {
    const rigged = rig()
    const rows = (await read(rigged, previewDocumentPathsQuery(['drafts.article-01']))) as Rec[][]
    expect(rows[0]?.[0]?.title).toBe(OVERLAY_TITLE)
  })

  it('answers `preview.document-paths` from the branch under perspective ["drafts"]', async () => {
    const rigged = rig()
    /* `createObserveFields` uses the PUBLISHED id when a perspective is set
     * (`datastores-DqFH7RLd.js:928`), and the branch edit is a DRAFT — which is
     * exactly the collapse the perspective exists to perform. */
    const rows = (await read(
      rigged,
      previewDocumentPathsQuery(['article-01']),
      {},
      {tag: 'preview.document-paths', perspective: DRAFTS_STACK},
    )) as Rec[][]

    expect(rows[0]?.[0]?.title).toBe(OVERLAY_TITLE)
    /* The negative control: staging really does say something else. */
    expect(STAGING.find((doc) => doc._id === 'article-01')?.title).toBe('Article 1')
  })

  it('addresses the collapsed row at the PUBLISHED id, as the hosted API does', async () => {
    const rigged = rig()
    const rows = (await read(
      rigged,
      previewDocumentPathsQuery(['article-01']),
      {},
      {perspective: DRAFTS_STACK},
    )) as Rec[][]
    expect(rows[0]?.[0]?._id).toBe('article-01')
  })

  it('records the read as answered by the overlay, not as a passthrough', async () => {
    const rigged = rig()
    await read(
      rigged,
      previewDocumentPathsQuery(['article-01']),
      {},
      {perspective: DRAFTS_STACK},
    )
    expect(rigged.records[0]?.outcome).toBe('overlay')
  })

  it('accepts the string spelling too — `perspective: "drafts"`', async () => {
    const rigged = rig()
    const rows = (await read(
      rigged,
      previewDocumentPathsQuery(['article-01']),
      {},
      {perspective: 'drafts'},
    )) as Rec[][]
    expect(rows[0]?.[0]?.title).toBe(OVERLAY_TITLE)
  })

  it('leaves a document the branch never touched exactly as staging has it', async () => {
    const rigged = rig()
    const rows = (await read(
      rigged,
      previewDocumentPathsQuery(['article-02']),
      {},
      {perspective: DRAFTS_STACK},
    )) as Rec[][]
    /* Base's own draft wins over base's published — that is the perspective
     * working, and it is what put "(DRAFT: retitled)" on the live screen. */
    expect(rows[0]?.[0]?.title).toBe('Article 2 (DRAFT: retitled)')
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 */

describe('§2 the collapse rule, case by case', () => {
  const draftsRead = (rigged: Rig, ids: string[]): Promise<unknown> =>
    read(rigged, `*[_id in ${JSON.stringify(ids)}]{_id, _originalId, title}`, {}, {
      perspective: DRAFTS_STACK,
    })

  it('a branch-created draft with no published sibling appears at the published id', async () => {
    const rigged = rig([
      {
        logicalId: 'article-99',
        schemaType: 'article',
        draft: {_id: 'drafts.article-99', _type: 'article', title: 'branch only'},
      },
    ])
    expect(await draftsRead(rigged, ['article-99'])).toEqual([
      {_id: 'article-99', _originalId: 'drafts.article-99', title: 'branch only'},
    ])
  })

  it('the branch’s OWN draft beats the branch’s own published body', async () => {
    /* Draft precedence is the whole rule, and it has to be pinned where both
     * versions exist — a branch holding only a draft agrees with a collapse
     * that got the precedence backwards. */
    const rigged = rig([
      {
        logicalId: 'article-01',
        schemaType: 'article',
        draft: {_id: 'drafts.article-01', _type: 'article', title: 'branch draft'},
        published: {_id: 'article-01', _type: 'article', title: 'branch published'},
      },
    ])
    expect(await draftsRead(rigged, ['article-01'])).toEqual([
      {_id: 'article-01', _originalId: 'drafts.article-01', title: 'branch draft'},
    ])
    /* …and `published` takes the other one, from the same branch state. */
    expect(
      await read(rigged, '*[_id in ["article-01"]]{_id, title}', {}, {perspective: 'published'}),
    ).toEqual([{_id: 'article-01', title: 'branch published'}])
  })

  it('the BRANCH’s published body beats base’s draft — §18.2 fallthrough, not address precedence', async () => {
    /* `article-02` has a base draft ("Article 2 (DRAFT: retitled)") and a base
     * published. PRD §18.2 orders the drafts-perspective fallthrough: local
     * draft → local published → base draft. A branch that published this
     * document HAS an opinion — the base draft is superseded content.
     *
     * The inverse of this assertion was previously pinned here as "address
     * precedence, not origin". The 2026-08-11 human validation over the live
     * parity dataset showed what that rule does to an editor: they changed
     * this very document's title, clicked Publish, and watched the pane revert
     * to the stale upstream draft — published work reading as lost. §18.2 and
     * §18.5 together rule the other way, so this test now pins the PRD. */
    const rigged = rig([
      {
        logicalId: 'article-02',
        schemaType: 'article',
        published: {_id: 'article-02', _type: 'article', title: 'branch published two'},
      },
    ])
    expect(await draftsRead(rigged, ['article-02'])).toEqual([
      {
        _id: 'article-02',
        _originalId: 'article-02',
        title: 'branch published two',
      },
    ])
  })

  it('a branch that discarded the draft falls back to the PUBLISHED row', async () => {
    const rigged = rig([{logicalId: 'article-01', schemaType: 'article', draftTombstone: true}])
    expect(await draftsRead(rigged, ['article-01'])).toEqual([
      {_id: 'article-01', _originalId: 'article-01', title: 'Article 1'},
    ])
  })

  it('a branch that deleted both versions yields nothing at all', async () => {
    const rigged = rig([
      {
        logicalId: 'article-01',
        schemaType: 'article',
        draftTombstone: true,
        publishedTombstone: true,
      },
    ])
    expect(await draftsRead(rigged, ['article-01'])).toEqual([])
  })

  it('a branch that unpublished still shows the draft under `drafts`', async () => {
    const rigged = rig([
      {logicalId: 'article-01', schemaType: 'article', publishedTombstone: true},
    ])
    expect(await draftsRead(rigged, ['article-01'])).toEqual([
      {_id: 'article-01', _originalId: 'drafts.article-01', title: 'Article 1'},
    ])
  })

  it('`published` ignores the branch draft entirely', async () => {
    const rigged = rig()
    expect(
      await read(rigged, '*[_id in ["article-01"]]{_id, title}', {}, {perspective: 'published'}),
    ).toEqual([{_id: 'article-01', title: 'Article 1'}])
  })

  it('`published` honours a branch publish tombstone', async () => {
    const rigged = rig([
      {logicalId: 'article-01', schemaType: 'article', publishedTombstone: true},
    ])
    expect(
      await read(rigged, '*[_id in ["article-01"]]{_id, title}', {}, {perspective: ['published']}),
    ).toEqual([])
  })

  it('never hands back a `drafts.` address under a perspective', async () => {
    const rigged = rig()
    const rows = (await read(
      rigged,
      '*[_type == "article"]{_id}',
      {},
      {perspective: DRAFTS_STACK},
    )) as Rec[]
    expect(rows.map((row) => row._id)).toEqual(['article-01', 'article-02', 'article-03'])
  })

  it('a type list under `drafts` carries the branch title', async () => {
    const rigged = rig()
    const rows = (await read(
      rigged,
      '*[_type == "article"]{_id, title}',
      {},
      {perspective: DRAFTS_STACK},
    )) as Rec[]
    expect(rows).toEqual([
      {_id: 'article-01', title: OVERLAY_TITLE},
      {_id: 'article-02', title: 'Article 2 (DRAFT: retitled)'},
      {_id: 'article-03', title: 'Article 3'},
    ])
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 */

describe('§3 what stays refused, and says why', () => {
  it('a release perspective stack is still refused — Releases are degraded (PRD §32)', async () => {
    const rigged = rig()
    await read(rigged, '*[_id in ["article-01"]]{title}', {}, {perspective: ['rSummer', 'drafts']})
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/release/i)
  })

  it('a perspective spelling this layer does not know is refused, not guessed', async () => {
    const rigged = rig()
    await read(rigged, '*[_id in ["article-01"]]{title}', {}, {perspective: 'previewDrafts'})
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/perspective/i)
  })

  it('a field-equality (slug) plan under a perspective is refused, with the reason', async () => {
    /* The base fetch evaluates the predicate over RAW rows, so a published row
     * that matches while its draft does not would be collapsed INTO the answer
     * the hosted API leaves out. Refused rather than half-answered. */
    const rigged = rig()
    await read(
      rigged,
      '*[_type == "article" && title == $title]{_id}',
      {title: 'Article 1'},
      {perspective: DRAFTS_STACK},
    )
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/perspective/i)
  })

  it('a Content Source Map request is still refused', async () => {
    const rigged = rig()
    await read(rigged, '*[_id in ["article-01"]]{title}', {}, {resultSourceMap: true})
    expect(rigged.records[0]?.outcome).toBe('passthrough')
  })

  /**
   * GAP CLOSED — but only for the term an unfiltered pane actually sends.
   *
   * Studio's `prefixLast("")` returns `"*"`, so a pane with an empty search box
   * passes `$__query = "*"` and the predicate means "match everything of these
   * types". That is answerable exactly, and it is what makes list MEMBERSHIP
   * branch-correct: a branch-created document appears and a tombstoned one is
   * removed. See `studio-findability.test.ts` for the membership assertions.
   */
  it('answers the list CONTENT query from the branch for an unfiltered pane', async () => {
    const rigged = rig()
    await read(
      rigged,
      LIST_CONTENT_QUERY,
      {__types: ['article'], __query: '*', __rawQuery: '', __limit: 1000},
      {tag: 'structure.document-list', perspective: DRAFTS_STACK},
    )
    expect(rigged.records[0]?.outcome).toBe('overlay')
  })

  /**
   * An EMPTY term is not `"*"`, and it is not guessed either way. Hosted
   * `text::query("")` is not specified to mean "everything", so answering it
   * locally — in either direction — would be exactly the silent approximation
   * §5.5 forbids. Refused, recorded, delegated.
   */
  it('refuses an empty search term rather than guessing what it means', async () => {
    const rigged = rig()
    /* The delegation itself is allowed to fail here: the staging DOUBLE is
     * `groq-js`, and it cannot evaluate `text::query`. The RECORD is written by
     * `degrade()` before anything is delegated, and that is what this is about. */
    await read(
      rigged,
      LIST_CONTENT_QUERY,
      {__types: ['article'], __query: '', __rawQuery: '', __limit: 1000},
      {tag: 'structure.document-list', perspective: DRAFTS_STACK},
    ).catch(() => undefined)
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/text::query/)
  })

  /**
   * A TYPED term stays refused, and the reason names the index rather than the
   * parser. Under the pinned evaluator `[@, _id] match "nine*"` is `[]` even for
   * a matching document, because `match` does not descend into the document on
   * its left — so a local answer would be a strict subset of the hosted one.
   */
  it('refuses a typed search term, naming the hosted index', async () => {
    const rigged = rig()
    await read(
      rigged,
      LIST_CONTENT_QUERY,
      {__types: ['article'], __query: 'nine*', __rawQuery: 'nine', __limit: 1000},
      {tag: 'structure.document-list', perspective: DRAFTS_STACK},
    ).catch(() => undefined)
    expect(rigged.records[0]?.outcome).toBe('passthrough')
    expect(rigged.records[0]?.reason).toMatch(/text::query/)
    expect(rigged.records[0]?.reason).not.toMatch(/slicing/i)
  })

  it('the list’s type probe IS answered from the branch', async () => {
    const rigged = rig()
    expect(await read(rigged, LIST_TYPE_PROBE)).toEqual(['article'])
    expect(rigged.records[0]?.outcome).toBe('overlay')
  })
})

/* ══════════════════════════════════════════════════════════════════ §4 */

describe('§4 boundedness survives the widening (PRD §22.9)', () => {
  it('asks staging for both addresses of a named id, and nothing more', async () => {
    const rigged = rig()
    await read(rigged, '*[_id in ["article-01"]]{title}', {}, {perspective: DRAFTS_STACK})
    expect(rigged.issued).toHaveLength(1)
    expect(rigged.issued[0]?.params).toEqual({
      __overlayIds: ['article-01', 'drafts.article-01'],
    })
  })

  it('keeps the literal slice on a type fetch', async () => {
    const rigged = rig()
    await read(rigged, '*[_type == "article"]{_id}', {}, {perspective: DRAFTS_STACK})
    expect(rigged.issued[0]?.query).toMatch(/\[0\.\.\.\d+\]$/)
  })

  it('never sends the caller’s own GROQ to staging when it answers locally', async () => {
    const rigged = rig()
    const query = '*[_id in ["article-01"]]{title}'
    await read(rigged, query, {}, {perspective: DRAFTS_STACK})
    expect(rigged.issued.map((call) => call.query)).not.toContain(query)
  })
})

/* ══════════════════════════════════════════════════════════════════ §5 */

describe('§5 the pinned query shapes are still what sanity 6.8.0 emits', () => {
  const require_ = createRequire(import.meta.url)
  const sanityRoot = dirname(
    require_.resolve('sanity/package.json', {
      paths: [new URL('../../../examples/kitchen-sink/', import.meta.url).pathname],
    }),
  )
  const source = (file: string): string => readFileSync(join(sanityRoot, 'lib', file), 'utf8')

  it('the preview field fetch still passes a perspective', () => {
    /* `datastores-DqFH7RLd.js:910-913`. If this disappears the whole reason for
     * the perspective path disappears with it, and this file should be re-read
     * rather than trusted. */
    const text = source('datastores-DqFH7RLd.js')
    expect(text).toContain('"preview.document-paths"')
    expect(text).toContain('*[_id in [')
  })

  it('the list content query still calls text::query', () => {
    expect(source('useBundleDocuments-BYW8M9LS.js')).toContain('text::query($__query)')
  })

  it('the document list still passes perspectiveStack', () => {
    expect(source('PaneContainer-Bp8RN3ON.js')).toContain('perspective: perspectiveStack')
  })
})
