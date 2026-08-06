/**
 * `sanity-overlay-next` — the `/events` change bridge (PRD §14.3, §14.4 steps
 * 2-4 and 7-10, §37 Phase 2 "local SSE or event bridge").
 *
 * Driven over a REAL SSE connection: the frames asserted on below were parsed
 * out of bytes that crossed a socket, not read off an emitter. The wire format
 * is half the contract — a bridge that emitted the right objects into the wrong
 * frame encoding delivers nothing.
 *
 * THREE CLAIMS THIS FILE EXISTS FOR
 *
 *   1. DURABILITY PRECEDES NOTIFICATION. An event is an instruction to refetch.
 *      One sent before the write landed makes every subscriber read the PREVIOUS
 *      state and cache it as current.
 *   2. THE WATCHER SHARES THE COMMIT MUTEX. `revalidate` repairs a stale
 *      checksum by REWRITING `intent.json`. That is a write, so an unserialised
 *      watch pass races the commit path — two writers, one file, no lock.
 *   3. `projection` IS DECLARED ON THE WIRE. `/state` and `/resolve` are built
 *      from the immutable record the manifest head names. A direct edit rewrites
 *      `intent.json` and touches neither, and core exports no entry point that
 *      replays intent + snapshot back into a record. So a direct-edit event says
 *      `projection: "stale"` and a commit event says `"current"`. That honesty
 *      is the contract; erasing it would make the two indistinguishable to a
 *      consumer that has to decide whether to trust `/state`.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {encodeSseFrame, startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import type {OverlayApiServer} from '../../sanity-overlay-next/src/index'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'next-events-overlay-00000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

const roots: string[] = []
const running: OverlayApiServer[] = []
const streams: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of streams.splice(0)) await stop()
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'next-events-'))
  roots.push(root)
  return root
}

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

interface Hooks {
  beforeRename?(info: {tempPath: string; targetPath: string}): void | Promise<void>
}

interface Gate {
  hooks: Hooks
  arm(): void
  reached(): boolean
  release(): void
}

function manifestGate(): Gate {
  let armed = false
  let reached = false
  let release: () => void = () => undefined
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    hooks: {
      async beforeRename({targetPath}) {
        if (!armed || !targetPath.endsWith('manifest.json')) return
        reached = true
        await open
      },
    },
    arm: () => {
      armed = true
    },
    reached: () => reached,
    release: () => release(),
  }
}

async function boot(root: string, hooks?: Hooks): Promise<OverlayApiServer> {
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    hooks,
    /* The timer is a latency knob; every test here drives `pollDirectEdits`
     * explicitly so no assertion depends on when a timer happened to fire. */
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
  })
  running.push(server)
  return server
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function watch<T>(promise: Promise<T>): {settled: () => boolean; promise: Promise<T>} {
  let settled = false
  const tracked = promise.then(
    (value) => {
      settled = true
      return value
    },
    (error) => {
      settled = true
      throw error
    },
  )
  void tracked.catch(() => undefined)
  return {settled: () => settled, promise: tracked}
}

interface Frame {
  id: string
  event: string
  /** The raw `data:` line, so a forged newline would be visible as a split. */
  raw: string
  data: Record<string, any>
}

interface Stream {
  frames: Frame[]
  headers: Headers
  status: number
  /** Every raw line the server sent, for encoding assertions. */
  lines: string[]
}

/**
 * Open a real `text/event-stream` and decode frames as they arrive.
 *
 * Frames are split on the blank line SSE defines as a terminator, so a payload
 * that contained a raw `\n\n` would show up here as EXTRA frames — which is
 * exactly the forgery the encoder must prevent.
 */
