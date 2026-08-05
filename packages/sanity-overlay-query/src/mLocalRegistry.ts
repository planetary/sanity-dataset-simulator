/**
 * The `[M-LOCAL]` reduced query registry.
 *
 * PRD §37 Phase 2, "Minimal Studio and query slice `[M-LOCAL]`":
 *
 *   - Reduced query registry containing the ID and slug lookup entries with
 *     parity fixtures. The full registry, codemod and lint enforcement remain
 *     Phase 5.
 *   - ID and slug candidate planners evaluated through pinned `groq-js`. The
 *     remaining planners remain Phase 5.
 *
 * and PRD §38.1 "Registered ID and slug queries work" / "Basic reference
 * dereference works".
 *
 * DELIBERATELY OUT OF SCOPE, and therefore absent rather than registered:
 *
 *   - Ordered slices (`| order(...)[0...K]`). Exactness needs the §22.6 bounded
 *     top-K proof and a `top-k` planner — Phase 5.
 *   - Aggregates (`count()`, `math::sum`). Spike C evidence
 *     (`boundedness-2026-08-04.md` §4) shows §22.6 step 14 forces an aggregate
 *     to materialise its whole type, so they are honestly Tier B and need
 *     aggregate pushdown.
 *   - Filters that traverse a reference (`author->name == $name`). Membership
 *     depends on a field of the TARGET, so no base-side predicate over the
 *     referrers is complete; that needs §22.6 step 10.
 *
 * Registering a shape without its planner would let a query claim exact support
 * it does not have, which PRD §5.5 forbids.
 *
 * Two type-constrained list entries ARE included: their candidate plan is the
 * type itself, which is exact and — because the answer IS the type — cannot be
 * smaller than the response. They are classified `result-proportional`, not
 * `constant`, by the boundedness suite.
 *
 * Checksums are SHA-256 of the query text (§22.5). They are pinned literals:
 * editing a query without refreshing its checksum fails at registry
 * construction rather than changing behaviour silently.
 */
import {defineOverlayQuery} from './registry'
import type {OverlayQueryDefinition} from './types'

const FRONTEND = ['frontend', 'studio', 'agent', 'test'] as const
const PUBLISHED_AND_DRAFTS = ['published', 'drafts'] as const

/**
 * PRD §11.1 defines `query.maxCandidateDocuments` without a value. A lookup
 * resolves one document plus whatever `maxReferenceDepth` pulls in; the largest
 * fan-out measured in the Spike C corpus was 9. 64 leaves headroom for a richer
 * projection while still failing long before a type scan.
 *
 * The list entries carry a much larger limit because their answer is the type;
 * the Spike C latency evidence (§1.1) records that a single global limit cannot
 * serve both and flags it for ratification. Per-query limits are the §22.4
 * model's own answer to that.
 */
const LOOKUP_MAX_CANDIDATES = 64
const LIST_MAX_CANDIDATES = 4096

