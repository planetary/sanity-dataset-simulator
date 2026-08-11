/**
 * PRD §21.4.1 — the listener compatibility matrix, automated.
 *
 * `gate-review.md` records Gate B as PARTIAL because the §21.4.1 five-criterion
 * matrix existed only as ad-hoc browser observation. This file is the automated
 * half. The five criteria are quoted verbatim from PRD §21.4.1:
 *
 *   1. Save state reaches a stable committed state after every supported action.
 *   2. No lost keystrokes, duplicate patches, cursor jumps, or stale pane state
 *      occur in the E2E fixture.
 *   3. Reconnect produces the current head without replaying an already
 *      committed mutation.
 *   4. Unsubscription stops updates and releases resources.
 *   5. Event payloads are documented as a version-pinned compatibility contract.
 *
 * WHAT CAN AND CANNOT BE PROVEN HERE
 * Criteria 1, 3, 4 and 5 are protocol properties and are fully decided in Node
 * against `echoProtocol.ts` — the pure seam `localEcho.ts` delegates to. Criterion
 * 2 splits: the *protocol* half (no duplicate patches, no stale pane, no dropped
 * or reordered patch) is decided here; the *input-device* half (cursor jumps,
 * keystrokes lost inside Portable Text) is a browser property and stays a human
 * check — see `listener-matrix.md`.
 *
 * ORACLE DISCIPLINE
 * Every convergence claim is settled by `Pane`, a deliberately independent
 * re-implementation of the rules `@sanity/mutator`'s `Document`/`BufferedDocument`
 * enforce (chain check, create-first-when-missing, `_rev = resultRev`). Asserting
 * that the emitter's own bookkeeping agrees with itself would prove nothing.
 */
import {createRequire} from 'node:module'
import {describe, expect, it, vi} from 'vitest'
import {
  createEchoProtocol,
  type EchoMutationEvent,
  type EchoProtocol,
} from '../../../examples/kitchen-sink/spikeA/echoProtocol'
import {
  createOverlayEcho,
  type OverlayEcho,
  type OverlayMutationEvent,
} from '../../sanity-overlay-studio/src/client/echo'

type Rec = Record<string, unknown>

/** The versions §21.4.1 pins the contract to (`listener-event-shapes.md`). */
const PINNED = {sanity: '6.8.0', client: '7.26.0'} as const

const PUBLISHED = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

const DRAFT = {
  _id: 'drafts.article-1',
  _type: 'article',
  _rev: 'lake-draft-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-02T00:00:00.000Z',
  title: 'Article 1 draft',
}

const PAIR_IDS = ['article-1', 'drafts.article-1'] as const

function protocolWith(documents: Rec[] = [PUBLISHED, DRAFT]): EchoProtocol {
  let tick = 0
  const protocol = createEchoProtocol({now: () => Date.UTC(2026, 0, 1) + (tick += 1000)})
  protocol.seedFromResult(documents, true)
  return protocol
}

function editAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      patch: {set: {title}},
    },
  ]
}

/* ------------------------------------------------------------------ *
 * The oracle: an independent pane, applying @sanity/mutator's rules
 * ------------------------------------------------------------------ */

class ChainBreak extends Error {}

/**
 * One document pane's local HEAD, fed only by listener frames.
 *
 * Deliberately re-derived from `@sanity/mutator`'s documented behaviour rather
 * than shared with the emitter:
 *  - `Document.considerIncoming` refuses a mutation whose `previousRev` does not
 *    equal HEAD's `_rev`;
 *  - a missing document only accepts a create-shaped FIRST mutation;
 *  - `Mutation.apply` stamps `_rev = resultRev`.
 */
class Pane {
  readonly seen: EchoMutationEvent[] = []
  readonly documents = new Map<string, Rec | null>()
  readonly transactions: string[] = []

  constructor(snapshot: Rec[]) {
    for (const document of snapshot) this.documents.set(document._id as string, {...document})
  }

  head(id: string): Rec | null {
    return this.documents.get(id) ?? null
  }

  rev(id: string): string | undefined {
    return this.head(id)?._rev as string | undefined
  }

  apply(event: EchoMutationEvent): void {
    this.seen.push(event)
    if (!this.transactions.includes(event.transactionId)) {
      this.transactions.push(event.transactionId)
    }

    const current = this.head(event.documentId)
    const expected = current?._rev as string | undefined
    if (event.previousRev !== expected) {
      throw new ChainBreak(
        `chain break on ${event.documentId}: frame expects ${String(
          event.previousRev,
        )} but HEAD is ${String(expected)}`,
      )
    }

    let document = current === null ? null : {...current}
    for (const [index, mutation] of event.mutations.entries()) {
      const [kind] = Object.keys(mutation)
      if (document === null && index === 0 && !String(kind).startsWith('create')) {
        throw new ChainBreak(
          `${event.documentId} is missing but the first mutation is ${String(kind)}`,
        )
      }
      document = applyMutation(document, mutation)
    }

    if (document === null) this.documents.set(event.documentId, null)
    else this.documents.set(event.documentId, {...document, _rev: event.resultRev})
  }
}

function applyMutation(document: Rec | null, mutation: Rec): Rec | null {
  if (mutation.createOrReplace) return {...(mutation.createOrReplace as Rec)}
  if (mutation.createIfNotExists) {
    return document ?? {...(mutation.createIfNotExists as Rec)}
  }
  if (mutation.create) return {...(mutation.create as Rec)}
  if (mutation.delete) return null
  if (mutation.patch) {
    const patch = mutation.patch as Rec
    const next = {...(document ?? {})}
    for (const [path, value] of Object.entries((patch.set as Rec) ?? {})) next[path] = value
    for (const path of (patch.unset as string[]) ?? []) delete next[path]
    return next
  }
  throw new Error(`the pane oracle cannot apply ${JSON.stringify(Object.keys(mutation))}`)
}

/** Wire a pane to the protocol the way `getPairListener` wires Studio's. */
function connect(
  protocol: EchoProtocol,
  pane: Pane,
  ids: readonly string[] = PAIR_IDS,
): {unsubscribe: () => void} {
  return protocol.subscribe(ids, (event) => pane.apply(event))
}