async function openEvents(server: OverlayApiServer): Promise<Stream> {
  const response = await fetch(`${server.url}/events`, {
    headers: {origin: STUDIO_ORIGIN, accept: 'text/event-stream'},
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const stream: Stream = {frames: [], headers: response.headers, status: response.status, lines: []}

  let buffer = ''
  const pump = (async () => {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const lines = chunk.split('\n')
        stream.lines.push(...lines)
        const field = (name: string): string =>
          lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? ''
        const raw = field('data')
        stream.frames.push({
          id: field('id'),
          event: field('event'),
          raw,
          data: raw.length > 0 ? JSON.parse(raw) : {},
        })
      }
    }
  })()

  streams.push(async () => {
    await reader.cancel().catch(() => undefined)
    await pump.catch(() => undefined)
  })

  await until(() => stream.frames.length > 0, 'the opening frame')
  return stream
}

const BASE_ARTICLE = {
  _id: 'article-1',
  _type: 'article',
  _rev: 'lake-rev-1',
  _createdAt: '2025-12-01T00:00:00.000Z',
  _updatedAt: '2025-12-01T00:00:00.000Z',
  title: 'Staging title',
}

function editAction(title: string): unknown[] {
  return [
    {
      actionType: 'sanity.action.document.edit',
      draftId: 'drafts.article-1',
      publishedId: 'article-1',
      patch: {set: {title}},
    },
  ]
}

