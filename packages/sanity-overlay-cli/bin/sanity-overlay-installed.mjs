#!/usr/bin/env node
/**
 * The `sanity-overlay` executable, as an INSTALLED consumer runs it.
 *
 * `bin/sanity-overlay.mjs` is the in-repo launcher: it registers the `.ts`
 * resolve hook in `bin/ts-resolve.mjs` and imports `../src/index.ts`. That is
 * correct here and impossible there — Node refuses to strip types for anything
 * under `node_modules`, so a published package that pointed at `src/` would
 * fail on the first invocation with
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
 *
 * So the two live side by side and the manifest chooses: `bin` names the
 * in-repo launcher, `publishConfig.bin` names this one, and pnpm swaps them
 * when the package is packed. Nothing detects, nothing guesses; a stale `dist/`
 * in this checkout cannot silently take over the launcher the developers run,
 * and a missing `.ts` hook cannot silently take out the launcher a consumer
 * runs.
 *
 * Beyond the entry point it is character-for-character the same program: argv,
 * the two streams, the working directory and the environment in, an exit code
 * out. `process.exitCode` is assigned rather than `process.exit()` called, so a
 * buffered stdout write cannot be truncated on the way out — that matters for
 * `--json`, where a piped consumer must receive the whole document or none.
 */
import {runCli} from '../dist/src/index.js'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  io: {
    out: (chunk) => process.stdout.write(chunk),
    err: (chunk) => process.stderr.write(chunk),
  },
})