/**
 * Every supported action, as one table, so criterion 1 covers all of them
 * instead of whichever one is convenient.
 */
const SUPPORTED_ACTIONS: Array<{
  name: string
  snapshot: Rec[]
  run: (protocol: EchoProtocol, transactionId: string) => void
}> = [
  {
    name: 'edit',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) => protocol.emit(protocol.planActions(editAction('Edited')).plans, tx),
  },
  {
    name: 'publish',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planActions([
          {
            actionType: 'sanity.action.document.publish',
            draftId: 'drafts.article-1',
            publishedId: 'article-1',
          },
        ]).plans,
        tx,
      ),
  },
  {
    name: 'unpublish',
    snapshot: [PUBLISHED],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planActions([
          {
            actionType: 'sanity.action.document.unpublish',
            draftId: 'drafts.article-1',
            publishedId: 'article-1',
          },
        ]).plans,
        tx,
      ),
  },
  {
    name: 'discard',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planActions([
          {actionType: 'sanity.action.document.discard', draftId: 'drafts.article-1'},
        ]).plans,
        tx,
      ),
  },
  {
    name: 'delete',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planActions([
          {
            actionType: 'sanity.action.document.delete',
            includeDrafts: ['drafts.article-1'],
            publishedId: 'article-1',
          },
        ]).plans,
        tx,
      ),
  },
  {
    name: 'restore',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planActions([
          {
            actionType: 'sanity.action.document.replaceDraft',
            publishedId: 'article-1',
            attributes: {_id: 'drafts.article-1', _type: 'article', title: 'Restored'},
          },
        ]).plans,
        tx,
      ),
  },
  {
    name: 'duplicate',
    snapshot: [PUBLISHED, DRAFT],
    run: (protocol, tx) =>
      protocol.emit(
        protocol.planWrite(
          'create',
          {_id: 'drafts.article-copy', _type: 'article', _rev: DRAFT._rev, title: 'Copy'},
          {tag: 'document.duplicate'},
        ).plans,
        tx,
      ),
  },
]

/* ================================================================== *
 * Criterion 1 — "Save state reaches a stable committed state after
 *                every supported action."
 * ================================================================== */

describe('§21.4.1 criterion 1 — save state settles after every supported action', () => {
  for (const action of SUPPORTED_ACTIONS) {
    it(`settles after ${action.name}`, () => {
      const protocol = protocolWith(action.snapshot)
      const pane = new Pane(action.snapshot)
      connect(protocol, pane, [...PAIR_IDS, 'drafts.article-copy'])

      action.run(protocol, 'tx-studio-settle')

      expect(pane.seen.length).toBeGreaterThan(0)
      /* `BufferedDocument.consumeUnresolved` matches on the transaction id Studio
       * generated and passed in. A different id leaves the pane "unsaved" forever
       * — the exact failure `write-block-validation.md` recorded for publish. */
      expect(pane.transactions).toEqual(['tx-studio-settle'])
      for (const frame of pane.seen) expect(frame.resultRev).toBe('tx-studio-settle')

      /* Committed state is *stable*: the pane's own HEAD revision now equals the
       * revision the protocol believes is head, for every surviving document. */
      for (const [id, document] of pane.documents) {
        expect(protocol.revisionOf(id)).toBe(document === null ? undefined : document._rev)
      }
    })
  }

  it('reports a transaction as fully delivered before it is treated as committed', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    protocol.emit(
      protocol.planActions([
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ]).plans,
      'tx-publish',
    )

    /* `allPendingTransactionEventsReceived` groups by transactionId and requires
     * `mutations.length === transactionTotalEvents`. A miscount parks the pane. */
    const grouped = pane.seen.filter((frame) => frame.transactionId === 'tx-publish')
    expect(grouped).toHaveLength(grouped[0]!.transactionTotalEvents)
    expect(grouped.map((frame) => frame.transactionCurrentEvent)).toEqual([1, 2])
  })
})

/* ================================================================== *
 * Criterion 2 — "No lost keystrokes, duplicate patches, cursor jumps,
 *                or stale pane state occur in the E2E fixture."
 * ================================================================== */

