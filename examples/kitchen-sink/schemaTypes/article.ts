import {defineArrayMember, defineField, defineType} from 'sanity'

// Adversarial coverage: ordered-slice queries (publishedAt), strong ref,
// weak ref array, non-keyed string array, keyed object array, Portable Text
// with marks and an inline object.
export const article = defineType({
  name: 'article',
  title: 'Article',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}, validation: (r) => r.required()}),
    defineField({name: 'publishedAt', type: 'datetime', validation: (r) => r.required()}),
    // Non-keyed primitive array: full-array touch semantics (PRD §17.7)
    defineField({name: 'tags', type: 'array', of: [{type: 'string'}]}),
    // Strong reference: delete-protection semantics (PRD §18.8)
    defineField({name: 'author', type: 'reference', to: [{type: 'author'}], validation: (r) => r.required()}),
    // Weak reference array
    defineField({
      name: 'related',
      type: 'array',
      of: [defineArrayMember({type: 'reference', to: [{type: 'article'}], weak: true})],
    }),
    // Portable Text with marks and an inline object
    defineField({
      name: 'body',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'block',
          of: [defineArrayMember({name: 'inlineStat', type: 'object', fields: [
            defineField({name: 'label', type: 'string'}),
            defineField({name: 'value', type: 'number'}),
          ]})],
        }),
        defineArrayMember({type: 'image'}),
      ],
    }),
    // Keyed object array: _key merge semantics (PRD §17.7)
    defineField({
      name: 'sections',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'quoteSection',
          type: 'object',
          fields: [
            defineField({name: 'quote', type: 'text'}),
            defineField({name: 'attribution', type: 'string'}),
          ],
        }),
        defineArrayMember({
          name: 'statsSection',
          type: 'object',
          fields: [
            defineField({name: 'heading', type: 'string'}),
            defineField({name: 'count', type: 'number'}),
          ],
        }),
      ],
    }),
  ],
})
