import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline/promises'
import {fileURLToPath} from 'node:url'
import {detectProject} from './project.js'
import {runDevTargets} from './run.js'
import {startServer} from './server.js'
import {Simulator} from './simulator.js'
import {findToken, followDataset, syncDataset} from './sync.js'
import {caDirectory, ensureTls, isCaTrusted, trustCommand} from './tls.js'
import {exportFile, importFile} from './transfer.js'
import {NEXT_ENV, STUDIO_ENV, VITE_ENVS, isStudioWired, unwireClients, unwireStudio, wireClients, wireStudio} from './wire.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const REGISTER = fileURLToPath(new URL('./register.js', import.meta.url))

const HELP = `sanity-sim ${VERSION} — a local Sanity Content Lake for your Studio and app

Usage
  npx sanity-sim [command] [options]

Commands
  (none), dev     Start the simulator, wire this folder's Studio/app to it, and run your dev script
  serve           Start only the simulator (no dev scripts)
  sync            Pull the real dataset into the local snapshot (read-only), then exit
  status          Show what is here: project, datasets, local changes
  import <file>   Import an NDJSON or \`sanity dataset export\` .tar.gz
  export <file>   Export the current dataset as NDJSON (.ndjson or .ndjson.gz)
  reset           Discard local changes (keeps the synced snapshot); --all wipes everything
  trust           Trust sanity-sim's local HTTPS certificate (asks your OS for confirmation)
  eject           Remove sanity-sim's edits from your Studio config and clients

Options
  --port <n>          Port for API + dashboard (default 3939; next free one if taken)
  --dataset <name>    Dataset to use (default: detected, else "production")
  --project <id>      Project id (default: detected, else "simlocal")
  --no-dev            Do not run the project's dev script
  --no-wire           Do not edit sanity.config / createClient files
  --sync              Pull from the real dataset before starting
  --follow            Keep the synced snapshot live (read-only listener on the real dataset)
  --seed <file>       Import this file when the dataset is empty
  --http              Serve plain HTTP only (no TLS; Studio stalls past six listeners)
  --origin <url>      Allow a non-loopback browser origin
  --root <dir>        Project folder (default: current directory)
  --yes               Accept defaults without prompting
`

export async function run(argv) {
  const {command, positional, flags} = parseArgs(argv)
  if (flags.help || command === 'help') return print(HELP)
  if (flags.version || command === 'version') return print(VERSION)
  const root = path.resolve(flags.root ?? process.cwd())
  const project = detectProject(root)

  switch (command) {
    case 'dev':
      return dev(root, project, flags, {runDev: !flags['no-dev']})
    case 'serve':
      return dev(root, project, flags, {runDev: false})
    case 'sync':
      return syncOnce(root, project, flags)
    case 'status':
      return status(root, project, flags)
    case 'import':
      return importCommand(root, project, flags, positional[0])
    case 'export':
      return exportCommand(root, project, flags, positional[0])
    case 'reset':
      return reset(root, project, flags)
    case 'trust':
      return trust(flags)
    case 'eject':
      return eject(root, project)
    default:
      throw new UsageError(`unknown command "${command}"\n\n${HELP}`)
  }
}

/* ------------------------------------------------------------------ dev */

