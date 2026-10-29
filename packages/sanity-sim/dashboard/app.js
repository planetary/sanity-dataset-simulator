/* sanity-sim dashboard. No build step: plain ES modules, DOM built with h(). */

const API_VERSION = 'v2025-02-19'
const state = {status: null, dataset: null, live: false}

/* ------------------------------------------------------------------ tiny DOM helpers */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'style') el.setAttribute('style', value)
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'value') el.value = value
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, value)
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

function mount(target, ...nodes) {
  target.replaceChildren(...nodes.flat())
}

let toastTimer
function toast(message, isError = false) {
  document.querySelector('.toast')?.remove()
  const el = h('div', {class: `toast${isError ? ' err' : ''}`, role: 'status'}, message)
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), isError ? 7000 : 3000)
}

const ago = (iso) => {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

/* ------------------------------------------------------------------ API */

async function call(path, {method = 'GET', body, raw} = {}) {
  const response = await fetch(path, {
    method,
    headers: raw ? {} : body !== undefined ? {'content-type': 'application/json'} : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const text = await response.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null
  if (!response.ok) throw new Error(data?.error?.description ?? `${response.status} ${response.statusText}`)
  return data
}

const admin = (path, options) => call(`/_sim${path}`, options)
const ds = () => encodeURIComponent(state.dataset)
const api = (path, options) => call(`/${API_VERSION}${path}`, options)

async function query(groq, {perspective = 'raw', params = {}} = {}) {
  const search = new URLSearchParams({query: groq, perspective, tag: 'sanity-sim.dashboard'})
  for (const [key, value] of Object.entries(params)) search.set(`$${key}`, JSON.stringify(value))
  return (await api(`/data/query/${ds()}?${search}`)).result
}

const actions = (list) => api(`/data/actions/${ds()}`, {method: 'POST', body: {actions: list}})

/* ------------------------------------------------------------------ shell */

const PAGES = {
  documents: {label: 'Documents', render: renderDocuments},
  query: {label: 'Query', render: renderQuery},
  activity: {label: 'Activity', render: renderActivity},
  assets: {label: 'Assets', render: renderAssets},
  releases: {label: 'Releases', render: renderReleases},
  sync: {label: 'Sync', render: renderSync},
  datasets: {label: 'Datasets', render: renderDatasets},
  connections: {label: 'Connections', render: renderConnections},
}

function route() {
  const [page = 'documents', rest = ''] = location.hash.replace(/^#\/?/, '').split('?')
  return {page: PAGES[page] ? page : 'documents', params: new URLSearchParams(rest)}
}

function go(page, params = {}) {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  location.hash = `#/${page}${search.size ? `?${search}` : ''}`
}

async function refreshStatus() {
  state.status = await admin('/status')
  if (!state.dataset || !knownName(state.dataset)) {
    const remembered = safeStorage('get', 'sanity-sim.dataset')
    state.dataset = knownName(remembered) ? remembered : state.status.defaultDataset
  }
}

/* A name in the picker: a stored dataset, or a link to one. */
const knownName = (name) => state.status.datasets.some((d) => d.name === name) || state.status.links.some((link) => link.name === name)
const linkOf = (name) => state.status.links.find((link) => link.name === name)
/* The stored dataset a name shows. */
const resolved = (name) => linkOf(name)?.target ?? name

function safeStorage(op, key, value) {
  try {
    return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, value)
  } catch {
    return null
  }
}

async function render() {
  const app = document.getElementById('app')
  const {page} = route()
  const current = state.status?.datasets.find((d) => d.name === resolved(state.dataset))
  const datasetSelect = h(
    'select',
    {
      'aria-label': 'Dataset',
      onchange: (event) => {
        state.dataset = event.target.value
        safeStorage('set', 'sanity-sim.dataset', state.dataset)
        render()
      },
    },
    state.status.links.length > 0
      ? h('optgroup', {label: 'Links'}, state.status.links.map((link) => h('option', {value: link.name, selected: link.name === state.dataset}, `${link.name} → ${link.target}`)))
      : null,
    h('optgroup', {label: 'Datasets'}, state.status.datasets.map((d) => h('option', {value: d.name, selected: d.name === state.dataset}, d.name))),
  )
  const top = h(
    'header',
    {class: 'topbar'},
    h('div', {class: 'brand'}, h('span', {class: 'brand-mark', 'aria-hidden': 'true'}, 's'), 'sanity-sim'),
    h('span', {class: 'pill mono'}, state.status.projectId),
    datasetSelect,
    current?.synced ? h('span', {class: 'pill'}, `synced from ${current.synced.projectId}/${current.synced.dataset} · ${ago(current.synced.syncedAt)}`) : null,
    h('div', {class: 'spacer'}),
    h('span', {class: 'pill', title: 'Live connection to the simulator'}, h('span', {class: `dot${state.live ? ' live' : ''}`}), state.live ? 'live' : 'connecting'),
  )
  const nav = h(
    'nav',
    {'aria-label': 'Sections'},
    Object.entries(PAGES).map(([key, def]) =>
      h(
        'a',
        {href: `#/${key}`, class: key === page ? 'active' : null},
        def.label,
        key === 'documents' && current ? h('span', {class: 'count'}, current.documents) : null,
        key === 'sync' && current?.stale ? h('span', {class: 'badge stale'}, current.stale) : null,
        key === 'connections' && state.status.unsupported.length ? h('span', {class: 'badge warn'}, state.status.unsupported.length) : null,
      ),
    ),
  )
  const main = h('main', {id: 'main'})
  mount(app, top, h('div', {class: 'body'}, nav, main))
  try {
    await PAGES[page].render(main, route().params)
  } catch (error) {
    mount(main, h('div', {class: 'page'}, h('div', {class: 'notice'}, error.message)))
  }
}

/* ------------------------------------------------------------------ Documents */

async function renderDocuments(main, params) {
  const type = params.get('type') ?? ''
  const selected = params.get('id')
  const q = params.get('q') ?? ''
  const onlyLocal = params.get('layer') === 'local'
  const [types, list] = await Promise.all([
    admin(`/datasets/${ds()}/types`),
    admin(`/datasets/${ds()}/documents?${new URLSearchParams({type, q, layer: onlyLocal ? 'local' : '', limit: '500'})}`),
  ])
  const current = (overrides) => ({type, q, layer: onlyLocal ? 'local' : '', id: selected, ...overrides})

  const typeCol = h(
    'section',
    {'aria-label': 'Document types'},
    h('div', {class: 'col-head row'}, h('strong', {class: 'grow'}, 'Types'), h('button', {class: 'btn small', onclick: () => newDocument(type)}, 'New')),
    h('a', {class: `type-item${type === '' ? ' active' : ''}`, href: '#', onclick: (e) => (e.preventDefault(), go('documents', current({type: '', id: ''})))}, 'All documents', h('span', {class: 'muted'}, types.reduce((sum, t) => sum + t.total, 0))),
    types.map((t) =>
      h(
        'a',
        {class: `type-item${t.type === type ? ' active' : ''}`, href: '#', onclick: (e) => (e.preventDefault(), go('documents', current({type: t.type, id: ''})))},
        h('span', {class: 'mono'}, t.type),
        h('span', {class: 'muted'}, t.total),
      ),
    ),
  )

  const search = h('input', {type: 'search', placeholder: 'Search ids and content…', value: q, class: 'grow', 'aria-label': 'Search documents'})
  search.addEventListener('keydown', (event) => event.key === 'Enter' && go('documents', current({q: search.value, id: ''})))
  const listCol = h(
    'section',
    {'aria-label': 'Documents'},
    h(
      'div',
      {class: 'col-head'},
      h('div', {class: 'row'}, search),
      h(
        'label',
        {class: 'row muted', style: 'margin-top:6px'},
        h('input', {type: 'checkbox', checked: onlyLocal, onchange: (e) => go('documents', current({layer: e.target.checked ? 'local' : '', id: ''}))}),
        'Only local changes',
        h('span', {class: 'grow'}),
        `${list.total} shown`,
      ),
    ),
    list.documents.length === 0 ? h('div', {class: 'empty'}, q || type ? 'No matching documents.' : 'This dataset is empty. Create a document, import a file, or sync from a real dataset.') : null,
    list.documents.map((doc) =>
      h(
        'a',
        {class: `list-item${doc._id === selected ? ' active' : ''}`, href: '#', onclick: (e) => (e.preventDefault(), go('documents', current({id: doc._id})))},
        h('div', {class: 'title'}, doc.title ?? h('span', {class: 'muted'}, 'Untitled')),
        h('div', {class: 'meta'}, idBadge(doc._id), layerBadge(doc.layer), doc.stale ? h('span', {class: 'badge stale'}, 'stale') : null, h('span', {class: 'mono'}, doc._id)),
      ),
    ),
  )

  const editorCol = h('section', {'aria-label': 'Document'})
  mount(main, h('div', {class: 'docs'}, typeCol, listCol, editorCol))
  if (selected) await renderEditor(editorCol, selected)
  else mount(editorCol, h('div', {class: 'empty'}, 'Select a document to view and edit it.'))
}

function idBadge(id) {
  if (id.startsWith('drafts.')) return h('span', {class: 'badge draft'}, 'draft')
  if (id.startsWith('versions.')) return h('span', {class: 'badge version'}, id.split('.')[1])
  return null
}

function layerBadge(layer) {
  const labels = {local: 'local', 'local-shadow': 'edited locally', remote: 'synced', tombstone: 'deleted locally'}
  return layer ? h('span', {class: `badge ${layer}`, title: layerHelp(layer)}, labels[layer] ?? layer) : null
}

function layerHelp(layer) {
  return {
    local: 'Created locally; not in the synced dataset',
    'local-shadow': 'A local copy shadows the synced version',
    remote: 'From the synced dataset; unchanged locally',
    tombstone: 'Deleted locally; still exists in the synced dataset',
  }[layer]
}

async function renderEditor(col, id) {
  const detail = await admin(`/datasets/${ds()}/documents/${encodeURIComponent(id)}`)
  const doc = detail.document
  const textarea = h('textarea', {spellcheck: 'false', 'aria-label': 'Document JSON'})
  textarea.value = JSON.stringify(doc ?? {_id: id, _type: ''}, null, 2)
  const status = h('div', {class: 'ok'}, doc ? `rev ${doc._rev}` : 'This document does not exist yet.')
  const validate = () => {
    try {
      const parsed = JSON.parse(textarea.value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object')
      if (!parsed._type) throw new Error('`_type` is required')
      if (parsed._id && parsed._id !== id) throw new Error(`\`_id\` must stay "${id}" (create a new document to use another id)`)
      status.className = 'ok'
      status.textContent = 'Valid JSON'
      return parsed
    } catch (error) {
      status.className = 'error'
      status.textContent = error.message
      return null
    }
  }
  textarea.addEventListener('input', validate)
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault()
      save()
    }
  })
  const save = async () => {
    const parsed = validate()
    if (!parsed) return
    try {
      await admin(`/datasets/${ds()}/documents/${encodeURIComponent(id)}?${doc ? `ifRevisionID=${encodeURIComponent(doc._rev)}` : ''}`, {method: 'PUT', body: parsed})
      toast(`Saved ${id}`)
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }
  const publishedId = id.replace(/^drafts\./, '').replace(/^versions\.[^.]+\./, '')
  const run = (label, fn) => async () => {
    try {
      await fn()
      toast(label)
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }
  const buttons = [
    h('button', {class: 'btn primary', onclick: save, title: 'Cmd/Ctrl+S'}, doc ? 'Save' : 'Create'),
    doc && id.startsWith('drafts.') ? h('button', {class: 'btn', onclick: run('Published', () => actions([{actionType: 'sanity.action.document.publish', draftId: id, publishedId}]))}, 'Publish') : null,
    doc && id.startsWith('drafts.') ? h('button', {class: 'btn', onclick: run('Draft discarded', () => actions([{actionType: 'sanity.action.document.discard', draftId: id}]))}, 'Discard draft') : null,
    doc && id === publishedId ? h('button', {class: 'btn', onclick: run('Unpublished', () => actions([{actionType: 'sanity.action.document.unpublish', draftId: `drafts.${id}`, publishedId: id}]))}, 'Unpublish') : null,
    detail.layer === 'local-shadow' || detail.layer === 'tombstone'
      ? h('button', {class: 'btn', title: 'Drop the local copy and show the synced version again', onclick: run('Reverted to the synced version', () => admin(`/datasets/${ds()}/documents/${encodeURIComponent(id)}/revert`, {method: 'POST'}))}, 'Revert to synced')
      : null,
    doc
      ? h('button', {class: 'btn danger', onclick: () => confirm(`Delete ${id}?`) && run('Deleted', () => admin(`/datasets/${ds()}/documents/${encodeURIComponent(id)}`, {method: 'DELETE'}))()}, 'Delete')
      : null,
  ]
  mount(
    col,
    h(
      'div',
      {class: 'editor'},
      h('div', {class: 'row'}, h('strong', {class: 'mono grow'}, id), idBadge(id), layerBadge(detail.layer), detail.stale ? h('span', {class: 'badge stale', title: 'The synced version changed since this local copy was made; resolve it on the Sync page'}, 'stale') : null),
      detail.siblings.length
        ? h('div', {class: 'row muted'}, 'Also:', detail.siblings.map((s) => h('a', {href: '#', class: 'mono', onclick: (e) => (e.preventDefault(), go('documents', {...Object.fromEntries(route().params), id: s._id}))}, s._id)))
        : null,
      h('div', {class: 'row'}, buttons),
      textarea,
      status,
      detail.history.length ? h('h2', {}, 'Local history') : null,
      h(
        'div',
        {},
        detail.history.map((tx) =>
          h(
            'div',
            {class: 'history-item'},
            h('span', {class: 'nowrap muted'}, ago(tx.timestamp)),
            h('span', {class: 'grow muted'}, tx.author),
            h('span', {class: 'mono muted'}, tx.id.slice(0, 8)),
            tx.document
              ? h('button', {class: 'btn small', onclick: () => ((textarea.value = JSON.stringify({...tx.document}, null, 2)), validate(), toast('Loaded this revision into the editor; Save to restore it'))}, 'Load')
              : h('span', {class: 'badge tombstone'}, 'deleted'),
          ),
        ),
      ),
    ),
  )
}

async function newDocument(type) {
  const docType = prompt('Document type (_type):', type || '')
  if (!docType) return
  const id = prompt('Document id (leave empty for a new draft with a random id):', '') || `drafts.${crypto.randomUUID()}`
  await admin(`/datasets/${ds()}/documents/${encodeURIComponent(id)}`, {method: 'PUT', body: {_id: id, _type: docType}}).catch((error) => toast(error.message, true))
  go('documents', {type: docType, id})
}

/* ------------------------------------------------------------------ Query */

async function renderQuery(main) {
  const groq = h('textarea', {rows: 7, spellcheck: 'false', 'aria-label': 'GROQ query'})
  groq.value = safeStorage('get', 'sanity-sim.query') ?? '*[_type == $type][0...10]{_id, _type, ...}'
  const params = h('textarea', {rows: 3, spellcheck: 'false', 'aria-label': 'Parameters (JSON)'})
  params.value = safeStorage('get', 'sanity-sim.params') ?? '{"type": "post"}'
  const perspective = h('select', {'aria-label': 'Perspective'}, ['published', 'drafts', 'raw'].map((p) => h('option', {value: p}, p)))
  const releases = await query('*[_type == "system.release" && state in ["active", "scheduled"]]{"name": name, "title": metadata.title}').catch(() => [])
  for (const release of releases) perspective.append(h('option', {value: `${release.name},drafts`}, `release: ${release.title || release.name}`))
  const output = h('pre', {class: 'result'}, 'Run a query (Cmd/Ctrl+Enter).')
  const meta = h('div', {class: 'muted'})
  const runQuery = async () => {
    safeStorage('set', 'sanity-sim.query', groq.value)
    safeStorage('set', 'sanity-sim.params', params.value)
    let parsedParams
    try {
      parsedParams = params.value.trim() ? JSON.parse(params.value) : {}
    } catch {
      return toast('Parameters must be a JSON object', true)
    }
    const search = new URLSearchParams({query: groq.value, perspective: perspective.value})
    for (const [key, value] of Object.entries(parsedParams)) search.set(`$${key}`, JSON.stringify(value))
    try {
      const started = performance.now()
      const response = await api(`/data/query/${ds()}?${search}`)
      output.textContent = JSON.stringify(response.result, null, 2)
      meta.textContent = `${Array.isArray(response.result) ? `${response.result.length} results · ` : ''}${response.ms} ms server · ${Math.round(performance.now() - started)} ms total · syncTags ${response.syncTags.join(', ')}${response.simApproximations ? ' · approximated: ' + response.simApproximations.map((a) => `${a.function}("${a.term}")`).join(', ') : ''}`
    } catch (error) {
      output.textContent = error.message
      meta.textContent = ''
    }
  }
  for (const el of [groq, params]) el.addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && runQuery())
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Query'),
      h('p', {class: 'sub'}, `GROQ against ${state.dataset}, evaluated exactly as Studio and your app see it.`),
      h('div', {class: 'split'}, h('div', {}, groq), h('div', {}, params, h('div', {class: 'row', style: 'margin-top:8px'}, h('label', {class: 'muted'}, 'Perspective'), perspective, h('span', {class: 'grow'}), h('button', {class: 'btn primary', onclick: runQuery}, 'Run')))),
      h('div', {style: 'margin:10px 0'}, meta),
      output,
    ),
  )
}

