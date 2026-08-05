/**
 * Change detection — "when the overlay changes on disk, the next render must
 * reflect it" (roadmap Phase 3 "local API and client").
 *
 * Two mechanisms, both named rather than implicit, because a later Next.js port
 * substitutes for them one for one:
 *
 *   - a cache keyed on the overlay's change token, refreshed by a cheap probe
 *     (the ISR / `revalidate` window);
 *   - {@link OverlayClient.revalidate}, the explicit trigger
 *     (`revalidateTag(OVERLAY_CACHE_TAG)`).
 *
 * The load-bearing property is asserted against a SECOND commit written by the
 * real store after the client has already answered a read: a client that cached
 * forever, or that re-read but ignored the overlay, fails here.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  OVERLAY_CACHE_TAG,
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createOverlayClient,
  seedOverlay,
} from '../../sanity-overlay-client/src/index'
import type {OverlayStateLoader} from '../../sanity-overlay-client/src/index'
import {loadFixtureDataset, publishedPerspective, type FixtureDocument} from '../src/fixtures'

const BASE: FixtureDocument[] = publishedPerspective(loadFixtureDataset()).filter(
  (doc) => doc._type === 'author' || ['article-01', 'article-02'].includes(doc._id),
)

const FIRST_TITLE = 'First branch title'
const SECOND_TITLE = 'Second branch title'

let root: string
let tick: number

const clock = () => {
  tick += 1
  return new Date(Date.UTC(2026, 7, 4, 12, 0, 0) + tick * 1000).toISOString()
}

async function editTitle(title: string): Promise<void> {
  await seedOverlay({
    root,
    baseDocuments: BASE,
    now: clock,
    edits: [{kind: 'edit', id: 'article-01', operations: [{type: 'set', path: ['title'], value: title}]}],
  })
}

beforeEach(async () => {
  tick = 0
  root = await mkdtemp(join(tmpdir(), 'overlay-client-revalidate-'))
  await editTitle(FIRST_TITLE)
})

afterEach(async () => {
  if (root) await rm(root, {recursive: true, force: true})
})

const titleOf = (client: {fetch: (id: string, params?: Record<string, unknown>) => Promise<unknown>}) =>
  client
    .fetch('article-by-slug', {slug: 'article-1'})
    .then((value) => (value as {title: string}).title)

describe('overlay change detection', () => {
  it('reflects a later on-disk commit on the next read', async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
    })

    expect(await titleOf(client)).toBe(FIRST_TITLE)

    await editTitle(SECOND_TITLE)

    expect(await titleOf(client)).toBe(SECOND_TITLE)
  })

  it('serves the cached view while the overlay is unchanged', async () => {
    let loads = 0
    let probes = 0
    const fsLoader = createFsOverlayStateLoader({root})
    const counting: OverlayStateLoader = {
      load: async () => {
        loads += 1
        return await fsLoader.load()
      },
      probe: async () => {
        probes += 1
        return await fsLoader.probe()
      },
    }
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: counting,
      perspective: 'drafts',
    })

    await titleOf(client)
    await titleOf(client)
    await titleOf(client)

    /* Three reads, one materialisation: the cache is real, and the probe is what
     * keeps it honest. */
    expect(loads).toBe(1)
    expect(probes).toBeGreaterThanOrEqual(2)
  })

  it('pins the view until revalidate() when autoRevalidate is off', async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
      autoRevalidate: false,
    })

    expect(await titleOf(client)).toBe(FIRST_TITLE)
    await editTitle(SECOND_TITLE)

    /* Deliberately stale — this is the deployment model where an external
     * trigger, not a probe, decides when the page rebuilds. */
    expect(await titleOf(client)).toBe(FIRST_TITLE)

    client.revalidate()

    expect(await titleOf(client)).toBe(SECOND_TITLE)
  })

  it('revalidate() drops the cached view even when auto-revalidation is on', async () => {
    let loads = 0
    const fsLoader = createFsOverlayStateLoader({root})
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: {
        load: async () => {
          loads += 1
          return await fsLoader.load()
        },
        probe: () => fsLoader.probe(),
      },
      perspective: 'drafts',
    })

    await titleOf(client)
    expect(loads).toBe(1)

    client.revalidate()
    await titleOf(client)

    expect(loads).toBe(2)
  })

  it('reports the overlay revision advancing with each commit', async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
    })

    const before = await client.overlayRevision()
    await editTitle(SECOND_TITLE)
    const after = await client.overlayRevision()

    expect(before).not.toBeNull()
    expect(after).toBeGreaterThan(before as number)
  })

  it('watch() revalidates before notifying the subscriber', async () => {
    const events: string[] = []
    let trigger: (() => void) | null = null
    let loads = 0
    const fsLoader = createFsOverlayStateLoader({root})

    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: {
        load: async () => {
          loads += 1
          events.push('load')
          return await fsLoader.load()
        },
        probe: () => fsLoader.probe(),
        watch: (onChange) => {
          trigger = onChange
          return () => {
            trigger = null
          }
        },
      },
      perspective: 'drafts',
      autoRevalidate: false,
    })

    const stop = client.watch(() => events.push('subscriber'))
    await titleOf(client)
    expect(loads).toBe(1)
    expect(trigger).toBeTypeOf('function')

    await editTitle(SECOND_TITLE)
    ;(trigger as unknown as () => void)()
    events.push('notified')
    stop()

    expect(await titleOf(client)).toBe(SECOND_TITLE)
    /* The reload happened because of the notification, not before it. */
    expect(events).toEqual(['load', 'subscriber', 'notified', 'load'])
  })

  it('watch() on the filesystem loader fires for a real on-disk commit', {timeout: 20_000}, async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root, watchDebounceMs: 5}),
      perspective: 'drafts',
      autoRevalidate: false,
    })
    await titleOf(client)

    let notifications = 0
    const stop = client.watch(() => {
      notifications += 1
    })
    try {
      await editTitle(SECOND_TITLE)
      const deadline = Date.now() + 10_000
      while (notifications === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      expect(notifications).toBeGreaterThan(0)
      expect(await titleOf(client)).toBe(SECOND_TITLE)
    } finally {
      stop()
    }
  })

  it("mode: 'off' never subscribes and never revalidates", () => {
    let watched = 0
    const client = createOverlayClient({
      mode: 'off',
      base: createDocumentBaseSource(BASE),
      overlay: {
        load: () => {
          throw new Error('overlay was read in mode: off')
        },
        probe: () => {
          throw new Error('overlay was probed in mode: off')
        },
        watch: () => {
          watched += 1
          return () => {}
        },
      },
      perspective: 'drafts',
    })

    const stop = client.watch(() => {})
    client.revalidate()
    stop()

    expect(watched).toBe(0)
  })

  it('names the cache tag a Next.js port would revalidate', () => {
    expect(OVERLAY_CACHE_TAG).toBe('sanity-overlay')
  })
})