export const M_LOCAL_QUERIES: readonly OverlayQueryDefinition[] = [
  /* --- ID lookups (§22.3 Tier A "Document lookup by `_id`") ------------- */
  defineOverlayQuery({
    id: 'article-by-id',
    description: 'Article lookup by document ID, scalar and array fields only.',
    query: `*[_id == $id][0]{title, tags}`,
    queryChecksum: '85db7ecc40c4c22be2ac94471343a89ed32f5e6824812a53e2250e17c3410196',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'ids', idsFromParams: ['id']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),
  defineOverlayQuery({
    id: 'article-with-author',
    description: 'Article lookup by ID with a same-dataset reference dereference (§38.1).',
    query: `*[_id == $id][0]{title, author->{name}}`,
    queryChecksum: 'bdefa8bd0acb82b26df45badd15f1fcc9f69fe0efb86d23fdab98c9252dee715',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'ids', idsFromParams: ['id']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),
  defineOverlayQuery({
    id: 'page-featured-refs',
    description: 'Singleton page by literal ID with a reference-array dereference.',
    query: `*[_id == "page-home"][0]{sections[_type == "featuredArticles"][0]{articles[]->{title}}}`,
    queryChecksum: '7f43aec53a8c76e0ecce72e3289b8a7e62cb5f3c85198877e3e03ed7f9531f88',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'ids-literal', ids: ['page-home']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),

  /* --- Slug lookups (§22.3 Tier A "Slug filters"; §22.7 example) -------- */
  defineOverlayQuery({
    id: 'page-by-slug',
    description: 'Page by slug with nested object projection (the PRD §22.7 worked example).',
    query: `*[_type == "page" && slug.current == $slug][0]{title, hero{heading, cta{label}}}`,
    queryChecksum: '3fd076000fc3781dcddd98ea32f7f9226fd427959b89e6a38bbe98d355f4084b',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'slug', types: ['page'], path: ['slug', 'current'], valueFromParam: 'slug'},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),
  defineOverlayQuery({
    id: 'article-by-slug',
    description: 'Article by slug, projecting the slug back out.',
    query: `*[_type == "article" && slug.current == $slug][0]{title, "slug": slug.current}`,
    queryChecksum: '4ccaa5586afda940b50ba524e25fc5490df0815c7f94f7bf849ed171d9a3dbc6',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {
      type: 'slug',
      types: ['article'],
      path: ['slug', 'current'],
      valueFromParam: 'slug',
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),
  defineOverlayQuery({
    id: 'article-by-slug-with-author',
    description: 'Article by slug with a reference dereference — the §38.1 route shape.',
    query: `*[_type == "article" && slug.current == $slug][0]{title, author->{name, "slug": slug.current}}`,
    queryChecksum: 'ae8bd83b6bb0afa127adf9589345a689e0b2dfe29729b1c104fef6d1d4c1e7f2',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {
      type: 'slug',
      types: ['article'],
      path: ['slug', 'current'],
      valueFromParam: 'slug',
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
  }),

  /* --- Type-constrained lists (§22.3 Tier A "Type-constrained filters") -- */
  defineOverlayQuery({
    id: 'article-type-list',
    description: 'Every article. Answer-proportional: the answer IS the type.',
    query: `*[_type == "article"]{_id, title} | order(_id asc)`,
    queryChecksum: '5f2bd3f4dc36fc09fb6ac30d10e06c57e182d5871bccbdb088c08d5c6ca613b7',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'types', types: ['article']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LIST_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes: 'Not constant-bounded and not claimed to be: the candidate set cannot be smaller than the response.',
  }),
  defineOverlayQuery({
    id: 'multi-type-list',
    description: 'Multiple finite `_type` constraints (§22.3 Tier A).',
    query: `*[_type in ["article", "page"]]{_id, _type} | order(_id asc)`,
    queryChecksum: 'b3f601eda533741ae91a0f597cfd63e39d4a1a6a60f63439931b0778ca278871',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'types', types: ['article', 'page']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LIST_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes: 'As article-type-list, across two types.',
  }),

  /* --- Tier C, registered so the refusal is executable ------------------ */
  defineOverlayQuery({
    id: 'unconstrained-star',
    description:
      'Unconstrained `*` with no finite candidate plan (§22.3 Tier C). Registered so that ' +
      '"must fail structurally, never approximate" is a test rather than a claim.',
    query: `*[]{_id}`,
    queryChecksum: '21b89f6658780eee57efea21ff5bf94dc2bd26b3fd8bf9e3fbc8223f6365c056',
    allowedCallers: ['test'],
    perspectives: ['published'],
    candidatePlan: {
      type: 'none',
      reason:
        'Unconstrained `*` cannot be bounded without loading the whole dataset (PRD §22.3 Tier C).',
    },
    systemTimestampPolicy: 'unsupported',
    maxCandidates: 0,
    maxReferenceDepth: 0,
    status: 'unsupported',
  }),
]
