/**
 * SPIKE A — GATE E: the facade gaps Spike F found, closed one class at a time.
 *
 * WHAT THIS FILE IS NOT
 * ─────────────────────
 * It is not a security suite. `spike-f-safety-boundary/report.md` settled that
 * question: **the client facade is not a security boundary and cannot be made
 * into one** — any page JS holding a write token bypasses it (attacks 25–27).
 * The proxy is the enforcement boundary and is already default-deny, with
 * `writeGuardContract.ts` behind it.
 *
 * WHY THE GAPS STILL MATTER
 * ─────────────────────────
 * A write that escapes the facade escapes **local echo**. The user's edit then
 * either vanishes (the overlay never hears about it, the pane shows content that
 * exists nowhere) or diverges (staging moves, the overlay does not) — and with
 * the proxy in front, the escape surfaces as an opaque 403 in the middle of an
 * edit instead of an edit that simply works locally. So every gap below is a
 * **correctness and UX** defect, and the fix is judged on whether the edit still
 * works, not on whether an attacker is stopped.
 *
 * THE SIX GAPS (report.md, "Real facade gaps")
 *   18/19  `Patch.clone().commit()` / `Transaction.clone().commit()` escape the
 *          fluent wrapper — `blockFluentCommit` only re-wrapped `result === t`.
 *   20     `request({uri: 'data/mutate'})` with no leading slash. ALREADY CLOSED
 *          by the shared `requestPath()` normaliser — witnessed in part 0.
 *   21/22  `client.assets.*` — a namespace object, never descended into.
 *   23     `client.agent.action.*` — likewise.
 *   24     `client.datasets.*` (and `releases`) — likewise.
 *   7      `resource:`-configured clients write to `/projects/<p>/datasets/<d>/
 *          mutate` with NO `/data/` prefix — `resourceDataBase()`.
 *
 * Plus the Gate E follow-up: `restoreSession()` existed and was tested but
 * nothing ever called it, so a session that 401s stayed write-refusing until a
 * full page reload. Part 5.
 *
 * ORACLES
 * ───────
 * Every "blocked" assertion is made against something the facade did not
 * compute: the REAL `@sanity/client@7.26.0` builder classes and namespace
 * clients are used, and the escape detector is "was the underlying method
 * invoked at all". Every "echoed" assertion reads `__SPIKE_ECHO__.emitted`,
 * which is written by the protocol from the frame it delivered, not by the call
 * site. The namespace method inventories are read off the installed client's
 * prototypes at run time, so a `@sanity/client` upgrade that adds a method makes
 * this file red rather than silently reopening a gap.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createClient, type ClientConfig} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {
  CLIENT_NAMESPACE_POLICY,
  classifyWriteEndpoint,
  identityProofFrom,
  isIdentityProbeEndpoint,
  isMutationEndpoint,
  namespaceMethodKind,
} from '../../../examples/kitchen-sink/spikeA/echoProtocol'

type Rec = Record<string, unknown>

/**
 * Measured, not guessed: a full-suite load sweep clocked this file at **5012 ms**
 * against vitest's 5 s default — already over budget before CI adds contention.
 * The cost is real work, not a leak: ~200 cases each construct a live
 * `@sanity/client`, walk every namespace prototype and exercise both the promise
 * and observable surfaces.
 *
 * A budget is the right tool here rather than restructuring, because nothing in
 * this file asserts on time — every assertion is structural (which endpoint a
 * call classified as, whether the echo layer saw it). Raising the ceiling
 * therefore cannot weaken a claim, only stop the runner from cutting real work
 * short. Same treatment as `action-echo`, `core-properties` and `overlay-server`.
 */
vi.setConfig({testTimeout: 30_000, hookTimeout: 30_000})

/* ───────────────────────────────────────────────────── browser-global stubs */

class StubStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value)
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  clear(): void {
    this.#map.clear()
  }
}

const storage = new StubStorage()
const win: Record<string, unknown> = {localStorage: storage}
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).localStorage = storage

interface EchoWindow {
  __SPIKE_ECHO__?: {
    errors: string[]
    emitted: Array<{documentId: string; transactionId: string; mutationCount: number}>
    blocked: Array<{method: string; handled: boolean}>
    revs: Record<string, string | undefined>
    persist: {failed: number; committed: number}
  }
}

type EchoModule = typeof import('../../../examples/kitchen-sink/spikeA/localEcho')

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function loadEcho(flags: Record<string, string> = {SPIKE_LOCAL_ECHO: '1'}): Promise<EchoModule> {
  await settle()
  storage.clear()
  for (const [key, value] of Object.entries(flags)) storage.setItem(key, value)
  ;(win as EchoWindow).__SPIKE_ECHO__ = undefined
  vi.resetModules()
  return import('../../../examples/kitchen-sink/spikeA/localEcho')
}

function echoLog(): NonNullable<EchoWindow['__SPIKE_ECHO__']> {
  const log = (win as EchoWindow).__SPIKE_ECHO__
  if (!log) throw new Error('__SPIKE_ECHO__ was never created')
  return log
}

const CONFIG: ClientConfig = {
  projectId: 'b1n03q3z',
  dataset: 'parity',
  apiVersion: '2025-02-19',
  useCdn: false,
}

const DS = 'parity'
const PID = 'b1n03q3z'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ================================================================== *
 * 0. Gap 20 — the one a previous agent already closed. Regression witness.
 * ================================================================== */

describe('gap 20 (leading-slash-less write URL) is already closed', () => {
  const CLOSED = [
    'data/mutate/parity',
    'data/actions/parity',
    '/data/mutate/parity',
    '//data//mutate//parity',
    '/v2025-02-19/data/actions/parity',
    '/DATA/MUTATE/parity',
    'https://b1n03q3z.api.sanity.io/v2025-02-19/data/mutate/parity',
  ]

  for (const url of CLOSED) {
    it(`isMutationEndpoint(${JSON.stringify(url)}) — closed by the shared normaliser`, () => {
      expect(isMutationEndpoint(url)).toBe(true)
    })
  }

  it('still lets the read plane through', () => {
    expect(isMutationEndpoint('/data/query/parity')).toBe(false)
    expect(isMutationEndpoint('data/query/parity')).toBe(false)
  })
})

