/**
 * THE CONSISTENCY GATE, DRIVEN AGAINST `@sanity/mutator` ITSELF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS.
 *
 * `sanity@6.8.0` gates four of the six §21.2 document actions on document
 * CONSISTENCY (`lib/datastores-DqFH7RLd.js:2450`):
 *
 *     const REQUIRES_CONSISTENCY = ["publish", "unpublish", "discardChanges", "delete"]
 *     …
 *     requiresConsistency && (published.commit(), draft.commit(), version?.commit())
 *     return (requiresConsistency ? isConsistent$.pipe(take(1)) : of(true))
 *       .pipe(switchMap(() => execute(args.operationName, …)))
 *
 * `isConsistent$` is `@sanity/mutator`'s `BufferedDocument.onConsistencyChanged`,
 * which flips true only when `Document.submitted` empties — i.e. when the PAIR
 * LISTENER delivers the submitted transaction back
 * (`@sanity/mutator@6.8.0 lib/index.js` `Document.applyIncoming` →
 * `consumeUnresolved`). No frame, no consistency, no `execute`. The action does
 * not fail; it never runs, and the pane sits at `Saving…` for ever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS THE REAL MUTATOR AND THE REAL DISK. NOTHING IS DOUBLED.
 *
 * Five features on this project passed their unit tests and did not work in a
 * browser because the test substituted a double for the broken thing. So:
 *
 *   - `BufferedDocument` / `Mutation` are the REAL `@sanity/mutator@6.8.0`,
 *     resolved out of the installed `sanity@6.8.0`. Consistency is asked of the
 *     library, never computed here.
 *   - the overlay API is a REAL `sanity-overlay-next` server over a REAL
 *     `FsOverlayStore` in a `mkdtemp` root.
 *   - the client facade, echo and transport are the REAL shipped ones, wired by
 *     the REAL `createOverlayRuntime`.
 *   - "did it land?" is answered by reading the bytes back through a SECOND,
 *     freshly-constructed `FsOverlayStore`, never from a value a call returned.
 *
 * The only transcription is sanity's own document-pane plumbing — `patch`,
 * `publish`, `toActions`, `checkoutPair`'s commit loop — quoted with line
 * references below, because importing `sanity` in Node pulls in React.
 *
 * `examples/kitchen-sink/.sanity-overlay` is live state a human tests against
 * and is never touched: every root here is a `mkdtemp`.
 */
import {createRequire} from 'node:module'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {FsOverlayStore} from '../../sanity-overlay-store-fs/src/index'
import {startOverlayApiServer} from '../../sanity-overlay-next/src/index'
import {resolveOverlayOptions} from '../../sanity-overlay-studio/src/options'
import {createOverlayRuntime, type OverlayRuntime} from '../../sanity-overlay-studio/src/runtime'

type Rec = Record<string, unknown>

vi.setConfig({testTimeout: 40_000, hookTimeout: 40_000})

/* ══════════════════════════════════ the real @sanity/mutator, not a stand-in */

/**
 * `@sanity/mutator` is a transitive dependency of `sanity@6.8.0` and is not a
 * direct dependency of this workspace, so it is resolved THROUGH the pinned
 * Studio rather than by name. That also pins it to the exact copy the Studio
 * under test runs, which is the whole point of using it as the oracle.
 */
const kitchenSinkRequire = createRequire(
  new URL('../../../examples/kitchen-sink/package.json', import.meta.url),
)
const sanityRequire = createRequire(kitchenSinkRequire.resolve('sanity'))
const mutator = sanityRequire('@sanity/mutator') as MutatorModule

interface MutatorMutationParams {
  mutations: Rec[]
  transactionId?: string
  resultRev?: string
  previousRev?: string
  timestamp?: string
}

interface MutatorMutation {
  params: MutatorMutationParams
  readonly transactionId?: string
  readonly mutations: Rec[]
  apply(document: Rec | null): Rec | null
}

interface MutatorBufferedDocument {
  LOCAL: Rec | null
  document: {HEAD: Rec | null; isConsistent(): boolean}
  onConsistencyChanged?: (isConsistent: boolean) => void
  commitHandler?: (arg: {
    mutation: MutatorMutation
    success: () => void
    failure: (error?: unknown) => void
    cancel: (error?: unknown) => void
  }) => void
  add(mutation: MutatorMutation): void
  arrive(mutation: MutatorMutation): void
  commit(): Promise<void>
}

