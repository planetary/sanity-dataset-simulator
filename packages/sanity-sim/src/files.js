import fs from 'node:fs'
import path from 'node:path'

export function readNdjson(file) {
  if (!fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    out.push(JSON.parse(line))
  }
  return out
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write via a temp file + rename, so a crash never leaves half a dataset. */
export function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, contents)
  fs.renameSync(temp, file)
}

export function writeNdjsonAtomic(file, items) {
  writeFileAtomic(file, items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : ''))
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}
