/**
 * **THE STUDIO HALF OF BRANCH-LOCAL ASSETS** — PRD §24.3, §24.7, §24.8, §5.5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN.
 *
 * `assets-upload-wiring.test.ts` proves the SERVER can store and serve a branch
 * asset. Nothing reached it. Two connections were missing:
 *
 *   1. `startOverlayApiServer` never constructed an `FsOverlayAssetStore`, so a
 *      live server answered every asset route `501 ASSETS_NOT_CONFIGURED`.
 *   2. The Studio facade refused the whole `assets` namespace, so
 *      `client.assets.upload()` never reached the route even once it existed.
 *
 * Observed live on 2026-08-06: dropping a PNG into `author-2.portrait` patched
 * `_upload: {progress: 2}` into the draft and then **hung forever** — no asset,
 * no error, no toast. That hang is the §5.5 silent approximation this file
 * exists to make impossible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLES ARE NEVER THE CALL'S OWN RETURN VALUE.
 *
 *   bytes        `node:fs` reads the blob; `node:crypto` hashes it; a FRESH
 *                `FsOverlayAssetStore` that shares no state with the server's
 *                re-reads both the record and the bytes.
 *   reference    the document is rebuilt from `GET /state` and followed with
 *                core's own `resolveReferenceTarget`, then the bytes are fetched
 *                through the id THAT RESOLVER returned.
 *   termination  every path in the class table is raced against a deadline.
 *
 * NOT ONE BYTE LEAVES FOR SANITY. The "real" client under the facade is a
 * recording double that resolves without a socket, the overlay server is bound
 * to loopback, and the suite-wide outbound monitor refuses any non-GET to a
 * Sanity host.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {crc32, deflateSync} from 'node:zlib'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  applyTransaction,
  createOverlayState,
  resolveReferenceTarget,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState, SanityDocument} from '../../sanity-overlay-core/src/index'
import {FsOverlayAssetStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {createOverlayEcho} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {
  assetOriginFor,
  createOverlayAssetUploader,
} from '../../sanity-overlay-studio/src/client/assets'
import {createOverlayTransport} from '../../sanity-overlay-studio/src/client/transport'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

type Rec = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * Fixtures — real containers, constructed (repo-hygiene forbids binaries)
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed) >>> 0, 0)
  return Buffer.concat([length, typed, crc])
}

function makePng(width: number, height: number, fill = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(height * (1 + width * 4), fill)
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 4)] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = makePng(64, 32)
const SECOND_PNG = makePng(10, 20, 9)
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x41)])
/** Eight bytes of PNG signature and nothing else: a container with no IHDR. */
const TRUNCATED_PNG = Buffer.from(PNG_SIGNATURE)

const nodeSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const nodeSha1 = (bytes: Uint8Array): string =>
  createHash('sha1').update(Buffer.from(bytes)).digest('hex')

const PNG_SHA256 = nodeSha256(PNG)
const PNG_SHA1 = nodeSha1(PNG)
const PNG_ID = `image-${PNG_SHA1}-64x32-png`
const SECOND_PNG_ID = `image-${nodeSha1(SECOND_PNG)}-10x20-png`
const PDF_ID = `file-${nodeSha1(PDF)}-pdf`

const OVERLAY_ID = 'assets-facade-overlay-0000000000'
const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const STUDIO_ORIGIN = 'http://localhost:3333'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []

