/**
 * **BRANCH-LOCAL ASSET UPLOAD, WIRED** — PRD §24.3 steps 1-7, §24.5, §24.7,
 * under the owner ruling of 2026-08-05 (PRD §0.0).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN, AND WHAT THIS FILE PINS.
 *
 * `FsOverlayAssetStore` and the whole of `core/assets` were built and then
 * referenced by nothing: the overlay API had no asset endpoint and the Studio
 * facade refused `client.assets.upload` outright. Uploading an image in a branch
 * therefore left `_upload: {progress: 2}` on the document and never produced an
 * asset. The storage half existed; the wiring did not.
 *
 * Three claims are load-bearing here, and each is checked against an oracle that
 * is NOT the code under test:
 *
 *   1. **BYTES ON DISK.** After an upload the blob is read back with `node:fs`
 *      and hashed with `node:crypto`; the record and the bytes are re-read
 *      through a FRESH `FsOverlayAssetStore` that shares no state with the
 *      server's. A server that answered correctly and wrote nothing fails.
 *   2. **A REFERENCE THAT RESOLVES.** The synthetic asset document is committed
 *      into the overlay, so a document holding `asset._ref` resolves through
 *      core's own `resolveReferenceTarget` — and the delivered bytes are then
 *      fetched through the ID that resolver returned, not through the ID the
 *      upload response reported.
 *   3. **NOTHING HANGS.** Every asset path in the class table below is raced
 *      against a deadline. A path that neither succeeds nor states a refusal
 *      fails the test, because `progress: 2` forever is the §5.5 silent
 *      approximation this whole exercise exists to remove.
 *
 * NOT ONE BYTE LEAVES FOR SANITY. Every upload here goes to a `node:http` server
 * bound to loopback and writes into a temporary directory. The suite-wide
 * outbound monitor (`vitest.setup.ts`) refuses any non-GET to a Sanity host, so
 * a regression that started uploading to the asset API fails here as well as in
 * `no-staging-writes.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {crc32, deflateSync} from 'node:zlib'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  applyTransaction,
  createOverlayState,
  edit,
  overlayImageDeliveryPath,
  parseOverlayAssetRequest,
  resolveReferenceTarget,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState} from '../../sanity-overlay-core/src/index'
import {FsOverlayAssetStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'

vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

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

/** Independent oracles. Never a digest the code under test computed. */
const nodeSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const nodeSha1 = (bytes: Uint8Array): string =>
  createHash('sha1').update(Buffer.from(bytes)).digest('hex')

const PNG_SHA256 = nodeSha256(PNG)
const PNG_SHA1 = nodeSha1(PNG)
const PNG_ID = `image-${PNG_SHA1}-64x32-png`
const SECOND_PNG_ID = `image-${nodeSha1(SECOND_PNG)}-10x20-png`
const PDF_ID = `file-${nodeSha1(PDF)}-pdf`

const STUDIO_ORIGIN = 'http://localhost:3333'
const OVERLAY_ID = 'assets-wiring-overlay-000000000'
const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'

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

interface Booted {
  url: string
  root: string
  close(): Promise<void>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'assets-wiring-'))
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

/** The upload request the Studio transport makes, spelled out here on purpose. */
async function upload(
  server: Booted,
  bytes: Buffer,
  init: {filename?: string; contentType?: string; headers?: Record<string, string>} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'application/octet-stream',
    origin: STUDIO_ORIGIN,
    /* The custom header is what forces a CORS preflight — see the CSRF section. */
    'x-overlay-asset-upload': '1',
    ...(init.filename === undefined
      ? {}
      : {'x-overlay-asset-filename': encodeURIComponent(init.filename)}),
    ...(init.headers ?? {}),
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === '') delete headers[name]
  }
  const response = await fetch(`${server.url}/assets`, {method: 'POST', headers, body: bytes})
  const text = await response.text()
  return {status: response.status, body: text === '' ? {} : (JSON.parse(text) as never)}
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

