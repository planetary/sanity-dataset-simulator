import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'
import {Simulator} from '../src/simulator.js'
import {readEvents, startSim} from './helpers.js'

describe('queries and perspectives', () => {
  let sim
  before(async () => {
    sim = await startSim()
    await sim.mutate([
      {create: {_id: 'a', _type: 'author', name: 'Ada'}},
      {create: {_id: 'drafts.a', _type: 'author', name: 'Ada (draft)'}},
      {create: {_id: 'drafts.b', _type: 'author', name: 'Only a draft'}},
      {create: {_id: 'versions.spring.a', _type: 'author', name: 'Ada (spring)'}},
      {create: {_id: 'versions.spring.c', _type: 'author', name: 'Gone in spring', _system: {delete: true}}},
      {create: {_id: 'c', _type: 'author', name: 'Cee'}},
      {create: {_id: 'p', _type: 'post', title: 'Hello', author: {_type: 'reference', _ref: 'a'}}},
    ])
  })
  after(() => sim.close())

  const names = (result) => result.map((doc) => doc.name).sort()

  it('defaults to `published` from v2025-02-19', async () => {
    const {body} = await sim.query('*[_type == "author"]{name}')
    assert.deepEqual(names(body.result), ['Ada', 'Cee'])
  })

  it('defaults to `raw` before v2025-02-19', async () => {
    const {body} = await sim.query('*[_type == "author"]{name}', {version: 'v2024-01-01'})
    assert.equal(body.result.length, 6)
  })

  it('overlays drafts under `drafts`, reporting published ids and _originalId', async () => {
    const {body} = await sim.query('*[_type == "author"]{_id, _originalId, name}', {perspective: 'drafts'})
    assert.deepEqual(body.result.sort((x, y) => x._id.localeCompare(y._id)), [
      {_id: 'a', _originalId: 'drafts.a', name: 'Ada (draft)'},
      {_id: 'b', _originalId: 'drafts.b', name: 'Only a draft'},
      {_id: 'c', _originalId: null, name: 'Cee'},
    ])
  })

  it('resolves release stacks, honouring _system.delete', async () => {
    const {body} = await sim.query('*[_type == "author"]{_id, name}', {perspective: 'spring,drafts'})
    assert.deepEqual(names(body.result), ['Ada (spring)', 'Only a draft'])
  })

  it('returns everything, versions and system docs included, under `raw`', async () => {
    const {body} = await sim.query('count(*)', {perspective: 'raw'})
    assert.equal(body.result, 7)
  })

  it('follows references and returns syncTags', async () => {
    const {body} = await sim.query('*[_type == "post"][0]{title, "author": author->name}')
    assert.deepEqual(body.result, {title: 'Hello', author: 'Ada'})
    assert.ok(Array.isArray(body.syncTags) && body.syncTags[0].startsWith('s1:'))
  })

  it('answers text::query matches the way Studio list queries use them', async () => {
    const all = await sim.query('*[_type == "author" && [@, _id] match text::query($q)]._id', {params: {q: '*'}})
    assert.equal(all.body.result.length, 2)
    const some = await sim.query('*[_type == "author" && [@, _id] match text::query($q)]._id', {params: {q: 'ce*'}})
    assert.deepEqual(some.body.result, ['c'])
    assert.equal(some.body.simApproximations[0].function, 'text::query')
  })

  it('accepts parameterized slices, which groq-js cannot parse alone', async () => {
    const {body} = await sim.query('*[_type == "author"] | order(_id asc) [0...$limit]._id', {params: {limit: 1}})
    assert.deepEqual(body.result, ['a'])
  })

  it('reports parse errors in Content Lake shape', async () => {
    const {status, body} = await sim.query('*[_type == ')
    assert.equal(status, 400)
    assert.equal(body.error.type, 'queryParseError')
  })

  it('refuses non-JSON parameters', async () => {
    const response = await fetch(sim.api('/data/query/production?query=*&$x=notjson'))
    assert.equal(response.status, 400)
  })
})

