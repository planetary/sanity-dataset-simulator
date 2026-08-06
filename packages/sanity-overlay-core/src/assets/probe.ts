/**
 * PRD §24.3 step 4 — "metadata is extracted locally", honestly.
 *
 * ## What this reads, and what it refuses to
 *
 * Sanity's hosted pipeline decodes the image. It can therefore report `lqip`,
 * `blurHash`, `thumbHash`, `palette`, `isOpaque` and EXIF. This probe decodes
 * nothing: it reads *container headers*, which are declarations the file makes
 * about itself and can be parsed exactly with no dependency and no pixel work.
 *
 * That buys, per format:
 *
 * | format | dimensions            | alpha                                   |
 * | ------ | --------------------- | --------------------------------------- |
 * | PNG    | `IHDR` width/height   | colour type 4/6, or a `tRNS` chunk      |
 * | JPEG   | `SOFn` frame header   | always `false` — JPEG has no alpha      |
 * | GIF    | logical screen desc.  | `null` — per-frame, needs frame decode  |
 * | WebP   | `VP8X` / `VP8L` / `VP8` | `VP8X` alpha flag, `VP8L` alpha bit   |
 *
 * Everything else is `null` and is named in `OMITTED_ASSET_METADATA_FIELDS`. The
 * rule this file exists to enforce: **a value that cannot be read is absent, never
 * approximated.** A truncated PNG yields `dimensions: null`, which in turn makes
 * {@link overlayAssetDocumentId} refuse to mint an ID — because an `image-…` ID
 * embeds `<width>x<height>` and there is no such thing as a Sanity-shaped image
 * asset with unknown dimensions.
 *
 * ## Why the bytes, not the declared type
 *
 * The format is sniffed from the magic bytes and the caller's `contentType` is
 * only ever a fallback for non-image data (PRD §24.5 "validate MIME type and
 * extension"). A browser upload can declare anything; the container cannot lie
 * about its own header without ceasing to be that format.
 */
import type {OverlayAssetDimensions, OverlayBinaryProbe} from './types'

export interface ProbeBinaryOptions {
  /** The client-supplied name. Used for a *file* extension only, never for format. */
  filename?: string
  /** The client-supplied MIME type. Used for non-image bytes only. */
  contentType?: string
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] /* "GIF8" */

const IMAGE_MIME: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
})

/** The ID's trailing segment. Sanity spells JPEG `jpg`; everything else matches. */
const IMAGE_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
})

const DEFAULT_FILE_MIME = 'application/octet-stream'
const DEFAULT_FILE_EXTENSION = 'bin'

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function dimensionsOf(width: number, height: number): OverlayAssetDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if (width <= 0 || height <= 0) return null
  return {width, height, aspectRatio: width / height}
}

interface ImageReading {
  format: string
  dimensions: OverlayAssetDimensions | null
  hasAlpha: boolean | null
}

/* ------------------------------------------------------------------ *
 * PNG (spec §11.2.2 IHDR, §11.3.2.1 tRNS)
 * ------------------------------------------------------------------ */

function readPng(bytes: Uint8Array): ImageReading {
  /* 8-byte signature, then chunks: length(4) type(4) data(length) crc(4). The
   * first chunk must be IHDR, whose data is 13 bytes: width, height, bit depth,
   * colour type, compression, filter, interlace. */
  if (bytes.length < 8 + 4 + 4 + 13) return {format: 'png', dimensions: null, hasAlpha: null}
  if (
    bytes[12] !== 0x49 /* I */ ||
    bytes[13] !== 0x48 /* H */ ||
    bytes[14] !== 0x44 /* D */ ||
    bytes[15] !== 0x52 /* R */
  ) {
    return {format: 'png', dimensions: null, hasAlpha: null}
  }

  const dimensions = dimensionsOf(readUInt32BE(bytes, 16), readUInt32BE(bytes, 20))
  const colorType = bytes[25]

  /* Colour types 4 (grey+alpha) and 6 (RGBA) carry an alpha channel outright.
   * Types 0 and 3 can still be transparent, but only via a `tRNS` chunk, so the
   * chunk list is walked rather than assumed. */
  let hasAlpha = colorType === 4 || colorType === 6
  if (!hasAlpha) {
    let offset = 8
    while (offset + 8 <= bytes.length) {
      const length = readUInt32BE(bytes, offset)
      const type =
        String.fromCharCode(bytes[offset + 4]) +
        String.fromCharCode(bytes[offset + 5]) +
        String.fromCharCode(bytes[offset + 6]) +
        String.fromCharCode(bytes[offset + 7])
      if (type === 'tRNS') {
        hasAlpha = true
        break
      }
      if (type === 'IDAT' || type === 'IEND') break
      /* `length` is an unsigned 32-bit field: a corrupt one must not wrap the
       * cursor backwards into an endless loop. */
      const next = offset + 12 + length
      if (!Number.isSafeInteger(next) || next <= offset) break
      offset = next
    }
  }

  return {format: 'png', dimensions, hasAlpha}
}

/* ------------------------------------------------------------------ *
 * JPEG (ITU-T T.81 — the SOFn frame header, not APP0/JFIF)
 * ------------------------------------------------------------------ */

/** Frame markers that carry width and height. `C4`/`C8`/`CC` are DHT/JPG/DAC. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function readJpeg(bytes: Uint8Array): ImageReading {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    /* Padding fill bytes and the standalone markers carry no segment length. */
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = readUInt16BE(bytes, offset + 2)
    if (length < 2) break
    if (isStartOfFrame(marker)) {
      /* marker(2) length(2) precision(1) height(2) width(2) */
      if (offset + 9 > bytes.length) break
      return {
        format: 'jpeg',
        dimensions: dimensionsOf(readUInt16BE(bytes, offset + 7), readUInt16BE(bytes, offset + 5)),
        /* JPEG has no alpha channel at all — this is a fact about the format, not
         * an unread field, so it is `false` rather than `null`. */
        hasAlpha: false,
      }
    }
    /* `SOS` starts entropy-coded data; no frame header follows it. */
    if (marker === 0xda) break
    offset += 2 + length
  }
  return {format: 'jpeg', dimensions: null, hasAlpha: false}
}

