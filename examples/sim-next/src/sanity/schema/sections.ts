import {BlockContentIcon} from '@sanity/icons/BlockContent'
import {CommentIcon} from '@sanity/icons/Comment'
import {DashboardIcon} from '@sanity/icons/Dashboard'
import {HelpCircleIcon} from '@sanity/icons/HelpCircle'
import {ImagesIcon} from '@sanity/icons/Images'
import {PinIcon} from '@sanity/icons/Pin'
import {RocketIcon} from '@sanity/icons/Rocket'
import {StarIcon} from '@sanity/icons/Star'
import {TrendUpwardIcon} from '@sanity/icons/TrendUpward'
import {defineArrayMember, defineField, defineType} from 'sanity'

/** Page builder sections: each is an object type, used together in `page.sections`. */

export const hero = defineType({
  name: 'hero',
  title: 'Hero',
  type: 'object',
  icon: RocketIcon,
  groups: [{name: 'content', title: 'Content', default: true}, {name: 'style', title: 'Style'}],
  fields: [
    defineField({name: 'eyebrow', type: 'string', group: 'content'}),
    defineField({name: 'heading', type: 'string', group: 'content', validation: (rule) => rule.required()}),
    defineField({name: 'subheading', type: 'text', rows: 2, group: 'content'}),
    defineField({name: 'image', type: 'figure', group: 'content'}),
    defineField({name: 'actions', title: 'Buttons', type: 'array', of: [defineArrayMember({type: 'link'})], validation: (rule) => rule.max(2), group: 'content'}),
    defineField({
      name: 'layout',
      type: 'string',
      group: 'style',
      options: {list: [{title: 'Image right', value: 'split'}, {title: 'Full-bleed image', value: 'cover'}, {title: 'Text only', value: 'text'}], layout: 'radio'},
      initialValue: 'split',
    }),
    defineField({name: 'background', type: 'color', group: 'style'}),
  ],
  preview: {select: {title: 'heading', subtitle: 'eyebrow', media: 'image'}, prepare: (s) => ({...s, subtitle: `Hero · ${s.subtitle ?? ''}`})},
})

export const featureGrid = defineType({
  name: 'featureGrid',
  title: 'Feature grid',
  type: 'object',
  icon: DashboardIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({name: 'columns', type: 'number', options: {list: [2, 3, 4]}, initialValue: 3}),
    defineField({
      name: 'features',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'feature',
          type: 'object',
          fields: [
            defineField({name: 'title', type: 'string'}),
            defineField({name: 'body', type: 'text', rows: 3}),
            defineField({name: 'icon', type: 'string', description: 'An emoji or short symbol'}),
            defineField({name: 'link', type: 'link'}),
          ],
          preview: {select: {title: 'title', subtitle: 'body'}},
        }),
      ],
    }),
  ],
  preview: {select: {title: 'heading', features: 'features'}, prepare: ({title, features}) => ({title: title || 'Feature grid', subtitle: `${features?.length ?? 0} features`})},
})

export const statsBand = defineType({
  name: 'statsBand',
  title: 'Stats band',
  type: 'object',
  icon: TrendUpwardIcon,
  fields: [
    defineField({
      name: 'stats',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'stat',
          type: 'object',
          fields: [
            defineField({name: 'value', type: 'number', validation: (rule) => rule.required()}),
            defineField({name: 'unit', type: 'string'}),
            defineField({name: 'label', type: 'string'}),
          ],
          preview: {select: {value: 'value', unit: 'unit', label: 'label'}, prepare: ({value, unit, label}) => ({title: `${value}${unit ?? ''}`, subtitle: label})},
        }),
      ],
      validation: (rule) => rule.min(2).max(4),
    }),
  ],
  preview: {prepare: () => ({title: 'Stats band'})},
})

export const featuredContent = defineType({
  name: 'featuredContent',
  title: 'Featured content',
  type: 'object',
  icon: StarIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({
      name: 'items',
      description: 'Any mix of articles, products and events',
      type: 'array',
      of: [defineArrayMember({type: 'reference', to: [{type: 'article'}, {type: 'product'}, {type: 'event'}]})],
      validation: (rule) => rule.unique(),
    }),
  ],
  preview: {select: {title: 'heading', items: 'items'}, prepare: ({title, items}) => ({title: title || 'Featured content', subtitle: `${items?.length ?? 0} items`})},
})

