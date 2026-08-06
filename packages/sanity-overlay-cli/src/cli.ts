/**
 * The dispatcher — argv in, exit code out.
 *
 * Argument parsing is `node:util`'s `parseArgs` in strict mode. Strict matters:
 * an unknown option is a usage error, not something to ignore. A CLI that
 * silently swallowed `--dry-run` because it was misspelled would happily destroy
 * an overlay the operator thought they were only inspecting.
 *
 * Every command body throws `CliError` on failure and returns an exit code on
 * success, so this module is the single place where a failure becomes an exit
 * code and a rendered message — and the single place where secret redaction is
 * applied to both streams.
 */
import {parseArgs} from 'node:util'
import {runCleanup} from './commands/cleanup'
import {runConflicts} from './commands/conflicts'
import {runDiff} from './commands/diff'
import {runExport, runImport} from './commands/checkpoint'
import {runHistory} from './commands/history'
import {runInspect} from './commands/inspect'
import {runNormalize} from './commands/normalize'
import {runQuery} from './commands/query'
import {runRebase} from './commands/rebase'
import {runReset} from './commands/reset'
import {runStatus} from './commands/status'
import {runValidate} from './commands/validate'
import {CliError, usageError} from './errors'
import {EXIT, EXIT_CODE_TABLE} from './exit'
import {asCliError, resolveRoot} from './overlay'
import {collectSecrets, redact} from './redact'
import {toJson} from './render'
import type {CommandContext, RunCliOptions} from './types'

export const CLI_NAME = 'sanity-overlay'
export const CLI_VERSION = '0.1.0'

/**
 * PRD §14.5 "Filesystem commands" — the SPECIFIED command surface, verbatim and
 * in the order the fenced block gives it.
 *
 * This is the inventory. {@link PHASE_2_CLI_COMMANDS} below is a schedule that
 * selects from it, and the two must not be confused: `normalize
 * --repair-checksums` is named here and used again verbatim in the §29.4
 * checkpoint-commit recipe, so a dispatcher pinned to the phase checklist would
 * make the PRD's own documented workflow un-runnable.
 *
 * `materialize` and `promotion-plan` are named here and deliberately not
 * dispatched — see {@link CLI_COMMANDS}.
 */
export const PRD_14_5_COMMANDS = Object.freeze([
  'inspect',
  'status',
  'validate',
  'materialize',
  'normalize',
  'diff',
  'reset',
  'rebase',
  'conflicts',
  'export',
  'import',
  'query',
  'promotion-plan',
] as const)

/**
 * The PRD §37 Phase 2 "CLI" checklist, verbatim and in the order the PRD gives
 * it. These ten are what that checklist names — a strict subset of
 * {@link PRD_14_5_COMMANDS}.
 *
 * A phase checklist bounds the WORK of a phase, not the CLI. Nothing may be
 * removed from this list to make a schedule look met; nothing may be added to it
 * to justify a new verb.
 */
export const PHASE_2_CLI_COMMANDS = Object.freeze([
  'inspect',
  'status',
  'validate',
  'diff',
  'reset',
  'rebase',
  'conflicts',
  'query',
  'export',
  'import',
] as const)

/**
 * Commands this CLI dispatches that PRD §14.5 does NOT name, each mapped to the
 * §37 Phase 2 task it exists to serve.
 *
 * These two are the real deviation, and they are small: the PRD mandates the
 * capability as a Phase 2 "Filesystem store task" and simply never spells a verb
 * for it. Recording the rationale beside the name means the next command cannot
 * be added without writing down why — the guard is the justification, not a
 * count.
 */
export const COMMANDS_BEYOND_PRD = Object.freeze({
  history:
    'PRD §37 Phase 2 Filesystem store tasks → "Local runtime history". The task is mandated; §14.5 names no verb for reading the local transaction log.',
  cleanup:
    'PRD §37 Phase 2 Filesystem store tasks → "Local cleanup", carrying §15.7 retention to fs mode. The task is mandated; §14.5 names no verb for it.',
} as const)

