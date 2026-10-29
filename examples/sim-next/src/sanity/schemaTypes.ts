import {announcement, article, author, category, event, navigation, page, product, settings, venue} from './schema/documents'
import {callout, figure, footnote, libraryVideo, link, localeString, menuItem, productMention, richText, seo, videoEmbed} from './schema/objects'
import {callToAction, faq, featureGrid, featuredContent, gallery, hero, mapSection, statsBand, testimonials, textSection} from './schema/sections'

export const schemaTypes = [
  // documents
  settings,
  navigation,
  announcement,
  page,
  article,
  author,
  category,
  product,
  venue,
  event,
  // shared objects
  localeString,
  figure,
  link,
  menuItem,
  seo,
  callout,
  videoEmbed,
  libraryVideo,
  productMention,
  footnote,
  richText,
  // page builder sections
  hero,
  featureGrid,
  statsBand,
  featuredContent,
  gallery,
  testimonials,
  faq,
  textSection,
  mapSection,
  callToAction,
]

/** Documents that exist once, edited from fixed places in the desk. */
export const SINGLETONS = ['settings', 'navigation']
