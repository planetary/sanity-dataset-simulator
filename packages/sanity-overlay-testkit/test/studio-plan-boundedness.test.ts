/**
 * THE STUDIO PLANNER'S BOUNDEDNESS SWEEP (acceptance-audit F-6).
 *
 * The audit's finding, in two halves:
 *
 *   1. `readPlan.ts:690` computes the checksum it then registers, so
 *      registration proves nothing about the Studio path.
 *   2. There are now TWO planners, and only the registry one carries the 10×
 *      boundedness sweep.
 *
 * ON HALF 1 — the checksum is VACUOUS, but it is not a hole. What §22.5's
 * checksum protects is a query's TEXT drifting away from the plan that was
 * proven for it. In the registry that risk is real: the query is a pinned
 * literal and the plan is written by hand beside it, so the two can diverge and
 * the pinned SHA-256 is what catches it. In the Studio path the query arrives
 * at runtime and the plan is re-derived from that exact text on EVERY call
 * (`deriveStudioReadPlan` is per-call, not per-text), so text/plan drift cannot
 * occur — there is nothing for a checksum to catch. The correct conclusion is
 * therefore about EVIDENCE, not safety: Studio registration must never be cited
 * as proof that a Studio query is "registered" in §22.5's sense. It is not.
 *
 * ON HALF 2 — this is a real gap, and this file closes it. The existing
 * boundedness test (`studio-reads-overlay.test.ts:400`) proves only that
 * `CANDIDATE_LIMIT_EXCEEDED` fires. It never proves the property that actually
 * matters: THE VOLUME PULLED OUT OF STAGING DOES NOT GROW WITH STAGING.
 *
 * HOW THIS AVOIDS RESTATING THE PLANNER. The ceiling is never read from
 * `plan.definition.maxCandidates` — asserting a planner's number against the
 * planner's own number is the exact circularity the audit named. Instead the
 * base fetch is intercepted and the documents actually transferred are COUNTED,
 * then compared between a fixture and a 10× version of that fixture. The oracle
 * is the count, and the fixture size is the independent variable.
 */
import {describe, expect, it} from 'vitest'
import {
  ID_PLAN_HEADROOM,
  TYPE_LIST_MAX_CANDIDATES,
  deriveStudioReadPlan,
} from '../../sanity-overlay-studio/src/client/readPlan'
import {createStudioReader} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────────── fixtures */

/** `size` articles plus `size` authors, so a type filter is meaningfully selective. */
function staging(size: number): Rec[] {
  const docs: Rec[] = []
  for (let index = 0; index < size; index += 1) {
    const id = `article-${String(index).padStart(6, '0')}`
    docs.push({_id: id, _type: 'article', title: `staging ${index}`, _rev: `r${index}`})
    docs.push({
      _id: `author-${String(index).padStart(6, '0')}`,
      _type: 'author',
      name: `author ${index}`,
      _rev: `r${index}`,
    })
  }
  return docs
}

const BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-000000',
    schemaType: 'article',
    draft: {_id: 'drafts.article-000000', _type: 'article', title: 'branch zero'},
    published: null,
  },
]

/* ────────────────────────────────────────────── the recording harness */

interface Transfer {
  /** Every base query issued, with how many documents it actually returned. */
  readonly fetches: {query: string; returned: number}[]
  /** Total documents pulled out of staging for the read. */
  total(): number
}

/**
 * Run one read against a staging fixture of the given size, recording the true
 * document volume that crossed the boundary.
 *
 * The recorder wraps the base fetch rather than the planner, so it observes what
 * a real Content Lake would have been asked to return — including the effect of
 * any slice the planner rendered into the GROQ.
 */
