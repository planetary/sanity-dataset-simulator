import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Pull a real dataset into the simulator's remote snapshot layer.
 *
 * READ-ONLY BY CONSTRUCTION. Every request to Sanity goes through
 * `upstream()`, which refuses any method but GET. A write token found in the
 * project's env is fine to *hold* (projects often keep one in .env); it is
 * only ever sent on GETs. Local edits never leave the machine.
 */

const API_VERSION = 'v2025-02-19'

export class ReadOnlyViolation extends Error {}

/**
 * `https://<project>.api.sanity.io`, or SANITY_SIM_UPSTREAM when set. The
 * override exists so the test suite can sync from a second simulator instead
 * of the network; it is not a user-facing option.
 */
export function upstreamBase(projectId) {
  return process.env.SANITY_SIM_UPSTREAM ?? `https://${projectId}.api.sanity.io`
}

export function upstream(url, {method = 'GET', token, signal} = {}) {
  if (method !== 'GET') throw new ReadOnlyViolation(`sanity-sim never writes to Sanity (refused ${method} ${url})`)
  const headers = {accept: 'application/json, application/x-ndjson', 'user-agent': 'sanity-sim'}
  /* A Sanity token only ever goes to Sanity's own hosts. */
  if (token && /(^|\.)sanity\.io$/.test(new URL(url).hostname)) headers.authorization = `Bearer ${token}`
  return fetch(url, {method, headers, signal})
}

/** A token to read the source dataset with: the project's env first, then `sanity login`. */
export function findToken(project) {
  if (project?.token?.value) return {value: project.token.value, source: project.token.key}
  if (process.env.SANITY_AUTH_TOKEN) return {value: process.env.SANITY_AUTH_TOKEN, source: 'SANITY_AUTH_TOKEN'}
  const configs = [
    path.join(os.homedir(), '.config', 'sanity', 'config.json'),
    path.join(os.homedir(), '.config', 'sanity-staging', 'config.json'),
  ]
  for (const file of configs) {
    try {
      const token = JSON.parse(fs.readFileSync(file, 'utf8')).authToken
      if (token) return {value: token, source: 'sanity login'}
    } catch {
      /* not logged in */
    }
  }
  return null
}

/**
 * Replace `datasetName`'s remote snapshot with the source dataset's current
 * contents (drafts and release versions included when the token can read them).
 */
export async function syncDataset(sim, datasetName, {projectId, dataset, token, types, onProgress = () => {}}) {
  const target = sim.dataset(datasetName)
  const search = new URLSearchParams()
  if (types?.length) search.set('types', types.join(','))
  const url = `${upstreamBase(projectId)}/${API_VERSION}/data/export/${dataset}${search.size ? `?${search}` : ''}`
  const response = await upstream(url, {token: token?.value})
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`export of ${projectId}/${dataset} failed: ${response.status} ${body.slice(0, 300)}`)
  }
  const documents = []
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, {stream: true})
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const doc = JSON.parse(line)
      if (doc.error && !doc._id) throw new Error(`export stream error: ${JSON.stringify(doc.error)}`)
      documents.push(doc)
      if (documents.length % 1000 === 0) onProgress(documents.length)
    }
  }
  if (pending.trim()) documents.push(JSON.parse(pending))

  const meta = {
    projectId,
    dataset,
    syncedAt: new Date().toISOString(),
    count: documents.length,
    drafts: documents.filter((doc) => doc._id.startsWith('drafts.')).length,
    credentials: token?.source ?? 'none (public dataset, published documents only)',
    types: types ?? null,
  }
  const changes = target.replaceRemote(documents, meta)
  sim.config.sync = {...sim.config.sync, [target.name]: {projectId, dataset, types: types ?? null}}
  sim.saveConfig()
  const mediaLibraries = await syncMediaLibraries(sim, documents, {projectId, token})
  return {meta, changed: changes.length, stale: target.staleEntries().length, mediaLibraries}
}

/* ------------------------------------------------------------------ Media Library */

const LIBRARY_REF = /^media-library:(ml[^:]+):([^:]+)$/
const LIBRARY_BATCH = 40

/**
 * The Media Library documents a dataset points at, by library id: what its
 * `media-library:<lib>:<id>` references name (asset containers from fields'
 * `media`, instances from linked asset documents and video fields), plus the
 * container of every linked asset (`source.id`).
 */
export function mediaLibraryRefs(documents) {
  const refs = new Map()
  const add = (library, id) => {
    if (!refs.has(library)) refs.set(library, new Set())
    refs.get(library).add(id)
  }
  const walk = (value, depth = 0) => {
    if (depth > 40 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1))
    const match = typeof value._ref === 'string' && LIBRARY_REF.exec(value._ref)
    if (match) add(match[1], match[2])
    for (const item of Object.values(value)) walk(item, depth + 1)
  }
  for (const document of documents) {
    walk(document)
    const library = LIBRARY_REF.exec(document.media?._ref ?? '')?.[1]
    if (library && document.source?.name === 'sanity-media-library' && document.source.id) add(library, document.source.id)
  }
  return refs
}

