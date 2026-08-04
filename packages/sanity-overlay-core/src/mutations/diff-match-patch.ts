/**
 * `diffMatchPatch` patch **application** (PRD §13.7, §17.9).
 *
 * ## What this implements
 *
 * Sanity emits `diffMatchPatch` operations whose payload is the patch text
 * produced by `diff-match-patch`'s `patch_toText`, a diff/unidiff hybrid:
 *
 * ```text
 * @@ -8,16 +8,17 @@
 *  the quick br
 * -o
 * +O
 *  wn fox
 * ```
 *
 * Supported grammar, matching `patch_fromText` exactly:
 *
 * - Hunk header `@@ -start1[,length1] +start2[,length2] @@`. Following upstream,
 *   an omitted length means `1` and the start is 1-based; an explicit length of
 *   `0` means an insertion point and the start is 0-based.
 * - **Every number in that header counts UTF-8 bytes, not UTF-16 code units.**
 *   See "Coordinates are bytes" below — this is the single most load-bearing
 *   fact about the format, and reading them as JavaScript string indices breaks
 *   every edit containing a non-ASCII character.
 * - Body lines prefixed ` ` (equality/context), `-` (deletion) and `+`
 *   (insertion). Line payloads are `encodeURI`-encoded with `%20` written back as
 *   a literal space, so they are read with `decodeURI`.
 * - Blank lines between hunks are ignored (upstream does the same).
 * - Multiple hunks in one patch string, applied left to right with a running
 *   offset.
 *
 * ## Coordinates are bytes
 *
 * `patch_toText` writes `utf8Start1`/`utf8Length1`/`utf8Start2`/`utf8Length2`,
 * all measured in UTF-8 bytes; `patch_fromText` reads them back the same way and
 * converts to UTF-16 indices against the target string. JavaScript string
 * indices are UTF-16 code units, and the two numbers coincide only for ASCII —
 * which is why a suite full of ASCII fixtures can pass while every em dash,
 * curly apostrophe, accented letter, CJK character and emoji fails in
 * production. This module therefore keeps {@link DiffMatchPatchHunk} in the
 * byte domain and crosses into UTF-16 exactly once, in
 * {@link byteOffsetToIndex}.
 *
 * Two subtleties worth stating, because both are silent when wrong:
 *
 * 1. **Astral characters have three different counts.** `"🎉"` is one code
 *    point, two UTF-16 code units, and four true UTF-8 bytes — but
 *    diff-match-patch's own `countUtf8Bytes` walks *code units* and asks
 *    `codePointAt` at each, charging 4 for the lead surrogate and a further 3
 *    for the trailing one: **7**. `patch_make` and `patch_fromText` apply that
 *    convention symmetrically, so 7 is what the wire format means and what
 *    {@link byteLength} reproduces. A `TextEncoder` would disagree and reject
 *    every valid patch containing an emoji.
 * 2. **Starts are rolling, not absolute.** `patch_make` resets its running
 *    counters to the post-patch text after each hunk, so hunk *n*'s start is an
 *    offset into the text as already modified by hunks `0…n-1` — exactly what
 *    upstream `patch_apply` assumes when it uses `start2` directly. Adding a
 *    running delta on top of it double-counts and lands later hunks past their
 *    context.
 *
 * ## What this deliberately does not implement
 *
 * Application is **exact**, never fuzzy. Upstream `patch_apply` falls back to a
 * Bitap `match_main` search with `Match_Distance`/`Match_Threshold` heuristics and
 * a `patch_splitMax`/`patch_addPadding` re-alignment pass when the context does
 * not sit at `start1`. Those heuristics can relocate a hunk and produce a
 * plausible-but-wrong string. PRD §17.9 makes the resulting string the stored
 * value, so a wrong application is unrecoverable — this module therefore throws
 * {@link OverlayDiffMatchPatchError} rather than guessing. Specifically it throws on:
 *
 * | Condition | code |
 * |---|---|
 * | Malformed or missing hunk header, body line with an unknown prefix, body line before any header | `OVERLAY_DMP_PATCH_INVALID` |
 * | Malformed percent-escape in a body line | `OVERLAY_DMP_PATCH_INVALID` |
 * | Hunk `length1` disagreeing with the byte length of the context+deletion payload it declares | `OVERLAY_DMP_PATCH_INVALID` |
 * | Unidiff file headers (`--- a`, `+++ b`), `\ No newline at end of file`, or any other non-`@@` framing | `OVERLAY_DMP_PATCH_UNSUPPORTED` |
 * | Hunk start beyond the end of the target text, a start that falls strictly inside a character, or context that does not match the target exactly there | `OVERLAY_DMP_CONTEXT_MISMATCH` |
 *
 * A caller that needs fuzzy application must supply the already-resolved string
 * with `set` instead; §17.9 already forbids replaying a diff against a later base.
 */
