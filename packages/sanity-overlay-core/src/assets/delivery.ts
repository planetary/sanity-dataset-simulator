/**
 * PRD §24.3 step 7 / §24.7 — "preview URL routes through local asset endpoint".
 *
 * ## There are two delivery shapes, not one, and the reason is not a choice
 *
 * **(a) The document route.** `sanity.imageAsset.url` /
 * `sanity.fileAsset.url` — read by GROQ projections (`asset->url`), by Studio's
 * file input download link, and by any front-end that dereferences the asset.
 * PRD §24.7 fixes it at `/api/sanity-overlay/assets/<assetDocumentId>`.
 *
 * **(b) The image-pipeline route.** Studio's image *preview* never reads the
 * `url` field. `sanity@6.8.0` renders it with
 * `imageUrlBuilder.image(value.asset).url()`, and `@sanity/image-url@2.1.1`
 * builds that string from the asset ID with no network read and no reference to
 * the asset document at all:
 *
 * ```js
 * // @sanity/image-url@2.1.1, lib/_chunks-es/compat.js
 * const cdnUrl = (spec.baseUrl || 'https://cdn.sanity.io').replace(/\/+$/, '')
 * const filename = `${spec.asset.id}-${spec.asset.width}x${spec.asset.height}.${spec.asset.format}`
 * baseUrl = `${cdnUrl}/images/${spec.projectId}/${spec.dataset}/${filename}`
 * ```
 *
 * with `baseUrl` derived from the client's own config:
 *
 * ```js
 * baseUrl: (apiHost || 'https://api.sanity.io').replace(/^https:\/\/api\./, 'https://cdn.')
 * ```
 *
 * So a branch image renders in Studio if and only if something answers a GET at
 * `<cdn-ified apiHost>/images/<projectId>/<dataset>/<sha1>-<w>x<h>.<ext>`. That is
 * a fact about the installed package, not a design preference — which is why
 * both route shapes are defined here and both are part of the interface the
 * overlay API server must implement.
 *
 * §24.8 still holds: the query string `@sanity/image-url` appends (`w`, `h`,
 * `fit`, `dpr`, `auto=format`, `rect`, …) describes transformations no local
 * server performs. A conforming responder serves the **original bytes** and says
 * so; it must not pretend the transformation was applied.
 *
 * Everything in this file is pure string work. Serving the bytes belongs to the
 * adapter (`sanity-overlay-client`) and, in the kitchen-sink topology, to the
 * overlay API server.
 */
import {OVERLAY_ASSET_BASE_PATH} from './document'
import {isOverlayAssetDocumentId, parseOverlayAssetDocumentId} from './identity'

/** A resolved delivery request: which asset, and whether transformations were asked for. */
export interface OverlayAssetDeliveryRequest {
  assetDocumentId: string
  /**
   * `document` = the §24.7 route; `image-pipeline` = the `@sanity/image-url`
   * shape; `file-pipeline` = the same idea for a `sanity.fileAsset`, whose
   * hosted URL is `<cdn>/files/<projectId>/<dataset>/<sha1>.<ext>`.
   */
  route: 'document' | 'image-pipeline' | 'file-pipeline'
  /**
   * Present for `image-pipeline` requests that carried transformation parameters.
   * A conforming responder ignores them and serves the original bytes (§24.8).
   */
  unsupportedTransformParams: readonly string[]
}

function pathnameAndQuery(url: string): [string, string] {
  const hash = url.indexOf('#')
  const withoutHash = hash < 0 ? url : url.slice(0, hash)
  const question = withoutHash.indexOf('?')
  return question < 0
    ? [withoutHash, '']
    : [withoutHash.slice(0, question), withoutHash.slice(question + 1)]
}

function queryKeys(query: string): string[] {
  if (query === '') return []
  const keys: string[] = []
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const key = pair.split('=')[0]
    if (key !== '' && !keys.includes(key)) keys.push(key)
  }
  return keys.sort()
}

/**
 * Route (a): `<basePath>/<assetDocumentId>`.
 *
 * Traversal is impossible rather than filtered: the last segment has to satisfy
 * {@link isOverlayAssetDocumentId}, whose pattern admits no `/`, no `.` and no
 * `%`, so `..%2f` and friends are rejected as *not an asset ID* before any path
 * is assembled.
 */
