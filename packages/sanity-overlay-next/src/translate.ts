/**
 * Studio dialect → PRD §13.7 mutations and §18.4-§18.9 document actions.
 *
 * The local API is handed whatever the Studio write facade intercepted: an
 * Actions API payload (`client.observable.action(...)`) or a raw `/data/mutate`
 * body (`dataRequest('mutate', ...)`). Neither is an overlay mutation. This
 * module is the only place in the package that knows Sanity's wire dialect;
 * everything downstream speaks core's types.
 *
 * TWO TRANSLATORS, ON PURPOSE.
 *
 * {@link translateInterceptedWrite} answers "which §13.7 *mutation* is this?".
 * {@link translateDocumentActions} answers "which core §18 *reducer*, with which
 * arguments?". A mutation is replayable data; an action is a state transition
 * whose result depends on what the overlay holds right now (publish promotes
 * whatever the draft resolves to at apply time). Folding them together would
 * mean re-deriving §18 semantics here, which is exactly what core exists for —
 * so the mutation translator deliberately keeps answering "not mine" for
 * publish / unpublish / discard, and says so out loud.
 *
 * NOTHING IS EVER SILENTLY DROPPED (§5.5). Every input this module declines to
 * translate produces a human-readable entry in `unsupported`, which the endpoint
 * returns on the wire and the caller is expected to surface. A write that
 * reached the server and vanished without a word is the one failure mode the
 * local API must never have.
 */
import {isForbiddenKey} from '../../sanity-overlay-core/src/index'
import type {
  OverlayMutation,
  OverlayOperation,
  OverlayPath,
  SanityDocument,
} from '../../sanity-overlay-core/src/index'

type Rec = Record<string, unknown>

/**
 * The pseudo field Studio's Actions API prepends an `unset` of, so that an
 * otherwise empty edit action still forms a legal patch.
 *
 * It is a transport artifact. Letting it through would put a touched path and an
 * `unset` into the reviewer-facing `intent.json` (PRD §14.2) for an edit that
 * changed nothing.
 */
export const GUARD_PSEUDO_FIELD = '_empty_action_guard_pseudo_field_'

/** The overlay's own spelling of the §18.9 duplicate action. */
export const DUPLICATE_ACTION_TYPE = 'sanity.overlay.document.duplicate'

/** Patch keys that carry no operation and must not be reported as unsupported. */
const IGNORED_PATCH_KEYS = new Set([
  'id',
  'query',
  'params',
  'purge',
  'unsetIsEmpty',
  /*
   * Dropped deliberately, not ignored by accident. The overlay stamps synthetic
   * revisions (PRD §13.9) that live in a different revision space from Content
   * Lake, so a Content Lake precondition can only ever fail here. Preconditions
   * against the overlay's OWN revisions are a §25.5 concern for the write path.
   */
  'ifRevisionID',
  'ifRevisionId',
])

const OPERATION_PATCH_KEYS = [
  'set',
  'setIfMissing',
  'unset',
  'insert',
  'inc',
  'dec',
  'diffMatchPatch',
]

const EDIT_ACTIONS = new Set([
  'sanity.action.document.edit',
  'sanity.action.document.version.replace',
])

const DISCARD_ACTIONS = new Set([
  'sanity.action.document.discard',
  'sanity.action.document.version.discard',
])

/** The interception point a write arrived through. */
export interface InterceptedWrite {
  kind: 'actions' | 'mutations'
  /** The intercepted array, the `{mutations}`/`{actions}` envelope, or one entry. */
  payload: unknown
}

export interface TranslationResult {
  mutations: OverlayMutation[]
  /**
   * Perspective-qualified document IDs the write touches, in first-seen order.
   * The caller ships the base documents for these so the overlay can capture a
   * merge ancestor on first touch (PRD §13.3).
   */
  documentIds: string[]
  /** Human-readable reasons a part of the write was not translated. */
  unsupported: string[]
}

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
      document?: SanityDocument
    }

