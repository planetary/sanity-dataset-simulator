/**
 * Branch-local assets, the half that touches bytes — PRD §24.3 steps 1-3 and 7,
 * §24.5 (validation and traversal), §24.6 (remove), §14.1 (content addressing)
 * and §14.3 (temp-file-plus-rename atomicity).
 *
 * SCOPE (owner ruling, 2026-08-05, PRD §0.0): every byte written here stays in
 * the overlay. There is no code path in this file, or in anything it exercises,
 * that reaches Sanity's asset API. The suite-wide outbound monitor
 * (`vitest.setup.ts`) would refuse it if there were.
 *
 * ## What each section is actually testing
 *
 * The oracles are deliberately independent of the code under test:
 *
 * - blob identity is checked against `node:crypto`'s SHA-256, never against the
 *   checksum the store just computed;
 * - "stored once" is checked by counting directory entries and by comparing the
 *   blob's inode and mtime across two uploads — a store that re-wrote identical
 *   bytes to a fresh name, or truncated and rewrote the same name, fails both;
 * - "retrievable by its reference" goes the whole way round: upload, land the
 *   synthetic document in overlay state, resolve the `_ref` through §19.2, then
 *   read the bytes back through the ID the resolver returned and compare them to
 *   the buffer that went in.
 */
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {crc32, deflateSync} from 'node:zlib'
import {afterAll, describe, expect, it} from 'vitest'

import {
  OVERLAY_ASSET_BASE_PATH,
  OverlayAssetError,
  applyTransaction,
  createOverlayState,
  edit,
  overlayImageDeliveryPath,
  parseOverlayAssetRequest,
  planAssetUpload,
  resolveReferenceTarget,
  serialize,
  parse,
} from '../../sanity-overlay-core/src/index'
import type {OverlayAssetRecord, OverlayState} from '../../sanity-overlay-core/src/index'
import {FsOverlayAssetStore} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayAssetDelivery} from '../../sanity-overlay-client/src/assets'

/* ------------------------------------------------------------------ *
 * Fixtures — real containers, constructed, never committed
 * (repo-hygiene.test.ts requires every tracked file to be reviewable text)
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
const OTHER_PNG = makePng(64, 32, 7)
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x41)])

/** Independent oracle. Never the store's own checksum. */
const nodeSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const nodeSha1 = (bytes: Uint8Array): string =>
  createHash('sha1').update(Buffer.from(bytes)).digest('hex')

const PNG_SHA256 = nodeSha256(PNG)
const PNG_SHA1 = nodeSha1(PNG)
const IMAGE_ID = `image-${PNG_SHA1}-64x32-png`

const ACTOR = {type: 'user', id: 'valdis'} as const
const CLOCK = (): string => '2026-08-06T09:00:00.000Z'
const OVERLAY_ID = 'overlay-assets'

const roots: string[] = []

async function harness(
  options: {hooks?: ConstructorParameters<typeof FsOverlayAssetStore>[0]['hooks']} = {},
): Promise<{root: string; store: FsOverlayAssetStore; blobsDir: string; recordsDir: string}> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-assets-'))
  roots.push(root)
  const store = new FsOverlayAssetStore({
    root,
    now: CLOCK,
    ...(options.hooks === undefined ? {} : {hooks: options.hooks}),
  })
  return {
    root,
    store,
    blobsDir: store.layout.assetBlobsDir,
    recordsDir: store.layout.assetRecordsDir,
  }
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, {recursive: true, force: true})))
})

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

let sequence = 0
function txOptions(): {
  transactionId: string
  idempotencyKey: string
  actor: typeof ACTOR
  now: () => string
} {
  sequence += 1
  return {
    transactionId: `tx-${String(sequence).padStart(4, '0')}`,
    idempotencyKey: `key-${sequence}`,
    actor: ACTOR,
    now: CLOCK,
  }
}

/* ------------------------------------------------------------------ *
 * §14.1 content addressing, §14.3 atomicity
 * ------------------------------------------------------------------ */

