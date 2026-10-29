/**
 * Document id conventions, as Content Lake defines them.
 *
 *   x                      published
 *   drafts.x               draft of x
 *   versions.<release>.x   x inside a content release
 *   _.releases.<release>   the release document itself (a "system" path)
 */

export const DRAFTS_PREFIX = 'drafts.'
export const VERSIONS_PREFIX = 'versions.'
export const RELEASES_PREFIX = '_.releases.'

export const isDraftId = (id) => id.startsWith(DRAFTS_PREFIX)
export const isVersionId = (id) => id.startsWith(VERSIONS_PREFIX)
export const isSystemId = (id) => id.startsWith('_.')
export const isPublishedId = (id) => !isDraftId(id) && !isVersionId(id) && !isSystemId(id)

export function getPublishedId(id) {
  if (isDraftId(id)) return id.slice(DRAFTS_PREFIX.length)
  if (isVersionId(id)) {
    const rest = id.slice(VERSIONS_PREFIX.length)
    const dot = rest.indexOf('.')
    return dot === -1 ? rest : rest.slice(dot + 1)
  }
  return id
}

/** The release name of a `versions.<release>.<id>` id, otherwise null. */
export function getReleaseName(id) {
  if (!isVersionId(id)) return null
  const rest = id.slice(VERSIONS_PREFIX.length)
  const dot = rest.indexOf('.')
  return dot === -1 ? null : rest.slice(0, dot)
}

export const draftIdFor = (id) => DRAFTS_PREFIX + getPublishedId(id)
export const versionIdFor = (release, id) => `${VERSIONS_PREFIX}${release}.${getPublishedId(id)}`
export const releaseDocumentId = (release) => RELEASES_PREFIX + release

/** Content Lake allows `[a-zA-Z0-9._-]`, max 128 chars, not starting with `-`. */
export function isValidDocumentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_.][a-zA-Z0-9._-]*$/.test(id)
}
