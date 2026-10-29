import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import {createSecureContext} from 'node:tls'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {compileActions} from './actions.js'
import {mimeForExtension, transformImage} from './assets.js'
import {SimError, badRequest, notFound, notImplemented} from './errors.js'
import {idsForQuery, paramsFromSearch, runQuery} from './groq.js'
import {getPublishedId, isVersionId} from './ids.js'
import {CDN_PERSPECTIVES, PerspectiveError, normalizeApiVersion, parsePerspective} from './perspective.js'
import {handleAdmin} from './admin.js'
import {documentEvents} from './events.js'
import {LOCAL_USER, DOCUMENT_GRANTS, journeyAnswer, projectDocument, datasetDocument, roleGrants} from './meta.js'
import {acceptWebSocket} from './websocket.js'

const DASHBOARD_DIR = fileURLToPath(new URL('../dashboard/', import.meta.url))
const MAX_JSON_BODY = 32 * 1024 * 1024
const MAX_ASSET_BODY = 512 * 1024 * 1024
/**
 * Project features Studio gates UI on (`FEATURES` in sanity/lib). Content
 * releases and scheduled drafts (`singleDocRelease`) are on; comments and
 * tasks need add-on datasets the simulator does not create.
 */
const PROJECT_FEATURES = ['contentReleases', 'singleDocRelease']
const VERSIONED = /^\/v(\d{4}-\d{2}-\d{2}|X|x|1)(\/.*)?$/

/**
 * Start the simulator's HTTP server.
 *
 * One port speaks both HTTP/1.1 (plain) and HTTP/2 over TLS: the first byte of
 * each connection decides (0x16 is a TLS ClientHello). Browsers use
 * `https://localhost:<port>` (HTTP/2, which Studio needs); Node clients and
 * curl can use `http://localhost:<port>` with no certificate involved.
 *
 * @returns {Promise<{port: number, close: () => Promise<void>, origin: string, httpOrigin: string}>}
 */
export async function startServer(sim, {port = 3939, host = '127.0.0.1', tls = null, extraOrigins = [], project = null}) {
  const allowedOrigins = new Set(extraOrigins)
  const context = {sim, allowedOrigins, tls: Boolean(tls), port, project, wired: []}
  const handler = (req, res) => handle(context, req, res)

  const plain = http.createServer(handler)
  plain.keepAliveTimeout = 65_000
  plain.on('upgrade', (req, socket, head) => upgrade(context, req, socket, head))
  /* SNI picks the certificate: localhost names get the browser leaf; Sanity's
   * API hostnames (reached only via sanity-sim/register's TLS redirect) get the
   * Node-only intercept leaf. */
  const interceptContext = tls?.intercept ? createSecureContext(tls.intercept) : null
  const secure = tls
    ? http2.createSecureServer(
        {
          key: tls.key,
          cert: tls.cert,
          allowHTTP1: true,
          SNICallback: (servername, callback) => callback(null, interceptContext && /(^|\.)sanity\.io$/.test(servername) ? interceptContext : null),
        },
        handler,
      )
    : null
  secure?.on('upgrade', (req, socket, head) => upgrade(context, req, socket, head))
  secure?.on('sessionError', () => {})

  const sockets = new Set()
  const onConnection = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('readable', () => {
      const first = socket.read(1)
      if (first === null) return
      socket.unshift(first)
      if (first[0] === 0x16 && secure) secure.emit('connection', socket)
      else plain.emit('connection', socket)
    })
  }

  const servers = []
  const listenOn = (bindHost, bindPort) =>
    new Promise((resolve, reject) => {
      const server = net.createServer(onConnection)
      server.once('error', reject)
      server.listen(bindPort, bindHost, () => {
        servers.push(server)
        resolve(server.address().port)
      })
    })

  const actualPort = await listenOn(host, port)
  context.port = actualPort
  if (host === '127.0.0.1') await listenOn('::1', actualPort).catch(() => {})

  const scheme = tls ? 'https' : 'http'
  context.publicBase = `${scheme}://localhost:${actualPort}`
  return {
    port: actualPort,
    origin: context.publicBase,
    httpOrigin: `http://localhost:${actualPort}`,
    context,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))))
    },
  }
}