export interface DocumentActionTranslation {
  steps: DocumentActionStep[]
  /** Logical document IDs the actions touch, in first-seen order. */
  documentIds: string[]
  unsupported: string[]
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalise the three shapes a caller may post into one array of entries. */
function asEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRec(payload)) {
    if (Array.isArray(payload.mutations)) return payload.mutations
    if (Array.isArray(payload.actions)) return payload.actions
  }
  if (payload === undefined || payload === null) return []
  return [payload]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse a Sanity patch path (`body[_key=="a"].children[0].text`) into a PRD
 * §13.6 overlay path.
 *
 * Only the accessors Studio actually emits are supported: named fields, integer
 * indexes (including the `-1` append anchor) and `_key` predicates. Anything
 * that selects a SET of positions — `[]`, a slice, a filter — throws, because
 * collapsing it to a single path would write to the wrong element and look like
 * it worked. The caller records the throw in `unsupported`.
 *
 * A field segment spelling a §35.14 prototype key throws for the same reason.
 * `__proto__`, `constructor` and `prototype` can never be own keys of canonical
 * overlay JSON, so such a path names a member the format cannot hold — and the
 * one thing it must not do is look like it worked. Before this check it did
 * exactly that: `set` at `__proto__.polluted` was answered `committed: true`
 * and stored nothing, because a plain assignment to that key runs the prototype
 * SETTER (security review 2026-08-06 P2-5). A `_key` PREDICATE spelling the same
 * word is untouched — that is a value, not a property name.
 */
export function parseSanityPath(path: string): OverlayPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('a patch path must be a non-empty string')
  }

  const segments: OverlayPath = []
  let cursor = 0

  while (cursor < path.length) {
    if (path[cursor] === '.') {
      cursor += 1
      continue
    }

    if (path[cursor] === '[') {
      const close = path.indexOf(']', cursor)
      if (close === -1) throw new Error(`unbalanced "[" in path ${JSON.stringify(path)}`)
      const inner = path.slice(cursor + 1, close).trim()
      cursor = close + 1

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

    let end = cursor
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1
    const field = path.slice(cursor, end)
    if (field.length === 0) throw new Error(`empty segment in path ${JSON.stringify(path)}`)
    if (isForbiddenKey(field)) {
      throw new Error(
        `segment ${JSON.stringify(field)} in path ${JSON.stringify(path)} is a ` +
          'prototype-polluting key and cannot be a document field (PRD §35.14); the write is ' +
          'refused rather than stored as something else',
      )
    }
    segments.push(field)
    cursor = end
  }

  if (segments.length === 0) throw new Error(`empty path ${JSON.stringify(path)}`)
  return segments
}

/**
 * Matched on the ROOT segment: the guard field is a transport artifact, so
 * anything rooted at it is equally an artifact.
 */
function isGuardPath(path: OverlayPath): boolean {
  return path[0] === GUARD_PSEUDO_FIELD
}

/**
 * One Sanity patch body → ordered operations.
 *
 * The emission order mirrors Content Lake's documented apply order
 * (`setIfMissing`, `unset`, `set`, `inc`, `dec`, `insert`, `diffMatchPatch`), so
 * a patch that mixes operations lands the same way locally as it would remotely.
 * Core's `applyOperations` is order-sensitive: this is behaviour, not style.
 */
