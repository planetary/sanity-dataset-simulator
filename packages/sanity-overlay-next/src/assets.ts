/**
 * The asset half of the overlay HTTP API — PRD §24.3 steps 1-7, §24.5, §24.7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * `FsOverlayAssetStore` (storage), `core/assets` (identity, probing, the
 * synthetic document, delivery routing) and `createOverlayAssetDelivery`
 * (a transport-neutral responder) were all built and then reachable from
 * nothing. A Studio could not put an image into a branch, because no endpoint
 * accepted one and no endpoint served one back. This module is the missing
 * plumbing and owns no new semantics: every decision it needs was already made
 * by `planAssetUpload`, `overlayAssetDocumentId` and `parseOverlayAssetRequest`,
 * and it defers to them rather than re-deciding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE ROUTES, AND WHY THREE
 *
 *   POST <mount>/assets                                   upload
 *   GET  <mount>/assets/<assetDocumentId>                 the `url` field (§24.7)
 *   GET  /images/<projectId>/<dataset>/<sha1>-<w>x<h>.<ext>
 *   GET  /files/<projectId>/<dataset>/<sha1>.<ext>
 *
 * The last two are not a convenience. `@sanity/image-url@2.1.1` builds a
 * Studio's image preview `src` from the asset ID alone and never reads the
 * asset document's `url`, so a branch image renders if and only if something
 * answers at that shape. See `core/assets/delivery.ts` for the transcript of the
 * installed package that fixes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BASE FALLTHROUGH, AND WHY IT IS A REDIRECT
 *
 * §24.1 requires existing Sanity assets to keep working. Once a Studio's image
 * pipeline is pointed at this server (see `assetOriginFor` in the Studio
 * facade), it asks THIS server for base assets too — assets that live in Sanity
 * and that this overlay must never hold a copy of. Those are answered with a
 * `302` to Sanity's image CDN rather than proxied, for two reasons: proxying
 * would make every base image a round trip through a development server, and a
 * proxy that streams bytes from Sanity is a second, undeclared read path.
 *
 * IT IS NOT AN OPEN REDIRECT. The `Location` is rebuilt from scratch against a
 * fixed `https://cdn.sanity.io` origin using path segments that have already
 * satisfied {@link SEGMENT_RE}; nothing from the request supplies a host, a
 * scheme or an authority. A segment that is not a plain project/dataset name is
 * refused outright rather than escaped.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {parseOverlayAssetRequest} from '../../sanity-overlay-core/src/index'
import type {SanityDocument} from '../../sanity-overlay-core/src/index'
import type {FsOverlayAssetStore, PutAssetResult} from '../../sanity-overlay-store-fs/src/index'
import {createOverlayAssetDelivery} from '../../sanity-overlay-client/src/assets'
import {OverlayApiError} from './errors'

/** The mount-relative segment both the upload and the document route sit under. */
export const ASSET_ROUTE_SEGMENT = 'assets'

/**
 * The header an upload MUST carry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE CSRF CONTROL, AND IT IS DOING THE SAME JOB AS `content-type:
 * application/json` DOES FOR `/commit`.
 *
 * An upload's `Content-Type` is `image/png` — a value on the CORS-safelist. A
 * `POST` carrying it fires NO preflight, so without this header any page the
 * developer happened to have open could write bytes into the branch. A custom
 * header name is not safelisted, so requiring one forces a preflight, and the
 * preflight is answered by the origin allowlist, which grants nothing by
 * default. That closes the class rather than an instance: it does not matter
 * what the body or the content type is.
 *
 * Page JavaScript can of course SET this header on a same-origin XHR — that is
 * the point. What it cannot do is make the browser skip the preflight.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const ASSET_UPLOAD_HEADER = 'x-overlay-asset-upload'

/** Original filename, percent-encoded so a non-ASCII name survives a header. */
export const ASSET_FILENAME_HEADER = 'x-overlay-asset-filename'

/** Sanity's image/file CDN. Only ever a redirect target, never a request we make. */
export const SANITY_CDN_ORIGIN = 'https://cdn.sanity.io'

