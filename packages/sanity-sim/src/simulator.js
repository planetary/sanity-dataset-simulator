import fs from 'node:fs'
import path from 'node:path'
import {compileActions} from './actions.js'
import {AssetStore} from './assets.js'
import {Dataset} from './dataset.js'
import {readJson, writeJsonAtomic} from './files.js'
import {RELEASES_PREFIX} from './ids.js'
import {ListenHub, LiveHub} from './listen.js'

const DATASET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * The simulator's state: project identity, datasets, hubs, request log.
 * Everything lives under `<root>/.sanity-sim/`.
 */
export class Simulator {
  constructor({root, projectId, dataset = 'production', persist = true, log = () => {}}) {
    this.root = root
    this.dir = path.join(root, '.sanity-sim')
    this.persist = persist
    this.log = log
    this.config = this.persist ? readJson(path.join(this.dir, 'config.json'), null) : null
    this.config ??= {projectId: projectId ?? 'simlocal', defaultDataset: dataset, datasets: [dataset], sync: {}}
    if (projectId) this.config.projectId = projectId
    if (!this.config.datasets.includes(dataset)) this.config.datasets.push(dataset)
    this.config.defaultDataset ??= dataset
    this.datasets = new Map()
    this.listen = new ListenHub()
    this.live = new LiveHub()
    this.assets = new AssetStore({root})
    this.keyvalue = this.persist ? readJson(path.join(this.dir, 'keyvalue.json'), {}) : {}
    this.requests = []
    this.unsupported = new Map()
    this.clients = new Map()
    this.scheduler = null
    this.saveConfig()
  }

  get projectId() {
    return this.config.projectId
  }

  saveConfig() {
    if (!this.persist) return
    fs.mkdirSync(this.dir, {recursive: true})
    writeJsonAtomic(path.join(this.dir, 'config.json'), this.config)
    const gitignore = path.join(this.dir, '.gitignore')
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(
        gitignore,
        '# sanity-sim: commit your local content, not caches.\n.cache/\ndatasets/*/remote.ndjson\ndatasets/*/remote.json\ndatasets/*/transactions.ndjson\nkeyvalue.json\n',
      )
    }
  }

  /** Dataset names Content Lake would accept. Unknown names are created on first use. */
  dataset(name, {create = true} = {}) {
    if (this.datasets.has(name)) return this.datasets.get(name)
    if (!DATASET_NAME.test(name)) return null
    if (!this.config.datasets.includes(name)) {
      if (!create) return null
      this.config.datasets.push(name)
      this.saveConfig()
      this.log('info', `created dataset "${name}" on first use`)
    }
    const dataset = new Dataset({name, dir: path.join(this.dir, 'datasets', name), persist: this.persist}).load()
    this.listen.attach(dataset)
    this.live.attach(dataset)
    this.datasets.set(name, dataset)
    return dataset
  }

  datasetNames() {
    return [...this.config.datasets].sort()
  }

  deleteDataset(name) {
    const dataset = this.datasets.get(name)
    dataset?.reset({keepRemote: false})
    this.datasets.delete(name)
    this.config.datasets = this.config.datasets.filter((entry) => entry !== name)
    if (this.persist) fs.rmSync(path.join(this.dir, 'datasets', name), {recursive: true, force: true})
    this.saveConfig()
  }

  setKeyValue(entries) {
    for (const {key, value} of entries) this.keyvalue[key] = value
    if (this.persist) writeJsonAtomic(path.join(this.dir, 'keyvalue.json'), this.keyvalue)
  }

  /* ------------------------------------------------------------ request log */

  record(entry) {
    this.requests.push(entry)
    if (this.requests.length > 1000) this.requests.shift()
    if (entry.unsupported) {
      const key = `${entry.method} ${entry.route}`
      this.unsupported.set(key, (this.unsupported.get(key) ?? 0) + 1)
    }
    if (entry.client) {
      const known = this.clients.get(entry.client) ?? {client: entry.client, requests: 0}
      known.requests += 1
      known.lastSeen = entry.at
      known.apiVersions = [...new Set([...(known.apiVersions ?? []), entry.apiVersion].filter(Boolean))].sort()
      this.clients.set(entry.client, known)
    }
  }

  /* ------------------------------------------------------------ scheduled releases */

  startScheduler(intervalMs = 1000) {
    this.scheduler = setInterval(() => this.publishDueReleases().catch((error) => this.log('error', `scheduler: ${error.message}`)), intervalMs)
    this.scheduler.unref?.()
  }

  async publishDueReleases(now = new Date()) {
    for (const name of this.config.datasets) {
      const dataset = this.dataset(name)
      for (const doc of dataset.documents()) {
        if (!doc._id.startsWith(RELEASES_PREFIX) || doc.state !== 'scheduled' || !doc.publishAt) continue
        if (new Date(doc.publishAt) > now) continue
        const releaseId = doc._id.slice(RELEASES_PREFIX.length)
        await dataset.commitWith((ds) => compileActions([{actionType: 'sanity.action.release.publish', releaseId}], ds, {now}), {author: 'sanity-sim.scheduler'})
        this.log('info', `published scheduled release "${releaseId}" in ${name}`)
      }
    }
  }

  close() {
    if (this.scheduler) clearInterval(this.scheduler)
    for (const dataset of this.datasets.values()) dataset.flush()
  }
}
