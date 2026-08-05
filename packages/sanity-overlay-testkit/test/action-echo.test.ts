/**
 * SPIKE A — document-action echo (PRD §18.4-§18.9, §21.4.1, Gate A breadth).
 *
 * The gap this closes: publish, unpublish, delete, discard, duplicate and restore
 * were *blocked* by the facade but never *echoed*, so Studio's save/publish state
 * never settled for them — `write-block-validation.md` records the publish button
 * going dead with `handled: false`.
 *
 * Two seams are exercised, and neither needs a browser:
 *
 * 1. `echoProtocol.ts` — the pure listener protocol extracted out of
 *    `localEcho.ts`: the revision store, the subscriber registry, the plan →
 *    listener-frame builder, and the intercepted-write planner. Everything the
 *    browser does to Studio's pair listener happens here, so it can be pinned in
 *    Node against the shapes captured in `listener-event-shapes.md`.
 *
 * 2. `overlayServer.mjs` + `overlayTranslate.ts` — persistence. A document action
 *    must survive a reload exactly like an edit does, and it must do so by
 *    running `sanity-overlay-core`'s own §18.4-§18.9 reducers rather than by
 *    reimplementing their semantics in the spike.
 *
 * Assertion discipline: persistence claims are read back off the filesystem or
 * from a *restarted* server, never from the response body of the write that made
 * the claim.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import {
  createEchoProtocol,
  type EchoMutationEvent,
  type EchoProtocol,
} from '../../../examples/kitchen-sink/spikeA/echoProtocol'
import {translateDocumentActions} from '../../../examples/kitchen-sink/spikeA/overlayTranslate'
import {startOverlayServer} from '../../../examples/kitchen-sink/spikeA/overlayServer.mjs'

/**
 * Per-test budget for the §3 persistence block (ms).
 *
 * Those tests are not waiting on a duration — they do real work: each one boots
 * an overlay server, drives two or three HTTP round-trips through it, and then
 * boots a SECOND server to re-read the result off disk, because the assertion
 * discipline at the top of this file forbids believing the response body of the
 * write that made the claim.
 *
 * Measured on this repo (vitest default `testTimeout` is 5 s):
 *
 *   publish (first test in the block, so it also pays the one-off cost of the
 *   first `fetch`, the first `listen` and the first store write)
 *     - idle full-suite run          4.00 s
 *     - full-suite run, CPU-loaded   median 4.03 s, max 5.65 s
 *     - observed failure             1 of 6 idle full-suite runs, "Test timed
 *                                    out in 5000ms" at 5.40 s
 *
 * So the default budget sits inside the normal spread of this test's honest
 * runtime, and the whole repository shares one worker pool — a full-suite run is
 * exactly when it loses. The only failure mode a larger budget hides is "the
 * machine was busy", which is not a claim this file makes. Every assertion is
 * unchanged; nothing here is timing-sensitive once it is allowed to finish.
 *
 * 30 s is ~5x the worst runtime ever measured. `hookTimeout` matches because
 * `afterEach` closes the servers and recursively removes the temp roots.
 */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'spike-a-actions-00000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

type Rec = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * Fixtures — exactly the payloads sanity 6.8.0 puts on the wire
 * ------------------------------------------------------------------ *
 *
 * Extracted from `node_modules/sanity/lib/datastores-*.js` (`serverOperationImpls`)
 * at the pinned version. Each helper below is one Studio document action.
 */

const PUBLISHED_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

const DRAFT_ARTICLE = {
  _id: 'drafts.article-1',
  _type: 'article',
  _rev: 'lake-draft-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-02T00:00:00.000Z',
  title: 'Article 1 (edited)',
}

const PAIR_IDS = ['article-1', 'drafts.article-1'] as const

