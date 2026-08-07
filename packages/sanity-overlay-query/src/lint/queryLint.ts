/**
 * The STATIC half of PRD §22.5 — "an ESLint rule that blocks unregistered GROQ
 * construction … CI runs the lint rule in error mode".
 *
 * §22.5 has four requirements about unregistered queries. Three are runtime
 * behaviours this package already implements (log, reject in strict mode, allow
 * a warning mode during migration); they fire when a query RUNS. This module is
 * the fourth: find the query in the SOURCE, before it runs.
 *
 * WHY THIS IS NOT AN ESLINT PLUGIN. Plugin packaging is not the part with any
 * content — the decision "is this GROQ literal registered?" is, and it is a
 * pure function of a source string and the registry. Written this way it can be
 * called from an ESLint rule, from a CI script (`lint/check-queries.mjs`), or
 * from the CLI package, and it adds no dependency to a package PRD §10.1 pins
 * to exactly one.
 *
 * WHY ONE FILE. `lint/check-queries.mjs` loads this module directly through
 * Node's type stripping, which resolves module specifiers the way ESM does —
 * extensionless relative imports would not resolve. Keeping the checker free of
 * runtime imports is what lets the same source serve the bundler and Node.
 *
 * WHAT IT CANNOT DO, stated here because a check that overstates its coverage
 * is worse than no check. It reads literals; it does not evaluate the program.
 * A query assembled from fragments, loaded from a file, or received over the
 * network is invisible to it. §22.5 answers that case by forbidding dynamic
 * construction rather than by demanding a smarter linter, so a literal that IS
 * visibly assembled at runtime is reported (`dynamic-query`) instead of being
 * silently resolved. The limits are pinned as tests in
 * `sanity-overlay-testkit/test/lint-unregistered-queries.test.ts`.
 */

/* ================================================================== *
 * A. Literal scanning.
 * ================================================================== */

export interface SourceLiteral {
  /** Literal content with escapes resolved; `${…}` marks an interpolation. */
  readonly text: string
  readonly kind: 'string' | 'template'
  /** Offset of the opening quote, and of the first character after the close. */
  readonly index: number
  readonly end: number
  /** True when a template literal contains `${…}`: its runtime text is unknown. */
  readonly interpolated: boolean
  /** True when the literal is an operand of `+`: likewise unknown. */
  readonly concatenated: boolean
  /** Tag of a tagged template, e.g. `groq` in ``groq`*[…]` ``. */
  readonly tag?: string
  /** Name of the call the literal is an argument of, e.g. `fetch`, `defineQuery`. */
  readonly callee?: string
  /**
   * The identifier immediately before the literal, whitespace skipped — `from`
   * in `from '@sanity/client'`, `import` in a bare side-effect import. This is
   * what makes "module specifier" distinguishable from "a string that happens
   * to name a package", which the import half of the rule depends on.
   */
  readonly precedingWord?: string
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
}

const IDENTIFIER = /[A-Za-z0-9_$]/

/** A `/` starts a regex unless the previous token could end an expression. */
const REGEX_CANNOT_FOLLOW = new Set([')', ']', '}'])

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

/**
 * Find every string, template and tagged-template literal in a JavaScript or
 * TypeScript source, skipping comments and regular expressions.
 *
 * This is a lexical scan, not a parse. It is deliberately conservative about
 * the two constructs that would otherwise desynchronise it — comments and
 * regular expressions — because a scanner that mistook `/['"]/` for division
 * would read the rest of the file as one string and report nothing at all.
 */