/* ================================================================== *
 * 1. The write-endpoint classifier — gap 7 and the endpoint families
 *    behind gaps 21/23/24, as pure data in / data out.
 * ================================================================== */

describe('classifyWriteEndpoint — every write URL @sanity/client 7.26.0 can build', () => {
  const DOCUMENTS: Array<[string, string]> = [
    ['/data/mutate/' + DS, 'Mutation API'],
    ['/data/actions/' + DS, 'Actions API'],
    ['data/mutate/' + DS, 'gap 20 spelling'],
    /* gap 7 — `resourceDataBase()` builds these with NO /data/ prefix. */
    ['/projects/' + PID + '/datasets/' + DS + '/mutate', 'resource: {type:"dataset"} mutate'],
    ['/projects/' + PID + '/datasets/' + DS + '/actions', 'resource: {type:"dataset"} actions'],
    ['projects/' + PID + '/datasets/' + DS + '/mutate', 'the same, leading slash stripped'],
    ['/canvases/canvas-1/mutate', 'resource: {type:"canvas"}'],
    ['/canvases/canvas-1/actions', 'resource: {type:"canvas"} actions'],
    ['/media-libraries/ml-1/mutate', 'resource: {type:"media-library"}'],
    ['/dashboards/db-1/actions', 'resource: {type:"dashboard"}'],
    ['/v2025-02-19/projects/' + PID + '/datasets/' + DS + '/mutate', 'API-version prefixed'],
  ]

  const ASSETS: Array<[string, string]> = [
    ['/assets/images/' + DS, 'image upload'],
    ['/assets/files/' + DS, 'file upload'],
    ['assets/images/' + DS, 'the exact string buildAssetUploadUrl() returns'],
    ['assets/files/' + DS, 'ditto, files'],
    ['/canvases/canvas-1/assets/images', 'canvas asset upload'],
    ['/dashboards/db-1/assets/files', 'dashboard asset upload'],
    ['/media-libraries/ml-1/upload', 'media-library upload'],
  ]

  const AGENT: Array<[string, string]> = [
    ['/agent/action/patch/' + DS, 'agent patch'],
    ['/agent/action/generate/' + DS, 'agent generate'],
    ['/agent/action/transform/' + DS, 'agent transform'],
    ['/agent/action/translate/' + DS, 'agent translate'],
    ['/agent/action/prompt/' + DS, 'agent prompt'],
    ['agent/action/patch/' + DS, 'no leading slash'],
  ]

  const DATASET_ADMIN: Array<[string, string]> = [
    ['/datasets/' + DS, 'DatasetsClient create/edit/delete'],
    ['/datasets/' + DS + '/settings/embeddings', 'embeddings settings'],
    ['/projects/' + PID + '/datasets/' + DS, 'dataset admin under a project host'],
    ['/projects/' + PID + '/datasets/' + DS + '/settings/embeddings', 'ditto, embeddings'],
  ]

  for (const [url, why] of DOCUMENTS) {
    it(`classifies ${url} as a document write (${why})`, () => {
      expect(classifyWriteEndpoint(url)).toBe('documents')
      expect(isMutationEndpoint(url)).toBe(true)
    })
  }
  for (const [url, why] of ASSETS) {
    it(`classifies ${url} as an asset write (${why})`, () => {
      expect(classifyWriteEndpoint(url)).toBe('asset')
    })
  }
  for (const [url, why] of AGENT) {
    it(`classifies ${url} as an agent action (${why})`, () => {
      expect(classifyWriteEndpoint(url)).toBe('agent-action')
    })
  }
  for (const [url, why] of DATASET_ADMIN) {
    it(`classifies ${url} as dataset administration (${why})`, () => {
      expect(classifyWriteEndpoint(url)).toBe('dataset-admin')
    })
  }

  /* The other direction: the classifier must not swallow the read plane, or the
   * facade starts answering queries with synthetic mutation results. */
  const READS = [
    '/data/query/' + DS,
    'data/query/' + DS,
    '/data/doc/' + DS + '/article-1',
    '/data/listen/' + DS,
    '/data/history/' + DS + '/article-1',
    '/data/live/events/' + DS,
    '/projects/' + PID + '/datasets/' + DS + '/query',
    '/projects/' + PID + '/datasets/' + DS + '/doc/article-1',
    '/canvases/canvas-1/query',
    '/datasets',
    '/projects',
    '/projects/' + PID,
    '/users/me',
    '/auth/id',
    '/auth/logout',
    '/ping',
    '/versions',
  ]
  for (const url of READS) {
    it(`leaves ${url} unclassified — it is not a write`, () => {
      expect(classifyWriteEndpoint(url)).toBeUndefined()
    })
  }

  it('is not fooled by a write path quoted inside a GROQ query string', () => {
    expect(classifyWriteEndpoint('/data/query/' + DS + '?query=*[_id=="/data/mutate/x"]')).toBeUndefined()
  })

  it('classifies a non-string target as not-a-write rather than throwing', () => {
    expect(classifyWriteEndpoint(undefined)).toBeUndefined()
    expect(classifyWriteEndpoint(null)).toBeUndefined()
    expect(classifyWriteEndpoint({})).toBeUndefined()
  })
})