/* ------------------------------------------------------------------ Activity */

async function renderActivity(main, params) {
  const filter = params.get('filter') ?? 'all'
  const requests = await admin('/requests?limit=400')
  const transactions = await admin(`/datasets/${ds()}/history?limit=50`)
  const visible = requests
    .filter((r) => filter === 'all' || (filter === 'errors' ? r.status >= 400 : filter === 'unsupported' ? r.unsupported : r.method !== 'GET' && r.method !== 'OPTIONS'))
    .reverse()
  const tabs = ['all', 'writes', 'errors', 'unsupported'].map((key) => h('button', {class: `btn small${filter === key ? ' primary' : ''}`, onclick: () => go('activity', {filter: key})}, key))
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Activity'),
      h('p', {class: 'sub'}, 'Every request Studio and your app made, and every change to the data. Updates live.'),
      h('h2', {}, 'Recent transactions'),
      h(
        'div',
        {class: 'card'},
        transactions.length === 0
          ? h('div', {class: 'empty'}, 'No local changes yet.')
          : h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Author'), h('th', {}, 'Documents'), h('th', {}, 'Transaction'))),
              h(
                'tbody',
                {},
                transactions.map((tx) =>
                  h(
                    'tr',
                    {},
                    h('td', {class: 'nowrap'}, ago(tx.timestamp)),
                    h('td', {}, tx.author),
                    h('td', {}, tx.documentIDs.slice(0, 4).map((id) => h('a', {href: `#/documents?id=${encodeURIComponent(id)}`, class: 'mono', style: 'margin-right:8px'}, id)), tx.documentIDs.length > 4 ? `+${tx.documentIDs.length - 4}` : ''),
                    h('td', {class: 'mono muted'}, tx.id.slice(0, 12)),
                  ),
                ),
              ),
            ),
      ),
      h('h2', {class: 'row'}, 'Requests', h('span', {class: 'grow'}), tabs),
      h(
        'div',
        {class: 'card', style: 'max-height:55vh;overflow:auto'},
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Client'), h('th', {}, 'Request'), h('th', {}, 'Tag'), h('th', {class: 'num'}, 'Status'), h('th', {class: 'num'}, 'ms'))),
          h(
            'tbody',
            {},
            visible.map((r) =>
              h(
                'tr',
                {},
                h('td', {class: 'nowrap muted'}, new Date(r.at).toLocaleTimeString()),
                h('td', {class: 'muted'}, r.client ?? ''),
                h('td', {class: 'mono'}, `${r.method} ${r.path}`, r.perspective ? h('span', {class: 'badge', style: 'margin-left:6px'}, r.perspective) : null),
                h('td', {class: 'muted mono'}, r.tag ?? ''),
                h('td', {class: 'num'}, h('span', {class: `badge${r.status >= 400 ? ' err' : ''}`}, r.status ?? '…')),
                h('td', {class: 'num muted'}, r.ms ?? ''),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ Assets */

async function renderAssets(main) {
  const assets = await query('*[_type in ["sanity.imageAsset", "sanity.fileAsset"]] | order(_createdAt desc) {_id, _type, url, originalFilename, size, mimeType, "w": metadata.dimensions.width, "h": metadata.dimensions.height, "refs": count(*[references(^._id)])}')
  const input = h('input', {type: 'file', multiple: true, 'aria-label': 'Upload files'})
  input.addEventListener('change', async () => {
    for (const file of input.files) {
      const kind = file.type.startsWith('image/') ? 'images' : 'files'
      try {
        await call(`/${API_VERSION}/assets/${kind}/${ds()}?filename=${encodeURIComponent(file.name)}`, {method: 'POST', raw: file})
      } catch (error) {
        toast(`${file.name}: ${error.message}`, true)
      }
    }
    toast('Uploaded')
    render()
  })
  const localUrl = (url) => url.replace(/^https?:\/\/[^/]+/, '')
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Assets'),
      h('p', {class: 'sub'}, 'Images and files in this dataset. Synced assets are fetched from Sanity’s CDN on first view and cached locally.'),
      h('div', {class: 'row', style: 'margin-bottom:14px'}, h('label', {class: 'btn'}, 'Upload…', h('span', {style: 'display:none'}, input)), h('span', {class: 'muted'}, `${assets.length} assets`)),
      assets.length === 0
        ? h('div', {class: 'card empty'}, 'No assets yet.')
        : h(
            'div',
            {class: 'assets'},
            assets.map((asset) =>
              h(
                'a',
                {class: 'card asset', href: `#/documents?id=${encodeURIComponent(asset._id)}`, title: asset.originalFilename},
                h('div', {class: 'thumb', style: asset._type === 'sanity.imageAsset' ? `background-image:url("${localUrl(asset.url)}?w=300&fit=max")` : null}, asset._type === 'sanity.fileAsset' ? (asset.mimeType ?? 'file') : ''),
                h('div', {class: 'info'}, asset.originalFilename ?? asset._id),
                h('div', {class: 'info'}, [asset.w ? `${asset.w}×${asset.h}` : null, asset.size ? `${Math.round(asset.size / 1024)} KB` : null, `${asset.refs} refs`].filter(Boolean).join(' · ')),
              ),
            ),
          ),
    ),
  )
}

/* ------------------------------------------------------------------ Releases */

async function renderReleases(main) {
  const releases = await query('*[_type == "system.release"] | order(_createdAt desc) {_id, name, state, publishAt, publishedAt, metadata, _createdAt, "documents": count(*[_id in path("versions." + ^.name + ".**")])}')
  const title = h('input', {type: 'text', placeholder: 'New release title', 'aria-label': 'Release title'})
  const act = (label, list) => async () => {
    try {
      await actions(list)
      toast(label)
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }
  const createRelease = async () => {
    if (!title.value.trim()) return toast('Give the release a title', true)
    const releaseId = `r${Math.random().toString(36).slice(2, 10)}`
    await act('Release created', [{actionType: 'sanity.action.release.create', releaseId, metadata: {title: title.value.trim(), releaseType: 'asap'}}])()
  }
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Releases'),
      h('p', {class: 'sub'}, 'Content releases in this dataset. Scheduled releases publish automatically while sanity-sim is running.'),
      h('div', {class: 'row', style: 'margin-bottom:14px'}, title, h('button', {class: 'btn primary', onclick: createRelease}, 'Create release')),
      releases.length === 0
        ? h('div', {class: 'card empty'}, 'No releases.')
        : h(
            'div',
            {class: 'card'},
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Release'), h('th', {}, 'State'), h('th', {class: 'num'}, 'Documents'), h('th', {}, 'When'), h('th', {}, ''))),
              h(
                'tbody',
                {},
                releases.map((r) => {
                  const when = h('input', {type: 'datetime-local', 'aria-label': 'Publish at'})
                  return h(
                    'tr',
                    {},
                    h('td', {}, h('div', {}, r.metadata?.title || r.name), h('div', {class: 'mono muted'}, r.name)),
                    h('td', {}, h('span', {class: `badge${r.state === 'published' ? ' local' : r.state === 'scheduled' ? ' warn' : ''}`}, r.state)),
                    h('td', {class: 'num'}, r.documents),
                    h('td', {class: 'muted'}, r.state === 'scheduled' ? `publishes ${new Date(r.publishAt).toLocaleString()}` : r.publishedAt ? `published ${ago(r.publishedAt)}` : `created ${ago(r._createdAt)}`),
                    h(
                      'td',
                      {class: 'row'},
                      ['active', 'scheduled'].includes(r.state) ? h('button', {class: 'btn small primary', onclick: act('Published', [{actionType: 'sanity.action.release.publish', releaseId: r.name}])}, 'Publish now') : null,
                      r.state === 'active' ? [when, h('button', {class: 'btn small', onclick: () => (when.value ? act('Scheduled', [{actionType: 'sanity.action.release.schedule', releaseId: r.name, publishAt: new Date(when.value).toISOString()}])() : toast('Pick a time first', true))}, 'Schedule')] : null,
                      r.state === 'scheduled' ? h('button', {class: 'btn small', onclick: act('Unscheduled', [{actionType: 'sanity.action.release.unschedule', releaseId: r.name}])}, 'Unschedule') : null,
                      ['active', 'scheduled'].includes(r.state) ? h('button', {class: 'btn small', onclick: act('Archived', [{actionType: 'sanity.action.release.archive', releaseId: r.name}])}, 'Archive') : null,
                      r.state === 'archived' ? h('button', {class: 'btn small', onclick: act('Unarchived', [{actionType: 'sanity.action.release.unarchive', releaseId: r.name}])}, 'Unarchive') : null,
                      ['archived', 'published'].includes(r.state) ? h('button', {class: 'btn small danger', onclick: act('Deleted', [{actionType: 'sanity.action.release.delete', releaseId: r.name}])}, 'Delete') : null,
                    ),
                  )
                }),
              ),
            ),
          ),
    ),
  )
}

