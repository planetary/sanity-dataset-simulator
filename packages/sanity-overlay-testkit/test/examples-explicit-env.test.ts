/**
 * `examples/**` must never be pointed at a foreign project by a shell.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT CLASS.
 *
 * `packages/sanity-overlay-testkit/src/env.ts` closed this hole for the tests:
 * configuration is read from the repo's declared source, the ambient
 * environment is *checked* and never *obeyed*, and a disagreement is refused
 * rather than resolved. `e2e/**` and `src/hosted.ts` go through it.
 *
 * `examples/**` did not. Every example read `process.env` directly, so
 * `pnpm dev` in a shell that carried another project's `SANITY_PROJECT_ID`,
 * `SANITY_STUDIO_PROJECT_ID` or `SANITY_API_HOST` pointed the example at that
 * project — silently, and with the developer's own cookies and tokens behind
 * the request in the proxy's case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY CASE HERE IS A CHILD PROCESS.
 *
 * A previous attempt at this class produced a VACUOUS test: it set the
 * contaminating variables on `process.env` inside the test and then asserted on
 * a value the module under test had already computed at *module scope*, before
 * the assignment. The contamination arrived after the read it was supposed to
 * poison, so the test passed against the unfixed code.
 *
 * The only way to present a genuinely contaminated shell to a module that reads
 * its environment at import time is to hand the environment to `spawn`. So every
 * case below boots the real launcher — the exact command `pnpm dev` /
 * `pnpm overlay:server` runs — with a poisoned `env` and reads its own output.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CANARIES.
 *
 * Every contaminating value below is a string that exists on no machine and in
 * no Sanity account: a project id no one was issued, a dataset no one created,
 * a host that does not resolve. That matters twice. It means a passing run
 * cannot be an accident of the developer's `.env` happening to agree, and it
 * means an assertion of the form "the output does not contain the canary" is a
 * real statement about where the example pointed rather than about formatting.
 */
import {spawn} from 'node:child_process'
import {existsSync, unlinkSync, writeFileSync} from 'node:fs'
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createSiteBaseSource} from '../../../examples/local-site/src/createClient'

/* Each case boots a Node process that imports a good part of the overlay stack. */
vi.setConfig({testTimeout: 90_000, hookTimeout: 90_000})

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const EXAMPLES = join(REPO, 'examples')
const KITCHEN_SINK = join(EXAMPLES, 'kitchen-sink')
const LOCAL_SITE = join(EXAMPLES, 'local-site')

/* ------------------------------------------------------------------ *
 * Canaries and shells
 * ------------------------------------------------------------------ */

/**
 * The identity of a project that does not exist. Spelled distinctively so a
 * `toContain` over a whole banner cannot match anything else in it.
 */
const CANARY = Object.freeze({
  SANITY_PROJECT_ID: 'zzcanaryproj0000',
  SANITY_DATASET: 'zz-canary-dataset',
  SANITY_READ_TOKEN: 'skZZCANARYtokenThatWasNeverIssued',
  SANITY_STUDIO_PROJECT_ID: 'zzcanarystudio00',
  SANITY_STUDIO_DATASET: 'zz-canary-studio-dataset',
  SANITY_API_HOST: 'https://zzcanaryhost0000.api.sanity.io',
})

/** Every canary value, for "this string must appear nowhere" assertions. */
const CANARY_VALUES = Object.values(CANARY)

/**
 * A shell with nothing of ours in it.
 *
 * The developer running this suite may legitimately have `SANITY_PROJECT_ID`
 * exported — the whole point of the change under test is that this is now
 * ignored rather than obeyed — so the "clean" control has to be built by
 * *removing* keys, not by trusting the runner's own environment to be empty.
 */
function cleanShell(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(SANITY|OVERLAY|SPIKE|PROXY|SITE)_/.test(key)) continue
    env[key] = value
  }
  /* An inherited `--experimental-*` or loader flag would change what the child
   * resolves; `studio-example-server.test.ts` clears it for the same reason. */
  env.NODE_OPTIONS = ''
  return env
}