export const gallery = defineType({
  name: 'gallery',
  title: 'Gallery',
  type: 'object',
  icon: ImagesIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({name: 'layout', type: 'string', options: {list: ['grid', 'masonry', 'carousel'], layout: 'dropdown'}, initialValue: 'grid'}),
    defineField({name: 'images', type: 'array', of: [defineArrayMember({type: 'figure'})], options: {layout: 'grid'}}),
  ],
  preview: {select: {title: 'heading', media: 'images.0', images: 'images'}, prepare: ({title, media, images}) => ({title: title || 'Gallery', subtitle: `${images?.length ?? 0} images`, media})},
})

export const testimonials = defineType({
  name: 'testimonials',
  title: 'Testimonials',
  type: 'object',
  icon: CommentIcon,
  fields: [
    defineField({
      name: 'quotes',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'quote',
          type: 'object',
          fields: [
            defineField({name: 'text', type: 'text', rows: 3}),
            defineField({name: 'author', title: 'Author (from the team)', type: 'reference', to: [{type: 'author'}], weak: true}),
            defineField({name: 'name', title: 'Or a name', type: 'string', hidden: ({parent}) => Boolean(parent?.author)}),
            defineField({name: 'rating', type: 'number', validation: (rule) => rule.min(1).max(5).integer()}),
          ],
          preview: {select: {title: 'text', author: 'author.name', name: 'name'}, prepare: ({title, author, name}) => ({title, subtitle: author || name})},
        }),
      ],
    }),
  ],
  preview: {select: {quotes: 'quotes'}, prepare: ({quotes}) => ({title: 'Testimonials', subtitle: `${quotes?.length ?? 0} quotes`})},
})

/** Nested arrays: groups of questions, each with rich-text answers. */
export const faq = defineType({
  name: 'faq',
  title: 'FAQ',
  type: 'object',
  icon: HelpCircleIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({
      name: 'groups',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'faqGroup',
          type: 'object',
          fields: [
            defineField({name: 'title', type: 'string'}),
            defineField({
              name: 'items',
              type: 'array',
              of: [
                defineArrayMember({
                  name: 'faqItem',
                  type: 'object',
                  fields: [defineField({name: 'question', type: 'string'}), defineField({name: 'answer', type: 'richText'})],
                  preview: {select: {title: 'question'}},
                }),
              ],
            }),
          ],
          preview: {select: {title: 'title', items: 'items'}, prepare: ({title, items}) => ({title, subtitle: `${items?.length ?? 0} questions`})},
        }),
      ],
    }),
  ],
  preview: {select: {title: 'heading'}, prepare: ({title}) => ({title: title || 'FAQ'})},
})

export const textSection = defineType({
  name: 'textSection',
  title: 'Text',
  type: 'object',
  icon: BlockContentIcon,
  fields: [defineField({name: 'heading', type: 'string'}), defineField({name: 'body', type: 'richText'})],
  preview: {select: {title: 'heading'}, prepare: ({title}) => ({title: title || 'Text'})},
})

export const mapSection = defineType({
  name: 'mapSection',
  title: 'Map',
  type: 'object',
  icon: PinIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({name: 'places', type: 'array', of: [defineArrayMember({type: 'reference', to: [{type: 'venue'}]})]}),
  ],
  preview: {select: {title: 'heading'}, prepare: ({title}) => ({title: title || 'Map'})},
})

export const callToAction = defineType({
  name: 'callToAction',
  title: 'Call to action',
  type: 'object',
  icon: RocketIcon,
  fields: [
    defineField({name: 'heading', type: 'string'}),
    defineField({name: 'body', type: 'text', rows: 2}),
    defineField({name: 'action', type: 'link'}),
    defineField({name: 'accent', type: 'color'}),
  ],
  preview: {select: {title: 'heading'}, prepare: ({title}) => ({title: title || 'Call to action'})},
})

export const SECTION_TYPES = ['hero', 'featureGrid', 'statsBand', 'featuredContent', 'gallery', 'testimonials', 'faq', 'textSection', 'mapSection', 'callToAction']
