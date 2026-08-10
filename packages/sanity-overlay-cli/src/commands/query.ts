/**
 * `query` — GROQ against the branch, through the registry.
 *
 * The command takes a registered query ID, never GROQ text. That is the whole
 * point: PRD §22.5 rejects unregistered queries and §5.5 forbids silent
 * approximation, so the CLI runs `evaluateOverlayQuery` over the same registry
 * the runtime uses and inherits its refusals verbatim. A `--query` escape hatch
 * would be a second, weaker policy, and the first thing anyone would reach for
 * when the registry said no.
 *
 * `--base` supplies the base dataset as a JSON file because `fs` mode has no
 * connection to the Content Lake. Omitting it evaluates against an EMPTY base,
 * which is exact for branch-created documents and honestly incomplete for
 * anything else — the diagnostics report the base fetch counts so the difference
 * is visible rather than assumed.
 */
import {readFile} from 'node:fs/promises'
import {
  M_LOCAL_QUERIES,
  OverlayQueryError,
  createMemoryBaseSource,
  createQueryRegistry,
  evaluateOverlayQuery,
} from 'sanity-overlay-query'
import type {
  QueryCaller,
  QueryDocument,
  QueryPerspective,
} from 'sanity-overlay-query'
import {buildOverlaySource} from 'sanity-overlay-client'
import type {OverlayRecordMap} from 'sanity-overlay-core'
import {CliError, usageError} from '../errors'
import {EXIT} from '../exit'
import {loadRecords, openOverlay} from '../overlay'
import {table, toJson} from '../render'
import type {CommandContext} from '../types'

export interface QueryOptions {
  readonly queryId?: string
  readonly list?: boolean
  readonly params?: readonly string[]
  readonly base?: string
  readonly perspective?: string
  readonly caller?: string
}

const CALLERS: readonly string[] = ['frontend', 'studio', 'agent', 'test']
const PERSPECTIVES: readonly string[] = ['published', 'drafts', 'raw']

/** `k=v`, where `v` is JSON when it parses and a plain string otherwise. */
function parseParams(entries: readonly string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      throw usageError(
        `--param ${JSON.stringify(entry)} must be in the form name=value`,
        {param: entry},
      )
    }
    const name = entry.slice(0, eq)
    const raw = entry.slice(eq + 1)
    try {
      params[name] = JSON.parse(raw)
    } catch {
      params[name] = raw
    }
  }
  return params
}

async function readBaseDataset(path: string | undefined): Promise<QueryDocument[]> {
  if (path === undefined) return []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw usageError(`--base file ${path} could not be read`, {path})
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw usageError(`--base file ${path} is not valid JSON: ${(error as Error).message}`, {path})
  }
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
    (doc): doc is QueryDocument =>
      doc !== null &&
      typeof doc === 'object' &&
      typeof (doc as QueryDocument)._id === 'string' &&
      typeof (doc as QueryDocument)._type === 'string',
  )
}

export async function runQuery(ctx: CommandContext, options: QueryOptions): Promise<number> {
  const registry = createQueryRegistry(M_LOCAL_QUERIES)

  if (options.list === true) {
    const definitions = [...registry.definitions].sort((a, b) => (a.id < b.id ? -1 : 1))
    ctx.emitJson({
      queries: definitions.map((def) => ({
        id: def.id,
        status: def.status,
        description: def.description,
        plan: def.candidatePlan.type,
        callers: def.allowedCallers,
        perspectives: def.perspectives,
      })),
    })
    if (!ctx.json) {
      for (const line of table([
        ['ID', 'TIER', 'PLAN', 'CALLERS', 'DESCRIPTION'],
        ...definitions.map((def) => [
          def.id,
          def.status,
          def.candidatePlan.type,
          def.allowedCallers.join('|'),
          def.description,
        ]),
      ])) {
        ctx.out(line)
      }
    }
    return EXIT.OK
  }

  if (options.queryId === undefined) {
    throw usageError(
      'query requires a registered query id (or --list to see them). GROQ text is deliberately not accepted: unregistered queries are rejected, never approximated (PRD §22.5, §5.5).',
    )
  }

  const caller = options.caller ?? 'agent'
  if (!CALLERS.includes(caller)) {
    throw usageError(`Unknown --caller ${JSON.stringify(caller)}; expected ${CALLERS.join(', ')}`)
  }
  const perspective = options.perspective ?? 'drafts'
  if (!PERSPECTIVES.includes(perspective)) {
    throw usageError(
      `Unknown --perspective ${JSON.stringify(perspective)}; expected ${PERSPECTIVES.join(', ')}`,
    )
  }

  const params = parseParams(options.params ?? [])
  const baseDocuments = await readBaseDataset(options.base)
  const base = createMemoryBaseSource(baseDocuments)

  const opened = await openOverlay(ctx.root, ctx.now)
  const loaded = await loadRecords(opened)

  try {
    const overlay = await buildOverlaySource({
      snapshot: {
        overlayId: opened.overlayId,
        revision: opened.manifest.revision,
        records: loaded.records as OverlayRecordMap,
        token: `${opened.manifest.revision}:${opened.manifest.updatedAt}`,
      },
      base,
      perspective: perspective as QueryPerspective,
      now: ctx.now(),
    })

    const result = await evaluateOverlayQuery({
      registry,
      queryId: options.queryId,
      params,
      base,
      overlay,
      caller: caller as QueryCaller,
      perspective: perspective as QueryPerspective,
    })

    ctx.emitJson({queryId: options.queryId, result: result.result, diagnostics: result.diagnostics})
    if (!ctx.json) {
      ctx.out(toJson(result.result).trimEnd())
      ctx.out('')
      ctx.out(
        `candidates ${result.diagnostics.candidateCount}  baseRequests ${result.diagnostics.baseRequestCount}  refDepth ${result.diagnostics.referenceDepth}  exact ${result.diagnostics.exact}`,
      )
    }
    return EXIT.OK
  } catch (error) {
    if (error instanceof OverlayQueryError) {
      throw new CliError(EXIT.QUERY_REFUSED, error.code, error.message, error.details ?? {})
    }
    throw error
  }
}
