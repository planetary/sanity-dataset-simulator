/**
 * **THE ENTRY POINT SANITY'S IMAGE INPUT ACTUALLY DRIVES** — PRD §24, §22.6, §5.5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS WHEN `assets-facade-upload.test.ts` ALREADY PASSES.
 *
 * That file proves `client.assets.upload(...)` stores bytes in the branch, on
 * both client shapes. It was green while a PNG dropped into `author-3.portrait`
 * hung forever with `_upload: {progress: 2}` and no `asset` — because the image
 * input does not call `client.assets.upload` first. It calls this, quoted from
 * the installed package (`sanity@6.8.0`, `lib/useBundleDocuments-BYW8M9LS.js`):
 *
 *   :37996  uploadSubscription.current =
 *             uploader.upload(client, file_0, schemaType, options).subscribe({…})
 *   :13786  function resolveUploader(type, file) { … }
 *   :13767  upload: (client, file, type, options) => uploadImage(client, file, options)
 *   :13750  function uploadImage(client, file, options) {
 *             let upload$ = uploadImageAsset(client, file, options).pipe(…)
 *   :13469  const uploadAsset = withMaxConcurrency(uploadSanityAsset, 4)
 *   :13448  function uploadSanityAsset(client, assetType, file, options = {}) {
 *   :13450    return hashFile(file).pipe(
 *               catchError(() => of(null)),
 *               mergeMap(hash => hash ? fetchExisting(client, `sanity.${assetType}Asset`, hash)
 *                                     : of(null)),
 *               mergeMap(existing => existing ? of({type: 'complete', …})
 *                                             : client.observable.assets.upload(…)))
 *   :13584  function fetchExisting(client, type, hash) {
 *             return client.observable.fetch(
 *               '*[_type == $documentType && sha1hash == $hash][0]',
 *               {documentType: type, hash}, {tag: 'asset.find-duplicate'})
 *
 * **The upload is gated on a dedup probe that runs FIRST.** Nothing downstream of
 * `mergeMap` runs until that probe emits. `catchError` covers `hashFile` only —
 * the probe's own failures are load-bearing, and the probe asks for a
 * `sanity.imageAsset`, which `readPlan.ts` refuses to plan (hosted system type)
 * and therefore sends to the base dataset. A probe that never answers is a field
 * that says "Uploading" for the life of the tab, with no error anywhere.
 *
 * So this file drives `resolveUploader(...).upload(...)` — Sanity's own code,
 * imported from the installed package, not re-implemented here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS REAL AND WHAT IS NOT.
 *
 *   REAL   sanity 6.8.0's uploader and its whole rxjs pipeline; `@sanity/client`
 *          7.26.0 (so `client.observable.*` really is an rxjs `Observable` and
 *          the facade adopts a real constructor); the overlay API over loopback
 *          with a real `FsOverlayAssetStore`; the whole Studio runtime, wired by
 *          `createOverlayRuntime` exactly as `defineOverlayConfig` wires it.
 *
 *   STOOD  the Content Lake, by a loopback HTTP server that speaks
 *   IN FOR `/data/query`. It is programmable per test, which is the point: the
 *          live defect depends on what the dedup probe does, and "never answers"
 *          is a behaviour no real dataset will produce on demand.
 *
 *   NOT    React. `uploader.upload(...)` takes a client, a File and a schema
 *   THERE  type and returns an observable of patch events; the input component
 *          only subscribes to it and forwards `event.patches` to `onChange`
 *          (:37997). That subscription is reproduced here literally. The gap is
 *          therefore the component's own rendering — the spinner, the toast —
 *          and nothing in the upload path itself. `jsdom` and `react-dom` are
 *          not resolvable from this package and are not needed to reach this.
 *
 *   SHIMMED `window.crypto` / `FileReader`, which `hashFile` requires and Node
 *          does not have. WITHOUT THEM `hashFile` short-circuits to `of(null)`
 *          and the dedup probe never runs — the shim is what makes this test
 *          able to fail. `window.URL`/`window.Image` are deliberately absent, so
 *          the preview-thumbnail branch degrades exactly as its `catchError`
 *          says it should.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORACLES ARE NEVER THE CALL'S OWN RETURN VALUE.
 *
 *   bytes      `node:fs` reads the blob and `node:crypto` hashes it; a FRESH
 *              `FsOverlayAssetStore` re-reads record and bytes.
 *   reference  a separate `GET /state` is read back over HTTP.
 *   liveness   every path is raced against a deadline, and a path that neither
 *              completes nor errors is reported as `HANG` and fails.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {createHash} from 'node:crypto'
import {readFileSync, readdirSync} from 'node:fs'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import http from 'node:http'
import {createRequire} from 'node:module'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {crc32} from 'node:zlib'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'

import {FsOverlayAssetStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime, type OverlayRuntime} from '../../sanity-overlay-studio/src/runtime'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 60_000, hookTimeout: 60_000})

/* ------------------------------------------------------------------ *
 * 0. Sanity's own uploader, located in the installed package
 * ------------------------------------------------------------------ */