describe('§21.4.1 criterion 2 — no duplicate patches, no lost or stale patches', () => {
  it('keeps previousRev → resultRev unbroken across a sequence of mutations', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    const titles = ['One', 'Two', 'Three', 'Four', 'Five']
    titles.forEach((title, index) => {
      protocol.emit(protocol.planActions(editAction(title)).plans, `tx-${index}`)
    })

    /* The oracle throws on any break, so surviving the loop is itself the claim;
     * this pins the shape of the chain so a silent re-seed cannot hide in it. */
    const draftFrames = pane.seen.filter((frame) => frame.documentId === 'drafts.article-1')
    expect(draftFrames).toHaveLength(titles.length)
    expect(draftFrames[0]?.previousRev).toBe(DRAFT._rev)
    for (let index = 1; index < draftFrames.length; index += 1) {
      expect(draftFrames[index]?.previousRev).toBe(draftFrames[index - 1]?.resultRev)
    }
    expect(pane.head('drafts.article-1')).toMatchObject({title: 'Five', _rev: 'tx-4'})
  })

  it('never delivers the same transaction twice', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    const plan = protocol.planActions(editAction('Typed once'))
    protocol.emit(plan.plans, 'tx-once')
    /* A second subscribe of the same observable, or a retried commit, must not
     * become a second frame: `Mutation.apply` would then run twice and the chain
     * would break on the third edit. */
    protocol.emit(plan.plans, 'tx-once')

    expect(pane.seen).toHaveLength(1)
    expect(pane.head('drafts.article-1')).toMatchObject({title: 'Typed once'})
  })

  it('delivers a burst of edits in submission order, losing none', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    const burst = ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg']
    burst.forEach((title, index) => {
      protocol.emit(protocol.planActions(editAction(title)).plans, `burst-${index}`)
    })

    expect(pane.transactions).toEqual(burst.map((_, index) => `burst-${index}`))
    expect(pane.head('drafts.article-1')).toMatchObject({title: 'abcdefg'})
  })

  it('does not leave a pane stale after a document action', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    protocol.emit(protocol.planActions(editAction('Ready to ship')).plans, 'tx-edit')
    /* The echo layer never materializes an edit itself — it forwards patches and
     * lets the pane apply them. The body a publish promotes therefore comes back
     * from the overlay server's `/commit` response, which is the only party that
     * ran the patch through core. This call is that round-trip. */
    protocol.setOverlayDocument('drafts.article-1', {
      _id: 'drafts.article-1',
      _type: 'article',
      title: 'Ready to ship',
    })

    protocol.emit(
      protocol.planActions([
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ]).plans,
      'tx-publish',
    )

    /* Stale pane state = the published pane still showing the pre-publish body,
     * or the draft pane still showing a draft that no longer exists. */
    expect(pane.head('article-1')).toMatchObject({title: 'Ready to ship'})
    expect(pane.head('drafts.article-1')).toBeNull()
  })

  it('reports loudly rather than silently publishing a stale body', () => {
    /* The other side of the round-trip above: with `SPIKE_OVERLAY_PERSIST` off
     * nobody materialized the edit, so the only body the echo layer holds is the
     * pre-edit snapshot. Publishing it would show the user a *successful* publish
     * of content they never wrote — the one failure this spike must never hide. */
    const errors: string[] = []
    const protocol = createEchoProtocol({onError: (message) => errors.push(message)})
    protocol.seedFromResult([PUBLISHED, DRAFT], true)
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    protocol.emit(protocol.planActions(editAction('Never materialized')).plans, 'tx-edit')
    protocol.emit(
      protocol.planActions([
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ]).plans,
      'tx-publish',
    )

    expect(errors.join('\n')).toContain('drafts.article-1')
    /* Still emitted: a pane that never settles is worse than a reported one. */
    expect(pane.head('article-1')).not.toBeNull()
  })
})

/* ================================================================== *
 * Criterion 3 — "Reconnect produces the current head without replaying
 *                an already committed mutation."
 * ================================================================== */

describe('§21.4.1 criterion 3 — reconnect converges on the current head', () => {
  it('chains from the revision the reconnect snapshot reports', () => {
    const protocol = protocolWith()
    const before = new Pane([PUBLISHED, DRAFT])
    const connection = connect(protocol, before)

    protocol.emit(protocol.planActions(editAction('Before the drop')).plans, 'tx-before')
    connection.unsubscribe()

    /* The stream dropped. On reconnect Studio re-runs the pair snapshot fetch,
     * which is the only authoritative reseed of the revision store. Another
     * writer moved the document on while we were away. */
    const reconnected = {...DRAFT, _rev: 'lake-draft-rev-9', title: 'Changed elsewhere'}
    protocol.seedFromResult([PUBLISHED, reconnected], true)

    const after = new Pane([PUBLISHED, reconnected])
    connect(protocol, after)
    protocol.emit(protocol.planActions(editAction('After the drop')).plans, 'tx-after')

    expect(after.seen).toHaveLength(1)
    expect(after.seen[0]?.previousRev).toBe('lake-draft-rev-9')
    expect(after.head('drafts.article-1')).toMatchObject({
      title: 'After the drop',
      _rev: 'tx-after',
    })
  })

  it('does not replay a mutation the pane already committed', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    const connection = connect(protocol, pane)

    const plan = protocol.planActions(editAction('Committed before the drop'))
    protocol.emit(plan.plans, 'tx-committed')
    connection.unsubscribe()

    const resumed = new Pane([...pane.documents.values()].filter(Boolean) as Rec[])
    connect(protocol, resumed)
    /* A resume that re-sent the already committed transaction would break the
     * chain on the *next* edit, because HEAD is already at its resultRev. */
    protocol.emit(plan.plans, 'tx-committed')

    expect(resumed.seen).toEqual([])
    protocol.emit(protocol.planActions(editAction('After resume')).plans, 'tx-resume')
    expect(resumed.seen).toHaveLength(1)
    expect(resumed.seen[0]?.previousRev).toBe('tx-committed')
  })

  it('converges on the current head after an auth drop and a token refresh', () => {
    /* The reconnect Gate A actually cares about: the stream did not just drop,
     * it 401'd. `spike-a-auth-flows.test.ts` owns what that does to the write
     * path; what belongs to criterion 3 is that the *listener* still converges
     * afterwards, and converges on the head — not on a replay. */
    const protocol = protocolWith()
    const before = new Pane([PUBLISHED, DRAFT])
    const connection = connect(protocol, before)

    const committed = protocol.planActions(editAction('Committed before the 401'))
    protocol.emit(committed.plans, 'tx-before-401')

    protocol.noteAuthFailure({status: 401, source: 'listener'})
    connection.unsubscribe()
    expect(protocol.sessionState()).toBe('unauthenticated')

    /* Studio refreshes the token, reopens the pair listener and re-runs the
     * snapshot fetch. Somebody else published in the meantime. */
    protocol.restoreSession()
    const head = {...DRAFT, _rev: 'lake-draft-rev-42', title: 'Moved on while we were away'}
    protocol.seedFromResult([PUBLISHED, head], true)

    const after = new Pane([PUBLISHED, head])
    connect(protocol, after)
    /* The already-committed transaction is re-offered, exactly as a replaying
     * transport would. It must not become a second frame. */
    protocol.emit(committed.plans, 'tx-before-401')
    expect(after.seen).toEqual([])

    protocol.emit(protocol.planActions(editAction('After the refresh')).plans, 'tx-after-401')
    expect(after.seen).toHaveLength(1)
    expect(after.seen[0]?.previousRev).toBe('lake-draft-rev-42')
    expect(after.head('drafts.article-1')).toMatchObject({
      title: 'After the refresh',
      _rev: 'tx-after-401',
    })
  })

  it('does not reconnect a pane at all once the session is logged out', () => {
    /* The failure this rules out: Studio tears the session down, some pane's
     * retry loop reopens a subscription, and the echo layer keeps feeding
     * synthetic frames into a logged-out editor. */
    const protocol = protocolWith()
    connect(protocol, new Pane([PUBLISHED, DRAFT]))

    protocol.logout()

    const reconnected = new Pane([PUBLISHED, DRAFT])
    connect(protocol, reconnected)
    protocol.emit(protocol.planActions(editAction('After logout')).plans, 'tx-after-logout')

    expect(protocol.subscriberCount()).toBe(0)
    expect(reconnected.seen).toEqual([])
    /* And the head the next session would reconnect to is still the real one. */
    expect(protocol.revisionOf('drafts.article-1')).toBe(DRAFT._rev)
  })

  it('lets an upstream mutation event reseed the chain without a snapshot fetch', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    connect(protocol, pane)

    /* A change from another client arrives on the real upstream stream. The echo
     * layer tees it so its own next frame chains off the new revision instead of
     * the one it last synthesised. */
    protocol.observeUpstreamEvent({
      type: 'mutation',
      documentId: 'drafts.article-1',
      resultRev: 'other-client-rev',
      identity: 'someone-else',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    protocol.emit(protocol.planActions(editAction('Ours')).plans, 'tx-ours')

    expect(pane.seen[0]?.previousRev).toBe('other-client-rev')
  })
})

