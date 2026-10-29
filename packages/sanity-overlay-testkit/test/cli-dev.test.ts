/**
 * `sanity-overlay dev` — the one-command local runtime (roadmap "pleasant DX").
 *
 * WHAT IT IS. The distributable answer to "run the overlay": start the real
 * overlay API server against `--root`, create the overlay when the directory
 * has none (identity from flags — never guessed), and print the wiring a
 * developer needs next: the env lines for their Studio and their site, the
 * port, the health URL, and the CLI verbs for inspecting the branch. Until
 * this command existed, "run the overlay" meant knowing which launcher script
 * in which example directory to start with which four env vars — knowledge
 * that lived in a runbook and two people's heads.
 *
 * THE SEAMS. `runDev` blocks until shutdown by design (it IS the dev server),
 * so tests inject `until` (a promise whose resolution is the Ctrl-C) and
 * `onReady` (called with the bound server before blocking). Assertions run
 * between the two, against the REAL HTTP surface — no mocks; the port is `0`
 * so parallel suites cannot collide.
 */
import {existsSync, readFileSync} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {EXIT} from '../../sanity-overlay-cli/src/index'
import {runDev} from '../../sanity-overlay-cli/src/commands/dev'
import type {CommandContext} from '../../sanity-overlay-cli/src/index'
import {
  cleanupOverlayFixtures,
  createOverlayFixture,
} from '../../sanity-overlay-cli/test-support/overlayFixture'

const roots: string[] = []

afterEach(async () => {
  await cleanupOverlayFixtures()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli-dev-'))
  roots.push(root)
  return root
}

function makeClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 11, 22, 0, tick++)).toISOString()
}

interface Captured {
  ctx: CommandContext
  lines: () => string
  jsonValues: unknown[]
}

function makeCtx(root: string, json = false): Captured {
  const out: string[] = []
  const jsonValues: unknown[] = []
  return {
    ctx: {
      root,
      json,
      now: makeClock(),
      out: (line) => out.push(line),
      warn: (line) => out.push(line),
      emitJson: (value) => {
        if (json) jsonValues.push(value)
      },
    },
    lines: () => out.join('\n'),
    jsonValues,
  }
}

interface ReadyServer {
  url: string
  port: number
}

/** Run `dev`, hand the ready server to `probe`, then shut down and return. */
async function withDev(
  ctx: CommandContext,
  options: Record<string, unknown>,
  probe: (server: ReadyServer) => Promise<void>,
): Promise<number> {
  let release!: () => void
  const until = new Promise<void>((resolveUntil) => {
    release = resolveUntil
  })
  let probeError: unknown = null
  const code = await runDev(ctx, {
    port: 0,
    ...options,
    until,
    onReady: (server: ReadyServer) => {
      void probe(server)
        .catch((error) => {
          probeError = error
        })
        .finally(release)
    },
  })
  if (probeError !== null) throw probeError
  return code
}

describe('sanity-overlay dev — an existing overlay', () => {
  it('serves the real overlay API and prints the wiring a developer needs next', async () => {
    const fixture = await createOverlayFixture()
    const {ctx, lines} = makeCtx(fixture.root)

    const code = await withDev(ctx, {}, async (server) => {
      const health = await fetch(`${server.url}/health`)
      expect(health.status).toBe(200)

      const state = (await fetch(`${server.url}/state`, {
        headers: {origin: 'http://localhost:3333'},
      }).then((response) => response.json())) as {ok: boolean; revision: number}
      expect(state.ok).toBe(true)
    })
    expect(code).toBe(EXIT.OK)

    const output = lines()
    /* The four things §the-user-asked-for: where it runs, how to wire the
     * Studio, how to wire the site, and how to look inside the branch. */
    expect(output).toMatch(/http:\/\/127\.0\.0\.1:\d+/)
    expect(output).toContain('SANITY_STUDIO_OVERLAY_MODE=fs')
    expect(output).toMatch(/SANITY_STUDIO_OVERLAY_API_URL=http:\/\/127\.0\.0\.1:\d+/)
    expect(output).toContain('SANITY_OVERLAY_MODE=fs')
    expect(output).toContain(`SANITY_OVERLAY_ROOT=${fixture.root}`)
    expect(output).toContain('sanity-overlay status')
    expect(output).toContain('sanity-overlay conflicts')
    expect(output).toContain('Ctrl-C')
    /* And the identity line — a dev server that does not say WHICH overlay it
     * serves invites editing the wrong branch. */
    expect(output).toContain(fixture.overlayId)
  })

  it('grants CORS to the studio origin it names, and only that one', async () => {
    const fixture = await createOverlayFixture()
    const {ctx, lines} = makeCtx(fixture.root)

    const code = await withDev(ctx, {studioOrigin: 'http://localhost:3345'}, async (server) => {
      const granted = await fetch(`${server.url}/state`, {
        headers: {origin: 'http://localhost:3345'},
      })
      expect(granted.headers.get('access-control-allow-origin')).toBe('http://localhost:3345')

      const refused = await fetch(`${server.url}/state`, {
        headers: {origin: 'http://evil.example'},
      })
      expect(refused.headers.get('access-control-allow-origin')).toBeNull()
    })
    expect(code).toBe(EXIT.OK)
    expect(lines()).toContain('http://localhost:3345')
  })
})

