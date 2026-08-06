/**
 * SHA-1 (FIPS 180-4 §6.1), in pure TypeScript.
 *
 * **Why SHA-1 at all, when §13.2 standardises on SHA-256.** Nothing here is a
 * security claim. `@sanity/asset-utils@2.3.0` pins the shape of an asset document
 * ID to a 40-hex-character digest segment, and Sanity's own `sha1hash` field on
 * `sanity.imageAsset` holds exactly that value, so an overlay asset document that
 * wants to be parsed by the Sanity ecosystem has no choice of digest. A SHA-256
 * is 64 hex characters and fails the pattern outright.
 *
 * Content addressing on disk is a *separate* axis and stays on SHA-256
 * (`checksum`, PRD §13.2 / §14.1). Both digests are functions of the same bytes,
 * so "the same file uploaded twice" collapses on both at once.
 *
 * Pure, like {@link sha256Bytes}: core takes no dependency and must run unchanged
 * in Node and the browser, so neither `node:crypto` nor `SubtleCrypto` is usable.
 */

const HEX = '0123456789abcdef'

/** SHA-1 digest of raw bytes. */
export function sha1Bytes(input: Uint8Array): Uint8Array {
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const bitLength = input.length * 8
  /* message + 0x80 + zero padding + 8-byte big-endian bit length, to a 64-byte
   * multiple: ceil((length + 9) / 64) * 64 */
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6
  const message = new Uint8Array(paddedLength)
  message.set(input)
  message[input.length] = 0x80

  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  message[paddedLength - 8] = (high >>> 24) & 0xff
  message[paddedLength - 7] = (high >>> 16) & 0xff
  message[paddedLength - 6] = (high >>> 8) & 0xff
  message[paddedLength - 5] = high & 0xff
  message[paddedLength - 4] = (low >>> 24) & 0xff
  message[paddedLength - 3] = (low >>> 16) & 0xff
  message[paddedLength - 2] = (low >>> 8) & 0xff
  message[paddedLength - 1] = low & 0xff

  const w = new Uint32Array(80)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        (message[j] << 24) | (message[j + 1] << 16) | (message[j + 2] << 8) | message[j + 3]
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      /* Every term is a 32-bit quantity, so the five-way sum is at most
       * 5 * (2^32 - 1) — well inside the exactly-representable integer range —
       * and `>>> 0` reduces it modulo 2^32. */
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const digest = new Uint8Array(20)
  const words = [h0, h1, h2, h3, h4]
  for (let i = 0; i < 5; i++) {
    const word = words[i]
    digest[i * 4] = (word >>> 24) & 0xff
    digest[i * 4 + 1] = (word >>> 16) & 0xff
    digest[i * 4 + 2] = (word >>> 8) & 0xff
    digest[i * 4 + 3] = word & 0xff
  }
  return digest
}

/** Lowercase hex SHA-1 of raw bytes — the `sha1hash` field's exact encoding. */
export function sha1Hex(input: Uint8Array): string {
  const digest = sha1Bytes(input)
  let out = ''
  for (let i = 0; i < digest.length; i++) {
    out += HEX[digest[i] >> 4] + HEX[digest[i] & 0x0f]
  }
  return out
}
