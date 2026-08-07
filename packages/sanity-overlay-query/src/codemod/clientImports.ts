/**
 * The §22.5 client-import codemod — "[MUST] Provide a codemod that replaces
 * direct Sanity client imports with the environment-aware client and attaches
 * stable query IDs where queries are statically discoverable." §37 Phase 5
 * adds "CI runs the codemod in check mode".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE: A REFUSAL ANYWHERE LEAVES THE WHOLE FILE BYTE-IDENTICAL.
 *
 * The worst outcome available to this transform is not "did not migrate a
 * file". It is "migrated half of one". A file that imports the overlay client
 * on line 1 and a direct `@sanity/client` on line 2 compiles, runs, and serves
 * two different datasets to the same page — one resolving the branch, one
 * reading the Content Lake. That is the split-brain the overlay exists to
 * prevent, and unlike a refusal it is silent.
 *
 * So there is no best-effort mode. Every construct is either fully understood
 * and rewritten, or named in the report and left alone with the rest of its
 * file.
 *
 * WHAT IT REWRITES — exactly one shape, and alias-preserving:
 *
 *     import {createClient}            from '@sanity/client'
 *     import {createOverlayClient as createClient} from 'sanity-overlay-client'
 *
 * The LOCAL binding never changes, so no line outside the import statement is
 * touched and no reference can be captured or missed. An existing alias is kept
 * for the same reason.
 *
 * WHAT IT CANNOT DO, and does not pretend to. `createOverlayClient` needs a base
 * port and an overlay state loader; `createClient` needs a project id and a
 * dataset. No transform can turn one configuration into the other, and guessing
 * would produce a client that reads the wrong thing. Every construction site of
 * a rewritten binding is therefore reported as a FOLLOW-UP — visible work,
 * located, not a silent breakage and not an invented config.
 *
 * WHY NO PARSER. Installs are not available here, so there is no jscodeshift and
 * no TypeScript AST. That bound is what makes the refusal list load-bearing
 * rather than decorative: the transform only touches shapes a lexical scan can
 * prove, and the scanner it uses is the comment- and regex-aware one the §22.5
 * lint rule already runs on the same files.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  bypassingModuleOf,
  liveSpecifierIn,
  scanStringLiterals,
  type RegisteredQuerySummary,
  type SourceLiteral,
} from '../lint/queryLint'

/* ================================================================== *
 * A. The report model.
 * ================================================================== */

/** Every construct the codemod stops on. Named, so a refusal is greppable. */
export type CodemodRefusalConstruct =
  | 'default-import'
  | 'namespace-import'
  | 'mixed-default-and-named'
  | 'side-effect-import'
  | 'type-only-import'
  | 'unmapped-specifier'
  | 're-export'
  | 'require'
  | 'dynamic-import'
  | 'dynamic-specifier'
  | 'subpath-import'
  | 'live-subscription'

export interface CodemodRefusal {
  readonly construct: CodemodRefusalConstruct
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
  /** The statement text, verbatim, so the reader can find it. */
  readonly source: string
  readonly reason: string
}

export interface CodemodRewrite {
  readonly kind: 'client-import' | 'query-id'
  readonly line: number
  readonly column: number
  readonly before: string
  readonly after: string
}

/** Work the codemod deliberately leaves to a human, located. */
export interface CodemodFollowUp {
  readonly line: number
  readonly column: number
  readonly binding: string
  readonly detail: string
}

export interface CodemodFileResult {
  readonly file: string
  /** The rewritten source, or the original verbatim when nothing was rewritten. */
  readonly code: string
  readonly changed: boolean
  readonly rewrites: readonly CodemodRewrite[]
  readonly refusals: readonly CodemodRefusal[]
  readonly followUps: readonly CodemodFollowUp[]
}

export interface CodemodReport {
  readonly results: readonly CodemodFileResult[]
  readonly filesChecked: number
  readonly filesChanged: number
  readonly filesRefused: number
  /** False when the migration is unfinished: a pending rewrite OR a refusal. */
  readonly ok: boolean
}