async function commit(server: OverlayApiServer, key: string, title: string) {
  const response = await fetch(`${server.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify({
      idempotencyKey: key,
      kind: 'actions',
      payload: editAction(title),
      baseDocuments: [BASE_ARTICLE],
    }),
  })
  return (await response.json()) as Record<string, any>
}

const intentPath = (root: string): string =>
  join(root, '.sanity-overlay', 'documents', 'article-1', 'intent.json')

/* ------------------------------------------------------------------ *
 * The stream itself
 * ------------------------------------------------------------------ */

describe('GET /events', () => {
  it('opens an unbuffered event stream and says which revision you joined at', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)

    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    /* A compressing proxy would buffer the stream and turn a live bridge into a
     * stalled one; `no-transform` is the opt-out that prevents it. */
    expect(stream.headers.get('cache-control')).toContain('no-transform')
    expect(stream.headers.get('x-accel-buffering')).toBe('no')
    expect(stream.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)

    expect(stream.frames[0].event).toBe('hello')
    expect(stream.frames[0].data).toMatchObject({ok: true, overlayId: OVERLAY_ID})
    expect(typeof stream.frames[0].data.revision).toBe('number')
  })

  it('counts its subscribers and forgets one that disconnects', async () => {
    const server = await boot(await makeRoot())
    expect(server.api.subscriberCount()).toBe(0)

    await openEvents(server)
    await until(() => server.api.subscriberCount() === 1, 'the subscriber to register')

    await streams.splice(0)[0]!()
    await until(() => server.api.subscriberCount() === 0, 'the subscriber to be dropped')
  })
})

/* ------------------------------------------------------------------ *
 * Commits — projection: current
 * ------------------------------------------------------------------ */

describe('a commit announces itself as current', () => {
  it('names the documents as a list and declares the projection current', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)

    const result = await commit(server, 'k1', 'Announced')
    await until(() => stream.frames.length > 1, 'the commit event')

    const [, changed] = stream.frames
    expect(changed.event).toBe('document.changed')
    expect(changed.data).toMatchObject({
      overlayId: OVERLAY_ID,
      origin: 'commit',
      /* The commit updated the projection in the same step that made it
       * durable, so `/state` already agrees with this event. */
      projection: 'current',
      revision: result.revision,
      transactionId: result.transactionId,
    })
    /* A LIST, never a joined string: two documents must stay two elements. */
    expect(changed.data.documentIds).toEqual(['article-1'])
  })

  it('does not announce a commit that changed nothing', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)

    await fetch(`${server.url}/commit`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
      body: JSON.stringify({
        idempotencyKey: 'nothing',
        kind: 'mutations',
        payload: [{delete: {query: '*[_type == "article"]'}}],
      }),
    })
    await settle()
    expect(stream.frames.map((frame) => frame.event)).toEqual(['hello'])
  })

  it('never announces before the store has passed its commit point', async () => {
    const root = await makeRoot()
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    const stream = await openEvents(server)
    gate.arm()

    const inflight = watch(commit(server, 'k1', 'Held'))
    await until(gate.reached, 'the store to reach its commit point')
    await settle()

    /* The write is mid-flight. An event now would send every subscriber to
     * refetch the PREVIOUS state and cache it as current. */
    expect(stream.frames.map((frame) => frame.event)).toEqual(['hello'])

    gate.release()
    await inflight.promise
    await until(() => stream.frames.length > 1, 'the commit event')
    expect(stream.frames[1].event).toBe('document.changed')
  })
})

/* ------------------------------------------------------------------ *
 * Direct edits — projection: stale
 * ------------------------------------------------------------------ */

describe('a direct file edit is announced as stale', () => {
  it('declares the projection stale rather than pretending /state caught up', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commit(server, 'k1', 'Committed')
    const stream = await openEvents(server)

    /* An agent edits the canonical file by hand — PRD §14.3's whole premise. */
    const path = intentPath(root)
    const intent = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
    intent.draft.overrides = [{path: ['title'], value: 'Edited on disk'}]
    await writeFile(path, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')

    await server.api.pollDirectEdits()
    await until(() => stream.frames.length > 1, 'the direct-edit event')

    const changed = stream.frames.find((frame) => frame.data.origin === 'direct-edit')!
    expect(changed.event).toBe('document.changed')
    expect(changed.data.documentIds).toEqual(['article-1'])
    /*
     * The load-bearing field. `/state` is built from the immutable record the
     * manifest head names; this edit touched `intent.json` and nothing else, and
     * core exposes no entry point that replays intent + snapshot back into a
     * record. A consumer reading the canonical files is fully served; a consumer
     * reading `/state` is told not to trust it.
     */
    expect(changed.data.projection).toBe('stale')
  })

  it('reports a checksum repair as its own event, not as a content change', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commit(server, 'k1', 'Committed')
    const stream = await openEvents(server)

    /* §14.3 — a semantically valid file whose checksum is stale is REPAIRED,
     * not refused. The bytes change without the meaning changing, so it is its
     * own kind of news. */
    const path = intentPath(root)
    const intent = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
    intent.checksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    await writeFile(path, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')

    await server.api.pollDirectEdits()
    await until(
      () => stream.frames.some((frame) => frame.event === 'overlay.repaired'),
      'the repair event',
    )

    const repaired = stream.frames.find((frame) => frame.event === 'overlay.repaired')!
    expect(repaired.data.refs).toEqual(['documents/article-1/intent.json'])

    /* And the repair is on disk, not merely announced. */
    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
    expect(after.checksum).not.toBe(intent.checksum)
  })

  it('reports an unparseable file once, not on every pass', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commit(server, 'k1', 'Committed')
    const stream = await openEvents(server)

    await writeFile(intentPath(root), '{ this is not json', 'utf8')

    await server.api.pollDirectEdits()
    await until(
      () => stream.frames.some((frame) => frame.event === 'overlay.invalid'),
      'the invalid event',
    )

    const invalid = stream.frames.find((frame) => frame.event === 'overlay.invalid')!
    expect(invalid.data.invalid).toHaveLength(1)
    expect(invalid.data.invalid[0].logicalId).toBe('article-1')
    /* §14.4 step 10 — the store keeps serving the last valid state, so this is a
     * report and not a state transition. `brokenCopyRef` is the route out. */
    expect(typeof invalid.data.invalid[0].brokenCopyRef).toBe('string')

    /* A broken file STAYS broken. Without a fingerprint, one bad file becomes an
     * unbounded event stream that buries every real change. */
    const before = stream.frames.length
    await server.api.pollDirectEdits()
    await server.api.pollDirectEdits()
    await settle()
    expect(stream.frames.length).toBe(before)
  })

  it('emits one frame for one finding, whatever the broken file contains', async () => {
    const root = await makeRoot()
    const server = await boot(root)
    await commit(server, 'k1', 'Committed')
    const stream = await openEvents(server)

    await writeFile(
      intentPath(root),
      '{ broken\n\nevent: forged\ndata: {"ok":true}\n\n',
      'utf8',
    )

    await server.api.pollDirectEdits()
    await until(
      () => stream.frames.some((frame) => frame.event === 'overlay.invalid'),
      'the invalid event',
    )
    await settle()

    expect(stream.frames.map((frame) => frame.event).sort()).toEqual(['hello', 'overlay.invalid'])
    for (const frame of stream.frames) {
      expect(frame.raw).not.toContain('\n')
      expect(() => JSON.parse(frame.raw)).not.toThrow()
    }
  })
})

/* ------------------------------------------------------------------ *
 * The frame encoder
 * ------------------------------------------------------------------ */

describe('encodeSseFrame', () => {
  /*
   * WHY THIS IS A UNIT TEST AND NOT A WIRE TEST.
   *
   * The test above sends a payload through a real socket and checks no frame was
   * forged. It passes — and it passes for a reason that is not the encoder: every
   * payload the overlay emits today is newline-free by construction. Document
   * IDs are escaped, revisions are numbers, refs are relative paths, and V8's
   * JSON parse messages carry a POSITION ("at position 2 (line 1 column 3)")
   * rather than a snippet of the offending bytes. So there is nothing on that
   * wire for an interpolation bug to reveal itself with. Verified by mutation:
   * with `JSON.stringify` replaced by raw interpolation, the wire test above
   * stays green.
   *
   * A guard nothing can falsify is a guard that gets deleted as dead weight, and
   * the first payload that ever carries a newline — a validation message, a
   * conflict summary, an author display name — turns it into frame injection.
   * So the claim is made where it IS falsifiable.
   */
  it('escapes a newline instead of letting it terminate the frame', () => {
    const encoded = encodeSseFrame({
      id: 7,
      event: 'document.changed',
      data: {note: 'first line\n\nevent: forged\ndata: {"ok":true}'},
    })

    /* Exactly one frame terminator, and it is the last thing in the string. */
    expect(encoded.split('\n\n')).toHaveLength(2)
    expect(encoded.endsWith('\n\n')).toBe(true)

    const [id, event, data] = encoded.slice(0, -2).split('\n')
    expect(id).toBe('id: 7')
    expect(event).toBe('event: document.changed')
    expect(JSON.parse(data!.slice('data: '.length))).toEqual({
      note: 'first line\n\nevent: forged\ndata: {"ok":true}',
    })
  })

  it('survives a carriage return, which also ends an SSE field', () => {
    const encoded = encodeSseFrame({id: 1, event: 'hello', data: {note: 'a\r\nb'}})
    expect(encoded.split('\n')).toHaveLength(5)
    expect(encoded).toContain('\\r\\n')
  })
})

/* ------------------------------------------------------------------ *
 * The shared mutex
 * ------------------------------------------------------------------ */

describe('the direct-edit watcher shares the commit mutex', () => {
  it('cannot run a revalidation pass while a commit is inside the store', async () => {
    const root = await makeRoot()
    const gate = manifestGate()
    const server = await boot(root, gate.hooks)
    gate.arm()

    const inflight = watch(commit(server, 'k1', 'Held'))
    await until(gate.reached, 'the store to reach its commit point')

    /*
     * `revalidate` REWRITES `intent.json` to repair a stale checksum, so a pass
     * that ran here would be a second writer on the same files as the commit in
     * flight. It must queue behind it.
     */
    const pass = watch(server.api.pollDirectEdits())
    await settle()
    expect(pass.settled()).toBe(false)

    gate.release()
    await inflight.promise
    await pass.promise
  })
})

/* ------------------------------------------------------------------ *
 * Shutdown
 * ------------------------------------------------------------------ */

describe('close() ends every event stream', () => {
  it('closes the stream cleanly instead of leaving the socket hanging', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    expect(server.api.subscriberCount()).toBe(1)

    /* An SSE response is a connection the server itself holds open. A `close()`
     * that waited for connections to finish without ending these would never
     * resolve — so this test failing is a hang, not an assertion. */
    await server.close()
    running.splice(running.indexOf(server), 1)

    expect(server.api.subscriberCount()).toBe(0)
    expect(stream.frames[0].event).toBe('hello')
  })
})
