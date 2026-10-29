import {BulbOutlineIcon} from '@sanity/icons/BulbOutline'
import {CodeIcon} from '@sanity/icons/Code'
import {ImageIcon} from '@sanity/icons/Image'
import {LinkIcon} from '@sanity/icons/Link'
import {PlayIcon} from '@sanity/icons/Play'
import {TagIcon} from '@sanity/icons/Tag'
import {defineArrayMember, defineField, defineType} from 'sanity'
import {defineVideoField} from 'sanity/media-library'

/** The site's languages: field-level localization through one reusable object type. */
export const LANGUAGES = [
  {id: 'en', title: 'English'},
  {id: 'es', title: 'Español'},
  {id: 'fr', title: 'Français'},
]

export const localeString = defineType({
  name: 'localeString',
  title: 'Localized string',
  type: 'object',
  fieldsets: [{name: 'translations', title: 'Translations', options: {collapsible: true, collapsed: true}}],
  fields: LANGUAGES.map((lang) =>
    defineField({name: lang.id, title: lang.title, type: 'string', fieldset: lang.id === 'en' ? undefined : 'translations'}),
  ),
})

/** An image with editorial fields, hotspot/crop and full metadata extraction. */
export const figure = defineType({
  name: 'figure',
  title: 'Figure',
  type: 'image',
  icon: ImageIcon,
  options: {hotspot: true, metadata: ['blurhash', 'lqip', 'palette', 'exif', 'location']},
  fields: [
    defineField({name: 'alt', title: 'Alternative text', type: 'string', validation: (rule) => rule.required().warning('Describe the image for screen readers')}),
    defineField({name: 'caption', type: 'string'}),
    defineField({name: 'credit', type: 'string'}),
  ],
  preview: {select: {title: 'caption', subtitle: 'alt', media: 'asset'}},
})

/** A link that is either internal (a reference) or external (a URL), shown conditionally. */
export const link = defineType({
  name: 'link',
  title: 'Link',
  type: 'object',
  icon: LinkIcon,
  fields: [
    defineField({name: 'label', type: 'string'}),
    defineField({
      name: 'kind',
      type: 'string',
      options: {list: [{title: 'Internal', value: 'internal'}, {title: 'External', value: 'external'}], layout: 'radio', direction: 'horizontal'},
      initialValue: 'internal',
    }),
    defineField({
      name: 'internal',
      type: 'reference',
      to: [{type: 'page'}, {type: 'article'}, {type: 'product'}, {type: 'event'}, {type: 'category'}],
      hidden: ({parent}) => parent?.kind !== 'internal',
    }),
    defineField({
      name: 'external',
      type: 'url',
      validation: (rule) => rule.uri({scheme: ['http', 'https', 'mailto', 'tel']}),
      hidden: ({parent}) => parent?.kind !== 'external',
    }),
    defineField({name: 'newTab', title: 'Open in a new tab', type: 'boolean', initialValue: false, hidden: ({parent}) => parent?.kind !== 'external'}),
  ],
  preview: {
    select: {label: 'label', kind: 'kind', internal: 'internal.title', external: 'external'},
    prepare: ({label, kind, internal, external}) => ({title: label || internal || external || 'Link', subtitle: kind === 'external' ? external : internal}),
  },
})

/** A recursive navigation item: items can hold children, which can hold children. */
export const menuItem = defineType({
  name: 'menuItem',
  title: 'Menu item',
  type: 'object',
  fields: [
    defineField({name: 'link', type: 'link'}),
    defineField({name: 'children', title: 'Sub-items', type: 'array', of: [defineArrayMember({type: 'menuItem'})]}),
  ],
  preview: {
    select: {title: 'link.label', internal: 'link.internal.title', children: 'children'},
    prepare: ({title, internal, children}) => ({title: title || internal || 'Item', subtitle: children?.length ? `${children.length} sub-item(s)` : undefined}),
  },
})

export const seo = defineType({
  name: 'seo',
  title: 'SEO',
  type: 'object',
  options: {collapsible: true, collapsed: true},
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.max(60).warning('Search engines truncate titles over 60 characters')}),
    defineField({name: 'description', type: 'text', rows: 3, validation: (rule) => rule.max(160).warning('Keep it under 160 characters')}),
    defineField({name: 'image', title: 'Share image', type: 'image'}),
    defineField({name: 'noIndex', title: 'Hide from search engines', type: 'boolean', initialValue: false}),
  ],
})

