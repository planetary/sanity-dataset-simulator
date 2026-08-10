/**
 * The Studio's half of branch-local assets — PRD §24.3 steps 1-2, §24.7, §5.5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES, OBSERVED LIVE ON 2026-08-06.
 *
 * Dropping a PNG into an image field patched `_upload: {progress: 2}` into the
 * draft and then hung forever: no asset reference, no error, no toast. The
 * facade refused the whole `assets` namespace, and the refusal never reached the
 * editor because sanity 6.8.0's `uploadSanityAsset` only renders an error if the
 * upload observable *errors* — and there was no server for it to error against.
 *
 * So this module exists to make every asset path end in one of two states, and
 * never in a third: **bytes stored in the branch**, or **an Error the image
 * input can render**. A pending promise is not an outcome.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BYTES GO TO THE OVERLAY API AND NOT TO SANITY.
 *
 * Owner ruling 2026-08-05, PRD §0.0: this system never writes to a real Sanity
 * dataset, and that includes assets. `POST <apiUrl>/assets` stores them under
 * `.sanity-overlay/assets/` and commits a synthetic `sanity.imageAsset` /
 * `sanity.fileAsset` into the branch, so `asset._ref` resolves through the
 * ordinary reference machinery. Nothing here can reach `*.api.sanity.io`:
 * {@link createOverlayAssetUploader} refuses such an `apiUrl` at construction
 * and re-checks every request through `createStagingSafeFetch`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A TIMEOUT.
 *
 * `fetch` has none. A server that accepts the connection and never answers —
 * exactly what the editor experienced — leaves the promise pending for the life
 * of the tab, and §5.5 forbids presenting that as anything. The deadline turns
 * it into a sentence.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  OVERLAY_ASSET_FILENAME_HEADER,
  OVERLAY_ASSET_ROUTE_SEGMENT,
  OVERLAY_ASSET_UPLOAD_HEADER,
} from 'sanity-overlay-core'
import {
  assertNoStagingWrite,
  createStagingSafeFetch,
} from 'sanity-overlay-client/stagingHost'
import {markOverlayRefusal} from './echo'

type Rec = Record<string, unknown>

/** `@sanity/client`'s two asset planes. Anything else is refused before a request. */
export const OVERLAY_ASSET_TYPES = ['image', 'file'] as const

export type OverlayAssetType = (typeof OVERLAY_ASSET_TYPES)[number]

/** One `client.assets.upload(assetType, body, options)` call, normalised. */
export interface OverlayAssetUploadRequest {
  assetType: unknown
  body: unknown
  options?: unknown
}

export interface OverlayAssetUploadOutcome {
  /** The synthetic §24.3 step-5 asset document, as the overlay committed it. */
  document: Rec
  /** True when these exact bytes were already in the branch. */
  deduplicated: boolean
}

export type OverlayAssetUploader = (
  request: OverlayAssetUploadRequest,
) => Promise<OverlayAssetUploadOutcome>

export interface CreateOverlayAssetUploaderOptions {
  /** Base URL of the overlay API — the same one the transport commits to. */
  apiUrl: string
  fetch?: typeof fetch
  /** Extra headers, e.g. a preview session token. */
  headers?: Record<string, string>
  /** Deadline for one upload. Defaults to {@link DEFAULT_UPLOAD_TIMEOUT_MS}. */
  timeoutMs?: number
  onError?: (message: string) => void
}

/**
 * Two minutes.
 *
 * Long enough for a large image over a slow link, short enough that a stalled
 * server becomes a message rather than a permanent spinner. It bounds the
 * WHOLE upload, not an idle period, because the failure being prevented is a
 * server that accepts bytes and never replies.
 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * An overlay refusal carrying the reason, ready for `subscriber.error`.
 *
 * MARKED, because a host that funnels client errors through the session observer
 * must not read our own "no" as Sanity revoking the editor's credential
 * (`echo.ts` {@link markOverlayRefusal}).
 */
function refusal(message: string, extra: Rec = {}): Error {
  return markOverlayRefusal(Object.assign(new Error(message), extra))
}

