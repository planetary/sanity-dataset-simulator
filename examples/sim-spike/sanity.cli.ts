import {defineCliConfig} from 'sanity/cli'

/* Literal identity: this spike points at a simulator, never at a real project. */
export default defineCliConfig({api: {projectId: 'b1n03q3z', dataset: 'parity'}})