export const callout = defineType({
  name: 'callout',
  title: 'Callout',
  type: 'object',
  icon: BulbOutlineIcon,
  fields: [
    defineField({
      name: 'tone',
      type: 'string',
      options: {list: ['note', 'tip', 'warning'], layout: 'radio', direction: 'horizontal'},
      initialValue: 'note',
    }),
    defineField({name: 'body', type: 'text', rows: 3, validation: (rule) => rule.required()}),
  ],
  preview: {select: {title: 'body', subtitle: 'tone'}},
})

export const videoEmbed = defineType({
  name: 'videoEmbed',
  title: 'Video embed',
  type: 'object',
  icon: PlayIcon,
  fields: [
    defineField({name: 'url', title: 'URL', type: 'url', validation: (rule) => rule.required()}),
    defineField({name: 'caption', type: 'string'}),
  ],
  preview: {select: {title: 'caption', subtitle: 'url'}},
})

/** A Media Library video (sanity.video), stored as global document references. */
export const libraryVideo = defineType({
  name: 'libraryVideo',
  title: 'Library video',
  type: 'object',
  icon: PlayIcon,
  fields: [defineVideoField({name: 'video', title: 'Video'}), defineField({name: 'caption', type: 'string'})],
  preview: {select: {title: 'caption'}, prepare: ({title}) => ({title: title || 'Video from the Media Library'})},
})

/** Inline object inside text: a product mention renders as a chip with the price. */
export const productMention = defineType({
  name: 'productMention',
  title: 'Product mention',
  type: 'object',
  icon: TagIcon,
  fields: [defineField({name: 'product', type: 'reference', to: [{type: 'product'}], validation: (rule) => rule.required()})],
  preview: {select: {title: 'product.title'}},
})

export const footnote = defineType({
  name: 'footnote',
  title: 'Footnote',
  type: 'object',
  fields: [defineField({name: 'text', type: 'text', rows: 2})],
})

/** Rich text with every portable text feature: styles, lists, marks, annotations, inline and block objects. */
export const richText = defineType({
  name: 'richText',
  title: 'Rich text',
  type: 'array',
  of: [
    defineArrayMember({
      type: 'block',
      styles: [
        {title: 'Normal', value: 'normal'},
        {title: 'Heading 2', value: 'h2'},
        {title: 'Heading 3', value: 'h3'},
        {title: 'Heading 4', value: 'h4'},
        {title: 'Quote', value: 'blockquote'},
        {title: 'Lead', value: 'lead'},
      ],
      lists: [
        {title: 'Bullet', value: 'bullet'},
        {title: 'Numbered', value: 'number'},
      ],
      marks: {
        decorators: [
          {title: 'Strong', value: 'strong'},
          {title: 'Emphasis', value: 'em'},
          {title: 'Code', value: 'code'},
          {title: 'Underline', value: 'underline'},
          {title: 'Strike', value: 'strike-through'},
          {title: 'Highlight', value: 'highlight', icon: () => 'H'},
        ],
        annotations: [
          defineArrayMember({
            name: 'externalLink',
            title: 'External link',
            type: 'object',
            icon: LinkIcon,
            fields: [
              defineField({name: 'href', type: 'url', validation: (rule) => rule.uri({scheme: ['http', 'https', 'mailto']})}),
              defineField({name: 'newTab', type: 'boolean', initialValue: true}),
            ],
          }),
          defineArrayMember({
            name: 'internalLink',
            title: 'Internal link',
            type: 'object',
            fields: [defineField({name: 'reference', type: 'reference', to: [{type: 'article'}, {type: 'product'}, {type: 'event'}, {type: 'page'}, {type: 'author'}]})],
          }),
          defineArrayMember({type: 'footnote'}),
        ],
      },
      of: [defineArrayMember({type: 'productMention'})],
    }),
    defineArrayMember({type: 'figure'}),
    defineArrayMember({type: 'callout'}),
    defineArrayMember({type: 'code', title: 'Code', icon: CodeIcon, options: {withFilename: true, languageAlternatives: [{title: 'TypeScript', value: 'typescript'}, {title: 'GROQ', value: 'groq'}, {title: 'Shell', value: 'sh'}, {title: 'JSON', value: 'json'}]}}),
    defineArrayMember({type: 'table', title: 'Table'}),
    defineArrayMember({type: 'videoEmbed'}),
    defineArrayMember({type: 'libraryVideo'}),
  ],
})
