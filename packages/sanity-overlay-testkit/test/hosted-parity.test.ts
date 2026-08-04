import {describe, expect, it} from 'vitest'
import {loadEnv} from '../src/env'
import {hostedConfigFromEnv, hostedQuery} from '../src/hosted'
import {draftsPerspective, loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {runGroq} from '../src/groq'

// Empty-overlay parity, PR-loop tier (testing-strategy §2/§3):
// hosted Content Lake result vs pinned groq-js over the same fixture dataset.
// Projection-only queries so no metadata normalization is needed yet.
// Skips cleanly when no credentials are present (inner loop stays offline).

loadEnv()
const cfg = hostedConfigFromEnv()
const docs = loadFixtureDataset()
const published = publishedPerspective(docs)
const drafts = draftsPerspective(docs)

const CASES: Array<{name: string; query: string; params?: Record<string, unknown>}> = [
  {name: 'ID lookup', query: `*[_id == "article-01"][0]{title}`},
  {name: 'slug lookup', query: `*[_type == "page" && slug.current == $slug][0]{title}`, params: {slug: 'legacy-page'}},
  {name: 'order and slice', query: `*[_type == "article"] | order(publishedAt desc)[0...20]{title, "slug": slug.current}`},
  {name: 'reference dereference', query: `*[_id == "article-01"][0]{title, author->{name}}`},
  {name: 'references()', query: `*[_type == "article" && references("author-1")]{_id} | order(_id asc)`},
  {name: 'count over finite type', query: `count(*[_type == "article"])`},
  {name: 'nested projection', query: `*[_type == "page"]{title, hero{heading, cta{label}}} | order(title asc)`},
  {name: 'array membership', query: `*[_type == "article" && "even" in tags]{_id} | order(_id asc)`},
  {name: 'type list', query: `*[_type == "article"]{_id, title} | order(_id asc)`},
  {name: 'multi-type list', query: `*[_type in ["article", "page"]]{_id, _type} | order(_id asc)`},
  {name: 'aggregate over finite type', query: `math::sum(*[_type == "article"].sections[1].count)`},
  {name: 'Portable Text pt::text', query: `*[_id == "article-03"][0]{"text": pt::text(body)}`},
]

describe.skipIf(!cfg)('hosted empty-overlay parity (Gate D groundwork)', () => {
  for (const c of CASES) {
    it(`published: ${c.name}`, async () => {
      const hosted = await hostedQuery(cfg!, c.query, c.params ?? {})
      const local = await runGroq(c.query, published, c.params ?? {})
      expect(local).toEqual(hosted)
    })
  }

  it('drafts perspective: diverging draft wins on both sides', async () => {
    const q = `*[_id == "article-02"][0]{title}`
    const hosted = await hostedQuery(cfg!, q, {}, 'drafts')
    const local = await runGroq(q, drafts)
    expect(local).toEqual(hosted)
    expect(hosted).toEqual({title: 'Article 2 (DRAFT: retitled)'})
  })
})