/**
 * Every command the CLI dispatches.
 *
 * = the ten §37 Phase 2 commands
 * + `normalize`, which §14.5 and §29.4 name directly and which is the §37 Phase 2
 *   "Local UX" surface for "File parse error UI" and "Reset actions"
 * + the {@link COMMANDS_BEYOND_PRD} pair.
 *
 * Two §14.5 commands are absent on purpose:
 *
 * - `materialize` — §14.4 step 6 materializes into `.runtime/materialized/` on
 *   every revalidation, so there is no operator-triggered work left to expose.
 *   A command that only re-ran an automatic step would imply the step is
 *   optional.
 * - `promotion-plan` — §37 Phase 8, superseded in full by §0.0. This system
 *   never writes to a Sanity dataset, so there is no promotion to plan.
 */
export const CLI_COMMANDS = Object.freeze([
  ...PHASE_2_CLI_COMMANDS,
  'normalize',
  'history',
  'cleanup',
] as const)

export type CliCommand = (typeof CLI_COMMANDS)[number]

type OptionConfig = Parameters<typeof parseArgs>[0] extends {options?: infer O} ? O : never

const GLOBAL_OPTIONS = {
  root: {type: 'string'},
  json: {type: 'boolean'},
  help: {type: 'boolean', short: 'h'},
} as const

const COMMAND_OPTIONS: Record<CliCommand, Record<string, unknown>> = {
  inspect: {document: {type: 'string'}},
  status: {},
  validate: {strict: {type: 'boolean'}, checkpoint: {type: 'string'}},
  diff: {
    document: {type: 'string'},
    'name-only': {type: 'boolean'},
    'exit-code': {type: 'boolean'},
    system: {type: 'boolean'},
  },
  reset: {
    document: {type: 'string'},
    all: {type: 'boolean'},
    confirm: {type: 'boolean'},
    'dry-run': {type: 'boolean'},
  },
  rebase: {
    document: {type: 'string'},
    base: {type: 'string'},
    mode: {type: 'string'},
    confirm: {type: 'boolean'},
    'dry-run': {type: 'boolean'},
  },
  conflicts: {
    document: {type: 'string'},
    all: {type: 'boolean'},
    actions: {type: 'boolean'},
  },
  query: {
    list: {type: 'boolean'},
    param: {type: 'string', multiple: true},
    base: {type: 'string'},
    perspective: {type: 'string'},
    caller: {type: 'string'},
  },
  export: {
    output: {type: 'string'},
    bundle: {type: 'string'},
    'no-transactions': {type: 'boolean'},
  },
  import: {
    input: {type: 'string'},
    bundle: {type: 'string'},
    overwrite: {type: 'boolean'},
    confirm: {type: 'boolean'},
    strict: {type: 'boolean'},
    'no-verify-checksum': {type: 'boolean'},
  },
  normalize: {
    'repair-checksums': {type: 'boolean'},
    document: {type: 'string'},
  },
  history: {
    document: {type: 'string'},
    limit: {type: 'string'},
    since: {type: 'string'},
    order: {type: 'string'},
    mutations: {type: 'boolean'},
  },
  cleanup: {
    confirm: {type: 'boolean'},
    'dry-run': {type: 'boolean'},
    'keep-last': {type: 'string'},
    'keep-after-revision': {type: 'string'},
  },
}

const USAGE_SUMMARY: Record<CliCommand, string> = {
  inspect: 'manifest, document heads, or one document in detail',
  status: 'one-screen branch summary: revision, states, conflicts, checkpoint',
  validate: 'run the PRD §34 invariants and verify every stored checksum',
  diff: 'what this branch changed versus its base, per document and per path',
  reset: 'discard branch state (destructive — needs --confirm)',
  rebase: 'replace the merge ancestor with the current base (destructive — needs --confirm)',
  conflicts: 'list unresolved conflicts and the resolution actions that apply',
  query: 'evaluate a REGISTERED query against the branch',
  export: 'write a checkpoint tree (--output) or a portable bundle (--bundle)',
  import: 'load a checkpoint tree (--input) or a portable bundle (--bundle)',
  normalize:
    're-run the §14.4 direct-edit checks; --repair-checksums recomputes stale ones',
  history: 'the local overlay transaction log — what this branch did, in order',
  cleanup: 'reclaim orphan artifacts and prune runtime growth (destructive — needs --confirm)',
}

