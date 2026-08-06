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

  // --- Aggregate pushdown (§22.6, promoted Tier B -> Tier A 2026-08-06) -----
  // Both were TYPE-LINEAR: registered under a `types` plan they materialized
  // every article to return one scalar (4.8 MiB on the wire, latency-2026-08-04
  // §4.1). They now push the aggregate down to the base and materialize only the
  // branch delta, which is Tier A's "counts and aggregates over a proven finite
  // candidate set" — the finite set being the branch, not the type.
  {
    id: 'article-count', status: 'tier-a',
    query: `count(*[_type == "article"])`,
    candidatePlan: {
      type: 'aggregate',
      types: ['article'],
      baseAggregate: `count(*[_type == "article" && !(_id in $__touched)])`,
    },
    notes: 'AGGREGATE PUSHDOWN. count() is additive over the partition {untouched base} u {resolved branch delta}, so the base counts the first half server-side and returns a number. Exact, not estimated: every document is counted in exactly one half.',
  },
  {
    id: 'stats-aggregate', status: 'tier-a',
    query: `math::sum(*[_type == "article"].sections[1].count)`,
    candidatePlan: {
      type: 'aggregate',
      types: ['article'],
      baseAggregate: `math::sum(*[_type == "article" && !(_id in $__touched)].sections[1].count)`,
    },
    notes: 'AGGREGATE PUSHDOWN, as article-count. math::sum is additive and math::sum([]) is 0; a non-numeric member makes the whole sum null, which the recombination preserves by refusing to add a null half.',
  },

  // --- Tier B ---------------------------------------------------------------
  // §22.3 "queries that require bounded recursive reference expansion".
  {
    id: 'articles-by-author-name', status: 'tier-b',
    query: `*[_type == "article" && author->name == $name]{_id} | order(_id asc)`,
    candidatePlan: {
      type: 'reverse-reference',
      types: ['article'],
      filter: `*[_type == "article" && (author->name == $name || references($__touched))]{_id}`,
    },
    notes: 'REFERRER-PROPORTIONAL (was TYPE-LINEAR). §22.6 step 10: the base returns the referrers that match in the base state plus the referrers of every touched document — the only base non-matches that a branch edit can turn into matches. Stays Tier B because the bound is the referrer fan-out of the branch, which is a property of the data and is NOT constant; §22.7 sanctions the full scan this replaces.',
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
