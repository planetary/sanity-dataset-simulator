#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`sanity-sim needs Node.js 22.12 or newer (this is ${process.versions.node}).`)
  process.exit(1)
}
const {run, UsageError} = await import('../src/cli.js')
try {
  await run(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(error?.stack ?? error)
  process.exit(1)
}