function helpText(): string {
  const lines: string[] = [
    `${CLI_NAME} ${CLI_VERSION} — local branch overlay tooling (PRD §37 Phase 2)`,
    '',
    `usage: ${CLI_NAME} <command> [options]`,
    '',
    'Commands',
  ]
  const width = Math.max(...CLI_COMMANDS.map((command) => command.length))
  for (const command of CLI_COMMANDS) {
    lines.push(`  ${command.padEnd(width)}  ${USAGE_SUMMARY[command]}`)
  }
  lines.push(
    '',
    'Global options',
    '  --root <dir>   directory containing .sanity-overlay/ (default: cwd)',
    '  --json         machine-readable output on stdout',
    '  --help, -h     this text',
    '  --version      print the version',
    '',
    'Exit codes',
  )
  for (const [code, meaning] of EXIT_CODE_TABLE) lines.push(`  ${code}  ${meaning}`)
  lines.push(
    '',
    'Notes',
    '  reset, rebase and cleanup never write without --confirm; all support --dry-run.',
    '  query takes a registered query ID, not GROQ text (PRD §22.5, §5.5).',
    '  rebase and query need --base <file.json>: fs mode has no live base connection.',
    '  validate measures and never writes; normalize is the repair half (PRD §14.5).',
    '  validate --checkpoint <dir> REJECTS repairable checksum divergence;',
    '  import repairs it by default (PRD §14.3, §29.7) unless given --strict.',
    '  export/import --bundle is lossless; --output/--input is the §29.1 review tree.',
    '  history is the OVERLAY log, not Sanity History, and lives in gitignored',
    '  .runtime/ — a fresh clone or a checkpoint import has none (PRD §14.1, §29.2).',
  )
  return lines.join('\n')
}

function parse(
  command: CliCommand,
  argv: readonly string[],
): {values: Record<string, unknown>; positionals: string[]} {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command]} as OptionConfig,
      allowPositionals: true,
      strict: true,
    })
    return {values: parsed.values as Record<string, unknown>, positionals: parsed.positionals}
  } catch (error) {
    throw usageError(`${CLI_NAME} ${command}: ${(error as Error).message}`)
  }
}

