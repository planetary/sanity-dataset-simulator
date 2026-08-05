/**
 * `examples/local-site` — the consumer half of the loop.
 *
 * THE POINT. Until now the Studio wrote a branch overlay to disk and nothing
 * read it: "edit in Studio, see it on my local site, staging untouched" was not
 * runnable end to end. These tests assert the *rendered HTML*, not an
 * intermediate value, because the rendered HTML is the thing the user looks at
 * and the thing that was wrong.
 *
 * Every overlay assertion is written to fail if the site reads base only:
 *
 *   - the list and the detail page must show the BRANCH title;
 *   - a branch-created article must appear in the list and be routable;
 *   - a tombstoned article must be gone from the list and 404 on its own URL.
 *
 * And the mirror image, which is what makes "staging untouched" checkable: the
 * same site with `mode: 'off'` must render the base titles, keep the tombstoned
 * article and never show the branch-created one.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {
  createDocumentBaseSource,
  createFsOverlayStateLoader,
  createOverlayClient,
  seedOverlay,
} from '../../sanity-overlay-client/src/index'
import type {OverlayClient} from '../../sanity-overlay-client/src/index'
import {createSite} from '../../../examples/local-site/src/site'
import {getArticleBySlug, listArticles} from '../../../examples/local-site/src/data'
import {loadNdjsonDataset, SITE_BASE_DATASET_PATH} from '../../../examples/local-site/src/dataset'
import {SITE_QUERIES} from '../../../examples/local-site/src/queries'
import {loadFixtureDataset, publishedPerspective, type FixtureDocument} from '../src/fixtures'

const BASE: FixtureDocument[] = publishedPerspective(loadFixtureDataset()).filter(
  (doc) =>
    doc._type === 'author' || ['article-01', 'article-02', 'article-03'].includes(doc._id),
)

const baseDoc = (id: string): FixtureDocument => {
  const doc = BASE.find((d) => d._id === id)
  if (!doc) throw new Error(`fixture base is missing ${id}`)
  return doc
}

const BASE_TITLE_01 = baseDoc('article-01').title as string
const BASE_TITLE_02 = baseDoc('article-02').title as string

/**
 * Branch titles are chosen so that no base title is a SUBSTRING of them: the
 * assertions below are `not.toContain(baseTitle)` over the whole page, and a
 * branch title spelled "Article 1 — edited" would make that assertion pass for
 * the wrong reason.
 */
const BRANCH_TITLE_01 = 'Branch edit ✅ 日本語 — the first piece'
const BRANCH_CREATED_SLUG = 'branch-article'
const BRANCH_CREATED_TITLE = 'Branch-created piece'
/** A branch title that would break the page if it were interpolated raw. */
const HOSTILE_TITLE = 'Hostile <script>alert("xss")</script> & <b>bold</b>'

let root: string

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 4, 12, 0, 0) + tick++ * 1000).toISOString()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'overlay-local-site-'))
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
        kind: 'edit',
        id: 'article-03',
        operations: [{type: 'set', path: ['title'], value: HOSTILE_TITLE}],
      },
      {
        kind: 'create',
        document: {
          _id: 'drafts.article-branch-1',
          _type: 'article',
          title: BRANCH_CREATED_TITLE,
          slug: {_type: 'slug', current: BRANCH_CREATED_SLUG},
          author: {_type: 'reference', _ref: 'author-2'},
        },
      },
      {kind: 'delete', id: 'article-02'},
    ],
  })
})

afterAll(async () => {
  if (root) await rm(root, {recursive: true, force: true})
})

const overlayClient = (options: {autoRevalidate?: boolean} = {}): OverlayClient =>
  createOverlayClient({
    mode: 'fs',
    base: createDocumentBaseSource(BASE),
    overlay: createFsOverlayStateLoader({root}),
    queries: SITE_QUERIES,
    perspective: 'drafts',
    caller: 'frontend',
    ...(options.autoRevalidate === undefined ? {} : {autoRevalidate: options.autoRevalidate}),
  })

const baseOnlyClient = (): OverlayClient =>
  createOverlayClient({
    mode: 'off',
    base: createDocumentBaseSource(BASE),
    queries: SITE_QUERIES,
    perspective: 'drafts',
    caller: 'frontend',
  })

