import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes'

export default defineConfig({
  name: 'kitchen-sink',
  title: 'Kitchen Sink (overlay test target)',
  projectId: process.env.SANITY_STUDIO_PROJECT_ID || 'placeholder',
  dataset: process.env.SANITY_STUDIO_DATASET || 'parity',
  plugins: [structureTool()],
  schema: {types: schemaTypes},
})
