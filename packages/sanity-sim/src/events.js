import {getPublishedId, getReleaseName, isPublishedId} from './ids.js'

/**
 * The document events API (`GET /data/history/<ds>/events/documents/<id>`),
 * derived from the local transaction log.
 *
 * Studio 6 renders its history panel from these (types from sanity's
 * `CreateDocumentVersionEvent` & co.); edits inside a draft or version are
 * synthesized by Studio itself from the transactions endpoint, so only
 * lifecycle events are produced here. Newest first, as the API answers.
 */
export function documentEvents(dataset, requestedId, {limit = 100} = {}) {
  const publishedId = getPublishedId(requestedId)
  const inGroup = (id) => getPublishedId(id) === publishedId
  const events = []

  for (const tx of dataset.transactions) {
    const ids = tx.documentIDs.filter(inGroup)
    if (ids.length === 0) continue
    const effect = (id) => ({before: tx.effects[id]?.revert?.[1] ?? null, after: tx.effects[id]?.apply?.[1] ?? null})
    const base = {timestamp: tx.timestamp, author: tx.author, documentId: publishedId}
    const published = ids.includes(publishedId) ? effect(publishedId) : null
    const versionIds = ids.filter((id) => !isPublishedId(id))
    const removedVersions = versionIds.filter((id) => effect(id).before && !effect(id).after)
    const createdVersions = versionIds.filter((id) => !effect(id).before && effect(id).after)
    const handled = new Set()

    if (published?.after && removedVersions.length > 0) {
      const source = removedVersions[0]
      const releaseId = getReleaseName(source) ?? undefined
      events.push({
        ...base,
        type: 'publishDocumentVersion',
        revisionId: published.after._rev,
        versionId: source,
        versionRevisionId: effect(source).before._rev,
        ...(releaseId ? {releaseId} : {}),
        publishCause: releaseId ? 'release.publish' : 'document.publish',
        contributors: [tx.author],
      })
      handled.add(source)
    } else if (published?.before && !published.after) {
      if (createdVersions.length > 0) {
        const draft = createdVersions[0]
        events.push({...base, type: 'unpublishDocument', versionId: draft, versionRevisionId: effect(draft).after._rev})
        handled.add(draft)
      } else {
        events.push({...base, type: 'deleteDocumentGroup'})
        for (const id of removedVersions) handled.add(id)
      }
    } else if (published && !published.before && published.after) {
      events.push({...base, type: 'createLiveDocument', revisionId: published.after._rev})
    } else if (published?.before && published.after) {
      events.push({...base, type: 'updateLiveDocument', revisionId: published.after._rev})
    }

    for (const id of createdVersions) {
      if (handled.has(id)) continue
      const releaseId = getReleaseName(id) ?? undefined
      events.push({...base, type: 'createDocumentVersion', versionId: id, versionRevisionId: effect(id).after._rev, ...(releaseId ? {releaseId} : {})})
    }
    for (const id of removedVersions) {
      if (handled.has(id)) continue
      const releaseId = getReleaseName(id) ?? undefined
      events.push({...base, type: 'deleteDocumentVersion', versionId: id, versionRevisionId: effect(id).before._rev, ...(releaseId ? {releaseId} : {})})
    }
  }
  return events.reverse().slice(0, limit)
}