/* ------------------------------------------------------------------ *
 * GIF (89a §18 logical screen descriptor)
 * ------------------------------------------------------------------ */

function readGif(bytes: Uint8Array): ImageReading {
  if (bytes.length < 10) return {format: 'gif', dimensions: null, hasAlpha: null}
  return {
    format: 'gif',
    dimensions: dimensionsOf(readUInt16LE(bytes, 6), readUInt16LE(bytes, 8)),
    /* Transparency is a per-frame Graphic Control Extension flag. Reading it
     * means walking the frame stream, which this probe does not do. */
    hasAlpha: null,
  }
}

/* ------------------------------------------------------------------ *
 * WebP (RIFF container: VP8X extended, VP8L lossless, VP8 lossy)
 * ------------------------------------------------------------------ */

function readWebp(bytes: Uint8Array): ImageReading {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id =
      String.fromCharCode(bytes[offset]) +
      String.fromCharCode(bytes[offset + 1]) +
      String.fromCharCode(bytes[offset + 2]) +
      String.fromCharCode(bytes[offset + 3])
    const size = readUInt32LE(bytes, offset + 4)
    const data = offset + 8

    if (id === 'VP8X' && data + 10 <= bytes.length) {
      /* flags(1) reserved(3) canvasWidth-1(3 LE) canvasHeight-1(3 LE) */
      return {
        format: 'webp',
        dimensions: dimensionsOf(readUInt24LE(bytes, data + 4) + 1, readUInt24LE(bytes, data + 7) + 1),
        hasAlpha: (bytes[data] & 0x10) !== 0,
      }
    }
    if (id === 'VP8L' && data + 5 <= bytes.length && bytes[data] === 0x2f) {
      /* 14 bits width-1, 14 bits height-1, 1 bit alpha, 3 bits version. */
      const bits = readUInt32LE(bytes, data + 1)
      return {
        format: 'webp',
        dimensions: dimensionsOf((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1),
        hasAlpha: ((bits >>> 28) & 0x1) === 1,
      }
    }
    if (id === 'VP8 ' && data + 10 <= bytes.length) {
      /* Lossy keyframe: 3-byte frame tag, 3-byte start code, then 14-bit
       * width and height. Simple VP8 has no alpha channel. */
      return {
        format: 'webp',
        dimensions: dimensionsOf(
          readUInt16LE(bytes, data + 6) & 0x3fff,
          readUInt16LE(bytes, data + 8) & 0x3fff,
        ),
        hasAlpha: false,
      }
    }

    const padded = size % 2 === 1 ? size + 1 : size
    const next = data + padded
    if (!Number.isSafeInteger(next) || next <= offset) break
    offset = next
  }
  return {format: 'webp', dimensions: null, hasAlpha: null}
}

/* ------------------------------------------------------------------ *
 * Sniffing and the public probe
 * ------------------------------------------------------------------ */

function readImage(bytes: Uint8Array): ImageReading | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return readJpeg(bytes)
  }
  if (startsWith(bytes, GIF_SIGNATURE)) return readGif(bytes)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 /* R */ &&
    bytes[1] === 0x49 /* I */ &&
    bytes[2] === 0x46 /* F */ &&
    bytes[3] === 0x46 /* F */ &&
    bytes[8] === 0x57 /* W */ &&
    bytes[9] === 0x45 /* E */ &&
    bytes[10] === 0x42 /* B */ &&
    bytes[11] === 0x50 /* P */
  ) {
    return readWebp(bytes)
  }
  return null
}

/**
 * The extension a *non-image* upload gets: from the filename, or `bin`.
 *
 * Constrained to `[a-z0-9]+` because the extension is the last segment of the
 * asset document ID and must satisfy `@sanity/asset-utils`' pattern — which
 * incidentally makes it incapable of carrying a path separator, satisfying
 * §24.5 "prevent path traversal in filenames" by construction rather than by a
 * blacklist.
 */
export function extensionFromFilename(filename: string | undefined): string {
  if (typeof filename !== 'string') return DEFAULT_FILE_EXTENSION
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return DEFAULT_FILE_EXTENSION
  const candidate = filename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]+$/.test(candidate) ? candidate : DEFAULT_FILE_EXTENSION
}

/** Read everything the container states about itself, and nothing else (§24.3 step 4). */
export function probeBinary(
  bytes: Uint8Array,
  options: ProbeBinaryOptions = {},
): OverlayBinaryProbe {
  const image = readImage(bytes)
  if (image !== null) {
    return {
      kind: 'image',
      format: image.format,
      /* Sniffed, so a lying `contentType` cannot decide the stored MIME type. */
      mimeType: IMAGE_MIME[image.format] ?? DEFAULT_FILE_MIME,
      extension: IMAGE_EXTENSION[image.format] ?? DEFAULT_FILE_EXTENSION,
      dimensions: image.dimensions,
      hasAlpha: image.hasAlpha,
    }
  }

  const declared = typeof options.contentType === 'string' ? options.contentType.trim() : ''
  return {
    kind: 'file',
    format: null,
    mimeType: declared === '' ? DEFAULT_FILE_MIME : declared,
    extension: extensionFromFilename(options.filename),
    dimensions: null,
    hasAlpha: null,
  }
}
