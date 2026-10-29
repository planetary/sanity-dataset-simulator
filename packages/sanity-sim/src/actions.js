import {badRequest, conflict} from './errors.js'
import {draftIdFor, getPublishedId, getReleaseName, isDraftId, isVersionId, releaseDocumentId, VERSIONS_PREFIX} from './ids.js'

/**
 * Compile Actions API actions (`POST /data/actions`) into plain mutations,
 * reading current state from `dataset`. The result commits as one transaction,
 * which is what Content Lake promises for an actions request.
 *
 * Covers sanity.action.document.*, sanity.action.document.version.* and
 * sanity.action.release.*. Content Lake refuses mixing categories in one
 * request; so does this.
 */
export function compileActions(actions, dataset, {now = new Date()} = {}) {
  if (!Array.isArray(actions) || actions.length === 0) throw badRequest('`actions` must be a non-empty array')
  const categories = new Set(actions.map((action) => categoryOf(action?.actionType)))
  if (categories.size > 1) throw badRequest('document, version and release actions cannot be mixed in one request')

  /* Later actions in the same request must see earlier ones' effects. */
  const overlay = new Map()
  const read = (id) => (overlay.has(id) ? overlay.get(id) : dataset.get(id))
  const out = []
  const put = (doc) => {
    overlay.set(doc._id, doc)
    out.push({createOrReplace: doc})
  }
  const create = (doc) => {
    overlay.set(doc._id, doc)
    out.push({create: doc})
  }
  const remove = (id) => {
    if (read(id) === null) return
    overlay.set(id, null)
    out.push({delete: {id}})
  }
  const patch = (id, operations) => {
    out.push({patch: {id, ...operations}})
    overlay.set(id, read(id))
  }

  for (const action of actions) {
    const type = action.actionType
    switch (type) {
      /* ------------------------------------------------ documents */
      case 'sanity.action.document.create': {
        const doc = action.attributes ?? action.document
        if (!doc || typeof doc !== 'object') throw badRequest(`${type} needs \`attributes\``)
        const id = doc._id ?? draftIdFor(action.publishedId)
        const existing = read(id)
        if (existing) {
          if (action.ifExists === 'ignore') break
          throw conflict(`Document by ID "${id}" already exists`)
        }
        create({...doc, _id: id})
        break
      }
      case 'sanity.action.document.replaceDraft': {
        const doc = action.attributes ?? action.document
        if (!doc) throw badRequest(`${type} needs \`attributes\``)
        put({...doc, _id: draftIdFor(action.publishedId ?? doc._id)})
        break
      }
      case 'sanity.action.document.edit': {
        const publishedId = action.publishedId ?? getPublishedId(action.draftId ?? action.versionId)
        const targetId = action.versionId ?? action.draftId ?? draftIdFor(publishedId)
        if (!read(targetId)) {
          /* Editing a published document creates its draft from the published version. */
          const source = read(publishedId)
          if (!source) throw conflict(`Cannot edit "${publishedId}": neither "${targetId}" nor the published document exists`)
          create({...stripSystem(source), _id: targetId})
        }
        if (action.patch && Object.keys(action.patch).length > 0) patch(targetId, action.patch)
        break
      }
      case 'sanity.action.document.publish': {
        const publishedId = action.publishedId ?? getPublishedId(action.draftId ?? action.versionId)
        const sourceId = action.versionId ?? action.draftId ?? draftIdFor(publishedId)
        const source = read(sourceId)
        if (!source) throw conflict(`Cannot publish "${publishedId}": "${sourceId}" does not exist`)
        const ifSource = action.ifDraftRevisionId ?? action.ifVersionRevisionId
        if (ifSource && ifSource !== source._rev) {
          throw conflict(`Document by ID "${sourceId}" has unexpected revision ID ("${source._rev}"), expected "${ifSource}"`)
        }
        const published = read(publishedId)
        if (action.ifPublishedRevisionId && action.ifPublishedRevisionId !== published?._rev) {
          throw conflict(`Document by ID "${publishedId}" has unexpected revision ID ("${published?._rev}"), expected "${action.ifPublishedRevisionId}"`)
        }
        const doc = {...stripSystem(source), _id: publishedId}
        if (published?._createdAt) doc._createdAt = published._createdAt
        put(doc)
        remove(sourceId)
        break
      }
      case 'sanity.action.document.unpublish': {
        const publishedId = action.publishedId ?? getPublishedId(action.draftId)
        const published = read(publishedId)
        if (!published) throw conflict(`Cannot unpublish "${publishedId}": it is not published`)
        const draftId = action.draftId ?? draftIdFor(publishedId)
        if (!read(draftId)) create({...stripSystem(published), _id: draftId})
        remove(publishedId)
        break
      }
      case 'sanity.action.document.discard': {
        const id = action.draftId ?? action.versionId
        if (!read(id)) throw conflict(`Cannot discard "${id}": it does not exist`)
        remove(id)
        break
      }
      case 'sanity.action.document.delete': {
        const publishedId = action.publishedId
        const drafts = action.includeDrafts ?? [draftIdFor(publishedId)]
        remove(publishedId)
        for (const id of drafts) remove(id)
        break
      }

      /* ------------------------------------------------ versions */
      case 'sanity.action.document.version.create': {
        let doc = action.document
        if (!doc) {
          const base = read(action.baseId)
          if (!base) throw conflict(`Cannot create version: base "${action.baseId}" does not exist`)
          if (action.ifBaseRevisionId && action.ifBaseRevisionId !== base._rev) {
            throw conflict(`Document by ID "${action.baseId}" has unexpected revision ID ("${base._rev}"), expected "${action.ifBaseRevisionId}"`)
          }
          doc = {...stripSystem(base), _id: action.versionId}
        }
        if (!isVersionId(doc._id) && !isDraftId(doc._id)) throw badRequest(`"${doc._id}" is not a version id`)
        assertReleaseEditable(read, getReleaseName(doc._id))
        if (read(doc._id)) throw conflict(`Document by ID "${doc._id}" already exists`)
        create(doc)
        break
      }
      case 'sanity.action.document.version.discard': {
        assertReleaseEditable(read, getReleaseName(action.versionId))
        if (!read(action.versionId)) throw conflict(`Cannot discard "${action.versionId}": it does not exist`)
        remove(action.versionId)
        break
      }
      case 'sanity.action.document.version.replace': {
        const doc = action.document
        if (!doc || !isVersionId(doc._id)) throw badRequest(`${type} needs a version \`document\``)
        assertReleaseEditable(read, getReleaseName(doc._id))
        put(doc)
        break
      }
      case 'sanity.action.document.version.unpublish': {
        const {versionId, publishedId} = action
        assertReleaseEditable(read, getReleaseName(versionId))
        const published = read(publishedId)
        if (!published) throw conflict(`Cannot unpublish "${publishedId}" in a release: it is not published`)
        const existing = read(versionId)
        put({...stripSystem(existing ?? published), _id: versionId, _system: {delete: true}})
        break
      }

      /* ------------------------------------------------ releases */
      case 'sanity.action.release.create': {
        const id = releaseDocumentId(action.releaseId)
        if (read(id)) throw conflict(`Release "${action.releaseId}" already exists`)
        create({
          _id: id,
          _type: 'system.release',
          name: action.releaseId,
          state: 'active',
          metadata: {releaseType: 'undecided', ...(action.metadata ?? {})},
          userId: 'local-dev',
        })
        break
      }
      case 'sanity.action.release.edit': {
        const id = releaseOrThrow(read, action.releaseId)._id
        if (action.patch) patch(id, action.patch)
        break
      }
      case 'sanity.action.release.publish': {
        publishRelease(action.releaseId, {read, put, remove, now, dataset, overlay})
        break
      }
      case 'sanity.action.release.archive': {
        const release = releaseOrThrow(read, action.releaseId)
        if (!['active', 'scheduled'].includes(release.state)) throw conflict(`Release "${action.releaseId}" cannot be archived from state "${release.state}"`)
        const versions = versionsOf(dataset, overlay, action.releaseId)
        put({...stripSystem(release), state: 'archived', archivedDocuments: versions.map(stripRev)})
        for (const doc of versions) remove(doc._id)
        break
      }
      case 'sanity.action.release.unarchive': {
        const release = releaseOrThrow(read, action.releaseId)
        if (release.state !== 'archived') throw conflict(`Release "${action.releaseId}" is not archived`)
        const {archivedDocuments = [], ...rest} = stripSystem(release)
        put({...rest, state: 'active'})
        for (const doc of archivedDocuments) put(doc)
        break
      }
      case 'sanity.action.release.schedule': {
        const release = releaseOrThrow(read, action.releaseId)
        if (release.state !== 'active') throw conflict(`Release "${action.releaseId}" cannot be scheduled from state "${release.state}"`)
        if (!action.publishAt) throw badRequest('`publishAt` is required')
        put({...stripSystem(release), state: 'scheduled', publishAt: action.publishAt})
        break
      }
      case 'sanity.action.release.unschedule': {
        const release = releaseOrThrow(read, action.releaseId)
        if (release.state !== 'scheduled') throw conflict(`Release "${action.releaseId}" is not scheduled`)
        const {publishAt: _ignored, ...rest} = stripSystem(release)
        put({...rest, state: 'active'})
        break
      }
      case 'sanity.action.release.delete': {
        const release = releaseOrThrow(read, action.releaseId)
        if (!['archived', 'published'].includes(release.state)) {
          throw conflict(`Release "${action.releaseId}" must be archived or published before it can be deleted`)
        }
        remove(release._id)
        break
      }
      default:
        throw badRequest(`Unsupported action type "${type}"`)
    }
  }
  return out
}