describe('sanity-overlay dev — a fresh project directory', () => {
  it('creates the overlay from an explicit identity and says it did', async () => {
    const root = await emptyRoot()
    const {ctx, lines} = makeCtx(root)

    const code = await withDev(
      ctx,
      {project: 'b1n03q3z', dataset: 'parity'},
      async (server) => {
        const health = await fetch(`${server.url}/health`)
        expect(health.status).toBe(200)
      },
    )
    expect(code).toBe(EXIT.OK)

    const manifestPath = join(root, '.sanity-overlay', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      base: {projectId: string; dataset: string}
    }
    expect(manifest.base.projectId).toBe('b1n03q3z')
    expect(manifest.base.dataset).toBe('parity')
    expect(lines().toLowerCase()).toContain('created')
  })

  /**
   * DETACHED OVERLAYS — content before a Sanity project exists.
   *
   * A common start: the team wants to build the UI and seed content NOW, and
   * a real Sanity project comes later (project ids are ASSIGNED by Sanity, so
   * they cannot be guessed ahead of time). In `fs` mode the manifest's
   * project/dataset is an inert label — nothing ever contacts Sanity — so a
   * detached overlay is safe; what matters is that the label is HONEST: a
   * sentinel that cannot be mistaken for a real project id, chosen by an
   * explicit flag rather than defaulted into.
   */
  it('--detached creates an overlay with a sentinel identity and says how to attach later', async () => {
    const root = await emptyRoot()
    const {ctx, lines} = makeCtx(root)

    const code = await withDev(ctx, {detached: true}, async (server) => {
      const health = await fetch(`${server.url}/health`)
      expect(health.status).toBe(200)
    })
    expect(code).toBe(EXIT.OK)

    const manifest = JSON.parse(
      readFileSync(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ) as {base: {projectId: string; dataset: string}}
    /* The sentinel must be impossible to mistake for a real project id (real
     * ids are lowercase alphanumerics; a dot cannot appear in one). */
    expect(manifest.base.projectId).toBe('detached.local')
    expect(manifest.base.dataset).toBe('detached')

    const output = lines()
    expect(output.toLowerCase()).toContain('detached')
    /* It must name the way OUT of detached — the `attach` verb, not a manual
     * manifest edit (which is what this line said before `attach` existed). */
    expect(output).toContain('sanity-overlay attach')
  })

  it('refuses --detached combined with --project — the two contradict', async () => {
    const root = await emptyRoot()
    const {ctx} = makeCtx(root)
    await expect(
      runDev(ctx, {port: 0, detached: true, project: 'b1n03q3z', dataset: 'parity'}),
    ).rejects.toThrow(/--detached/)
  })

  it('refuses to invent an identity, naming the flags that supply one', async () => {
    const root = await emptyRoot()
    const {ctx} = makeCtx(root)

    await expect(runDev(ctx, {port: 0})).rejects.toThrow(/--project.*--dataset|--dataset.*--project/s)
    /* And nothing was scaffolded by the refusal. */
    expect(existsSync(join(root, '.sanity-overlay'))).toBe(false)
  })
})
