/**
 * The upload wire contract — PRD §24.3 steps 1-2, §25.1.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE STRINGS LIVE IN CORE AND NOT IN THE SERVER THAT READS THEM.
 *
 * Two packages have to agree on them and neither may import the other: the
 * overlay API (`sanity-overlay-next`, Node) requires the header before it will
 * read a body, and the Studio (`sanity-overlay-studio`, browser bundle) has to
 * send it. They were previously declared only in the server. Nothing sent them,
 * so nothing noticed; the moment a client existed, "the server requires a header
 * the client does not send" is a 403 with no symptom other than a failed upload.
 *
 * Core is the one place both already depend on, it is dependency-free and
 * browser-safe (plan §3), and a constant is not behaviour — so this file states
 * the contract once and both sides import it rather than transcribe it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The mount-relative segment the upload and document-delivery routes sit under. */
export const OVERLAY_ASSET_ROUTE_SEGMENT = 'assets'

/**
 * The header an upload MUST carry, and the CSRF control for a request whose
 * content type cannot be constrained.
 *
 * An upload's `Content-Type` is `image/png` — a value on the CORS safelist — so
 * a `POST` carrying it fires NO preflight, and without this header any page the
 * developer happened to have open could write bytes into the branch. A custom
 * header name is not safelisted, so requiring one forces a preflight, and the
 * preflight is answered by the origin allowlist, which grants nothing by
 * default. That closes the class rather than an instance: it does not matter
 * what the body or the content type is.
 *
 * Page JavaScript can of course SET this header on a same-origin XHR — that is
 * the point. What it cannot do is make the browser skip the preflight.
 */
export const OVERLAY_ASSET_UPLOAD_HEADER = 'x-overlay-asset-upload'

/** Original filename, percent-encoded so a non-ASCII name survives a header. */
export const OVERLAY_ASSET_FILENAME_HEADER = 'x-overlay-asset-filename'

/**
 * Sanity's image/file CDN.
 *
 * Only ever a `Location` for base assets this overlay does not hold (§24.1), and
 * never a request this system makes. Declared here so the server that redirects
 * to it and any client that recognises the redirect share one spelling.
 */
export const SANITY_CDN_ORIGIN = 'https://cdn.sanity.io'
