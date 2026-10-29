import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'
import {ReadOnlyViolation, mergeDocuments, upstream} from '../src/sync.js'
import {post, startSim} from './helpers.js'

/**
 * Sync with a second simulator standing in for the real dataset (SANITY_SIM_UPSTREAM).
 * The "remote" records every request, which is how these tests prove sync never writes.
 */
describe('sync: remote snapshot under a local layer', () => {
  let remote
  let local
  const admin = async (path, body) => {
    const response = await fetch(`${local.base}/_sim${path}`, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
    return {status: response.status, body: await response.json()}
  }
  before(async () => {
    remote = await startSim({projectId: 'realproj'})
    await remote.mutate([
      {create: {_id: 'p1', _type: 'post', title: 'Remote one', tags: ['a']}},
      {create: {_id: 'p2', _type: 'post', title: 'Remote two'}},
      {create: {_id: 'drafts.p3', _type: 'post', title: 'Remote draft'}},
    ])
    process.env.SANITY_SIM_UPSTREAM = remote.base
    local = await startSim({projectId: 'realproj'})
  })
  after(async () => {
    delete process.env.SANITY_SIM_UPSTREAM
    await local.close()
    await remote.close()
  })

  it('pulls the remote dataset, drafts included', async () => {
    const {body} = await admin('/datasets/production/sync', {projectId: 'realproj', dataset: 'production'})
    assert.equal(body.meta.count, 3)
    const {body: q} = await local.query('*[_type == "post"] | order(_id) .title', {perspective: 'raw'})
    assert.deepEqual(q.result, ['Remote draft', 'Remote one', 'Remote two'])
  })

  it('writes land in the local layer and shadow the remote document', async () => {
    await local.mutate([{patch: {id: 'p1', set: {title: 'Local one'}}}, {delete: {id: 'p2'}}, {create: {_id: 'p9', _type: 'post', title: 'Local only'}}])
    const dataset = local.sim.dataset('production')
    assert.equal(dataset.layerOf('p1'), 'local-shadow')
    assert.equal(dataset.layerOf('p2'), 'tombstone')
    assert.equal(dataset.layerOf('p9'), 'local')
    assert.deepEqual((await local.query('*[_type == "post"] | order(_id) .title')).body.result, ['Local one', 'Local only'])
    assert.equal(remote.sim.dataset('production').get('p1').title, 'Remote one', 'nothing reaches the remote')
  })

  it('a re-sync never touches local changes, and flags the ones the remote moved under', async () => {
    await remote.mutate([{patch: {id: 'p1', set: {tags: ['a', 'b']}}}, {patch: {id: 'p2', set: {title: 'Remote two, edited'}}}])
    const {body} = await admin('/datasets/production/sync', {})
    assert.equal(body.stale, 2)
    assert.equal((await local.query('*[_id == "p1"][0].title')).body.result, 'Local one')
    const stale = (await admin('/datasets/production/stale')).body
    assert.deepEqual(stale.map((entry) => entry.id), ['p1', 'p2'])
  })

  it('merge takes the remote-only change and keeps the local one', async () => {
    const {body} = await admin('/datasets/production/stale/p1', {action: 'merge'})
    assert.deepEqual(body.conflicts, [])
    assert.ok(body.ancestorFound, 'the ancestor came from the remote history API')
    const doc = (await local.query('*[_id == "p1"][0]{title, tags}')).body.result
    assert.deepEqual(doc, {title: 'Local one', tags: ['a', 'b']})
  })

  it('take discards the local version', async () => {
    await admin('/datasets/production/stale/p2', {action: 'take'})
    assert.equal((await local.query('*[_id == "p2"][0].title')).body.result, 'Remote two, edited')
    assert.deepEqual((await admin('/datasets/production/stale')).body, [])
  })

  it('keep re-bases the local version on the current remote revision', async () => {
    await remote.mutate([{patch: {id: 'p1', set: {title: 'Remote renamed'}}}])
    await admin('/datasets/production/sync', {})
    assert.deepEqual((await admin('/datasets/production/stale')).body.map((entry) => entry.id), ['p1'])
    await admin('/datasets/production/stale/p1', {action: 'keep'})
    assert.deepEqual((await admin('/datasets/production/stale')).body, [])
    assert.equal((await local.query('*[_id == "p1"][0].title')).body.result, 'Local one')
  })

  it('lists local changes like a git status', async () => {
    const changes = (await admin('/datasets/production/local-changes')).body
    assert.deepEqual(changes.map((c) => [c.id, c.change]), [['p1', 'modified'], ['p9', 'added']])
  })

  it('follow mode applies remote changes live', async () => {
    await admin('/datasets/production/follow', {enabled: true})
    await new Promise((resolve) => setTimeout(resolve, 300))
    await remote.mutate([{create: {_id: 'p10', _type: 'post', title: 'Arrived live'}}])
    let title
    for (let i = 0; i < 40 && !title; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      title = local.sim.dataset('production').get('p10')?.title
    }
    await admin('/datasets/production/follow', {enabled: false})
    assert.equal(title, 'Arrived live')
  })

  it('only ever sent GETs upstream', () => {
    const fromSync = remote.sim.requests.filter((entry) => entry.client === 'sanity-sim')
    assert.ok(fromSync.length >= 3, 'the remote saw the sync requests')
    assert.deepEqual([...new Set(fromSync.map((entry) => entry.method))], ['GET'])
  })

  it('never sends a token anywhere but sanity.io', async () => {
    let seen
    const server = (await import('node:http')).createServer((req, res) => {
      seen = req.headers.authorization
      res.end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await upstream(`http://127.0.0.1:${server.address().port}/`, {token: 'secret'})
    server.close()
    assert.equal(seen, undefined)
  })

  it('the upstream helper refuses anything but GET', () => {
    assert.throws(() => upstream('https://x.api.sanity.io/v1/data/mutate/production', {method: 'POST'}), ReadOnlyViolation)
  })
})

describe('mergeDocuments', () => {
  it('merges per field and reports true conflicts', () => {
    const ancestor = {_id: 'x', a: 1, b: 1, c: 1}
    const {merged, conflicts} = mergeDocuments(ancestor, {_id: 'x', a: 2, b: 1, c: 5}, {_id: 'x', a: 1, b: 3, c: 6})
    assert.deepEqual(merged, {_id: 'x', a: 2, b: 3, c: 5})
    assert.deepEqual(conflicts, ['c'])
  })
})
