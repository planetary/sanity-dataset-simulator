/**
 * The local event bridge — PRD §37 Phase 2 "Implement local SSE or event bridge",
 * §14.4 steps 8-10, §6 "Event bus: notify Studio and preview clients through
 * in-process events, filesystem watches, SSE, or polling".
 *
 * ## What was missing
 *
 * Two halves already existed and did not meet. `FsOverlayStore.revalidate` runs
 * the §14.4 direct-edit workflow and `watchOverlay` triggers it on a poll — so a
 * hand-edited `intent.json` is parsed, validated, checksum-repaired and refused
 * if malformed. And the overlay server commits Studio's writes durably. But
 * nothing announced either one. §14.4 step 8 says the event bus emits
 * `document.changed` and step 9 says Studio and preview refetch; with no bridge,
 * step 9 could only ever happen by luck or by polling `/state` forever.
 *
 * ## The two properties this file exists to pin
 *
 * 1. **Durability precedes notification.** This repository has already shipped
 *    the opposite bug once: the overlay server acknowledged an HTTP request
 *    before the disk write finished. An event stream is the same hazard with a
 *    longer fuse, because a subscriber that refetches on a premature event reads
 *    the *previous* state and caches it as current. `beforeRename` holds a commit
 *    open inside the store, and the test asserts no frame has been written while
 *    it is held.
 *
 * 2. **Frames are not built by joining strings.** SSE is a newline-delimited
 *    wire format, so a document title containing `\n\ndata: {...}` is an event
 *    injection unless the payload is JSON-encoded. This is the same class of
 *    defect as the separator-joined keys fixed elsewhere in this repository
 *    (`k` and `k+S+k` colliding): a delimiter chosen from the same alphabet as
 *    the data. Both the framing and the document-ID list are tested for it.
 *
 * Assertion discipline: revisions and document contents are read back from
 * `manifest.json` and `intent.json` with `node:fs`, never taken from the event
 * the server just emitted. An event that reported a revision the store never
 * wrote would otherwise pass.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {encodeLogicalId, parse, serialize} from '../../sanity-overlay-core/src/index'
import {startOverlayServer} from '../../../examples/kitchen-sink/spikeA/overlayServer.mjs'

/* Real ports, real files, real streams — see `overlay-server.test.ts` for why the
 * budget is generous and why no assertion depends on it. */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

const OVERLAY_ID = 'spike-a-events-00000000000000'
const STUDIO_ORIGIN = 'http://localhost:3333'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const roots: string[] = []
const running: Array<{close: () => Promise<void>}> = []
const streams: Array<{close: () => void}> = []

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close()
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spike-a-events-'))
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

interface Booted {
  url: string
  root: string
  close(): Promise<void>
}

interface BeforeRenameHook {
  beforeRename(info: {tempPath: string; targetPath: string}): void | Promise<void>
}

async function boot(
  root: string,
  extra: {hooks?: BeforeRenameHook; watchIntervalMs?: number} = {},
): Promise<Booted> {
  const server = (await startOverlayServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    ...extra,
  })) as Booted
  running.push(server)
  return server
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Drain enough turns that "still nothing" means genuinely nothing. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

interface SseFrame {
  readonly id: string | undefined
  readonly event: string
  readonly data: Record<string, any>
}

interface SseStream {
  readonly frames: SseFrame[]
  readonly response: Response
  /** Every byte the server wrote, undecoded into frames. */
  rawText(): string
  /** True once the server ended the stream (or it was aborted). */
  ended(): boolean
  /** True when the read failed rather than reaching a clean end of stream. */
  errored(): boolean
  of(event: string): SseFrame[]
  close(): void
}

/**
 * A deliberately literal SSE reader.
 *
 * It splits on the blank-line frame terminator and joins multi-line `data:`
 * fields with `\n`, exactly as the HTML spec's event-stream parser does — so a
 * server that emitted a raw newline inside a payload would be *observed* here as
 * two frames rather than quietly repaired into one. That is the point: the
 * framing test needs a parser that can be fooled.
 */
