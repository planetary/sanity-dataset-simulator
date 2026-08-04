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
 * - Body lines prefixed ` ` (equality/context), `-` (deletion) and `+`
 *   (insertion). Line payloads are `encodeURI`-encoded with `%20` written back as
 *   a literal space, so they are read with `decodeURI`.
 * - Blank lines between hunks are ignored (upstream does the same).
 * - Multiple hunks in one patch string, applied left to right with a running
 *   offset.
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
 * | Hunk `length1` disagreeing with the context+deletion payload it declares | `OVERLAY_DMP_PATCH_INVALID` |
 * | Unidiff file headers (`--- a`, `+++ b`), `\ No newline at end of file`, or any other non-`@@` framing | `OVERLAY_DMP_PATCH_UNSUPPORTED` |
 * | Hunk start beyond the end of the target text, or context that does not match the target byte-for-byte at `start1` | `OVERLAY_DMP_CONTEXT_MISMATCH` |
 *
 * A caller that needs fuzzy application must supply the already-resolved string
 * with `set` instead; §17.9 already forbids replaying a diff against a later base.
 */
import {OverlayDiffMatchPatchError} from '../errors'

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/

export type DiffOp = 'equal' | 'delete' | 'insert'

export interface DiffMatchPatchHunk {
  /** 0-based offset into the source text. */
  start1: number
  length1: number
  /** 0-based offset into the destination text. */
  start2: number
  length2: number
  diffs: {op: DiffOp; text: string}[]
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
    const source = sourceText(hunk)
    if (source.length !== hunk.length1) {
      return invalid(
        `Hunk declares length1 ${hunk.length1} but its context and deletions total ${source.length} characters`,
        {declared: hunk.length1, actual: source.length},
      )
    }
    const destination = destinationText(hunk)
    if (destination.length !== hunk.length2) {
      return invalid(
        `Hunk declares length2 ${hunk.length2} but its context and insertions total ${destination.length} characters`,
        {declared: hunk.length2, actual: destination.length},
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
 * Every hunk must match its declared source text at its declared offset (shifted
 * by the net length change of earlier hunks). Anything else throws — see the
 * module comment for the full table.
 */
export function applyDiffMatchPatch(text: string, patchText: string): string {
  if (typeof text !== 'string') {
    return invalid('diffMatchPatch target must be a string', {received: typeof text})
  }

  const hunks = parseDiffMatchPatch(patchText)
  let result = text
  let offset = 0

  for (const hunk of hunks) {
    const expected = sourceText(hunk)
    const start = hunk.start1 + offset
    if (start < 0 || start > result.length) {
      throw new OverlayDiffMatchPatchError(
        'OVERLAY_DMP_CONTEXT_MISMATCH',
        `Hunk start ${start} lies outside the target text of length ${result.length}`,
        {start, textLength: result.length},
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
    const replacement = destinationText(hunk)
    result = result.slice(0, start) + replacement + result.slice(start + expected.length)
    offset += replacement.length - expected.length
  }

  return result
}
