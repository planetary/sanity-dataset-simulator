/**
 * PRD §24.3 steps 1-5 — the upload, as a pure plan.
 *
 * `planAssetUpload` is a function of the bytes and nothing else: it validates,
 * probes, hashes on both axes, mints the ID, builds the §24.2 record and renders
 * the §24.3 step-5 document. It performs no I/O, so the same plan is executed by
 * the filesystem provider today and by the private-Blob provider later (§24.4)
 * without either of them re-deciding what an asset *is*.
 *
 * ## The two digests, and why "uploaded twice" collapses
 *
 * - **SHA-256** addresses the bytes on disk (`checksum`, `storageRef`) — PRD
 *   §13.2 / §14.1 content addressing.
 * - **SHA-1** addresses the *document* (`assetId`, `sha1hash`, and the digest
 *   segment of the ID) — forced by `@sanity/asset-utils`, see `identity.ts`.
 *
 * Both are functions of the same bytes, so uploading identical content twice
 * yields the same blob path *and* the same document ID, under any filename. The
 * second upload is a no-op that returns the first one's record: content
 * addressing, not a deduplication pass bolted on afterwards.
 *
 * ## What it refuses
 *
 * §24.5 requires size limits, MIME/extension validation and traversal-proof
 * filenames. The first two are parameters (a project decides its own policy); the
 * third is structural — the stored `originalFilename` is stripped to a basename
 * and the extension that ends up in the ID is `[a-z0-9]+`, which cannot express a
 * path. Type sniffing beats the declared `contentType`, so a `.jpg` name on PNG
 * bytes stores as PNG.
 */
import {sha256Hex} from '../checksum'
import {OVERLAY_FORMAT_VERSION} from '../types/format-version'
import type {OverlayActor} from '../types/actor'
import type {SanityDocument} from '../types/document'
import {OMITTED_ASSET_METADATA_FIELDS, synthesizeAssetDocument} from './document'
import {OverlayAssetError} from './errors'
import {overlayAssetDocumentId} from './identity'
import {probeBinary} from './probe'
import {sha1Hex} from './sha1'
import type {
  OverlayAssetProvider,
  OverlayAssetRecord,
  OverlayBinaryProbe,
} from './types'

/** Overlay-relative directory the content-addressed blobs live in (PRD §14.1 `assets/`). */
export const OVERLAY_ASSET_BLOBS_PREFIX = 'assets/blobs'

/**
 * Default ceiling, 20 MiB.
 *
 * Deliberately conservative and deliberately overridable: §24.5 says "enforce
 * size limits" without naming one, and the checkpoint question (PRD §29 — how
 * large a binary may travel in a reviewable branch) is unresolved. A bound that
 * is easy to raise is safer than no bound.
 */
export const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024

/** `assets/blobs/<sha256>.bin` — the `storageRef` of a filesystem-provider asset. */
export function overlayAssetBlobRef(checksum: string): string {
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new OverlayAssetError(
      'OVERLAY_ASSET_REJECTED',
      `Blob ref requires a lowercase hex SHA-256, received ${JSON.stringify(checksum)}`,
      {checksum},
    )
  }
  return `${OVERLAY_ASSET_BLOBS_PREFIX}/${checksum}.bin`
}

export interface PlanAssetUploadInput {
  bytes: Uint8Array
  overlayId: string
  /** Injected clock value — core reads no wall clock (PRD §14.3 determinism). */
  createdAt: string
  filename?: string
  contentType?: string
  actor?: OverlayActor
  provider?: OverlayAssetProvider
  /** Defaults to {@link DEFAULT_MAX_ASSET_BYTES}. */
  maxBytes?: number
  /** When given, the sniffed MIME type must be a member (§24.5). */
  allowedContentTypes?: readonly string[]
  /** Mount point of the delivery route, for the document's `url` (§24.7). */
  basePath?: string
}

export interface AssetUploadPlan {
  record: OverlayAssetRecord
  /** The §24.3 step-5 document, ready to be `create`d in a transaction. */
  document: SanityDocument
  probe: OverlayBinaryProbe
  /** SHA-256 of the bytes — the blob's content address. */
  checksum: string
}

