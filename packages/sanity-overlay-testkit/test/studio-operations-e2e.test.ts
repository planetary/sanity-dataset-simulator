/**
 * The §21.7 overlay actions, driven end to end onto a REAL filesystem store.
 *
 * WHAT WAS WRONG, AND WHY EVERY EXISTING TEST STAYED GREEN THROUGH IT.
 *
 * `studio-operations.test.ts` proves `planRebase` / `planCheckpoint` decide
 * correctly. `studio-conflict-panel-ui.test.ts` proves a controller behaves when
 * it is handed a runtime. `studio-document-action-delivery.test.ts` proves the
 * components reach a Studio's menu. All three stop at a hand-made transport, so
 * all three were green while a real click did NOTHING: the overlay API refuses
 * any `POST /commit` whose `kind` is not `actions` / `mutations` /
 * `documentActions`, and `checkpoint` and `rebase` are neither. The capability
 * below the button did not exist.
 *
 * So this file starts a REAL `sanity-overlay-next` server over a REAL temporary
 * `.sanity-overlay` tree and drives the controller through exactly the sequence
 * sanity 6.8.0 drives it through:
 *
 *   describe(context)      → the menu item (`ActionMenuListItem`)
 *   .onHandle()            → the click (`lib/structureTool-EN0gOzyJ.js:5451`,
 *                            `onAction(index), onHandle && onHandle()`)
 *   describe(context)      → the re-render the state change causes
 *   .dialog.onConfirm()    → the confirm button
 *                            (`ConfirmDialog` → `ConfirmPopover`, note: sanity
 *                            renders a confirm dialog as a POPOVER, so it has no
 *                            `role="dialog"` in the DOM)
 *
 * THE ORACLE IS ALWAYS DISK. Every assertion below reads bytes with `node:fs`,
 * or re-imports the checkpoint tree into a SECOND, empty store — never the
 * value the call under test just returned.
 *
 * `examples/kitchen-sink/.sanity-overlay` is live state a human is testing
 * against and is never touched.
 */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {parse} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime, type OverlayRuntime} from '../../sanity-overlay-studio/src/runtime'
import {createOverlayActionControllers} from '../../sanity-overlay-studio/src/ui/documentActions'
import type {
  OverlayActionController,
  OverlayConfirmDialog,
} from '../../sanity-overlay-studio/src/documentActions'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'studio-operations-e2e-00000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface Booted {
  url: string
  close(): Promise<void>
}

/**
 * §13.1 requires a manifest `base` block, and `exportCheckpoint` refuses to
 * render a tree without one. `createOverlayApi` will happily create an overlay
 * with `base: {}` when the caller names none — see the report on
 * `examples/kitchen-sink/overlayApiServer.mjs`.
 */
const BASE_IDENTITY = {projectId: 'b1n03q3z', dataset: 'parity', apiVersion: '2025-02-19'}
const SOURCE_IDENTITY = {repositoryId: 'github:planetary/sanity-branch-overlay', branch: 'test'}

const BASE_PUBLISHED = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
  summary: 'from the lake',
}

/** The base as it stands NOW — moved on a path the branch never touched. */
const BASE_MOVED = {
  ...BASE_PUBLISHED,
  _rev: 'lake-rev-2',
  _updatedAt: '2026-01-05T00:00:00.000Z',
  summary: 'rewritten upstream',
}

async function post(server: Booted, route: string, body: unknown): Promise<Rec> {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
  return (await response.json()) as Rec
}

async function readJson(path: string): Promise<Rec> {
  return parse(await readFile(path, 'utf8')) as Rec
}

/** A client double that answers base reads and never writes. */
function baseClient(base: Rec): Rec {
  const self: Rec = {
    fetch: (): Promise<unknown> => Promise.resolve([]),
    getDocument: (id: string): Promise<unknown> =>
      Promise.resolve(id === base._id ? {...base} : undefined),
    getDocuments: (ids: readonly string[]): Promise<unknown> =>
      Promise.resolve(ids.map((id) => (id === base._id ? {...base} : null))),
    config: () => ({projectId: 'p', dataset: 'd', apiVersion: '2025-02-19'}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
  }
  return self
}

/**
 * A branch with one edited document, plus a fresh Studio session over it.
 *
 * The session performs the one authoritative base read Studio itself performs
 * (the pair listener's `getDocuments` snapshot), because that is where the
 * ancestry a rebase needs comes from.
 */
async function session(options: {base?: Rec} = {}): Promise<{
  root: string
  server: Booted
  runtime: OverlayRuntime
  controllers: ReturnType<typeof createOverlayActionControllers>
}> {
  const root = await makeRoot('studio-ops-e2e-')
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: BASE_IDENTITY,
    source: SOURCE_IDENTITY,
  })
  running.push(server)

  await post(server, '/commit', {
    idempotencyKey: 'seed-edit',
    kind: 'actions',
    payload: [
      {
        actionType: 'sanity.action.document.edit',
        draftId: 'drafts.article-1',
        publishedId: 'article-1',
        patch: {set: {title: 'Edited in the branch'}},
      },
    ],
    baseDocuments: [BASE_PUBLISHED],
  })

  const client = baseClient(options.base ?? BASE_PUBLISHED)
  const runtime = createOverlayRuntime({
    resolved: resolveOverlayOptions(
      {mode: 'fs', apiUrl: server.url, strictQueries: false},
      {},
    ),
    createClient: () => client,
  })
  await runtime.refresh()

  /* The read that seeds the merge ancestor, exactly as opening the document
   * pane does. Without it the Studio has never seen the current base. */
  const wrapped = runtime.clientFactory({}) as Rec
  await (wrapped.getDocuments as (ids: string[]) => Promise<unknown>)([
    'article-1',
    'drafts.article-1',
  ])

  return {root, server, runtime, controllers: createOverlayActionControllers(runtime)}
}

