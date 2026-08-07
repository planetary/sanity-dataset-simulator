/**
 * `codemod` — PRD §22.5 "[MUST] Provide a codemod that replaces direct Sanity
 * client imports with the environment-aware client and attaches stable query IDs
 * where queries are statically discoverable", and "[MUST] CI runs the codemod in
 * check mode".
 *
 * CHECK MODE IS THE DEFAULT. A migration tool whose default writes is one
 * mis-typed path away from rewriting a directory nobody meant to touch, and
 * check mode is also the mode CI needs. `--write` is the explicit opt-in, in
 * the same spirit as `--confirm` on the destructive commands.
 *
 * A refused file fails BOTH modes. A refusal is unfinished migration work: the
 * file still imports a client that bypasses the overlay, and `--write` cannot
 * silently declare success just because it chose not to touch it.
 *
 * The transform lives in `sanity-overlay-query`; this command is file IO, an
 * exit code, and nothing else.
 */
import {writeFile} from 'node:fs/promises'
import {
  M_LOCAL_QUERIES,
  formatCodemodReport,
  runClientImportCodemod,
} from '../../../sanity-overlay-query/src/index'
import type {RegisteredQuerySummary} from '../../../sanity-overlay-query/src/index'
import {EXIT} from '../exit'
import {collectSources} from '../sources'
import type {CommandContext} from '../types'

export interface CodemodOptions {
  readonly paths?: readonly string[]
  readonly write?: boolean
  readonly module?: string
  readonly ext?: string
  readonly ignore?: readonly string[]
}

export async function runCodemod(ctx: CommandContext, options: CodemodOptions): Promise<number> {
  const sources = await collectSources(ctx.root, options.paths ?? [], {
    ...(options.ext === undefined ? {} : {extensions: options.ext.split(',')}),
    ...(options.ignore === undefined ? {} : {ignore: [...options.ignore]}),
  })

  const registry: RegisteredQuerySummary[] = M_LOCAL_QUERIES.map((def) => ({
    id: def.id,
    query: def.query,
  }))
  const report = runClientImportCodemod(
    sources.map(({file, source}) => ({file, source})),
    {registry, ...(options.module === undefined ? {} : {module: options.module})},
  )

  let written = 0
  if (options.write === true) {
    const byFile = new Map(sources.map((source) => [source.file, source.path]))
    for (const result of report.results) {
      if (!result.changed) continue
      const path = byFile.get(result.file)
      if (path === undefined) continue
      await writeFile(path, result.code, 'utf8')
      written++
    }
  }

  ctx.emitJson({...report, mode: options.write === true ? 'write' : 'check', written})
  if (!ctx.json) {
    ctx.out(formatCodemodReport(report))
    if (options.write === true) ctx.out(`${written} file${written === 1 ? '' : 's'} written`)
  }

  /*
   * check: any pending rewrite or refusal fails.
   * write: the rewrites are now applied, so only refusals remain — and a
   *        refusal is still unfinished migration work.
   */
  const failing = options.write === true ? report.filesRefused > 0 : !report.ok
  return failing ? EXIT.FINDINGS : EXIT.OK
}
