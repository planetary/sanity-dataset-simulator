import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'
import {startSim} from './helpers.js'

describe('dashboard API', () => {
  let sim
  const admin = async (path, {method = 'GET', body} = {}) => {
    const response = await fetch(`${sim.base}/_sim${path}`, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined})
    return {status: response.status, body: await response.json()}
  }
  before(async () => {
    sim = await startSim()
    await sim.mutate([{create: {_id: 'a', _type: 'post', title: 'A'}}, {create: {_id: 'drafts.a', _type: 'post', title: 'A draft'}}, {create: {_id: 'b', _type: 'author', name: 'B'}}])
  })
  after(() => sim.close())

  it('reports status with datasets and request log', async () => {
    await sim.query('*')
    const {body} = await admin('/status')
    assert.equal(body.datasets[0].documents, 3)
    assert.ok((await admin('/requests')).body.some((entry) => entry.route === '/data/query/{dataset}'))
  })

  it('counts types and lists documents with titles and layers', async () => {
    assert.deepEqual((await admin('/datasets/production/types')).body.map((t) => [t.type, t.total, t.drafts]), [['author', 1, 0], ['post', 2, 1]])
    const list = (await admin('/datasets/production/documents?type=post')).body
    assert.equal(list.total, 2)
    assert.ok(list.documents.every((doc) => doc.layer === 'local' && doc.title.startsWith('A')))
  })

  it('saves a document and refuses a stale save', async () => {
    const detail = (await admin('/datasets/production/documents/b')).body
    const saved = await admin(`/datasets/production/documents/b?ifRevisionID=${detail.document._rev}`, {method: 'PUT', body: {...detail.document, name: 'Bee'}})
    assert.equal(saved.body.document.name, 'Bee')
    assert.equal(saved.body.document._createdAt, detail.document._createdAt)
    const stale = await admin(`/datasets/production/documents/b?ifRevisionID=${detail.document._rev}`, {method: 'PUT', body: {...detail.document, name: 'Lost'}})
    assert.equal(stale.status, 409)
  })

  it('refuses documents without _type', async () => {
    assert.equal((await admin('/datasets/production/documents/x', {method: 'PUT', body: {_id: 'x'}})).status, 400)
  })

  it('exposes per-document history', async () => {
    const {body} = await admin('/datasets/production/documents/b')
    assert.equal(body.history.length, 2)
    assert.equal(body.history[0].author, 'dashboard')
  })

  it('creates and deletes datasets', async () => {
    assert.equal((await admin('/datasets', {method: 'POST', body: {name: 'staging'}})).body.name, 'staging')
    assert.equal((await admin('/datasets', {method: 'POST', body: {name: 'Bad Name'}})).status, 400)
    await admin('/datasets/staging', {method: 'DELETE'})
    assert.deepEqual((await admin('/datasets')).body.map((d) => d.name), ['production'])
  })

  it('serves the dashboard shell at / and for client-side routes', async () => {
    for (const path of ['/', '/documents']) {
      const response = await fetch(`${sim.base}${path}`)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /<div id="app">/)
    }
  })
})
