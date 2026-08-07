/**
 * The overlay runtime — one per workspace.
 *
 * Holds the pieces that must be shared between the client factory (which
 * intercepts writes) and the status banner (which reports what happened to
 * them): the echo protocol, the transport, the write ledger, and the derived
 * §21.3 status.
 *
 * Pure apart from an injected `fetch`: no React, no DOM, no globals. The banner
 * component subscribes to {@link OverlayRuntime.subscribe} and renders
 * {@link OverlayRuntime.status}; it derives nothing itself.
 */

import {createOverlayEcho, type OverlayEcho} from './client/echo'
import {seedOverlayDocuments, wrapWithOverlay, type OverlayWriteRecord} from './client/facade'
import {createStudioReader, type StudioReadRecord} from './client/reads'
import {overlaySourceFromBranch} from './client/readSource'
import {
  createOverlayTransport,
  type OverlayHydrationDocument,
  type OverlayTransport,
} from './client/transport'
import {readConflictReport, type OverlayConflictReport} from './conflicts'
import type {ResolvedOverlayOptions} from './options'
import {deriveOverlayStatus, type OverlayStatus} from './status'

type Rec = Record<string, unknown>

export interface OverlayRuntimeOptions {
  resolved: ResolvedOverlayOptions
  fetch?: typeof fetch
  /**
   * Injected `createClient`. The Studio's own `@sanity/client` is the default in
   * the shipped entry point; tests pass a stub so nothing touches the network.
   */
  createClient: (options: Rec) => object
  now?: () => number
  onLog?: (message: string) => void
}

export interface OverlayRuntime {
  readonly resolved: ResolvedOverlayOptions
  readonly echo: OverlayEcho
  readonly transport: OverlayTransport
  /** The `unstable_clientFactory` this runtime installs. */
  clientFactory(options: Rec): object
  status(): OverlayStatus
  conflicts(): OverlayConflictReport
  /** Recent messages, newest last, for the banner's detail view. */
  messages(): readonly string[]
  /**
   * Every GROQ read this session routed, newest last (PRD §22.8).
   *
   * The diagnostic surface §22.5 requires: a read recorded as `passthrough` was
   * answered by the base dataset and may not reflect branch edits, and the only
   * way an editor can know that is if something keeps the list.
   */
  reads(): readonly StudioReadRecord[]
  /**
   * What the READ path believes the branch holds, right now.
   *
   * "Is the branch even loaded?" is the first question in every diagnosis of a
   * pane showing base content, and until this existed the only way to answer it
   * was to re-derive `overlaySourceFromBranch` by hand from a `/state` response
   * fetched separately. Addresses, not bodies: the question is membership.
   */
  branch(): OverlayBranchView
  /**
   * The branch inventory, as the overlay API last described it.
   *
   * {@link OverlayRuntime.branch} answers "which addresses does the branch own?"
   * — membership, for diagnosis. This answers "what does it hold?", which is
   * what `planRebase` and `planCheckpoint` read: they need each document's
   * `schemaType`, `runtimeRevision` and conflict flag to say what a rebase would
   * discard. Fed by the same `/state` and commit-hydration answers as `branch()`
   * so the two cannot disagree.
   */
  documents(): readonly OverlayHydrationDocument[]
  /**
   * The CURRENT BASE for a set of logical ids, as this session actually read it.
   *
   * §17 recomputes the merge against the base as it stands now, and §16.1 keeps
   * base fetching out of core and out of the overlay API — the Studio holds the
   * only Sanity credential in the topology, so it is the only party that can
   * state it. The source is the echo's revision store, which records the raw
   * base body of the one authoritative read Studio performs (the pair listener's
   * `getDocuments` snapshot) BEFORE the overlay substitutes anything into it.
   *
   * A document this session has never opened yields NOTHING, deliberately. An
   * empty answer is what makes the rebase action disable itself with a reason
   * instead of asking the API to rebase against an ancestor nobody checked.
   */
  baseDocuments(logicalIds: readonly string[]): Rec[]
  subscribe(listener: () => void): () => void
  /** Poll the overlay API once, updating connection, revision and conflicts. */
  refresh(): Promise<void>
}

