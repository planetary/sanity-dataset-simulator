/**
 * `sanity-overlay-studio` — the overlay echo protocol (PRD §18.4–§18.9, §21.4.1).
 *
 * WHAT THIS LAYER IS
 * Studio's document pane is driven by a listener. When the overlay intercepts a
 * write, the real listener will never report it — the Content Lake never saw the
 * mutation — so the pane would sit at "Saving…" forever. This module synthesises
 * the listener frames the pane is waiting for, and decides which overlay
 * operations a Studio write corresponds to.
 *
 * It is pure data-in/data-out: no `window`, no client, no clock that is not
 * injected. That is deliberate — the questions worth asking here ("does a
 * publish emit the two frames §18.5 requires, in that order?") are all answerable
 * without a browser.
 *
 * FOUR RULES THE FRAMES MUST OBEY (sanity 6.8.0 sources)
 *  1. The frame carries Studio's OWN transactionId. `BufferedDocument` mints it
 *     and `consumeUnresolved` matches on it; a fabricated id leaves the pane
 *     unsaved forever.
 *  2. `sequentializeListenerEvents` needs an unbroken `previousRev -> resultRev`
 *     chain seeded from the pair snapshot fetch. Revisions are learned from real
 *     reads, never invented.
 *  3. `Document.considerIncoming` only accepts a first-entry create when the
 *     document does not exist, and drops frames older than HEAD._updatedAt.
 *  4. `transactionTotalEvents` is scoped to *that listener's* filter. A shared
 *     count parks every pane matching only part of the transaction.
 */
import {describe, expect, it, vi} from 'vitest'
import {
  authStatusOf,
  createOverlayEcho,
  type OverlayEcho,
  type OverlayMutationEvent,
} from '../../sanity-overlay-studio/src/client/echo'

type Rec = Record<string, unknown>

const PUBLISHED: Rec = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

const DRAFT: Rec = {...PUBLISHED, _id: 'drafts.article-1', _rev: 'lake-draft-1'}

let tick = 0
function makeEcho(overrides: Parameters<typeof createOverlayEcho>[0] = {}): OverlayEcho {
  tick = 0
  return createOverlayEcho({
    now: () => Date.UTC(2026, 0, 1) + (tick += 1000),
    ...overrides,
  })
}

/** Collect the frames a subscriber over `ids` receives. */
function collect(echo: OverlayEcho, ids: string[]): OverlayMutationEvent[] {
  const seen: OverlayMutationEvent[] = []
  echo.subscribe(ids, (event) => seen.push(event))
  return seen
}

/* ══════════════════════════════════════════════════════ authStatusOf */

describe('authStatusOf — the shapes @sanity/client throws a 401 in', () => {
  it.each([
    ['ClientError.statusCode', {statusCode: 401}],
    ['HttpError response', {response: {statusCode: 403}}],
    ['API error body under details', {details: {statusCode: 401, error: 'Unauthorized'}}],
    ['API error body under response.body', {response: {body: {statusCode: 403}}}],
    ['bare fetch Response', {status: 401}],
    ['string-valued status', {statusCode: '401'}],
  ])('finds the status in %s', (_label, error) => {
    expect(authStatusOf(error)).toBeGreaterThanOrEqual(401)
  })

  it.each([
    ['a 500', {statusCode: 500}],
    ['a 409', {statusCode: 409}],
    ['a network TypeError', new TypeError('fetch failed')],
    ['the digits 401 inside a message', {message: 'request failed after 401 ms'}],
    ['a string', '401'],
    ['null', null],
    ['undefined', undefined],
  ])('does not read %s as an auth failure', (_label, error) => {
    expect(authStatusOf(error)).toBeUndefined()
  })
})

/* ══════════════════════════════════════════════════════ session */

