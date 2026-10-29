import fs from 'node:fs'
import path from 'node:path'
import {compileActions} from './actions.js'
import {AssetStore} from './assets.js'
import {Dataset} from './dataset.js'
import {readJson, writeJsonAtomic} from './files.js'
import {RELEASES_PREFIX} from './ids.js'
import {SimError, badRequest} from './errors.js'
import {syncTagFor} from './groq.js'
import {ListenHub, LiveHub} from './listen.js'

const DATASET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * One project's state: identity, datasets, hubs, request log. The main
 * project lives under `<root>/.sanity-sim/`; other projects (workspaces on
 * other project ids) under `<root>/.sanity-sim/projects/<id>/`, reached
 * through `projects`. Asset files are content-addressed and shared.
 */
export class Simulator {
  constructor({root, dir, projectId, dataset = 'production', persist = true, log = () => {}, primary = null}) {
    this.root = root
    this.dir = dir ?? path.join(root, '.sanity-sim')
    this.primary = primary
    this.persist = persist
    this.log = log
    this.config = this.persist ? readJson(path.join(this.dir, 'config.json'), null) : null
    this.config ??= {projectId: projectId ?? 'simlocal', defaultDataset: dataset, datasets: [dataset], sync: {}}
    if (projectId) this.config.projectId = projectId
    if (!this.config.datasets.includes(dataset) && !this.config.links?.[dataset]) this.config.datasets.push(dataset)
    this.config.defaultDataset ??= dataset
    this.config.links ??= {}
    this.config.preserved ??= {}
    this.datasets = new Map()
    this.listen = new ListenHub()
    this.live = new LiveHub()
    this.assets = new AssetStore({root})
    this.keyvalue = this.persist ? readJson(path.join(this.dir, 'keyvalue.json'), {}) : {}
    this.requests = []
    this.unsupported = new Map()
    this.clients = new Map()
    this.scheduler = null
    this.linkListeners = new Set()
    this.saveConfig()
  }

  get projectId() {
    return this.config.projectId
  }

  /** Every project in this folder, created on first use like datasets. */
  get projects() {
    if (this.primary) return this.primary.projects
    this.registry ??= new ProjectRegistry(this)
    return this.registry
  }

