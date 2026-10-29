/**
 * The site's query registry (PRD §22.4 model, §22.5 registration requirements).
 *
 * The site may only ask what is registered. `sanity-overlay-query` refuses an
 * unregistered query outright rather than approximating it (PRD §5.5), which is
 * why the two routes below are *registered here* rather than assembled at the
 * call site from a slug.
 *
 * Both entries stay inside candidate-plan shapes that have a real planner in the
 * `[M-LOCAL]` slice:
 *
 *   - `types` — the answer IS the type, so the candidate set is exact and cannot
 *     be smaller than the response. Not constant-bounded, and not claimed to be.
 *   - `slug`  — PRD §22.7's worked example: the base answers an exact predicate
 *     over a LOCAL field, and every branch record of the type is unioned in
 *     because a branch edit can make a document newly match.
 *
 * Nothing here registers an ordered slice, an aggregate, or a filter that
 * traverses a reference. Those need PRD §22.6 machinery that is Phase 5; a
 * registration without its planner would claim exactness the system does not have.
 *
 * `queryChecksum` is a pinned SHA-256 of the query text (§22.5): editing a query
 * without refreshing the literal fails at registry construction instead of
 * changing what the site renders silently.
 */
import {
  M_LOCAL_QUERIES,
  defineOverlayQuery,
  type OverlayQueryDefinition,
} from '../../../packages/sanity-overlay-query/src/index'

const CALLERS = ['frontend', 'studio', 'agent', 'test'] as const
const PERSPECTIVES = ['published', 'drafts'] as const

/** The list route. */
export const ARTICLE_LIST_QUERY = 'site-article-list'
/** The detail route. */
export const ARTICLE_BY_SLUG_QUERY = 'site-article-by-slug'

const SITE_ONLY_QUERIES: readonly OverlayQueryDefinition[] = [
  defineOverlayQuery({
    id: ARTICLE_LIST_QUERY,
    description: 'Every article, with the slug the detail route needs to link to it.',
    query: `*[_type == "article"]{_id, title, "slug": slug.current} | order(_id asc)`,
    queryChecksum: '6d36618d9c90f050783fa319b0360f5121020a668d5028860e6734903f58b0f0',
    allowedCallers: [...CALLERS],
    perspectives: [...PERSPECTIVES],
    candidatePlan: {type: 'types', types: ['article']},
    systemTimestampPolicy: 'preserve-base',
    /* The answer is the type, so the limit is a dataset-size guard, not a
     * boundedness claim. It mirrors `article-type-list` in the M-LOCAL registry. */
    maxCandidates: 4096,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes: 'Answer-proportional: the candidate set cannot be smaller than the response.',
  }),
  defineOverlayQuery({
    id: ARTICLE_BY_SLUG_QUERY,
    description: 'One article by slug, with its author dereferenced — the detail route.',
    /* `body` and `sections` are plain field selections — no new candidate-plan
     * shape, no traversal — added 2026-08-11 when the detail page was found
     * rendering title/byline/tags and silently dropping the article's whole
     * Portable Text body: the exact fields the branch workflow edits. */
    query: `*[_type == "article" && slug.current == $slug][0]{_id, title, "slug": slug.current, publishedAt, tags, body, sections, author->{name}}`,
    queryChecksum: '6cb22258ad716ee310b4cb95e848335450a7f9889a1d5f5bf0593073c52b59a7',
    allowedCallers: [...CALLERS],
    perspectives: [...PERSPECTIVES],
    candidatePlan: {
      type: 'slug',
      types: ['article'],
      path: ['slug', 'current'],
      valueFromParam: 'slug',
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: 4096,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),
]

/**
 * What the site's client is constructed with: the `[M-LOCAL]` registry — kept so
 * the Tier C refusal stays executable from the site's own client — plus the two
 * route queries.
 */
export const SITE_QUERIES: readonly OverlayQueryDefinition[] = [
  ...M_LOCAL_QUERIES,
  ...SITE_ONLY_QUERIES,
]