async function openEvents(server: Booted, headers: Record<string, string> = {}): Promise<SseStream> {
  const controller = new AbortController()
  const response = await fetch(`${server.url}/events`, {
    headers: {origin: STUDIO_ORIGIN, accept: 'text/event-stream', ...headers},
    signal: controller.signal,
  })

  const frames: SseFrame[] = []
  let ended = false
  let errored = false
  let buffer = ''
  let raw = ''

  const pump = async (): Promise<void> => {
    const body = response.body
    if (body === null) {
      ended = true
      return
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      const text = decoder.decode(value, {stream: true})
      raw += text
      buffer += text
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseFrame(raw)
        if (frame !== null) frames.push(frame)
        boundary = buffer.indexOf('\n\n')
      }
    }
    ended = true
  }

  void pump().catch(() => {
    /* A destroyed socket surfaces here; a server that ended the response
     * properly reaches `done` inside `pump` instead. The two are deliberately
     * distinguishable — see the shutdown tests. */
    errored = true
    ended = true
  })

  const stream: SseStream = {
    frames,
    response,
    rawText: () => raw,
    ended: () => ended,
    errored: () => errored,
    of: (event) => frames.filter((frame) => frame.event === event),
    close: () => controller.abort(),
  }
  streams.push(stream)
  return stream
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return {id, event, data: JSON.parse(data.join('\n')) as Record<string, any>}
}

/* ------------------------------------------------------------------ *
 * On-disk oracles — never the server's own answer
 * ------------------------------------------------------------------ */

async function manifestRevision(root: string): Promise<number> {
  const raw = await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8')
  return (parse(raw) as {revision: number}).revision
}

function intentPath(root: string, logicalId: string): string {
  return join(root, '.sanity-overlay', 'documents', encodeLogicalId(logicalId), 'intent.json')
}

/* ------------------------------------------------------------------ *
 * Commit payloads (the same shapes `client.observable.action` sends)
 * ------------------------------------------------------------------ */

function baseArticle(id: string): Record<string, unknown> {
  return {
    _id: id,
    _type: 'article',
    _rev: `lake-rev-${id}`,
    _createdAt: '2025-12-01T00:00:00.000Z',
    _updatedAt: '2025-12-01T00:00:00.000Z',
    title: `Base ${id}`,
  }
}

function editBody(
  key: string,
  ids: readonly string[],
  title: string,
): Record<string, unknown> {
  return {
    idempotencyKey: key,
    kind: 'actions',
    payload: ids.map((id) => ({
      actionType: 'sanity.action.document.edit',
      draftId: `drafts.${id}`,
      publishedId: id,
      patch: {set: {title}},
    })),
    baseDocuments: ids.map(baseArticle),
  }
}

