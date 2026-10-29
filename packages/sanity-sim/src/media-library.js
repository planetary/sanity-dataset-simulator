import fs from 'node:fs'
import path from 'node:path'
import {randomBytes, randomUUID} from 'node:crypto'
import {sniffMime} from './assets.js'
import {Dataset} from './dataset.js'
import {SimError, badRequest, notFound} from './errors.js'
import {readJson, writeJsonAtomic} from './files.js'
import {ListenHub} from './listen.js'

/**
 * Media Library: an organization-wide asset library with its own document
 * store, shared by every project in this simulator.
 *
 * A library holds asset containers (`sanity.asset`, one per logical asset,
 * listing its versions) and asset instances (`sanity.imageAsset`,
 * `sanity.fileAsset`, `sanity.videoAsset`, one per uploaded file). Studio
 * "links" an instance into a project dataset, which creates an ordinary
 * dataset asset document pointing back at the library through `media`.
 * Bytes live in the shared content-addressed asset store, so a linked image
 * is served from the dataset's usual image path.
 */

export const ORGANIZATION_ID = 'osimlocal'
export const DEFAULT_LIBRARY_ID = 'mlsimlocal'
/** @sanity/client only recognises `media-library:ml…:<id>` references. */
export const LIBRARY_ID = /^ml[A-Za-z0-9_-]{1,64}$/
export const SOURCE_NAME = 'sanity-media-library'

const INSTANCE_TYPES = {images: 'sanity.imageAsset', files: 'sanity.fileAsset', videos: 'sanity.videoAsset'}

export class MediaLibraries {
  constructor({dir, assets, persist, log}) {
    this.dir = dir
    this.assets = assets
    this.persist = persist
    this.log = log
    this.libraries = new Map()
    this.listen = new ListenHub()
    this.ids = this.persist ? readJson(path.join(dir, 'libraries.json'), []) : []
  }

  /** A library by id, created on first use (Studio configs may name a real library's id). */
  get(id, {create = true} = {}) {
    if (this.libraries.has(id)) return this.libraries.get(id)
    if (!LIBRARY_ID.test(String(id))) return null
    if (!this.ids.includes(id)) {
      if (!create) return null
      this.ids.push(id)
      if (this.persist) {
        fs.mkdirSync(this.dir, {recursive: true})
        writeJsonAtomic(path.join(this.dir, 'libraries.json'), this.ids)
      }
      this.log('info', `created media library "${id}" on first use`)
    }
    const store = new Dataset({name: `media-library.${id}`, dir: path.join(this.dir, id), persist: this.persist}).load()
    this.listen.attach(store)
    const library = new MediaLibrary({id, store, assets: this.assets})
    this.libraries.set(id, library)
    return library
  }

  /** Every library; the default one exists as soon as anyone asks for the list. */
  all() {
    if (this.ids.length === 0) this.get(DEFAULT_LIBRARY_ID)
    return this.ids.map((id) => this.get(id))
  }

  /**
   * Where to fetch bytes this machine doesn't have: a library instance synced
   * from a real Media Library keeps its real URL. `self` (this server's
   * origin) is skipped, so a lookup never loops back here.
   */
  remoteUrlFor(sha1, extension, self) {
    for (const id of this.ids) {
      for (const document of this.get(id).store.documents()) {
        if (document.sha1hash !== sha1 || document.extension !== extension || typeof document.url !== 'string') continue
        if (!/^https?:\/\//.test(document.url) || (self && document.url.startsWith(self))) continue
        return document.url
      }
    }
    return null
  }

  flush() {
    for (const library of this.libraries.values()) library.store.flush()
  }
}

export class MediaLibrary {
  constructor({id, store, assets}) {
    this.id = id
    this.store = store
    this.assets = assets
  }

  describe() {
    return {
      id: this.id,
      organizationId: ORGANIZATION_ID,
      name: this.id === DEFAULT_LIBRARY_ID ? 'Local media library (sanity-sim)' : `${this.id} (sanity-sim)`,
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    }
  }

