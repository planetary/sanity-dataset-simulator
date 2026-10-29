import {EventEmitter} from 'node:events'
import {randomUUID, randomBytes} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {Mutation} from '@sanity/mutator'
import {conflict, badRequest} from './errors.js'
import {isValidDocumentId} from './ids.js'
import {readNdjson, writeNdjsonAtomic, writeJsonAtomic, readJson} from './files.js'

const CREATE_KINDS = ['create', 'createOrReplace', 'createIfNotExists']

/**
 * One dataset: a read-only remote snapshot (from `sanity-sim sync`), a local
 * layer of whole documents on top, and tombstones for remote documents deleted
 * locally. Every read sees the merged view; every write lands in the local layer.
 *
 * Files (all under `<root>/.sanity-sim/datasets/<name>/`):
 *   local.ndjson         local layer, sorted by _id (commit this)
 *   tombstones.json      ids deleted locally that exist remotely (commit this)
 *   base.json            remote _rev each local shadow/tombstone was forked from
 *   remote.ndjson        synced snapshot (cache; gitignored)
 *   remote.json          sync metadata
 *   transactions.ndjson  local transaction log, with mendoza effects (history API)
 *
 * Events: 'transaction' ({transactionId, timestamp, author, mutations, changes})
 * after every committed (non-dry-run) write.
 */
export class Dataset extends EventEmitter {
  constructor({name, dir, persist = true}) {
    super()
    this.name = name
    this.dir = dir
    this.persist = persist
    this.remote = new Map()
    this.local = new Map()
    this.tombstones = new Set()
    this.base = {}
    this.remoteMeta = null
    this.remoteDirty = false
    this.transactions = []
    this.queue = Promise.resolve()
    this.flushTimer = null
    this.setMaxListeners(0)
  }

  load() {
    if (!this.persist) return this
    fs.mkdirSync(this.dir, {recursive: true})
    for (const doc of readNdjson(this.file('remote.ndjson'))) this.remote.set(doc._id, doc)
    for (const doc of readNdjson(this.file('local.ndjson'))) this.local.set(doc._id, doc)
    for (const id of readJson(this.file('tombstones.json'), [])) this.tombstones.add(id)
    this.base = readJson(this.file('base.json'), {})
    this.remoteMeta = readJson(this.file('remote.json'), null)
    this.transactions = readNdjson(this.file('transactions.ndjson'))
    return this
  }

  file(name) {
    return path.join(this.dir, name)
  }

  /* ------------------------------------------------------------ reads */

  get(id) {
    if (this.tombstones.has(id)) return null
    return this.local.get(id) ?? this.remote.get(id) ?? null
  }

  /** Every document in the merged view, sorted by `_id`. */
  documents() {
    const out = []
    for (const [id, doc] of this.local) out.push(doc)
    for (const [id, doc] of this.remote) {
      if (this.local.has(id) || this.tombstones.has(id)) continue
      out.push(doc)
    }
    return out.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
  }

  get size() {
    let count = this.local.size
    for (const id of this.remote.keys()) if (!this.local.has(id) && !this.tombstones.has(id)) count++
    return count
  }

  /** Where a document's current version comes from. */
  layerOf(id) {
    if (this.tombstones.has(id)) return 'tombstone'
    if (this.local.has(id)) return this.remote.has(id) ? 'local-shadow' : 'local'
    if (this.remote.has(id)) return 'remote'
    return null
  }

  /* ------------------------------------------------------------ writes */

  /**
   * Apply Content Lake mutations atomically. Serialized: concurrent commits
   * queue behind each other, so each sees the previous one's result.
   *
   * @param {object[]} mutations Content Lake mutation objects
   * @param {{transactionId?: string, author?: string, dryRun?: boolean,
   *   autoGenerateArrayKeys?: boolean, expandQuery?: (query: string, params: object) => Promise<string[]>}} options
   */
  commit(mutations, options = {}) {
    return this.commitWith(() => mutations, options)
  }

