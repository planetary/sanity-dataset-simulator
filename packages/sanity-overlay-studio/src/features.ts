/**
 * Disabling the hosted-only Studio features (PRD §21.10, §32.2).
 *
 * These are load-bearing, not cosmetic. Comments, Tasks, Releases and Scheduled
 * Drafts are hosted collaboration and versioning infrastructure that reads and
 * writes the *real* dataset. Against a virtual dataset they either fail with
 * confusing mid-edit errors or, worse, succeed against staging. Native History
 * shows Content Lake transactions the overlay never produced. Vision runs
 * arbitrary GROQ no candidate plan can answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT sanity 6.8.0 ACTUALLY ALLOWS — read this before "simplifying" any of it.
 *
 * `getDefaultPluginsOptions(rawWorkspace)` (`lib/WorkspaceLoader-BRx2afZV.js`
 * :8033-8060) decides whether the hosted plugins are *registered at all*, and it
 * is pure direct property access on the object passed to `defineConfig`. It never
 * calls `flattenConfig`. Therefore:
 *
 *   - `tasks`, `scheduledPublishing` are not even keys on `PluginOptions`;
 *   - `releases.enabled` IS a key on `PluginOptions` and is *silently ignored*
 *     for both registration and `Source.releases`;
 *   - `scheduledDrafts.enabled` from a plugin flips the runtime flag but does
 *     not stop the tool and the `schedule` action being installed.
 *
 * And `prepareConfig` appends the hosted plugins *after* every user plugin
 * (:8211-8213), while `flattenConfig` puts the root config LAST — so a plugin's
 * `tools` / `document.actions` / `document.inspectors` resolver never sees what
 * those plugins contribute, and only a root-level resolver does.
 *
 * Consequence: the resolvers below are exported so the *config wrapper* can
 * install them at the root, where they are guaranteed to run last. The plugin
 * carries only what genuinely works from a plugin.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const HOSTED_FEATURES = [
  'comments',
  'tasks',
  'releases',
  'scheduledDrafts',
  'history',
  'aiAssist',
  'vision',
] as const

export type HostedFeature = (typeof HOSTED_FEATURES)[number]

/** How completely the feature can be taken away. */
export type HostedFeatureRemoval =
  /** Gone. No surface, no route, no residue that matters. */
  | 'clean'
  /** The UI is gone but some machinery or deep link survives. */
  | 'partial'
  /** Not part of `sanity` at all — it only exists if the consumer installs it. */
  | 'not-installed'

/** Where the switch lives. */
export type HostedFeatureLever =
  /** A key on the object passed to `defineConfig`. A plugin cannot set it. */
  | 'workspace-config'
  /** A `PluginOptions` key that really is read through `flattenConfig`. */
  | 'plugin-option'
  /** A `tools` / `inspectors` / `actions` resolver, which must run last. */
  | 'resolver'
  | 'none'

export interface HostedFeatureReport {
  feature: HostedFeature
  removal: HostedFeatureRemoval
  lever: HostedFeatureLever
  /** The exact config key or resolver, where there is one. */
  configKey?: string
  /** What survives when `removal` is `partial`. */
  residue?: string
  why: string
}