import {OverlayDiffMatchPatchError} from '../errors'
import {utf8CodePointLength} from '../utf8'

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/

export type DiffOp = 'equal' | 'delete' | 'insert'

export interface DiffMatchPatchHunk {
  /** 0-based **UTF-8 byte** offset into the source text. */
  start1: number
  /** Byte length of this hunk's context and deletions. */
  length1: number
  /** 0-based **UTF-8 byte** offset into the destination text. */
  start2: number
  /** Byte length of this hunk's context and insertions. */
  length2: number
  diffs: {op: DiffOp; text: string}[]
}

/**
 * Byte length of `text` in the accounting `patch_toText` uses for the numbers it
 * writes into a hunk header: one contribution per UTF-16 code unit, sized by the
 * code point starting at that unit.
 *
 * For everything in the BMP this is the true UTF-8 length. For an astral
 * character it is not — the lead surrogate is charged the code point's 4 bytes
 * and the trailing surrogate a further 3 — but `patch_make` and `patch_fromText`
 * both count that way, so it is the definition the wire format carries. See the
 * module comment.
 */
function byteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    bytes += utf8CodePointLength(text.codePointAt(index)!)
  }
  return bytes
}

/**
 * Map a hunk's byte offset onto a UTF-16 index in `text`, using the same
 * accounting as {@link byteLength}.
 *
 * Returns `-1` when the offset runs past the end of `text` or falls strictly
 * inside a character — neither can be applied exactly, so the caller reports a
 * context mismatch rather than rounding to a nearby index.
 */
function byteOffsetToIndex(text: string, byteOffset: number): number {
  if (byteOffset < 0) return -1
  let bytes = 0
  let index = 0
  while (index < text.length && bytes < byteOffset) {
    bytes += utf8CodePointLength(text.codePointAt(index)!)
    index += 1
  }
  return bytes === byteOffset ? index : -1
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new OverlayDiffMatchPatchError('OVERLAY_DMP_PATCH_INVALID', message, details)
}

function unsupported(message: string, details: Record<string, unknown> = {}): never {
  throw new OverlayDiffMatchPatchError('OVERLAY_DMP_PATCH_UNSUPPORTED', message, details)
}

function decodeLine(payload: string, line: string): string {
  try {
    return decodeURI(payload)
  } catch {
    return invalid(`Invalid percent-escape in diff-match-patch line ${JSON.stringify(line)}`, {
      line,
    })
  }
}

/**
 * Parse `patch_toText` output into hunks. Coordinate handling mirrors upstream
 * `patch_fromText`: an omitted length is `1` with a 1-based start, an explicit
 * `0` length keeps the start as written.
 */
