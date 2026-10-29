import {getPublishedId, getReleaseName, isDraftId, isPublishedId, isSystemId, isVersionId} from './ids.js'

/** The first API version where the default perspective is `published` and releases exist. */
export const PERSPECTIVE_API_VERSION = '2025-02-19'

/**
 * `v2025-02-19` → '2025-02-19'; `vX` → 'X' (treated as newest); `v1` → '2021-03-25'
 * (Content Lake's v1 behaves like the first dated version).
 */
export function normalizeApiVersion(raw) {
  const value = String(raw ?? '').replace(/^v/, '')
  if (value === 'X' || value === 'x') return '9999-12-31'
  if (value === '1') return '2021-03-25'
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export const atLeast = (version, floor) => version !== null && version >= floor

/**
 * Parse a `perspective` parameter into a normalized form.
 *
 * @returns {{kind: 'raw'|'published'|'drafts'} | {kind: 'stack', releases: string[], drafts: boolean}}
 */
export function parsePerspective(raw, apiVersion) {
  const fallback = atLeast(apiVersion, PERSPECTIVE_API_VERSION) ? 'published' : 'raw'
  const value = Array.isArray(raw) ? raw.join(',') : String(raw ?? '').trim()
  if (value === '') return {kind: fallback}
  if (value === 'raw' || value === 'published') return {kind: value}
  if (value === 'drafts' || value === 'previewDrafts') return {kind: 'drafts'}
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (entries.length > 200) throw new PerspectiveError('a release perspective stack may hold at most 200 entries')
  if (entries.includes('raw')) throw new PerspectiveError('`raw` cannot be combined with other perspectives')
  const releases = entries.filter((entry) => entry !== 'drafts' && entry !== 'published')
  return {kind: 'stack', releases, drafts: entries.includes('drafts')}
}

export class PerspectiveError extends Error {}

/**
 * Resolve the documents a query sees under `perspective`.
 *
 * Under every non-raw perspective the winning version is returned with `_id`
 * rewritten to the published id and `_originalId` carrying the stored id, the
 * way Content Lake does it, so references (always to published ids) resolve.
 */
export function resolvePerspective(documents, perspective) {
  if (perspective.kind === 'raw') return documents

  if (perspective.kind === 'published') {
    return documents.filter((doc) => isPublishedId(doc._id))
  }

  /* Rank: earlier stack entries win; then drafts (if requested); then published. */
  const releaseRank = new Map()
  const releases = perspective.kind === 'stack' ? perspective.releases : []
  releases.forEach((name, index) => releaseRank.set(name, index))
  const draftRank = releases.length
  const publishedRank = releases.length + 1
  const includeDrafts = perspective.kind === 'drafts' || perspective.drafts

  const winners = new Map()
  for (const doc of documents) {
    const id = doc._id
    if (isSystemId(id)) continue
    let rank
    if (isPublishedId(id)) rank = publishedRank
    else if (isDraftId(id)) {
      if (!includeDrafts) continue
      rank = draftRank
    } else if (isVersionId(id)) {
      const release = getReleaseName(id)
      if (!releaseRank.has(release)) continue
      rank = releaseRank.get(release)
    } else continue
    const publishedId = getPublishedId(id)
    const current = winners.get(publishedId)
    if (current === undefined || rank < current.rank) winners.set(publishedId, {rank, doc})
  }

  const out = []
  for (const [publishedId, {doc}] of winners) {
    /* A version that unpublishes in its release hides the document. */
    if (doc._system?.delete === true) continue
    out.push(doc._id === publishedId ? doc : {...doc, _id: publishedId, _originalId: doc._id})
  }
  return out
}

/** The CDN host only answers these two. */
export const CDN_PERSPECTIVES = new Set(['published', 'raw'])