const get = (client: OverlayClient, url: string) =>
  createSite({client}).handle({method: 'GET', url})

/* ------------------------------------------------------------------ *
 * The overlay-backed site
 * ------------------------------------------------------------------ */

describe('the local site renders the branch overlay', () => {
  it('serves the article list as HTML', async () => {
    const response = await get(overlayClient(), '/')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.body).toContain('<!doctype html>')
  })

  it('shows the BRANCH title of an edited article in the list', async () => {
    const response = await get(overlayClient(), '/')

    expect(response.body).toContain(BRANCH_TITLE_01)
    expect(response.body).not.toContain(BASE_TITLE_01)
  })

  it('shows the BRANCH title on the article detail page', async () => {
    const response = await get(overlayClient(), '/articles/article-1')

    expect(response.status).toBe(200)
    expect(response.body).toContain(BRANCH_TITLE_01)
    expect(response.body).not.toContain(BASE_TITLE_01)
  })

  it('lists a branch-created article and routes to it', async () => {
    const list = await get(overlayClient(), '/')
    expect(list.body).toContain(BRANCH_CREATED_TITLE)
    expect(list.body).toContain(`/articles/${BRANCH_CREATED_SLUG}`)

    const detail = await get(overlayClient(), `/articles/${BRANCH_CREATED_SLUG}`)
    expect(detail.status).toBe(200)
    expect(detail.body).toContain(BRANCH_CREATED_TITLE)
  })

  it('drops a tombstoned article from the list', async () => {
    const response = await get(overlayClient(), '/')

    expect(response.body).not.toContain(BASE_TITLE_02)
    expect(response.body).not.toContain('/articles/article-2')
  })

  it('404s the tombstoned article rather than serving its stale base row', async () => {
    const response = await get(overlayClient(), '/articles/article-2')

    expect(response.status).toBe(404)
    expect(response.body).not.toContain(BASE_TITLE_02)
  })

  it('404s an unknown slug', async () => {
    const response = await get(overlayClient(), '/articles/no-such-article')

    expect(response.status).toBe(404)
  })

  it('renders the dereferenced author name', async () => {
    const response = await get(overlayClient(), '/articles/article-1')

    expect(response.body).toContain(baseDoc('author-2').name as string)
  })

  it('escapes a branch title instead of interpolating it into the page', async () => {
    const response = await get(overlayClient(), '/articles/article-3')

    expect(response.status).toBe(200)
    expect(response.body).toContain('&lt;script&gt;')
    expect(response.body).not.toContain('<script>alert')
  })

  /**
   * The rendered ID must be the LOGICAL one.
   *
   * Core addresses the drafts perspective by its §13.9 document ID, so a
   * resolved draft carries `_id: "drafts.article-01"`. If that form reaches the
   * query layer, every `_id == $id` lookup and every reference target silently
   * stops matching — and the page prints a `drafts.` prefix at the reader. This
   * assertion exists because a mutation check found the site suite green with
   * the normalization removed.
   */
  it('renders logical document IDs, never the drafts-prefixed form', async () => {
    const list = await get(overlayClient(), '/')
    const detail = await get(overlayClient(), '/articles/article-1')

    expect(list.body).toContain('article-01')
    expect(list.body).toContain('article-branch-1')
    expect(list.body).not.toContain('drafts.')
    expect(detail.body).toContain('article-01')
    expect(detail.body).not.toContain('drafts.')
  })

  it('reports the mode and overlay revision it rendered from', async () => {
    const response = await get(overlayClient(), '/')

    expect(response.body).toContain('mode: fs')
    expect(response.body).toMatch(/overlay revision: \d+/)
  })
})

/* ------------------------------------------------------------------ *
 * The same site with the overlay off — the "staging" view
 * ------------------------------------------------------------------ */