export function parseDiffMatchPatch(patchText: string): DiffMatchPatchHunk[] {
  if (typeof patchText !== 'string') {
    return invalid('diffMatchPatch patch must be a string', {received: typeof patchText})
  }
  if (patchText.length === 0) return []

  const lines = patchText.split('\n')
  const hunks: DiffMatchPatchHunk[] = []
  let current: DiffMatchPatchHunk | null = null

  for (const line of lines) {
    if (line.length === 0) continue

    if (line.startsWith('@@')) {
      const match = HEADER.exec(line)
      if (!match) return invalid(`Malformed hunk header ${JSON.stringify(line)}`, {line})
      const [, rawStart1, rawLength1, rawStart2, rawLength2] = match
      const coords = (rawStart: string, rawLength: string | undefined) => {
        if (rawLength === undefined) return {start: Number(rawStart) - 1, length: 1}
        if (rawLength === '0') return {start: Number(rawStart), length: 0}
        return {start: Number(rawStart) - 1, length: Number(rawLength)}
      }
      const one = coords(rawStart1!, rawLength1)
      const two = coords(rawStart2!, rawLength2)
      if (one.start < 0 || two.start < 0) {
        return invalid(`Hunk header ${JSON.stringify(line)} has a negative start offset`, {line})
      }
      current = {
        start1: one.start,
        length1: one.length,
        start2: two.start,
        length2: two.length,
        diffs: [],
      }
      hunks.push(current)
      continue
    }

    if (line.startsWith('---') || line.startsWith('+++')) {
      return unsupported(
        `Unified-diff file headers are not part of the diff-match-patch patch format (${JSON.stringify(
          line,
        )})`,
        {line},
      )
    }
    if (line.startsWith('\\')) {
      return unsupported(`"\\ No newline" markers are not supported (${JSON.stringify(line)})`, {
        line,
      })
    }

    if (current === null) {
      return invalid(`Patch body line ${JSON.stringify(line)} appears before any hunk header`, {
        line,
      })
    }

    const prefix = line[0]!
    const payload = decodeLine(line.slice(1), line)
    if (prefix === ' ') current.diffs.push({op: 'equal', text: payload})
    else if (prefix === '-') current.diffs.push({op: 'delete', text: payload})
    else if (prefix === '+') current.diffs.push({op: 'insert', text: payload})
    else {
      return invalid(
        `Unknown patch line prefix ${JSON.stringify(prefix)} in ${JSON.stringify(line)}`,
        {line, prefix},
      )
    }
  }

  for (const hunk of hunks) {
    const sourceBytes = byteLength(sourceText(hunk))
    if (sourceBytes !== hunk.length1) {
      return invalid(
        `Hunk declares length1 ${hunk.length1} but its context and deletions total ${sourceBytes} UTF-8 bytes`,
        {declared: hunk.length1, actual: sourceBytes},
      )
    }
    const destinationBytes = byteLength(destinationText(hunk))
    if (destinationBytes !== hunk.length2) {
      return invalid(
        `Hunk declares length2 ${hunk.length2} but its context and insertions total ${destinationBytes} UTF-8 bytes`,
        {declared: hunk.length2, actual: destinationBytes},
      )
    }
  }

  return hunks
}

function sourceText(hunk: DiffMatchPatchHunk): string {
  return hunk.diffs
    .filter((diff) => diff.op !== 'insert')
    .map((diff) => diff.text)
    .join('')
}

function destinationText(hunk: DiffMatchPatchHunk): string {
  return hunk.diffs
    .filter((diff) => diff.op !== 'delete')
    .map((diff) => diff.text)
    .join('')
}

/**
 * Apply a `diff-match-patch` patch string to `text`, exactly.
 *
 * Each hunk's `start2` is a UTF-8 byte offset into the text as the earlier hunks
 * left it (the format's rolling coordinates — see the module comment), so it is
 * translated to a UTF-16 index against the running result and no separate delta
 * is carried. The source text must then match there exactly; anything else
 * throws — see the module comment for the full table.
 */
export function applyDiffMatchPatch(text: string, patchText: string): string {
  if (typeof text !== 'string') {
    return invalid('diffMatchPatch target must be a string', {received: typeof text})
  }

  const hunks = parseDiffMatchPatch(patchText)
  let result = text

  for (const hunk of hunks) {
    const expected = sourceText(hunk)
    const start = byteOffsetToIndex(result, hunk.start2)
    if (start < 0) {
      throw new OverlayDiffMatchPatchError(
        'OVERLAY_DMP_CONTEXT_MISMATCH',
        `Hunk starts at byte ${hunk.start2}, which is not a character boundary within the target text of ${byteLength(result)} bytes`,
        {startByte: hunk.start2, textBytes: byteLength(result)},
      )
    }
    const actual = result.slice(start, start + expected.length)
    if (actual !== expected) {
      throw new OverlayDiffMatchPatchError(
        'OVERLAY_DMP_CONTEXT_MISMATCH',
        `diffMatchPatch context does not match the target text at offset ${start}; exact application only, no fuzzy matching (PRD §17.9)`,
        {offset: start, expected, actual},
      )
    }
    result = result.slice(0, start) + destinationText(hunk) + result.slice(start + expected.length)
  }

  return result
}