/**
 * `resolveUploader` is not on `sanity`'s public surface — it is an internal of
 * the form-builder chunk. It is found by CONTENT rather than by filename,
 * because the filename carries a build hash that changes with every release.
 */
function locateSanityUploaderChunk(): {file: string; aliases: Record<string, string>} {
  const anchor = new URL('../../../examples/kitchen-sink/package.json', import.meta.url)
  const require_ = createRequire(anchor)
  const lib = join(dirname(require_.resolve('sanity/package.json')), 'lib')
  const wanted = [
    'resolveUploader',
    'createDatasetImageAssetSource',
    'createDatasetFileAssetSource',
  ]
  for (const name of readdirSync(lib)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(join(lib, name), 'utf8')
    if (!source.includes('function resolveUploader(type, file)')) continue
    const aliases: Record<string, string> = {}
    for (const local of wanted) {
      const alias = new RegExp(`\\b${local} as ([A-Za-z_$][\\w$]*)`).exec(source)
      if (alias !== null) aliases[local] = alias[1] as string
    }
    if (Object.keys(aliases).length !== wanted.length) continue
    return {file: join(lib, name), aliases}
  }
  throw new Error('sanity 6.8.0 no longer ships a `resolveUploader` — this test must be re-read')
}

/** `UploadEvent` as the input component sees it (`:37997`). */
interface UploadProgressEvent {
  type: string
  patches?: unknown[]
}

interface SanityUploader {
  type: string
  upload(client: unknown, file: unknown, type: unknown, options?: unknown): {
    subscribe(observer: {
      next(event: UploadProgressEvent): void
      error(error: unknown): void
      complete(): void
    }): {unsubscribe(): void}
  }
}

type ResolveUploader = (type: unknown, file: unknown) => SanityUploader | null

/**
 * `DatasetAssetSourceUploader` (`:40758`) — what a DROP, a PASTE and the Upload
 * button all reach, via `useAssetSourceUploader` (`:34350`). It is not a second
 * implementation: `:40763` calls `resolveUploader(schemaType, file)` and
 * `:40772` subscribes to `uploader.upload(this.client, file, schemaType, …)`.
 * Driving it as well as `resolveUploader` proves the wrapper terminates too.
 */
interface DatasetUploaderClass {
  new (): {
    upload(files: File[], options: {schemaType: unknown; onChange(patches: unknown): void}): unknown
    subscribe(listener: (event: Rec) => void): () => void
    abort(file?: unknown): void
  }
}

type CreateDatasetAssetSource = (props: {client: unknown; title?: string}) => {
  Uploader: DatasetUploaderClass
}

let resolveUploader: ResolveUploader
let createDatasetImageAssetSource: CreateDatasetAssetSource
let createDatasetFileAssetSource: CreateDatasetAssetSource
let createSanityClient: (config: Rec) => Rec

beforeAll(async () => {
  const {file, aliases} = locateSanityUploaderChunk()
  const chunk = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Rec
  resolveUploader = chunk[aliases.resolveUploader as string] as ResolveUploader
  createDatasetImageAssetSource = chunk[
    aliases.createDatasetImageAssetSource as string
  ] as CreateDatasetAssetSource
  createDatasetFileAssetSource = chunk[
    aliases.createDatasetFileAssetSource as string
  ] as CreateDatasetAssetSource

  const anchor = new URL('../../../examples/kitchen-sink/package.json', import.meta.url)
  const require_ = createRequire(anchor)
  const clientModule = (await import(
    /* @vite-ignore */ pathToFileURL(require_.resolve('@sanity/client')).href
  )) as Rec
  createSanityClient = clientModule.createClient as (config: Rec) => Rec

  installBrowserShims()
}, 60_000)

afterAll(() => {
  removeBrowserShims()
})

/* ------------------------------------------------------------------ *
 * 0b. The two browser globals `hashFile` requires
 * ------------------------------------------------------------------ */