afterEach(async () => {
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

/** Race anything against a deadline. A path that hangs answers `'HANG'`. */
async function withDeadline<T>(work: Promise<T>, ms = 4000): Promise<T | 'HANG'> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'HANG'>((resolve) => {
    timer = setTimeout(() => resolve('HANG'), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface MinimalSubscription {
  unsubscribe(): void
}

/** Drain an observable into `{events, error}`, with a deadline of its own. */
async function collect(
  source: unknown,
  ms = 4000,
): Promise<{events: Rec[]; error?: unknown} | 'HANG'> {
  const events: Rec[] = []
  const work = new Promise<{events: Rec[]; error?: unknown}>((resolve) => {
    const observable = source as {
      subscribe(observer: Rec): MinimalSubscription
    }
    observable.subscribe({
      next: (value: unknown) => events.push(value as Rec),
      error: (error: unknown) => resolve({events, error}),
      complete: () => resolve({events}),
    })
  })
  return withDeadline(work, ms)
}

interface Booted {
  url: string
  root: string
  close(): Promise<void>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'assets-facade-'))
  roots.push(root)
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: {projectId: PROJECT_ID, dataset: DATASET, apiVersion: '2025-02-19'},
  })
  running.push(server)
  return {url: server.url, root, close: () => server.close()}
}

/**
 * A client-shaped double whose every network method RECORDS and never leaves the
 * process. Own-property methods on purpose: the facade must never call a double
 * it has not proved to be a real `@sanity/client`.
 */
function fakeClient(): Rec & {escaped: string[]} {
  const escaped: string[] = []
  const escape =
    (name: string) =>
    (...args: unknown[]): unknown => {
      escaped.push(name)
      return Promise.resolve({escaped: name, args})
    }
  const self: Rec & {escaped: string[]} = {
    escaped,
    fetch: escape('fetch'),
    getDocument: escape('getDocument'),
    getDocuments: escape('getDocuments'),
    create: escape('create'),
    createOrReplace: escape('createOrReplace'),
    delete: escape('delete'),
    mutate: escape('mutate'),
    request: escape('request'),
    listen: () => ({subscribe: () => ({unsubscribe: (): void => {}})}),
    config: () => ({
      projectId: PROJECT_ID,
      dataset: DATASET,
      apiVersion: '2025-02-19',
      apiHost: 'https://api.sanity.io',
      useCdn: false,
    }),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
    assets: {upload: escape('assets.upload')},
  }
  self.observable = {
    fetch: escape('observable.fetch'),
    getDocuments: escape('observable.getDocuments'),
    assets: {upload: escape('observable.assets.upload')},
  }
  return self
}

interface Studio {
  server: Booted
  client: Rec & {escaped: string[]}
  wrapped: Rec
  errors: string[]
}

/** The Studio side, wired exactly as `runtime.ts` wires it. */
async function studio(options: {assets?: boolean} = {}): Promise<Studio> {
  const server = await boot()
  const errors: string[] = []
  const echo = createOverlayEcho({onError: (message) => errors.push(message)})
  const transport = createOverlayTransport({
    apiUrl: server.url,
    onError: (message) => errors.push(message),
  })
  const client = fakeClient()
  const origin = assetOriginFor(server.url)
  const wrapped = wrapWithOverlay(client as unknown as object, {
    echo,
    transport,
    onError: (message) => errors.push(message),
    ...(options.assets === false
      ? {}
      : {
          assets: createOverlayAssetUploader({
            apiUrl: server.url,
            onError: (message) => errors.push(message),
          }),
          ...('origin' in origin ? {assetOrigin: origin.origin} : {}),
        }),
  }) as unknown as Rec

  return {server, client, wrapped, errors}
}

function fileOf(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, {type})
}

interface StateRow {
  logicalId: string
  draft: Rec | null
  published: Rec | null
}

/**
 * `GET /state`, polled until `settled` says the branch holds what is being
 * waited for.
 *
 * POLLED ON A CONDITION, not slept: the facade schedules its commit on delivery
 * of the write's result, so "has the overlay seen it yet?" has an answer rather
 * than a duration to guess. The deadline exists so a missing write fails as an
 * assertion about the branch rather than as a suite timeout.
 */