  /**
   * Build the mutations from the current state and commit them, in one turn of
   * the queue, so nothing can change between reading and writing (actions need
   * this: "edit" reads whether a draft exists before deciding what to write).
   */
  commitWith(build, options = {}) {
    const run = this.queue.then(async () => this.#commit(await build(this), options))
    this.queue = run.catch(() => {})
    return run
  }

  async #commit(mutations, {transactionId, author = 'local-dev', dryRun = false, autoGenerateArrayKeys = false, expandQuery}) {
    if (!Array.isArray(mutations)) throw badRequest('`mutations` must be an array')
    const txId = transactionId || randomUUID()
    if (!dryRun && this.transactions.some((tx) => tx.id === txId)) {
      throw conflict(`Transaction ID "${txId}" has already been used`, {type: 'conflictError'})
    }
    const timestamp = new Date().toISOString()
    const working = new Map()
    const read = (id) => (working.has(id) ? working.get(id) : this.get(id))
    const results = []
    const applied = []

    for (const raw of mutations) {
      const [kind, body] = singleKey(raw)
      if (CREATE_KINDS.includes(kind)) {
        const doc = {...body}
        doc._id = generatedId(doc._id)
        if (typeof doc._type !== 'string' || doc._type === '') {
          throw badRequest(`${kind}: document "${doc._id}" is missing \`_type\``)
        }
        if (!isValidDocumentId(doc._id)) throw badRequest(`Document ID "${doc._id}" is not valid`)
        const existing = read(doc._id)
        if (kind === 'create' && existing) throw conflict(`Document by ID "${doc._id}" already exists`)
        if (kind === 'createIfNotExists' && existing) {
          results.push({id: doc._id, operation: 'none'})
          continue
        }
        const mutation = {[kind]: doc}
        working.set(doc._id, applyOne(mutation, existing, txId, timestamp, autoGenerateArrayKeys))
        applied.push(mutation)
        results.push({id: doc._id, operation: existing ? 'update' : 'create'})
      } else if (kind === 'delete') {
        const ids = body.id !== undefined ? [body.id] : await expandOrThrow(expandQuery, body)
        for (const id of ids) {
          const existing = read(id)
          working.set(id, null)
          applied.push({delete: {id}})
          results.push({id, operation: existing ? 'delete' : 'none'})
        }
      } else if (kind === 'patch') {
        const ids = body.id !== undefined ? [body.id] : await expandOrThrow(expandQuery, body)
        for (const id of ids) {
          const existing = read(id)
          if (!existing) {
            throw conflict(`Cannot modify document "${id}" because it does not exist`, {documentId: id})
          }
          if (body.ifRevisionID !== undefined && body.ifRevisionID !== existing._rev) {
            throw conflict(
              `Document by ID "${id}" has unexpected revision ID ("${existing._rev}"), expected "${body.ifRevisionID}"`,
              {documentId: id},
            )
          }
          const {query: _q, params: _p, ...rest} = body
          const mutation = {patch: {...rest, id}}
          working.set(id, applyOne(mutation, existing, txId, timestamp, autoGenerateArrayKeys))
          applied.push(mutation)
          results.push({id, operation: 'update'})
        }
      } else {
        throw badRequest(`Unknown mutation type "${kind}"`)
      }
    }

    const changes = []
    for (const [id, after] of working) {
      const before = this.get(id)
      if (before === null && after === null) continue
      changes.push({id, before, after})
    }

    if (dryRun) return {transactionId: txId, timestamp, results, changes, mutations: applied}

    for (const {id, after} of changes) this.#write(id, after)
    if (changes.length > 0) {
      const entry = {
        id: txId,
        timestamp,
        author,
        mutations: applied,
        documentIDs: changes.map((change) => change.id),
        effects: Object.fromEntries(
          changes.map(({id, before, after}) => [id, {apply: [0, after], revert: [0, before]}]),
        ),
      }
      this.transactions.push(entry)
      if (this.persist) fs.appendFileSync(this.file('transactions.ndjson'), JSON.stringify(entry) + '\n')
      this.scheduleFlush()
      this.emit('transaction', {transactionId: txId, timestamp, author, mutations: applied, changes})
    }
    return {transactionId: txId, timestamp, results, changes, mutations: applied}
  }