interface MutatorModule {
  BufferedDocument: new (doc: Rec | null) => MutatorBufferedDocument
  Mutation: new (params: MutatorMutationParams) => MutatorMutation
}

const {BufferedDocument, Mutation} = mutator

/* ═════════════════════════════════════════ sanity 6.8.0, transcribed verbatim */

/** `lib/datastores-DqFH7RLd.js:1500` — `prepare`. */
function prepareDoc(id: string, document: Rec): Rec {
  const {_id: _ignoredId, _rev: _ignoredRev, _updatedAt: _ignoredUpdatedAt, ...rest} = document
  return {_id: id, ...rest}
}

/** `lib/datastores-DqFH7RLd.js:1766` — `toActions`. */
function toActions(
  idPair: {publishedId: string; draftId: string; versionId?: string},
  params: MutatorMutationParams,
): Rec[] {
  const actions = params.mutations.flatMap((mutation): Rec[] => {
    if (mutation.createIfNotExists) return []
    if (mutation.create) {
      const create = mutation.create as Rec
      if (!create._id) throw new Error('Expected document to have an _id')
      return [
        {
          actionType: 'sanity.action.document.create',
          publishedId: idPair.publishedId,
          attributes: create,
          ifExists: 'fail',
        },
      ]
    }
    if (mutation.patch) {
      const {id: _dropped, ...patch} = mutation.patch as Rec
      return [
        {
          actionType: 'sanity.action.document.edit',
          draftId: idPair.versionId ?? idPair.draftId,
          publishedId: idPair.publishedId,
          patch,
        },
      ]
    }
    throw new Error('Cannot map mutation to action')
  })
  return actions.length === 0
    ? [
        {
          actionType: 'sanity.action.document.edit',
          draftId: idPair.draftId,
          publishedId: idPair.publishedId,
          patch: {unset: ['_empty_action_guard_pseudo_field_']},
        },
      ]
    : actions
}

/** `lib/datastores-DqFH7RLd.js:1758` — `isLiveEditMutation`. */
function isLiveEditMutation(params: MutatorMutationParams, publishedId: string): boolean {
  return params.mutations
    .flatMap((mutation) => {
      const payloads = Object.values(mutation)
      if (payloads.length > 1) throw new Error('Did not expect multiple mutations in one payload')
      const payload = payloads[0] as Rec
      return [payload.id ?? payload._id]
    })
    .every((target) => target === publishedId)
}

/* ════════════════════════════════════════════════════════ a Studio-shaped pane */

interface MinimalSubscription {
  unsubscribe(): void
}
interface MinimalObservable<T> {
  subscribe(observer: {next?: (v: T) => void; error?: (e: unknown) => void}): MinimalSubscription
}

function isObservable(value: unknown): value is MinimalObservable<unknown> {
  return typeof value === 'object' && value !== null &&
    typeof (value as Rec).subscribe === 'function'
}

async function firstValue(result: unknown): Promise<unknown> {
  if (isObservable(result)) {
    return new Promise((resolve, reject) => {
      let settled = false
      result.subscribe({
        next: (value) => {
          if (settled) return
          settled = true
          resolve(value)
        },
        error: (error) => {
          if (settled) return
          settled = true
          reject(error)
        },
      })
    })
  }
  return result
}

/**
 * `checkoutPair` + `createBufferedDocument` + `operationEvents`, reduced to the
 * parts that decide the question this file asks.
 *
 * Deliberately NOT a re-implementation of the mutator: every consistency answer
 * comes from `BufferedDocument.onConsistencyChanged`, every HEAD advance from
 * `BufferedDocument.arrive`.
 */
class Pane {
  readonly publishedId: string
  readonly draftId: string
  readonly typeName: string
  readonly client: Rec
  draft!: MutatorBufferedDocument
  published!: MutatorBufferedDocument
  consistent: {draft: boolean; published: boolean} = {draft: true, published: true}
  readonly events: Rec[] = []
  readonly commitErrors: unknown[] = []
  #subscription: MinimalSubscription | null = null

