/**
 * `lint` — PRD §22.5 "[MUST] CI runs … the lint rule in error mode after
 * migration."
 *
 * The rule itself lives in `sanity-overlay-query` and is a pure function of a
 * source string and the registry. This command is the ENFORCEMENT half, and it
 * is the half that was missing: a checker that only prints is documentation.
 * Here an unregistered query, a drifted query text, a direct `@sanity/client`
 * or a native Sanity Live subscription returns {@link EXIT.FINDINGS}, and a CI
 * step that runs this command therefore fails the build.
 *
 * `--mode warn` is §22.5's "[SHOULD] Allow a local development warning mode
 * during migration": the same findings, printed, exit 0. It has to be asked for
 * — a gate that defaulted to warning would be off by default.
 *
 * The registry is the in-process `M_LOCAL_QUERIES`, not a JSON manifest, so
 * this command cannot drift from the registry the runtime evaluates against.
 */
import {
  M_LOCAL_QUERIES,
  checkSourcesForUnregisteredQueries,
  formatQueryLintReport,
} from '../../../sanity-overlay-query/src/index'
import type {QueryLintMode, RegisteredQuerySummary} from '../../../sanity-overlay-query/src/index'
import {usageError} from '../errors'
import {EXIT} from '../exit'
import {collectSources} from '../sources'
import type {CommandContext} from '../types'

export interface LintOptions {
  readonly paths?: readonly string[]
  readonly mode?: string
  readonly ext?: string
  readonly ignore?: readonly string[]
}

const MODES: readonly string[] = ['strict', 'warn']

export async function runLint(ctx: CommandContext, options: LintOptions): Promise<number> {
  const mode = options.mode ?? 'strict'
  if (!MODES.includes(mode)) {
    throw usageError(
      `Unknown --mode ${JSON.stringify(mode)}; expected ${MODES.join(' or ')}. ` +
        `"warn" is the §22.5 migration mode and does not fail the build.`,
      {mode},
    )
  }

  const sources = await collectSources(ctx.root, options.paths ?? [], {
    ...(options.ext === undefined ? {} : {extensions: options.ext.split(',')}),
    ...(options.ignore === undefined ? {} : {ignore: [...options.ignore]}),
  })

  const registry: RegisteredQuerySummary[] = M_LOCAL_QUERIES.map((def) => ({
    id: def.id,
    query: def.query,
  }))
  const report = checkSourcesForUnregisteredQueries(
    sources.map(({file, source}) => ({file, source})),
    {registry, mode: mode as QueryLintMode},
  )

  ctx.emitJson(report)
  if (!ctx.json) ctx.out(formatQueryLintReport(report))

  /* `ok` is false only in strict mode: warn mode reports and returns 0. */
  return report.ok ? EXIT.OK : EXIT.FINDINGS
}
