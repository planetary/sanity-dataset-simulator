import {BellIcon} from '@sanity/icons/Bell'
import {CalendarIcon} from '@sanity/icons/Calendar'
import {CogIcon} from '@sanity/icons/Cog'
import {DocumentTextIcon} from '@sanity/icons/DocumentText'
import {FolderIcon} from '@sanity/icons/Folder'
import {MenuIcon} from '@sanity/icons/Menu'
import {PackageIcon} from '@sanity/icons/Package'
import {PinIcon} from '@sanity/icons/Pin'
import {UserIcon} from '@sanity/icons/User'
import {DocumentIcon} from '@sanity/icons/Document'
import {defineArrayMember, defineField, defineType} from 'sanity'
import {SECTION_TYPES} from './sections'

const slugField = (source = 'title') =>
  defineField({name: 'slug', type: 'slug', options: {source, maxLength: 96}, validation: (rule) => rule.required()})

/* ---------------------------------------------------------------- singletons */

export const settings = defineType({
  name: 'settings',
  title: 'Site settings',
  type: 'document',
  icon: CogIcon,
  groups: [{name: 'general', title: 'General', default: true}, {name: 'brand', title: 'Brand'}, {name: 'social', title: 'Social'}],
  fields: [
    defineField({name: 'title', type: 'string', group: 'general', validation: (rule) => rule.required()}),
    defineField({name: 'tagline', type: 'localeString', group: 'general'}),
    defineField({name: 'homepage', type: 'reference', to: [{type: 'page'}], group: 'general'}),
    defineField({name: 'contactEmail', type: 'email', group: 'general'}),
    defineField({name: 'logo', type: 'image', group: 'brand'}),
    defineField({name: 'brandColor', type: 'color', group: 'brand'}),
    defineField({name: 'footerNote', type: 'richText', group: 'general'}),
    defineField({
      name: 'social',
      type: 'array',
      group: 'social',
      of: [
        defineArrayMember({
          name: 'socialLink',
          type: 'object',
          fields: [
            defineField({name: 'network', type: 'string', options: {list: ['Instagram', 'Mastodon', 'YouTube', 'Bluesky', 'LinkedIn']}}),
            defineField({name: 'url', type: 'url'}),
          ],
          preview: {select: {title: 'network', subtitle: 'url'}},
        }),
      ],
    }),
    defineField({name: 'seo', type: 'seo', group: 'general'}),
  ],
  preview: {select: {title: 'title'}},
})

export const navigation = defineType({
  name: 'navigation',
  title: 'Navigation',
  type: 'document',
  icon: MenuIcon,
  fields: [
    defineField({name: 'title', type: 'string', readOnly: true, initialValue: 'Main navigation'}),
    defineField({name: 'items', type: 'array', of: [defineArrayMember({type: 'menuItem'})]}),
  ],
})

/** Live-edited: changes publish immediately, with no draft. */
export const announcement = defineType({
  name: 'announcement',
  title: 'Announcement bar',
  type: 'document',
  icon: BellIcon,
  liveEdit: true,
  fields: [
    defineField({name: 'enabled', type: 'boolean', initialValue: true}),
    defineField({name: 'message', type: 'string'}),
    defineField({name: 'link', type: 'link'}),
    defineField({name: 'startsAt', type: 'datetime'}),
    defineField({name: 'endsAt', type: 'datetime', validation: (rule) => rule.min(rule.valueOfField('startsAt'))}),
  ],
  preview: {select: {title: 'message', enabled: 'enabled'}, prepare: ({title, enabled}) => ({title, subtitle: enabled ? 'Showing' : 'Hidden'})},
})

/* ---------------------------------------------------------------- pages */

export const page = defineType({
  name: 'page',
  title: 'Page',
  type: 'document',
  icon: DocumentIcon,
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    slugField(),
    defineField({name: 'sections', title: 'Page builder', type: 'array', of: SECTION_TYPES.map((type) => defineArrayMember({type})), options: {insertMenu: {views: [{name: 'grid'}, {name: 'list'}]}}}),
    defineField({name: 'seo', type: 'seo'}),
  ],
  preview: {select: {title: 'title', slug: 'slug.current'}, prepare: ({title, slug}) => ({title, subtitle: `/${slug ?? ''}`})},
})