  saveConfig() {
    if (!this.persist) return
    fs.mkdirSync(this.dir, {recursive: true})
    writeJsonAtomic(path.join(this.dir, 'config.json'), this.config)
    const gitignore = path.join(this.dir, '.gitignore')
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(
        gitignore,
        '# sanity-sim: commit your local content, not caches.\n.cache/\ndatasets/*/remote.ndjson\ndatasets/*/remote.json\ndatasets/*/transactions.ndjson\nkeyvalue.json\nserver.json\n',
      )
    } else if (!fs.readFileSync(gitignore, 'utf8').includes('server.json')) {
      fs.appendFileSync(gitignore, 'server.json\n')
    }
  }

  /**
   * The stored dataset a name refers to. A linked name ("production") resolves
   * to its target; Content Lake's alias spelling (`~production`) works too.
   */
  resolveName(name) {
    const bare = String(name ?? '').replace(/^~/, '')
    return this.config.links[bare] ?? bare
  }

  /** Dataset names Content Lake would accept. Unknown names are created on first use. */
  dataset(requested, {create = true} = {}) {
    const name = this.resolveName(requested)
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

  /** Stored datasets (links excluded). */
  datasetNames() {
    return [...this.config.datasets].sort()
  }

  /** Every name a client can use: stored datasets and links. */
  visibleDatasetNames() {
    return [...new Set([...this.config.datasets, ...Object.keys(this.config.links)])].sort()
  }

  links() {
    return Object.entries(this.config.links)
      .map(([name, target]) => ({name, target}))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Point `name` at the stored dataset `target`, or re-point it (hot swap).
   * If `name` is itself a stored dataset holding documents, they are kept
   * under `<name>-original` (or the next free name) until `unlink` puts them
   * back. Clients connected through `name` are disconnected so they reconnect
   * and refetch.
   */
  link(name, target) {
    name = String(name ?? '').replace(/^~/, '')
    target = String(target ?? '').replace(/^~/, '')
    if (!DATASET_NAME.test(name) || !DATASET_NAME.test(target)) throw badRequest('dataset names are lowercase letters, digits, "-" and "_" (max 64)')
    if (name === target) throw badRequest(`"${name}" cannot link to itself`)
    if (this.config.links[target]) throw badRequest(`"${target}" is itself a link; link to a stored dataset`)
    if (Object.values(this.config.links).includes(name)) throw badRequest(`"${name}" is the target of a link; it cannot also be one`)
    const previous = this.config.links[name]
    let preserved
    if (!previous && this.config.datasets.includes(name)) {
      const existing = this.dataset(name)
      if (existing.size > 0 || existing.transactions.length > 0) {
        preserved = this.freeName(`${name}-original`)
        this.renameDataset(name, preserved)
        this.config.preserved[name] = preserved
      } else {
        this.deleteDataset(name)
      }
    }
    this.dataset(target)
    this.config.links[name] = target
    this.saveConfig()
    this.disconnect(name, [previous ?? (preserved ? preserved : name), target])
    for (const listener of this.linkListeners) listener()
    this.log('info', `linked "${name}" → "${target}"${preserved ? ` (kept its data as "${preserved}")` : ''}`)
    return {name, target, ...(preserved ? {preserved} : {})}
  }

  unlink(name) {
    name = String(name ?? '').replace(/^~/, '')
    const target = this.config.links[name]
    if (!target) throw new SimError(404, 'notFound', `"${name}" is not a link`)
    delete this.config.links[name]
    const preserved = this.config.preserved[name]
    delete this.config.preserved[name]
    const restore = preserved && this.config.datasets.includes(preserved) && !this.config.datasets.includes(name) && !Object.values(this.config.links).includes(preserved)
    if (restore) this.renameDataset(preserved, name)
    this.saveConfig()
    this.disconnect(name, [target, name, ...(restore ? [preserved] : [])])
    for (const listener of this.linkListeners) listener()
    this.log('info', `unlinked "${name}" (was → "${target}")${restore ? ` and restored its data from "${preserved}"` : ''}`)
    return {name, unlinked: target, ...(restore ? {restored: preserved} : {})}
  }

  /** End listener and live streams opened through `name`, invalidating every dataset it showed. */
  disconnect(name, datasetNames) {
    this.listen.disconnect(name)
    this.live.disconnect(name, datasetNames.map(syncTagFor))
  }

  freeName(base) {
    let candidate = base
    for (let n = 2; this.config.datasets.includes(candidate) || this.config.links[candidate]; n += 1) candidate = `${base}-${n}`
    return candidate
  }

  renameDataset(from, to) {
    const dataset = this.dataset(from)
    dataset.flush()
    const dir = path.join(this.dir, 'datasets', to)
    if (this.persist && fs.existsSync(dataset.dir)) fs.renameSync(dataset.dir, dir)
    dataset.name = to
    dataset.dir = dir
    this.datasets.delete(from)
    this.datasets.set(to, dataset)
    this.config.datasets = this.config.datasets.map((entry) => (entry === from ? to : entry))
    if (this.config.sync?.[from]) {
      this.config.sync[to] = this.config.sync[from]
      delete this.config.sync[from]
    }
    this.saveConfig()
  }

  deleteDataset(requested) {
    const name = String(requested ?? '').replace(/^~/, '')
    if (this.config.links[name]) return this.unlink(name)
    const linkedFrom = this.links().filter((link) => link.target === name).map((link) => link.name)
    if (linkedFrom.length > 0) throw new SimError(409, 'conflict', `"${name}" is linked from ${linkedFrom.map((n) => `"${n}"`).join(', ')}; unlink or re-point first`)
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
    for (const listener of this.requestListeners ?? []) listener(entry)
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
    for (const sim of this.registry?.others.values() ?? []) if (!sim.scheduler) sim.startScheduler(intervalMs)
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
    this.registry?.closeOthers()
  }
}

/**
 * The main project's simulator plus one per other project id, each with its
 * own datasets, links, history and request log.
 */
class ProjectRegistry {
  constructor(primary) {
    this.primary = primary
    this.others = new Map()
    this.dir = path.join(primary.dir, 'projects')
    if (primary.persist && fs.existsSync(this.dir)) {
      for (const id of fs.readdirSync(this.dir)) {
        if (PROJECT_ID.test(id) && fs.existsSync(path.join(this.dir, id, 'config.json'))) this.get(id)
      }
    }
  }

  get(projectId, {create = true} = {}) {
    if (!projectId || projectId === this.primary.projectId) return this.primary
    if (this.others.has(projectId)) return this.others.get(projectId)
    if (!PROJECT_ID.test(projectId) || !create) return null
    const {primary} = this
    const fresh = !fs.existsSync(path.join(this.dir, projectId, 'config.json'))
    const sim = new Simulator({
      root: primary.root,
      dir: path.join(this.dir, projectId),
      projectId,
      dataset: primary.config.defaultDataset,
      persist: primary.persist,
      log: primary.log,
      primary,
    })
    sim.log = (...args) => primary.log(...args)
    this.others.set(projectId, sim)
    if (fresh) primary.log('info', `created project "${projectId}" on first use`)
    if (primary.scheduler) sim.startScheduler()
    for (const listener of primary.projectListeners ?? []) listener(projectId)
    return sim
  }

  all() {
    return [this.primary, ...[...this.others.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))]
  }

  closeOthers() {
    for (const sim of this.others.values()) sim.close()
  }
}
