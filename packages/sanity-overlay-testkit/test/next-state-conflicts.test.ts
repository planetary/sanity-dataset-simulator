/**
 * `GET /state` must report the branch's conflict set (PRD §13.1, §13.3, §17.11,
 * §28.1–§28.3).
 *
 * THE DEFECT THIS FILE PINS
 * Neither overlay server put conflicts on `/state`: they were computed only
 * inside `POST /resolve`. The Studio's `readConflictReport`
 * (`sanity-overlay-studio/src/conflicts.ts:211`) therefore always took its
 * "this overlay API does not report conflicts" branch, and the §28.3 resolution
 * action rendered as a permanently **disabled "Conflict state unknown"**. Core
 * has the whole engine — detection at the commit boundary, persistence on the
 * record, the §13.1 summary, the seven §28.3 actions — and none of it could
 * reach the UI. A built feature, unreachable, with nothing saying so.
 *
 * THREE STATES, NOT TWO
 * §28.1 forbids hiding conflicts, and the sharp edge is that "no conflicts" and
 * "conflicts not computed" are DIFFERENT FACTS. Collapsing the second into a
 * reassuring zero is exactly the hiding the section rules out — and collapsing
 * it the other way makes the button dead forever, which is what happened. The
 * wire shape therefore has to distinguish:
 *
 *   1. CONFLICTS PRESENT      `conflictSummary.total > 0`, and the offending
 *                             documents carry a non-empty `conflicts` array.
 *   2. NO CONFLICTS           `conflictSummary` present and all-zero, every
 *                             document carrying `conflicts: []`.
 *   3. NOT COMPUTED           `conflictSummary` ABSENT and no document carrying
 *                             a `conflicts` array at all.
 *
 * `conflictSummary` is the load-bearing half, and it is top-level rather than
 * per-document on purpose: an overlay with ZERO documents has no per-document
 * field to read, so a documents-only contract makes "empty branch" and "server
 * cannot tell you" indistinguishable — the same bug one level down.
 *
 * A server that computes conflicts must never emit shape 3. These two do, so
 * these tests require shapes 1 and 2 and forbid 3.
 *
 * COST — WHY THIS IS SAFE ON A 5-SECOND POLL
 * Nothing is recomputed. §17.11 makes the COMMIT the detection point: every
 * transaction with a base view re-detects and `persistConflicts` writes the
 * answer onto `record.conflicts`, which the projection already holds and
 * `hydrateState` already reads back from disk at boot. `/state` therefore reads
 * an array it is holding, and the summary is an O(documents) count over those
 * arrays — no merge, no resolve, no I/O. Recomputing here is not merely
 * expensive, it is IMPOSSIBLE and would be wrong to fake: core never fetches
 * base (§16.1) and `/state` carries no `baseDocuments`, so the persisted set is
 * the only honest answer there is.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayApi} from '../../sanity-overlay-next/src/index'
import type {OverlayApi} from '../../sanity-overlay-next/src/index'

type Rec = Record<string, any>

const OVERLAY_ID = 'next-conflict-overlay-00000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const apis: OverlayApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 7, 6, 0, 0, tick)).toISOString()
  }
}

async function boot(): Promise<{api: OverlayApi; root: string}> {
  const root = await mkdtemp(join(tmpdir(), 'next-conflict-'))
  roots.push(root)
  const now = makeClock()
  const api = await createOverlayApi({
    store: new FsOverlayStore({root, now}),
    overlayId: OVERLAY_ID,
    now,
    origins: [STUDIO_ORIGIN],
  })
  apis.push(api)
  return {api, root}
}

const BASE_V1 = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2026-01-01T00:00:00.000Z',
  _updatedAt: '2026-01-02T00:00:00.000Z',
  title: 'Base title',
  editor: 'Ada',
}

/** Upstream moved on the SAME path the branch touched → §17.4 SAME_PATH_CHANGED. */
const BASE_TITLE_MOVED = {...BASE_V1, _rev: 'lake-rev-2', title: 'Upstream title'}

/** Upstream moved only on a path the branch never touched → no conflict. */
const BASE_EDITOR_MOVED = {...BASE_V1, _rev: 'lake-rev-3', editor: 'Grace'}