/* ---------------------------------------------------------------- editorial */

export const author = defineType({
  name: 'author',
  title: 'Author',
  type: 'document',
  icon: UserIcon,
  fields: [
    defineField({name: 'name', type: 'string', validation: (rule) => rule.required()}),
    slugField('name'),
    defineField({name: 'role', type: 'string', options: {list: ['Editor', 'Writer', 'Photographer', 'Guide']}}),
    defineField({name: 'portrait', type: 'figure'}),
    defineField({name: 'bio', type: 'richText'}),
    defineField({name: 'email', type: 'email'}),
    defineField({name: 'website', type: 'url'}),
    defineField({name: 'favoriteColor', type: 'color'}),
    defineField({name: 'basedIn', title: 'Based in', type: 'geopoint'}),
  ],
  preview: {select: {title: 'name', subtitle: 'role', media: 'portrait'}},
})

/** Hierarchical: a category can have a parent category. */
export const category = defineType({
  name: 'category',
  title: 'Category',
  type: 'document',
  icon: FolderIcon,
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    slugField(),
    defineField({
      name: 'parent',
      type: 'reference',
      to: [{type: 'category'}],
      options: {filter: ({document}) => ({filter: '_id != $self && !defined(parent)', params: {self: document._id.replace(/^drafts\./, '')}})},
      description: 'Top-level categories have no parent',
    }),
    defineField({name: 'description', type: 'text', rows: 2}),
    defineField({name: 'color', type: 'color'}),
  ],
  preview: {
    select: {title: 'title', parent: 'parent.title'},
    prepare: ({title, parent}) => ({title: parent ? `${parent} › ${title}` : title}),
  },
})

export const article = defineType({
  name: 'article',
  title: 'Article',
  type: 'document',
  icon: DocumentTextIcon,
  groups: [
    {name: 'content', title: 'Content', default: true},
    {name: 'meta', title: 'Details'},
    {name: 'seo', title: 'SEO'},
  ],
  fieldsets: [{name: 'dates', title: 'Dates', options: {columns: 2}}],
  fields: [
    defineField({name: 'title', type: 'string', group: 'content', validation: (rule) => rule.required().max(90)}),
    slugField(),
    defineField({name: 'kicker', type: 'string', group: 'content', description: 'A short line above the title'}),
    defineField({name: 'excerpt', type: 'text', rows: 3, group: 'content'}),
    defineField({name: 'cover', type: 'figure', group: 'content'}),
    defineField({name: 'body', type: 'richText', group: 'content'}),
    defineField({name: 'author', type: 'reference', to: [{type: 'author'}], group: 'meta', validation: (rule) => rule.required()}),
    defineField({name: 'contributors', type: 'array', group: 'meta', of: [defineArrayMember({type: 'reference', to: [{type: 'author'}]})], validation: (rule) => rule.unique()}),
    defineField({name: 'categories', type: 'array', group: 'meta', of: [defineArrayMember({type: 'reference', to: [{type: 'category'}]})]}),
    defineField({name: 'tags', type: 'array', group: 'meta', of: [defineArrayMember({type: 'string'})], options: {layout: 'tags'}}),
    defineField({name: 'publishedAt', type: 'datetime', group: 'meta', fieldset: 'dates'}),
    defineField({name: 'updatedOn', type: 'date', group: 'meta', fieldset: 'dates'}),
    defineField({name: 'readingTime', title: 'Reading time (minutes)', type: 'number', group: 'meta', validation: (rule) => rule.min(1).integer()}),
    defineField({name: 'featured', type: 'boolean', group: 'meta', initialValue: false}),
    defineField({name: 'location', title: 'Where it happened', type: 'geopoint', group: 'meta'}),
    defineField({
      name: 'related',
      title: 'Related content',
      type: 'array',
      group: 'meta',
      of: [defineArrayMember({type: 'reference', to: [{type: 'article'}, {type: 'product'}, {type: 'event'}], options: {filter: ({document}) => ({filter: '_id != $self', params: {self: document._id.replace(/^drafts\./, '')}})}})],
    }),
    defineField({name: 'attachments', type: 'array', group: 'meta', of: [defineArrayMember({type: 'file', fields: [defineField({name: 'description', type: 'string'})]})]}),
    defineField({name: 'seo', type: 'seo', group: 'seo'}),
  ],
  orderings: [
    {title: 'Newest first', name: 'publishedDesc', by: [{field: 'publishedAt', direction: 'desc'}]},
    {title: 'Title', name: 'titleAsc', by: [{field: 'title', direction: 'asc'}]},
  ],
  preview: {
    select: {title: 'title', author: 'author.name', media: 'cover', featured: 'featured'},
    prepare: ({title, author, media, featured}) => ({title: `${featured ? '★ ' : ''}${title}`, subtitle: author, media}),
  },
})

