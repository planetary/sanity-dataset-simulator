/**
 * `sanity-overlay-studio` — LIST MEMBERSHIP (PRD §5.5, §22.5, §22.6, §22.9).
 *
 * THE BUG THIS FILE EXISTS FOR. A branch-*edited* document already rendered its
 * branch title in a list pane. A branch-**created** one still did not appear at
 * all, and a **tombstoned** one was not removed — so list membership was coming
 * from staging while the row contents came from the branch.
 *
 * The cause is not in the overlay resolution, which was always correct. It is
 * that a structure list pane does not send `*[_type == "article"]`. It sends the
 * search service's *findability* query, built by `createSearchQuery` in
 * `sanity@6.8.0`, and two things in it defeat the pinned `groq-js@2.0.0`:
 *
 *   1. `[0...$__limit]` — "slicing must use constant numbers", thrown at PARSE.
 *      The whole query dies before planning, so not one document comes back.
 *   2. `text::query(...)` — parses, then throws "not implemented" at EVALUATION.
 *      It is Content Lake's hosted full-text index.
 *
 * The hosted API accepts both. So the query the Studio actually sends could
 * never be answered from the branch, and every list pane fell through to
 * staging.
 *
 * WHAT IS EXACT AND WHAT IS REFUSED — the honesty line §5.5 draws.
 *
 * For an UNFILTERED pane the parameters carry `$__query = "*"` (Studio's own
 * `prefixLast("")`), so the predicate means *"match everything of these types"*.
 * Over a candidate set that already contains the resolved branch, that answer is
 * EXACT — and it is the case a list pane overwhelmingly uses. Returning nothing
 * was never the honest degradation; it was simply wrong.
 *
 * For a TYPED term there is no honest local answer. This is measured, not
 * assumed: `[@, _id] match "nin*"` evaluates to `[]` under the pinned evaluator
 * even for a document titled "nine lives", because `match` does not descend into
 * the document object on the left. Rewriting it anyway would answer a strict
 * SUBSET of the hosted result without saying so, which is exactly what §5.5
 * forbids. So it is REFUSED with a reason and recorded, never answered empty.
 *
 * Nothing here is mocked at the layer under test. Staging is a document array
 * standing in for the Content Lake; the plan, the candidate set and the answer
 * are the shipping code's.
 */
import {describe, expect, it} from 'vitest'

import {
  prepareFindabilityQuery,
  substituteSliceParameters,
} from '../../sanity-overlay-studio/src/client/findability'
import {
  deriveStudioReadPlan,
  evaluateStudioRead,
} from '../../sanity-overlay-studio/src/client/readPlan'
import {createStudioReader} from '../../sanity-overlay-studio/src/client/reads'
import type {StudioReadRecord} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'
import type {QueryDocument} from '../../sanity-overlay-query/src/types'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────────── the fixtures */

/**
 * The findability query VERBATIM, as `createSearchQuery` emits it. Copied rather
 * than paraphrased: a paraphrase that happens to parse would prove nothing about
 * the query the Studio actually sends.
 */
const FINDABILITY =
  '*[_type in $__types && ([@, _id] match text::query($__query) || references($__rawQuery)) && (_type == $type)] ' +
  '{_type, _id, _originalId, "orderings": [_updatedAt]} | order(orderings[0] desc) [0...$__limit]'

/** An unfiltered pane. `prefixLast("")` is `"*"`; the limit is `(limit ?? 1000) + 1`. */
const UNFILTERED: Rec = {
  __types: ['article'],
  __query: '*',
  __rawQuery: '',
  type: 'article',
  __limit: 1001,
}

/** The same pane with "nine" typed into the search box. */
const TYPED: Rec = {...UNFILTERED, __query: 'nine*', __rawQuery: 'nine'}

