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
import {caDirectory, ensureTls, isCaTrusted, setTrustDeclined, trustCommand, trustDeclined} from './tls.js'
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
  status          Show what is here: project, datasets, links, local changes
  link <name> <dataset>
                  Point a dataset name (e.g. production) at another stored dataset;
                  re-run with a different dataset to hot-swap while Studio runs
  unlink <name>   Remove a link
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
  --types <a,b>       Only sync these document types (large datasets)
  --seed <file>       Import this file when the dataset is empty
  --http              Serve plain HTTP only (no TLS; Studio stalls past six listeners)
  --origin <url>      Allow a non-loopback browser origin
  --root <dir>        Project folder (default: current directory)
  --yes               Accept defaults without prompting
`

const DEFAULT_PORT = 3939

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
    case 'link':
      return linkCommand(root, project, flags, positional)
    case 'unlink':
      return linkCommand(root, project, flags, [positional[0]], {unlink: true})
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
  const source = withTypes(syncSource(sim, project, datasetName), flags)
  if (flags.sync) {
    if (!source) log('warn', 'no Sanity project detected to sync from; starting with local data only')
    else await pull(sim, datasetName, source, log)
  }
  if (flags.follow && source) stops.push(followDataset(sim, datasetName, {...source, log}))

  /* TLS + server. */
  const port = await freePort(Number(flags.port ?? DEFAULT_PORT))
  /* Every workspace's project up front (shown on the dashboard); others are created on first request. */
  for (const id of project.projectIds ?? []) sim.projects.get(id)
  let tls = null
  if (!flags.http) {
    try {
      /* Any project not named here gets its name added on first connection. */
      tls = ensureTls({hostnames: sim.projects.all().map((p) => `${p.projectId}.localhost`)})
    } catch (error) {
      log('warn', `${error.message}\nfalling back to plain HTTP`)
    }
  }
  const server = await startServer(sim, {port, tls, extraOrigins: [].concat(flags.origin ?? []), project})
  sim.startScheduler()
  /* Lets `sanity-sim link` (and other tools) find this server whatever port it landed on. */
  const serverFile = path.join(sim.dir, 'server.json')
  fs.writeFileSync(serverFile, JSON.stringify({pid: process.pid, port: server.port, startedAt: new Date().toISOString()}) + '\n')
  stops.push(() => {
    if (readJsonFile(serverFile)?.pid === process.pid) fs.rmSync(serverFile, {force: true})
  })

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

  /*
   * First run in a terminal: start the trust step right away. The OS asks for
   * confirmation itself; a cancel or a refusal (managed machines) is
   * remembered so later runs only print the reminder.
   */
  if (tls && !isCaTrusted() && !trustDeclined() && process.stdin.isTTY && !flags.yes) {
    log('info', 'trusting the local HTTPS certificate for this user (one time; your OS will ask to confirm)…')
    runTrust({server, projectId: sim.projectId})
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
    `${bold('sanity-sim')} ${VERSION} ${dim(`· project ${sim.projectId} · dataset ${datasetName}${dataset.name !== datasetName ? ` → ${dataset.name}` : ''}`)}`,
    '',
    `  Dashboard  ${bold(server.httpOrigin + '/')}`,
    `  API        ${server.origin}${tls ? dim(`  (Node/curl: ${server.httpOrigin})`) : ''}`,
    `  Data       ${rel(root, sim.dir)}/ ${dim(`(${remote}${dataset.local.size} local, ${dataset.tombstones.size} deleted locally)`)}`,
  ]
  const others = sim.projects.all().slice(1)
  if (others.length > 0) lines.push(`  Projects   ${sim.projectId} ${dim('(main)')}, ${others.map((p) => p.projectId).join(', ')} ${dim('(each with its own datasets)')}`)
  if (project.studioConfig) lines.push(`  Studio     ${isStudioWired(project.studioConfig) ? 'wired' : 'not wired'} ${dim(rel(root, project.studioConfig))}`)
  if (wired.length > 0) lines.push(`  Wired now  ${wired.join(', ')} ${dim('(undo: npx sanity-sim eject)')}`)
  if (tls && !isCaTrusted()) {
    lines.push('', `  ${bold('!')} The HTTPS certificate is not trusted by this machine yet. Browsers will refuse the API until it is.`)
    lines.push(`    Run once: ${bold('npx sanity-sim trust')}   ${dim(`(or open ${server.origin.replace('://localhost', `://${sim.projectId}.localhost`)}/ and accept it)`)}`)
  }
  if (!runDev) lines.push('', dim(`  Point other tools at it: SANITY_SIM_URL=${server.httpOrigin} node --import sanity-sim/register …`))
  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
}

/* ------------------------------------------------------------------ other commands */

