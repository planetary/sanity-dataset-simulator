/**
 * HTML rendering — pure functions, data in and a string out.
 *
 * No client involved, no fetching: these are the "components". A Next.js port
 * replaces this file with JSX and keeps `data.ts` untouched, which is why the
 * two are separate modules rather than one route handler.
 *
 * Every interpolated value goes through {@link escapeHtml}. Branch content is
 * whatever an editor typed, so the page must survive an editor typing a tag.
 */
import type {
  ArticleDetail,
  ArticleSection,
  ArticleSummary,
  PortableTextBlock,
  SiteReadContext,
} from './data'

/** HTML text/attribute escaping. Deliberately escapes quotes too. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 44rem; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 1.5rem; }
h2 { font-size: 1.3rem; margin: 0 0 .25rem; }
ul.articles { list-style: none; padding: 0; }
ul.articles li { border-bottom: 1px solid rgba(128,128,128,.3); padding: .75rem 0; }
a { color: inherit; }
footer { border-top: 1px solid rgba(128,128,128,.3); color: rgba(128,128,128,1); font-size: .85rem; margin-top: 3rem; padding-top: .75rem; }
.meta { color: rgba(128,128,128,1); font-size: .85rem; }
.badge { border: 1px solid currentColor; border-radius: .3rem; font-size: .75rem; padding: 0 .35rem; }
`

/**
 * The footer. It is not decoration: it is how a reader tells the branch preview
 * apart from staging without guessing, which matters when the whole point of the
 * tool is that two different answers to the same URL are both correct.
 */
function renderContext(context: SiteReadContext): string {
  const parts = [`mode: ${escapeHtml(context.mode)}`]
  if (context.mode === 'off') {
    parts.push('reading the base dataset directly — no overlay is consulted')
  } else {
    parts.push(`overlay revision: ${escapeHtml(context.overlayRevision ?? 0)}`)
  }
  return `<footer>${parts.join(' &middot; ')}</footer>`
}

function layout(title: string, body: string, context: SiteReadContext): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    body,
    renderContext(context),
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export function renderArticleList(
  articles: readonly ArticleSummary[],
  context: SiteReadContext,
): string {
  const items = articles
    .map((article) => {
      const title = escapeHtml(article.title ?? '(untitled)')
      const heading =
        article.slug === null
          ? `<h2>${title}</h2><p class="meta">no slug yet — not routable</p>`
          : `<h2><a href="/articles/${encodeURIComponent(article.slug)}">${title}</a></h2>`
      return `<li>${heading}<p class="meta">${escapeHtml(article._id)}</p></li>`
    })
    .join('\n')

  const body = [
    '<h1>Pieces</h1>',
    articles.length === 0
      ? '<p>Nothing here yet.</p>'
      : `<ul class="articles">\n${items}\n</ul>`,
  ].join('\n')

  return layout('Pieces', body, context)
}

/**
 * One Portable Text block → one paragraph. Spans are concatenated in order;
 * an inline object (the schema's `inlineStat`) renders as its label/value pair
 * rather than vanishing. Marks are NOT styled — this site proves the content
 * round-trips, not a rich-text renderer; the Next.js port swaps in
 * `@portabletext/react` here.
 */
function renderPortableText(blocks: readonly PortableTextBlock[]): string {
  return blocks
    .filter((block) => block._type === 'block')
    .map((block) => {
      const text = (block.children ?? [])
        .map((child) => {
          if (typeof child.text === 'string') return escapeHtml(child.text)
          if (child.label !== undefined) {
            return `<span class="badge">${escapeHtml(child.label)}: ${escapeHtml(child.value ?? '')}</span>`
          }
          return ''
        })
        .join('')
      return text === '' ? '' : `<p>${text}</p>`
    })
    .filter((line) => line !== '')
    .join('\n')
}

/** The two kitchen-sink section shapes; an unknown `_type` renders nothing. */
function renderSections(sections: readonly ArticleSection[]): string {
  return sections
    .map((section) => {
      if (section._type === 'quoteSection' && section.quote !== undefined) {
        const attribution =
          section.attribution === undefined
            ? ''
            : `<footer class="meta">— ${escapeHtml(section.attribution)}</footer>`
        return `<blockquote>${escapeHtml(section.quote)}${attribution}</blockquote>`
      }
      if (section._type === 'statsSection' && section.heading !== undefined) {
        return `<p><strong>${escapeHtml(section.heading)}</strong> <span class="badge">${escapeHtml(section.count ?? 0)}</span></p>`
      }
      return ''
    })
    .filter((line) => line !== '')
    .join('\n')
}

export function renderArticleDetail(article: ArticleDetail, context: SiteReadContext): string {
  const meta: string[] = []
  if (article.author?.name) meta.push(`by ${escapeHtml(article.author.name)}`)
  if (article.publishedAt) meta.push(escapeHtml(article.publishedAt))
  const tags = (article.tags ?? [])
    .map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`)
    .join(' ')

  const bodyHtml = renderPortableText(article.body ?? [])
  const sectionsHtml = renderSections(article.sections ?? [])

  const body = [
    '<p><a href="/">&larr; all pieces</a></p>',
    `<h1>${escapeHtml(article.title ?? '(untitled)')}</h1>`,
    meta.length === 0 ? '' : `<p class="meta">${meta.join(' &middot; ')}</p>`,
    tags === '' ? '' : `<p>${tags}</p>`,
    bodyHtml,
    sectionsHtml,
    `<p class="meta">${escapeHtml(article._id)}</p>`,
  ]
    .filter((line) => line !== '')
    .join('\n')

  return layout(article.title ?? '(untitled)', body, context)
}

export function renderNotFound(path: string, context: SiteReadContext): string {
  const body = [
    '<h1>Not found</h1>',
    `<p class="meta">${escapeHtml(path)}</p>`,
    '<p><a href="/">&larr; all pieces</a></p>',
  ].join('\n')
  return layout('Not found', body, context)
}

export function renderError(
  heading: string,
  detail: string,
  context: SiteReadContext,
): string {
  const body = [`<h1>${escapeHtml(heading)}</h1>`, `<pre>${escapeHtml(detail)}</pre>`].join('\n')
  return layout(heading, body, context)
}
