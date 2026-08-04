// SPIKE C query registry seed (PRD §22.4 shape, simplified; §36.3 deliverable).
// This inventory + tier classification is the Gate D evidence input and the
// seed for the real Phase 6 registry.
import type {SpikeQueryDefinition} from './planner'

export const REGISTRY: SpikeQueryDefinition[] = [
  // --- Tier A ---------------------------------------------------------------
  {id: 'article-by-id', status: 'tier-a', query: `*[_id == $id][0]{title, tags}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {id: 'page-by-slug', status: 'tier-a', query: `*[_type == "page" && slug.current == $slug][0]{title, hero{heading, cta{label}}}`, candidatePlan: {type: 'slug', docType: 'page'}},
  {id: 'article-by-slug', status: 'tier-a', query: `*[_type == "article" && slug.current == $slug][0]{title, "slug": slug.current}`, candidatePlan: {type: 'slug', docType: 'article'}},
  {id: 'article-type-list', status: 'tier-a', query: `*[_type == "article"]{_id, title} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'multi-type-list', status: 'tier-a', query: `*[_type in ["article", "page"]]{_id, _type} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article', 'page']}},
  {id: 'projection-rename', status: 'tier-a', query: `*[_type == "article"]{"headline": title, "when": publishedAt} | order(when desc)[0...5]`, candidatePlan: {type: 'top-k', docType: 'article', orderField: 'publishedAt', sliceEnd: 5}},
  {id: 'object-spread', status: 'tier-a', query: `*[_id == $id][0]{...}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {id: 'articles-ordered-sliced', status: 'tier-a', query: `*[_type == "article"] | order(publishedAt desc)[0...20]{title, "slug": slug.current}`, candidatePlan: {type: 'top-k', docType: 'article', orderField: 'publishedAt', sliceEnd: 20}},
  {id: 'filter-by-tag', status: 'tier-a', query: `*[_type == "article" && "featured" in tags]{_id, title} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'article-with-author', status: 'tier-a', query: `*[_id == $id][0]{title, author->{name}}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {id: 'articles-by-author-name', status: 'tier-a', query: `*[_type == "article" && author->name == $name]{_id} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'page-featured-refs', status: 'tier-a', query: `*[_id == "page-home"][0]{sections[_type == "featuredArticles"][0]{articles[]->{title}}}`, candidatePlan: {type: 'ids-literal', ids: ['page-home']}},
  {id: 'references-author', status: 'tier-a', query: `*[_type == "article" && references($authorId)]{_id} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'article-count', status: 'tier-a', query: `count(*[_type == "article"])`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'stats-aggregate', status: 'tier-a', query: `math::sum(*[_type == "article"].sections[1].count)`, candidatePlan: {type: 'types', types: ['article']}},
  {id: 'pt-text', status: 'tier-a', query: `*[_id == $id][0]{"text": pt::text(body)}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},

  // --- Tier B ---------------------------------------------------------------
  {
    id: 'recent-by-created-at', status: 'tier-b',
    query: `*[_type == "article"] | order(_createdAt desc)[0...5]{_id}`,
    candidatePlan: {type: 'top-k', docType: 'article', orderField: '_createdAt', sliceEnd: 5},
    systemTimestampPolicy: 'preview-diverges',
    notes: 'Synthetic overlay timestamps can reorder after promotion (PRD §13.9); accepted with diagnostic.',
  },

  // --- Unsupported (Tier C) -------------------------------------------------
  {
    id: 'unconstrained-star', status: 'unsupported',
    query: `*[]{_id}`,
    candidatePlan: {type: 'none'},
    notes: 'Unconstrained * without a finite candidate plan (PRD §22.3 Tier C). Must fail structurally, never approximate.',
  },
]

export const byId = (id: string): SpikeQueryDefinition => {
  const def = REGISTRY.find((d) => d.id === id)
  if (!def) throw new Error(`unregistered query: ${id}`)
  return def
}
