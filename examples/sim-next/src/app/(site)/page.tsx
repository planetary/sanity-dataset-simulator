import Link from 'next/link'
import {sanityFetch} from '../../sanity/live'
import {ClientPosts} from './clientside/ClientPosts'

export default async function Home() {
  const {data: posts} = await sanityFetch({
    query: `*[_type == "post" && defined(slug.current)] | order(title asc) {_id, title, "slug": slug.current}`,
  })
  return (
    <main>
      <h1>Posts (server)</h1>
      <ul id="server-posts">
        {posts.map((post: {_id: string; title: string; slug: string}) => (
          <li key={post._id}>
            <Link href={`/posts/${post.slug}`}>{post.title}</Link>
          </li>
        ))}
      </ul>
      <ClientPosts />
    </main>
  )
}
