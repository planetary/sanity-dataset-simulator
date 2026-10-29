'use client'
import {useEffect, useState} from 'react'
import {client} from '../../../sanity/client'

/** Fetched in the browser, not on the server: proves the browser client reaches the simulator too. */
export function ClientPosts() {
  const [titles, setTitles] = useState<string[] | null>(null)
  useEffect(() => {
    client.fetch<string[]>(`*[_type == "article"] | order(title asc).title`).then(setTitles, (error) => setTitles([`error: ${error.message}`]))
  }, [])
  return (
    <aside className="client-fetch">
      <strong>Fetched in the browser</strong>
      <ul id="client-posts">{titles?.map((title) => <li key={title}>{title}</li>)}</ul>
    </aside>
  )
}
