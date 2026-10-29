import assert from 'node:assert/strict'
import fs from 'node:fs'
import {describe, it} from 'node:test'
import {expectedPackageReadme, packageReadme} from '../scripts/readme.mjs'

/* npm shows the package README; the repository README is the one people edit. */
describe('package README', () => {
  it('is the repository README with absolute links (run `pnpm --filter @planetary/sanity-sim readme`)', () => {
    assert.equal(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), expectedPackageReadme())
  })

  it('rewrites repository paths and leaves URLs and anchors alone', () => {
    const out = packageReadme('[a](examples/sim-next) [b](docs/x.md#y) [c](https://x.dev) [d](#quick-start) [e](packages/sanity-sim/README.md)')
    assert.match(out, /\[a\]\(https:\/\/github\.com\/planetary\/sanity-dataset-simulator\/tree\/main\/examples\/sim-next\)/)
    assert.match(out, /\[b\]\(https:\/\/github\.com\/planetary\/sanity-dataset-simulator\/blob\/main\/docs\/x\.md#y\)/)
    assert.match(out, /\[c\]\(https:\/\/x\.dev\) \[d\]\(#quick-start\)/)
    assert.match(out, /\[e\]\(https:\/\/github\.com\/planetary\/sanity-dataset-simulator\/blob\/main\/packages\/sanity-sim\/README\.md\)/)
  })
})