describe("the same site with mode: 'off' renders staging", () => {
  it('shows the base title, not the branch title', async () => {
    const response = await get(baseOnlyClient(), '/')

    expect(response.body).toContain(BASE_TITLE_01)
    expect(response.body).not.toContain(BRANCH_TITLE_01)
  })

  it('keeps the article the branch tombstoned', async () => {
    const list = await get(baseOnlyClient(), '/')
    const detail = await get(baseOnlyClient(), '/articles/article-2')

    expect(list.body).toContain(BASE_TITLE_02)
    expect(detail.status).toBe(200)
  })

  it('does not show a branch-created article', async () => {
    const list = await get(baseOnlyClient(), '/')
    const detail = await get(baseOnlyClient(), `/articles/${BRANCH_CREATED_SLUG}`)

    expect(list.body).not.toContain(BRANCH_CREATED_TITLE)
    expect(detail.status).toBe(404)
  })

  it('says so in the page footer', async () => {
    const response = await get(baseOnlyClient(), '/')

    expect(response.body).toContain('mode: off')
  })
})

/* ------------------------------------------------------------------ *
 * The revalidation trigger — the Next.js ISR substitution point
 * ------------------------------------------------------------------ */

describe('revalidation', () => {
  it('re-renders after an explicit revalidate, with auto-revalidation off', async () => {
    const client = overlayClient({autoRevalidate: false})
    const site = createSite({client})
    const laterTitle = 'Edited again while the site was running'

    expect((await site.handle({method: 'GET', url: '/'})).body).toContain(BRANCH_TITLE_01)

    await seedOverlay({
      root,
      baseDocuments: BASE,
      now: fixedClock(),
      edits: [
        {
          kind: 'edit',
          id: 'article-01',
          operations: [{type: 'set', path: ['title'], value: laterTitle}],
        },
      ],
    })

    /* Pinned: nothing changed yet. */
    expect((await site.handle({method: 'GET', url: '/'})).body).toContain(BRANCH_TITLE_01)

    const trigger = await site.handle({method: 'POST', url: '/revalidate'})
    expect(trigger.status).toBe(204)

    const after = await site.handle({method: 'GET', url: '/'})
    expect(after.body).toContain(laterTitle)

    /* Restore the shared fixture state for the rest of the file. */
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
      ],
    })
  })

  it('refuses a GET on the revalidation endpoint', async () => {
    const response = await get(overlayClient(), '/revalidate')

    expect(response.status).toBe(405)
  })
})

/* ------------------------------------------------------------------ *
 * The transport-free data layer — the functions an RSC would call
 * ------------------------------------------------------------------ */

describe('data layer', () => {
  it('listArticles returns the branch view with no HTTP involved', async () => {
    const articles = await listArticles(overlayClient())

    expect(articles.map((a) => a.title)).toContain(BRANCH_TITLE_01)
    expect(articles.map((a) => a.slug)).toContain(BRANCH_CREATED_SLUG)
    expect(articles.map((a) => a._id)).not.toContain('article-02')
  })

  it('getArticleBySlug returns null for a tombstoned article', async () => {
    await expect(getArticleBySlug(overlayClient(), 'article-2')).resolves.toBeNull()
  })

  it('getArticleBySlug resolves the branch value and its reference', async () => {
    const article = await getArticleBySlug(overlayClient(), 'article-1')

    expect(article?.title).toBe(BRANCH_TITLE_01)
    expect(article?.author?.name).toBe(baseDoc('author-2').name)
  })
})

/* ------------------------------------------------------------------ *
 * The shipped example dataset
 * ------------------------------------------------------------------ */

describe('the shipped base dataset', () => {
  it('loads and carries the documents the example routes need', () => {
    const documents = loadNdjsonDataset(SITE_BASE_DATASET_PATH)

    expect(documents.length).toBeGreaterThan(0)
    expect(documents.some((doc) => doc._id === 'article-01' && doc._type === 'article')).toBe(true)
    expect(documents.some((doc) => doc._type === 'author')).toBe(true)
    /* Every base document can anchor a merge ancestor (PRD §13.4). */
    expect(documents.every((doc) => typeof doc._rev === 'string' && doc._rev.length > 0)).toBe(true)
  })

  it('serves the example routes end to end from the shipped dataset', async () => {
    const documents = loadNdjsonDataset(SITE_BASE_DATASET_PATH)
    const client = createOverlayClient({
      mode: 'off',
      base: createDocumentBaseSource(documents),
      queries: SITE_QUERIES,
      perspective: 'drafts',
      caller: 'frontend',
    })

    const list = await get(client, '/')
    expect(list.status).toBe(200)
    expect(list.body).toContain('/articles/article-1')

    const detail = await get(client, '/articles/article-1')
    expect(detail.status).toBe(200)
  })
})
