/**
 * PRD §13.1 `manifest.checkpoint` — the marker, and everything that reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * `manifest.checkpoint` was declared in §13.1, read by `sanity-overlay status`,
 * by CI's §29.6 `checkpoint-policy` check and by §15.7 retention — and written
 * by nothing. The only writer, the overlay API's checkpoint endpoint, wrote it
 * only when the caller supplied a `commitSha`; a checkpoint taken from a Studio
 * cannot supply one, because the checkpoint is what PRODUCES the files that
 * will be committed. So the field was never written in practice, and both
 * readers reported "never checkpointed" the instant after a checkpoint had been
 * taken. `touchedSinceCheckpoint` — a §28.2 column the Studio's conflict panel
 * filters on — could never be derived by anyone.
 *
 * THE DESIGN THIS SUITE PINS
 *
 * "Checkpoint written" and "checkpoint attributed to a commit" are two facts,
 * and only the first is knowable when a checkpoint is taken:
 *
 *   checkpoint present, no `commitSha`   taken at this overlay revision;
 *                                        not yet known to be in Git
 *   checkpoint present, with `commitSha` a commit is known to carry it
 *   checkpoint absent                    never checkpointed
 *
 * Every §29.6 predicate the PRD states is written in terms of
 * `checkpoint.overlayRevision`, never the sha, so the unattributed form answers
 * the policy the PRD specifies without inventing anything (§5.5).
 *
 * THE ORACLES ARE THE BYTES AND A SECOND STORE. Every assertion about the
 * marker reads `manifest.json` off disk with `node:fs`, or opens a SECOND,
 * freshly-constructed `FsOverlayStore` over the same root. Nothing here trusts
 * the response body of the call that did the writing — a report agreeing with
 * itself is what let this field be absent for as long as it was.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {defaultRetentionDays, parse} from '../../sanity-overlay-core/src/index'
import type {OverlayManifest} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'
import {statusReport, renderStatus} from '../../sanity-overlay-cli/src/commands/status'
import {checkpointPolicyCheck} from '../../sanity-overlay-cli/src/ci/overlayChecks'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
  runCliCapture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

const OVERLAY_ID = 'checkpoint-marker-000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: OverlayApiServer[] = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
  await cleanupOverlayFixtures()
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-marker-'))
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
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    /* A real launcher always states its base and source; `exportCheckpoint`
     * validates both structurally (§14.3) and refuses a manifest without them.
     * Omitting them here would make every checkpoint 400 for a reason that has
     * nothing to do with the marker under test. */
    base: {projectId: 'checkpoint-marker', dataset: 'branch', apiVersion: '2025-02-19'},
    source: {repositoryId: 'sanity-dataset-simulator', branch: 'checkpoint-marker'},
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

/** THE ORACLE: the manifest as `node:fs` sees it, not as the API described it. */
async function manifestOnDisk(root: string): Promise<OverlayManifest> {
  return parse(
    await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
  ) as OverlayManifest
}

/** THE OTHER ORACLE: a second store, constructed after the fact, reading the same root. */
async function manifestFromASecondStore(root: string): Promise<OverlayManifest> {
  return await new FsOverlayStore({root, now: () => new Date().toISOString()}).inspect()
}

function editAction(title: string, id = 'article-1'): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: `drafts.${id}`,
      publishedId: id,
      patch: {set: {title}},
    },
  ]
}

const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
}

/** A Studio checkpoint: no `commitSha`, because the commit does not exist yet. */
async function browserCheckpoint(
  server: OverlayApiServer,
  root: string,
): Promise<Record<string, any>> {
  const result = await post(server, '/commit', {
    idempotencyKey: `checkpoint-${Math.random()}`,
    kind: 'checkpoint',
    payload: {dir: join(root, 'checkpoint')},
  })
  expect(result.status, JSON.stringify(result.json)).toBe(200)
  return result.json
}

/* ================================================================== *
 * The browser path — the one that could never write the marker
 * ================================================================== */

