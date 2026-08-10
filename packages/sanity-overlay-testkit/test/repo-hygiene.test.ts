/**
 * Repository hygiene — every tracked text file must stay reviewable plain text.
 *
 * WHY THIS IS A TEST AND NOT A LINT RULE
 * ──────────────────────────────────────
 * A raw NUL byte in a source file is not a style problem. Git classifies a file
 * containing NUL as **binary**, and the consequences are that review stops
 * working on it:
 *
 *   - `git diff` / `git show` / a PR diff print only "Binary files … differ",
 *     so every content change in that file becomes invisible to human review;
 *   - `grep` and `rg` skip the file entirely (they report "binary file matches"
 *     at best), so a repo-wide search for a bad pattern silently misses it.
 *
 * That is not hypothetical here. A leftover `// MUTATION (b)` edit survived a
 * repo-wide sweep AND got staged into the index precisely because the file it
 * lived in carried a NUL and neither `git diff` nor `rg` would show it. The NUL
 * was there as a join separator — a construction that is independently unsound
 * (see `cli-diff.test.ts` and `core-w4-integrity.test.ts`) — so the two defects
 * arrived together and the second one hid the first.
 *
 * The promotion module already had a scoped version of this check. Scoped is not
 * enough: the property has to hold for the whole repository or the next NUL just
 * lands somewhere else. This is the repository-wide generalisation.
 *
 * THE ORACLE IS GIT, NOT A HARD-CODED LIST
 * ────────────────────────────────────────
 * The file set comes from `git ls-files`, which reads the INDEX — so a file is
 * covered from the moment it is `git add`ed, which is exactly when the incident
 * above became dangerous, and nobody has to remember to extend a list. The scan
 * asserts its own denominator so that a broken enumeration cannot pass by
 * checking nothing.
 *
 * Untracked files are deliberately NOT scanned. A working tree legitimately
 * holds half-written scratch, and reading it would make this guard depend on
 * whatever else is mid-write — a guard that flakes is a guard that gets
 * disabled. Staging is the boundary this defends.
 */
import {execFileSync} from 'node:child_process'
import {readFileSync, statSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Extensions whose contents are binary BY DESIGN. Nothing tracked matches these
 * today; the set states the policy for whoever adds the first one, so the guard
 * fails on an accidental NUL in source rather than on a legitimate asset.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.wasm',
])

/**
 * Bytes that make a file unreviewable. Everything below 0x20 except the three
 * whitespace bytes source files legitimately use, plus DEL.
 *
 * `\t` (0x09), `\n` (0x0a) and `\r` (0x0d) are allowed; every other C0 byte and
 * 0x7f is not.
 */
function isForbidden(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false
  return byte < 0x20 || byte === 0x7f
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const slash = name.lastIndexOf('/')
  return dot > slash ? name.slice(dot).toLowerCase() : ''
}

/**
 * Files this repository has DECLARED binary in a `.gitattributes`.
 *
 * The extension set above cannot answer for branch-local asset blobs: they are
 * `assets/blobs/<sha256>.bin`, deliberately extension-less as to their real
 * type, because the content is opaque bytes addressed by checksum. Adding
 * `.bin` to the list would be worse than useless — it would excuse every stray
 * `.bin` anyone ever commits.
 *
 * So the second source of truth is Git's own, which is also the reviewable one:
 * a path escapes the text scan only if some `.gitattributes` says `binary`, and
 * that file is itself in the diff. Declaring a path binary becomes a visible
 * act rather than a silent extension match.
 *
 * `git check-attr` is asked once for the whole list; per-file invocation is
 * thousands of processes.
 */
function declaredBinary(files: string[]): Set<string> {
  if (files.length === 0) return new Set()
  const stdout = execFileSync('git', ['check-attr', '--stdin', '-z', 'binary'], {
    cwd: REPO_ROOT,
    /* A Buffer, not a string: with `encoding: 'buffer'` Node tries to encode a
       string input using that same encoding and rejects it as unknown. Bytes in,
       bytes out — which is also what a path containing non-UTF-8 needs. */
    input: Buffer.from(`${files.join('\0')}\0`, 'utf8'),
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  /* `-z` emits NUL-separated triples: <path> NUL <attr> NUL <value> NUL. */
  const fields = stdout.toString('utf8').split('\0')
  const declared = new Set<string>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === 'set') declared.add(fields[index] as string)
  }
  return declared
}

function trackedFiles(): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0)
}

interface Offence {
  file: string
  line: number
  column: number
  byte: string
}

/** Where in the file, in human terms, so the failure message is actionable. */
function locate(bytes: Buffer, offset: number): {line: number; column: number} {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === 0x0a) {
      line += 1
      lineStart = index + 1
    }
  }
  return {line, column: offset - lineStart + 1}
}

/**
 * The first forbidden byte in `bytes`, or `null`.
 *
 * One report per file is enough to act on, and a file full of NULs must not
 * produce a thousand-line failure message.
 */
function firstOffence(bytes: Buffer): number | null {
  for (let index = 0; index < bytes.length; index += 1) {
    if (isForbidden(bytes[index] as number)) return index
  }
  return null
}

function scan(): {files: number; offences: Offence[]} {
  const offences: Offence[] = []
  let scanned = 0

  const tracked = trackedFiles()
  const declared = declaredBinary(tracked)

  for (const file of tracked) {
    if (BINARY_EXTENSIONS.has(extensionOf(file))) continue
    if (declared.has(file)) continue
    const absolute = REPO_ROOT + file
    /* `git ls-files` still lists a tracked file that has been deleted in the
       working tree; that is not this test's business. */
    try {
      if (!statSync(absolute).isFile()) continue
    } catch {
      continue
    }

    const bytes = readFileSync(absolute)
    scanned += 1
    if (firstOffence(bytes) === null) continue

    /* CONFIRM BEFORE REPORTING. A repository is a live directory: an editor, a
       formatter, another agent or a test fixture can be rewriting a file at the
       instant it is read, and a torn read can surface bytes that are in no
       committed or saved version of the file. A defect is reproducible; a torn
       read is not. Re-reading and requiring the offence to still be there keeps
       this guard deterministic without weakening it — a real control byte
       survives every read. */
    let confirmed: Buffer
    try {
      confirmed = readFileSync(absolute)
    } catch {
      continue
    }
    const index = firstOffence(confirmed)
    if (index === null) continue

    const {line, column} = locate(confirmed, index)
    offences.push({
      file,
      line,
      column,
      byte: `0x${(confirmed[index] as number).toString(16).padStart(2, '0')}`,
    })
  }

  return {files: scanned, offences}
}

describe('repository hygiene', () => {
  it('tracks no text file containing a control byte', () => {
    const {files, offences} = scan()

    /* Independent oracle for the scan itself: this repository is well over a
       hundred tracked text files, so a zero-length enumeration is a broken test,
       not a clean repository. */
    expect(files).toBeGreaterThan(100)

    expect(offences).toEqual([])
  })

  it('rejects a control byte the moment one is present', () => {
    /* Proof the predicate above is not vacuous: it is the same predicate, run
       against the exact byte sequences it exists to catch and against the
       whitespace it must tolerate. */
    for (const byte of [0x00, 0x01, 0x1b, 0x1f, 0x7f]) {
      expect(isForbidden(byte)).toBe(true)
    }
    for (const byte of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0xc3]) {
      expect(isForbidden(byte)).toBe(false)
    }
  })
})
