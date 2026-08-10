/**
 * A refused write must reach the human who made it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INCIDENT (2026-08-09, reproduced in a real browser)
 *
 * A long-lived overlay API server had been up for two days. A SECOND process —
 * `sanity-overlay normalize`, which calls `store.revalidate()`, and which a
 * developer runs with their Studio open — rewrote `manifest.json` and advanced
 * the on-disk revision. From that moment every edit in the Studio silently
 * failed to commit: `GET /state` kept reporting the old values, the revision
 * stayed pinned, and there was NO error, NO toast, NO console message and no
 * "Syncing document…" indicator. Restarting the API server fixed it instantly.
 *
 * THE REFUSAL IS CORRECT. THE SILENCE IS THE DEFECT.
 *
 * `FsOverlayStore.#writeManifest` re-reads the revision immediately before the
 * rename and raises `OVERLAY_WRITE_CONFLICT` rather than clobbering a newer
 * one. That guard is the §33 durability work doing exactly its job, and nothing
 * here weakens it. What this file requires is that the refusal be
 * DISTINGUISHABLE at the boundary — a write that is refused for a good reason
 * and reported as success is, from the editor's chair, indistinguishable from
 * data loss (PRD §5.5).
 *
 * SO THE ASSERTIONS ARE PAIRED, ALWAYS, IN BOTH DIRECTIONS:
 *
 *     the caller was told "ok"      ⇒ it is on disk
 *     it is NOT on disk             ⇒ the caller was told, specifically
 *
 * and the oracle for "on disk" is `node:fs`, never the response body.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'

const OVERLAY_ID = 'stale-session-0000000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'
const LOGICAL_ID = 'article-1'

const BASE_ARTICLE = {
  _id: LOGICAL_ID,
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Base title',
}

const roots: string[] = []
const running: OverlayApiServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stale-session-'))
  roots.push(root)
  return root
}

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

async function boot(root: string): Promise<OverlayApiServer> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    /* The watcher OFF, so the only thing under test is the commit path. The
     * incident happened with it on; see the case that turns it on. */
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: {projectId: 'stale-session', dataset: 'branch', apiVersion: '2025-02-19'},
    source: {repositoryId: 'sanity-dataset-simulator', branch: 'stale-session'},
  })
  running.push(server)
  return server
}

async function post(
  server: OverlayApiServer,
  route: string,
  body: unknown,
): Promise<{status: number; json: Record<string, any>}> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return {status: response.status, json: (await response.json()) as Record<string, any>}
}

function editAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: `drafts.${LOGICAL_ID}`,
      publishedId: LOGICAL_ID,
      patch: {set: {title}},
    },
  ]
}

/** THE ORACLE: the manifest as `node:fs` sees it. */
async function manifestOnDisk(root: string): Promise<OverlayManifest> {
  return parse(
    await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
  ) as OverlayManifest
}

