/**
 * `sanity-overlay-studio` — the write classifier (PRD §21.4 "Blocked methods",
 * §11.3 "Never let unsupported client calls silently reach the staging write API").
 *
 * This is the single place the facade decides "write or read?". It is not a
 * security boundary — the Track B proxy owns enforcement and is default-deny —
 * it exists so the facade can tell *a write it can echo* from *a write it
 * cannot* from *a read*, and answer each honestly rather than letting one slip
 * through to staging.
 *
 * THE HAZARD CLASS THIS FILE COVERS, not the instance. Spike F found the spike
 * facade escapable by a leading-slash-less `request({uri: 'data/mutate/…'})` —
 * a raw substring test against the caller's spelling. So the tests below sweep
 * the whole normalisation family (absolute URL, missing / doubled / trailing
 * slash, query, fragment, case, `.`/`..` segments, percent-encoding) for every
 * write plane, not just the one variant that was reported.
 *
 * The URL families come from `@sanity/client@7.26.0`'s URL construction sites —
 * `_getDataUrl`, `resourceDataBase`, `buildAssetUploadUrl`, the `uri:` literals —
 * not from observed traffic. Observed traffic is what made the original guard
 * incomplete.
 */
import {describe, expect, it} from 'vitest'
import {
  CLIENT_NAMESPACE_POLICY,
  classifyWriteEndpoint,
  isIdentityProbeEndpoint,
  isLogoutEndpoint,
  namespaceMethodKind,
  normalizeRequestPath,
} from '../../sanity-overlay-studio/src/client/writeGuard'

/** Every spelling of one path that must collapse to the same normalised form. */
function variantsOf(path: string): string[] {
  const bare = path.replace(/^\//, '')
  return [
    path,
    bare,
    `/${path}`,
    `${path}/`,
    `${path}?query=1`,
    `${path}#frag`,
    `${path}?a=1#b`,
    path.toUpperCase(),
    `/./${bare}`,
    `/nope/../${bare}`,
    `https://b1n03q3z.api.sanity.io${path}`,
    `http://localhost:3999${path}`,
    encodeURI(path).replace(/\//g, '%2F').replace(/^/, '/').replace('//', '/'),
  ]
}

describe('normalizeRequestPath', () => {
  it('collapses every spelling of the same target to one string', () => {
    const normalised = new Set(variantsOf('/data/mutate/parity').map(normalizeRequestPath))
    expect(normalised.size).toBe(1)
    expect([...normalised][0]).toBe('/data/mutate/parity')
  })

  it('answers "/" for a non-string target rather than throwing', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(normalizeRequestPath(value)).toBe('/')
    }
  })

  it('survives a malformed percent escape by comparing the raw spelling', () => {
    expect(() => normalizeRequestPath('/data/mutate/%E0%A4%A')).not.toThrow()
    expect(normalizeRequestPath('/data/mutate/%E0%A4%A')).toContain('/data/mutate')
  })

  it('does not let a `..` segment climb out of the guarded prefix', () => {
    expect(normalizeRequestPath('/data/mutate/../../data/mutate/parity')).toBe(
      '/data/mutate/parity',
    )
  })
})

describe('classifyWriteEndpoint — the document write plane', () => {
  const documentWrites = [
    '/data/mutate/parity',
    '/data/actions/parity',
    '/projects/b1n03q3z/datasets/parity/mutate',
    '/projects/b1n03q3z/datasets/parity/actions',
    '/canvases/abc/mutate',
    '/media-libraries/ml1/actions',
    '/dashboards/d1/mutate',
  ]

  it.each(documentWrites)('classifies %s as a document write in every spelling', (path) => {
    for (const variant of variantsOf(path)) {
      expect(classifyWriteEndpoint(variant), variant).toBe('documents')
    }
  })

  it('does not classify the resource-scoped READ plane as a write', () => {
    expect(classifyWriteEndpoint('/projects/b1n03q3z/datasets/parity/query')).toBeUndefined()
    expect(classifyWriteEndpoint('/data/query/parity')).toBeUndefined()
    expect(classifyWriteEndpoint('/data/doc/parity/article-1')).toBeUndefined()
    expect(classifyWriteEndpoint('/data/export/parity')).toBeUndefined()
  })
})

