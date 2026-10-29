#!/usr/bin/env node
/**
 * The package README is the repository README with its relative links made
 * absolute, so they work on npm too. The root README is the one to edit; this
 * runs before `npm pack`/`npm publish`, and a test fails if the two drift.
 */
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'

const REPO = 'https://github.com/planetary/sanity-dataset-simulator'
const ROOT_README = fileURLToPath(new URL('../../../README.md', import.meta.url))
const PACKAGE_README = fileURLToPath(new URL('../README.md', import.meta.url))

/** Markdown links to repository paths become GitHub links; URLs and in-page anchors are left alone. */
export function packageReadme(source) {
  const note = '<!-- Generated from the repository README by scripts/readme.mjs. Edit that one. -->\n\n'
  return (
    note +
    source.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_match, target) => {
      const [file, anchor] = target.split('#')
      const kind = file.endsWith('/') || !/\.[a-z0-9]+$/i.test(file) ? 'tree' : 'blob'
      return `](${REPO}/${kind}/main/${file.replace(/^\.\//, '')}${anchor ? `#${anchor}` : ''})`
    })
  )
}

export function expectedPackageReadme() {
  return packageReadme(fs.readFileSync(ROOT_README, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(PACKAGE_README, expectedPackageReadme())
  console.log('wrote packages/sanity-sim/README.md')
}