const REPORTS: Readonly<Record<HostedFeature, HostedFeatureReport>> = Object.freeze({
  comments: {
    feature: 'comments',
    removal: 'clean',
    lever: 'plugin-option',
    configKey: 'document.comments.enabled',
    why:
      'Read through `documentCommentsEnabledReducer`, which flattens the plugin chain, so a ' +
      'plugin can set it. The `sanity/comments` plugin stays mounted but its inspector menu ' +
      'item reports `hidden` and its document layout short-circuits, so no surface remains.',
  },
  tasks: {
    feature: 'tasks',
    removal: 'clean',
    lever: 'workspace-config',
    configKey: 'tasks.enabled',
    why:
      '`tasks` is not a key on `PluginOptions` at all. Registration is decided from the raw ' +
      'workspace object, so it must be set on the object passed to defineConfig (the root ' +
      'config) — a plugin cannot reach it. Set there, the plugin is never installed.',
  },
  releases: {
    feature: 'releases',
    removal: 'clean',
    lever: 'workspace-config',
    configKey: 'releases.enabled',
    why:
      '`releases` IS a key on `PluginOptions`, but `releases.enabled` is read by direct ' +
      'property access on the source config for both plugin registration and `Source.releases`, ' +
      'so a plugin value is silently ignored. Only the root/workspace config works.',
  },
  scheduledDrafts: {
    feature: 'scheduledDrafts',
    removal: 'clean',
    lever: 'workspace-config',
    configKey: 'scheduledDrafts.enabled',
    why:
      'Split behaviour: the runtime flag flattens (a plugin can flip it) but registration of ' +
      'the `sanity/schedules` tool and `sanity/singleDocRelease` reads the raw workspace ' +
      'object. Only the root config removes the tool and the `schedule` document action. ' +
      'Legacy `scheduledPublishing.enabled` is likewise workspace-only.',
  },
  history: {
    feature: 'history',
    removal: 'partial',
    lever: 'resolver',
    configKey: 'document.inspectors + document.actions',
    residue:
      'the document-events/timeline machinery still runs, the `?rev=`/`?since=` pane params ' +
      'and the "compare versions" route are still reachable by deep link, and the Releases ' +
      'tool links straight to the history inspector when releases are enabled',
    why:
      'sanity 6.8.0 has NO on/off config key for history. The inspector `sanity/structure/history` ' +
      'and the `restore` action can be filtered out of the resolvers, and the code that opens ' +
      'them is guarded (`historyInspector && …`) so it degrades to a no-op. The panel and the ' +
      'revert button go away; the underlying machinery does not. Reported as partial for that ' +
      'reason — replacing it with overlay history is §32.2 "Overlay revision history", still to build.',
  },
  aiAssist: {
    feature: 'aiAssist',
    removal: 'not-installed',
    lever: 'none',
    why:
      'AI Assist ships as the separate `@sanity/assist` package and is not a dependency of ' +
      '`sanity`; there is no `beta.aiAssist` or equivalent core key. If a consumer installs it, ' +
      'remove it from their `plugins` array. Hosted Agent Actions reach the network through ' +
      '`client.agent.action.*`, which the overlay facade refuses outright — that half is enforced.',
  },
  vision: {
    feature: 'vision',
    removal: 'clean',
    lever: 'resolver',
    configKey: 'tools',
    why:
      '`@sanity/vision` is an external plugin; it only exists if the consumer adds ' +
      '`visionTool()`. Its tool is removed through the `tools` resolver. That resolver must run ' +
      'after the plugin that contributed it, which is why the shipped config wrapper installs ' +
      'it at the root rather than inside the overlay plugin.',
  },
})

export function hostedFeatureReport(feature: HostedFeature): HostedFeatureReport {
  return REPORTS[feature]
}

export function hostedFeatureReports(): HostedFeatureReport[] {
  return HOSTED_FEATURES.map((feature) => REPORTS[feature])
}

/**
 * The keys that only work on the object passed to `defineConfig`.
 *
 * Every one of these is read by direct property access on the raw workspace, so
 * a `definePlugin` setting them is a no-op. The config wrapper merges this.
 */
export function overlayWorkspaceFeatureFlags(): Record<string, {enabled: false}> {
  return {
    tasks: {enabled: false},
    releases: {enabled: false},
    scheduledDrafts: {enabled: false},
    scheduledPublishing: {enabled: false},
    /* Not in §21.10, but the same class of problem: product announcement cards
     * advertise hosted features that do not work here. */
    announcements: {enabled: false},
  }
}

/** What a plugin genuinely can turn off by itself. */
export function overlayDocumentPluginOptions(): {comments: {enabled: false}} {
  return {comments: {enabled: false}}
}

/**
 * Tools that must not be reachable in an overlay workspace.
 *
 * `vision` is `@sanity/vision`. `releases` is the `sanity/schedules` plugin's
 * tool (§21.6 "Release queries: Disabled"), `schedules` is legacy scheduled
 * publishing, and `media-library` / `canvas` are hosted asset and editing
 * surfaces that write outside the overlay.
 */
export const DISABLED_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'vision',
  'releases',
  'schedules',
  'media-library',
  'canvas',
])

export function filterHostedTools<T extends {name: string}>(tools: readonly T[]): T[] {
  return tools.filter((tool) => !DISABLED_HOSTED_TOOL_NAMES.has(tool.name))
}

/** The native history inspector's name in sanity 6.8.0. */
export const HISTORY_INSPECTOR_NAME = 'sanity/structure/history'

/** The comments inspector, which `document.comments.enabled: false` already hides. */
export const COMMENTS_INSPECTOR_NAME = 'sanity/comments/comments'

/**
 * Inspectors removed in an overlay workspace.
 *
 * The comments inspector is here as well as behind `document.comments.enabled`
 * on purpose: the config key hides its menu item, this removes the inspector.
 * Two independent switches for one hosted surface is the right ratio when the
 * failure mode is a collaboration feature silently writing to the real dataset.
 */
export const DISABLED_HOSTED_INSPECTOR_NAMES: ReadonlySet<string> = new Set([
  HISTORY_INSPECTOR_NAME,
  COMMENTS_INSPECTOR_NAME,
])

export function filterHostedInspectors<T extends {name: string}>(inspectors: readonly T[]): T[] {
  return inspectors.filter((inspector) => !DISABLED_HOSTED_INSPECTOR_NAMES.has(inspector.name))
}
