/**
 * `ci` — the PRD §37 Phase 6 "CI" checklist as one runnable gate.
 *
 * ## What this command is, and what it is not
 *
 * It is a COMPOSITION. Every answer comes from a package that already owned the
 * question: the §34 invariants and the merge engine from `sanity-overlay-core`,
 * `classifyTokenEnvKey` and the hosted-feature lists from
 * `sanity-overlay-studio`, the `.sanity-overlay/` layout from
 * `sanity-overlay-store-fs`. Query parity is not here at all — it is a suite,
 * and the workflow runs the suite.
 *
 * ## Two rules that make it a gate rather than a badge
 *
 * 1. **A skip is not a pass.** A check that cannot run — no `--schema`, no
 *    `--base`, an empty file set, `--checkpoint-policy off` — reports `skip`
 *    with a reason and the run exits non-zero, unless the invocation named that
 *    check in `--allow-skip`. The consequence is that a workflow has to declare,
 *    in configuration, exactly which checks are inert in that repository and
 *    therefore why. Silence is not available.
 * 2. **Every check reports what it measured.** `documents`, `files`, `names`,
 *    `references`, `imports`. A gate that reports zero findings over zero inputs
 *    is worse than no gate, because it reads as evidence; the counts are how a
 *    reviewer tells the two apart, and they are printed in both output formats.
 */
