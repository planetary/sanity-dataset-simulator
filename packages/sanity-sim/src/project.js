import fs from 'node:fs'
import path from 'node:path'

/**
 * Work out what is in the folder `sanity-sim` was started in: a Studio, an
 * app, both, and which Sanity project/dataset they point at. Read-only.
 */

const STUDIO_CONFIGS = ['sanity.config.ts', 'sanity.config.tsx', 'sanity.config.js', 'sanity.config.jsx', 'sanity.config.mjs']
const CLI_CONFIGS = ['sanity.cli.ts', 'sanity.cli.js', 'sanity.cli.mjs']
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local']
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.sanity', '.sanity-sim', '.turbo', '.vercel', 'out'])

const PROJECT_ID_KEYS = ['SANITY_STUDIO_PROJECT_ID', 'NEXT_PUBLIC_SANITY_PROJECT_ID', 'PUBLIC_SANITY_PROJECT_ID', 'VITE_SANITY_PROJECT_ID', 'NUXT_PUBLIC_SANITY_PROJECT_ID', 'SANITY_PROJECT_ID']
const DATASET_KEYS = ['SANITY_STUDIO_DATASET', 'NEXT_PUBLIC_SANITY_DATASET', 'PUBLIC_SANITY_DATASET', 'VITE_SANITY_DATASET', 'NUXT_PUBLIC_SANITY_DATASET', 'SANITY_DATASET']
const TOKEN_KEYS = ['SANITY_API_READ_TOKEN', 'SANITY_READ_TOKEN', 'SANITY_API_TOKEN', 'SANITY_AUTH_TOKEN', 'SANITY_TOKEN', 'SANITY_API_WRITE_TOKEN']

export function detectProject(root) {
  const studioConfigs = findFiles(root, STUDIO_CONFIGS, 3)
  const studioConfig = studioConfigs[0] ?? null
  const studioDir = studioConfig ? path.dirname(studioConfig) : null
  const cliConfig = studioDir ? CLI_CONFIGS.map((name) => path.join(studioDir, name)).find((file) => fs.existsSync(file)) ?? null : null

  const envDirs = [...new Set([root, studioDir].filter(Boolean))]
  const env = {}
  for (const dir of envDirs) Object.assign(env, readEnvFiles(dir))
  const lookup = (key) => process.env[key] ?? env[key]

  const fromSource = (file, field) => {
    if (!file) return null
    const text = fs.readFileSync(file, 'utf8')
    const literal = text.match(new RegExp(`${field}\\s*:\\s*['"\`]([a-z0-9-_]+)['"\`]`, 'i'))
    if (literal) return literal[1]
    const envRef = text.match(new RegExp(`${field}\\s*:\\s*(?:process\\.env|import\\.meta\\.env)\\.([A-Z0-9_]+)(?:\\s*(?:\\?\\?|\\|\\|)\\s*['"\`]([a-z0-9-_]+)['"\`])?`, 'i'))
    return envRef ? (lookup(envRef[1]) ?? envRef[2] ?? null) : null
  }
  /* Every value of `field` in the file: a Studio config with workspaces names several projects. */
  const allFromSource = (file, field) => {
    if (!file) return []
    const text = fs.readFileSync(file, 'utf8')
    const pattern = new RegExp(
      `${field}\\s*:\\s*(?:['"\`]([a-z0-9-_]+)['"\`]|(?:process\\.env|import\\.meta\\.env)\\.([A-Z0-9_]+)(?:\\s*(?:\\?\\?|\\|\\|)\\s*['"\`]([a-z0-9-_]+)['"\`])?)`,
      'gi',
    )
    return [...text.matchAll(pattern)].map((match) => match[1] ?? lookup(match[2]) ?? match[3]).filter(Boolean)
  }
  const firstEnv = (keys) => keys.map(lookup).find((value) => typeof value === 'string' && value.trim() !== '') ?? null

  const projectId = fromSource(cliConfig, 'projectId') ?? fromSource(studioConfig, 'projectId') ?? firstEnv(PROJECT_ID_KEYS)
  const projectIds = [...new Set([projectId, ...allFromSource(studioConfig, 'projectId')].filter(Boolean))]
  const dataset = fromSource(cliConfig, 'dataset') ?? fromSource(studioConfig, 'dataset') ?? firstEnv(DATASET_KEYS)
  const tokenKey = TOKEN_KEYS.find((key) => lookup(key))

  const packages = findFiles(root, ['package.json'], 2).map((file) => ({dir: path.dirname(file), json: readJsonSafe(file)})).filter((pkg) => pkg.json)
  const rootPackage = packages.find((pkg) => pkg.dir === root)?.json ?? null
  const frameworks = detectFrameworks(packages.map((pkg) => pkg.json))

  return {
    root,
    studioConfig,
    studioDir,
    cliConfig,
    projectId,
    projectIds,
    dataset,
    token: tokenKey ? {key: tokenKey, value: lookup(tokenKey)} : null,
    frameworks,
    packageManager: detectPackageManager(root),
    devTargets: devTargets(root, rootPackage, studioDir, packages),
  }
}

/** Which dev scripts to run so the user's whole stack comes up. */
function devTargets(root, rootPackage, studioDir, packages) {
  const targets = []
  const rootDev = rootPackage?.scripts?.dev
  if (rootDev) targets.push({dir: root, script: 'dev', command: rootDev})
  const orchestrates = rootDev && /turbo|concurrently|npm-run-all|run-p|--filter|-r |--parallel|workspaces|nx /.test(rootDev)
  if (studioDir && studioDir !== root && !orchestrates) {
    const studioPackage = packages.find((pkg) => pkg.dir === studioDir)?.json
    if (studioPackage?.scripts?.dev) targets.push({dir: studioDir, script: 'dev', command: studioPackage.scripts.dev})
  }
  return targets
}

function detectFrameworks(manifests) {
  const deps = new Set()
  for (const json of manifests) for (const key of Object.keys({...json.dependencies, ...json.devDependencies})) deps.add(key)
  const found = []
  if (deps.has('sanity')) found.push('studio')
  if (deps.has('next')) found.push('next')
  if (deps.has('astro')) found.push('astro')
  if (deps.has('@sveltejs/kit')) found.push('sveltekit')
  if (deps.has('nuxt')) found.push('nuxt')
  if ([...deps].some((dep) => dep.startsWith('@remix-run/') || dep.startsWith('@react-router/'))) found.push('remix')
  if (deps.has('vite') && !found.some((name) => ['astro', 'sveltekit', 'nuxt', 'remix'].includes(name))) found.push('vite')
  if (deps.has('next-sanity')) found.push('next-sanity')
  if (deps.has('@sanity/client')) found.push('@sanity/client')
  return found
}

function detectPackageManager(root) {
  let dir = root
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun'
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm'
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'npm'
}

/** Breadth-first search for any of `names`, `depth` levels deep, skipping build output. */
export function findFiles(root, names, depth) {
  const found = []
  let level = [root]
  for (let d = 0; d <= depth && level.length > 0; d++) {
    const next = []
    for (const dir of level) {
      let entries
      try {
        entries = fs.readdirSync(dir, {withFileTypes: true})
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() && names.includes(entry.name)) found.push(path.join(dir, entry.name))
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) next.push(path.join(dir, entry.name))
      }
    }
    level = next
  }
  return found
}

/** `KEY=value` lines; later files win, like Vite and Next. */
export function readEnvFiles(dir) {
  const out = {}
  for (const name of ENV_FILES) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match) continue
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      else value = value.replace(/\s+#.*$/, '')
      out[match[1]] = value
    }
  }
  return out
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