/* ------------------------------------------------------------------ *
 * The origin the image pipeline must be pointed at
 * ------------------------------------------------------------------ */

export type OverlayAssetOrigin = {origin: string} | {refusal: string}

/**
 * Where `@sanity/image-url` must build preview URLs against — or why it cannot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STUDIO'S IMAGE PREVIEW NEVER READS THE ASSET DOCUMENT'S `url`.
 *
 * sanity 6.8.0 renders it with `createImageUrlBuilder(client).image(ref).url()`,
 * and `@sanity/image-url@2.1.1` builds that string from `client.config()` alone
 * (`clientConfigToOptions`):
 *
 *     baseUrl = (apiHost || 'https://api.sanity.io').replace(/^https:\/\/api\./, 'https://cdn.')
 *     src     = `${baseUrl}/images/${projectId}/${dataset}/${sha1}-${w}x${h}.${ext}`
 *
 * So a branch image renders if and only if something answers a GET at that
 * shape. The overlay API does — and it answers for BASE assets too, with a 302
 * to `cdn.sanity.io` (§24.1), so both kinds resolve in the same field.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHY THIS CAN REFUSE.
 *
 * That path is absolute — `/images/...` at the ORIGIN root — so an overlay API
 * mounted under a prefix (`https://site.example/api/sanity-overlay`, the App
 * Router shape of PRD §10.1) does not serve it. Rewriting the origin anyway
 * would hand the image pipeline a URL that 404s for every image, base ones
 * included, which is strictly worse than leaving it pointed at Sanity. §5.5:
 * state it, do not approximate it.
 */
export function assetOriginFor(apiUrl: string): OverlayAssetOrigin {
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    return {
      refusal:
        `the overlay API URL ${JSON.stringify(apiUrl)} is not absolute, so no asset origin can ` +
        `be derived from it`,
    }
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return {
      refusal:
        `the overlay API is mounted at ${JSON.stringify(parsed.pathname)}, but Studio's image ` +
        `pipeline builds every preview URL as "/images/<projectId>/<dataset>/<file>" at the ` +
        `ORIGIN ROOT, which that mounting does not serve. Branch image previews will not render ` +
        `until the overlay API answers those paths — mount it at the origin root, or add a ` +
        `catch-all "/images/[...]" and "/files/[...]" route that forwards to it.`,
    }
  }
  return {origin: parsed.origin}
}

/* ------------------------------------------------------------------ *
 * Reading the caller's arguments
 * ------------------------------------------------------------------ */

/**
 * The filename to record, from the shapes `@sanity/client`'s `optionsFromFile`
 * accepts: an explicit `options.filename`, or a `File`/`Blob`-with-`name`.
 *
 * NEVER TRUSTED AS A PATH. It travels percent-encoded in a header and the server
 * strips it to a basename (`sanitizeOriginalFilename`); the extension that ends
 * up in the asset ID is `[a-z0-9]+`, which cannot express one.
 */
export function uploadFilenameOf(body: unknown, options: unknown): string | undefined {
  if (isRec(options) && typeof options.filename === 'string' && options.filename !== '') {
    return options.filename
  }
  /* `preserveFilename: false` is Studio asking for the name NOT to be stored. */
  if (isRec(options) && options.preserveFilename === false) return undefined
  if (isRec(body) && typeof (body as {name?: unknown}).name === 'string') {
    const name = (body as {name: string}).name
    return name === '' ? undefined : name
  }
  return undefined
}

