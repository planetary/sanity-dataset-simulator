/**
 * `defineOverlayConfig()` — the one line a consumer writes.
 *
 *     import {defineOverlayConfig} from 'sanity-overlay-studio'
 *
 *     export default defineOverlayConfig({
 *       name: 'default',
 *       projectId: '…',
 *       dataset: '…',
 *       plugins: [structureTool()],
 *       schema: {types: schemaTypes},
 *     })
 *
 * It is a config wrapper rather than the `plugins: [overlay()]` of PRD §10
 * because sanity 6.8.0 gives a plugin no way to reach the two things that
 * matter — see `plugin.ts` for the specifics. Everything a plugin *can* do is
 * still shipped as `overlay()`, and this wrapper appends it.
 *
 * THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR:
 *
 *  1. **Additive.** The consumer's config object is never mutated and never has
 *     a key silently replaced; their `tools` / `document.actions` resolvers are
 *     *composed* with the overlay's, overlay last.
 *  2. **Last word.** The overlay resolvers are installed at the root, because
 *     `flattenConfig` resolves the root config last — the only position from
 *     which the hosted plugins' contributions are visible.
 *  3. **Inert when off.** In `off` mode it returns the consumer's config
 *     untouched, so a single env var restores native Sanity exactly.
 *
 * Dependency-free: it builds plain objects. `defineConfig` from `sanity` is an
 * identity function over the same shape, so it is not needed and not imported.
 */

import {resolveOverlayDocumentActions} from './actions'
import {installOverlayDevtools} from './devtools'
import {filterHostedInspectors, filterHostedTools, overlayWorkspaceFeatureFlags} from './features'
import {
  resolveOverlayOptions,
  type OverlayEnv,
  type OverlayStudioOptions,
  type ResolvedOverlayOptions,
} from './options'
import {overlay} from './plugin'
import {createOverlayRuntime, registerOverlayRuntime, type OverlayRuntime} from './runtime'

type Rec = Record<string, unknown>

export interface DefineOverlayConfigOptions extends OverlayStudioOptions {
  /** Environment map. Defaults to `process.env` when available. */
  env?: OverlayEnv
  /** Injected `createClient`; the shipped entry point supplies `@sanity/client`. */
  createClient?: (options: Rec) => object
  /** Injected `fetch`, for tests. */
  fetch?: typeof fetch
  /** `studio.components.layout` — the status banner. Injected by the entry point. */
  layout?: unknown
  /**
   * Where `__SANITY_OVERLAY__` is installed. Defaults to `globalThis`, which is
   * `window` in the Studio bundle. Injected so this module stays testable in
   * Node and so a host can opt out by passing `null`.
   */
  devtoolsTarget?: unknown
}

function defaultEnv(): OverlayEnv {
  const globalProcess = (globalThis as {process?: {env?: OverlayEnv}}).process
  return globalProcess?.env ?? {}
}

/**
 * Compose two resolvers so the overlay's runs **last**.
 *
 * A consumer who re-adds `schedule` in their own resolver has not defeated the
 * overlay: their function shapes the list, then the overlay's takes out what it
 * cannot honour. Composition order is the whole guarantee.
 */
function composeResolver<T>(
  existing: unknown,
  overlayResolver: (prev: readonly T[]) => T[],
): (prev: readonly T[], context: unknown) => T[] {
  return (prev, context) => {
    let next: readonly T[] = prev
    if (typeof existing === 'function') {
      next = (existing as (p: readonly T[], c: unknown) => T[])(prev, context)
    } else if (Array.isArray(existing)) {
      next = [...prev, ...(existing as T[])]
    }
    return overlayResolver(next)
  }
}

export interface OverlayWorkspacePatch {
  workspace: Rec
  resolved: ResolvedOverlayOptions
  runtime: OverlayRuntime | null
}

/**
 * Build the patched workspace for one workspace object.
 *
 * Exported so a consumer with an exotic config shape (or a test) can apply the
 * same patch without going through {@link defineOverlayConfig}.
 */
export function overlayWorkspacePatch(
  workspace: Rec,
  options: DefineOverlayConfigOptions = {},
): OverlayWorkspacePatch {
  const {
    env,
    createClient,
    fetch: fetchImpl,
    layout,
    devtoolsTarget,
    ...studioOptions
  } = options
  const resolved = resolveOverlayOptions(studioOptions, env ?? defaultEnv())

  if (!resolved.enabled) return {workspace, resolved, runtime: null}

  const name = typeof workspace.name === 'string' ? workspace.name : 'default'

  const runtime = createOverlayRuntime({
    resolved,
    fetch: fetchImpl,
    createClient:
      createClient ??
      ((): object => {
        throw new Error(
          `[sanity-overlay-studio] no createClient was supplied. Import ` +
            `defineOverlayConfig from 'sanity-overlay-studio' (the package entry point ` +
            `wires @sanity/client) rather than from its internal config module.`,
        )
      }),
  })
  registerOverlayRuntime(name, runtime)
  /* `'*'` is the fallback the banner uses when it cannot see a workspace name —
   * correct for the overwhelmingly common single-workspace Studio, and
   * deliberately last-writer-wins so a multi-workspace config still resolves by
   * exact name first. */
  registerOverlayRuntime('*', runtime)

  /* The instrument (`devtools.ts`). Installed only when the overlay is on — in
   * `off` mode this function has already returned, so native Sanity is restored
   * exactly, global included. */
  installOverlayDevtools(runtime, devtoolsTarget === undefined ? globalThis : devtoolsTarget)

  const existingDocument = (
    typeof workspace.document === 'object' && workspace.document !== null
      ? workspace.document
      : {}
  ) as Rec

  const overlayPlugin = overlay({...studioOptions, env: env ?? defaultEnv()})
  const plugins = Array.isArray(workspace.plugins) ? workspace.plugins : []

  const studio = (
    typeof workspace.studio === 'object' && workspace.studio !== null ? workspace.studio : {}
  ) as Rec
  const studioComponents = (
    typeof studio.components === 'object' && studio.components !== null ? studio.components : {}
  ) as Rec

  return {
    workspace: {
      ...workspace,
      /* The interception. This is the key a plugin cannot set, and without it
       * nothing else in this package matters. */
      unstable_clientFactory: (clientOptions: Rec) => runtime.clientFactory(clientOptions),
      /* Workspace-only hosted-feature switches (§21.10). */
      ...overlayWorkspaceFeatureFlags(),
      /* Appended, so the overlay plugin's own resolvers see the consumer's
       * plugins — and so the consumer's plugins are never displaced. */
      plugins: [...plugins, overlayPlugin],
      tools: composeResolver(workspace.tools, filterHostedTools),
      document: {
        ...existingDocument,
        comments: {enabled: false},
        actions: composeResolver(existingDocument.actions, resolveOverlayDocumentActions),
        inspectors: composeResolver(existingDocument.inspectors, filterHostedInspectors),
      },
      ...(layout === undefined
        ? {}
        : {studio: {...studio, components: {...studioComponents, layout}}}),
    },
    resolved,
    runtime,
  }
}

/**
 * Wrap a Studio config so every read and write goes through the branch overlay.
 *
 * Accepts a single workspace object or an array of them, matching
 * `defineConfig`'s own `Config` union.
 */
export function defineOverlayConfig<T>(config: T, options: DefineOverlayConfigOptions = {}): T {
  if (Array.isArray(config)) {
    return config.map(
      (workspace) => overlayWorkspacePatch(workspace as Rec, options).workspace,
    ) as unknown as T
  }
  return overlayWorkspacePatch(config as unknown as Rec, options).workspace as unknown as T
}