/** A shell that another project has configured. */
function contaminatedShell(): NodeJS.ProcessEnv {
  return {...cleanShell(), ...CANARY}
}

/* ------------------------------------------------------------------ *
 * Running a launcher
 * ------------------------------------------------------------------ */

interface Ran {
  code: number | null
  stdout: string
  stderr: string
  get output(): string
}

const kills: Array<() => void> = []
const roots: string[] = []

afterEach(async () => {
  for (const kill of kills.splice(0)) kill()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/**
 * Run a command to completion, or — if `until` matches its output first — up to
 * that point and then kill it.
 *
 * Servers here are expected either to refuse (exit non-zero, quickly) or to boot
 * and listen forever. `until` is how the second case terminates: the launcher's
 * own banner is the signal, so a launcher that announces something it did not do
 * still fails the assertions that follow.
 */
function run(
  args: readonly string[],
  options: {cwd: string; env: NodeJS.ProcessEnv; until?: RegExp},
): Promise<Ran> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const kill = (): void => {
      if (!child.killed) child.kill('SIGKILL')
    }
    kills.push(kill)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({
        code,
        stdout,
        stderr,
        get output() {
          return `${stdout}\n${stderr}`
        },
      })
    }

    const check = (): void => {
      if (options.until !== undefined && options.until.test(`${stdout}\n${stderr}`)) {
        kill()
        finish(null)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      check()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      check()
    })
    child.on('exit', (code) => finish(code))
    child.on('error', (error) => rejectRun(error))

    const timer = setTimeout(() => {
      kill()
      finish(null)
    }, 60_000)
    timer.unref?.()
  })
}

/** Every regular file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const path = join(current, entry)
      const info = await stat(path)
      if (info.isDirectory()) await walk(path)
      else out.push(path)
    }
  }
  await walk(dir)
  return out
}

/** Nothing the run left behind may name the project that does not exist. */
async function expectNoCanaryOnDisk(root: string): Promise<void> {
  for (const path of await filesUnder(root)) {
    const text = await readFile(path, 'utf8')
    for (const canary of CANARY_VALUES) {
      expect(text, `${path} recorded the ambient ${canary}`).not.toContain(canary)
    }
  }
}

/* ================================================================== *
 * examples/local-site — the whole ambient environment was spread in
 * ================================================================== */

describe('examples/local-site reads its base dataset from a declared source only', () => {
  /**
   * `run.mjs` built the site's environment as `{...process.env, …}`, and
   * `createSiteBaseSource` reads `SANITY_PROJECT_ID` + `SANITY_DATASET` out of
   * it to decide between the committed NDJSON snapshot and the HOSTED query
   * API. So an exported pair — from any other project, in any shell — moved the
   * site's reads onto that project's content, with `SANITY_READ_TOKEN`
   * attached, and said nothing.
   *
   * The banner is the oracle: the site prints `base=file …` or
   * `base=hosted <project>/<dataset> …`, and it prints it from the resolved
   * source rather than from the flags it was given.
   */
  it('ignores an ambient SANITY_PROJECT_ID/SANITY_DATASET rather than dialling it', async () => {
    const ran = await run(['--experimental-strip-types', 'run.mjs', '--mode=off', '--port=0'], {
      cwd: LOCAL_SITE,
      env: contaminatedShell(),
      until: /\[site\] mode=/,
    })

    expect(ran.output).toMatch(/\[site\] mode=off {2}base=file /)
    for (const canary of CANARY_VALUES) {
      expect(ran.output, 'the ambient shell reached the site client').not.toContain(canary)
    }
  })

  /**
   * Ignoring in silence is the other half of the bug, not the fix. A developer
   * who exported the pair on purpose and then watched the site serve the
   * committed snapshot is owed the reason, and the testkit's loader is
   * explicit that this case WARNS rather than refusing (the declared source
   * simply has no opinion, so there is nothing to disagree with).
   *
   * This assertion is also what stops the case above from passing vacuously:
   * it proves the ambient value was SEEN and rejected, not merely absent.
   */
  it('says on stderr which ambient key it ignored', async () => {
    const ran = await run(['--experimental-strip-types', 'run.mjs', '--mode=off', '--port=0'], {
      cwd: LOCAL_SITE,
      env: contaminatedShell(),
      until: /\[site\] mode=/,
    })

    expect(ran.stderr).toContain('SANITY_PROJECT_ID')
    expect(ran.stderr).toMatch(/IGNORING/i)
  })

  /**
   * The control. Without contamination the example must still work exactly as
   * documented — a red here would mean the fix broke the example rather than
   * securing it.
   */
  it('still serves the committed snapshot in a clean shell', async () => {
    const ran = await run(['--experimental-strip-types', 'run.mjs', '--mode=off', '--port=0'], {
      cwd: LOCAL_SITE,
      env: cleanShell(),
      until: /\[site\] mode=/,
    })

    expect(ran.output).toMatch(/\[site\] mode=off {2}base=file /)
    expect(ran.output).toMatch(/\[site\] listening on http:\/\/127\.0\.0\.1:\d+/)
  })
})

