import './spikeA/eventSourceTap'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes'
import {spikeClientFactory} from './spikeA/instrumentedClient'

export default defineConfig({
  name: 'kitchen-sink',
  title: 'Kitchen Sink (overlay test target)',
  projectId: process.env.SANITY_STUDIO_PROJECT_ID || 'b1n03q3z',
  dataset: process.env.SANITY_STUDIO_DATASET || 'parity',
  plugins: [structureTool()],
  schema: {types: schemaTypes},
  // SPIKE A Track A: every Studio client goes through the factory (§36.1)
  unstable_clientFactory: spikeClientFactory,
})