  #write(id, after) {
    const remote = this.remote.get(id)
    if (after === null) {
      this.local.delete(id)
      if (remote) {
        this.tombstones.add(id)
        if (!(id in this.base)) this.base[id] = remote._rev
      } else {
        delete this.base[id]
      }
      return
    }
    this.tombstones.delete(id)
    this.local.set(id, after)
    if (remote && !(id in this.base)) this.base[id] = remote._rev
  }

  /* ------------------------------------------------------------ local layer */

  /** Drop local changes (all, or the given ids) so the remote version shows again. */
  discardLocal(ids) {
    const targets = ids ?? [...new Set([...this.local.keys(), ...this.tombstones])]
    const changes = []
    for (const id of targets) {
      const before = this.get(id)
      this.local.delete(id)
      this.tombstones.delete(id)
      delete this.base[id]
      const after = this.get(id)
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({id, before, after})
    }
    this.#announceExternal(changes, 'sanity-sim.discard')
    return changes
  }

  /** Mark local shadows as forked from the current remote revision ("keep mine"). */
  acceptRemoteBase(ids) {
    for (const id of ids) {
      const remote = this.remote.get(id)
      if (remote) this.base[id] = remote._rev
      else delete this.base[id]
    }
    this.scheduleFlush()
  }

  /**
   * Local documents/tombstones whose remote counterpart changed since they
   * were forked: the remote `_rev` no longer equals the recorded base.
   */
  staleEntries() {
    const out = []
    for (const [id, baseRev] of Object.entries(this.base)) {
      const remote = this.remote.get(id)
      const remoteRev = remote?._rev ?? null
      if (remoteRev !== baseRev) {
        out.push({id, baseRev, remoteRev, local: this.tombstones.has(id) ? null : (this.local.get(id) ?? null), remote: remote ?? null})
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /** Replace the remote snapshot (a sync). Never touches the local layer. */
  replaceRemote(documents, meta) {
    const before = new Map(this.documents().map((doc) => [doc._id, doc]))
    this.remote = new Map(documents.map((doc) => [doc._id, doc]))
    this.remoteMeta = meta
    const after = new Map(this.documents().map((doc) => [doc._id, doc]))
    const changes = []
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(id) ?? null
      const a = after.get(id) ?? null
      if (b?._rev !== a?._rev || (b === null) !== (a === null)) changes.push({id, before: b, after: a})
    }
    if (this.persist) {
      writeNdjsonAtomic(this.file('remote.ndjson'), [...this.remote.values()].sort(byId))
      writeJsonAtomic(this.file('remote.json'), meta)
    }
    this.#announceExternal(changes, 'sanity-sim.sync')
    return changes
  }

  /** Apply one remote document change (follow mode). */
  applyRemoteChange(id, doc) {
    const before = this.get(id)
    if (doc === null) this.remote.delete(id)
    else this.remote.set(id, doc)
    const after = this.get(id)
    this.remoteDirty = true
    this.scheduleFlush()
    if (JSON.stringify(before) !== JSON.stringify(after)) this.#announceExternal([{id, before, after}], 'sanity-sim.follow')
  }

  /** Wipe everything: local layer, tombstones, history, and (optionally) the remote snapshot. */
  reset({keepRemote = true} = {}) {
    const before = this.documents()
    this.local.clear()
    this.tombstones.clear()
    this.base = {}
    this.transactions = []
    if (!keepRemote) {
      this.remote.clear()
      this.remoteMeta = null
    }
    if (this.persist) {
      fs.rmSync(this.file('transactions.ndjson'), {force: true})
      if (!keepRemote) {
        fs.rmSync(this.file('remote.ndjson'), {force: true})
        fs.rmSync(this.file('remote.json'), {force: true})
      }
    }
    const afterIds = new Set(this.documents().map((doc) => doc._id))
    const changes = before.map((doc) => ({id: doc._id, before: doc, after: afterIds.has(doc._id) ? this.get(doc._id) : null}))
    this.flush()
    this.#announceExternal(changes, 'sanity-sim.reset')
  }

  /** Changes made outside a mutation still have to reach listeners. */
  #announceExternal(changes, author) {
    if (changes.length === 0) return
    this.scheduleFlush()
    this.emit('transaction', {
      transactionId: `${author}-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      author,
      mutations: changes.map(({id, after}) => (after === null ? {delete: {id}} : {createOrReplace: after})),
      changes,
      external: true,
    })
  }

  /* ------------------------------------------------------------ history */

  /** Transactions touching any of `ids` (or all), oldest first. */
  transactionsFor(ids, {fromTime, toTime, fromTransaction, toTransaction, reverse, limit} = {}) {
    const wanted = ids && ids.length > 0 ? new Set(ids) : null
    let list = this.transactions.filter((tx) => !wanted || tx.documentIDs.some((id) => wanted.has(id)))
    if (fromTransaction) {
      const index = list.findIndex((tx) => tx.id === fromTransaction)
      if (index !== -1) list = list.slice(index)
    }
    if (toTransaction) {
      const index = list.findIndex((tx) => tx.id === toTransaction)
      if (index !== -1) list = list.slice(0, index + 1)
    }
    if (fromTime) list = list.filter((tx) => tx.timestamp >= fromTime)
    if (toTime) list = list.filter((tx) => tx.timestamp <= toTime)
    if (reverse) list = [...list].reverse()
    if (limit) list = list.slice(0, limit)
    return list
  }

  /** A document as of a revision or a point in time. */
  revisionOf(id, {revision, time}) {
    const remote = this.remote.get(id) ?? null
    if (revision !== undefined) {
      const tx = this.transactions.find((entry) => entry.id === revision && entry.effects[id])
      if (tx) return tx.effects[id].apply[1]
      if (remote && remote._rev === revision) return remote
      return null
    }
    if (time !== undefined) {
      let doc = remote && (!remote._updatedAt || remote._updatedAt <= time) ? remote : null
      for (const tx of this.transactions) {
        if (tx.timestamp > time) break
        if (tx.effects[id]) doc = tx.effects[id].apply[1]
      }
      return doc
    }
    return this.get(id)
  }

  /* ------------------------------------------------------------ persistence */

  scheduleFlush() {
    if (!this.persist || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 40)
    this.flushTimer.unref?.()
  }

  flush() {
    if (!this.persist) return
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    fs.mkdirSync(this.dir, {recursive: true})
    writeNdjsonAtomic(this.file('local.ndjson'), [...this.local.values()].sort(byId))
    writeJsonAtomic(this.file('tombstones.json'), [...this.tombstones].sort())
    writeJsonAtomic(this.file('base.json'), sortedObject(this.base))
    if (this.remoteDirty) {
      this.remoteDirty = false
      writeNdjsonAtomic(this.file('remote.ndjson'), [...this.remote.values()].sort(byId))
    }
  }
}

function applyOne(mutation, existing, transactionId, timestamp, autoKeys) {
  const result = new Mutation({mutations: [mutation], transactionId, resultRev: transactionId, timestamp}).apply(
    existing ? structuredClone(existing) : null,
  )
  if (result && autoKeys) addMissingKeys(result)
  return result
}

function addMissingKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item) && item._key === undefined) {
        item._key = randomBytes(6).toString('hex')
      }
      addMissingKeys(item)
    }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) addMissingKeys(child)
  }
}

function singleKey(mutation) {
  if (!mutation || typeof mutation !== 'object') throw badRequest('a mutation must be an object')
  const keys = Object.keys(mutation)
  if (keys.length !== 1) throw badRequest(`a mutation must have exactly one key, got ${JSON.stringify(keys)}`)
  return [keys[0], mutation[keys[0]] ?? {}]
}

/** `undefined` → uuid; `drafts.` (trailing dot) → `drafts.<uuid>`, as Content Lake does. */
function generatedId(id) {
  if (id === undefined || id === null || id === '') return randomUUID()
  if (typeof id === 'string' && id.endsWith('.')) return id + randomUUID()
  return id
}

async function expandOrThrow(expandQuery, body) {
  if (typeof body.query !== 'string') throw badRequest('a patch or delete needs `id` or `query`')
  if (!expandQuery) throw badRequest('query-based mutations are not available here')
  return expandQuery(body.query, body.params ?? {})
}

const byId = (a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)))
}
