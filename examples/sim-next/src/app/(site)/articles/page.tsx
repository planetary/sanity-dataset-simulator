import {CardGrid} from '../../../components/Cards'
import {load} from '../../../sanity/live'
import {ARTICLES_QUERY} from '../../../sanity/queries'
import {ClientPosts} from '../clientside/ClientPosts'

export default async function Articles() {
  const articles = await load(ARTICLES_QUERY)
  return (
    <section className="section">
      <h1>Articles</h1>
      <CardGrid items={articles} />
      <ClientPosts />
    </section>
  )
}