/**
 * Pull the referenced Media Library documents, read-only, into the local
 * libraries' remote layer: references resolve, the picker lists them, and
 * "Open in Media Library" finds them. Bytes are fetched lazily from each
 * instance's own URL when first served. A library the token cannot read is
 * reported, not fatal: the dataset sync has already succeeded.
 */
export async function syncMediaLibraries(sim, documents, {projectId, token}) {
  const results = []
  for (const [libraryId, wanted] of mediaLibraryRefs(documents)) {
    const library = sim.mediaLibraries.get(libraryId)
    if (!library) continue
    try {
      const fetched = new Map()
      const requested = new Set(wanted)
      let pending = [...wanted]
      while (pending.length > 0) {
        for (const document of await fetchLibraryDocuments({projectId, libraryId, token, ids: pending})) fetched.set(document._id, document)
        /* A container's versions come along, so every version can be opened and linked. */
        pending = [...new Set([...fetched.values()]
          .filter((document) => document._type === 'sanity.asset')
          .flatMap((container) => [container.currentVersion?._ref, ...(container.versions ?? []).map((version) => version.instance?._ref)])
          .filter((id) => id && !requested.has(id)))]
        for (const id of pending) requested.add(id)
      }
      for (const document of fetched.values()) library.store.applyRemoteChange(document._id, document)
      results.push({libraryId, documents: fetched.size, missing: [...wanted].filter((id) => !fetched.has(id)).length})
    } catch (error) {
      results.push({libraryId, error: error.message})
    }
  }
  return results
}

async function fetchLibraryDocuments({projectId, libraryId, token, ids}) {
  const out = []
  for (let i = 0; i < ids.length; i += LIBRARY_BATCH) {
    const batch = ids.slice(i, i + LIBRARY_BATCH).map(encodeURIComponent).join(',')
    const url = `${upstreamBase(projectId)}/vX/media-libraries/${libraryId}/doc/${batch}`
    const response = await upstream(url, {token: token?.value})
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`reading media library ${libraryId} failed: ${response.status} ${body.slice(0, 200)}`)
    }
    out.push(...((await response.json()).documents ?? []))
  }
  return out
}

/**
 * Keep the remote snapshot current: one read-only listen stream on the source
 * dataset. Returns a stop function. Reconnects with backoff.
 */
export function followDataset(sim, datasetName, {projectId, dataset, token, log = () => {}}) {
  const target = sim.dataset(datasetName)
  const controller = new AbortController()
  let attempt = 0
  const url = `${upstreamBase(projectId)}/${API_VERSION}/data/listen/${dataset}?${new URLSearchParams({
    query: '*',
    includeResult: 'true',
    includeAllVersions: 'true',
    visibility: 'query',
    effectFormat: 'mendoza',
    includeMutations: 'false',
  })}`

  const connect = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await upstream(url, {token: token?.value, signal: controller.signal})
        if (!response.ok) throw new Error(`listen ${response.status}`)
        attempt = 0
        log('info', `following ${projectId}/${dataset}`)
        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, {stream: true})
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (event !== 'mutation' || !data) continue
            const payload = JSON.parse(data)
            const gone = payload.transition === 'disappear' || !payload.result
            target.applyRemoteChange(payload.documentId, gone ? null : payload.result)
            if (!gone) pullNewLibraryRefs(sim, payload.result, {projectId, token, log})
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        attempt += 1
        log('warn', `follow ${projectId}/${dataset}: ${error.message}; retrying`)
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)))
      }
    }
  }
  connect()
  return () => controller.abort()
}

/** Follow mode: a remote change that references Media Library documents not here yet pulls them. */
function pullNewLibraryRefs(sim, document, {projectId, token, log}) {
  const unknown = [...mediaLibraryRefs([document])].some(([libraryId, ids]) => {
    const library = sim.mediaLibraries.get(libraryId)
    return library && [...ids].some((id) => !library.store.get(id))
  })
  if (!unknown) return
  syncMediaLibraries(sim, [document], {projectId, token}).then((results) => {
    for (const result of results) if (result.error) log('warn', result.error)
  })
}

/** A remote document at an earlier revision (the merge ancestor). Read-only. */
export async function fetchRemoteRevision({projectId, dataset, token}, id, revision) {
  const url = `${upstreamBase(projectId)}/${API_VERSION}/data/history/${dataset}/documents/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`
  const response = await upstream(url, {token: token?.value})
  if (!response.ok) return null
  const body = await response.json()
  return body.documents?.[0] ?? null
}

/**
 * Three-way merge at top-level-field granularity: fields only one side
 * changed take that side; fields both changed identically agree; fields both
 * changed differently keep the local value and are reported as conflicts.
 */
export function mergeDocuments(ancestor, local, remote) {
  const keys = new Set([...Object.keys(ancestor ?? {}), ...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])
  const merged = {}
  const conflicts = []
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const key of keys) {
    if (key === '_rev' || key === '_updatedAt') continue
    const a = ancestor?.[key]
    const l = local?.[key]
    const r = remote?.[key]
    let value
    if (same(l, a)) value = r
    else if (same(r, a) || same(l, r)) value = l
    else {
      value = l
      conflicts.push(key)
    }
    if (value !== undefined) merged[key] = value
  }
  merged._id = local?._id ?? remote?._id
  return {merged, conflicts}
}
