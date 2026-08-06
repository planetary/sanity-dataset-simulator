import {describe, it} from 'vitest'
import {deriveStudioReadPlan} from '../sanity-overlay-studio/src/client/readPlan'

const QUERIES: Record<string, [string, Record<string, unknown>]> = {
  'groq2024 reference search': [
    '// findability-mvi:5\n*[_type in $__types] | score(boost(_type in ["author"] && name match text::query($__query), 10), ([@, _id] match text::query($__query) || references($__rawQuery))) [_score > 0] {_type, _id, _originalId, "orderings": [_score]} | order(orderings[0] desc) [0...$__limit]',
    {__types: ['author'], __query: 'a*', __rawQuery: 'a', __limit: 102},
  ],
  'groqLegacy reference search': [
    '// findability-mvi:4\n*[_type in $__types && (name match $t0 || title match $t0)] {_type, _id, _originalId, "orderings": []} | order(_id asc) [0...$__limit]',
    {__types: ['author'], t0: 'a*', __limit: 1000},
  ],
  'incoming references (useReferringDocuments)': [
    '*[references($docId)][0...101]{_id,_type}',
    {docId: 'article-1'},
  ],
  'incoming references (ConfirmDelete)': [
    '{"references":*[references($documentId)][0...100]{_id,_type},"totalCount":count(*[references($documentId)])}',
    {documentId: 'article-1'},
  ],
  'incoming references pane (id set)': [
    '*[references("article-1") && _type == "post"]._id',
    {},
  ],
  'preview document-paths': [
    '[*[_id in ["author-1","drafts.author-1"]][0...2]{_id,_rev,_type,title,subtitle}][0...1]',
    {},
  ],
  'preview observe-document': ['*[_id in $ids]', {ids: ['author-1']}],
  'dereference through a branch-created target': [
    '*[_id == $id][0]{title, author->{name}}',
    {id: 'article-1'},
  ],
}

describe('probe', () => {
  it('reports', () => {
    for (const [name, [query, params]] of Object.entries(QUERIES)) {
      const derived = deriveStudioReadPlan(query, params)
      
      process.stderr.write(
        `\n### ${name}\n  supported=${derived.supported}\n  ${
          derived.supported
            ? JSON.stringify(derived.plan.definition.candidatePlan)
            : derived.reason.slice(0, 220)
        }`,
      + "\n")
    }
  })
})
