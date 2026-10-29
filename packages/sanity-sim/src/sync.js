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
  return {meta, changed: changes.length, stale: target.staleEntries().length}
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