async function dev(root, project, flags, {runDev}) {
  const fresh = !fs.existsSync(path.join(root, '.sanity-sim'))
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  const dataset = sim.dataset(datasetName)
  const log = logger()
  sim.log = log
  const stops = []

  /* Initialize: seed from a file, or offer to pull the real dataset. */
  if (dataset.size === 0) {
    if (flags.seed) {
      const result = await importFile(sim, datasetName, path.resolve(flags.seed))
      log('info', `seeded ${result.documents} documents from ${flags.seed}`)
    } else if (!flags.sync && project.projectId && fresh && process.stdin.isTTY && !flags.yes && (await confirm(flags, `Pull ${project.projectId}/${datasetName} into the simulator first (read-only)?`, true))) {
      flags.sync = true
    }
  }
  const source = syncSource(sim, project, datasetName)
  if (flags.sync) {
    if (!source) log('warn', 'no Sanity project detected to sync from; starting with local data only')
    else await pull(sim, datasetName, source, log)
  }
  if (flags.follow && source) stops.push(followDataset(sim, datasetName, {...source, log}))

  /* TLS + server. */
  const port = await freePort(Number(flags.port ?? 3939))
  let tls = null
  if (!flags.http) {
    try {
      tls = ensureTls({hostnames: [`${sim.projectId}.localhost`]})
    } catch (error) {
      log('warn', `${error.message}\nfalling back to plain HTTP`)
    }
  }
  const server = await startServer(sim, {port, tls, extraOrigins: [].concat(flags.origin ?? []), project})
  sim.startScheduler()

  /* Wire the Studio and app clients (marked, reversible, inert without our env). */
  const wired = []
  if (!flags['no-wire']) {
    if (project.studioConfig) {
      const result = wireStudio(project.studioConfig)
      if (result.changed) wired.push(`Studio config ${rel(root, project.studioConfig)}`)
      else if (result.reason !== 'already wired') log('warn', `Studio not wired: ${result.reason}`)
    }
    for (const file of wireClients(root, project.frameworks, {studioDir: project.studioDir})) wired.push(`client ${rel(root, file)}`)
  }

  server.context.wired = wired
  const browserBase = server.origin
  const env = {
    SANITY_SIM_URL: server.httpOrigin.replace('localhost', '127.0.0.1'),
    ...(tls ? {SANITY_SIM_TLS_PORT: String(server.port)} : {}),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToImport(REGISTER)}`].filter(Boolean).join(' '),
    [STUDIO_ENV]: browserBase,
    [NEXT_ENV]: browserBase,
    ...Object.fromEntries(VITE_ENVS.map((key) => [key, browserBase])),
    ...(tls ? {NODE_EXTRA_CA_CERTS: tls.nodeCaBundle} : {}),
  }

  banner({sim, project, root, server, tls, datasetName, wired, runDev})

  if (tls && !isCaTrusted() && process.platform === 'darwin' && process.stdin.isTTY && !flags.yes) {
    if (await confirm(flags, 'Trust sanity-sim\'s local HTTPS certificate now? (macOS will ask for your password)', true)) runTrust()
  }

  if (runDev) {
    if (project.devTargets.length === 0) log('info', 'no dev script found; the simulator is running on its own')
    else {
      log('info', `starting ${project.devTargets.map((t) => `${project.packageManager} run ${t.script}${t.dir !== root ? ` (in ${rel(root, t.dir)})` : ''}`).join(', ')}`)
      stops.push(runDevTargets(project.devTargets, {packageManager: project.packageManager, env}))
    }
  }

  await new Promise((resolve) => {
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      process.stdout.write('\nstopping sanity-sim…\n')
      for (const fn of stops) fn()
      sim.close()
      await server.close()
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

function banner({sim, project, root, server, tls, datasetName, wired, runDev}) {
  const dataset = sim.dataset(datasetName)
  const bold = (text) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text)
  const dim = (text) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text)
  const remote = dataset.remoteMeta ? `${dataset.remote.size} synced from ${dataset.remoteMeta.projectId}/${dataset.remoteMeta.dataset}, ` : ''
  const lines = [
    '',
    `${bold('sanity-sim')} ${VERSION} ${dim(`· project ${sim.projectId} · dataset ${datasetName}`)}`,
    '',
    `  Dashboard  ${bold(server.httpOrigin + '/')}`,
    `  API        ${server.origin}${tls ? dim(`  (Node/curl: ${server.httpOrigin})`) : ''}`,
    `  Data       ${rel(root, sim.dir)}/ ${dim(`(${remote}${dataset.local.size} local, ${dataset.tombstones.size} deleted locally)`)}`,
  ]
  if (project.studioConfig) lines.push(`  Studio     ${isStudioWired(project.studioConfig) ? 'wired' : 'not wired'} ${dim(rel(root, project.studioConfig))}`)
  if (wired.length > 0) lines.push(`  Wired now  ${wired.join(', ')} ${dim('(undo: npx sanity-sim eject)')}`)
  if (tls && !isCaTrusted()) {
    lines.push('', `  ${bold('!')} The HTTPS certificate is not trusted by this machine yet. Browsers will refuse the API until it is.`)
    lines.push(`    Run once: ${bold('npx sanity-sim trust')}   ${dim(`(or open ${server.origin}/ and accept it)`)}`)
  }
  if (!runDev) lines.push('', dim(`  Point other tools at it: SANITY_SIM_URL=${server.httpOrigin} node --import sanity-sim/register …`))
  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
}

/* ------------------------------------------------------------------ other commands */

async function syncOnce(root, project, flags) {
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  const source = syncSource(sim, project, datasetName)
  if (!source) throw new UsageError('No Sanity project found to sync from. Pass --project <id> (and --dataset), or run in a folder with a sanity.config / .env.')
  await pull(sim, datasetName, source, logger())
  sim.close()
}

async function pull(sim, datasetName, source, log) {
  log('info', `syncing ${source.projectId}/${source.dataset} (read-only, credentials: ${source.token?.source ?? 'none'})…`)
  const result = await syncDataset(sim, datasetName, {...source, onProgress: (n) => log('info', `  ${n} documents…`)})
  log('info', `synced ${result.meta.count} documents (${result.meta.drafts} drafts)${result.stale ? `; ${result.stale} local change(s) now stale — see the dashboard` : ''}`)
}

function syncSource(sim, project, datasetName) {
  const configured = sim.config.sync?.[datasetName]
  const projectId = configured?.projectId ?? project.projectId
  if (!projectId || projectId === 'simlocal') return null
  return {projectId, dataset: configured?.dataset ?? project.dataset ?? datasetName, token: findToken(project), types: configured?.types ?? undefined}
}

function status(root, project, flags) {
  if (!fs.existsSync(path.join(root, '.sanity-sim'))) {
    print(`not initialized in ${root} (run \`npx sanity-sim\` to start)\ndetected: ${project.frameworks.join(', ') || 'nothing'}${project.projectId ? `; project ${project.projectId}/${project.dataset ?? 'production'}` : ''}`)
    return
  }
  const sim = openSim(root, project, flags)
  const out = {
    root,
    projectId: sim.projectId,
    detected: {studioConfig: project.studioConfig && rel(root, project.studioConfig), frameworks: project.frameworks, devTargets: project.devTargets.map((t) => `${rel(root, t.dir) || '.'}: ${t.command}`), token: project.token?.key ?? null},
    datasets: sim.datasetNames().map((name) => {
      const ds = sim.dataset(name)
      return {name, documents: ds.size, local: ds.local.size, deletedLocally: ds.tombstones.size, synced: ds.remoteMeta, stale: ds.staleEntries().length, transactions: ds.transactions.length}
    }),
    certificate: {dir: caDirectory(), trusted: isCaTrusted()},
  }
  print(flags.json ? JSON.stringify(out, null, 2) : formatStatus(out))
  sim.close()
}

