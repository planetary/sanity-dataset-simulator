/**
 * THE SMOKE TEST — boot the real thing and assert against it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS
 *
 * In one session five features passed their unit tests and did not work in a
 * browser. Three of them are the ones this file is built around:
 *
 *  1. Three overlay document actions never rendered. The tests constructed the
 *     actions THEMSELVES and asserted they were correct — proving the factory
 *     worked, not that anything called it.
 *  2. Those actions, once rendering, did nothing: the overlay API answered `400`
 *     for `kind:'checkpoint'`. The tests invoked `onHandle()` against a MOCKED
 *     transport, which cannot return 400.
 *  3. The editor form showed BASE content while the overlay held something else.
 *     GROQ reads were overlay-aware and tested; the form uses `getDocuments`,
 *     a different path nobody had thought of.
 *
 * Every one of those is a WIRING defect, and every test that missed it stopped
 * at a seam it had built itself. So this file builds nothing it then measures:
 *
 *   REAL CONFIG      `examples/kitchen-sink/sanity.config.ts` is imported as a
 *                    module and its `document.actions` are resolved by sanity
 *                    6.8.0's own `flattenConfig` → `documentActionsReducer`
 *                    (`src/sanityConfigResolution.ts`), with the REAL
 *                    `structureTool()` from the installed `sanity@6.8.0`
 *                    contributing the built-ins.
 *   REAL HTTP        a real `startOverlayApiServer` on a real ephemeral port,
 *                    reached through the Studio's own transport — no stub fetch.
 *   REAL STORE       a real `FsOverlayStore` over a real temporary
 *                    `.sanity-overlay` tree.
 *   REAL CLIENT      the real `@sanity/client@7.26.0` the example wires, talking
 *                    real HTTP to a loopback stand-in for the Content Lake.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS NEVER THE CALL UNDER TEST
 *
 * Bytes read back with `node:fs` + `JSON.parse`; a SECOND, freshly constructed
 * `FsOverlayStore` re-importing the checkpoint; a separate `GET /state` round
 * trip made with bare `fetch`; and the loopback lake's own request log. Nothing
 * below asserts on a value the code under test just returned to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT REAL HERE, NAMED RATHER THAN GLOSSED
 *
 *  a. THE REACT RENDERER. A Sanity document action is a React hook, and a real
 *     React hook cannot be invoked outside a renderer — Node answers "Invalid
 *     hook call". This package has no DOM environment available (`jsdom` is not
 *     one of its dependencies and adding one is not this agent's to do), so the
 *     three actions are DRIVEN through `createOverlayDocumentActions(hookHost)`.
 *     The test pins that those are the same three components the shipped config
 *     installs — same `.action` keys, same count, same order, and the shipped
 *     objects are asserted present in the resolved menu by REFERENCE. The
 *     runtime, registry, transport, HTTP and store underneath them are the real
 *     ones the example config built.
 *  b. THE CONTENT LAKE. `getDocuments` really does leave the process over HTTP;
 *     what answers is a loopback server, because the suite may never talk to a
 *     real dataset. It is a stand-in DATASET, not a stand-in client: the request
 *     is built, signed, sent and parsed by the real `@sanity/client`.
 *  c. THE BANNER'S POLL. `runtime.refresh()` is called directly rather than by
 *     mounting `OverlayStatusLayout`, which is what calls it in a browser
 *     (`ui/statusLayout.ts:108`). Same call, same object; only the renderer is
 *     absent, for the reason in (a).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY
 *
 * `examples/kitchen-sink/.sanity-overlay/` is live state a human is editing
 * against on :3333/:3998/:4000 and is NEVER touched: every overlay here is a
 * fresh `mkdtemp` and every port is ephemeral (`port: 0`). The example config is
 * pointed at them through the environment, which is exactly how a developer
 * points it at anything.
 */
import {createServer, type Server} from 'node:http'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {register} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest'

import {
  createHookHost,
  renderActionStates,
  resolveDocumentActions,
  type HookHost,
  type SanityActionHook,
} from '../src/sanityConfigResolution'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 120_000, hookTimeout: 120_000})

/*
 * ── THE ONE PIECE OF PLUMBING THE EXAMPLE CONFIG NEEDS TO LOAD IN NODE ──────
 *
 * `examples/kitchen-sink/sanity.config.ts` imports `sanity` and
 * `sanity/structure`, and somewhere under those a package imports a `.css` file.
 * Vitest externalises `node_modules` to native Node ESM, which has no loader for
 * `.css` and throws `Unknown file extension ".css"`.
 *
 * This is a LOADER, not a stub of anything under test: it makes a stylesheet
 * import evaluate to an empty module, which is what a bundler does with it in
 * the Studio build too. Nothing in this file's subject matter is CSS.
 */
