/**
 * EVERY PLACE THE ECHO DECLINES TO BUILD A FRAME, AND WHAT HAPPENS NEXT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE ENFORCES: NOTHING MAY HANG.
 *
 * A Studio write that reaches the overlay but produces no listener frame leaves
 * `@sanity/mutator`'s `Document.submitted` non-empty for ever. That is not a
 * cosmetic loss — `sanity@6.8.0` gates `publish`, `unpublish`, `discardChanges`
 * and `delete` on `isConsistent$` (`lib/datastores-DqFH7RLd.js:2450`), so an
 * unechoed write silently disables four of the six §21.2 actions AND parks the
 * pane on `Saving…` with nothing in any channel to explain it.
 *
 * So each refusal below must do BOTH of:
 *   1. say why, on the error channel the banner renders; and
 *   2. leave the pane a way out — the `reset` event `getPairListener` turns into
 *      a fresh snapshot fetch (`lib/datastores-DqFH7RLd.js:1681`).
 *
 * The one exception is stated explicitly and tested as such: a change that is
 * genuinely a NO-OP for the pane (removing an address the pane never held) is
 * silence, not a refusal, and must not trigger either.
 *
 * `studio-branch-created-consistency.test.ts` is the companion file: it proves
 * the SUCCESS path against the real `@sanity/mutator` and a real overlay on
 * disk. This one is about the failure paths, where the interesting question is
 * what the echo says rather than what a document ends up containing.
 */
import {describe, expect, it} from 'vitest'

import {
  createOverlayEcho,
  MAX_RESYNCS_PER_DOCUMENT,
  type OverlayEcho,
  type OverlayListenerEvent,
} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import type {
  OverlayTransport,
  OverlayTransportOutcome,
} from '../../sanity-overlay-studio/src/client/transport'

type Rec = Record<string, unknown>

interface Watched {
  echo: OverlayEcho
  errors: string[]
  events: OverlayListenerEvent[]
  frames: () => OverlayListenerEvent[]
  resyncs: () => OverlayListenerEvent[]
}

function watched(ids: readonly string[]): Watched {
  const errors: string[] = []
  const events: OverlayListenerEvent[] = []
  const echo = createOverlayEcho({
    onError: (message) => errors.push(message),
    now: (() => {
      let tick = 0
      return () => Date.UTC(2026, 0, 1) + (tick += 1000)
    })(),
  })
  echo.subscribe(ids, (event) => events.push(event))
  return {
    echo,
    errors,
    events,
    frames: () => events.filter((event) => event.type === 'mutation'),
    resyncs: () => events.filter((event) => event.type === 'reset'),
  }
}

const BRANCH_DRAFT: Rec = {
  _id: 'drafts.article-1',
  _type: 'article',
  _rev: 'overlay.4.0123456789ab',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-01T00:00:00.000Z',
  title: 'Branch created',
}

/* ════════════════════════════ refusal 1 — nothing to copy from (§18.5/§18.6) */

describe('copyFrom with no known body', () => {
  it('refuses by name and asks the pane to re-read, instead of going quiet', () => {
    const w = watched(['article-1', 'drafts.article-1'])

    const delivered = w.echo.emit(
      [{documentId: 'article-1', transition: 'update', copyFrom: 'drafts.article-1'}],
      'tx-publish',
    )

    expect(delivered).toEqual([])
    expect(w.frames()).toEqual([])
    expect(w.errors.join(' ')).toMatch(/no known body for drafts\.article-1/)

    const resync = w.resyncs()
    expect(resync, 'a publish that cannot be echoed must not leave the pane at Saving…').toHaveLength(1)
    expect((resync[0] as {documentIds: string[]}).documentIds).toEqual(['article-1'])
    /* `reset` is sanity's own spelling: `getPairListener` maps it straight onto
     * `fetchInitialDocumentSnapshots()`. */
    expect(resync[0]?.type).toBe('reset')
  })

  it('still echoes the sibling frames it CAN build', () => {
    const w = watched(['article-1', 'drafts.article-1'])

    /* §18.5 publish plans two frames; only the copy needs a body. */
    const delivered = w.echo.emit(
      [
        {documentId: 'article-1', transition: 'update', copyFrom: 'drafts.article-1'},
        {
          documentId: 'drafts.article-1',
          transition: 'disappear',
          mutations: [{delete: {id: 'drafts.article-1'}}],
        },
      ],
      'tx-publish-partial',
    )

    /* The draft disappearance is suppressed too — the pane holds no revision for
     * it, so there is nothing to remove (see the no-op section below). */
    expect(delivered).toEqual([])
    expect(w.resyncs()).toHaveLength(1)
  })
})