/* ---------------------------------------------------------------- shop */

export const product = defineType({
  name: 'product',
  title: 'Product',
  type: 'document',
  icon: PackageIcon,
  groups: [
    {name: 'content', title: 'Content', default: true},
    {name: 'commerce', title: 'Pricing & stock'},
    {name: 'specs', title: 'Specs'},
  ],
  fields: [
    defineField({name: 'title', type: 'string', group: 'content', validation: (rule) => rule.required()}),
    slugField(),
    defineField({name: 'name', title: 'Name (localized)', type: 'localeString', group: 'content'}),
    defineField({name: 'images', type: 'array', group: 'content', of: [defineArrayMember({type: 'figure'})], validation: (rule) => rule.min(1)}),
    defineField({name: 'description', type: 'richText', group: 'content'}),
    defineField({name: 'category', type: 'reference', to: [{type: 'category'}], group: 'content'}),
    defineField({name: 'price', type: 'number', group: 'commerce', validation: (rule) => rule.required().positive().precision(2)}),
    defineField({name: 'currency', type: 'string', group: 'commerce', options: {list: ['USD', 'EUR', 'GBP'], layout: 'radio', direction: 'horizontal'}, initialValue: 'USD'}),
    defineField({name: 'onSale', type: 'boolean', group: 'commerce', initialValue: false}),
    defineField({name: 'salePrice', type: 'number', group: 'commerce', hidden: ({document}) => !document?.onSale, validation: (rule) => rule.positive().precision(2)}),
    defineField({
      name: 'variants',
      type: 'array',
      group: 'commerce',
      of: [
        defineArrayMember({
          name: 'variant',
          type: 'object',
          fields: [
            defineField({name: 'name', type: 'string'}),
            defineField({name: 'sku', title: 'SKU', type: 'string', validation: (rule) => rule.regex(/^[A-Z0-9-]+$/, {name: 'SKU'})}),
            defineField({name: 'color', type: 'color'}),
            defineField({name: 'size', type: 'string', options: {list: ['XS', 'S', 'M', 'L', 'XL', 'One size']}}),
            defineField({name: 'stock', type: 'number', validation: (rule) => rule.min(0).integer()}),
            defineField({name: 'image', type: 'image', options: {hotspot: true}}),
          ],
          preview: {
            select: {title: 'name', sku: 'sku', stock: 'stock', media: 'image'},
            prepare: ({title, sku, stock, media}) => ({title, subtitle: `${sku ?? ''} · ${stock ?? 0} in stock`, media}),
          },
        }),
      ],
    }),
    defineField({name: 'specs', title: 'Spec sheet', type: 'table', group: 'specs'}),
    defineField({name: 'weightGrams', title: 'Weight (g)', type: 'number', group: 'specs'}),
    defineField({name: 'manual', title: 'Manual (PDF)', type: 'file', group: 'specs', options: {accept: 'application/pdf'}}),
    defineField({name: 'relatedProducts', type: 'array', group: 'content', of: [defineArrayMember({type: 'reference', to: [{type: 'product'}]})]}),
    defineField({name: 'seo', type: 'seo', group: 'content'}),
  ],
  preview: {
    select: {title: 'title', price: 'price', currency: 'currency', media: 'images.0'},
    prepare: ({title, price, currency, media}) => ({title, subtitle: price ? `${currency ?? 'USD'} ${price.toFixed(2)}` : undefined, media}),
  },
})

/* ---------------------------------------------------------------- events */