/* ══════════════════════════════════════════════════════════════════ *
 * 1. The upload endpoint — bytes on disk, checked with node:fs
 * ══════════════════════════════════════════════════════════════════ */

describe('POST /assets — the branch-local upload endpoint (PRD §24.3 steps 1-5)', () => {
  it('writes the exact bytes under .sanity-overlay/, addressed by their SHA-256', async () => {
    const server = await boot()
    const {status, body} = await upload(server, PNG, {
      filename: 'hero.png',
      contentType: 'image/png',
    })
    expect(status).toBe(200)

    /* THE ORACLE IS THE FILESYSTEM. Not the response, and not the store. */
    const blobsDir = join(server.root, '.sanity-overlay', 'assets', 'blobs')
    expect((await readdir(blobsDir)).sort()).toEqual([`${PNG_SHA256}.bin`])
    const onDisk = await readFile(join(blobsDir, `${PNG_SHA256}.bin`))
    expect(onDisk.equals(PNG)).toBe(true)
    expect(nodeSha256(onDisk)).toBe(PNG_SHA256)

    /* And a FRESH store, sharing nothing with the server's, re-reads both. */
    const reader = new FsOverlayAssetStore({root: server.root, now: makeClock()})
    const record = await reader.getRecord(PNG_ID)
    expect(record?.assetDocumentId).toBe(PNG_ID)
    expect(record?.sha1hash).toBe(PNG_SHA1)
    expect(Buffer.from(await reader.readBlob(PNG_ID, {verify: true})).equals(PNG)).toBe(true)

    const document = body.document as Record<string, unknown>
    expect(document._id).toBe(PNG_ID)
    expect(document._type).toBe('sanity.imageAsset')
  })

  it('answers with a url on the overlay API, never a cdn.sanity.io one', async () => {
    const server = await boot()
    const {body} = await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})
    const url = (body.document as Record<string, unknown>).url as string

    expect(url).toBe(`${server.url}/assets/${PNG_ID}`)
    expect(url).not.toContain('sanity.io')

    /* The url is not decoration: fetching it returns the bytes. */
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('commits the synthetic asset document, so a reference to it resolves', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    const state = (await (await fetch(`${server.url}/state`)).json()) as {
      documents: Array<{logicalId: string; published: Record<string, unknown> | null}>
    }
    const assetRow = state.documents.find((row) => row.logicalId === PNG_ID)
    expect(assetRow?.published?._type).toBe('sanity.imageAsset')

    /* Follow it the way core does, from a document that holds the reference. */
    let overlay: OverlayState = createOverlayState({overlayId: OVERLAY_ID})
    overlay = applyTransaction(
      overlay,
      [{type: 'create', document: assetRow?.published as never}],
      {transactionId: 'tx-1', idempotencyKey: 'k-1', now: makeClock()},
    ).state
    overlay = applyTransaction(
      overlay,
      [{type: 'create', document: {_id: 'author-2', _type: 'author', name: 'A'}}],
      {transactionId: 'tx-2', idempotencyKey: 'k-2', now: makeClock()},
    ).state
    overlay = edit(
      overlay,
      {
        id: 'author-2',
        operations: [
          {
            type: 'set',
            path: ['portrait'],
            value: {_type: 'image', asset: {_type: 'reference', _ref: PNG_ID}},
          },
        ],
      },
      {transactionId: 'tx-3', idempotencyKey: 'k-3', now: makeClock()},
    ).state

    const author = resolveReferenceTarget(overlay, 'author-2', {perspective: 'drafts'})
    const ref = ((author.document?.portrait as Record<string, unknown>).asset as {_ref: string})
      ._ref
    const resolved = resolveReferenceTarget(overlay, ref, {perspective: 'drafts'})
    expect(resolved.available).toBe(true)
    expect(resolved.document?._type).toBe('sanity.imageAsset')

    /* The bytes, fetched through the ID the RESOLVER returned. */
    const response = await fetch(`${server.url}/assets/${resolved.document?._id as string}`)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('stores identical bytes once, under any filename', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'a.png', contentType: 'image/png'})
    const second = await upload(server, PNG, {filename: 'b.png', contentType: 'image/png'})

    expect(second.status).toBe(200)
    expect(second.body.deduplicated).toBe(true)
    const blobsDir = join(server.root, '.sanity-overlay', 'assets', 'blobs')
    expect((await readdir(blobsDir)).length).toBe(1)
  })

  it('accepts a non-image as a sanity.fileAsset', async () => {
    const server = await boot()
    const {status, body} = await upload(server, PDF, {
      filename: 'brief.pdf',
      contentType: 'application/pdf',
    })
    expect(status).toBe(200)
    const document = body.document as Record<string, unknown>
    expect(document._id).toBe(PDF_ID)
    expect(document._type).toBe('sanity.fileAsset')

    const response = await fetch(`${server.url}/assets/${PDF_ID}`)
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 2. Failure is LOUD — never a hang, never a silent success
 * ══════════════════════════════════════════════════════════════════ */

describe('a refused upload states a reason (PRD §5.5, §24.5, §24.6)', () => {
  it('refuses an image whose container does not state its dimensions', async () => {
    const server = await boot()
    const {status, body} = await upload(server, TRUNCATED_PNG, {
      filename: 'broken.png',
      contentType: 'image/png',
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    const error = body.error as Record<string, unknown>
    expect(error.code).toBe('OVERLAY_ASSET_METADATA_UNAVAILABLE')
    expect(String(error.message)).toMatch(/dimensions/i)

    /* Nothing was written: a refused upload leaves the store as it was. */
    await expect(readdir(join(server.root, '.sanity-overlay', 'assets', 'blobs'))).rejects
      .toThrow()
  })

  it('refuses a zero-byte body with a reason rather than storing an empty asset', async () => {
    const server = await boot()
    const {status, body} = await upload(server, Buffer.alloc(0), {filename: 'empty.png'})
    expect(status).toBe(400)
    expect((body.error as Record<string, unknown>).code).toBe('OVERLAY_ASSET_REJECTED')
  })

  it('refuses an upload that carries no custom header, so a forged POST cannot upload', async () => {
    const server = await boot()
    const response = await fetch(`${server.url}/assets`, {
      method: 'POST',
      /* A CORS-safelisted simple request: no preflight, so nothing but this
       * check stands between any open page and the branch (§25.1, security
       * review P2-4). */
      headers: {'content-type': 'text/plain', origin: 'https://evil.example'},
      body: PNG,
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as {error: {code: string}}
    expect(body.error.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('refuses a cross-site upload even when the header is present', async () => {
    const server = await boot()
    const {status} = await upload(server, PNG, {
      filename: 'hero.png',
      contentType: 'image/png',
      headers: {origin: 'https://evil.example', 'sec-fetch-site': 'cross-site'},
    })
    expect(status).toBe(403)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 3. Delivery — two routes, and a file server that cannot escape
 * ══════════════════════════════════════════════════════════════════ */

describe('asset delivery (PRD §24.7, §24.8, §35.9 path containment)', () => {
  it('serves the URL @sanity/image-url builds, and says no transformation happened', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    const path = overlayImageDeliveryPath(PNG_ID, PROJECT_ID, DATASET) as string
    expect(path).toBe(`/images/${PROJECT_ID}/${DATASET}/${PNG_SHA1}-64x32.png`)

    const response = await fetch(`${server.url}${path}?w=2000&fit=max`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
    /* §24.8 stated on the wire, not left to be discovered. */
    expect(response.headers.get('x-overlay-asset-transform')).toBe('not-applied; fit, w')
    expect(response.headers.get('x-overlay-asset')).toBe('branch-only')
  })

  it('serves the file-pipeline URL shape too', async () => {
    const server = await boot()
    await upload(server, PDF, {filename: 'brief.pdf', contentType: 'application/pdf'})

    const response = await fetch(
      `${server.url}/files/${PROJECT_ID}/${DATASET}/${nodeSha1(PDF)}.pdf`,
    )
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
  })

  it('cannot be talked into serving a file outside the asset directory', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    for (const hostile of [
      '/assets/../../manifest.json',
      '/assets/..%2F..%2Fmanifest.json',
      '/assets/%2e%2e%2f%2e%2e%2fmanifest.json',
      '/assets/',
      `/assets/${PNG_ID.toUpperCase()}`,
      `/images/${PROJECT_ID}/${DATASET}/../../../../etc/passwd`,
      '/images/../../etc/passwd',
    ]) {
      const response = await fetch(`${server.url}${hostile}`)
      expect(response.status).not.toBe(200)
      const text = await response.text()
      expect(text).not.toContain('formatVersion')
      expect(text).not.toContain('root:')
    }
  })

  it('404s an asset ID this overlay never stored, on the document route', async () => {
    const server = await boot()
    const response = await fetch(`${server.url}/assets/${PNG_ID}`)
    expect(response.status).toBe(404)
  })

  it('405s a write method on the delivery route', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})
    const response = await fetch(`${server.url}/assets/${PNG_ID}`, {
      method: 'DELETE',
      headers: {origin: STUDIO_ORIGIN},
    })
    expect(response.status).toBe(405)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 4. A BASE asset and a BRANCH asset in the same field
 * ══════════════════════════════════════════════════════════════════ */

describe('base assets keep resolving beside branch assets (PRD §24.1)', () => {
  it('redirects an image the branch does not hold to the Sanity CDN, and serves one it does', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    /* A real Sanity asset — 40 hex that this overlay has never seen. */
    const baseSha1 = 'f'.repeat(40)
    const baseResponse = await fetch(
      `${server.url}/images/${PROJECT_ID}/${DATASET}/${baseSha1}-800x600.jpg?w=200`,
      {redirect: 'manual'},
    )
    expect(baseResponse.status).toBe(302)
    expect(baseResponse.headers.get('location')).toBe(
      `https://cdn.sanity.io/images/${PROJECT_ID}/${DATASET}/${baseSha1}-800x600.jpg?w=200`,
    )

    /* The branch one is served locally, in the same route, in the same session. */
    const branchResponse = await fetch(
      `${server.url}/images/${PROJECT_ID}/${DATASET}/${PNG_SHA1}-64x32.png`,
      {redirect: 'manual'},
    )
    expect(branchResponse.status).toBe(200)
    expect(Buffer.from(await branchResponse.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('never redirects anywhere but the Sanity image CDN', async () => {
    const server = await boot()
    const baseSha1 = 'a'.repeat(40)
    const response = await fetch(
      `${server.url}/images/evil.example%2Fx/${DATASET}/${baseSha1}-1x1.png`,
      {redirect: 'manual'},
    )
    const location = response.headers.get('location')
    if (location !== null) {
      expect(new URL(location).origin).toBe('https://cdn.sanity.io')
    }
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 5. Arrays of images — `article.ts` has `defineArrayMember({type:'image'})`
 * ══════════════════════════════════════════════════════════════════ */

describe('more than one image in one document (examples/kitchen-sink article.gallery)', () => {
  it('two uploads produce two distinct assets, both retrievable', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'one.png', contentType: 'image/png'})
    await upload(server, SECOND_PNG, {filename: 'two.png', contentType: 'image/png'})

    for (const [id, bytes] of [
      [PNG_ID, PNG],
      [SECOND_PNG_ID, SECOND_PNG],
    ] as const) {
      const response = await fetch(`${server.url}/assets/${id}`)
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
    }

    const blobsDir = join(server.root, '.sanity-overlay', 'assets', 'blobs')
    expect((await readdir(blobsDir)).length).toBe(2)
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 6. Every asset path terminates
 * ══════════════════════════════════════════════════════════════════ */

describe('no asset path hangs (PRD §5.5)', () => {
  it('answers every asset route within a deadline, including the ones it refuses', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    const probes: Array<[string, Promise<unknown>]> = [
      ['upload', upload(server, SECOND_PNG, {filename: 'x.png', contentType: 'image/png'})],
      ['upload-refused', upload(server, TRUNCATED_PNG, {filename: 'x.png'})],
      ['deliver-document', fetch(`${server.url}/assets/${PNG_ID}`)],
      [
        'deliver-image',
        fetch(`${server.url}/images/${PROJECT_ID}/${DATASET}/${PNG_SHA1}-64x32.png`),
      ],
      ['deliver-missing', fetch(`${server.url}/assets/${SECOND_PNG_ID.replace('9', '8')}`)],
      ['deliver-traversal', fetch(`${server.url}/assets/../../manifest.json`)],
    ]

    for (const [label, work] of probes) {
      expect(await withDeadline(work), `${label} must terminate`).not.toBe('HANG')
    }
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 7. The core delivery parser knows the file shape too
 * ══════════════════════════════════════════════════════════════════ */

describe('core delivery routing (PRD §24.7)', () => {
  it('parses the file CDN shape as well as the image one', () => {
    const sha1 = nodeSha1(PDF)
    expect(parseOverlayAssetRequest(`/files/${PROJECT_ID}/${DATASET}/${sha1}.pdf`)).toEqual({
      assetDocumentId: `file-${sha1}-pdf`,
      route: 'file-pipeline',
      unsupportedTransformParams: [],
    })
  })

  it('still refuses anything that is not an asset ID', () => {
    for (const hostile of [
      `/files/${PROJECT_ID}/${DATASET}/../../../etc/passwd`,
      `/files/${PROJECT_ID}/${DATASET}/${'A'.repeat(40)}.pdf`,
      '/files/p/ds/short.pdf',
    ]) {
      expect(parseOverlayAssetRequest(hostile)).toBeNull()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 8. The launcher, which is what makes any of the above reachable
 * ══════════════════════════════════════════════════════════════════ */

describe('startOverlayApiServer configures the asset store (PRD §24.3)', () => {
  it('exposes the store it built, addressed at the same overlay root', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    const handle = running[running.length - 1] as unknown as {
      assetStore: {getRecord(id: string): Promise<{checksum: string} | null>} | null
    }
    expect(handle.assetStore, 'the launcher must construct an asset store').not.toBeNull()
    const record = await handle.assetStore?.getRecord(PNG_ID)
    expect(record?.checksum).toBe(PNG_SHA256)
  })

  it('keeps the 501 refusal for an embedder who turns assets off', async () => {
    /* The 501 branch is a GOOD failure mode and must survive the fix: it tells a
     * host that mounted the handler without storage exactly what is missing,
     * instead of a 404 they would read as "no such asset". */
    const root = await mkdtemp(join(tmpdir(), 'assets-wiring-off-'))
    roots.push(root)
    const server = await startOverlayApiServer({
      root,
      port: 0,
      overlayId: OVERLAY_ID,
      now: makeClock(),
      watchIntervalMs: 0,
      origins: [STUDIO_ORIGIN],
      assets: false,
    })
    running.push(server)
    expect(server.assetStore).toBeNull()

    const uploaded = await upload({url: server.url, root, close: () => server.close()}, PNG, {
      filename: 'hero.png',
      contentType: 'image/png',
    })
    expect(uploaded.status).toBe(501)
    expect((uploaded.body.error as Record<string, unknown>).code).toBe('ASSETS_NOT_CONFIGURED')

    const delivered = await fetch(`${server.url}/assets/${PNG_ID}`)
    expect(delivered.status).toBe(501)

    /* And nothing was written: a refusal that scaffolds a directory is a
     * refusal that changed the branch. */
    await expect(readdir(join(root, '.sanity-overlay', 'assets'))).rejects.toThrow()
  })
})

/* ══════════════════════════════════════════════════════════════════ *
 * 9. `deliverAsset` IS A FILE SERVER. It must not serve a foreign file.
 * ══════════════════════════════════════════════════════════════════ */

describe('delivery containment beyond naming (PRD §35.9, §13.2)', () => {
  it('refuses a blob replaced by a symlink to a file outside the overlay', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    /* `.sanity-overlay/` is committed and reviewed — that is the point of the
     * format — so a hostile branch can carry a blob that is a LINK. No naming
     * guard can see this: the path is a perfectly legal SHA-256. */
    const secretPath = join(server.root, 'outside-the-overlay.txt')
    const SECRET = 'SSH-PRIVATE-KEY-LOOKALIKE-9f3a2b'
    await writeFile(secretPath, SECRET, 'utf8')
    const blobPath = join(server.root, '.sanity-overlay', 'assets', 'blobs', `${PNG_SHA256}.bin`)
    await rm(blobPath, {force: true})
    await symlink(secretPath, blobPath)

    for (const url of [
      `${server.url}/assets/${PNG_ID}`,
      `${server.url}/images/${PROJECT_ID}/${DATASET}/${PNG_SHA1}-64x32.png`,
    ]) {
      const response = await fetch(url, {redirect: 'manual'})
      const text = await response.text()
      expect(text, url).not.toContain(SECRET)
      expect(response.status, url).not.toBe(200)
    }
  })

  it('refuses a blob whose bytes no longer hash to the record’s checksum', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    const blobPath = join(server.root, '.sanity-overlay', 'assets', 'blobs', `${PNG_SHA256}.bin`)
    await writeFile(blobPath, 'not the bytes this record names', 'utf8')

    const response = await fetch(`${server.url}/assets/${PNG_ID}`)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('not the bytes')
  })

  it('cannot be talked into serving a file through an encoded or absolute name', async () => {
    const server = await boot()
    await upload(server, PNG, {filename: 'hero.png', contentType: 'image/png'})

    for (const hostile of [
      /* Encoded separators, on both route families. */
      `/assets/image-${PNG_SHA1}-64x32-png%2f..%2f..%2fmanifest.json`,
      `/images/${PROJECT_ID}/${DATASET}/%2e%2e%2f%2e%2e%2fmanifest.json`,
      `/files/${PROJECT_ID}/${DATASET}/%2e%2e%2fmanifest.json`,
      /* Encoded `?` and `#` — the truncation family a prior review found broken
       * in the write guard, checked here rather than assumed absent. */
      `/assets/${PNG_ID}%3f../../manifest.json`,
      `/assets/${PNG_ID}%23/../../manifest.json`,
      /* An absolute path, a NUL, and a Windows separator. */
      `/assets/%2fetc%2fpasswd`,
      `/assets/${PNG_ID}%00.png`,
      `/assets/..%5c..%5cmanifest.json`,
    ]) {
      const response = await fetch(`${server.url}${hostile}`, {redirect: 'manual'})
      const text = await response.text()
      expect(text, hostile).not.toContain('formatVersion')
      expect(text, hostile).not.toContain('root:')
      /* The only 200 this server may ever answer on an asset route is the asset
       * itself, and none of these names is one. */
      expect(response.status, hostile).not.toBe(200)
    }
  })

  it('never redirects anywhere but the Sanity CDN, however the path is spelled', async () => {
    const server = await boot()
    for (const hostile of [
      `/images/${PROJECT_ID}/${DATASET}/..%2f..%2f${'a'.repeat(40)}-1x1.png`,
      `/images/evil.example%2Fx/${DATASET}/${'a'.repeat(40)}-1x1.png`,
      `/images/${PROJECT_ID}/${DATASET}%2f%2fevil.example/${'a'.repeat(40)}-1x1.png`,
      `/files/..%2f..%2fevil.example/${DATASET}/${'a'.repeat(40)}.pdf`,
    ]) {
      const response = await fetch(`${server.url}${hostile}`, {redirect: 'manual'})
      const location = response.headers.get('location')
      if (location === null) continue
      expect(new URL(location, server.url).origin, hostile).toBe('https://cdn.sanity.io')
    }
  })
})
