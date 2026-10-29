'use client'
import {codeInput} from '@sanity/code-input'
import {colorInput} from '@sanity/color-input'
import {table} from '@sanity/table'
import {visionTool} from '@sanity/vision'
import {defineConfig} from 'sanity'
import {defineDocuments, defineLocations, presentationTool} from 'sanity/presentation'
import {structureTool} from 'sanity/structure'
import {SINGLETONS, schemaTypes} from './src/sanity/schemaTypes'
import {structure} from './src/sanity/structure'

const at = (href: string, title?: string) => ({title: title || 'Untitled', href})

export default defineConfig({
  name: 'meridian',
  title: 'Meridian',
  basePath: '/studio',
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  plugins: [
    structureTool({structure}),
    presentationTool({
      previewUrl: {previewMode: {enable: '/api/draft-mode/enable'}},
      resolve: {
        mainDocuments: defineDocuments([
          {route: '/', filter: `_type == "page" && _id == *[_id == "settings"][0].homepage._ref`},
          {route: '/:slug', filter: `_type == "page" && slug.current == $slug`},
          {route: '/articles/:slug', filter: `_type == "article" && slug.current == $slug`},
          {route: '/products/:slug', filter: `_type == "product" && slug.current == $slug`},
          {route: '/events/:slug', filter: `_type == "event" && slug.current == $slug`},
          {route: '/authors/:slug', filter: `_type == "author" && slug.current == $slug`},
          {route: '/categories/:slug', filter: `_type == "category" && slug.current == $slug`},
        ]),
        locations: {
          page: defineLocations({select: {title: 'title', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/${doc?.slug === 'home' ? '' : doc?.slug}`, doc?.title)]})}),
          article: defineLocations({select: {title: 'title', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/articles/${doc?.slug}`, doc?.title), at('/articles', 'All articles')]})}),
          product: defineLocations({select: {title: 'title', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/products/${doc?.slug}`, doc?.title), at('/products', 'Shop')]})}),
          event: defineLocations({select: {title: 'title', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/events/${doc?.slug}`, doc?.title), at('/events', 'Events')]})}),
          author: defineLocations({select: {title: 'name', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/authors/${doc?.slug}`, doc?.title)]})}),
          category: defineLocations({select: {title: 'title', slug: 'slug.current'}, resolve: (doc) => ({locations: [at(`/categories/${doc?.slug}`, doc?.title)]})}),
          settings: defineLocations({message: 'Used on every page', tone: 'positive'}),
          navigation: defineLocations({message: 'Used on every page', tone: 'positive'}),
          announcement: defineLocations({message: 'Shown at the top of every page while enabled', tone: 'positive'}),
        },
      },
    }),
    visionTool({defaultApiVersion: '2025-02-19'}),
    codeInput(),
    colorInput(),
    table(),
  ],
  schema: {
    types: schemaTypes,
    /* Singletons are opened from the desk, never created from "New document". */
    templates: (templates) => templates.filter(({schemaType}) => !SINGLETONS.includes(schemaType)),
  },
  document: {
    actions: (actions, {schemaType}) => (SINGLETONS.includes(schemaType) ? actions.filter(({action}) => action && ['publish', 'discardChanges', 'restore'].includes(action)) : actions),
  },
  mediaLibrary: {enabled: true},
})
