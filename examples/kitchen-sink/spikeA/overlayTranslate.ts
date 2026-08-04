// SPIKE A — browser → overlay-store translation (PRD §13.6, §13.7, §36.1).
//
// This is the ONLY piece of the write path that is a pure function, and that is
// deliberate: `localEcho.ts` cannot be unit tested (it needs a live Studio, an
// rxjs constructor captured off a real client, and a document pane), but the
// question "does an intercepted Studio write become the right overlay mutation?"
// is pure data-in / data-out. It is therefore extracted here and pinned by
// `packages/sanity-overlay-testkit/test/overlay-server.test.ts`.
//
// The module is imported from three very different runtimes, so it must stay
// dependency-free (no `@sanity/client`, no `sanity-overlay-core`, no `node:*`):
//
//   - the browser, through `localEcho.ts` (Vite),
//   - plain Node, through `overlayServer.mjs` (type stripping),
//   - vitest, through the testkit.
//
// The output shape is structurally the PRD §13.7 `OverlayMutation` /
// `OverlayOperation` union from `sanity-overlay-core`. It is re-declared rather
// than imported for the reason above; `overlayServer.mjs` hands the result
// straight to core's `applyTransaction`, so any drift fails there loudly.

/* ------------------------------------------------------------------ types */

/** PRD §13.6 — an overlay path segment. */
export type OverlayPathSegment = string | number | {_key: string}
export type OverlayPath = OverlayPathSegment[]

/** PRD §13.7 — patch-level operations. */
export type TranslatedOperation =
  | {type: 'set'; path: OverlayPath; value: unknown}
  | {type: 'setIfMissing'; path: OverlayPath; value: unknown}
  | {type: 'unset'; path: OverlayPath}
  | {type: 'insert'; path: OverlayPath; position: 'before' | 'after' | 'replace'; items: unknown[]}
  | {type: 'inc'; path: OverlayPath; amount: number}
  | {type: 'dec'; path: OverlayPath; amount: number}
  | {type: 'diffMatchPatch'; path: OverlayPath; patch: string}

/** PRD §13.7 — document-level mutation envelope. */
export type TranslatedMutation =
  | {type: 'create'; document: Record<string, unknown>}
  | {type: 'createIfNotExists'; document: Record<string, unknown>}
  | {type: 'createOrReplace'; document: Record<string, unknown>}
  | {type: 'delete'; id: string}
  | {type: 'patch'; id: string; operations: TranslatedOperation[]}

export interface TranslationResult {
  mutations: TranslatedMutation[]
  /**
   * Perspective-qualified document IDs the write targets, in first-seen order.
   * The echo layer uses these to decide which base documents to ship along, so
   * the server can capture a merge ancestor on first touch (PRD §13.3).
   */
  documentIds: string[]
  /**
   * Human-readable reasons a part of the write was NOT translated. Never empty
   * *and* silent: the caller is expected to surface every entry. A dropped write
   * that nobody reports is exactly the failure mode this spike exists to avoid.
   */
  unsupported: string[]
}

export interface InterceptedWrite {
  /** `actions` = Actions API payload; `mutations` = raw `/data/mutate` body. */
  kind: 'actions' | 'mutations'
  /** The intercepted array (or a single entry, which is normalized to one). */
  payload: unknown
}

type Rec = Record<string, unknown>

/**
 * Studio prepends an unset of this pseudo field so an otherwise empty edit
 * action still forms a legal patch. It is a transport artifact, not content, and
 * must never reach the overlay — it would show up as a touched path and an
 * `unset` in the reviewer-facing `intent.json` (PRD §14.2).
 */
export const GUARD_PSEUDO_FIELD = '_empty_action_guard_pseudo_field_'

/**
 * Patch keys that carry no operation.
 *
 * `ifRevisionID` is dropped on purpose: the overlay stamps synthetic revisions
 * (PRD §13.9) that live in a different revision space from Content Lake, so a
 * Content Lake precondition can only ever fail here. Preconditions against the
 * overlay's own revisions are a §25.5 concern for the real write path.
 */
const IGNORED_PATCH_KEYS = new Set(['id', 'ifRevisionID', 'ifRevisionId', 'unsetIsEmpty', 'purge'])

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRec(payload) && Array.isArray(payload.mutations)) return payload.mutations
  if (isRec(payload) && Array.isArray(payload.actions)) return payload.actions
  if (payload === undefined || payload === null) return []
  return [payload]
}

/* -------------------------------------------------------------- path parsing */

