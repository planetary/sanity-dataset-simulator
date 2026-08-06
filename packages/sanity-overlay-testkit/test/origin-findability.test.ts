/**
 * MODE 2 (origin) — Studio's STRUCTURE LIST, which is a *findability* query.
 *
 * THE GAP THIS SUITE EXISTS FOR
 * -----------------------------
 * A Studio structure list pane does not ask "give me documents of type X".
 * It asks the search service. `origin-data.test.ts` proves a type-list query
 * returns overlay documents, and it does — but the pane never sends one, so in
 * Mode 2 (no Sanity upstream, nothing to fall back to) the pane rendered EMPTY
 * while the overlay held content. An empty content list is the worst possible
 * failure mode for a branch overlay whose entire purpose is editing content.
 *
 * WHERE THE QUERY AND ITS PARAMETERS COME FROM
 * --------------------------------------------
 * NOT from the proxy logs. `proxy-log*.jsonl` records `method` and `path` only —
 * the query string is stripped before the line is written, so no recorded line
 * carries GROQ text or parameters. (`§ evidence` below asserts that, so nobody
 * later mistakes those logs for a source of query text.)
 *
 * The evidence is instead the installed `sanity@6.8.0` itself: the dist module
 * that builds the query (`createSearchQuery`) and the dist module that drives
 * the structure list (the pane's `findability-source: list` call site). This
 * suite reads both at test time, asserts the query template is still what we
 * built against, and — crucially — EXTRACTS AND EXECUTES Studio's own
 * `prefixLast()` to establish what `$__query` and `$__rawQuery` actually carry.
 * That is an independent oracle: Studio's code answers the question, not us.
 *
 * WHAT IS EXACT AND WHAT IS APPROXIMATE
 * -------------------------------------
 * `text::query()` is Content Lake's hosted full-text index — stemming, ranking,
 * language analysis. It cannot be reproduced locally and this suite does not
 * pretend otherwise. What it pins is:
 *
 *   - the UNFILTERED list pane, where Studio's own `prefixLast('')` yields the
 *     term `"*"` — "match everything". That case is EXACT, and it is the case
 *     the structure list actually uses. There is no honest reason for it to be
 *     empty.
 *   - a TYPED term, where Mode 2 does prefix/substring token matching over the
 *     document's own text. That is an APPROXIMATION, it must narrow the result,
 *     and it must be VISIBLE in the response rather than silent.
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

// @ts-expect-error — plain-JS spike proxy shared with Node; no .d.ts by design
import {createProxyServer} from '../../../examples/kitchen-sink/spikeB-proxy/proxy.mjs'
// @ts-expect-error — plain-JS spike module shared with Node; no .d.ts by design
import {createOriginHandler} from '../../../examples/kitchen-sink/spikeB-proxy/origin.mjs'

const PROJECT_ID = 'b1n03q3z'
const DATASET = 'parity'
const V = '/v2025-02-19'

const SPIKE_B = fileURLToPath(new URL('../../../examples/kitchen-sink/spikeB-proxy/', import.meta.url))
const KITCHEN_SINK = fileURLToPath(new URL('../../../examples/kitchen-sink/package.json', import.meta.url))

let root = ''
let baseUrl = ''
let server: http.Server
let handler: {close: () => Promise<void>}

async function boot(): Promise<void> {
  handler = await createOriginHandler({
    root,
    projectId: PROJECT_ID,
    dataset: DATASET,
    overlayId: 'origin-findability-test',
  })
  server = createProxyServer({
    origin: true,
    originHandler: handler,
    logPath: path.join(root, 'log.jsonl'),
    env: {},
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-findability-'))
  await boot()
})

afterAll(async () => {
  await handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(root, {recursive: true, force: true})
})

/* ------------------------------------------------------------------ *
 * the wire API, as @sanity/client speaks it
 * ------------------------------------------------------------------ */

