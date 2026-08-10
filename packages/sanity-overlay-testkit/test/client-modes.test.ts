/**
 * `sanity-overlay-client` — the environment-aware read client (roadmap Phase 3
 * "local API and client", PRD §37 Phase 2, §9.2 `mode`, §11.1).
 *
 * WHAT THESE TESTS ARE FOR
 * The defect this package exists to fix is an *overlay-blind read*: a site that
 * queries the base dataset and renders staging content while the branch overlay
 * on disk says something else. Every assertion below is written so that it FAILS
 * if the client ignores `.sanity-overlay/`:
 *
 *   - a locally edited document must render its BRANCH title, not the base one;
 *   - a branch-created document must APPEAR, though no base fetch can select it;
 *   - a tombstoned document must be ABSENT, not stale.
 *
 * The oracle is never a value this code just computed: the branch values are
 * literals declared here, the base values come from the committed fixture
 * dataset, and the two are deliberately different strings.
 *
 * The overlay under test is written by the real `FsOverlayStore` through the
 * real core mutation engine — the same path the Studio write interceptor takes —
 * so these are reads of an overlay a Studio could actually have produced.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createOverlayClient,
  overlayClientConfigFromEnv,
  seedOverlay,
} from '../../sanity-overlay-client/src/index'
import type {
  OverlayClientBaseSource,
  OverlayStateLoader,
} from '../../sanity-overlay-client/src/index'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {OverlayQueryError} from '../../sanity-overlay-query/src/index'
import {loadFixtureDataset, publishedPerspective, type FixtureDocument} from '../src/fixtures'

/* ------------------------------------------------------------------ *
 * Base dataset — "staging". Never written to by anything in this file.
 * ------------------------------------------------------------------ */

const BASE: FixtureDocument[] = publishedPerspective(loadFixtureDataset()).filter(
  (doc) =>
    doc._type === 'author' ||
    ['article-01', 'article-02', 'article-03'].includes(doc._id) ||
    doc._id === 'page-home',
)

const baseDoc = (id: string): FixtureDocument => {
  const doc = BASE.find((d) => d._id === id)
  if (!doc) throw new Error(`fixture base is missing ${id}`)
  return doc
}

/** The base titles, read out of the fixture rather than restated. */
const BASE_TITLE_01 = baseDoc('article-01').title as string
const BASE_TITLE_02 = baseDoc('article-02').title as string

/* Branch values: literals, chosen so they cannot coincide with a base value. */
const BRANCH_TITLE_01 = 'Article 1 — BRANCH EDIT ✅ 日本語'
const BRANCH_CREATED_ID = 'article-branch-1'
const BRANCH_CREATED_TITLE = 'Branch-created article'
const TOMBSTONED_ID = 'article-02'

let root: string

/** Deterministic clock: no wall time inside a fixture (plan §8.6). */
function fixedClock(startMs = Date.UTC(2026, 7, 4, 12, 0, 0)): () => string {
  let tick = 0
  return () => new Date(startMs + tick++ * 1000).toISOString()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'overlay-client-modes-'))
  await seedOverlay({
    root,
    baseDocuments: BASE,
    now: fixedClock(),
    edits: [
      {
        kind: 'edit',
        id: 'article-01',
        operations: [{type: 'set', path: ['title'], value: BRANCH_TITLE_01}],
      },
      {
        kind: 'create',
        document: {
          _id: `drafts.${BRANCH_CREATED_ID}`,
          _type: 'article',
          title: BRANCH_CREATED_TITLE,
          slug: {_type: 'slug', current: 'branch-article'},
          author: {_type: 'reference', _ref: 'author-2'},
        },
      },
      {kind: 'delete', id: TOMBSTONED_ID},
    ],
  })
})

afterAll(async () => {
  if (root) await rm(root, {recursive: true, force: true})
})

const fsClient = () =>
  createOverlayClient({
    mode: 'fs',
    base: createDocumentBaseSource(BASE),
    overlay: createFsOverlayStateLoader({root}),
    perspective: 'drafts',
    caller: 'frontend',
  })

/* ------------------------------------------------------------------ *
 * mode: 'fs' — the reads that must be overlay-aware in both directions
 * ------------------------------------------------------------------ */

