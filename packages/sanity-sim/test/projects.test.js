import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {after, before, describe, it} from 'node:test'
import {Simulator} from '../src/simulator.js'
import {ensureTls} from '../src/tls.js'
import {startSim} from './helpers.js'

/** Dataset files are written shortly after each change (debounced). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

/** A request with an explicit Host header, the way browsers reach `<projectId>.localhost:<port>`. */
function raw(port, {host, method = 'GET', path: target, body}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({host: '127.0.0.1', port, method, path: target, headers: {host, ...(payload ? {'content-type': 'application/json'} : {})}}, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({status: res.statusCode, body: text ? JSON.parse(text) : null}))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/*
 * Several projects in one simulator, as a Studio with workspaces on different
 * projects needs: the project in the hostname (or path) picks its own data.
 */
describe('multiple projects', () => {
  let sim
  const q = encodeURIComponent('*[_type=="post"].title')
  const titles = async (host) => (await raw(sim.port, {host, path: `/v2025-02-19/data/query/production?query=${q}`})).body.result
  const create = (host, doc) => raw(sim.port, {host, method: 'POST', path: '/v2025-02-19/data/mutate/production', body: {mutations: [{create: doc}]}})

  before(async () => {
    process.env.SANITY_SIM_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-home-'))
    sim = await startSim({projectId: 'mainprj', tls: ensureTls({hostnames: ['mainprj.localhost']})})
    await create(`mainprj.localhost:${sim.port}`, {_id: 'm', _type: 'post', title: 'main project'})
    await create(`otherprj.localhost:${sim.port}`, {_id: 'o', _type: 'post', title: 'other project'})
  })
  after(() => sim.close())

  it('keeps each project\'s datasets apart, chosen by the hostname', async () => {
    assert.deepEqual(await titles(`mainprj.localhost:${sim.port}`), ['main project'])
    assert.deepEqual(await titles(`otherprj.localhost:${sim.port}`), ['other project'])
    assert.deepEqual(await titles(`otherprj.api.sanity.io`), ['other project'])
  })

  it('stores other projects under .sanity-sim/projects/<id>/, the main one where it always was', async () => {
    await settle()
    assert.match(fs.readFileSync(path.join(sim.root, '.sanity-sim/datasets/production/local.ndjson'), 'utf8'), /main project/)
    assert.match(fs.readFileSync(path.join(sim.root, '.sanity-sim/projects/otherprj/datasets/production/local.ndjson'), 'utf8'), /other project/)
  })

  it('routes /projects/<id>/… by path, and lists every project', async () => {
    await raw(sim.port, {host: `localhost:${sim.port}`, method: 'PUT', path: '/v2021-06-07/projects/otherprj/datasets/staging'})
    const datasets = (await raw(sim.port, {host: `localhost:${sim.port}`, path: '/v2021-06-07/projects/otherprj/datasets'})).body.map((d) => d.name)
    assert.deepEqual(datasets, ['production', 'staging'])
    const mainDatasets = (await raw(sim.port, {host: `localhost:${sim.port}`, path: '/v2021-06-07/projects/mainprj/datasets'})).body.map((d) => d.name)
    assert.deepEqual(mainDatasets, ['production'])
    const projects = (await raw(sim.port, {host: `localhost:${sim.port}`, path: '/v2021-06-07/projects'})).body.map((p) => p.id)
    assert.deepEqual(projects.sort(), ['mainprj', 'otherprj'])
  })

  it('takes the project from x-sanity-sim-project (set by the Node register hook)', async () => {
    const response = await fetch(`${sim.base}/v2025-02-19/data/query/production?query=${q}`, {headers: {'x-sanity-sim-project': 'otherprj'}})
    assert.deepEqual((await response.json()).result, ['other project'])
  })

  it('scopes the dashboard API with ?project=', async () => {
    const list = await (await fetch(`${sim.base}/_sim/datasets/production/documents?project=otherprj`)).json()
    assert.deepEqual(list.documents.map((d) => d._id), ['o'])
    const status = await (await fetch(`${sim.base}/_sim/status`)).json()
    assert.deepEqual(status.projects.map((p) => p.projectId).sort(), ['mainprj', 'otherprj'])
    assert.equal((await fetch(`${sim.base}/_sim/status?project=nosuchprj`)).status, 404)
  })

  it('finds other projects again after a restart', async () => {
    await settle()
    const reopened = new Simulator({root: sim.root, projectId: 'mainprj'})
    assert.equal(reopened.projects.get('otherprj', {create: false}).dataset('production').size, 1)
    reopened.close()
  })

  it('answers TLS for a project it has not seen yet with a certificate naming it', async () => {
    const ca = fs.readFileSync(path.join(process.env.SANITY_SIM_HOME, 'ca', 'ca.pem'))
    const cert = await new Promise((resolve, reject) => {
      const socket = tls.connect({host: '127.0.0.1', port: sim.port, servername: 'brandnew1.localhost', ca, ALPNProtocols: ['http/1.1']}, () => {
        resolve(new X509Certificate(socket.getPeerX509Certificate().raw))
        socket.end()
      })
      socket.on('error', reject)
    })
    assert.match(cert.subjectAltName, /DNS:brandnew1\.localhost/)
  })

  it('the register hook keeps the project for fetch, http.request and @sanity/client', async () => {
    const hookTls = ensureTls({hostnames: ['mainprj.localhost']})
    const script = `
      import https from 'node:https'
      import {createClient} from '@sanity/client'
      const q = '*[_type=="post"][0].title'
      const client = createClient({projectId: 'otherprj', dataset: 'production', apiVersion: '2025-02-19', useCdn: false})
      const viaFetch = (await (await fetch('https://otherprj.api.sanity.io/v2025-02-19/data/query/production?query=' + encodeURIComponent(q))).json()).result
      const viaHttps = await new Promise((resolve) => https.get('https://otherprj.api.sanity.io/v2025-02-19/data/query/production?query=' + encodeURIComponent(q), (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve(JSON.parse(text).result))
      }))
      console.log(JSON.stringify({client: await client.fetch(q), fetch: viaFetch, https: viaHttps}))
    `
    const register = fileURLToPath(new URL('../src/register.js', import.meta.url))
    const {stdout} = await promisify(execFile)(process.execPath, ['--import', register, '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {...process.env, SANITY_SIM_URL: sim.base, SANITY_SIM_TLS_PORT: String(sim.port), NODE_EXTRA_CA_CERTS: hookTls.nodeCaBundle},
    })
    assert.deepEqual(JSON.parse(stdout.trim()), {client: 'other project', fetch: 'other project', https: 'other project'})
  })
})
