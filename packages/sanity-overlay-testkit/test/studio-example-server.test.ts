/**
 * The example Studio's overlay server — the SHIPPED package, and the spike it
 * replaced.
 *
 * `examples/kitchen-sink` is the Studio a developer actually opens, and until
 * now `pnpm overlay:server` booted `spikeA/overlayServer.mjs`: a throwaway
 * written to answer a Phase 1 feasibility question, with its own route table,
 * its own translation layer and its own idea of what a commit is. PRD §0.6 is
 * explicit that spike code is disposable and must never be promoted — so the
 * example demonstrating the product must run `sanity-overlay-next`, which is
 * the package the endpoints actually live in.
 *
 * TWO THINGS ARE ASSERTED, AND THE SECOND MATTERS AS MUCH AS THE FIRST:
 *
 *  1. The example boots the real API. Not "the script string changed" — the
 *     launcher is executed as a child process, exactly as `pnpm overlay:server`
 *     would execute it, and is made to answer real HTTP.
 *  2. The spike still boots. §36.1's evidence procedures and
 *     `overlay-server.test.ts` are written against `spikeA/`, and evidence that
 *     no longer runs is not evidence. Repointing the script must not have been
 *     a removal.
 *
 * A string check alone would pass against a launcher that throws on import —
 * which is the exact failure mode of running TypeScript sources through `node`,
 * and therefore the one thing worth spending a child process on.
 */
import {execFile, spawn} from 'node:child_process'
import {readFile, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startOverlayServer} from '../../../examples/kitchen-sink/spikeA/overlayServer.mjs'

/* Two `node` boots per case, each importing the whole overlay stack. */
vi.setConfig({testTimeout: 60_000, hookTimeout: 60_000})

const KITCHEN_SINK = fileURLToPath(new URL('../../../examples/kitchen-sink/', import.meta.url))
const PACKAGE_JSON = join(KITCHEN_SINK, 'package.json')
const REAL_LAUNCHER = join(KITCHEN_SINK, 'overlayApiServer.mjs')
const SPIKE_LAUNCHER = join(KITCHEN_SINK, 'spikeA', 'runOverlayServer.mjs')

const roots: string[] = []
const running: Array<{close: () => Promise<void>}> = []
const children: Array<() => void> = []

