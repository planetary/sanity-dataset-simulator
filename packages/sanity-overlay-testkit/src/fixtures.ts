import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

export interface FixtureDocument {
  _id: string
  _type: string
  _createdAt: string
  _updatedAt: string
  _rev: string
  [key: string]: unknown
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dataset.ndjson')

/** Load the committed deterministic fixture dataset (testing-strategy §1). */
export function loadFixtureDataset(path: string = FIXTURE_PATH): FixtureDocument[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureDocument)
}

/** Published perspective over the raw fixture set: drafts win over published. */
export function publishedPerspective(docs: FixtureDocument[]): FixtureDocument[] {
  return docs.filter((d) => !d._id.startsWith('drafts.'))
}

/** Drafts perspective: draft version replaces its published counterpart. */
export function draftsPerspective(docs: FixtureDocument[]): FixtureDocument[] {
  const drafts = new Map(
    docs.filter((d) => d._id.startsWith('drafts.')).map((d) => [d._id.slice('drafts.'.length), d]),
  )
  const out: FixtureDocument[] = []
  for (const d of docs) {
    if (d._id.startsWith('drafts.')) {
      // Emit under the logical ID so queries see one virtual document
      out.push({...d, _id: d._id.slice('drafts.'.length)})
    } else if (!drafts.has(d._id)) {
      out.push(d)
    }
  }
  return out
}
