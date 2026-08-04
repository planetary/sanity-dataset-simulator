/**
 * Dependency-free UTF-8 codec.
 *
 * Core must be Node-safe and browser-safe (plan §3) and must not take any
 * dependency, so encoding is implemented here rather than relying on
 * `TextEncoder` / `TextDecoder` or `Buffer` being present.
 */

/** Encode a JavaScript string to UTF-8 bytes. Lone surrogates become U+FFFD. */
export function utf8Encode(input: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    let codePoint = input.charCodeAt(i)

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
        i++
      } else {
        codePoint = 0xfffd
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd
    }

    if (codePoint < 0x80) {
      out.push(codePoint)
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/** Decode UTF-8 bytes to a JavaScript string. Invalid sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]!
    let codePoint: number
    let extra: number

    if (byte < 0x80) {
      codePoint = byte
      extra = 0
    } else if ((byte & 0xe0) === 0xc0) {
      codePoint = byte & 0x1f
      extra = 1
    } else if ((byte & 0xf0) === 0xe0) {
      codePoint = byte & 0x0f
      extra = 2
    } else if ((byte & 0xf8) === 0xf0) {
      codePoint = byte & 0x07
      extra = 3
    } else {
      out += '�'
      i++
      continue
    }

    if (i + extra >= bytes.length) {
      out += '�'
      break
    }

    let valid = true
    for (let k = 1; k <= extra; k++) {
      const cont = bytes[i + k]!
      if ((cont & 0xc0) !== 0x80) {
        valid = false
        break
      }
      codePoint = (codePoint << 6) | (cont & 0x3f)
    }

    if (!valid || codePoint > 0x10ffff) {
      out += '�'
      i++
      continue
    }

    i += extra + 1
    if (codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff))
    } else {
      out += String.fromCharCode(codePoint)
    }
  }
  return out
}