export function parseOverlayAssetDeliveryPath(
  url: string,
  basePath: string = OVERLAY_ASSET_BASE_PATH,
): OverlayAssetDeliveryRequest | null {
  const [pathname] = pathnameAndQuery(url)
  const prefix = `${basePath.replace(/\/+$/, '')}/`
  if (!pathname.startsWith(prefix)) return null
  const candidate = pathname.slice(prefix.length)
  if (!isOverlayAssetDocumentId(candidate)) return null
  return {assetDocumentId: candidate, route: 'document', unsupportedTransformParams: []}
}

/**
 * The `@sanity/image-url` filename for an asset ID: `<sha1>-<w>x<h>.<ext>`.
 *
 * Note the separator flip — the ID's last `-` becomes a `.` — which is exactly
 * what `specToImageUrl` does, and why this is derived rather than string-formatted
 * by hand elsewhere.
 */
export function overlayImageFilename(assetDocumentId: string): string | null {
  const parsed = parseOverlayAssetDocumentId(assetDocumentId)
  if (parsed === null || parsed.kind !== 'image') return null
  return `${parsed.sha1}-${parsed.width}x${parsed.height}.${parsed.extension}`
}

/** Route (b), rendered: `/images/<projectId>/<dataset>/<sha1>-<w>x<h>.<ext>`. */
export function overlayImageDeliveryPath(
  assetDocumentId: string,
  projectId: string,
  dataset: string,
): string | null {
  const filename = overlayImageFilename(assetDocumentId)
  if (filename === null) return null
  return `/images/${projectId}/${dataset}/${filename}`
}

const IMAGE_ROUTE_RE = /^\/images\/([^/]+)\/([^/]+)\/([a-f0-9]{40})-(\d+)x(\d+)\.([a-z0-9]+)$/

/** Route (b), parsed. Returns the asset ID `@sanity/image-url` was addressing. */
export function parseOverlayImageDeliveryPath(url: string): OverlayAssetDeliveryRequest | null {
  const [pathname, query] = pathnameAndQuery(url)
  const match = IMAGE_ROUTE_RE.exec(pathname)
  if (match === null) return null
  return {
    assetDocumentId: `image-${match[3]}-${match[4]}x${match[5]}-${match[6]}`,
    route: 'image-pipeline',
    unsupportedTransformParams: queryKeys(query),
  }
}

/**
 * The `sanity.fileAsset` sibling of route (b).
 *
 * A hosted file asset's `url` is `<cdn>/files/<projectId>/<dataset>/<sha1>.<ext>`
 * — the same construction as the image route with the `<w>x<h>` segment absent,
 * because a file has no dimensions. It is parsed here for the same reason the
 * image route is: an overlay asset ID is recoverable from the path exactly, so a
 * front end that built the URL from Sanity's own convention still reaches the
 * bytes. Query parameters carry no meaning on this route and are reported as
 * unsupported, exactly as they are for images (§24.8).
 */
const FILE_ROUTE_RE = /^\/files\/([^/]+)\/([^/]+)\/([a-f0-9]{40})\.([a-z0-9]+)$/

/** Route (c), rendered: `/files/<projectId>/<dataset>/<sha1>.<ext>`. */
export function overlayFileDeliveryPath(
  assetDocumentId: string,
  projectId: string,
  dataset: string,
): string | null {
  const parsed = parseOverlayAssetDocumentId(assetDocumentId)
  if (parsed === null || parsed.kind !== 'file') return null
  return `/files/${projectId}/${dataset}/${parsed.sha1}.${parsed.extension}`
}

/** Route (c), parsed. Returns the `file-…` asset ID the path addresses. */
export function parseOverlayFileDeliveryPath(url: string): OverlayAssetDeliveryRequest | null {
  const [pathname, query] = pathnameAndQuery(url)
  const match = FILE_ROUTE_RE.exec(pathname)
  if (match === null) return null
  return {
    assetDocumentId: `file-${match[3]}-${match[4]}`,
    route: 'file-pipeline',
    unsupportedTransformParams: queryKeys(query),
  }
}

/** Every delivery shape, for a server that mounts one handler for all (§24.7). */
export function parseOverlayAssetRequest(
  url: string,
  basePath: string = OVERLAY_ASSET_BASE_PATH,
): OverlayAssetDeliveryRequest | null {
  return (
    parseOverlayAssetDeliveryPath(url, basePath) ??
    parseOverlayImageDeliveryPath(url) ??
    parseOverlayFileDeliveryPath(url)
  )
}
