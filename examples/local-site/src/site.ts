/**
 * Routing — the only layer that knows about requests and responses.
 *
 * It returns a plain `{status, headers, body}` rather than writing to a socket,
 * so the whole site is testable without a listening port, and so `server.ts` is
 * the only file that imports `node:http`.
 *
 * Routes:
 *   GET  /                     the list of pieces
 *   GET  /articles/<slug>      one piece
 *   POST /revalidate           drop the cached overlay view and re-render
 *
 * `/revalidate` is a *named* trigger rather than an inline cache-buster. In a
 * Next.js port it becomes a route handler calling `revalidateTag(OVERLAY_CACHE_TAG)`;
 * the body of {@link revalidateSite} is the only thing that changes.
 */
import {
  OverlayQueryError,
  httpStatusForQueryErrorCode,
} from '../../../packages/sanity-overlay-query/src/index'
import type {OverlayClient} from '../../../packages/sanity-overlay-client/src/index'
import {getArticleBySlug, listArticles, readContext} from './data'
import {renderArticleDetail, renderArticleList, renderError, renderNotFound} from './render'

export interface SiteRequest {
  readonly method: string
  /** Request target, e.g. `/articles/my-piece?preview=1`. */
  readonly url: string
}

export interface SiteResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

export interface LocalSite {
  handle(request: SiteRequest): Promise<SiteResponse>
  /** The named revalidation trigger. See {@link revalidateSite}. */
  revalidate(): void
}

/**
 * Drop whatever the site has cached about the overlay.
 *
 * Named, exported and called from exactly one place, so the Next.js port has a
 * single substitution point: `revalidateTag(OVERLAY_CACHE_TAG)` goes here.
 */
export function revalidateSite(client: OverlayClient): void {
  client.revalidate()
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  /* The page is a live view of a local branch overlay; a cached copy is a stale
   * copy, and staleness is the exact defect this example exists to disprove. */
  'cache-control': 'no-store',
}

export interface CreateSiteOptions {
  readonly client: OverlayClient
}

export function createSite(options: CreateSiteOptions): LocalSite {
  const client = options.client

  async function handle(request: SiteRequest): Promise<SiteResponse> {
    const url = new URL(request.url, 'http://local-site.invalid')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()

    if (path === '/revalidate') {
      if (method !== 'POST') {
        return {status: 405, headers: {allow: 'POST'}, body: ''}
      }
      revalidateSite(client)
      return {status: 204, headers: {}, body: ''}
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return {status: 405, headers: {allow: 'GET, HEAD'}, body: ''}
    }

    let context = {mode: client.mode, overlayRevision: null as number | null}
    try {
      context = await readContext(client)

      if (path === '/') {
        const articles = await listArticles(client)
        return {status: 200, headers: HTML_HEADERS, body: renderArticleList(articles, context)}
      }

      const match = /^\/articles\/(.+)$/.exec(path)
      if (match) {
        const slug = decodeURIComponent(match[1] as string)
        const article = await getArticleBySlug(client, slug)
        if (article === null) {
          /* A tombstoned document lands here. 404 is the point: falling back to
           * the base row would render content the branch deleted. */
          return {status: 404, headers: HTML_HEADERS, body: renderNotFound(path, context)}
        }
        return {status: 200, headers: HTML_HEADERS, body: renderArticleDetail(article, context)}
      }

      return {status: 404, headers: HTML_HEADERS, body: renderNotFound(path, context)}
    } catch (error) {
      /* A query the registry refuses is surfaced with its structured code and
       * the HTTP status PRD §22.9 assigns it — never swallowed into a blank
       * page, and never quietly answered from base instead. */
      if (error instanceof OverlayQueryError) {
        return {
          status: httpStatusForQueryErrorCode(error.code),
          headers: HTML_HEADERS,
          body: renderError(error.code, error.message, context),
        }
      }
      return {
        status: 500,
        headers: HTML_HEADERS,
        body: renderError('Read failed', String((error as Error)?.stack ?? error), context),
      }
    }
  }

  return {
    handle,
    revalidate: () => revalidateSite(client),
  }
}