async function syncOnce(root, project, flags) {
  const sim = openSim(root, project, flags)
  const datasetName = flags.dataset ?? sim.config.defaultDataset
  const source = withTypes(syncSource(sim, project, datasetName), flags)
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
  const configured = sim.config.sync?.[sim.resolveName(datasetName)]
  const projectId = configured?.projectId ?? project.projectId ?? sim.projectId
  if (!projectId || projectId === 'simlocal') return null
  return {projectId, dataset: configured?.dataset ?? project.dataset ?? datasetName, token: findToken(project), types: configured?.types ?? undefined}
}

function withTypes(source, flags) {
  if (!source || !flags.types) return source
  return {...source, types: String(flags.types).split(',').map((type) => type.trim()).filter(Boolean)}
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
    links: sim.links(),
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
  for (const link of out.links) lines.push(`link ${link.name} → ${link.target}`)
  lines.push(`certificate: ${out.certificate.trusted ? 'trusted' : 'not trusted (npx sanity-sim trust)'}`)
  return lines.join('\n')
}

/**
 * Link or unlink. A simulator already running for this folder applies it live
 * (connected clients reconnect and refetch); otherwise the config is edited.
 */
async function linkCommand(root, project, flags, [name, target], {unlink = false} = {}) {
  if (!name || (!unlink && !target)) throw new UsageError(unlink ? 'usage: sanity-sim unlink <name>' : 'usage: sanity-sim link <name> <dataset>')
  const running = await runningSimFor(root, flags)
  let result
  if (running) {
    const response = await fetch(`${running}/_sim/links/${encodeURIComponent(name)}`, {
      method: unlink ? 'DELETE' : 'PUT',
      headers: {'content-type': 'application/json'},
      body: unlink ? undefined : JSON.stringify({target}),
    })
    result = await response.json()
    if (!response.ok) throw new UsageError(result.error?.description ?? `request failed (${response.status})`)
  } else {
    const sim = openSim(root, project, flags)
    result = unlink ? sim.unlink(name) : sim.link(name, target)
    sim.close()
  }
  if (unlink) return print(`unlinked ${name} (was → ${result.unlinked})`)
  print(`${name} → ${result.target}${result.preserved ? ` (its previous documents are kept as "${result.preserved}")` : ''}${running ? '; connected clients are reloading' : ''}`)
}

/** The http origin of a simulator serving this folder, if one is running. */
async function runningSimFor(root, flags) {
  const recorded = readJsonFile(path.join(root, '.sanity-sim', 'server.json'))?.port
  const ports = [...new Set([flags.port, recorded, DEFAULT_PORT].filter(Boolean).map(Number))]
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_sim/status`, {signal: AbortSignal.timeout(500)})
      if ((await response.json()).root === root) return `http://127.0.0.1:${port}`
    } catch {
      /* nothing there, or not a simulator */
    }
  }
  return null
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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
  if (isCaTrusted()) {
    setTrustDeclined(false)
    return print('the sanity-sim certificate is already trusted')
  }
  runTrust({})
}

/** Run the OS trust command. Returns whether the CA is trusted afterwards; never throws. */
function runTrust({server, projectId}) {
  const [command, args] = trustCommand()
  print(`running: ${command} ${args.join(' ')}`)
  try {
    execFileSync(command, args, {stdio: 'inherit'})
  } catch (error) {
    /* Missing tool, cancelled dialog, or blocked by policy: the verification below tells them apart from success. */
    if (error.code === 'ENOENT') print(`${command} is not installed.`)
  }
  if (isCaTrusted()) {
    setTrustDeclined(false)
    print('trusted. Quit and reopen your browser if it was open (Firefox reads the system certificates only at startup).')
    print('Firefox: if it still refuses, set security.enterprise_roots.enabled to true in about:config and restart it.')
    return true
  }
  setTrustDeclined(true)
  const apiOrigin = server ? server.origin.replace('://localhost', `://${projectId}.localhost`) : 'https://<projectId>.localhost:3939'
  print(
    [
      'the certificate is not trusted (cancelled, or this machine does not allow it). sanity-sim keeps running; other ways in:',
      `  - Chrome, Edge, Safari: open ${apiOrigin}/ once and accept the warning.`,
      '    Managed browsers can forbid that; then ask IT to trust this CA, which only covers localhost names:',
      `    ${path.join(caDirectory(), 'ca.pem')}`,
      '  - --http serves plain HTTP: no certificate, but Studio stalls with several documents open (6 connections per host).',
      'Run `npx sanity-sim trust` to try again; first runs will not ask again until then.',
    ].join('\n'),
  )
  return false
}

function eject(root, project) {
  const changed = []
  if (project.studioConfig && unwireStudio(project.studioConfig)) changed.push(rel(root, project.studioConfig))
  changed.push(...unwireClients(root).map((file) => rel(root, file)))
  print(changed.length ? `removed sanity-sim edits from: ${changed.join(', ')}` : 'nothing to eject')
}

/* ------------------------------------------------------------------ helpers */

function openSim(root, project, flags) {
  /* The folder's default is the dataset its Studio/app uses; `--dataset` only picks what one command works on. */
  return new Simulator({root, projectId: flags.project ?? project.projectId ?? undefined, dataset: project.dataset ?? 'production', log: logger()})
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