  constructor(client: Rec, publishedId: string, typeName: string) {
    this.client = client
    this.publishedId = publishedId
    this.draftId = `drafts.${publishedId}`
    this.typeName = typeName
  }

  get idPair(): {publishedId: string; draftId: string} {
    return {publishedId: this.publishedId, draftId: this.draftId}
  }

  /** `fetchInitialDocumentSnapshots` + the two `createBufferedDocument` calls. */
  async open(): Promise<void> {
    const snapshot = (await firstValue(
      (this.client.getDocuments as (ids: string[]) => unknown)([this.publishedId, this.draftId]),
    )) as Array<Rec | null>
    const [published, draft] = snapshot

    this.draft = this.#buffered(draft ?? null, 'draft')
    this.published = this.#buffered(published ?? null, 'published')

    const stream = (this.client.listen as (...a: unknown[]) => unknown)(
      '*[_id in $ids]',
      {ids: [this.publishedId, this.draftId]},
      {includeResult: false, effectFormat: 'mendoza', tag: 'document.pair.listen'},
    )
    if (isObservable(stream)) {
      this.#subscription = stream.subscribe({
        next: (event) => this.#receive(event as Rec),
      })
    }
  }

  close(): void {
    this.#subscription?.unsubscribe()
  }

  #buffered(snapshot: Rec | null, which: 'draft' | 'published'): MutatorBufferedDocument {
    const buffered = new BufferedDocument(snapshot)
    /* `handleDocConsistencyChanged` only reports `true` when there is nothing
     * local left, which is exactly the semantic `consistencyStatus` combines. */
    buffered.onConsistencyChanged = (isConsistent: boolean): void => {
      this.consistent[which] = isConsistent
    }
    buffered.commitHandler = (arg): void => {
      this.#submit(arg)
    }
    return buffered
  }

  #receive(event: Rec): void {
    this.events.push(event)
    /**
     * `getPairListener`, `lib/datastores-DqFH7RLd.js:1681`:
     *
     *     concatMap(event => event.type === "reset" || event.type === "welcome"
     *       ? fetchInitialDocumentSnapshots().pipe(mergeMap(…snapshot events…))
     *       : of(event))
     *
     * and `createObservableBufferedDocument`'s scan on a snapshot
     * (`:1487`): commit whatever is buffered, `consistency$.next(true)`, then
     * build a fresh `BufferedDocument` from the fetched document.
     */
    if (event.type === 'reset') {
      void this.resnapshot()
      return
    }
    if (event.type !== 'mutation') return
    const target = event.documentId === this.draftId ? this.draft : this.published
    target.arrive(new Mutation(event as unknown as MutatorMutationParams))
  }

  async resnapshot(): Promise<void> {
    const snapshot = (await firstValue(
      (this.client.getDocuments as (ids: string[]) => unknown)([this.publishedId, this.draftId]),
    )) as Array<Rec | null>
    const [published, draft] = snapshot
    void this.draft.commit()
    void this.published.commit()
    this.consistent = {draft: true, published: true}
    this.draft = this.#buffered(draft ?? null, 'draft')
    this.published = this.#buffered(published ?? null, 'published')
  }

  /** `submitCommitRequest` + `commitActions`, `lib/datastores-…:1815`. */
  #submit(arg: {
    mutation: MutatorMutation
    success: () => void
    failure: (error?: unknown) => void
    cancel: (error?: unknown) => void
  }): void {
    const params = arg.mutation.params
    const send = isLiveEditMutation(params, this.publishedId)
      ? (): unknown => {
          const {resultRev: _dropped, ...body} = params
          return (this.client.dataRequest as (...a: unknown[]) => unknown)('mutate', body, {
            visibility: 'async',
            returnDocuments: false,
            tag: 'document.commit',
          })
        }
      : (): unknown =>
          (
            (
              (this.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
                .observable as Rec
            ).action as (...a: unknown[]) => unknown
          )(toActions(this.idPair, params), {
            tag: 'document.commit',
            transactionId: params.transactionId,
          })

    void firstValue(send()).then(
      () => arg.success(),
      (error: unknown) => {
        this.commitErrors.push(error)
        arg.failure(error)
      },
    )
  }

  /** `serverOperationImpls.patch.execute`, `lib/datastores-DqFH7RLd.js:2313`. */
  patch(patches: Rec[], initialDocument: Rec = {}): void {
    const patchMutation = patches.map((patch) => ({
      patch: {...patch, id: this.draftId},
    }))
    const mutate = (mutations: Rec[]): void => {
      this.draft.add(new Mutation({mutations}))
    }
    if (this.draft.LOCAL) {
      mutate([
        {patch: {unset: ['_empty_action_guard_pseudo_field_'], id: this.draftId}},
        ...patchMutation,
      ])
      return
    }
    const createMutation = this.published.LOCAL
      ? {
          createIfNotExists: prepareDoc(this.draftId, {
            ...initialDocument,
            ...this.published.LOCAL,
            _type: this.typeName,
          }),
        }
      : {
          create: prepareDoc(this.draftId, {
            ...initialDocument,
            _type: this.typeName,
          }),
        }
    mutate([createMutation])
    void this.draft.commit()
    mutate(patchMutation)
  }

  /** The throttled `commit` operation, `lib/datastores-DqFH7RLd.js:2472`. */
  async commitEdits(): Promise<void> {
    await this.draft.commit()
  }

  /**
   * `operationEvents`, `lib/datastores-DqFH7RLd.js:2455-2461`: the four
   * consistency-gated operations commit both buffers, wait for the pair to be
   * consistent, and only then `execute`.
   *
   * Resolves `{executed: false}` when the gate never opens — which is the
   * defect this file is about, and is why it does not simply throw.
   */
  async runGated(
    execute: () => Promise<unknown>,
    timeoutMs = 8000,
  ): Promise<{executed: boolean; result?: unknown}> {
    void this.published.commit()
    void this.draft.commit()
    const opened = await waitUntil(
      () => this.consistent.draft && this.consistent.published,
      timeoutMs,
    )
    if (!opened) return {executed: false}
    return {executed: true, result: await execute()}
  }
}