describe('a checkpoint taken from a browser', () => {
  it('writes PRD §13.1 `manifest.checkpoint` to disk without a commit sha', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Branch title'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect((await manifestOnDisk(root)).checkpoint).toBeUndefined()

    await browserCheckpoint(server, root)

    const onDisk = await manifestOnDisk(root)
    expect(onDisk.checkpoint).toBeDefined()
    expect(onDisk.checkpoint?.overlayRevision).toBe(onDisk.revision)
    expect(typeof onDisk.checkpoint?.createdAt).toBe('string')
    /* NOTHING IS INVENTED. §5.5: the commit does not exist yet, so no sha. */
    expect(onDisk.checkpoint?.commitSha).toBeUndefined()
  })

  it('is visible to a second store that never saw the request', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await browserCheckpoint(server, root)

    const manifest = await manifestFromASecondStore(root)
    expect(manifest.checkpoint?.overlayRevision).toBe(manifest.revision)
  })

  it('puts the marker in the COMMITTED tree, so a fresh clone inherits it', async () => {
    /* The tree is what gets committed; if the marker were stamped after the
     * render, a clone would import a manifest that still said "never
     * checkpointed" and the §29.6 answer would be wrong for everyone but the
     * machine that took it. */
    const root = await makeRoot()
    const server = await boot(root)
    await browserCheckpoint(server, root)

    const tree = parse(
      await readFile(join(root, 'checkpoint', 'manifest.json'), 'utf8'),
    ) as OverlayManifest
    expect(tree.checkpoint?.overlayRevision).toBe(tree.revision)
  })

  it('records the sha when — and only when — the caller could name one', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'checkpoint-attributed',
      kind: 'checkpoint',
      payload: {dir: join(root, 'checkpoint'), commitSha: '9f1c0de'},
    })

    expect((await manifestOnDisk(root)).checkpoint?.commitSha).toBe('9f1c0de')
  })

  it('says whether the checkpoint is attributed, rather than whether it was written', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    const report = (await browserCheckpoint(server, root)).checkpoint

    /* The marker IS written now — that is no longer the operator's problem. */
    expect(report.manifestMarked).toBe(true)
    /* What remains true and actionable: nothing yet says where it landed. */
    expect(report.attributedToCommit).toBe(false)
    expect(String(report.attributionNote)).toMatch(/commit the tree/i)
  })
})

/* ================================================================== *
 * The two readers that were lying
 * ================================================================== */

describe('`sanity-overlay status` after a browser checkpoint', () => {
  it('stops reporting "none" and counts zero uncheckpointed revisions', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Branch title'),
      baseDocuments: [BASE_ARTICLE],
    })

    const before = statusReport(await manifestOnDisk(root))
    expect(before.checkpoint).toBeNull()
    expect(before.uncheckpointedRevisions).toBeGreaterThan(0)

    await browserCheckpoint(server, root)

    const after = statusReport(await manifestOnDisk(root))
    expect(after.checkpoint).not.toBeNull()
    expect(after.uncheckpointedRevisions).toBe(0)

    const rendered = renderStatus(after).join('\n')
    expect(rendered).not.toMatch(/checkpoint\s+none/)
    /* An unattributed checkpoint must not be printed as though it had a sha. */
    expect(rendered).toMatch(/not attributed to a commit/i)
    expect(rendered).not.toMatch(/undefined/)
  })

  it('names the commit once one is attributed', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'checkpoint-attributed',
      kind: 'checkpoint',
      payload: {dir: join(root, 'checkpoint'), commitSha: 'deadbee'},
    })

    const rendered = renderStatus(statusReport(await manifestOnDisk(root))).join('\n')
    expect(rendered).toContain('deadbee')
    expect(rendered).not.toMatch(/not attributed/i)
  })

  it('counts revisions committed after the checkpoint', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await browserCheckpoint(server, root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-after',
      kind: 'actions',
      payload: editAction('Edited after the checkpoint'),
      baseDocuments: [BASE_ARTICLE],
    })

    expect(statusReport(await manifestOnDisk(root)).uncheckpointedRevisions).toBeGreaterThan(0)
  })
})