/* ================================================================== *
 * 2. Gaps 18/19 — the fluent builders, and EVERY clone/copy path on them.
 * ================================================================== *
 *
 * The real `Patch` / `Transaction` classes are used (they are not exported from
 * `@sanity/client`, so they are reached through a real client). `commit()` is
 * `this.#client.mutate(...)` in both — see `data/patch.ts:324` and
 * `data/transaction.ts:186` — and `#client` is captured at CONSTRUCTION from the
 * unwrapped client. So "did the write escape?" is answerable without a network:
 * an own-property stub on the raw client's `mutate` records every escape.
 */

interface Rig {
  wrapped: Rec
  escapes: unknown[][]
}

async function builderRig(flags?: Record<string, string>): Promise<Rig & {echo: EchoModule}> {
  const echo = await loadEcho(flags)
  const real = createClient({...CONFIG})
  const escapes: unknown[][] = []
  /* Own properties shadow the prototype methods the builders call, so an escape
   * is recorded instead of reaching get-it. */
  ;(real as unknown as Rec).mutate = (...args: unknown[]): unknown => {
    escapes.push(['mutate', ...args])
    return Promise.resolve({transactionId: 'ESCAPED'})
  }
  ;(real.observable as unknown as Rec).mutate = (...args: unknown[]): unknown => {
    escapes.push(['observable.mutate', ...args])
    return {subscribe: () => ({unsubscribe: () => {}})}
  }
  const wrapped = echo.wrapWithLocalEcho(real) as unknown as Rec
  return {wrapped, escapes, echo}
}

/** Drain a promise-or-observable commit result. */
async function drain(result: unknown): Promise<unknown> {
  if (result && typeof (result as Rec).subscribe === 'function') {
    return new Promise((resolve, reject) => {
      ;(result as {subscribe: (o: Rec) => unknown}).subscribe({
        next: (value: unknown) => resolve(value),
        error: (error: unknown) => reject(error),
        complete: () => resolve(undefined),
      })
    })
  }
  return result
}