/**
 * §24.5 "prevent path traversal in filenames".
 *
 * The filename never reaches a path — the blob is addressed by digest — but it is
 * echoed to the UI and stored, so separators, control characters and `..` are
 * removed rather than trusted.
 */
export function sanitizeOriginalFilename(filename: string | undefined): string {
  if (typeof filename !== 'string') return ''
  const lastSeparator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const base = lastSeparator < 0 ? filename : filename.slice(lastSeparator + 1)
  /* C0 controls and DEL: bytes that turn a display string into a surprise. */
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '.' || cleaned === '..' ? '' : cleaned
}

function reject(message: string, details: Record<string, unknown>): never {
  throw new OverlayAssetError('OVERLAY_ASSET_REJECTED', message, details)
}

/** Validate, probe, hash and render — PRD §24.3 steps 2, 4 and 5. */
export function planAssetUpload(input: PlanAssetUploadInput): AssetUploadPlan {
  const {bytes} = input
  if (!(bytes instanceof Uint8Array)) {
    reject('Asset upload requires a Uint8Array of bytes', {})
  }
  if (bytes.length === 0) {
    reject('Refusing to store a zero-byte asset (PRD §24.3 step 2)', {
      size: 0,
    })
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ASSET_BYTES
  if (bytes.length > maxBytes) {
    reject(
      `Asset is ${bytes.length} bytes, over the ${maxBytes}-byte limit (PRD §24.5)`,
      {size: bytes.length, maxBytes},
    )
  }

  const originalFilename = sanitizeOriginalFilename(input.filename)
  const probe = probeBinary(bytes, {
    ...(originalFilename === '' ? {} : {filename: originalFilename}),
    ...(input.contentType === undefined ? {} : {contentType: input.contentType}),
  })

  if (
    input.allowedContentTypes !== undefined &&
    !input.allowedContentTypes.includes(probe.mimeType)
  ) {
    reject(
      `Content type ${JSON.stringify(probe.mimeType)} is not allowed (PRD §24.5)`,
      {mimeType: probe.mimeType, allowed: [...input.allowedContentTypes]},
    )
  }

  const checksum = sha256Hex(bytes)
  const sha1 = sha1Hex(bytes)

  /* Throws OVERLAY_ASSET_METADATA_UNAVAILABLE for an image whose container did
   * not state its dimensions. That refusal is the point: see `identity.ts`. */
  const assetDocumentId = overlayAssetDocumentId({
    kind: probe.kind,
    sha1,
    extension: probe.extension,
    dimensions: probe.dimensions,
  })

  /* Everything the hosted pipeline computes and this one does not, plus the one
   * container-declared field that this particular container withheld. */
  const omitted = [...OMITTED_ASSET_METADATA_FIELDS]
  if (probe.kind === 'image' && probe.hasAlpha === null) omitted.push('metadata.hasAlpha')
  omitted.sort()

  const record: OverlayAssetRecord = {
    formatVersion: OVERLAY_FORMAT_VERSION,
    overlayId: input.overlayId,
    assetDocumentId,
    assetId: sha1,
    kind: probe.kind,
    provider: input.provider ?? 'filesystem',
    storageRef: overlayAssetBlobRef(checksum),
    checksum,
    sha1hash: sha1,
    originalFilename:
      originalFilename === '' ? `${sha1}.${probe.extension}` : originalFilename,
    contentType: probe.mimeType,
    size: bytes.length,
    metadata: {
      extension: probe.extension,
      ...(probe.dimensions === null
        ? {}
        : {
            width: probe.dimensions.width,
            height: probe.dimensions.height,
            aspectRatio: probe.dimensions.aspectRatio,
          }),
      ...(probe.hasAlpha === null ? {} : {hasAlpha: probe.hasAlpha}),
      omitted,
    },
    createdAt: input.createdAt,
    ...(input.actor === undefined ? {} : {createdBy: input.actor}),
  }

  return {
    record,
    document: synthesizeAssetDocument(record, {
      ...(input.basePath === undefined ? {} : {basePath: input.basePath}),
    }),
    probe,
    checksum,
  }
}