describe('the session state machine', () => {
  it('starts active and acknowledges writes', () => {
    const echo = makeEcho()
    expect(echo.sessionState()).toBe('active')
    expect(echo.acknowledgeWrite().ok).toBe(true)
  })

  it.each(['listener', 'read', 'write'] as const)(
    'stops acknowledging writes after a 401 seen on the %s',
    (source) => {
      const echo = makeEcho()
      echo.noteAuthFailure({status: 401, source})
      expect(echo.sessionState()).toBe('unauthenticated')
      const ack = echo.acknowledgeWrite()
      expect(ack.ok).toBe(false)
      expect(ack.error?.status).toBe(401)
      expect(ack.error?.message).toMatch(/not authenticated/i)
    },
  )

  it('resumes acknowledging once the token is refreshed', () => {
    const echo = makeEcho()
    echo.noteAuthFailure({status: 401, source: 'read'})
    echo.restoreSession()
    expect(echo.sessionState()).toBe('active')
    expect(echo.acknowledgeWrite().ok).toBe(true)
  })

  it('never acknowledges a write after logout', () => {
    const echo = makeEcho()
    echo.logout()
    expect(echo.sessionState()).toBe('logged-out')
    expect(echo.acknowledgeWrite().ok).toBe(false)
    echo.restoreSession()
    expect(echo.sessionState()).toBe('logged-out')
  })

  it('does not let a late in-flight 401 downgrade logout back to recoverable', () => {
    const echo = makeEcho()
    echo.logout()
    echo.noteAuthFailure({status: 401, source: 'listener'})
    echo.restoreSession()
    expect(echo.sessionState()).toBe('logged-out')
  })

  it('releases every subscription at logout so no pane keeps receiving frames', () => {
    const echo = makeEcho()
    const seen = collect(echo, ['article-1'])
    echo.logout()
    expect(echo.subscriberCount()).toBe(0)
    echo.emit([{documentId: 'article-1', transition: 'update', patch: {set: {title: 'x'}}}], 'tx-1')
    expect(seen).toHaveLength(0)
  })

  it('refuses a subscription created after logout', () => {
    const echo = makeEcho()
    echo.logout()
    const seen = collect(echo, ['article-1'])
    expect(echo.subscriberCount()).toBe(0)
    expect(seen).toHaveLength(0)
  })

  it('records every auth failure for the status banner', () => {
    const echo = makeEcho()
    echo.noteAuthFailure({status: 401, source: 'read', message: 'token expired'})
    echo.noteAuthFailure({status: 403, source: 'write'})
    expect(echo.authFailures()).toEqual([
      {status: 401, source: 'read', message: 'token expired'},
      {status: 403, source: 'write', message: 'HTTP 403'},
    ])
  })
})

/* ══════════════════════════════════════════════════════ revisions */

describe('the revision store', () => {
  it('learns revisions from a read', () => {
    const echo = makeEcho()
    echo.seedFromResult([PUBLISHED, DRAFT], true)
    expect(echo.revisionOf('article-1')).toBe('lake-rev-1')
    expect(echo.revisionOf('drafts.article-1')).toBe('lake-draft-1')
  })

  it('does not let a stale non-authoritative read overwrite a synthetic revision', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    echo.emit([{documentId: 'article-1', transition: 'update', patch: {set: {title: 'a'}}}], 'tx-1')
    expect(echo.revisionOf('article-1')).toBe('tx-1')
    echo.seedFromResult(PUBLISHED, false)
    expect(echo.revisionOf('article-1')).toBe('tx-1')
  })

  it('lets the authoritative pair snapshot reset the chain', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    echo.emit([{documentId: 'article-1', transition: 'update', patch: {set: {title: 'a'}}}], 'tx-1')
    echo.seedFromResult({...PUBLISHED, _rev: 'lake-rev-2'}, true)
    expect(echo.revisionOf('article-1')).toBe('lake-rev-2')
  })

  it('learns the real chain from an event another client produced', () => {
    const echo = makeEcho({identity: 'overlay'})
    echo.observeUpstreamEvent({
      type: 'mutation',
      documentId: 'article-1',
      resultRev: 'lake-rev-9',
      identity: 'someone-else',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(echo.revisionOf('article-1')).toBe('lake-rev-9')
  })

  it('ignores its own frames coming back round', () => {
    const echo = makeEcho({identity: 'overlay'})
    echo.seedFromResult(PUBLISHED, true)
    echo.observeUpstreamEvent({
      type: 'mutation',
      documentId: 'article-1',
      resultRev: 'echoed',
      identity: 'overlay',
    })
    expect(echo.revisionOf('article-1')).toBe('lake-rev-1')
  })
})

/* ══════════════════════════════════════════════════════ frames */

