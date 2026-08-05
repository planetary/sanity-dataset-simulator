/**
 * The `fs` overlay port — reads `.sanity-overlay/` through the real
 * {@link FsOverlayStore} (PRD §14.1 canonical layout, §37 Phase 2).
 *
 * It is a LOADER, not a store: it opens no transaction, holds no lock and writes
 * nothing. The Studio (through the overlay server) is the only writer; this side
 * observes. That asymmetry is the reason the site can be pointed at a live
 * `.sanity-overlay/` while the Studio is running.
 *
 * CHANGE DETECTION. {@link OverlayStateLoader.probe} reads only `manifest.json`
 * and returns `<revision>:<updatedAt>`, which the store rewrites on every commit.
 * A *direct* hand-edit of `documents/<id>/intent.json` does not touch the
 * manifest, so it is not seen by the probe — that is what
 * {@link FsOverlayStateLoader.watch} and the client's explicit `revalidate()` are
 * for, and it is stated here rather than left to be discovered.
 */
import {watch as fsWatch, type FSWatcher} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'
import {isOverlayStoreError} from '../../sanity-overlay-core/src/index'
import {FsOverlayStore, OVERLAY_DIR} from '../../sanity-overlay-store-fs/src/index'
import type {OverlayRecordMap} from '../../sanity-overlay-core/src/index'
import type {OverlayStateLoader, OverlayStateSnapshot} from './types'

export interface FsOverlayStateLoaderOptions {
  /** The directory that CONTAINS `.sanity-overlay/` (PRD §14.1). */
  readonly root: string
  /** Injected clock. The loader never writes, so this only satisfies the store. */
  readonly now?: () => string
  /** Debounce window for {@link FsOverlayStateLoader.watch}, in milliseconds. */
  readonly watchDebounceMs?: number
}

export interface FsOverlayStateLoader extends OverlayStateLoader {
  /** Absolute path of the directory containing `.sanity-overlay/`. */
  readonly root: string
  watch(onChange: () => void): () => void
}

const isNotFound = (error: unknown): boolean =>
  isOverlayStoreError(error) && error.code === 'OVERLAY_NOT_FOUND'

export function createFsOverlayStateLoader(
  options: FsOverlayStateLoaderOptions,
): FsOverlayStateLoader {
  const root = isAbsolute(options.root) ? resolve(options.root) : resolve(process.cwd(), options.root)
  const now = options.now ?? (() => new Date().toISOString())
  const debounceMs = options.watchDebounceMs ?? 25
  const store = new FsOverlayStore({root, now})

  return {
    root,

    async probe() {
      try {
        const manifest = await store.inspect()
        return `${manifest.revision}:${manifest.updatedAt}`
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async load(): Promise<OverlayStateSnapshot | null> {
      let manifest
      try {
        manifest = await store.inspect()
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }

      const records: Record<string, OverlayRecordMap[string]> = {}
      const heads = await store.listChangedDocuments(manifest.overlayId, {includeUnchanged: true})
      for (const head of heads) {
        const read = await store.readDocumentByLogicalId(manifest.overlayId, head.logicalId)
        /* `record === null` is a fresh clone where `.runtime/` was never
         * committed: the review surface survives but the replayable record does
         * not. Rebuilding it needs the three-way merge engine and is not a read
         * client's job — the document is skipped, never faked from `intent`. */
        if (read?.record) records[read.record.logicalId] = read.record
      }

      return {
        overlayId: manifest.overlayId,
        revision: manifest.revision,
        records,
        token: `${manifest.revision}:${manifest.updatedAt}`,
      }
    },

    watch(onChange: () => void): () => void {
      const overlayDir = join(root, OVERLAY_DIR)
      let timer: ReturnType<typeof setTimeout> | null = null
      let watcher: FSWatcher | null = null

      const fire = () => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          onChange()
        }, debounceMs)
        /* A pending debounce must not hold the process open: a site that is
         * otherwise idle should still be able to exit. Optional because the
         * browser/DOM `setTimeout` returns a number with no `unref`. */
        ;(timer as unknown as {unref?: () => void}).unref?.()
      }

      try {
        watcher = fsWatch(overlayDir, {recursive: true}, fire)
      } catch {
        /* No overlay directory yet. Watch its parent so the overlay appearing
         * later is still noticed, rather than silently never firing. */
        try {
          watcher = fsWatch(root, {recursive: true}, fire)
        } catch {
          watcher = null
        }
      }

      return () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        watcher?.close()
        watcher = null
      }
    },
  }
}
