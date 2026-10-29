import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {describe, it} from 'node:test'
import {detectProject} from '../src/project.js'

describe('project detection', () => {
  it("finds every workspace's project id, main project first", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-detect-'))
    fs.writeFileSync(path.join(root, 'sanity.cli.ts'), "export default defineCliConfig({api: {projectId: 'mainprj', dataset: 'production'}})\n")
    fs.writeFileSync(
      path.join(root, 'sanity.config.ts'),
      [
        'export default defineConfig([',
        "  {name: 'a', projectId: 'mainprj', dataset: 'production'},",
        "  {name: 'b', projectId: process.env.SANITY_STUDIO_OTHER_PROJECT ?? 'otherprj', dataset: 'production'},",
        "  {name: 'c', projectId: \"thirdprj\", dataset: 'staging'},",
        '])',
      ].join('\n'),
    )
    const project = detectProject(root)
    assert.equal(project.projectId, 'mainprj')
    assert.deepEqual(project.projectIds, ['mainprj', 'otherprj', 'thirdprj'])
  })
})
