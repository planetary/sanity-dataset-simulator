/**
 * `sanity-overlay-studio` — the one-line install (PRD §10, §11.1, §21.1).
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE. PRD §10 imagines
 *
 *     plugins: [structureTool(), overlay()]
 *
 * and a `definePlugin` cannot deliver it in sanity 6.8.0. Two hard facts, both
 * read out of the installed package:
 *
 *  1. `unstable_clientFactory` is declared on `SourceOptions`, not
 *     `PluginOptions`, and `getAuthStore` reads it by direct property access off
 *     the source config — never through `flattenConfig`. Without it there is no
 *     interception at all, so the *entire* write-blocking guarantee is
 *     unreachable from a plugin.
 *  2. `tasks`, `releases`, `scheduledDrafts` and `scheduledPublishing`
 *     registration is decided from the raw workspace object, and the hosted
 *     plugins are appended *after* every user plugin — so a plugin's `tools` /
 *     `document.actions` resolvers never see what they contribute.
 *
 * So the shipped one-liner is a config wrapper, and `overlay()` remains
 * available for the subset a plugin really can do. This file pins both, and pins
 * that the wrapper does not quietly discard the consumer's own configuration.
 */
import {describe, expect, it} from 'vitest'
import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'
import {defineOverlayConfig, overlayWorkspacePatch} from '../../sanity-overlay-studio/src/config'
import {overlay} from '../../sanity-overlay-studio/src/plugin'

type Rec = Record<string, unknown>

const BASE = {
  name: 'default',
  title: 'Kitchen Sink',
  projectId: 'b1n03q3z',
  dataset: 'parity',
  plugins: [{name: 'sanity/structure'}],
  schema: {types: []},
}

const ENV = {SANITY_STUDIO_OVERLAY_MODE: 'fs'}

describe('defineOverlayConfig — the consumer’s one line', () => {
  it('keeps every key the consumer wrote', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    expect(config.name).toBe('default')
    expect(config.title).toBe('Kitchen Sink')
    expect(config.projectId).toBe('b1n03q3z')
    expect(config.dataset).toBe('parity')
    expect(config.schema).toBe(BASE.schema)
  })

  it('does not mutate the object it was handed', () => {
    const original = {...BASE, plugins: [...BASE.plugins]}
    defineOverlayConfig(original, {env: ENV})
    expect(original.plugins).toHaveLength(1)
    expect((original as Rec).unstable_clientFactory).toBeUndefined()
    expect((original as Rec).tasks).toBeUndefined()
  })

  it('installs the client factory — the interception a plugin cannot reach', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    expect(typeof config.unstable_clientFactory).toBe('function')
  })

  it('installs the workspace-only hosted-feature switches', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    expect(config).toMatchObject({
      tasks: {enabled: false},
      releases: {enabled: false},
      scheduledDrafts: {enabled: false},
      scheduledPublishing: {enabled: false},
      announcements: {enabled: false},
    })
  })

  it('appends the overlay plugin AFTER the consumer’s plugins, so resolvers see them', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    const plugins = config.plugins as {name: string}[]
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'sanity/structure',
      'sanity-overlay-studio',
    ])
  })

  it('puts the tool / action / inspector resolvers at the ROOT, where they run last', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    expect(typeof config.tools).toBe('function')
    const document = config.document as Rec
    expect(typeof document.actions).toBe('function')
    expect(typeof document.inspectors).toBe('function')
  })

  it('the root tools resolver removes Vision, which a plugin-level one could not', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    const tools = config.tools as (prev: {name: string}[]) => {name: string}[]
    expect(tools([{name: 'structure'}, {name: 'vision'}]).map((tool) => tool.name)).toEqual([
      'structure',
    ])
  })

  it('the root action resolver removes the scheduled-draft action the overlay cannot honour', () => {
    const config = defineOverlayConfig(BASE, {env: ENV}) as Rec
    const actions = (config.document as Rec).actions as (
      prev: {action?: string}[],
    ) => {action?: string}[]
    expect(actions([{action: 'publish'}, {action: 'schedule'}]).map((a) => a.action)).toEqual([
      'publish',
    ])
  })

  it('composes with a consumer’s own tools resolver instead of replacing it', () => {
    const config = defineOverlayConfig(
      {...BASE, tools: (prev: {name: string}[]) => [...prev, {name: 'my-tool'}]},
      {env: ENV},
    ) as Rec
    const tools = config.tools as (prev: {name: string}[]) => {name: string}[]
    expect(tools([{name: 'vision'}]).map((tool) => tool.name)).toEqual(['my-tool'])
  })

  it('composes with a consumer’s own document.actions resolver', () => {
    const config = defineOverlayConfig(
      {
        ...BASE,
        document: {
          actions: (prev: {action?: string}[]) => [...prev, {action: 'schedule'}],
        },
      },
      {env: ENV},
    ) as Rec
    const actions = (config.document as Rec).actions as (
      prev: {action?: string}[],
    ) => {action?: string}[]
    /* The consumer added `schedule` back; the overlay resolver still runs after
     * them and takes it out. Ordering, not luck. */
    expect(actions([{action: 'publish'}]).map((a) => a.action)).toEqual(['publish'])
  })
})