describe('FsOverlayAssetStore — content-addressed blob storage (PRD §14.1, §24.3 step 3)', () => {
  it('writes the exact bytes to a path named by their SHA-256', async () => {
    const {store, blobsDir} = await harness()
    const result = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    /* The filename is the digest an independent hasher computes over the input. */
    expect(await entries(blobsDir)).toEqual([`${PNG_SHA256}.bin`])
    expect(result.record.checksum).toBe(PNG_SHA256)
    expect(result.record.storageRef).toBe(`assets/blobs/${PNG_SHA256}.bin`)

    const onDisk = await readFile(join(blobsDir, `${PNG_SHA256}.bin`))
    expect(onDisk.equals(PNG)).toBe(true)
    expect(nodeSha256(onDisk)).toBe(PNG_SHA256)
  })

  it('stores identical bytes exactly once, whatever the upload was called', async () => {
    const {store, blobsDir, recordsDir} = await harness()
    const first = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})
    const before = await stat(join(blobsDir, `${PNG_SHA256}.bin`))

    const second = await store.put({
      overlayId: OVERLAY_ID,
      bytes: Buffer.from(PNG),
      filename: 'a-completely-different-name.png',
    })
    const after = await stat(join(blobsDir, `${PNG_SHA256}.bin`))

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.record.assetDocumentId).toBe(first.record.assetDocumentId)
    expect(second.record.storageRef).toBe(first.record.storageRef)

    /* One blob and one record, not two of either. */
    expect(await entries(blobsDir)).toHaveLength(1)
    expect(await entries(recordsDir)).toHaveLength(1)

    /* And the blob was not rewritten in place either: same inode, same mtime. */
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('keeps distinct bytes in distinct blobs', async () => {
    const {store, blobsDir} = await harness()
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'a.png'})
    await store.put({overlayId: OVERLAY_ID, bytes: OTHER_PNG, filename: 'b.png'})

    expect(await entries(blobsDir)).toEqual(
      [`${PNG_SHA256}.bin`, `${nodeSha256(OTHER_PNG)}.bin`].sort(),
    )
  })

  it('publishes the blob by rename, so a reader never sees a partial file (PRD §14.3)', async () => {
    const observed: Array<{targetExists: boolean; tempExists: boolean}> = []
    const {store, blobsDir} = await harness({
      hooks: {
        beforeRename: async ({tempPath, targetPath}) => {
          observed.push({
            targetExists: await exists(targetPath),
            tempExists: await exists(tempPath),
          })
        },
      },
    })
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    expect(observed.length).toBeGreaterThan(0)
    for (const window of observed) {
      expect(window.tempExists).toBe(true)
      expect(window.targetExists).toBe(false)
    }
    /* No staging litter survives a successful write. */
    expect((await entries(blobsDir)).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('leaves nothing behind when the upload is refused', async () => {
    const {store, blobsDir, recordsDir} = await harness()
    const truncated = PNG.subarray(0, 12)

    await expect(
      store.put({overlayId: OVERLAY_ID, bytes: truncated, filename: 'broken.png'}),
    ).rejects.toMatchObject({code: 'OVERLAY_ASSET_METADATA_UNAVAILABLE'})

    expect(await entries(blobsDir)).toEqual([])
    expect(await entries(recordsDir)).toEqual([])
  })

  it('refuses an oversized upload before writing anything (PRD §24.5)', async () => {
    const {root, blobsDir} = await harness()
    const store = new FsOverlayAssetStore({root, now: CLOCK, maxBytes: 8})

    await expect(
      store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'}),
    ).rejects.toBeInstanceOf(OverlayAssetError)
    expect(await entries(blobsDir)).toEqual([])
  })
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * §24.3 — the upload path, end to end
 * ------------------------------------------------------------------ */

describe('the upload path (PRD §24.3 steps 1-6)', () => {
  it('an uploaded asset is retrievable through the reference a document holds', async () => {
    const {store} = await harness()
    const uploaded = await store.put({
      overlayId: OVERLAY_ID,
      bytes: PNG,
      filename: 'hero.png',
      actor: ACTOR,
    })

    /* Step 5-6: the synthetic document lands in the overlay, an article points at it. */
    let state: OverlayState = createOverlayState({overlayId: OVERLAY_ID})
    state = applyTransaction(state, [{type: 'create', document: uploaded.document}], txOptions())
      .state
    state = applyTransaction(
      state,
      [{type: 'create', document: {_id: 'article-1', _type: 'article', title: 'Cover story'}}],
      txOptions(),
    ).state
    state = edit(
      state,
      {
        id: 'article-1',
        operations: [
          {
            type: 'set',
            path: ['cover'],
            value: {
              _type: 'image',
              asset: {_type: 'reference', _ref: uploaded.record.assetDocumentId},
            },
          },
        ],
      },
      txOptions(),
    ).state

    const article = resolveReferenceTarget(state, 'article-1', {perspective: 'drafts'})
    const ref = ((article.document?.cover as Record<string, unknown>).asset as {_ref: string})._ref

    /* Follow the reference the document actually holds — not the ID from `uploaded`. */
    const resolved = resolveReferenceTarget(state, ref, {perspective: 'drafts'})
    expect(resolved.available).toBe(true)
    expect(resolved.document?._type).toBe('sanity.imageAsset')

    const bytes = await store.readBlob(resolved.document?._id as string)
    expect(Buffer.from(bytes).equals(PNG)).toBe(true)
    expect(nodeSha1(bytes)).toBe(PNG_SHA1)
  })

  it('re-reads the record from disk exactly as it was written', async () => {
    const {store, recordsDir} = await harness()
    const uploaded = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    /* Re-read, never the returned object. */
    const reloaded = await store.getRecord(uploaded.record.assetDocumentId)
    expect(reloaded).toEqual(uploaded.record)

    /* And the file itself is canonical, review-facing JSON (PRD §14.3). */
    const raw = await readFile(join(recordsDir, `${IMAGE_ID}.json`), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(parse(raw)).toEqual(uploaded.record)
    expect(serialize(parse(raw) as OverlayAssetRecord)).toBe(raw)
  })

  it('sniffs the format from the bytes, not from a lying filename or content type', async () => {
    const {store} = await harness()
    const uploaded = await store.put({
      overlayId: OVERLAY_ID,
      bytes: PNG,
      filename: 'evil.jpg',
      contentType: 'image/jpeg',
    })

    expect(uploaded.record.contentType).toBe('image/png')
    expect(uploaded.record.assetDocumentId).toBe(IMAGE_ID)
    expect(uploaded.record.assetDocumentId.endsWith('-png')).toBe(true)
  })

  it('emits a sanity.fileAsset for bytes that are not a known image', async () => {
    const {store} = await harness()
    const uploaded = await store.put({
      overlayId: OVERLAY_ID,
      bytes: PDF,
      filename: 'brief.pdf',
      contentType: 'application/pdf',
    })

    expect(uploaded.record.kind).toBe('file')
    expect(uploaded.document._type).toBe('sanity.fileAsset')
    expect(uploaded.record.assetDocumentId).toBe(`file-${nodeSha1(PDF)}-pdf`)
    expect(uploaded.record.metadata.width).toBeUndefined()
  })

  it('names every metadata field it did not produce, and produces none it named', () => {
    const plan = planAssetUpload({
      bytes: PNG,
      overlayId: OVERLAY_ID,
      createdAt: CLOCK(),
      filename: 'hero.png',
    })
    const metadata = plan.document.metadata as Record<string, unknown>

    expect(plan.record.metadata.omitted.length).toBeGreaterThan(0)
    for (const field of plan.record.metadata.omitted) {
      expect(field.startsWith('metadata.')).toBe(true)
      expect(Object.hasOwn(metadata, field.slice('metadata.'.length))).toBe(false)
    }
    /* What it DID read is present, because the container stated it. */
    expect(metadata.dimensions).toMatchObject({width: 64, height: 32})
    expect(metadata.hasAlpha).toBe(true)
  })

  it('reports an unreadable container as omitted rather than defaulting it', () => {
    /* A GIF states its size but not its transparency: per-frame, needs a decode. */
    const gif = Buffer.alloc(13)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(9, 6)
    gif.writeUInt16LE(4, 8)

    const plan = planAssetUpload({
      bytes: Buffer.concat([gif, Buffer.from([0x3b])]),
      overlayId: OVERLAY_ID,
      createdAt: CLOCK(),
      filename: 'anim.gif',
    })

    expect(plan.record.metadata.hasAlpha).toBeUndefined()
    expect(plan.record.metadata.omitted).toContain('metadata.hasAlpha')
    expect(Object.hasOwn(plan.document.metadata as object, 'hasAlpha')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * §24.6 remove, under the §18.8 strong-reference rule
 * ------------------------------------------------------------------ */

describe('removing a branch asset (PRD §24.6, §18.8)', () => {
  async function usedAsset(): Promise<{
    store: FsOverlayAssetStore
    blobsDir: string
    recordsDir: string
    assetDocumentId: string
    state: OverlayState
  }> {
    const {store, blobsDir, recordsDir} = await harness()
    const uploaded = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    let state: OverlayState = createOverlayState({overlayId: OVERLAY_ID})
    state = applyTransaction(state, [{type: 'create', document: uploaded.document}], txOptions())
      .state
    state = applyTransaction(
      state,
      [{type: 'create', document: {_id: 'article-1', _type: 'article', title: 'Cover story'}}],
      txOptions(),
    ).state
    state = edit(
      state,
      {
        id: 'article-1',
        operations: [
          {
            type: 'set',
            path: ['cover'],
            value: {
              _type: 'image',
              asset: {_type: 'reference', _ref: uploaded.record.assetDocumentId},
            },
          },
        ],
      },
      txOptions(),
    ).state

    return {store, blobsDir, recordsDir, assetDocumentId: uploaded.record.assetDocumentId, state}
  }

  it('refuses while a document still references it, and keeps the bytes', async () => {
    const {store, blobsDir, assetDocumentId, state} = await usedAsset()

    await expect(store.remove(assetDocumentId, {state})).rejects.toMatchObject({
      code: 'OVERLAY_ASSET_IN_USE',
    })
    /* The refusal is not a partial delete: the bytes are still there. */
    expect(await entries(blobsDir)).toEqual([`${PNG_SHA256}.bin`])
    expect(await store.getRecord(assetDocumentId)).not.toBeNull()
  })

  it('removes the record and the bytes once the last reference is gone', async () => {
    const {store, blobsDir, recordsDir, assetDocumentId, state} = await usedAsset()
    const released = edit(
      state,
      {id: 'article-1', operations: [{type: 'unset', path: ['cover']}]},
      txOptions(),
    ).state

    await store.remove(assetDocumentId, {state: released})

    expect(await entries(blobsDir)).toEqual([])
    expect(await entries(recordsDir)).toEqual([])
    expect(await store.getRecord(assetDocumentId)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Integrity and traversal (PRD §35.9, §24.5)
 * ------------------------------------------------------------------ */

describe('integrity and containment', () => {
  it('detects a blob whose bytes no longer hash to its record', async () => {
    const {store, blobsDir} = await harness()
    const uploaded = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    await writeFile(join(blobsDir, `${PNG_SHA256}.bin`), Buffer.from('tampered'))

    await expect(
      store.readBlob(uploaded.record.assetDocumentId, {verify: true}),
    ).rejects.toMatchObject({code: 'OVERLAY_ASSET_CHECKSUM_MISMATCH'})

    const report = await store.verifyBlobs()
    expect(report.ok).toBe(false)
    expect(report.corrupt).toEqual([uploaded.record.assetDocumentId])
  })

  it('reports a record whose blob has been deleted', async () => {
    const {store, blobsDir} = await harness()
    const uploaded = await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})
    await rm(join(blobsDir, `${PNG_SHA256}.bin`))

    const report = await store.verifyBlobs()
    expect(report.ok).toBe(false)
    expect(report.missing).toEqual([uploaded.record.assetDocumentId])
  })

  it('refuses an asset ID that is not one, rather than resolving a path from it', async () => {
    const {store, root, blobsDir} = await harness()
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    for (const hostile of [
      '../../etc/passwd',
      '..',
      'image-' + PNG_SHA1,
      `image-${PNG_SHA1}-64x32-png/../../manifest.json`,
      '',
    ]) {
      await expect(store.readBlob(hostile)).rejects.toBeInstanceOf(OverlayAssetError)
      await expect(store.getRecord(hostile)).rejects.toBeInstanceOf(OverlayAssetError)
    }
    /* Nothing was created, read or destroyed outside the overlay directory. */
    expect(await entries(root)).toEqual(['.sanity-overlay'])
    expect(await entries(blobsDir)).toEqual([`${PNG_SHA256}.bin`])
  })
})

/* ------------------------------------------------------------------ *
 * §24.7 delivery
 * ------------------------------------------------------------------ */

describe('local delivery (PRD §24.3 step 7, §24.7, §24.8)', () => {
  it('routes the asset document url', () => {
    const request = parseOverlayAssetRequest(`${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID}`)
    expect(request).toEqual({
      assetDocumentId: IMAGE_ID,
      route: 'document',
      unsupportedTransformParams: [],
    })
  })

  it('routes the URL @sanity/image-url builds, and names the params it cannot honour', () => {
    const path = overlayImageDeliveryPath(IMAGE_ID, 'b1n03q3z', 'parity')
    expect(path).toBe(`/images/b1n03q3z/parity/${PNG_SHA1}-64x32.png`)

    const request = parseOverlayAssetRequest(`${path as string}?w=2000&fit=max&auto=format`)
    expect(request?.assetDocumentId).toBe(IMAGE_ID)
    expect(request?.route).toBe('image-pipeline')
    /* §24.8: no local transformation happens; the params are reported, not applied. */
    expect(request?.unsupportedTransformParams).toEqual(['auto', 'fit', 'w'])
  })

  it('refuses to route anything that is not an asset ID', () => {
    for (const hostile of [
      `${OVERLAY_ASSET_BASE_PATH}/../../manifest.json`,
      `${OVERLAY_ASSET_BASE_PATH}/`,
      `${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID.toUpperCase()}`,
      '/images/p/ds/../../../etc/passwd',
      '/unrelated/path',
    ]) {
      expect(parseOverlayAssetRequest(hostile)).toBeNull()
    }
  })

  it('serves the original bytes, and says that no transformation was applied', async () => {
    const {store} = await harness()
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})
    const deliver = createOverlayAssetDelivery({source: store})

    const response = await deliver({
      method: 'GET',
      url: `${overlayImageDeliveryPath(IMAGE_ID, 'p', 'ds') as string}?w=100`,
    })

    expect(response?.status).toBe(200)
    expect(response?.headers['content-type']).toBe('image/png')
    expect(response?.headers['content-length']).toBe(String(PNG.length))
    expect(Buffer.from(response?.body as Uint8Array).equals(PNG)).toBe(true)
    expect(response?.headers['x-overlay-asset']).toBe('branch-only')
    expect(response?.headers['x-overlay-asset-transform']).toBe('not-applied; w')
  })

  it('404s an asset that was never uploaded and 405s a write method', async () => {
    const {store} = await harness()
    const deliver = createOverlayAssetDelivery({source: store})

    expect((await deliver({method: 'GET', url: `${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID}`}))?.status)
      .toBe(404)
    expect((await deliver({method: 'POST', url: `${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID}`}))?.status)
      .toBe(405)
    /* Not an asset route at all: the handler abstains so the server can fall through. */
    expect(await deliver({method: 'GET', url: '/api/other'})).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Checkpoint interaction (PRD §29) — the deferral, made explicit
 * ------------------------------------------------------------------ */

describe('what a checkpoint carries (PRD §29, §14.1)', () => {
  it('describes each asset as reviewable text and carries no bytes', async () => {
    const {store} = await harness()
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    const manifest = await store.assetCheckpointManifest(OVERLAY_ID)
    expect(manifest.bytesIncluded).toBe(false)
    expect(manifest.assets).toEqual([
      {
        assetDocumentId: IMAGE_ID,
        checksum: PNG_SHA256,
        contentType: 'image/png',
        size: PNG.length,
        storageRef: `assets/blobs/${PNG_SHA256}.bin`,
      },
    ])
    /* Canonical and diffable: the manifest itself round-trips through §14.3. */
    expect(parse(serialize(manifest))).toEqual(manifest)
    expect(JSON.stringify(manifest)).not.toContain('\\u0000')
  })

  it('marks the blob directory as binary so Git never attempts a text diff', async () => {
    const {store} = await harness()
    await store.put({overlayId: OVERLAY_ID, bytes: PNG, filename: 'hero.png'})

    /* Patterns are relative to the directory holding the `.gitattributes`, and
       that file is written INSIDE `.sanity-overlay/`. This assertion once
       expected a leading `.sanity-overlay/`, which made Git resolve
       `.sanity-overlay/.sanity-overlay/assets/blobs/` — a path that cannot
       exist — so the rule was a silent no-op and this test was pinning the bug.

       Note what this case CANNOT establish, despite its name: a string in a file
       is not Git behaviour. `store-scaffold-reconcile.test.ts` asks
       `git check-attr` in a real repository, which is the only authority on
       whether the attribute actually applies. */
    const attributes = await readFile(store.layout.resolve('.gitattributes'), 'utf8')
    expect(attributes).toContain('assets/blobs/** binary')
  })
})