const STAGING: QueryDocument[] = [
  {_id: 'article-1', _type: 'article', title: 'published one', _rev: 'base-1'},
  {_id: 'drafts.article-1', _type: 'article', title: 'staging one', _rev: 'base-2'},
  {_id: 'drafts.article-2', _type: 'article', title: 'staging two', _rev: 'base-3'},
  {_id: 'author-1', _type: 'author', name: 'staging author', _rev: 'base-4'},
]

/**
 * `article-1` — the branch renamed the draft.
 * `article-2` — the branch deleted the draft; staging still holds it.
 * `article-9` — the branch invented it; staging has no such row.
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

async function answerFindability(params: Rec): Promise<Rec[]> {
  const derivation = deriveStudioReadPlan(FINDABILITY, params)
  if (!derivation.supported) throw new Error(`expected a plan, got: ${derivation.reason}`)
  const {result} = await evaluateStudioRead({
    plan: derivation.plan,
    params,
    baseDocuments: STAGING,
    overlay: overlaySourceFromBranch(BRANCH),
  })
  return result as Rec[]
}

function idsOf(rows: Rec[]): string[] {
  return rows.map((row) => String(row._id)).sort()
}

/* ══════════════════════════════════════════════════════ §1 slice parameters */

describe('§1 a parameterised slice is substituted, and only after groq-js refuses', () => {
  it('substitutes an integer parameter into a slice endpoint', () => {
    expect(substituteSliceParameters('*[_type=="a"][0...$lim]', {lim: 10})).toBe(
      '*[_type=="a"][0...10]',
    )
  })

  it('substitutes both endpoints of a two-parameter slice', () => {
    expect(substituteSliceParameters('*[_type=="a"][$from...$to]', {from: 2, to: 5})).toBe(
      '*[_type=="a"][2...5]',
    )
  })

  it('substitutes an inclusive `..` slice as well as an exclusive `...` one', () => {
    expect(substituteSliceParameters('*[_type=="a"][0..$lim]', {lim: 4})).toBe(
      '*[_type=="a"][0..4]',
    )
  })

  /**
   * The load-bearing negative. Substituting a non-integer would either inject
   * syntax or, worse, silently drop the bound — turning a limited pane into an
   * unbounded dataset transfer. Left alone, the re-parse fails again and the
   * caller gets the parse error.
   */
  it('leaves a non-integer parameter alone rather than inventing a bound', () => {
    expect(substituteSliceParameters('*[_type=="a"][0...$lim]', {lim: 'abc'})).toBe(
      '*[_type=="a"][0...$lim]',
    )
    expect(substituteSliceParameters('*[_type=="a"][0...$lim]', {lim: 3.5})).toBe(
      '*[_type=="a"][0...$lim]',
    )
    expect(substituteSliceParameters('*[_type=="a"][0...$lim]', {})).toBe(
      '*[_type=="a"][0...$lim]',
    )
  })

  /** `[$lim]` is an INDEX, not a slice. groq-js accepts it, so it is not ours to rewrite. */
  it('does not touch a bare parameterised index', () => {
    expect(substituteSliceParameters('*[_type=="a"][$lim]', {lim: 4})).toBe('*[_type=="a"][$lim]')
  })

  /**
   * The rule that keeps this from having behaviour of its own: the rewrite runs
   * ONLY after the pinned parser has already refused the source.
   */
  it('never rewrites a query groq-js already accepts', () => {
    const accepted = '*[_type == "article"][0...50]'
    const prepared = prepareFindabilityQuery(accepted, {lim: 10})
    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return
    expect(prepared.rewrite.query).toBe(accepted)
    expect(prepared.rewrite.rewritten).toBe(false)
  })

  it('reports the parse error when substitution cannot rescue the query', () => {
    const prepared = prepareFindabilityQuery('*[_type=="a"][0...$lim]', {lim: 'abc'})
    expect(prepared.supported).toBe(false)
    if (prepared.supported) return
    expect(prepared.reason).toMatch(/constant numbers/i)
  })
})