/* ================================================================== *
 * Criterion 4 — "Unsubscription stops updates and releases resources."
 * ================================================================== */

describe('§21.4.1 criterion 4 — unsubscribe stops updates and releases resources', () => {
  it('stops delivering to an unsubscribed pane', () => {
    const protocol = protocolWith()
    const pane = new Pane([PUBLISHED, DRAFT])
    const connection = connect(protocol, pane)

    protocol.emit(protocol.planActions(editAction('Delivered')).plans, 'tx-1')
    connection.unsubscribe()
    protocol.emit(protocol.planActions(editAction('Not delivered')).plans, 'tx-2')

    expect(pane.seen).toHaveLength(1)
    expect(pane.head('drafts.article-1')).toMatchObject({title: 'Delivered'})
  })

  it('releases the subscription so a closed pane cannot be retained', () => {
    const protocol = protocolWith()
    expect(protocol.subscriberCount()).toBe(0)

    const first = connect(protocol, new Pane([PUBLISHED, DRAFT]))
    const second = connect(protocol, new Pane([PUBLISHED, DRAFT]))
    expect(protocol.subscriberCount()).toBe(2)

    first.unsubscribe()
    expect(protocol.subscriberCount()).toBe(1)
    second.unsubscribe()
    expect(protocol.subscriberCount()).toBe(0)
  })

  it('is idempotent — unsubscribing twice does not release someone else’s pane', () => {
    const protocol = protocolWith()
    const survivor = new Pane([PUBLISHED, DRAFT])
    const closing = connect(protocol, new Pane([PUBLISHED, DRAFT]))
    connect(protocol, survivor)

    closing.unsubscribe()
    closing.unsubscribe()

    expect(protocol.subscriberCount()).toBe(1)
    protocol.emit(protocol.planActions(editAction('Still live')).plans, 'tx-1')
    expect(survivor.seen).toHaveLength(1)
  })
})

/* ================================================================== *
 * Criterion 5 — "Event payloads are documented as a version-pinned
 *                compatibility contract."
 * ================================================================== */