/* ================================================================ request handling */

async function handle(context, req, res) {
  const started = performance.now()
  const url = new URL(req.url, 'http://localhost')
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    route: routeKey(url.pathname),
    tag: url.searchParams.get('tag') ?? undefined,
    perspective: url.searchParams.get('perspective') ?? undefined,
    apiVersion: url.pathname.match(VERSIONED)?.[1],
    client: clientOf(req, url),
    protocol: req.httpVersion,
  }
  res.on('close', () => {
    entry.status = res.statusCode
    entry.ms = Math.round(performance.now() - started)
    if (res.statusCode === 501) entry.unsupported = true
    if (!url.pathname.startsWith('/_sim/') && !isStatic(url.pathname)) context.sim.record(entry)
  })

  try {
    if (!cors(context, req, res)) return
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    await route(context, req, res, url)
  } catch (error) {
    sendError(res, error, context.sim)
  }
}

/** CORS: any loopback origin (the dev servers on this machine) or one named with --origin. */
function cors(context, req, res) {
  const origin = req.headers.origin
  if (!origin) return true
  const granted = context.allowedOrigins.has(origin) || isLoopbackOrigin(origin)
  if (granted) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'Origin')
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*')
      res.setHeader('access-control-max-age', '600')
      if (req.headers['access-control-request-private-network']) res.setHeader('access-control-allow-private-network', 'true')
    }
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 403, {error: {type: 'forbidden', description: `sanity-sim only accepts writes from loopback origins (got ${origin}). Pass --origin ${origin} to allow it.`}})
    return false
  }
  return true
}