/* ══════════════════════════════════════════════ §2 the findability query plans */

describe('§2 the query a list pane actually sends can now be planned', () => {
  it('plans the verbatim findability query for an unfiltered pane', () => {
    const derivation = deriveStudioReadPlan(FINDABILITY, UNFILTERED)
    expect(derivation.supported).toBe(true)
  })

  it('leaves neither a parameterised slice nor text::query in the planned query', () => {
    const derivation = deriveStudioReadPlan(FINDABILITY, UNFILTERED)
    expect(derivation.supported).toBe(true)
    if (!derivation.supported) return
    expect(derivation.plan.definition.query).not.toContain('text::query')
    expect(derivation.plan.definition.query).not.toContain('$__limit')
  })

  /** Boundedness survives the rewrite (§22.9): the plan still carries a ceiling. */
  it('keeps a bounded candidate plan', () => {
    const derivation = deriveStudioReadPlan(FINDABILITY, UNFILTERED)
    expect(derivation.supported).toBe(true)
    if (!derivation.supported) return
    expect(derivation.plan.definition.maxCandidates).toBeGreaterThan(0)
    expect(derivation.plan.definition.candidatePlan.type).toBeTruthy()
  })
})

/* ═════════════════════════════════════════════════ §3 list membership itself */

describe('§3 list membership comes from the branch, not from staging', () => {
  it('INCLUDES a document the branch created, which staging has never held', async () => {
    const rows = await answerFindability(UNFILTERED)
    expect(idsOf(rows)).toContain('drafts.article-9')
  })

  it('DROPS a document the branch tombstoned, though staging still holds it', async () => {
    const rows = await answerFindability(UNFILTERED)
    expect(idsOf(rows)).not.toContain('drafts.article-2')
  })

  it('still answers a branch-edited document from the branch', async () => {
    const rows = await answerFindability(UNFILTERED)
    expect(idsOf(rows)).toContain('drafts.article-1')
  })

  /** The type filter is still honoured — the rewrite widens nothing. */
  it('does not widen the pane to other types', async () => {
    const rows = await answerFindability(UNFILTERED)
    expect(idsOf(rows)).not.toContain('author-1')
  })

  /**
   * The whole membership set, asserted against a hand-computed oracle rather
   * than against anything the implementation produced.
   */
  it('answers exactly the articles the branch view holds', async () => {
    const rows = await answerFindability(UNFILTERED)
    expect(idsOf(rows)).toEqual(['article-1', 'drafts.article-1', 'drafts.article-9'])
  })
})

/* ═══════════════════════════════════════════ §4 declared exactness / refusal */

describe('§4 §5.5 — approximate out loud, or refuse with a reason', () => {
  it('claims NO approximation for an unfiltered pane, because "*" is exact', () => {
    const prepared = prepareFindabilityQuery(FINDABILITY, UNFILTERED)
    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return
    expect(prepared.rewrite.approximations).toEqual([])
  })

  it('records that it rewrote the query even when the answer is exact', () => {
    const prepared = prepareFindabilityQuery(FINDABILITY, UNFILTERED)
    expect(prepared.supported).toBe(true)
    if (!prepared.supported) return
    expect(prepared.rewrite.rewritten).toBe(true)
  })

  /**
   * THE REGRESSION THAT COST A BROWSER CYCLE. A typed term must not come back as
   * an empty list. It must refuse, and the refusal must say `text::query`.
   */
  it('REFUSES a typed search term rather than answering a silent subset', () => {
    const prepared = prepareFindabilityQuery(FINDABILITY, TYPED)
    expect(prepared.supported).toBe(false)
    if (prepared.supported) return
    expect(prepared.reason).toMatch(/text::query/)
    expect(prepared.reason).toMatch(/index|hosted/i)
  })

  it('refuses a term it cannot know before evaluation', () => {
    const prepared = prepareFindabilityQuery(FINDABILITY, {...UNFILTERED, __query: undefined})
    expect(prepared.supported).toBe(false)
    if (prepared.supported) return
    expect(prepared.reason).toMatch(/text::query/)
  })

  it('refuses text::query used as a VALUE rather than as the right-hand side of match', () => {
    const prepared = prepareFindabilityQuery('*[_type == "article"]{"hits": text::query($q)}', {
      q: '*',
    })
    expect(prepared.supported).toBe(false)
    if (prepared.supported) return
    expect(prepared.reason).toMatch(/text::query/)
  })

  it('refuses a typed term even when the slice needed no substitution', () => {
    const noSlice =
      '*[_type in $__types && ([@, _id] match text::query($__query))]{_id}'
    const prepared = prepareFindabilityQuery(noSlice, TYPED)
    expect(prepared.supported).toBe(false)
  })
})

