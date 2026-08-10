/**
 * Explicit revalidation — the code path a Vercel/Blob deployment depends on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `OverlayClient.revalidate()` is documented as the substitution point for
 * `revalidateTag(OVERLAY_CACHE_TAG)`, and `examples/local-site` exposes it as
 * `POST /revalidate`. Neither had ever run in the configuration a deployment
 * would actually use:
 *
 *   - every existing case calls `site.handle()` in process. The socket, the
 *     `node:http` adapter and the route table that a Vercel route handler stands
 *     in for were never crossed.
 *   - and, decisively, the shipped example COULD NOT BE STARTED in that
 *     configuration. `createSiteClient` never passed `autoRevalidate`, so the
 *     client probed the overlay before every read; `run.mjs` also attached the
 *     filesystem watcher. Two independent mechanisms kept the page fresh, so
 *     `/revalidate` was dead code in the only configuration the example had.
 *     A path nobody can run is a path nobody can find broken.
 *
 * WHAT IS ASSERTED, AND WITH WHAT ORACLE
 * Every read below is a real HTTP GET against a listening socket, and every
 * change to the branch is written by the real store through `seedOverlay` —
 * never by a double standing in for it. Staleness is asserted POSITIVELY (the
 * page must still show the old title) before revalidation is asserted to fix
 * it: a cache that was never populated would make the second half pass for the
 * wrong reason, which is exactly how a dead path stays green.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createOverlayClient,
  overlayClientConfigFromEnv,
  seedOverlay,
} from '../../sanity-overlay-client/src/index'
import type {OverlayClient} from '../../sanity-overlay-client/src/index'
import {startLocalSite} from '../../../examples/local-site/src/server'
import type {RunningLocalSite} from '../../../examples/local-site/src/server'
import {createSiteClient} from '../../../examples/local-site/src/createClient'
import {SITE_QUERIES} from '../../../examples/local-site/src/queries'
import {loadFixtureDataset, publishedPerspective, type FixtureDocument} from '../src/fixtures'

const BASE: FixtureDocument[] = publishedPerspective(loadFixtureDataset()).filter(
  (doc) => doc._type === 'author' || ['article-01', 'article-02'].includes(doc._id),
)

const FIRST = 'Title before the deploy'
const SECOND = 'Title written while the site was running'

const roots: string[] = []
const sites: RunningLocalSite[] = []

afterEach(async () => {
  for (const site of sites.splice(0)) await site.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function clock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 7, 4, 12, 0, 0) + tick * 1000).toISOString()
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-site-revalidate-'))
  roots.push(root)
  return root
}

async function writeTitle(root: string, title: string): Promise<void> {
  await seedOverlay({
    root,
    baseDocuments: BASE,
    now: clock(),
    edits: [
      {kind: 'edit', id: 'article-01', operations: [{type: 'set', path: ['title'], value: title}]},
    ],
  })
}

function client(root: string, options: {autoRevalidate: boolean}): OverlayClient {
  return createOverlayClient({
    mode: 'fs',
    base: createDocumentBaseSource(BASE),
    overlay: createFsOverlayStateLoader({root}),
    queries: SITE_QUERIES,
    perspective: 'drafts',
    caller: 'frontend',
    autoRevalidate: options.autoRevalidate,
  })
}

async function serve(
  root: string,
  options: {autoRevalidate: boolean; watch: boolean},
): Promise<RunningLocalSite> {
  const site = await startLocalSite({
    client: client(root, {autoRevalidate: options.autoRevalidate}),
    port: 0,
    watch: options.watch,
  })
  sites.push(site)
  return site
}

/** A real HTTP GET. The body is the page a reader would see. */
async function get(site: RunningLocalSite, path = '/'): Promise<{status: number; body: string}> {
  const response = await fetch(`${site.url}${path}`)
  return {status: response.status, body: await response.text()}
}

async function revalidate(site: RunningLocalSite): Promise<number> {
  const response = await fetch(`${site.url}/revalidate`, {method: 'POST'})
  await response.text()
  return response.status
}

/* ================================================================== *
 * The deployment path, over a socket
 * ================================================================== */

