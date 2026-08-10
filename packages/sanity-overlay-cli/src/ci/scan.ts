/**
 * The two checks that read PROJECT CONFIGURATION rather than overlay state:
 * `unsupported-plugins` (PRD §21.10, §21.11) and `write-tokens` (PRD §11.3,
 * invariant §34.15).
 *
 * Neither rule is invented here.
 *
 * - The write-token verdict is `classifyTokenEnvKey` from
 *   `sanity-overlay-studio/src/options.ts` — the exact function the Studio
 *   refuses to boot against. One question, one answer, no second regex that
 *   drifts from it.
 * - The plugin deny list is derived from that package's `HOSTED_FEATURES` and
 *   `DISABLED_HOSTED_TOOL_NAMES`, so a feature the Studio learns to disable is
 *   automatically a feature CI refuses.
 *
 * Extraction is textual on purpose: the CLI's stated constraint is Node
 * built-ins only, so there is no TypeScript compiler and no YAML parser here.
 * That is a real limitation and it cuts one way only — a name written in a form
 * these patterns miss is not reported, so the check can under-report but never
 * fabricate. The measured counts exist so an under-reporting scan is visible as
 * a suspiciously small number rather than as a green tick.
 */
import {
  classifyTokenEnvKey,
  isBrowserReachableEnvKey,
} from 'sanity-overlay-studio/options'
import {
  DISABLED_HOSTED_TOOL_NAMES,
  HOSTED_FEATURES,
} from 'sanity-overlay-studio/features'
import type {CiFinding} from './checks'

/* ------------------------------------------------------------------ *
 * Environment names
 * ------------------------------------------------------------------ */

/**
 * Every shape a preview environment variable NAME appears in, across the file
 * kinds a preview deployment is configured by.
 *
 * Deliberately name-only. A value is a secret; reading one into a report would
 * put it in a CI log, which is the thing this check exists to prevent.
 */
