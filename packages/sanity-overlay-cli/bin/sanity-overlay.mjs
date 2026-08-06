#!/usr/bin/env node
/**
 * The `sanity-overlay` executable.
 *
 * Everything real is in `../src`; this file only supplies the four things
 * `runCli` refuses to read from globals — argv, the two streams, the working
 * directory and the environment — and turns the returned exit code into a
 * process exit code.
 *
 * `process.exitCode` is assigned rather than `process.exit()` called, so a
 * buffered stdout write cannot be truncated on the way out. That matters for
 * `--json`: a piped consumer must receive the whole document or none of it.
 */
import {register} from 'node:module'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

register('./ts-resolve.mjs', import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const {runCli} = await import(pathToFileURL(join(here, '..', 'src', 'index.ts')).href)

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  io: {
    out: (chunk) => process.stdout.write(chunk),
    err: (chunk) => process.stderr.write(chunk),
  },
})