/** The declared content type, from `options.contentType` or a `File`/`Blob`. */
export function uploadContentTypeOf(body: unknown, options: unknown): string | undefined {
  if (isRec(options) && typeof options.contentType === 'string' && options.contentType !== '') {
    return options.contentType
  }
  if (isRec(body) && typeof (body as {type?: unknown}).type === 'string') {
    const type = (body as {type: string}).type
    return type === '' ? undefined : type
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * The uploader
 * ------------------------------------------------------------------ */

export function createOverlayAssetUploader(
  options: CreateOverlayAssetUploaderOptions,
): OverlayAssetUploader {
  const base = options.apiUrl.replace(/\/+$/, '')
  const uploadUrl = `${base}/${OVERLAY_ASSET_ROUTE_SEGMENT}`

  /* REFUSE AT CONSTRUCTION. The same reasoning as the transport's: a
   * misconfigured `apiUrl` must not become a per-upload failure that looks
   * transient — it is the one way an "overlay" upload could reach the Content
   * Lake, and PRD §0.0 forbids that absolutely. */
  assertNoStagingWrite(
    {method: 'POST', url: uploadUrl},
    'branch asset uploads must go to the overlay API, never to Sanity',
  )

  const noteError = options.onError ?? ((): void => {})
  const rawFetch =
    options.fetch ??
    (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  const doFetch =
    rawFetch === undefined ? undefined : createStagingSafeFetch(rawFetch, 'overlay asset upload')
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS

  function fail(message: string, extra: Rec = {}): never {
    const error = refusal(`[sanity-overlay-studio] ${message}`, extra)
    noteError(error.message)
    throw error
  }

  return async function upload(request) {
    const assetType = request.assetType
    if (assetType !== 'image' && assetType !== 'file') {
      fail(
        `cannot upload asset type ${JSON.stringify(assetType)} into the branch: the overlay ` +
          `stores ${OVERLAY_ASSET_TYPES.join(' and ')} assets only (PRD §24.2)`,
      )
    }
    if (doFetch === undefined) {
      fail(`no fetch implementation is available, so ${uploadUrl} cannot be reached`)
    }
    if (request.body === undefined || request.body === null) {
      fail('an asset upload was issued with no body, so there are no bytes to store')
    }

    const filename = uploadFilenameOf(request.body, request.options)
    const contentType = uploadContentTypeOf(request.body, request.options)

    const headers: Record<string, string> = {
      /* The CSRF control. Its VALUE carries nothing; its presence is what forces
       * the browser to preflight, which the origin allowlist then answers. */
      [OVERLAY_ASSET_UPLOAD_HEADER]: '1',
      ...(contentType === undefined ? {} : {'content-type': contentType}),
      ...(filename === undefined
        ? {}
        : {[OVERLAY_ASSET_FILENAME_HEADER]: encodeURIComponent(filename)}),
      ...(options.headers ?? {}),
    }

    /* The deadline. `AbortController` is in every browser Studio supports and in
     * Node 18+, so there is no environment where the upload can outlive it. */
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    let timedOut = false
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)

    let status = 0
    let text = ''
    try {
      const response = (await doFetch(uploadUrl, {
        method: 'POST',
        headers,
        body: request.body as BodyInit,
        ...(controller === undefined ? {} : {signal: controller.signal}),
      })) as unknown as {status: number; text: () => Promise<string>}
      status = response.status
      text = await response.text()
    } catch (error) {
      if (timedOut) {
        fail(
          `the asset upload to ${uploadUrl} timed out after ${timeoutMs}ms and was abandoned. ` +
            `Nothing was stored, and nothing was sent to Sanity.`,
        )
      }
      fail(
        `the asset upload to ${uploadUrl} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    let body: Rec = {}
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      if (isRec(parsed)) body = parsed
    } catch {
      fail(
        `the overlay API at ${uploadUrl} answered ${status} with a body that is not JSON ` +
          `(${text.slice(0, 120)})`,
      )
    }

    if (status < 200 || status >= 300 || body.ok === false) {
      const error = isRec(body.error) ? body.error : {}
      const code = typeof error.code === 'string' ? error.code : `HTTP_${status}`
      const message = typeof error.message === 'string' ? error.message : text.slice(0, 200)
      fail(
        `the branch refused this asset (${code}): ${message === '' ? `HTTP ${status}` : message}`,
        {statusCode: status, code},
      )
    }

    const document = isRec(body.document) ? body.document : undefined
    if (document === undefined || typeof document._id !== 'string') {
      /* A 200 with no document is the one answer that could be mistaken for
       * success. It is refused rather than reported, because the editor would
       * otherwise be shown an image field bound to nothing. */
      fail(
        `the overlay API accepted the upload but described no asset document, so there is ` +
          `nothing to reference`,
      )
    }

    return {document, deduplicated: body.deduplicated === true}
  }
}
