import {describe, it} from 'vitest'
import {loadFixtureDataset, publishedPerspective} from '../src/fixtures'
import {OVERLAY_FIXTURES} from '../spike-c/overlay'
import {evaluateRegistered} from '../spike-c/planner'
import {REGISTRY} from '../spike-c/registry'

const base = publishedPerspective(loadFixtureDataset())
const PARAMS: Record<string, Record<string, unknown>> = {
  'article-by-id': {id: 'article-05'},
  'object-spread': {id: 'article-05'},
  'article-with-author': {id: 'article-01'},
  'articles-by-author-name': {name: 'Author 2 (branch rename)'},
  'page-by-slug': {slug: 'legacy-page'},
  'article-by-slug': {slug: 'article-7'},
  'references-author': {authorId: 'author-1'},
  'pt-text': {id: 'article-03'},
}

describe('audit', () => {
  it('dump candidate counts', async () => {
    const rows: string[] = []
    for (const def of REGISTRY.filter((d) => d.status !== 'unsupported')) {
      for (const [ov, mk] of Object.entries(OVERLAY_FIXTURES)) {
        const {diagnostics: d} = await evaluateRegistered(def, base, mk(base), PARAMS[def.id] ?? {})
        rows.push(
          `${def.id.padEnd(26)} ${ov.padEnd(18)} plan=${String((def.candidatePlan as {type: string}).type).padEnd(11)} cand=${String(d.candidateCount).padStart(3)} full=${d.fullDatasetCount} refExp=${d.referenceExpansions}`,
        )
      }
    }
    console.log('\n' + rows.join('\n'))
  })
})