async function commit(server: Booted, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${server.url}/commit`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: STUDIO_ORIGIN},
    body: JSON.stringify(body),
  })
}

async function getState(server: Booted): Promise<Record<string, any>> {
  const response = await fetch(`${server.url}/state`, {headers: {origin: STUDIO_ORIGIN}})
  return (await response.json()) as Record<string, any>
}

/* ------------------------------------------------------------------ *
 * The stream itself
 * ------------------------------------------------------------------ */

describe('GET /events — the SSE bridge', () => {
  it('answers as an event stream, CORS-granted to the Studio origin', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)

    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get('content-type')).toMatch(/^text\/event-stream/)
    /* A proxy or a browser that buffered or compressed this would turn a live
     * bridge into a stalled one. */
    expect(stream.response.headers.get('cache-control')).toMatch(/no-cache/)
    expect(stream.response.headers.get('access-control-allow-origin')).toBe(STUDIO_ORIGIN)
  })

  it('opens with the revision that is actually on disk, so a client can detect a gap', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    const hello = stream.of('hello')[0]!
    expect(hello.data.overlayId).toBe(OVERLAY_ID)
    /* Independent oracle: the manifest, not the server's projection. */
    expect(hello.data.revision).toBe(await manifestRevision(server.root))
  })

  it('refuses a cross-origin subscriber the CORS grant', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server, {origin: 'http://evil.example'})
    expect(stream.response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('commit-origin events (PRD §14.4 step 8)', () => {
  it('emits document.changed naming the documents and the revision now on disk', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    const response = await commit(server, editBody('k1', ['article-1'], 'Edited once'))
    expect(response.status).toBe(200)

    await until(() => stream.of('document.changed').length === 1, 'the change frame')
    const frame = stream.of('document.changed')[0]!
    expect(frame.data.origin).toBe('commit')
    expect(frame.data.documentIds).toEqual(['article-1'])
    expect(frame.data.revision).toBe(await manifestRevision(server.root))
    expect(typeof frame.data.transactionId).toBe('string')
  })

  it('carries document IDs as a list, never as one joined string', async () => {
    /* The separator-joined-key hazard in its wire form. Two documents must be two
     * elements: a `documentIds` built by joining would be indistinguishable from
     * a single document whose ID contained the separator. The IDs below carry a
     * `-` and a `.` — both legal in a Sanity ID and both plausible separators. */
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await commit(server, editBody('k2', ['a-1.b', 'c-2.d'], 'Two at once'))
    await until(() => stream.of('document.changed').length === 1, 'the change frame')

    const ids = stream.of('document.changed')[0]!.data.documentIds
    expect(Array.isArray(ids)).toBe(true)
    expect([...ids].sort()).toEqual(['a-1.b', 'c-2.d'])
  })

  it('numbers frames strictly increasingly, so a client can order and gap-check them', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await commit(server, editBody('k3', ['article-1'], 'One'))
    await commit(server, editBody('k4', ['article-2'], 'Two'))
    await until(() => stream.of('document.changed').length === 2, 'both change frames')

    const ids = stream.frames.map((frame) => Number(frame.id))
    expect(ids.every((value) => Number.isInteger(value))).toBe(true)
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]!).toBeGreaterThan(ids[index - 1]!)
    }
  })

  it('broadcasts to every subscriber rather than handing the event to one', async () => {
    const server = await boot(await makeRoot())
    const first = await openEvents(server)
    const second = await openEvents(server)
    await until(
      () => first.of('hello').length === 1 && second.of('hello').length === 1,
      'both hello frames',
    )

    await commit(server, editBody('k5', ['article-1'], 'Broadcast'))
    await until(
      () => first.of('document.changed').length === 1 && second.of('document.changed').length === 1,
      'both change frames',
    )
    expect(first.of('document.changed')[0]!.data.revision).toBe(
      second.of('document.changed')[0]!.data.revision,
    )
  })
})

describe('durability precedes notification', () => {
  it('does not announce a commit the store has not finished writing', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holds = 0

    const server = await boot(await makeRoot(), {
      hooks: {
        async beforeRename({targetPath}) {
          /* Hold the FIRST intent rename only. Overlay creation renames the
           * manifest before any test edit exists, and holding that would deadlock
           * boot rather than test anything. */
          if (!targetPath.endsWith('intent.json') || holds > 0) return
          holds += 1
          await held
        },
      },
    })
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    const inFlight = commit(server, editBody('k6', ['article-1'], 'Held open'))
    await until(() => holds === 1, 'the store to reach the rename')
    await settle()

    /* The bytes are still in a temp file. Anything told to refetch now would read
     * the PREVIOUS state and cache it as current. */
    expect(stream.of('document.changed')).toHaveLength(0)

    release()
    const response = await inFlight
    expect(response.status).toBe(200)

    await until(() => stream.of('document.changed').length === 1, 'the change frame')
    /* And when it does arrive, the file it describes is readable at that revision. */
    expect(stream.of('document.changed')[0]!.data.revision).toBe(
      await manifestRevision(server.root),
    )
  })
})

describe('direct-edit events (PRD §14.3, §14.4 steps 2-10)', () => {
  it('announces a hand-edited intent.json against the file that is on disk', async () => {
    const server = await boot(await makeRoot(), {watchIntervalMs: 5})
    await commit(server, editBody('k7', ['article-1'], 'From Studio'))

    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    /* The §14.4 step 1 move: an agent edits the canonical file directly. */
    const path = intentPath(server.root, 'article-1')
    const intent = parse(await readFile(path, 'utf8')) as Record<string, any>
    const mutated = JSON.parse(JSON.stringify(intent))
    setTitleInIntent(mutated, 'From an agent')
    await writeFile(path, serialize(mutated), 'utf8')

    await until(
      () => stream.of('document.changed').some((frame) => frame.data.origin === 'direct-edit'),
      'the direct-edit frame',
    )
    const frame = stream
      .of('document.changed')
      .find((candidate) => candidate.data.origin === 'direct-edit')!
    expect(frame.data.documentIds).toEqual(['article-1'])
    expect(frame.data.revision).toBe(await manifestRevision(server.root))

    /* The event describes a durable change: the file it names really does hold
     * the new value, and it validated (§14.4 steps 3-4) or it would have arrived
     * as `overlay.invalid` instead. */
    expect(await readFile(path, 'utf8')).toContain('From an agent')
  })

  /**
   * The known limit, pinned so it cannot be quietly asserted away.
   *
   * `/state` is built from the IMMUTABLE record named by the manifest head
   * (`.runtime/revisions/<checksum>.json`). A direct edit rewrites `intent.json`
   * and touches neither, so the server's materialized projection is stale until
   * something replays intent + base snapshot back into a record — which needs
   * core's three-way merge engine and does not exist as a core export today
   * (`hydrateState` in `overlayServer.mjs` says as much).
   *
   * So the bridge tells the truth on the wire instead of pretending: a
   * commit-origin frame is `projection: "current"`, a direct-edit frame is
   * `projection: "stale"`. A consumer that reads the canonical files (the CLI,
   * a preview build) is fully served; a consumer that reads `/state` is told not
   * to trust it. Announcing a change while silently serving the old value would
   * be worse than no event — it would make the staleness look confirmed.
   */
  it('marks a direct-edit frame as stale projection, and a commit frame as current', async () => {
    const server = await boot(await makeRoot(), {watchIntervalMs: 5})
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await commit(server, editBody('k7b', ['article-1'], 'From Studio'))
    await until(() => stream.of('document.changed').length === 1, 'the commit frame')
    expect(stream.of('document.changed')[0]!.data.projection).toBe('current')

    const path = intentPath(server.root, 'article-1')
    const mutated = JSON.parse(
      JSON.stringify(parse(await readFile(path, 'utf8'))),
    ) as Record<string, any>
    setTitleInIntent(mutated, 'From an agent')
    await writeFile(path, serialize(mutated), 'utf8')

    await until(() => stream.of('document.changed').length === 2, 'the direct-edit frame')
    const frame = stream.of('document.changed')[1]!
    expect(frame.data.origin).toBe('direct-edit')
    expect(frame.data.projection).toBe('stale')

    /* And the claim is accurate — `/state` really has not caught up. If a future
     * intent→record replay lands, this assertion is what must change first. */
    const state = await getState(server)
    const document = state.documents.find((entry: any) => entry.logicalId === 'article-1')
    expect(document.draft.title).toBe('From Studio')
  })

  it('announces an unparseable file as invalid and keeps serving the last valid state', async () => {
    const server = await boot(await makeRoot(), {watchIntervalMs: 5})
    await commit(server, editBody('k8', ['article-1'], 'Valid title'))

    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await writeFile(intentPath(server.root, 'article-1'), '{ "logicalId": ', 'utf8')

    await until(() => stream.of('overlay.invalid').length >= 1, 'the invalid frame')
    const frame = stream.of('overlay.invalid')[0]!
    expect(frame.data.invalid[0].logicalId).toBe('article-1')
    expect(frame.data.invalid[0].ref).toContain('intent.json')

    /* §14.4 step 10 — refused, not served. */
    const state = await getState(server)
    const document = state.documents.find((entry: any) => entry.logicalId === 'article-1')
    expect(document.draft.title).toBe('Valid title')
  })

  it('reports a persistently broken file once, not once per poll', async () => {
    /* The watcher re-reads the same broken bytes every pass. Re-announcing them
     * would turn one bad file into an unbounded stream and drown every real
     * event behind it — the reason this is deduplicated on the CONTENT of the
     * finding rather than merely rate-limited. */
    const server = await boot(await makeRoot(), {watchIntervalMs: 1})
    await commit(server, editBody('k8b', ['article-1'], 'Valid title'))

    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await writeFile(intentPath(server.root, 'article-1'), '{ "logicalId": ', 'utf8')
    await until(() => stream.of('overlay.invalid').length >= 1, 'the invalid frame')
    for (let tick = 0; tick < 20; tick += 1) await settle()
    expect(stream.of('overlay.invalid')).toHaveLength(1)

    /* A DIFFERENT breakage is a new finding and is announced. */
    await writeFile(intentPath(server.root, 'article-1'), 'not json at all', 'utf8')
    await until(() => stream.of('overlay.invalid').length === 2, 'the second invalid frame')
  })

  it('stays quiet when nothing changed, so a poll is not a change', async () => {
    const server = await boot(await makeRoot(), {watchIntervalMs: 5})
    await commit(server, editBody('k9', ['article-1'], 'Untouched'))

    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    /* Long enough for many watcher passes over an unchanged tree. */
    for (let tick = 0; tick < 20; tick += 1) await settle()
    expect(stream.of('document.changed')).toHaveLength(0)
    expect(stream.of('overlay.invalid')).toHaveLength(0)
  })
})

/**
 * ## Why the injection carrier is the document ID and not the title
 *
 * The first version of this block put the SSE framing inside a document *title*
 * and asserted one frame came back. It passed against a deliberately broken
 * encoder, because no title ever reaches the frame — the payload carries IDs, a
 * revision and an origin. It was a tautology: green for reasons unrelated to
 * encoding.
 *
 * A document ID is the field that genuinely crosses the boundary. It is
 * caller-supplied, it is echoed into `documentIds`, and `encodeLogicalId`
 * percent-escapes only the FILENAME — the logical ID keeps whatever bytes the
 * caller sent, newlines included. So an interpolating encoder really would let a
 * caller forge an event, and this is what proves it does not.
 */
describe('frame integrity', () => {
  const INJECTION = 'x\n\nevent: document.changed\ndata: {"revision":9999}\n\n'

  it('cannot be made to forge an event through a document ID', async () => {
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await commit(server, editBody('k10', [INJECTION], 'Injected ID'))
    await until(() => stream.of('document.changed').length === 1, 'the change frame')
    await settle()

    /* One frame, carrying the ID verbatim — and no forged revision anywhere. */
    expect(stream.of('document.changed')).toHaveLength(1)
    expect(stream.of('document.changed')[0]!.data.documentIds).toEqual([INJECTION])
    expect(stream.frames.some((frame) => frame.data.revision === 9999)).toBe(false)
  })

  it('writes every payload as exactly one data line', async () => {
    /* The encoder property itself, asserted on the raw bytes rather than through
     * a parser that would helpfully rejoin what the server split. It holds for
     * whatever the payload grows into, which the test above cannot promise. */
    const server = await boot(await makeRoot())
    const stream = await openEvents(server)
    await until(() => stream.of('hello').length === 1, 'the hello frame')

    await commit(server, editBody('k11', [INJECTION, 'article-1'], 'Two, one injected'))
    await until(() => stream.of('document.changed').length === 1, 'the change frame')
    await settle()

    const dataLines = stream
      .rawText()
      .split('\n')
      .filter((line) => line.startsWith('data:'))
    expect(dataLines).toHaveLength(stream.frames.length)
    for (const line of dataLines) {
      /* Parses whole, on its own, with nothing spilled onto the next line. */
      expect(() => JSON.parse(line.slice('data:'.length))).not.toThrow()
    }
  })

  it('stores a title that looks like SSE framing without altering it', async () => {
    /* Not an SSE assertion — a store one. It keeps the injection strings above
     * honest by showing the pipeline does not sanitize content on the way in. */
    const server = await boot(await makeRoot())
    await commit(server, editBody('k12', ['article-1'], INJECTION))
    const raw = await readFile(intentPath(server.root, 'article-1'), 'utf8')
    expect(raw).toContain(JSON.stringify(INJECTION).slice(1, -1))
  })
})

describe('shutdown', () => {
  it('ends every open stream and resolves, leaving no work behind it', async () => {
    const server = await boot(await makeRoot(), {watchIntervalMs: 5})
    const first = await openEvents(server)
    const second = await openEvents(server)
    await until(
      () => first.of('hello').length === 1 && second.of('hello').length === 1,
      'both hello frames',
    )

    /* `close()` must resolve even though two responses are deliberately never
     * finished by the client: a stream held open by the server is exactly the
     * "async work outliving its caller" shape this repository has been bitten by,
     * and here it would hang `server.close()` forever. */
    running.splice(running.indexOf(server as never), 1)
    await server.close()

    await until(() => first.ended() && second.ended(), 'both streams to end')

    /* CLEANLY ended, not destroyed. `closeAllConnections()` would also unblock
     * `close()`, but it hands the subscriber a truncated read it cannot tell
     * from a crashed server — so it reconnects and refetches when it should have
     * stopped. It is also optional-chained here because it is a Node 18.2+ API:
     * ending the responses is what makes shutdown correct without it. */
    expect(first.errored()).toBe(false)
    expect(second.errored()).toBe(false)
  })

  it('stops watching after close, so a deleted root is never polled', async () => {
    const root = await makeRoot()
    const server = await boot(root, {watchIntervalMs: 1})
    const errors: unknown[] = []
    process.on('unhandledRejection', collect)
    function collect(error: unknown): void {
      errors.push(error)
    }

    try {
      running.splice(running.indexOf(server as never), 1)
      await server.close()
      await rm(root, {recursive: true, force: true})
      roots.splice(roots.indexOf(root), 1)
      for (let tick = 0; tick < 20; tick += 1) await settle()
      expect(errors).toEqual([])
    } finally {
      process.off('unhandledRejection', collect)
    }
  })
})

/**
 * Rewrite the `title` override the intent already carries (PRD §14.2
 * `OverlayIntentState.overrides`), the way a hand-editing agent would.
 *
 * It asserts it found one: an edit that silently changed nothing would make the
 * watcher correctly report no change, and the test would then be pinning the
 * helper's failure rather than the bridge's behaviour.
 */
function setTitleInIntent(intent: Record<string, any>, title: string): void {
  let hits = 0
  for (const version of [intent.draft, intent.published]) {
    for (const override of version?.overrides ?? []) {
      if (Array.isArray(override?.path) && override.path[0] === 'title') {
        override.value = title
        hits += 1
      }
    }
  }
  expect(hits).toBeGreaterThan(0)
}
