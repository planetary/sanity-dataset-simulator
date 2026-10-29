import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'
import {Simulator} from '../src/simulator.js'
import {post, readEvents, startSim} from './helpers.js'

/*
 * Linked datasets: a name the app uses ("production") that points at a stored
 * dataset ("test-1"), and can be re-pointed while Studio and the app run.
 */
describe('linked datasets', () => {
  let sim
  const admin = async (path, {method = 'GET', body} = {}) => {
    const response = await fetch(`${sim.base}/_sim${path}`, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined})
    return {status: response.status, body: await response.json()}
  }
  const titles = async (dataset) => {
    const response = await fetch(sim.api(`/data/query/${dataset}?query=${encodeURIComponent('*[_type=="post"].title')}`))
    return (await response.json()).result.sort()
  }

  before(async () => {
    sim = await startSim()
    await sim.mutate([{create: {_id: 'p', _type: 'post', title: 'from production'}}])
    await post(sim.api('/data/mutate/test-1'), {mutations: [{create: {_id: 't1', _type: 'post', title: 'from test-1'}}]})
    await post(sim.api('/data/mutate/test-2'), {mutations: [{create: {_id: 't2', _type: 'post', title: 'from test-2'}}]})
  })
  after(() => sim.close())

  it('keeps the data a linked name already held, under a new name', async () => {
    const linked = await admin('/links/production', {method: 'PUT', body: {target: 'test-1'}})
    assert.equal(linked.status, 200)
    assert.deepEqual(linked.body, {name: 'production', target: 'test-1', preserved: 'production-original'})
    assert.deepEqual(await titles('production-original'), ['from production'])
  })

  it('serves the target through the linked name, and through ~name', async () => {
    assert.deepEqual(await titles('production'), ['from test-1'])
    assert.deepEqual(await titles('~production'), ['from test-1'])
  })

  it('writes through the link into the target', async () => {
    await sim.mutate([{create: {_id: 'w', _type: 'post', title: 'written via production'}}])
    assert.deepEqual(await titles('test-1'), ['from test-1', 'written via production'])
  })

  it('hot-swaps: listeners on the linked name are closed so clients refetch', async () => {
    const url = sim.api(`/data/listen/production?query=${encodeURIComponent('*')}`)
    const started = Date.now()
    const events = await readEvents(url, {timeout: 3000, onOpen: () => admin('/links/production', {method: 'PUT', body: {target: 'test-2'}})})
    assert.equal(events[0].event, 'welcome')
    assert.ok(Date.now() - started < 2500, 'the listener stream ended on swap')
    assert.deepEqual(await titles('production'), ['from test-2'])
  })

  it('hot-swaps: live clients get both datasets\' sync tags, then reconnect', async () => {
    const tagsOf = async (dataset) => {
      const response = await fetch(sim.api(`/data/query/${dataset}?query=${encodeURIComponent('*[0]')}`))
      return (await response.json()).syncTags
    }
    const before = await tagsOf('production')
    const url = sim.api('/data/live/events/production')
    const events = await readEvents(url, {timeout: 3000, onOpen: () => admin('/links/production', {method: 'PUT', body: {target: 'test-1'}})})
    const message = events.find((event) => event.event === 'message')
    assert.ok(message, 'a message announced the swap')
    for (const tag of [...before, ...(await tagsOf('production'))]) assert.ok(message.data.tags.includes(tag), `${tag} invalidated`)
  })

  it('lists links in the dashboard API and the project dataset list', async () => {
    assert.deepEqual((await admin('/links')).body, [{name: 'production', target: 'test-1'}])
    const datasets = (await admin('/datasets')).body
    assert.deepEqual(datasets.find((d) => d.name === 'test-1').linkedFrom, ['production'])
    assert.ok(!datasets.some((d) => d.name === 'production'), 'a link is not a stored dataset')
    const projectList = await (await fetch(sim.api('/projects/testproj/datasets'))).json()
    assert.ok(projectList.some((d) => d.name === 'production'), 'Studio still sees its dataset')
  })

  it('refuses links that would loop or dangle', async () => {
    assert.equal((await admin('/links/test-2', {method: 'PUT', body: {target: 'test-2'}})).status, 400)
    assert.equal((await admin('/links/other', {method: 'PUT', body: {target: 'production'}})).status, 400)
    assert.equal((await admin('/datasets/test-1', {method: 'DELETE'})).status, 409)
  })

  it('persists links across restarts', () => {
    const reopened = new Simulator({root: sim.root})
    assert.equal(reopened.dataset('production').name, 'test-1')
    reopened.close()
  })

  it('unlinks; the documents the name held before the link come back', async () => {
    const unlinked = await admin('/links/production', {method: 'DELETE'})
    assert.deepEqual(unlinked.body, {name: 'production', unlinked: 'test-1', restored: 'production-original'})
    assert.deepEqual(await titles('production'), ['from production'])
    assert.deepEqual(await titles('test-1'), ['from test-1', 'written via production'])
    assert.ok(!(await admin('/status')).body.datasets.some((dataset) => dataset.name === 'production-original'))
  })

  it('unlinks a name that held nothing into an ordinary empty dataset', async () => {
    await admin('/links/fresh', {method: 'PUT', body: {target: 'test-2'}})
    assert.deepEqual((await admin('/links/fresh', {method: 'DELETE'})).body, {name: 'fresh', unlinked: 'test-2'})
    assert.deepEqual(await titles('fresh'), [])
  })
})
