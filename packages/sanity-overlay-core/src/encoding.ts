/**
 * Two distinct encoders (PRD §13.6, §14.3, §35.9; plan §4 "Define ID and path encoding").
 *
 * ## (a) `OverlayPath` canonical string form
 *
 * Grammar (all three segment kinds of §13.6 round-trip losslessly):
 *
 * ```text
 * path    := "$" segment*
 * segment := "." text          // string property
 *          | "[" digits "]"    // numeric array index (non-negative integer)
 *          | "[_key=" text "]" // keyed array item {_key: string}
 * text    := any characters, with \ . [ ] each escaped by a leading backslash
 * ```
 *
 * The leading `$` root marker is what makes the form unambiguous: the empty path
 * `[]` encodes as `"$"` while the single empty-string property `[""]` encodes as
 * `"$."`. Examples:
 *
 * ```text
 * []                                        -> "$"
 * ["title"]                                 -> "$.title"
 * ["hero", "heading"]                       -> "$.hero.heading"
 * ["sections", {_key: "section-a"}, "title"] -> "$.sections[_key=section-a].title"
 * ["items", 3]                              -> "$.items[3]"
 * ["a.b", "c[0]"]                           -> "$.a\.b.c\[0\]"
 * ```
 *
 * ## (b) Reversible, filesystem-safe logical-ID encoding
 *
 * Storage keys must survive dots and `drafts.` prefixes (§35.9 "File path encoding
 * handles IDs with dots and draft prefixes") and must not permit traversal
 * (§35.9 "Path traversal attempts fail"). The encoding keeps `[a-z0-9_-]`
 * literal and escapes every other byte as `~XX` (uppercase hex of the UTF-8
 * byte):
 *
 * ```text
 * "drafts.article-02" -> "drafts~2Earticle-02"
 * "legacy.page.v2"    -> "legacy~2Epage~2Ev2"
 * "../../etc/passwd"  -> "~2E~2E~2F~2E~2E~2Fetc~2Fpasswd"
 * ```
 *
 * Uppercase ASCII is escaped too, so two IDs differing only in case cannot
 * collide on a case-insensitive filesystem (APFS, NTFS). Windows reserved device
 * names are escaped in their first character. The result is never empty, never
 * `.`/`..`, contains no separator, and is length-checked against the 255-byte
 * filename limit rather than truncated, because truncation would not be reversible.
 */
import {OverlayEncodingError} from './errors'
import {isKeySegment, type OverlayPath, type OverlayPathSegment} from './types/path'
import {utf8Decode, utf8Encode} from './utf8'

/* ------------------------------------------------------------------ *
 * (a) OverlayPath
 * ------------------------------------------------------------------ */

export const OVERLAY_PATH_ROOT = '$'

const KEY_PREFIX = '_key='
const PATH_ESCAPE_PATTERN = /[\\.[\]]/g

function pathError(message: string, details: Record<string, unknown>): OverlayEncodingError {
  return new OverlayEncodingError('OVERLAY_PATH_ENCODING_INVALID', message, details)
}

function escapePathText(text: string): string {
  return text.replace(PATH_ESCAPE_PATTERN, (char) => `\\${char}`)
}

/** Encode an {@link OverlayPath} to its canonical string form. */
export function encodeOverlayPath(path: OverlayPath): string {
  let out = OVERLAY_PATH_ROOT
  path.forEach((segment, index) => {
    if (typeof segment === 'string') {
      out += `.${escapePathText(segment)}`
      return
    }
    if (typeof segment === 'number') {
      if (!Number.isInteger(segment) || segment < 0) {
        throw pathError(
          `Array index segment must be a non-negative integer, received ${String(segment)}`,
          {index, segment},
        )
      }
      out += `[${segment}]`
      return
    }
    if (isKeySegment(segment)) {
      out += `[${KEY_PREFIX}${escapePathText(segment._key)}]`
      return
    }
    throw pathError(`Unsupported path segment at index ${index}`, {index, segment})
  })
  return out
}

/** Read escaped text until `stop` (unescaped) or, when `stop` is null, until an unescaped `.` or `[`. */
function readEscaped(
  input: string,
  start: number,
  stop: string | null,
): {text: string; next: number} {
  let text = ''
  let i = start
  while (i < input.length) {
    const char = input[i]!
    if (char === '\\') {
      const escaped = input[i + 1]
      if (escaped === undefined) {
        throw pathError('Path ends with a dangling escape character', {input, position: i})
      }
      text += escaped
      i += 2
      continue
    }
    if (stop === null) {
      if (char === '.' || char === '[') break
    } else if (char === stop) {
      break
    }
    text += char
    i++
  }
  if (stop !== null && input[i] !== stop) {
    throw pathError(`Unterminated path segment, expected ${JSON.stringify(stop)}`, {
      input,
      position: i,
    })
  }
  return {text, next: i}
}