register(
  `data:text/javascript,${encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return {format: 'module', source: 'export default {}', shortCircuit: true}
  }
  return nextLoad(url, context)
}
`)}`,
)

/* ═══════════════════════════════════════════════════════════════ fixtures */

const OVERLAY_ID = 'studio-boot-smoke-00000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

/** What `examples/kitchen-sink/studioIdentity.mjs` declares when no `.env` says otherwise. */
const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const API_VERSION = '2025-02-19'

const BASE_IDENTITY = {projectId: PROJECT_ID, dataset: DATASET, apiVersion: API_VERSION}
const SOURCE_IDENTITY = {repositoryId: 'github:planetary/sanity-branch-overlay', branch: 'smoke'}

const LOGICAL_ID = 'article-1'
const DRAFT_ID = `drafts.${LOGICAL_ID}`

/** The base as it stood when the branch forked. */
const BASE_PUBLISHED = {
  _id: LOGICAL_ID,
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Article 1',
  summary: 'from the lake',
}

/** The base as it stands NOW — moved upstream on a path the branch never touched. */
const BASE_MOVED = {
  ...BASE_PUBLISHED,
  _rev: 'lake-rev-2',
  _updatedAt: '2026-01-05T00:00:00.000Z',
  summary: 'rewritten upstream',
}

/**
 * A DRAFT IN THE BASE DATASET THAT DISAGREES WITH THE BRANCH.
 *
 * This is the fixture that makes the form-read assertion non-vacuous. If the
 * lake had no draft, "the form shows the branch draft" would also be satisfied
 * by "the form shows nothing and the branch filled it in". With a base draft
 * present and different, the two answers are distinguishable and the defect —
 * the form opening on base content — is reproducible.
 */
const BASE_DRAFT = {
  _id: DRAFT_ID,
  _type: 'article',
  _rev: 'lake-draft-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-02T00:00:00.000Z',
  title: 'A base draft the branch never saw',
  summary: 'from the lake',
}

const BRANCH_TITLE = 'Edited in the branch'

const OVERLAY_ACTIONS = ['overlayRebase', 'overlayResolveConflict', 'overlayCheckpoint']

/** `devtools.ts` — `window.__SANITY_OVERLAY__`, spelled once. */
const OVERLAY_DEVTOOLS_GLOBAL = '__SANITY_OVERLAY__'

/** The `context` sanity builds for the `document.actions` resolver. */
const ACTION_CONTEXT: Rec = {
  schemaType: 'article',
  documentId: LOGICAL_ID,
  versionType: 'draft',
  releaseId: undefined,
}

/**
 * `DocumentActionsProvider`, sanity 6.8.0 `lib/structureTool-EN0gOzyJ.js:2274` —
 * the ONE argument every document action receives. Note there is no `workspace`
 * in it, which is why the actions must find their runtime through the registry.
 */
const ACTION_PROPS: Rec = {
  id: LOGICAL_ID,
  type: 'article',
  draft: {_id: DRAFT_ID, _type: 'article', title: BRANCH_TITLE},
  published: null,
  liveEdit: false,
  ready: true,
  transactionSyncLock: null,
  version: undefined,
  release: undefined,
  revision: undefined,
  initialValueResolved: true,
  onComplete: () => {},
}

/* ═══════════════════════════════════════════════════ the loopback "lake" */

interface Lake {
  /** A BARE ORIGIN, as `apiHost` must be. */
  origin: string
  /** Every path the real `@sanity/client` asked for, in order. */
  requests: string[]
  close(): Promise<void>
}

/**
 * A loopback stand-in for the base dataset.
 *
 * `@sanity/client` builds `<protocol>//<projectId>.<apiHost>` when
 * `useProjectHostname` is on (its default, and the Studio's), so the URL it
 * dials is `http://b1n03q3z.localhost:<port>`. RFC 6761 makes every
 * `*.localhost` name resolve to loopback, which is why an ephemeral port and a
 * dual-stack listen are enough — no hosts-file entry, no DNS, no network.
 */
async function startLake(documents: readonly Rec[]): Promise<Lake> {
  const byId = new Map(documents.map((document) => [String(document._id), document]))
  const requests: string[] = []

  const server: Server = createServer((incoming, out) => {
    const path = incoming.url ?? '/'
    requests.push(path)
    const url = new URL(path, 'http://lake.invalid')

    const doc = /^\/v[^/]+\/data\/doc\/([^/]+)\/(.*)$/.exec(url.pathname)
    if (doc !== null) {
      const ids = decodeURIComponent(doc[2] as string).split(',')
      const found = ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
      out.writeHead(200, {'content-type': 'application/json'})
      out.end(JSON.stringify({documents: found}))
      return
    }
    if (/^\/v[^/]+\/data\/query\//.test(url.pathname)) {
      out.writeHead(200, {'content-type': 'application/json'})
      out.end(JSON.stringify({ms: 0, query: url.searchParams.get('query') ?? '', result: []}))
      return
    }
    /* Anything else the Studio's client probes for (identity, listeners) is
     * answered emptily rather than 404'd: a 404 would be indistinguishable from
     * a routing mistake in this file. */
    out.writeHead(200, {'content-type': 'application/json'})
    out.end(JSON.stringify({}))
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    origin: `http://localhost:${port}`,
    requests,
    async close() {
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    },
  }
}

/* ══════════════════════════════════════════════════════════ booting Studio */

/** Deterministic clock, so `snapshotRef`s differ because the CAPTURE differs. */
function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

interface Session {
  /** The temp directory that CONTAINS `.sanity-overlay/`. */
  root: string
  overlayUrl: string
  lake: Lake
  /** The default export of `examples/kitchen-sink/sanity.config.ts`. */
  workspace: Rec
  /** The three shipped components, from the package entry point. */
  shippedActions: readonly {action: string}[]
  /** The same three bound to a drivable React — see the header, note (a). */
  drivableActions: readonly SanityActionHook[]
  host: HookHost
  runtime: {
    refresh(): Promise<void>
    documents(): readonly Rec[]
    baseDocuments(ids: readonly string[]): Rec[]
  }
  /** A client built the way Studio builds one: through `unstable_clientFactory`. */
  client(): Rec
  /** An INDEPENDENT `GET /state`, made with bare `fetch`. */
  state(): Promise<{revision: number; documents: Rec[]}>
  readJson(...segments: string[]): Promise<Rec>
}

const cleanups: Array<() => Promise<void>> = []
const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

/**
 * Boot one complete Studio session over one fresh overlay.
 *
 * ORDER IS THE POINT. The overlay API and the lake come up first, the
 * environment is written second, and only then is the example config imported —
 * because `defineOverlayConfig` runs at module evaluation and reads
 * `process.env` once. `vi.resetModules()` in front of it is what makes a second
 * boot a genuinely second Studio rather than the first one's cached singleton
 * (`runtime.ts` holds a module-level workspace registry).
 */
async function boot(options: {lakeDocuments?: readonly Rec[]} = {}): Promise<Session> {
  vi.resetModules()

  const root = await mkdtemp(join(tmpdir(), 'studio-boot-smoke-'))
  cleanups.push(() => rm(root, {recursive: true, force: true}))

  const {startOverlayApiServer} = await import('../../sanity-overlay-next/src/index')
  const api = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: BASE_IDENTITY,
    source: SOURCE_IDENTITY,
  })
  cleanups.push(() => api.close())

  const lake = await startLake(options.lakeDocuments ?? [BASE_MOVED, BASE_DRAFT])
  cleanups.push(() => lake.close())

  /* A SECOND WRITER seeds the branch over real HTTP before this Studio exists,
   * so the session under test has never written anything. That is the state
   * defect 3 lived in: a fresh session whose echo had been fed only by commits
   * it made itself, and had therefore been fed nothing. */
  const seeded = await fetch(`${api.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify({
      idempotencyKey: 'smoke-seed-edit',
      kind: 'actions',
      payload: [
        {
          actionType: 'sanity.action.document.edit',
          draftId: DRAFT_ID,
          publishedId: LOGICAL_ID,
          patch: {set: {title: BRANCH_TITLE}},
        },
      ],
      baseDocuments: [BASE_PUBLISHED],
    }),
  })
  expect(seeded.status).toBe(200)

  /* ── the environment a developer would set, and nothing inherited ────────
   * The example hands `process.env` to `defineOverlayConfig` DELIBERATELY, so
   * that `assertNoWriteToken` can scan it. That makes the import sensitive to
   * whatever the shell happens to export, so a write-capable Sanity credential
   * in the developer's environment would abort the import for a reason that has
   * nothing to do with what is being measured. It is removed for the duration
   * and restored in `afterEach` — the same declaration-over-inheritance rule
   * `sanity.cli.ts` applies to the project identity. */
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase()
    if (!/(?:^|_)(?:TOKEN|SECRET|API_?KEY|CREDENTIALS?|PASSWORD|PAT)$/.test(upper)) continue
    if (!/(?:^|_)SANITY(?:$|_)/.test(upper) && !upper.endsWith('WRITE_TOKEN')) continue
    setEnv(key, undefined)
  }
  setEnv('SANITY_STUDIO_OVERLAY_MODE', 'fs')
  setEnv('SANITY_STUDIO_OVERLAY_API_URL', api.url)
  setEnv('SANITY_STUDIO_OVERLAY_API_HOST', lake.origin)

  /* THE REAL CONFIG FILE. Not a workspace this test wrote. */
  const configModule = await import('../../../examples/kitchen-sink/sanity.config')
  const workspace = configModule.default as unknown as Rec

  const {getOverlayRuntime} = await import('../../sanity-overlay-studio/src/runtime')
  const {OverlayDocumentActions} = await import('../../sanity-overlay-studio/src/index')
  const {createOverlayDocumentActions} = await import(
    '../../sanity-overlay-studio/src/ui/documentActions'
  )

  const runtime = getOverlayRuntime(String(workspace.name))
  if (runtime === undefined) {
    throw new Error('the example config registered no overlay runtime for its workspace')
  }

  const host = createHookHost()

  return {
    root,
    overlayUrl: api.url,
    lake,
    workspace,
    shippedActions: OverlayDocumentActions as unknown as readonly {action: string}[],
    drivableActions: createOverlayDocumentActions(
      host.react as never,
    ) as unknown as readonly SanityActionHook[],
    host,
    runtime: runtime as unknown as Session['runtime'],
    client: () =>
      (workspace.unstable_clientFactory as (options: Rec) => Rec)({
        projectId: PROJECT_ID,
        dataset: DATASET,
        apiVersion: API_VERSION,
        useCdn: false,
      }),
    async state() {
      const response = await fetch(`${api.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
      expect(response.status).toBe(200)
      return (await response.json()) as {revision: number; documents: Rec[]}
    },
    async readJson(...segments) {
      return JSON.parse(await readFile(join(root, '.sanity-overlay', ...segments), 'utf8')) as Rec
    },
  }
}