/* ================================================================== *
 * examples/kitchen-sink — the Studio a consumer copies
 * ================================================================== */

describe('examples/kitchen-sink refuses an ambient Studio identity', () => {
  /**
   * `sanity.cli.ts` is the file the Sanity CLI evaluates FIRST, in Node, before
   * it starts Vite — and it is therefore the only place in this example that
   * can still tell an ambient `SANITY_STUDIO_PROJECT_ID` apart from one the
   * Studio's own `.env` declared. (By the time `sanity.config.ts` runs, the two
   * have been merged into one `process.env` by dotenv, ambient winning, and the
   * distinction no longer exists.)
   *
   * So the refusal lives here, and it must be a refusal: an ambient id and a
   * declared id name DIFFERENT projects, and picking either silently is how an
   * editing session writes branch intents naming a foreign project's document
   * ids into this repository's committed `.sanity-overlay/`.
   */
  it('aborts the CLI config when the shell disagrees with the declared identity', async () => {
    const ran = await run(
      [
        '-e',
        `import(${JSON.stringify(join(KITCHEN_SINK, 'sanity.cli.ts'))})
           .then((m) => console.log('RESOLVED ' + JSON.stringify(m.default.api)))
           .catch((error) => { console.error(String(error && error.message)); process.exit(3) })`,
      ],
      {cwd: KITCHEN_SINK, env: contaminatedShell()},
    )

    expect(ran.code, ran.output).not.toBe(0)
    expect(ran.output).toContain('SANITY_STUDIO_PROJECT_ID')
    expect(ran.output).toMatch(/REFUS/i)
    expect(ran.output).not.toContain('RESOLVED')
  })

  /**
   * The control, and the thing that keeps the example an example: with nothing
   * exported it resolves the identity this repository declares, so
   * `pnpm --filter kitchen-sink dev` still just works.
   */
  it('resolves the declared identity in a clean shell', async () => {
    const ran = await run(
      [
        '-e',
        `import(${JSON.stringify(join(KITCHEN_SINK, 'sanity.cli.ts'))})
           .then((m) => console.log('RESOLVED ' + JSON.stringify(m.default.api)))
           .catch((error) => { console.error(String(error && error.stack)); process.exit(3) })`,
      ],
      {cwd: KITCHEN_SINK, env: cleanShell()},
    )

    expect(ran.code, ran.output).toBe(0)
    expect(ran.stdout).toContain('RESOLVED {"projectId":"b1n03q3z","dataset":"parity"}')
  })
})

/* ================================================================== *
 * examples/kitchen-sink/spikeA — Phase 1 evidence, still evidence
 * ================================================================== */

