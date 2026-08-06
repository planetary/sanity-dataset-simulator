/**
 * Branch-local assets, the pure half — PRD §24.2 (branch-local asset model),
 * §24.3 steps 4-6 (metadata extraction, synthetic asset document, content
 * document reference), §24.6 (labelling), §24.8 (degradation) and the §18.8
 * strong-reference rule as it applies to deleting an asset that is in use.
 *
 * SCOPE RULING THIS FILE LIVES UNDER (owner, 2026-08-05, PRD §0.0): nothing here
 * uploads to Sanity. Every byte stays in the overlay. §24.9 asset promotion is
 * out of scope permanently, so there is no `promotedSanityAssetId` and no
 * reference rewrite.
 *
 * ## Why the identifiers are shaped the way they are
 *
 * A synthetic asset document is only useful if the rest of the Sanity ecosystem
 * recognises it. `@sanity/asset-utils@2.3.0` — the package `sanity@6.8.0` uses to
 * parse asset IDs — pins the shape with these two regexes (quoted verbatim from
 * its `dist/index.js`, line 1):
 *
 * ```js
 * imageAssetIdPattern = /^image-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-\d+x\d+-[a-z0-9]+$/
 * fileAssetIdPattern  = /^file-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-[a-z0-9]+$/
 * ```
 *
 * Two consequences the implementation cannot argue with:
 *
 * 1. The digest segment is 40 lowercase hex characters — a SHA-1, which is also
 *    exactly what Sanity's own `sha1hash` field holds. A SHA-256 (64 hex) does
 *    not match either alternative. So the *document ID* is addressed by SHA-1
 *    while the *bytes on disk* are addressed by SHA-256 (PRD §14.1 content
 *    addressing). Both are functions of the same bytes, so "same file uploaded
 *    twice" collapses on both axes at once.
 * 2. An image ID embeds `<width>x<height>`. There is therefore no such thing as
 *    a Sanity-shaped image asset whose dimensions are unknown: if the container
 *    will not yield them, the upload must fail rather than invent them.
 *
 * The last test in the identity section re-reads those regexes out of the
 * installed package, so the constants above cannot silently go stale.
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {crc32, deflateSync} from 'node:zlib'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {
  OMITTED_ASSET_METADATA_FIELDS,
  OVERLAY_ASSET_BASE_PATH,
  OVERLAY_FILE_ASSET_TYPE,
  OVERLAY_IMAGE_ASSET_TYPE,
  OverlayAssetError,
  assetUsage,
  assertAssetDeletable,
  isOverlayAssetDocumentId,
  overlayAssetDocumentId,
  parseOverlayAssetDocumentId,
  probeBinary,
  sha1Hex,
  synthesizeAssetDocument,
} from '../../sanity-overlay-core/src/assets/index'
import type {OverlayAssetRecord} from '../../sanity-overlay-core/src/assets/index'
import {
  OVERLAY_FORMAT_VERSION,
  applyTransaction,
  createOverlayState,
  createStrongReferenceCheck,
  deleteDocument,
  edit,
  parse,
  resolveReferenceTarget,
  serialize,
} from '../../sanity-overlay-core/src/index'
import type {OverlayState} from '../../sanity-overlay-core/src/index'

/* ------------------------------------------------------------------ *
 * Binary fixtures — real containers, built here, never checked in
 *
 * `repo-hygiene.test.ts` requires every tracked file to be reviewable text, so
 * the fixtures are constructed rather than committed. They are genuine files,
 * not header stubs: the PNG carries a real deflate-compressed IDAT and CRC-32
 * chunk checksums computed by `node:zlib`, so it is a file an image decoder
 * would accept. That matters — a probe tested only against hand-waved headers
 * proves nothing about real uploads.
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

/** `colorType`: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA (PNG spec §11.2.2). */
function makePng(width: number, height: number, colorType = 6, fill = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const raw = Buffer.alloc(height * (1 + width * channels), fill)
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * channels)] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A palette PNG whose transparency lives in a `tRNS` chunk, not in the colour type. */
function makePalettePngWithTrns(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 3
  const raw = Buffer.alloc(height * (1 + width))
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
    pngChunk('tRNS', Buffer.from([0])),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** SOI · APP0/JFIF · SOF0 (where the dimensions live) · SOS · EOI. */
function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ])
  const sof0 = Buffer.alloc(4 + 6 + 9)
  sof0[0] = 0xff
  sof0[1] = 0xc0
  sof0.writeUInt16BE(8 + 9, 2)
  sof0[4] = 8
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0[9] = 3
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ])
}