import {readFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import type {SanityDocument, SerializedSchemaArtifact} from '../../../sanity-overlay-core/src/index'
import {usageError} from '../errors'
import {EXIT} from '../exit'
import {loadRecords, openOverlay, type LoadedRecords, type OpenedOverlay} from '../overlay'
import {DEFAULT_SOURCE_EXTENSIONS, collectSources} from '../sources'
import {
  CI_CHECKS,
  type CiCheckId,
  type CiCheckResult,
  type CiReport,
} from '../ci/checks'
import {skipped} from '../ci/checks'
import {
  CHECKPOINT_POLICIES,
  baseDriftCheck,
  branchSchemaCheck,
  checkpointPolicyCheck,
  conflictSummaryCheck,
  overlaySchemasCheck,
  strongReferencesCheck,
  type BaseDriftCheck,
  type CheckpointPolicy,
  type ConflictSummaryCheck,
  type OverlayCheckInput,
} from '../ci/overlayChecks'
import {scanForUnsupportedPlugins, scanForWriteTokens} from '../ci/scan'
import {renderCiText, renderConflictMarkdown} from '../ci/report'
import {
  createHttpGitHubClient,
  parseRepository,
  publishPrReport,
  type FetchLike,
} from '../ci/github'

export interface CiOptions {
  readonly check?: readonly string[]
  readonly allowSkip?: readonly string[]
  readonly schema?: string
  readonly base?: string
  readonly config?: readonly string[]
  readonly envFile?: readonly string[]
  readonly checkpointPolicy?: string
  readonly format?: string
  readonly report?: string
  readonly repository?: string
  readonly pr?: string
  readonly sha?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

const FORMATS: readonly string[] = ['text', 'markdown']

/** Files a preview deployment is configured by. */
const PREVIEW_CONFIG_EXTENSIONS: readonly string[] = [
  '.env',
  '.yml',
  '.yaml',
  '.json',
  '.sh',
  ...DEFAULT_SOURCE_EXTENSIONS,
]

/** `.env.preview`, `.env.production` — the suffix is the environment, not the type. */
const isDotenv = (basename: string): boolean => /(^|\/)\.env(\..+)?$/.test(basename)

async function readJsonFile(root: string, option: string, path: string): Promise<unknown> {
  const target = isAbsolute(path) ? path : resolve(root, path)
  let text: string
  try {
    text = await readFile(target, 'utf8')
  } catch {
    throw usageError(`${option} file ${target} could not be read`, {path: target})
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw usageError(`${option} file ${target} is not valid JSON: ${(error as Error).message}`, {
      path: target,
    })
  }
}

async function readSchemaArtifact(root: string, path: string): Promise<SerializedSchemaArtifact> {
  const parsed = await readJsonFile(root, '--schema', path)
  const record = parsed as {schemaCommit?: unknown; types?: unknown} | null
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.schemaCommit !== 'string' ||
    !Array.isArray(record.types)
  ) {
    throw usageError(
      `--schema ${path} must hold a PRD §20.1 serialized schema artifact: {"schemaCommit": string, "types": []}`,
      {path},
    )
  }
  return parsed as SerializedSchemaArtifact
}

async function readBaseDocuments(root: string, path: string): Promise<SanityDocument[]> {
  const parsed = await readJsonFile(root, '--base', path)
  const documents = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : null
  if (documents === null) {
    throw usageError(`--base file ${path} must hold an array of documents or an id→document map`, {
      path,
    })
  }
  return documents.filter(
    (document): document is SanityDocument =>
      document !== null && typeof document === 'object' && typeof (document as SanityDocument)._id === 'string',
  )
}

function selectChecks(requested: readonly string[] | undefined): CiCheckId[] {
  if (requested === undefined || requested.length === 0) return [...CI_CHECKS]
  const unknown = requested.filter((id) => !(CI_CHECKS as readonly string[]).includes(id))
  if (unknown.length > 0) {
    throw usageError(
      `Unknown --check ${unknown.map((id) => JSON.stringify(id)).join(', ')}; expected one of ${CI_CHECKS.join(', ')}`,
      {unknown},
    )
  }
  /* Deduplicated, in the declared order, so the report is diffable. */
  return CI_CHECKS.filter((id) => requested.includes(id))
}

function selectAllowedSkips(requested: readonly string[] | undefined): Set<string> {
  if (requested === undefined) return new Set()
  const allowed = new Set<string>()
  for (const id of requested) {
    if (id === 'all') {
      for (const check of CI_CHECKS) allowed.add(check)
      allowed.add('pr-report')
      continue
    }
    if (!(CI_CHECKS as readonly string[]).includes(id) && id !== 'pr-report') {
      throw usageError(
        `Unknown --allow-skip ${JSON.stringify(id)}; expected "all", "pr-report", or one of ${CI_CHECKS.join(', ')}. ` +
          `A typo here would silently leave a gate un-enforced, so it is refused.`,
        {id},
      )
    }
    allowed.add(id)
  }
  return allowed
}

export async function runCi(ctx: {
  readonly root: string
  readonly json: boolean
  readonly now: () => string
  readonly out: (line: string) => void
  readonly warn: (line: string) => void
  readonly emitJson: (value: unknown) => void
}, options: CiOptions): Promise<number> {
  const format = options.format ?? 'text'
  if (!FORMATS.includes(format)) {
    throw usageError(`Unknown --format ${JSON.stringify(format)}; expected ${FORMATS.join(' or ')}`, {
      format,
    })
  }
  const policy = (options.checkpointPolicy ?? 'required') as CheckpointPolicy
  if (!(CHECKPOINT_POLICIES as readonly string[]).includes(policy)) {
    throw usageError(
      `Unknown --checkpoint-policy ${JSON.stringify(options.checkpointPolicy)}; expected ${CHECKPOINT_POLICIES.join(', ')}. ` +
        `"required" is decision D05's default-when-unanswered (block merge when uncheckpointed revisions exist).`,
      {policy: options.checkpointPolicy},
    )
  }
  if (options.report !== undefined && options.report !== 'pr') {
    throw usageError(`Unknown --report ${JSON.stringify(options.report)}; expected "pr"`, {
      report: options.report,
    })
  }

  const selected = selectChecks(options.check)
  const allowedSkips = selectAllowedSkips(options.allowSkip)

  const schema =
    options.schema === undefined ? undefined : await readSchemaArtifact(ctx.root, options.schema)
  const baseDocuments =
    options.base === undefined ? undefined : await readBaseDocuments(ctx.root, options.base)

  /* Opened lazily: `write-tokens` and `unsupported-plugins` read project
   * configuration and have nothing to say about an overlay, so a repository
   * with no `.sanity-overlay/` can still run them. */
  let opened: OpenedOverlay | null = null
  let loaded: LoadedRecords | null = null
  const overlay = async (): Promise<OverlayCheckInput> => {
    if (opened === null) {
      opened = await openOverlay(ctx.root, ctx.now)
      loaded = await loadRecords(opened)
    }
    return {
      opened,
      loaded: loaded!,
      ...(schema === undefined ? {} : {schema}),
      ...(baseDocuments === undefined ? {} : {baseDocuments}),
      now: ctx.now(),
    }
  }

  const results: CiCheckResult[] = []
  let conflictCheck: ConflictSummaryCheck | null = null
  let driftCheck: BaseDriftCheck | null = null

  for (const check of selected) {
    switch (check) {
      case 'overlay-schemas':
        results.push(await overlaySchemasCheck(await overlay()))
        break
      case 'branch-schema':
        results.push(branchSchemaCheck(await overlay()))
        break
      case 'strong-references':
        results.push(strongReferencesCheck(await overlay()))
        break
      case 'checkpoint-policy':
        results.push(checkpointPolicyCheck((await overlay()).opened.manifest, policy))
        break
      case 'conflict-summary':
        conflictCheck = conflictSummaryCheck(await overlay())
        results.push(conflictCheck.result)
        break
      case 'base-drift':
        driftCheck = baseDriftCheck(await overlay())
        results.push(driftCheck.result)
        break
      case 'unsupported-plugins': {
        const files =
          options.config === undefined || options.config.length === 0
            ? []
            : await collectSources(ctx.root, options.config, {
                extensions: DEFAULT_SOURCE_EXTENSIONS,
              })
        if (files.length === 0) {
          results.push(
            skipped(
              'unsupported-plugins',
              options.config === undefined || options.config.length === 0
                ? 'no Studio configuration to scan: pass --config <path>… naming the directories that hold sanity.config.* and the plugin list.'
                : `no source file matched under ${options.config.join(', ')} — the paths are wrong, and a plugin scan over zero files proves nothing.`,
              {files: 0, imports: 0, pluginCalls: 0},
            ),
          )
          break
        }
        const scan = scanForUnsupportedPlugins(files.map(({file, source}) => ({file, source})))
        results.push({
          check: 'unsupported-plugins',
          task: 'Check unsupported plugins.',
          status: scan.findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
          findings: scan.findings,
          measured: scan.measured,
        })
        break
      }
      case 'write-tokens': {
        const files =
          options.envFile === undefined || options.envFile.length === 0
            ? []
            : await collectSources(ctx.root, options.envFile, {
                extensions: PREVIEW_CONFIG_EXTENSIONS,
                include: isDotenv,
              })
        if (files.length === 0) {
          results.push(
            skipped(
              'write-tokens',
              options.envFile === undefined || options.envFile.length === 0
                ? 'no preview configuration to scan: pass --env-file <path>… naming the dotenv, workflow, vercel.json or source files a preview deployment is configured by.'
                : `no configuration file matched under ${options.envFile.join(', ')} — the paths are wrong, and a credential scan over zero files proves nothing.`,
              {files: 0, names: 0, credentials: 0, readOnly: 0, writeCapable: 0},
            ),
          )
          break
        }
        const scan = scanForWriteTokens(files.map(({file, source}) => ({file, source})))
        results.push({
          check: 'write-tokens',
          task: 'Check no write tokens in preview configuration.',
          status: scan.findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
          findings: scan.findings,
          measured: scan.measured,
        })
        break
      }
      default: {
        const exhaustive: never = check
        throw usageError(`Unhandled check ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  const failed = results.filter((result) => result.status === 'fail').map((result) => result.check)
  const skippedNotAllowed = results
    .filter((result) => result.status === 'skip' && !allowedSkips.has(result.check))
    .map((result) => result.check)

  /* The PR report. Never invented: it needs a repository, a pull request number,
   * a commit sha and a token, and if any is missing it says so rather than
   * reporting a delivery that did not happen. */
  let prReport: CiReport['prReport']
  if (options.report === 'pr') {
    const token = options.env?.GITHUB_TOKEN ?? options.env?.GH_TOKEN
    const repository = options.repository ?? options.env?.GITHUB_REPOSITORY
    const pullNumber = Number.parseInt(options.pr ?? '', 10)
    const sha = options.sha ?? options.env?.GITHUB_SHA
    const missing: string[] = []
    if (token === undefined || token.length === 0) missing.push('GITHUB_TOKEN')
    if (repository === undefined || repository.length === 0) missing.push('--repository')
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) missing.push('--pr')
    if (sha === undefined || sha.length === 0) missing.push('--sha')
    if (conflictCheck === null) missing.push('--check conflict-summary')

    if (missing.length > 0) {
      prReport = {
        status: 'skip',
        reason:
          `no pull request report was sent: ${missing.join(', ')} absent. On a fork pull request ` +
          `GITHUB_TOKEN is read-only by design (PRD §11.5, §39.2 D14), so this is expected there ` +
          `— but it is reported rather than passed over in silence.`,
      }
    } else {
      const target = {...parseRepository(repository!), pullNumber, sha: sha!}
      const body = renderConflictMarkdown({
        report: {
          ok: failed.length === 0,
          root: ctx.root,
          overlayId: opened === null ? null : (opened as OpenedOverlay).overlayId,
          checks: results,
          failed,
          skipped: skippedNotAllowed,
        },
        summary: conflictCheck!.summary,
        manifestSummary: conflictCheck!.manifestSummary,
        conflicts: conflictCheck!.conflicts,
        ...(driftCheck === null
          ? {}
          : {
              drift: {
                changed: driftCheck.changed,
                recomputed: driftCheck.recomputed,
                driftedDocuments: driftCheck.driftedDocuments,
              },
            }),
      })
      const result = await publishPrReport({
        client: createHttpGitHubClient({
          token: token!,
          fetch: (globalThis as unknown as {fetch: FetchLike}).fetch,
        }),
        target,
        body,
        previous: driftCheck === null ? null : driftCheck.previous,
        current: driftCheck === null ? conflictCheck!.summary : driftCheck.recomputed,
      })
      prReport = {
        status: 'sent',
        comment: result.comment.action,
        commitStatus: result.statusSent ? result.status.state : 'unchanged',
      }
    }
  }

  const prSkipped = prReport?.status === 'skip' && !allowedSkips.has('pr-report')

  const report: CiReport = {
    ok: failed.length === 0 && skippedNotAllowed.length === 0 && !prSkipped,
    root: ctx.root,
    overlayId: opened === null ? null : (opened as OpenedOverlay).overlayId,
    checks: results,
    failed,
    skipped: skippedNotAllowed,
    ...(prReport === undefined ? {} : {prReport}),
  }

  ctx.emitJson(report)
  if (!ctx.json) {
    if (format === 'markdown' && conflictCheck !== null) {
      ctx.out(
        renderConflictMarkdown({
          report,
          summary: conflictCheck.summary,
          manifestSummary: conflictCheck.manifestSummary,
          conflicts: conflictCheck.conflicts,
          ...(driftCheck === null
            ? {}
            : {
                drift: {
                  changed: driftCheck.changed,
                  recomputed: driftCheck.recomputed,
                  driftedDocuments: driftCheck.driftedDocuments,
                },
              }),
        }),
      )
    } else {
      for (const line of renderCiText(report)) ctx.out(line)
    }
  }

  return failed.length > 0 || skippedNotAllowed.length > 0 || prSkipped ? EXIT.FINDINGS : EXIT.OK
}