/* ------------------------------------------------------------------ Sync */

async function renderSync(main) {
  const [info, changes, stale] = await Promise.all([admin(`/datasets/${ds()}/sync`), admin(`/datasets/${ds()}/local-changes`), admin(`/datasets/${ds()}/stale`)])
  const source = info.source
  const projectInput = h('input', {type: 'text', placeholder: 'project id', value: source?.projectId ?? '', 'aria-label': 'Source project id'})
  const datasetInput = h('input', {type: 'text', placeholder: 'dataset', value: source?.dataset ?? state.dataset, 'aria-label': 'Source dataset'})
  const syncButton = h('button', {class: 'btn primary'}, info.remote ? 'Sync now' : 'Sync')
  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true
    syncButton.textContent = 'Syncing…'
    try {
      const result = await admin(`/datasets/${ds()}/sync`, {method: 'POST', body: {projectId: projectInput.value.trim() || undefined, dataset: datasetInput.value.trim() || undefined}})
      toast(`Synced ${result.meta.count} documents${result.stale ? `; ${result.stale} stale` : ''}`)
      await refreshStatus()
      render()
    } catch (error) {
      toast(error.message, true)
      syncButton.disabled = false
      syncButton.textContent = 'Sync now'
    }
  })
  const follow = h('input', {type: 'checkbox', checked: info.following, 'aria-label': 'Follow live changes'})
  follow.addEventListener('change', () => admin(`/datasets/${ds()}/follow`, {method: 'POST', body: {enabled: follow.checked}}).then(() => toast(follow.checked ? 'Following live changes' : 'Stopped following'), (error) => toast(error.message, true)))

  const resolve = (id, action) => async () => {
    try {
      const result = await admin(`/datasets/${ds()}/stale/${encodeURIComponent(id)}`, {method: 'POST', body: {action}})
      toast(action === 'merge' ? `Merged${result.conflicts.length ? `; kept local values for ${result.conflicts.join(', ')}` : ''}` : action === 'keep' ? 'Kept your version' : 'Took the synced version')
      await refreshStatus()
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }

  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Sync'),
      h('p', {class: 'sub'}, 'Pull a real dataset underneath your local data. Read-only: nothing here ever writes to Sanity. Your local documents and deletions stay on top, per document.'),
      h(
        'div',
        {class: 'card pad'},
        h('div', {class: 'row'}, h('span', {class: 'muted'}, 'Source'), projectInput, h('span', {class: 'muted'}, '/'), datasetInput, syncButton, h('label', {class: 'row muted'}, follow, 'Follow live changes')),
        h(
          'div',
          {class: 'muted', style: 'margin-top:10px'},
          info.remote
            ? `Last synced ${ago(info.remote.syncedAt)}: ${info.remote.count} documents (${info.remote.drafts} drafts) from ${info.remote.projectId}/${info.remote.dataset}. Credentials: ${info.remote.credentials}.`
            : source?.credentials
              ? `Not synced yet. Will read with ${source.credentials}.`
              : 'Not synced yet. Without a token (SANITY_API_READ_TOKEN in .env, or `sanity login`) only published documents of public datasets can be read.',
        ),
      ),
      h('h2', {}, `Stale (${stale.length})`),
      stale.length === 0
        ? h('div', {class: 'card empty'}, 'Nothing stale: every local change was made against the current synced version.')
        : stale.map((entry) => staleCard(entry, resolve)),
      h('h2', {}, `Local changes (${changes.length})`),
      changes.length === 0
        ? h('div', {class: 'card empty'}, 'No local changes. Everything you see comes from the synced dataset.')
        : h(
            'div',
            {class: 'card'},
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Change'), h('th', {}, 'Document'), h('th', {}, 'Type'), h('th', {}, ''))),
              h(
                'tbody',
                {},
                changes.map((c) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('span', {class: `badge ${c.change === 'added' ? 'local' : c.change === 'deleted' ? 'tombstone' : 'local-shadow'}`}, c.change), c.stale ? h('span', {class: 'badge stale', style: 'margin-left:4px'}, 'stale') : null),
                    h('td', {}, h('a', {href: `#/documents?id=${encodeURIComponent(c.id)}`}, c.title ?? c.id), h('div', {class: 'mono muted'}, c.id)),
                    h('td', {class: 'mono muted'}, c.type ?? ''),
                    h('td', {}, c.change !== 'added' ? h('button', {class: 'btn small', onclick: async () => { await admin(`/datasets/${ds()}/documents/${encodeURIComponent(c.id)}/revert`, {method: 'POST'}); toast('Reverted'); render() }}, 'Revert') : null),
                  ),
                ),
              ),
            ),
          ),
    ),
  )
}

