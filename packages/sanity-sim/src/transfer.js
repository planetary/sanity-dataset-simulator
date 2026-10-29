import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Import and export in `sanity dataset export` formats: plain NDJSON, or the
 * `.tar.gz` the Sanity CLI writes (`<name>/data.ndjson`, `images/`, `files/`).
 */

export async function importFile(sim, datasetName, file, {replace = false} = {}) {
  const dataset = sim.dataset(datasetName)
  const {documents, assets} = readExport(file)
  for (const asset of assets) {
    const match = asset.name.match(/([a-f0-9]{40})(?:-\d+x\d+)?\.([a-z0-9]+)$/i)
    if (match) sim.assets.cache(match[1], match[2], asset.bytes)
  }
  if (replace) dataset.reset({keepRemote: true})
  const chunk = 500
  for (let i = 0; i < documents.length; i += chunk) {
    const mutations = documents.slice(i, i + chunk).map((doc) => ({createOrReplace: stripImportFields(doc)}))
    await dataset.commit(mutations, {author: 'sanity-sim.import'})
  }
  dataset.flush()
  return {documents: documents.length, assets: assets.length}
}

export function exportFile(sim, datasetName, file) {
  const dataset = sim.dataset(datasetName)
  const lines = dataset.documents().map((doc) => JSON.stringify(doc)).join('\n') + '\n'
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true})
  fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(lines) : lines)
  return dataset.size
}

export function readExport(file) {
  const raw = fs.readFileSync(file)
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b
  const data = isGzip ? zlib.gunzipSync(raw) : raw
  if (isTar(data)) {
    const entries = readTar(data)
    const ndjson = entries.find((entry) => entry.name.endsWith('data.ndjson'))
    if (!ndjson) throw new Error(`${file} has no data.ndjson`)
    return {
      documents: parseNdjson(ndjson.bytes.toString('utf8')),
      assets: entries.filter((entry) => /\/(images|files)\//.test(`/${entry.name}`) && entry.bytes.length > 0),
    }
  }
  return {documents: parseNdjson(data.toString('utf8')), assets: []}
}

function parseNdjson(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** `_sanityAsset` and friends are import instructions for the Sanity CLI, not content. */
function stripImportFields(doc) {
  const {_sanityAsset, ...rest} = doc
  return rest
}

function isTar(buffer) {
  return buffer.length > 512 && buffer.toString('ascii', 257, 262) === 'ustar'
}

function readTar(buffer) {
  const entries = []
  let offset = 0
  let longName = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '') entries.push({name, bytes: Buffer.from(body)})
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}