/* ═════════════════════════════════════════════════════ §5 the read ledger */

describe('§5 the read ledger declares what happened', () => {
  function reader(records: StudioReadRecord[]): ReturnType<typeof createStudioReader> {
    return createStudioReader({
      overlay: () => overlaySourceFromBranch(BRANCH),
      onRecord: (record) => records.push(record),
    })
  }

  /** Staging, answering the planner's own bounded candidate GROQ. */
  async function baseFetch(query: string, params: Rec): Promise<unknown> {
    const {evaluate, parse} = await import('groq-js')
    const value = await evaluate(parse(query), {dataset: STAGING, params})
    return await value.get()
  }

  it('records an unfiltered pane as answered from the overlay', async () => {
    const records: StudioReadRecord[] = []
    const answer = await reader(records)({
      query: FINDABILITY,
      params: UNFILTERED,
      baseFetch,
    })
    expect(answer.answered).toBe(true)
    expect(records.at(-1)?.outcome).toBe('overlay')
  })

  /**
   * §5.5 again: the string that was EVALUATED is not the string the caller
   * wrote, and the ledger has to say so rather than leave an operator to deduce
   * it from a query that no longer contains `text::query`.
   */
  it('declares the rewritten query on the record, alongside the caller\'s own', async () => {
    const records: StudioReadRecord[] = []
    await reader(records)({query: FINDABILITY, params: UNFILTERED, baseFetch})
    const record = records.at(-1)
    expect(record?.query).toBe(FINDABILITY)
    expect(record?.rewrittenQuery).toBeTypeOf('string')
    expect(record?.rewrittenQuery).not.toBe(FINDABILITY)
    expect(record?.rewrittenQuery).not.toContain('text::query')
  })

  it('leaves rewrittenQuery absent when the caller\'s own GROQ was evaluated', async () => {
    const records: StudioReadRecord[] = []
    await reader(records)({
      query: '*[_type == "article"]{_id}',
      params: {},
      baseFetch,
    })
    expect(records.at(-1)?.rewrittenQuery).toBeUndefined()
  })

  it('returns the branch-created document through the full reader path', async () => {
    const records: StudioReadRecord[] = []
    const answer = await reader(records)({
      query: FINDABILITY,
      params: UNFILTERED,
      baseFetch,
    })
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    expect(idsOf(answer.result as Rec[])).toContain('drafts.article-9')
  })

  /**
   * A typed term degrades to a RECORDED passthrough — the caller re-issues
   * against staging. What it must never be is `answered: true` with an empty
   * list, which is the shape that looks like data.
   */
  it('records a typed term as a passthrough carrying a reason, never as an empty answer', async () => {
    const records: StudioReadRecord[] = []
    const answer = await reader(records)({query: FINDABILITY, params: TYPED, baseFetch})
    expect(answer.answered).toBe(false)
    if (answer.answered) return
    expect(answer.reason).toMatch(/text::query/)
    const record = records.at(-1)
    expect(record?.outcome).toBe('passthrough')
    expect(record?.reason).toMatch(/text::query/)
  })
})