describe('the Spike A overlay server stamps the declared identity, never the shell', () => {
  /**
   * `startOverlayServer` writes `base: {projectId, dataset}` into
   * `.sanity-overlay/manifest.json`, which is a COMMITTED artefact: it is how a
   * branch overlay says which dataset it is a branch of. A shell that redirected
   * it would put a foreign project id into the repository's own history.
   */
  it('refuses to boot against an ambient SANITY_STUDIO_PROJECT_ID', async () => {
    const root = await makeRoot('spike-a-canary-')
    const ran = await run(
      [
        '--experimental-strip-types',
        join('spikeA', 'runOverlayServer.mjs'),
        '--port=0',
        `--root=${root}`,
        '--id=spike-a-canary-guard',
      ],
      {cwd: KITCHEN_SINK, env: contaminatedShell()},
    )

    expect(ran.code, ran.output).not.toBe(0)
    expect(ran.output).toContain('SANITY_STUDIO_PROJECT_ID')
    /* And, independently of what it said: nothing was written naming it. */
    await expectNoCanaryOnDisk(root)
  })

  /**
   * §36.1's evidence procedures are written against this launcher. Evidence that
   * no longer runs is not evidence, so the clean path is asserted on the artefact
   * the spike exists to produce.
   */
  it('still boots in a clean shell and writes the declared base into the manifest', async () => {
    const root = await makeRoot('spike-a-clean-')
    const ran = await run(
      [
        '--experimental-strip-types',
        join('spikeA', 'runOverlayServer.mjs'),
        '--port=0',
        `--root=${root}`,
        '--id=spike-a-clean-guard',
      ],
      {cwd: KITCHEN_SINK, env: cleanShell(), until: /\[overlay\] CORS origin/},
    )

    expect(ran.output).toMatch(/\[overlay\] listening on http:\/\/127\.0\.0\.1:\d+/)

    const manifest = JSON.parse(
      await readFile(join(root, '.sanity-overlay', 'manifest.json'), 'utf8'),
    ) as {base: {projectId: string; dataset: string}}
    expect(manifest.base).toEqual({
      projectId: 'b1n03q3z',
      dataset: 'parity',
      apiVersion: '2025-02-19',
    })
  })
})

/* ================================================================== *
 * examples/kitchen-sink/spikeB-proxy — the request path
 * ================================================================== */

describe('the Spike B proxy dials only the declared upstream', () => {
  /**
   * Mode 1 forwards Studio's REAL, authenticated traffic — session cookies and
   * bearer tokens included — to `upstream`. `SANITY_API_HOST` chose that host
   * out of the ambient environment, which makes it the most expensive ambient
   * read in `examples/`: the failure is not "reads the wrong content", it is
   * "sends this developer's credentials to a host they did not name".
   */
  it('refuses an ambient SANITY_API_HOST', async () => {
    const ran = await run(
      [
        '-e',
        `import(${JSON.stringify(join(KITCHEN_SINK, 'spikeB-proxy', 'proxy.mjs'))})
           .then((m) => console.log('UPSTREAM ' + m.resolveProxyConfig({}).upstream.origin))
           .catch((error) => { console.error(String(error && error.message)); process.exit(3) })`,
      ],
      {cwd: join(KITCHEN_SINK, 'spikeB-proxy'), env: contaminatedShell()},
    )

    expect(ran.code, ran.output).not.toBe(0)
    expect(ran.output).toContain('SANITY_API_HOST')
    /* No config was produced at all. The refusal message DOES quote the
     * ambient value — naming both sides is the whole point of it — so the
     * check that nothing was dialled has to be the absence of a resolution,
     * not the absence of the string. */
    expect(ran.stdout).not.toContain('UPSTREAM')
  })

  it('keeps the declared default in a clean shell', async () => {
    const ran = await run(
      [
        '-e',
        `import(${JSON.stringify(join(KITCHEN_SINK, 'spikeB-proxy', 'proxy.mjs'))})
           .then((m) => console.log('UPSTREAM ' + m.resolveProxyConfig({}).upstream.origin))
           .catch((error) => { console.error(String(error && error.stack)); process.exit(3) })`,
      ],
      {cwd: join(KITCHEN_SINK, 'spikeB-proxy'), env: cleanShell()},
    )

    expect(ran.code, ran.output).toBe(0)
    expect(ran.stdout).toContain('UPSTREAM https://b1n03q3z.api.sanity.io')
  })

  /**
   * Mode 2 fabricates a fully-granted `local-dev` identity and serves it from
   * loopback. The project id it serves is stamped into the overlay it opens, so
   * the same rule applies to the same key.
   */
  it('refuses an ambient Studio identity in Mode 2', async () => {
    const root = await makeRoot('origin-canary-')
    const ran = await run(
      ['--experimental-strip-types', 'runOrigin.mjs', '--origin', '--port=0', `--root=${root}`],
      {cwd: join(KITCHEN_SINK, 'spikeB-proxy'), env: contaminatedShell()},
    )

    expect(ran.code, ran.output).not.toBe(0)
    expect(ran.output).toContain('SANITY_STUDIO_PROJECT_ID')
    await expectNoCanaryOnDisk(root)
  })
})

