import {defineQuery} from 'next-sanity'

/* Reusable projections. Rich text resolves its internal links and product mentions in one pass. */

const TARGET = `{_type, title, name, "slug": slug.current}`
const LINK = `{label, kind, external, newTab, "internal": internal->${TARGET}}`
const RICH = `[]{
  ...,
  markDefs[]{..., _type == "internalLink" => {"target": reference->${TARGET}}},
  children[]{..., _type == "productMention" => {"product": product->{title, price, currency, "slug": slug.current}}},
  _type == "libraryVideo" => {..., "videoRef": video.asset._ref}
}`
const CARD = `{
  _id, _type, title, name, "slug": slug.current, kicker, excerpt, summary, startsAt, price, currency, onSale, salePrice,
  "image": coalesce(cover, images[0], portrait),
  "author": author->name
}`

export const SITE_QUERY = defineQuery(`{
  "settings": *[_id == "settings"][0]{title, tagline, contactEmail, brandColor, footerNote${RICH}, social},
  "navigation": *[_id == "navigation"][0].items[]{
    _key, link${LINK},
    children[]{_key, link${LINK}, children[]{_key, link${LINK}}}
  },
  "announcement": *[_type == "announcement" && enabled == true && (!defined(startsAt) || startsAt <= now()) && (!defined(endsAt) || endsAt > now())][0]{message, link${LINK}}
}`)

const SECTIONS = `sections[]{
  ...,
  _type == "hero" => {..., actions[]${LINK}},
  _type == "featureGrid" => {..., features[]{..., link${LINK}}},
  _type == "featuredContent" => {..., items[]->${CARD}},
  _type == "testimonials" => {..., quotes[]{..., "author": author->{name, role, portrait}}},
  _type == "faq" => {..., groups[]{..., items[]{..., answer${RICH}}}},
  _type == "textSection" => {..., body${RICH}},
  _type == "mapSection" => {..., places[]->{_id, name, location, address, capacity, accessible}},
  _type == "callToAction" => {..., action${LINK}}
}`

export const HOME_QUERY = defineQuery(`*[_id == "settings"][0].homepage->{_id, title, ${SECTIONS}}`)
export const PAGE_QUERY = defineQuery(`*[_type == "page" && slug.current == $slug][0]{_id, title, ${SECTIONS}}`)

export const ARTICLES_QUERY = defineQuery(`*[_type == "article" && defined(slug.current)] | order(publishedAt desc) ${CARD}`)
export const ARTICLE_QUERY = defineQuery(`*[_type == "article" && slug.current == $slug][0]{
  _id, title, kicker, excerpt, cover, publishedAt, updatedOn, readingTime, featured, tags, location,
  body${RICH},
  "author": author->{name, role, portrait, "slug": slug.current},
  "contributors": contributors[]->{name, role, "slug": slug.current},
  "categories": categories[]->{title, "slug": slug.current, "parent": parent->{title, "slug": slug.current}},
  "related": related[]->${CARD},
  "attachments": attachments[]{description, "url": asset->url, "filename": asset->originalFilename, "size": asset->size}
}`)

export const PRODUCTS_QUERY = defineQuery(`*[_type == "product" && defined(slug.current)] | order(title asc) ${CARD}`)
export const PRODUCT_QUERY = defineQuery(`*[_type == "product" && slug.current == $slug][0]{
  _id, title, name, images, price, currency, onSale, salePrice, weightGrams, specs,
  description${RICH},
  "category": category->{title, "slug": slug.current},
  variants[]{_key, name, sku, size, stock, color, image},
  "manual": manual.asset->{url, originalFilename, size},
  "relatedProducts": relatedProducts[]->${CARD},
  "usedIn": *[_type == "event" && references(^._id)]${CARD}
}`)

export const EVENTS_QUERY = defineQuery(`*[_type == "event" && defined(slug.current)] | order(startsAt desc) ${CARD}`)
export const EVENT_QUERY = defineQuery(`*[_type == "event" && slug.current == $slug][0]{
  _id, title, format, startsAt, endsAt, cover, summary, streamUrl, tickets,
  details${RICH},
  "venue": venue->{name, address, location, capacity, accessible},
  "speakers": speakers[]->{name, role, portrait, "slug": slug.current},
  schedule[]{_key, date, sessions[]{_key, time, title, room, "speaker": speaker->{name, "slug": slug.current}}},
  "gearList": gearList[]->${CARD}
}`)

export const AUTHOR_QUERY = defineQuery(`*[_type == "author" && slug.current == $slug][0]{
  _id, name, role, portrait, email, website, favoriteColor, basedIn,
  bio${RICH},
  "articles": *[_type == "article" && (author._ref == ^._id || ^._id in contributors[]._ref)] | order(publishedAt desc)${CARD},
  "events": *[_type == "event" && ^._id in speakers[]._ref]${CARD}
}`)

export const CATEGORY_QUERY = defineQuery(`*[_type == "category" && slug.current == $slug][0]{
  _id, title, description, color,
  "parent": parent->{title, "slug": slug.current},
  "children": *[_type == "category" && parent._ref == ^._id]{_id, title, "slug": slug.current}
}`)

/** Everything filed under any of these categories (a category and its children). */
export const IN_CATEGORIES_QUERY = defineQuery(`{
  "articles": *[_type == "article" && references($ids)] | order(publishedAt desc)${CARD},
  "products": *[_type == "product" && references($ids)] | order(title asc)${CARD}
}`)
