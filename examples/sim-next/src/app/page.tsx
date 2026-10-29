import {client} from '../sanity/client'
import {ClientPosts} from './clientside/ClientPosts'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const posts = await client.fetch<{_id: string; title: string}[]>(`*[_type == "post"] | order(title asc) {_id, title}`)
  return (
    <main>
      <h1>Posts (server)</h1>
      <ul id="server-posts">
        {posts.map((post) => (
          <li key={post._id}>{post.title}</li>
        ))}
      </ul>
      <ClientPosts />
    </main>
  )
}