/* ════════════════════════ refusal 2 — a branch-created document with no body */

describe('an edit at an address nothing knows about', () => {
  it('refuses with a reason that names all three places it looked', () => {
    const w = watched(['drafts.article-1'])

    const delivered = w.echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'update',
          patch: {set: {title: 'x'}},
          cloneFrom: 'article-1',
        },
      ],
      'tx-edit',
    )

    expect(delivered).toEqual([])
    expect(w.errors.join(' ')).toMatch(/no revision for it/)
    expect(w.errors.join(' ')).toMatch(/no published base to clone/)
    expect(w.errors.join(' ')).toMatch(/reported no body/)
    expect(w.resyncs()).toHaveLength(1)
  })

  it('builds the frame from the branch body once the overlay has reported one', () => {
    const w = watched(['drafts.article-1'])
    w.echo.setOverlayDocument('drafts.article-1', BRANCH_DRAFT)

    const delivered = w.echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'update',
          patch: {set: {title: 'x'}},
          cloneFrom: 'article-1',
        },
      ],
      'tx-edit-2',
    )

    expect(w.resyncs()).toEqual([])
    expect(delivered).toHaveLength(1)
    /* ONE createOrReplace, not createIfNotExists + the patch: the branch body
     * ALREADY has the patch folded in, so replaying it would apply it twice —
     * silently wrong for `inc`, `dec` and `insert`. */
    expect(delivered[0]?.mutations).toEqual([
      {
        createOrReplace: {
          _id: 'drafts.article-1',
          _type: 'article',
          _createdAt: '2026-01-01T00:00:00.000Z',
          title: 'Branch created',
        },
      },
    ])
    /* The frame states the revision, and the payload must not contradict it. */
    expect((delivered[0]?.mutations[0] as Rec).createOrReplace).not.toHaveProperty('_rev')
    expect(delivered[0]?.previousRev).toBeUndefined()
    expect(delivered[0]?.resultRev).toBe('tx-edit-2')
    expect(delivered[0]?.transition).toBe('appear')
  })
})

/* ═════════════════════════ refusal 3 — a create action with nothing to create */

describe('sanity.action.document.create', () => {
  it('is planned, not refused — it is the first transaction of every branch document', () => {
    const echo = createOverlayEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.create',
        publishedId: 'article-9',
        attributes: {_id: 'drafts.article-9', _type: 'article', title: 'New'},
        ifExists: 'fail',
      },
    ])

    expect(plan.unsupported).toEqual([])
    expect(plan.plans).toEqual([
      {
        documentId: 'drafts.article-9',
        transition: 'appear',
        mutations: [{create: {_id: 'drafts.article-9', _type: 'article', title: 'New'}}],
      },
    ])
    /* The commit is unchanged: it always went to the overlay, only the frame was
     * missing. */
    expect(plan.commits).toHaveLength(1)
    expect(plan.commits[0]?.kind).toBe('actions')
  })

  it('emits a create-shaped frame, which is the only shape a missing HEAD accepts', () => {
    const w = watched(['drafts.article-9'])
    const plan = w.echo.planActions([
      {
        actionType: 'sanity.action.document.create',
        publishedId: 'article-9',
        attributes: {_id: 'drafts.article-9', _type: 'article', title: 'New'},
      },
    ])

    const delivered = w.echo.emit(plan.plans, 'tx-create')
    expect(delivered).toHaveLength(1)
    expect(Object.keys(delivered[0]!.mutations[0]!)).toEqual(['create'])
    expect(w.resyncs()).toEqual([])
  })

  it('refuses BY NAME when there is no body carrying an _id', () => {
    const echo = createOverlayEcho()
    const plan = echo.planActions([
      {actionType: 'sanity.action.document.create', publishedId: 'article-9'},
    ])

    expect(plan.plans).toEqual([])
    expect(plan.unsupported).toEqual(['sanity.action.document.create: no attributes carrying an _id'])
  })

  it('is still superseded by a replaceDraft for the same draft', () => {
    const echo = createOverlayEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.create',
        attributes: {_id: 'drafts.article-1', _type: 'article'},
      },
      {
        actionType: 'sanity.action.document.replaceDraft',
        publishedId: 'article-1',
        attributes: {_id: 'drafts.article-1', _type: 'article', title: 'restored'},
      },
    ])

    expect(plan.plans).toHaveLength(1)
    expect(plan.plans[0]?.mutations?.[0]).toHaveProperty('createOrReplace')
  })
})