/** Publish every version in a release, then mark it published. Shared with the scheduler. */
export function publishRelease(releaseName, {read, put, remove, now, dataset, overlay}) {
  const release = releaseOrThrow(read, releaseName)
  if (!['active', 'scheduled'].includes(release.state)) {
    throw conflict(`Release "${releaseName}" cannot be published from state "${release.state}"`)
  }
  const versions = dataset ? versionsOf(dataset, overlay ?? new Map(), releaseName) : null
  const list = versions ?? []
  const finalDocumentStates = []
  for (const version of list) {
    const publishedId = getPublishedId(version._id)
    if (version._system?.delete === true) {
      remove(publishedId)
    } else {
      const published = read(publishedId)
      const doc = {...stripSystem(version), _id: publishedId}
      if (published?._createdAt) doc._createdAt = published._createdAt
      put(doc)
    }
    remove(version._id)
    finalDocumentStates.push({id: publishedId})
  }
  put({...stripSystem(release), state: 'published', publishedAt: now.toISOString(), finalDocumentStates})
}

function versionsOf(dataset, overlay, releaseName) {
  const prefix = `${VERSIONS_PREFIX}${releaseName}.`
  const docs = new Map()
  for (const doc of dataset.documents()) if (doc._id.startsWith(prefix)) docs.set(doc._id, doc)
  for (const [id, doc] of overlay) {
    if (!id.startsWith(prefix)) continue
    if (doc === null) docs.delete(id)
    else docs.set(id, doc)
  }
  return [...docs.values()]
}

function releaseOrThrow(read, releaseName) {
  const release = read(releaseDocumentId(releaseName))
  if (!release) throw conflict(`Release "${releaseName}" does not exist`)
  return release
}

function assertReleaseEditable(read, releaseName) {
  if (releaseName === null) return
  const release = read(releaseDocumentId(releaseName))
  if (release && release.state === 'scheduled') throw conflict(`Release "${releaseName}" is scheduled; its documents are locked`)
  if (release && ['published', 'archived'].includes(release.state)) {
    throw conflict(`Release "${releaseName}" is ${release.state}; its documents cannot change`)
  }
}

function categoryOf(type) {
  if (typeof type !== 'string') throw badRequest('every action needs an `actionType`')
  if (type.startsWith('sanity.action.release.')) return 'release'
  if (type.startsWith('sanity.action.document.version.')) return 'version'
  if (type.startsWith('sanity.action.document.')) return 'document'
  throw badRequest(`Unsupported action type "${type}"`)
}

/** System fields Content Lake recomputes on write. */
function stripSystem(doc) {
  const {_rev, _updatedAt, _originalId, _system, ...rest} = doc
  return rest
}

const stripRev = (doc) => {
  const {_rev, ...rest} = doc
  return rest
}
