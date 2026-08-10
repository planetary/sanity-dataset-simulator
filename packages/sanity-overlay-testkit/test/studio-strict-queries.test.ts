/**
 * THE `strictQueries` COMPOSITE (acceptance-audit F-7).
 *
 * Two facts shipped without a test between them:
 *
 *   `options.ts:221`  `strictQueries: options.strictQueries ?? env ?? true`
 *   `reads.ts:18-23`  refusing every unplannable Studio query "makes it not
 *                     boot. That is a different failure, not a smaller one."
 *
 * The mitigation in `reads.ts` is that strict refuses ONLY once the branch
 * holds state (`branchHasState`) — an empty branch cannot have changed any
 * answer, so delegating to staging is exact rather than approximate. That
 * mitigation is tested. What was NOT tested is the composite: the SHIPPED
 * default, a NON-EMPTY branch, and the GROQ a real Studio actually issues.
 *
 * THE WORKLOAD IS NOT INVENTED. Every query in {@link SHIPPED_WORKLOAD} was
 * grepped out of the Studio that this repo actually installs
 * (`examples/kitchen-sink/node_modules/sanity/lib/**`), because the PRD is not
 * evidence of what Studio issues and this file's whole purpose is to find out
 * what really happens. The provenance comment on each entry is the citation.
 */
import {describe, expect, it} from 'vitest'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {
  OverlayReadRefusedError,
  createStudioReader,
  type StudioReadRecord,
} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────────── fixtures */

const STAGING: Rec[] = [
  {_id: 'article-1', _type: 'article', title: 'staging one', _rev: 'base-1'},
  {_id: 'drafts.article-1', _type: 'article', title: 'staging one draft', _rev: 'base-2'},
  {_id: 'author-1', _type: 'author', name: 'staging author', _rev: 'base-3'},
]

/** A branch that holds state, which is the precondition `branchHasState` gates on. */
const NON_EMPTY_BRANCH: OverlayHydrationDocument[] = [
  {
    logicalId: 'article-1',
    schemaType: 'article',
    draft: {_id: 'drafts.article-1', _type: 'article', title: 'branch one'},
    published: null,
  },
]

/**
 * GROQ this repo's own `sanity` install issues. Provenance is the grep that
 * found each one; `kind` records why the query matters to booting.
 */
const SHIPPED_WORKLOAD: readonly {
  readonly query: string
  readonly params: Rec
  /** What breaks in the Studio UI if this read cannot be served. */
  readonly surface: string
}[] = [
  {
    query: '*[!(_id in path("drafts.**"))]',
    params: {},
    surface: 'the document list — the structure tool’s published-document pane',
  },
  {query: '*[_id == $id][0]', params: {id: 'article-1'}, surface: 'the document pane'},
  {
    query: '*[_id in $ids]{_id, cdnAccessPolicy}',
    params: {ids: ['article-1']},
    surface: 'the batch document fetch',
  },
  {
    query: '*[_id in $draftIds]._id',
    params: {draftIds: ['drafts.article-1']},
    surface: 'the draft-existence probe',
  },
  {
    query: '*[_type == $documentType && sha1hash == $hash][0]',
    params: {documentType: 'sanity.imageAsset', hash: 'abc'},
    surface: 'asset upload de-duplication',
  },
  {
    query: '*[_type == $type &&_id == $ref][0]{mimeType, originalFilename}',
    params: {type: 'sanity.fileAsset', ref: 'file-1'},
    surface: 'the file input preview',
  },
  {
    query: '*[sanity::versionOf($publishedId)][0]._type',
    params: {publishedId: 'article-1'},
    surface: 'release/version resolution',
  },
  {
    query: '*[references($docId)]',
    params: {docId: 'article-1'},
    surface: 'the delete-confirmation incoming-reference check',
  },
]

/* ────────────────────────────────────────────────────────── the reader */

async function evaluateOverStaging(query: string, params: Rec): Promise<unknown> {
  const {parse, evaluate} = await import('groq-js')
  const value = await evaluate(parse(query), {dataset: STAGING, params})
  return await value.get()
}