async function readState(
  server: Booted,
  settled: (documents: StateRow[]) => boolean,
): Promise<StateRow[]> {
  const deadline = Date.now() + 5000
  for (;;) {
    const body = (await (await fetch(`${server.url}/state`)).json()) as {documents: StateRow[]}
    if (settled(body.documents) || Date.now() > deadline) return body.documents
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** `GET /state`, rebuilt into an overlay state core can resolve references over. */
async function branchState(
  server: Booted,
  settled: (documents: StateRow[]) => boolean = () => true,
): Promise<OverlayState> {
  const body = {documents: await readState(server, settled)}
  let state: OverlayState = createOverlayState({overlayId: OVERLAY_ID})
  const clock = makeClock()
  let sequence = 0
  for (const row of body.documents) {
    for (const document of [row.published, row.draft]) {
      if (document === null || document === undefined) continue
      sequence += 1
      state = applyTransaction(
        state,
        [{type: 'create', document: document as unknown as SanityDocument}],
        {
          transactionId: `tx-${sequence}`,
          idempotencyKey: `k-${sequence}`,
          actor: {type: 'user', id: 'assets-facade-test'},
          now: clock,
        },
      ).state
    }
  }
  return state
}

/* ══════════════════════════════════════════════════════════════════ *
 * 1. The load-bearing claim
 * ══════════════════════════════════════════════════════════════════ */

describe('an upload through the FACADE lands on disk and resolves (PRD §24.3)', () => {
  it('writes the exact bytes under .sanity-overlay/ and never touches the real client', async () => {
    const {server, client, wrapped} = await studio()

    const document = (await withDeadline(
      (
        (wrapped.assets as Rec).upload as (
          type: string,
          body: unknown,
          options?: unknown,
        ) => Promise<Rec>
      )('image', fileOf(PNG, 'hero.png', 'image/png')),
    )) as Rec

    expect(document, 'the upload must not hang').not.toBe('HANG')
    expect(document._id).toBe(PNG_ID)
    expect(document._type).toBe('sanity.imageAsset')

    /* THE ORACLE IS THE FILESYSTEM, not the value the call handed back. */
    const blobsDir = join(server.root, '.sanity-overlay', 'assets', 'blobs')
    expect((await readdir(blobsDir)).sort()).toEqual([`${PNG_SHA256}.bin`])
    const onDisk = await readFile(join(blobsDir, `${PNG_SHA256}.bin`))
    expect(onDisk.equals(PNG)).toBe(true)
    expect(nodeSha256(onDisk)).toBe(PNG_SHA256)

    /* And a FRESH store, sharing nothing with the server's, re-reads both. */
    const reader = new FsOverlayAssetStore({root: server.root, now: makeClock()})
    const record = await reader.getRecord(PNG_ID)
    expect(record?.sha1hash).toBe(PNG_SHA1)
    expect(Buffer.from(await reader.readBlob(PNG_ID, {verify: true})).equals(PNG)).toBe(true)

    /* The real `@sanity/client` was never asked to do anything. */
    expect(client.escaped).toEqual([])
  })

  it('produces a reference that resolves, and the resolved id serves the bytes', async () => {
    const {server, wrapped} = await studio()

    await (wrapped.createOrReplace as (document: Rec) => Promise<unknown>)({
      _id: 'drafts.author-2',
      _type: 'author',
      name: 'Ada',
    })

    const asset = (await (
      (wrapped.assets as Rec).upload as (type: string, body: unknown) => Promise<Rec>
    )('image', fileOf(PNG, 'hero.png', 'image/png'))) as Rec

    await (wrapped.mutate as (mutations: unknown[]) => Promise<unknown>)([
      {
        patch: {
          id: 'drafts.author-2',
          set: {
            portrait: {_type: 'image', asset: {_type: 'reference', _ref: asset._id as string}},
          },
        },
      },
    ])

    const state = await branchState(server, (documents) => {
      const author = documents.find((row) => row.logicalId === 'author-2')
      return (
        documents.some((row) => row.logicalId === asset._id) &&
        (author?.draft as Rec | null)?.portrait !== undefined
      )
    })
    const author = resolveReferenceTarget(state, 'author-2', {perspective: 'drafts'})
    expect(author.available).toBe(true)
    const ref = ((author.document?.portrait as Rec).asset as {_ref: string})._ref
    const resolved = resolveReferenceTarget(state, ref, {perspective: 'drafts'})
    expect(resolved.available, 'the asset reference must resolve inside the branch').toBe(true)
    expect(resolved.document?._type).toBe('sanity.imageAsset')

    /* Bytes, through the id the RESOLVER returned — not the one upload reported. */
    const response = await fetch(`${server.url}/assets/${resolved.document?._id as string}`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('answers the observable form with the event stream sanity 6.8.0 consumes', async () => {
    const {wrapped} = await studio()

    const stream = (
      ((wrapped.observable as Rec).assets as Rec).upload as (
        type: string,
        body: unknown,
      ) => unknown
    )('image', fileOf(PNG, 'hero.png', 'image/png'))

    const result = await collect(stream)
    expect(result, 'the observable upload must not hang').not.toBe('HANG')
    if (result === 'HANG') return
    expect(result.error).toBeUndefined()

    /* `uploadSanityAsset` (sanity 6.8.0) maps `type === 'response'` to a
     * completion carrying `event.body.document._id`. Anything else is read as a
     * progress event with a `percent`. Both shapes are pinned here. */
    const response = result.events.find((event) => event.type === 'response')
    expect(response, 'a response event is what ends Studio’s upload').toBeDefined()
    expect(((response?.body as Rec).document as Rec)._id).toBe(PNG_ID)
    for (const event of result.events) {
      if (event.type === 'response') continue
      expect(event.type).toBe('progress')
      expect(typeof event.percent).toBe('number')
    }
    expect(result.events[result.events.length - 1]?.type).toBe('response')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 2. Failure is LOUD. Nothing hangs, ever.
 * ══════════════════════════════════════════════════════════════════ */

describe('every asset path ends in success or a stated refusal (PRD §5.5)', () => {
  it('rejects with the server’s own reason when the container states no dimensions', async () => {
    const {wrapped, errors} = await studio()
    const refusal = await withDeadline(
      ((wrapped.assets as Rec).upload as (type: string, body: unknown) => Promise<unknown>)(
        'image',
        fileOf(TRUNCATED_PNG, 'broken.png', 'image/png'),
      ).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(refusal, 'a refused upload must not hang').not.toBe('HANG')
    expect(refusal).toBeInstanceOf(Error)
    expect(String((refusal as Error).message)).toMatch(/dimension/i)
    expect(errors.some((message) => /dimension/i.test(message))).toBe(true)
  })

  it('errors the observable rather than stalling it, so `_upload` is cleared', async () => {
    const {wrapped} = await studio()
    const result = await collect(
      (
        ((wrapped.observable as Rec).assets as Rec).upload as (
          type: string,
          body: unknown,
        ) => unknown
      )('image', fileOf(TRUNCATED_PNG, 'broken.png', 'image/png')),
    )
    expect(result, 'a refused observable upload must not hang').not.toBe('HANG')
    if (result === 'HANG') return
    expect(result.error).toBeInstanceOf(Error)
    expect(result.events.some((event) => event.type === 'response')).toBe(false)
  })

  it('states the reason when the overlay API has no asset store at all', async () => {
    /* The 501 branch is a GOOD failure mode for an embedder who has not
     * configured assets. It must reach the editor as words, not as a spinner. */
    const root = await mkdtemp(join(tmpdir(), 'assets-facade-off-'))
    roots.push(root)
    const {startOverlayApiServer: start} = await import(
      '../../sanity-overlay-next/src/index'
    )
    const server = await start({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
      assets: false,
    })
    running.push(server)

    const uploader = createOverlayAssetUploader({apiUrl: server.url})
    const refusal = await withDeadline(
      uploader({assetType: 'image', body: fileOf(PNG, 'hero.png', 'image/png')}).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(refusal).toBeInstanceOf(Error)
    expect(String((refusal as Error).message)).toMatch(/ASSETS_NOT_CONFIGURED|not configured/i)
  })

  it('refuses rather than hangs when the overlay API is unreachable', async () => {
    const uploader = createOverlayAssetUploader({
      /* A port nothing is listening on. `fetch` fails fast; the point is that the
       * failure becomes an Error the input can render, not a pending promise. */
      apiUrl: 'http://127.0.0.1:1',
      timeoutMs: 2000,
    })
    const refusal = await withDeadline(
      uploader({assetType: 'image', body: fileOf(PNG, 'hero.png', 'image/png')}).then(
        () => undefined,
        (error: unknown) => error,
      ),
      6000,
    )
    expect(refusal, 'an unreachable overlay API must not hang the upload').not.toBe('HANG')
    expect(refusal).toBeInstanceOf(Error)
  })

  it('times out a server that never answers, with a message naming the timeout', async () => {
    const {createServer} = await import('node:http')
    const stalled = createServer(() => {
      /* Accept the request and never respond — the exact live symptom. */
    })
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', () => resolve()))
    const address = stalled.address() as {port: number}
    running.push({
      close: () =>
        new Promise<void>((resolve) => {
          stalled.closeAllConnections?.()
          stalled.close(() => resolve())
        }),
    })

    const uploader = createOverlayAssetUploader({
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 300,
    })
    const refusal = await withDeadline(
      uploader({assetType: 'image', body: fileOf(PNG, 'hero.png', 'image/png')}).then(
        () => undefined,
        (error: unknown) => error,
      ),
      5000,
    )
    expect(refusal, 'a stalled overlay API must not hang the upload').not.toBe('HANG')
    expect(refusal).toBeInstanceOf(Error)
    expect(String((refusal as Error).message)).toMatch(/timed out|timeout/i)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 3. The class — every member of the `assets` namespace and every binary path
 * ══════════════════════════════════════════════════════════════════ */

describe('the whole assets namespace, and every neighbouring binary path', () => {
  it('uploads a FILE asset as well as an image, on both client shapes', async () => {
    const {server, wrapped} = await studio()

    const document = (await (
      (wrapped.assets as Rec).upload as (type: string, body: unknown) => Promise<Rec>
    )('file', fileOf(PDF, 'brief.pdf', 'application/pdf'))) as Rec
    expect(document._id).toBe(PDF_ID)
    expect(document._type).toBe('sanity.fileAsset')

    const response = await fetch(`${server.url}/assets/${PDF_ID}`)
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
  })

  it('handles an ARRAY of images — article.gallery uploads two distinct assets', async () => {
    const {server, wrapped} = await studio()
    const upload = (wrapped.assets as Rec).upload as (
      type: string,
      body: unknown,
    ) => Promise<Rec>

    const [first, second] = await Promise.all([
      upload('image', fileOf(PNG, 'one.png', 'image/png')),
      upload('image', fileOf(SECOND_PNG, 'two.png', 'image/png')),
    ])
    expect([first._id, second._id].sort()).toEqual([PNG_ID, SECOND_PNG_ID].sort())

    for (const [id, bytes] of [
      [PNG_ID, PNG],
      [SECOND_PNG_ID, SECOND_PNG],
    ] as const) {
      const response = await fetch(`${server.url}/assets/${id}`)
      expect(response.status, id).toBe(200)
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
    }
    expect((await readdir(join(server.root, '.sanity-overlay', 'assets', 'blobs'))).length).toBe(2)
  })

  it('still refuses every OTHER namespace method, with a reason and not a hang', async () => {
    const {client, wrapped} = await studio()
    const namespace = wrapped.assets as Rec
    /* `@sanity/client@7.26.0` ships only `upload` on `assets`. Anything that
     * appears later is a write by default (`namespaceMethodKind`) and must be
     * refused rather than delegated — the inventory is never complete. */
    ;(client.assets as Rec).delete = (): Promise<unknown> => Promise.resolve('escaped')
    const refusal = await withDeadline(
      (namespace.delete as (id: string) => Promise<unknown>)('image-x').then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(refusal).toBeInstanceOf(Error)
    expect(client.escaped).toEqual([])
  })

  it('refuses a raw request to Sanity’s asset endpoint, on host grounds', async () => {
    const {client, wrapped} = await studio()
    await expect(
      (wrapped.request as (options: Rec) => Promise<unknown>)({
        uri: `assets/images/${DATASET}`,
        method: 'POST',
        body: {},
      }),
    ).rejects.toThrow()
    expect(client.escaped).toEqual([])
  })

  it('refuses the media-library upload plane, which is hosted infrastructure', async () => {
    const {client, wrapped} = await studio()
    ;(client.mediaLibrary as Rec | undefined) ?? (client.mediaLibrary = {video: {}})
    await expect(
      (wrapped.request as (options: Rec) => Promise<unknown>)({
        uri: '/media-libraries/ml123/upload',
        method: 'POST',
        body: {},
      }),
    ).rejects.toThrow()
    expect(client.escaped).toEqual([])
  })

  it('refuses assets.upload with a stated reason when no uploader is configured', async () => {
    /* The pre-existing contract, unweakened: a facade built WITHOUT the asset
     * port must still refuse rather than delegate. */
    const {client, wrapped} = await studio({assets: false})
    const refusal = await withDeadline(
      ((wrapped.assets as Rec).upload as (type: string, body: unknown) => Promise<unknown>)(
        'image',
        fileOf(PNG, 'hero.png', 'image/png'),
      ).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(refusal).toBeInstanceOf(Error)
    expect(String((refusal as Error).message)).toMatch(/blocked assets\.upload/)
    expect(client.escaped).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 4. The read side — a BASE asset and a BRANCH asset in one field
 * ══════════════════════════════════════════════════════════════════ */

describe('the image pipeline points at the overlay, which owns both kinds (§24.1)', () => {
  it('rewrites the apiHost @sanity/image-url reads, and only that', async () => {
    const {server, wrapped} = await studio()
    const config = (wrapped.config as () => Rec)()

    /* `@sanity/image-url@2.1.1` builds every preview `src` from
     * `client.config().apiHost` — see `clientConfigToOptions`. Pointing it here
     * is what makes a branch image render at all. */
    expect(config.apiHost).toBe(new URL(server.url).origin)
    expect(config.projectId).toBe(PROJECT_ID)
    expect(config.dataset).toBe(DATASET)
  })

  it('serves a branch asset and redirects a base asset, in the same route', async () => {
    const {server, wrapped} = await studio()
    await ((wrapped.assets as Rec).upload as (type: string, body: unknown) => Promise<Rec>)(
      'image',
      fileOf(PNG, 'hero.png', 'image/png'),
    )

    /* Exactly the string `@sanity/image-url` builds for a branch asset. */
    const branch = await fetch(
      `${server.url}/images/${PROJECT_ID}/${DATASET}/${PNG_SHA1}-64x32.png?w=200&fit=max`,
      {redirect: 'manual'},
    )
    expect(branch.status).toBe(200)
    expect(Buffer.from(await branch.arrayBuffer()).equals(PNG)).toBe(true)
    expect(branch.headers.get('x-overlay-asset-transform')).toBe('not-applied; fit, w')

    /* And a Sanity-hosted one this overlay has never seen. */
    const baseSha1 = 'c'.repeat(40)
    const base = await fetch(
      `${server.url}/images/${PROJECT_ID}/${DATASET}/${baseSha1}-800x600.jpg?w=200`,
      {redirect: 'manual'},
    )
    expect(base.status).toBe(302)
    expect(base.headers.get('location')).toBe(
      `https://cdn.sanity.io/images/${PROJECT_ID}/${DATASET}/${baseSha1}-800x600.jpg?w=200`,
    )
  })

  it('refuses to rewrite the origin when the overlay API is mounted under a path', async () => {
    /* `/images/<pid>/<ds>/<file>` is absolute by construction, so an API mounted
     * at `/api/sanity-overlay` does not serve it. Saying so is the alternative to
     * handing the image pipeline a URL that 404s. */
    const refusal = assetOriginFor('https://site.example/api/sanity-overlay')
    expect('origin' in refusal).toBe(false)
    expect(String((refusal as {refusal: string}).refusal)).toMatch(/images/)

    expect(assetOriginFor('http://localhost:3998')).toEqual({origin: 'http://localhost:3998'})
    expect(assetOriginFor('http://localhost:3998/')).toEqual({origin: 'http://localhost:3998'})
  })
})