function makeGif(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  header[10] = 0x00
  return Buffer.concat([header, Buffer.from([0x3b])])
}

function riff(fourCC: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32LE(4 + payload.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from(fourCC, 'latin1'), payload])
}

function webpChunk(id: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32LE(data.length, 0)
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.from([0])]) : data
  return Buffer.concat([Buffer.from(id, 'latin1'), size, padded])
}

/** Extended WebP: the canvas size is `width - 1` / `height - 1`, 24-bit LE. */
function makeWebpVp8x(width: number, height: number, alpha: boolean): Buffer {
  const data = Buffer.alloc(10)
  data[0] = alpha ? 0x10 : 0x00
  data.writeUIntLE(width - 1, 4, 3)
  data.writeUIntLE(height - 1, 7, 3)
  return riff('WEBP', webpChunk('VP8X', data))
}

/** Lossless WebP: signature `0x2f`, then 14 bits w-1, 14 bits h-1, 1 bit alpha. */
function makeWebpVp8l(width: number, height: number, alpha: boolean): Buffer {
  const bits =
    ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28)
  const data = Buffer.alloc(5)
  data[0] = 0x2f
  data.writeUInt32LE(bits >>> 0, 1)
  return riff('WEBP', webpChunk('VP8L', data))
}

/* Independent oracles: node:crypto, not the pure implementations under test. */
const nodeSha1 = (bytes: Uint8Array): string =>
  createHash('sha1').update(Buffer.from(bytes)).digest('hex')

/* ------------------------------------------------------------------ *
 * §24.3 step 4 — metadata extraction, from the container only
 * ------------------------------------------------------------------ */

describe('probeBinary — PRD §24.3 step 4, honest container metadata', () => {
  it('reads PNG dimensions from IHDR', () => {
    const probe = probeBinary(makePng(37, 11, 6))
    expect(probe.kind).toBe('image')
    expect(probe.format).toBe('png')
    expect(probe.mimeType).toBe('image/png')
    expect(probe.extension).toBe('png')
    expect(probe.dimensions).toEqual({width: 37, height: 11, aspectRatio: 37 / 11})
  })

  it('reads JPEG dimensions from the SOF0 marker, not from the APP0 segment', () => {
    const probe = probeBinary(makeJpeg(120, 64))
    expect(probe.format).toBe('jpeg')
    expect(probe.mimeType).toBe('image/jpeg')
    expect(probe.extension).toBe('jpg')
    expect(probe.dimensions).toEqual({width: 120, height: 64, aspectRatio: 120 / 64})
  })

  it('reads GIF dimensions from the logical screen descriptor', () => {
    const probe = probeBinary(makeGif(9, 4))
    expect(probe.format).toBe('gif')
    expect(probe.dimensions).toEqual({width: 9, height: 4, aspectRatio: 9 / 4})
  })

  it('reads WebP dimensions from a VP8X chunk', () => {
    const probe = probeBinary(makeWebpVp8x(300, 150, false))
    expect(probe.format).toBe('webp')
    expect(probe.mimeType).toBe('image/webp')
    expect(probe.dimensions).toEqual({width: 300, height: 150, aspectRatio: 2})
  })

  it('reads WebP dimensions from a VP8L chunk', () => {
    const probe = probeBinary(makeWebpVp8l(64, 32, true))
    expect(probe.format).toBe('webp')
    expect(probe.dimensions).toEqual({width: 64, height: 32, aspectRatio: 2})
  })

  it('sniffs the format from the bytes, ignoring a lying content type', () => {
    const probe = probeBinary(makePng(4, 4), {filename: 'evil.jpg', contentType: 'image/jpeg'})
    expect(probe.format).toBe('png')
    expect(probe.mimeType).toBe('image/png')
    expect(probe.extension).toBe('png')
  })

  describe('hasAlpha — reported only where the container states it', () => {
    it('is true for an RGBA PNG (colour type 6)', () => {
      expect(probeBinary(makePng(2, 2, 6)).hasAlpha).toBe(true)
    })

    it('is true for a greyscale+alpha PNG (colour type 4)', () => {
      expect(probeBinary(makePng(2, 2, 4)).hasAlpha).toBe(true)
    })

    it('is false for an RGB PNG (colour type 2)', () => {
      expect(probeBinary(makePng(2, 2, 2)).hasAlpha).toBe(false)
    })

    it('is true for a palette PNG carrying a tRNS chunk', () => {
      expect(probeBinary(makePalettePngWithTrns(2, 2)).hasAlpha).toBe(true)
    })

    it('is false for JPEG, which has no alpha channel at all', () => {
      expect(probeBinary(makeJpeg(8, 8)).hasAlpha).toBe(false)
    })

    it('follows the VP8X alpha flag for WebP', () => {
      expect(probeBinary(makeWebpVp8x(8, 8, true)).hasAlpha).toBe(true)
      expect(probeBinary(makeWebpVp8x(8, 8, false)).hasAlpha).toBe(false)
    })

    it('follows the VP8L alpha bit for lossless WebP', () => {
      expect(probeBinary(makeWebpVp8l(8, 8, true)).hasAlpha).toBe(true)
      expect(probeBinary(makeWebpVp8l(8, 8, false)).hasAlpha).toBe(false)
    })

    it('is null for GIF — transparency is per-frame and this probe does not decode frames', () => {
      expect(probeBinary(makeGif(8, 8)).hasAlpha).toBeNull()
    })
  })

  it('classifies unrecognised bytes as a file, with no dimensions', () => {
    const probe = probeBinary(new TextEncoder().encode('hello, world'), {filename: 'notes.txt'})
    expect(probe.kind).toBe('file')
    expect(probe.format).toBeNull()
    expect(probe.dimensions).toBeNull()
    expect(probe.hasAlpha).toBeNull()
  })

  it('never invents dimensions for truncated image bytes', () => {
    const truncated = makePng(10, 10).subarray(0, 12)
    expect(probeBinary(truncated).dimensions).toBeNull()
  })

  it('derives a file extension from the filename only for non-image bytes', () => {
    expect(probeBinary(new Uint8Array([1, 2, 3]), {filename: 'report.PDF'}).extension).toBe('pdf')
    expect(probeBinary(new Uint8Array([1, 2, 3]), {filename: 'noext'}).extension).toBe('bin')
  })
})

