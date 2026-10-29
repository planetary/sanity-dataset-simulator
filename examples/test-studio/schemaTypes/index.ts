import {defineArrayMember, defineField, defineType} from 'sanity'

export const author = defineType({
  name: 'author',
  title: 'Author',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string', validation: (rule) => rule.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}}),
    defineField({name: 'bio', type: 'text'}),
    defineField({name: 'portrait', type: 'image', options: {hotspot: true}}),
  ],
})

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
    defineField({name: 'publishedAt', type: 'datetime'}),
    defineField({name: 'author', type: 'reference', to: [{type: 'author'}]}),
    defineField({name: 'mainImage', type: 'image', options: {hotspot: true}}),
    defineField({name: 'tags', type: 'array', of: [{type: 'string'}], options: {layout: 'tags'}}),
    defineField({name: 'body', type: 'array', of: [defineArrayMember({type: 'block'}), defineArrayMember({type: 'image'})]}),
  ],
  preview: {select: {title: 'title', subtitle: 'author.name', media: 'mainImage'}},
})

export const schemaTypes = [author, post]
