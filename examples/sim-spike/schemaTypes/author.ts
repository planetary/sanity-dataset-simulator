import {defineField, defineType} from 'sanity'

// Adversarial coverage: strong ref target, weak self-referencing cycle
// (author -> favoriteArticle -> author), image asset, slug.
export const author = defineType({
  name: 'author',
  title: 'Author',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'name'}}),
    defineField({name: 'bio', type: 'text'}),
    defineField({name: 'portrait', type: 'image'}),
    // Weak reference completing a cycle with article.author
    defineField({name: 'favoriteArticle', type: 'reference', to: [{type: 'article'}], weak: true}),
  ],
})