/** THE ORACLE: the branch title the §14.2 intent file actually records. */
async function titleOnDisk(root: string): Promise<string | null> {
  const path = join(root, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const intent = parse(raw) as {
    draft?: {overrides?: Array<{path: unknown[]; value: unknown}>}
  }
  const override = intent.draft?.overrides?.find(
    (entry) => Array.isArray(entry.path) && entry.path[0] === 'title',
  )
  return override === undefined ? null : (override.value as string)
}

/**
 * THE SECOND PROCESS.
 *
 * A separate `FsOverlayStore` over the same root — a CLI run (`normalize`,
 * `reset`), an agent, a Git merge, or a second tab. Not a stub: the real store,
 * through the real write path, exactly as `sanity-overlay` drives it.
 */
function otherProcess(root: string): FsOverlayStore {
  return new FsOverlayStore({root, now: () => new Date().toISOString()})
}

/** The second process advances the manifest without touching any document. */
async function bumpRevision(root: string): Promise<number> {
  const store = otherProcess(root)
  const current = await store.readManifest(OVERLAY_ID)
  const next = await store.writeManifestConditional(
    OVERLAY_ID,
    {...current, revision: current.revision + 1},
    current.revision,
    {actor: {type: 'system', id: 'another-process', displayName: 'another process'}},
  )
  return next.revision
}

/** The second process edits the SAME document the open session is editing. */
async function writeSummaryElsewhere(root: string, summary: string): Promise<void> {
  const store = otherProcess(root)
  const read = await store.readDocumentByLogicalId(OVERLAY_ID, LOGICAL_ID)
  const record = read?.record
  if (record === undefined || record === null || record.local.draft === null) {
    throw new Error('fixture: the second process found no draft to edit')
  }
  const draft = record.local.draft
  await store.commitTransaction(OVERLAY_ID, {
    idempotencyKey: `other-process-${summary}`,
    actor: {type: 'system', id: 'another-process', displayName: 'another process'},
    mutations: [],
    records: [
      {
        ...record,
        local: {
          ...record.local,
          draft: {
            ...draft,
            materialized: {...draft.materialized, summary},
            touchedPaths: [...draft.touchedPaths, ['summary']],
            operations: [
              ...draft.operations,
              {type: 'set', path: ['summary'], value: summary},
            ],
          },
        },
      } as never,
    ],
  })
}

/** THE ORACLE: the §14.2 intent bytes, so another writer's value is visible. */
async function intentText(root: string): Promise<string> {
  return readFile(join(root, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json'), 'utf8')
}

async function seed(root: string, server: OverlayApiServer): Promise<void> {
  const first = await post(server, '/commit', {
    idempotencyKey: 'edit-1',
    kind: 'actions',
    payload: editAction('Branch title one'),
    baseDocuments: [BASE_ARTICLE],
  })
  expect(first.json.committed, JSON.stringify(first.json)).toBe(true)
}

/** Armed only for the case that needs a permanent conflict. See it below. */
let armed = false

/* ================================================================== *
 * The measured defect: a stale session silently discards another
 * writer's work
 * ================================================================== */

describe('a session whose branch moved underneath it', () => {
  it('does not discard a change another process made to the same document', async () => {
    /*
     * MEASURED 2026-08-09, before the fix: `200 ok:true committed:true`, the
     * manifest advanced, the editor's title on disk — and the other process's
     * `summary` GONE, with nothing said about it. A lost update reported as a
     * success is the §33 failure this repository has now shipped three times.
     */
    const root = await makeRoot()
    const server = await boot(root)
    await seed(root, server)

    await writeSummaryElsewhere(root, 'Written by another process')
    /* NON-VACUITY: the other process really did land on disk first. */
    expect(await intentText(root)).toContain('Written by another process')

    const result = await post(server, '/commit', {
      idempotencyKey: 'edit-2',
      kind: 'actions',
      payload: editAction('Typed after the other process wrote'),
      baseDocuments: [BASE_ARTICLE],
    })

    const mine = (await titleOnDisk(root)) === 'Typed after the other process wrote'
    const theirs = (await intentText(root)).includes('Written by another process')

    /* Either BOTH survive — the session reconciled against what was on disk —
     * or the caller was told its write did not land. Never "ok" plus silence. */
    if (result.json.ok === true && result.json.committed === true) {
      expect(mine, 'reported committed, but the edit is not on disk').toBe(true)
      expect(theirs, 'reported committed, and the other writer’s change vanished').toBe(true)
    } else {
      expect(result.json.ok).toBe(false)
      expect(theirs).toBe(true)
    }
  })

  it('keeps serving the reconciled truth on a later GET /state', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await seed(root, server)
    await writeSummaryElsewhere(root, 'Written by another process')

    await post(server, '/commit', {
      idempotencyKey: 'edit-2',
      kind: 'actions',
      payload: editAction('Typed after the other process wrote'),
      baseDocuments: [BASE_ARTICLE],
    })

    /* A separate round trip. A session that wrote the right bytes and then kept
     * serving its stale copy is the same lie, one layer up — and it is the half
     * the incident actually showed the operator. */
    const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const body = (await response.json()) as Record<string, any>
    const entry = body.documents.find((d: Record<string, any>) => d.logicalId === LOGICAL_ID)
    expect(entry.draft.title).toBe('Typed after the other process wrote')
    expect(entry.draft.summary).toBe('Written by another process')
    expect(body.revision).toBe((await manifestOnDisk(root)).revision)
  })

  it('survives the manifest moving with no document change at all', async () => {
    /* The incident's own trigger: something advanced the revision (a checkpoint
     * marker, a `normalize`, a merge) without touching this document. The
     * session must carry on rather than wedge. */
    const root = await makeRoot()
    const server = await boot(root)
    await seed(root, server)
    const moved = await bumpRevision(root)

    const result = await post(server, '/commit', {
      idempotencyKey: 'edit-2',
      kind: 'actions',
      payload: editAction('Typed after the manifest moved'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(result.json.ok).toBe(true)
    expect(result.json.committed).toBe(true)
    expect(await titleOnDisk(root)).toBe('Typed after the manifest moved')
    expect((await manifestOnDisk(root)).revision).toBeGreaterThan(moved)
  })

  it('refuses out loud, with a 409, when it cannot reconcile', async () => {
    /*
     * THE INJECTION: the branch moves again on EVERY attempt, from inside the
     * commit's own critical section, so no number of retries can converge. A
     * session that cannot reconcile must SAY SO — with a status meaning "your
     * view is stale", not a 400 meaning "your payload is malformed", which
     * invites a client to retry the same request forever.
     */
    const root = await makeRoot()
    const server = await startOverlayApiServer({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
      base: {projectId: 'stale-session', dataset: 'branch', apiVersion: '2025-02-19'},
      source: {repositoryId: 'sanity-dataset-simulator', branch: 'stale-session'},
      hooks: {
        async beforeRename(info) {
          if (!armed || !info.targetPath.endsWith('manifest.json')) return
          /* A RAW write, not the store's API: this is the §14.4 writer the
           * guard is documented for — a Git merge, an agent, a process from an
           * older build — which does not take `.locks/` and therefore lands in
           * the window between the revision being read and the rename. Going
           * through the store here would deadlock on the lock this commit
           * already holds, which is itself proof the two writers are different
           * kinds of thing. */
          const path = join(root, '.sanity-overlay', 'manifest.json')
          const current = parse(await readFile(path, 'utf8')) as OverlayManifest
          await writeFile(
            path,
            `${JSON.stringify({...current, revision: current.revision + 1}, null, 2)}\n`,
            'utf8',
          )
        },
      },
    })
    running.push(server)

    await seed(root, server)
    armed = true

    const before = await manifestOnDisk(root)
    const result = await post(server, '/commit', {
      idempotencyKey: 'edit-doomed',
      kind: 'actions',
      payload: editAction('This can never land'),
      baseDocuments: [BASE_ARTICLE],
    })
    armed = false

    expect(result.json.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(String(result.json.error.code)).toBe('OVERLAY_WRITE_CONFLICT')
    expect(String(result.json.error.message)).toMatch(/revision/i)

    /* THE GUARD IS INTACT: the other writer's revision was never rolled back. */
    expect((await manifestOnDisk(root)).revision).toBeGreaterThanOrEqual(before.revision)
  })
})

/* ================================================================== *
 * The class: a 200 that carries a refusal
 * ================================================================== */

describe('every accepted-but-not-applied answer says so in the body', () => {
  /**
   * The root cause the incident, the D-3 status collapse and the rebase
   * pair-collapse share: `/commit` answers `200 ok:true` for outcomes that
   * CHANGED NOTHING, and a transport checking `response.ok` reads every one of
   * them as success.
   *
   * The contract here is the smallest thing that makes those outcomes
   * machine-detectable: `committed: false` on a 200 never stands alone. It
   * carries its reason — `blockedBy` for a §28.5 precondition, `unsupported`
   * for a translation gap, `checkpoint` for a render that deliberately commits
   * nothing — so a client can tell "did nothing, here is why" from "did it".
   */
  const carriesAReason = (body: Record<string, any>): boolean =>
    (Array.isArray(body.unsupported) && body.unsupported.length > 0) ||
    (Array.isArray(body.documents) &&
      body.documents.some((entry: Record<string, any>) => Array.isArray(entry.blockedBy))) ||
    body.checkpoint !== undefined

  it('a rebase that changed nothing reports why, per document', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await seed(root, server)

    /* The base moved on a path the branch touched, so §28.5 precondition 1
     * fails and nothing is written. */
    const result = await post(server, '/commit', {
      idempotencyKey: 'rebase-blocked',
      kind: 'rebase',
      payload: {mode: 'auto', documentIds: [LOGICAL_ID]},
      baseDocuments: [{...BASE_ARTICLE, _rev: 'lake-rev-9', title: 'Upstream took this path'}],
    })

    expect(result.status).toBe(200)
    expect(result.json.committed).toBe(false)
    expect(carriesAReason(result.json)).toBe(true)
    const outcome = result.json.documents.find(
      (entry: Record<string, any>) => entry.logicalId === LOGICAL_ID,
    )
    expect(outcome.applied).toBe(false)
    expect(outcome.blockedBy.length).toBeGreaterThan(0)
  })

  it('a checkpoint reports the tree it wrote, so `committed: false` is not bare', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await seed(root, server)

    const result = await post(server, '/commit', {
      idempotencyKey: 'checkpoint-1',
      kind: 'checkpoint',
      payload: {dir: join(root, 'checkpoint')},
    })

    expect(result.json.committed).toBe(false)
    expect(carriesAReason(result.json)).toBe(true)
    expect(String(result.json.checkpoint.dir)).toContain('checkpoint')
  })
})

