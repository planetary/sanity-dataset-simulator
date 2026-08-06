/**
 * "Write or read?" — the one place the overlay facade answers that question.
 *
 * NOT A SECURITY CLASSIFIER. Enforcement belongs to the Track B proxy, which is
 * default-deny. This module exists so the facade can distinguish *a write it can
 * echo into the overlay* from *a write it cannot represent* from *a read it
 * should delegate*, and answer each honestly — PRD §21.4 "Blocked methods" and
 * §11.3 "Never let unsupported client calls silently reach the staging write API".
 *
 * Dependency-free: imported from the browser bundle and from Node.
 */

type Rec = Record<string, unknown>

/**
 * Reduce a `client.request({url | uri})` target to a comparable path.
 *
 * One normalisation, re-derived nowhere. Spike F escaped the spike facade with a
 * *leading-slash-less* `data/mutate` because the guard tested the caller's raw
 * spelling; every variant in that family — absolute URL, missing/doubled/
 * trailing slash, query, fragment, case, `.`/`..`, percent-encoding — collapses
 * here to one string instead.
 *
 * Over-normalising is the safe direction: a shortened path still matches the
 * guarded prefixes, so it fails closed.
 */
export function normalizeRequestPath(target: unknown): string {
  if (typeof target !== 'string') return '/'
  let value = target.trim()

  /* Absolute URL: drop scheme and authority, keep the path. */
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
  if (scheme) {
    const rest = value.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    value = slash === -1 ? '' : rest.slice(slash)
  }

  try {
    value = decodeURIComponent(value)
  } catch {
    /* Malformed escape — compare the raw spelling rather than give up. */
  }

  const cut = Math.min(
    ...[value.indexOf('?'), value.indexOf('#')].map((at) => (at === -1 ? value.length : at)),
  )
  value = value.slice(0, cut)

  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`.toLowerCase()
}

/**
 * The four resource bases `resourceDataBase()` can build
 * (`@sanity/client@7.26.0` `dataMethods.ts`). A `resource:`-configured client
 * mutates through `<resourceBase>/mutate` and `<resourceBase>/actions` with **no
 * `/data/` prefix at all**, so a `/data/`-anchored guard misses them entirely.
 */
const RESOURCE_BASE = String.raw`(?:projects\/[^/]+\/datasets\/[^/]+|canvases\/[^/]+|media-libraries\/[^/]+|dashboards\/[^/]+)`

/**
 * Document writes — `/data/(mutate|actions)/<ds>` and the resource-scoped forms.
 * One plane, not four, because all of them carry a mutations/actions array the
 * overlay can plan from.
 */
const DOCUMENT_WRITE_RE = new RegExp(
  String.raw`(^|\/)(?:data\/(?:mutate|actions)|` +
    RESOURCE_BASE +
    String.raw`\/(?:mutate|actions))(\/|$)`,
)

/**
 * Asset uploads. `buildAssetUploadUrl()` emits `assets/images/<ds>` with NO
 * leading slash for the default config, plus the resource-scoped spellings.
 */
const ASSET_WRITE_RE = /(^|\/)(?:assets\/(?:images|files)|media-libraries\/[^/]+\/upload)(\/|$)/

/** The five Agent Actions endpoints. */
const AGENT_ACTION_RE = /(^|\/)agent\/action\/(?:generate|transform|translate|prompt|patch)(\/|$)/

/**
 * Dataset administration. Anchored at `$` on purpose so
 * `/projects/<p>/datasets/<d>/query` — a READ on the resource data plane — is
 * not swept up with it.
 */
const DATASET_ADMIN_RE = /(^|\/)(?:projects\/[^/]+\/)?datasets\/[^/]+(?:\/settings(?:\/[^/]+)*)?$/

/** `/auth/logout` — sanity 6.8.0's own logout call. */
const LOGOUT_PATH_RE = /(^|\/)auth\/logout(\/|$)/

/**
 * The two endpoints sanity 6.8.0 treats as proof of a live credential:
 * `/users/me` (`getCurrentUser`) and `/auth/id` (`probeCurrentUser`).
 */
const IDENTITY_PROBE_RE = /(^|\/)(?:users\/me|auth\/id)(\/|$)/

/**
 * Write planes, split by what the overlay can *do* with each: `documents` is
 * echoable; the other three have no overlay spelling and can only be refused.
 */
export type WritePlane = 'documents' | 'asset' | 'agent-action' | 'dataset-admin'

export function classifyWriteEndpoint(target: unknown): WritePlane | undefined {
  const path = normalizeRequestPath(target)
  if (DOCUMENT_WRITE_RE.test(path)) return 'documents'
  if (ASSET_WRITE_RE.test(path)) return 'asset'
  if (AGENT_ACTION_RE.test(path)) return 'agent-action'
  if (DATASET_ADMIN_RE.test(path)) return 'dataset-admin'
  return undefined
}

export function isLogoutEndpoint(target: unknown): boolean {
  return LOGOUT_PATH_RE.test(normalizeRequestPath(target))
}

export function isIdentityProbeEndpoint(target: unknown): boolean {
  return IDENTITY_PROBE_RE.test(normalizeRequestPath(target))
}

/**
 * The user id inside an identity-probe response, or `undefined`.
 *
 * `/users/me` answers an **unauthenticated** caller with HTTP 200 and a `null`
 * body, so "the request succeeded" proves nothing. sanity 6.8.0 only calls the
 * session authenticated when `typeof user?.id === 'string'`; this is that
 * predicate, so the facade and Studio cannot disagree about who is logged in.
 */
export function identityProofFrom(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const id = (value as Rec).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export interface NamespacePolicy {
  read: readonly string[]
  write: readonly string[]
}

/**
 * Every namespace object `@sanity/client@7.26.0` hangs off a client, split into
 * "reaches the network to read" and "reaches the network to write". These do not
 * route through `client.request`: each namespace client holds its own
 * `#httpRequest` and calls it directly, so guarding `request` never reached them.
 *
 * `agent.action` and `mediaLibrary.video` are nested one level down and keyed by
 * their full path.
 *
 * `prompt` counts as a write: it is the one Agent Action that need not persist a
 * document, but it is indistinguishable from its four siblings at the transport
 * layer (`POST /agent/action/prompt/<ds>`) and the proxy classifies it as a
 * write. Facade and proxy disagreeing about one request is exactly the confusing
 * mid-edit 403 this package exists to remove.
 */
export const CLIENT_NAMESPACE_POLICY: Readonly<Record<string, NamespacePolicy>> = Object.freeze({
  assets: {read: [], write: ['upload']},
  datasets: {
    read: ['list', 'getEmbeddingsSettings'],
    write: ['create', 'edit', 'delete', 'editEmbeddingsSettings'],
  },
  agent: {read: [], write: []},
  'agent.action': {read: [], write: ['generate', 'transform', 'translate', 'prompt', 'patch']},
  releases: {
    read: ['get', 'fetchDocuments'],
    write: ['create', 'edit', 'publish', 'archive', 'unarchive', 'schedule', 'unschedule', 'delete'],
  },
  projects: {read: ['list', 'getById'], write: []},
  users: {read: ['getById'], write: []},
  live: {read: ['events'], write: []},
  mediaLibrary: {read: [], write: []},
  'mediaLibrary.video': {read: ['getPlaybackInfo'], write: []},
})

/**
 * Read or write? **Anything not declared a read is a write.**
 *
 * Deliberately asymmetric, and not a security stance: an unrecognised method
 * that is really a read fails loudly at one call site the first time it is used;
 * an unrecognised method that is really a write escapes the overlay silently and
 * the user loses an edit they were told was saved.
 */
export function namespaceMethodKind(namespace: string, method: string): 'read' | 'write' {
  return CLIENT_NAMESPACE_POLICY[namespace]?.read.includes(method) ? 'read' : 'write'
}

/** The namespaces the facade must descend into to reach the methods above. */
export const NAMESPACE_ROOTS: ReadonlySet<string> = new Set([
  'assets',
  'datasets',
  'projects',
  'users',
  'releases',
  'live',
  'agent',
  'mediaLibrary',
])

/** namespace path -> the property under it that is itself a namespace. */
export const NESTED_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({
  agent: 'action',
  mediaLibrary: 'video',
})