describe('frame construction', () => {
  it("carries Studio's own transaction id as both transactionId and resultRev", () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    const [frame] = echo.emit(
      [{documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'b'}}}],
      'studio-tx-42',
    )
    expect(frame.transactionId).toBe('studio-tx-42')
    expect(frame.resultRev).toBe('studio-tx-42')
    expect(frame.previousRev).toBe('lake-draft-1')
  })

  it('omits previousRev entirely — not as undefined — for a document with no revision', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    const [frame] = echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'appear',
          patch: {set: {title: 'b'}},
          cloneFrom: 'article-1',
        },
      ],
      'tx-1',
    )
    expect('previousRev' in frame).toBe(false)
    expect(frame.transition).toBe('appear')
  })

  it('creates the draft from the published base, as the Actions API edit does', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    const [frame] = echo.emit(
      [
        {
          documentId: 'drafts.article-1',
          transition: 'appear',
          patch: {set: {title: 'b'}},
          cloneFrom: 'article-1',
        },
      ],
      'tx-1',
    )
    const first = frame.mutations[0] as Rec
    expect(Object.keys(first)[0]).toBe('createIfNotExists')
    expect((first.createIfNotExists as Rec)._id).toBe('drafts.article-1')
    expect((first.createIfNotExists as Rec)._rev).toBeUndefined()
  })

  it('refuses to invent a frame it has no body for, and says why', () => {
    const errors: string[] = []
    const echo = makeEcho({onError: (message) => errors.push(message)})
    const frames = echo.emit(
      [{documentId: 'drafts.article-1', transition: 'appear', cloneFrom: 'article-1'}],
      'tx-1',
    )
    expect(frames).toHaveLength(0)
    expect(errors.join(' ')).toMatch(/article-1/)
  })

  it('prefers the overlay-materialized body over a stale read snapshot', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    echo.setOverlayDocument('drafts.article-1', {
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'edited in the overlay',
    })
    const [frame] = echo.emit(
      [{documentId: 'article-1', transition: 'update', copyFrom: 'drafts.article-1'}],
      'tx-1',
    )
    const body = (frame.mutations[0] as Rec).createOrReplace as Rec
    expect(body.title).toBe('edited in the overlay')
    expect(body._id).toBe('article-1')
    expect(body._rev).toBeUndefined()
  })

  it('never emits a timestamp that predates the head it chains from', () => {
    const echo = makeEcho({now: () => Date.UTC(2020, 0, 1)})
    echo.seedFromResult(PUBLISHED, true)
    const [frame] = echo.emit(
      [{documentId: 'article-1', transition: 'update', patch: {set: {title: 'x'}}}],
      'tx-1',
    )
    expect(Date.parse(frame.timestamp)).toBeGreaterThan(Date.parse(PUBLISHED._updatedAt as string))
  })

  it('prepends the Actions API guard unset to an edit of an existing document', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    const [frame] = echo.emit(
      [{documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'b'}}}],
      'tx-1',
    )
    expect(frame.mutations).toHaveLength(2)
    expect(((frame.mutations[0] as Rec).patch as Rec).unset).toEqual([
      '_empty_action_guard_pseudo_field_',
    ])
  })
})

describe('frame delivery', () => {
  it('scopes transactionTotalEvents to each listener filter (rule 4)', () => {
    const echo = makeEcho()
    echo.seedFromResult([PUBLISHED, DRAFT], true)
    const both = collect(echo, ['article-1', 'drafts.article-1'])
    const publishedOnly = collect(echo, ['article-1'])

    echo.emit(
      [
        {documentId: 'article-1', transition: 'update', copyFrom: 'drafts.article-1'},
        {documentId: 'drafts.article-1', transition: 'disappear', mutations: [{delete: {id: 'drafts.article-1'}}]},
      ],
      'tx-1',
    )

    expect(both.map((event) => event.transactionTotalEvents)).toEqual([2, 2])
    expect(both.map((event) => event.transactionCurrentEvent)).toEqual([1, 2])
    expect(publishedOnly.map((event) => event.transactionTotalEvents)).toEqual([1])
    expect(publishedOnly.map((event) => event.transactionCurrentEvent)).toEqual([1])
  })

  it('delivers a transaction exactly once even if emit is called again', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    const seen = collect(echo, ['drafts.article-1'])
    const plan = [
      {documentId: 'drafts.article-1', transition: 'update' as const, patch: {set: {title: 'b'}}},
    ]
    echo.emit(plan, 'tx-1')
    echo.emit(plan, 'tx-1')
    expect(seen).toHaveLength(1)
  })

  it('stops delivering after unsubscribe', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    const seen: OverlayMutationEvent[] = []
    const subscription = echo.subscribe(['drafts.article-1'], (event) => seen.push(event))
    subscription.unsubscribe()
    subscription.unsubscribe()
    echo.emit(
      [{documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'b'}}}],
      'tx-1',
    )
    expect(seen).toHaveLength(0)
    expect(echo.subscriberCount()).toBe(0)
  })

  it('survives a listener that throws and keeps delivering to the others', () => {
    const errors: string[] = []
    const echo = makeEcho({onError: (message) => errors.push(message)})
    echo.seedFromResult(DRAFT, true)
    echo.subscribe(['drafts.article-1'], () => {
      throw new Error('pane exploded')
    })
    const seen = collect(echo, ['drafts.article-1'])
    echo.emit(
      [{documentId: 'drafts.article-1', transition: 'update', patch: {set: {title: 'b'}}}],
      'tx-1',
    )
    expect(seen).toHaveLength(1)
    expect(errors.join(' ')).toMatch(/pane exploded/)
  })

  it('chains a second transaction off the first, unbroken (rule 2)', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    const seen = collect(echo, ['drafts.article-1'])
    echo.emit([{documentId: 'drafts.article-1', transition: 'update', patch: {set: {a: 1}}}], 'tx-1')
    echo.emit([{documentId: 'drafts.article-1', transition: 'update', patch: {set: {a: 2}}}], 'tx-2')
    expect(seen.map((event) => [event.previousRev, event.resultRev])).toEqual([
      ['lake-draft-1', 'tx-1'],
      ['tx-1', 'tx-2'],
    ])
  })

  it('clears the revision after a disappear so a later create is an appear', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    echo.setOverlayDocument('drafts.article-1', DRAFT)
    echo.emit(
      [{documentId: 'drafts.article-1', transition: 'disappear', mutations: [{delete: {id: 'drafts.article-1'}}]}],
      'tx-1',
    )
    expect(echo.revisionOf('drafts.article-1')).toBeUndefined()
  })
})

