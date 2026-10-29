import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {after, before, describe, it} from 'node:test'
import {promisify} from 'node:util'
import {createClient} from '@sanity/client'
import {Mutation} from '@sanity/mutator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {ensureTls} from '../src/tls.js'
import {startSim} from './helpers.js'

/**
 * The real @sanity/client (v8) against the simulator: what an app or script
 * would do, with nothing but `apiHost` pointing elsewhere.
 */
describe('@sanity/client 8 contract', () => {
  let sim
  let client
  before(async () => {
    sim = await startSim({projectId: 'contract'})
    client = createClient({
      projectId: 'contract',
      dataset: 'production',
      apiVersion: '2025-02-19',
      apiHost: sim.base,
      useProjectHostname: false,
      useCdn: false,
      token: 'not-checked',
    })
  })
  after(() => sim.close())

  it('creates, fetches and patches documents', async () => {
    await client.create({_id: 'movie-1', _type: 'movie', title: 'Alien', year: 1979})
    await client.patch('movie-1').set({title: 'Alien (1979)'}).inc({year: 0}).commit()
    const movie = await client.getDocument('movie-1')
    assert.equal(movie.title, 'Alien (1979)')
    assert.deepEqual(await client.fetch('*[_type == "movie"].title'), ['Alien (1979)'])
  })

  it('commits multi-document transactions', async () => {
    await client.transaction().create({_id: 'm2', _type: 'movie', title: 'Aliens'}).createOrReplace({_id: 'm3', _type: 'movie', title: 'Alien 3'}).commit()
    const docs = await client.getDocuments(['m2', 'm3', 'nope'])
    assert.deepEqual(docs.map((doc) => doc?.title ?? null), ['Aliens', 'Alien 3', null])
  })

  it('honours perspectives through the client', async () => {
    await client.create({_id: 'drafts.m2', _type: 'movie', title: 'Aliens (draft)'})
    const published = await client.fetch('*[_id == "m2"][0].title')
    const drafts = await client.withConfig({perspective: 'drafts'}).fetch('*[_id == "m2"][0].title')
    assert.equal(published, 'Aliens')
    assert.equal(drafts, 'Aliens (draft)')
  })

  it('returns the full response with syncTags when filterResponse is false', async () => {
    const response = await client.fetch('count(*)', {}, {filterResponse: false})
    assert.equal(typeof response.result, 'number')
    assert.ok(response.syncTags.length > 0)
  })

  it('returns content source maps that stega can encode', async () => {
    await client.createOrReplace({_id: 'csm', _type: 'movie', title: 'Solaris', crew: [{_key: 'k1', name: 'Tarkovsky'}]})
    const {result, resultSourceMap} = await client.fetch('*[_id == "csm"][0]{_id, title, "director": crew[0].name}', {}, {filterResponse: false, resultSourceMap: true})
    assert.equal(result.title, 'Solaris')
    const titleMapping = resultSourceMap.mappings["$['title']"]
    assert.equal(resultSourceMap.paths[titleMapping.source.path], "$['title']")
    assert.equal(resultSourceMap.documents[titleMapping.source.document]._id, 'csm')
    const directorPath = resultSourceMap.paths[resultSourceMap.mappings["$['director']"].source.path]
    assert.equal(directorPath, "$['crew'][?(@._key=='k1')]['name']")
    const {stegaEncodeSourceMap} = await import('@sanity/client/stega')
    const encoded = stegaEncodeSourceMap(result, resultSourceMap, {enabled: true, studioUrl: 'http://localhost:3333'})
    assert.notEqual(encoded.title, 'Solaris', 'stega embedded invisible edit info into the string')
    assert.ok(encoded.title.startsWith('Solaris'))
  })

  it('publishes through the Actions API', async () => {
    await client.action({actionType: 'sanity.action.document.publish', draftId: 'drafts.m2', publishedId: 'm2'})
    assert.equal(await client.fetch('*[_id == "m2"][0].title'), 'Aliens (draft)')
    assert.equal(await client.getDocument('drafts.m2'), undefined)
  })

  it('streams listener events', async () => {
    const received = new Promise((resolve, reject) => {
      const subscription = client.listen('*[_type == "movie" && year > 2000]').subscribe({
        next: (event) => {
          if (event.type === 'mutation') {
            subscription.unsubscribe()
            resolve(event)
          }
        },
        error: reject,
      })
      setTimeout(() => client.create({_id: 'm4', _type: 'movie', title: 'Prometheus', year: 2012}), 200)
    })
    const event = await received
    assert.equal(event.documentId, 'm4')
    assert.equal(event.transition, 'appear')
    assert.equal(event.result.title, 'Prometheus')
  })

  it('sends each listener event only its own document\'s mutations, as Studio applies them blindly', async () => {
    await client.createOrReplace({_id: 'm5', _type: 'movie', title: 'Alien'})
    await client.createOrReplace({_id: 'drafts.m5', _type: 'movie', title: 'Alien (edited)'})
    const published = await client.getDocument('m5')
    const events = new Promise((resolve, reject) => {
      const seen = []
      const subscription = client.listen('*[_id in ["m5", "drafts.m5"]]').subscribe({
        next: (event) => {
          if (event.type !== 'mutation') return
          seen.push(event)
          if (seen.length === event.transactionTotalEvents) {
            subscription.unsubscribe()
            resolve(seen)
          }
        },
        error: reject,
      })
      setTimeout(() => client.action({actionType: 'sanity.action.document.publish', draftId: 'drafts.m5', publishedId: 'm5'}), 200)
    })
    const publishEvent = (await events).find((event) => event.documentId === 'm5')
    const result = new Mutation({mutations: publishEvent.mutations, previousRev: publishEvent.previousRev, resultRev: publishEvent.resultRev}).apply(published)
    assert.equal(result?.title, 'Alien (edited)', 'the draft\'s delete must not reach the published document')
  })

  it('uploads assets and serves them back from the CDN path', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISd3Qk6OAUIBAB8mBBGFRCvEAAAAAElFTkSuQmCC', 'base64')
    const asset = await client.assets.upload('image', png, {filename: 'tiny.png'})
    assert.match(asset._id, /^image-[a-f0-9]{40}-2x2-png$/)
    assert.equal(asset.metadata.dimensions.width, 2)
    const bytes = Buffer.from(await (await fetch(asset.url.replace(/^https?:\/\/[^/]+/, sim.base))).arrayBuffer())
    assert.deepEqual(bytes, png)
    const resized = await fetch(`${asset.url.replace(/^https?:\/\/[^/]+/, sim.base)}?w=1&fm=webp`)
    assert.equal(resized.headers.get('content-type'), 'image/webp', 'image URL parameters are applied (sharp)')
    assert.ok(asset.metadata.lqip?.startsWith('data:image/jpeg;base64,'))
    const again = await client.assets.upload('image', png, {filename: 'other-name.png'})
    assert.equal(again._id, asset._id, 'identical bytes are deduplicated')
  })

  it('deletes documents', async () => {
    await client.delete('m4')
    assert.equal(await client.getDocument('m4'), undefined)
  })
})

