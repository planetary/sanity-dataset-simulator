import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: process.env.SANITY_STUDIO_PROJECT_ID ?? 'b1n03q3z',
    dataset: process.env.SANITY_STUDIO_DATASET ?? 'parity',
  },
})