/** Decode a canonical path string back to an {@link OverlayPath}. */
export function decodeOverlayPath(encoded: string): OverlayPath {
  if (!encoded.startsWith(OVERLAY_PATH_ROOT)) {
    throw pathError(
      `Encoded path must start with ${JSON.stringify(OVERLAY_PATH_ROOT)}, received ${JSON.stringify(
        encoded,
      )}`,
      {input: encoded},
    )
  }

  const path: OverlayPathSegment[] = []
  let i = OVERLAY_PATH_ROOT.length

  while (i < encoded.length) {
    const char = encoded[i]!
    if (char === '.') {
      const {text, next} = readEscaped(encoded, i + 1, null)
      path.push(text)
      i = next
      continue
    }
    if (char === '[') {
      const {text, next} = readEscaped(encoded, i + 1, ']')
      if (text.startsWith(KEY_PREFIX)) {
        path.push({_key: text.slice(KEY_PREFIX.length)})
      } else if (/^\d+$/.test(text)) {
        path.push(Number(text))
      } else {
        throw pathError(`Invalid bracket segment ${JSON.stringify(text)}`, {
          input: encoded,
          segment: text,
        })
      }
      i = next + 1
      continue
    }
    throw pathError(`Unexpected character ${JSON.stringify(char)} at position ${i}`, {
      input: encoded,
      position: i,
    })
  }

  return path
}

/** Structural equality for two paths, independent of object identity. */
export function overlayPathEquals(a: OverlayPath, b: OverlayPath): boolean {
  return encodeOverlayPath(a) === encodeOverlayPath(b)
}

/* ------------------------------------------------------------------ *
 * (b) Logical document IDs
 * ------------------------------------------------------------------ */

/** Maximum encoded length; the common filesystem filename limit is 255 bytes. */
export const MAX_ENCODED_ID_LENGTH = 255

/** Escape character introducing a two-digit uppercase hex byte. */
export const ID_ESCAPE = '~'

const LITERAL_ID_CHARS = /^[a-z0-9_-]$/
const ESCAPE_HEX = /^[0-9A-F]{2}$/
/**
 * A storage key is a sequence of literal characters and `~XX` escapes. Escape
 * hex digits are uppercase, literals are lowercase, so no two distinct IDs can
 * produce names that differ only in case.
 */
const ENCODED_ID_PATTERN = /^(?:[a-z0-9_-]|~[0-9A-F]{2})+$/

// Windows reserved device names, compared case-insensitively. The encoder never
// emits uppercase, so a lowercase comparison is sufficient.
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

function idError(message: string, details: Record<string, unknown>): OverlayEncodingError {
  return new OverlayEncodingError('OVERLAY_ID_ENCODING_INVALID', message, details)
}

function escapeByte(byte: number): string {
  return ID_ESCAPE + byte.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * Encode a logical document ID as a reversible, filesystem-safe storage key
 * (PRD §14.3 "Encode document IDs safely and reversibly", §35.9).
 */
export function encodeLogicalId(logicalId: string): string {
  if (typeof logicalId !== 'string' || logicalId.length === 0) {
    throw idError('Logical document ID must be a non-empty string', {logicalId})
  }

  const bytes = utf8Encode(logicalId)
  let out = ''
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    out += byte < 0x80 && LITERAL_ID_CHARS.test(char) ? char : escapeByte(byte)
  }

  if (RESERVED_NAMES.has(out)) {
    // Escape the first character so the name is no longer reserved, reversibly.
    out = escapeByte(out.charCodeAt(0)) + out.slice(1)
  }

  if (out.length > MAX_ENCODED_ID_LENGTH) {
    throw idError(
      `Encoded logical ID is ${out.length} characters, exceeding the ${MAX_ENCODED_ID_LENGTH}-character filename limit`,
      {logicalId, encodedLength: out.length},
    )
  }

  return out
}

/** Decode a storage key produced by {@link encodeLogicalId}. */
export function decodeLogicalId(encoded: string): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw idError('Encoded logical ID must be a non-empty string', {encoded})
  }

  const bytes: number[] = []
  let i = 0
  while (i < encoded.length) {
    const char = encoded[i]!
    if (char === ID_ESCAPE) {
      const hex = encoded.slice(i + 1, i + 3)
      if (!ESCAPE_HEX.test(hex)) {
        throw idError(`Invalid escape sequence at position ${i}`, {encoded, position: i, hex})
      }
      bytes.push(parseInt(hex, 16))
      i += 3
      continue
    }
    if (!LITERAL_ID_CHARS.test(char)) {
      throw idError(
        `Encoded logical ID contains characters outside the safe alphabet at position ${i}`,
        {encoded, position: i, character: char},
      )
    }
    bytes.push(char.charCodeAt(0))
    i++
  }

  return utf8Decode(Uint8Array.from(bytes))
}

/** True when `name` is a storage key this encoder could have produced. */
export function isEncodedLogicalId(name: string): boolean {
  return ENCODED_ID_PATTERN.test(name) && name.length <= MAX_ENCODED_ID_LENGTH
}

/** The `drafts.` prefix Sanity uses for draft documents (PRD §13.9, §18.2). */
export const DRAFTS_PREFIX = 'drafts.'

/** Strip a `drafts.` prefix to get the published/logical ID form. */
export function toPublishedId(id: string): string {
  return id.startsWith(DRAFTS_PREFIX) ? id.slice(DRAFTS_PREFIX.length) : id
}

/** Add the `drafts.` prefix when it is not already present. */
export function toDraftId(id: string): string {
  return id.startsWith(DRAFTS_PREFIX) ? id : `${DRAFTS_PREFIX}${id}`
}

/** True when the ID carries the `drafts.` prefix. */
export function isDraftId(id: string): boolean {
  return id.startsWith(DRAFTS_PREFIX)
}