describe('defineOverlayConfig — off mode', () => {
  it('leaves a native Sanity config completely untouched', () => {
    const config = defineOverlayConfig(BASE, {mode: 'off', env: {}}) as Rec
    expect(config.unstable_clientFactory).toBeUndefined()
    expect(config.tasks).toBeUndefined()
    expect(config.tools).toBeUndefined()
    expect((config.plugins as unknown[]).length).toBe(1)
  })
})

describe('defineOverlayConfig — multiple workspaces', () => {
  it('patches every workspace in an array config', () => {
    const config = defineOverlayConfig([BASE, {...BASE, name: 'second'}], {env: ENV}) as Rec[]
    expect(config).toHaveLength(2)
    for (const workspace of config) {
      expect(typeof workspace.unstable_clientFactory).toBe('function')
    }
  })
})

describe('defineOverlayConfig — the §11.3 startup guards still fire', () => {
  it('throws when a write token is present in the Studio environment', () => {
    expect(() => defineOverlayConfig(BASE, {env: {SANITY_STUDIO_WRITE_TOKEN: 'sk'}})).toThrow(
      /write token/i,
    )
  })

  it('throws on an unknown mode rather than silently defaulting', () => {
    expect(() => defineOverlayConfig(BASE, {env: {SANITY_STUDIO_OVERLAY_MODE: 'nope'}})).toThrow(
      /nope/,
    )
  })
})

describe('overlayWorkspacePatch — what the wrapper actually adds', () => {
  it('reports the resolved options so the caller can log or assert on them', () => {
    const {resolved} = overlayWorkspacePatch(BASE, {env: ENV})
    expect(resolved.mode).toBe('fs')
    expect(resolved.apiUrl).toBe('http://localhost:3998')
    expect(resolved.disableHostedFeatures).toBe(true)
  })

  it('carries the resolver warnings through instead of swallowing them', () => {
    const {resolved} = overlayWorkspacePatch(BASE, {env: {}})
    expect(resolved.warnings.join(' ')).toMatch(/OVERLAY_MODE/)
  })
})