function staleCard(entry, resolve) {
  const keys = [...new Set([...Object.keys(entry.local ?? {}), ...Object.keys(entry.remote ?? {})])].filter((k) => !['_rev', '_updatedAt'].includes(k)).sort()
  const differs = (k) => JSON.stringify(entry.local?.[k]) !== JSON.stringify(entry.remote?.[k])
  const side = (doc) => h('pre', {class: 'result', style: 'max-height:240px'}, doc === null ? '(deleted)' : keys.map((k) => h('div', {class: differs(k) ? 'diff-key' : null}, `${k}: ${JSON.stringify(doc[k])}`)))
  return h(
    'div',
    {class: 'card pad', style: 'margin-bottom:10px'},
    h('div', {class: 'row', style: 'margin-bottom:8px'}, h('strong', {class: 'mono grow'}, entry.id), h('button', {class: 'btn small', onclick: resolve(entry.id, 'keep')}, 'Keep mine'), h('button', {class: 'btn small', onclick: resolve(entry.id, 'take')}, 'Take synced'), entry.local && entry.remote ? h('button', {class: 'btn small primary', onclick: resolve(entry.id, 'merge')}, 'Merge') : null),
    h('div', {class: 'split'}, h('div', {}, h('div', {class: 'muted'}, 'Local'), side(entry.local)), h('div', {}, h('div', {class: 'muted'}, `Synced (was ${entry.baseRev ?? 'absent'}, now ${entry.remoteRev ?? 'deleted'})`), side(entry.remote))),
  )
}