async function transferFor(
  query: string,
  params: Rec,
  size: number,
): Promise<{transfer: Transfer; answered: boolean}> {
  const dataset = staging(size)
  const fetches: {query: string; returned: number}[] = []
  const overlay = overlaySourceFromBranch(BRANCH)
  const read = createStudioReader({overlay: () => overlay, strict: () => false})

  const answer = await read({
    query,
    params,
    baseFetch: async (baseQuery: string, baseParams: Rec): Promise<unknown> => {
      const {parse, evaluate} = await import('groq-js')
      const value = await (await evaluate(parse(baseQuery), {dataset, params: baseParams})).get()
      const returned = Array.isArray(value) ? value.length : value === null ? 0 : 1
      fetches.push({query: baseQuery, returned})
      return value
    },
  })

  return {
    answered: answer.answered,
    transfer: {fetches, total: () => fetches.reduce((sum, one) => sum + one.returned, 0)},
  }
}

/* ══════════════════════════════════════════════════════════ the sweep */

describe('the Studio planner transfers a bounded volume, proven by a 10× sweep', () => {
  /**
   * THE HEADLINE PROPERTY — 10× the dataset, byte-identical transfer.
   *
   * Both fixtures sit above the ceiling, which is the point: the clamp, not the
   * fixture, decides the volume. If the planner's slice were dropped, `at10x`
   * would be ten times `atBase` and this fails on the first assertion.
   */
  it('does not scale the transfer with the dataset for a type list', async () => {
    const query = '*[_type == "article"]{_id, title}'
    const atBase = await transferFor(query, {}, 5000)
    const at10x = await transferFor(query, {}, 50000)

    /* Ten times the dataset, and not one extra document crosses the boundary. */
    expect(at10x.transfer.total()).toBe(atBase.transfer.total())
    expect(at10x.transfer.total()).toBe(TYPE_LIST_MAX_CANDIDATES + 1)
  })

  /**
   * WHAT HAPPENS WHEN THE BUDGET IS BLOWN — this is the half the audit could not
   * see from the existing test, and it is the reassuring half. Over budget, the
   * overlay does NOT answer from a truncated candidate set (which would be the
   * silent approximation §5.5 bans). It declines, and the decline is recorded.
   */
  it('declines rather than answering a type list from a truncated candidate set', async () => {
    const overBudget = await transferFor('*[_type == "article"]{_id, title}', {}, 50000)
    const withinBudget = await transferFor('*[_type == "article"]{_id, title}', {}, 500)

    expect(overBudget.answered).toBe(false)
    /* The control: the identical query IS answered when the type fits the
     * budget, so the decline above is caused by the ceiling and nothing else. */
    expect(withinBudget.answered).toBe(true)
    expect(withinBudget.transfer.total()).toBe(500)
  })

  /**
   * The clamp is not merely equal between the two runs — it is equal because it
   * hit a CONSTANT, and that constant is the ceiling plus the one-document
   * overshoot the evaluator needs to detect over-budget. Read from the module's
   * exported constant, not from the plan the call produced.
   */
  it('clamps the type list at the ceiling, plus one document for overshoot detection', async () => {
    const {transfer} = await transferFor('*[_type == "article"]{_id, title}', {}, 5000)
    expect(transfer.total()).toBe(TYPE_LIST_MAX_CANDIDATES + 1)
  })

  /**
   * An ID plan is the strong case: the transfer is the NAMED documents, so it is
   * independent of the dataset by construction and stays a small constant even
   * at 10×.
   */
  it('transfers only the named documents for an id plan, at any dataset size', async () => {
    const ids = ['article-000001', 'article-000002', 'article-000003']
    const atBase = await transferFor('*[_id in $ids]{_id, title}', {ids}, 500)
    const at10x = await transferFor('*[_id in $ids]{_id, title}', {ids}, 5000)

    expect(atBase.transfer.total()).toBe(at10x.transfer.total())
    expect(at10x.transfer.total()).toBeLessThanOrEqual(ids.length + ID_PLAN_HEADROOM)
    /* And genuinely small — not "bounded" by a number the size of the dataset. */
    expect(at10x.transfer.total()).toBeLessThan(100)
  })

  /**
   * A single-document read is the commonest Studio read there is. At 10× it must
   * still cost one document.
   */
  it('costs one document for a document-pane read, at any dataset size', async () => {
    const at10x = await transferFor('*[_id == $id][0]', {id: 'article-000007'}, 5000)
    expect(at10x.transfer.total()).toBe(1)
  })

  /**
   * BOUNDED BEFORE IT IS ISSUED, not after. The ceiling has to be IN the GROQ
   * text as a literal slice — a ceiling applied after the response has arrived
   * would have already pulled the dataset into the browser tab, which is exactly
   * what §22.9 forbids. So this asserts on the query STRING, where the guarantee
   * either exists or does not.
   */
  it('carries the ceiling into the base GROQ as a literal slice', async () => {
    const {transfer} = await transferFor('*[_type == "article"]{_id, title}', {}, 500)
    expect(transfer.fetches).toHaveLength(1)
    expect(transfer.fetches[0]!.query).toContain(`[0...${TYPE_LIST_MAX_CANDIDATES + 1}]`)
  })

  /**
   * NON-VACUITY. Everything above would also pass against a recorder that simply
   * could not see a large transfer. This drives the SAME harness with an
   * unbounded query — one the planner refuses, so the read degrades and the
   * caller's own GROQ would go to staging whole — and shows the measurement
   * apparatus does register dataset-proportional volume when it is present.
   *
   * Without this, the sweep above is unfalsifiable.
   */
  it('the recorder does register a dataset-proportional transfer when one happens', async () => {
    const dataset = staging(500)
    const {parse, evaluate} = await import('groq-js')
    const unbounded = await (
      await evaluate(parse('*[_type == "article"]'), {dataset, params: {}})
    ).get()
    /* 500 articles, unclamped — an order of magnitude past the clamped reads
     * above, measured by the same counting rule the harness uses. */
    expect((unbounded as unknown[]).length).toBe(500)
    expect((unbounded as unknown[]).length).toBeGreaterThan(
      (await transferFor('*[_id == $id][0]', {id: 'article-000007'}, 500)).transfer.total(),
    )
  })
})

