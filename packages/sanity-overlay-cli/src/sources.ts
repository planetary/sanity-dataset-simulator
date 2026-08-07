/**
 * Collecting a project's source files, for the two §22.5 enforcement commands.
 *
 * Shared by `lint` and `codemod` on purpose: a gate that scanned a different
 * file set from the transform meant to fix it would report problems the fixer
 * never sees, or bless files the fixer would still rewrite. One walker, one
 * answer.
 *
 * `node_modules`, `.git` and build output are always skipped. That is not a
 * convenience — a rule that reported a vendored query would be switched off
 * within a day, and the check is worthless once it is off.
 */
import {readdir, readFile, stat} from 'node:fs/promises'
import {isAbsolute, join, relative, resolve} from 'node:path'
import {usageError} from './errors'

export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]

/** Directories that are never a project's own source. */
export const ALWAYS_SKIPPED: readonly string[] = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
]

export interface CollectOptions {
  readonly extensions?: readonly string[]
  /** Skip any path containing one of these substrings. */
  readonly ignore?: readonly string[]
  /**
   * Accept a file the extension list would reject.
   *
   * Preview configuration is the case that needs it: `.env.preview` and
   * `.env.production` are dotenv files whose *suffix* is the environment name,
   * so "ends with `.env`" misses exactly the files a preview deployment is
   * configured by. Additive only — it can never exclude a file the extensions
   * already matched, so no caller can narrow a scan through this option.
   */
  readonly include?: (basename: string) => boolean
}

export interface SourceFile {
  /** Path relative to the scan root — what a report prints. */
  readonly file: string
  readonly path: string
  readonly source: string
}

async function walk(
  target: string,
  root: string,
  options: Required<CollectOptions>,
  into: string[],
): Promise<void> {
  const matches = (name: string): boolean =>
    options.extensions.some((extension) => name.endsWith(extension)) || options.include(name)

  const stats = await stat(target).catch(() => null)
  if (stats === null) throw usageError(`No such path: ${target}`, {path: target})
  if (options.ignore.some((needle) => target.includes(needle))) return
  if (stats.isFile()) {
    if (matches(target)) into.push(target)
    return
  }
  for (const entry of await readdir(target, {withFileTypes: true})) {
    if (ALWAYS_SKIPPED.includes(entry.name)) continue
    const full = join(target, entry.name)
    if (options.ignore.some((needle) => full.includes(needle))) continue
    if (entry.isDirectory()) await walk(full, root, options, into)
    else if (matches(entry.name)) into.push(full)
  }
}

/**
 * Read every source file under `paths`, resolved against `root`.
 *
 * Deterministic order: a report whose lines moved between runs could not be
 * diffed, and CI logs are read by diffing them.
 */
export async function collectSources(
  root: string,
  paths: readonly string[],
  options: CollectOptions = {},
): Promise<SourceFile[]> {
  const resolved: Required<CollectOptions> = {
    extensions: options.extensions ?? DEFAULT_SOURCE_EXTENSIONS,
    ignore: options.ignore ?? [],
    include: options.include ?? (() => false),
  }
  const targets = paths.length > 0 ? paths : ['.']
  const found: string[] = []
  for (const target of targets) {
    await walk(isAbsolute(target) ? target : resolve(root, target), root, resolved, found)
  }
  found.sort()
  return Promise.all(
    found.map(async (path) => ({
      file: relative(root, path) || path,
      path,
      source: await readFile(path, 'utf8'),
    })),
  )
}