/* ══════════════════════════════════════════════════════ §18 action plans */

describe('planActions — §18.4 edit', () => {
  it('plans a patch against the draft and names the published base to clone from', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {id: 'drafts.article-1', ifRevisionID: 'x', set: {title: 'b'}},
      },
    ])
    expect(plan.plans).toEqual([
      {
        documentId: 'drafts.article-1',
        transition: 'update',
        patch: {set: {title: 'b'}},
        cloneFrom: 'article-1',
      },
    ])
    expect(plan.commits).toEqual([
      {kind: 'actions', payload: [expect.objectContaining({actionType: 'sanity.action.document.edit'})]},
    ])
    expect(plan.unsupported).toEqual([])
  })

  it('reports an edit with no target instead of silently dropping it', () => {
    const echo = makeEcho()
    const plan = echo.planActions([{actionType: 'sanity.action.document.edit'}])
    expect(plan.plans).toEqual([])
    expect(plan.unsupported.join(' ')).toMatch(/no target id/)
  })
})

describe('planActions — §18.5 publish', () => {
  it('copies the draft into published FIRST, then removes the draft', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.publish',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
      },
    ])
    expect(plan.plans).toEqual([
      {documentId: 'article-1', transition: 'update', copyFrom: 'drafts.article-1'},
      {
        documentId: 'drafts.article-1',
        transition: 'disappear',
        mutations: [{delete: {id: 'drafts.article-1'}}],
      },
    ])
    expect(plan.commits[0]?.kind).toBe('documentActions')
  })

  it('derives the draft id when the action omits it', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {actionType: 'sanity.action.document.publish', publishedId: 'article-1'},
    ])
    expect(plan.plans[1]?.documentId).toBe('drafts.article-1')
  })
})

describe('planActions — §18.6 unpublish', () => {
  it('stores the draft BEFORE removing published, as §18.6 requires', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.unpublish',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
      },
    ])
    expect(plan.plans.map((entry) => [entry.documentId, entry.transition])).toEqual([
      ['drafts.article-1', 'appear'],
      ['article-1', 'disappear'],
    ])
    expect(plan.plans[0]?.copyFrom).toBe('article-1')
  })
})

describe('planActions — §18.7 discard draft', () => {
  it.each([
    'sanity.action.document.discard',
    'sanity.action.document.version.discard',
  ])('removes only the draft for %s', (actionType) => {
    const echo = makeEcho()
    const plan = echo.planActions([{actionType, draftId: 'drafts.article-1'}])
    expect(plan.plans).toEqual([
      {
        documentId: 'drafts.article-1',
        transition: 'disappear',
        mutations: [{delete: {id: 'drafts.article-1'}}],
      },
    ])
  })
})