/* ------------------------------------------------------------------ *
 * Identity — the shape `@sanity/asset-utils` will accept
 * ------------------------------------------------------------------ */

const IMAGE_ASSET_ID_PATTERN = /^image-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-\d+x\d+-[a-z0-9]+$/
const FILE_ASSET_ID_PATTERN = /^file-([a-zA-Z0-9_]{24,40}|[a-f0-9]{40})+-[a-z0-9]+$/

describe('overlayAssetDocumentId — PRD §24.2 identity', () => {
  const png = makePng(48, 24, 6)
  const sha1 = nodeSha1(png)

  it('computes SHA-1 that matches node:crypto, digit for digit', () => {
    expect(sha1Hex(png)).toBe(sha1)
    expect(sha1Hex(new Uint8Array(0))).toBe(nodeSha1(new Uint8Array(0)))
    expect(sha1Hex(new TextEncoder().encode('abc'))).toBe(
      nodeSha1(new TextEncoder().encode('abc')),
    )
  })

  it('mints an image ID @sanity/asset-utils recognises', () => {
    const id = overlayAssetDocumentId({
      kind: 'image',
      sha1,
      extension: 'png',
      dimensions: {width: 48, height: 24, aspectRatio: 2},
    })
    expect(id).toBe(`image-${sha1}-48x24-png`)
    expect(IMAGE_ASSET_ID_PATTERN.test(id)).toBe(true)
    expect(isOverlayAssetDocumentId(id)).toBe(true)
  })

  it('mints a file ID @sanity/asset-utils recognises', () => {
    const id = overlayAssetDocumentId({kind: 'file', sha1, extension: 'pdf'})
    expect(id).toBe(`file-${sha1}-pdf`)
    expect(FILE_ASSET_ID_PATTERN.test(id)).toBe(true)
    expect(isOverlayAssetDocumentId(id)).toBe(true)
  })

  it('refuses to mint an image ID without dimensions rather than inventing them', () => {
    expect(() => overlayAssetDocumentId({kind: 'image', sha1, extension: 'png'})).toThrow(
      OverlayAssetError,
    )
    try {
      overlayAssetDocumentId({kind: 'image', sha1, extension: 'png'})
    } catch (error) {
      expect((error as OverlayAssetError).code).toBe('OVERLAY_ASSET_METADATA_UNAVAILABLE')
    }
  })

  it('round-trips through parseOverlayAssetDocumentId', () => {
    const id = overlayAssetDocumentId({
      kind: 'image',
      sha1,
      extension: 'png',
      dimensions: {width: 48, height: 24, aspectRatio: 2},
    })
    expect(parseOverlayAssetDocumentId(id)).toEqual({
      kind: 'image',
      sha1,
      extension: 'png',
      width: 48,
      height: 24,
    })
    expect(parseOverlayAssetDocumentId(`file-${sha1}-pdf`)).toEqual({
      kind: 'file',
      sha1,
      extension: 'pdf',
    })
  })

  it('rejects anything that is not an asset ID, including near misses', () => {
    for (const candidate of [
      'article-1',
      'drafts.article-1',
      `image-${sha1}-48x24`,
      `image-${sha1.toUpperCase()}-48x24-png`,
      `image-${sha1}-48x24-PNG`,
      `image-${sha1.slice(0, 20)}-48x24-png`,
      `image-${sha1}-48x24-png/../etc`,
      `file-${sha1}`,
      '',
    ]) {
      expect(isOverlayAssetDocumentId(candidate)).toBe(false)
      expect(parseOverlayAssetDocumentId(candidate)).toBeNull()
    }
  })

  /**
   * Provenance, not a guess: re-read the two patterns out of the installed
   * package so an upgrade that changes them fails here instead of silently
   * producing IDs Studio will not parse.
   */
  const assetUtilsRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../node_modules/.pnpm',
  )
  const assetUtilsDist = existsSync(assetUtilsRoot)
    ? readdirSync(assetUtilsRoot)
        .filter((entry) => entry.startsWith('@sanity+asset-utils@'))
        .map((entry) => join(assetUtilsRoot, entry, 'node_modules/@sanity/asset-utils/dist/index.js'))
        .find((candidate) => existsSync(candidate))
    : undefined

  it.skipIf(assetUtilsDist === undefined)(
    'still matches the ID patterns compiled into the installed @sanity/asset-utils',
    () => {
      const source = readFileSync(assetUtilsDist as string, 'utf8')
      expect(source).toContain(IMAGE_ASSET_ID_PATTERN.source)
      expect(source).toContain(FILE_ASSET_ID_PATTERN.source)
    },
  )
})