const ENV_NAME_PATTERNS: readonly RegExp[] = [
  /* dotenv and shell: `SANITY_API_TOKEN=…`, `export SANITY_API_TOKEN=…` */
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm,
  /* YAML `env:` entries and any other uppercase-ish YAML key. */
  /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*:/gm,
  /* GitHub Actions expressions: `${{ secrets.X }}`, `${{ env.X }}`. */
  /\$\{\{[ \t]*(?:secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /* JSON object keys, e.g. vercel.json `env` / `build.env`. */
  /"([A-Za-z_][A-Za-z0-9_]*)"[ \t]*:/g,
  /* Source: `process.env.X` and `process.env['X']`. */
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[[ \t]*['"]([^'"]+)['"]/g,
]

export interface EnvNameHit {
  readonly name: string
  readonly file: string
  readonly line: number
}

function lineNumberAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1
  return line
}

/** Every environment-variable name this file mentions, deduplicated per file. */
export function extractEnvNames(file: string, source: string): EnvNameHit[] {
  const seen = new Set<string>()
  const hits: EnvNameHit[] = []
  for (const pattern of ENV_NAME_PATTERNS) {
    const rx = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = rx.exec(source)) !== null) {
      const name = match[1]
      if (name === undefined || seen.has(name)) continue
      seen.add(name)
      hits.push({name, file, line: lineNumberAt(source, match.index)})
    }
  }
  return hits.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export interface WriteTokenScan {
  readonly findings: CiFinding[]
  readonly measured: Record<string, number>
}

/**
 * PRD §11.3 — "no write-capable Sanity credential may exist in the application
 * runtime", and invariant §34.15 "Preview mode never contains or uses a Sanity
 * write credential".
 *
 * Fails closed, exactly as the Studio does: a Sanity-scoped credential whose
 * name does not positively say read-only is treated as write-capable.
 */
export function scanForWriteTokens(
  files: readonly {readonly file: string; readonly source: string}[],
): WriteTokenScan {
  const findings: CiFinding[] = []
  let names = 0
  let credentials = 0
  let readOnly = 0
  let writeCapable = 0

  for (const {file, source} of files) {
    for (const hit of extractEnvNames(file, source)) {
      names += 1
      const verdict = classifyTokenEnvKey(hit.name)
      if (verdict === 'not-a-credential') continue
      credentials += 1

      if (verdict === 'read-only') {
        readOnly += 1
        if (isBrowserReachableEnvKey(hit.name)) {
          findings.push({
            severity: 'warning',
            ref: `${hit.file}:${hit.line}`,
            message:
              `\`${hit.name}\` is a read-only Sanity credential but carries a browser-reachable ` +
              `prefix, so its value is compiled into the bundle and served to every visitor. It ` +
              `cannot write, so this does not fail the gate — move it to a server-only variable.`,
          })
        }
        continue
      }

      writeCapable += 1
      findings.push({
        severity: 'error',
        ref: `${hit.file}:${hit.line}`,
        message:
          `\`${hit.name}\` names a Sanity credential whose capability cannot be established from ` +
          `its name, so it is treated as write-capable. PRD §11.3 and invariant §34.15 forbid a ` +
          `write-capable Sanity credential in preview configuration. Remove it, or rename it to ` +
          `say read-only (e.g. \`SANITY_API_READ_TOKEN\`).`,
      })
    }
  }

  return {findings, measured: {files: files.length, names, credentials, readOnly, writeCapable}}
}

/* ------------------------------------------------------------------ *
 * Unsupported plugins
 * ------------------------------------------------------------------ */

/**
 * Module specifiers PRD §21.11 classifies "Unsupported", plus the packages that
 * ship the §21.10 features by name.
 *
 * Matched on the package identity — `@sanity/vision` and `@sanity/vision/lib/x`
 * are the same plugin — never on a substring of an unrelated name.
 */
export const UNSUPPORTED_PLUGIN_MODULES: Readonly<Record<string, string>> = Object.freeze({
  '@sanity/vision': 'PRD §21.10 "Vision arbitrary GROQ by default" — no candidate plan can answer it.',
  '@sanity/scheduled-publishing':
    'PRD §21.10 "Scheduled Drafts" — schedules execute against the hosted dataset, not the overlay.',
  '@sanity/assist':
    'PRD §21.10 "AI Assist or Agent Actions that target the hosted dataset unless a provider is explicitly overlay-aware".',
  '@sanity/comments': 'PRD §21.10 "Comments" — hosted collaboration infrastructure outside overlay state.',
  '@sanity/tasks': 'PRD §21.10 "Tasks and assignments".',
  '@sanity/dashboard':
    'PRD §21.11 "Plugin using direct HTTP endpoints — Unsupported until adapted"; the dashboard widgets read hosted project endpoints.',
  '@sanity/production-preview':
    'PRD §21.11 "Plugin using direct HTTP endpoints — Unsupported until adapted".',
  '@sanity/google-maps-input':
    'PRD §21.11 "Plugin using direct HTTP endpoints — Unsupported until adapted"; endpoint audit required before re-enabling.',
})

/**
 * Studio-side symbols that install one of those features.
 *
 * Derived from `sanity-overlay-studio`: {@link HOSTED_FEATURES} is the §21.10
 * list the plugin disables and {@link DISABLED_HOSTED_TOOL_NAMES} is the set of
 * tools it removes, so this gate cannot bless a feature the Studio refuses.
 */
export const UNSUPPORTED_PLUGIN_SYMBOLS: ReadonlySet<string> = new Set([
  'visionTool',
  'scheduledPublishing',
  'scheduledDrafts',
  'comments',
  'tasks',
  'assist',
  'dashboardTool',
  'mediaLibrary',
  'canvasTool',
])

/** Every hosted surface CI refuses, from the Studio's own two lists. */
export const UNSUPPORTED_HOSTED_NAMES: readonly string[] = Object.freeze(
  [...new Set<string>([...HOSTED_FEATURES, ...DISABLED_HOSTED_TOOL_NAMES])].sort(),
)

/** `import … from '<specifier>'`, `export … from`, `require('<specifier>')`, `import('<specifier>')`. */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;])(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/**
 * A call that installs a plugin or defines a workspace.
 *
 * Counted so the check can prove it PARSED a Studio configuration rather than
 * reading a directory of prose: a config with zero plugin calls means the
 * pattern set missed, and that shows up as a measured zero.
 */
const PLUGIN_CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g

const CONFIG_ENTRY_SYMBOLS: ReadonlySet<string> = new Set([
  'defineConfig',
  'defineCliConfig',
  'definePlugin',
  'defineOverlayConfig',
])

function packageOf(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return specifier
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

export interface PluginScan {
  readonly findings: CiFinding[]
  readonly measured: Record<string, number>
}

export function scanForUnsupportedPlugins(
  files: readonly {readonly file: string; readonly source: string}[],
): PluginScan {
  const findings: CiFinding[] = []
  let imports = 0
  let pluginCalls = 0

  for (const {file, source} of files) {
    const seenModules = new Set<string>()
    for (const pattern of IMPORT_PATTERNS) {
      const rx = new RegExp(pattern.source, pattern.flags)
      let match: RegExpExecArray | null
      while ((match = rx.exec(source)) !== null) {
        const specifier = match[1]
        if (specifier === undefined) continue
        const key = `${specifier}@${match.index}`
        if (seenModules.has(key)) continue
        seenModules.add(key)
        imports += 1

        const pkg = packageOf(specifier)
        const why = UNSUPPORTED_PLUGIN_MODULES[pkg]
        if (why === undefined) continue
        findings.push({
          severity: 'error',
          ref: `${file}:${lineNumberAt(source, match.index)}`,
          message: `${file} imports ${pkg}, which the overlay workspace does not support. ${why}`,
        })
      }
    }

    const calls = new RegExp(PLUGIN_CALL_PATTERN.source, PLUGIN_CALL_PATTERN.flags)
    const reportedSymbols = new Set<string>()
    let call: RegExpExecArray | null
    while ((call = calls.exec(source)) !== null) {
      const symbol = call[1]
      if (symbol === undefined) continue
      if (CONFIG_ENTRY_SYMBOLS.has(symbol) || UNSUPPORTED_PLUGIN_SYMBOLS.has(symbol)) pluginCalls += 1
      else if (/Tool$|^structureTool$|^presentationTool$/.test(symbol)) pluginCalls += 1

      if (!UNSUPPORTED_PLUGIN_SYMBOLS.has(symbol) || reportedSymbols.has(symbol)) continue
      reportedSymbols.add(symbol)
      findings.push({
        severity: 'error',
        ref: `${file}:${lineNumberAt(source, call.index)}`,
        message:
          `${file} installs \`${symbol}()\`, a hosted Studio surface PRD §21.10 requires to be ` +
          `disabled in an overlay workspace (${UNSUPPORTED_HOSTED_NAMES.join(', ')}).`,
      })
    }
  }

  return {findings, measured: {files: files.length, imports, pluginCalls}}
}