describe('POST /revalidate over real HTTP', () => {
  it('serves genuinely stale HTML until it is called, then serves the new content', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)
    /* The deployment shape: no watcher, no probe. Something external decides
     * when the page rebuilds — `revalidateTag` there, this route here. */
    const site = await serve(root, {autoRevalidate: false, watch: false})

    const first = await get(site)
    expect(first.status).toBe(200)
    expect(first.body).toContain(FIRST)

    await writeTitle(root, SECOND)

    /* THE HALF THAT MATTERS. If this page had already changed, the assertion
     * below would prove nothing: there would be no cache for `/revalidate` to
     * clear, and a `revalidate()` that did nothing at all would still pass. */
    const stale = await get(site)
    expect(stale.body).toContain(FIRST)
    expect(stale.body).not.toContain(SECOND)

    expect(await revalidate(site)).toBe(204)

    const fresh = await get(site)
    expect(fresh.body).toContain(SECOND)
    expect(fresh.body).not.toContain(FIRST)
  })

  it('moves the reported overlay revision, not just the rendered title', async () => {
    /* The footer prints the revision the page was rendered from. A cache that
     * re-queried but kept a stale snapshot would still show the new title if
     * the base happened to match; the revision cannot be faked that way. */
    const root = await makeRoot()
    await writeTitle(root, FIRST)
    const site = await serve(root, {autoRevalidate: false, watch: false})

    const before = /overlay revision: (\d+)/.exec((await get(site)).body)
    expect(before).not.toBeNull()

    await writeTitle(root, SECOND)
    expect((await get(site)).body).toContain(`overlay revision: ${(before as RegExpExecArray)[1]}`)

    await revalidate(site)

    const after = /overlay revision: (\d+)/.exec((await get(site)).body)
    expect(Number((after as RegExpExecArray)[1])).toBeGreaterThan(
      Number((before as RegExpExecArray)[1]),
    )
  })

  it('refuses a GET on the route, so a crawler cannot flush the cache', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)
    const site = await serve(root, {autoRevalidate: false, watch: false})

    const response = await fetch(`${site.url}/revalidate`)
    await response.text()
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  /**
   * WHY THE PATH WAS NEVER EXERCISED, as an executable statement.
   *
   * With the watcher on — which is how `run.mjs` starts the site — the page
   * refreshes itself and nobody ever calls `/revalidate`. That is not a bug; it
   * is a different deployment model. It is recorded here so the reason the
   * route went unrun is a test rather than a claim in a commit message.
   */
  it('is masked by the filesystem watcher, which is why nobody ever called it', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)
    const site = await serve(root, {autoRevalidate: false, watch: true})

    expect((await get(site)).body).toContain(FIRST)
    await writeTitle(root, SECOND)

    const deadline = Date.now() + 10_000
    let body = ''
    while (Date.now() < deadline) {
      body = (await get(site)).body
      if (body.includes(SECOND)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(body).toContain(SECOND)
  }, 20_000)
})

/* ================================================================== *
 * The example has to be startable in that configuration
 * ================================================================== */

describe('the shipped example can be configured for explicit revalidation', () => {
  const ENV = {
    SANITY_OVERLAY_MODE: 'fs',
    SANITY_OVERLAY_PERSPECTIVE: 'drafts',
  } as const

  it('reads the revalidation model from the environment, like every other setting', () => {
    expect(
      overlayClientConfigFromEnv({...ENV, SANITY_OVERLAY_ROOT: '/tmp/x'}).autoRevalidate,
    ).toBe(true)
    expect(
      overlayClientConfigFromEnv({
        ...ENV,
        SANITY_OVERLAY_ROOT: '/tmp/x',
        SANITY_OVERLAY_REVALIDATE: 'explicit',
      }).autoRevalidate,
    ).toBe(false)
    expect(
      overlayClientConfigFromEnv({
        ...ENV,
        SANITY_OVERLAY_ROOT: '/tmp/x',
        SANITY_OVERLAY_REVALIDATE: 'auto',
      }).autoRevalidate,
    ).toBe(true)
  })

  it('refuses a value it does not understand rather than picking a model', () => {
    /* Same ruling as `OVERLAY_MODE`: a misspelling that silently selected the
     * OTHER model would give a deployment a page that never updates, or one
     * that re-reads on every request, with nothing said about it. */
    expect(() =>
      overlayClientConfigFromEnv({
        ...ENV,
        SANITY_OVERLAY_ROOT: '/tmp/x',
        SANITY_OVERLAY_REVALIDATE: 'on-demand',
      }),
    ).toThrow(/OVERLAY_REVALIDATE/)
  })

  it('builds a client that actually serves stale content under that setting', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)

    const {client: configured} = createSiteClient({
      SANITY_OVERLAY_MODE: 'fs',
      SANITY_OVERLAY_ROOT: root,
      SANITY_OVERLAY_PERSPECTIVE: 'drafts',
      SANITY_OVERLAY_REVALIDATE: 'explicit',
    })

    const titleOf = async (): Promise<string> =>
      (await configured.fetch<{title: string}>('article-by-slug', {slug: 'article-1'})).title

    expect(await titleOf()).toBe(FIRST)
    await writeTitle(root, SECOND)
    expect(await titleOf()).toBe(FIRST)

    configured.revalidate()
    expect(await titleOf()).toBe(SECOND)
  })

  it('still probes by default, so the documented default is unchanged', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)

    const {client: configured} = createSiteClient({
      SANITY_OVERLAY_MODE: 'fs',
      SANITY_OVERLAY_ROOT: root,
      SANITY_OVERLAY_PERSPECTIVE: 'drafts',
    })

    const titleOf = async (): Promise<string> =>
      (await configured.fetch<{title: string}>('article-by-slug', {slug: 'article-1'})).title

    expect(await titleOf()).toBe(FIRST)
    await writeTitle(root, SECOND)
    expect(await titleOf()).toBe(SECOND)
  })

  it('says which model it is running in, so the banner cannot mislead', async () => {
    const root = await makeRoot()
    await writeTitle(root, FIRST)

    const explicit = createSiteClient({
      SANITY_OVERLAY_MODE: 'fs',
      SANITY_OVERLAY_ROOT: root,
      SANITY_OVERLAY_REVALIDATE: 'explicit',
    })
    const auto = createSiteClient({SANITY_OVERLAY_MODE: 'fs', SANITY_OVERLAY_ROOT: root})

    expect(explicit.summary).toMatch(/revalidate=explicit/)
    expect(auto.summary).toMatch(/revalidate=auto/)
  })
})
