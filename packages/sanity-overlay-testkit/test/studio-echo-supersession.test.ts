import {describe, expect, it} from 'vitest'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {seedOverlayDocuments, wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import type {OverlayHydrationDocument} from '../../sanity-overlay-studio/src/client/transport'

/*
 * ═══════════════════════════════════════════════════════════════════
 * R5 SUPERSESSION — the ECHO path (the edit form's own read).
 *
 * 2026-08-11, live: after a branch publish the list pane (fed from
 * `overlaySourceFromBranch`, which derives R5) showed the branch title,
 * while the FORM (fed from the pair listener's `getDocuments` snapshot
 * through `seedOverlayDocuments` → echo → `tapRead`) showed the stale
 * upstream draft. Same hydration array, two derivations, one of them
 * missing the §18.2 rule. These tests pin the echo derivation.
 * ═══════════════════════════════════════════════════════════════════
 */

type Rec = Record<string, unknown>

const LOGICAL = 'article-2'
const DRAFT_ID = 'drafts.article-2'

const BRANCH_PUBLISHED: Rec = {
  _id: LOGICAL,
  _type: 'article',
  _rev: 'overlay.9.aaaa',
  title: 'Well?',
}

const STALE_BASE_DRAFT: Rec = {
  _id: DRAFT_ID,
  _type: 'article',
  _rev: 'base-draft-rev',
  title: 'Article 2 (DRAFT: retitled)',
}

const BASE_PUBLISHED: Rec = {
  _id: LOGICAL,
  _type: 'article',
  _rev: 'base-pub-rev',
  title: 'Article 2',
}

/** `/state` after a §18.5 branch publish — the exact live wire shape. */
const R5_ROW: OverlayHydrationDocument = {
  logicalId: LOGICAL,
  schemaType: 'article',
  draft: null,
  published: BRANCH_PUBLISHED,
  draftTombstone: false,
  publishedTombstone: false,
} as OverlayHydrationDocument

function silentTransport(): OverlayTransport {
  return {
    commit: async () => ({outcome: 'ok', committed: true}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  } as unknown as OverlayTransport
}

function stubClient(baseAnswers: Record<string, Rec | null>) {
  const client: Rec = {
    fetch: () => Promise.resolve(null),
    getDocument: (id: string) => Promise.resolve(baseAnswers[id] ?? null),
    getDocuments: (ids: string[]) => Promise.resolve(ids.map((id) => baseAnswers[id] ?? null)),
    config: () => ({projectId: 'b1n03q3z', dataset: 'parity', apiHost: 'https://api.example.test'}),
    withConfig: (): unknown => client,
    request: () => Promise.resolve({}),
  }
  return client
}

describe('R5 in the echo state — seedOverlayDocuments derives supersession', () => {
  it('a published-no-draft hydration row SUPPRESSES the draft address', () => {
    const echo = createOverlayEcho()
    seedOverlayDocuments(echo, [R5_ROW])
    expect(echo.getOverlayDocument(LOGICAL)).toEqual(BRANCH_PUBLISHED)
    expect(echo.getOverlayDocument(DRAFT_ID)).toBeUndefined()
    /* THE RED LINE — today this is false and the base draft answers. */
    expect(echo.isOverlaySuppressed(DRAFT_ID)).toBe(true)
  })

  it('boundary: a live branch draft is held, not suppressed', () => {
    const echo = createOverlayEcho()
    const draftBody = {...STALE_BASE_DRAFT, title: 'branch draft'}
    seedOverlayDocuments(echo, [{...R5_ROW, draft: draftBody} as OverlayHydrationDocument])
    expect(echo.getOverlayDocument(DRAFT_ID)).toEqual(draftBody)
    expect(echo.isOverlaySuppressed(DRAFT_ID)).toBe(false)
  })

  it('boundary: published tombstoned means NO supersession — base draft may answer', () => {
    const echo = createOverlayEcho()
    seedOverlayDocuments(echo, [
      {...R5_ROW, published: null, publishedTombstone: true} as OverlayHydrationDocument,
    ])
    /* §18.2: publishedTombstone falls through to the base draft. */
    expect(echo.isOverlaySuppressed(DRAFT_ID)).toBe(false)
    expect(echo.isOverlaySuppressed(LOGICAL)).toBe(true)
  })

  it('boundary: a draft-only row leaves the published address alone', () => {
    const echo = createOverlayEcho()
    seedOverlayDocuments(echo, [
      {
        logicalId: LOGICAL,
        schemaType: 'article',
        draft: {...STALE_BASE_DRAFT, title: 'branch draft'},
        published: null,
        draftTombstone: false,
        publishedTombstone: false,
      } as OverlayHydrationDocument,
    ])
    expect(echo.isOverlaySuppressed(LOGICAL)).toBe(false)
  })

  it('re-hydration keeps the suppression — the poll must not erase it', () => {
    const echo = createOverlayEcho()
    seedOverlayDocuments(echo, [R5_ROW])
    seedOverlayDocuments(echo, [R5_ROW])
    expect(echo.isOverlaySuppressed(DRAFT_ID)).toBe(true)
  })
})

describe('R5 through the facade — the pair snapshot the form opens with', () => {
  function harness() {
    const echo = createOverlayEcho()
    seedOverlayDocuments(echo, [R5_ROW])
    const wrapped = wrapWithOverlay(
      stubClient({[DRAFT_ID]: STALE_BASE_DRAFT, [LOGICAL]: BASE_PUBLISHED}) as never,
      {echo, transport: silentTransport(), onError: () => undefined},
    ) as unknown as Rec
    return wrapped
  }

  it('getDocuments([draft, published]) never returns the superseded base draft', async () => {
    const answer = (await (harness().getDocuments as (ids: string[]) => Promise<unknown[]>)([
      DRAFT_ID,
      LOGICAL,
    ])) as (Rec | null)[]
    /* The live symptom: index 0 carried "Article 2 (DRAFT: retitled)". */
    expect(answer[0]).toBeNull()
    expect((answer[1] as Rec).title).toBe('Well?')
  })

  it('getDocument(draft) answers null, not the base draft', async () => {
    const answer = await (harness().getDocument as (id: string) => Promise<unknown>)(DRAFT_ID)
    expect(answer).toBeNull()
  })
})

describe('R5 in the publish frames — the echoed transition states branch content', () => {
  it('the published frame carries the branch body even after hydration cleared the draft', () => {
    const echo = createOverlayEcho()

    /* The session as it was: the pane had seeded both base bodies, and the
     * branch held a draft (the edit being published). */
    echo.seedFromResult([BASE_PUBLISHED, STALE_BASE_DRAFT], true)
    seedOverlayDocuments(echo, [
      {...R5_ROW, draft: BRANCH_PUBLISHED, published: null} as OverlayHydrationDocument,
    ])

    const frames: Rec[] = []
    const subscription = echo.subscribe([LOGICAL, DRAFT_ID], (event) =>
      frames.push(event as unknown as Rec),
    )

    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.publish',
        draftId: DRAFT_ID,
        publishedId: LOGICAL,
      },
    ])
    expect(plan.unsupported).toEqual([])

    /* persistAndEcho's real order: the commit's hydration lands BEFORE the
     * frames are emitted — the draft body is gone from the echo by then. */
    seedOverlayDocuments(echo, [R5_ROW])
    echo.emit(plan.plans, 'tx-publish-r5')

    const publishedFrame = frames.find((f) => f.documentId === LOGICAL)!
    expect(publishedFrame).toBeDefined()
    const mutations = publishedFrame.mutations as Rec[]
    const createOrReplace = mutations.find((m) => m.createOrReplace !== undefined)
      ?.createOrReplace as Rec
    /* The frame must state what the branch PUBLISHED — never the base draft. */
    expect(createOrReplace.title).toBe('Well?')

    subscription.unsubscribe()
  })
})