describe('the §29.6 CI checkpoint policy after a browser checkpoint', () => {
  it('stops claiming the overlay has never been checkpointed', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Branch title'),
      baseDocuments: [BASE_ARTICLE],
    })

    const before = checkpointPolicyCheck(await manifestOnDisk(root), 'required')
    expect(before.status).toBe('fail')
    expect(JSON.stringify(before.findings)).toMatch(/never been checkpointed/)

    await browserCheckpoint(server, root)

    const after = checkpointPolicyCheck(await manifestOnDisk(root), 'required')
    expect(JSON.stringify(after.findings)).not.toMatch(/never been checkpointed/)
    expect(after.measured.uncheckpointedRevisions).toBe(0)
    expect(after.measured.hasCheckpoint).toBe(1)
    /* The policy is about uncheckpointed runtime state, and there is none. */
    expect(after.status).toBe('pass')
  })

  it('reports attribution as its own measure, so an uncommitted tree is still visible', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await browserCheckpoint(server, root)

    const unattributed = checkpointPolicyCheck(await manifestOnDisk(root), 'required')
    expect(unattributed.measured.attributedToCommit).toBe(0)

    const attributed = await (async () => {
      await post(server, '/commit', {
        idempotencyKey: 'checkpoint-attributed',
        kind: 'checkpoint',
        payload: {dir: join(root, 'checkpoint'), commitSha: 'cafe123'},
      })
      return checkpointPolicyCheck(await manifestOnDisk(root), 'required')
    })()
    expect(attributed.measured.attributedToCommit).toBe(1)
  })

  it('tells an operator to run a command that actually clears the finding', async () => {
    /* The old remedy was `sanity-overlay export --output …`, which wrote a tree
     * and left the manifest untouched — so following the advice changed nothing
     * about the finding. */
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Branch title'),
      baseDocuments: [BASE_ARTICLE],
    })

    const finding = JSON.stringify(checkpointPolicyCheck(await manifestOnDisk(root), 'required'))
    expect(finding).toContain('--mark-checkpoint')
  })
})

/* ================================================================== *
 * The §28.2 column that could never be derived
 * ================================================================== */

describe('`touchedSinceCheckpoint` on GET /state', () => {
  const stateOf = async (server: OverlayApiServer): Promise<Record<string, any>> => {
    const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    return (await response.json()) as Record<string, any>
  }

  it('is absent before any checkpoint, rather than a `false` nobody earned', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Branch title'),
      baseDocuments: [BASE_ARTICLE],
    })

    const entry = (await stateOf(server)).documents[0]
    expect(entry.touchedSinceCheckpoint).toBeUndefined()
  })

  it('is false for a document the checkpoint captured and true for one edited after', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await post(server, '/commit', {
      idempotencyKey: 'edit-1',
      kind: 'actions',
      payload: editAction('Captured by the checkpoint'),
      baseDocuments: [BASE_ARTICLE],
    })
    await browserCheckpoint(server, root)

    const captured = (await stateOf(server)).documents.find(
      (entry: Record<string, any>) => entry.logicalId === 'article-1',
    )
    expect(captured.touchedSinceCheckpoint).toBe(false)

    await post(server, '/commit', {
      idempotencyKey: 'edit-2',
      kind: 'actions',
      payload: editAction('Edited after the checkpoint', 'article-2'),
      baseDocuments: [{...BASE_ARTICLE, _id: 'article-2'}],
    })

    const documents = (await stateOf(server)).documents
    const stillCaptured = documents.find(
      (entry: Record<string, any>) => entry.logicalId === 'article-1',
    )
    const touchedAfter = documents.find(
      (entry: Record<string, any>) => entry.logicalId === 'article-2',
    )
    expect(stillCaptured.touchedSinceCheckpoint).toBe(false)
    expect(touchedAfter.touchedSinceCheckpoint).toBe(true)
  })
})