/* ═══════════════════════════════════════════════════════════════════ harness */

const roots: string[] = []
const running: Array<{close(): Promise<void>}> = []
const panes: Pane[] = []

afterEach(async () => {
  for (const pane of panes.splice(0)) pane.close()
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

const BASE_IDENTITY = {projectId: 'b1n03q3z', dataset: 'parity', apiVersion: '2025-02-19'}
const STUDIO_ORIGIN = 'http://localhost:3333'

function makeClock(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick * 1000).toISOString()
  }
}

/**
 * MODE 2. There is no base dataset at all: every read answers `null`, exactly
 * as `runOrigin.mjs` does with `OVERLAY_BASE=none`, so every document in the
 * branch is branch-CREATED. That is the configuration the E2E suite runs in and
 * the one in which the refusal is taken every single time.
 */
function baseClient(base: Record<string, Rec> = {}): Rec {
  const self: Rec = {
    escaped: [] as unknown[],
    /** How many snapshot fetches the pane has made. A resync must cause one. */
    snapshotFetches: 0,
    fetch: (): Promise<unknown> => Promise.resolve(null),
    getDocument: (id: string): Promise<unknown> => Promise.resolve(base[id] ?? undefined),
    getDocuments: (ids: readonly string[]): Promise<unknown> => {
      self.snapshotFetches = (self.snapshotFetches as number) + 1
      return Promise.resolve(ids.map((id) => base[id] ?? null))
    },
    listen: (): unknown => ({subscribe: () => ({unsubscribe: () => {}})}),
    config: () => ({projectId: 'b1n03q3z', dataset: 'parity', apiVersion: '2025-02-19'}),
    withConfig: (): unknown => self,
    clone: (): unknown => self,
    /* Nothing may reach these. A call is recorded rather than thrown so the
     * assertion reads as "the facade let a write escape", not as a crash. */
    action: (...args: unknown[]): never => {
      ;(self.escaped as unknown[]).push(['action', ...args])
      throw new Error('the real client.action was called — the facade let a write escape')
    },
    dataRequest: (...args: unknown[]): never => {
      ;(self.escaped as unknown[]).push(['dataRequest', ...args])
      throw new Error('the real client.dataRequest was called — the facade let a write escape')
    },
  }
  self.observable = {
    fetch: (): unknown => ({subscribe: (o: Rec) => {
      ;(o.next as (v: unknown) => void)?.(null)
      ;(o.complete as () => void)?.()
      return {unsubscribe: () => {}}
    }}),
    getDocuments: self.getDocuments,
    action: self.action,
    dataRequest: self.dataRequest,
  }
  return self
}

