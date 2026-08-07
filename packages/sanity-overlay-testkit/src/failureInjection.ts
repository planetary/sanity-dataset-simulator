/**
 * The shared failure-injection and work-accounting harness (PRD §33, §35.15,
 * §5.4).
 *
 * ONE INSTRUMENT, TWO JOBS, AND THAT IS DELIBERATE.
 *
 * `FsOverlayStoreHooks.beforeRename` fires at the exact instant a temporary file
 * holds the complete new bytes and the atomic rename has not yet happened. That
 * single point answers both questions this harness exists to ask:
 *
 *   §33  — *inject*: throw there and the write fails after the bytes were staged
 *          and before anything became visible. That is the real "process stopped
 *          during a local temporary write" of §35.15, not a simulation of it.
 *   §5.4 — *account*: the file is on disk and readable, so its byte length is the
 *          exact volume the operation committed. Counting renames and summing
 *          those lengths gives a deterministic work measure — no wall clock, no
 *          GC sensitivity, no machine.
 *
 * WHY THE BYTES ARE READ RATHER THAN ASSUMED. A ledger that recorded only the
 * target path would pass just as happily against a store that never wrote
 * anything, because the hook would still have been called. Reading the staged
 * file back is the non-vacuity proof: the assertion is about bytes that exist.
 *
 * `beforeRename` is a production hook with a production purpose (`store-fs`
 * declares it for §35.9 "Atomic temporary write and rename"), so nothing here
 * requires a production change, and no injected failure can leak into a run that
 * did not ask for one — an unarmed ledger only observes.
 */
import {readFile} from 'node:fs/promises'

/** One atomic write, captured between "bytes staged" and "bytes visible". */
export interface AtomicWriteRecord {
  /** Absolute path the temporary file is about to become. */
  targetPath: string
  /** Absolute path of the staging file, which still exists at capture time. */
  tempPath: string
  /**
   * Length of the staged file in bytes, read back from disk at the injection
   * point. Never a predicted or recomputed value.
   */
  bytes: number
}

export type PathMatch = (targetPath: string) => boolean

/** Match by trailing path segment — `manifest.json`, `intent.json`, and so on. */
export function endsWith(suffix: string): PathMatch {
  return (targetPath) => targetPath.endsWith(suffix)
}

/** Match anything under a named directory of the canonical layout (PRD §14.1). */
export function underDir(name: string): PathMatch {
  const needle = `/${name}/`
  return (targetPath) => targetPath.includes(needle)
}

export interface HeldWrite {
  /** Has a matching write actually reached the injection point? */
  reached(): boolean
  /** How many matching writes are parked. */
  parked(): number
  release(): void
}

export interface FailureLedger {
  /** Pass straight to `new FsOverlayStore({hooks})` / `startOverlayApiServer({hooks})`. */
  hooks: {beforeRename(info: {tempPath: string; targetPath: string}): Promise<void>}
  /** Every atomic write that reached the rename point, in order. */
  readonly writes: AtomicWriteRecord[]
  /** Total staged bytes across recorded writes. */
  totalBytes(): number
  /** Writes whose target matches. */
  matching(match: PathMatch): AtomicWriteRecord[]
  /** Forget everything recorded so far. Arming is untouched. */
  reset(): void
  /**
   * Fail matching writes by throwing `error` at the injection point — after the
   * temporary file holds the complete bytes, before the rename.
   *
   * One-shot by default, so a later attempt can prove the system recovered.
   * The staged write is still RECORDED before the throw: a caller must be able
   * to assert that the injection landed on real bytes.
   */
  failOn(match: PathMatch, error: unknown, options?: {repeat?: boolean}): void
  /** How many times an armed failure actually fired. Zero means it never injected. */
  injections(): number
  /** Park matching writes at the injection point until released. */
  holdOn(match: PathMatch): HeldWrite
  /** Disarm every injection; observation continues. */
  disarm(): void
}

interface ArmedFailure {
  match: PathMatch
  error: unknown
  repeat: boolean
  spent: boolean
}

export function createFailureLedger(): FailureLedger {
  const writes: AtomicWriteRecord[] = []
  const failures: ArmedFailure[] = []
  const holds: Array<{match: PathMatch; open: Promise<void>; state: {reached: number}}> = []
  let injected = 0

  async function beforeRename(info: {tempPath: string; targetPath: string}): Promise<void> {
    /* Read the staged file, so every recorded byte count is a fact about disk. */
    let bytes = -1
    try {
      bytes = Buffer.byteLength(await readFile(info.tempPath, 'utf8'), 'utf8')
    } catch {
      /* A temporary file that cannot be read at the rename point is itself a
       * finding; recorded as -1 rather than hidden behind a thrown error. */
    }
    writes.push({targetPath: info.targetPath, tempPath: info.tempPath, bytes})

    for (const failure of failures) {
      if (failure.spent || !failure.match(info.targetPath)) continue
      if (!failure.repeat) failure.spent = true
      injected += 1
      throw failure.error
    }

    for (const hold of holds) {
      if (!hold.match(info.targetPath)) continue
      hold.state.reached += 1
      await hold.open
    }
  }

  return {
    hooks: {beforeRename},
    writes,
    totalBytes: () => writes.reduce((sum, write) => sum + Math.max(write.bytes, 0), 0),
    matching: (match) => writes.filter((write) => match(write.targetPath)),
    reset: () => {
      writes.length = 0
    },
    failOn: (match, error, options) => {
      failures.push({match, error, repeat: options?.repeat === true, spent: false})
    },
    injections: () => injected,
    holdOn: (match) => {
      const state = {reached: 0}
      let release: () => void = () => undefined
      const open = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.push({match, open, state})
      return {
        reached: () => state.reached > 0,
        parked: () => state.reached,
        release: () => release(),
      }
    },
    disarm: () => {
      failures.length = 0
      holds.length = 0
    },
  }
}

/**
 * A real `errno` failure, shaped exactly as `node:fs` raises one.
 *
 * PRD §33 "Local disk write fails" names the detection as *"OS error"*. A plain
 * `Error` would let a store that special-cases its own test double pass; this
 * carries the fields production code actually branches on (`code`, `errno`,
 * `syscall`, `path`), so a handler that inspects them behaves identically.
 */
export function errnoError(
  code: 'ENOSPC' | 'EACCES' | 'EIO' | 'EROFS' | 'EPERM',
  syscall: string,
  path: string,
): NodeJS.ErrnoException {
  const messages: Record<string, string> = {
    ENOSPC: 'no space left on device',
    EACCES: 'permission denied',
    EIO: 'input/output error',
    EROFS: 'read-only file system',
    EPERM: 'operation not permitted',
  }
  const error = new Error(
    `${code}: ${messages[code]}, ${syscall} '${path}'`,
  ) as NodeJS.ErrnoException
  error.code = code
  error.syscall = syscall
  error.path = path
  return error
}

/** Poll a predicate instead of sleeping on a guessed duration. */
export async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Drain microtasks and a few macrotasks, so "still pending" means genuinely pending. */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