/**
 * Poll `GET /state` until it says what the caller is waiting for.
 *
 * Used only for writes the facade acknowledges optimistically. Polling an
 * INDEPENDENT endpoint is the point: waiting on anything the write path returned
 * would be waiting on the thing under test to declare itself finished.
 */
async function waitForState(
  session: Session,
  predicate: (entry: Rec) => boolean,
  failure: string,
): Promise<{revision: number; documents: Rec[]}> {
  const deadline = Date.now() + 10_000
  let last: {revision: number; documents: Rec[]} | null = null
  for (;;) {
    last = await session.state()
    const entry = last.documents.find((document) => document.logicalId === LOGICAL_ID)
    if (entry !== undefined && predicate(entry)) return last
    if (Date.now() > deadline) {
      throw new Error(`${failure} — last /state was ${JSON.stringify(last)}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
}

/** describe → click → re-describe → confirm, the way sanity 6.8.0 does it. */
async function clickAndConfirm(session: Session, action: string): Promise<void> {
  const hook = session.drivableActions.find((entry) => entry.action === action)
  if (hook === undefined) throw new Error(`no action named ${action} was delivered at all`)

  const [menuItem] = renderActionStates([hook], session.host, ACTION_PROPS)
  if (menuItem === undefined) throw new Error(`${action} rendered nothing at all`)
  if (menuItem.disabled === true) {
    throw new Error(`${action} is disabled: ${String(menuItem.title ?? '<no reason given>')}`)
  }
  if (typeof menuItem.onHandle !== 'function') {
    throw new Error(`${action} is enabled but carries no onHandle — a click would do nothing`)
  }
  ;(menuItem.onHandle as () => void)()

  const [opened] = renderActionStates([hook], session.host, ACTION_PROPS)
  const dialog = opened?.dialog
  if (dialog === undefined || dialog === false) {
    throw new Error(`clicking ${action} opened no dialog`)
  }
  await ((dialog as Rec).onConfirm as () => Promise<void>)()
}

/* ══════════════════════════════════════ 1. the wrong-import defect */

describe('the config a consumer actually ships delivers the §21.7 actions', () => {
  /**
   * DEFECT 1. `examples/kitchen-sink/sanity.config.ts` produced a workspace with
   * the §21.10 availability filter and none of the overlay's own actions, and a
   * real Studio rendered publish / Duplicate / Delete with nothing else. Every
   * test stayed green because every test built the action list itself.
   *
   * Nothing is handed in below. The file is imported, and sanity's own resolver
   * is asked what a Studio would end up with.
   */
  it('resolves rebase, resolve-conflict and checkpoint out of the real config file', async () => {
    const session = await boot()

    const resolved = resolveDocumentActions(session.workspace, ACTION_CONTEXT)
    const names = resolved.map((entry) => entry.action)

    expect(names).toEqual(expect.arrayContaining(OVERLAY_ACTIONS))

    /* ORACLE: not "three things with the right names", but the very objects the
     * package entry point exports — by reference, which is also how Studio's own
     * `useMemo` comparisons see them. A config that built its own lookalikes
     * would fail here. */
    for (const shipped of session.shippedActions) {
      expect(resolved).toContain(shipped)
    }
  })

  it('leaves the REAL structureTool built-ins in place and puts the overlay’s three last', async () => {
    const session = await boot()

    const names = resolveDocumentActions(session.workspace, ACTION_CONTEXT).map(
      (entry) => entry.action,
    )

    /* These come from the installed `sanity@6.8.0`, not from a transcription:
     * the example's `plugins: [structureTool()]` is the real plugin. */
    expect(names).toContain('publish')
    expect(names).toContain('duplicate')
    expect(names).toContain('delete')
    /* §21.10: hosted-only actions are removed rather than left clickable. */
    expect(names).not.toContain('schedule')
    /* Appended, never prepended — the first entry is Studio's primary button and
     * a destructive rebase must not be what a reflex press hits. */
    expect(names.slice(-3)).toEqual(OVERLAY_ACTIONS)
  })

  it('installs the client interception and the §21.3 banner on the same workspace', async () => {
    const session = await boot()

    /* Without this key nothing else in the package matters, and it is the one
     * key a `definePlugin` cannot set. */
    expect(typeof session.workspace.unstable_clientFactory).toBe('function')

    const studio = session.workspace.studio as Rec
    expect(typeof (studio.components as Rec).layout).toBe('function')

    /* The overlay plugin is appended after the consumer's, so the consumer's are
     * never displaced. */
    const plugins = session.workspace.plugins as Rec[]
    expect(plugins.length).toBeGreaterThanOrEqual(2)
    expect(String(plugins[plugins.length - 1]?.name)).toContain('overlay')
  })

  it('drives the same three components the shipped config installs', async () => {
    const session = await boot()

    /* The substitution named in the header, pinned rather than assumed: the
     * drivable components and the shipped ones are the same three, in the same
     * order, with the same keys. */
    expect(session.drivableActions.map((entry) => entry.action)).toEqual(
      session.shippedActions.map((entry) => entry.action),
    )
    expect(session.drivableActions).toHaveLength(session.shippedActions.length)
    expect(session.drivableActions.map((entry) => entry.action)).toEqual(OVERLAY_ACTIONS)
  })
})

/* ══════════════════════════════════ 2. the inert-action defect */

describe('clicking an overlay action changes bytes on disk', () => {
  /**
   * DEFECT 2. The overlay API refused any `POST /commit` whose `kind` was not
   * `actions` / `mutations` / `documentActions`, so `checkpoint` and `rebase`
   * answered 400 and the buttons did nothing. Every test was green because every
   * test invoked `onHandle()` against a mocked transport that could not 400.
   *
   * Below, the handler runs over a real socket to a real server over a real
   * store, and the answer is read off the filesystem.
   */
  it('Create checkpoint renders a tree a second, empty store can re-import', async () => {
    const session = await boot()
    await session.runtime.refresh()

    await clickAndConfirm(session, 'overlayCheckpoint')

    /* ORACLE 1 — the bytes. `checksums.json` is the §14.3 integrity file that
     * only a checkpoint render produces; it does not exist before one. */
    const checksums = await session.readJson('checksums.json')
    expect(typeof checksums.checksum).toBe('string')
    expect(String(checksums.checksum).length).toBeGreaterThan(0)

    /* ORACLE 2 — a SECOND, freshly constructed store re-imports the tree into an
     * empty overlay (§29.7). Nothing this Studio computed takes part in that
     * answer. */
    const {FsOverlayStore} = await import('../../sanity-overlay-store-fs/src/index')
    const freshRoot = await mkdtemp(join(tmpdir(), 'studio-boot-smoke-import-'))
    cleanups.push(() => rm(freshRoot, {recursive: true, force: true}))
    const fresh = new FsOverlayStore({root: freshRoot, now: makeClock()})
    const imported = await fresh.importCheckpoint(join(session.root, '.sanity-overlay'))

    expect(imported.overlayId).toBe(OVERLAY_ID)
    expect(imported.importedDocuments).toBe(1)
    expect(imported.issues).toEqual([])

    const roundTripped = JSON.parse(
      await readFile(
        join(freshRoot, '.sanity-overlay', 'documents', LOGICAL_ID, 'intent.json'),
        'utf8',
      ),
    ) as Rec
    expect(roundTripped.logicalId).toBe(LOGICAL_ID)
  })

  it('Rebase advances manifest.revision and rewrites intent.base.snapshotRef', async () => {
    const session = await boot({lakeDocuments: [BASE_MOVED]})
    await session.runtime.refresh()

    /* §16.1: the Studio holds the only Sanity credential, so it is the only
     * party that can state the current base. This is the read that gives it one
     * — the pair listener's snapshot, through the real client over real HTTP. */
    const client = session.client()
    await (client.getDocuments as (ids: string[]) => Promise<unknown>)([LOGICAL_ID, DRAFT_ID])
    expect(session.runtime.baseDocuments([LOGICAL_ID]).length).toBeGreaterThan(0)

    const manifestBefore = await session.readJson('manifest.json')
    const intentBefore = await session.readJson('documents', LOGICAL_ID, 'intent.json')
    const snapshotBefore = (intentBefore.base as Rec).snapshotRef

    await clickAndConfirm(session, 'overlayRebase')

    /* ORACLE 1 — the manifest on disk moved. */
    const manifestAfter = await session.readJson('manifest.json')
    expect(Number(manifestAfter.revision)).toBeGreaterThan(Number(manifestBefore.revision))

    /* ORACLE 2 — the canonical intent names a DIFFERENT base capture, and it is
     * the revision the lake is serving now rather than the one the branch forked
     * from. */
    const intentAfter = await session.readJson('documents', LOGICAL_ID, 'intent.json')
    expect((intentAfter.base as Rec).snapshotRef).not.toBe(snapshotBefore)
    expect((intentAfter.base as Rec).publishedRevision).toBe(BASE_MOVED._rev)

    /* ORACLE 3 — a separate `GET /state` round trip agrees with the bytes. */
    const state = await session.state()
    expect(state.revision).toBe(manifestAfter.revision)
    const entry = state.documents.find((document) => document.logicalId === LOGICAL_ID)
    expect(entry?.baseRevisionAtFirstTouch).toBe(BASE_MOVED._rev)
    /* §28.5 replaces the ancestor; it does not discard local intent. */
    expect((entry?.draft as Rec).title).toBe(BRANCH_TITLE)
  })

  /**
   * ═══ A LIVE DEFECT THIS FILE FOUND ON ITS FIRST RUN (2026-08-09) ═══════════
   *
   * `it.fails` — the assertion below states the CORRECT behaviour and is marked
   * as a known failure, so the suite stays green while the defect is on the
   * record. When somebody fixes it this test goes red demanding the marker be
   * removed, which is the behaviour a bug ledger should have and a comment does
   * not.
   *
   * WHAT IS WRONG. `api.ts:935` builds the current-base map as
   *
   *     currentBase.set(toPublishedId(document._id), document)
   *
   * so `drafts.article-1` and `article-1` collapse onto ONE key and the LAST
   * entry of `baseDocuments` wins. `runtime.baseDocuments()`
   * (`studio/src/runtime.ts:341-359`) deliberately emits both addresses, in the
   * order `[published, draft]` — §17.1's ancestor may be the base PUBLISHED
   * snapshot even when the branch edit lives on the draft — so in a real Studio
   * the base DRAFT always wins and always becomes "the current base".
   *
   * MEASURED, over real HTTP, on the same overlay, varying only array order:
   *
   *     [published, draft]  → 200 committed:false blockedBy:
   *                           ["base-changed-only-on-untouched-paths"]
   *     [draft, published]  → 200 committed:true  revision 1 → 2
   *     [draft]             → 200 committed:false, same blockage
   *
   * WHY IT MATTERS. Every document a person is editing in staging HAS a draft,
   * so this is the ordinary case, not an edge. The answer is `200 ok:true` with
   * `committed:false`, which is precisely the defect-2 shape all over again: the
   * button is enabled, the click is accepted, nothing changes and nothing says
   * so. `studio-operations-e2e.test.ts` misses it because its base client
   * answers `getDocuments` with the published document and `null` for the draft.
   *
   * FIXED 2026-08-09, and the `it.fails` marker removed with the fix — a marker
   * left on a passing test is a lie in the opposite direction, and the suite
   * fails loudly (`Expect test to fail`) precisely so it cannot be forgotten.
   *
   * The fix landed as `currentBaseForAncestor` / `hasAnyBaseAddress` in core,
   * imported by BOTH the API and the CLI so the two cannot answer differently,
   * selecting the address by the record's `ancestorKind` instead of collapsing
   * the pair. The class was swept: `toPublishedId` as a map key is safe when the
   * value is per-LOGICAL-DOCUMENT (a §13.3 record) or the id itself (a
   * membership Set), and wrong when the value is a per-ADDRESS document.
   * `api.ts` held the only value-is-a-document keying position; the CLI had the
   * mirror half, looking up only the published address and silently ignoring a
   * supplied base draft.
   */
  it(
    'rebases when the Studio has also read the base DRAFT — the ordinary case',
    async () => {
      const session = await boot({lakeDocuments: [BASE_MOVED, BASE_DRAFT]})
      await session.runtime.refresh()

      const client = session.client()
      await (client.getDocuments as (ids: string[]) => Promise<unknown>)([LOGICAL_ID, DRAFT_ID])
      /* Both addresses, published first — exactly what the pair listener causes. */
      expect(session.runtime.baseDocuments([LOGICAL_ID]).map((d) => d._id)).toEqual([
        LOGICAL_ID,
        DRAFT_ID,
      ])

      const before = await session.readJson('manifest.json')
      await clickAndConfirm(session, 'overlayRebase')
      const after = await session.readJson('manifest.json')

      expect(Number(after.revision)).toBeGreaterThan(Number(before.revision))
    },
  )

  it('refuses visibly rather than silently when the Studio has read no current base', async () => {
    const session = await boot()
    await session.runtime.refresh()
    /* NO base read: nothing in this session has opened the document pane. */

    const hook = session.drivableActions.find((entry) => entry.action === 'overlayRebase')
    const [menuItem] = renderActionStates([hook as SanityActionHook], session.host, ACTION_PROPS)

    /* Disabled WITH A REASON is acceptable. Enabled-and-inert is the defect. */
    expect(menuItem?.disabled).toBe(true)
    expect(String(menuItem?.title ?? '')).toMatch(/current base/i)
    expect(menuItem?.onHandle).toBeUndefined()
  })
})

/* ══════════════════════════════════════ 3. the form-read defect */

describe('the edit form opens on the branch, not on the base', () => {
  /**
   * DEFECT 3. The list panes read GROQ (overlay-aware, tested); the edit form
   * does not. sanity 6.8.0 fetches the form's opening value with
   * `client.observable.getDocuments([publishedId, draftId])`
   * (`lib/datastores-DqFH7RLd.js:1720`). Only the COMMIT feed seeded the echo, so
   * a session that had not yet written anything opened the form on base content
   * and merged the editor's work against an ancestor they were never shown.
   *
   * The branch here was written by somebody else before this Studio started, so
   * the only thing that can seed the echo is `/state` hydration.
   */
  it('getDocuments returns what GET /state reports, not what the lake serves', async () => {
    const session = await boot()
    await session.runtime.refresh()

    const client = session.client()
    const pair = (await (client.getDocuments as (ids: string[]) => Promise<unknown>)([
      LOGICAL_ID,
      DRAFT_ID,
    ])) as Array<Rec | null>

    /* ORACLE 1 — an independent `GET /state`, fetched with bare `fetch` from a
     * connection this client knows nothing about. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === LOGICAL_ID)
    const branchDraft = entry?.draft as Rec

    expect(branchDraft).toBeDefined()
    expect(pair[1]).toEqual(branchDraft)

    /* ORACLE 2 — NON-VACUITY. The lake really did answer, really did answer
     * something else, and the form did not get it. Without this the assertion
     * above would also pass if the two happened to agree. */
    expect(session.lake.requests.some((path) => path.includes('/data/doc/'))).toBe(true)
    const lakeAnswer = await fetch(
      `${session.lake.origin}/v${API_VERSION}/data/doc/${DATASET}/${DRAFT_ID}`,
    )
    const lakeDraft = ((await lakeAnswer.json()) as {documents: Rec[]}).documents[0] as Rec
    expect(lakeDraft.title).toBe(BASE_DRAFT.title)
    expect(String(branchDraft.title)).not.toBe(String(lakeDraft.title))
    expect((pair[1] as Rec).title).toBe(BRANCH_TITLE)
  })

  it('keeps the base body as the merge ancestor even though the form shows the branch', async () => {
    const session = await boot()
    await session.runtime.refresh()

    const client = session.client()
    await (client.getDocuments as (ids: string[]) => Promise<unknown>)([LOGICAL_ID, DRAFT_ID])

    /* The substituted value is what the FORM sees; the raw one is what a §17
     * rebase needs. Both must survive the same call, or the rebase silently
     * makes the overlay its own ancestor. */
    const ancestors = session.runtime.baseDocuments([LOGICAL_ID])
    const published = ancestors.find((document) => document._id === LOGICAL_ID)
    expect(published?._rev).toBe(BASE_MOVED._rev)
    expect(published?.summary).toBe(BASE_MOVED.summary)
  })

  it('shows the branch in the list panes and the form at the same time', async () => {
    const session = await boot()
    await session.runtime.refresh()

    /* The two read paths that disagreed. `documents()` is what feeds the GROQ
     * source the list panes read; `getDocuments` is what the form opens with.
     * Asserting them equal to each other would be the tautology the original
     * tests fell into, so each is compared against the same independent
     * `GET /state` answer. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === LOGICAL_ID)

    const listPaneView = session.runtime
      .documents()
      .find((document) => document.logicalId === LOGICAL_ID)
    expect((listPaneView?.draft as Rec)?.title).toBe((entry?.draft as Rec)?.title)

    const client = session.client()
    const pair = (await (client.getDocuments as (ids: string[]) => Promise<unknown>)([
      LOGICAL_ID,
      DRAFT_ID,
    ])) as Array<Rec | null>
    expect((pair[1] as Rec).title).toBe((entry?.draft as Rec)?.title)
  })
})

/* ══════════════════════════════ 4. the cheap seams, taken while we are here */

/**
 * Everything below is a seam that a PURE test already covers as a decision and
 * that nothing covered as WIRING until this file booted. Each one costs a few
 * lines given a session that already exists, which is the whole argument for
 * putting them here rather than leaving them on the residual-risk list.
 */
describe('the seams a booted Studio makes cheap to check', () => {
  it('installs the devtools global, and it agrees with GET /state', async () => {
    const session = await boot()
    await session.runtime.refresh()

    /* `config.ts` installs this onto `globalThis` (which is `window` in the
     * Studio bundle) whenever the overlay is on. `studio-devtools.test.ts`
     * proves the VIEW is correct when handed a runtime; nothing proved the real
     * config ever installs it. */
    const devtools = (globalThis as Rec)[OVERLAY_DEVTOOLS_GLOBAL] as Rec | undefined
    expect(devtools).toBeDefined()

    const config = (devtools?.config as () => Rec)()
    expect(config.apiUrl).toBe(session.overlayUrl)
    expect(config.mode).toBe('fs')

    /* ORACLE: the number comes from a separate HTTP round trip, not from the
     * object being interrogated. */
    const state = await session.state()
    const branch = (devtools?.branch as () => Rec)()
    expect(branch.revision).toBe(state.revision)
    expect(branch.documents as string[]).toContain(DRAFT_ID)
    expect((devtools?.status as () => Rec)().state).toBe('healthy')
  })

  it('carries the §21.10 hosted-feature switches on the workspace itself', async () => {
    const session = await boot()
    for (const flag of ['tasks', 'releases', 'scheduledDrafts', 'scheduledPublishing']) {
      expect(session.workspace[flag], flag).toEqual({enabled: false})
    }
    expect((session.workspace.document as Rec).comments).toEqual({enabled: false})
  })

  it('reports the §28.3 conflict channel as PRESENT rather than absent', async () => {
    const session = await boot()
    await session.runtime.refresh()

    /* WHY THIS IS WORTH A TEST. §5.5 forbids reading silence as "clean", so
     * `readConflictReport` answers "unknown" when the API reports no `conflicts`
     * key at all — and `studio-document-action-delivery.test.ts` records, as of
     * its writing, that the shipped `hydrationDocuments()` projection omitted
     * one, which made the whole §28.3 panel unreachable from a real server. It
     * does not omit one any more (`api.ts:362`). This pins the channel as live
     * so the panel's reachability is a measured fact rather than a stale note. */
    const state = await session.state()
    const entry = state.documents.find((document) => document.logicalId === LOGICAL_ID)
    expect(entry).toBeDefined()
    expect(Array.isArray(entry?.conflicts)).toBe(true)

    const report = (session.runtime as unknown as {conflicts(): Rec}).conflicts()
    expect(report.available).toBe(true)
    expect((report.summary as Rec).hard).toBe((entry?.conflicts as unknown[]).length)
  })

  it('sends an edit made through the real client to the overlay and never to the lake', async () => {
    const session = await boot()
    await session.runtime.refresh()

    const client = session.client()
    /* Open the pane first. Nobody edits a document they have not opened, and the
     * echo learns the document's current revision from exactly this read. */
    await (client.getDocuments as (ids: string[]) => Promise<unknown>)([LOGICAL_ID, DRAFT_ID])
    const before = session.lake.requests.length

    /* A REAL `@sanity/client` patch, through the real facade. The write plane is
     * the one seam `studio-facade` / `studio-write-guard` / `studio-echo` all
     * describe and none of them cross. */
    const result = (await (
      client.patch as (id: string) => {
        set(value: Rec): {commit(): Promise<Rec>}
      }
    )(DRAFT_ID)
      .set({summary: 'written through the wrapped client'})
      .commit()) as Rec
    expect(typeof result.transactionId).toBe('string')

    /* THE ANSWER IS OPTIMISTIC AND SAYS SO. `facade.ts:660-663` hands back
     * `{transactionId, documentIds: [], results: []}` immediately and runs
     * `persistAndEcho` detached — the editor must not wait on a round trip to
     * see their own keystroke. Durability therefore has to be observed, not
     * inferred from the return value, which is the whole reason this test polls
     * an independent oracle instead of asserting on `result`. */
    const state = await waitForState(
      session,
      (entry) => (entry.draft as Rec)?.summary === 'written through the wrapped client',
      'the wrapped client’s patch never reached the overlay API',
    )

    /* ORACLE 1 — the bytes. */
    const intent = await session.readJson('documents', LOGICAL_ID, 'intent.json')
    expect(JSON.stringify(intent)).toContain('written through the wrapped client')

    /* ORACLE 2 — the independent `GET /state` the poll above settled on. */
    const entry = state.documents.find((document) => document.logicalId === LOGICAL_ID)
    expect((entry?.draft as Rec).summary).toBe('written through the wrapped client')
    /* …and the branch edit that was already there survived. */
    expect((entry?.draft as Rec).title).toBe(BRANCH_TITLE)

    /* ORACLE 3 — the lake's own request log. The write never left for the base
     * dataset: `@sanity/client` would have issued `POST /data/mutate/<ds>`. */
    const afterWrite = session.lake.requests.slice(before)
    expect(afterWrite.filter((path) => path.includes('/data/mutate/'))).toEqual([])
  })
})