export interface ClientCodemodOptions {
  /** Module the rewritten imports point at. */
  readonly module?: string
  /** Imported name → replacement, e.g. `createClient` → `createOverlayClient`. */
  readonly bindings?: Readonly<Record<string, string>>
  /** Registered queries, for the stable-ID half of §22.5. Optional. */
  readonly registry?: readonly RegisteredQuerySummary[]
}

const DEFAULT_MODULE = 'sanity-overlay-client'
const DEFAULT_BINDINGS: Readonly<Record<string, string>> = Object.freeze({
  createClient: 'createOverlayClient',
})

/* ================================================================== *
 * B. Locating the import statement around a module specifier.
 * ================================================================== */

const IDENT = /[A-Za-z0-9_$]/
const SPECIFIER = /^([A-Za-z_$][A-Za-z0-9_$]*)(\s+as\s+)([A-Za-z_$][A-Za-z0-9_$]*)$|^([A-Za-z_$][A-Za-z0-9_$]*)$/

interface ImportStatement {
  readonly keyword: 'import' | 'export'
  readonly start: number
  readonly clauseStart: number
  readonly clauseEnd: number
  readonly clause: string
}

/**
 * The `import`/`export` keyword governing a `from '…'` specifier, and the span
 * of the clause between them.
 *
 * Walking backwards is safe here because the scan that produced the literal
 * already skipped comments, regular expressions and nested literals: the text
 * between the keyword and the specifier is code.
 */
function importStatementOf(source: string, literal: SourceLiteral): ImportStatement | undefined {
  const head = source.slice(0, literal.index)
  const start = Math.max(head.lastIndexOf('import'), head.lastIndexOf('export'))
  if (start === -1) return undefined
  const before = start === 0 ? '' : source[start - 1]
  if (before !== '' && IDENT.test(before)) return undefined
  const keyword = source.startsWith('import', start) ? 'import' : 'export'

  let clauseStart = start + keyword.length
  while (clauseStart < literal.index && /\s/.test(source[clauseStart])) clauseStart++

  /* The clause ends at the `from` that introduces the specifier. */
  const between = source.slice(clauseStart, literal.index)
  const from = /\bfrom\b(?!.*\bfrom\b)/s.exec(between)
  let clauseEnd = from === null ? literal.index : clauseStart + from.index
  while (clauseEnd > clauseStart && /\s/.test(source[clauseEnd - 1])) clauseEnd--

  return {
    keyword,
    start,
    clauseStart,
    clauseEnd,
    clause: source.slice(clauseStart, clauseEnd),
  }
}

const lineColumnAt = (source: string, offset: number): {line: number; column: number} => {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return {line, column: offset - lineStart + 1}
}

/* ================================================================== *
 * C. Classifying one direct-client import.
 * ================================================================== */

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface Classified {
  readonly refusal?: Omit<CodemodRefusal, 'line' | 'column' | 'source'>
  readonly edits?: readonly Edit[]
  /** Local names bound by a rewritten import — the follow-up call sites. */
  readonly bindings?: readonly string[]
}

