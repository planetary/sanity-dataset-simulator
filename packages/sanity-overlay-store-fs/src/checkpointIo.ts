/**
 * Reading a checkpoint directory off disk — PRD §14.1, §29.1, §29.7.
 *
 * Core owns the checkpoint *format* (`sanity-overlay-core/src/checkpoint`): it
 * renders and parses a path → bytes map and knows nothing about a filesystem.
 * This module is the only place that turns a directory into that map, so the
 * format stays testable without I/O and the I/O stays testable without a format.
 *
 * The directory being read is frequently the *live* `.sanity-overlay/`, which
 * also holds generated runtime state (§14.1 "Runtime-only files must be
 * ignored"), diagnostic `.broken` copies and in-flight `.tmp-` staging files.
 * None of those are checkpoint content and none are read here.
 */
import type {Dirent} from 'node:fs'
import {readFile, readdir} from 'node:fs/promises'
import {join, sep} from 'node:path'
import {
  CHECKPOINT_CHECKSUMS_FILE,
  isGovernedCheckpointPath,
  parse,
} from 'sanity-overlay-core'
import type {
  OverlayCheckpointChecksums,
  OverlayCheckpointFiles,
} from 'sanity-overlay-core'
import {BROKEN_SUFFIX, HISTORY_DIR, LOCKS_DIR, RUNTIME_DIR, TEMP_PREFIX, assertWithinRoot} from './layout'

const SKIPPED_DIRS = new Set([RUNTIME_DIR, LOCKS_DIR, HISTORY_DIR])

function isIgnored(relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.some((segment) => SKIPPED_DIRS.has(segment))) return true
  const name = segments[segments.length - 1]!
  if (name.startsWith(TEMP_PREFIX)) return true
  if (name.endsWith(BROKEN_SUFFIX)) return true
  return false
}

/**
 * Read a checkpoint directory into the path → bytes map core verifies.
 *
 * Two passes: `checksums.json` first, then everything the format governs plus
 * anything that record explicitly lists. Reading the listed set as well as the
 * governed set is what lets core distinguish "listed but absent" (corrupt) from
 * "present but unlisted" (also corrupt) rather than silently seeing neither.
 */
export async function readCheckpointDir(dir: string): Promise<OverlayCheckpointFiles> {
  const files = new Map<string, string>()

  let listed: ReadonlySet<string> = new Set()
  const checksumsPath = assertWithinRoot(dir, CHECKPOINT_CHECKSUMS_FILE)
  const checksumsText = await readFileSoft(checksumsPath)
  if (checksumsText !== null) {
    files.set(CHECKPOINT_CHECKSUMS_FILE, checksumsText)
    try {
      const record = parse(checksumsText) as OverlayCheckpointChecksums
      if (record !== null && typeof record === 'object' && typeof record.files === 'object') {
        listed = new Set(Object.keys(record.files))
      }
    } catch {
      /* An unparseable checksum manifest is core's to classify, not ours. */
    }
  }

  let entries: Dirent<string>[] = []
  try {
    entries = await readdir(dir, {recursive: true, withFileTypes: true})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return files
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath, entry.name)
    const relative = absolute.slice(dir.length + 1).split(sep).join('/')
    if (relative === CHECKPOINT_CHECKSUMS_FILE) continue
    if (isIgnored(relative)) continue
    if (!isGovernedCheckpointPath(relative) && !listed.has(relative)) continue
    files.set(relative, await readFile(absolute, 'utf8'))
  }

  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

async function readFileSoft(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
