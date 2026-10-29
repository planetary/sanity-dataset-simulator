import {defineField, defineType} from 'sanity'

// Singleton with a strong reference into the article graph.
export const siteSettings = defineType({
  name: 'siteSettings',
  title: 'Site settings',
  type: 'document',
  fields: [
    defineField({name: 'siteTitle', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'featuredArticle', type: 'reference', to: [{type: 'article'}]}),
    defineField({name: 'homePage', type: 'reference', to: [{type: 'page'}]}),
  ],
})
