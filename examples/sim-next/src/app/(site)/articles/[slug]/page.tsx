import Link from 'next/link'
import {notFound} from 'next/navigation'
import {CardGrid} from '../../../../components/Cards'
import {RichText} from '../../../../components/RichText'
import {type Doc, bytes, formatDate, hrefFor, imageUrl} from '../../../../lib/content'
import {load} from '../../../../sanity/live'
import {ARTICLE_QUERY} from '../../../../sanity/queries'

export default async function ArticlePage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const article = await load(ARTICLE_QUERY, {slug})
  if (!article) notFound()
  const cover = imageUrl(article.cover, 1800, 900)
  return (
    <article className="article">
      <header className="article-head">
        <div className="crumbs">
          {article.categories?.map((category: Doc) => (
            <Link key={category.slug} href={hrefFor({_type: 'category', slug: category.slug})}>
              {category.parent ? `${category.parent.title} › ` : ''}
              {category.title}
            </Link>
          ))}
        </div>
        {article.kicker && <span className="eyebrow">{article.kicker}</span>}
        <h1 id="post-title">{article.title}</h1>
        {article.excerpt && <p className="lead">{article.excerpt}</p>}
        <p className="byline">
          {article.author && (
            <>
              By <Link href={hrefFor({_type: 'author', slug: article.author.slug})}>{article.author.name}</Link>
            </>
          )}
          {article.contributors?.length > 0 && (
            <>
              {' '}with{' '}
              {article.contributors.map((person: Doc, i: number) => (
                <span key={person.slug}>
                  {i > 0 && ', '}
                  <Link href={hrefFor({_type: 'author', slug: person.slug})}>{person.name}</Link>
                </span>
              ))}
            </>
          )}
          {article.publishedAt && <> · {formatDate(article.publishedAt, {dateStyle: 'long'})}</>}
          {article.updatedOn && <> · updated {formatDate(article.updatedOn)}</>}
          {article.readingTime && <> · {article.readingTime} min read</>}
          {article.featured && <> · ★ Featured</>}
        </p>
      </header>
      {cover && (
        <figure className="cover">
          <img id="post-image" src={cover} alt={article.cover?.alt ?? ''} />
          {article.cover?.caption && <figcaption>{article.cover.caption}{article.cover.credit && ` · ${article.cover.credit}`}</figcaption>}
        </figure>
      )}
      <div className="article-body">
        <RichText value={article.body} />
        <aside className="article-aside">
          {article.tags?.length > 0 && (
            <div className="tags">
              {article.tags.map((tag: string) => (
                <span key={tag} className="tag">
                  #{tag}
                </span>
              ))}
            </div>
          )}
          {article.location && (
            <p className="muted">
              📍 {article.location.lat.toFixed(3)}, {article.location.lng.toFixed(3)}
              {article.location.alt ? ` · ${article.location.alt} m` : ''}
            </p>
          )}
          {article.attachments?.length > 0 && (
            <ul className="files">
              {article.attachments.map((file: Doc, i: number) => (
                <li key={i}>
                  <a href={file.url}>{file.description || file.filename}</a> <span className="muted">{bytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      {article.related?.length > 0 && (
        <section className="section">
          <h2>Related</h2>
          <CardGrid items={article.related} />
        </section>
      )}
    </article>
  )
}