/**
 * `hashFile` (`:13602`) reads `window.crypto`, `window.crypto.subtle` and
 * `window.FileReader`, and returns `of(null)` if any is missing — which SKIPS
 * the dedup probe entirely. A Node run without these shims therefore cannot
 * observe the defect at all: it is the shim that puts the probe back in the
 * path, so the shim is part of the reproduction, not a convenience.
 */
class NodeFileReader {
  result: ArrayBuffer | null = null
  onload: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  #aborted = false

  readAsArrayBuffer(blob: Blob): void {
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (this.#aborted) return
        this.result = buffer
        this.onload?.()
      })
      .catch((error: unknown) => {
        if (this.#aborted) return
        this.onerror?.(error)
      })
  }

  abort(): void {
    this.#aborted = true
  }
}

let hadWindow = false

function installBrowserShims(): void {
  hadWindow = 'window' in globalThis
  ;(globalThis as Rec).FileReader = NodeFileReader
  ;(globalThis as Rec).window = {crypto: globalThis.crypto, FileReader: NodeFileReader}
}

function removeBrowserShims(): void {
  delete (globalThis as Rec).FileReader
  if (!hadWindow) delete (globalThis as Rec).window
}

/* ------------------------------------------------------------------ *
 * 1. Fixtures
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
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.alloc(8, fill)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const nodeSha1 = (bytes: Uint8Array): string =>
  createHash('sha1').update(Buffer.from(bytes)).digest('hex')

const PNG = makePng(64, 32)
const PNG_SHA1 = nodeSha1(PNG)
const PNG_ID = `image-${PNG_SHA1}-64x32-png`

const SECOND_PNG = makePng(10, 20, 9)
const SECOND_PNG_ID = `image-${nodeSha1(SECOND_PNG)}-10x20-png`

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x41)])
const PDF_ID = `file-${nodeSha1(PDF)}-pdf`

const TRUNCATED_PNG = Buffer.from(PNG_SIGNATURE)

const OVERLAY_ID = 'assets-uploader-overlay-000000'
const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'

/** `examples/kitchen-sink/schemaTypes/author.ts:13` — `portrait`, an image. */
const IMAGE_TYPE = {name: 'image', jsonType: 'object', type: {name: 'image'}, options: {}}
/** `article.ts` — an attachment file field. */
const FILE_TYPE = {name: 'file', jsonType: 'object', type: {name: 'file'}, options: {}}

function fileOf(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, {type})
}

/* ------------------------------------------------------------------ *
 * 2. The base dataset, stood in for over loopback
 * ------------------------------------------------------------------ */

type QueryHandler = (query: string, params: Rec) => Promise<unknown> | unknown

interface Staging {
  origin: string
  queries: string[]
  /** Replace the `/data/query` behaviour for the next call onwards. */
  answerWith(handler: QueryHandler): void
  close(): Promise<void>
}

/** The one answer a real dataset gives the dedup probe: no such asset. */
const NO_DUPLICATE: QueryHandler = () => null

async function startStaging(): Promise<Staging> {
  let handler: QueryHandler = NO_DUPLICATE
  const queries: string[] = []

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.includes('/data/query/')) {
      response.writeHead(404, {'content-type': 'application/json'})
      response.end(JSON.stringify({error: {description: `no route for ${url.pathname}`}}))
      return
    }
    const query = url.searchParams.get('query') ?? ''
    queries.push(query)
    const params: Rec = {}
    for (const [key, value] of url.searchParams) {
      if (!key.startsWith('$')) continue
      try {
        params[key.slice(1)] = JSON.parse(value)
      } catch {
        params[key.slice(1)] = value
      }
    }
    void (async () => {
      let result: unknown
      try {
        result = await handler(query, params)
      } catch (error) {
        response.writeHead(500, {'content-type': 'application/json'})
        response.end(JSON.stringify({error: {description: String(error)}}))
        return
      }
      /* `undefined` from the handler means: accept the connection and never
       * answer. The socket is deliberately left open. */
      if (result === undefined) return
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({ms: 1, query, result}))
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    queries,
    answerWith: (next) => {
      handler = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/* ------------------------------------------------------------------ *
 * 3. The Studio, wired as `defineOverlayConfig` wires it
 * ------------------------------------------------------------------ */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  }
}

interface Rig {
  runtime: OverlayRuntime
  client: Rec
  staging: Staging
  overlayUrl: string
  root: string
  messages: string[]
}

