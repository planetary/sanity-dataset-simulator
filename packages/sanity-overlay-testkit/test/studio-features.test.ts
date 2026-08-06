/**
 * `sanity-overlay-studio` — disabling the hosted-only Studio features
 * (PRD §21.10, §32.2).
 *
 * These are load-bearing, not cosmetic. Comments, Tasks, Releases and Scheduled
 * Drafts are hosted collaboration/versioning infrastructure that reads and
 * writes the *real* dataset; against a virtual dataset they either fail with
 * confusing errors or — worse — succeed against staging. Native History shows
 * Content Lake transactions the overlay never produced. Vision runs arbitrary
 * GROQ the overlay cannot answer.
 *
 * WHAT THIS FILE ALSO PINS: the honest limits. sanity 6.8.0 reads the
 * registration switches for tasks/releases/scheduledDrafts/scheduledPublishing
 * by **direct property access on the workspace object** — `getDefaultPluginsOptions`
 * never calls `flattenConfig` — so a `definePlugin` literally cannot turn them
 * off. And hosted plugins are appended *after* every user plugin, so a plugin's
 * `document.actions` / `tools` resolver never sees what they contribute. Both
 * facts are encoded below as data, so the package cannot quietly start claiming
 * a removal it does not achieve.
 */
import {describe, expect, it} from 'vitest'
import {
  DISABLED_HOSTED_TOOL_NAMES,
  HISTORY_INSPECTOR_NAME,
  HOSTED_FEATURES,
  hostedFeatureReport,
  overlayDocumentPluginOptions,
  overlayWorkspaceFeatureFlags,
  filterHostedInspectors,
  filterHostedTools,
} from '../../sanity-overlay-studio/src/features'

describe('the seven hosted features are each accounted for', () => {
  it('names exactly the §21.10 set the brief requires', () => {
    expect([...HOSTED_FEATURES]).toEqual([
      'comments',
      'tasks',
      'releases',
      'scheduledDrafts',
      'history',
      'aiAssist',
      'vision',
    ])
  })

  it('gives every feature a lever, a removal class and a reason', () => {
    for (const feature of HOSTED_FEATURES) {
      const report = hostedFeatureReport(feature)
      expect(report.feature, feature).toBe(feature)
      expect(['clean', 'partial', 'not-installed'], feature).toContain(report.removal)
      expect(['workspace-config', 'plugin-option', 'resolver', 'none'], feature).toContain(
        report.lever,
      )
      expect(report.why.length, feature).toBeGreaterThan(20)
    }
  })

  it('does not claim a clean removal where sanity 6.8.0 cannot give one', () => {
    /* History leaves the timeline machinery and `?rev=` deep links behind; the
     * scheduled-drafts *tool* is registered from the raw workspace object. */
    expect(hostedFeatureReport('history').removal).toBe('partial')
    expect(hostedFeatureReport('history').residue).toMatch(/deep link|timeline|compare/i)
  })

  it('records that a plugin alone cannot disable the workspace-registered features', () => {
    for (const feature of ['tasks', 'releases', 'scheduledDrafts'] as const) {
      expect(hostedFeatureReport(feature).lever, feature).toBe('workspace-config')
      expect(hostedFeatureReport(feature).why, feature).toMatch(/workspace|defineConfig|root/i)
    }
  })

  it('reports comments as cleanly removable from a plugin option', () => {
    expect(hostedFeatureReport('comments')).toMatchObject({
      removal: 'clean',
      lever: 'plugin-option',
      configKey: 'document.comments.enabled',
    })
  })

  it('reports AI Assist and Vision as external packages, not core config', () => {
    expect(hostedFeatureReport('aiAssist').removal).toBe('not-installed')
    expect(hostedFeatureReport('vision').lever).toBe('resolver')
  })
})

describe('overlayWorkspaceFeatureFlags — the root-config keys', () => {
  const flags = overlayWorkspaceFeatureFlags()

  it('switches off every hosted feature that can only be switched off at the root', () => {
    expect(flags).toMatchObject({
      tasks: {enabled: false},
      releases: {enabled: false},
      scheduledDrafts: {enabled: false},
      scheduledPublishing: {enabled: false},
    })
  })

  it('also silences Sanity product announcements, which are hosted upsell surfaces', () => {
    expect(flags.announcements).toEqual({enabled: false})
  })

  it('touches nothing else — it is merged into a consumer’s config', () => {
    expect(Object.keys(flags).sort()).toEqual(
      ['announcements', 'releases', 'scheduledDrafts', 'scheduledPublishing', 'tasks'].sort(),
    )
  })
})

describe('overlayDocumentPluginOptions — what a plugin CAN do', () => {
  it('disables comments through the flattened document option', () => {
    expect(overlayDocumentPluginOptions()).toMatchObject({comments: {enabled: false}})
  })
})

describe('filterHostedTools', () => {
  it('removes Vision, the releases tool and the scheduled-publishing tool', () => {
    const tools = [
      {name: 'structure', title: 'Structure'},
      {name: 'vision', title: 'Vision'},
      {name: 'releases', title: 'Releases'},
      {name: 'schedules', title: 'Schedules'},
      {name: 'media-library', title: 'Media Library'},
      {name: 'canvas', title: 'Canvas'},
    ]
    expect(filterHostedTools(tools).map((tool) => tool.name)).toEqual(['structure'])
  })

  it('keeps a consumer’s own tools untouched', () => {
    const tools = [{name: 'my-dashboard'}, {name: 'structure'}]
    expect(filterHostedTools(tools)).toEqual(tools)
  })

  it('exports the removed set as data, so the report cannot drift from the code', () => {
    expect([...DISABLED_HOSTED_TOOL_NAMES].sort()).toEqual(
      ['canvas', 'media-library', 'releases', 'schedules', 'vision'].sort(),
    )
  })

  it('returns a new array rather than mutating the resolver input', () => {
    const tools = [{name: 'vision'}, {name: 'structure'}]
    const result = filterHostedTools(tools)
    expect(tools).toHaveLength(2)
    expect(result).not.toBe(tools)
  })
})

describe('filterHostedInspectors', () => {
  it('removes the native history inspector by its 6.8.0 name', () => {
    expect(HISTORY_INSPECTOR_NAME).toBe('sanity/structure/history')
    const inspectors = [
      {name: 'sanity/structure/validation'},
      {name: 'sanity/structure/history'},
      {name: 'sanity/comments/comments'},
      {name: 'my/custom'},
    ]
    expect(filterHostedInspectors(inspectors).map((inspector) => inspector.name)).toEqual([
      'sanity/structure/validation',
      'my/custom',
    ])
  })

  it('is a no-op when the structure tool is declared after the overlay plugin', () => {
    /* `prev` is empty in that ordering — the plugin simply has nothing to strip,
     * which is why the shipped config wrapper puts the resolver at the root. */
    expect(filterHostedInspectors([])).toEqual([])
  })
})