describe('overlay() — the plugin, for the subset a plugin can do', () => {
  it('is a plain PluginOptions object with a stable name', () => {
    const plugin = overlay({mode: 'fs'}) as unknown as Rec
    expect(plugin.name).toBe('sanity-overlay-studio')
  })

  it('disables comments, which really is flattened through the plugin chain', () => {
    const plugin = overlay({mode: 'fs'}) as unknown as Rec
    expect(plugin.document).toMatchObject({comments: {enabled: false}})
  })

  it('carries the resolvers so an explicitly-ordered plugin list still benefits', () => {
    const plugin = overlay({mode: 'fs'}) as unknown as Rec
    expect(typeof plugin.tools).toBe('function')
    expect(typeof (plugin.document as Rec).inspectors).toBe('function')
  })

  it('does NOT claim to set unstable_clientFactory, which would be silently ignored', () => {
    expect((overlay({mode: 'fs'}) as unknown as Rec).unstable_clientFactory).toBeUndefined()
  })

  it('does NOT set the workspace-only keys, which would also be silently ignored', () => {
    const plugin = overlay({mode: 'fs'}) as unknown as Rec
    for (const key of ['tasks', 'releases', 'scheduledDrafts', 'scheduledPublishing']) {
      expect(plugin[key], key).toBeUndefined()
    }
  })

  it('is inert in off mode', () => {
    const plugin = overlay({mode: 'off'}) as unknown as Rec
    expect(plugin.document).toBeUndefined()
    expect(plugin.tools).toBeUndefined()
  })
})

describe('the client factory the wrapper installs', () => {
  it('returns an intercepted client, not a bare one', () => {
    /* The internal config module has no client dependency by design — the
     * package entry point wires `@sanity/client`. Here the test plays that part. */
    const config = defineOverlayConfig(BASE, {
      env: ENV,
      createClient: (clientOptions) => createClient(clientOptions as never),
    }) as Rec
    const factory = config.unstable_clientFactory as (options: Rec) => Rec
    const client = factory({projectId: 'b1n03q3z', dataset: 'parity', apiVersion: '2025-02-19'})
    expect(typeof client.fetch).toBe('function')
    /* Identity stability, at the seam Studio actually uses. */
    expect(client.fetch).toBe(client.fetch)
    expect(client.observable).toBe(client.observable)
  })

  it('injects the proxy apiHost when one is configured (the D13 hybrid)', () => {
    const seen: Rec[] = []
    const config = defineOverlayConfig(BASE, {
      env: ENV,
      apiHost: 'http://localhost:3999',
      createClient: (clientOptions: Rec) => {
        seen.push(clientOptions)
        return {fetch: (): void => {}, config: () => clientOptions} as unknown as never
      },
    }) as Rec
    const factory = config.unstable_clientFactory as (options: Rec) => Rec
    factory({projectId: 'b1n03q3z', dataset: 'parity'})
    expect(seen[0]?.apiHost).toBe('http://localhost:3999')
  })

  it('does not inject an apiHost when no proxy is configured', () => {
    const seen: Rec[] = []
    const config = defineOverlayConfig(BASE, {
      env: ENV,
      createClient: (clientOptions: Rec) => {
        seen.push(clientOptions)
        return {fetch: (): void => {}} as unknown as never
      },
    }) as Rec
    const factory = config.unstable_clientFactory as (options: Rec) => Rec
    factory({projectId: 'b1n03q3z', dataset: 'parity'})
    expect(seen[0]).not.toHaveProperty('apiHost')
  })

  it('blocks a write made through a client the factory produced', async () => {
    const escaped: string[] = []
    const config = defineOverlayConfig(BASE, {
      env: ENV,
      fetch: (async () =>
        ({
          status: 200,
          text: async () => JSON.stringify({ok: true, documents: []}),
        }) as never) as unknown as typeof fetch,
      createClient: () =>
        ({
          mutate: (): Promise<unknown> => {
            escaped.push('mutate')
            return Promise.resolve({})
          },
          fetch: (): Promise<unknown> => Promise.resolve(null),
        }) as unknown as never,
    }) as Rec
    const factory = config.unstable_clientFactory as (options: Rec) => Rec
    const client = factory({projectId: 'b1n03q3z', dataset: 'parity'})
    await (client.mutate as CallableFunction)([{patch: {id: 'a', set: {x: 1}}}])
    expect(escaped).toEqual([])
  })
})
