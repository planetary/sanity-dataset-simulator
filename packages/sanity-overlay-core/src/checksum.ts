/**
 * Checksums and synthetic revisions (PRD §13.2, §13.9, §14.3, §34.4).
 *
 * PRD §13.2 (v1.1): every checksum field in the data model — `OverlayDocumentHead.checksum`,
 * `BaseDocumentVersion.checksum`, `OverlayTransactionRecord.resultChecksums`,
 * `CheckpointDocumentIntent.checksum` and content-addressed snapshot filenames
 * (§14.1 `snapshots/<sha256>.json`) — is SHA-256 over the canonical JSON
 * serialization (§14.3 rules), hex encoded. `documentChecksumPrefix` is the first
 * twelve hex characters of that checksum (§13.9).
 *
 * SHA-256 is implemented here in pure TypeScript: core takes no dependency
 * (plan §3) and must run unchanged in Node and the browser, so neither
 * `node:crypto` nor the async `SubtleCrypto` API is usable.
 */
import {OverlayError} from './errors'
import {serialize} from './serialize'
import type {OverlayIdentityInput} from './types/identity'
import {utf8Encode} from './utf8'

/* ------------------------------------------------------------------ *
 * SHA-256 (FIPS 180-4)
 * ------------------------------------------------------------------ */

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const HEX = '0123456789abcdef'

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** SHA-256 digest of raw bytes. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  // Initial hash values: fractional parts of the square roots of the first 8 primes.
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const bitLength = input.length * 8
  // message + 0x80 + zero padding + 8-byte big-endian bit length, to a 64-byte
  // multiple: ceil((length + 9) / 64) * 64
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6
  const message = new Uint8Array(paddedLength)
  message.set(input)
  message[input.length] = 0x80

  // Length is written as a 64-bit big-endian integer. Lengths beyond 2^53 bits
  // are not reachable from a JavaScript string or array buffer.
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

  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        ((message[j]! << 24) | (message[j + 1]! << 16) | (message[j + 2]! << 8) | message[j + 3]!) >>>
        0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const digest = new Uint8Array(32)
  const words = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i++) {
    const word = words[i]!
    digest[i * 4] = (word >>> 24) & 0xff
    digest[i * 4 + 1] = (word >>> 16) & 0xff
    digest[i * 4 + 2] = (word >>> 8) & 0xff
    digest[i * 4 + 3] = word & 0xff
  }
  return digest
}

/** Lowercase hex encoding of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf]! + HEX[byte & 0xf]!
  }
  return out
}

/** SHA-256 of a string (UTF-8) or byte array, hex encoded. */
export function sha256Hex(input: string | Uint8Array): string {
  return toHex(sha256Bytes(typeof input === 'string' ? utf8Encode(input) : input))
}

/* ------------------------------------------------------------------ *
 * Data-model checksums (PRD §13.2)
 * ------------------------------------------------------------------ */

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const CHECKSUM_PREFIX_LENGTH = 12

/** SHA-256, hex encoded, over the canonical serialization of `value` (PRD §13.2). */
export function checksum(value: unknown): string {
  return sha256Hex(serialize(value))
}

/** Alias of {@link checksum}, named for the §14.3 "recompute checksum" rule. */
export const recomputeChecksum = checksum

/** True when `expected` matches the recomputed checksum of `value` (invariant §34.4). */
export function verifyChecksum(value: unknown, expected: string): boolean {
  return checksum(value) === expected.toLowerCase()
}

/** True when `candidate` is a well-formed lowercase hex SHA-256 digest. */
export function isChecksum(candidate: string): boolean {
  return CHECKSUM_PATTERN.test(candidate)
}

/**
 * First twelve hex characters of a checksum — the `documentChecksumPrefix` used
 * in synthetic revisions (PRD §13.2, §13.9).
 */
export function documentChecksumPrefix(value: string): string {
  if (!isChecksum(value)) {
    throw new OverlayError(
      'OVERLAY_CHECKSUM_INVALID',
      `Expected a 64-character lowercase hex SHA-256 checksum, received ${JSON.stringify(value)}`,
      {received: value},
    )
  }
  return value.slice(0, CHECKSUM_PREFIX_LENGTH)
}

/* ------------------------------------------------------------------ *
 * Synthetic revisions (PRD §13.9)
 * ------------------------------------------------------------------ */

/** Prefix marking a revision as overlay-synthetic, never a Content Lake revision. */
export const SYNTHETIC_REV_PREFIX = 'overlay.'

const SYNTHETIC_REV_PATTERN = /^overlay\.([^.]+)\.([0-9a-f]{12})$/

/**
 * Format the synthetic `_rev` value `overlay.<overlayRevision>.<documentChecksumPrefix>`
 * (PRD §13.9). `overlayRevision` must not contain a dot, so the form stays parseable.
 */
export function syntheticRev(overlayRevision: string | number, documentChecksum: string): string {
  const revision = String(overlayRevision)
  if (revision.length === 0 || revision.includes('.')) {
    throw new OverlayError(
      'OVERLAY_CHECKSUM_INVALID',
      `Overlay revision ${JSON.stringify(revision)} must be non-empty and contain no dot`,
      {overlayRevision: revision},
    )
  }
  return `${SYNTHETIC_REV_PREFIX}${revision}.${documentChecksumPrefix(documentChecksum)}`
}

export interface ParsedSyntheticRev {
  overlayRevision: string
  documentChecksumPrefix: string
}

/**
 * Guard for PRD §13.9 "Code must not assume synthetic `_rev` values are valid
 * Content Lake revisions".
 */
export function isSyntheticRev(rev: string | undefined | null): boolean {
  return typeof rev === 'string' && SYNTHETIC_REV_PATTERN.test(rev)
}

/** Parse a synthetic `_rev`, or return `null` when it is not one. */
export function parseSyntheticRev(rev: string): ParsedSyntheticRev | null {
  const match = SYNTHETIC_REV_PATTERN.exec(rev)
  if (!match) return null
  return {overlayRevision: match[1]!, documentChecksumPrefix: match[2]!}
}

/**
 * Throw when a synthetic revision is about to be used where a Content Lake
 * revision is required (PRD §13.9).
 */
export function assertContentLakeRevision(rev: string, context = 'revision'): void {
  if (isSyntheticRev(rev)) {
    throw new OverlayError(
      'OVERLAY_CHECKSUM_INVALID',
      `Synthetic overlay revision ${JSON.stringify(rev)} is not a valid Content Lake ${context}`,
      {rev, context},
    )
  }
}

/* ------------------------------------------------------------------ *
 * Overlay identity (PRD §12.1)
 * ------------------------------------------------------------------ */

const OVERLAY_ID_LENGTH = 32

/**
 * `sha256(canonical-json-input).slice(0, 32)` (PRD §12.1). The canonical
 * serializer built here is the one that hashes the identity input, so the ID is
 * insensitive to key insertion order in the caller's object.
 */
export function overlayIdFromIdentityInput(input: OverlayIdentityInput): string {
  return checksum(input).slice(0, OVERLAY_ID_LENGTH)
}