/** describe → click → re-describe → confirm, the way sanity 6.8.0 does it. */
async function clickAndConfirm(
  controller: OverlayActionController,
  documentId: string,
): Promise<void> {
  const menuItem = controller.describe({id: documentId, type: 'article'})
  if (menuItem === null) throw new Error('the action rendered nothing at all')
  if (menuItem.disabled) {
    throw new Error(`the action is disabled: ${menuItem.title ?? '<no reason given>'}`)
  }
  if (typeof menuItem.onHandle !== 'function') {
    throw new Error('the menu item is enabled but carries no onHandle — a click would do nothing')
  }
  menuItem.onHandle()

  const opened = controller.describe({id: documentId, type: 'article'})
  const dialog = opened?.dialog
  if (dialog === undefined || dialog === false) {
    throw new Error('clicking the action opened no dialog')
  }
  await (dialog as OverlayConfirmDialog).onConfirm()
}

/* ══════════════════════════════════════════════════════════ checkpoint */

describe('Create checkpoint writes a durable, re-importable checkpoint (PRD §14.1, §29.1)', () => {
  it('renders a checkpoint tree the store can read back into an empty overlay', async () => {
    const {root, controllers} = await session()

    await clickAndConfirm(controllers.checkpoint, 'article-1')

    expect(controllers.checkpoint.state().error).toBeUndefined()

    /* ORACLE 1: the bytes. `checksums.json` is the §14.3 integrity file that
     * only a checkpoint render produces. */
    const checksums = await readJson(join(root, '.sanity-overlay', 'checksums.json'))
    expect(typeof checksums.checksum).toBe('string')

    /* ORACLE 2: a SECOND, empty store re-imports the tree — PRD §29.7. Nothing
     * the Studio computed is involved in this answer. */
    const freshRoot = await makeRoot('studio-ops-import-')
    const fresh = new FsOverlayStore({root: freshRoot, now: makeClock()})
    const imported = await fresh.importCheckpoint(join(root, '.sanity-overlay'))
    expect(imported.overlayId).toBe(OVERLAY_ID)
    expect(imported.importedDocuments).toBe(1)
    expect(imported.issues).toEqual([])

    const roundTripped = await readJson(
      join(freshRoot, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
    )
    expect(roundTripped.logicalId).toBe('article-1')
  })

  it('reports where the checkpoint landed rather than saying only "done"', async () => {
    const {root, controllers} = await session()
    await clickAndConfirm(controllers.checkpoint, 'article-1')

    const result = controllers.checkpoint.state().result
    expect(result).toContain('.sanity-overlay')
    expect(result).toContain(join(root, '.sanity-overlay'))
  })
})

/* ═════════════════════════════════════════════════════════════ rebase */

describe('Rebase onto current base applies §17/§28.5 and persists it', () => {
  it('replaces the merge ancestor with the current base and writes it to disk', async () => {
    const {root, server, controllers} = await session({base: BASE_MOVED})

    const before = await readJson(
      join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
    )
    const beforeSnapshotRef = (before.base as Rec).snapshotRef

    await clickAndConfirm(controllers.rebase, 'article-1')

    expect(controllers.rebase.state().error).toBeUndefined()

    /* ORACLE: the canonical intent on disk names a DIFFERENT base capture than
     * it did before — the ancestor really was replaced. */
    const after = await readJson(
      join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json'),
    )
    expect((after.base as Rec).snapshotRef).not.toBe(beforeSnapshotRef)
    /* And it names the base revision the Studio supplied, not the one the
     * branch forked from. §13.3 keeps `firstTouchedAt`; the CAPTURE moves. */
    expect((after.base as Rec).publishedRevision).toBe(BASE_MOVED._rev)

    /* And the API agrees, on a round trip the Studio did not make. */
    const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
    const state = (await response.json()) as {revision: number; documents: Array<Rec>}
    const manifest = await readJson(join(root, '.sanity-overlay', 'manifest.json'))
    expect(state.revision).toBe(manifest.revision)
    const entry = state.documents.find((document) => document.logicalId === 'article-1')
    expect(entry?.baseRevisionAtFirstTouch).toBe(BASE_MOVED._rev)

    /* The branch edit survived the rebase — §28.5 replaces the ancestor, it does
     * not discard local intent. */
    expect((entry?.draft as Rec).title).toBe('Edited in the branch')
  })

  it('refuses rather than pretending when the Studio holds no current base', async () => {
    const root = await makeRoot('studio-ops-nobase-')
    const server = await startOverlayApiServer({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
      base: BASE_IDENTITY,
      source: SOURCE_IDENTITY,
    })
    running.push(server)

    await post(server, '/commit', {
      idempotencyKey: 'seed-edit',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: 'drafts.article-1',
          publishedId: 'article-1',
          patch: {set: {title: 'Edited in the branch'}},
        },
      ],
      baseDocuments: [BASE_PUBLISHED],
    })

    const runtime = createOverlayRuntime({
      resolved: resolveOverlayOptions(
        {mode: 'fs', apiUrl: server.url, strictQueries: false},
        {},
      ),
      createClient: () => baseClient(BASE_PUBLISHED),
    })
    await runtime.refresh()
    /* NO base read this time: nothing in this session has opened the document. */

    const controllers = createOverlayActionControllers(runtime)
    const menuItem = controllers.rebase.describe({id: 'article-1', type: 'article'})

    /* Disabled WITH A REASON is the acceptable answer. Enabled-and-inert is not. */
    expect(menuItem?.disabled).toBe(true)
    expect(menuItem?.title ?? '').toMatch(/current base/i)
    expect(menuItem?.onHandle).toBeUndefined()
  })
})