function edit(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      patch: {set: {title}},
    },
  ]
}

async function commit(api: OverlayApi, body: unknown): Promise<Rec> {
  const response = await api.handle(
    new Request('http://localhost:3998/commit', {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: JSON.stringify(body),
    }),
  )
  return (await response.json()) as Rec
}

async function state(api: OverlayApi): Promise<Rec> {
  const response = await api.handle(
    new Request('http://localhost:3998/state', {headers: {origin: STUDIO_ORIGIN}}),
  )
  expect(response.status).toBe(200)
  return (await response.json()) as Rec
}

/** Reproduce the Studio's own three-way read, so the test is not self-referential. */
function reportShape(body: Rec): 'present' | 'none' | 'not-computed' {
  const documents: Rec[] = Array.isArray(body.documents) ? body.documents : []
  const sawField = documents.some((entry) => Array.isArray(entry.conflicts))
  const summary = body.conflictSummary
  if (summary === undefined && !sawField) return 'not-computed'
  const total =
    summary !== undefined && typeof summary.total === 'number'
      ? summary.total
      : documents.reduce(
          (count, entry) => count + (Array.isArray(entry.conflicts) ? entry.conflicts.length : 0),
          0,
        )
  return total > 0 ? 'present' : 'none'
}

/* ------------------------------------------------------------------ *
 * The three states
 * ------------------------------------------------------------------ */

describe('GET /state distinguishes "no conflicts" from "conflicts not computed"', () => {
  it('an EMPTY overlay says "none", not "not computed"', async () => {
    const {api} = await boot()
    const body = await state(api)
    /* Zero documents means no per-document field exists to read, which is why
     * the top-level summary has to be there. */
    expect(body.documents).toEqual([])
    expect(body.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    expect(reportShape(body)).toBe('none')
  })

  it('a clean branch says "none", with an explicit empty array per document', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })

    const body = await state(api)
    expect(body.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    expect(body.documents).toHaveLength(1)
    /* An EXPLICIT `[]`, not an omission: the array's presence is what tells a
     * client the server computes conflicts at all. */
    expect(body.documents[0].conflicts).toEqual([])
    expect(reportShape(body)).toBe('none')
  })

  it('stays "none" when upstream moves on a path the branch never touched', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })
    await commit(api, {
      idempotencyKey: 'k2',
      kind: 'actions',
      payload: edit('Branch title, again'),
      baseDocuments: [BASE_EDITOR_MOVED],
    })

    const body = await state(api)
    expect(body.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    expect(body.documents[0].conflicts).toEqual([])
  })

  it('reports a real §17.4 conflict, on the document and in the summary', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })
    /* Upstream moved on the touched path; the next commit re-detects (§17.11). */
    const committed = await commit(api, {
      idempotencyKey: 'k2',
      kind: 'actions',
      payload: edit('Branch title, again'),
      baseDocuments: [BASE_TITLE_MOVED],
    })
    expect(committed.committed).toBe(true)

    const body = await state(api)
    expect(reportShape(body)).toBe('present')
    expect(body.conflictSummary.total).toBeGreaterThan(0)
    expect(body.conflictSummary.total).toBe(
      body.conflictSummary.hard + body.conflictSummary.soft,
    )

    const entry = body.documents.find((document: Rec) => document.logicalId === 'article-1')
    expect(entry.conflicts.length).toBeGreaterThan(0)
    const conflict = entry.conflicts[0]
    /* The exact fields `conflictPanelModel` renders — a payload the panel cannot
     * build from is the same dead button in a different costume. */
    expect(typeof conflict.id).toBe('string')
    expect(conflict.documentId).toContain('article-1')
    expect(['soft', 'hard']).toContain(conflict.severity)
    expect(typeof conflict.type).toBe('string')
    expect(typeof conflict.detectedAt).toBe('string')
  })

  it('survives a restart — the conflict is on disk, not in the process', async () => {
    const {api, root} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })
    await commit(api, {
      idempotencyKey: 'k2',
      kind: 'actions',
      payload: edit('Branch title, again'),
      baseDocuments: [BASE_TITLE_MOVED],
    })
    const before = await state(api)
    await api.close()
    apis.splice(apis.indexOf(api), 1)

    const now = makeClock()
    const restarted = await createOverlayApi({
      store: new FsOverlayStore({root, now}),
      overlayId: OVERLAY_ID,
      now,
      origins: [STUDIO_ORIGIN],
    })
    apis.push(restarted)

    const after = await state(restarted)
    /* Pinned against an absolute fact first, so the equality below cannot pass
     * by two `undefined`s agreeing with each other. */
    expect(after.conflictSummary.total).toBeGreaterThan(0)
    expect(after.documents[0].conflicts.length).toBeGreaterThan(0)
    expect(after.conflictSummary).toEqual(before.conflictSummary)
    expect(after.documents[0].conflicts).toEqual(before.documents[0].conflicts)
  })

  it('never emits the "not computed" shape, in any of the states above', async () => {
    const {api} = await boot()
    expect(reportShape(await state(api))).not.toBe('not-computed')
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })
    expect(reportShape(await state(api))).not.toBe('not-computed')
  })
})