describe("mode: 'fs' resolves reads against the overlay", () => {
  it('returns the BRANCH value of a locally edited document, not the base value', async () => {
    const client = fsClient()

    const article = await client.fetch<{title: string; slug: string}>('article-by-slug', {
      slug: 'article-1',
    })

    expect(article.title).toBe(BRANCH_TITLE_01)
    /* Stated explicitly: a passing assertion above with an equal base title
     * would be worthless, so the two are asserted to differ. */
    expect(BRANCH_TITLE_01).not.toBe(BASE_TITLE_01)
  })

  it('includes a branch-created document that no base fetch could select', async () => {
    const client = fsClient()

    const list = await client.fetch<{_id: string; title: string}[]>('article-type-list')

    expect(list).toContainEqual({_id: BRANCH_CREATED_ID, title: BRANCH_CREATED_TITLE})
    expect(BASE.some((d) => d._id === BRANCH_CREATED_ID)).toBe(false)
  })

  it('omits a tombstoned document instead of serving its stale base row', async () => {
    const client = fsClient()

    const list = await client.fetch<{_id: string; title: string}[]>('article-type-list')

    expect(list.map((entry) => entry._id)).not.toContain(TOMBSTONED_ID)
    /* The base row it must not have served is really there. */
    expect(BASE.some((d) => d._id === TOMBSTONED_ID && d.title === BASE_TITLE_02)).toBe(true)
  })

  it('shows the branch title in the list read as well as the lookup read', async () => {
    const client = fsClient()

    const list = await client.fetch<{_id: string; title: string}[]>('article-type-list')

    expect(list).toContainEqual({_id: 'article-01', title: BRANCH_TITLE_01})
  })

  it('leaves an untouched document exactly as base has it', async () => {
    const client = fsClient()

    const article = await client.fetch<{title: string}>('article-by-slug', {slug: 'article-3'})

    expect(article.title).toBe(baseDoc('article-03').title)
  })

  it('dereferences a reference target through the overlay-aware read', async () => {
    const client = fsClient()

    const article = await client.fetch<{title: string; author: {name: string}}>(
      'article-by-slug-with-author',
      {slug: 'article-1'},
    )

    expect(article.title).toBe(BRANCH_TITLE_01)
    expect(article.author.name).toBe(baseDoc('author-2').name)
  })

  it('exposes the query layer diagnostics alongside the result', async () => {
    const client = fsClient()

    const {result, diagnostics} = await client.fetchWithDiagnostics<{title: string}>(
      'article-by-slug',
      {slug: 'article-1'},
    )

    expect(result.title).toBe(BRANCH_TITLE_01)
    expect(diagnostics.queryId).toBe('article-by-slug')
    expect(diagnostics.candidateIds).toContain('article-01')
    expect(diagnostics.exact).toBe(true)
  })

  it('reports the overlay revision it is reading', async () => {
    const client = fsClient()

    await expect(client.overlayRevision()).resolves.toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * mode: 'off' — PRD §9.2, a project can turn the overlay off entirely
 * ------------------------------------------------------------------ */

describe("mode: 'off' is inert", () => {
  /** A loader that makes any overlay read an immediate, loud failure. */
  const explodingLoader = (): OverlayStateLoader => ({
    load: () => {
      throw new Error('overlay was read in mode: off')
    },
    probe: () => {
      throw new Error('overlay was probed in mode: off')
    },
  })

  const offClient = (overlay: OverlayStateLoader) =>
    createOverlayClient({
      mode: 'off',
      base: createDocumentBaseSource(BASE),
      overlay,
      perspective: 'drafts',
      caller: 'frontend',
    })

  it('returns the BASE value for a document the branch has edited', async () => {
    const client = offClient(explodingLoader())

    const article = await client.fetch<{title: string}>('article-by-slug', {slug: 'article-1'})

    expect(article.title).toBe(BASE_TITLE_01)
  })

  it('does not hide a document the branch tombstoned', async () => {
    const client = offClient(explodingLoader())

    const list = await client.fetch<{_id: string}[]>('article-type-list')

    expect(list.map((entry) => entry._id)).toContain(TOMBSTONED_ID)
  })

  it('does not surface a branch-created document', async () => {
    const client = offClient(explodingLoader())

    const list = await client.fetch<{_id: string}[]>('article-type-list')

    expect(list.map((entry) => entry._id)).not.toContain(BRANCH_CREATED_ID)
  })

  it('performs no overlay read at all — the loader is never invoked', async () => {
    let loads = 0
    let probes = 0
    const counting: OverlayStateLoader = {
      load: async () => {
        loads++
        return null
      },
      probe: async () => {
        probes++
        return null
      },
    }
    const client = offClient(counting)

    await client.fetch('article-type-list')
    await client.fetch('article-by-slug', {slug: 'article-1'})
    await client.overlayRevision()
    client.revalidate()

    expect({loads, probes}).toEqual({loads: 0, probes: 0})
  })

  it('reads a real `.sanity-overlay/` root without consulting it', async () => {
    const client = createOverlayClient({
      mode: 'off',
      base: createDocumentBaseSource(BASE),
      /* The genuine, populated overlay the `fs` describe block reads. */
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'drafts',
      caller: 'frontend',
    })

    const article = await client.fetch<{title: string}>('article-by-slug', {slug: 'article-1'})
    const list = await client.fetch<{_id: string}[]>('article-type-list')

    expect(article.title).toBe(BASE_TITLE_01)
    expect(list.map((entry) => entry._id)).toContain(TOMBSTONED_ID)
    expect(await client.overlayRevision()).toBeNull()
  })

  it('delegates the whole query to the base source when it can answer one', async () => {
    const calls: {query: string; params: Record<string, unknown>}[] = []
    const passthrough: OverlayClientBaseSource = {
      fetchCandidates: async () => {
        throw new Error('mode: off must delegate rather than plan candidates')
      },
      query: async (query, params) => {
        calls.push({query, params})
        return {title: 'from the base API'} as never
      },
    }

    const client = createOverlayClient({
      mode: 'off',
      base: passthrough,
      perspective: 'drafts',
      caller: 'frontend',
    })
    const article = await client.fetch<{title: string}>('article-by-slug', {slug: 'article-1'})

    expect(article).toEqual({title: 'from the base API'})
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toContain('slug.current == $slug')
    expect(calls[0]?.params).toEqual({slug: 'article-1'})
  })
})

/* ------------------------------------------------------------------ *
 * Registry discipline — PRD §22.5, §5.5: refuse, never approximate
 * ------------------------------------------------------------------ */

describe('registry discipline', () => {
  it('refuses an unregistered query with a structured error', async () => {
    const client = fsClient()

    await expect(client.fetch('not-a-registered-query')).rejects.toMatchObject({
      name: 'OverlayQueryError',
      code: 'QUERY_NOT_REGISTERED',
      httpStatus: 422,
    })
  })

  it('refuses a Tier C query with UNSUPPORTED_GROQ rather than approximating', async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'published',
      caller: 'test',
    })

    const error = await client.fetch('unconstrained-star').then(
      () => null,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(OverlayQueryError)
    expect((error as OverlayQueryError).code).toBe('UNSUPPORTED_GROQ')
    expect((error as OverlayQueryError).details).toMatchObject({queryId: 'unconstrained-star'})
  })

  it('refuses an unregistered query in mode: off too', async () => {
    const client = createOverlayClient({
      mode: 'off',
      base: createDocumentBaseSource(BASE),
      perspective: 'drafts',
      caller: 'frontend',
    })

    await expect(client.fetch('not-a-registered-query')).rejects.toMatchObject({
      code: 'QUERY_NOT_REGISTERED',
    })
  })

  it('refuses a caller the query did not register', async () => {
    const client = createOverlayClient({
      mode: 'fs',
      base: createDocumentBaseSource(BASE),
      overlay: createFsOverlayStateLoader({root}),
      perspective: 'published',
      caller: 'frontend',
    })

    await expect(client.fetch('unconstrained-star')).rejects.toMatchObject({
      code: 'QUERY_CALLER_NOT_ALLOWED',
    })
  })
})

/* ------------------------------------------------------------------ *
 * Configuration — PRD §11.1 `mode`
 * ------------------------------------------------------------------ */

describe('environment configuration', () => {
  /* ──────────────────────────────────────────────────────────────────────────
   * AN ABSENT KEY MUST NOT PICK A MODE.
   *
   * This used to be `env.SANITY_OVERLAY_MODE ?? 'off'`. `off` reads the BASE
   * dataset — staging — so a misspelled, unset or unpropagated variable put a
   * reader on staging while every other signal in the deployment said "branch".
   * That is the exact failure this package exists to prevent, and it arrived
   * silently, which is what made it expensive.
   *
   * `off` is still a perfectly good setting. It just has to be CHOSEN.
   * ────────────────────────────────────────────────────────────────────────── */

  it('REFUSES to guess when the environment names no mode', () => {
    expect(() => overlayClientConfigFromEnv({})).toThrow(/mode/i)
  })

  it('names every accepted spelling when it refuses, and says "off" is a choice', () => {
    let message = ''
    try {
      overlayClientConfigFromEnv({})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SANITY_STUDIO_OVERLAY_MODE')
    expect(message).toContain('SANITY_OVERLAY_MODE')
    expect(message).toContain('OVERLAY_MODE')
    expect(message).toMatch(/\boff\b/)
  })

  /** Spike A's scar: a blank value read as "configured" at one site and falsy at another. */
  it.each(['', '   ', '\t'])('treats a blank value (%j) as unset, not as a mode', (raw) => {
    expect(() => overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: raw})).toThrow(/mode/i)
  })

  it('accepts an explicit off', () => {
    expect(overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'off'})).toMatchObject({mode: 'off'})
  })

  /* ──────────────────────────────────────────────────────────────────────────
   * ONE VOCABULARY.
   *
   * Three spellings were in use across the packages — `SANITY_STUDIO_OVERLAY_MODE`
   * (the only prefix Vite exposes to a browser bundle), `OVERLAY_MODE` (PRD §11.2's
   * server spelling) and `SANITY_OVERLAY_MODE` (this package's own). A deployment
   * that set one and was read by a package expecting another got the silent
   * default above.
   * ────────────────────────────────────────────────────────────────────────── */

  it.each(['SANITY_STUDIO_OVERLAY_MODE', 'SANITY_OVERLAY_MODE', 'OVERLAY_MODE'])(
    'accepts %s as a spelling of the mode',
    (key) => {
      expect(overlayClientConfigFromEnv({[key]: 'off'})).toMatchObject({mode: 'off'})
    },
  )

  it.each(['SANITY_STUDIO_OVERLAY_ROOT', 'SANITY_OVERLAY_ROOT', 'OVERLAY_ROOT'])(
    'accepts %s as a spelling of the overlay root',
    (key) => {
      expect(
        overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'fs', [key]: '/srv/checkout'}),
      ).toMatchObject({mode: 'fs', overlayRoot: '/srv/checkout'})
    },
  )

  it.each(['SANITY_STUDIO_OVERLAY_PERSPECTIVE', 'SANITY_OVERLAY_PERSPECTIVE', 'OVERLAY_PERSPECTIVE'])(
    'accepts %s as a spelling of the perspective',
    (key) => {
      expect(overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'off', [key]: 'published'})).toMatchObject(
        {perspective: 'published'},
      )
    },
  )

  it('accepts the same value written under two spellings', () => {
    expect(
      overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'off', OVERLAY_MODE: 'off'}),
    ).toMatchObject({mode: 'off'})
  })

  /**
   * When two spellings disagree the most REACHABLE one wins, matching the
   * Studio resolver. The prefixes address different runtimes — the bare
   * spelling is the server's and the CLI's, `SANITY_STUDIO_` is the only one a
   * Vite bundle can see — so divergence is coherent rather than a
   * misconfiguration, and a value that is actually readable must never be
   * shadowed by one that is not.
   */
  it('prefers the most reachable spelling when two disagree', () => {
    expect(
      overlayClientConfigFromEnv({
        SANITY_STUDIO_OVERLAY_MODE: 'off',
        SANITY_OVERLAY_MODE: 'fs',
        OVERLAY_MODE: 'fs',
        SANITY_OVERLAY_ROOT: '/srv/checkout',
      }),
    ).toMatchObject({mode: 'off'})

    expect(
      overlayClientConfigFromEnv({
        SANITY_OVERLAY_MODE: 'off',
        OVERLAY_MODE: 'fs',
      }),
    ).toMatchObject({mode: 'off'})
  })

  /** A present-but-empty variable falls through to the next spelling. */
  it('treats a blank spelling as unset and falls through to the next', () => {
    expect(
      overlayClientConfigFromEnv({SANITY_STUDIO_OVERLAY_MODE: '  ', OVERLAY_MODE: 'off'}),
    ).toMatchObject({mode: 'off'})
  })

  it('reads mode and overlay root from the environment', () => {
    expect(
      overlayClientConfigFromEnv({
        SANITY_OVERLAY_MODE: 'fs',
        SANITY_OVERLAY_ROOT: '/srv/checkout',
        SANITY_OVERLAY_PERSPECTIVE: 'published',
      }),
    ).toEqual({
      mode: 'fs',
      overlayRoot: '/srv/checkout',
      perspective: 'published',
      /* `OVERLAY_REVALIDATE` defaults to `auto`, which is the behaviour every
       * deployment already had — see `local-site-revalidation.test.ts` for why
       * the key exists at all. */
      autoRevalidate: true,
    })
  })

  it('rejects an unknown mode rather than silently falling back', () => {
    expect(() => overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'maybe'})).toThrow(/maybe/)
  })

  it('requires an overlay root when mode is fs', () => {
    expect(() => overlayClientConfigFromEnv({SANITY_OVERLAY_MODE: 'fs'})).toThrow(
      /OVERLAY_ROOT/,
    )
  })

  /**
   * THE UNIFICATION, PROVED ACROSS THE PACKAGE BOUNDARY. One env map, two
   * independent readers, the same answer. This is the assertion that "three
   * vocabularies" made impossible.
   */
  it.each(['SANITY_STUDIO_OVERLAY_MODE', 'SANITY_OVERLAY_MODE', 'OVERLAY_MODE'])(
    'agrees with the Studio resolver about %s',
    (key) => {
      const env = {[key]: 'off'}
      expect(overlayClientConfigFromEnv(env).mode).toBe(resolveOverlayOptions({}, env).mode)
    },
  )
})