const REASONS: Readonly<Record<CodemodRefusalConstruct, string>> = Object.freeze({
  'default-import':
    'The default export of the Sanity client package is not the factory this codemod maps, and ' +
    'no text rewrite can tell which member the file actually uses. Import the named factory and ' +
    're-run.',
  'namespace-import':
    'A namespace import is used through member access that may itself be computed, so no static ' +
    'rewrite can be shown complete. Replace it with the named imports the file actually uses.',
  'mixed-default-and-named':
    'The statement binds both a default and named members. The named half is rewritable and the ' +
    'default half is not, and splitting it would leave the file importing from two clients. ' +
    'Split it by hand first.',
  'side-effect-import':
    'A bare import is kept for its side effects, and the environment-aware client has different ' +
    'ones. Removing or replacing it is a decision about program start-up, not a rename.',
  'type-only-import':
    'Type-only imports name types this codemod has no mapping for. Overlay reads are typed by ' +
    'the query layer, not by the hosted client, so the replacement is a different type and not ' +
    'a renamed one.',
  'unmapped-specifier':
    'The statement imports a member with no environment-aware equivalent. Rewriting only the ' +
    'mapped members would leave a second import pointing at the bypassed package, which is the ' +
    'split-brain this codemod refuses to create.',
  're-export':
    'A re-export changes this module’s own public API, so redirecting it silently changes what ' +
    'every consumer of this file receives. That is a decision for a human.',
  require:
    'CommonJS `require` binds its result through arbitrary destructuring or property access, so ' +
    'the shape a rewrite must preserve is not visible in the statement. Convert the file to ESM ' +
    'imports first.',
  'dynamic-import':
    'A dynamic `import()` is consumed through a promise whose members are read later, possibly ' +
    'computed, so there is no statement here to rewrite completely.',
  'dynamic-specifier':
    'The module specifier is built at runtime, so the module being imported is not knowable ' +
    'statically and any rewrite would be a guess.',
  'subpath-import':
    'A subpath entry point exposes a different surface from the package root, and this codemod ' +
    'maps only the root factory. Rewriting the path would point the import at exports that do ' +
    'not exist.',
  'live-subscription':
    'Sanity Live pushes Content Lake changes straight into the page, already evaluated, so they ' +
    'overwrite whatever the overlay resolved. No import swap fixes that — remove the live ' +
    'subscription and subscribe to overlay changes instead (OverlayClient.watch / revalidate).',
})

function classify(
  source: string,
  literal: SourceLiteral,
  pkg: string,
  module: string,
  bindings: Readonly<Record<string, string>>,
): Classified {
  if (literal.interpolated || literal.concatenated) {
    return {refusal: {construct: 'dynamic-specifier', reason: REASONS['dynamic-specifier']}}
  }
  if (literal.callee === 'require') {
    return {refusal: {construct: 'require', reason: REASONS.require}}
  }
  if (literal.callee === 'import') {
    return {refusal: {construct: 'dynamic-import', reason: REASONS['dynamic-import']}}
  }
  if (literal.precedingWord === 'import') {
    return {refusal: {construct: 'side-effect-import', reason: REASONS['side-effect-import']}}
  }

  const statement = importStatementOf(source, literal)
  if (statement === undefined) {
    return {refusal: {construct: 'dynamic-specifier', reason: REASONS['dynamic-specifier']}}
  }

  /* Live first: it is the only refusal whose fix is a deletion, and reporting
   * it as an unmapped specifier would send the reader to swap the import and
   * leave the subscription running. */
  if (liveSpecifierIn(statement.clause) !== undefined) {
    return {refusal: {construct: 'live-subscription', reason: REASONS['live-subscription']}}
  }
  if (statement.keyword === 'export') {
    return {refusal: {construct: 're-export', reason: REASONS['re-export']}}
  }
  if (literal.text !== pkg) {
    return {refusal: {construct: 'subpath-import', reason: REASONS['subpath-import']}}
  }

  const clause = statement.clause
  if (/^type\b/.test(clause)) {
    return {refusal: {construct: 'type-only-import', reason: REASONS['type-only-import']}}
  }
  if (clause.includes('*')) {
    return {refusal: {construct: 'namespace-import', reason: REASONS['namespace-import']}}
  }
  if (!clause.startsWith('{')) {
    return clause.includes('{')
      ? {
          refusal: {
            construct: 'mixed-default-and-named',
            reason: REASONS['mixed-default-and-named'],
          },
        }
      : {refusal: {construct: 'default-import', reason: REASONS['default-import']}}
  }
  if (!clause.endsWith('}')) {
    return {refusal: {construct: 'dynamic-specifier', reason: REASONS['dynamic-specifier']}}
  }

  /* Named-only. Every member must map, or the whole statement is refused. */
  const inner = clause.slice(1, -1)
  const parts = inner.split(',')
  const locals: string[] = []
  const rebuilt: string[] = []

  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === '') {
      /* A trailing comma. Keep the original text so formatting survives. */
      rebuilt.push(part)
      continue
    }
    if (/^type\b/.test(trimmed)) {
      return {refusal: {construct: 'type-only-import', reason: REASONS['type-only-import']}}
    }
    const match = SPECIFIER.exec(trimmed)
    if (match === null) {
      return {refusal: {construct: 'unmapped-specifier', reason: REASONS['unmapped-specifier']}}
    }
    const imported = match[1] ?? match[4]
    const local = match[3] ?? imported
    const mapped = bindings[imported]
    if (mapped === undefined) {
      return {refusal: {construct: 'unmapped-specifier', reason: REASONS['unmapped-specifier']}}
    }
    const [, lead, , trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part) as RegExpExecArray
    locals.push(local)
    rebuilt.push(`${lead}${mapped} as ${local}${trail}`)
  }

  const quote = source[literal.index]
  return {
    bindings: locals,
    edits: [
      {start: statement.clauseStart, end: statement.clauseEnd, text: `{${rebuilt.join(',')}}`},
      {start: literal.index, end: literal.end, text: `${quote}${module}${quote}`},
    ],
  }
}