/* ------------------------------------------------------------------ *
 * Regression: repeated seeding must not replay (PRD §34.6)
 * ------------------------------------------------------------------ *
 *
 * Found by the first red run above. `seedOverlay` derived its idempotency key
 * from a per-call counter alone, so a SECOND call reused the FIRST call's key,
 * the store correctly replayed the original transaction, and the new edits
 * silently never landed — a change-detection test that could never go green.
 *
 * The class of the bug is "a generated key that is unique within a call but not
 * across calls", so every edit kind that generates one is covered here, not just
 * the `edit` that happened to expose it.
 */
describe('seedOverlay key generation', () => {
  it('advances the revision on every successive call, for every edit kind', async () => {
    const revisions: number[] = []

    const first = await seedOverlay({
      root,
      baseDocuments: BASE,
      now: clock,
      edits: [{kind: 'edit', id: 'article-01', operations: [{type: 'set', path: ['title'], value: 'A'}]}],
    })
    revisions.push(first.revision)

    const second = await seedOverlay({
      root,
      baseDocuments: BASE,
      now: clock,
      edits: [{kind: 'edit', id: 'article-01', operations: [{type: 'set', path: ['title'], value: 'B'}]}],
    })
    revisions.push(second.revision)

    const third = await seedOverlay({
      root,
      baseDocuments: BASE,
      now: clock,
      edits: [
        {
          kind: 'create',
          document: {
            _id: 'drafts.article-seeded',
            _type: 'article',
            title: 'Seeded',
            slug: {_type: 'slug', current: 'seeded'},
          },
        },
      ],
    })
    revisions.push(third.revision)

    const fourth = await seedOverlay({
      root,
      baseDocuments: BASE,
      now: clock,
      edits: [{kind: 'delete', id: 'article-02'}],
    })
    revisions.push(fourth.revision)

    /* Strictly increasing: a replayed transaction leaves the revision alone. */
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)

    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
    })
    /* The LAST write of each kind is the one that survived. */
    expect(await titleOf(client)).toBe('B')
    const list = await client.fetch<{_id: string}[]>('article-type-list')
    expect(list.map((entry) => entry._id)).toContain('article-seeded')
    expect(list.map((entry) => entry._id)).not.toContain('article-02')
  })

  /* ---------------------------------------------------------------- *
   * Regression: re-running the same seed must not throw
   * ---------------------------------------------------------------- *
   *
   * Found by running `examples/local-site/seed.mjs` twice: the second run died
   * with OVERLAY_DOCUMENT_ALREADY_EXISTS, because `create` is strict by design
   * (PRD §35.4) and a demo script re-run is exactly the case that hits it.
   *
   * The class is "seed edit kinds that are not re-runnable", so all of them are
   * covered here, and the strictness of `create` itself is asserted rather than
   * relaxed — the fix is a new kind, not a weakened one.
   */
  const rerunnableEdits = [
    {kind: 'edit', id: 'article-01', operations: [{type: 'set', path: ['title'], value: 'Re-run'}]},
    {
      kind: 'createOrReplace',
      document: {
        _id: 'drafts.article-rerun',
        _type: 'article',
        title: 'Re-runnable',
        slug: {_type: 'slug', current: 'rerun'},
      },
    },
    {kind: 'delete', id: 'article-02'},
  ] as const

  it('applies every re-runnable edit kind twice without failing', async () => {
    await seedOverlay({root, baseDocuments: BASE, now: clock, edits: [...rerunnableEdits]})

    await expect(
      seedOverlay({root, baseDocuments: BASE, now: clock, edits: [...rerunnableEdits]}),
    ).resolves.toMatchObject({affectedDocumentIds: expect.any(Array)})

    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
    })
    expect(await titleOf(client)).toBe('Re-run')
    const list = await client.fetch<{_id: string}[]>('article-type-list')
    expect(list.map((entry) => entry._id)).toContain('article-rerun')
    expect(list.map((entry) => entry._id)).not.toContain('article-02')
  })

  it('keeps `create` strict, so a genuine duplicate is still refused', async () => {
    const create = {
      kind: 'create' as const,
      document: {
        _id: 'drafts.article-strict',
        _type: 'article',
        title: 'Once only',
        slug: {_type: 'slug', current: 'once-only'},
      },
    }

    await seedOverlay({root, baseDocuments: BASE, now: clock, edits: [create]})

    await expect(
      seedOverlay({root, baseDocuments: BASE, now: clock, edits: [create]}),
    ).rejects.toMatchObject({code: 'OVERLAY_DOCUMENT_ALREADY_EXISTS'})
  })
})