/**
 * A reader wired as a Studio wires it when the operator **opts into strict**.
 *
 * This file originally read `resolveOverlayOptions({}, {})` — the shipped
 * default — because strict was the default when the evidence below was
 * gathered. That default was changed to warn mode on 2026-08-05 precisely
 * BECAUSE of what these tests measured, so they now opt in explicitly. The
 * evidence is what matters and it is unchanged: this is what strict does to a
 * real Studio workload once the branch holds state, and it is why strict is
 * reserved for preview frontends rather than the editing Studio.
 */
function shippedReader(branch: OverlayHydrationDocument[]): {
  read: ReturnType<typeof createStudioReader>
  records: StudioReadRecord[]
} {
  const resolved = resolveOverlayOptions({strictQueries: true}, {})
  const records: StudioReadRecord[] = []
  const overlay = overlaySourceFromBranch(branch)
  return {
    records,
    read: createStudioReader({
      overlay: () => overlay,
      strict: () => resolved.strictQueries,
      onRecord: (record) => records.push(record),
    }),
  }
}

/** Run one shipped query through the shipped reader; report how it ended. */
async function outcomeOf(
  entry: (typeof SHIPPED_WORKLOAD)[number],
  branch: OverlayHydrationDocument[],
): Promise<'overlay' | 'passthrough' | 'refused'> {
  const {read} = shippedReader(branch)
  try {
    const answer = await read({
      query: entry.query,
      params: entry.params,
      baseFetch: evaluateOverStaging,
    })
    return answer.answered ? 'overlay' : 'passthrough'
  } catch (error) {
    if (error instanceof OverlayReadRefusedError) return 'refused'
    throw error
  }
}

/* ══════════════════════════════════════════════════════ the composite */

