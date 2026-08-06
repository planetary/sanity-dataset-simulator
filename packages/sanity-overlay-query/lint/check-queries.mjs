#!/usr/bin/env node
/**
 * PRD §22.5: "[MUST] CI runs … the lint rule in error mode after migration."
 *
 * The runnable half of the unregistered-query check. CI runs a PROCESS, not a
 * function, so the rule needs an entry point with an exit code — and the exit
 * codes are three, not two, because "the check failed" and "the check could not
 * run" are different facts:
 *
 *   0  no errors (warn mode always ends here; findings are still printed)
 *   1  at least one error — unregistered, drifted or dynamically built GROQ
 *   2  the check could not run: bad arguments, or an unusable registry manifest
 *
 * Usage:
 *   node lint/check-queries.mjs [options] [path …]
 *
 *   --registry <file.json>  registered queries; defaults to the manifest beside
 *                           this script. Adopting projects point it at their own.
 *   --mode strict|warn      strict (default) fails on findings; warn only reports.
 *   --ext .ts,.tsx          file extensions to scan.
 *   --ignore <substring>    skip paths containing it; repeatable.
 *   --json                  emit the report as JSON instead of text.
 *
 * This file is JavaScript, and the checker it calls is TypeScript, because the
 * checker must also run in the browser-safe package surface (PRD §10.1) while
 * this shell is unashamedly Node: it reads files and owns the process exit.
 */
import {createHash} from 'node:crypto'
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REGISTRY = join(HERE, 'm-local-registry.json')
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const ALWAYS_IGNORED = ['node_modules', '.git', 'dist', 'build', 'coverage']

const fail = (message) => {
  process.stderr.write(`check-queries: ${message}\n`)
  process.exit(2)
}

function parseArguments(argv) {
  const options = {
    registry: DEFAULT_REGISTRY,
    mode: 'strict',
    extensions: DEFAULT_EXTENSIONS,
    ignore: [],
    json: false,
    paths: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) fail(`${argument} needs a value`)
      return next
    }
    if (argument === '--registry') options.registry = resolve(value())
    else if (argument === '--mode') options.mode = value()
    else if (argument === '--ext') options.extensions = value().split(',')
    else if (argument === '--ignore') options.ignore.push(value())
    else if (argument === '--json') options.json = true
    else if (argument.startsWith('-')) fail(`unknown option ${argument}`)
    else options.paths.push(argument)
  }
  if (options.mode !== 'strict' && options.mode !== 'warn') {
    fail(`--mode must be strict or warn, received ${options.mode}`)
  }
  if (options.paths.length === 0) options.paths.push(process.cwd())
  return options
}

/**
 * Load the registered queries, verifying each pinned checksum against
 * `node:crypto` (§22.5 "query text and candidate plan are version controlled").
 * A hand-edited manifest is a configuration failure, not a clean codebase.
 */
function loadRegistry(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read registry manifest ${path}: ${error.message}`)
  }
  const queries = parsed?.queries
  if (!Array.isArray(queries) || queries.length === 0) {
    fail(`registry manifest ${path} has no "queries" array`)
  }
  for (const entry of queries) {
    if (typeof entry?.id !== 'string' || typeof entry?.query !== 'string') {
      fail(`registry manifest ${path} has an entry without an id and a query`)
    }
    if (typeof entry.queryChecksum === 'string') {
      const actual = createHash('sha256').update(entry.query, 'utf8').digest('hex')
      if (actual !== entry.queryChecksum) {
        fail(
          `registry manifest ${path}: query ${entry.id} does not match its pinned checksum ` +
            `(${entry.queryChecksum} != ${actual})`,
        )
      }
    }
  }
  return queries.map((entry) => ({id: entry.id, query: entry.query}))
}

function collectFiles(target, options, into) {
  const stats = statSync(target, {throwIfNoEntry: false})
  if (!stats) fail(`no such path: ${target}`)
  if (stats.isFile()) {
    if (options.extensions.some((extension) => target.endsWith(extension))) into.push(target)
    return
  }
  for (const entry of readdirSync(target, {withFileTypes: true})) {
    const full = join(target, entry.name)
    if (ALWAYS_IGNORED.includes(entry.name)) continue
    if (options.ignore.some((needle) => full.includes(needle))) continue
    if (entry.isDirectory()) collectFiles(full, options, into)
    else if (options.extensions.some((extension) => entry.name.endsWith(extension))) into.push(full)
  }
}

const options = parseArguments(process.argv.slice(2))
const registry = loadRegistry(options.registry)
const {checkSourcesForUnregisteredQueries, formatQueryLintReport} = await import(
  '../src/lint/queryLint.ts'
)

const paths = []
for (const target of options.paths) collectFiles(resolve(target), options, paths)

const report = checkSourcesForUnregisteredQueries(
  paths.map((path) => ({file: relative(process.cwd(), path) || path, source: readFileSync(path, 'utf8')})),
  {registry, mode: options.mode},
)

process.stdout.write(
  options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatQueryLintReport(report)}\n`,
)
process.exit(report.ok ? 0 : 1)