/** The branch as the read path sees it — {@link OverlayRuntime.branch}. */
export interface OverlayBranchView {
  /** Raw addresses (`drafts.x`, `x`) the branch owns a body for, sorted. */
  documents: string[]
  /** Raw addresses the branch has suppressed, sorted. */
  tombstones: string[]
  /** Raw addresses the overlay API reported a conflict on, sorted. */
  conflicts: string[]
  /** The overlay revision `/state` last reported, or `undefined` if never read. */
  revision: number | undefined
  connection: 'ok' | 'unreachable'
}

const MAX_MESSAGES = 50
/** The read ledger is a diagnostic, not a log: bounded, newest kept. */
const MAX_READ_RECORDS = 200

export function createOverlayRuntime(options: OverlayRuntimeOptions): OverlayRuntime {
  const {resolved} = options
  const listeners = new Set<() => void>()
  const messages: string[] = []

  let connection: 'ok' | 'unreachable' = 'ok'
  let revision: number | undefined
  let conflictReport: OverlayConflictReport = readConflictReport(undefined)
  let pendingWrites = 0
  let degradedWrites = 0
  let uncheckpointedEdits = 0
  let identityMismatch = false

  function notify(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        /* A subscriber that throws must not stop the others being told. */
      }
    }
  }

  function log(message: string): void {
    messages.push(message)
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES)
    options.onLog?.(message)
    notify()
  }

  for (const warning of resolved.warnings) log(warning)

  const echo = createOverlayEcho({onError: log})

  /* ---------------------------------------------------------------- *
   * The branch, as the READ path needs it.
   *
   * Keyed by logical id and fed from the two places the overlay API states
   * what it holds: `GET /state` on every refresh, and the hydration documents
   * every `POST /commit` answers with. Both speak `OverlayHydrationDocument`,
   * so the read view and the write echo agree by construction rather than by a
   * second translation that could drift.
   *
   * The echo's own document map is NOT this, and the two answer different
   * questions: this one answers GROQ (membership plus bodies, projected through
   * the caller's query), the echo's answers document-BY-ID. `noteHydration`
   * feeds both from the same array, because feeding only one is exactly how the
   * list pane and the edit form came to disagree.
   *
   * The echo stores `null` as a deletion of its own entry — "the branch has no
   * opinion, use base" — so a TOMBSTONE cannot be spelled that way; it travels
   * on `setOverlaySuppressed` instead. Reading the two as the same thing is what
   * made a deleted document reappear.
   * ---------------------------------------------------------------- */
  const hydration = new Map<string, OverlayHydrationDocument>()
  let overlayView = overlaySourceFromBranch([])
  let overlayViewStale = false

  function noteHydration(documents: readonly OverlayHydrationDocument[]): void {
    let changed = false
    for (const document of documents) {
      if (typeof document?.logicalId !== 'string' || document.logicalId === '') continue
      hydration.set(document.logicalId, document)
      changed = true
    }
    if (!changed) return
    overlayViewStale = true
    /* THE SECOND READ PATH. `overlaySource()` above answers GROQ — the list
     * panes, previews, reference inputs. The document pair listener does NOT go
     * through GROQ: sanity 6.8.0 fetches the form's opening value with
     * `client.observable.getDocuments([publishedId, draftId])`
     * (`lib/datastores-DqFH7RLd.js:1720`), which the facade answers from the
     * ECHO's overlay-document map. Feeding only one of the two is how the list
     * pane and the edit form came to disagree about the same document, with the
     * form showing base content the editor then unknowingly merged against. */
    seedOverlayDocuments(echo, documents)
  }

  function overlaySource(): ReturnType<typeof overlaySourceFromBranch> {
    if (overlayViewStale) {
      overlayView = overlaySourceFromBranch([...hydration.values()])
      overlayViewStale = false
    }
    return overlayView
  }

  const readRecords: StudioReadRecord[] = []

  const reads = createStudioReader({
    overlay: overlaySource,
    strict: () => resolved.strictQueries,
    onLog: log,
    onRecord: (record) => {
      readRecords.push(record)
      if (readRecords.length > MAX_READ_RECORDS) {
        readRecords.splice(0, readRecords.length - MAX_READ_RECORDS)
      }
    },
  })

  const transport = createOverlayTransport({
    apiUrl: resolved.apiUrl,
    fetch: options.fetch,
    onError: (message) => {
      connection = 'unreachable'
      log(message)
    },
    onAuthFailure: (failure) => echo.noteAuthFailure(failure),
  })

  function onWrite(record: OverlayWriteRecord): void {
    if (record.committed === 'ok') {
      connection = 'ok'
      /* §29.6: every accepted write is an edit the checkpoint has not seen. */
      uncheckpointedEdits += 1
    }
    if (record.committed === 'degraded') degradedWrites += 1
    if (pendingWrites > 0) pendingWrites -= 1
    notify()
  }

  function clientFactory(clientOptions: Rec): object {
    const withHost =
      resolved.apiHost === null ? clientOptions : {...clientOptions, apiHost: resolved.apiHost}
    const real = options.createClient(withHost)
    if (!resolved.enabled) return real
    return wrapWithOverlay(real, {
      echo,
      transport,
      onError: log,
      onWrite,
      reads,
      onHydration: noteHydration,
      now: options.now,
    })
  }

  async function refresh(): Promise<void> {
    const result = await transport.state()
    if (result.outcome === 'ok') {
      connection = 'ok'
      revision = result.revision
      if (
        resolved.overlayId !== null &&
        result.overlayId !== undefined &&
        result.overlayId !== resolved.overlayId
      ) {
        /* §21.3 "Overlay identity mismatch: Fatal screen. No reads or writes." */
        identityMismatch = true
        log(
          `[sanity-overlay-studio] the overlay API reports overlay "${result.overlayId}" but ` +
            `this Studio is configured for "${resolved.overlayId}". Editing is stopped.`,
        )
      }
      conflictReport = readConflictReport(result.body)
      /* The branch the read path answers over. Merged rather than replaced, so
       * a `/state` answer that omits a document this session just committed
       * cannot un-do the commit's own hydration. */
      if (result.documents !== undefined) noteHydration(result.documents)
    } else if (result.outcome === 'degraded') {
      connection = 'unreachable'
    }
    notify()
  }

  return {
    resolved,
    echo,
    transport,
    clientFactory,
    status: () =>
      deriveOverlayStatus({
        enabled: resolved.enabled,
        expectedEnabled: resolved.enabled,
        mode: resolved.mode,
        apiUrl: resolved.apiUrl,
        overlayId: resolved.overlayId,
        connection,
        session: echo.sessionState(),
        revision,
        pendingWrites,
        degradedWrites,
        uncheckpointedEdits,
        conflicts: {hard: conflictReport.summary.hard, soft: conflictReport.summary.soft},
        identityMismatch,
      }),
    conflicts: () => conflictReport,
    messages: () => messages.slice(),
    reads: () => readRecords.slice(),
    /* Sorted by logical id, so a document action's confirmation message lists
     * the same documents in the same order on every render. */
    documents: () =>
      [...hydration.values()].sort((left, right) =>
        left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0,
      ),
    baseDocuments: (logicalIds) => {
      const out: Rec[] = []
      const seen = new Set<string>()
      for (const logicalId of logicalIds) {
        /* Both addresses: §17.1's ancestor may be the base PUBLISHED snapshot
         * even when the branch edit lives on the draft. */
        for (const address of [logicalId, `drafts.${logicalId}`]) {
          if (seen.has(address)) continue
          seen.add(address)
          const docState = echo.getDocState(address)
          /* `synthetic` marks a revision this overlay minted (§13.9). Sending one
           * back as "the current base" would make the overlay its own ancestor. */
          if (docState?.doc !== undefined && docState.synthetic !== true) {
            out.push(docState.doc as Rec)
          }
        }
      }
      return out
    },
    branch: () => {
      const view = overlaySource()
      return {
        documents: [...view.documents.keys()].sort(),
        tombstones: [...view.tombstones].sort(),
        conflicts: [...(view.conflicts ?? [])].sort(),
        revision,
        connection,
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
  }
}

/* ------------------------------------------------------------------ *
 * The workspace registry
 * ------------------------------------------------------------------ *
 *
 * The client factory and the banner are wired into the Studio through two
 * unrelated seams — `unstable_clientFactory` on the workspace and a layout
 * component inside a plugin — and neither can pass a value to the other. The
 * registry is the seam between them, keyed by workspace name so a
 * multi-workspace config does not cross wires.
 */

const registry = new Map<string, OverlayRuntime>()

export function registerOverlayRuntime(workspace: string, runtime: OverlayRuntime): void {
  registry.set(workspace, runtime)
}

export function getOverlayRuntime(workspace: string): OverlayRuntime | undefined {
  return registry.get(workspace) ?? registry.get('*')
}

export function clearOverlayRuntimes(): void {
  registry.clear()
}