/* ═══════════════════ the no-op: silence that is not a refusal and must not be */

describe('a change with nothing to report', () => {
  it('does not echo a disappearance for an address the pane never held', () => {
    const w = watched(['article-1', 'drafts.article-1'])
    w.echo.seedFromResult({_id: 'drafts.article-1', _type: 'article', _rev: 'r1'}, true)

    /* §18.8 delete of a branch-created document: the draft exists, the published
     * version never did. */
    const delivered = w.echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'disappear',
          mutations: [{delete: {id: 'drafts.article-1'}}],
        },
        {
          documentId: 'article-1',
          transition: 'disappear',
          mutations: [{delete: {id: 'article-1'}}],
        },
      ],
      'tx-delete',
    )

    expect(delivered.map((event) => event.documentId)).toEqual(['drafts.article-1'])
    /*
     * NOT A REFUSAL. A `{delete}` frame fails `appliesToMissingDocument`, so
     * delivering one against a published version that never existed would park
     * the published BufferedDocument in `incoming` for ever and hold
     * `consistencyStatus` false — blocking every later gated action on the pair.
     * Saying nothing is the truth, so nothing is said and nobody is alarmed.
     */
    expect(w.resyncs()).toEqual([])
    expect(w.errors).toEqual([])
  })
})

/* ═══════════════════════════════════════════════ the resync itself is bounded */

describe('the resync request', () => {
  it('gives up after a fixed number of attempts and says the pane will not settle', () => {
    const w = watched(['article-1'])

    for (let attempt = 0; attempt < MAX_RESYNCS_PER_DOCUMENT + 2; attempt += 1) {
      w.echo.emit(
        [{documentId: 'article-1', transition: 'update', copyFrom: 'nowhere'}],
        `tx-${attempt}`,
      )
    }

    expect(w.resyncs()).toHaveLength(MAX_RESYNCS_PER_DOCUMENT)
    expect(w.errors.join(' ')).toMatch(/has already been re-read/)
    expect(w.errors.join(' ')).toMatch(/Reload the Studio/)
  })

  it('only reaches listeners watching the affected address', () => {
    const errors: string[] = []
    const echo = createOverlayEcho({onError: (message) => errors.push(message)})
    const mine: OverlayListenerEvent[] = []
    const theirs: OverlayListenerEvent[] = []
    echo.subscribe(['article-1'], (event) => mine.push(event))
    echo.subscribe(['article-2'], (event) => theirs.push(event))

    echo.emit([{documentId: 'article-1', transition: 'update', copyFrom: 'nowhere'}], 'tx-1')

    expect(mine).toHaveLength(1)
    expect(theirs).toEqual([])
  })

  it('is not issued for a replayed transaction — that one already settled', () => {
    const w = watched(['drafts.article-1'])
    w.echo.setOverlayDocument('drafts.article-1', BRANCH_DRAFT)
    const plan = [
      {
        documentId: 'drafts.article-1',
        transition: 'update' as const,
        patch: {set: {title: 'x'}},
      },
    ]

    expect(w.echo.emit(plan, 'tx-once')).toHaveLength(1)
    expect(w.echo.emit(plan, 'tx-once')).toEqual([])
    expect(w.resyncs()).toEqual([])
  })

  it('is not issued after logout — the session has no pane left to tell', () => {
    const w = watched(['article-1'])
    w.echo.logout()
    expect(w.echo.emit([{documentId: 'article-1', transition: 'update', copyFrom: 'nowhere'}], 'tx-1')).toEqual([])
    expect(w.resyncs()).toEqual([])
  })
})

/* ══════════════════════════════ one document, one frame, one transaction */