/**
 * The revision an overlay document is expected to be at, by counter only.
 *
 * `_rev` is `overlay.<counter>.<content hash>`. The **counter** is the claim these
 * tests make — it says how many revisions the action produced, so an action that
 * silently applied twice, or that rewrote a perspective it should not have
 * touched, fails here. The **hash** is a property of the canonical serializer in
 * `sanity-overlay-core`, which these tests do not exercise and must not pin:
 * doing so would turn every legitimate serializer change (key order, unicode
 * normalisation) into six opaque failures in an integration suite that has no
 * opinion about hashing. The hashes were verified to reproduce exactly at the
 * time of writing; they are deliberately not asserted.
 */
function OVERLAY_REV(counter: number): unknown {
  return expect.stringMatching(new RegExp(`^overlay\\.${counter}\\.[0-9a-f]{12}$`))
}

function publishAction(): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.publish',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      ifPublishedRevisionId: 'lake-rev-1',
    },
  ]
}

function unpublishAction(): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.unpublish',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
    },
  ]
}

function deleteAction(includeDrafts: string[] = ['drafts.article-1']): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.delete',
      includeDrafts,
      publishedId: 'article-1',
    },
  ]
}

function discardAction(): unknown[] {
  return [{actionType: 'sanity.action.document.discard', draftId: 'drafts.article-1'}]
}

/** Studio's history restore: `replaceDraft` carrying the whole restored body. */
function restoreAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.replaceDraft',
      publishedId: 'article-1',
      attributes: {_id: 'drafts.article-1', _type: 'article', title},
    },
  ]
}

/** Restore of a fully deleted document: a guarded create, then the replaceDraft. */
function restoreFromDeletedAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.create',
      publishedId: 'article-1',
      attributes: {_id: 'drafts.article-1', _type: 'article', title},
      ifExists: 'fail',
    },
    ...restoreAction(title),
  ]
}

/**
 * Studio's duplicate is not an Actions API call at all — it is
 * `client.observable.create({...source, _id: 'drafts.<new>'}, {tag: 'document.duplicate'})`,
 * and it keeps the source's `_rev` (only `_createdAt`, `_updatedAt` and `_system`
 * are omitted). That surviving `_rev` is how the echo layer identifies the source.
 */
function duplicateBody(): Rec {
  return {
    _id: 'drafts.article-copy',
    _type: 'article',
    _rev: DRAFT_ARTICLE._rev,
    title: DRAFT_ARTICLE.title,
  }
}

/* ------------------------------------------------------------------ *
 * Protocol harness
 * ------------------------------------------------------------------ */

interface Pane {
  frames: EchoMutationEvent[]
  unsubscribe(): void
}

/** A protocol seeded exactly the way the pair listener's snapshot fetch seeds it. */
function seededProtocol(documents: Rec[] = [PUBLISHED_ARTICLE, DRAFT_ARTICLE]): EchoProtocol {
  let tick = 0
  const protocol = createEchoProtocol({now: () => Date.UTC(2026, 0, 1) + (tick += 1000)})
  protocol.seedFromResult(documents, true)
  return protocol
}

/** A document pane: one pair-listener subscription over `[published, draft]`. */
function openPane(protocol: EchoProtocol, ids: readonly string[] = PAIR_IDS): Pane {
  const frames: EchoMutationEvent[] = []
  const subscription = protocol.subscribe(ids, (event) => frames.push(event))
  return {frames, unsubscribe: () => subscription.unsubscribe()}
}

/** Plan and emit one intercepted `client.action(...)` call, as `localEcho` does. */
function runActions(
  protocol: EchoProtocol,
  payload: unknown[],
  transactionId = 'tx-studio-1',
): ReturnType<EchoProtocol['planActions']> {
  const plan = protocol.planActions(payload)
  protocol.emit(plan.plans, transactionId)
  return plan
}

/* ------------------------------------------------------------------ *
 * Server harness
 * ------------------------------------------------------------------ */

const roots: string[] = []
const running: Array<{close: () => Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spike-a-actions-'))
  roots.push(root)
  return root
}