/* ------------------------------------------------------------------ *
 * §24.3 step 5 — the synthetic asset document
 * ------------------------------------------------------------------ */

const PNG = makePng(64, 32, 6)
const PNG_SHA1 = nodeSha1(PNG)
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex')
const IMAGE_ID = `image-${PNG_SHA1}-64x32-png`

function imageRecord(overrides: Partial<OverlayAssetRecord> = {}): OverlayAssetRecord {
  return {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId: 'overlay-assets',
    assetDocumentId: IMAGE_ID,
    assetId: PNG_SHA1,
    kind: 'image',
    provider: 'filesystem',
    storageRef: `assets/blobs/${PNG_SHA256}.bin`,
    checksum: PNG_SHA256,
    sha1hash: PNG_SHA1,
    originalFilename: 'hero.png',
    contentType: 'image/png',
    size: PNG.length,
    metadata: {
      extension: 'png',
      width: 64,
      height: 32,
      aspectRatio: 2,
      hasAlpha: true,
      omitted: [...OMITTED_ASSET_METADATA_FIELDS],
    },
    createdAt: '2026-08-06T09:00:00.000Z',
    ...overrides,
  }
}

describe('synthesizeAssetDocument — PRD §24.3 step 5, §24.6 labelling', () => {
  const document = synthesizeAssetDocument(imageRecord())

  it('is a sanity.imageAsset whose _id is the minted asset ID', () => {
    expect(document._type).toBe(OVERLAY_IMAGE_ASSET_TYPE)
    expect(OVERLAY_IMAGE_ASSET_TYPE).toBe('sanity.imageAsset')
    expect(document._id).toBe(IMAGE_ID)
  })

  it('carries every field Sanity computes without decoding pixels', () => {
    expect(document.assetId).toBe(PNG_SHA1)
    expect(document.sha1hash).toBe(PNG_SHA1)
    expect(document.size).toBe(PNG.length)
    expect(document.mimeType).toBe('image/png')
    expect(document.extension).toBe('png')
    expect(document.originalFilename).toBe('hero.png')
  })

  it('carries the dimensions block Studio needs to lay a preview out', () => {
    expect(document.metadata).toMatchObject({
      _type: 'sanity.imageMetadata',
      dimensions: {_type: 'sanity.imageDimensions', width: 64, height: 32, aspectRatio: 2},
      hasAlpha: true,
    })
  })

  it('omits every field that would require decoding, and never fabricates one', () => {
    const metadata = document.metadata as Record<string, unknown>
    for (const field of ['isOpaque', 'lqip', 'blurHash', 'thumbHash', 'palette', 'exif', 'image']) {
      expect(Object.hasOwn(metadata, field)).toBe(false)
    }
    expect(Object.hasOwn(document, 'uploadId')).toBe(false)
  })

  it('declares what it omitted, so a consumer can tell absent from unknown', () => {
    const marker = document.overlayAsset as Record<string, unknown>
    expect(marker.branchOnly).toBe(true)
    expect(marker.provider).toBe('filesystem')
    expect(marker.blobRef).toBe(PNG_SHA256)
    expect(marker.omittedMetadata).toEqual([...OMITTED_ASSET_METADATA_FIELDS])
    expect(OMITTED_ASSET_METADATA_FIELDS).toContain('metadata.isOpaque')
    expect(OMITTED_ASSET_METADATA_FIELDS).toContain('metadata.lqip')
    expect(OMITTED_ASSET_METADATA_FIELDS).toContain('metadata.palette')
  })

  it('points url at the local delivery route, never at the Sanity CDN', () => {
    expect(document.url).toBe(`${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID}`)
    expect(String(document.url)).not.toContain('sanity.io')
    expect(String(document.path)).toBe(`assets/blobs/${PNG_SHA256}.bin`)
    expect(String(document.path)).not.toContain('cdn.sanity')
  })

  it('honours an explicit basePath so a host app can mount the route anywhere', () => {
    const mounted = synthesizeAssetDocument(imageRecord(), {basePath: '/branch/files'})
    expect(mounted.url).toBe(`/branch/files/${IMAGE_ID}`)
  })

  it('emits a sanity.fileAsset with no image metadata block for a file upload', () => {
    const fileId = `file-${PNG_SHA1}-pdf`
    const fileDoc = synthesizeAssetDocument(
      imageRecord({
        assetDocumentId: fileId,
        kind: 'file',
        contentType: 'application/pdf',
        originalFilename: 'brief.pdf',
        metadata: {extension: 'pdf', omitted: [...OMITTED_ASSET_METADATA_FIELDS]},
      }),
    )
    expect(fileDoc._type).toBe(OVERLAY_FILE_ASSET_TYPE)
    expect(OVERLAY_FILE_ASSET_TYPE).toBe('sanity.fileAsset')
    expect(fileDoc._id).toBe(fileId)
    expect(fileDoc.extension).toBe('pdf')
    expect((fileDoc.metadata as Record<string, unknown>)._type).toBeUndefined()
    expect(Object.hasOwn(fileDoc.metadata as object, 'dimensions')).toBe(false)
  })

  it('survives the canonical serializer unchanged (PRD §14.3)', () => {
    expect(parse(serialize(document))).toEqual(document)
  })
})