export const venue = defineType({
  name: 'venue',
  title: 'Venue',
  type: 'document',
  icon: PinIcon,
  fields: [
    defineField({name: 'name', type: 'string', validation: (rule) => rule.required()}),
    defineField({
      name: 'address',
      type: 'object',
      options: {columns: 2},
      fields: [
        defineField({name: 'street', type: 'string'}),
        defineField({name: 'city', type: 'string'}),
        defineField({name: 'postalCode', type: 'string'}),
        defineField({name: 'country', type: 'string'}),
      ],
    }),
    defineField({name: 'location', type: 'geopoint', validation: (rule) => rule.required()}),
    defineField({name: 'capacity', type: 'number'}),
    defineField({name: 'accessible', title: 'Step-free access', type: 'boolean'}),
    defineField({name: 'photo', type: 'figure'}),
  ],
  preview: {select: {title: 'name', subtitle: 'address.city', media: 'photo'}},
})

export const event = defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  icon: CalendarIcon,
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    slugField(),
    defineField({name: 'format', type: 'string', options: {list: [{title: 'In person', value: 'in-person'}, {title: 'Online', value: 'online'}, {title: 'Hybrid', value: 'hybrid'}], layout: 'radio'}, initialValue: 'in-person'}),
    defineField({name: 'startsAt', type: 'datetime', validation: (rule) => rule.required()}),
    defineField({name: 'endsAt', type: 'datetime', validation: (rule) => rule.min(rule.valueOfField('startsAt'))}),
    defineField({name: 'venue', type: 'reference', to: [{type: 'venue'}], hidden: ({document}) => document?.format === 'online'}),
    defineField({name: 'streamUrl', title: 'Stream URL', type: 'url', hidden: ({document}) => document?.format === 'in-person'}),
    defineField({name: 'cover', type: 'figure'}),
    defineField({name: 'summary', type: 'text', rows: 3}),
    defineField({name: 'speakers', type: 'array', of: [defineArrayMember({type: 'reference', to: [{type: 'author'}]})]}),
    defineField({
      name: 'schedule',
      description: 'Days, each with timed sessions',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'day',
          type: 'object',
          fields: [
            defineField({name: 'date', type: 'date'}),
            defineField({
              name: 'sessions',
              type: 'array',
              of: [
                defineArrayMember({
                  name: 'session',
                  type: 'object',
                  fields: [
                    defineField({name: 'time', type: 'string', validation: (rule) => rule.regex(/^\d{2}:\d{2}$/, {name: 'HH:MM'})}),
                    defineField({name: 'title', type: 'string'}),
                    defineField({name: 'speaker', type: 'reference', to: [{type: 'author'}]}),
                    defineField({name: 'room', type: 'string'}),
                  ],
                  preview: {select: {title: 'title', time: 'time', speaker: 'speaker.name'}, prepare: ({title, time, speaker}) => ({title: `${time ?? ''} ${title ?? ''}`, subtitle: speaker})},
                }),
              ],
            }),
          ],
          preview: {select: {title: 'date', sessions: 'sessions'}, prepare: ({title, sessions}) => ({title, subtitle: `${sessions?.length ?? 0} sessions`})},
        }),
      ],
    }),
    defineField({
      name: 'tickets',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'ticket',
          type: 'object',
          fields: [
            defineField({name: 'name', type: 'string'}),
            defineField({name: 'price', type: 'number'}),
            defineField({name: 'soldOut', type: 'boolean'}),
          ],
          preview: {select: {title: 'name', price: 'price', soldOut: 'soldOut'}, prepare: ({title, price, soldOut}) => ({title, subtitle: soldOut ? 'Sold out' : price ? `$${price}` : 'Free'})},
        }),
      ],
    }),
    defineField({name: 'gearList', title: 'What to bring', type: 'array', of: [defineArrayMember({type: 'reference', to: [{type: 'product'}]})]}),
    defineField({name: 'details', type: 'richText'}),
  ],
  orderings: [{title: 'Soonest', name: 'startsAsc', by: [{field: 'startsAt', direction: 'asc'}]}],
  preview: {
    select: {title: 'title', startsAt: 'startsAt', venue: 'venue.name', media: 'cover'},
    prepare: ({title, startsAt, venue, media}) => ({title, subtitle: [startsAt?.slice(0, 10), venue].filter(Boolean).join(' · '), media}),
  },
})