async function dispatch(
  command: CliCommand,
  values: Record<string, unknown>,
  positionals: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  switch (command) {
    case 'status':
      return runStatus(ctx)
    case 'inspect':
      return runInspect(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
      })
    case 'validate':
      return runValidate(ctx, {
        strict: values.strict === true,
        ...(typeof values.checkpoint === 'string' ? {checkpoint: values.checkpoint} : {}),
      })
    case 'diff':
      return runDiff(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
        nameOnly: values['name-only'] === true,
        exitCode: values['exit-code'] === true,
        system: values.system === true,
      })
    case 'reset':
      return runReset(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
        all: values.all === true,
        confirm: values.confirm === true,
        dryRun: values['dry-run'] === true,
      })
    case 'rebase':
      return runRebase(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
        ...(typeof values.base === 'string' ? {base: values.base} : {}),
        ...(typeof values.mode === 'string' ? {mode: values.mode} : {}),
        confirm: values.confirm === true,
        dryRun: values['dry-run'] === true,
      })
    case 'conflicts':
      return runConflicts(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
        all: values.all === true,
        actions: values.actions === true,
      })
    case 'query':
      return runQuery(ctx, {
        ...(positionals[0] === undefined ? {} : {queryId: positionals[0]}),
        list: values.list === true,
        ...(Array.isArray(values.param) ? {params: values.param as string[]} : {}),
        ...(typeof values.base === 'string' ? {base: values.base} : {}),
        ...(typeof values.perspective === 'string' ? {perspective: values.perspective} : {}),
        ...(typeof values.caller === 'string' ? {caller: values.caller} : {}),
      })
    case 'export':
      return runExport(ctx, {
        ...(typeof values.output === 'string' ? {output: values.output} : {}),
        ...(typeof values.bundle === 'string' ? {bundle: values.bundle} : {}),
        noTransactions: values['no-transactions'] === true,
      })
    case 'import':
      return runImport(ctx, {
        ...(typeof values.input === 'string' ? {input: values.input} : {}),
        ...(typeof values.bundle === 'string' ? {bundle: values.bundle} : {}),
        overwrite: values.overwrite === true,
        confirm: values.confirm === true,
        strict: values.strict === true,
        noVerifyChecksum: values['no-verify-checksum'] === true,
      })
    case 'normalize':
      return runNormalize(ctx, {
        repairChecksums: values['repair-checksums'] === true,
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
      })
    case 'history':
      return runHistory(ctx, {
        ...(typeof values.document === 'string' ? {document: values.document} : {}),
        ...(typeof values.limit === 'string' ? {limit: values.limit} : {}),
        ...(typeof values.since === 'string' ? {since: values.since} : {}),
        ...(typeof values.order === 'string' ? {order: values.order} : {}),
        mutations: values.mutations === true,
      })
    case 'cleanup':
      return runCleanup(ctx, {
        confirm: values.confirm === true,
        dryRun: values['dry-run'] === true,
        ...(typeof values['keep-last'] === 'string' ? {keepLast: values['keep-last']} : {}),
        ...(typeof values['keep-after-revision'] === 'string'
          ? {keepAfterRevision: values['keep-after-revision']}
          : {}),
      })
    default: {
      const exhaustive: never = command
      throw usageError(`Unknown command ${JSON.stringify(exhaustive)}`)
    }
  }
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const secrets = collectSecrets(options.env ?? {})
  const write = (chunk: string): void => options.io.out(redact(chunk, secrets))
  const writeError = (chunk: string): void => options.io.err(redact(chunk, secrets))
  const argv = [...options.argv]

  /* Global short-circuits, valid with or without a command. */
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length === 0) {
      writeError(`usage: ${CLI_NAME} <command> [options]\n`)
      writeError(`Run \`${CLI_NAME} --help\` for the command list.\n`)
      return EXIT.USAGE
    }
    write(`${helpText()}\n`)
    return EXIT.OK
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    write(`${CLI_VERSION}\n`)
    return EXIT.OK
  }

  const command = argv[0] as CliCommand
  if (!CLI_COMMANDS.includes(command)) {
    writeError(
      `${CLI_NAME}: unknown command ${JSON.stringify(argv[0])}. Expected one of: ${CLI_COMMANDS.join(', ')}\n`,
    )
    return EXIT.USAGE
  }

  let json = false
  try {
    const {values, positionals} = parse(command, argv.slice(1))
    json = values.json === true
    if (values.help === true) {
      write(`${helpText()}\n`)
      return EXIT.OK
    }

    const root = await resolveRoot(
      options.cwd,
      typeof values.root === 'string' ? values.root : undefined,
    )
    const ctx: CommandContext = {
      root,
      json,
      now: options.now ?? (() => new Date().toISOString()),
      out: (line) => write(`${line}\n`),
      warn: (line) => writeError(`${line}\n`),
      emitJson: (value) => {
        if (json) write(toJson(value))
      },
    }
    return await dispatch(command, values, positionals, ctx)
  } catch (error) {
    const cli: CliError = asCliError(error)
    if (json) {
      writeError(toJson({ok: false, code: cli.code, message: cli.message, details: cli.details}))
    } else {
      /* The machine-readable code is printed alongside the prose so a script can
       * grep for `QUERY_NOT_REGISTERED` without asking for `--json`, and so a
       * bug report carries the code rather than a paraphrase of the sentence. */
      writeError(`${CLI_NAME} ${command}: ${cli.message} [${cli.code}]\n`)
    }
    return cli.exitCode
  }
}
