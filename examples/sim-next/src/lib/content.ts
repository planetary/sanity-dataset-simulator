import {createImageUrlBuilder} from '@sanity/image-url'
import {stegaClean} from 'next-sanity'
import {client} from '../sanity/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Doc = Record<string, any>

const builder = createImageUrlBuilder(client)

/** An image URL that honours the editor's hotspot and crop. */
export function imageUrl(source: Doc | undefined, width: number, height?: number) {
  if (!source?.asset) return undefined
  let image = builder.image(source).width(width).auto('format').fit('crop')
  if (height) image = image.height(height)
  return image.url()
}

const ROUTES: Partial<Record<string, (slug: string) => string>> = {
  page: (slug) => (slug === 'home' ? '/' : `/${slug}`),
  article: (slug) => `/articles/${slug}`,
  product: (slug) => `/products/${slug}`,
  event: (slug) => `/events/${slug}`,
  author: (slug) => `/authors/${slug}`,
  category: (slug) => `/categories/${slug}`,
}

/** The site path for a document with `_type` and `slug`. */
export function hrefFor(doc: Doc | undefined | null) {
  const slug = stegaClean(doc?.slug)
  const route = ROUTES[stegaClean(doc?._type) as string]
  return route && slug ? route(slug) : '#'
}

/** `link` objects: internal references or external URLs. */
export function linkProps(link: Doc | undefined | null) {
  if (!link) return {href: '#', label: ''}
  const external = stegaClean(link.kind) === 'external'
  const href = external ? stegaClean(link.external) ?? '#' : hrefFor(link.internal)
  const label = link.label || link.internal?.title || link.internal?.name || link.external || ''
  return {href, label, ...(external && link.newTab ? {target: '_blank', rel: 'noreferrer'} : {})}
}

export function money(amount: number | undefined, currency = 'USD') {
  if (amount === undefined || amount === null) return ''
  return new Intl.NumberFormat('en', {style: 'currency', currency: stegaClean(currency) || 'USD'}).format(amount)
}

export function formatDate(value: string | undefined, options: Intl.DateTimeFormatOptions = {dateStyle: 'medium'}) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-GB', {timeZone: 'UTC', ...options}).format(new Date(stegaClean(value)))
}

export function bytes(size: number | undefined) {
  if (!size) return ''
  return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}

export {stegaClean}
