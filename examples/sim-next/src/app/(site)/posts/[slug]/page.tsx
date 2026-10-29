import {notFound} from 'next/navigation'
import {sanityFetch} from '../../../../sanity/live'

export default async function PostPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const {data: post} = await sanityFetch({
    query: `*[_type == "post" && slug.current == $slug][0]{_id, title}`,
    params: {slug},
  })
  if (!post) notFound()
  return (
    <main>
      <h1 id="post-title">{post.title}</h1>
    </main>
  )
}