describe('planActions — §18.8 delete and restore', () => {
  it('tombstones every draft Studio names, plus published', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {
        actionType: 'sanity.action.document.delete',
        publishedId: 'article-1',
        includeDrafts: ['drafts.article-1'],
      },
    ])
    expect(plan.plans.map((entry) => entry.documentId)).toEqual(['drafts.article-1', 'article-1'])
    expect(plan.plans.every((entry) => entry.transition === 'disappear')).toBe(true)
  })

  it('does not invent a draft frame for a draft Studio did not name', () => {
    const echo = makeEcho()
    const plan = echo.planActions([
      {actionType: 'sanity.action.document.delete', publishedId: 'article-1'},
    ])
    expect(plan.plans.map((entry) => entry.documentId)).toEqual(['article-1'])
  })

  it('restores a deleted document with one createOrReplace, not create + replace', () => {
    const echo = makeEcho()
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
    expect(plan.plans[0]?.documentId).toBe('drafts.article-1')
    expect(plan.plans[0]?.mutations?.[0]).toHaveProperty('createOrReplace')
  })
})

describe('planWrite — §18.9 duplicate', () => {
  it('recognises Studio duplicate by its tag and names the source document', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    const copy = {_id: 'drafts.new-id', _type: 'article', _rev: 'lake-rev-1', title: 'Article 1'}
    const plan = echo.planWrite('create', copy, {tag: 'document.duplicate'})
    expect(plan.commits).toEqual([
      {
        kind: 'documentActions',
        payload: [
          {
            actionType: 'sanity.overlay.document.duplicate',
            publishedId: 'article-1',
            newId: 'new-id',
            attributes: copy,
          },
        ],
      },
    ])
  })

  it('treats an untagged create as an ordinary create', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    const copy = {_id: 'drafts.new-id', _type: 'article', _rev: 'lake-rev-1'}
    const plan = echo.planWrite('create', copy)
    expect(plan.commits[0]?.kind).toBe('mutations')
  })

  it('does not match a synthetic revision as a duplicate source', () => {
    const echo = makeEcho()
    echo.seedFromResult(PUBLISHED, true)
    echo.emit([{documentId: 'article-1', transition: 'update', patch: {set: {a: 1}}}], 'tx-1')
    const copy = {_id: 'drafts.new-id', _type: 'article', _rev: 'tx-1'}
    const plan = echo.planWrite('create', copy, {tag: 'document.duplicate'})
    expect(plan.commits[0]?.kind).toBe('mutations')
  })
})

describe('planWrite / planMutations — the raw client surface', () => {
  it('groups a mutation array by document', () => {
    const echo = makeEcho()
    const plan = echo.planMutations({
      mutations: [
        {patch: {id: 'a', set: {x: 1}}},
        {patch: {id: 'a', set: {y: 2}}},
        {delete: {id: 'b'}},
      ],
    })
    expect(plan.plans.map((entry) => entry.documentId)).toEqual(['a', 'b'])
    expect(plan.plans[0]?.mutations).toHaveLength(2)
    expect(plan.commits[0]?.kind).toBe('mutations')
  })

  it('reports delete-by-query as unsupported rather than guessing', () => {
    const echo = makeEcho()
    const plan = echo.planWrite('delete', {query: '*[_type=="article"]'})
    expect(plan.plans).toEqual([])
    expect(plan.commits).toEqual([])
    expect(plan.unsupported.join(' ')).toMatch(/query/)
  })

  it('reports an unknown write method as unsupported', () => {
    const echo = makeEcho()
    expect(echo.planWrite('somethingNew', {}).unsupported).toEqual(['somethingNew'])
  })
})

describe('nextTransactionId', () => {
  it('never repeats', () => {
    const echo = makeEcho()
    const ids = new Set(Array.from({length: 1000}, () => echo.nextTransactionId()))
    expect(ids.size).toBe(1000)
  })
})

describe('emit does nothing at all once logged out', () => {
  it('leaves no revision behind that the next session would have to chain from', () => {
    const echo = makeEcho()
    echo.seedFromResult(DRAFT, true)
    echo.logout()
    const frames = echo.emit(
      [{documentId: 'drafts.article-1', transition: 'update', patch: {set: {a: 1}}}],
      'tx-1',
    )
    expect(frames).toEqual([])
    expect(echo.revisionOf('drafts.article-1')).toBe('lake-draft-1')
  })
})

describe('onEmit hook', () => {
  it('reports every delivered frame with the subscriber count for the banner', () => {
    const onEmit = vi.fn()
    const echo = makeEcho({onEmit})
    echo.seedFromResult(DRAFT, true)
    collect(echo, ['drafts.article-1'])
    echo.emit([{documentId: 'drafts.article-1', transition: 'update', patch: {set: {a: 1}}}], 'tx-1')
    expect(onEmit).toHaveBeenCalledTimes(1)
    expect(onEmit.mock.calls[0][1]).toBe(1)
  })
})
