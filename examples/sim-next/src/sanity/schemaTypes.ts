import {defineField, defineType} from 'sanity'

export const schemaTypes = [
  defineType({
    name: 'post',
    title: 'Post',
    type: 'document',
    fields: [
      defineField({name: 'title', type: 'string'}),
      defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
      defineField({name: 'mainImage', type: 'image'}),
    ],
  }),
]