/* ------------------------------------------------------------------ *
 * §24.3 step 6 — a content document references the synthetic asset
 * ------------------------------------------------------------------ */

const ACTOR = {type: 'user', id: 'valdis'} as const
const clock = (): string => '2026-08-06T09:00:00.000Z'

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
    now: clock,
  }
}

/** Land the synthetic asset document in the overlay as an ordinary branch document. */
function withAsset(state: OverlayState = createOverlayState({overlayId: 'overlay-assets'})) {
  return applyTransaction(
    state,
    [{type: 'create', document: synthesizeAssetDocument(imageRecord())}],
    txOptions(),
  ).state
}

/** An article whose `cover.asset` points at the branch asset. */
function withArticleUsingAsset(state: OverlayState): OverlayState {
  /* `edit` patches an existing document (§18.4); the article has to exist before
   * it can acquire a cover, exactly as it would in Studio. */
  const created = applyTransaction(
    state,
    [{type: 'create', document: {_id: 'article-1', _type: 'article', title: 'Cover story'}}],
    txOptions(),
  ).state
  return edit(
    created,
    {
      id: 'article-1',
      operations: [
        {
          type: 'set',
          path: ['cover'],
          value: {_type: 'image', asset: {_type: 'reference', _ref: IMAGE_ID}},
        },
      ],
    },
    txOptions(),
  ).state
}

