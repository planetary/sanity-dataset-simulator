import {randomUUID} from 'node:crypto'
import {isVersionId} from './ids.js'
import {compileFilter, syncTagFor} from './groq.js'

const KEEPALIVE_MS = 15_000
const RESUME_BUFFER = 2_000

/**
 * The Listen API (`GET /data/listen/<ds>`, SSE) for every dataset.
 *
 * Per Content Lake: each listener gets only events for documents matching its
 * filter, with `transition` computed from before/after (appear, update,
 * disappear), the transaction's `mutations`, `previousRev`/`resultRev`, the
 * result document (`includeResult`, default on), the previous one
 * (`includePreviousRevision`), and mendoza `effects` when asked for.
 * `enableResume` + `Last-Event-ID` replays missed events (`welcomeback`) or
 * says it cannot (`reset`).
 */
export class ListenHub {
  constructor() {
    this.listeners = new Set()
    this.history = new Map()
    this.attached = new WeakSet()
  }

  attach(dataset) {
    if (this.attached.has(dataset)) return
    this.attached.add(dataset)
    const buffer = []
    this.history.set(dataset.name, buffer)
    dataset.on('transaction', (tx) => {
      buffer.push(tx)
      if (buffer.length > RESUME_BUFFER) buffer.shift()
      for (const listener of this.listeners) {
        if (listener.dataset === dataset.name) listener.enqueue(tx)
      }
    })
  }

  open({req, res, dataset, via = dataset.name, query, params, options, lastEventId}) {
    const filter = compileFilter(query, params)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      ...(req.httpVersionMajor === 1 ? {connection: 'keep-alive'} : {}),
      'x-accel-buffering': 'no',
    })
    const listener = new Listener({res, dataset: dataset.name, via, filter, options})
    this.listeners.add(listener)
    const close = () => {
      this.listeners.delete(listener)
      listener.close()
    }
    res.on('close', close)
    req.on?.('close', close)

    if (options.enableResume && lastEventId) {
      const txId = lastEventId.split('#')[0]
      const buffer = this.history.get(dataset.name) ?? []
      const index = buffer.findIndex((tx) => tx.transactionId === txId)
      if (index === -1) {
        listener.send('reset', {listenerName: listener.name})
        res.end()
        return listener
      }
      listener.send('welcomeback', {listenerName: listener.name})
      for (const tx of buffer.slice(index + 1)) listener.enqueue(tx)
    } else {
      listener.send('welcome', {listenerName: listener.name})
    }
    return listener
  }

  /**
   * End every listener opened through `via` (a dataset name or link). Clients
   * reconnect, get a fresh `welcome`, and refetch from whatever it names now.
   */
  disconnect(via) {
    for (const listener of this.listeners) {
      if (listener.via !== via) continue
      this.listeners.delete(listener)
      listener.close()
      listener.res.end()
    }
  }

  get count() {
    return this.listeners.size
  }
}

class Listener {
  constructor({res, dataset, via, filter, options}) {
    this.res = res
    this.dataset = dataset
    this.via = via
    this.filter = filter
    this.options = options
    this.name = `sim-${randomUUID().slice(0, 12)}`
    this.chain = Promise.resolve()
    this.keepalive = setInterval(() => this.comment(''), KEEPALIVE_MS)
    this.keepalive.unref?.()
  }

  close() {
    clearInterval(this.keepalive)
  }

  comment(text) {
    if (!this.res.writableEnded && !this.res.destroyed) this.res.write(`: ${text}\n\n`)
  }

  send(event, data, id) {
    if (this.res.writableEnded || this.res.destroyed) return
    this.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /** Events are evaluated asynchronously but always delivered in commit order. */
  enqueue(tx) {
    this.chain = this.chain.then(() => this.deliver(tx)).catch(() => {})
  }

  async deliver(tx) {
    const {options} = this
    const events = []
    for (const change of tx.changes) {
      if (!options.includeAllVersions && isVersionId(change.id)) continue
      const [before, after] = await Promise.all([this.filter(change.before), this.filter(change.after)])
      if (!before && !after) continue
      events.push({change, transition: before && after ? 'update' : after ? 'appear' : 'disappear'})
    }
    events.forEach(({change, transition}, index) => {
      const eventId = `${tx.transactionId}#${change.id}`
      const payload = {
        eventId,
        documentId: change.id,
        transactionId: tx.transactionId,
        transition,
        identity: tx.author,
        previousRev: change.before?._rev,
        resultRev: change.after?._rev ?? tx.transactionId,
        timestamp: tx.timestamp,
        visibility: options.visibility === 'transaction' ? 'transaction' : 'query',
        transactionTotalEvents: events.length,
        transactionCurrentEvent: index + 1,
      }
      if (options.includeMutations !== false) payload.mutations = tx.mutations
      if (options.includeResult !== false && change.after) payload.result = change.after
      if (options.includePreviousRevision && change.before) payload.previous = change.before
      if (options.effectFormat === 'mendoza') payload.effects = {apply: [0, change.after], revert: [0, change.before]}
      this.send('mutation', payload, options.enableResume ? eventId : undefined)
    })
  }
}

/**
 * The Live Content API (`GET /data/live/events/<ds>`): sync-tag invalidation
 * messages, not documents. Clients without `includeDrafts` only hear about
 * changes that touched published documents.
 */
export class LiveHub {
  constructor() {
    this.clients = new Set()
    this.attached = new WeakSet()
    this.sequence = 0
  }

  attach(dataset) {
    if (this.attached.has(dataset)) return
    this.attached.add(dataset)
    dataset.on('transaction', (tx) => {
      const touchesPublished = tx.changes.some((change) => !change.id.startsWith('drafts.') && !isVersionId(change.id))
      const id = `${Date.now().toString(36)}-${(this.sequence += 1)}`
      const tags = [syncTagFor(dataset.name)]
      for (const client of this.clients) {
        if (client.dataset !== dataset.name) continue
        if (!touchesPublished && !client.includeDrafts) continue
        write(client.res, 'message', {id, tags}, id)
      }
    })
  }

  open({req, res, dataset, via = dataset.name, includeDrafts}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      ...(req.httpVersionMajor === 1 ? {connection: 'keep-alive'} : {}),
    })
    const client = {res, dataset: dataset.name, via, includeDrafts}
    this.clients.add(client)
    write(res, 'welcome', {})
    const keepalive = setInterval(() => !res.writableEnded && res.write(': keepalive\n\n'), 30_000)
    keepalive.unref?.()
    res.on('close', () => {
      clearInterval(keepalive)
      this.clients.delete(client)
    })
  }

  /** Invalidate `tags` for clients connected through `via`, then end their streams so they reconnect. */
  disconnect(via, tags) {
    const id = `${Date.now().toString(36)}-${(this.sequence += 1)}`
    for (const client of this.clients) {
      if (client.via !== via) continue
      write(client.res, 'message', {id, tags: [...new Set(tags)]}, id)
      this.clients.delete(client)
      client.res.end()
    }
  }

  get count() {
    return this.clients.size
  }
}

function write(res, event, data, id) {
  if (res.writableEnded || res.destroyed) return
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