interface Session {
  root: string
  url: string
  runtime: OverlayRuntime
  client: Rec
  wrapped: Rec
  messages: string[]
  pane(publishedId: string, typeName?: string): Promise<Pane>
}

async function session(base: Record<string, Rec> = {}): Promise<Session> {
  const root = await mkdtemp(join(tmpdir(), 'studio-branch-created-'))
  roots.push(root)
  const server = await startOverlayApiServer({
    root,
    port: 0,
    overlayId: 'branch-created-consistency-0000',
    now: makeClock(),
    watchIntervalMs: 0,
    origins: [STUDIO_ORIGIN],
    base: BASE_IDENTITY,
  })
  running.push(server)

  const messages: string[] = []
  const client = baseClient(base)
  const runtime = createOverlayRuntime({
    resolved: resolveOverlayOptions({mode: 'fs', apiUrl: server.url, strictQueries: false}, {}),
    createClient: () => client,
    onLog: (message) => messages.push(message),
  })
  await runtime.refresh()
  const wrapped = runtime.clientFactory({}) as Rec

  return {
    root,
    url: server.url,
    runtime,
    client,
    wrapped,
    messages,
    async pane(publishedId, typeName = 'article') {
      const pane = new Pane(wrapped, publishedId, typeName)
      panes.push(pane)
      await pane.open()
      return pane
    },
  }
}

/**
 * THE INDEPENDENT ORACLE: a SECOND store, constructed after the fact over the
 * same bytes, read with no help from the API that wrote them.
 */
async function readFromDisk(root: string, logicalId: string): Promise<Rec | null> {
  const store = new FsOverlayStore({root, now: () => new Date().toISOString()})
  const manifest = await store.inspect()
  const read = await store.readDocumentByLogicalId(manifest.overlayId, logicalId)
  return (read?.record as unknown as Rec) ?? null
}

function localDraftValue(record: Rec | null, field: string): unknown {
  const local = (record?.local ?? {}) as Rec
  const draft = (local.draft ?? null) as Rec | null
  return draft === null ? undefined : ((draft.materialized as Rec | undefined) ?? {})[field]
}

function localPublishedValue(record: Rec | null, field: string): unknown {
  const local = (record?.local ?? {}) as Rec
  const published = (local.published ?? null) as Rec | null
  return published === null
    ? undefined
    : ((published.materialized as Rec | undefined) ?? {})[field]
}

/* ══════════════════════════════════════════════════════════════════ the tests */