describe('gaps 18/19 — no builder, and no copy of a builder, escapes the facade', () => {
  /**
   * The class, enumerated. Each entry produces a builder that has passed through
   * at least one copy/reset/chain path and then commits. Every one of them must
   * be intercepted, and every one of them must echo the edit rather than drop it.
   */
  const PATHS: Array<{
    name: string
    /** builds and commits; returns the document id the edit targets */
    run: (client: Rec) => {result: unknown; documentId: string}
  }> = [
    {
      name: 'patch(id).set().commit() — the baseline that already worked',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-1')
        const set = (p.set as (a: Rec) => Rec)({title: 'direct'})
        return {result: (set.commit as () => unknown)(), documentId: 'drafts.article-1'}
      },
    },
    {
      name: 'patch(id).clone().commit() — Spike F attack 18',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-2')
        ;(p.set as (a: Rec) => Rec)({title: 'cloned'})
        const clone = (p.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-2'}
      },
    },
    {
      name: 'patch(id).clone().clone().commit() — a copy of a copy',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-3')
        ;(p.set as (a: Rec) => Rec)({title: 'twice'})
        const twice = ((p.clone as () => Rec)().clone as () => Rec)()
        return {result: (twice.commit as () => unknown)(), documentId: 'drafts.article-3'}
      },
    },
    {
      name: 'patch(id).clone().set().commit() — chaining off a clone',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-4')
        const clone = (p.clone as () => Rec)()
        const set = (clone.set as (a: Rec) => Rec)({title: 'chained off a clone'})
        return {result: (set.commit as () => unknown)(), documentId: 'drafts.article-4'}
      },
    },
    {
      name: 'patch(id).reset().set().commit() — reset returns `this`',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-5')
        const reset = (p.reset as () => Rec)()
        const set = (reset.set as (a: Rec) => Rec)({title: 'after reset'})
        return {result: (set.commit as () => unknown)(), documentId: 'drafts.article-5'}
      },
    },
    {
      name: 'transaction().patch().commit() — the baseline',
      run: (c) => {
        const t = (c.transaction as () => Rec)()
        const withPatch = (t.patch as (id: string, ops: Rec) => Rec)('drafts.article-6', {
          set: {title: 'tx direct'},
        })
        return {result: (withPatch.commit as () => unknown)(), documentId: 'drafts.article-6'}
      },
    },
    {
      name: 'transaction().patch().clone().commit() — Spike F attack 19',
      run: (c) => {
        const t = (c.transaction as () => Rec)()
        ;(t.patch as (id: string, ops: Rec) => Rec)('drafts.article-7', {set: {title: 'tx clone'}})
        const clone = (t.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-7'}
      },
    },
    {
      name: 'transaction().clone().patch().commit() — mutating the clone',
      run: (c) => {
        const t = (c.transaction as () => Rec)()
        const clone = (t.clone as () => Rec)()
        const withPatch = (clone.patch as (id: string, ops: Rec) => Rec)('drafts.article-8', {
          set: {title: 'on the clone'},
        })
        return {result: (withPatch.commit as () => unknown)(), documentId: 'drafts.article-8'}
      },
    },
    {
      name: 'transaction().create().clone().commit() — a create on a copied transaction',
      run: (c) => {
        const t = (c.transaction as () => Rec)()
        ;(t.create as (d: Rec) => Rec)({_id: 'drafts.article-9', _type: 'article', title: 'made'})
        const clone = (t.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-9'}
      },
    },
    {
      name: 'transaction([ops]).clone().commit() — a transaction seeded from an array',
      run: (c) => {
        const t = (c.transaction as (ops: Rec[]) => Rec)([
          {patch: {id: 'drafts.article-10', set: {title: 'seeded'}}},
        ])
        const clone = (t.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-10'}
      },
    },
    {
      name: 'transaction().patch(builderFn).clone().commit() — the builder-function form',
      run: (c) => {
        const t = (c.transaction as () => Rec)()
        ;(t.patch as (id: string, fn: (p: Rec) => Rec) => Rec)('drafts.article-11', (p) =>
          (p.set as (a: Rec) => Rec)({title: 'built'}),
        )
        const clone = (t.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-11'}
      },
    },
    {
      name: 'transaction().patch(client.patch(id)) — a Patch handed to a Transaction',
      run: (c) => {
        const p = (c.patch as (id: string) => Rec)('drafts.article-12')
        const set = (p.set as (a: Rec) => Rec)({title: 'passed in'})
        const t = (c.transaction as () => Rec)()
        const withPatch = (t.patch as (p: Rec) => Rec)(set)
        const clone = (withPatch.clone as () => Rec)()
        return {result: (clone.commit as () => unknown)(), documentId: 'drafts.article-12'}
      },
    },
  ]

  for (const path of PATHS) {
    it(`intercepts and echoes: ${path.name}`, async () => {
      const {wrapped, escapes} = await builderRig()
      const {result, documentId} = path.run(wrapped)
      await drain(result)
      await settle()

      /* 1. The write never reached the client. */
      expect(escapes).toEqual([])
      /* 2. And the edit was not merely swallowed — it was echoed, so the pane
       *    converges on the overlay's version instead of silently losing it. */
      expect(echoLog().emitted.map((e) => e.documentId)).toContain(documentId)
    })

    it(`intercepts the observable form: ${path.name}`, async () => {
      const {wrapped, escapes} = await builderRig()
      const {result, documentId} = path.run(wrapped.observable as Rec)
      await drain(result)
      await settle()

      expect(escapes).toEqual([])
      expect(echoLog().emitted.map((e) => e.documentId)).toContain(documentId)
    })
  }

  /**
   * The other way a builder reaches the wire: handed to `client.mutate()`
   * instead of committing itself (`_mutate` serialises `Patch`/`Transaction`
   * instances, dataMethods.ts). `mutate` was already intercepted, so nothing
   * escaped — but the planner could not read a builder instance, so the edit was
   * blocked WITHOUT an echo and the user's change vanished. Same class of
   * failure as gaps 18/19, reached from the other end.
   */
  const HANDED_IN: Array<{name: string; build: (c: Rec) => {arg: unknown; documentId: string}}> = [
    {
      name: 'client.mutate(client.patch(id).set(…))',
      build: (c) => ({
        arg: ((c.patch as (id: string) => Rec)('drafts.article-20').set as (a: Rec) => Rec)({
          title: 'handed to mutate',
        }),
        documentId: 'drafts.article-20',
      }),
    },
    {
      name: 'client.mutate(client.transaction().patch(…))',
      build: (c) => {
        const t = (c.transaction as () => Rec)()
        return {
          arg: (t.patch as (id: string, ops: Rec) => Rec)('drafts.article-21', {
            set: {title: 'tx handed to mutate'},
          }),
          documentId: 'drafts.article-21',
        }
      },
    },
    {
      name: 'client.mutate([client.patch(id).set(…)]) — inside an array',
      build: (c) => ({
        arg: [
          ((c.patch as (id: string) => Rec)('drafts.article-22').set as (a: Rec) => Rec)({
            title: 'in an array',
          }),
        ],
        documentId: 'drafts.article-22',
      }),
    },
  ]

  for (const path of HANDED_IN) {
    it(`echoes a builder handed to mutate: ${path.name}`, async () => {
      const {wrapped, escapes} = await builderRig()
      const {arg, documentId} = path.build(wrapped)
      await drain((wrapped.mutate as (a: unknown) => unknown)(arg))
      await settle()
      expect(escapes).toEqual([])
      expect(echoLog().emitted.map((e) => e.documentId)).toContain(documentId)
    })
  }

  it('records the commit as handled, not as a blocked-without-echo dead end', async () => {
    const {wrapped} = await builderRig()
    const p = (wrapped.patch as (id: string) => Rec)('drafts.article-1')
    const set = (p.set as (a: Rec) => Rec)({title: 'handled'})
    await drain(((p.clone as () => Rec)().commit as () => unknown)())
    await settle()
    void set
    const entry = echoLog().blocked.find((b) => b.method.startsWith('patch'))
    expect(entry?.handled).toBe(true)
  })

  it('carries the transaction id the caller supplied into the echoed frame', async () => {
    const {wrapped} = await builderRig()
    const t = (wrapped.transaction as () => Rec)()
    ;(t.patch as (id: string, ops: Rec) => Rec)('drafts.article-1', {set: {title: 'x'}})
    const clone = (t.clone as () => Rec)()
    await drain((clone.commit as (o: Rec) => unknown)({transactionId: 'caller-tx-1'}))
    await settle()
    expect(echoLog().emitted.map((e) => e.transactionId)).toContain('caller-tx-1')
  })

  it('persists a cloned-builder commit to the overlay like any other write', async () => {
    const posted: Array<Rec> = []
    ;(globalThis as Rec).fetch = async (url: string, init?: {body?: string}): Promise<unknown> => {
      if (String(url).endsWith('/state')) {
        return {ok: true, status: 200, json: async () => ({ok: true, documents: []})}
      }
      posted.push(JSON.parse(String(init?.body ?? '{}')) as Rec)
      return {ok: true, status: 200, json: async () => ({ok: true, committed: true, documents: []})}
    }
    const {wrapped} = await builderRig({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const p = (wrapped.patch as (id: string) => Rec)('drafts.article-1')
    ;(p.set as (a: Rec) => Rec)({title: 'persisted from a clone'})
    await drain(((p.clone as () => Rec)().commit as () => unknown)())
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({kind: 'mutations'})
    expect(JSON.stringify(posted[0]?.payload)).toContain('persisted from a clone')
    delete (globalThis as Rec).fetch
  })

  it('refuses a cloned-builder commit once the session is unauthenticated', async () => {
    /* The clone must not be a way around the write veto either: it goes through
     * `blockedResult`, so it inherits `acknowledgeWrite()`. */
    ;(globalThis as Rec).fetch = async (url: string): Promise<unknown> => {
      if (String(url).endsWith('/state')) {
        return {ok: true, status: 200, json: async () => ({ok: true, documents: []})}
      }
      return {ok: false, status: 401, json: async () => ({ok: false, error: {message: 'expired'}})}
    }
    const {wrapped} = await builderRig({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const p = (wrapped.patch as (id: string) => Rec)('drafts.article-1')
    ;(p.set as (a: Rec) => Rec)({title: 'never lands'})
    await expect(drain(((p.clone as () => Rec)().commit as () => unknown)())).rejects.toThrow(/401/)
    await settle()
    expect(echoLog().emitted).toEqual([])
    delete (globalThis as Rec).fetch
  })
})

/* ================================================================== *
 * 3. Gaps 21/22/23/24 — the namespace objects the facade never descended into.
 * ================================================================== */

/** The namespaces as the installed client actually exposes them. */
function namespaceTargets(client: Rec): Array<{path: string; target: Rec}> {
  return [
    {path: 'assets', target: client.assets as Rec},
    {path: 'datasets', target: client.datasets as Rec},
    {path: 'projects', target: client.projects as Rec},
    {path: 'users', target: client.users as Rec},
    {path: 'releases', target: client.releases as Rec},
    {path: 'live', target: client.live as Rec},
    {path: 'agent.action', target: (client.agent as Rec).action as Rec},
    {path: 'mediaLibrary.video', target: (client.mediaLibrary as Rec).video as Rec},
  ]
}

function prototypeMethods(target: Rec): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter(
    (name) => name !== 'constructor' && typeof (target as Rec)[name] === 'function',
  )
}

describe('the namespace policy covers every method @sanity/client 7.26.0 ships', () => {
  /* This is the class guarantee: the policy is not a list someone remembered,
   * it is checked against the installed client's prototypes. A version bump that
   * adds `datasets.duplicate` makes this red instead of quietly reopening gap 24. */
  const client = createClient({...CONFIG}) as unknown as Rec

  for (const {path, target} of namespaceTargets(client)) {
    it(`declares every method the installed client.${path} actually has`, () => {
      const methods = prototypeMethods(target)
      expect(methods.length).toBeGreaterThan(0)
      const policy = CLIENT_NAMESPACE_POLICY[path]
      expect(policy, `no policy declared for client.${path}`).toBeDefined()
      const declared = new Set([...(policy?.read ?? []), ...(policy?.write ?? [])])
      expect(methods.filter((m) => !declared.has(m))).toEqual([])
    })

    it(`declares no method on client.${path} the client does not have`, () => {
      const declared = [
        ...(CLIENT_NAMESPACE_POLICY[path]?.write ?? []),
        ...(CLIENT_NAMESPACE_POLICY[path]?.read ?? []),
      ]
      const actual = new Set(prototypeMethods(target))
      expect(declared.filter((m) => !actual.has(m))).toEqual([])
    })
  }

  it('classifies the five promise-side agent actions and notes the observable side ships three', () => {
    /* `AgentActionsClient` has generate/transform/translate/prompt/patch;
     * `ObservableAgentsActionClient` ships only the first three. Both are
     * covered by the same policy entry. */
    const promiseSide = prototypeMethods((client.agent as Rec).action as Rec)
    const observableSide = prototypeMethods(((client.observable as Rec).agent as Rec).action as Rec)
    expect(promiseSide.sort()).toEqual(['generate', 'patch', 'prompt', 'transform', 'translate'])
    expect(observableSide.sort()).toEqual(['generate', 'transform', 'translate'])
    for (const method of promiseSide) {
      expect(namespaceMethodKind('agent.action', method)).toBe('write')
    }
  })

  it('treats an unknown namespace method as a write rather than letting it through', () => {
    expect(namespaceMethodKind('datasets', 'someFutureWrite')).toBe('write')
    expect(namespaceMethodKind('assets', 'uploadV2')).toBe('write')
  })
})

async function namespaceRig(): Promise<{
  wrapped: Rec
  raw: Rec
  invoked: string[]
}> {
  const echo = await loadEcho()
  const real = createClient({...CONFIG}) as unknown as Rec
  const invoked: string[] = []
  for (const {path, target} of namespaceTargets(real)) {
    for (const method of prototypeMethods(target)) {
      ;(target as Rec)[method] = (...args: unknown[]): unknown => {
        invoked.push(`${path}.${method}`)
        void args
        return Promise.resolve({ok: true})
      }
    }
  }
  return {wrapped: echo.wrapWithLocalEcho(real as never) as unknown as Rec, raw: real, invoked}
}

function reach(client: Rec, path: string): Rec {
  return path.split('.').reduce<Rec>((node, key) => node[key] as Rec, client)
}

describe('gaps 21/22/23/24 — namespace writes are intercepted', () => {
  const WRITE_CASES: Array<[string, string]> = []
  for (const [path, policy] of Object.entries(CLIENT_NAMESPACE_POLICY)) {
    for (const method of policy.write) WRITE_CASES.push([path, method])
  }

  it('has write cases for every gap Spike F named', () => {
    const flat = WRITE_CASES.map(([p, m]) => `${p}.${m}`)
    expect(flat).toContain('assets.upload') // gaps 21/22
    expect(flat).toContain('agent.action.patch') // gap 23
    expect(flat).toContain('datasets.create') // gap 24
    expect(flat).toContain('datasets.delete')
    expect(flat).toContain('releases.publish')
  })

  for (const [path, method] of WRITE_CASES) {
    it(`refuses client.${path}.${method}() and never invokes the real method`, async () => {
      const {wrapped, invoked} = await namespaceRig()
      const namespace = reach(wrapped, path)
      await expect(
        (namespace[method] as (...a: unknown[]) => Promise<unknown>)({}),
      ).rejects.toThrow(/local echo|local-echo/i)
      expect(invoked).toEqual([])
    })

    it(`records client.${path}.${method}() as blocked-without-echo`, async () => {
      const {wrapped} = await namespaceRig()
      const namespace = reach(wrapped, path)
      await (namespace[method] as (...a: unknown[]) => Promise<unknown>)({}).catch(() => {})
      const entry = echoLog().blocked.find((b) => b.method === `${path}.${method}`)
      expect(entry).toBeDefined()
      expect(entry?.handled).toBe(false)
    })
  }

  const READ_CASES: Array<[string, string]> = []
  for (const [path, policy] of Object.entries(CLIENT_NAMESPACE_POLICY)) {
    for (const method of policy.read) READ_CASES.push([path, method])
  }

  for (const [path, method] of READ_CASES) {
    it(`passes client.${path}.${method}() straight through`, async () => {
      const {wrapped, invoked} = await namespaceRig()
      const namespace = reach(wrapped, path)
      await (namespace[method] as (...a: unknown[]) => Promise<unknown>)('me')
      expect(invoked).toEqual([`${path}.${method}`])
    })
  }

  it('descends the observable client’s namespaces too — and refuses in observable form', async () => {
    /* `client.observable.assets.upload` returns an Observable, so the refusal
     * has to arrive on the error channel, not as a rejected promise. */
    const {wrapped, invoked} = await namespaceRig()
    const observable = wrapped.observable as Rec
    const result = ((observable.assets as Rec).upload as (...a: unknown[]) => unknown)('image', {})
    expect(typeof (result as Rec).subscribe).toBe('function')
    await expect(drain(result)).rejects.toThrow(/local echo|local-echo/i)
    expect(invoked).toEqual([])
  })

  it('keeps namespace access identity-stable (the 40k-resubscribe constraint)', async () => {
    const {wrapped} = await namespaceRig()
    for (const path of ['assets', 'datasets', 'live', 'agent', 'releases', 'projects', 'users']) {
      const seen = new Set<unknown>()
      for (let i = 0; i < 5_000; i += 1) seen.add(wrapped[path])
      expect(seen.size, `client.${path} must be identity-stable`).toBe(1)
    }
    const assets = wrapped.assets as Rec
    const methods = new Set<unknown>()
    for (let i = 0; i < 5_000; i += 1) methods.add(assets.upload)
    expect(methods.size).toBe(1)
  })

  it('leaves client.live.events reaching the real client — it is a read stream', async () => {
    const {wrapped, invoked} = await namespaceRig()
    await ((wrapped.live as Rec).events as (...a: unknown[]) => Promise<unknown>)()
    expect(invoked).toEqual(['live.events'])
  })
})

describe('gap 7 — a resource-configured client’s writes are intercepted', () => {
  it('blocks request() to a resource-scoped mutate URL', async () => {
    const echo = await loadEcho()
    const real = createClient({...CONFIG}) as unknown as Rec
    const reached: string[] = []
    real.request = (options: Rec): unknown => {
      reached.push(String(options.uri ?? options.url ?? ''))
      return Promise.resolve({ok: true})
    }
    const wrapped = echo.wrapWithLocalEcho(real as never) as unknown as Rec

    const result = await (wrapped.request as (o: Rec) => Promise<Rec>)({
      uri: `/projects/${PID}/datasets/${DS}/mutate`,
      method: 'POST',
      body: {mutations: [{patch: {id: 'drafts.article-1', set: {title: 'resource write'}}}]},
    })

    expect(result).toMatchObject({transactionId: expect.any(String)})
    expect(reached).toEqual([])
    await settle()
    expect(echoLog().emitted.map((e) => e.documentId)).toContain('drafts.article-1')
  })

  it('refuses request() to an asset endpoint rather than letting it reach the network', async () => {
    const echo = await loadEcho()
    const real = createClient({...CONFIG}) as unknown as Rec
    const reached: string[] = []
    real.request = (options: Rec): unknown => {
      reached.push(String(options.uri ?? options.url ?? ''))
      return Promise.resolve({ok: true})
    }
    const wrapped = echo.wrapWithLocalEcho(real as never) as unknown as Rec

    await expect(
      (wrapped.request as (o: Rec) => Promise<Rec>)({
        uri: `assets/images/${DS}`,
        method: 'POST',
        body: {},
      }),
    ).rejects.toThrow(/local echo|local-echo/i)
    expect(reached).toEqual([])
  })

  it('still lets a resource-scoped READ through', async () => {
    const echo = await loadEcho()
    const real = createClient({...CONFIG}) as unknown as Rec
    const reached: string[] = []
    real.request = (options: Rec): unknown => {
      reached.push(String(options.uri ?? options.url ?? ''))
      return Promise.resolve({ok: true})
    }
    const wrapped = echo.wrapWithLocalEcho(real as never) as unknown as Rec
    await (wrapped.request as (o: Rec) => Promise<Rec>)({
      uri: `/projects/${PID}/datasets/${DS}/query`,
    })
    expect(reached).toEqual([`/projects/${PID}/datasets/${DS}/query`])
  })
})

/* ================================================================== *
 * 4. GAP 2 — token refresh: the signal, and the credulity it must resist.
 * ================================================================== *
 *
 * The signal is Studio 6.8.0's OWN definition of "authenticated", read out of
 * `WorkspaceLoader-BRx2afZV.js`:
 *
 *   probeAuthState  -> getCurrentUser -> client.request({uri: '/users/me'})
 *                      authenticated: !!currentUser?.id            (:2542)
 *   probeCurrentUser -> client.request({uri: '/auth/id'})
 *                      typeof response?.id === 'string'            (:2465)
 *
 * Both run on a `withConfig({_requestHandler: undefined})` clone, and both are
 * re-run after `refreshWorkbenchToken()` reissues a token (:2436-2438). So the
 * facade learns about a refresh from the same round trip Studio uses, with no
 * new coupling and no polling of its own.
 */

interface TinySubscriber<T> {
  next: (value: T) => void
  error: (error: unknown) => void
  complete: () => void
}

class TinyObservable<T> {
  readonly #onSubscribe: (subscriber: TinySubscriber<T>) => (() => void) | void
  constructor(onSubscribe: (subscriber: TinySubscriber<T>) => (() => void) | void) {
    this.#onSubscribe = onSubscribe
  }
  subscribe(observer: Partial<TinySubscriber<T>>): {unsubscribe: () => void} {
    let closed = false
    const teardown = this.#onSubscribe({
      next: (v) => {
        if (!closed) observer.next?.(v)
      },
      error: (e) => {
        if (!closed) {
          closed = true
          observer.error?.(e)
        }
      },
      complete: () => {
        if (!closed) {
          closed = true
          observer.complete?.()
        }
      },
    })
    return {
      unsubscribe: () => {
        closed = true
        if (typeof teardown === 'function') teardown()
      },
    }
  }
  pipe(...ops: Array<(src: unknown) => unknown>): unknown {
    return ops.reduce<unknown>((src, op) => op(src), this)
  }
}

const USER = {id: 'p8xk1', name: 'Editor', email: 'editor@example.com'}

/**
 * A client whose `request` answers from a table, plus a pair listener whose
 * error channel is drivable — the 401 that kills the session in the browser.
 */
function authRig(): {
  client: Rec
  fail: (error: unknown) => void
  responses: Map<string, () => unknown>
  requested: string[]
} {
  const responses = new Map<string, () => unknown>()
  const requested: string[] = []
  let fail: (error: unknown) => void = () => {}
  const upstream = new TinyObservable<unknown>((subscriber) => {
    fail = (error) => subscriber.error(error)
    return () => {}
  })
  const shared: Rec = {
    fetch: (): unknown => new TinyObservable<unknown>(() => () => {}),
    listen: (): unknown => upstream,
    getDocuments: async (ids: string[]): Promise<unknown> => ids.map(() => null),
    request: (options: Rec): unknown => {
      const uri = String(options.uri ?? options.url ?? '')
      requested.push(uri)
      const answer = responses.get(uri)
      if (!answer) return Promise.resolve({ok: true})
      /* Async rejection, like a real transport — a synchronous throw here would
       * escape the facade's promise tap and make the test red for the wrong
       * reason. */
      try {
        return Promise.resolve(answer())
      } catch (error) {
        return Promise.reject(error)
      }
    },
    create: (): never => {
      throw new Error('a write reached the real client')
    },
    mutate: (): never => {
      throw new Error('a write reached the real client')
    },
    action: (): never => {
      throw new Error('a write reached the real client')
    },
  }
  const client: Rec = {
    ...shared,
    observable: {...shared},
    users: {
      getById: (id: string): unknown => {
        requested.push(`users.getById:${id}`)
        const answer = responses.get(`users.getById:${id}`)
        return Promise.resolve(answer ? answer() : null)
      },
    },
    withConfig: (): unknown => client,
  }
  return {client, fail: (error) => fail(error), responses, requested}
}

/** Kill the session the way a dying token does: a 401 on the pair listener. */
function killSession(wrapped: Rec, rig: ReturnType<typeof authRig>): void {
  const stream = (wrapped.listen as (q: string, p: Rec) => TinyObservable<unknown>)(
    '*[_id in $ids]',
    {ids: ['drafts.article-1', 'article-1']},
  )
  stream.subscribe({error: () => {}})
  rig.fail(Object.assign(new Error('Unauthorized'), {statusCode: 401}))
}

describe('identityProofFrom — what counts as proof of a live credential', () => {
  it('accepts the shape Studio calls authenticated', () => {
    expect(identityProofFrom(USER)).toBe('p8xk1')
  })

  const NOT_PROOF: Array<[string, unknown]> = [
    ['null — the tokenless 200 /users/me returns', null],
    ['undefined', undefined],
    ['an object with no id', {name: 'Editor'}],
    ['an empty id', {id: ''}],
    ['a non-string id', {id: 42}],
    ['a bare true', true],
    ['an ok envelope', {ok: true}],
    ['an array', [USER]],
    ['a string', 'p8xk1'],
  ]
  for (const [label, value] of NOT_PROOF) {
    it(`rejects ${label}`, () => {
      expect(identityProofFrom(value)).toBeUndefined()
    })
  }
})

describe('isIdentityProbeEndpoint — the two endpoints, over the whole path family', () => {
  const PROBES = [
    '/users/me',
    'users/me',
    '/v2025-02-19/users/me',
    '//users//me',
    '/USERS/ME',
    'https://b1n03q3z.api.sanity.io/v2025-02-19/users/me',
    '/auth/id',
    'auth/id',
    '/v2025-02-19/auth/id',
  ]
  for (const url of PROBES) {
    it(`recognises ${url}`, () => {
      expect(isIdentityProbeEndpoint(url)).toBe(true)
    })
  }

  const NOT_PROBES = [
    '/users',
    '/users/p8xk1',
    '/auth/logout',
    '/auth/fetch',
    '/data/query/parity',
    '/ping',
    '/data/mutate/parity',
  ]
  for (const url of NOT_PROBES) {
    it(`does not treat ${url} as an identity probe`, () => {
      expect(isIdentityProbeEndpoint(url)).toBe(false)
    })
  }
})

describe('gap 2 — a refreshed token resumes writes without a page reload', () => {
  it('refuses writes after a 401 — the state this gap is about', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
    killSession(wrapped, rig)

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/401/)
  })

  it('resumes writes once /users/me proves a live credential', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('/users/me', () => USER)
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
    killSession(wrapped, rig)
    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/401/)

    /* Exactly what Studio issues after `refreshWorkbenchToken()` reissues one. */
    const probe = (wrapped.withConfig as (c: Rec) => Rec)({_requestHandler: undefined})
    await (probe.request as (o: Rec) => Promise<unknown>)({
      uri: '/users/me',
      tag: 'users.get-current.update',
    })

    const result = await (wrapped.create as (d: Rec) => Promise<Rec>)({
      _id: 'drafts.article-2',
      _type: 'article',
      title: 'after the refresh',
    })
    expect(result).toMatchObject({transactionId: expect.any(String)})
    await settle()
    expect(echoLog().emitted.map((e) => e.documentId)).toEqual(['drafts.article-2'])
  })

  it('resumes on /auth/id too — Studio’s other identity probe', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('/auth/id', () => ({id: 'p8xk1'}))
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
    killSession(wrapped, rig)

    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/auth/id', tag: 'auth.check-id'})
    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).resolves.toMatchObject({transactionId: expect.any(String)})
  })

  it('resumes on client.users.getById("me") — the same proof, a different surface', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('users.getById:me', () => USER)
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
    killSession(wrapped, rig)

    await ((wrapped.users as Rec).getById as (id: string) => Promise<unknown>)('me')
    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).resolves.toMatchObject({transactionId: expect.any(String)})
  })

  it('resumes through the observable form of the probe', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('/users/me', () => USER)
    ;(rig.client.observable as Rec).request = (options: Rec): unknown =>
      new TinyObservable<unknown>((subscriber) => {
        rig.requested.push(String(options.uri ?? ''))
        subscriber.next(USER)
        subscriber.complete()
      })
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
    killSession(wrapped, rig)

    await new Promise<void>((resolve) => {
      ;(
        (wrapped.observable as Rec).request as (o: Rec) => TinyObservable<unknown>
      )({uri: '/users/me'}).subscribe({complete: () => resolve()})
    })

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).resolves.toMatchObject({transactionId: expect.any(String)})
  })

  /* ---- the credulity guards ---- */

  const CREDULOUS: Array<[string, (wrapped: Rec, rig: ReturnType<typeof authRig>) => Promise<unknown>]> = [
    [
      'a 200 from a public GROQ read',
      async (wrapped) =>
        (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/data/query/parity'}),
    ],
    [
      'a 200 from /ping',
      async (wrapped) => (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/ping'}),
    ],
    [
      'a 200 from an arbitrary endpoint',
      async (wrapped) =>
        (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/projects/b1n03q3z'}),
    ],
    [
      '/users/me resolving to null — the tokenless 200',
      async (wrapped, rig) => {
        rig.responses.set('/users/me', () => null)
        return (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'})
      },
    ],
    [
      '/users/me resolving to an object with no id',
      async (wrapped, rig) => {
        rig.responses.set('/users/me', () => ({name: 'Anonymous'}))
        return (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'})
      },
    ],
    [
      '/auth/id resolving to an empty id',
      async (wrapped, rig) => {
        rig.responses.set('/auth/id', () => ({id: ''}))
        return (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/auth/id'})
      },
    ],
    [
      '/users/me rejecting with a 401',
      async (wrapped, rig) => {
        rig.responses.set('/users/me', () => {
          throw Object.assign(new Error('Unauthorized'), {statusCode: 401})
        })
        return (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'}).catch(() => {})
      },
    ],
    [
      'users.getById on somebody who is not "me"',
      async (wrapped, rig) => {
        rig.responses.set('users.getById:p8xk1', () => USER)
        return ((wrapped.users as Rec).getById as (id: string) => Promise<unknown>)('p8xk1')
      },
    ],
  ]

  for (const [label, act] of CREDULOUS) {
    it(`does NOT resume on ${label}`, async () => {
      const {wrapWithLocalEcho} = await loadEcho()
      const rig = authRig()
      const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec
      killSession(wrapped, rig)

      await act(wrapped, rig)

      await expect(
        (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
      ).rejects.toThrow(/401/)
    })
  }

  it('cannot resurrect a logged-out session', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('/users/me', () => USER)
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec

    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/auth/logout', method: 'POST'})
    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'})

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/logged out/i)
  })

  it('still forwards the probe to the real client — it is a tap, not a replacement', async () => {
    const {wrapWithLocalEcho} = await loadEcho()
    const rig = authRig()
    rig.responses.set('/users/me', () => USER)
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec

    const user = await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'})
    expect(user).toEqual(USER)
    expect(rig.requested).toContain('/users/me')
  })

  it('resumes persistence too, not just acknowledgement', async () => {
    const posted: string[] = []
    let commitStatus = 401
    ;(globalThis as Rec).fetch = async (url: string, init?: {body?: string}): Promise<unknown> => {
      if (String(url).endsWith('/state')) {
        return {ok: true, status: 200, json: async () => ({ok: true, documents: []})}
      }
      posted.push(String(init?.body ?? ''))
      return {
        ok: commitStatus < 400,
        status: commitStatus,
        json: async () => (commitStatus < 400 ? {ok: true, committed: true, documents: []} : {ok: false, error: {message: 'token expired'}}),
      }
    }
    const {wrapWithLocalEcho} = await loadEcho({
      SPIKE_LOCAL_ECHO: '1',
      SPIKE_OVERLAY_PERSIST: '1',
      SPIKE_OVERLAY_URL: 'http://overlay.test',
    })
    const rig = authRig()
    rig.responses.set('/users/me', () => USER)
    const wrapped = wrapWithLocalEcho(rig.client as never) as unknown as Rec

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-1', _type: 'article'}),
    ).rejects.toThrow(/401/)
    expect(posted).toHaveLength(1)

    commitStatus = 200
    await (wrapped.request as (o: Rec) => Promise<unknown>)({uri: '/users/me'})

    await expect(
      (wrapped.create as (d: Rec) => Promise<Rec>)({_id: 'drafts.article-2', _type: 'article'}),
    ).resolves.toMatchObject({transactionId: expect.any(String)})
    expect(posted).toHaveLength(2)
    delete (globalThis as Rec).fetch
  })
})