export function isLoopbackOrigin(origin) {
  try {
    const {hostname, protocol} = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    const host = hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

async function route(context, req, res, url) {
  const {pathname} = url
  if (pathname.startsWith('/_sim/')) return handleAdmin(context, req, res, url)
  if (pathname.startsWith('/images/') || pathname.startsWith('/files/')) return serveAsset(context, req, res, url)
  const versioned = pathname.match(VERSIONED)
  if (!versioned) return serveDashboard(res, pathname)

  const apiVersion = normalizeApiVersion(versioned[1])
  const segments = (versioned[2] ?? '/').split('/').filter(Boolean).map(safeDecode)
  const [head, ...rest] = segments
  const method = req.method

  switch (head) {
    case 'ping':
      return json(res, 200, 'PONG')
    case 'users':
      return users(context, req, res, rest)
    case 'auth':
      return json(res, 200, rest[0] === 'providers' ? {providers: [], thirdPartyLogin: false, sso: {saml: false}} : {})
    case 'projects':
      return projects(context, req, res, url, rest, apiVersion)
    case 'datasets':
      return json(res, 200, context.sim.visibleDatasetNames().map((name) => datasetDocument(context.sim, name)))
    case 'data':
      return data(context, req, res, url, rest, apiVersion)
    case 'assets':
      if (method !== 'POST') throw notImplemented(`${method} /assets`)
      return uploadAsset(context, req, res, url, rest)
    case 'socket':
      throw notImplemented('the realtime socket without a WebSocket upgrade')
    case 'journey':
      return json(res, 200, journeyAnswer(rest[0]))
    case 'features':
      return json(res, 200, PROJECT_FEATURES)
    case 'help':
    case 'schedules':
      return json(res, 200, [])
    case 'intake':
      return json(res, 200, method === 'GET' ? {status: 'denied', reason: 'sanity-sim sends no telemetry'} : {})
    case 'access':
      return access(context, res, rest)
    case 'subscriptions':
      /* Studio reads `plan.name` (labels) and retention for the releases archive notice. */
      return json(res, 200, {id: 'sanity-sim', projectId: context.sim.projectId, plan: {id: 'sanity-sim', name: 'Local (sanity-sim)', planTypeId: 'local'}, resources: {}, featureTypes: {}})
    default:
      throw notImplemented(`${method} ${pathname.replace(VERSIONED, '/v…$2')}`)
  }
}

/* ================================================================ identity & project */

async function users(context, req, res, rest) {
  if (rest[0] !== 'me' && rest[0] !== undefined) return json(res, 200, LOCAL_USER)
  if (rest[1] === undefined) return json(res, 200, LOCAL_USER)
  if (rest[1] === 'keyvalue') {
    if (req.method === 'GET') {
      const keys = String(rest[2] ?? '').split(',').filter(Boolean)
      return json(res, 200, keys.map((key) => ({key, value: context.sim.keyvalue[key] ?? null})))
    }
    const body = await readJsonBody(req)
    const entries = Array.isArray(body) ? body : [body]
    context.sim.setKeyValue(entries.filter((entry) => entry && typeof entry.key === 'string'))
    return json(res, 200, entries)
  }
  throw notImplemented(`/users/me/${rest[1]}`)
}

async function projects(context, req, res, url, rest, apiVersion) {
  const {sim} = context
  const [projectId, sub, datasetName, leaf, ...more] = rest
  if (projectId === undefined) return json(res, 200, [projectDocument(sim)])
  if (sub === undefined) return json(res, 200, projectDocument(sim))
  switch (sub) {
    case 'grants':
      return json(res, 200, roleGrants())
    case 'user-applications':
      return json(res, 200, [])
    case 'new-content-release-allowed':
      /* Release limits: effectively unlimited locally. Studio reads `data.*`. */
      return json(res, 200, {data: {datasetReleaseLimit: 10_000, orgActiveReleaseLimit: 10_000, orgMeteredActiveReleaseCount: 0}})
    case 'features':
      return json(res, 200, PROJECT_FEATURES)
    case 'users':
      return json(res, 200, datasetName && datasetName.includes(',') ? datasetName.split(',').map(() => LOCAL_USER) : LOCAL_USER)
    case 'datasets': {
      if (datasetName === undefined) {
        /* `?datasetProfile=comments&addonFor=<ds>` asks for add-on datasets; there are none. */
        const profile = url.searchParams.get('datasetProfile')
        if ((profile && profile !== 'content') || url.searchParams.get('addonFor')) return json(res, 200, [])
        return json(res, 200, sim.visibleDatasetNames().map((name) => datasetDocument(sim, name)))
      }
      if (leaf === 'acl') return json(res, 200, DOCUMENT_GRANTS)
      if (leaf === 'live' && more[0] === 'events') return liveEvents(context, req, res, url, datasetName)
      if (req.method === 'PUT') {
        sim.dataset(datasetName)
        return json(res, 200, {datasetName, aclMode: 'public'})
      }
      if (req.method === 'DELETE') {
        sim.deleteDataset(datasetName)
        return json(res, 200, {deleted: true})
      }
      return json(res, 200, datasetDocument(sim, datasetName))
    }
    default:
      throw notImplemented(`/projects/{id}/${sub}`)
  }
}

function access(context, res, rest) {
  /* /access/{project|organization}/{id}/user-permissions/me[/check] */
  if (rest.includes('user-permissions')) {
    if (rest.at(-1) === 'check') return json(res, 200, {granted: true})
    return json(res, 200, [{type: 'sanity.project', name: 'sanity.project', permissions: ['read', 'create', 'update', 'delete']}])
  }
  if (rest.includes('requests')) return json(res, 200, [])
  throw notImplemented(`/access/${rest.join('/')}`)
}

/* ================================================================ data plane */

async function data(context, req, res, url, rest, apiVersion) {
  const {sim} = context
  const [operation, datasetName, ...tail] = rest
  if (operation === 'ping') return json(res, 200, {ok: true})
  if (datasetName === undefined) throw badRequest(`/data/${operation} needs a dataset`)
  if (operation === 'live' && datasetName === 'events') return liveEvents(context, req, res, url, tail[0])
  const dataset = sim.dataset(datasetName)
  if (!dataset) throw notFound(`Dataset "${datasetName}" not found`)

  switch (operation) {
    case 'query':
      return query(context, req, res, url, dataset, apiVersion)
    case 'doc':
      return doc(res, url, dataset, tail)
    case 'mutate':
      return mutate(context, req, res, url, dataset)
    case 'actions':
      return actions(req, res, dataset)
    case 'listen':
      return listen(context, req, res, url, dataset, datasetName)
    case 'history':
      return history(res, url, dataset, tail)
    case 'export':
      return exportDataset(res, url, dataset)
    default:
      throw notImplemented(`/data/${operation}`)
  }
}

async function query(context, req, res, url, dataset, apiVersion) {
  let text
  let params
  let options = url.searchParams
  if (req.method === 'POST') {
    const body = await readJsonBody(req)
    const allowed = new Set(['query', 'params', 'returnQuery', 'perspective', 'resultSourceMap'])
    const unknown = Object.keys(body ?? {}).filter((key) => !allowed.has(key))
    if (unknown.length > 0) throw badRequest(`Unknown body field(s): ${unknown.join(', ')}`)
    text = body.query
    params = body.params ?? {}
    if (body.perspective && !options.get('perspective')) options = new URLSearchParams([...options, ['perspective', body.perspective]])
  } else {
    text = url.searchParams.get('query')
    params = paramsFromSearch(url.searchParams)
  }
  if (typeof text !== 'string' || text.trim() === '') throw new SimError(400, 'queryParseError', 'A `query` is required')
  let perspective
  try {
    perspective = parsePerspective(options.get('perspective'), apiVersion)
  } catch (error) {
    if (error instanceof PerspectiveError) throw badRequest(error.message)
    throw error
  }
  const viaCdn = String(req.headers.host ?? req.headers[':authority'] ?? '').includes('apicdn')
  if (viaCdn && !CDN_PERSPECTIVES.has(perspective.kind)) {
    throw badRequest('The API CDN only serves the `published` and `raw` perspectives; use the live API host')
  }
  const body = await runQuery({
    dataset,
    query: text,
    params,
    perspective,
    projectId: context.sim.projectId,
    returnQuery: options.get('returnQuery') !== 'false',
    resultSourceMap: ['true', 'withKeyArraySelector'].includes(options.get('resultSourceMap') ?? ''),
  })
  res.setHeader('x-sanity-shard', 'sanity-sim')
  return json(res, 200, body)
}

function doc(res, url, dataset, tail) {
  if (url.searchParams.has('perspective')) throw badRequest('The Doc API does not accept a `perspective`')
  const ids = tail.join('/').split(',').map(safeDecode).filter(Boolean)
  if (ids.length === 0) throw badRequest('at least one document id is required')
  const includeAll = url.searchParams.get('includeAllVersions') === 'true'
  const excludeContent = url.searchParams.get('excludeContent') === 'true'
  const wanted = new Set(ids)
  if (includeAll) {
    const published = new Set(ids.map(getPublishedId))
    for (const candidate of dataset.documents()) if (published.has(getPublishedId(candidate._id))) wanted.add(candidate._id)
  }
  const documents = []
  const omitted = []
  for (const id of wanted) {
    const found = dataset.get(id)
    if (!found) {
      if (ids.includes(id)) omitted.push({id, reason: 'existence'})
      continue
    }
    documents.push(excludeContent ? pickSystem(found) : found)
  }
  return json(res, 200, {documents, omitted})
}

async function mutate(context, req, res, url, dataset) {
  const body = await readJsonBody(req)
  const options = url.searchParams
  const flag = (name) => options.get(name) === 'true' || body?.[name] === true
  const result = await dataset.commit(body?.mutations, {
    transactionId: body?.transactionId ?? options.get('transactionId') ?? undefined,
    dryRun: flag('dryRun'),
    autoGenerateArrayKeys: flag('autoGenerateArrayKeys'),
    expandQuery: (query, params) => idsForQuery(dataset, query, params, context.sim.projectId),
  })
  const returnDocuments = flag('returnDocuments')
  const latest = new Map(result.changes.map((change) => [change.id, change.after]))
  const out = {
    transactionId: result.transactionId,
    results: result.results.map(({id, operation}) =>
      returnDocuments ? {id, operation, document: latest.get(id) ?? dataset.get(id)} : {id, operation},
    ),
  }
  if (flag('returnIds') || returnDocuments) out.documentIds = [...new Set(result.results.map((entry) => entry.id))]
  return json(res, 200, out)
}

async function actions(req, res, dataset) {
  const body = await readJsonBody(req)
  const result = await dataset.commitWith((ds) => compileActions(body?.actions, ds), {
    transactionId: body?.transactionId,
    dryRun: body?.dryRun === true,
  })
  return json(res, 200, {transactionId: result.transactionId})
}

function listen(context, req, res, url, dataset, requested) {
  const options = url.searchParams
  const text = options.get('query')
  if (!text) throw badRequest('a listener needs a `query`')
  const bool = (name, fallback) => (options.has(name) ? options.get(name) === 'true' : fallback)
  context.sim.listen.open({
    req,
    res,
    dataset,
    via: viaName(requested),
    query: text,
    params: paramsFromSearch(options),
    lastEventId: req.headers['last-event-id'] ?? options.get('lastEventId') ?? undefined,
    options: {
      includeResult: bool('includeResult', true),
      includePreviousRevision: bool('includePreviousRevision', false),
      includeMutations: bool('includeMutations', true),
      includeAllVersions: bool('includeAllVersions', false),
      enableResume: bool('enableResume', false),
      visibility: options.get('visibility') ?? 'query',
      effectFormat: options.get('effectFormat') ?? undefined,
    },
  })
}

function liveEvents(context, req, res, url, datasetName) {
  const dataset = context.sim.dataset(datasetName)
  if (!dataset) throw notFound(`Dataset "${datasetName}" not found`)
  const includeDrafts = url.searchParams.get('includeDrafts') === 'true' || url.searchParams.get('includeAllDocuments') === 'true'
  context.sim.live.open({req, res, dataset, via: viaName(datasetName), includeDrafts})
}

/** The name a client connected through (a link or a dataset), for hot swaps. */
const viaName = (requested) => String(requested).replace(/^~/, '')

function history(res, url, dataset, tail) {
  const [kind, ...rest] = tail
  const options = url.searchParams
  if (kind === 'transactions') {
    const ids = rest.join('/').split(',').map(safeDecode).filter(Boolean)
    const list = dataset.transactionsFor(ids, {
      fromTime: options.get('fromTime') ?? undefined,
      toTime: options.get('toTime') ?? undefined,
      fromTransaction: options.get('fromTransaction') ?? undefined,
      toTransaction: options.get('toTransaction') ?? undefined,
      reverse: options.get('reverse') === 'true',
      limit: options.has('limit') ? Number(options.get('limit')) : undefined,
    })
    const includeIdentifiedOnly = options.get('includeIdentifiedDocumentsOnly') === 'true'
    const wanted = new Set(ids)
    const lines = list.map((tx) => {
      const documentIDs = includeIdentifiedOnly && wanted.size > 0 ? tx.documentIDs.filter((id) => wanted.has(id)) : tx.documentIDs
      const effects = Object.fromEntries(documentIDs.map((id) => [id, tx.effects[id]]).filter(([, effect]) => effect))
      return JSON.stringify({id: tx.id, timestamp: tx.timestamp, author: tx.author, documentIDs, effects})
    })
    res.writeHead(200, {'content-type': 'application/x-ndjson', 'cache-control': 'no-store'})
    res.end(lines.length > 0 ? lines.join('\n') + '\n' : '')
    return
  }
  if (kind === 'events') {
    const ids = (rest[0] === 'documents' ? rest.slice(1) : rest).join('/').split(',').map(safeDecode).filter(Boolean)
    const limit = Number(options.get('limit') ?? 100)
    const events = Object.fromEntries(ids.map((id) => [id, documentEvents(dataset, id, {limit})]))
    return json(res, 200, {events, nextCursor: ''})
  }
  if (kind === 'documents') {
    const ids = rest.join('/').split(',').map(safeDecode).filter(Boolean)
    const revision = options.get('revision') ?? undefined
    const time = options.get('time') ?? undefined
    const documents = ids.map((id) => dataset.revisionOf(id, {revision, time})).filter(Boolean)
    return json(res, 200, {documents})
  }
  throw notImplemented(`/data/history/${kind}`)
}

function exportDataset(res, url, dataset) {
  const types = url.searchParams.get('types')?.split(',').filter(Boolean)
  res.writeHead(200, {'content-type': 'application/x-ndjson', 'cache-control': 'no-store'})
  for (const document of dataset.documents()) {
    if (types && !types.includes(document._type)) continue
    res.write(JSON.stringify(document) + '\n')
  }
  res.end()
}

/* ================================================================ assets */

async function uploadAsset(context, req, res, url, rest) {
  const [kind, datasetName, sub] = rest
  if (kind !== 'images' && kind !== 'files') throw notFound(`unknown asset kind ${kind}`)
  const dataset = context.sim.dataset(datasetName)
  if (!dataset) throw notFound(`Dataset "${datasetName}" not found`)
  let bytes
  let contentType = req.headers['content-type']
  let filename = url.searchParams.get('filename') ?? undefined
  if (sub === 'from-url') {
    const body = await readJsonBody(req)
    const response = await fetch(body.url)
    if (!response.ok) throw badRequest(`could not fetch ${body.url}: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    contentType = response.headers.get('content-type') ?? undefined
    filename = body.filename ?? new URL(body.url).pathname.split('/').pop()
  } else {
    bytes = await readBody(req, MAX_ASSET_BODY)
  }
  if (bytes.length === 0) throw badRequest('the upload is empty')
  const meta = Object.fromEntries(url.searchParams.entries())
  const document = await context.sim.assets.ingest({
    kind,
    bytes,
    contentType,
    filename,
    projectId: context.sim.projectId,
    dataset: dataset.name,
    publicBase: context.publicBase,
    meta,
  })
  const existing = dataset.get(document._id)
  if (existing) return json(res, 200, {document: existing})
  await dataset.commit([{createIfNotExists: document}])
  return json(res, 200, {document: dataset.get(document._id)})
}

const ASSET_PATH = /^\/(images|files)\/([^/]+)\/([^/]+)\/([a-f0-9]{40})(?:-(\d+)x(\d+))?\.([a-z0-9]+)(?:\/.*)?$/i

async function serveAsset(context, req, res, url) {
  const match = url.pathname.match(ASSET_PATH)
  if (!match) throw notFound('unknown asset path')
  const [, kind, projectId, datasetName, sha1, , , extension] = match
  let file = context.sim.assets.locate(sha1, extension)
  if (!file) {
    /* A synced dataset's asset: fetch it from Sanity's public CDN once, then serve from cache. */
    const remote = context.sim.config.sync?.[context.sim.resolveName(datasetName)]
    if (remote?.projectId) {
      const name = url.pathname.split('/')[4]
      const cdnUrl = `https://cdn.sanity.io/${kind}/${remote.projectId}/${remote.dataset ?? datasetName}/${name}`
      const response = await fetch(cdnUrl)
      if (response.ok) file = context.sim.assets.cache(sha1, extension, Buffer.from(await response.arrayBuffer()))
    }
  }
  if (!file) throw notFound(`asset ${sha1}.${extension} is not stored locally (project ${projectId})`)

  const headers = {'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*'}
  if (url.searchParams.has('dl')) {
    headers['content-disposition'] = `attachment; filename="${url.searchParams.get('dl') || `${sha1}.${extension}`}"`
  }
  if (kind === 'images') {
    const transformed = await transformImage(file, url.searchParams, String(req.headers.accept ?? '')).catch(() => null)
    if (transformed?.json) return json(res, 200, transformed.json)
    if (transformed) {
      res.writeHead(200, {...headers, 'content-type': transformed.contentType, vary: 'Accept'})
      res.end(transformed.bytes)
      return
    }
  }
  res.writeHead(200, {...headers, 'content-type': mimeForExtension(extension)})
  fs.createReadStream(file).pipe(res)
}

/* ================================================================ dashboard */

function serveDashboard(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = path.join(DASHBOARD_DIR, relative)
  if (!file.startsWith(DASHBOARD_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    /* Client-side routes fall back to the app shell. */
    const index = path.join(DASHBOARD_DIR, 'index.html')
    if (!path.extname(relative) && fs.existsSync(index)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache'})
      fs.createReadStream(index).pipe(res)
      return
    }
    throw notImplemented(`GET ${pathname}`)
  }
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}
  res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache'})
  fs.createReadStream(file).pipe(res)
}

const isStatic = (pathname) => !VERSIONED.test(pathname) && !pathname.startsWith('/images/') && !pathname.startsWith('/files/')

/* ================================================================ websocket */

function upgrade(context, req, socket, head) {
  const url = new URL(req.url, 'http://localhost')
  const origin = req.headers.origin
  if (origin && !context.allowedOrigins.has(origin) && !isLoopbackOrigin(origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  if (/^\/v[^/]+\/socket\//.test(url.pathname)) {
    acceptWebSocket(req, socket, head)
    context.sim.record({at: new Date().toISOString(), method: 'WS', path: url.pathname, route: '/socket/{dataset}', status: 101, client: clientOf(req, url)})
    return
  }
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
}

/* ================================================================ helpers */

export function json(res, status, body) {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(payload)
}

function sendError(res, error, sim) {
  if (error instanceof SimError) {
    if (error.status >= 500) sim.log('warn', error.message)
    return json(res, error.status, error.toBody())
  }
  sim.log('error', error?.stack ?? String(error))
  return json(res, 500, {error: {type: 'internalError', description: String(error?.message ?? error)}})
}

export function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new SimError(413, 'payloadTooLarge', `request body exceeds ${limit} bytes`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw badRequest('the request body is not valid JSON')
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function pickSystem(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key.startsWith('_')))
}

/** A stable route label for the request log (ids and versions collapsed). */
function routeKey(pathname) {
  const match = pathname.match(VERSIONED)
  if (!match) return pathname.startsWith('/images/') ? '/images/…' : pathname.startsWith('/files/') ? '/files/…' : pathname
  const parts = (match[2] ?? '/').split('/').filter(Boolean)
  if (parts[0] === 'data' && parts.length >= 3) return `/data/${parts[1]}/{dataset}${parts[1] === 'history' ? `/${parts[3] ?? ''}` : ''}`
  if (parts[0] === 'projects') return `/projects/{id}${parts[1] ? `/${parts[1]}` : ''}${parts[3] ? `/{ds}/${parts[3]}` : ''}`
  if (parts[0] === 'users' && parts[1] === 'me' && parts[2]) return `/users/me/${parts[2]}`
  if (parts[0] === 'assets') return `/assets/${parts[1] ?? ''}`
  if (parts[0] === 'journey') return '/journey/{topic}'
  return '/' + parts.slice(0, 2).join('/')
}

/** Who is calling: the Studio, an app, the dashboard, or a script. */
function clientOf(req, url) {
  const tag = url.searchParams.get('tag') ?? ''
  const origin = req.headers.origin ?? ''
  if (tag.startsWith('sanity.studio') || req.headers['x-sanity-app']?.includes?.('studio')) return `studio ${origin}`.trim()
  if (origin) return `browser ${origin}`
  const agent = String(req.headers['user-agent'] ?? '')
  if (agent.includes('@sanity/client')) return `node ${agent.split(' ')[0]}`
  return agent ? agent.split(' ')[0] : 'unknown'
}
