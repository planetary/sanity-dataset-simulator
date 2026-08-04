// SPIKE D migration prototype — PRD §20.4 OverlayMigration shape carrying
// §13.7 OverlayMutation envelopes. Proves the rename path is explicit and
// loses no data. Overlay-only: base documents are never touched.
import type {FixtureDocument} from '../src/fixtures'

type OverlayOperation =
  | {type: 'set'; path: (string | number)[]; value: unknown}
  | {type: 'unset'; path: (string | number)[]}

interface OverlayMutation {
  type: 'patch'
  id: string
  operations: OverlayOperation[]
}

export interface OverlayMigration {
  id: string
  title: string
  schemaCommitBefore?: string
  schemaCommitAfter: string
  affectedTypes: string[]
  operations: Array<{documentId: string; description: string; mutations: OverlayMutation[]}>
  createdAt: string
  createdBy: {type: 'agent'; id: string}
}

/** Plan the article.title -> headline rename for every affected document. */
export function planRenameMigration(docs: FixtureDocument[]): OverlayMigration {
  const affected = docs.filter((d) => d._type === 'article' && d.title !== undefined)
  return {
    id: 'mig-rename-title-headline',
    title: 'Rename article.title to headline',
    schemaCommitBefore: 'base',
    schemaCommitAfter: 'variant-rename-field',
    affectedTypes: ['article'],
    operations: affected.map((d) => ({
      documentId: d._id,
      description: `copy title -> headline, remove title`,
      mutations: [{
        type: 'patch',
        id: d._id,
        operations: [
          {type: 'set', path: ['headline'], value: d.title},
          {type: 'unset', path: ['title']},
        ],
      }],
    })),
    createdAt: '2026-08-03T00:00:00Z',
    createdBy: {type: 'agent', id: 'spike-d'},
  }
}

/** Apply set/unset to a cloned materialized document (overlay side only). */
export function applyMutations(doc: FixtureDocument, mutations: OverlayMutation[]): FixtureDocument {
  const out = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
  for (const m of mutations) {
    for (const op of m.operations) {
      if (op.path.length !== 1 || typeof op.path[0] !== 'string') throw new Error('spike applier: top-level paths only')
      if (op.type === 'set') out[op.path[0]] = op.value
      else delete out[op.path[0]]
    }
  }
  return out as FixtureDocument
}