/**
 * Parse a Sanity patch path (`body[_key=="a"].children[0].text`) into a PRD §13.6
 * overlay path.
 *
 * Only the accessors Studio actually emits are supported — named fields, numeric
 * indexes (including the `-1` append anchor) and `_key` predicates. Anything else
 * (`[]`, slices, filters) throws, and the caller records it in `unsupported`
 * rather than guessing at semantics.
 */
export function parseSanityPath(path: string): OverlayPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('a patch path must be a non-empty string')
  }
  const segments: OverlayPath = []
  let index = 0

  while (index < path.length) {
    const char = path[index]

    if (char === '.') {
      index += 1
      continue
    }

    if (char === '[') {
      const end = path.indexOf(']', index)
      if (end === -1) throw new Error(`unbalanced "[" in path ${JSON.stringify(path)}`)
      const inner = path.slice(index + 1, end).trim()
      index = end + 1

      const keyed = /^_key\s*==\s*(['"])([\s\S]*)\1$/.exec(inner)
      if (keyed) {
        segments.push({_key: keyed[2]!})
        continue
      }
      if (/^-?\d+$/.test(inner)) {
        segments.push(Number(inner))
        continue
      }
      throw new Error(`unsupported path accessor [${inner}] in ${JSON.stringify(path)}`)
    }

    let cursor = index
    while (cursor < path.length && path[cursor] !== '.' && path[cursor] !== '[') cursor += 1
    const field = path.slice(index, cursor)
    if (field.length === 0) throw new Error(`empty segment in path ${JSON.stringify(path)}`)
    segments.push(field)
    index = cursor
  }

  if (segments.length === 0) throw new Error(`empty path ${JSON.stringify(path)}`)
  return segments
}

/**
 * A path is dropped when it addresses the empty-action guard pseudo field.
 *
 * Matched on the ROOT segment, not on the whole path: the field is a transport
 * artifact of Studio's Actions API, so anything rooted at it is equally an
 * artifact and equally must not reach `intent.json`.
 */
function isGuardPath(path: OverlayPath): boolean {
  return path[0] === GUARD_PSEUDO_FIELD
}

/* ------------------------------------------------------------ patch → ops */

/**
 * Translate one Sanity patch body into ordered operations.
 *
 * The emission order mirrors Content Lake's documented apply order
 * (`setIfMissing`, `unset`, `set`, `inc`/`dec`, `insert`, `diffMatchPatch`) so a
 * patch that mixes operations lands the same way locally as it would remotely.
 * `applyOperations` in core is order-sensitive, so this is behaviour, not style.
 */
function operationsFromPatch(patch: Rec, unsupported: string[]): TranslatedOperation[] {
  const operations: TranslatedOperation[] = []

  const valueEntries = (
    key: 'setIfMissing' | 'set' | 'inc' | 'dec' | 'diffMatchPatch',
  ): Array<[string, unknown]> => {
    const value = patch[key]
    return isRec(value) ? Object.entries(value) : []
  }

  const push = (
    key: string,
    rawPath: string,
    build: (path: OverlayPath) => TranslatedOperation | null,
  ): void => {
    let path: OverlayPath
    try {
      path = parseSanityPath(rawPath)
    } catch (error) {
      unsupported.push(`patch.${key}: ${(error as Error).message}`)
      return
    }
    if (isGuardPath(path)) return
    const operation = build(path)
    if (operation !== null) operations.push(operation)
  }

  for (const [rawPath, value] of valueEntries('setIfMissing')) {
    push('setIfMissing', rawPath, (path) => ({type: 'setIfMissing', path, value}))
  }

  const unset = patch.unset
  if (Array.isArray(unset)) {
    for (const rawPath of unset) {
      if (typeof rawPath !== 'string') {
        unsupported.push('patch.unset entries must be path strings')
        continue
      }
      push('unset', rawPath, (path) => ({type: 'unset', path}))
    }
  } else if (unset !== undefined) {
    unsupported.push('patch.unset must be an array of path strings')
  }

  for (const [rawPath, value] of valueEntries('set')) {
    push('set', rawPath, (path) => ({type: 'set', path, value}))
  }

  for (const [rawPath, amount] of valueEntries('inc')) {
    push('inc', rawPath, (path) =>
      typeof amount === 'number'
        ? {type: 'inc', path, amount}
        : (unsupported.push(`patch.inc.${rawPath} must be a number`), null),
    )
  }

  for (const [rawPath, amount] of valueEntries('dec')) {
    push('dec', rawPath, (path) =>
      typeof amount === 'number'
        ? {type: 'dec', path, amount}
        : (unsupported.push(`patch.dec.${rawPath} must be a number`), null),
    )
  }

  const insert = patch.insert
  if (isRec(insert)) {
    const position = (['before', 'after', 'replace'] as const).find(
      (candidate) => typeof insert[candidate] === 'string',
    )
    const items = insert.items
    if (position === undefined) {
      unsupported.push('patch.insert requires a before/after/replace anchor path')
    } else if (!Array.isArray(items)) {
      unsupported.push('patch.insert requires an `items` array')
    } else {
      push('insert', insert[position] as string, (path) => ({
        type: 'insert',
        path,
        position,
        items,
      }))
    }
  } else if (insert !== undefined) {
    unsupported.push('patch.insert must be an object')
  }

  for (const [rawPath, value] of valueEntries('diffMatchPatch')) {
    push('diffMatchPatch', rawPath, (path) =>
      typeof value === 'string'
        ? {type: 'diffMatchPatch', path, patch: value}
        : (unsupported.push(`patch.diffMatchPatch.${rawPath} must be a string`), null),
    )
  }

  for (const key of Object.keys(patch)) {
    if (IGNORED_PATCH_KEYS.has(key)) continue
    if (
      ['set', 'setIfMissing', 'unset', 'insert', 'inc', 'dec', 'diffMatchPatch'].includes(key)
    ) {
      continue
    }
    unsupported.push(`unsupported patch key ${JSON.stringify(key)}`)
  }

  return operations
}

/* ------------------------------------------------------- collector plumbing */

class Collector {
  readonly mutations: TranslatedMutation[] = []
  readonly documentIds: string[] = []
  readonly unsupported: string[] = []

  target(id: unknown): string | null {
    if (typeof id !== 'string' || id.length === 0) return null
    if (!this.documentIds.includes(id)) this.documentIds.push(id)
    return id
  }

  patch(id: string, patch: Rec): void {
    const operations = operationsFromPatch(patch, this.unsupported)
    /* An all-guard patch collapses to nothing. Emitting a zero-operation patch
     * would still bump the overlay revision and rewrite intent.json for no
     * semantic change, which breaks the §14.3 "diff shows semantic change only"
     * rule. */
    if (operations.length === 0) return
    this.mutations.push({type: 'patch', id, operations})
  }

  result(): TranslationResult {
    return {
      mutations: this.mutations,
      documentIds: this.documentIds,
      unsupported: this.unsupported,
    }
  }
}

/* ------------------------------------------------------ raw mutate payloads */

const CREATE_KEYS = ['create', 'createIfNotExists', 'createOrReplace'] as const

/** Studio's live-edit path: `dataRequest('mutate', {mutations, transactionId})`. */
export function translateMutations(payload: unknown): TranslationResult {
  const collector = new Collector()

  for (const entry of asArray(payload)) {
    if (!isRec(entry)) {
      collector.unsupported.push('a mutation must be an object')
      continue
    }

    const createKey = CREATE_KEYS.find((key) => entry[key] !== undefined)
    if (createKey !== undefined) {
      const document = entry[createKey]
      if (!isRec(document) || typeof document._id !== 'string') {
        collector.unsupported.push(`${createKey} requires a document with an _id`)
        continue
      }
      if (typeof document._type !== 'string') {
        collector.unsupported.push(`${createKey} requires a document with a _type (PRD §13.9)`)
        continue
      }
      collector.target(document._id)
      collector.mutations.push({type: createKey, document})
      continue
    }

    if (entry.delete !== undefined) {
      const body = entry.delete
      const id = isRec(body) ? body.id : undefined
      const target = collector.target(id)
      if (target === null) {
        collector.unsupported.push('delete by query is not supported by the overlay')
        continue
      }
      collector.mutations.push({type: 'delete', id: target})
      continue
    }

    if (entry.patch !== undefined) {
      const body = entry.patch
      if (!isRec(body)) {
        collector.unsupported.push('patch must be an object')
        continue
      }
      const target = collector.target(body.id)
      if (target === null) {
        collector.unsupported.push('patch by query is not supported by the overlay')
        continue
      }
      collector.patch(target, body)
      continue
    }

    collector.unsupported.push(
      `unsupported mutation shape {${Object.keys(entry).slice(0, 4).join(',')}}`,
    )
  }

  return collector.result()
}

/* ---------------------------------------------------------- Actions API */

const EDIT_ACTIONS = new Set([
  'sanity.action.document.edit',
  'sanity.action.document.version.replace',
])

/** Studio's autosave path: `client.observable.action(actions, {transactionId})`. */
export function translateActions(payload: unknown): TranslationResult {
  const collector = new Collector()

  for (const entry of asArray(payload)) {
    if (!isRec(entry)) {
      collector.unsupported.push('an action must be an object')
      continue
    }
    const actionType = typeof entry.actionType === 'string' ? entry.actionType : '<unknown>'
    const draftId = typeof entry.draftId === 'string' ? entry.draftId : undefined
    const publishedId = typeof entry.publishedId === 'string' ? entry.publishedId : undefined
    const versionId = typeof entry.versionId === 'string' ? entry.versionId : undefined

    if (EDIT_ACTIONS.has(actionType)) {
      const target = collector.target(versionId ?? draftId ?? publishedId)
      if (target === null) {
        collector.unsupported.push(`${actionType}: no target document id`)
        continue
      }
      if (!isRec(entry.patch)) {
        collector.unsupported.push(`${actionType}: no patch body`)
        continue
      }
      collector.patch(target, entry.patch)
      continue
    }

    if (actionType === 'sanity.action.document.create') {
      const attributes = entry.attributes
      if (!isRec(attributes) || typeof attributes._id !== 'string') {
        collector.unsupported.push(`${actionType}: no \`attributes\` document`)
        continue
      }
      if (typeof attributes._type !== 'string') {
        collector.unsupported.push(`${actionType}: attributes require a _type (PRD §13.9)`)
        continue
      }
      collector.target(attributes._id)
      collector.mutations.push({
        /* `ifExists: 'ignore'` is the Actions API spelling of createIfNotExists. */
        type: entry.ifExists === 'ignore' ? 'createIfNotExists' : 'create',
        document: attributes,
      })
      continue
    }

    if (actionType === 'sanity.action.document.delete') {
      /* PRD §18.8 — a `delete` mutation tombstones both perspectives at once, so
       * it is keyed on the logical (published) ID. */
      const target = collector.target(publishedId ?? draftId ?? versionId)
      if (target === null) {
        collector.unsupported.push(`${actionType}: no target document id`)
        continue
      }
      collector.mutations.push({type: 'delete', id: target})
      continue
    }

    /* publish / unpublish / discard / release actions are multi-document state
     * transitions, not mutations: `publish` needs the draft body promoted onto
     * the published perspective and the draft tombstoned in one transaction, and
     * `discard` tombstones only the draft (PRD §18.5-§18.7). Core models them as
     * document *actions*; wiring those through this spike would mean echoing a
     * two-document listener frame back to Studio, which `localEcho.ts` also does
     * not do. Reported, never silently dropped. */
    collector.unsupported.push(
      `${actionType} is a document action, not a mutation — not persisted by the spike overlay`,
    )
  }

  return collector.result()
}

/* ------------------------------------------------- document actions (§18) */
//
// `translateActions` above answers "which §13.7 *mutation* is this write?", and
// deliberately keeps answering "none" for publish/unpublish/discard/restore —
// those are §18.4-§18.9 document *actions*, which core models as reducers over
// overlay state rather than as mutations. This second translator answers the
// other half of the question: "which core reducer, with which arguments?".
//
// The two are kept apart on purpose. A mutation is replayable data; an action is
// a state transition whose result depends on what the overlay currently holds
// (publish promotes whatever the draft resolves to *now*). Collapsing them would
// mean re-deriving §18 semantics here, which is exactly what core exists for.

/** One core §18.4-§18.9 reducer call, named by the reducer it dispatches to. */
export type DocumentActionStep =
  | {type: 'publish'; id: string}
  | {type: 'unpublish'; id: string}
  | {type: 'discardDraft'; id: string}
  | {type: 'delete'; id: string}
  | {type: 'duplicate'; id: string; newId: string}
  | {
      type: 'restore'
      id: string
      target: 'draft' | 'published' | 'both'
      document?: Record<string, unknown>
    }

export interface DocumentActionTranslation {
  steps: DocumentActionStep[]
  /** Logical document IDs the actions touch, in first-seen order. */
  documentIds: string[]
  unsupported: string[]
}

/** `drafts.x` / `versions.r.x` → `x`. Actions are keyed on the logical ID. */
function toLogicalId(id: string): string {
  if (id.startsWith('drafts.')) return id.slice('drafts.'.length)
  const version = /^versions\.[^.]+\.(.+)$/.exec(id)
  return version ? version[1]! : id
}

/**
 * The overlay's own spelling of §18.9 duplicate.
 *
 * Studio never sends one: its duplicate is a tagged `client.create`. The echo
 * layer synthesises this action once it has identified the source document, so
 * that the overlay runs core's `duplicate` (new logical ID, base revision
 * metadata removed, transforms applied) instead of a bare create.
 */
export const DUPLICATE_ACTION_TYPE = 'sanity.overlay.document.duplicate'

export function translateDocumentActions(payload: unknown): DocumentActionTranslation {
  const steps: DocumentActionStep[] = []
  const documentIds: string[] = []
  const unsupported: string[] = []

  const target = (id: unknown): string | null => {
    if (typeof id !== 'string' || id.length === 0) return null
    const logical = toLogicalId(id)
    if (!documentIds.includes(logical)) documentIds.push(logical)
    return logical
  }

  for (const entry of asArray(payload)) {
    if (!isRec(entry)) {
      unsupported.push('a document action must be an object')
      continue
    }
    const actionType = typeof entry.actionType === 'string' ? entry.actionType : '<unknown>'
    const draftId = typeof entry.draftId === 'string' ? entry.draftId : undefined
    const publishedId = typeof entry.publishedId === 'string' ? entry.publishedId : undefined
    const versionId = typeof entry.versionId === 'string' ? entry.versionId : undefined

    if (actionType === 'sanity.action.document.publish') {
      const id = target(publishedId ?? draftId)
      if (id === null) unsupported.push(`${actionType}: no target document id`)
      else steps.push({type: 'publish', id})
      continue
    }

    if (actionType === 'sanity.action.document.unpublish') {
      const id = target(publishedId ?? draftId)
      if (id === null) unsupported.push(`${actionType}: no target document id`)
      else steps.push({type: 'unpublish', id})
      continue
    }

    if (
      actionType === 'sanity.action.document.discard' ||
      actionType === 'sanity.action.document.version.discard'
    ) {
      const id = target(versionId ?? draftId ?? publishedId)
      if (id === null) unsupported.push(`${actionType}: no target document id`)
      else steps.push({type: 'discardDraft', id})
      continue
    }

    if (actionType === 'sanity.action.document.delete') {
      const id = target(publishedId ?? draftId ?? versionId)
      if (id === null) unsupported.push(`${actionType}: no target document id`)
      else steps.push({type: 'delete', id})
      continue
    }

    if (actionType === 'sanity.action.document.replaceDraft') {
      const id = target(publishedId ?? draftId)
      const attributes = entry.attributes
      if (id === null) {
        unsupported.push(`${actionType}: no target document id`)
        continue
      }
      if (!isRec(attributes) || typeof attributes._type !== 'string') {
        unsupported.push(`${actionType}: requires an \`attributes\` document with a _type`)
        continue
      }
      /* §18.8 explicit restore: clear the draft tombstone, then write the body
       * the user chose to come back to. Both halves are core calls. */
      steps.push({
        type: 'restore',
        id,
        target: 'draft',
        document: {...attributes, _id: typeof attributes._id === 'string' ? attributes._id : `drafts.${id}`},
      })
      continue
    }

    if (actionType === DUPLICATE_ACTION_TYPE) {
      const id = target(publishedId)
      const newId = typeof entry.newId === 'string' ? toLogicalId(entry.newId) : undefined
      if (id === null || newId === undefined || newId.length === 0) {
        unsupported.push(`${actionType}: requires \`publishedId\` and \`newId\``)
        continue
      }
      if (!documentIds.includes(newId)) documentIds.push(newId)
      steps.push({type: 'duplicate', id, newId})
      continue
    }

    /* Edits and creates are mutations, and `translateActions` already owns them.
     * Reaching here means the caller routed a write to the wrong translator —
     * reported, never silently applied twice. */
    unsupported.push(
      `${actionType} is not a document action — route it through translateActions instead`,
    )
  }

  return {steps, documentIds, unsupported}
}

/** Dispatch on the interception point the write came from. */
export function translateInterceptedWrite(write: InterceptedWrite): TranslationResult {
  if (write?.kind === 'actions') return translateActions(write.payload)
  if (write?.kind === 'mutations') return translateMutations(write.payload)
  return {
    mutations: [],
    documentIds: [],
    unsupported: [`unknown intercepted write kind ${JSON.stringify(write?.kind)}`],
  }
}
