import fs from 'node:fs'
import path from 'node:path'

/**
 * Reversible, marked edits that let a Studio and an app talk to the simulator.
 *
 * Every edit is inert unless sanity-sim's environment variables are present,
 * and those only exist in the processes `npx sanity-sim` starts. So
 * `sanity dev`, `next dev`, builds and deploys behave exactly as before.
 * `sanity-sim eject` removes every edit byte-for-byte.
 */

export const STUDIO_ENV = 'SANITY_STUDIO_SIM_API_HOST'
export const NEXT_ENV = 'NEXT_PUBLIC_SANITY_SIM_API_HOST'
export const VITE_ENVS = ['PUBLIC_SANITY_SIM_API_HOST', 'VITE_SANITY_SIM_API_HOST']

const STUDIO_MARK = '<sanity-sim>'
const CONST_NAME = '__sanitySimConfig'

/* ------------------------------------------------------------------ Studio */

function studioHelper(typescript) {
  const signature = typescript ? 'function withSanitySim<T>(config: T): T' : 'function withSanitySim(config)'
  const host = `process.env.${STUDIO_ENV} ?? process.env.${NEXT_ENV}`
  const spread = typescript ? '{...(config as object), apiHost}' : '{...config, apiHost}'
  const cast = typescript ? ' as T' : ''
  return [
    `// ${STUDIO_MARK} Points this Studio at a local sanity-sim while \`npx sanity-sim\` runs; inert otherwise.`,
    '// Remove with `npx sanity-sim eject`.',
    `${signature} {`,
    `  const apiHost = ${host}`,
    '  if (!apiHost) return config',
    `  return (Array.isArray(config) ? config.map((workspace) => ({...workspace, apiHost})) : ${spread})${cast}`,
    '}',
    `// </sanity-sim>`,
  ].join('\n')
}

export function isStudioWired(file) {
  return fs.readFileSync(file, 'utf8').includes(STUDIO_MARK)
}

/** Wrap the config's default export. Returns a description of the change, or why not. */
export function wireStudio(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(STUDIO_MARK)) return {changed: false, reason: 'already wired'}
  const match = text.match(/^export default (?!function\b|class\b|async\b)/m)
  if (!match) return {changed: false, reason: 'no `export default <expression>` found; add `apiHost: process.env.SANITY_STUDIO_SIM_API_HOST` to your config by hand'}
  const typescript = /\.tsx?$/.test(file)
  const replaced =
    text.slice(0, match.index) +
    `const ${CONST_NAME} = /* ${STUDIO_MARK} was: export default */ ` +
    text.slice(match.index + match[0].length)
  const next = `${replaced.replace(/\s*$/, '\n')}\n${studioHelper(typescript)}\nexport default withSanitySim(${CONST_NAME}) // ${STUDIO_MARK}\n`
  fs.writeFileSync(file, next)
  return {changed: true}
}

export function unwireStudio(file) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(STUDIO_MARK)) return false
  text = text.replace(`const ${CONST_NAME} = /* ${STUDIO_MARK} was: export default */ `, 'export default ')
  text = text.replace(/\n*\/\/ <sanity-sim> Points this Studio[\s\S]*?\/\/ <\/sanity-sim>\nexport default withSanitySim\(__sanitySimConfig\) \/\/ <sanity-sim>\n/, '\n')
  fs.writeFileSync(file, text)
  return true
}

/* ------------------------------------------------------------------ app clients */

const CLIENT_OPEN = '/* <sanity-sim> */'
const CLIENT_CLOSE = '/* </sanity-sim> */'
const CLIENT_SNIPPET = new RegExp(`${escape(CLIENT_OPEN)}.*?${escape(CLIENT_CLOSE)}(?: (?=\\S))?`, 'g')

function hostExpression(frameworks) {
  if (frameworks.includes('next')) return `process.env.${NEXT_ENV}`
  if (frameworks.some((name) => ['astro', 'vite', 'sveltekit'].includes(name))) {
    return `(import.meta.env?.${VITE_ENVS[0]} ?? import.meta.env?.${VITE_ENVS[1]})`
  }
  return null
}

/**
 * Point browser-side `createClient({...})` calls at the simulator.
 * Server-side code needs no edit: the register hook reroutes it.
 */
export function wireClients(root, frameworks, {studioDir} = {}) {
  const expression = hostExpression(frameworks)
  if (!expression) return []
  const candidates = sourceFiles(root).filter((file) => !studioDir || !file.startsWith(studioDir + path.sep) || frameworks.includes('next'))
  const changed = []
  for (const file of candidates) {
    const text = fs.readFileSync(file, 'utf8')
    if (!/from\s+['"](next-sanity|@sanity\/client)['"]/.test(text) || !/createClient\(\s*\{/.test(text)) continue
    if (text.includes(CLIENT_OPEN)) continue
    const snippet = `${CLIENT_OPEN} ...(${expression} ? {apiHost: ${expression}} : {}), ${CLIENT_CLOSE}`
    /* `createClient({` then the snippet; a separating space only when code follows on the same line. */
    const next = text.replace(/createClient\(\{(\s?)/g, (whole, space, offset, source) => {
      const after = source[offset + whole.length - space.length]
      return `createClient({${snippet}${after === undefined || /\s/.test(after) ? '' : ' '}${space}`
    })
    fs.writeFileSync(file, next)
    changed.push(file)
  }
  return changed
}

export function unwireClients(root) {
  const changed = []
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes(CLIENT_OPEN)) continue
    fs.writeFileSync(file, text.replace(CLIENT_SNIPPET, ''))
    changed.push(file)
  }
  return changed
}

function sourceFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'out'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/\.(m?[jt]sx?)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/^sanity\.(config|cli)\./.test(entry.name)) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