async function post(target: string, body: unknown): Promise<{status: number; json: any}> {
  const response = await fetch(`${baseUrl}${target}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {status: response.status, json: text === '' ? null : JSON.parse(text)}
}

async function get(target: string): Promise<{status: number; json: any}> {
  const response = await fetch(`${baseUrl}${target}`)
  const text = await response.text()
  return {status: response.status, json: text === '' ? null : JSON.parse(text)}
}

const mutate = (mutations: unknown[]) => post(`${V}/data/mutate/${DATASET}`, {mutations})

const query = (groq: string, params: Record<string, unknown> = {}) => {
  const search = new URLSearchParams({query: groq})
  for (const [key, value] of Object.entries(params)) search.set(`$${key}`, JSON.stringify(value))
  return get(`${V}/data/query/${DATASET}?${search.toString()}`)
}

/* ================================================================== *
 * § evidence — what Studio actually sends
 * ================================================================== */

/** The dist module of the installed `sanity` that builds every search query. */
function studioSearchQuerySource(): string {
  const require_ = createRequire(KITCHEN_SINK)
  const lib = path.join(path.dirname(require_.resolve('sanity/package.json')), 'lib')
  for (const name of fs.readdirSync(lib)) {
    if (!name.endsWith('.js')) continue
    const source = fs.readFileSync(path.join(lib, name), 'utf8')
    if (source.includes('function prefixLast(') && source.includes('findability-mvi:5')) return source
  }
  throw new Error(`no sanity dist module builds the findability query under ${lib}`)
}

/** The dist module that drives a structure list pane. */
function studioListPaneSource(): string {
  const require_ = createRequire(KITCHEN_SINK)
  const lib = path.join(path.dirname(require_.resolve('sanity/package.json')), 'lib')
  for (const name of fs.readdirSync(lib)) {
    if (!name.endsWith('.js')) continue
    const source = fs.readFileSync(path.join(lib, name), 'utf8')
    if (source.includes('findability-source: ')) return source
  }
  throw new Error(`no sanity dist module drives a findability list pane under ${lib}`)
}

/**
 * Studio's own `prefixLast`, lifted out of the dist and executed.
 *
 * This is the independent oracle. We do not assert what we believe `$__query`
 * contains; we run the function that produces it.
 */
function studioPrefixLast(): (input: string) => string {
  const source = studioSearchQuerySource()
  const from = source.indexOf('const TOKEN_REGEX')
  const entry = source.indexOf('function prefixLast(query) {', from)
  if (from === -1 || entry === -1) throw new Error('cannot locate prefixLast in the sanity dist')
  /* brace-match to the end of the function so we lift a runnable block, not a
   * guessed line range. */
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', entry); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) throw new Error('cannot brace-match prefixLast in the sanity dist')
  const block = source.slice(from, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${block}; return prefixLast`)() as (input: string) => string
}

describe('§ evidence · what a structure list pane really sends', () => {
  it('the proxy logs cannot be the source — they record no query text at all', () => {
    /* Stated so nobody later "verifies" a query shape against these files and
     * concludes the wrong thing. They are path-level evidence and nothing more. */
    const files = fs.readdirSync(SPIKE_B).filter((n) => n.startsWith('proxy-log') && n.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = fs.readFileSync(path.join(SPIKE_B, file), 'utf8')
      expect(text, `${file} should carry no GROQ`).not.toContain('__query')
      expect(text, `${file} should carry no GROQ`).not.toContain('text::query')
    }
  })

  it('builds the base predicate verbatim as this suite replays it', () => {
    expect(studioSearchQuerySource()).toContain(
      '([@, _id] match text::query($__query) || references($__rawQuery))',
    )
  })

  it('tails every findability query with a PARAMETERISED slice', () => {
    /* `[0...$__limit]`, not a constant. groq-js refuses to parse that, which is
     * half of why the pane was empty. */
    expect(studioSearchQuerySource()).toContain('"[0...$__limit]"')
  })

  it('maps $__query to prefixLast(term) and $__rawQuery to the term itself', () => {
    const source = studioSearchQuerySource()
    expect(source).toContain('__query: prefixLast(rawQuery)')
    expect(source).toContain('__rawQuery: rawQuery')
  })

  it('sends an EMPTY term for an unfiltered list pane', () => {
    /* `searchQuery || ""` at the `findability-source: list` call site. */
    expect(studioListPaneSource()).toContain('findability-source: ')
    expect(studioListPaneSource()).toMatch(/query:\s*searchQuery\s*\|\|\s*""/)
  })

  it("Studio's own prefixLast turns the empty term into `*` — match everything", () => {
    const prefixLast = studioPrefixLast()
    expect(prefixLast('')).toBe('*')
  })

  it("Studio's own prefixLast turns a typed term into a prefix term", () => {
    const prefixLast = studioPrefixLast()
    expect(prefixLast('Born')).toBe('Born*')
    expect(prefixLast('Born*')).toBe('Born*')
    expect(prefixLast('no Sanity')).toBe('no Sanity*')
  })
})