describe('a branch-created document reaches consistency in @sanity/mutator', () => {
  it('the first edit of a document that exists nowhere upstream settles the pane', async () => {
    const app = await session()
    const pane = await app.pane('bc-first-edit')

    /* Both halves start missing: nothing in base, nothing in the branch. */
    expect(pane.draft.document.HEAD).toBeNull()
    expect(pane.published.document.HEAD).toBeNull()

    pane.patch([{set: {title: 'Branch created'}}])
    await pane.commitEdits()

    /* The bytes landed — proven from a second store, not from a return value.
     * Asserted FIRST, so a failure below is unambiguously the pane's state and
     * not a write that never happened. */
    const record = await waitForRecord(
      app.root,
      'bc-first-edit',
      (value) => localDraftValue(value, 'title') === 'Branch created',
    )
    expect(
      localDraftValue(record, 'title'),
      'the write must reach the overlay on disk before consistency is even a question',
    ).toBe('Branch created')

    await waitUntil(() => pane.consistent.draft, 6000)

    /* THE ASSERTION. `@sanity/mutator` decides this, not us. */
    expect(
      pane.consistent.draft,
      'the draft BufferedDocument never became consistent: the echo built no listener ' +
        'frame for a branch-created document, so `submitted` never emptied and every ' +
        'REQUIRES_CONSISTENCY action is unreachable',
    ).toBe(true)

    /* And nothing escaped to the real client on the way. */
    expect(app.client.escaped).toEqual([])
  })

  it('publish executes and moves the value onto the published layer', async () => {
    const app = await session()
    const pane = await app.pane('bc-publish')

    pane.patch([{set: {title: 'Ready to publish'}}])
    await pane.commitEdits()
    await waitUntil(() => pane.consistent.draft, 6000)

    /* `publish.execute`, `lib/datastores-DqFH7RLd.js:2371`. */
    const outcome = await pane.runGated(async () => {
      const draftSnapshot = pane.draft.LOCAL as Rec
      return firstValue(
        (
          (
            (pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
              .observable as Rec
          ).action as (...a: unknown[]) => unknown
        )(
          {
            actionType: 'sanity.action.document.publish',
            draftId: draftSnapshot._id,
            publishedId: pane.publishedId,
            ifPublishedRevisionId: (pane.published.LOCAL as Rec | null)?._rev,
          },
          {tag: 'document.publish'},
        ),
      )
    })

    expect(
      outcome.executed,
      'the consistency gate never opened, so sanity never called publish.execute',
    ).toBe(true)

    const record = await waitForRecord(app.root, 'bc-publish', (value) =>
      localPublishedValue(value, 'title') === 'Ready to publish',
    )
    expect(localPublishedValue(record, 'title')).toBe('Ready to publish')
  })

  it('delete tombstones the record and the pane learns the document is gone', async () => {
    const app = await session()
    const pane = await app.pane('bc-delete')

    pane.patch([{set: {title: 'To be deleted'}}])
    await pane.commitEdits()
    await waitUntil(() => pane.consistent.draft, 6000)

    /* `del.execute`, `lib/datastores-DqFH7RLd.js` — delete names the drafts it
     * knows about, which is what the echo turns into `disappear` frames. */
    const outcome = await pane.runGated(async () =>
      firstValue(
        (
          (
            (pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
              .observable as Rec
          ).action as (...a: unknown[]) => unknown
        )(
          {
            actionType: 'sanity.action.document.delete',
            publishedId: pane.publishedId,
            includeDrafts: [pane.draftId],
          },
          {tag: 'document.delete'},
        ),
      ),
    )

    expect(outcome.executed, 'the consistency gate never opened for delete').toBe(true)

    const record = await waitForRecord(app.root, 'bc-delete', (value) => {
      const local = (value?.local ?? {}) as Rec
      return local.draftTombstone === true || local.publishedTombstone === true
    })
    const local = (record?.local ?? {}) as Rec
    expect(local.draftTombstone === true || local.publishedTombstone === true).toBe(true)
  })

  it('discard removes the branch draft', async () => {
    const app = await session()
    const pane = await app.pane('bc-discard')

    pane.patch([{set: {title: 'Will be discarded'}}])
    await pane.commitEdits()
    await waitUntil(() => pane.consistent.draft, 6000)

    const outcome = await pane.runGated(async () =>
      firstValue(
        (
          (
            (pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
              .observable as Rec
          ).action as (...a: unknown[]) => unknown
        )(
          {actionType: 'sanity.action.document.discard', draftId: pane.draftId},
          {tag: 'document.discard-changes'},
        ),
      ),
    )

    expect(outcome.executed, 'the consistency gate never opened for discardChanges').toBe(true)

    const record = await waitForRecord(
      app.root,
      'bc-discard',
      (value) => localDraftValue(value, 'title') !== 'Will be discarded',
    )
    expect(localDraftValue(record, 'title')).not.toBe('Will be discarded')
  })
})

describe('the second symptom: a pane REOPENED on a branch document', () => {
  /**
   * THE `Saving…` FOREVER, IN ITS OTHER FORM.
   *
   * On reopen, `getDocuments` answers `null` from base and the read tap
   * substitutes the branch body — so the pane's HEAD carries a SYNTHETIC `_rev`
   * that the base read never mentioned. `Document.considerIncoming` then looks
   * for `previousRev === HEAD._rev` and the echo, which only ever learned the
   * raw base answer, omits `previousRev` entirely. Nothing chains, nothing is
   * ever applied, and the document is inconsistent for the life of the tab —
   * with the file on disk perfectly correct the whole time.
   */
  it('the pane HEAD carries the overlay revision, and the next edit chains off it', async () => {
    const app = await session()
    const first = await app.pane('bc-reopen')
    first.patch([{set: {title: 'First session'}}])
    await first.commitEdits()
    await waitUntil(() => first.consistent.draft, 6000)
    first.close()

    /* A fresh pane over the same client, exactly as a reload gives you. */
    const second = await app.pane('bc-reopen')

    const head = second.draft.document.HEAD
    expect(head, 'the reopened pane must be given the branch body, not base null').not.toBeNull()
    expect(
      typeof (head as Rec)._rev,
      'core stamps every materialized body with a synthetic _rev (§13.9); without one on ' +
        'HEAD, @sanity/mutator can never apply another mutation to this document',
    ).toBe('string')
    expect(app.runtime.echo.revisionOf('drafts.bc-reopen')).toBe((head as Rec)._rev)

    second.patch([{set: {title: 'Second session'}}])
    await second.commitEdits()
    await waitUntil(() => second.consistent.draft, 6000)

    const record = await waitForRecord(
      app.root,
      'bc-reopen',
      (value) => localDraftValue(value, 'title') === 'Second session',
    )
    expect(localDraftValue(record, 'title')).toBe('Second session')
    expect(
      second.consistent.draft,
      'a reopened branch document never settled: the echo chained off a revision the pane ' +
        'was never given',
    ).toBe(true)

    /* ONE frame per document per transaction. Two would both claim the same
     * `previousRev → resultRev` and only the first could ever apply. */
    const perTransaction = new Map<string, number>()
    for (const event of second.events) {
      if (event.type !== 'mutation') continue
      const key = `${String(event.transactionId)}#${String(event.documentId)}`
      perTransaction.set(key, (perTransaction.get(key) ?? 0) + 1)
    }
    expect(
      [...perTransaction.entries()].filter(([, count]) => count > 1),
      'the Content Lake emits at most one event per document per transaction, and a second ' +
        'one is permanently unappliable',
    ).toEqual([])
    expect(
      second.consistent.draft,
    ).toBe(true)
  })

  /**
   * The mirror image: the branch TOMBSTONED the address, so the pane is handed
   * `null` while the echo still remembers a revision. Only a create-shaped frame
   * can apply to a null HEAD, so the echo has to forget the revision too.
   */
  it('a tombstoned address resets the echo revision so a re-create can chain', async () => {
    const app = await session()
    const pane = await app.pane('bc-tombstone-reopen')
    pane.patch([{set: {title: 'Doomed'}}])
    await pane.commitEdits()
    await waitUntil(() => pane.consistent.draft, 6000)

    const deleted = await pane.runGated(async () =>
      firstValue(
        (
          ((pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
            .observable as Rec).action as (...a: unknown[]) => unknown
        )(
          {
            actionType: 'sanity.action.document.delete',
            publishedId: pane.publishedId,
            includeDrafts: [pane.draftId],
          },
          {tag: 'document.delete'},
        ),
      ),
    )
    expect(deleted.executed).toBe(true)
    await waitForRecord(app.root, 'bc-tombstone-reopen', (value) => {
      const local = (value?.local ?? {}) as Rec
      return local.draftTombstone === true
    })
    pane.close()

    /* `/state` is what a reloaded Studio learns the tombstone from. */
    await app.runtime.refresh()

    const reopened = await app.pane('bc-tombstone-reopen')
    expect(reopened.draft.document.HEAD, 'a tombstoned address must read as absent').toBeNull()
    expect(app.runtime.echo.revisionOf('drafts.bc-tombstone-reopen')).toBeUndefined()

    reopened.patch([{set: {title: 'Recreated'}}])
    await reopened.commitEdits()
    await waitUntil(() => reopened.consistent.draft, 6000)
    expect(
      reopened.consistent.draft,
      're-creating a tombstoned document never settled: the echo chained off the revision ' +
        'the deleted document used to have',
    ).toBe(true)
  })
})

describe('unpublish — the sixth §21.2 action, driven past the same gate', () => {
  it('executes and tombstones the published layer', async () => {
    const app = await session()
    const pane = await app.pane('bc-unpublish')

    pane.patch([{set: {title: 'To be unpublished'}}])
    await pane.commitEdits()
    await waitUntil(() => pane.consistent.draft, 6000)

    await pane.runGated(async () =>
      firstValue(
        (
          ((pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
            .observable as Rec).action as (...a: unknown[]) => unknown
        )(
          {
            actionType: 'sanity.action.document.publish',
            draftId: pane.draftId,
            publishedId: pane.publishedId,
          },
          {tag: 'document.publish'},
        ),
      ),
    )
    await waitForRecord(
      app.root,
      'bc-unpublish',
      (value) => localPublishedValue(value, 'title') === 'To be unpublished',
    )

    /* `unpublish.execute`, `lib/datastores-DqFH7RLd.js:2401`. */
    const outcome = await pane.runGated(async () =>
      firstValue(
        (
          ((pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
            .observable as Rec).action as (...a: unknown[]) => unknown
        )(
          {
            actionType: 'sanity.action.document.unpublish',
            draftId: pane.draftId,
            publishedId: pane.publishedId,
          },
          {tag: 'document.unpublish'},
        ),
      ),
    )

    expect(outcome.executed, 'the consistency gate never opened for unpublish').toBe(true)

    const record = await waitForRecord(app.root, 'bc-unpublish', (value) => {
      const local = (value?.local ?? {}) as Rec
      return local.publishedTombstone === true
    })
    const local = (record?.local ?? {}) as Rec
    expect(local.publishedTombstone).toBe(true)
    /* §39.2: unpublish is a TOMBSTONE. The record must survive, or the base
     * document reappears. */
    expect(record?.logicalId).toBe('bc-unpublish')
  })
})

describe('a write that CANNOT be echoed still does not hang the pane', () => {
  /**
   * THE RULE: an action the overlay cannot spell as a frame must refuse
   * VISIBLY, never sit at `Saving…`. Publishing a document the branch holds
   * nothing for is the reachable case — §18.5 plans a `copyFrom` and there is no
   * body to copy — so it is the one driven here, end to end, against the real
   * mutator.
   */
  it('says why, and asks the pane to re-read so it settles anyway', async () => {
    const app = await session()
    const pane = await app.pane('bc-unechoable')
    const fetchesBefore = app.client.snapshotFetches as number

    await firstValue(
      (
        ((pane.client.withConfig as (c: Rec) => Rec)({apiVersion: '2025-02-19'})
          .observable as Rec).action as (...a: unknown[]) => unknown
      )(
        {
          actionType: 'sanity.action.document.publish',
          draftId: pane.draftId,
          publishedId: pane.publishedId,
        },
        {tag: 'document.publish'},
      ),
    )

    /* The refusal reaches a human. */
    await waitUntil(() => app.messages.some((m) => /no known body/.test(m)), 6000)
    expect(app.messages.join(' | ')).toMatch(/no known body for drafts\.bc-unechoable/)

    /* …AND the pane was told to re-read, on sanity's own `reset` channel. */
    await waitUntil(() => pane.events.some((event) => event.type === 'reset'), 6000)
    const reset = pane.events.find((event) => event.type === 'reset') as Rec
    expect(reset.documentIds).toContain('bc-unechoable')
    expect(app.messages.join(' | ')).toMatch(/re-read/)

    /*
     * And the recovery really RAN. Counted at the client, not inferred from the
     * pane's own flag: `getPairListener` answers a `reset` with
     * `fetchInitialDocumentSnapshots()`, so a second snapshot fetch is the
     * observable proof that the pane rebuilt itself from the overlay rather than
     * sitting on a stale model.
     */
    expect(
      await waitUntil(() => (app.client.snapshotFetches as number) > fetchesBefore, 6000),
      'the reset did not make the pane re-read; it would still be holding a transaction ' +
        'nothing will ever answer',
    ).toBe(true)
    expect(await waitUntil(() => pane.consistent.draft && pane.consistent.published, 6000)).toBe(
      true,
    )

    /* Nothing reached Sanity on the way. */
    expect(app.client.escaped).toEqual([])
  })
})

async function waitForRecord(
  root: string,
  logicalId: string,
  predicate: (record: Rec | null) => boolean,
  timeoutMs = 8000,
): Promise<Rec | null> {
  const deadline = Date.now() + timeoutMs
  let last: Rec | null = null
  while (Date.now() < deadline) {
    last = await readFromDisk(root, logicalId)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return last
}
