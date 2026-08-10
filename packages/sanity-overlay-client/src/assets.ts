/**
 * PRD §24.3 step 7 / §24.7 — serving branch asset bytes locally.
 *
 * ## The interface, and who is expected to mount it
 *
 * This is a *transport-neutral* responder: URL in, `{status, headers, body}` out,
 * or `null` when the URL is not an asset route so the host can fall through to its
 * own handler. It deliberately does not know about `node:http`, Next.js route
 * handlers or Express, because it has to work in all three — the kitchen-sink
 * overlay API server (`examples/kitchen-sink/spikeA/overlayServer.mjs`), a
 * consumer's `/api/sanity-overlay/assets/[id]` route, and the Track B proxy.
 *
 * ## Two routes, because `@sanity/image-url` gives no choice
 *
 * `parseOverlayAssetRequest` (core) accepts both shapes; see the long note in
 * `sanity-overlay-core/src/assets/delivery.ts` for the evidence. In summary:
 *
 * - `/api/sanity-overlay/assets/<assetDocumentId>` — the `url` field on the asset
 *   document. Everything that dereferences the asset uses this.
 * - `/images/<projectId>/<dataset>/<sha1>-<w>x<h>.<ext>` — the string
 *   `@sanity/image-url@2.1.1` constructs from the asset ID alone. Studio's image
 *   preview renders **only** if this answers, because the preview never reads the
 *   `url` field.
 *
 * ## Honesty about transformations
 *
 * §24.8: branch assets get no Sanity image pipeline. When a request carries
 * transformation parameters (`w`, `h`, `fit`, `dpr`, `auto`, `rect`, …) the
 * original bytes are served and the response *says so* in
 * `x-overlay-asset-transform`. Silently returning an untransformed image under a
 * URL that asked for `w=100` is the failure mode this header exists to prevent.
 *
 * ## Not a Sanity read
 *
 * Every byte comes from the injected source (the filesystem asset store today,
 * private Vercel Blob in the §24.4 design). Nothing here opens a socket, so the
 * suite-wide outbound monitor and `stagingHost.ts` have nothing to refuse.
 */
import {parseOverlayAssetRequest} from 'sanity-overlay-core'
import type {OverlayAssetRecord} from 'sanity-overlay-core'

/** The provider surface a responder needs — implemented by `FsOverlayAssetStore`. */
export interface OverlayAssetSource {
  getRecord(assetDocumentId: string): Promise<OverlayAssetRecord | null>
  readBlob(assetDocumentId: string, options?: {verify?: boolean}): Promise<Uint8Array>
}

/** Minimal request shape: everything a host framework can supply trivially. */
export interface OverlayAssetDeliveryRequestInit {
  /** Defaults to `GET`. */
  method?: string
  /** Path with optional query string, or an absolute URL. */
  url: string
}

export interface OverlayAssetDeliveryResponse {
  status: number
  headers: Record<string, string>
  /** `null` for `HEAD` and for error statuses. */
  body: Uint8Array | null
}

export interface CreateOverlayAssetDeliveryOptions {
  source: OverlayAssetSource
  /** Mount point of the document route. Defaults to PRD §24.7's path. */
  basePath?: string
  /** Re-hash bytes on every read. Correct but O(n); off by default. */
  verify?: boolean
  /**
   * `Cache-Control` for a hit. The default is safe *because* the URL is content
   * addressed: the digest is in the path, so the bytes at a given URL can never
   * change.
   */
  cacheControl?: string
}

const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const READ_METHODS = new Set(['GET', 'HEAD'])

function pathOf(url: string): string {
  /* Absolute URLs arrive from `request.url` in some frameworks; relative ones from
   * others. Neither is parsed with `new URL(url)` unguarded, because that throws
   * on a relative input. */
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      return `${parsed.pathname}${parsed.search}`
    } catch {
      return url
    }
  }
  return url
}

function errorResponse(status: number, reason: string): OverlayAssetDeliveryResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-overlay-asset': 'branch-only',
      'x-overlay-asset-error': reason,
    },
    body: null,
  }
}

/**
 * Build the responder.
 *
 * Returns `null` — not a 404 — for a URL that is not an asset route at all, so a
 * server can mount this ahead of its own routes without swallowing them.
 */
export function createOverlayAssetDelivery(
  options: CreateOverlayAssetDeliveryOptions,
): (
  request: OverlayAssetDeliveryRequestInit,
) => Promise<OverlayAssetDeliveryResponse | null> {
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL

  return async (request) => {
    const url = pathOf(request.url)
    const parsed =
      options.basePath === undefined
        ? parseOverlayAssetRequest(url)
        : parseOverlayAssetRequest(url, options.basePath)
    if (parsed === null) return null

    const method = (request.method ?? 'GET').toUpperCase()
    if (!READ_METHODS.has(method)) {
      /* Assets are immutable and content addressed; there is no write plane here,
       * and there is certainly no upload-to-Sanity plane (PRD §0.0). */
      return {
        status: 405,
        headers: {allow: 'GET, HEAD', 'x-overlay-asset': 'branch-only'},
        body: null,
      }
    }

    const record = await options.source.getRecord(parsed.assetDocumentId)
    if (record === null) return errorResponse(404, 'asset not found in this overlay')

    let bytes: Uint8Array
    try {
      bytes = await options.source.readBlob(parsed.assetDocumentId, {
        verify: options.verify === true,
      })
    } catch {
      /* A record with no readable blob is a broken overlay, not a missing asset;
       * 502 keeps those distinguishable in a log. */
      return errorResponse(502, 'asset record present but its bytes are unreadable')
    }

    const headers: Record<string, string> = {
      'content-type': record.contentType,
      'content-length': String(bytes.length),
      'cache-control': cacheControl,
      etag: `"${record.checksum}"`,
      'x-overlay-asset': 'branch-only',
      'x-overlay-asset-id': record.assetDocumentId,
    }

    /* §24.8, stated in the response rather than left to be discovered. */
    if (parsed.unsupportedTransformParams.length > 0) {
      headers['x-overlay-asset-transform'] = `not-applied; ${parsed.unsupportedTransformParams.join(
        ', ',
      )}`
    }

    return {status: 200, headers, body: method === 'HEAD' ? null : bytes}
  }
}