/* ================================================================== *
 * the query itself — captured verbatim from a live Studio session
 * ================================================================== */

const LIST_QUERY = [
  '// findability-mvi:5',
  '// findability-source: list',
  '*[_type in $__types && ([@, _id] match text::query($__query) || references($__rawQuery)) && (_type == $type)] {',
  '  _type, _id, _originalId, "orderings": [_updatedAt]',
  '} | order(orderings[0] desc) [0...$__limit]',
].join('\n')

/** The parameter object `createSearchQuery` produces for a list pane. */
function listParams(term: string, limit = 1000): Record<string, unknown> {
  const prefixLast = studioPrefixLast()
  return {
    __types: ['article'],
    __limit: limit + 1,
    __query: prefixLast(term),
    __rawQuery: term,
    type: 'article',
  }
}

const idsOf = (answer: {json: any}): string[] =>
  (answer.json.result as Array<{_id: string}>).map((hit) => hit._id)

/* ================================================================== *
 * 1. THE LOAD-BEARING CASE — an unfiltered pane lists the overlay
 * ================================================================== */

describe('Mode 2 · the structure list', () => {
  beforeAll(async () => {
    /* The two documents the live session held when the pane rendered empty. */
    await mutate([
      {
        create: {
          _id: 'drafts.article-01',
          _type: 'article',
          title: 'Article 1 — OVERLAY EDIT ✅ 日本語',
        },
      },
    ])
    await mutate([
      {
        create: {
          _id: 'origin-proof-1',
          _type: 'article',
          title: 'Born with no Sanity project 🌱',
        },
      },
    ])
  })

  it('returns BOTH overlay documents for the exact findability query', async () => {
    const answer = await query(LIST_QUERY, listParams(''))
    expect(answer.status).toBe(200)
    expect(idsOf(answer).sort()).toEqual(['drafts.article-01', 'origin-proof-1'])
  })

  it('projects the fields the pane reads', async () => {
    const answer = await query(LIST_QUERY, listParams(''))
    /* An empty list would satisfy the loop below vacuously. */
    expect((answer.json.result as unknown[]).length).toBeGreaterThan(0)
    for (const hit of answer.json.result as Array<Record<string, unknown>>) {
      expect(hit._type).toBe('article')
      expect(typeof hit._id).toBe('string')
      expect(Array.isArray(hit.orderings)).toBe(true)
      expect(typeof (hit.orderings as unknown[])[0]).toBe('string')
    }
  })

  it('honours the parameterised slice rather than ignoring it', async () => {
    const answer = await query(LIST_QUERY, listParams('', 1))
    expect(answer.status).toBe(200)
    /* `__limit` is `limit + 1` — Studio asks for one extra to detect "more". */
    expect(answer.json.result).toHaveLength(2)

    const one = await query(LIST_QUERY, listParams('', 0))
    expect(one.json.result).toHaveLength(1)
  })

  it('orders newest first, as the pane asked', async () => {
    const answer = await query(LIST_QUERY, listParams(''))
    const stamps = (answer.json.result as Array<{orderings: string[]}>).map((h) => h.orderings[0])
    expect(stamps.length).toBeGreaterThan(1)
    expect(stamps).toEqual([...stamps].sort().reverse())
  })
})

/* ================================================================== *
 * 2. a typed term narrows — honestly, and visibly
 * ================================================================== */