describe('§21.4.1 criterion 5 — event payloads match the version-pinned contract', () => {
  /** Exactly the fields captured from sanity 6.8.0 in listener-event-shapes.md. */
  const REQUIRED_KEYS = [
    'type',
    'eventId',
    'documentId',
    'transactionId',
    'transition',
    'identity',
    'mutations',
    'resultRev',
    'timestamp',
    'visibility',
    'transactionCurrentEvent',
    'transactionTotalEvents',
    'projection',
  ] as const

  const OPTIONAL_KEYS = ['previousRev'] as const

  it('pins the Studio and client versions the contract was captured against', () => {
    expect(createEchoProtocol().contractVersions()).toEqual(PINNED)
  })

  for (const action of SUPPORTED_ACTIONS) {
    it(`every ${action.name} frame conforms to the pinned payload shape`, () => {
      const protocol = protocolWith(action.snapshot)
      const frames: EchoMutationEvent[] = []
      protocol.subscribe([...PAIR_IDS, 'drafts.article-copy'], (event) => frames.push(event))

      action.run(protocol, 'tx-contract')

      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        for (const key of REQUIRED_KEYS) expect(frame).toHaveProperty(key)
        const extra = Object.keys(frame).filter(
          (key) =>
            !(REQUIRED_KEYS as readonly string[]).includes(key) &&
            !(OPTIONAL_KEYS as readonly string[]).includes(key),
        )
        expect(extra).toEqual([])

        expect(frame.type).toBe('mutation')
        expect(frame.visibility).toBe('transaction')
        expect(frame.identity).toBe('local-echo')
        expect(frame.projection).toBeNull()
        expect(frame.eventId).toBe(`${frame.transactionId}#${frame.documentId}@local`)
        expect(Array.isArray(frame.mutations)).toBe(true)
        expect(frame.mutations.length).toBeGreaterThan(0)
        expect(['update', 'appear', 'disappear']).toContain(frame.transition)
        expect(Number.isInteger(frame.transactionCurrentEvent)).toBe(true)
        expect(frame.transactionCurrentEvent).toBeLessThanOrEqual(frame.transactionTotalEvents)
        expect(Date.parse(frame.timestamp)).not.toBeNaN()
      }
    })
  }

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * THIS TEST USED TO ASSERT THE OPPOSITE, AND THE REASON IT GAVE WAS FALSE.
   *
   * It read:
   *
   *     it('omits `effects` — only the global preview listener consumes
   *        mendoza', …)
   *         expect(frames[0]).not.toHaveProperty('effects')
   *
   * The premise — "only the global preview listener consumes mendoza" — is
   * contradicted by `sanity@6.8.0` in three separate places, all of them fed by
   * the PAIR listener, i.e. by exactly the channel these frames are merged into
   * (`client/facade.ts` `wrapListen`, which only attaches a local channel to
   * `*[_id in $ids]`):
   *
   *   1. lib/datastores-DqFH7RLd.js:1676 — `getPairListener` itself subscribes
   *      with `effectFormat: "mendoza"`, so EVERY real pair frame carries
   *      `effects`. The omission was ours alone.
   *   2. lib/index.js:5688 — `getRemoteTransactionsSubscription`'s
   *      `onMutationReceived` reads `remoteMutation.effects.apply` /
   *      `.revert` unguarded. `remoteMutation` reaches it through
   *      `bufferedDocument.onRemoteMutation` (datastores:1462), which copies
   *      `mutation.effects` off the `@sanity/mutator` `Mutation` built from the
   *      raw frame (datastores:1486, `new Mutation(mutationEvent)`). A frame
   *      with no `effects` therefore throws
   *      `TypeError: Cannot read properties of undefined (reading 'apply')`
   *      on every draft edit — `apply` there is a MENDOZA PATCH PROPERTY, not
   *      `Function.prototype.apply`.
   *   3. lib/datastores-DqFH7RLd.js:6821 → :6859 — the history/timeline
   *      `Aligner` does `applyPatch(state.attrs, evt.effects.apply)` on the
   *      same `remoteSnapshots` stream. It both throws on a missing `effects`
   *      AND reconstructs revision content from `apply`, so an EMPTY patch
   *      would silently rebuild the pre-edit body.
   *
   * The `sanity/lib/index.js:5682` guard that used to make this look harmless
   * (`variant !== documentVariantType → return`) does not save us: `version` is
   * stamped downstream by `setVersion("draft")` (datastores:1740, applied in
   * `checkoutPair` at :1888), so a draft frame always matches a draft pane.
   *
   * The replacement asserts the contract against the SHIPPED echo
   * (`sanity-overlay-studio/src/client/echo.ts`), which is the frame source a
   * real Studio consumes. The spike protocol this file otherwise exercises is
   * PRD §0.6 evidence code that no Studio imports.
   */
  it('does NOT omit `effects` — the pair listener is a mendoza consumer', () => {
    const echo = studioEcho([PUBLISHED, DRAFT])
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(echo.planActions(editAction('Now with effects')).plans, 'tx-1')

    expect(frames[0]).toHaveProperty('effects')
    expect(Array.isArray(frames[0]?.effects.apply)).toBe(true)
    expect(Array.isArray(frames[0]?.effects.revert)).toBe(true)
  })

  it('moves the timestamp forward even when the clock does not', () => {
    /* `Document.considerIncoming` drops an incoming mutation whose timestamp
     * predates HEAD._updatedAt, so a frozen or backwards clock silently loses
     * edits rather than failing loudly. */
    const protocol = createEchoProtocol({now: () => Date.UTC(2020, 0, 1)})
    protocol.seedFromResult([PUBLISHED, DRAFT], true)
    const frames: EchoMutationEvent[] = []
    protocol.subscribe(PAIR_IDS, (event) => frames.push(event))

    protocol.emit(protocol.planActions(editAction('One')).plans, 'tx-1')
    protocol.emit(protocol.planActions(editAction('Two')).plans, 'tx-2')

    expect(Date.parse(frames[1]!.timestamp)).toBeGreaterThan(Date.parse(frames[0]!.timestamp))
    expect(Date.parse(frames[0]!.timestamp)).toBeGreaterThan(Date.parse(DRAFT._updatedAt))
  })
})

/* ================================================================== *
 * Two panes / two tabs — the breadth item gate-review.md names
 * ================================================================== */

describe('§21.4.1 two-pane and two-tab convergence', () => {
  it('converges two independent subscribers on the same document', () => {
    const protocol = protocolWith()
    const paneA = new Pane([PUBLISHED, DRAFT])
    const paneB = new Pane([PUBLISHED, DRAFT])
    connect(protocol, paneA)
    connect(protocol, paneB)

    protocol.emit(protocol.planActions(editAction('Typed in tab A')).plans, 'tx-1')
    protocol.emit(protocol.planActions(editAction('Typed in tab B')).plans, 'tx-2')

    expect(paneA.head('drafts.article-1')).toEqual(paneB.head('drafts.article-1'))
    expect(paneA.head('drafts.article-1')).toMatchObject({
      title: 'Typed in tab B',
      _rev: 'tx-2',
    })
  })

  it('converges a pane opened mid-session with one that was there from the start', () => {
    const protocol = protocolWith()
    const early = new Pane([PUBLISHED, DRAFT])
    connect(protocol, early)
    protocol.emit(protocol.planActions(editAction('First')).plans, 'tx-1')

    /* A second tab opens: it runs its own pair snapshot fetch, which in the echo
     * topology returns the *stale* Content Lake document, so the fetch must NOT
     * be allowed to reset the synthetic revision — that is what the
     * `authoritative` flag guards. */
    protocol.seedFromResult([PUBLISHED, DRAFT], false)
    const late = new Pane([{...DRAFT, title: 'First', _rev: 'tx-1'}])
    connect(protocol, late)

    protocol.emit(protocol.planActions(editAction('Second')).plans, 'tx-2')

    expect(late.head('drafts.article-1')).toEqual(early.head('drafts.article-1'))
  })

  it('delivers a document action to both panes with per-pane event counts', () => {
    const protocol = protocolWith()
    const pair = new Pane([PUBLISHED, DRAFT])
    const publishedOnly = new Pane([PUBLISHED])
    connect(protocol, pair, PAIR_IDS)
    connect(protocol, publishedOnly, ['article-1'])

    protocol.emit(
      protocol.planActions([
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ]).plans,
      'tx-publish',
    )

    expect(pair.seen).toHaveLength(2)
    expect(publishedOnly.seen).toHaveLength(1)
    expect(publishedOnly.seen[0]?.transactionTotalEvents).toBe(1)
    expect(pair.head('article-1')).toEqual(publishedOnly.head('article-1'))
  })

  it('does not let one pane’s error stop delivery to another', () => {
    const protocol = protocolWith()
    const healthy = new Pane([PUBLISHED, DRAFT])
    protocol.subscribe(PAIR_IDS, () => {
      throw new Error('this pane blew up')
    })
    connect(protocol, healthy)

    protocol.emit(protocol.planActions(editAction('Delivered anyway')).plans, 'tx-1')

    expect(healthy.head('drafts.article-1')).toMatchObject({title: 'Delivered anyway'})
  })
})

