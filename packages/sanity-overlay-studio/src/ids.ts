/** Draft/published id arithmetic. Dependency-free; shared by every module. */

const DRAFTS_PREFIX = 'drafts.'

export function toPublishedId(id: string): string {
  return id.startsWith(DRAFTS_PREFIX) ? id.slice(DRAFTS_PREFIX.length) : id
}

export function toDraftId(id: string): string {
  return id.startsWith(DRAFTS_PREFIX) ? id : `${DRAFTS_PREFIX}${id}`
}

export function isDraftId(id: string): boolean {
  return id.startsWith(DRAFTS_PREFIX)
}