/* ================================================================== *
 * The CLI half — `export` is a read, and says so
 * ================================================================== */

describe('`sanity-overlay export --output`', () => {
  it('leaves the manifest alone by default, so the tree stays byte-stable', async () => {
    const {root} = await createOverlayFixture()
    const before = await manifestOnDisk(root)

    const run = await runCliCapture(['export', '--output', join(root, 'checkpoint')], {cwd: root})

    expect(run.code).toBe(EXIT.OK)
    const after = await manifestOnDisk(root)
    expect(after.revision).toBe(before.revision)
    expect(after.checkpoint).toBeUndefined()
  })

  it('records the checkpoint when asked, and says it is unattributed', async () => {
    const {root} = await createOverlayFixture()

    const run = await runCliCapture(
      ['export', '--output', join(root, 'checkpoint'), '--mark-checkpoint'],
      {cwd: root},
    )

    expect(run.code).toBe(EXIT.OK)
    const after = await manifestOnDisk(root)
    expect(after.checkpoint?.overlayRevision).toBe(after.revision)
    expect(after.checkpoint?.commitSha).toBeUndefined()
    expect(run.stdout).toMatch(/not attributed to a commit/i)

    /* And the readers agree, from the bytes. */
    expect(statusReport(after).uncheckpointedRevisions).toBe(0)
    expect(
      JSON.stringify(checkpointPolicyCheck(after, 'required').findings),
    ).not.toMatch(/never been checkpointed/)
  })

  it('attributes the checkpoint to a commit the caller names', async () => {
    const {root} = await createOverlayFixture()

    const run = await runCliCapture(
      [
        'export',
        '--output',
        join(root, 'checkpoint'),
        '--mark-checkpoint',
        '--commit-sha',
        'abc1234',
      ],
      {cwd: root},
    )

    expect(run.code).toBe(EXIT.OK)
    expect((await manifestOnDisk(root)).checkpoint?.commitSha).toBe('abc1234')
  })

  it('refuses --commit-sha without --mark-checkpoint rather than ignoring it', async () => {
    /* A flag that is silently dropped is how a CI job comes to believe it
     * attributed a checkpoint it did not. */
    const {root} = await createOverlayFixture()

    const run = await runCliCapture(
      ['export', '--output', join(root, 'checkpoint'), '--commit-sha', 'abc1234'],
      {cwd: root},
    )

    expect(run.code).toBe(EXIT.USAGE)
    expect((await manifestOnDisk(root)).checkpoint).toBeUndefined()
  })
})

/* ================================================================== *
 * §15.7 retention — the other reader of the field
 * ================================================================== */

describe('§15.7 retention distinguishes written from attributed', () => {
  const closed = (checkpoint: OverlayManifest['checkpoint']): OverlayManifest =>
    ({
      formatVersion: 1,
      overlayId: OVERLAY_ID,
      status: 'closed',
      base: {projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'},
      source: {repositoryId: 'r', branch: 'b'},
      revision: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      documentHeads: {},
      conflictSummary: {total: 0, hard: 0, soft: 0},
      ...(checkpoint === undefined ? {} : {checkpoint}),
    }) as OverlayManifest

  it('keeps the conservative window for a checkpoint no commit is known to carry', async () => {
    /* 14 days is affordable because the review surface is recoverable from Git.
     * An unattributed checkpoint has no such guarantee — its only copy may be an
     * uncommitted working tree — so it keeps the 30-day window. */
    expect(
      defaultRetentionDays(closed({overlayRevision: 4, createdAt: '2026-01-01T00:00:00.000Z'})),
    ).toBe(30)
    expect(defaultRetentionDays(closed(undefined))).toBe(30)
  })

  it('shortens the window once a commit is named', async () => {
    expect(
      defaultRetentionDays(
        closed({overlayRevision: 4, commitSha: 'abc1234', createdAt: '2026-01-01T00:00:00.000Z'}),
      ),
    ).toBe(14)
  })
})