/** A project id or dataset name, as Sanity spells them. No separators, no escapes. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `/images/<pid>/<ds>/<file>` and `/files/<pid>/<ds>/<file>`, for the fallthrough. */
const CDN_ROUTE_RE = /^\/(images|files)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/

export interface OverlayAssetResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

export interface OverlayAssetEndpointsOptions {
  assetStore: FsOverlayAssetStore
  overlayId: string
  /** PRD §24.5 size ceiling. Defaults to core's `DEFAULT_MAX_ASSET_BYTES`. */
  maxBytes?: number
  /** PRD §24.5 MIME allow-list, matched against the SNIFFED type. */
  allowedContentTypes?: readonly string[]
}

/**
 * Where the delivery routes live, for THIS request.
 *
 * Derived from the request rather than configured, because the API cannot know
 * its own public URL: `startOverlayApiServer` binds an ephemeral port when asked
 * to, and an App Router mounting carries a prefix (`/api/sanity-overlay`) that a
 * bare dev server does not. Taking it from the request that is being answered
 * makes the `url` on every synthetic asset document correct in both mountings
 * with nothing to configure and nothing to keep in step.
 */
export function assetMountPath(request: Request): string {
  const segments = new URL(request.url).pathname
    .split('/')
    .filter((segment) => segment.length > 0)
  /* Drop everything from the `assets` segment onwards; whatever is left is the
   * mount point. `/assets` → ``; `/api/sanity-overlay/assets/<id>` →
   * `/api/sanity-overlay`. A request that names no `assets` segment is one of
   * the CDN-shaped routes, which are absolute by construction and never
   * compared against this prefix — the default keeps the shape well-formed. */
  const at = segments.lastIndexOf(ASSET_ROUTE_SEGMENT)
  if (at < 0) return `/${ASSET_ROUTE_SEGMENT}`
  const mount = segments.slice(0, at)
  return `${mount.length === 0 ? '' : `/${mount.join('/')}`}/${ASSET_ROUTE_SEGMENT}`
}

/** The same mount point, absolute — what a document's `url` must carry (§24.7). */
export function assetBasePathFor(request: Request): string {
  return `${new URL(request.url).origin}${assetMountPath(request)}`
}

/** Which asset route, if any, is this request addressing? */
export function assetRouteOf(
  request: Request,
): {kind: 'upload'} | {kind: 'deliver'} | {kind: 'cdn-fallthrough'} | null {
  const url = new URL(request.url)
  const segments = url.pathname.replace(/\/+$/, '').split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]

  if (last === ASSET_ROUTE_SEGMENT) return {kind: 'upload'}
  if (segments[segments.length - 2] === ASSET_ROUTE_SEGMENT) return {kind: 'deliver'}
  if (segments[0] === 'images' || segments[0] === 'files') {
    return CDN_ROUTE_RE.test(url.pathname) ? {kind: 'cdn-fallthrough'} : {kind: 'deliver'}
  }
  return null
}

/**
 * Store bytes and render the §24.3 step-5 document.
 *
 * Validation is `planAssetUpload`'s, inside the store, and it happens BEFORE any
 * filesystem work — so a refused upload leaves the store byte-for-byte as it
 * was. The refusal is re-thrown as an {@link OverlayApiError} carrying core's own
 * `OVERLAY_ASSET_*` code, because §24.6 requires upload and metadata-extraction
 * failures to be SHOWN, and a code the UI can branch on is the difference
 * between a message and a spinner.
 */
export async function putUploadedAsset(
  options: OverlayAssetEndpointsOptions,
  input: {bytes: Uint8Array; filename?: string; contentType?: string; actor?: unknown},
): Promise<PutAssetResult> {
  return options.assetStore.put({
    overlayId: options.overlayId,
    bytes: input.bytes,
    ...(input.filename === undefined || input.filename === ''
      ? {}
      : {filename: input.filename}),
    ...(input.contentType === undefined || input.contentType === ''
      ? {}
      : {contentType: input.contentType}),
    ...(input.actor === undefined ? {} : {actor: input.actor as never}),
  })
}

/** The filename the caller declared, or `undefined`. Never trusted as a path. */
export function uploadFilenameFrom(request: Request): string | undefined {
  const raw = request.headers.get(ASSET_FILENAME_HEADER)
  if (raw === null || raw === '') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    /* A malformed escape is a caller's bug, not a reason to lose the upload;
     * `sanitizeOriginalFilename` strips whatever survives. */
    return raw
  }
}