export function scanStringLiterals(source: string): SourceLiteral[] {
  const literals: SourceLiteral[] = []
  let index = 0
  let line = 1
  let lineStart = 0
  /** Last character that was neither whitespace nor part of a comment. */
  let previous = ''

  const advanceNewlines = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (source[i] === '\n') {
        line++
        lineStart = i + 1
      }
    }
  }

  /** The next character that is neither whitespace nor a comment. */
  const nextSignificant = (from: number): string => {
    let i = from
    while (i < source.length) {
      const character = source[i]
      if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
        i++
      } else if (character === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++
      } else if (character === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? source.length : end + 2
      } else {
        return character
      }
    }
    return ''
  }

  /** The identifier ending at `end` (exclusive), if the char before it is one. */
  const identifierBefore = (end: number): {name: string; start: number} | undefined => {
    let i = end
    while (i > 0 && IDENTIFIER.test(source[i - 1])) i--
    if (i === end) return undefined
    return {name: source.slice(i, end), start: i}
  }

  /** The identifier before `start`, whitespace skipped: `from '…'`, `import '…'`. */
  const wordBefore = (start: number): string | undefined => {
    let i = start
    while (i > 0 && /\s/.test(source[i - 1])) i--
    return identifierBefore(i)?.name
  }

  /** The call this literal is the first argument of, e.g. `client.fetch(<here>`. */
  const calleeBefore = (start: number): string | undefined => {
    let i = start - 1
    while (i >= 0 && /\s/.test(source[i])) i--
    if (i < 0 || source[i] !== '(') return undefined
    let j = i
    while (j > 0 && /\s/.test(source[j - 1])) j--
    return identifierBefore(j)?.name
  }

  while (index < source.length) {
    const character = source[index]

    if (character === '\n') {
      line++
      index++
      lineStart = index
      continue
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      index++
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      advanceNewlines(index, stop)
      index = stop
      continue
    }
    if (character === '/' && !IDENTIFIER.test(previous) && !REGEX_CANNOT_FOLLOW.has(previous)) {
      // Regular expression literal: skip it, character class included.
      let i = index + 1
      let inClass = false
      while (i < source.length) {
        const c = source[i]
        if (c === '\\') i += 2
        else if (c === '[') {
          inClass = true
          i++
        } else if (c === ']') {
          inClass = false
          i++
        } else if (c === '/' && !inClass) break
        else if (c === '\n') break
        else i++
      }
      index = i + 1
      previous = '/'
      continue
    }

    if (character === '"' || character === "'" || character === '`') {
      const start = index
      const startColumn = start - lineStart + 1
      const startLine = line
      const template = character === '`'
      let text = ''
      let interpolated = false
      let i = index + 1
      let braceDepth = 0
      let terminated = false

      while (i < source.length) {
        const c = source[i]
        if (braceDepth > 0) {
          // Inside `${ … }`: track nesting and skip nested literals wholesale.
          if (c === '{') braceDepth++
          else if (c === '}') braceDepth--
          else if (c === '"' || c === "'" || c === '`') {
            const quote = c
            i++
            while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
          }
          i++
          continue
        }
        if (c === '\\') {
          const escaped = source[i + 1]
          text += ESCAPES[escaped] ?? escaped ?? ''
          i += 2
          continue
        }
        if (c === character) {
          terminated = true
          break
        }
        if (template && c === '$' && source[i + 1] === '{') {
          interpolated = true
          text += '${…}'
          braceDepth = 1
          i += 2
          continue
        }
        if (!template && c === '\n') break // an unterminated quoted string
        text += c
        i++
      }

      const end = terminated ? i + 1 : i
      const tag = template ? identifierBefore(start)?.name : undefined
      const callee = calleeBefore(start)
      const precedingWord = wordBefore(start)
      const concatenated = previous === '+' || nextSignificant(end) === '+'
      literals.push({
        text,
        kind: template ? 'template' : 'string',
        index: start,
        end,
        interpolated,
        concatenated,
        ...(tag === undefined ? {} : {tag}),
        ...(callee === undefined ? {} : {callee}),
        ...(precedingWord === undefined ? {} : {precedingWord}),
        line: startLine,
        column: startColumn,
      })
      advanceNewlines(start, end)
      index = end
      previous = character
      continue
    }

    previous = character
    index++
  }

  return literals
}

/* ================================================================== *
 * B. Which literals are GROQ.
 * ================================================================== */

/**
 * `*[` at the start of the literal, or immediately after an opening bracket,
 * pipe, comma or equals — the positions a GROQ filter actually appears in.
 *
 * The looser rule "contains `*[`" was tried and rejected: it reports `'2 * [3]'`
 * and any prose that multiplies by an array index. A checker whose output is
 * mostly false positives gets switched off, which is the failure mode that
 * matters here.
 */