describe('Mode 2 · typing in the pane search box', () => {
  it('narrows to the matching document', async () => {
    const answer = await query(LIST_QUERY, listParams('Born'))
    expect(answer.status).toBe(200)
    expect(idsOf(answer)).toEqual(['origin-proof-1'])
  })

  it('matches on a term buried in the document, not just the id', async () => {
    const answer = await query(LIST_QUERY, listParams('OVERLAY'))
    expect(idsOf(answer)).toEqual(['drafts.article-01'])
  })

  it('is case-insensitive and prefix-matching, like the hosted index', async () => {
    expect(idsOf(await query(LIST_QUERY, listParams('bor')))).toEqual(['origin-proof-1'])
    expect(idsOf(await query(LIST_QUERY, listParams('SANITY')))).toEqual(['origin-proof-1'])
  })

  it('handles a non-ASCII term', async () => {
    expect(idsOf(await query(LIST_QUERY, listParams('日本語')))).toEqual(['drafts.article-01'])
  })

  it('returns nothing for a term nothing matches — and says nothing rather than everything', async () => {
    expect(idsOf(await query(LIST_QUERY, listParams('zzzznothing')))).toEqual([])
  })

  it('DECLARES the approximation in the response instead of passing it off as exact', async () => {
    const answer = await query(LIST_QUERY, listParams('Born'))
    const declared = answer.json.overlayApproximation
    expect(Array.isArray(declared)).toBe(true)
    expect(declared).toHaveLength(1)
    expect(declared[0].function).toBe('text::query')
    expect(declared[0].term).toBe('Born*')
    expect(String(declared[0].reason)).toMatch(/rank|index|full-text/i)
  })

  it('does NOT claim an approximation for the unfiltered pane — `*` is exact', async () => {
    /* `prefixLast('') === '*'` means "everything of these types", and over a
     * dataset that IS the overlay that is an exact answer, not a guess. */
    const answer = await query(LIST_QUERY, listParams(''))
    expect(answer.json.overlayApproximation).toBeUndefined()
  })

  it('does not decorate an ordinary query at all', async () => {
    const answer = await query('*[_type == "article"]{_id}')
    expect(answer.json.overlayApproximation).toBeUndefined()
  })
})

/* ================================================================== *
 * 3. references($__rawQuery) — a defined answer, not an accident
 * ================================================================== */

describe('Mode 2 · the references() half of the predicate', () => {
  it('contributes nothing for an unfiltered pane, because the raw term is empty', async () => {
    /* `references("")` is false for every document. Asserted directly so the
     * list result above cannot be explained by references() matching. */
    const answer = await query('*[references($__rawQuery)]{_id}', {__rawQuery: ''})
    expect(answer.status).toBe(200)
    expect(answer.json.result).toEqual([])
  })

  it('finds referencing documents when the typed term IS a document id', async () => {
    await mutate([
      {
        create: {
          _id: 'drafts.article-ref',
          _type: 'article',
          title: 'Points at the first one',
          related: {_type: 'reference', _ref: 'drafts.article-01'},
        },
      },
    ])
    const answer = await query(LIST_QUERY, {
      ...listParams('drafts.article-01'),
      __limit: 1001,
    })
    expect(idsOf(answer)).toContain('drafts.article-ref')
  })
})

/* ================================================================== *
 * 4. the list tracks the overlay — creations in, tombstones out
 * ================================================================== */

describe('Mode 2 · the list follows the overlay', () => {
  it('shows a branch-created document', async () => {
    await mutate([
      {create: {_id: 'drafts.article-new', _type: 'article', title: 'Created on the branch'}},
    ])
    expect(idsOf(await query(LIST_QUERY, listParams('')))).toContain('drafts.article-new')
  })

  it('does NOT show a tombstoned document', async () => {
    await post(`${V}/data/actions/${DATASET}`, {
      actions: [
        {
          actionType: 'sanity.action.document.delete',
          publishedId: 'article-new',
          includeDrafts: ['drafts.article-new'],
        },
      ],
    })
    expect(idsOf(await query(LIST_QUERY, listParams('')))).not.toContain('drafts.article-new')
  })

  it('does not resurrect a tombstoned document through a typed search either', async () => {
    expect(idsOf(await query(LIST_QUERY, listParams('Created')))).toEqual([])
  })
})

/* ================================================================== *
 * 5. where Mode 2 genuinely cannot go, it refuses out loud
 * ================================================================== */

describe('Mode 2 · the limits of a local text index', () => {
  it('refuses text::query outside a match predicate rather than answering wrongly', async () => {
    const answer = await query('*[_type == "article"]{"t": text::query($__query)}', {__query: '*'})
    expect(answer.status).toBe(501)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_UNIMPLEMENTED')
    expect(String(answer.json.error.description)).toContain('text::query')
  })

  it('still reports a genuinely broken query as a parse error, not as an empty list', async () => {
    const answer = await query('*[_type == ]{')
    expect(answer.status).toBe(400)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_INVALID_GROQ')
  })

  it('rejects a slice parameter that is not a number instead of silently dropping the slice', async () => {
    const answer = await query('*[_type == "article"][0...$__limit]', {__limit: 'lots'})
    expect(answer.status).toBe(400)
    expect(answer.json.error.code).toBe('OVERLAY_ORIGIN_INVALID_GROQ')
  })
})