/* ------------------------------------------------------------------ Datasets */

async function renderDatasets(main) {
  const [list, links] = await Promise.all([admin('/datasets'), admin('/links')])
  const stored = list.map((d) => d.name)
  const relink = async (name, target) => {
    try {
      const result = await admin(`/links/${encodeURIComponent(name)}`, {method: 'PUT', body: {target}})
      toast(`${name} → ${target}${result.preserved ? `. Its previous documents are kept as “${result.preserved}”.` : '. Connected Studios and apps are reloading.'}`)
      await refreshStatus()
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }
  const linkName = h('input', {type: 'text', placeholder: state.status.defaultDataset, 'aria-label': 'Name to link', list: 'link-names'})
  const linkTarget = h('select', {'aria-label': 'Dataset to link to'}, stored.map((n) => h('option', {value: n}, n)))
  const linksCard = h(
    'div',
    {class: 'card'},
    links.length === 0
      ? h('p', {class: 'muted', style: 'margin:0 0 10px'}, 'No links yet.')
      : h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Shows'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            links.map((link) =>
              h(
                'tr',
                {},
                h('td', {}, h('strong', {}, link.name)),
                h(
                  'td',
                  {},
                  h(
                    'select',
                    {'aria-label': `Dataset ${link.name} shows`, onchange: (event) => relink(link.name, event.target.value)},
                    stored.map((n) => h('option', {value: n, selected: n === link.target}, n)),
                  ),
                ),
                h(
                  'td',
                  {},
                  h(
                    'button',
                    {
                      class: 'btn small',
                      title: `Stop linking; "${link.name}" becomes an ordinary, empty dataset`,
                      onclick: async () => {
                        if (!confirm(`Unlink ${link.name}? It becomes an ordinary, empty dataset; ${link.target} is untouched.`)) return
                        try {
                          await admin(`/links/${encodeURIComponent(link.name)}`, {method: 'DELETE'})
                          toast(`Unlinked ${link.name}`)
                          await refreshStatus()
                          render()
                        } catch (error) {
                          toast(error.message, true)
                        }
                      },
                    },
                    'Unlink',
                  ),
                ),
              ),
            ),
          ),
        ),
    h(
      'div',
      {class: 'row', style: 'margin-top:10px'},
      linkName,
      h('span', {class: 'muted'}, '→'),
      linkTarget,
      h('button', {class: 'btn', onclick: () => relink(linkName.value.trim() || state.status.defaultDataset, linkTarget.value)}, 'Link'),
    ),
    h('datalist', {id: 'link-names'}, h('option', {value: state.status.defaultDataset})),
  )
  const name = h('input', {type: 'text', placeholder: 'new-dataset', 'aria-label': 'New dataset name'})
  const fileInput = h('input', {type: 'file', accept: '.ndjson,.gz,.tar.gz,.json', style: 'display:none'})
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]
    if (!file) return
    try {
      const result = await admin(`/datasets/${ds()}/import`, {method: 'POST', raw: file})
      toast(`Imported ${result.documents} documents and ${result.assets} asset files`)
      render()
    } catch (error) {
      toast(error.message, true)
    }
  })
  const dangerous = (label, question, fn) => h('button', {class: 'btn danger', onclick: async () => { if (!confirm(question)) return; try { await fn(); toast(label); await refreshStatus(); render() } catch (error) { toast(error.message, true) } }}, label)
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Datasets'),
      h('p', {class: 'sub'}, `Stored in ${state.status.root}/.sanity-sim/. Studio’s dataset switcher and your app can use any of these by name.`),
      h('h2', {}, 'Links'),
      h(
        'p',
        {class: 'sub'},
        `A link makes a name your Studio and app already use (like “${state.status.defaultDataset}”) show another dataset. Switch what it shows at any time: connected Studios and apps reconnect and reload, with no restart. Linking a name that already holds documents keeps them as “<name>-original”.`,
      ),
      linksCard,
      h('h2', {}, 'Stored datasets'),
      h(
        'div',
        {class: 'card'},
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Dataset'), h('th', {class: 'num'}, 'Documents'), h('th', {class: 'num'}, 'Local'), h('th', {class: 'num'}, 'Synced'), h('th', {class: 'num'}, 'Transactions'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            list.map((d) =>
              h(
                'tr',
                {},
                h(
                  'td',
                  {},
                  h('strong', {}, d.name),
                  d.name === resolved(state.dataset) ? h('span', {class: 'badge local', style: 'margin-left:6px'}, 'current') : null,
                  ...d.linkedFrom.map((from) => h('span', {class: 'badge', style: 'margin-left:6px', title: `“${from}” shows this dataset`}, `← ${from}`)),
                ),
                h('td', {class: 'num'}, d.documents),
                h('td', {class: 'num'}, d.local + d.deletedLocally),
                h('td', {class: 'num'}, d.remote),
                h('td', {class: 'num'}, d.transactions),
                h('td', {}, d.name !== resolved(state.dataset) ? h('button', {class: 'btn small', onclick: () => { state.dataset = d.name; safeStorage('set', 'sanity-sim.dataset', d.name); render() }}, 'Use') : null),
              ),
            ),
          ),
        ),
      ),
      h('div', {class: 'row', style: 'margin-top:12px'}, name, h('button', {class: 'btn', onclick: async () => { try { await admin('/datasets', {method: 'POST', body: {name: name.value.trim()}}); await refreshStatus(); render() } catch (error) { toast(error.message, true) } }}, 'Create dataset')),
      h('h2', {}, `This dataset: ${linkOf(state.dataset) ? `${state.dataset} → ${resolved(state.dataset)}` : state.dataset}`),
      h(
        'div',
        {class: 'row'},
        h('label', {class: 'btn'}, 'Import NDJSON / export tarball…', fileInput),
        h('a', {class: 'btn', href: `/_sim/datasets/${ds()}/export`, download: `${state.dataset}.ndjson`}, 'Export NDJSON'),
        dangerous('Discard local changes', `Discard every local change in ${state.dataset}? Synced documents stay.`, () => admin(`/datasets/${ds()}/reset`, {method: 'POST', body: {}})),
        dangerous('Wipe dataset', `Wipe ${state.dataset} completely (local changes, history and synced snapshot)?`, () => admin(`/datasets/${ds()}/reset`, {method: 'POST', body: {all: true}})),
        list.length > 1 && !linkOf(state.dataset) && list.find((d) => d.name === state.dataset)?.linkedFrom.length === 0 ? dangerous('Delete dataset', `Delete dataset ${state.dataset} and its files?`, () => admin(`/datasets/${ds()}`, {method: 'DELETE'}).then(() => (state.dataset = null))) : null,
      ),
    ),
  )
}