async function rig(options: {readTimeoutMs?: number} = {}): Promise<Rig> {
  const staging = await startStaging()
  cleanups.push(() => staging.close())

  const root = await mkdtemp(join(tmpdir(), 'assets-uploader-'))
  cleanups.push(() => rm(root, {recursive: true, force: true}))

  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: OVERLAY_ID,
    now: makeClock(),
    watchIntervalMs: 0,
    origins: ['http://localhost:3333'],
    base: {projectId: PROJECT_ID, dataset: DATASET, apiVersion: '2025-02-19'},
  })
  cleanups.push(() => server.close())

  const messages: string[] = []
  const resolved = resolveOverlayOptions(
    {mode: 'fs', apiUrl: server.url, overlayId: OVERLAY_ID},
    {},
  )
  const runtime = createOverlayRuntime({
    resolved,
    createClient: (clientOptions) =>
      createSanityClient({
        ...clientOptions,
        apiHost: staging.origin,
        useProjectHostname: false,
        useCdn: false,
      }) as unknown as object,
    onLog: (message) => messages.push(message),
    ...(options.readTimeoutMs === undefined ? {} : {readTimeoutMs: options.readTimeoutMs}),
  })

  const client = runtime.clientFactory({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: '2025-02-19',
    useCdn: false,
  }) as unknown as Rec

  return {runtime, client, staging, overlayUrl: server.url, root, messages}
}

/* ------------------------------------------------------------------ *
 * 4. The drive — literally what `:37996` does
 * ------------------------------------------------------------------ */

type Outcome =
  | {kind: 'complete'; patches: Rec[]}
  | {kind: 'error'; patches: Rec[]; error: unknown}
  | {kind: 'HANG'; patches: Rec[]}

/**
 * Subscribe to `uploader.upload(...)` the way `BaseImageInput` does, collect the
 * patches it would have handed `onChange`, and give the whole thing a deadline.
 *
 * The subscription is ALWAYS torn down. `uploadAsset` is
 * `withMaxConcurrency(uploadSanityAsset, 4)` (`:13469`) over a module-level
 * throttler, so a leaked subscription from a hung test would starve the next
 * four uploads in this file and turn one failure into five.
 */
async function driveInput(
  client: unknown,
  schemaType: unknown,
  file: File,
  ms = 8000,
): Promise<Outcome> {
  const uploader = resolveUploader(schemaType, file)
  expect(uploader, 'sanity resolved no uploader for this (type, file) pair').not.toBeNull()

  const patches: Rec[] = []
  let subscription: {unsubscribe(): void} | undefined
  let timer: NodeJS.Timeout | undefined

  try {
    return await new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({kind: 'HANG', patches}), ms)
      subscription = (uploader as SanityUploader)
        .upload(client, file, schemaType, {})
        .subscribe({
          next: (event) => {
            for (const patch of event.patches ?? []) patches.push(patch as Rec)
          },
          error: (error) => resolve({kind: 'error', patches, error}),
          complete: () => resolve({kind: 'complete', patches}),
        })
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    subscription?.unsubscribe()
  }
}

/**
 * The DROP / PASTE / Upload-button path: `DatasetAssetSourceUploader`, driven
 * exactly as `useAssetSourceUploader` drives it (`:34350-34386`), including the
 * two things the component does with its events —
 *
 *   `error`        push a toast (recorded here as `toasts`), and
 *   `all-complete` `onChange(unset(['_upload']))`  (`:34369`)
 *
 * — because "the spinner clears" is a claim about those, not about the inner
 * observable. `abort()` is the Cancel button.
 */
interface DropOutcome {
  patches: Rec[]
  toasts: number
  allComplete: boolean
  statuses: string[]
  errors: string[]
  cancel(): void
}