/* ------------------------------------------------------------------ *
 * The rest of the branch state the §28.2 list needs
 * ------------------------------------------------------------------ *
 *
 * `sanity-overlay-studio/src/conflicts.ts` `documentFacts` reads six fields off
 * each `/state` document. Three were already there (`logicalId`, `schemaType`,
 * `runtimeRevision`); the base-revision pair was not, so two §28.2 columns
 * rendered blank for the same reason the button was dead — nobody sent them.
 * `origin` and `baseStatus` come with them: §17.2 precedence and §16.4 "base
 * deleted" are facts a reviewer needs on the same screen, and both are already
 * on the record.
 */
describe('GET /state carries the rest of the §28.2 per-document facts', () => {
  it('reports the base revisions the merge ancestor was captured at', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })

    const entry = (await state(api)).documents[0]
    expect(entry.baseRevisionAtFirstTouch).toBe('lake-rev-1')
    expect(entry.currentBaseRevision).toBe('lake-rev-1')
  })

  it('reports origin and base status, so a branch-created document is identifiable', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'mutations',
      payload: [{createOrReplace: {_id: 'new-1', _type: 'article', title: 'branch only'}}],
    })
    await commit(api, {
      idempotencyKey: 'k2',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })

    const body = await state(api)
    const branchCreated = body.documents.find((entry: Rec) => entry.logicalId === 'new-1')
    const fromBase = body.documents.find((entry: Rec) => entry.logicalId === 'article-1')

    expect(branchCreated.origin).toBe('branch')
    expect(branchCreated.baseStatus).toBeNull()
    expect(fromBase.origin).toBe('base')
    expect(fromBase.baseStatus).toBe('present')
  })

  it('omits a base revision it does not have rather than inventing one', async () => {
    /* §5.5: a branch-created document has no merge ancestor, and a plausible
     * placeholder in a reviewer-facing column is exactly the filler the section
     * rules out. The Studio's `documentFacts` already omits an absent field. */
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'mutations',
      payload: [{createOrReplace: {_id: 'new-1', _type: 'article', title: 'branch only'}}],
    })

    const entry = (await state(api)).documents[0]
    expect(entry.baseRevisionAtFirstTouch).toBeUndefined()
    expect(entry.currentBaseRevision).toBeUndefined()
  })

  it('keeps every field the hydration payload already carried', async () => {
    const {api} = await boot()
    await commit(api, {
      idempotencyKey: 'k1',
      kind: 'actions',
      payload: edit('Branch title'),
      baseDocuments: [BASE_V1],
    })

    const entry = (await state(api)).documents[0]
    for (const field of [
      'logicalId',
      'schemaType',
      'runtimeRevision',
      'updatedAt',
      'draftTombstone',
      'publishedTombstone',
      'draft',
      'published',
    ]) {
      expect(entry).toHaveProperty(field)
    }
    expect(entry.draft.title).toBe('Branch title')
  })
})