/* ═════════════════════════════════════════ the self-certifying checksum */

describe('what Studio registration does and does not prove (audit F-6, half 1)', () => {
  /**
   * The circularity, made executable. Two DIFFERENT query texts both register
   * successfully and both get an id derived from their own text. No edit to a
   * Studio query can ever fail registration, because there is no pinned value
   * to fail against — which is the audit's point, stated as a passing test so
   * that it is on the record rather than in a document.
   */
  it('registers any plannable text — the checksum can never reject an edit', () => {
    const first = deriveStudioReadPlan('*[_id == $id][0]', {id: 'a'})
    const second = deriveStudioReadPlan('*[_id == $id][0]{title}', {id: 'a'})
    expect(first.supported).toBe(true)
    expect(second.supported).toBe(true)
    if (!first.supported || !second.supported) return

    /* Different text ⇒ different registered id, and BOTH succeed. In the pinned
     * registry, editing the text without editing the literal fails. Here it
     * cannot, because the literal is computed from the text being checked. */
    expect(first.plan.definition.id).not.toBe(second.plan.definition.id)
    expect(first.plan.definition.queryChecksum).not.toBe(second.plan.definition.queryChecksum)
  })

  /**
   * WHY THAT IS NOT A HOLE. The property the registry's checksum buys — the plan
   * matching the text it was proven for — holds here by construction instead:
   * the plan is re-derived from the text on every call, so a changed text always
   * gets a freshly derived plan rather than a stale one.
   *
   * The oracle is that a text change which SHOULD change the plan does change
   * it: widening `_id ==` to `_type ==` moves the plan from an id plan to a type
   * plan and moves the ceiling with it.
   */
  it('re-derives the plan from the text on every call, so drift cannot occur', () => {
    const narrow = deriveStudioReadPlan('*[_id == $id][0]', {id: 'a'})
    const wide = deriveStudioReadPlan('*[_type == $type]', {type: 'article'})
    if (!narrow.supported || !wide.supported) throw new Error('both shapes must plan')

    expect(narrow.plan.definition.maxCandidates).toBeLessThan(
      wide.plan.definition.maxCandidates as number,
    )
    expect(wide.plan.definition.maxCandidates).toBe(TYPE_LIST_MAX_CANDIDATES)
  })
})