afterEach(async () => {
  for (const kill of children.splice(0)) kill()
  for (const server of running.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kitchen-sink-overlay-'))
  roots.push(root)
  return root
}

async function readScript(name: string): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts?.[name]
}

interface Booted {
  url: string
  stdout: string
  stderr: string
}

/**
 * Run a launcher as `pnpm overlay:server` would, and wait for it to say where
 * it is listening.
 *
 * The URL is parsed out of the launcher's own banner rather than assumed, so a
 * launcher that binds a different port than it announces cannot pass: the test
 * then talks to nothing.
 */
function boot(script: string, args: readonly string[]): Promise<Booted> {
  return new Promise((resolveBoot, rejectBoot) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: KITCHEN_SINK,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, NODE_OPTIONS: ''},
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const kill = (): void => {
      if (!child.killed) child.kill('SIGKILL')
    }
    children.push(kill)

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveBoot({url, stdout, stderr})
      else rejectBoot(new Error(`${error.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    }

    let url = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = /listening on (http:\/\/[^\s]+)/.exec(stdout)
      /* Wait for the WHOLE banner, not just the first line: `CORS origin` is
       * the last thing both launchers print, so resolving on it means the
       * assertions below read a complete buffer rather than racing the pipe. */
      if (match !== null && stdout.includes('CORS origin')) {
        url = match[1]!
        finish()
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      finish(new Error(`launcher exited with code ${code} before it announced a port`))
    })
    child.on('error', (error) => finish(error))

    const timer = setTimeout(
      () => finish(new Error('launcher never announced a port within 45s')),
      45_000,
    )
    timer.unref?.()
  })
}

/* ------------------------------------------------------------------ *
 * The script itself
 * ------------------------------------------------------------------ */

describe('the example runs the shipped overlay API, not the spike', () => {
  it('points `overlay:server` at the real launcher', async () => {
    const script = await readScript('overlay:server')

    expect(script).toBeDefined()
    expect(script).toContain('overlayApiServer.mjs')
    /* PRD §0.6: spike code is disposable and is never what a product surface
     * runs. A script naming `spikeA/` is the defect this test exists for. */
    expect(script).not.toContain('spikeA')
  })

  it('needs no experimental flag to run', async () => {
    const script = await readScript('overlay:server')
    /* Node 22.18 unflagged type stripping. A `--experimental-strip-types` left
     * in the script is a flag that will be REMOVED by a future Node and take
     * the example's only run command with it. */
    expect(script).not.toContain('--experimental-')
  })
})

/* ------------------------------------------------------------------ *
 * The real launcher, executed
 * ------------------------------------------------------------------ */

describe('the shipped launcher boots and serves', () => {
  it('binds a port, announces it, and answers /state from sanity-overlay-next', async () => {
    const root = await makeRoot()
    const booted = await boot(REAL_LAUNCHER, ['--port=0', `--root=${root}`, '--id=example-local'])

    expect(booted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(booted.stdout).toContain('overlay id   example-local')

    const response = await fetch(`${booted.url}/state`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    /* `/state` is a `sanity-overlay-next` route; `spikeA/overlayServer.mjs`
     * answers a different shape. Asserting the overlay id proves which server
     * replied, not merely that something is listening. */
    expect(body.overlayId).toBe('example-local')
    expect(body.ok).not.toBe(false)
    expect(Array.isArray(body.documents)).toBe(true)
  })

  it('serves the health route and grants CORS only to the origin it was given', async () => {
    const root = await makeRoot()
    const booted = await boot(REAL_LAUNCHER, [
      '--port=0',
      `--root=${root}`,
      '--origin=http://localhost:4444',
    ])

    const granted = await fetch(`${booted.url}/health`, {
      headers: {origin: 'http://localhost:4444'},
    })
    expect(granted.status).toBe(200)
    expect(granted.headers.get('access-control-allow-origin')).toBe('http://localhost:4444')

    /* The branch is every unpublished edit in the project. An origin that was
     * not named gets no grant. */
    const refused = await fetch(`${booted.url}/health`, {
      headers: {origin: 'http://evil.example'},
    })
    expect(refused.headers.get('access-control-allow-origin')).not.toBe('http://evil.example')
  })

  it('refuses an unknown flag rather than silently ignoring it', async () => {
    const {code, stderr} = await new Promise<{code: number | null; stderr: string}>((resolve) => {
      execFile(
        process.execPath,
        [REAL_LAUNCHER, '--nonsense=1'],
        {cwd: KITCHEN_SINK},
        (error, _stdout, stderrOut) => {
          resolve({code: (error as {code?: number} | null)?.code ?? 0, stderr: stderrOut})
        },
      )
    })

    expect(code).not.toBe(0)
    expect(stderr).toContain('unknown flag --nonsense')
  })
})

/* ------------------------------------------------------------------ *
 * The spike, left intact
 * ------------------------------------------------------------------ */

describe('the Phase 1 spike is still runnable evidence', () => {
  it('still boots as a module — `overlay-server.test.ts` depends on it', async () => {
    const root = await makeRoot()
    const server = await startOverlayServer({
      root,
      port: 0,
      overlayId: 'spike-a-still-alive-00000000000',
      origins: ['http://localhost:3333'],
      now: (() => {
        let tick = 0
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))).toISOString()
      })(),
    })
    running.push(server)

    const response = await fetch(`${server.url}/state`)
    expect(response.status).toBe(200)
    expect(server.overlayId).toBe('spike-a-still-alive-00000000000')
  })

  it('still boots as a process — the §36.1 evidence command still works', async () => {
    const root = await makeRoot()
    const booted = await boot(SPIKE_LAUNCHER, ['--port=0', `--root=${root}`, '--id=spike-a-alive'])

    expect(booted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${booted.url}/state`)
    expect(response.status).toBe(200)
  })
})