/* ------------------------------------------------------------------ *
 * POST /commit kind "conflictResolution" — the missing branch (§28.1, §28.3)
 * ------------------------------------------------------------------ *
 *
 * The Studio's resolution UI was FULLY BUILT — panel, controller, labels,
 * transport — and POSTed `{kind: 'conflictResolution'}` to `/commit`, where the
 * dispatcher had no such branch and answered 400 INVALID_REQUEST. Found live
 * 2026-08-11: two hard conflicts in the banner, resolution options rendered as
 * text, and no wired way anywhere to invoke them.
 */

async function conflictedApi(): Promise<{api: OverlayApi; conflictId: string; root: string}> {
  const {api, root} = await boot()
  await commit(api, {
    idempotencyKey: 'k1',
    kind: 'actions',
    payload: edit('Branch title'),
    baseDocuments: [BASE_V1],
  })
  await commit(api, {
    idempotencyKey: 'k2',
    kind: 'actions',
    payload: edit('Branch title, again'),
    baseDocuments: [BASE_TITLE_MOVED],
  })
  const body = await state(api)
  const conflictId = body.documents[0].conflicts[0].id as string
  return {api, conflictId, root}
}

describe('POST /commit kind "conflictResolution"', () => {
  it('resolves a conflict, persists the decision, and clears the unresolved summary', async () => {
    const {api, conflictId} = await conflictedApi()

    const resolved = await commit(api, {
      idempotencyKey: 'k3',
      kind: 'conflictResolution',
      payload: {
        kind: 'conflictResolution',
        documentId: 'article-1',
        conflictId,
        action: 'keep-branch-value',
        resolution: 'keep-local',
      },
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.committed).toBe(true)
    expect(resolved.affectedDocumentIds).toEqual(['article-1'])

    const body = await state(api)
    /* The summary counts UNRESOLVED conflicts — a resolved one must leave it. */
    expect(body.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    const conflict = body.documents[0].conflicts.find((c: Rec) => c.id === conflictId)
    expect(conflict.resolution?.type).toBe('keep-local')
    /* The branch value survived the keep-local action. */
    expect(body.documents[0].draft.title).toBe('Branch title, again')
  })

  it('replays a retried resolution instead of double-resolving', async () => {
    const {api, conflictId} = await conflictedApi()
    const body = {
      idempotencyKey: 'k3',
      kind: 'conflictResolution',
      payload: {
        kind: 'conflictResolution',
        documentId: 'article-1',
        conflictId,
        action: 'keep-branch-value',
        resolution: 'keep-local',
      },
    }
    const first = await commit(api, body)
    const retry = await commit(api, body)

    expect(retry.replayed).toBe(true)
    expect(retry.committed).toBe(false)
    expect(retry.revision).toBe(first.revision)
  })

  it('refuses an unknown conflict id as a request error, not a crash', async () => {
    const {api} = await conflictedApi()
    const result = await commit(api, {
      idempotencyKey: 'k3',
      kind: 'conflictResolution',
      payload: {
        kind: 'conflictResolution',
        documentId: 'article-1',
        conflictId: 'no-such-conflict',
        action: 'keep-branch-value',
        resolution: 'keep-local',
      },
    })
    expect(result.ok).toBe(false)
    expect(String(result.error?.message ?? '')).toContain('no-such-conflict')
  })

  it('the resolution survives a restart — it is on disk, not in the process', async () => {
    const {api, conflictId, root} = await conflictedApi()
    await commit(api, {
      idempotencyKey: 'k3',
      kind: 'conflictResolution',
      payload: {
        kind: 'conflictResolution',
        documentId: 'article-1',
        conflictId,
        action: 'keep-branch-value',
        resolution: 'keep-local',
      },
    })
    await api.close()
    apis.splice(apis.indexOf(api), 1)

    const second = await createOverlayApi({
      store: new FsOverlayStore({root, now: makeClock()}),
      overlayId: OVERLAY_ID,
      origins: [STUDIO_ORIGIN],
      now: makeClock(),
    })
    apis.push(second)
    const body = await state(second)
    expect(body.conflictSummary).toEqual({total: 0, hard: 0, soft: 0})
    expect(
      body.documents[0].conflicts.find((c: Rec) => c.id === conflictId)?.resolution?.type,
    ).toBe('keep-local')
  })
})
