import {spawn} from 'node:child_process'

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m']
const RESET = '\x1b[0m'

/**
 * Run the project's dev scripts as children with the simulator's environment,
 * prefixing their output. Returns a function that stops them all.
 */
export function runDevTargets(targets, {packageManager, env, color = process.stdout.isTTY}) {
  const children = []
  targets.forEach((target, index) => {
    const label = targets.length > 1 ? `[${pathLabel(target.dir)}] ` : ''
    const prefix = color && label ? `${COLORS[index % COLORS.length]}${label}${RESET}` : label
    const child = spawn(packageManager, ['run', target.script], {
      cwd: target.dir,
      env: {...process.env, ...env},
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    const pipe = (stream, out) => {
      let pending = ''
      stream.on('data', (chunk) => {
        pending += chunk.toString()
        const lines = pending.split('\n')
        pending = lines.pop()
        for (const line of lines) out.write(`${prefix}${line}\n`)
      })
      stream.on('end', () => pending && out.write(`${prefix}${pending}\n`))
    }
    pipe(child.stdout, process.stdout)
    pipe(child.stderr, process.stderr)
    child.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM' && signal !== 'SIGINT') process.stdout.write(`${prefix}exited with ${signal ?? code}\n`)
    })
    children.push(child)
  })
  return () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  }
}

function pathLabel(dir) {
  return dir.split(/[\\/]/).filter(Boolean).pop()
}
