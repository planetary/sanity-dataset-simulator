import {describe, expect, it} from 'vitest'
import {draftsPerspective, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'

// First slice of the §35.11 fixture list, run offline through pinned groq-js.
// These exercise the query patterns the registry will formalize; the same
// queries later run against hosted Sanity for empty-overlay parity.

const docs = loadFixtureDataset()
const published = publishedPerspective(docs)
const drafts = draftsPerspective(docs)

describe('fixture dataset shape', () => {
  it('loads the committed deterministic dataset', () => {
    expect(docs.length).toBeGreaterThanOrEqual(41)
    expect(docs.filter((d) => d._type === 'article' && !d._id.startsWith('drafts.'))).toHaveLength(30)
  })

  it('contains the adversarial cases', () => {
    expect(docs.some((d) => d._id === 'legacy.page.v2')).toBe(true) // dots in _id
    expect(docs.some((d) => d._id === 'drafts.article-02')).toBe(true) // diverging draft
    expect(docs.some((d) => d._id === 'drafts.article-99')).toBe(true) // draft-only
  })
})

describe('offline groq-js parity harness (§35.11 slice)', () => {
  it('ID lookup', async () => {
    const r = await runGroq<{title: string}>(`*[_id == "article-01"][0]{title}`, published)
    expect(r).toEqual({title: 'Article 1'})
  })

  it('slug lookup', async () => {
    const r = await runGroq<{title: string}>(
      `*[_type == "page" && slug.current == $slug][0]{title}`,
      published,
      {slug: 'legacy-page'},
    )
    expect(r).toEqual({title: 'Legacy page'})
  })

  it('order and slice (top-K shape)', async () => {
    const r = await runGroq<{title: string}[]>(
      `*[_type == "article"] | order(publishedAt desc)[0...20]{title}`,
      published,
    )
    expect(r).toHaveLength(20)
    // publishedAt is reverse of the numeric id: article-01 is the newest
    expect(r[0].title).toBe('Article 1')
    expect(r[19].title).toBe('Article 20')
  })

  it('reference dereference', async () => {
    const r = await runGroq<{author: {name: string}}>(
      `*[_id == "article-01"][0]{author->{name}}`,
      published,
    )
    expect(r.author.name).toBe('Author 2')
  })

  it('references() over finite IDs', async () => {
    const r = await runGroq<{_id: string}[]>(
      `*[_type == "article" && references("author-1")]{_id} | order(_id asc)`,
      published,
    )
    expect(r.length).toBeGreaterThan(0)
  })

  it('count over finite type', async () => {
    const r = await runGroq<number>(`count(*[_type == "article"])`, published)
    expect(r).toBe(30)
  })

  it('drafts perspective: diverging draft wins', async () => {
    const r = await runGroq<{title: string}>(`*[_id == "article-02"][0]{title}`, drafts)
    expect(r).toEqual({title: 'Article 2 (DRAFT: retitled)'})
  })

  it('drafts perspective: draft-only document appears', async () => {
    const r = await runGroq<number>(`count(*[_type == "article"])`, drafts)
    expect(r).toBe(31)
  })

  it('published perspective: draft-only document absent', async () => {
    const r = await runGroq<unknown>(`*[_id == "article-99"][0]`, published)
    expect(r).toBeNull()
  })
})
