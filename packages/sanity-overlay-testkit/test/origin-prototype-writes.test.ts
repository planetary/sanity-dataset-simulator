/**
 * MODE 2 (origin) — a §35.14 prototype key never produces a silent success.
 *
 * THE CLASS SWEEP THAT FOUND THIS
 * Security review P2-5 named `sanity-overlay-next`'s `parseSanityPath`. There
 * are THREE copies of that parser in this repository — the packaged one, Spike
 * A's browser-safe re-declaration, and this one — and a defect in a rule
 * expressed three times is a defect in three places until every copy is checked.
 * `origin.mjs:318` had it too: a field segment spelling `__proto__` parsed
 * happily, and the write then vanished into a prototype swap while Mode 2
 * answered `200 {transactionId}`.
 *
 * WHY IT MATTERS MORE HERE
 * Mode 2 has NO upstream. The overlay is the only copy of the content, so a
 * write that is answered and discarded is not a divergence from staging — it is
 * data that has never existed anywhere. `handleMutate` already says this out
 * loud when it refuses an unsupported mutation: *"a write Studio believes
 * succeeded but that never landed is the worst failure this overlay can have."*
 * A `__proto__` path was the one way through that sentence.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
import {
  createOriginHandler,
  parseSanityPath,
  // @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>; revision: number}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-proto-'))
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-proto-test',
  })
  server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: path.join(root, 'log.jsonl'),
    env: {},
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, {recursive: true, force: true})
})

async function mutate(mutations: unknown[]): Promise<{status: number; json: any}> {
  const response = await fetch(`${baseUrl}${V}/data/mutate/${DATASET}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({mutations}),
  })
  const text = await response.text()
  return {status: response.status, json: text === '' ? null : JSON.parse(text)}
}

describe('parseSanityPath refuses a §35.14 key in any segment', () => {
  for (const spelling of [
    '__proto__',
    '__proto__.polluted',
    'a.__proto__.b',
    'constructor.prototype.x',
    'prototype',
    'list[0].__proto__',
  ]) {
    it(`refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => parseSanityPath(spelling)).toThrowError(/prototype|__proto__|constructor/i)
      let code: unknown
      try {
        parseSanityPath(spelling)
      } catch (error) {
        code = (error as {code?: string}).code
      }
      /* Coded, so `handle`'s catch answers 400 with a name rather than 500. */
      expect(code).toBe('OVERLAY_ORIGIN_UNSUPPORTED_PATH')
    })
  }

  it('still parses the paths Studio actually emits', () => {
    expect(parseSanityPath('title')).toEqual(['title'])
    expect(parseSanityPath('body[_key=="a1"].text')).toEqual(['body', {_key: 'a1'}, 'text'])
    expect(parseSanityPath('constructorName')).toEqual(['constructorName'])
    /* A `_key` VALUE spelling a forbidden word is data, not a property name. */
    expect(parseSanityPath('items[_key=="__proto__"].label')).toEqual([
      'items',
      {_key: '__proto__'},
      'label',
    ])
  })
})

describe('POST /data/mutate refuses rather than answering a transactionId', () => {
  it('refuses a `__proto__.polluted` patch and writes nothing', async () => {
    const created = await mutate([
      {createOrReplace: {_id: 'proto-doc', _type: 'article', title: 'seed'}},
    ])
    expect(created.status).toBe(200)
    const revisionBefore = handler.revision

    const forged = await mutate([
      {patch: {id: 'proto-doc', set: {'__proto__.polluted': 'yes'}}},
    ])
    expect(forged.status).toBe(400)
    expect(String(forged.json?.error?.description ?? '')).toMatch(/__proto__/)
    expect(handler.revision).toBe(revisionBefore)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('refuses `a.__proto__.b` rather than persisting `a` as an empty object', async () => {
    const revisionBefore = handler.revision
    const forged = await mutate([{patch: {id: 'proto-doc', set: {'a.__proto__.b': 'yes'}}}])
    expect(forged.status).toBe(400)
    expect(handler.revision).toBe(revisionBefore)

    const read = await fetch(`${baseUrl}${V}/data/doc/${DATASET}/proto-doc`)
    const body = (await read.json()) as any
    expect(body.documents?.[0]?.a).toBeUndefined()
  })

  it('still accepts an ordinary patch', async () => {
    const ok = await mutate([{patch: {id: 'proto-doc', set: {title: 'edited'}}}])
    expect(ok.status).toBe(200)
    const read = await fetch(`${baseUrl}${V}/data/doc/${DATASET}/proto-doc`)
    const body = (await read.json()) as any
    expect(body.documents?.[0]?.title).toBe('edited')
  })
})
