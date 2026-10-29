/**
 * Content source maps (`resultSourceMap=true`), which Presentation and stega
 * use to trace a rendered string back to the field it came from.
 *
 * Content Lake derives them from query provenance. Locally they are inferred,
 * conservatively, for string values (the only values stega encodes):
 *
 *   1. under the nearest result object carrying an `_id` that exists in the
 *      corpus, the same relative path in that document holds the same value;
 *   2. otherwise, exactly one string field in that document holds the value
 *      (covers renamed projections like `"name": title`);
 *   3. otherwise, exactly one string field in the whole corpus holds it
 *      (covers `*[...].title`), for corpora up to 5000 documents.
 *
 * Anything ambiguous is left unmapped rather than guessed.
 */

const MAX_CORPUS_SCAN = 5000

export function buildSourceMap(result, corpus) {
  const byId = new Map(corpus.map((doc) => [doc._id, doc]))
  const documents = []
  const documentIndex = new Map()
  const paths = []
  const pathIndex = new Map()
  const mappings = {}
  let corpusIndex = null

  const docRef = (doc) => {
    const id = doc._originalId ?? doc._id
    if (!documentIndex.has(id)) {
      documentIndex.set(id, documents.length)
      documents.push({_id: id, _type: doc._type})
    }
    return documentIndex.get(id)
  }
  const pathRef = (segments) => {
    const text = formatPath(segments)
    if (!pathIndex.has(text)) {
      pathIndex.set(text, paths.length)
      paths.push(text)
    }
    return pathIndex.get(text)
  }
  const map = (resultPath, doc, sourcePath) => {
    mappings[formatPath(resultPath)] = {type: 'value', source: {type: 'documentValue', document: docRef(doc), path: pathRef(sourcePath)}}
  }

  const walk = (value, resultPath, context) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const segment = item && typeof item === 'object' && typeof item._key === 'string' ? {key: item._key} : index
        walk(item, [...resultPath, index], context ? {...context, path: [...context.path, segment]} : null)
      })
      return
    }
    if (value && typeof value === 'object') {
      const source = typeof value._id === 'string' ? byId.get(value._id) : undefined
      const next = source ? {doc: source, path: []} : context
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('_')) continue
        walk(child, [...resultPath, key], next ? {...next, path: [...next.path, key]} : null)
      }
      return
    }
    if (typeof value !== 'string' || value === '') return
    if (context) {
      if (valueAt(context.doc, context.path) === value) return map(resultPath, context.doc, context.path)
      const within = findString(context.doc, value)
      if (within.length === 1) return map(resultPath, context.doc, within[0])
    }
    if (corpus.length > MAX_CORPUS_SCAN) return
    corpusIndex ??= indexCorpus(corpus)
    const hits = corpusIndex.get(value)
    if (hits?.length === 1) map(resultPath, hits[0].doc, hits[0].path)
  }

  walk(result, [], null)
  return {documents, paths, mappings}
}

function valueAt(doc, path) {
  let current = doc
  for (const segment of path) {
    if (current === null || current === undefined) return undefined
    if (typeof segment === 'object') current = Array.isArray(current) ? current.find((item) => item?._key === segment.key) : undefined
    else current = current[segment]
  }
  return current
}

function findString(doc, needle) {
  const found = []
  const visit = (value, path) => {
    if (found.length > 1) return
    if (typeof value === 'string') {
      if (value === needle) found.push(path)
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, item && typeof item === 'object' && typeof item._key === 'string' ? {key: item._key} : index]))
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) if (!key.startsWith('_')) visit(child, [...path, key])
    }
  }
  visit(doc, [])
  return found
}

function indexCorpus(corpus) {
  const index = new Map()
  for (const doc of corpus) {
    const visit = (value, path) => {
      if (typeof value === 'string') {
        if (value === '') return
        const list = index.get(value)
        if (!list) index.set(value, [{doc, path}])
        else if (list.length < 2) list.push({doc, path})
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...path, item && typeof item === 'object' && typeof item._key === 'string' ? {key: item._key} : i]))
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) if (!key.startsWith('_')) visit(child, [...path, key])
      }
    }
    visit(doc, [])
  }
  return index
}

/** `$['body'][?(@._key=='k1')]['children'][0]['text']` — Content Lake's JSONPath spelling. */
export function formatPath(segments) {
  return (
    '$' +
    segments
      .map((segment) =>
        typeof segment === 'number'
          ? `[${segment}]`
          : typeof segment === 'object'
            ? `[?(@._key==${quote(segment.key)})]`
            : `[${quote(segment)}]`,
      )
      .join('')
  )
}

const quote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
