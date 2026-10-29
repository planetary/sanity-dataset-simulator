import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {after, before, describe, it} from 'node:test'
import {Simulator} from '../src/simulator.js'
import {unwireStudio, wireStudio} from '../src/wire.js'
import {readEvents, startSim} from './helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISd3Qk6OAUIBAB8mBBGFRCvEAAAAAElFTkSuQmCC', 'base64')

/*
 * Media Library: the organization-wide asset library Studio picks from
 * (mediaLibrary: {enabled: true}), with Studio's link step into the dataset.
 */
describe('media library', () => {
  let sim
  let image
  const ml = (tail) => `${sim.base}/vX/media-libraries${tail}`
  const get = async (url) => {
    const response = await fetch(url)
    return {status: response.status, body: await response.json()}
  }
  const upload = async (bytes, {type, filename}) => {
    const response = await fetch(ml(`/mlsimlocal/upload?filename=${filename}&title=${filename}`), {method: 'POST', headers: {'content-type': type}, body: bytes})
    return {status: response.status, body: await response.json()}
  }
  const link = async (body) => {
    const response = await fetch(`${sim.base}/vX/assets/media-library-link/production`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
    return {status: response.status, body: await response.json()}
  }

  before(async () => {
    sim = await startSim({projectId: 'mlproj'})
  })
  after(() => sim.close())

  it('lets Studio discover the library: project organization, library list, library lookup', async () => {
    const project = await get(`${sim.base}/v2025-02-19/projects/mlproj`)
    const {organizationId} = project.body
    assert.ok(organizationId)
    const list = await get(`${sim.base}/v2025-02-19/media-libraries?organizationId=${organizationId}`)
    assert.deepEqual(list.body.data.map((library) => library.id), ['mlsimlocal'])
    assert.equal((await get(ml('/mlsimlocal'))).body.organizationId, organizationId)
    assert.equal((await get(ml('/not-a-library'))).status, 404, 'library ids start with "ml"')
  })

  it('stores an upload as a container plus an instance, and deduplicates identical bytes', async () => {
    const first = await upload(PNG, {type: 'image/png', filename: 'tiny.png'})
    assert.equal(first.status, 200)
    image = first.body
    assert.equal(image.asset._type, 'sanity.asset')
    assert.equal(image.asset.assetType, 'sanity.imageAsset')
    assert.equal(image.asset.currentVersion._ref, image.assetInstance._id)
    assert.match(image.assetInstance._id, /^image-[a-f0-9]{40}-2x2-png$/)
    assert.equal(image.uploadSession.status, 'complete')
    const again = await upload(PNG, {type: 'image/png', filename: 'copy.png'})
    assert.equal(again.body.asset._id, image.asset._id)
    assert.equal(again.body.uploadSession.status, 'alreadyExists')
  })

  it('answers GROQ against the library, as Studio does for cdnAccessPolicy', async () => {
    const search = new URLSearchParams({query: '*[_id in $ids]{_id, cdnAccessPolicy}', $ids: JSON.stringify([image.asset._id])})
    assert.deepEqual((await get(ml(`/mlsimlocal/query?${search}`))).body.result, [{_id: image.asset._id, cdnAccessPolicy: 'public'}])
  })

  it('links an instance into a dataset, pointing back at the library', async () => {
    const linked = await link({mediaLibraryId: 'mlsimlocal', assetInstanceId: image.assetInstance._id, assetId: image.asset._id})
    assert.equal(linked.status, 200)
    const document = linked.body.document
    assert.equal(document._id, image.assetInstance._id)
    assert.equal(document._type, 'sanity.imageAsset')
    assert.deepEqual(document.source, {name: 'sanity-media-library', id: image.asset._id})
    assert.equal(document.media._ref, `media-library:mlsimlocal:${image.assetInstance._id}`)
    assert.match(document.url, /\/images\/mlproj\/production\/[a-f0-9]{40}-2x2\.png$/)
    assert.equal(document.state, undefined, 'library-only fields stay in the library')
    const bytes = Buffer.from(await (await fetch(document.url.replace(/^https?:\/\/[^/]+/, sim.base))).arrayBuffer())
    assert.deepEqual(bytes, PNG)
  })

  it('refuses links Content Lake refuses: unknown instances, instances of another container', async () => {
    assert.equal((await link({mediaLibraryId: 'mlsimlocal', assetInstanceId: 'image-nope', assetId: image.asset._id})).status, 404)
    const other = await upload(Buffer.from('a plain text file'), {type: 'text/plain', filename: 'notes.txt'})
    const mismatched = await link({mediaLibraryId: 'mlsimlocal', assetInstanceId: image.assetInstance._id, assetId: other.body.asset._id})
    assert.equal(mismatched.status, 422)
    assert.match(mismatched.body.error.description, /does not belong/)
  })

  it('serves instances from the library CDN path that @sanity/image-url builds', async () => {
    const name = image.assetInstance.path.split('/').pop()
    const response = await fetch(`${sim.base}/media-libraries/mlsimlocal/images/${name}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
  })

  it('stores videos as sanity.videoAsset instances that are ready, with playback info', async () => {
    const video = await upload(Buffer.from('not really a video'), {type: 'video/mp4', filename: 'clip.mp4'})
    const id = video.body.assetInstance._id
    assert.equal(video.body.assetInstance._type, 'sanity.videoAsset')
    assert.equal((await get(ml(`/mlsimlocal/doc/${id}`))).body.documents[0].state, 'ready')
    const playback = await get(ml(`/mlsimlocal/video/${id}/playback-info`))
    assert.equal(playback.body.id, id)
    assert.ok(playback.body.stream.url)
  })

  it('reports where an asset is used, across the datasets that reference it', async () => {
    await sim.mutate([{create: {_id: 'post-1', _type: 'post', cover: {_type: 'image', asset: {_type: 'reference', _ref: image.assetInstance._id}, media: {_type: 'globalDocumentReference', _ref: `media-library:mlsimlocal:${image.asset._id}`, _weak: true}}}}])
    const {body} = await get(ml(`/mlsimlocal/references/documents/${image.asset._id}/to`))
    const refs = Object.fromEntries(body.references.map((ref) => [ref.sourceDocumentRef._ref, ref.sourceFieldPaths]))
    assert.deepEqual(refs['dataset:mlproj.production:post-1'], ['cover.media'])
    assert.deepEqual(refs[`dataset:mlproj.production:${image.assetInstance._id}`], ['media'])
  })

  it('keeps library history out of git, also in folders made by an earlier sanity-sim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-ml-git-'))
    fs.mkdirSync(path.join(root, '.sanity-sim'))
    fs.writeFileSync(path.join(root, '.sanity-sim', '.gitignore'), '.cache/\nserver.json\n')
    new Simulator({root, projectId: 'gitproj'}).close()
    const lines = fs.readFileSync(path.join(root, '.sanity-sim', '.gitignore'), 'utf8').split('\n')
    assert.ok(lines.includes('media-libraries/*/transactions.ndjson'))
    assert.equal(lines.filter((line) => line === 'server.json').length, 1)
  })

  it('serves the local picker page Studio frames instead of media.sanity.io', async () => {
    const response = await fetch(`${sim.base}/_sim/media-library/osimlocal/mlsimlocal/assets?createPluginView=e30`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /assetSelection/)
  })

  it('answers Studio\'s agent bundles stream (asked once a project has an organization) with no bundles', async () => {
    const events = await readEvents(`${sim.base}/v2025-02-19/agent/osimlocal/bundles/mine/listen`, {until: (list) => list.length > 0})
    assert.deepEqual(events[0], {event: 'bundles', data: {bundles: []}})
  })
})

describe('syncing a dataset that uses a real Media Library', () => {
  let remote
  let local
  let uploaded
  let syncResult
  let requestsBefore
  const name = () => `${uploaded.assetInstance.sha1hash}-2x2.png`

  before(async () => {
    remote = await startSim({projectId: 'realproj'})
    const response = await fetch(`${remote.base}/vX/media-libraries/mlreal/upload?filename=tiny.png`, {method: 'POST', headers: {'content-type': 'image/png'}, body: PNG})
    uploaded = await response.json()
    await fetch(`${remote.base}/vX/assets/media-library-link/production`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mediaLibraryId: 'mlreal', assetInstanceId: uploaded.assetInstance._id, assetId: uploaded.asset._id})})
    await remote.mutate([{create: {_id: 'post-1', _type: 'post', cover: {_type: 'image', asset: {_type: 'reference', _ref: uploaded.assetInstance._id}, media: {_type: 'globalDocumentReference', _ref: `media-library:mlreal:${uploaded.asset._id}`, _weak: true}}}}])
    process.env.SANITY_SIM_UPSTREAM = remote.base
    local = await startSim({projectId: 'realproj'})
    requestsBefore = remote.sim.requests.length
    const sync = await fetch(`${local.base}/_sim/datasets/production/sync`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({projectId: 'realproj', dataset: 'production'})})
    syncResult = await sync.json()
  })
  after(async () => {
    delete process.env.SANITY_SIM_UPSTREAM
    await local.close()
    await remote.close()
  })

  it('pulls the containers and instances the dataset references into the local library', () => {
    assert.deepEqual(syncResult.mediaLibraries, [{libraryId: 'mlreal', documents: 2, missing: 0}])
    const store = local.sim.mediaLibraries.get('mlreal').store
    assert.equal(store.get(uploaded.asset._id)._type, 'sanity.asset')
    assert.equal(store.get(uploaded.assetInstance._id)._type, 'sanity.imageAsset')
    assert.equal(store.layerOf(uploaded.asset._id), 'remote', 'synced, under any local changes')
  })

  it('reads Sanity only with GETs', () => {
    const methods = new Set(remote.sim.requests.slice(requestsBefore).map((entry) => entry.method))
    assert.deepEqual([...methods], ['GET'])
  })

  it('lets the picker list them and "open in library" find them', async () => {
    const search = new URLSearchParams({query: '*[_type == "sanity.asset"]._id'})
    const listed = await (await fetch(`${local.base}/vX/media-libraries/mlreal/query?${search}`)).json()
    assert.deepEqual(listed.result, [uploaded.asset._id])
  })

  it('serves their bytes, fetched once from the instance\'s real URL', async () => {
    const bytes = Buffer.from(await (await fetch(`${local.base}/media-libraries/mlreal/images/${name()}`)).arrayBuffer())
    assert.deepEqual(bytes, PNG)
  })

  it('follow mode pulls the library documents a newly synced change references', async () => {
    const admin = (body) => fetch(`${local.base}/_sim/datasets/production/follow`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
    await admin({enabled: true})
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const text = Buffer.from('a brief from the real library')
      const response = await fetch(`${remote.base}/vX/media-libraries/mlreal/upload?filename=brief.txt`, {method: 'POST', headers: {'content-type': 'text/plain'}, body: text})
      const brief = await response.json()
      await remote.mutate([{create: {_id: 'post-2', _type: 'post', brief: {_type: 'file', media: {_type: 'globalDocumentReference', _ref: `media-library:mlreal:${brief.asset._id}`, _weak: true}}}}])
      const store = local.sim.mediaLibraries.get('mlreal').store
      for (let i = 0; i < 50 && !store.get(brief.assetInstance._id); i++) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.get(brief.asset._id)?._type, 'sanity.asset')
      assert.equal(store.get(brief.assetInstance._id)?._type, 'sanity.fileAsset', 'the container\'s versions come along')
    } finally {
      await admin({enabled: false})
    }
  })

  it('links a synced asset into another local dataset, as picking it in Studio does', async () => {
    const response = await fetch(`${local.base}/vX/assets/media-library-link/staging`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mediaLibraryId: 'mlreal', assetInstanceId: uploaded.assetInstance._id, assetId: uploaded.asset._id})})
    const {document} = await response.json()
    assert.match(document.url, new RegExp(`/images/realproj/staging/${name()}$`))
    const bytes = Buffer.from(await (await fetch(document.url.replace(/^https?:\/\/[^/]+/, local.base))).arrayBuffer())
    assert.deepEqual(bytes, PNG)
  })
})

describe('Studio wiring for Media Library', () => {
  const studio = (source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-ml-wire-'))
    const file = path.join(dir, 'sanity.config.mjs')
    fs.writeFileSync(file, source)
    return file
  }
  const evaluate = async (file) => {
    const script = `const {default: config} = await import(${JSON.stringify(file)}); console.log(JSON.stringify(config))`
    const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, SANITY_STUDIO_SIM_API_HOST: 'https://localhost:3939'}})
    return JSON.parse(stdout)
  }

  it('points an enabled Media Library at the local picker, and leaves other workspaces alone', async () => {
    const file = studio(`export default [{name: 'a', mediaLibrary: {enabled: true, libraryId: 'mlreal'}}, {name: 'b'}]\n`)
    wireStudio(file)
    const [a, b] = await evaluate(file)
    assert.equal(a.mediaLibrary.__internal.frontendHost, 'https://localhost:3939/_sim/media-library')
    assert.equal(a.mediaLibrary.libraryId, 'mlreal')
    assert.equal(b.mediaLibrary, undefined)
    assert.equal(b.apiHost, 'https://localhost:3939')
  })

  it('brings a config wired by an earlier sanity-sim up to date, and eject still restores it exactly', async () => {
    const original = `export default {mediaLibrary: {enabled: true}}\n`
    const file = studio(original)
    wireStudio(file)
    const current = fs.readFileSync(file, 'utf8')
    const old = current.replace(/\/\/ <sanity-sim> Points this Studio[\s\S]*?\/\/ <\/sanity-sim>/, '// <sanity-sim> Points this Studio at an older sanity-sim.\nfunction withSanitySim(config) {\n  return config\n}\n// </sanity-sim>')
    fs.writeFileSync(file, old)
    assert.deepEqual(wireStudio(file), {changed: true, updated: true})
    assert.equal(fs.readFileSync(file, 'utf8'), current)
    assert.equal((await evaluate(file)).mediaLibrary.__internal.frontendHost, 'https://localhost:3939/_sim/media-library')
    unwireStudio(file)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
  })
})