describe('two plans for the same document in one transaction', () => {
  /**
   * `toActions` flatMaps mutations to actions, so the ordinary edit of an
   * existing draft — `[{patch: unset guard}, {patch: …}]` after
   * `SquashingBuffer` squashes them — arrives as TWO edit actions for one draft.
   * Two frames would both claim `previousRev → resultRev`; the first advances
   * `HEAD._rev` and the second can never match anything again.
   */
  it('merges into a single frame carrying both mutation lists', () => {
    const w = watched(['drafts.article-1'])
    w.echo.seedFromResult({_id: 'drafts.article-1', _type: 'article', _rev: 'r1'}, true)

    const delivered = w.echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'update',
          patch: {unset: ['_empty_action_guard_pseudo_field_']},
        },
        {documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'x'}}},
      ],
      'tx-double',
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.transactionTotalEvents).toBe(1)
    expect(delivered[0]?.mutations).toHaveLength(4)
    expect(delivered[0]?.previousRev).toBe('r1')
    expect(delivered[0]?.resultRev).toBe('tx-double')
  })

  it('keeps the LAST transition, so an edit-then-remove still ends as disappear', () => {
    const w = watched(['drafts.article-1'])
    w.echo.seedFromResult({_id: 'drafts.article-1', _type: 'article', _rev: 'r1'}, true)

    const delivered = w.echo.emit(
      [
        {documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'x'}}},
        {
          documentId: 'drafts.article-1',
          transition: 'disappear',
          mutations: [{delete: {id: 'drafts.article-1'}}],
        },
      ],
      'tx-edit-then-remove',
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.transition).toBe('disappear')
    expect(delivered[0]?.mutations.at(-1)).toEqual({delete: {id: 'drafts.article-1'}})
    /* A `disappear` clears the echo's revision, so the next write at this
     * address has to be create-shaped — which is what the guard enforces. */
    expect(w.echo.revisionOf('drafts.article-1')).toBeUndefined()
  })
})

/* ═════════════════ a commit that did NOT land must not be echoed, or be silent */

function transportAnswering(outcome: OverlayTransportOutcome): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome, retryable: outcome === 'degraded', status: 409}),
    operation: async () => ({outcome: 'ok', retryable: false}),
    resolve: async () => ({outcome: 'ok', retryable: false}),
    state: async () => ({outcome: 'ok', retryable: false}),
  }
}

function facadeOver(
  echo: OverlayEcho,
  transport: OverlayTransport,
  errors: string[],
): Record<string, unknown> {
  const self: Rec = {
    fetch: () => Promise.resolve(null),
    getDocument: () => Promise.resolve(undefined),
    getDocuments: () => Promise.resolve([]),
    mutate: () => Promise.reject(new Error('the real client.mutate must never run')),
    action: () => Promise.reject(new Error('the real client.action must never run')),
    listen: () => ({subscribe: () => ({unsubscribe: () => {}})}),
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
  }
  return wrapWithOverlay(self, {
    echo,
    transport,
    onError: (message) => errors.push(message),
  }) as Record<string, unknown>
}

describe.each([
  ['stale', 'the branch moved under this session (409) and the write was rejected'],
  ['fatal', 'the overlay refused the write outright'],
] as const)('a %s commit', (outcome, why) => {
  it(`is not echoed as if it had been saved — ${why}`, async () => {
    const errors: string[] = []
    const events: OverlayListenerEvent[] = []
    const echo = createOverlayEcho({onError: (message) => errors.push(message)})
    echo.seedFromResult({_id: 'drafts.a', _type: 'article', _rev: 'r1'}, true)
    echo.subscribe(['drafts.a'], (event) => events.push(event))

    const wrapped = facadeOver(echo, transportAnswering(outcome), errors)
    await (wrapped.mutate as CallableFunction)([{patch: {id: 'drafts.a', set: {x: 1}}}])
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

    /* No frame: the disk does not hold this, so nothing may claim it does. */
    expect(events.filter((event) => event.type === 'mutation')).toEqual([])
    /* The revision chain is untouched, so a later successful write still chains. */
    expect(echo.revisionOf('drafts.a')).toBe('r1')
    /* …and the pane is not left holding a transaction nothing will answer. */
    const resync = events.filter((event) => event.type === 'reset')
    expect(resync).toHaveLength(1)
    expect((resync[0] as {documentIds: string[]}).documentIds).toEqual(['drafts.a'])
    expect(errors.join(' ')).toMatch(new RegExp(outcome))
  })
})

