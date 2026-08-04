// SPIKE C query registry seed (PRD §22.4 shape, simplified; §36.3 deliverable).
// This inventory + tier classification is the Gate D evidence input and the
// seed for the real Phase 6 registry.
import type {SpikeQueryDefinition} from './planner'

export const REGISTRY: SpikeQueryDefinition[] = [
  // --- Tier A ---------------------------------------------------------------
  {id: 'article-by-id', status: 'tier-a', query: `*[_id == $id][0]{title, tags}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {
    id: 'page-by-slug', status: 'tier-a',
    query: `*[_type == "page" && slug.current == $slug][0]{title, hero{heading, cta{label}}}`,
    candidatePlan: {type: 'base-filter', types: ['page'], filter: `*[_type == "page" && slug.current == $slug]{_id}`},
    notes: 'Slug equality pushes down to the base fetch (§22.7); constant candidate count.',
  },
  {
    id: 'article-by-slug', status: 'tier-a',
    query: `*[_type == "article" && slug.current == $slug][0]{title, "slug": slug.current}`,
    candidatePlan: {type: 'base-filter', types: ['article'], filter: `*[_type == "article" && slug.current == $slug]{_id}`},
    notes: 'Was a full article scan (evidence review F6); now a filtered base fetch.',
  },
  {id: 'article-type-list', status: 'tier-a', query: `*[_type == "article"]{_id, title} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article']}, notes: 'Result-proportional: the answer IS every article, so the candidate set cannot be smaller than the response.'},
  {id: 'multi-type-list', status: 'tier-a', query: `*[_type in ["article", "page"]]{_id, _type} | order(_id asc)`, candidatePlan: {type: 'types', types: ['article', 'page']}, notes: 'Result-proportional, as article-type-list.'},
  {id: 'projection-rename', status: 'tier-a', query: `*[_type == "article"]{"headline": title, "when": publishedAt} | order(when desc)[0...5]`, candidatePlan: {type: 'top-k', docType: 'article', orderField: 'publishedAt', sliceEnd: 5}},
  {id: 'object-spread', status: 'tier-a', query: `*[_id == $id][0]{...}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {id: 'articles-ordered-sliced', status: 'tier-a', query: `*[_type == "article"] | order(publishedAt desc)[0...20]{title, "slug": slug.current}`, candidatePlan: {type: 'top-k', docType: 'article', orderField: 'publishedAt', sliceEnd: 20}},
  {
    id: 'filter-by-tag', status: 'tier-a',
    query: `*[_type == "article" && "featured" in tags]{_id, title} | order(_id asc)`,
    candidatePlan: {type: 'base-filter', types: ['article'], filter: `*[_type == "article" && "featured" in tags]{_id}`},
    notes: 'Array membership is a local-field predicate: pushes down to the base fetch.',
  },
  {id: 'article-with-author', status: 'tier-a', query: `*[_id == $id][0]{title, author->{name}}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},
  {
    id: 'page-featured-refs', status: 'tier-a',
    query: `*[_id == "page-home"][0]{sections[_type == "featuredArticles"][0]{articles[]->{title}}}`,
    candidatePlan: {type: 'ids-literal', ids: ['page-home']},
  },
  {
    id: 'references-author', status: 'tier-a',
    query: `*[_type == "article" && references($authorId)]{_id} | order(_id asc)`,
    candidatePlan: {type: 'base-filter', types: ['article'], filter: `*[_type == "article" && references($authorId)]{_id}`},
    notes: 'references() over a finite id is base-answerable; membership depends on the referrer only.',
  },
  {id: 'pt-text', status: 'tier-a', query: `*[_id == $id][0]{"text": pt::text(body)}`, candidatePlan: {type: 'ids', idsFromParams: ['id']}},

  // --- Tier B ---------------------------------------------------------------
  // §22.3 "Large type-constrained result sets" / "queries that require bounded
  // recursive reference expansion". Each of these materializes EVERY document
  // of its type to answer a small question, so §22.6's "never fetch every
  // document of a large type" is violated at scale. Reclassified 2026-08-04
  // (evidence review F6) — see spike-c-groq-corpus/boundedness-2026-08-04.md.
  {
    id: 'article-count', status: 'tier-b',
    query: `count(*[_type == "article"])`,
    candidatePlan: {type: 'types', types: ['article']},
    notes: 'TYPE-LINEAR. §22.6 step 14 evaluates the original query over the candidate set, so an aggregate must materialize everything it aggregates: a one-number answer costs a full type scan. Needs an aggregate-pushdown planner (base count + overlay delta) to reach Tier A.',
  },
  {
    id: 'stats-aggregate', status: 'tier-b',
    query: `math::sum(*[_type == "article"].sections[1].count)`,
    candidatePlan: {type: 'types', types: ['article']},
    notes: 'TYPE-LINEAR, as article-count.',
  },
  {
    id: 'articles-by-author-name', status: 'tier-b',
    query: `*[_type == "article" && author->name == $name]{_id} | order(_id asc)`,
    candidatePlan: {type: 'types', types: ['article']},
    notes: 'TYPE-LINEAR. The filter traverses a reference, so editing an author can add a referrer no base fetch selected; exactness without a scan needs §22.6 step 10 (reverse-reference expansion), which is unimplemented. Blast radius is the referrer count, so even that is not constant.',
  },
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