/* ══════════════════════════════════════════════════════════════════════════ *
 * THE MENDOZA `effects` CONTRACT — driven against sanity 6.8.0's own readers
 *
 * WHY THIS BLOCK TARGETS THE SHIPPED ECHO AND NOT THE SPIKE
 * `client/facade.ts` `wrapListen` merges `createOverlayEcho`'s frames into the
 * observable `client.observable.listen('*[_id in $ids]', …)` returns — i.e. the
 * PAIR listener, upstream of `dedupeListenerEvents` and of every consumer cited
 * below. The spike protocol the rest of this file exercises is §0.6 evidence
 * code nothing imports at runtime.
 *
 * ORACLE DISCIPLINE
 * Nothing here re-derives what the echo computed. The two oracles are foreign
 * libraries resolved THROUGH the pinned `sanity@6.8.0`, so they are the exact
 * copies the Studio under test runs:
 *   - `mendoza@3.0.8` `applyPatch` decides what a patch MEANS;
 *   - `@sanity/mutator@6.8.0` `Mutation` decides what the frame's own
 *     `mutations` DO.
 * A frame is truthful exactly when those two independent answers agree. An
 * empty `{apply: [], revert: []}` cannot satisfy that: `applyPatch(doc, [])` is
 * a verified no-op, so it would claim the document did not change.
 * ══════════════════════════════════════════════════════════════════════════ */

const kitchenSinkRequire = createRequire(
  new URL('../../../examples/kitchen-sink/package.json', import.meta.url),
)
const sanityRequire = createRequire(kitchenSinkRequire.resolve('sanity'))

const {applyPatch: applyMendozaPatch} = sanityRequire('mendoza') as {
  applyPatch: (left: unknown, patch: readonly unknown[]) => unknown
}

interface MutatorMutation {
  apply(document: Rec | null): Rec | null
}
const {Mutation} = sanityRequire('@sanity/mutator') as {
  Mutation: new (params: Rec) => MutatorMutation
}

/* ---- sanity 6.8.0, transcribed verbatim with line references ------------ */

/** `lib/useBundleDocuments-BYW8M9LS.js:4956` */
function isDeletePatch(patch: readonly unknown[]): boolean {
  return patch[0] === 0 && patch[1] === null
}

/** `lib/useBundleDocuments-BYW8M9LS.js:4952` */
function getEffectState(effect?: {apply: readonly unknown[]; revert: readonly unknown[]}): string {
  const modified = Boolean(effect)
  const deleted = effect && isDeletePatch(effect.apply)
  const created = effect && isDeletePatch(effect.revert)
  return deleted ? 'deleted' : created ? 'created' : modified ? 'modified' : 'noop'
}

/**
 * `lib/index.js:5678-5696` — `getRemoteTransactionsSubscription`'s
 * `onMutationReceived`, the function whose `remoteMutation.effects.apply` read
 * is the reported TypeError. `version` is what `setVersion(…)` stamps
 * downstream (datastores:1740), supplied here as `checkoutPair` supplies it.
 */
function onMutationReceived(
  remoteMutation: {version: string; effects?: {apply: unknown[]; revert: unknown[]}},
  options: {documentVariantType: string; isLiveEdit: boolean},
): {refetched: boolean; effectState?: string} {
  const variant = remoteMutation.version
  if (variant !== options.documentVariantType) return {refetched: false}
  if (variant === 'published' && !options.isLiveEdit) return {refetched: true}
  const effectState = getEffectState({
    apply: remoteMutation.effects!.apply,
    revert: remoteMutation.effects!.revert,
  })
  if (effectState === 'created' || effectState === 'deleted') return {refetched: true, effectState}
  return {refetched: false, effectState}
}

/** `lib/datastores-DqFH7RLd.js:6859` — the history/timeline `Aligner._apply`. */
function alignerApply(attrs: Rec | null, frame: OverlayMutationEvent): unknown {
  return applyMendozaPatch(attrs, frame.effects.apply)
}

/** Every `applyPatch` call site in sanity strips `_rev` first (`omitRev`). */
function omitRev(document: Rec | null): Rec | null {
  if (document === null) return null
  const {_rev: _ignored, ...rest} = document
  return rest
}

/* ---- the shipped echo, wired the way `facade.ts` wires it --------------- */

function studioEcho(snapshot: Rec[], overrides: Rec = {}): OverlayEcho {
  let tick = 0
  const echo = createOverlayEcho({
    now: () => Date.UTC(2026, 0, 1) + (tick += 1000),
    ...overrides,
  })
  echo.seedFromResult(snapshot, true)
  return echo
}

function studioFrames(echo: OverlayEcho, ids: readonly string[]): OverlayMutationEvent[] {
  const frames: OverlayMutationEvent[] = []
  echo.subscribe(ids, (event) => {
    if (event.type === 'mutation') frames.push(event)
  })
  return frames
}

const GUARD_FIELD = '_empty_action_guard_pseudo_field_'