function formatStatus(out) {
  const lines = [`project ${out.projectId} — ${out.root}`]
  lines.push(`detected: ${out.detected.frameworks.join(', ') || 'nothing'}${out.detected.studioConfig ? `; studio ${out.detected.studioConfig}` : ''}`)
  for (const ds of out.datasets) {
    lines.push(`dataset ${ds.name}: ${ds.documents} documents (${ds.local} local, ${ds.deletedLocally} deleted locally, ${ds.stale} stale)${ds.synced ? `, synced ${ds.synced.syncedAt} from ${ds.synced.projectId}/${ds.synced.dataset}` : ''}`)
  }
  lines.push(`certificate: ${out.certificate.trusted ? 'trusted' : 'not trusted (npx sanity-sim trust)'}`)
  return lines.join('\n')
}

async function importCommand(root, project, flags, file) {
  if (!file) throw new UsageError('usage: sanity-sim import <file.ndjson|file.tar.gz> [--replace]')
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  const result = await importFile(sim, datasetName, path.resolve(file), {replace: Boolean(flags.replace)})
  print(`imported ${result.documents} documents and ${result.assets} asset files into ${datasetName}`)
  sim.close()
}

function exportCommand(root, project, flags, file) {
  if (!file) throw new UsageError('usage: sanity-sim export <file.ndjson[.gz]>')
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  print(`exported ${exportFile(sim, datasetName, path.resolve(file))} documents from ${datasetName}`)
  sim.close()
}