describe('strict mode, composed with a non-empty branch', () => {
  it('is NOT the shipped default — that was changed to warn mode because of this file', () => {
    /* The audit (F-7) found strict shipping ON while `reads.ts` explained that
     * refusing unplannable GROQ "makes it not boot". The tests below measured
     * exactly that against the real `sanity` workload, so the default moved to
     * warn (PRD §22.5's `[SHOULD]`). Strict stays one line away. */
    expect(resolveOverlayOptions({}, {}).strictQueries).toBe(false)
  })

  it('is strict once the operator or the env asks for it', () => {
    expect(resolveOverlayOptions({strictQueries: true}, {}).strictQueries).toBe(true)
    expect(
      resolveOverlayOptions({}, {SANITY_STUDIO_OVERLAY_STRICT_QUERIES: 'true'}).strictQueries,
    ).toBe(true)
  })

  /**
   * THE FINDING, PINNED.
   *
   * This assertion was written the other way round first — `toEqual([])`, the
   * desired behaviour, i.e. that a Studio on the shipped default still boots.
   * It went RED on THREE entries, and the reasons are worse than "an exotic
   * query was not planned":
   *
   *   `path()` document list  the planner cannot prove a candidate set for a
   *                           dataset-wide ID-pattern scan. This is the
   *                           structure tool's main pane.
   *   `sanity.imageAsset`     refused as a "hosted system type" — a plain
   *   `sanity.fileAsset`      `*[_type == …]` fetch does not return them, so
   *                           completeness cannot be proven.
   *
   * So on the shipped default, the FIRST branch edit turns the document list
   * and EVERY image/file input into a thrown `OverlayReadRefusedError`. That is
   * precisely the "makes it not boot. That is a different failure, not a
   * smaller one" outcome `reads.ts:18-23` names and rejects — shipping ON.
   *
   * The expectation below therefore records MEASURED behaviour, not desired
   * behaviour, and is deliberately an equality on the whole set so a change in
   * either direction fails this test rather than passing silently. Which of
   * `options.ts:221` and `reads.ts:18-23` is wrong is the owner's call; this
   * test exists so the call is made against a fact rather than an assumption.
   */
  it('refuses the document list AND every asset input once the branch holds state', async () => {
    const refused: string[] = []
    for (const entry of SHIPPED_WORKLOAD) {
      if ((await outcomeOf(entry, NON_EMPTY_BRANCH)) === 'refused') refused.push(entry.query)
    }
    /*
     * ─────────────────────────────────────────────────────────────────────
     * UPDATED 2026-08-09, AND THE TWO ASSET ENTRIES ARE GONE ON PURPOSE.
     *
     * The comment above asked the owner to decide between `options.ts:221` and
     * `reads.ts:18-23`. The answer turned out to be neither: both asset
     * refusals were wrong on their own terms, and both are now answered.
     *
     *   `sha1hash`   the dedup probe. `client/assetDedup.ts` answers it from
     *                the branch — the branch HOLDS the `sanity.*Asset`
     *                documents since §24.3, so its candidate set really is
     *                complete for the branch, and the answer cannot change the
     *                resulting `asset._ref` because asset ids are
     *                content-addressed. Delegating it was also the live
     *                image-upload hang: nothing is uploaded until it emits.
     *
     *   `_id == $ref` the file/image input's asset read. It names the id
     *                EXACTLY, so `_type` beside it can only narrow.
     *                `readPlan.ts` was refusing on the `_type` conjunct before
     *                it had looked at the `_id` one — order of conjuncts
     *                deciding completeness — and the consequence was that a
     *                BRANCH-uploaded file rendered with no filename and no
     *                mime type, because base does not hold it.
     *
     * What remains is the one genuine gap: a dataset-wide ID-pattern scan.
     * Still an equality on the whole set, so a drift in either direction fails.
     * ─────────────────────────────────────────────────────────────────────
     */
    expect(refused).toEqual(['*[!(_id in path("drafts.**"))]'])
  })

  /**
   * THE FINDING THIS PINNED, AND WHY IT NOW READS THE OTHER WAY.
   *
   * It was written to record that the identical GROQ had two fates decided by a
   * runtime PARAMETER VALUE — answered for `article`, refused for
   * `sanity.fileAsset`. That asymmetry was the bug, not a property worth
   * keeping: this query names `_id` exactly, so the candidate set is the id,
   * and the `_type` conjunct beside it can only narrow it.
   *
   * The pin survives as an equality on BOTH fates, because the thing worth
   * catching is still divergence between them.
   */
  it('answers on the id, whatever the type parameter says — same GROQ, one fate', async () => {
    const query = '*[_type == $type &&_id == $ref][0]{mimeType, originalFilename}'
    const entry = {query, surface: 'asset input'} as const
    const asAsset = await outcomeOf(
      {...entry, params: {type: 'sanity.fileAsset', ref: 'file-1'}},
      NON_EMPTY_BRANCH,
    )
    const asOrdinary = await outcomeOf(
      {...entry, params: {type: 'article', ref: 'article-1'}},
      NON_EMPTY_BRANCH,
    )
    expect(asAsset).toBe('overlay')
    expect(asOrdinary).toBe('overlay')
  })

  /**
   * The type guard is NOT gone — it still refuses a system-type SCAN, which has
   * no bounded candidate plan. Only the id-bounded shape was wrong.
   */
  it('still refuses a bare system-type scan, which no id bounds', async () => {
    expect(
      await outcomeOf(
        {
          query: '*[_type == $type]',
          params: {type: 'sanity.imageAsset'},
          surface: 'system-type scan',
        },
        NON_EMPTY_BRANCH,
      ),
    ).toBe('refused')
  })

  it('refuses NOTHING while the branch is still empty, which is the documented mitigation', async () => {
    const refused: string[] = []
    for (const entry of SHIPPED_WORKLOAD) {
      if ((await outcomeOf(entry, [])) === 'refused') refused.push(entry.query)
    }
    expect(refused).toEqual([])
  })

  /**
   * The refusal is a THROW, not a degraded answer — so it propagates out of
   * `client.fetch` into Studio's own render path. That is the difference
   * between "the list is stale" and "the pane crashes", and it is why the
   * finding above is boot-severity rather than cosmetic.
   */
  it('surfaces the refusal as a thrown error carrying the planner’s reason', async () => {
    const {read, records} = shippedReader(NON_EMPTY_BRANCH)
    const attempt = read({
      query: '*[!(_id in path("drafts.**"))]',
      params: {},
      baseFetch: evaluateOverStaging,
    })
    await expect(attempt).rejects.toBeInstanceOf(OverlayReadRefusedError)
    await expect(attempt).rejects.toThrow(/path\(\)/)
    expect(records.map((record) => record.outcome)).toEqual(['refused'])
  })

  /**
   * The same query, same non-empty branch, strict OFF: it degrades to a
   * recorded passthrough instead. This is the control that proves the refusal
   * above is caused by the DEFAULT and not by the query being unanswerable —
   * without it, the test above would be consistent with a planner bug.
   */
  it('degrades the same query to a recorded passthrough when strict is off', async () => {
    const records: StudioReadRecord[] = []
    const overlay = overlaySourceFromBranch(NON_EMPTY_BRANCH)
    const read = createStudioReader({
      overlay: () => overlay,
      strict: () => resolveOverlayOptions({strictQueries: false}, {}).strictQueries,
      onRecord: (record) => records.push(record),
    })
    const answer = await read({
      query: '*[!(_id in path("drafts.**"))]',
      params: {},
      baseFetch: evaluateOverStaging,
    })
    expect(answer.answered).toBe(false)
    expect(records.map((record) => record.outcome)).toEqual(['passthrough'])
  })

  /**
   * §5.5 forbids SILENT approximation. A passthrough is permitted only because
   * it is recorded and logged; if the log stopped firing, the passthrough would
   * become the silent approximation the PRD bans.
   */
  it('logs every passthrough, so no degraded read is silent', async () => {
    const logs: string[] = []
    const overlay = overlaySourceFromBranch(NON_EMPTY_BRANCH)
    const read = createStudioReader({
      overlay: () => overlay,
      strict: () => false,
      onLog: (message) => logs.push(message),
    })
    await read({query: '*[!(_id in path("drafts.**"))]', params: {}, baseFetch: evaluateOverStaging})
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('*[!(_id in path("drafts.**"))]')
  })
})