function operationsFromPatch(patch: Rec, unsupported: string[]): OverlayOperation[] {
  const operations: OverlayOperation[] = []

  const at = (key: string, raw: unknown, build: (path: OverlayPath) => OverlayOperation | null) => {
    if (typeof raw !== 'string') {
      unsupported.push(`patch.${key}: path must be a string`)
      return
    }
    let path: OverlayPath
    try {
      path = parseSanityPath(raw)
    } catch (error) {
      unsupported.push(`patch.${key}: ${(error as Error).message}`)
      return
    }
    if (isGuardPath(path)) return
    const operation = build(path)
    if (operation !== null) operations.push(operation)
  }

  const entriesOf = (key: string): Array<[string, unknown]> =>
    isRec(patch[key]) ? Object.entries(patch[key] as Rec) : []

  for (const [raw, value] of entriesOf('setIfMissing')) {
    at('setIfMissing', raw, (path) => ({type: 'setIfMissing', path, value}))
  }

  const unset = patch.unset
  if (Array.isArray(unset)) {
    for (const raw of unset) at('unset', raw, (path) => ({type: 'unset', path}))
  } else if (unset !== undefined) {
    unsupported.push('patch.unset must be an array of path strings')
  }

  for (const [raw, value] of entriesOf('set')) {
    at('set', raw, (path) => ({type: 'set', path, value}))
  }

  for (const key of ['inc', 'dec'] as const) {
    for (const [raw, amount] of entriesOf(key)) {
      at(key, raw, (path) => {
        if (typeof amount !== 'number') {
          unsupported.push(`patch.${key}.${raw} must be a number`)
          return null
        }
        return {type: key, path, amount}
      })
    }
  }

  const insert = patch.insert
  if (isRec(insert)) {
    const position = (['before', 'after', 'replace'] as const).find(
      (candidate) => typeof insert[candidate] === 'string',
    )
    if (position === undefined) {
      unsupported.push('patch.insert requires a before/after/replace anchor path')
    } else if (!Array.isArray(insert.items)) {
      unsupported.push('patch.insert requires an `items` array')
    } else {
      const items = insert.items
      at('insert', insert[position], (path) => ({type: 'insert', path, position, items}))
    }
  } else if (insert !== undefined) {
    unsupported.push('patch.insert must be an object')
  }

  for (const [raw, value] of entriesOf('diffMatchPatch')) {
    at('diffMatchPatch', raw, (path) => {
      if (typeof value !== 'string') {
        unsupported.push(`patch.diffMatchPatch.${raw} must be a string`)
        return null
      }
      return {type: 'diffMatchPatch', path, patch: value}
    })
  }

  for (const key of Object.keys(patch)) {
    if (IGNORED_PATCH_KEYS.has(key) || OPERATION_PATCH_KEYS.includes(key)) continue
    unsupported.push(`unsupported patch key ${JSON.stringify(key)}`)
  }

  return operations
}

/** Accumulates one translation, keeping `documentIds` first-seen and unique. */
class Collector {
  readonly mutations: OverlayMutation[] = []
  readonly documentIds: string[] = []
  readonly unsupported: string[] = []

  target(id: unknown): string | null {
    const value = str(id)
    if (value === undefined) return null
    if (!this.documentIds.includes(value)) this.documentIds.push(value)
    return value
  }