describe('listener frames carry mendoza `effects` that sanity 6.8.0 can read', () => {
  it('no longer throws in `onMutationReceived` on an ordinary draft edit', () => {
    const echo = studioEcho([PUBLISHED, DRAFT])
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(echo.planActions(editAction('Typed')).plans, 'tx-1')

    /* The reported defect, reproduced through sanity's own function. */
    expect(() =>
      onMutationReceived(
        {...frames[0]!, version: 'draft'},
        {documentVariantType: 'draft', isLiveEdit: false},
      ),
    ).not.toThrow()
  })

  it('describes an edit exactly as @sanity/mutator applies it — mendoza is the oracle', () => {
    const echo = studioEcho([PUBLISHED, DRAFT])
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(echo.planActions(editAction('Typed into the pane')).plans, 'tx-1')
    const frame = frames[0]!

    /* ORACLE A — what the pane will hold: the REAL mutator applying the
     * frame's OWN mutations to the REAL HEAD the pane opened with. */
    const applied = new Mutation({
      mutations: frame.mutations,
      transactionId: frame.transactionId,
      resultRev: frame.resultRev,
      previousRev: frame.previousRev,
      timestamp: frame.timestamp,
    }).apply({...DRAFT})

    /* ORACLE B — what the frame's `effects` CLAIM, decoded by real mendoza. */
    const claimed = alignerApply(omitRev({...DRAFT}), frame)

    expect(claimed).toEqual(omitRev(applied))
    /* And the claim is not vacuous: it must actually carry the new title. */
    expect(claimed).toMatchObject({title: 'Typed into the pane'})
    expect(claimed).not.toHaveProperty(GUARD_FIELD)
  })

  it('classifies an edit as `modified` — not created, not deleted', () => {
    const echo = studioEcho([PUBLISHED, DRAFT])
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(echo.planActions(editAction('Still just an edit')).plans, 'tx-1')

    expect(getEffectState(frames[0]!.effects)).toBe('modified')
    expect(
      onMutationReceived(
        {...frames[0]!, version: 'draft'},
        {documentVariantType: 'draft', isLiveEdit: false},
      ),
    ).toEqual({refetched: false, effectState: 'modified'})
  })

  it('classifies a branch-created draft as `created`, so the events panel refetches', () => {
    /*
     * THE CASE `{apply: [], revert: []}` GETS WRONG. An empty effect reports
     * `modified` for a document that did not exist a moment ago, so
     * `onMutationReceived` never calls `onRefetch()` and the events panel never
     * learns the version appeared (lib/index.js:5691-5694).
     */
    const echo = studioEcho([])
    const body: Rec = {
      _id: 'drafts.branch-only',
      _type: 'article',
      _createdAt: '2026-01-01T00:00:00.000Z',
      title: 'Born on the branch',
    }
    echo.setOverlayDocument('drafts.branch-only', body)
    const frames = studioFrames(echo, ['drafts.branch-only'])

    echo.emit(
      echo.planActions([
        {actionType: 'sanity.action.document.create', attributes: body},
      ]).plans,
      'tx-create',
    )

    const frame = frames[0]!
    expect(frame.transition).toBe('appear')
    expect(getEffectState(frame.effects)).toBe('created')
    expect(frame.effects.revert).toEqual([0, null])
    /* Applying it to a missing document must reconstruct the body — exactly
     * what `isVersionCreateTransaction` relies on
     * (lib/useBundleDocuments-BYW8M9LS.js:11202). */
    expect(alignerApply(null, frame)).toMatchObject({
      _id: 'drafts.branch-only',
      title: 'Born on the branch',
    })
  })

  it('classifies the draft side of a publish as `deleted`', () => {
    const echo = studioEcho([PUBLISHED, DRAFT])
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(
      echo.planActions([
        {
          actionType: 'sanity.action.document.publish',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
        },
      ]).plans,
      'tx-publish',
    )

    const draftFrame = frames.find((frame) => frame.documentId === 'drafts.article-1')!
    expect(draftFrame.transition).toBe('disappear')
    expect(draftFrame.effects.apply).toEqual([0, null])
    expect(getEffectState(draftFrame.effects)).toBe('deleted')
    expect(alignerApply({...DRAFT}, draftFrame)).toBeNull()

    /* The published side is a content transition, and it must state the body
     * the draft carried — a publish claiming "nothing changed" would leave the
     * history timeline showing the pre-publish published document. */
    const publishedFrame = frames.find((frame) => frame.documentId === 'article-1')!
    expect(getEffectState(publishedFrame.effects)).toBe('modified')
    expect(alignerApply(omitRev({...PUBLISHED}), publishedFrame)).toMatchObject({
      _id: 'article-1',
      title: DRAFT.title,
    })
  })

  it('never claims a transition it cannot describe — the fallback is announced', () => {
    /*
     * A patch shape the echo does not fully understand (`insert`,
     * `diffMatchPatch`, an array-selector path) must NOT be spelled as a
     * confident mendoza patch. §5.5 forbids a SILENT approximation, so the
     * floor is an empty patch plus a stated reason — never a fabricated body.
     */
    const onError = vi.fn()
    const echo = studioEcho([PUBLISHED, DRAFT], {onError})
    const frames = studioFrames(echo, PAIR_IDS)

    echo.emit(
      echo.planActions([
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {insert: {after: 'body[-1]', items: [{_type: 'block'}]}},
        },
      ]).plans,
      'tx-insert',
    )

    const frame = frames[0]!
    expect(frame.effects.apply).toEqual([])
    /* Still a legal frame for every other consumer, and still `modified`. */
    expect(getEffectState(frame.effects)).toBe('modified')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('drafts.article-1'))
    expect(onError.mock.calls.map(String).join('\n')).toMatch(/insert/)
  })

  /* ------------------------------------------------------------------ *
   * The bounded applier, pinned op by op against the REAL mutator.
   *
   * The whole risk of stating a body rather than an empty patch is that the
   * body might be WRONG — a wrong body in the history timeline is worse than
   * no body. So every operation the echo claims to understand is decided here
   * by `@sanity/mutator`, never by re-deriving the expected value by hand.
   * ------------------------------------------------------------------ */

  const PATCHABLE: Rec = {
    _id: 'drafts.article-1',
    _type: 'article',
    _rev: 'lake-draft-rev-1',
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-02T00:00:00.000Z',
    title: 'Article 1 draft',
    views: 10,
    meta: {slug: 'article-1', locale: 'en'},
  }

  function frameForPatch(body: Rec, onError?: (message: string) => void): OverlayMutationEvent {
    const echo = studioEcho([PATCHABLE], onError ? {onError} : {})
    const frames = studioFrames(echo, ['drafts.article-1'])
    echo.emit(
      echo.planMutations({mutations: [{patch: {id: 'drafts.article-1', ...body}}]}).plans,
      'tx-patch',
    )
    return frames[0]!
  }

  it.each([
    ['set', {set: {title: 'Renamed'}}],
    ['set on a dotted path', {set: {'meta.slug': 'renamed'}}],
    ['setIfMissing filling a gap', {setIfMissing: {subtitle: 'Added'}}],
    ['setIfMissing leaving a value alone', {setIfMissing: {title: 'MUST NOT WIN'}}],
    ['unset', {unset: ['title']}],
    ['unset on a dotted path', {unset: ['meta.locale']}],
    ['unset of an absent field', {unset: ['absentField']}],
    ['unset of an absent dotted path', {unset: ['meta.absent']}],
    ['inc', {inc: {views: 5}}],
    ['dec', {dec: {views: 3}}],
    ['several ops at once', {set: {title: 'Both'}, unset: ['meta.locale'], inc: {views: 1}}],
  ])('states the same body @sanity/mutator computes for `%s`', (_label, body) => {
    const frame = frameForPatch(body as Rec)

    const applied = new Mutation({
      mutations: frame.mutations,
      transactionId: frame.transactionId,
      resultRev: frame.resultRev,
      previousRev: frame.previousRev,
      timestamp: frame.timestamp,
    }).apply({...PATCHABLE, meta: {...(PATCHABLE.meta as Rec)}})

    expect(alignerApply(omitRev({...PATCHABLE, meta: {...(PATCHABLE.meta as Rec)}}), frame)).toEqual(
      omitRev(applied),
    )
    /* NON-VACUITY: an empty patch would satisfy `toEqual` only if the mutation
     * genuinely changed nothing, and none of these do. */
    expect(frame.effects.apply).not.toEqual([])
  })

  it.each([
    ['insert', {insert: {after: 'body[-1]', items: [{_type: 'block'}]}}],
    ['diffMatchPatch', {diffMatchPatch: {title: '@@ -1,5 +1,5 @@\n-Hello\n+Hullo\n'}}],
    ['an array-selector path', {set: {'body[0].text': 'x'}}],
    ['a keyed-selector path', {set: {'body[_key=="a"].text': 'x'}}],
    ['an unknown operation', {merge: {title: 'x'}}],
    /*
     * FOUND BY THE ORACLE, NOT BY INSPECTION. `@sanity/mutator` throws
     * `Invalid tokens in jsonpath 'nothing-here' @ 7` on a hyphen, so a path
     * this module accepted but the pane's own patcher rejects would have been
     * a confident claim about a patch that cannot even be parsed.
     */
    ['a path the mutator cannot tokenize', {unset: ['nothing-here']}],
    ['a leading-digit segment', {set: {'0bad': 'x'}}],
    ['an empty path', {set: {'': 'x'}}],
  ])('refuses to invent a body for `%s`, and says so', (_label, body) => {
    const onError = vi.fn()
    const frame = frameForPatch(body as Rec, onError)

    expect(frame.effects.apply).toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('drafts.article-1'))
    /* The frame is still delivered, still chains, and still classifies. */
    expect(frame.previousRev).toBe(PATCHABLE._rev)
    expect(frame.mutations.length).toBeGreaterThan(0)
    expect(getEffectState(frame.effects)).toBe('modified')
  })

  it('states `effects` for every frame of every supported action', () => {
    /*
     * THE CLASS. One missing field on one action shape was the whole defect, so
     * the contract is asserted across the action table rather than on an edit.
     */
    const cases: Array<{name: string; run: (echo: OverlayEcho) => void}> = [
      {name: 'edit', run: (echo) => echo.emit(echo.planActions(editAction('E')).plans, 'tx')},
      {
        name: 'publish',
        run: (echo) =>
          echo.emit(
            echo.planActions([
              {
                actionType: 'sanity.action.document.publish',
                draftId: 'drafts.article-1',
                publishedId: 'article-1',
              },
            ]).plans,
            'tx',
          ),
      },
      {
        name: 'unpublish',
        run: (echo) =>
          echo.emit(
            echo.planActions([
              {
                actionType: 'sanity.action.document.unpublish',
                draftId: 'drafts.article-1',
                publishedId: 'article-1',
              },
            ]).plans,
            'tx',
          ),
      },
      {
        name: 'discard',
        run: (echo) =>
          echo.emit(
            echo.planActions([
              {actionType: 'sanity.action.document.discard', draftId: 'drafts.article-1'},
            ]).plans,
            'tx',
          ),
      },
      {
        name: 'delete',
        run: (echo) =>
          echo.emit(
            echo.planActions([
              {
                actionType: 'sanity.action.document.delete',
                publishedId: 'article-1',
                includeDrafts: ['drafts.article-1'],
              },
            ]).plans,
            'tx',
          ),
      },
      {
        name: 'restore',
        run: (echo) =>
          echo.emit(
            echo.planActions([
              {
                actionType: 'sanity.action.document.replaceDraft',
                publishedId: 'article-1',
                attributes: {...DRAFT, title: 'Restored'},
              },
            ]).plans,
            'tx',
          ),
      },
      {
        name: 'raw mutate',
        run: (echo) =>
          echo.emit(
            echo.planMutations({mutations: [{createOrReplace: {...DRAFT, title: 'Raw'}}]}).plans,
            'tx',
          ),
      },
    ]

    for (const testCase of cases) {
      const echo = studioEcho([PUBLISHED, DRAFT])
      const frames = studioFrames(echo, PAIR_IDS)
      testCase.run(echo)

      expect(frames.length, testCase.name).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame, `${testCase.name} / ${frame.documentId}`).toHaveProperty('effects')
        expect(Array.isArray(frame.effects.apply), testCase.name).toBe(true)
        expect(Array.isArray(frame.effects.revert), testCase.name).toBe(true)
        /* `getEffectState` must never see an effect it reads as `noop`: that is
         * the value it returns for a MISSING effect, and it is the one answer
         * no delivered frame can honestly carry. */
        expect(getEffectState(frame.effects), testCase.name).not.toBe('noop')
      }
    }
  })
})
