/**
 * `sanity-overlay-studio` — the branch as a query source, and the answer over it
 * (PRD §22.6 steps 6, 7, 13, 14; §18.8 tombstones; §22.9 boundedness).
 *
 * THE HOLE THIS CLOSES. Before this file existed the plugin substituted only
 * `getDocument`/`getDocuments` from the session's echo map and delegated `fetch`
 * whole. A document edited in a branch therefore rendered its **staging** title
 * in every list pane, in search, and in any GROQ the app ran; the document pane
 * looked right only because the listener echo replayed the mutation into it.
 *
 * So the load-bearing assertions here are the three that are *false* when reads
 * are overlay-blind, and they assert on the VALUE a GROQ query returns rather
 * than on any internal the same code computed:
 *
 *   1. a document the branch renamed answers with the BRANCH title;
 *   2. a document the branch created appears, though staging has no such row;
 *   3. a document the branch tombstoned does not appear, though staging does.
 *
 * Nothing here is mocked at the layer under test: the overlay source is built
 * from the same `/state` hydration shape the transport already declares, the
 * candidate set is assembled by the plugin, and the answer comes from
 * `sanity-overlay-query`'s pinned `groq-js` evaluator. The only doubles are the
 * *staging* documents, which stand in for the Content Lake.
 */
import {describe, expect, it} from 'vitest'

import {
  deriveStudioReadPlan,
  evaluateStudioRead,
} from '../../sanity-overlay-studio/src/client/readPlan'
import {
  createBranchCandidateSource,
  overlaySourceFromBranch,
} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'
import type {QueryDocument} from '../../sanity-overlay-query/src/types'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────────── the fixtures */

/**
 * Staging, as the Content Lake holds it. `_rev` is present on every row because
 * that is what a real base document carries and what distinguishes it from an
 * overlay materialization.
 */
const STAGING: QueryDocument[] = [
  {_id: 'article-1', _type: 'article', title: 'published one', _rev: 'base-1'},
  {_id: 'drafts.article-1', _type: 'article', title: 'staging one', _rev: 'base-2'},
  {_id: 'drafts.article-2', _type: 'article', title: 'staging two', _rev: 'base-3'},
  {_id: 'author-1', _type: 'author', name: 'staging author', _rev: 'base-4'},
]

/**
 * The branch, in the exact hydration shape `POST /state` and `POST /commit`
 * already answer with (`OverlayHydrationDocument`).
 *
 * `article-1` — the branch renamed the DRAFT and holds no opinion about the
 *               published version. `published: null` with no tombstone flag is
 *               "no opinion", not "deleted": conflating the two would delete a
 *               published document the branch never touched.
 * `article-2` — the branch deleted the draft. Staging still holds it.
 * `article-9` — the branch invented it. No staging row exists at all.
 */
const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-1',
    schemaType: 'article',
    draft: {_id: 'drafts.article-1', _type: 'article', title: 'branch one'},
    published: null,
  },
  {
    logicalId: 'article-2',
    schemaType: 'article',
    draftTombstone: true,
    draft: null,
    published: null,
  },
  {
    logicalId: 'article-9',
    schemaType: 'article',
    draft: {_id: 'drafts.article-9', _type: 'article', title: 'branch nine'},
    published: null,
  },
]

const LIST_QUERY = '*[_type == "article"]{_id, title}'

async function answer(query: string, params: Rec = {}): Promise<unknown> {
  const derivation = deriveStudioReadPlan(query, params)
  if (!derivation.supported) throw new Error(`expected a plan, got: ${derivation.reason}`)
  const overlay = overlaySourceFromBranch(BRANCH)
  const {result} = await evaluateStudioRead({
    plan: derivation.plan,
    params,
    baseDocuments: STAGING,
    overlay,
  })
  return result
}

/* ══════════════════════════════════════════════════════════════════ §1 */