const GROQ_FILTER = /(^\s*|[({|,=]\s*)\*\s*\[/

/** Tags and calls whose argument is a query by construction (§22.5 `defineQuery`). */
const QUERY_TAGS = new Set(['groq'])
const QUERY_CALLS = new Set(['defineQuery'])

export function looksLikeGroq(literal: SourceLiteral): boolean {
  if (literal.tag !== undefined && QUERY_TAGS.has(literal.tag)) return true
  if (literal.callee !== undefined && QUERY_CALLS.has(literal.callee)) return true
  return GROQ_FILTER.test(literal.text)
}

/* ================================================================== *
 * B2. Which literals are module specifiers, and which of those reach
 *     the Content Lake past the overlay.
 *
 * PRD §22.5 asks the rule to block two things, and the second is the
 * one with the silent failure mode: "direct overlay-bypassing Sanity
 * clients in preview-aware application code". An unregistered query is
 * REFUSED by the registry at runtime, so it surfaces as a 422. A direct
 * `@sanity/client` is never offered to the registry at all — it reads
 * base and renders staging content while the rest of the deployment
 * believes it is on a branch.
 * ================================================================== */

/**
 * Packages whose client talks to the Content Lake directly. Matched as a
 * package boundary, not a prefix: `@sanity/client-lookalike` is a different
 * package and flagging it would be a false positive.
 */
const BYPASSING_MODULES = ['@sanity/client', 'next-sanity'] as const

/**
 * Named imports that subscribe the page to Content Lake pushes.
 *
 * Separated from the plain import finding because the FIX is different, and a
 * rule that sends the reader to the wrong fix is worse than silence: swapping
 * the import leaves the subscription in place, and the subscription is the
 * bypass. §37 Phase 5 lists "Disable native Sanity Live in overlay mode" as its
 * own task for the same reason.
 */
export const LIVE_SPECIFIERS = [
  'defineLive',
  'SanityLive',
  'useLiveQuery',
  'useLiveEvents',
] as const

/** The Live specifier an import clause names, if any. */
export const liveSpecifierIn = (clause: string): string | undefined =>
  LIVE_SPECIFIERS.find((name) => new RegExp(`\\b${name}\\b`).test(clause))

/** True when `text` is `pkg` or a subpath of it (`pkg/sub`), never `pkg-other`. */
const isModule = (text: string, pkg: string): boolean =>
  text === pkg || text.startsWith(`${pkg}/`)

export function bypassingModuleOf(literal: SourceLiteral): string | undefined {
  /* Position first. `const externals = ['@sanity/client']` names the package
   * without importing it, and so does an error message. */
  const isSpecifier =
    literal.precedingWord === 'from' ||
    literal.precedingWord === 'import' ||
    literal.callee === 'require' ||
    literal.callee === 'import'
  if (!isSpecifier) return undefined
  return BYPASSING_MODULES.find((pkg) => isModule(literal.text, pkg))
}

/**
 * The import clause preceding a `from '…'` specifier — `{createClient}`,
 * `* as sanity`, `client`, or `''` for `import '…'` and `require('…')`.
 *
 * Read by walking back to the `import` or `export` keyword, because the clause
 * is what distinguishes a live subscription from an ordinary client import, and
 * because the codemod needs the same span to rewrite.
 */
export function importClauseOf(source: string, literal: SourceLiteral): string | undefined {
  const head = source.slice(0, literal.index)
  const keyword = Math.max(head.lastIndexOf('import'), head.lastIndexOf('export'))
  if (keyword === -1) return undefined
  const before = keyword === 0 ? '' : source[keyword - 1]
  if (before !== '' && IDENTIFIER.test(before)) return undefined
  const between = source.slice(keyword, literal.index)
  return between
    .replace(/^(import|export)\b/, '')
    .replace(/\bfrom\s*$/, '')
    .trim()
}

/* ================================================================== *
 * C. The rule.
 * ================================================================== */

export type QueryLintCode =
  | 'unregistered-query'
  | 'query-text-drift'
  | 'dynamic-query'
  | 'direct-client-import'
  | 'live-bypass'
export type QueryLintSeverity = 'error' | 'warning'
/**
 * §22.5: "[MUST] Reject unregistered queries in strict preview mode" and
 * "[SHOULD] Allow a local development warning mode during migration". The
 * static check mirrors the runtime's two modes rather than inventing its own.
 */
export type QueryLintMode = 'strict' | 'warn'

/** The registry, reduced to what a static check can compare against. */
export interface RegisteredQuerySummary {
  readonly id: string
  readonly query: string
}

export interface QueryLintFinding {
  readonly code: QueryLintCode
  readonly severity: QueryLintSeverity
  readonly file: string
  readonly line: number
  readonly column: number
  /** The literal as written, truncated for reporting. */
  readonly query: string
  readonly message: string
}

/**
 * A GROQ literal that IS registered, and the ID it resolves to.
 *
 * §22.5 "[MUST] Every production frontend query used in overlay mode has a
 * stable query ID". The environment-aware client is called with the ID, not the
 * text, so a rule that only says "not registered" leaves the reader to grep the
 * registry by hand for the thing they must type. The resolution is already
 * computed to decide the finding; reporting it closes the loop, and it is what
 * the codemod attaches.
 */
export interface RegisteredQueryResolution {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly queryId: string
}

export interface QueryLintReport {
  readonly findings: readonly QueryLintFinding[]
  readonly resolved: readonly RegisteredQueryResolution[]
  readonly filesChecked: number
  readonly literalsScanned: number
  readonly errorCount: number
  readonly warningCount: number
  /** False when the run must fail CI. */
  readonly ok: boolean
}

export interface QueryLintOptions {
  readonly registry: readonly RegisteredQuerySummary[]
  readonly mode: QueryLintMode
}

export interface QueryLintSourceInput extends QueryLintOptions {
  readonly file: string
  readonly source: string
}

const normalize = (query: string): string => query.replace(/\s+/g, ' ').trim()

const excerpt = (text: string): string =>
  text.length <= 160 ? text : `${text.slice(0, 157)}...`

function checkSource(input: QueryLintSourceInput): {
  findings: QueryLintFinding[]
  resolved: RegisteredQueryResolution[]
} {
  const severity: QueryLintSeverity = input.mode === 'strict' ? 'error' : 'warning'
  const exact = new Map(input.registry.map((entry) => [entry.query, entry.id]))
  const normalized = new Map(input.registry.map((entry) => [normalize(entry.query), entry.id]))
  const findings: QueryLintFinding[] = []
  const resolved: RegisteredQueryResolution[] = []

  for (const literal of scanStringLiterals(input.source)) {
    const at = {
      file: input.file,
      line: literal.line,
      column: literal.column,
      query: excerpt(literal.text),
      severity,
    }

    const bypassed = bypassingModuleOf(literal)
    if (bypassed !== undefined) {
      const clause = importClauseOf(input.source, literal) ?? ''
      const live = liveSpecifierIn(clause)
      findings.push(
        live === undefined
          ? {
              ...at,
              code: 'direct-client-import',
              message:
                `${literal.text} talks to the Content Lake directly, so every read through it ` +
                `bypasses the overlay and renders base content while the deployment believes ` +
                `it is on a branch. §22.5 requires the environment-aware client here: import ` +
                `it from sanity-overlay-client and call it with a registered query ID.`,
            }
          : {
              ...at,
              code: 'live-bypass',
              message:
                `${live} subscribes the page to Content Lake pushes, which arrive already ` +
                `evaluated and overwrite whatever the overlay resolved — a bypass no import ` +
                `swap can fix. §37 Phase 5 "Disable native Sanity Live in overlay mode": ` +
                `remove the live subscription and watch the overlay instead ` +
                `(OverlayClient.watch / revalidate).`,
            },
      )
      continue
    }

    if (!looksLikeGroq(literal)) continue

    if (literal.interpolated || literal.concatenated) {
      // Deliberately checked BEFORE registration: the static parts matching a
      // registered text says nothing about the string that will actually run.
      findings.push({
        ...at,
        code: 'dynamic-query',
        message:
          `This query is built at runtime, so it cannot be resolved statically and cannot be ` +
          `matched against the registry. PRD §22.5 forbids dynamic query construction unless a ` +
          `custom planner exists: replace it with a registered constant.`,
      })
      continue
    }

    const registeredId = exact.get(literal.text)
    if (registeredId !== undefined) {
      resolved.push({
        file: input.file,
        line: literal.line,
        column: literal.column,
        queryId: registeredId,
      })
      continue
    }

    const drifted = normalized.get(normalize(literal.text))
    if (drifted !== undefined) {
      findings.push({
        ...at,
        code: 'query-text-drift',
        message:
          `This text differs from registered query ${JSON.stringify(drifted)} only in ` +
          `whitespace. §22.5 checksums the query BYTE for byte, so this drift raises ` +
          `QUERY_CHANGED at runtime: re-copy the registered text or refresh the registration.`,
      })
      continue
    }

    findings.push({
      ...at,
      code: 'unregistered-query',
      message:
        `This GROQ query is not registered. Unregistered queries are rejected, never ` +
        `approximated (PRD §22.5, §5.5): register it with a stable id, a candidate plan and a ` +
        `parity fixture, or route it through a registered query.`,
    })
  }

  return {findings, resolved}
}

export function checkSourceForUnregisteredQueries(
  input: QueryLintSourceInput,
): QueryLintFinding[] {
  return checkSource(input).findings
}

export function checkSourcesForUnregisteredQueries(
  files: readonly {readonly file: string; readonly source: string}[],
  options: QueryLintOptions,
): QueryLintReport {
  const findings: QueryLintFinding[] = []
  const resolved: RegisteredQueryResolution[] = []
  let literalsScanned = 0
  for (const file of files) {
    literalsScanned += scanStringLiterals(file.source).length
    const outcome = checkSource({...file, ...options})
    findings.push(...outcome.findings)
    resolved.push(...outcome.resolved)
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length
  const warningCount = findings.length - errorCount
  return {
    findings,
    resolved,
    filesChecked: files.length,
    literalsScanned,
    errorCount,
    warningCount,
    ok: errorCount === 0,
  }
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

export function formatQueryLintReport(report: QueryLintReport): string {
  const lines = report.findings.map(
    (finding) =>
      `${finding.file}:${finding.line}:${finding.column}  ${finding.severity}  ` +
      `${finding.code}  ${finding.message}\n    ${finding.query}`,
  )
  lines.push(
    `${plural(report.errorCount, 'error')}, ${plural(report.warningCount, 'warning')} in ` +
      `${plural(report.filesChecked, 'file')} (${plural(report.literalsScanned, 'literal')} scanned)`,
  )
  return lines.join('\n')
}
