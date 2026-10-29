'use client'
import {useEffect, useState} from 'react'
import {client} from '../../../sanity/client'

export function ClientPosts() {
  const [titles, setTitles] = useState<string[] | null>(null)
  useEffect(() => {
    client.fetch<string[]>(`*[_type == "post"] | order(title asc).title`).then(setTitles, (error) => setTitles([`error: ${error.message}`]))
  }, [])
  return (
    <section>
      <h2>Posts (browser)</h2>
      <ul id="client-posts">{titles?.map((title) => <li key={title}>{title}</li>)}</ul>
    </section>
  )
}