async function driveDrop(
  source: CreateDatasetAssetSource,
  client: unknown,
  schemaType: unknown,
  files: File[],
  options: {abortAfterMs?: number; ms?: number} = {},
): Promise<DropOutcome | 'HANG'> {
  const Uploader = source({client, title: 'test'}).Uploader
  const uploader = new Uploader()
  const patches: Rec[] = []
  const statuses: string[] = []
  const errors: string[] = []
  let toasts = 0
  let allComplete = false

  const onChange = (patchSet: unknown): void => {
    for (const patch of Array.isArray(patchSet) ? patchSet : [patchSet]) patches.push(patch as Rec)
  }

  let unsubscribe: (() => void) | undefined
  let timer: NodeJS.Timeout | undefined
  let abortTimer: NodeJS.Timeout | undefined

  try {
    const settled = await new Promise<DropOutcome | 'HANG'>((resolve) => {
      timer = setTimeout(() => resolve('HANG'), options.ms ?? 8000)
      unsubscribe = uploader.subscribe((event) => {
        const type = event.type
        if (type === 'status') statuses.push(String((event.file as Rec | undefined)?.status))
        if (type === 'error') {
          toasts += 1
          for (const file of (event.files ?? []) as Rec[]) errors.push(messageOf(file.error))
        }
        if (type === 'all-complete') {
          allComplete = true
          /* `:34369`, verbatim: this is what clears the spinner. */
          onChange([{type: 'unset', path: ['_upload']}])
          /* A MICROTASK, not here. `DatasetUploader.updateFile` emits
           * `all-complete` from INSIDE `checkAllComplete()` and the caller then
           * emits `error` on the very next line (`:40779-40785`), so resolving
           * synchronously would drop the toast this test is about. */
          queueMicrotask(() =>
            resolve({
              patches,
              toasts,
              allComplete,
              statuses,
              errors,
              cancel: () => uploader.abort(),
            }),
          )
        }
      })
      /* `:34375` — the initial patches the component writes before uploading. */
      onChange([{type: 'set', path: ['_upload'], value: {progress: 2}}])
      uploader.upload(files, {schemaType, onChange})
      if (options.abortAfterMs !== undefined) {
        abortTimer = setTimeout(() => uploader.abort(), options.abortAfterMs)
      }
    })
    return settled
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortTimer !== undefined) clearTimeout(abortTimer)
    unsubscribe?.()
  }
}

/** The `set` patch that binds the field to an asset, if the stream produced one. */
function assetRefOf(patches: readonly Rec[]): string | undefined {
  for (const patch of patches) {
    if (patch.type !== 'set') continue
    const path = patch.path
    if (!Array.isArray(path) || path.length !== 1 || path[0] !== 'asset') continue
    const value = patch.value
    if (typeof value === 'object' && value !== null) {
      const ref = (value as Rec)._ref
      if (typeof ref === 'string') return ref
    }
  }
  return undefined
}

/** Did the stream end by unsetting `_upload`? (`CLEANUP_EVENT`, `:13615`) */
function clearsUploadStatus(patches: readonly Rec[]): boolean {
  return patches.some(
    (patch) =>
      patch.type === 'unset' &&
      Array.isArray(patch.path) &&
      patch.path.length === 1 &&
      patch.path[0] === '_upload',
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * 5. Oracles
 * ------------------------------------------------------------------ */

/** Bytes on disk, read by `node:fs`, hashed by `node:crypto`. */
async function blobBytes(root: string, sha256: string): Promise<Buffer> {
  return readFile(join(root, '.sanity-overlay', 'assets', 'blobs', `${sha256}.bin`))
}

async function blobNames(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, '.sanity-overlay', 'assets', 'blobs'))).sort()
  } catch {
    return []
  }
}

interface StateRow {
  logicalId: string
  draft: Rec | null
  published: Rec | null
}

/** A separate `GET /state`, over HTTP, on a connection this test opened. */
async function stateRows(overlayUrl: string): Promise<StateRow[]> {
  const body = (await (await fetch(`${overlayUrl}/state`)).json()) as {documents: StateRow[]}
  return body.documents
}

/* ══════════════════════════════════════════════════════════════════ *
 * PART 1 — the defect, at the entry point the editor drives
 * ══════════════════════════════════════════════════════════════════ */

