/**
 * The `[M-LOCAL]` query registry, grown towards the audited Spike C corpus
 * (`docs/plans/evidence/phase-1/spike-c-groq-corpus/report.md`).
 *
 * PRD §37 Phase 2 asks for "a reduced query registry containing the ID and slug
 * lookup entries with parity fixtures"; this is that, plus the corpus shapes
 * whose candidate plan can be PROVEN bounded from the query's own semantics:
 * array membership, `references()` over a finite ID, and the §22.6 bounded
 * top-K ordered slice.
 *
 * DELIBERATELY ABSENT rather than registered — all three are measured, accepted
 * Tier B in the Spike C evidence, and none has a planner here:
 *
 *   - Aggregates (`count()`, `math::sum`). §22.6 step 14 evaluates the ORIGINAL
 *     query over the candidate set, so an aggregate must materialise everything
 *     it aggregates: `boundedness-2026-08-04.md` §4 measures a one-number
 *     answer costing a full type scan, and `latency-2026-08-04.md` §4.1 records
 *     4.8 MiB transferred to return a scalar. The fix is aggregate pushdown
 *     (base count plus overlay delta), which §22.6 does not describe.
 *   - Filters that traverse a reference (`author->name == $name`). Membership
 *     depends on a field of the TARGET, so no base-side predicate over the
 *     referrers is complete once an author is edited. The fix is §22.6 step 10,
 *     reverse-reference expansion. Measured at p50 2.2 s against a 3 s budget.
 *   - `custom` planners (§22.4). A named external planner cannot be shown
 *     bounded from the registration, so it cannot be admitted here.
 *
 * Registering a shape without its planner would let a query claim exact support
 * it does not have, which PRD §5.5 forbids. Absent is better than falsely
 * exact, so those three shapes stay out and the refusal stays loud.
 *
 * The type-constrained list entries ARE included: their candidate plan is the
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
/**
 * An ordered slice resolves `K` untouched base documents plus the branch
 * records of its type that can enter, leave or reorder the slice. `K` is at
 * most 20 in this registry, so the headroom here is the branch delta: a preview
 * branch that has touched more than ~230 documents of a single type is outside
 * the authoring workflow §5.4 budgets, and hitting the limit raises
 * `CANDIDATE_LIMIT_EXCEEDED` rather than degrading into a type scan.
 */
const SLICE_MAX_CANDIDATES = 256

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

  defineOverlayQuery({
    id: 'article-object-spread',
    description: 'Article lookup by ID projecting the whole document (§22.3 Tier A projections).',
    query: `*[_id == $id][0]{...}`,
    queryChecksum: '110c828d3bd528e3256504c5613c7c55cb81b908008d52aa67f078229e28b330',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'ids', idsFromParams: ['id']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      'The spread widens the PROJECTION, not the candidate set: the plan is still one ID. ' +
      'Registered because it is the shape that carries system fields into the response, which ' +
      'is where a synthetic overlay timestamp would become visible (§13.9).',
  }),
  defineOverlayQuery({
    id: 'article-body-text',
    description: 'Article lookup by ID projecting Portable Text through `pt::text` (§22.3 Tier A).',
    query: `*[_id == $id][0]{title, "text": pt::text(body)}`,
    queryChecksum: 'abfb11d352beeb50573bd1d15c5187e979ff3e6ceb00ad57ca65ba06b714e586',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'ids', idsFromParams: ['id']},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LOOKUP_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      '§22.3 Tier A admits the Portable Text functions PINNED groq-js supports. The function ' +
      'reads a field of the one candidate document, so it changes nothing about the plan.',
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

  /* --- Local predicates pushed down to the base (§22.3 Tier A) ---------- */
  defineOverlayQuery({
    id: 'articles-by-tag',
    description: 'Articles carrying a tag — §22.3 Tier A "Basic array membership".',
    query: `*[_type == "article" && $tag in tags]{_id, title} | order(_id asc)`,
    queryChecksum: '03434473de15f542290d2385608f7a7c985f45315beecf865fbc64d0fbc1bcf5',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {
      type: 'field-contains',
      types: ['article'],
      path: ['tags'],
      valueFromParam: 'tag',
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LIST_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      'Membership reads the candidate document\'s OWN array, so the base answers the predicate ' +
      'exactly and the branch delta covers every document that newly matches. Bounded by the ' +
      'answer, not by the type: the candidate set is the matching articles plus the branch ' +
      'records of the type.',
  }),
  defineOverlayQuery({
    id: 'articles-referencing-author',
    description: 'Articles that reference a given author — §22.3 Tier A "references() for finite IDs".',
    query: `*[_type == "article" && references($authorId)]{_id, title} | order(_id asc)`,
    queryChecksum: 'ef6c8de7424146bbae45d09952e9adf8038ba17cc613427b3461e68369a1d62c',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {type: 'references', types: ['article'], idFromParam: 'authorId'},
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: LIST_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      'The CONVERSE of the unregistered `author->name == $name`: `references($id)` reads the ' +
      'referrer\'s own fields, so editing the target cannot change membership and no reverse ' +
      'expansion (§22.6 step 10) is needed. That difference is the whole reason one is here ' +
      'and the other is absent.',
  }),

  /* --- Bounded top-K ordered slices (§22.6) ----------------------------- */
  defineOverlayQuery({
    id: 'articles-ordered-sliced',
    description: 'The newest 20 articles — the §22.6 bounded top-K shape.',
    query: `*[_type == "article"] | order(publishedAt desc)[0...20]{title, "slug": slug.current}`,
    queryChecksum: '3641cadebfc34c1b8ad4e6cdd326a6c7f622549afb7f6a9954ee3fefd70e2e57',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {
      type: 'top-k',
      types: ['article'],
      order: [{field: 'publishedAt', direction: 'desc'}],
      sliceEnd: 20,
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: SLICE_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      'Orders on an explicit USER field, which is what §22.3 Tier A requires ("ordering on ' +
      'explicit user fields with a bounded candidate plan"); ordering on a synthetic ' +
      '`_createdAt` would be Tier B under §13.9 and is not registered.',
  }),
  defineOverlayQuery({
    id: 'articles-recent-headlines',
    description: 'The five newest headlines, ordered through a projection alias.',
    query: `*[_type == "article"]{"headline": title, "when": publishedAt} | order(when desc)[0...5]`,
    queryChecksum: '973c74d0aaf0401a3c2b06e1ff4bfe66c177a2314acf6d230466d7074db4cb4f',
    allowedCallers: [...FRONTEND],
    perspectives: [...PUBLISHED_AND_DRAFTS],
    candidatePlan: {
      type: 'top-k',
      types: ['article'],
      order: [{field: 'publishedAt', direction: 'desc'}],
      sliceEnd: 5,
    },
    systemTimestampPolicy: 'preserve-base',
    maxCandidates: SLICE_MAX_CANDIDATES,
    maxReferenceDepth: 3,
    status: 'tier-a',
    parityFixture: 'm-local-overlays',
    notes:
      'The query orders by the alias `when`, which the projection defines as `publishedAt`; the ' +
      'plan therefore orders the base by `publishedAt`. That mapping is a claim of the ' +
      'registration and is proven by the parity fixtures, not by the projection syntax.',
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