interface Booted {
  url: string
  close(): Promise<void>
}

async function boot(root: string): Promise<Booted> {
  let tick = 0
  const server = (await startOverlayServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))).toISOString(),
  })) as Booted
  running.push(server)
  return server
}

async function postCommit(
  server: Booted,
  body: Rec,
): Promise<{status: number; json: Record<string, any>}> {
  const response = await fetch(`${server.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {status: response.status, json: (await response.json()) as Record<string, any>}
}

async function getState(server: Booted): Promise<Record<string, any>> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  return (await response.json()) as Record<string, any>
}

/** The document as a *restarted* server reads it back off disk. */
async function reread(root: string, logicalId: string): Promise<Record<string, any> | undefined> {
  const server = await boot(root)
  const state = await getState(server)
  return (state.documents as Record<string, any>[]).find((doc) => doc.logicalId === logicalId)
}

async function readIntentRaw(root: string, logicalId: string): Promise<Record<string, any>> {
  const path = join(root, '.sanity-overlay', 'documents', logicalId, 'intent.json')
  return parse(await readFile(path, 'utf8')) as Record<string, any>
}

/** Seed the overlay with an edited draft, so publish has something to promote. */
async function commitEdit(server: Booted, title: string, key = 'seed-edit'): Promise<void> {
  const {json} = await postCommit(server, {
    idempotencyKey: key,
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {set: {title}},
      },
    ],
    baseDocuments: [PUBLISHED_ARTICLE],
  })
  expect(json.committed).toBe(true)
}

/* ================================================================== *
 * 1. Listener frames — what Studio's pair listener receives
 * ================================================================== */

describe('document-action echo — publish (PRD §18.5)', () => {
  it('emits a published createOrReplace and a draft disappear in one transaction', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol)

    runActions(protocol, publishAction(), 'tx-publish')

    expect(pane.frames).toHaveLength(2)
    const [published, draft] = pane.frames as [EchoMutationEvent, EchoMutationEvent]

    /* §18.5 order: the draft is copied into published *before* it is removed, so a
     * pane that applies the frames in order is never momentarily contentless. */
    expect(published.documentId).toBe('article-1')
    expect(published.transition).toBe('update')
    expect(published.mutations).toEqual([
      {createOrReplace: {_id: 'article-1', _type: 'article', title: 'Article 1 (edited)'}},
    ])

    expect(draft.documentId).toBe('drafts.article-1')
    expect(draft.transition).toBe('disappear')
    expect(draft.mutations).toEqual([{delete: {id: 'drafts.article-1'}}])

    /* One Studio transaction id across both frames — `consumeUnresolved` matches
     * on it, and a second id would leave the pane unsaved forever. */
    expect(published.transactionId).toBe('tx-publish')
    expect(draft.transactionId).toBe('tx-publish')
    expect(published.resultRev).toBe('tx-publish')
    expect(draft.resultRev).toBe('tx-publish')
  })

  it('chains each frame off that document’s own previous revision', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol)

    runActions(protocol, publishAction(), 'tx-publish')

    expect(pane.frames[0]?.previousRev).toBe(PUBLISHED_ARTICLE._rev)
    expect(pane.frames[1]?.previousRev).toBe(DRAFT_ARTICLE._rev)
  })

  it('counts transaction events per subscriber, not per transaction', () => {
    const protocol = seededProtocol()
    const pair = openPane(protocol, PAIR_IDS)
    /* A pane opened on the draft alone (a reference pane, or a second tab looking
     * at the draft) matches ONE of the two frames. Telling it to expect two would
     * park the event in `sequentializeListenerEvents`' buffer until the deadline. */
    const draftOnly = openPane(protocol, ['drafts.article-1'])

    runActions(protocol, publishAction(), 'tx-publish')

    expect(pair.frames.map((f) => [f.transactionCurrentEvent, f.transactionTotalEvents])).toEqual([
      [1, 2],
      [2, 2],
    ])
    expect(draftOnly.frames).toHaveLength(1)
    expect([
      draftOnly.frames[0]?.transactionCurrentEvent,
      draftOnly.frames[0]?.transactionTotalEvents,
    ]).toEqual([1, 1])
  })

  it('appears rather than updates when nothing is published yet', () => {
    const protocol = seededProtocol([DRAFT_ARTICLE])
    const pane = openPane(protocol)

    runActions(protocol, publishAction(), 'tx-publish')

    const published = pane.frames.find((frame) => frame.documentId === 'article-1')
    expect(published?.transition).toBe('appear')
    /* A missing document has base revision `undefined`; the key must be ABSENT,
     * not present-and-undefined, or the chain comparison never matches. */
    expect(published && 'previousRev' in published).toBe(false)
  })

  it('routes the write to the overlay as a document action, not a mutation', () => {
    const protocol = seededProtocol()
    const plan = protocol.planActions(publishAction())

    expect(plan.unsupported).toEqual([])
    expect(plan.commits).toEqual([{kind: 'documentActions', payload: publishAction()}])
  })
})

describe('document-action echo — unpublish (PRD §18.6)', () => {
  it('stores the draft before removing the published document', () => {
    const protocol = seededProtocol([PUBLISHED_ARTICLE])
    const pane = openPane(protocol)

    runActions(protocol, unpublishAction(), 'tx-unpublish')

    expect(pane.frames).toHaveLength(2)
    const [draft, published] = pane.frames as [EchoMutationEvent, EchoMutationEvent]

    /* §18.6 "[MUST] Remove local published state only after the draft is safely
     * stored" — the frame order is that rule, made observable. */
    expect(draft.documentId).toBe('drafts.article-1')
    expect(draft.transition).toBe('appear')
    expect(draft.mutations).toEqual([
      {createOrReplace: {_id: 'drafts.article-1', _type: 'article', title: 'Article 1'}},
    ])

    expect(published.documentId).toBe('article-1')
    expect(published.transition).toBe('disappear')
    expect(published.mutations).toEqual([{delete: {id: 'article-1'}}])
  })

  it('routes the write to the overlay as a document action', () => {
    const protocol = seededProtocol([PUBLISHED_ARTICLE])
    expect(protocol.planActions(unpublishAction()).commits).toEqual([
      {kind: 'documentActions', payload: unpublishAction()},
    ])
  })
})

describe('document-action echo — delete (PRD §18.8)', () => {
  it('disappears both perspectives in one transaction', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol)

    runActions(protocol, deleteAction(), 'tx-delete')

    expect(pane.frames.map((frame) => [frame.documentId, frame.transition])).toEqual([
      ['drafts.article-1', 'disappear'],
      ['article-1', 'disappear'],
    ])
    expect(pane.frames.every((frame) => frame.transactionTotalEvents === 2)).toBe(true)
  })

  it('disappears only the published document when Studio reports no draft', () => {
    const protocol = seededProtocol([PUBLISHED_ARTICLE])
    const pane = openPane(protocol)

    runActions(protocol, deleteAction([]), 'tx-delete')

    expect(pane.frames.map((frame) => frame.documentId)).toEqual(['article-1'])
    expect(pane.frames[0]?.transactionTotalEvents).toBe(1)
  })

  it('clears the revision it knew for a disappeared document', () => {
    const protocol = seededProtocol()
    runActions(protocol, deleteAction(), 'tx-delete')

    expect(protocol.revisionOf('article-1')).toBeUndefined()
    expect(protocol.revisionOf('drafts.article-1')).toBeUndefined()
  })
})

describe('document-action echo — discard draft (PRD §18.7)', () => {
  it('disappears the draft and leaves the published document alone', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol)

    runActions(protocol, discardAction(), 'tx-discard')

    expect(pane.frames).toHaveLength(1)
    expect(pane.frames[0]?.documentId).toBe('drafts.article-1')
    expect(pane.frames[0]?.transition).toBe('disappear')
    expect(protocol.revisionOf('article-1')).toBe(PUBLISHED_ARTICLE._rev)
  })

  it('routes the write as a document action rather than a delete mutation', () => {
    const protocol = seededProtocol()
    expect(protocol.planActions(discardAction()).commits).toEqual([
      {kind: 'documentActions', payload: discardAction()},
    ])
  })
})

describe('document-action echo — duplicate (PRD §18.9)', () => {
  it('echoes the new draft as an appear, from the intercepted create call', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol, ['drafts.article-copy'])

    const plan = protocol.planWrite('create', duplicateBody(), {tag: 'document.duplicate'})
    protocol.emit(plan.plans, 'tx-duplicate')

    expect(pane.frames).toHaveLength(1)
    expect(pane.frames[0]?.documentId).toBe('drafts.article-copy')
    expect(pane.frames[0]?.transition).toBe('appear')
    expect(pane.frames[0]?.mutations).toEqual([{createOrReplace: duplicateBody()}])
  })

  it('identifies the duplication source by the `_rev` the copy carries', () => {
    const protocol = seededProtocol()
    const plan = protocol.planWrite('create', duplicateBody(), {tag: 'document.duplicate'})

    expect(plan.commits).toEqual([
      {
        kind: 'documentActions',
        payload: [
          {
            actionType: 'sanity.overlay.document.duplicate',
            publishedId: 'article-1',
            newId: 'article-copy',
            attributes: duplicateBody(),
          },
        ],
      },
    ])
  })

  it('falls back to a plain create when the source revision is unknown', () => {
    const protocol = seededProtocol()
    const orphan = {...duplicateBody(), _rev: 'a-revision-nobody-has-seen'}

    const plan = protocol.planWrite('create', orphan, {tag: 'document.duplicate'})

    expect(plan.commits).toEqual([{kind: 'mutations', payload: [{create: orphan}]}])
    expect(plan.plans).toHaveLength(1)
  })
})

describe('document-action echo — restore (PRD §18.8)', () => {
  it('echoes replaceDraft as a full draft replacement', () => {
    const protocol = seededProtocol()
    const pane = openPane(protocol)

    runActions(protocol, restoreAction('Restored title'), 'tx-restore')

    expect(pane.frames).toHaveLength(1)
    expect(pane.frames[0]?.documentId).toBe('drafts.article-1')
    expect(pane.frames[0]?.transition).toBe('update')
    expect(pane.frames[0]?.mutations).toEqual([
      {
        createOrReplace: {_id: 'drafts.article-1', _type: 'article', title: 'Restored title'},
      },
    ])
  })

  it('appears the draft when restoring a document that was deleted', () => {
    const protocol = seededProtocol([PUBLISHED_ARTICLE])
    const pane = openPane(protocol)

    runActions(protocol, restoreFromDeletedAction('Back from the dead'), 'tx-restore')

    expect(pane.frames).toHaveLength(1)
    expect(pane.frames[0]?.transition).toBe('appear')
    expect(pane.frames[0]).not.toHaveProperty('previousRev')
  })

  it('routes replaceDraft as a document action carrying the restored body', () => {
    const protocol = seededProtocol()
    expect(protocol.planActions(restoreAction('Restored title')).commits).toEqual([
      {kind: 'documentActions', payload: restoreAction('Restored title')},
    ])
  })
})

/* ================================================================== *
 * 2. Translation — Studio wire payload → core §18 reducer steps
 * ================================================================== */

describe('translateDocumentActions (PRD §18.4-§18.9)', () => {
  it('maps every Studio document action onto a core reducer step', () => {
    expect(translateDocumentActions(publishAction()).steps).toEqual([
      {type: 'publish', id: 'article-1'},
    ])
    expect(translateDocumentActions(unpublishAction()).steps).toEqual([
      {type: 'unpublish', id: 'article-1'},
    ])
    expect(translateDocumentActions(deleteAction()).steps).toEqual([
      {type: 'delete', id: 'article-1'},
    ])
    expect(translateDocumentActions(discardAction()).steps).toEqual([
      {type: 'discardDraft', id: 'article-1'},
    ])
  })

  it('maps replaceDraft onto a restore carrying the restored body', () => {
    expect(translateDocumentActions(restoreAction('Restored')).steps).toEqual([
      {
        type: 'restore',
        id: 'article-1',
        target: 'draft',
        document: {_id: 'drafts.article-1', _type: 'article', title: 'Restored'},
      },
    ])
  })

  it('maps the synthetic duplicate action onto core duplicate', () => {
    expect(
      translateDocumentActions([
        {
          actionType: 'sanity.overlay.document.duplicate',
          publishedId: 'article-1',
          newId: 'article-copy',
          attributes: duplicateBody(),
        },
      ]).steps,
    ).toEqual([{type: 'duplicate', id: 'article-1', newId: 'article-copy'}])
  })

  it('reports an action it cannot map instead of dropping it', () => {
    const result = translateDocumentActions([{actionType: 'sanity.action.document.edit'}])
    expect(result.steps).toEqual([])
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]).toContain('sanity.action.document.edit')
  })
})

/* ================================================================== *
 * 3. Persistence — the action must survive a reload, via core's reducers
 * ================================================================== */

describe('document actions persist through the overlay server', () => {
  it('publishes: the edited draft becomes local published and the draft is gone', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Published body')

    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session:publish-1',
      kind: 'documentActions',
      payload: publishAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ok: true, committed: true})

    /* Read back through a *restarted* server: the claim is about disk. */
    const stored = await reread(root, 'article-1')
    expect(stored?.draft).toBeNull()
    expect(stored?.published).toEqual({
      _createdAt: '2025-12-01T00:00:00.000Z',
      _id: 'article-1',
      _rev: OVERLAY_REV(2),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:09.000Z',
      title: 'Published body',
    })

    const intent = await readIntentRaw(root, 'article-1')
    expect(intent.logicalId).toBe('article-1')
  })

  it('unpublishes: the published document becomes a draft and is tombstoned', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Will be unpublished')
    await postCommit(server, {
      idempotencyKey: 'session:publish-1',
      kind: 'documentActions',
      payload: publishAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })

    const {json} = await postCommit(server, {
      idempotencyKey: 'session:unpublish-1',
      kind: 'documentActions',
      payload: unpublishAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const stored = await reread(root, 'article-1')
    expect(stored?.publishedTombstone).toBe(true)
    expect(stored?.published).toBeNull()
    expect(stored?.draft).toEqual({
      _createdAt: '2025-12-01T00:00:00.000Z',
      _id: 'drafts.article-1',
      _rev: OVERLAY_REV(3),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:14.000Z',
      title: 'Will be unpublished',
    })
  })

  it('discards the draft without touching local published', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Promoted')
    await postCommit(server, {
      idempotencyKey: 'session:publish-1',
      kind: 'documentActions',
      payload: publishAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    await commitEdit(server, 'Draft to throw away', 'seed-edit-2')

    const {json} = await postCommit(server, {
      idempotencyKey: 'session:discard-1',
      kind: 'documentActions',
      payload: discardAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const stored = await reread(root, 'article-1')
    expect(stored?.draft).toBeNull()
    expect(stored?.published).toEqual({
      _createdAt: '2025-12-01T00:00:00.000Z',
      _id: 'article-1',
      _rev: OVERLAY_REV(2),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:09.000Z',
      title: 'Promoted',
    })
  })

  it('deletes: both perspectives are tombstoned and the record survives', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Doomed')

    const {json} = await postCommit(server, {
      idempotencyKey: 'session:delete-1',
      kind: 'documentActions',
      payload: deleteAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const stored = await reread(root, 'article-1')
    expect(stored?.draftTombstone).toBe(true)
    expect(stored?.publishedTombstone).toBe(true)
    /* §18.8 "[MUST] Preserve record metadata for diff, recovery, and promotion". */
    expect(await readIntentRaw(root, 'article-1')).toMatchObject({logicalId: 'article-1'})
  })

  it('restores a deleted document by clearing the tombstone and rewriting the draft', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Doomed')
    await postCommit(server, {
      idempotencyKey: 'session:delete-1',
      kind: 'documentActions',
      payload: deleteAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    })

    const {json} = await postCommit(server, {
      idempotencyKey: 'session:restore-1',
      kind: 'documentActions',
      payload: restoreAction('Recovered'),
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const stored = await reread(root, 'article-1')
    expect(stored?.draftTombstone).toBe(false)
    expect(stored?.draft).toEqual({
      _createdAt: '2025-12-01T00:00:00.000Z',
      _id: 'drafts.article-1',
      _rev: OVERLAY_REV(4),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:19.000Z',
      title: 'Recovered',
    })
  })

  it('duplicates a document into a new logical id', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Original')

    const {json} = await postCommit(server, {
      idempotencyKey: 'session:duplicate-1',
      kind: 'documentActions',
      payload: [
        {
          actionType: 'sanity.overlay.document.duplicate',
          publishedId: 'article-1',
          newId: 'article-copy',
          attributes: duplicateBody(),
        },
      ],
      baseDocuments: [PUBLISHED_ARTICLE],
    })
    expect(json).toMatchObject({ok: true, committed: true})

    const copy = await reread(root, 'article-copy')
    expect(copy?.draft).toEqual({
      _createdAt: '2026-01-01T00:00:09.000Z',
      _id: 'drafts.article-copy',
      _rev: OVERLAY_REV(2),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:10.000Z',
      title: 'Original',
    })
    /* §18.9 "[MUST] Remove base revision metadata" — the copy must not inherit
     * the source's Content Lake revision. */
    expect(copy?.draft?._rev).not.toBe(PUBLISHED_ARTICLE._rev)

    const original = await reread(root, 'article-1')
    expect(original?.draft).toEqual({
      _createdAt: '2025-12-01T00:00:00.000Z',
      _id: 'drafts.article-1',
      _rev: OVERLAY_REV(1),
      _type: 'article',
      _updatedAt: '2026-01-01T00:00:04.000Z',
      title: 'Original',
    })
  })

  it('replays a repeated document-action key instead of applying it twice', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commitEdit(server, 'Once')

    const body = {
      idempotencyKey: 'session:publish-replay',
      kind: 'documentActions',
      payload: publishAction(),
      baseDocuments: [PUBLISHED_ARTICLE],
    }
    const first = await postCommit(server, body)
    const second = await postCommit(server, body)

    expect(first.json).toMatchObject({committed: true})
    expect(second.json).toMatchObject({replayed: true})
    expect(second.json.revision).toBe(first.json.revision)
  })

  it('reports a document action it cannot apply rather than answering ok', async () => {
    const server = await boot(await makeRoot())

    /* Nothing has ever been edited, so there is no draft to publish. Core raises
     * OVERLAY_DOCUMENT_NOT_FOUND; the browser must hear about it, because Studio
     * has already been told the publish succeeded otherwise. */
    const {status, json} = await postCommit(server, {
      idempotencyKey: 'session:publish-nothing',
      kind: 'documentActions',
      payload: publishAction(),
      baseDocuments: [],
    })

    expect(status).toBeGreaterThanOrEqual(400)
    expect(json.ok).toBe(false)
    expect(String(json.error?.message)).toContain('article-1')
  })
})
