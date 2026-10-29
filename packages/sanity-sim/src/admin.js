import {SimError, badRequest, notFound} from './errors.js'
import {getPublishedId, isDraftId, isVersionId} from './ids.js'
import {fetchRemoteRevision, findToken, followDataset, mergeDocuments, syncDataset} from './sync.js'
import {isCaTrusted} from './tls.js'
import {readExport} from './transfer.js'

/**
 * The dashboard's API (`/_sim/*`). Same origin policy as the data plane:
 * loopback only. Document writes go through the dataset like any other
 * mutation, so Studio and apps see dashboard edits live.
 */
export async function handleAdmin(context, req, res, url) {
  const {sim} = context
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
  const method = req.method
  const [area, name, sub, id, action] = parts

  if (area === 'status' && method === 'GET') return send(res, status(context))
  if (area === 'requests' && method === 'GET') return send(res, sim.requests.slice(-Number(url.searchParams.get('limit') ?? 300)))
  if (area === 'events' && method === 'GET') return events(context, req, res)

  if (area === 'links') {
    if (name === undefined && method === 'GET') return send(res, sim.links())
    if (name !== undefined && method === 'PUT') return send(res, sim.link(name, (await readBody(req)).target))
    if (name !== undefined && method === 'DELETE') return send(res, sim.unlink(name))
  }

  if (area === 'datasets') {
    if (name === undefined) {
      if (method === 'GET') return send(res, sim.datasetNames().map((n) => summary(sim.dataset(n), sim)))
      if (method === 'POST') {
        const body = await readBody(req)
        const created = sim.dataset(String(body.name ?? ''))
        if (!created) throw badRequest('dataset names are lowercase letters, digits, "-" and "_" (max 64)')
        return send(res, summary(created, sim))
      }
    }
    const dataset = sim.dataset(name, {create: false})
    if (!dataset) throw notFound(`no dataset "${name}"`)

    if (sub === undefined && method === 'DELETE') {
      sim.deleteDataset(name)
      return send(res, {deleted: name})
    }
    switch (sub) {
      case 'types':
        return send(res, typeCounts(dataset))
      case 'documents':
        if (id === undefined) return send(res, listDocuments(dataset, url.searchParams))
        if (action === 'revert' && method === 'POST') return send(res, {changes: dataset.discardLocal([id]).length})
        if (method === 'GET') return send(res, documentDetail(dataset, id))
        if (method === 'PUT') {
          const doc = await readBody(req)
          if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw badRequest('send the document as a JSON object')
          if (typeof doc._type !== 'string' || !doc._type) throw badRequest('a document needs a `_type`')
          const {_rev, _updatedAt, _createdAt, ...rest} = doc
          const ifRevisionID = url.searchParams.get('ifRevisionID')
          const current = dataset.get(id)
          if (ifRevisionID && current && current._rev !== ifRevisionID) {
            throw new SimError(409, 'conflictError', `"${id}" changed since you opened it (now ${current._rev}); reload to see the latest version`)
          }
          await dataset.commit([{createOrReplace: {...rest, _id: id, ...(current?._createdAt ? {_createdAt: current._createdAt} : {})}}], {author: 'dashboard'})
          return send(res, documentDetail(dataset, id))
        }
        if (method === 'DELETE') {
          await dataset.commit([{delete: {id}}], {author: 'dashboard'})
          return send(res, {deleted: id})
        }
        break
      case 'local-changes':
        return send(res, localChanges(dataset))
      case 'stale':
        if (method === 'POST' && id) return send(res, await resolveStale(context, dataset, id, (await readBody(req)).action))
        return send(res, dataset.staleEntries())
      case 'sync':
        if (method === 'POST') return send(res, await sync(context, dataset, await readBody(req)))
        return send(res, {remote: dataset.remoteMeta, following: sim.followers?.has(dataset.name) ?? false, source: syncSourceFor(context, dataset)})
      case 'follow': {
        const body = await readBody(req)
        return send(res, follow(context, dataset, Boolean(body.enabled)))
      }
      case 'export':
        res.writeHead(200, {'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="${dataset.name}.ndjson"`})
        res.end(dataset.documents().map((doc) => JSON.stringify(doc)).join('\n') + '\n')
        return
      case 'import': {
        const bytes = await readRaw(req)
        const temp = await import('node:os').then((os) => `${os.tmpdir()}/sanity-sim-import-${Date.now()}`)
        const fs = await import('node:fs')
        fs.writeFileSync(temp, bytes)
        try {
          const {documents, assets} = readExport(temp)
          for (const asset of assets) {
            const match = asset.name.match(/([a-f0-9]{40})(?:-\d+x\d+)?\.([a-z0-9]+)$/i)
            if (match) sim.assets.cache(match[1], match[2], asset.bytes)
          }
          for (let i = 0; i < documents.length; i += 500) {
            await dataset.commit(documents.slice(i, i + 500).map(({_sanityAsset, ...doc}) => ({createOrReplace: doc})), {author: 'dashboard.import'})
          }
          return send(res, {documents: documents.length, assets: assets.length})
        } finally {
          fs.rmSync(temp, {force: true})
        }
      }
      case 'reset': {
        const body = await readBody(req)
        if (body.all) dataset.reset({keepRemote: false})
        else dataset.discardLocal()
        dataset.flush()
        return send(res, summary(dataset, sim))
      }
      case 'history':
        return send(res, dataset.transactionsFor(id ? [id] : [], {reverse: true, limit: Number(url.searchParams.get('limit') ?? 100)}).map(txSummary))
    }
  }
  throw notFound(`no dashboard route ${method} ${url.pathname}`)
}

/* ------------------------------------------------------------------ views */

function status(context) {
  const {sim} = context
  return {
    projectId: sim.projectId,
    /* Every project in the folder; the dashboard scopes its calls with ?project=. */
    projects: sim.projects.all().map((project) => ({projectId: project.projectId, main: !project.primary, datasets: project.datasetNames().length})),
    root: sim.root,
    defaultDataset: sim.config.defaultDataset,
    datasets: sim.datasetNames().map((name) => summary(sim.dataset(name), sim)),
    links: sim.links(),
    server: {port: context.port, https: context.tls, publicBase: context.publicBase, httpBase: `http://localhost:${context.port}`},
    certificateTrusted: context.tls ? isCaTrusted() : null,
    listeners: sim.listen.count,
    liveClients: sim.live.count,
    clients: [...sim.clients.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),
    unsupported: [...sim.unsupported.entries()].map(([route, count]) => ({route, count})),
    project: context.project
      ? {studioConfig: context.project.studioConfig, frameworks: context.project.frameworks, devTargets: context.project.devTargets, detectedProjectId: context.project.projectId, token: context.project.token?.key ?? null}
      : null,
    wired: context.wired ?? [],
  }
}

function summary(dataset, sim) {
  return {
    name: dataset.name,
    linkedFrom: sim.links().filter((link) => link.target === dataset.name).map((link) => link.name),
    documents: dataset.size,
    local: dataset.local.size,
    deletedLocally: dataset.tombstones.size,
    remote: dataset.remote.size,
    synced: dataset.remoteMeta,
    stale: dataset.remoteMeta ? dataset.staleEntries().length : 0,
    transactions: dataset.transactions.length,
  }
}

function typeCounts(dataset) {
  const counts = new Map()
  for (const doc of dataset.documents()) {
    const entry = counts.get(doc._type) ?? {type: doc._type, total: 0, drafts: 0, versions: 0, local: 0}
    entry.total += 1
    if (isDraftId(doc._id)) entry.drafts += 1
    if (isVersionId(doc._id)) entry.versions += 1
    if (dataset.local.has(doc._id)) entry.local += 1
    counts.set(doc._type, entry)
  }
  return [...counts.values()].sort((a, b) => a.type.localeCompare(b.type))
}

const TITLE_FIELDS = ['title', 'name', 'heading', 'label', 'headline', 'originalFilename']

export function titleOf(doc) {
  for (const field of TITLE_FIELDS) {
    const value = doc[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  if (typeof doc.slug?.current === 'string') return doc.slug.current
  return null
}

function listDocuments(dataset, params) {
  const type = params.get('type')
  const q = params.get('q')?.toLowerCase()
  const layer = params.get('layer')
  const limit = Math.min(Number(params.get('limit') ?? 200), 2000)
  const offset = Number(params.get('offset') ?? 0)
  const stale = new Set(dataset.remoteMeta ? dataset.staleEntries().map((entry) => entry.id) : [])
  let docs = dataset.documents()
  if (type) docs = docs.filter((doc) => doc._type === type)
  if (layer === 'local') docs = docs.filter((doc) => dataset.local.has(doc._id))
  if (q) docs = docs.filter((doc) => doc._id.toLowerCase().includes(q) || JSON.stringify(doc).toLowerCase().includes(q))
  docs.sort((a, b) => String(b._updatedAt ?? '').localeCompare(String(a._updatedAt ?? '')))
  return {
    total: docs.length,
    documents: docs.slice(offset, offset + limit).map((doc) => ({
      _id: doc._id,
      _type: doc._type,
      _updatedAt: doc._updatedAt,
      title: titleOf(doc),
      layer: dataset.layerOf(doc._id),
      stale: stale.has(doc._id),
    })),
  }
}

function documentDetail(dataset, id) {
  const document = dataset.get(id)
  const publishedId = getPublishedId(id)
  const siblings = dataset
    .documents()
    .filter((doc) => getPublishedId(doc._id) === publishedId && doc._id !== id)
    .map((doc) => ({_id: doc._id, layer: dataset.layerOf(doc._id)}))
  return {
    id,
    document,
    layer: dataset.layerOf(id),
    remote: dataset.remote.get(id) ?? null,
    baseRev: dataset.base[id] ?? null,
    stale: dataset.remoteMeta ? dataset.staleEntries().some((entry) => entry.id === id) : false,
    siblings,
    history: dataset.transactionsFor([id], {reverse: true, limit: 50}).map((tx) => ({...txSummary(tx), document: tx.effects[id]?.apply?.[1] ?? null})),
  }
}

function localChanges(dataset) {
  const out = []
  for (const [id, doc] of dataset.local) {
    out.push({id, type: doc._type, title: titleOf(doc), change: dataset.remote.has(id) ? 'modified' : 'added', updatedAt: doc._updatedAt})
  }
  for (const id of dataset.tombstones) {
    const remote = dataset.remote.get(id)
    out.push({id, type: remote?._type ?? null, title: remote ? titleOf(remote) : null, change: 'deleted'})
  }
  const stale = new Set(dataset.remoteMeta ? dataset.staleEntries().map((entry) => entry.id) : [])
  return out.map((entry) => ({...entry, stale: stale.has(entry.id)})).sort((a, b) => a.id.localeCompare(b.id))
}

function txSummary(tx) {
  return {id: tx.id, timestamp: tx.timestamp, author: tx.author, documentIDs: tx.documentIDs, mutations: tx.mutations?.length ?? 0}
}

/* ------------------------------------------------------------------ sync */

function syncSourceFor(context, dataset) {
  const configured = context.sim.config.sync?.[dataset.name]
  const projectId = configured?.projectId ?? context.project?.projectId ?? context.sim.projectId
  if (!projectId || projectId === 'simlocal') return null
  const token = findToken(context.project)
  return {projectId, dataset: configured?.dataset ?? context.project?.dataset ?? dataset.name, credentials: token?.source ?? null, types: configured?.types ?? null}
}

async function sync(context, dataset, body) {
  const source = syncSourceFor(context, dataset)
  const projectId = body.projectId ?? source?.projectId
  if (!projectId) throw badRequest('no source project: pass {projectId, dataset} or start sanity-sim in a folder with a Sanity config')
  const result = await syncDataset(context.sim, dataset.name, {
    projectId,
    dataset: body.dataset ?? source?.dataset ?? dataset.name,
    token: findToken(context.project),
    types: Array.isArray(body.types) && body.types.length ? body.types : undefined,
  })
  return result
}

function follow(context, dataset, enabled) {
  const {sim} = context
  sim.followers ??= new Map()
  if (!enabled) {
    sim.followers.get(dataset.name)?.()
    sim.followers.delete(dataset.name)
    return {following: false}
  }
  if (sim.followers.has(dataset.name)) return {following: true}
  const source = syncSourceFor(context, dataset)
  if (!source) throw badRequest('nothing to follow: sync from a project first')
  sim.followers.set(dataset.name, followDataset(sim, dataset.name, {...source, token: findToken(context.project), log: sim.log}))
  return {following: true}
}

async function resolveStale(context, dataset, id, action) {
  const entry = dataset.staleEntries().find((candidate) => candidate.id === id)
  if (!entry) throw notFound(`"${id}" is not stale`)
  if (action === 'keep') {
    dataset.acceptRemoteBase([id])
    return {resolved: 'keep'}
  }
  if (action === 'take') {
    dataset.discardLocal([id])
    return {resolved: 'take'}
  }
  if (action === 'merge') {
    if (!entry.local || !entry.remote) throw badRequest('merge needs both a local and a remote version; choose keep or take')
    const source = syncSourceFor(context, dataset)
    const ancestor = source ? await fetchRemoteRevision({...source, token: findToken(context.project)}, id, entry.baseRev).catch(() => null) : null
    const {merged, conflicts} = mergeDocuments(ancestor, entry.local, entry.remote)
    await dataset.commit([{createOrReplace: merged}], {author: 'dashboard.merge'})
    dataset.acceptRemoteBase([id])
    return {resolved: 'merge', conflicts, ancestorFound: Boolean(ancestor)}
  }
  throw badRequest('action must be keep, take or merge')
}

/* ------------------------------------------------------------------ live events for the dashboard */

function events(context, req, res) {
  const {sim} = context
  res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...(req.httpVersionMajor === 1 ? {connection: 'keep-alive'} : {})})
  res.write(': connected\n\n')
  const listeners = []
  for (const name of sim.datasetNames()) {
    const dataset = sim.dataset(name)
    const onTx = (tx) => {
      if (res.writableEnded) return
      res.write(`event: transaction\ndata: ${JSON.stringify({dataset: dataset.name, id: tx.transactionId, timestamp: tx.timestamp, author: tx.author, documentIDs: tx.changes.map((change) => change.id)})}\n\n`)
    }
    dataset.on('transaction', onTx)
    listeners.push(() => dataset.off('transaction', onTx))
  }
  /* Links changed (from the dashboard or `sanity-sim link`): the dashboard reloads its view and reconnects. */
  const onLinks = () => !res.writableEnded && res.write(`event: links\ndata: ${JSON.stringify(sim.links())}\n\n`)
  sim.linkListeners.add(onLinks)
  const onRequest = (entry) => !res.writableEnded && res.write(`event: request\ndata: ${JSON.stringify(entry)}\n\n`)
  sim.requestListeners ??= new Set()
  sim.requestListeners.add(onRequest)
  const keepalive = setInterval(() => !res.writableEnded && res.write(': keepalive\n\n'), 20_000)
  keepalive.unref?.()
  res.on('close', () => {
    clearInterval(keepalive)
    for (const off of listeners) off()
    sim.requestListeners.delete(onRequest)
    sim.linkListeners.delete(onLinks)
  })
}

/* ------------------------------------------------------------------ io */

function send(res, body) {
  res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(body))
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readBody(req) {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw badRequest('the request body is not valid JSON')
  }
}
