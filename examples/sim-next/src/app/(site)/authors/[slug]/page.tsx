import {notFound} from 'next/navigation'
import {CardGrid} from '../../../../components/Cards'
import {RichText} from '../../../../components/RichText'
import {imageUrl, stegaClean} from '../../../../lib/content'
import {load} from '../../../../sanity/live'
import {AUTHOR_QUERY} from '../../../../sanity/queries'

export default async function AuthorPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const author = await load(AUTHOR_QUERY, {slug})
  if (!author) notFound()
  const accent = stegaClean(author.favoriteColor?.hex)
  return (
    <article className="section">
      <header className="author-head" style={accent ? {borderColor: accent} : undefined}>
        {author.portrait && <img src={imageUrl(author.portrait, 320, 320)} alt={author.portrait.alt ?? ''} />}
        <div>
          <span className="eyebrow">{author.role}</span>
          <h1>{author.name}</h1>
          <RichText value={author.bio} />
          <p className="muted">
            {author.email && <a href={`mailto:${stegaClean(author.email)}`}>{author.email}</a>}
            {author.website && <> · <a href={stegaClean(author.website)}>{author.website}</a></>}
            {author.basedIn && <> · based at {author.basedIn.lat.toFixed(2)}, {author.basedIn.lng.toFixed(2)}</>}
          </p>
        </div>
      </header>
      <h2>Writing</h2>
      <CardGrid items={author.articles} />
      {author.events?.length > 0 && (
        <>
          <h2>Speaking at</h2>
          <CardGrid items={author.events} />
        </>
      )}
    </article>
  )
}