describe('§1 the branch is what a GROQ read answers with', () => {
  it('renders the BRANCH title for a document the branch renamed', async () => {
    const rows = (await answer(LIST_QUERY)) as Rec[]
    const row = rows.find((entry) => entry._id === 'drafts.article-1')
    expect(row).toEqual({_id: 'drafts.article-1', title: 'branch one'})
  })

  it('includes a branch-created document staging has never held', async () => {
    const rows = (await answer(LIST_QUERY)) as Rec[]
    expect(rows.find((entry) => entry._id === 'drafts.article-9')).toEqual({
      _id: 'drafts.article-9',
      title: 'branch nine',
    })
  })

  it('drops a document the branch tombstoned, though staging still holds it', async () => {
    const rows = (await answer(LIST_QUERY)) as Rec[]
    expect(rows.map((entry) => entry._id)).not.toContain('drafts.article-2')
    /* The negative control: staging really does hold it, so the absence is the
     * overlay's doing and not an empty fixture. */
    expect(STAGING.map((doc) => doc._id)).toContain('drafts.article-2')
  })

  it('answers the whole list in `_id` order, branch and staging interleaved', async () => {
    const rows = (await answer(LIST_QUERY)) as Rec[]
    /* Written out by hand rather than derived: `article-1` (published,
     * untouched by the branch), then the two drafts the branch owns. The
     * branch-created row sits in `_id` order rather than appended, so nothing
     * about the answer leaks where a document came from. */
    expect(rows).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
      {_id: 'drafts.article-9', title: 'branch nine'},
    ])
  })

  it('leaves a published version the branch holds no opinion about alone', async () => {
    const rows = (await answer('*[_id == "article-1"]{title}')) as Rec[]
    expect(rows).toEqual([{title: 'published one'}])
  })

  it('does not leak the branch into a type the branch never touched', async () => {
    const rows = (await answer('*[_type == "author"]{name}')) as Rec[]
    expect(rows).toEqual([{name: 'staging author'}])
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 */

describe('§2 the ID shapes Studio actually issues', () => {
  it('answers `*[_id in $ids]` with branch state for the ids named', async () => {
    const result = await answer('*[_id in $ids]{_id, title}', {
      ids: ['drafts.article-1', 'article-1'],
    })
    expect(result).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
    ])
  })

  it('answers a branch-created id no base fetch could return', async () => {
    const result = await answer('*[_id == $id][0]{title}', {id: 'drafts.article-9'})
    expect(result).toEqual({title: 'branch nine'})
  })

  it('answers nothing for a tombstoned id, rather than the staging row', async () => {
    const result = await answer('*[_id == $id][0]{title}', {id: 'drafts.article-2'})
    expect(result).toBeNull()
  })

  it('evaluates a projection inside a slice inside an array wrapper', async () => {
    /* The real Studio list-pane shape, which an ad-hoc candidate filter cannot
     * answer: the documents sit under a projection, under a slice, under an
     * array wrapper. */
    const result = await answer('{"items": *[_type == "article"][0...2]{_id, title}}')
    expect(result).toEqual({
      items: [
        {_id: 'article-1', title: 'published one'},
        {_id: 'drafts.article-1', title: 'branch one'},
      ],
    })
  })

  it('answers a `sanity::versionOf` probe from branch state', async () => {
    const result = await answer(
      '*[sanity::versionOf($id)]{_id, title}',
      {id: 'article-1'},
    )
    expect(result).toEqual([
      {_id: 'article-1', title: 'published one'},
      {_id: 'drafts.article-1', title: 'branch one'},
    ])
  })

  it('answers a `sanity::versionOf` probe for a document only the branch has', async () => {
    const result = await answer('*[sanity::versionOf($id)]{_id, title}', {id: 'article-9'})
    expect(result).toEqual([{_id: 'drafts.article-9', title: 'branch nine'}])
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 */

describe('§3 overlaySourceFromBranch — the three facts a query source needs', () => {
  it('addresses a branch draft as `drafts.<id>` and stamps its identity', () => {
    const source = overlaySourceFromBranch(BRANCH)
    expect(source.documents.get('drafts.article-1')).toEqual({
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'branch one',
    })
  })

  it('records a tombstoned version as a tombstone, not as an absent document', () => {
    const source = overlaySourceFromBranch(BRANCH)
    expect([...source.tombstones]).toEqual(['drafts.article-2'])
    expect(source.documents.has('drafts.article-2')).toBe(false)
  })

  it('treats a null version with no tombstone flag as "no opinion"', () => {
    const source = overlaySourceFromBranch(BRANCH)
    /* `article-1` has `published: null`. If that were read as a tombstone the
     * published document would vanish from every read in the Studio. */
    expect(source.tombstones.has('article-1')).toBe(false)
    expect(source.documents.has('article-1')).toBe(false)
  })

  it('takes `_type` from the record when the materialized body omits it', () => {
    const source = overlaySourceFromBranch([
      {
        logicalId: 'thing-1',
        schemaType: 'thing',
        published: {_id: 'thing-1', title: 'no type on the body'} as Rec,
      },
    ])
    expect(source.documents.get('thing-1')?._type).toBe('thing')
  })

  it('reports conflicted documents so §22.8 diagnostics can name them', () => {
    const source = overlaySourceFromBranch([
      {
        logicalId: 'article-1',
        schemaType: 'article',
        draft: {_id: 'drafts.article-1', _type: 'article', title: 'x'},
        conflicts: [{id: 'c1'}],
      },
    ])
    expect([...(source.conflicts ?? [])]).toEqual(['drafts.article-1'])
  })

  it('ignores a hydration entry with neither a version nor a tombstone', () => {
    const source = overlaySourceFromBranch([{logicalId: 'empty-1', schemaType: 'article'}])
    expect(source.documents.size).toBe(0)
    expect(source.tombstones.size).toBe(0)
  })
})

/* ══════════════════════════════════════════════════════════════════ §4 */

describe('§4 createBranchCandidateSource — a total order, not base-then-branch', () => {
  const overlay = overlaySourceFromBranch(BRANCH)
  const source = createBranchCandidateSource({baseDocuments: STAGING, overlay})

  it('serves a type request in `_id` order with branch records interleaved', async () => {
    const documents = await source.fetchCandidates({kind: 'types', types: ['article']})
    expect(documents.map((doc) => doc._id)).toEqual([
      'article-1',
      'drafts.article-1',
      'drafts.article-2',
      'drafts.article-9',
    ])
  })

  it('lets the branch record win over the staging row at the same address', async () => {
    const documents = await source.fetchCandidates({kind: 'ids', ids: ['drafts.article-1']})
    expect(documents).toEqual([
      {_id: 'drafts.article-1', _type: 'article', title: 'branch one'},
    ])
  })

  it('does NOT suppress tombstones itself — that stays §22.6 step 7', async () => {
    /* One implementation of suppression, in `resolveVirtualDocument`. If this
     * port also dropped tombstoned rows, deleting the real suppression would
     * still look green. */
    const documents = await source.fetchCandidates({kind: 'ids', ids: ['drafts.article-2']})
    expect(documents.map((doc) => doc._id)).toEqual(['drafts.article-2'])
  })

  it('widens a field-equality request with every branch record of the type', async () => {
    /* §22.6 step 6: a branch edit can make a document newly match a predicate
     * the base fetch evaluated against pre-branch content. */
    const documents = await source.fetchCandidates({
      kind: 'field-equality',
      types: ['article'],
      path: ['title'],
      value: 'published one',
    })
    expect(documents.map((doc) => doc._id)).toEqual([
      'article-1',
      'drafts.article-1',
      'drafts.article-2',
      'drafts.article-9',
    ])
  })

  it('returns nothing for a type no document has', async () => {
    expect(await source.fetchCandidates({kind: 'types', types: ['nope']})).toEqual([])
  })
})

/* ═════════════════════════════════════════════════════════════════ §4b */

describe('§4b "the branch has an opinion" is documents ∪ tombstones', () => {
  /*
   * THE BUG CLASS, PINNED. `createBranchCandidateSource` widened a
   * field-equality selection by asking `overlay.documents.has(id)` — which is
   * only HALF of "the branch touched this address", because a tombstoned
   * address is deliberately absent from `documents` (see the module note in
   * `readSource.ts`). Every place that asks the question has to ask both halves,
   * so both halves are pinned here rather than only the instance that was found.
   *
   * WHAT IS AT STAKE is the port's CONTRACT rather than any single answer: this
   * source only ever widens, and §22.6 step 7 is the only thing that removes. A
   * port that quietly declines to hand over an address the branch deleted is
   * performing suppression by never arriving — and it happens to agree with the
   * real suppression today, which is exactly why no answer-level assertion can
   * see it. So the three request kinds are pinned directly, and the last test
   * pins the division of labour end to end: the row IS handed over, and step 7
   * is what drops it.
   */
  const CONFLICTED_DELETE: OverlayHydrationDocument[] = [
    {
      logicalId: 'article-2',
      schemaType: 'article',
      draftTombstone: true,
      conflicts: [{id: 'hard-1'}],
    },
  ]

  it('admits a tombstoned address into a field-equality selection', async () => {
    const overlay = overlaySourceFromBranch(CONFLICTED_DELETE)
    const source = createBranchCandidateSource({baseDocuments: STAGING, overlay})
    const documents = await source.fetchCandidates({
      kind: 'field-equality',
      types: ['article'],
      /* A value NO article in staging carries, so the only way `drafts.article-2`
       * can appear is the branch's opinion about it. */
      path: ['title'],
      value: 'a title nothing has',
    })
    expect(documents.map((doc) => doc._id)).toEqual(['drafts.article-2'])
  })

  it('admits a tombstoned address into an ids selection', async () => {
    const overlay = overlaySourceFromBranch(CONFLICTED_DELETE)
    const source = createBranchCandidateSource({baseDocuments: STAGING, overlay})
    const documents = await source.fetchCandidates({
      kind: 'ids',
      ids: ['drafts.article-2'],
    })
    expect(documents.map((doc) => doc._id)).toEqual(['drafts.article-2'])
  })

  it('admits a tombstoned address into a types selection', async () => {
    const overlay = overlaySourceFromBranch(CONFLICTED_DELETE)
    const source = createBranchCandidateSource({baseDocuments: STAGING, overlay})
    const documents = await source.fetchCandidates({kind: 'types', types: ['article']})
    expect(documents.map((doc) => doc._id)).toContain('drafts.article-2')
  })

  it('hands the row over and lets step 7 be the thing that drops it', async () => {
    const derivation = deriveStudioReadPlan(
      '*[_type == "article" && title == $title]{_id}',
      {title: 'a title nothing has'},
    )
    if (!derivation.supported) throw new Error(derivation.reason)
    const {result, diagnostics} = await evaluateStudioRead({
      plan: derivation.plan,
      params: {title: 'a title nothing has'},
      baseDocuments: STAGING,
      overlay: overlaySourceFromBranch(CONFLICTED_DELETE),
    })
    /* Counted by `evaluate.ts` as it absorbs what this port returned — an
     * oracle computed by different code than the port under test. One document
     * was handed over, and it can only have been the tombstoned address, since
     * no staging article carries that title. */
    expect(diagnostics.baseFetchDocuments).toBe(1)
    /* And step 7 removed it: nothing survived into the candidate set … */
    expect(diagnostics.candidateIds).toEqual([])
    /* … so the answer is empty, though staging holds the row. */
    expect(result).toEqual([])
    expect(STAGING.map((doc) => doc._id)).toContain('drafts.article-2')
  })
})

/* ══════════════════════════════════════════════════════════════════ §5 */

describe('§5 boundedness is enforced where the answer is produced', () => {
  it('raises CANDIDATE_LIMIT_EXCEEDED rather than answering over budget', async () => {
    /* An ID plan's ceiling is the named ids plus a fixed headroom for the
     * dereference walk. Seventy referenced documents blow through it, and the
     * ceiling is enforced INSIDE the same `evaluateOverlayQuery` call that
     * produces the answer — there is no window in which an over-budget
     * candidate set exists and is evaluated anyway. */
    const targets = Array.from({length: 70}, (_, index) => ({
      _id: `target-${String(index).padStart(3, '0')}`,
      _type: 'target',
      title: `t${index}`,
      _rev: 'base',
    }))
    const root: QueryDocument = {
      _id: 'root-1',
      _type: 'root',
      _rev: 'base',
      refs: targets.map((doc) => ({_type: 'reference', _ref: doc._id})),
    }
    const derivation = deriveStudioReadPlan('*[_id == $id]{refs[]->{title}}', {id: 'root-1'})
    if (!derivation.supported) throw new Error(derivation.reason)

    await expect(
      evaluateStudioRead({
        plan: derivation.plan,
        params: {id: 'root-1'},
        baseDocuments: [root, ...targets],
        overlay: overlaySourceFromBranch([]),
      }),
    ).rejects.toMatchObject({code: 'CANDIDATE_LIMIT_EXCEEDED'})
  })

  it('reports the package’s own diagnostics, candidate ids included', async () => {
    const derivation = deriveStudioReadPlan(LIST_QUERY, {})
    if (!derivation.supported) throw new Error(derivation.reason)
    const {diagnostics} = await evaluateStudioRead({
      plan: derivation.plan,
      params: {},
      baseDocuments: STAGING,
      overlay: overlaySourceFromBranch(BRANCH),
    })
    expect(diagnostics.exact).toBe(true)
    expect(diagnostics.evaluatorInvocations).toBe(1)
    expect([...diagnostics.candidateIds]).toEqual([
      'article-1',
      'drafts.article-1',
      'drafts.article-9',
    ])
  })
})
