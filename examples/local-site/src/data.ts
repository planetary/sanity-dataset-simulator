/**
 * The site's data layer. **Transport-free on purpose.**
 *
 * Every function here takes an {@link OverlayClient} and returns plain data. No
 * `Request`, no `Response`, no `node:http`, no HTML. That is the whole trick that
 * makes the later Next.js port mechanical: a React Server Component can call
 * `listArticles(client)` and `getArticleBySlug(client, slug)` unchanged, and the
 * only thing that changes around them is who renders the result.
 *
 * The client — not this module — decides whether a read resolves against the
 * branch overlay or goes straight to the base dataset (PRD §9.2 `mode`).
 */
import type {OverlayClient} from '../../../packages/sanity-overlay-client/src/index'
import {ARTICLE_BY_SLUG_QUERY, ARTICLE_LIST_QUERY} from './queries'

export interface ArticleSummary {
  readonly _id: string
  readonly title: string | null
  /** `null` when a branch-created document has not been given a slug yet. */
  readonly slug: string | null
}

export interface ArticleDetail extends ArticleSummary {
  readonly publishedAt: string | null
  readonly tags: readonly string[] | null
  readonly author: {readonly name: string | null} | null
}

/** Everything the list route shows, in the registered query's own order. */
export async function listArticles(client: OverlayClient): Promise<ArticleSummary[]> {
  const rows = await client.fetch<ArticleSummary[] | null>(ARTICLE_LIST_QUERY)
  return rows ?? []
}

/**
 * One article by slug, or `null`.
 *
 * `null` is a real answer, not an error: a document the branch tombstoned is
 * *absent*, and the route must 404 rather than fall back to the base row.
 */
export async function getArticleBySlug(
  client: OverlayClient,
  slug: string,
): Promise<ArticleDetail | null> {
  if (slug.length === 0) return null
  const article = await client.fetch<ArticleDetail | null>(ARTICLE_BY_SLUG_QUERY, {slug})
  return article ?? null
}

/** What the page footer reports, so a reader can tell which dataset they see. */
export interface SiteReadContext {
  readonly mode: OverlayClient['mode']
  readonly overlayRevision: number | null
}

export async function readContext(client: OverlayClient): Promise<SiteReadContext> {
  return {mode: client.mode, overlayRevision: await client.overlayRevision()}
}
