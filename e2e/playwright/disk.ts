/**
 * THE DISK ORACLE.
 *
 * Every assertion about "the edit landed" reads the files a server wrote, never
 * anything the editor says about itself. The Studio showing *Saved* is the
 * failure mode this project has already had: on 2026-08-04 every non-ASCII edit
 * was silently dropped while the pane reported success, and 2048 green tests
 * could not see it, because the only thing that knew was `intent.json`.
 *
 * PATHS ARE FOUND, NOT COMPUTED. The store maps a logical id to a directory
 * through `documentKey()` = `encodeLogicalId(toPublishedId(id))`, so
 * `drafts.article-01` and `article-01` share a directory and ids with dots get
 * percent-encoded. Re-deriving that here would be a second copy of a mapping
 * that is allowed to change; instead every `documents/<dir>/intent.json` is read
 * and matched on the `logicalId` field the file itself carries. That is robust
 * to the encoding *and* it fails loudly if two directories ever claim the same
 * logical id.
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'

import {OVERLAY_ROOT} from '../harness/paths.mjs'

const OVERLAY_DIR = '.sanity-overlay'

/**
 * One perspective's compacted intent — `OverlayIntentState` in
 * `sanity-overlay-core/src/store/intent.ts`, spelled here because `e2e/` does
 * not import the packages it is auditing.
 */
export interface OverlayIntentLayer {
  mode: 'patch' | 'replace' | string
  overrides?: Array<{path: (string | number)[]; value: unknown}>
  unsets?: Array<(string | number)[]>
  /** Present, and authoritative, when `mode === 'replace'`. */
  replacement?: Record<string, unknown>
}

export interface OverlayIntent {
  logicalId: string
  type?: string
  formatVersion: number
  checksum: string
  base?: {publishedRevision?: string; snapshotRef?: string}
  draft?: OverlayIntentLayer
  published?: OverlayIntentLayer
  tombstones: {draft: boolean; published: boolean}
  touchedPaths: Array<(string | number)[]>
  conflicts: unknown[]
}

export interface OverlayManifest {
  overlayId: string
  revision: number
  status: string
  formatVersion: number
  transactionHead?: string
  base: {projectId: string; dataset: string; apiVersion: string}
  source: {branch?: string; repositoryId?: string}
  conflictSummary: {soft: number; hard: number; total: number}
  documentHeads: Record<
    string,
    {
      logicalId: string
      schemaType?: string
      state: 'modified' | 'created' | 'deleted' | string
      hasDraft: boolean
      hasPublished: boolean
      hasConflict: boolean
      checksum: string
      runtimeRevision: string
      updatedAt: string
    }
  >
}

export function overlayDir(root: string = OVERLAY_ROOT): string {
  return join(root, OVERLAY_DIR)
}

export function manifestPath(root: string = OVERLAY_ROOT): string {
  return join(overlayDir(root), 'manifest.json')
}

/** `null` before the overlay server has initialised the root. */
export function readManifest(root: string = OVERLAY_ROOT): OverlayManifest | null {
  const path = manifestPath(root)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as OverlayManifest
}

/** Every intent file on disk, in directory order. */
export function readAllIntents(root: string = OVERLAY_ROOT): Array<{dir: string; intent: OverlayIntent}> {
  const documents = join(overlayDir(root), 'documents')
  if (!existsSync(documents)) return []
  const out: Array<{dir: string; intent: OverlayIntent}> = []
  for (const dir of readdirSync(documents)) {
    const file = join(documents, dir, 'intent.json')
    if (!existsSync(file)) continue
    out.push({dir, intent: JSON.parse(readFileSync(file, 'utf8')) as OverlayIntent})
  }
  return out
}

/**
 * The intent for one logical id, or `null`.
 *
 * Throws when two directories claim the same logical id — that is a store bug
 * severe enough that returning either one would hide it.
 */
export function readIntent(logicalId: string, root: string = OVERLAY_ROOT): OverlayIntent | null {
  const matches = readAllIntents(root).filter(({intent}) => intent.logicalId === logicalId)
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} overlay directories claim logicalId "${logicalId}": ` +
        matches.map(({dir}) => dir).join(', '),
    )
  }
  return matches[0]?.intent ?? null
}

/** Every logical id the overlay currently holds an intent for. */
export function overlayDocumentIds(root: string = OVERLAY_ROOT): string[] {
  return readAllIntents(root)
    .map(({intent}) => intent.logicalId)
    .sort()
}

/**
 * The value the branch holds at `path` on the draft or published layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE ARE TWO INTENT SHAPES, AND THIS SUITE ONLY EVER PRODUCES THE SECOND.
 *
 * `compactIntentState` (`sanity-overlay-core/src/store/intent.ts`) emits
 * `mode: 'patch'` with an `overrides` array *only* when the document has a base
 * ancestor. **A branch-created document selects `mode: 'replace'` and emits the
 * whole document** as `replacement` — §14.2, §17.10.
 *
 * Every document in these specs is branch-created (Mode 2 has no base dataset
 * at all), so `overrides` is absent from every `intent.json` the suite will ever
 * write. This function used to read `overrides` and nothing else, so it returned
 * `undefined` for a file that plainly contained `"title": "Edited on the
 * branch"` — a green-looking oracle that could never be satisfied.
 *
 * It reads the file rather than re-deriving the mapping: `replacement` is a
 * whole document, so the path is walked; `overrides` is an exact-path list, so
 * it is matched; `unsets` wins over both, because a path the branch removed does
 * not hold the base value, it holds nothing.
 */
export function overrideAt(
  intent: OverlayIntent | null,
  path: (string | number)[],
  layer: 'draft' | 'published' = 'draft',
): unknown {
  const state = intent?.[layer]
  if (state === undefined) return undefined
  const key = JSON.stringify(path)

  if ((state.unsets ?? []).some((unset) => JSON.stringify(unset) === key)) return undefined

  const hit = (state.overrides ?? []).find(
    (override) => JSON.stringify(override.path) === key,
  )
  if (hit !== undefined) return hit.value

  if (state.mode !== 'replace' || state.replacement === undefined) return undefined
  let cursor: unknown = state.replacement
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string | number, unknown>)[segment]
  }
  return cursor
}

/**
 * The `.runtime/transactions/` log — one file per committed write.
 *
 * This is the second server-side witness to a write: the overlay-plane HTTP log
 * says a `/commit` was answered, and this says the store reached its commit
 * point. Either alone can be argued with; together they cannot.
 */
export function transactionIds(root: string = OVERLAY_ROOT): string[] {
  const dir = join(overlayDir(root), '.runtime', 'transactions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

/**
 * Poll the disk until `predicate` holds.
 *
 * Studio autosaves on a debounce and the commit is a round trip, so "the edit is
 * on disk" is never true at the instant the keystroke lands. Polling the file
 * system — rather than waiting on a UI signal — is the whole point: the UI
 * saying *Saved* is precisely the claim under test.
 */
export async function waitForDisk<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  {timeout = 20_000, interval = 200, what = 'overlay disk state'} = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T = read()
  while (Date.now() < deadline) {
    last = read()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(
    `timed out after ${timeout}ms waiting for ${what}. Last value:\n${JSON.stringify(last, null, 2)}`,
  )
}
