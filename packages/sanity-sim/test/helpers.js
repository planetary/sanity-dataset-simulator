import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Simulator} from '../src/simulator.js'
import {startServer} from '../src/server.js'

/** A simulator on a random port over a fresh temp directory (plain HTTP). */
export async function startSim({projectId = 'testproj', dataset = 'production', root} = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-test-'))
  const sim = new Simulator({root: dir, projectId, dataset})
  sim.dataset(dataset)
  const server = await startServer(sim, {port: 0})
  const base = `http://127.0.0.1:${server.port}`
  const api = (p) => `${base}/v2025-02-19${p}`
  return {
    sim,
    root: dir,
    base,
    api,
    port: server.port,
    async close() {
      sim.close()
      await server.close()
    },
    async mutate(mutations, query = '') {
      return post(api(`/data/mutate/${dataset}${query}`), {mutations})
    },
    async actions(actions, extra = {}) {
      return post(api(`/data/actions/${dataset}`), {actions, ...extra})
    },
    async query(groq, {perspective, params = {}, version = 'v2025-02-19'} = {}) {
      const search = new URLSearchParams({query: groq})
      if (perspective) search.set('perspective', perspective)
      for (const [key, value] of Object.entries(params)) search.set(`$${key}`, JSON.stringify(value))
      const response = await fetch(`${base}/${version}/data/query/${dataset}?${search}`)
      return {status: response.status, body: await response.json()}
    },
  }
}

export async function post(url, body, headers = {}) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)})
  const text = await response.text()
  return {status: response.status, body: text ? JSON.parse(text) : null}
}

/** Read an SSE stream into an array of {event, data, id} until `until` returns true or timeout. */
export async function readEvents(url, {until, timeout = 3000, headers = {}, onOpen} = {}) {
  const controller = new AbortController()
  const response = await fetch(url, {signal: controller.signal, headers})
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  let opened = false
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    for (;;) {
      const {value, done} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = {}
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event.event = line.slice(7)
          if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6))
          if (line.startsWith('id: ')) event.id = line.slice(4)
        }
        if (!event.event) continue
        events.push(event)
        if (!opened && onOpen) {
          opened = true
          await onOpen()
        }
        if (until?.(events)) {
          controller.abort()
          return events
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error
  } finally {
    clearTimeout(timer)
  }
  return events
}