/* ================================================================== *
 * D. The file transform.
 * ================================================================== */

/** The source with every string/template literal blanked, so identifier
 * searches cannot match text inside a string. Comments are NOT blanked: a
 * follow-up is a note, never a refusal, so a commented-out call site costs one
 * line of output and nothing else. */
function maskLiterals(source: string, literals: readonly SourceLiteral[]): string {
  let masked = source
  for (const literal of literals) {
    masked =
      masked.slice(0, literal.index) +
      ' '.repeat(literal.end - literal.index) +
      masked.slice(literal.end)
  }
  return masked
}

export function rewriteClientImports(
  input: {readonly file: string; readonly source: string},
  options: ClientCodemodOptions = {},
): CodemodFileResult {
  const module = options.module ?? DEFAULT_MODULE
  const bindings = options.bindings ?? DEFAULT_BINDINGS
  const source = input.source
  const literals = scanStringLiterals(source)

  const refusals: CodemodRefusal[] = []
  const rewrites: CodemodRewrite[] = []
  const edits: Edit[] = []
  const rewrittenBindings: string[] = []
  let importsOverlayModule = false

  for (const literal of literals) {
    const specifier =
      literal.precedingWord === 'from' ||
      literal.precedingWord === 'import' ||
      literal.callee === 'require' ||
      literal.callee === 'import'
    if (specifier && (literal.text === module || literal.text.startsWith(`${module}/`))) {
      importsOverlayModule = true
    }

    const pkg = bypassingModuleOf(literal)
    if (pkg === undefined) continue

    const outcome = classify(source, literal, pkg, module, bindings)
    const statement = importStatementOf(source, literal)
    const start = statement?.start ?? literal.index
    const at = lineColumnAt(source, start)

    if (outcome.refusal !== undefined) {
      refusals.push({
        ...outcome.refusal,
        ...at,
        source: source.slice(start, literal.end),
      })
      continue
    }

    const before = source.slice(start, literal.end)
    const after = applyEdits(source, outcome.edits ?? []).slice(
      start,
      literal.end + editDelta(outcome.edits ?? []),
    )
    rewrites.push({kind: 'client-import', ...at, before, after})
    edits.push(...(outcome.edits ?? []))
    rewrittenBindings.push(...(outcome.bindings ?? []))
  }

  /* THE RULE. Any refusal, and the file is returned exactly as it arrived. */
  if (refusals.length > 0) {
    return {
      file: input.file,
      code: source,
      changed: false,
      rewrites: [],
      refusals,
      followUps: [],
    }
  }

  /* §22.5 stable query IDs. Only in a file whose client comes from the
   * environment-aware module: elsewhere the receiver still takes GROQ text, and
   * substituting an ID would silently query for the literal string. */
  const overlayBacked = importsOverlayModule || rewrittenBindings.length > 0
  const registered = new Map((options.registry ?? []).map((entry) => [entry.query, entry.id]))
  if (overlayBacked && registered.size > 0) {
    for (const literal of literals) {
      if (literal.callee !== 'fetch' || literal.interpolated || literal.concatenated) continue
      const id = registered.get(literal.text)
      if (id === undefined) continue
      const quote = source[literal.index]
      edits.push({start: literal.index, end: literal.end, text: `${quote}${id}${quote}`})
      rewrites.push({
        kind: 'query-id',
        ...lineColumnAt(source, literal.index),
        before: source.slice(literal.index, literal.end),
        after: `${quote}${id}${quote}`,
      })
    }
  }

  const code = applyEdits(source, edits)

  /* What the codemod deliberately did not do, located rather than implied. */
  const followUps: CodemodFollowUp[] = []
  if (rewrittenBindings.length > 0) {
    const masked = maskLiterals(source, literals)
    for (const binding of rewrittenBindings) {
      const pattern = new RegExp(`\\b${binding}\\s*\\(`, 'g')
      for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
        followUps.push({
          ...lineColumnAt(source, m.index),
          binding,
          detail:
            `${binding}() is now the environment-aware factory, which is configured with a base ` +
            `port and an overlay state loader rather than a project id and a dataset. The codemod ` +
            `does not invent that configuration: supply it here.`,
        })
      }
    }
    followUps.sort((a, b) => a.line - b.line || a.column - b.column)
  }

  return {
    file: input.file,
    code,
    changed: code !== source,
    rewrites,
    refusals,
    followUps,
  }
}