describe('mutations', () => {
  let sim
  before(async () => (sim = await startSim()))
  after(() => sim.close())

  it('creates, refuses duplicates, and treats createIfNotExists as a no-op', async () => {
    assert.equal((await sim.mutate([{create: {_id: 'x', _type: 't', n: 1}}])).status, 200)
    const dup = await sim.mutate([{create: {_id: 'x', _type: 't'}}])
    assert.equal(dup.status, 409)
    const noop = await sim.mutate([{createIfNotExists: {_id: 'x', _type: 't', n: 99}}])
    assert.deepEqual(noop.body.results, [{id: 'x', operation: 'none'}])
  })

  it('applies patches with Content Lake path semantics and sets _rev to the transaction id', async () => {
    await sim.mutate([{create: {_id: 'pt', _type: 't', body: [{_key: 'k1', _type: 'block', children: [{_key: 's1', text: 'hi'}]}]}}])
    const {body} = await sim.mutate(
      [{patch: {id: 'pt', set: {'body[_key=="k1"].children[_key=="s1"].text': 'hello'}, insert: {after: 'body[-1]', items: [{_key: 'k2', _type: 'block'}]}}}],
      '?returnDocuments=true',
    )
    const doc = body.results[0].document
    assert.equal(doc.body[0].children[0].text, 'hello')
    assert.equal(doc.body.length, 2)
    assert.equal(doc._rev, body.transactionId)
  })

  it('enforces ifRevisionID', async () => {
    const res = await sim.mutate([{patch: {id: 'x', ifRevisionID: 'nope', set: {n: 2}}}])
    assert.equal(res.status, 409)
    assert.match(res.body.error.description, /unexpected revision/)
  })

  it('is atomic: a failing mutation rolls back the whole transaction', async () => {
    const res = await sim.mutate([{create: {_id: 'atomic', _type: 't'}}, {create: {_id: 'x', _type: 't'}}])
    assert.equal(res.status, 409)
    const {body} = await sim.query('*[_id == "atomic"]')
    assert.deepEqual(body.result, [])
  })

  it('supports query-based patch and delete', async () => {
    await sim.mutate([{create: {_id: 'q1', _type: 'bulk'}}, {create: {_id: 'q2', _type: 'bulk'}}])
    await sim.mutate([{patch: {query: '*[_type == "bulk"]', set: {flag: true}}}])
    const flagged = await sim.query('count(*[_type == "bulk" && flag])')
    assert.equal(flagged.body.result, 2)
    await sim.mutate([{delete: {query: '*[_type == "bulk"]'}}])
    assert.equal((await sim.query('count(*[_type == "bulk"])')).body.result, 0)
  })

  it('autoGenerateArrayKeys adds _key to array objects', async () => {
    const {body} = await sim.mutate([{create: {_id: 'keys', _type: 't', items: [{a: 1}, {b: 2}]}}], '?autoGenerateArrayKeys=true&returnDocuments=true')
    assert.ok(body.results[0].document.items.every((item) => typeof item._key === 'string'))
  })

  it('dryRun changes nothing', async () => {
    await sim.mutate([{create: {_id: 'dry', _type: 't'}}], '?dryRun=true')
    assert.equal((await sim.query('count(*[_id == "dry"])')).body.result, 0)
  })

  it('refuses a reused transaction id', async () => {
    await sim.mutate([{create: {_id: 't1', _type: 't'}}], '?transactionId=fixed-tx')
    const again = await sim.mutate([{create: {_id: 't2', _type: 't'}}], '?transactionId=fixed-tx')
    assert.equal(again.status, 409)
  })
})