/* ------------------------------------------------------------------ Connections */

async function renderConnections(main) {
  await refreshStatus()
  const s = state.status
  const base = s.server.publicBase
  mount(
    main,
    h(
      'div',
      {class: 'page'},
      h('h1', {}, 'Connections'),
      h('p', {class: 'sub'}, 'Who is talking to the simulator, and anything they asked for that it does not do.'),
      s.server.https && s.certificateTrusted === false
        ? h('div', {class: 'notice'}, 'The HTTPS certificate is not trusted on this machine, so browsers refuse ', h('code', {}, base), '. Run ', h('code', {}, 'npx sanity-sim trust'), ' once, or open ', h('a', {href: base, target: '_blank', rel: 'noopener'}, base), ' and accept the certificate.')
        : null,
      h(
        'div',
        {class: 'stats'},
        stat('Listeners', s.listeners),
        stat('Live clients', s.liveClients),
        stat('Clients seen', s.clients.length),
        stat('Unsupported calls', s.unsupported.reduce((sum, u) => sum + u.count, 0)),
      ),
      h('h2', {}, 'Clients'),
      h(
        'div',
        {class: 'card'},
        s.clients.length === 0
          ? h('div', {class: 'empty'}, 'No requests yet. Start your Studio or app with `npx sanity-sim`.')
          : h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', {class: 'num'}, 'Requests'), h('th', {}, 'API versions'), h('th', {}, 'Last seen'))), h('tbody', {}, s.clients.map((c) => h('tr', {}, h('td', {}, c.client), h('td', {class: 'num'}, c.requests), h('td', {class: 'mono muted'}, (c.apiVersions ?? []).join(', ')), h('td', {class: 'muted'}, ago(c.lastSeen)))))),
      ),
      h('h2', {}, 'Unsupported endpoints'),
      h(
        'div',
        {class: 'card'},
        s.unsupported.length === 0
          ? h('div', {class: 'empty'}, 'Everything requested so far is implemented.')
          : h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Request'), h('th', {class: 'num'}, 'Count'))), h('tbody', {}, s.unsupported.map((u) => h('tr', {}, h('td', {class: 'mono'}, u.route), h('td', {class: 'num'}, u.count))))),
      ),
      h('h2', {}, 'This folder'),
      h(
        'div',
        {class: 'card pad'},
        h('div', {}, 'Detected: ', s.project?.frameworks?.join(', ') || 'nothing', s.project?.studioConfig ? h('span', {class: 'muted'}, ` · Studio config ${s.project.studioConfig}`) : null),
        s.wired.length ? h('div', {style: 'margin-top:6px'}, 'Wired this run: ', s.wired.join(', '), h('span', {class: 'muted'}, ' (undo with npx sanity-sim eject)')) : null,
        h('div', {style: 'margin-top:10px'}, 'Wire anything else by hand:'),
        h('pre', {class: 'result', style: 'margin-top:6px'}, `// Studio (sanity.config.ts)\napiHost: '${base}',\n\n// @sanity/client in the browser\ncreateClient({projectId: '${s.projectId}', dataset: '${state.dataset}', apiVersion: '2025-02-19', apiHost: '${base}'})\n\n// Any Node process, no code change\nSANITY_SIM_URL=${s.server.httpBase} node --import sanity-sim/register your-script.js`),
      ),
    ),
  )
}