describe('a branch document referencing a branch asset (PRD §24.3 step 6, §19.2)', () => {
  it('resolves the asset reference like any other document', () => {
    const state = withArticleUsingAsset(withAsset())
    const resolved = resolveReferenceTarget(state, IMAGE_ID, {perspective: 'published'})

    expect(resolved.available).toBe(true)
    /* §19.2's own vocabulary: the asset exists only in the branch, so the
     * classification is `branch-created` — the most specific of the five
     * origins, not a generic "local". */
    expect(resolved.origin).toBe('branch-created')
    expect(resolved.document?._type).toBe('sanity.imageAsset')
    expect(resolved.document?._id).toBe(IMAGE_ID)
    expect((resolved.document as Record<string, unknown>).url).toBe(
      `${OVERLAY_ASSET_BASE_PATH}/${IMAGE_ID}`,
    )
  })

  it('reports an unresolvable reference when the asset was never uploaded', () => {
    const state = withArticleUsingAsset(createOverlayState({overlayId: 'overlay-assets'}))
    const resolved = resolveReferenceTarget(state, IMAGE_ID, {perspective: 'published'})
    expect(resolved.available).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * §24 delete protection, consistent with §18.8's strong-reference rule
 * ------------------------------------------------------------------ */

describe('asset usage tracking and delete protection (PRD §24.6, §24.8, §18.8)', () => {
  it('reports nothing for an asset nobody references', () => {
    expect(assetUsage(withAsset(), IMAGE_ID)).toEqual([])
  })

  it('names the document and the path that uses the asset', () => {
    const usage = assetUsage(withArticleUsingAsset(withAsset()), IMAGE_ID)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      referringDocumentId: 'article-1',
      targetId: IMAGE_ID,
      strength: 'strong',
      path: ['cover', 'asset'],
    })
  })

  it('blocks deleting an asset that is in use', () => {
    const state = withArticleUsingAsset(withAsset())
    expect(() => assertAssetDeletable(state, IMAGE_ID)).toThrow(OverlayAssetError)
    try {
      assertAssetDeletable(state, IMAGE_ID)
      throw new Error('assertAssetDeletable did not throw')
    } catch (error) {
      expect(error).toBeInstanceOf(OverlayAssetError)
      expect((error as OverlayAssetError).code).toBe('OVERLAY_ASSET_IN_USE')
      expect((error as OverlayAssetError).details.usedBy).toEqual(['article-1'])
    }
  })

  it('permits deleting an asset once the last reference is removed', () => {
    const used = withArticleUsingAsset(withAsset())
    const released = edit(used, {id: 'article-1', operations: [{type: 'unset', path: ['cover']}]}, txOptions()).state

    expect(assetUsage(released, IMAGE_ID)).toEqual([])
    expect(() => assertAssetDeletable(released, IMAGE_ID)).not.toThrow()
  })

  it('permits deleting an asset when the only referrer is deleted in the same breath', () => {
    const used = withArticleUsingAsset(withAsset())
    const gone = deleteDocument(used, {id: 'article-1'}, txOptions()).state
    expect(() => assertAssetDeletable(gone, IMAGE_ID)).not.toThrow()
  })

  it('is consistent with §18.8: the delete action blocks on the same reference', () => {
    const state = withArticleUsingAsset(withAsset())
    expect(() =>
      deleteDocument(state, {id: IMAGE_ID}, {
        ...txOptions(),
        checkStrongReferences: createStrongReferenceCheck(state),
      }),
    ).toThrow(/OVERLAY_ACTION_BLOCKED|strong reference/i)
  })
})
