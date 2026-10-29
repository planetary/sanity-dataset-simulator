import {defineLive} from 'next-sanity/live'
import {client} from './client'

const token = process.env.SANITY_API_READ_TOKEN

export const {sanityFetch, SanityLive} = defineLive({client, serverToken: token, browserToken: token})

/** `sanityFetch`, returning loosely typed documents (this demo has no generated types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function load<T = any>(query: string, params: Record<string, unknown> = {}): Promise<T> {
  const {data} = await sanityFetch({query, params})
  return data as T
}