/* ================================================================== *
 * The class, not the four instances
 * ================================================================== */

describe('no example reads a project identity out of an ambient environment', () => {
  /**
   * The four cases above are the instances that were found. This is the family.
   *
   * A source scan is a weaker kind of evidence than a booted process, and it is
   * here for the case the booted processes cannot cover: the NEXT example, or
   * the next `process.env.SANITY_…` added to an existing one. It fails on the
   * pattern rather than on the consequence, which is exactly what makes it
   * survive a file that has no launcher yet.
   */
  const IDENTITY_KEYS = [
    'SANITY_PROJECT_ID',
    'SANITY_DATASET',
    'SANITY_API_VERSION',
    'SANITY_READ_TOKEN',
    'SANITY_API_READ_TOKEN',
    'SANITY_STUDIO_PROJECT_ID',
    'SANITY_STUDIO_DATASET',
    'SANITY_API_HOST',
  ]

  /**
   * The two modules allowed to name an identity key, and why.
   *
   *  - `examples/explicitEnv.mjs` is the loader itself: naming the keys is its
   *    entire job, and it reads them from the DECLARED source.
   *  - `examples/kitchen-sink/studioIdentity.mjs` is the browser-safe seam. A
   *    Studio bundle has no filesystem, so it cannot read a declared source and
   *    cannot tell ambient from declared; the check for it happens in Node, in
   *    `sanity.cli.ts`, which the Sanity CLI always evaluates first. Keeping
   *    the read here — one named function, not a scattering of `process.env` —
   *    is what makes that pairing checkable.
   */
  const DECLARED_READERS = ['examples/explicitEnv.mjs', 'examples/kitchen-sink/studioIdentity.mjs']

  async function sourceFiles(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir)) {
        if (entry === 'node_modules' || entry === '.sanity' || entry.startsWith('.overlay-')) {
          continue
        }
        const path = join(dir, entry)
        const info = await stat(path)
        if (info.isDirectory()) await walk(path)
        else if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry)) out.push(path)
      }
    }
    await walk(EXAMPLES)
    return out
  }

  it('names an identity key only in the declared-source modules', async () => {
    const offenders: string[] = []
    for (const path of await sourceFiles()) {
      const relative = path.slice(REPO.length)
      if (DECLARED_READERS.includes(relative)) continue
      const source = await readFile(path, 'utf8')
      /* Code, not prose: the launchers document their variables in header
       * comments and those are the documentation this change keeps. */
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      for (const key of IDENTITY_KEYS) {
        if (new RegExp(`(process\\.env|import\\.meta\\.env|\\benv)\\s*[.[]\\s*['"]?${key}\\b`).test(code)) {
          offenders.push(`${relative} reads ${key}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * And the mirror image: the loader must actually exist and be used. A scan
   * that passes because every example stopped configuring anything would be no
   * better than the bug.
   */
  it('routes the launchers through the declared-source loader', async () => {
    const users = [
      'examples/local-site/run.mjs',
      'examples/kitchen-sink/sanity.cli.ts',
      'examples/kitchen-sink/spikeA/overlayServer.mjs',
      'examples/kitchen-sink/spikeB-proxy/proxy.mjs',
      'examples/kitchen-sink/spikeB-proxy/runOrigin.mjs',
    ]
    for (const relative of users) {
      const source = await readFile(join(REPO, relative), 'utf8')
      expect(source, `${relative} does not consult the declared source`).toMatch(/explicitEnv/)
    }
  })
})

/* ================================================================== *
 * The other half of "explicit": the declared spelling has to WORK
 * ================================================================== */

/**
 * DECLARING A VALUE CORRECTLY AND HAVING IT IGNORED IS THE SAME BUG.
 *
 * Everything above stops an *undeclared* value from reaching the example. This
 * block is the mirror image, and it is the same defect class rather than a
 * separate one: `examples/local-site` read `SANITY_DATASET` and
 * `SANITY_READ_TOKEN`, while this repository declares — in `.env`, in PRD §11.2,
 * in the testkit's `MANAGED_KEYS`, in `src/hosted.ts` and in
 * `e2e/playwright/upstream.ts` — `SANITY_BASE_DATASET` and
 * `SANITY_API_READ_TOKEN`.
 *
 * So the obvious thing a developer does — copy the repo's own `.env` into
 * `examples/local-site/.env` — produced a HALF configuration: the project id
 * matched, the dataset did not, and `createSiteBaseSource` fell silently back to
 * the committed NDJSON fixture while every visible signal said "configured for
 * the real dataset". That is precisely the silent-wrong-data-source failure the
 * rest of this file exists to abolish, arrived at from the other direction, and
 * an example that ships it teaches the bug.
 *
 * WHICH NAME WINS. `SANITY_BASE_DATASET` and `SANITY_API_READ_TOKEN`, because
 * five other places in this repository already say so and one place said
 * otherwise. The token spelling is not merely cosmetic either:
 * `assertNoWriteToken` in `sanity-overlay-studio/src/options.ts` hard-crashes on
 * any Sanity credential whose NAME does not say read-only, which is why the
 * declared spelling is the explicit one. The old spellings keep working — an
 * example that broke on upgrade would be its own defect — but they say so.
 */
describe('examples/local-site honours the spelling this repository declares', () => {
  const PROJECT = 'declaredproj0001'
  const DATASET = 'declared-dataset'
  const TOKEN = 'skDECLAREDreadTokenForTheseTests'

  /** An outbound-request recorder, so the token is asserted where it lands. */
  function recorder(): {
    calls: Array<{url: string; authorization: string | null}>
    fetchImpl: typeof fetch
  } {
    const calls: Array<{url: string; authorization: string | null}> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({url: String(input), authorization: headers.get('authorization')})
      return new Response(JSON.stringify({result: []}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    }) as unknown as typeof fetch
    return {calls, fetchImpl}
  }

  /* ---------------------------------------------------------------- *
   * The dataset spelling
   * ---------------------------------------------------------------- */

  /**
   * THE LOAD-BEARING CASE. A `.env` carrying only the declared spelling must
   * fully configure the site. Before this change it configured nothing and the
   * site served the fixture.
   */
  it('configures the hosted base from the declared SANITY_BASE_DATASET alone', () => {
    const base = createSiteBaseSource({
      SANITY_PROJECT_ID: PROJECT,
      SANITY_BASE_DATASET: DATASET,
    })

    expect(base.summary).toBe(`hosted ${PROJECT}/${DATASET} (read-only, GET)`)
    expect(base.warnings).toEqual([])
  })

  /**
   * The legacy spelling still works — an example that broke on upgrade would be
   * its own defect — but it is no longer silent about being legacy.
   */
  it('still accepts the legacy SANITY_DATASET, and says it is legacy', () => {
    const base = createSiteBaseSource({
      SANITY_PROJECT_ID: PROJECT,
      SANITY_DATASET: DATASET,
    })

    expect(base.summary).toBe(`hosted ${PROJECT}/${DATASET} (read-only, GET)`)
    expect(base.warnings.join(' ')).toContain('SANITY_DATASET')
    expect(base.warnings.join(' ')).toContain('SANITY_BASE_DATASET')
  })

  /**
   * Two spellings of one setting that name DIFFERENT datasets is the same
   * ambiguity `explicitEnv.mjs` refuses, so it gets the same ruling. Picking a
   * precedence order here would decide, silently, which of two datasets the
   * developer's `.env` meant.
   */
  it('refuses when the two dataset spellings disagree', () => {
    expect(() =>
      createSiteBaseSource({
        SANITY_PROJECT_ID: PROJECT,
        SANITY_BASE_DATASET: DATASET,
        SANITY_DATASET: 'a-different-dataset',
      }),
    ).toThrow(/SANITY_BASE_DATASET[\s\S]*SANITY_DATASET|SANITY_DATASET[\s\S]*SANITY_BASE_DATASET/)
  })

  it('passes in silence when the two dataset spellings agree', () => {
    const base = createSiteBaseSource({
      SANITY_PROJECT_ID: PROJECT,
      SANITY_BASE_DATASET: DATASET,
      SANITY_DATASET: DATASET,
    })

    expect(base.summary).toBe(`hosted ${PROJECT}/${DATASET} (read-only, GET)`)
    expect(base.warnings).toEqual([])
  })

  /* ---------------------------------------------------------------- *
   * The token spelling — the same class, the other key
   * ---------------------------------------------------------------- */

  /**
   * `SANITY_API_READ_TOKEN` is what the repo's `.env` holds, so before this it
   * reached nothing here: a private dataset was configured, authenticated with
   * no credential, and failed with a 401 that named neither cause.
   *
   * The oracle is the outbound request, not a value the resolver returned.
   */
  it('sends the declared SANITY_API_READ_TOKEN on the wire', async () => {
    const {calls, fetchImpl} = recorder()
    const base = createSiteBaseSource(
      {
        SANITY_PROJECT_ID: PROJECT,
        SANITY_BASE_DATASET: DATASET,
        SANITY_API_READ_TOKEN: TOKEN,
      },
      {fetchImpl},
    )

    await base.source.fetchCandidates({kind: 'types', types: ['article']})

    expect(calls).toHaveLength(1)
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.url).toContain(`${PROJECT}.api.sanity.io`)
    expect(calls[0]!.url).toContain(`/data/query/${DATASET}`)
    expect(base.warnings).toEqual([])
  })

  it('still accepts the legacy SANITY_READ_TOKEN, and says it is legacy', async () => {
    const {calls, fetchImpl} = recorder()
    const base = createSiteBaseSource(
      {
        SANITY_PROJECT_ID: PROJECT,
        SANITY_BASE_DATASET: DATASET,
        SANITY_READ_TOKEN: TOKEN,
      },
      {fetchImpl},
    )

    await base.source.fetchCandidates({kind: 'types', types: ['article']})

    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(base.warnings.join(' ')).toContain('SANITY_API_READ_TOKEN')
  })

  it('refuses when the two token spellings disagree', () => {
    expect(() =>
      createSiteBaseSource({
        SANITY_PROJECT_ID: PROJECT,
        SANITY_BASE_DATASET: DATASET,
        SANITY_API_READ_TOKEN: TOKEN,
        SANITY_READ_TOKEN: 'skA-COMPLETELY-DIFFERENT-CREDENTIAL',
      }),
    ).toThrow(/SANITY_(API_)?READ_TOKEN/)
  })

  /**
   * A credential must never be echoed, not even into an error a developer is
   * about to paste into an issue. `explicitEnv.mjs` redacts by key NAME for the
   * same reason; this holds the example to it.
   */
  it('never prints a token value in the refusal', () => {
    /* The capture is deliberately NOT a try/catch around the assertions: a
     * `expect.unreachable()` inside the `try` would be caught by the very
     * `catch` that inspects the message, and its text contains no token, so the
     * case would pass against a function that never threw at all. Observed on
     * the first draft of this test. */
    let thrown: unknown
    try {
      createSiteBaseSource({
        SANITY_PROJECT_ID: PROJECT,
        SANITY_BASE_DATASET: DATASET,
        SANITY_API_READ_TOKEN: TOKEN,
        SANITY_READ_TOKEN: 'skA-COMPLETELY-DIFFERENT-CREDENTIAL',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'a disagreement between two token spellings must be refused').toBeInstanceOf(
      Error,
    )
    const message = String((thrown as Error).message)
    expect(message).not.toContain(TOKEN)
    expect(message).not.toContain('skA-COMPLETELY-DIFFERENT-CREDENTIAL')
  })

  /* ---------------------------------------------------------------- *
   * Half a configuration
   * ---------------------------------------------------------------- */

  /**
   * The failure the coordinator named. A declared `SANITY_PROJECT_ID` is an
   * unambiguous statement of intent to read a hosted dataset; falling back to
   * the fixture answers a question nobody asked, and answers it invisibly.
   *
   * Absence of BOTH is different and stays silent: nothing was declared, so the
   * committed snapshot is the honest answer and the documented default.
   */
  it('refuses a project id with no dataset rather than serving the fixture', () => {
    expect(() => createSiteBaseSource({SANITY_PROJECT_ID: PROJECT})).toThrow(
      /SANITY_BASE_DATASET/,
    )
  })

  it('refuses a dataset with no project id, under either spelling', () => {
    expect(() => createSiteBaseSource({SANITY_BASE_DATASET: DATASET})).toThrow(
      /SANITY_PROJECT_ID/,
    )
    expect(() => createSiteBaseSource({SANITY_DATASET: DATASET})).toThrow(/SANITY_PROJECT_ID/)
  })

  it('serves the committed fixture in silence when nothing is declared', () => {
    const base = createSiteBaseSource({})

    expect(base.summary).toMatch(/^file /)
    expect(base.warnings).toEqual([])
  })

  /* ---------------------------------------------------------------- *
   * End to end, through the launcher a developer actually runs
   * ---------------------------------------------------------------- */

  /**
   * The unit cases above pin the resolver. This one pins the CLAIM: a developer
   * who writes the repository's declared spellings into
   * `examples/local-site/.env` and runs `pnpm dev` gets the hosted base.
   */
  it('reads a declared .env end to end', async () => {
    const envFile = join(LOCAL_SITE, '.env')
    /* Never clobber a real one. If a developer has configured this example, the
     * test says so instead of deleting their file. */
    expect(existsSync(envFile), `${envFile} already exists; refusing to overwrite it`).toBe(false)

    try {
      writeFileSync(
        envFile,
        `SANITY_PROJECT_ID=${PROJECT}\nSANITY_BASE_DATASET=${DATASET}\nSANITY_API_READ_TOKEN=${TOKEN}\n`,
      )
      const ran = await run(['--experimental-strip-types', 'run.mjs', '--mode=off', '--port=0'], {
        cwd: LOCAL_SITE,
        env: cleanShell(),
        until: /\[site\] mode=/,
      })

      expect(ran.output).toContain(`base=hosted ${PROJECT}/${DATASET}`)
      expect(ran.output).not.toMatch(/base=file /)
      /* And the credential never reaches a terminal. */
      expect(ran.output).not.toContain(TOKEN)
    } finally {
      if (existsSync(envFile)) unlinkSync(envFile)
    }
  })
})