  patch(id: string, patch: Rec): void {
    const operations = operationsFromPatch(patch, this.unsupported)
    /* An all-guard patch collapses to nothing. Emitting a zero-operation patch
     * would still bump the overlay revision and rewrite intent.json for no
     * semantic change, breaking the §14.3 "diff shows semantic change only"
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

/** A document a create mutation may carry: §13.9 requires both `_id` and `_type`. */
function createDocument(
  value: unknown,
  label: string,
  unsupported: string[],
): SanityDocument | null {
  if (!isRec(value) || str(value._id) === undefined) {
    unsupported.push(`${label} requires a document with an _id`)
    return null
  }
  if (str(value._type) === undefined) {
    unsupported.push(`${label} requires a document with a _type (PRD §13.9)`)
    return null
  }
  return value as unknown as SanityDocument
}

const CREATE_KEYS = ['create', 'createIfNotExists', 'createOrReplace'] as const

/** Studio's live-edit path: `dataRequest('mutate', {mutations, transactionId})`. */
export function translateMutations(payload: unknown): TranslationResult {
  const collector = new Collector()

  for (const entry of asEntries(payload)) {
    if (!isRec(entry)) {
      collector.unsupported.push('a mutation must be an object')
      continue
    }

    const createKey = CREATE_KEYS.find((key) => entry[key] !== undefined)
    if (createKey !== undefined) {
      const document = createDocument(entry[createKey], createKey, collector.unsupported)
      if (document === null) continue
      collector.target(document._id)
      collector.mutations.push({type: createKey, document})
      continue
    }

    if (entry.delete !== undefined) {
      const body = entry.delete
      const target = collector.target(isRec(body) ? body.id : undefined)
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

/** Studio's autosave path: `client.observable.action(actions, {transactionId})`. */
export function translateActions(payload: unknown): TranslationResult {
  const collector = new Collector()

  for (const entry of asEntries(payload)) {
    if (!isRec(entry)) {
      collector.unsupported.push('an action must be an object')
      continue
    }

    const actionType = str(entry.actionType) ?? '<unknown>'
    const draftId = str(entry.draftId)
    const publishedId = str(entry.publishedId)
    const versionId = str(entry.versionId)

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
      const document = createDocument(entry.attributes, `${actionType} attributes`, [])
      if (document === null) {
        collector.unsupported.push(
          `${actionType}: \`attributes\` must be a document with an _id and a _type (PRD §13.9)`,
        )
        continue
      }
      collector.target(document._id)
      /* `ifExists: 'ignore'` is the Actions API spelling of createIfNotExists. */
      collector.mutations.push({
        type: entry.ifExists === 'ignore' ? 'createIfNotExists' : 'create',
        document,
      })
      continue
    }

    if (actionType === 'sanity.action.document.delete') {
      /* §18.8 — a `delete` mutation tombstones both perspectives at once, so it
       * is keyed on the logical (published) ID. */
      const target = collector.target(publishedId ?? draftId ?? versionId)
      if (target === null) {
        collector.unsupported.push(`${actionType}: no target document id`)
        continue
      }
      collector.mutations.push({type: 'delete', id: target})
      continue
    }

    collector.unsupported.push(
      `${actionType} is a document action (PRD §18.4-§18.9), not a mutation — ` +
        `post it as kind "documentActions"`,
    )
  }

  return collector.result()
}

/** `drafts.x` / `versions.r.x` → `x`. Document actions are keyed on the logical ID. */
function toLogicalId(id: string): string {
  if (id.startsWith('drafts.')) return id.slice('drafts.'.length)
  const version = /^versions\.[^.]+\.(.+)$/.exec(id)
  return version ? version[1]! : id
}

export function translateDocumentActions(payload: unknown): DocumentActionTranslation {
  const steps: DocumentActionStep[] = []
  const documentIds: string[] = []
  const unsupported: string[] = []

  const target = (id: unknown): string | null => {
    const value = str(id)
    if (value === undefined) return null
    const logical = toLogicalId(value)
    if (!documentIds.includes(logical)) documentIds.push(logical)
    return logical
  }

  for (const entry of asEntries(payload)) {
    if (!isRec(entry)) {
      unsupported.push('a document action must be an object')
      continue
    }

    const actionType = str(entry.actionType) ?? '<unknown>'
    const draftId = str(entry.draftId)
    const publishedId = str(entry.publishedId)
    const versionId = str(entry.versionId)

    const simple = (
      type: 'publish' | 'unpublish' | 'discardDraft' | 'delete',
      id: string | null,
    ): void => {
      if (id === null) unsupported.push(`${actionType}: no target document id`)
      else steps.push({type, id})
    }

    if (actionType === 'sanity.action.document.publish') {
      simple('publish', target(publishedId ?? draftId))
      continue
    }
    if (actionType === 'sanity.action.document.unpublish') {
      simple('unpublish', target(publishedId ?? draftId))
      continue
    }
    if (DISCARD_ACTIONS.has(actionType)) {
      simple('discardDraft', target(versionId ?? draftId ?? publishedId))
      continue
    }
    if (actionType === 'sanity.action.document.delete') {
      simple('delete', target(publishedId ?? draftId ?? versionId))
      continue
    }

    if (actionType === 'sanity.action.document.replaceDraft') {
      const id = target(publishedId ?? draftId)
      if (id === null) {
        unsupported.push(`${actionType}: no target document id`)
        continue
      }
      const attributes = entry.attributes
      if (!isRec(attributes) || str(attributes._type) === undefined) {
        unsupported.push(`${actionType}: requires an \`attributes\` document with a _type`)
        continue
      }
      /* §18.8 explicit restore: clear the draft tombstone, then write the body
       * the user chose to come back to. Both halves are core calls. */
      steps.push({
        type: 'restore',
        id,
        target: 'draft',
        document: {
          ...attributes,
          _id: str(attributes._id) ?? `drafts.${id}`,
        } as unknown as SanityDocument,
      })
      continue
    }

    if (actionType === DUPLICATE_ACTION_TYPE) {
      const id = target(publishedId)
      const raw = str(entry.newId)
      const newId = raw === undefined ? undefined : toLogicalId(raw)
      if (id === null || newId === undefined || newId.length === 0) {
        unsupported.push(`${actionType}: requires \`publishedId\` and \`newId\``)
        continue
      }
      if (!documentIds.includes(newId)) documentIds.push(newId)
      steps.push({type: 'duplicate', id, newId})
      continue
    }

    unsupported.push(
      `${actionType} is not a document action — post it as kind "actions" or "mutations"`,
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