function stat(label, value) {
  return h('div', {class: 'card stat'}, h('div', {class: 'v'}, value), h('div', {class: 'k'}, label))
}

/* ------------------------------------------------------------------ live updates */

function connectEvents() {
  const source = new EventSource('/_sim/events')
  let pending = null
  const refresh = () => {
    clearTimeout(pending)
    pending = setTimeout(async () => {
      /* Don't clobber an editor with unsaved typing. */
      if (document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT') return
      await refreshStatus()
      render()
    }, 400)
  }
  const setLive = (live) => {
    state.live = live
    const pill = document.querySelector('.dot')?.parentElement
    if (pill) pill.replaceChildren(h('span', {class: `dot${live ? ' live' : ''}`}), live ? 'live' : 'reconnecting')
  }
  source.addEventListener('open', () => setLive(true))
  source.addEventListener('error', () => setLive(false))
  source.addEventListener('transaction', (event) => {
    const tx = JSON.parse(event.data)
    if (tx.dataset === resolved(state.dataset) && !tx.author.startsWith('dashboard')) refresh()
  })
  source.addEventListener('links', async () => {
    /* A swap may have created a dataset this stream is not watching yet. */
    source.close()
    await refreshStatus()
    render()
    connectEvents()
  })
  source.addEventListener('request', () => {
    if (route().page === 'activity' || route().page === 'connections') refresh()
  })
}

window.addEventListener('hashchange', render)
await refreshStatus()
await render()
connectEvents()