/* ════════════════════════════════════ what strict does NOT compromise */

describe('the plannable majority is answered over the branch either way', () => {
  /**
   * An independent oracle, not the reader's own bookkeeping: the branch renamed
   * `article-1`'s draft title, so an overlay-answered read MUST show the branch
   * title and a passthrough MUST show staging's. The title is the discriminator.
   */
  it('serves a document-pane read from branch state, not staging', async () => {
    const {read} = shippedReader(NON_EMPTY_BRANCH)
    const answer = await read({
      query: '*[_id == $id][0]',
      params: {id: 'drafts.article-1'},
      baseFetch: evaluateOverStaging,
    })
    expect(answer.answered).toBe(true)
    if (!answer.answered) return
    expect((answer.result as Rec).title).toBe('branch one')
  })

  /**
   * The ones that DO survive the strict default, named individually rather than
   * counted — a count would still pass if the set drifted. Two asset reads
   * joined this list on 2026-08-09; see the refusal test above for why.
   */
  it('answers the surviving shipped queries from the overlay, under the strict default', async () => {
    const answered: string[] = []
    for (const entry of SHIPPED_WORKLOAD) {
      if ((await outcomeOf(entry, NON_EMPTY_BRANCH)) === 'overlay') answered.push(entry.query)
    }
    expect(answered).toEqual([
      '*[_id == $id][0]',
      '*[_id in $ids]{_id, cdnAccessPolicy}',
      '*[_id in $draftIds]._id',
      '*[_type == $documentType && sha1hash == $hash][0]',
      '*[_type == $type &&_id == $ref][0]{mimeType, originalFilename}',
      '*[sanity::versionOf($publishedId)][0]._type',
      '*[references($docId)]',
    ])
  })
})