const editDelta = (edits: readonly Edit[]): number =>
  edits.reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0)

function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

/* ================================================================== *
 * E. Whole-project run and check mode.
 * ================================================================== */

export function runClientImportCodemod(
  files: readonly {readonly file: string; readonly source: string}[],
  options: ClientCodemodOptions = {},
): CodemodReport {
  const results = files.map((file) => rewriteClientImports(file, options))
  const filesChanged = results.filter((r) => r.changed).length
  const filesRefused = results.filter((r) => r.refusals.length > 0).length
  return {
    results,
    filesChecked: files.length,
    filesChanged,
    filesRefused,
    /* Check mode: a pending rewrite and a refusal are both unfinished
     * migration work, and §22.5 has CI fail on either. */
    ok: filesChanged === 0 && filesRefused === 0,
  }
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

export function formatCodemodReport(report: CodemodReport): string {
  const lines: string[] = []
  for (const result of report.results) {
    for (const rewrite of result.rewrites) {
      lines.push(
        `${result.file}:${rewrite.line}:${rewrite.column}  rewrite  ${rewrite.kind}\n` +
          `    - ${rewrite.before.split('\n')[0]}\n    + ${rewrite.after.split('\n')[0]}`,
      )
    }
    for (const refusal of result.refusals) {
      lines.push(
        `${result.file}:${refusal.line}:${refusal.column}  refused  ${refusal.construct}  ` +
          `${refusal.reason}\n    ${refusal.source.split('\n')[0]}`,
      )
    }
    for (const followUp of result.followUps) {
      lines.push(
        `${result.file}:${followUp.line}:${followUp.column}  follow-up  ${followUp.detail}`,
      )
    }
  }
  lines.push(
    `${plural(report.filesChanged, 'file')} changed, ` +
      `${plural(report.filesRefused, 'file')} refused, ` +
      `${plural(report.filesChecked, 'file')} checked`,
  )
  return lines.join('\n')
}
