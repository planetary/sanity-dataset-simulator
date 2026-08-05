/**
 * Parity fixtures for the `[M-LOCAL]` registry (PRD §37 Phase 2 "reduced query
 * registry ... with parity fixtures", §35.10, §35.11).
 *
 * These live beside the registry, not in a test file, because PRD §22.5 makes
 * the parity fixture part of the registration: `parityFixture` on every
 * supported entry names this set, and CI must be able to re-run it when a query
 * changes.
 *
 * Each fixture targets one §35.11 behaviour that post-processing a native
 * result cannot reproduce (§22.1): filter membership, dereferenced values,
 * document type, presence and absence. They are pure functions of a base
 * dataset so the same set runs against the published and drafts perspectives
 * and against a scaled dataset.
 */
import type {OverlaySource} from '../src/overlaySource'
import type {QueryDocument} from '../src/types'

interface MutableOverlay {
  documents: Map<string, QueryDocument>
  tombstones: Set<string>
}

const empty = (): MutableOverlay => ({documents: new Map(), tombstones: new Set()})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function find(base: readonly QueryDocument[], id: string): QueryDocument {
  const doc = base.find((d) => d._id === id)
  if (!doc) throw new Error(`parity fixture requires base document ${id}`)
  return clone(doc)
}

const slug = (current: string) => ({_type: 'slug', current})

/** No branch state: the overlay must be transparent. */
export const ovEmpty = (): OverlaySource => empty()

/** A branch slug edit removes the base document from its own slug lookup. */
export function ovSlugEdit(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  const doc = find(base, 'article-07')
  doc.slug = slug('article-7-old')
  doc.title = 'Article 7 (branch edit)'
  o.documents.set(doc._id, doc)
  return o
}

/** The slug moves to a different document; both records are branch records. */
export function ovSlugSteal(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  const from = find(base, 'article-07')
  from.slug = slug('article-7-old')
  const to = find(base, 'article-09')
  to.slug = slug('article-7')
  o.documents.set(from._id, from)
  o.documents.set(to._id, to)
  return o
}

/**
 * Branch-created documents. No base fetch can select these, so only §22.6
 * step 6 puts them in the candidate set.
 */
export function ovBranchCreate(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  const article = find(base, 'article-01')
  article._id = 'article-branch-1'
  article._rev = 'branch-rev-article-branch-1'
  article.title = 'Branch article'
  article.slug = slug('branch-article')
  o.documents.set(article._id, article)

  const page = find(base, 'page-about')
  page._id = 'page-branch-1'
  page._rev = 'branch-rev-page-branch-1'
  page.title = 'Branch page'
  page.slug = slug('branch-page')
  o.documents.set(page._id, page)
  return o
}

/** A tombstoned document leaves every result, including as a deref target. */
export function ovTombstone(): OverlaySource {
  const o = empty()
  o.tombstones.add('article-01')
  return o
}

/** A reference target is edited; no referrer is rewritten. */
export function ovRefTargetChange(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  const author = find(base, 'author-2')
  author.name = 'Author 2 (branch rename)'
  o.documents.set(author._id, author)
  return o
}

/** A branch record changes `_type`, moving a document between type constraints. */
export function ovTypeChange(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  const doc = find(base, 'legacy.page.v2')
  doc._type = 'article'
  o.documents.set(doc._id, doc)
  return o
}

/** Create, edit and delete at once — the shape a real branch actually has. */
export function ovMixed(base: readonly QueryDocument[]): OverlaySource {
  const o = empty()
  o.tombstones.add('article-03')
  const created = find(base, 'article-01')
  created._id = 'article-branch-1'
  created._rev = 'branch-rev-article-branch-1'
  created.title = 'Branch article'
  created.slug = slug('branch-article')
  o.documents.set(created._id, created)
  const edited = find(base, 'article-05')
  edited.title = 'Article 5 (branch edit)'
  edited.tags = ['news', 'featured']
  o.documents.set(edited._id, edited)
  const author = find(base, 'author-2')
  author.name = 'Author 2 (branch rename)'
  o.documents.set(author._id, author)
  return o
}

export const M_LOCAL_PARITY_OVERLAYS: Record<
  string,
  (base: readonly QueryDocument[]) => OverlaySource
> = {
  'empty': ovEmpty,
  'slug-edit': ovSlugEdit,
  'slug-steal': ovSlugSteal,
  'branch-create': ovBranchCreate,
  'tombstone': () => ovTombstone(),
  'ref-target-change': ovRefTargetChange,
  'type-change': ovTypeChange,
  'mixed': ovMixed,
}
