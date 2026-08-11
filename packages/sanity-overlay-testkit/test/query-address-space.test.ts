import {describe, expect, it} from 'vitest'
import {
  createMemoryBaseSource,
  createQueryRegistry,
  defineOverlayQuery,
  evaluateOverlayQuery,
  queryTextChecksum,
} from '../../sanity-overlay-query/src/index'
import type {OverlaySource, QueryDocument} from '../../sanity-overlay-query/src/index'

/*
 * ═══════════════════════════════════════════════════════════════════
 * R5 IN THE QUERY LAYER — the candidate pool's address space.
 *
 * The overlay view every logical-perspective reader builds is keyed by
 * LOGICAL id. A base source can nevertheless deliver rows addressed
 * `drafts.<id>` — an NDJSON export served verbatim, a caller-supplied
 * `baseDocuments` array, a types-plan over a raw memory dataset. Before
 * 2026-08-11 `resolveVirtualDocument` looked the raw address up, found no
 * overlay entry, and admitted the stale base draft ALONGSIDE the branch's
 * published answer — R5's leak plus a duplicate row.
 *
 * The rule: a draft-addressed base row is inadmissible whenever the overlay
 * holds an opinion (body or tombstone) about its logical twin. §18.2 — the
 * branch's opinion supersedes the base draft; §18.8 — a deleted document's
 * base draft must not resurface either.
 * ═══════════════════════════════════════════════════════════════════
 */

const ARTICLES = '*[_type == "article"]{_id, title}'
const QUERY = defineOverlayQuery({
  id: 'address-space-articles',
  description: 'All articles — address-space admission tests',
  query: ARTICLES,
  queryChecksum: queryTextChecksum(ARTICLES),
  allowedCallers: ['test'],
  perspectives: ['published', 'drafts'],
  candidatePlan: {type: 'types', types: ['article']},
  systemTimestampPolicy: 'preview-diverges',
  maxCandidates: 64,
  maxReferenceDepth: 1,
  status: 'tier-a',
})
const registry = createQueryRegistry([QUERY])

const BASE_PUBLISHED: QueryDocument = {_id: 'article-2', _type: 'article', title: 'Article 2'}
const STALE_BASE_DRAFT: QueryDocument = {
  _id: 'drafts.article-2',
  _type: 'article',
  title: 'Article 2 (DRAFT: retitled)',
}
const UNTOUCHED: QueryDocument = {_id: 'article-9', _type: 'article', title: 'Article 9'}

/** The raw dataset shape an NDJSON export or a caller's baseDocuments carries. */
const RAW_BASE = [BASE_PUBLISHED, STALE_BASE_DRAFT, UNTOUCHED]

const BRANCH_PUBLISHED: QueryDocument = {_id: 'article-2', _type: 'article', title: 'Well?'}

/** The logical-keyed view `buildOverlaySource` produces after a branch publish. */
function publishedOverArticle2(): OverlaySource {
  return {
    documents: new Map([['article-2', BRANCH_PUBLISHED]]),
    tombstones: new Set<string>(),
    conflicts: new Set<string>(),
  }
}

/** The view after the branch DELETED article-2 outright (§18.8). */
function deletedArticle2(): OverlaySource {
  return {
    documents: new Map<string, QueryDocument>(),
    tombstones: new Set(['article-2']),
    conflicts: new Set<string>(),
  }
}

async function titles(overlay: OverlaySource): Promise<string[]> {
  const {result} = await evaluateOverlayQuery<Array<{title: string}>>({
    registry,
    queryId: QUERY.id,
    params: {},
    base: createMemoryBaseSource(RAW_BASE),
    overlay,
    caller: 'test',
    perspective: 'published',
  })
  return result.map((row) => row.title).sort()
}

describe('draft-addressed base rows vs a logical-keyed overlay', () => {
  it('a branch-published document admits ONE row — never the stale base draft', async () => {
    /* The live shape: the base still holds drafts.article-2; the branch
     * published over it. Before the fix this answered THREE rows, one of them
     * "Article 2 (DRAFT: retitled)". */
    expect(await titles(publishedOverArticle2())).toEqual(['Article 9', 'Well?'])
  })

  it('§18.8 sibling: a branch delete suppresses the base draft row too', async () => {
    expect(await titles(deletedArticle2())).toEqual(['Article 9'])
  })

  it('boundary: with NO overlay opinion the raw rows pass through unchanged', async () => {
    const empty: OverlaySource = {
      documents: new Map(),
      tombstones: new Set(),
      conflicts: new Set(),
    }
    /* An untouched raw dataset keeps whatever address shapes it holds — the
     * admission rule keys on the OVERLAY's opinion, not on the row itself. */
    expect(await titles(empty)).toEqual([
      'Article 2',
      'Article 2 (DRAFT: retitled)',
      'Article 9',
    ])
  })

  it('boundary: a versioned overlay view still answers its own draft addresses', async () => {
    /* The studio's raw view keys BOTH addresses; an overlay-held draft body
     * must keep answering — the rule only rejects BASE rows the overlay has
     * superseded. */
    const versioned: OverlaySource = {
      documents: new Map<string, QueryDocument>([
        ['article-2', BRANCH_PUBLISHED],
        ['drafts.article-2', {_id: 'drafts.article-2', _type: 'article', title: 'branch draft'}],
      ]),
      tombstones: new Set(),
      conflicts: new Set(),
    }
    expect(await titles(versioned)).toEqual(['Article 9', 'Well?', 'branch draft'])
  })
})