async function reset(root, project, flags) {
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  const all = Boolean(flags.all)
  if (!(await confirm(flags, all ? `Wipe dataset ${datasetName} completely (local changes, history and synced snapshot)?` : `Discard all local changes in ${datasetName}?`, false))) return
  const dataset = sim.dataset(datasetName)
  if (all) dataset.reset({keepRemote: false})
  else dataset.discardLocal()
  dataset.flush()
  print(all ? `wiped ${datasetName}` : `discarded local changes in ${datasetName}`)
  sim.close()
}

function trust(flags) {
  ensureTls({hostnames: []})
  if (isCaTrusted()) return print('the sanity-sim certificate is already trusted')
  runTrust()
}

function runTrust() {
  const [command, args] = trustCommand()
  print(`running: ${command} ${args.join(' ')}`)
  try {
    execFileSync(command, args, {stdio: 'inherit'})
    print('trusted. Restart your browser if it was open.')
  } catch (error) {
    print(`could not trust the certificate automatically (${error.message.split('\n')[0]}). Trust ${path.join(caDirectory(), 'ca.pem')} by hand, or open the dashboard and accept the certificate.`)
  }
}

function eject(root, project) {
  const changed = []
  if (project.studioConfig && unwireStudio(project.studioConfig)) changed.push(rel(root, project.studioConfig))
  changed.push(...unwireClients(root).map((file) => rel(root, file)))
  print(changed.length ? `removed sanity-sim edits from: ${changed.join(', ')}` : 'nothing to eject')
}

/* ------------------------------------------------------------------ helpers */

function openSim(root, project, flags) {
  return new Simulator({root, projectId: flags.project ?? project.projectId ?? undefined, dataset: flags.dataset ?? project.dataset ?? 'production', log: logger()})
}

export class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split(/=(.*)/s)
      const boolean = ['help', 'version', 'no-dev', 'no-wire', 'sync', 'follow', 'http', 'yes', 'all', 'replace', 'json'].includes(name)
      if (boolean) flags[name] = true
      else {
        const value = inline ?? argv[++i]
        if (value === undefined) throw new UsageError(`--${name} needs a value`)
        flags[name] = flags[name] === undefined ? value : [].concat(flags[name], value)
      }
    } else if (token === '-h') flags.help = true
    else if (token === '-v') flags.version = true
    else if (token === '-y') flags.yes = true
    else positional.push(token)
  }
  const command = positional.shift() ?? 'dev'
  return {command, positional, flags}
}

async function confirm(flags, question, fallback) {
  if (flags.yes || !process.stdin.isTTY) return fallback
  const rl = readline.createInterface({input: process.stdin, output: process.stdout})
  const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  rl.close()
  return answer === '' ? fallback : answer.startsWith('y')
}

async function freePort(start) {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port in ${start}–${start + 49}`)
}

function logger() {
  return (level, message) => {
    if (level === 'debug') return
    const tag = level === 'error' ? '\x1b[31m✖\x1b[0m' : level === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[2m·\x1b[0m'
    process.stderr.write(`${process.stderr.isTTY ? tag : level} ${message}\n`)
  }
}

function print(text) {
  process.stdout.write(text + '\n')
}

function rel(root, file) {
  return path.relative(root, file) || '.'
}

/** NODE_OPTIONS splits on spaces; quote paths that contain them. */
function pathToImport(file) {
  const url = new URL(`file://${file}`).href
  return url.includes(' ') ? `"${url}"` : url
}