describe('classifyWriteEndpoint — the planes with no overlay spelling', () => {
  it.each([
    ['assets/images/parity', 'asset'],
    ['assets/files/parity', 'asset'],
    ['/canvases/abc/assets/images', 'asset'],
    ['/dashboards/d1/assets/files', 'asset'],
    ['/media-libraries/ml1/upload', 'asset'],
    ['/agent/action/generate/parity', 'agent-action'],
    ['/agent/action/transform/parity', 'agent-action'],
    ['/agent/action/translate/parity', 'agent-action'],
    ['/agent/action/prompt/parity', 'agent-action'],
    ['/agent/action/patch/parity', 'agent-action'],
    ['/datasets/parity', 'dataset-admin'],
    ['/projects/b1n03q3z/datasets/parity', 'dataset-admin'],
    ['/datasets/parity/settings/embeddings', 'dataset-admin'],
  ])('classifies %s as %s', (path, plane) => {
    expect(classifyWriteEndpoint(path)).toBe(plane)
    expect(classifyWriteEndpoint(path.replace(/^\//, ''))).toBe(plane)
    expect(classifyWriteEndpoint(`https://api.sanity.io/v1/${path.replace(/^\//, '')}`)).toBe(plane)
  })

  it('leaves ordinary reads unclassified', () => {
    for (const path of [
      '/users/me',
      '/auth/id',
      '/projects/b1n03q3z',
      '/projects/b1n03q3z/grants',
      '/data/query/parity',
      '/journey/b1n03q3z',
      '/versions',
    ]) {
      expect(classifyWriteEndpoint(path), path).toBeUndefined()
    }
  })
})

describe('the two session-signal endpoints', () => {
  it('recognises the logout endpoint in every spelling', () => {
    for (const variant of variantsOf('/auth/logout')) {
      expect(isLogoutEndpoint(variant), variant).toBe(true)
    }
    expect(isLogoutEndpoint('/auth/login')).toBe(false)
  })

  it('recognises both identity probes sanity 6.8.0 treats as proof of a credential', () => {
    for (const path of ['/users/me', '/auth/id']) {
      for (const variant of variantsOf(path)) {
        expect(isIdentityProbeEndpoint(variant), variant).toBe(true)
      }
    }
    expect(isIdentityProbeEndpoint('/users/abc123')).toBe(false)
  })
})

describe('namespaceMethodKind — anything not declared a read is a write', () => {
  it('declares every namespace @sanity/client hangs off a client', () => {
    expect(Object.keys(CLIENT_NAMESPACE_POLICY).sort()).toEqual(
      [
        'agent',
        'agent.action',
        'assets',
        'datasets',
        'live',
        'mediaLibrary',
        'mediaLibrary.video',
        'projects',
        'releases',
        'users',
      ].sort(),
    )
  })

  it.each([
    ['assets', 'upload', 'write'],
    ['agent.action', 'generate', 'write'],
    ['agent.action', 'prompt', 'write'],
    ['datasets', 'create', 'write'],
    ['datasets', 'list', 'read'],
    ['releases', 'publish', 'write'],
    ['releases', 'get', 'read'],
    ['projects', 'list', 'read'],
    ['users', 'getById', 'read'],
    ['live', 'events', 'read'],
    ['mediaLibrary.video', 'getPlaybackInfo', 'read'],
  ])('classifies %s.%s as a %s', (namespace, method, kind) => {
    expect(namespaceMethodKind(namespace, method)).toBe(kind)
  })

  it('classifies an unknown method as a write, in every namespace', () => {
    for (const namespace of Object.keys(CLIENT_NAMESPACE_POLICY)) {
      expect(namespaceMethodKind(namespace, 'somethingNewIn727'), namespace).toBe('write')
    }
  })

  it('classifies a method on an unknown namespace as a write', () => {
    expect(namespaceMethodKind('somethingNew', 'list')).toBe('write')
  })
})