describe('actions API', () => {
  let sim
  before(async () => {
    sim = await startSim()
    await sim.mutate([{create: {_id: 'doc', _type: 'post', title: 'Published title'}}])
  })
  after(() => sim.close())
  const raw = async (groq) => (await sim.query(groq, {perspective: 'raw'})).body.result

  it('edit creates the draft from the published document, then patches it', async () => {
    const res = await sim.actions([{actionType: 'sanity.action.document.edit', draftId: 'drafts.doc', publishedId: 'doc', patch: {set: {title: 'Draft title'}}}])
    assert.equal(res.status, 200)
    assert.deepEqual(await raw('*[_id in ["doc", "drafts.doc"]] | order(_id) .title'), ['Published title', 'Draft title'])
  })

  it('publish replaces the published document and removes the draft', async () => {
    await sim.actions([{actionType: 'sanity.action.document.publish', draftId: 'drafts.doc', publishedId: 'doc'}])
    assert.deepEqual(await raw('*[_id in ["doc", "drafts.doc"]].title'), ['Draft title'])
  })

  it('unpublish moves the published document back to a draft', async () => {
    await sim.actions([{actionType: 'sanity.action.document.unpublish', draftId: 'drafts.doc', publishedId: 'doc'}])
    assert.deepEqual(await raw('*[_id in ["doc", "drafts.doc"]]._id'), ['drafts.doc'])
  })

  it('refuses mixing action categories', async () => {
    const res = await sim.actions([
      {actionType: 'sanity.action.document.discard', draftId: 'drafts.doc'},
      {actionType: 'sanity.action.release.create', releaseId: 'r'},
    ])
    assert.equal(res.status, 400)
  })

  it('runs the release lifecycle: create, add a version, schedule, publish on time', async () => {
    await sim.mutate([{create: {_id: 'rel-doc', _type: 'post', title: 'Before'}}])
    await sim.actions([{actionType: 'sanity.action.release.create', releaseId: 'spring', metadata: {title: 'Spring', releaseType: 'asap'}}])
    await sim.actions([{actionType: 'sanity.action.document.version.create', publishedId: 'rel-doc', baseId: 'rel-doc', versionId: 'versions.spring.rel-doc'}])
    await sim.actions([{actionType: 'sanity.action.document.edit', draftId: 'versions.spring.rel-doc', publishedId: 'rel-doc', patch: {set: {title: 'After'}}}])
    const publishAt = new Date(Date.now() + 1000).toISOString()
    await sim.actions([{actionType: 'sanity.action.release.schedule', releaseId: 'spring', publishAt}])
    const locked = await sim.actions([{actionType: 'sanity.action.document.version.discard', versionId: 'versions.spring.rel-doc'}])
    assert.equal(locked.status, 409, 'versions are locked while scheduled')
    await sim.sim.publishDueReleases(new Date(Date.now() + 5000))
    assert.deepEqual(await raw('*[_id == "rel-doc"].title'), ['After'])
    assert.deepEqual(await raw('*[_id == "_.releases.spring"].state'), ['published'])
    assert.deepEqual(await raw('*[_id == "versions.spring.rel-doc"]'), [])
  })

  it('archive removes versions and unarchive restores them', async () => {
    await sim.actions([{actionType: 'sanity.action.release.create', releaseId: 'fall'}])
    await sim.actions([{actionType: 'sanity.action.document.version.create', publishedId: 'rel-doc', baseId: 'rel-doc', versionId: 'versions.fall.rel-doc'}])
    await sim.actions([{actionType: 'sanity.action.release.archive', releaseId: 'fall'}])
    assert.deepEqual(await raw('*[_id == "versions.fall.rel-doc"]'), [])
    await sim.actions([{actionType: 'sanity.action.release.unarchive', releaseId: 'fall'}])
    assert.deepEqual(await raw('*[_id == "versions.fall.rel-doc"]._id'), ['versions.fall.rel-doc'])
  })
})

describe('listen and live events', () => {
  let sim
  before(async () => (sim = await startSim()))
  after(() => sim.close())

  it('filters by query and computes appear / update / disappear with mutations and effects', async () => {
    const url = sim.api('/data/listen/production?query=' + encodeURIComponent('*[_type == "watched" && n > 1]') + '&effectFormat=mendoza')
    const events = await readEvents(url, {
      until: (list) => list.filter((e) => e.event === 'mutation').length >= 3,
      onOpen: async () => {
        await sim.mutate([{create: {_id: 'w', _type: 'watched', n: 1}}])
        await sim.mutate([{create: {_id: 'other', _type: 'unwatched', n: 5}}])
        await sim.mutate([{patch: {id: 'w', set: {n: 2}}}])
        await sim.mutate([{patch: {id: 'w', set: {n: 3}}}])
        await sim.mutate([{patch: {id: 'w', set: {n: 0}}}])
      },
    })
    assert.equal(events[0].event, 'welcome')
    const mutations = events.filter((e) => e.event === 'mutation').map((e) => e.data)
    assert.deepEqual(mutations.map((m) => m.transition), ['appear', 'update', 'disappear'])
    assert.ok(mutations.every((m) => m.documentId === 'w'))
    const first = mutations[0]
    assert.ok(Array.isArray(first.mutations) && first.mutations[0].patch)
    assert.equal(typeof first.previousRev, 'string')
    assert.equal(first.result.n, 2)
    assert.deepEqual(first.effects.apply, [0, first.result])
  })

  it('omits mutations when includeMutations=false and results when includeResult=false', async () => {
    const url = sim.api('/data/listen/production?query=' + encodeURIComponent('*[_id == "quiet"]') + '&includeMutations=false&includeResult=false')
    const events = await readEvents(url, {
      until: (list) => list.some((e) => e.event === 'mutation'),
      onOpen: () => sim.mutate([{create: {_id: 'quiet', _type: 't'}}]),
    })
    const event = events.find((e) => e.event === 'mutation').data
    assert.equal(event.mutations, undefined)
    assert.equal(event.result, undefined)
  })

  it('emits sync-tag messages on the live endpoint, drafts only with includeDrafts', async () => {
    const url = sim.api('/data/live/events/production')
    const events = await readEvents(url, {
      until: (list) => list.some((e) => e.event === 'message'),
      onOpen: async () => {
        await sim.mutate([{create: {_id: 'drafts.livex', _type: 't'}}])
        await sim.mutate([{create: {_id: 'livex', _type: 't'}}])
      },
    })
    const messages = events.filter((e) => e.event === 'message')
    assert.equal(messages.length, 1, 'the draft-only change is not announced without includeDrafts')
    assert.ok(messages[0].data.tags[0].startsWith('s1:'))
  })
})