/**
 * PRD §25.1 for a request whose content type cannot carry the `/commit` control.
 * Same three clauses, one substituted — see {@link ASSET_UPLOAD_HEADER}.
 */
export function assertUploadIsNotForged(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): void {
  const forbidden = (): OverlayApiError =>
    new OverlayApiError(
      403,
      'FORBIDDEN_ORIGIN',
      `an asset upload must declare \`${ASSET_UPLOAD_HEADER}\`, which is what forces a CORS ` +
        'preflight and closes the forged simple-request path, and must be same-origin or from ' +
        'a configured `origins` entry',
    )

  if (request.headers.get(ASSET_UPLOAD_HEADER) === null) throw forbidden()
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw forbidden()

  const origin = request.headers.get('origin')
  if (origin === null) return
  if (allowedOrigins.has(origin) || allowedOrigins.has('*')) return
  if (request.headers.get('sec-fetch-site') === 'same-origin') return
  try {
    if (new URL(request.url).origin === origin) return
  } catch {
    /* An unparseable request URL cannot establish same-origin. */
  }
  throw forbidden()
}

/**
 * `302` to Sanity's CDN for an asset this overlay does not hold — §24.1.
 *
 * Returns `null` when the path is not a well-formed CDN route, so a malformed
 * one becomes a 404 rather than a redirect to a guessed location.
 */
export function cdnFallthroughLocation(request: Request): string | null {
  const url = new URL(request.url)
  const match = CDN_ROUTE_RE.exec(url.pathname)
  if (match === null) return null
  const [, kind, projectId, dataset, filename] = match
  /* Every segment is REBUILT from a value that matched a name pattern. Nothing
   * the caller sent can contribute a host, a scheme, an authority or a `..`. */
  for (const segment of [projectId, dataset, filename]) {
    if (!SEGMENT_RE.test(segment)) return null
  }
  return `${SANITY_CDN_ORIGIN}/${kind}/${projectId}/${dataset}/${filename}${url.search}`
}

/**
 * The delivery responder for one request.
 *
 * `createOverlayAssetDelivery` owns the routing and the §24.8 headers; this
 * function only supplies the base path (which is per-request, see
 * {@link assetBasePathFor}) and turns "not an asset route" into `null` so the
 * caller can fall through.
 */
export async function deliverAsset(
  options: OverlayAssetEndpointsOptions,
  request: Request,
): Promise<OverlayAssetResponse | null> {
  const url = new URL(request.url)
  const deliver = createOverlayAssetDelivery({
    source: options.assetStore,
    /* PATH-RELATIVE, not absolute. The responder strips the origin from the URL
     * before matching, so a base path carrying one could never prefix-match —
     * which is exactly how the document route silently stopped resolving the
     * first time this was wired. */
    basePath: assetMountPath(request),
  })
  return deliver({method: request.method, url: `${url.pathname}${url.search}`})
}

/** The overlay asset ID a delivery URL addresses, or `null` when it addresses none. */
export function assetIdOfRequest(request: Request): string | null {
  const url = new URL(request.url)
  const parsed = parseOverlayAssetRequest(
    `${url.pathname}${url.search}`,
    assetMountPath(request),
  )
  return parsed?.assetDocumentId ?? null
}

/** The document a successful upload answers with, as JSON-able values. */
export function uploadResponseBody(
  result: PutAssetResult,
  overlayId: string,
  basePath: string,
): Record<string, unknown> {
  return {
    ok: true,
    overlayId,
    deduplicated: result.deduplicated,
    record: result.record,
    document: withUrl(result.document, basePath),
  }
}

/**
 * Re-render the document's `url` against THIS request's mount point.
 *
 * The record does not store a URL — it stores a `storageRef` — so the URL is a
 * function of where the API is mounted, and mounting it in two places must not
 * make one of them wrong.
 */
export function withUrl(document: SanityDocument, basePath: string): SanityDocument {
  return {...document, url: `${basePath.replace(/\/+$/, '')}/${document._id}`}
}