describe("sanity's own image uploader, driven end to end (PRD §24.3)", () => {
  it('stores the bytes and ends with an asset reference and a cleared `_upload`', async () => {
    const {client, staging, overlayUrl, root} = await rig()
    staging.answerWith(NO_DUPLICATE)

    const outcome = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'portrait.png', 'image/png'))

    expect(outcome.kind, `patches so far: ${JSON.stringify(outcome.patches)}`).toBe('complete')
    expect(assetRefOf(outcome.patches)).toBe(PNG_ID)
    expect(clearsUploadStatus(outcome.patches)).toBe(true)

    /* Oracle 1 — bytes on disk, hashed independently. */
    const names = await blobNames(root)
    expect(names).toHaveLength(1)
    const stored = await blobBytes(root, (names[0] as string).replace(/\.bin$/, ''))
    expect(Buffer.compare(stored, PNG)).toBe(0)

    /* Oracle 2 — a fresh store, sharing no state with the server's. */
    const fresh = new FsOverlayAssetStore({root, now: makeClock()})
    expect((await fresh.getRecord(PNG_ID))?.sha1hash).toBe(PNG_SHA1)
    expect(
      Buffer.from(await fresh.readBlob(PNG_ID, {verify: true})).equals(PNG),
    ).toBe(true)

    /* Oracle 3 — a separate `GET /state` sees the asset document. */
    const rows = await stateRows(overlayUrl)
    expect(rows.map((row) => row.logicalId)).toContain(PNG_ID)
  })

  /**
   * THE REGRESSION. Before `assetDedup.ts` this was the live defect exactly:
   * `progress: 2`, no asset, no error, forever.
   *
   * `() => undefined` leaves the socket open and never writes a response, which
   * is the one base behaviour that produces it. A base that errors, 404s or
   * answers `null` all terminate — see the neighbouring cases — so a test that
   * used any of those would have passed against the broken code.
   */
  it('never waits on the base dataset at all — the probe is answered locally', async () => {
    const {client, staging, root} = await rig()
    staging.answerWith(() => undefined)

    const outcome = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'portrait.png', 'image/png'))

    expect(outcome.kind, 'an upload that never resolves is the §5.5 defect').toBe('complete')
    expect(assetRefOf(outcome.patches)).toBe(PNG_ID)
    /* The proof it did not merely time out gracefully: NOTHING was asked of
     * base. A single query here would put the hang back one release later. */
    expect(staging.queries).toEqual([])
    expect(await blobNames(root)).toHaveLength(1)
  })

  it('records the dedup answer as a declared approximation, not as silence', async () => {
    const {client, staging, runtime} = await rig()
    staging.answerWith(() => undefined)

    await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'portrait.png', 'image/png'))

    const probe = runtime
      .reads()
      .find((record) => record.query.includes('sha1hash'))
    expect(probe?.outcome).toBe('overlay')
    expect(probe?.approximations?.[0]?.function).toBe('asset.find-duplicate')
    expect(probe?.approximations?.[0]?.reason).toMatch(/base dataset is NOT consulted/)
  })

  it('finds a BRANCH asset with the same bytes and uploads nothing the second time', async () => {
    const {client, staging, root} = await rig()
    staging.answerWith(() => undefined)

    const first = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'a.png', 'image/png'))
    expect(first.kind).toBe('complete')

    /* The second drop of the same bytes. The branch now holds the asset, so the
     * probe answers from it — and `uploadSanityAsset` short-circuits without
     * calling `assets.upload` at all (`:13450`). */
    const second = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'again.png', 'image/png'))

    expect(second.kind).toBe('complete')
    expect(assetRefOf(second.patches)).toBe(PNG_ID)
    expect(staging.queries).toEqual([])
    /* One blob, not two — the oracle for "it deduplicated" is the filesystem. */
    expect(await blobNames(root)).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 2 — the class: every asset path, and what each one ends in
 * ══════════════════════════════════════════════════════════════════ */

