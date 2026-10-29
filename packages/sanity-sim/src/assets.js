import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Asset storage and the image/file CDN.
 *
 * Bytes live under `<root>/.sanity-sim/assets/<sha1>.<ext>` (uploaded locally)
 * or `<root>/.sanity-sim/.cache/assets/` (fetched lazily from cdn.sanity.io for
 * synced datasets). Asset documents look exactly like Content Lake's, with
 * `url` pointing at this server so Studio previews resolve locally.
 */

let sharpModule
async function loadSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = (await import('sharp')).default
    } catch {
      sharpModule = null
    }
  }
  return sharpModule
}

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
}

const EXTENSION_MIMES = Object.fromEntries(Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime]))
EXTENSION_MIMES.jpeg = 'image/jpeg'

export function mimeForExtension(ext) {
  return EXTENSION_MIMES[ext?.toLowerCase()] ?? 'application/octet-stream'
}

export class AssetStore {
  constructor({root}) {
    this.dir = path.join(root, '.sanity-sim', 'assets')
    this.cacheDir = path.join(root, '.sanity-sim', '.cache', 'assets')
  }

  /**
   * Build the asset document for an upload and store its bytes.
   * @returns {Promise<object>} the `sanity.imageAsset` / `sanity.fileAsset` document
   */
  async ingest({kind, bytes, contentType, filename, projectId, dataset, publicBase, meta = {}}) {
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const mime = (contentType || '').split(';')[0].trim() || sniffMime(bytes) || 'application/octet-stream'
    const extension = extensionFor(mime, filename)
    fs.mkdirSync(this.dir, {recursive: true})
    const file = path.join(this.dir, `${sha1}.${extension}`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes)

    const common = {
      assetId: sha1,
      sha1hash: sha1,
      extension,
      mimeType: mime,
      size: bytes.length,
      originalFilename: filename ?? `${sha1}.${extension}`,
      uploadId: sha1.slice(0, 32),
      ...pick(meta, ['title', 'description', 'label', 'creditLine', 'altText']),
      ...(meta.sourceName ? {source: {name: meta.sourceName, id: meta.sourceId, url: meta.sourceUrl}} : {}),
    }

    if (kind === 'images') {
      const dims = imageDimensions(bytes, mime) ?? {width: 1, height: 1}
      const name = `${sha1}-${dims.width}x${dims.height}.${extension}`
      const metadata = {
        _type: 'sanity.imageMetadata',
        dimensions: {
          _type: 'sanity.imageDimensions',
          width: dims.width,
          height: dims.height,
          aspectRatio: dims.width / dims.height,
        },
        hasAlpha: ['png', 'gif', 'webp', 'avif', 'svg'].includes(extension),
        isOpaque: !['png', 'gif', 'webp', 'avif', 'svg'].includes(extension),
      }
      const lqip = await lqipFor(bytes)
      if (lqip) metadata.lqip = lqip
      return {
        _id: `image-${sha1}-${dims.width}x${dims.height}-${extension}`,
        _type: 'sanity.imageAsset',
        ...common,
        metadata,
        path: `images/${projectId}/${dataset}/${name}`,
        url: `${publicBase}/images/${projectId}/${dataset}/${name}`,
      }
    }
    const name = `${sha1}.${extension}`
    return {
      _id: `file-${sha1}-${extension}`,
      _type: 'sanity.fileAsset',
      ...common,
      path: `files/${projectId}/${dataset}/${name}`,
      url: `${publicBase}/files/${projectId}/${dataset}/${name}`,
    }
  }

  /** Find stored bytes for `<sha1>.<ext>`, locally uploaded or cached from a sync. */
  locate(sha1, extension) {
    for (const dir of [this.dir, this.cacheDir]) {
      const file = path.join(dir, `${sha1}.${extension}`)
      if (fs.existsSync(file)) return file
    }
    return null
  }

  cache(sha1, extension, bytes) {
    fs.mkdirSync(this.cacheDir, {recursive: true})
    const file = path.join(this.cacheDir, `${sha1}.${extension}`)
    fs.writeFileSync(file, bytes)
    return file
  }

  /** Every locally stored or cached asset file, for the dashboard. */
  stats() {
    const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0)
    return {local: count(this.dir), cached: count(this.cacheDir), transforms: Boolean(sharpModule)}
  }
}

/**
 * Apply Sanity image-URL parameters with sharp when it is installed; without
 * sharp the original bytes are served (correct image, untransformed).
 * Supports w, h, max-w, max-h, min-w, min-h, fit, crop, rect, fm, auto=format,
 * q, dpr, blur, sharp, flip, invert, sat=-100, bg.
 */
