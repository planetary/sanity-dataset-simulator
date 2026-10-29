/**
 * Phase 0 spike (docs/plans/sanity-sim.md): a stock Studio with exactly one
 * change from `npm create sanity` — `apiHost`, read from the environment.
 * No overlay plugin, no client factory. Whatever breaks against the Mode 2
 * origin here is what the simulator has to answer.
 */
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'

const apiHost = process.env.SANITY_STUDIO_API_HOST

export default defineConfig({
  name: 'default',
  title: 'sim-spike',
  projectId: 'b1n03q3z',
  dataset: 'parity',
  ...(apiHost ? {apiHost} : {}),
  plugins: [structureTool(), visionTool()],
  schema: {types: schemaTypes},
})