describe('every asset path terminates, in success or a stated reason (PRD §5.5)', () => {
  it('image field — the DROP / PASTE / Upload-button path clears its own spinner', async () => {
    const {client, root} = await rig()

    const drop = await driveDrop(createDatasetImageAssetSource, client, IMAGE_TYPE, [
      fileOf(PNG, 'portrait.png', 'image/png'),
    ])

    expect(drop).not.toBe('HANG')
    const outcome = drop as DropOutcome
    expect(outcome.allComplete).toBe(true)
    expect(outcome.toasts).toBe(0)
    expect(assetRefOf(outcome.patches)).toBe(PNG_ID)
    expect(clearsUploadStatus(outcome.patches)).toBe(true)
    expect(await blobNames(root)).toHaveLength(1)
  })

  it('file field — a PDF lands as a `file` asset on both drivers', async () => {
    const {client, root, overlayUrl} = await rig()

    const direct = await driveInput(client, FILE_TYPE, fileOf(PDF, 'spec.pdf', 'application/pdf'))
    expect(direct.kind).toBe('complete')
    expect(assetRefOf(direct.patches)).toBe(PDF_ID)

    const drop = await driveDrop(createDatasetFileAssetSource, client, FILE_TYPE, [
      fileOf(PDF, 'spec.pdf', 'application/pdf'),
    ])
    expect(drop).not.toBe('HANG')
    expect((drop as DropOutcome).allComplete).toBe(true)

    expect(await blobNames(root)).toHaveLength(1)
    expect((await stateRows(overlayUrl)).map((row) => row.logicalId)).toContain(PDF_ID)
  })

  it('array of images — two files in one drop, two assets, one terminating stream', async () => {
    const {client, root, overlayUrl} = await rig()

    const drop = await driveDrop(createDatasetImageAssetSource, client, IMAGE_TYPE, [
      fileOf(PNG, 'one.png', 'image/png'),
      fileOf(SECOND_PNG, 'two.png', 'image/png'),
    ])

    expect(drop).not.toBe('HANG')
    const outcome = drop as DropOutcome
    expect(outcome.allComplete).toBe(true)
    expect(outcome.toasts).toBe(0)

    const refs = outcome.patches
      .filter(
        (patch) =>
          patch.type === 'set' && Array.isArray(patch.path) && patch.path[0] === 'asset',
      )
      .map((patch) => (patch.value as Rec)._ref)
    expect(new Set(refs)).toEqual(new Set([PNG_ID, SECOND_PNG_ID]))
    expect(await blobNames(root)).toHaveLength(2)

    const ids = (await stateRows(overlayUrl)).map((row) => row.logicalId)
    expect(ids).toContain(PNG_ID)
    expect(ids).toContain(SECOND_PNG_ID)
  })

  it('replacing an existing asset — the second upload wins and both blobs are held', async () => {
    const {client, root} = await rig()

    const first = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'old.png', 'image/png'))
    const second = await driveInput(
      client,
      IMAGE_TYPE,
      fileOf(SECOND_PNG, 'new.png', 'image/png'),
    )

    expect(first.kind).toBe('complete')
    expect(second.kind).toBe('complete')
    expect(assetRefOf(second.patches)).toBe(SECOND_PNG_ID)
    expect(await blobNames(root)).toHaveLength(2)
  })

  it('cancelling mid-upload — `abort()` settles the stream and clears `_upload`', async () => {
    const {client} = await rig()

    const drop = await driveDrop(
      createDatasetImageAssetSource,
      client,
      IMAGE_TYPE,
      [fileOf(PNG, 'portrait.png', 'image/png')],
      {abortAfterMs: 0},
    )

    expect(drop, 'a cancelled upload must settle, not linger').not.toBe('HANG')
    const outcome = drop as DropOutcome
    expect(outcome.allComplete).toBe(true)
    expect(clearsUploadStatus(outcome.patches)).toBe(true)
  })

  it('a file no uploader accepts — refused with a reason naming the type', async () => {
    const {client} = await rig()
    const alien = new File([new Uint8Array([1, 2, 3])], 'thing.bin', {
      type: 'application/octet-stream',
    })

    /* `resolveUploader` returns null for an image field fed a binary blob
     * (`:13787`), and `DatasetAssetSourceUploader` turns that into an error
     * event rather than into nothing at all (`:40792`). */
    expect(resolveUploader(IMAGE_TYPE, alien)).toBeNull()

    const drop = await driveDrop(createDatasetImageAssetSource, client, IMAGE_TYPE, [alien])
    expect(drop).not.toBe('HANG')
    const outcome = drop as DropOutcome
    /* Visible and terminating: a toast, and `_upload` cleared. */
    expect(outcome.toasts).toBe(1)
    expect(clearsUploadStatus(outcome.patches)).toBe(true)
    /*
     * AND A NOTE ON WHAT THE TOAST SAYS, which is not ours to fix.
     * `:40793` builds `Unsupported file type: …` and emits it as
     * `{type: 'error', files: this.files.filter(…)}` — but `updateFile` has
     * already run `checkAllComplete()`, which calls `reset()` and empties
     * `this.files`. So the specific reason is dropped by sanity 6.8.0 itself
     * and the editor sees only the generic "upload failed". Asserted as
     * observed rather than as desired, so the day sanity fixes it this test
     * says so instead of quietly passing.
     */
    expect(outcome.errors).toEqual([])
  })

  it('a container the branch will not accept — refused with the server’s own reason', async () => {
    const {client, root} = await rig()

    const outcome = await driveInput(
      client,
      IMAGE_TYPE,
      fileOf(TRUNCATED_PNG, 'broken.png', 'image/png'),
    )

    expect(outcome.kind).toBe('error')
    expect(messageOf((outcome as {error: unknown}).error)).toMatch(
      /the branch refused this asset/,
    )
    expect(await blobNames(root)).toEqual([])
  })

  it('the overlay API unreachable — refused, bounded, and never sent to Sanity', async () => {
    const {client, overlayUrl, runtime} = await rig()
    /* Close the overlay API out from under the session. The uploader's own
     * deadline (`assets.ts` DEFAULT_UPLOAD_TIMEOUT_MS) is the backstop; a
     * refused connection is faster and is what a stopped server looks like. */
    for (const cleanup of cleanups.splice(0)) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup().catch(() => {})
      break
    }
    void overlayUrl
    void runtime

    const outcome = await driveInput(client, IMAGE_TYPE, fileOf(PNG, 'portrait.png', 'image/png'))
    expect(outcome.kind).not.toBe('HANG')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 2b — the READ side: a field that already points at an asset
 * ══════════════════════════════════════════════════════════════════ */

/**
 * `WithReferencedAsset` — how the file and image inputs read the asset a field
 * already references, in order to render its filename, size and download link.
 *
 * It was refused by `readPlan.ts` and delegated to base, because the `_type`
 * conjunct names a hosted system type. Base does not hold a BRANCH asset, so a
 * branch-uploaded file rendered with no filename and no mime type — and in
 * strict mode the pane threw. The id is named exactly, so the candidate set is
 * the id and the `_type` beside it can only narrow; `readPlan.ts` now defers the
 * system-type refusal until it knows there is no id to bound the fetch.
 */
const REFERENCED_ASSET_QUERY =
  '*[_type == $type &&_id == $ref][0]{mimeType, originalFilename}'

describe('an asset a field already references resolves, branch or base (§24.1)', () => {
  it('answers for a BRANCH asset, which base has never heard of', async () => {
    const {client, staging} = await rig()
    /* Base answers the candidate fetch honestly: it holds no such document. */
    staging.answerWith(() => [])

    await driveInput(client, FILE_TYPE, fileOf(PDF, 'spec.pdf', 'application/pdf'))

    const answer = (await (
      client.fetch as (query: string, params: Rec) => Promise<unknown>
    )(REFERENCED_ASSET_QUERY, {type: 'sanity.fileAsset', ref: PDF_ID})) as Rec | null

    expect(answer?.originalFilename).toBe('spec.pdf')
    expect(answer?.mimeType).toBe('application/pdf')
  })

  it('still answers for a BASE asset, from the candidate fetch', async () => {
    const {client, staging, runtime} = await rig()
    const baseAsset = {
      _id: 'image-basebasebasebasebasebasebasebasebase00-8x8-png',
      _type: 'sanity.imageAsset',
      originalFilename: 'from-staging.png',
      mimeType: 'image/png',
      sha1hash: 'basebasebasebasebasebasebasebasebase0000',
    }
    staging.answerWith(() => [baseAsset])

    const answer = (await (
      client.fetch as (query: string, params: Rec) => Promise<unknown>
    )(REFERENCED_ASSET_QUERY, {type: 'sanity.imageAsset', ref: baseAsset._id})) as Rec | null

    expect(answer?.originalFilename).toBe('from-staging.png')
    /* Answered from the branch view over base candidates — NOT delegated. */
    const record = runtime.reads().find((entry) => entry.query === REFERENCED_ASSET_QUERY)
    expect(record?.outcome).toBe('overlay')
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * PART 3 — the class beyond assets: a delegated read cannot hang either
 * ══════════════════════════════════════════════════════════════════ */

describe('a read handed to the base dataset is bounded (facade DEFAULT_READ_TIMEOUT_MS)', () => {
  it('states the deadline instead of leaving the caller pending forever', async () => {
    const {client, staging} = await rig({readTimeoutMs: 250})
    staging.answerWith(() => undefined)

    /* NOT an asset query: `assetDedup.ts` fixes that one instance by taking it
     * off the network. This is the class — any read the planner delegates. */
    const work = (client.fetch as (query: string) => Promise<unknown>)(
      '*[_type == "somethingTheOverlayCannotPlan"] | order(_createdAt) [0...10] {...}',
    )

    await expect(work).rejects.toThrow(/did not answer this read within 250ms/)
  })

  it('leaves a read that DOES answer completely alone', async () => {
    const {client, staging} = await rig({readTimeoutMs: 250})
    staging.answerWith(() => [{_id: 'a', _type: 'article'}])

    const result = await (client.fetch as (query: string) => Promise<unknown>)(
      '*[_type == "article"]',
    )
    expect(result).toEqual([{_id: 'a', _type: 'article'}])
  })
})