  /**
   * Store an upload: one instance per distinct file (content-addressed), one
   * container per new instance. Uploading the same bytes again returns the
   * existing container, as `alreadyExists`.
   */
  async upload({bytes, contentType, filename, title, publicBase}) {
    if (!bytes?.length) throw badRequest('the upload is empty')
    const declared = String(contentType ?? '').split(';')[0].trim()
    if (declared === 'multipart/form-data') throw badRequest('sanity-sim takes Media Library uploads as the raw file body (application/octet-stream or the file type), not multipart')
    const mime = declared && declared !== 'application/octet-stream' ? declared : (sniffMime(bytes) ?? declared)
    const kind = mime.startsWith('video/') ? 'videos' : mime.startsWith('image/') ? 'images' : 'files'
    const ingested = await this.assets.ingest({
      kind: kind === 'images' ? 'images' : 'files',
      bytes,
      contentType: mime || undefined,
      filename,
      projectId: '_',
      dataset: '_',
      publicBase,
      meta: title ? {title} : {},
    })
    const instance = this.instanceFrom(ingested, kind, publicBase)
    const existing = this.store.get(instance._id)
    if (existing) {
      const container = this.containerOf(existing._id)
      if (container) return {asset: container, assetInstance: existing, alreadyExists: true}
    }
    const containerId = newContainerId()
    const versionKey = randomBytes(6).toString('hex')
    const container = {
      _id: containerId,
      _type: 'sanity.asset',
      title: title ?? filename ?? instance.originalFilename,
      assetType: instance._type,
      cdnAccessPolicy: 'public',
      currentVersion: {_type: 'reference', _ref: instance._id},
      versions: [{_key: versionKey, _type: 'sanity.asset.version', title: title ?? filename ?? instance.originalFilename, instance: {_type: 'reference', _ref: instance._id}}],
    }
    await this.store.commit([{createIfNotExists: instance}, {create: container}], {author: 'sanity-sim.media-library'})
    return {asset: this.store.get(containerId), assetInstance: this.store.get(instance._id), alreadyExists: false}
  }

  instanceFrom(ingested, kind, publicBase) {
    const {path: _path, url: _url, ...rest} = ingested
    const sha1 = ingested.sha1hash
    const ext = ingested.extension
    if (kind === 'images') {
      const {width, height} = ingested.metadata.dimensions
      const name = `${sha1}-${width}x${height}.${ext}`
      return {...rest, state: 'ready', path: `media-libraries/${this.id}/images/${name}`, url: `${publicBase}/media-libraries/${this.id}/images/${name}`}
    }
    const name = `${sha1}.${ext}`
    if (kind === 'videos') {
      return {
        ...rest,
        _id: `video-${sha1}-${ext}`,
        _type: INSTANCE_TYPES.videos,
        state: 'ready',
        metadata: {_type: 'sanity.videoMetadata', playbacks: [{_type: 'sanity.videoMetadata.playback', _key: 'public', policy: 'public'}]},
        path: `media-libraries/${this.id}/files/${name}`,
        url: `${publicBase}/media-libraries/${this.id}/files/${name}`,
      }
    }
    return {...rest, state: 'ready', path: `media-libraries/${this.id}/files/${name}`, url: `${publicBase}/media-libraries/${this.id}/files/${name}`}
  }

  /** The container whose versions include this instance. */
  containerOf(instanceId) {
    return this.store.documents().find((doc) => doc._type === 'sanity.asset' && doc.versions?.some((version) => version.instance?._ref === instanceId)) ?? null
  }