export async function transformImage(file, searchParams, accept = '') {
  const sharp = await loadSharp()
  const params = Object.fromEntries(searchParams.entries())
  const meaningful = Object.keys(params).filter((key) => !['dl', 'dlRaw'].includes(key))
  if (!sharp || meaningful.length === 0) return null

  let image = sharp(file, {animated: false})
  const meta = await image.metadata()
  if (params.rect) {
    const [left, top, width, height] = params.rect.split(',').map(Number)
    if ([left, top, width, height].every(Number.isFinite)) image = image.extract({left, top, width, height})
  }
  const dpr = Math.min(Math.max(Number(params.dpr) || 1, 1), 5)
  const scale = (value) => (value ? Math.round(Number(value) * dpr) : undefined)
  let width = scale(params.w)
  let height = scale(params.h)
  const maxW = scale(params['max-w'])
  const maxH = scale(params['max-h'])
  if (maxW && (!width || width > maxW)) width = width ? Math.min(width, maxW) : Math.min(meta.width, maxW)
  if (maxH && (!height || height > maxH)) height = height ? Math.min(height, maxH) : Math.min(meta.height, maxH)
  if (width || height) {
    const fit = {clip: 'inside', max: 'inside', min: 'outside', crop: 'cover', fill: 'contain', fillmax: 'contain', scale: 'fill'}[params.fit] ?? 'cover'
    const position = params.crop === 'entropy' ? sharp.strategy.entropy : params.crop && params.crop !== 'focalpoint' ? params.crop.replace(',', ' ') : 'centre'
    image = image.resize({
      width,
      height,
      fit,
      position,
      withoutEnlargement: params.fit === 'max',
      background: params.bg ? `#${params.bg}` : {r: 255, g: 255, b: 255, alpha: params.fit === 'fill' ? 1 : 0},
    })
  }
  if (params.blur) image = image.blur(Math.max(0.3, Number(params.blur) / 10))
  if (params.sharp) image = image.sharpen()
  if (params.flip === 'h' || params.flip === 'hv') image = image.flop()
  if (params.flip === 'v' || params.flip === 'hv') image = image.flip()
  if (params.invert === 'true') image = image.negate()
  if (params.sat === '-100') image = image.grayscale()

  let format = params.fm
  if (!format && params.auto === 'format') format = accept.includes('image/avif') ? 'avif' : accept.includes('image/webp') ? 'webp' : undefined
  const quality = params.q ? Number(params.q) : 75
  if (format === 'json') return {json: {width: meta.width, height: meta.height, format: meta.format}}
  if (format) {
    const sharpFormat = {jpg: 'jpeg', pjpg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif'}[format]
    if (sharpFormat) image = image.toFormat(sharpFormat, {quality, progressive: format === 'pjpg'})
  } else if (params.q) {
    image = image.toFormat(meta.format, {quality})
  }
  const {data, info} = await image.toBuffer({resolveWithObject: true})
  return {bytes: data, contentType: `image/${info.format === 'jpeg' ? 'jpeg' : info.format}`}
}

async function lqipFor(bytes) {
  const sharp = await loadSharp()
  if (!sharp) return undefined
  try {
    const out = await sharp(bytes).resize(20, 20, {fit: 'inside'}).jpeg({quality: 40}).toBuffer()
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return undefined
  }
}

function extensionFor(mime, filename) {
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime]
  const fromName = filename?.split('.').pop()
  return fromName && fromName !== filename ? fromName.toLowerCase() : 'bin'
}

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.slice(0, 3).toString() === 'GIF') return 'image/gif'
  if (bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

/** Width/height from the file header: PNG, JPEG, GIF, WebP, SVG. */
export function imageDimensions(bytes, mime) {
  try {
    if (mime === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50)) {
      return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)}
    }
    if (mime === 'image/gif' || bytes.slice(0, 3).toString() === 'GIF') {
      return {width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8)}
    }
    if (bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WEBP') {
      const chunk = bytes.slice(12, 16).toString()
      if (chunk === 'VP8X') return {width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3)}
      if (chunk === 'VP8L') {
        const b = bytes.readUInt32LE(21)
        return {width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1}
      }
      if (chunk === 'VP8 ') return {width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff}
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) return null
        const marker = bytes[offset + 1]
        const length = bytes.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7)}
        }
        offset += 2 + length
      }
    }
    if (mime === 'image/svg+xml') {
      const text = bytes.toString('utf8', 0, Math.min(bytes.length, 4096))
      const width = Number(text.match(/\bwidth="([\d.]+)/)?.[1])
      const height = Number(text.match(/\bheight="([\d.]+)/)?.[1])
      if (width && height) return {width: Math.round(width), height: Math.round(height)}
      const viewBox = text.match(/viewBox="[\d.\s-]+?([\d.]+)\s+([\d.]+)"/)
      if (viewBox) return {width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2]))}
    }
  } catch {
    return null
  }
  return null
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined && object[key] !== null).map((key) => [key, object[key]]))
}