/* ══════════════════════════ the pane snapshot the read tap actually delivered */

describe('notePaneSnapshot keeps the echo agreeing with what the pane holds', () => {
  it('adopts the synthetic revision of a substituted branch body', () => {
    const echo = createOverlayEcho()
    /* Base answered nothing — Mode 2. */
    echo.seedFromResult(null, true)
    echo.notePaneSnapshot('drafts.article-1', BRANCH_DRAFT)

    expect(echo.revisionOf('drafts.article-1')).toBe('overlay.4.0123456789ab')
    /* …and the merge ancestor is untouched: an overlay body must never become
     * its own base (§17.1, §13.9). */
    expect(echo.getDocState('drafts.article-1')?.doc).toBeUndefined()
    /*
     * `paneRev`, NOT `synthetic`, and the distinction is the whole reason the two
     * flags exist separately. Both stop a later non-authoritative read clobbering
     * the revision. Only `synthetic` additionally means "the stored `doc` is not
     * a usable merge ancestor" — which `runtime.ts` `baseDocuments` reads, and
     * which is FALSE here: `doc` still holds whatever base answered.
     */
    expect(echo.getDocState('drafts.article-1')?.paneRev).toBe(true)
    expect(echo.getDocState('drafts.article-1')?.synthetic).not.toBe(true)
  })

  it('leaves the base body available as a merge ancestor', () => {
    const echo = createOverlayEcho()
    const base = {_id: 'drafts.article-1', _type: 'article', _rev: 'lake-1', title: 'From base'}
    echo.seedFromResult(base, true)
    echo.notePaneSnapshot('drafts.article-1', BRANCH_DRAFT)

    /* §16.1: the Studio holds the only Sanity credential, so this is the only
     * place a rebase's "current base" can come from. Marking the state
     * `synthetic` here emptied it and disabled the rebase action. */
    const state = echo.getDocState('drafts.article-1')
    expect(state?.doc).toEqual(base)
    expect(state?.synthetic).not.toBe(true)
  })

  it('survives a later non-authoritative read rather than reverting to the base revision', () => {
    const echo = createOverlayEcho()
    echo.seedFromResult({_id: 'drafts.article-1', _type: 'article', _rev: 'lake-1'}, true)
    echo.notePaneSnapshot('drafts.article-1', BRANCH_DRAFT)

    /* Any other read still answers the STALE Content Lake revision once writes
     * are intercepted; letting one win would break the chain 30 s later as a
     * `sequentializeListenerEvents` deadline, far from its cause. */
    echo.seedFromResult({_id: 'drafts.article-1', _type: 'article', _rev: 'lake-1'}, false)
    expect(echo.revisionOf('drafts.article-1')).toBe('overlay.4.0123456789ab')
  })

  it('does not overwrite the base body it was seeded with', () => {
    const echo = createOverlayEcho()
    const base = {_id: 'article-1', _type: 'article', _rev: 'lake-9', title: 'From the lake'}
    echo.seedFromResult(base, true)
    echo.notePaneSnapshot('article-1', {...BRANCH_DRAFT, _id: 'article-1'})

    expect(echo.getDocState('article-1')?.doc).toEqual(base)
    expect(echo.revisionOf('article-1')).toBe('overlay.4.0123456789ab')
  })

  it('forgets the revision for a tombstoned address, so a re-create can chain', () => {
    const echo = createOverlayEcho()
    echo.seedFromResult({_id: 'article-1', _type: 'article', _rev: 'lake-9'}, true)
    echo.notePaneSnapshot('article-1', null)

    expect(echo.revisionOf('article-1')).toBeUndefined()
  })

  it('shouts when the substituted body carries no revision at all', () => {
    const errors: string[] = []
    const echo = createOverlayEcho({onError: (message) => errors.push(message)})
    echo.notePaneSnapshot('drafts.article-1', {_id: 'drafts.article-1', _type: 'article'})

    /* `Document.considerIncoming` will not advance a HEAD without a `_rev`, so
     * no frame this module could build would ever apply. Nothing can be done
     * about it here except say so. */
    expect(errors.join(' ')).toMatch(/carries no _rev/)
    expect(echo.revisionOf('drafts.article-1')).toBeUndefined()
  })
})