  /**
   * `POST /assets/media-library-link/<dataset>`: the dataset asset document
   * for a library instance, created (or completed) in `dataset`.
   */
  async linkInto(dataset, {assetInstanceId, assetId, projectId, publicBase}) {
    const instance = typeof assetInstanceId === 'string' ? this.store.get(assetInstanceId) : null
    if (!instance) throw new SimError(404, 'notFound', `Media library asset instance "${assetInstanceId}" not found`)
    const container = typeof assetId === 'string' ? this.store.get(assetId) : null
    if (!container) throw new SimError(404, 'notFound', `Media library asset "${assetId}" not found`)
    if (!container.versions?.some((version) => version.instance?._ref === instance._id)) {
      throw new SimError(422, 'unprocessable', 'Asset instance does not belong to asset container')
    }
    if (instance._type === INSTANCE_TYPES.videos) throw badRequest('videos are not linked into datasets; reference them with a sanity.video field')
    const {_rev, _createdAt, _updatedAt, state: _state, path: _path, url: _url, ...fields} = instance
    const kind = instance._type === INSTANCE_TYPES.images ? 'images' : 'files'
    const dimensions = instance.metadata?.dimensions
    const name = kind === 'images' && dimensions ? `${instance.sha1hash}-${dimensions.width}x${dimensions.height}.${instance.extension}` : `${instance.sha1hash}.${instance.extension}`
    const media = {_type: 'globalDocumentReference', _ref: `media-library:${this.id}:${instance._id}`, _weak: true}
    const source = {name: SOURCE_NAME, id: container._id}
    const document = {
      ...fields,
      path: `${kind}/${projectId}/${dataset.name}/${name}`,
      url: `${publicBase}/${kind}/${projectId}/${dataset.name}/${name}`,
      source,
      media,
    }
    const existing = dataset.get(document._id)
    if (!existing) await dataset.commit([{createIfNotExists: document}], {author: 'sanity-sim.media-library'})
    else if (!existing.media) await dataset.commit([{patch: {id: existing._id, set: {media, source}}}], {author: 'sanity-sim.media-library'})
    return dataset.get(document._id)
  }

  /** `GET /media-libraries/<id>/video/<instanceId>/playback-info`. Playback goes through Mux, which is not simulated. */
  playbackInfo(instanceId) {
    const instance = this.store.get(instanceId)
    if (!instance || instance._type !== INSTANCE_TYPES.videos) throw notFound(`video "${instanceId}" not found in media library "${this.id}"`)
    return {
      id: instance._id,
      thumbnail: {url: instance.url},
      animated: {url: instance.url},
      storyboard: {url: instance.url},
      stream: {url: instance.url},
      duration: instance.metadata?.duration ?? 0,
      aspectRatio: instance.metadata?.aspectRatio ?? 16 / 9,
    }
  }
}

/** Documents in every project's datasets whose references point at these library ids (a container and its versions). */
export function referencesTo(sims, libraryId, ids) {
  const wanted = new Set(ids.map((id) => `media-library:${libraryId}:${id}`))
  const references = []
  for (const sim of sims) {
    for (const name of sim.datasetNames()) {
      for (const document of sim.dataset(name).documents()) {
        const paths = refPaths(document, wanted)
        if (paths.length > 0) references.push({sourceDocumentRef: {_type: 'globalDocumentReference', _ref: `dataset:${sim.projectId}.${name}:${document._id}`}, sourceFieldPaths: paths})
      }
    }
  }
  return {references, totalCount: references.length, nextCursor: null}
}

function refPaths(value, wanted, at = [], out = []) {
  if (Array.isArray(value)) value.forEach((item, index) => refPaths(item, wanted, [...at, item?._key ? `[_key=="${item._key}"]` : `[${index}]`], out))
  else if (value && typeof value === 'object') {
    if (typeof value._ref === 'string' && wanted.has(value._ref)) out.push(at.join('.').replace(/\.\[/g, '['))
    for (const [key, item] of Object.entries(value)) if (key !== '_ref') refPaths(item, wanted, [...at, key], out)
  }
  return out
}

function newContainerId() {
  return randomUUID().replace(/-/g, '').slice(0, 24)
}
