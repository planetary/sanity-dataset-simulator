'use client'
import {defineConfig} from 'sanity'
import {presentationTool} from 'sanity/presentation'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './src/sanity/schemaTypes'

export default defineConfig({
  basePath: '/studio',
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  plugins: [
    structureTool(),
    presentationTool({
      previewUrl: {previewMode: {enable: '/api/draft-mode/enable'}},
      resolve: {
        locations: {
          post: {
            select: {title: 'title', slug: 'slug.current'},
            resolve: (doc) => ({locations: [{title: doc?.title || 'Untitled', href: `/posts/${doc?.slug}`}]}),
          },
        },
      },
    }),
  ],
  schema: {types: schemaTypes},
})
