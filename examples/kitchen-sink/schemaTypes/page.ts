import {defineArrayMember, defineField, defineType} from 'sanity'

// Adversarial coverage: deeply nested object (nested-path touch tracking,
// PRD §17.6), keyed sections, slug lookups. Fixture includes an instance
// with dots in its _id ("legacy.page.v2").
export const page = defineType({
  name: 'page',
  title: 'Page',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}, validation: (r) => r.required()}),
    defineField({
      name: 'hero',
      type: 'object',
      fields: [
        defineField({name: 'heading', type: 'string'}),
        defineField({name: 'subheading', type: 'string'}),
        defineField({
          name: 'cta',
          type: 'object',
          fields: [
            defineField({name: 'label', type: 'string'}),
            defineField({name: 'href', type: 'url'}),
          ],
        }),
      ],
    }),
    defineField({
      name: 'sections',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'textSection',
          type: 'object',
          fields: [
            defineField({name: 'heading', type: 'string'}),
            defineField({name: 'body', type: 'text'}),
          ],
        }),
        defineArrayMember({
          name: 'featuredArticles',
          type: 'object',
          fields: [
            defineField({name: 'heading', type: 'string'}),
            defineField({
              name: 'articles',
              type: 'array',
              of: [defineArrayMember({type: 'reference', to: [{type: 'article'}]})],
            }),
          ],
        }),
      ],
    }),
  ],
})