describe('register hook (zero-code rerouting for Node apps)', () => {
  let sim
  let tls
  before(async () => {
    process.env.SANITY_SIM_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-home-'))
    tls = ensureTls({hostnames: ['hooked.localhost']})
    sim = await startSim({projectId: 'hooked', tls})
    await sim.mutate([{create: {_id: 'h1', _type: 'thing', name: 'from the sim'}}])
  })
  after(() => sim.close())

  it('reroutes an unmodified client pointed at <project>.api.sanity.io', async () => {
    const script = `
      import {createClient} from '@sanity/client'
      const client = createClient({projectId: 'hooked', dataset: 'production', apiVersion: '2025-02-19', useCdn: true})
      const viaFetch = await (await fetch('https://hooked.apicdn.sanity.io/v2025-02-19/data/query/production?query=*%5B_id%3D%3D%22h1%22%5D%5B0%5D.name')).json()
      console.log(JSON.stringify({client: await client.fetch('*[_id == "h1"][0].name'), fetch: viaFetch.result}))
    `
    const register = fileURLToPath(new URL('../src/register.js', import.meta.url))
    const {stdout} = await promisify(execFile)(process.execPath, ['--import', register, '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {...process.env, SANITY_SIM_URL: sim.base, SANITY_SIM_TLS_PORT: String(sim.port), NODE_EXTRA_CA_CERTS: tls.nodeCaBundle},
    })
    assert.deepEqual(JSON.parse(stdout.trim()), {client: 'from the sim', fetch: 'from the sim'})
  })
})