describe('history, doc and export', () => {
  let sim
  before(async () => {
    sim = await startSim()
    await sim.mutate([{create: {_id: 'h', _type: 't', v: 1}}])
    await sim.mutate([{patch: {id: 'h', set: {v: 2}}}])
  })
  after(() => sim.close())

  it('serves the translog as NDJSON with mendoza effects', async () => {
    const response = await fetch(sim.api('/data/history/production/transactions/h?excludeContent=true&effectFormat=mendoza'))
    assert.match(response.headers.get('content-type'), /ndjson/)
    const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.deepEqual(lines[1].effects.h.apply[1].v, 2)
  })

  it('returns a document at an earlier revision', async () => {
    const first = (await (await fetch(sim.api('/data/history/production/transactions/h'))).text()).split('\n')[0]
    const rev = JSON.parse(first).id
    const {documents} = await (await fetch(sim.api(`/data/history/production/documents/h?revision=${rev}`))).json()
    assert.equal(documents[0].v, 1)
  })

  it('derives lifecycle events for the history panel', async () => {
    const {events} = await (await fetch(sim.api('/data/history/production/events/documents/h'))).json()
    assert.equal(events.h[events.h.length - 1].type, 'createLiveDocument')
  })

  it('answers the doc API with omitted ids', async () => {
    const body = await (await fetch(sim.api('/data/doc/production/h,missing'))).json()
    assert.equal(body.documents[0]._id, 'h')
    assert.deepEqual(body.omitted, [{id: 'missing', reason: 'existence'}])
  })

  it('exports NDJSON', async () => {
    const text = await (await fetch(sim.api('/data/export/production'))).text()
    assert.equal(JSON.parse(text.trim()).v, 2)
  })
})

describe('persistence', () => {
  it('reloads the dataset, tombstones and history from disk', async () => {
    const first = await startSim()
    await first.mutate([{create: {_id: 'kept', _type: 't'}}, {create: {_id: 'gone', _type: 't'}}])
    await first.mutate([{delete: {id: 'gone'}}])
    await first.close()
    const sim = new Simulator({root: first.root, projectId: 'testproj'})
    const dataset = sim.dataset('production')
    assert.deepEqual(dataset.documents().map((doc) => doc._id), ['kept'])
    assert.equal(dataset.transactions.length, 2)
    sim.close()
  })
})

describe('origin policy', () => {
  it('refuses writes from non-loopback browser origins but allows loopback ones', async () => {
    const sim = await startSim()
    const write = (origin) =>
      fetch(sim.api('/data/mutate/production'), {
        method: 'POST',
        headers: {'content-type': 'application/json', origin},
        body: JSON.stringify({mutations: [{createOrReplace: {_id: 'o', _type: 't'}}]}),
      })
    assert.equal((await write('https://evil.example')).status, 403)
    assert.equal((await write('http://localhost:3333')).status, 200)
    assert.equal((await write('https://myproj.localhost:3939')).status, 200)
    await sim.close()
  })
})
