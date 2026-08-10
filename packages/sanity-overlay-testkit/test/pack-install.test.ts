/**
 * THE INSTALL ORACLE.
 *
 * Every other test in this repository loads these packages the way this
 * repository loads them: by relative path, through a workspace that hoists
 * every dependency to a place Node happens to find, with a `.ts` resolve hook
 * already registered by the launcher. None of that exists on a consumer's
 * machine, and so none of it can answer the only question that matters here —
 * *if someone runs `pnpm add sanity-overlay-studio` in their own Sanity
 * project, does it work?*
 *
 * `test/repo-manifests.test.ts` gets closer: it reads source TEXT and reasons
 * about whether a specifier could resolve after an install. That is a static
 * argument, and a good one, but it is still an argument. This file is the
 * measurement:
 *
 *   1. `pnpm pack` every publishable package — which runs each package's
 *      `prepack`, so what is packed is what a registry would serve, built the
 *      way a release would build it;
 *   2. install each tarball into ITS OWN scratch project under the OS temp
 *      directory, outside this repository and outside its `node_modules`, with
 *      `npm` rather than `pnpm` so no workspace linking can rescue a bad
 *      manifest;
 *   3. `import()` the result in a fresh Node process and call into it.
 *
 * ONE PROJECT PER PACKAGE, AND WHY IT IS NOT PARANOIA.
 *
 * The first version of this file installed all seven tarballs into a single
 * scratch project. It passed. It also passed with `sanity-overlay-core` DELETED
 * from `sanity-overlay-studio`'s dependencies — because six other tarballs
 * listed core, npm hoisted it to the root of `node_modules`, and the studio
 * found it there. That is the same hoisting rescue that hid the original
 * `@sanity/client` defect, reproduced inside the test written to catch it.
 *
 * So each package is installed alone. Its siblings arrive only because it
 * DECLARED them: `overrides` redirects each `sanity-overlay-*` requirement to
 * the matching tarball, and `overrides` can only redirect a requirement that
 * something in the tree actually makes. An undeclared sibling is therefore not
 * installed at all, and the import fails — which is verified, not assumed: the
 * mutation above now goes red with `ERR_MODULE_NOT_FOUND`.
 *
 * WHAT IS AND IS NOT SUBSTITUTED.
 *
 * `@sanity/client`, `react` and `sanity` are stubbed, in the studio project
 * only, and that is deliberate rather than convenient. They are the consumer's
 * to supply; the pins are exact and read FROM the studio manifest below, so a
 * stub cannot drift from what the package demands. What is emphatically NOT
 * substituted is anything of ours: every `sanity-overlay-*` package is the real
 * tarball, resolved by package name through `node_modules` exactly as a
 * consumer would resolve it.
 *
 * The CLI project gets no stubs at all, on purpose. `sanity-overlay-cli`
 * depends on `sanity-overlay-studio` for two pure modules, reached through the
 * `options` and `features` subpaths precisely so the Studio's React and client
 * peers stay out of a command-line tool's runtime path. Running `--help` with
 * none of the three installed is what proves that.
 *
 * WHY IT IS SLOW, AND WHY THAT IS ACCEPTABLE.
 *
 * Seven `pnpm pack`s and seven `npm install`s: tens of seconds. It is the only
 * test in the suite that can fail for the reason this packaging effort exists,
 * so it earns its runtime. It must never be made conditional or `skip`ped when
 * the environment looks unhelpful: a skipped install oracle is indistinguishable
 * from a passing one, and that is precisely the failure this repository has hit
 * five times.
 */

import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {beforeAll, describe, expect, it} from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The packages a consumer can install. `sanity-overlay-testkit` is absent on
 * purpose: it is this repository's test harness, it is never published, and
 * including it would make the oracle assert something no consumer ever does.
 */
const PUBLISHABLE = [
  'sanity-overlay-core',
  'sanity-overlay-query',
  'sanity-overlay-store-fs',
  'sanity-overlay-client',
  'sanity-overlay-studio',
  'sanity-overlay-next',
  'sanity-overlay-cli',
] as const

type Publishable = (typeof PUBLISHABLE)[number]

const readManifest = (pkg: string): Record<string, any> =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'))

/** Strip a range operator: `^19.0.0` is satisfiable by a stub at `19.0.0`. */
const concreteVersion = (range: string): string => range.replace(/^[\^~>=<\s]+/, '')

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  } catch (error) {
    const err = error as {stdout?: string; stderr?: string; message: string}
    throw new Error(
      `${command} ${args.join(' ')}\n(cwd ${cwd})\n--- stdout\n${err.stdout ?? ''}\n` +
        `--- stderr\n${err.stderr ?? ''}\n${err.message}`,
    )
  }
}

let scratch = ''
const tarballs: Record<string, string> = {}
const projects: Record<string, string> = {}
let peerStubs: Record<string, string> = {}

/** Where `pkg` was installed on its own, as a consumer's project root. */
const projectOf = (pkg: Publishable): string => projects[pkg]
const installedRoot = (pkg: Publishable): string => join(projectOf(pkg), 'node_modules', pkg)

function probe(pkg: Publishable, name: string, body: string[]): unknown {
  const file = join(projectOf(pkg), `${name}.mjs`)
  writeFileSync(file, `${body.join('\n')}\n`)
  return JSON.parse(run('node', [`${name}.mjs`], projectOf(pkg)).trim())
}

describe('the packages install and import outside this repository', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'overlay-install-'))
    const tarballDir = join(scratch, 'tarballs')
    mkdirSync(tarballDir)

    /* ── 1. pack (runs each package's prepack) ───────────────────────────── */
    for (const pkg of PUBLISHABLE) {
      run('pnpm', ['pack', '--pack-destination', tarballDir], join(REPO_ROOT, 'packages', pkg))
      const tarball = join(tarballDir, `${pkg}-${readManifest(pkg).version}.tgz`)
      if (!existsSync(tarball)) throw new Error(`pnpm pack produced no ${tarball}`)
      tarballs[pkg] = `file:${tarball}`
    }

    /* ── 2. stub the peers, at the versions the studio actually pins ─────── */
    const peers: Record<string, string> = readManifest('sanity-overlay-studio').peerDependencies
    peerStubs = {}
    for (const [name, range] of Object.entries(peers)) {
      const dir = join(scratch, 'peers', name.replace('/', '__'))
      mkdirSync(dir, {recursive: true})
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({name, version: concreteVersion(range), type: 'module', main: 'index.js'}),
      )
      /* `createClient` is the only peer binding the studio entry point calls at
       * module scope; the rest is React, which is never rendered here. */
      writeFileSync(
        join(dir, 'index.js'),
        [
          'export const createClient = () => ({stubbed: true})',
          'export const createElement = () => null',
          'export const useEffect = () => {}',
          'export const useMemo = (f) => f()',
          'export const useState = (v) => [v, () => {}]',
          'export const useSyncExternalStore = (_s, get) => get()',
          'export default {createElement, createClient}',
        ].join('\n'),
      )
      peerStubs[name] = `file:${dir}`
    }

    /* ── 3. one scratch consumer project per package ─────────────────────── */
    for (const pkg of PUBLISHABLE) {
      const project = join(scratch, `consumer-${pkg}`)
      mkdirSync(project)
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify(
          {
            name: `consumer-of-${pkg}`,
            private: true,
            version: '1.0.0',
            type: 'module',
            /* ONLY this package. A sibling reaches the tree only by being
             * declared — see the header on why that is the whole point. */
            dependencies: {
              [pkg]: tarballs[pkg],
              ...(pkg === 'sanity-overlay-studio' ? peerStubs : {}),
            },
            /* Redirects each `sanity-overlay-*` REQUIREMENT to its tarball.
             * Without this npm would ask the public registry for
             * `sanity-overlay-core@0.0.0`, and a green run would then mean
             * "npm found something with that name". `overrides` cannot
             * introduce a package nothing asked for, so it does not weaken the
             * one-project-per-package isolation. */
            overrides: tarballs,
          },
          null,
          2,
        ),
      )
      run(
        'npm',
        [
          'install',
          /*
           * NESTED, NOT HOISTED — the second half of the isolation.
           *
           * npm's default flat layout lifts every transitive dependency to the
           * root of `node_modules`, where anything can resolve it. Under that
           * layout `sanity-overlay-studio` still imported `sanity-overlay-core`
           * with the dependency deleted from its manifest, because
           * `sanity-overlay-client` declared core and npm hoisted it into
           * view. Real consumers on pnpm's isolated store get no such rescue,
           * so neither does this test: `--install-strategy=nested` puts each
           * dependency under its own dependent and nowhere else, and a package
           * can then reach exactly what it declared.
           */
          '--install-strategy=nested',
          '--no-audit',
          '--no-fund',
          '--legacy-peer-deps',
          '--ignore-scripts',
        ],
        project,
      )
      projects[pkg] = project
    }
  }, 900_000)

  it.each(PUBLISHABLE.map((p) => [p] as const))(
    '%s: installs by name, and can reach exactly what it declared',
    (pkg) => {
      expect(existsSync(installedRoot(pkg)), `${pkg} is not in node_modules`).toBe(true)

      /*
       * Under the nested layout a package's OWN `node_modules` is the entirety
       * of what it can resolve, so the two directions are both checkable:
       * every declared sibling is there (or the import would fail), and nothing
       * undeclared is (or a missing declaration could hide behind it).
       */
      const declared = Object.keys(readManifest(pkg).dependencies ?? {})
        .filter((name) => (PUBLISHABLE as readonly string[]).includes(name))
        .sort()
      const reachable = PUBLISHABLE.filter((other) =>
        existsSync(join(installedRoot(pkg), 'node_modules', other)),
      ).sort()
      expect(reachable).toEqual(declared)
    },
  )

  it('resolves and executes the studio entry point', () => {
    expect(
      probe('sanity-overlay-studio', 'probe-studio', [
        "import {defineOverlayConfig, overlay, OVERLAY_PLUGIN_NAME} from 'sanity-overlay-studio'",
        "import {classifyTokenEnvKey} from 'sanity-overlay-studio/options'",
        "import {HOSTED_FEATURES} from 'sanity-overlay-studio/features'",
        'const plugin = overlay({})',
        'const wrapped = defineOverlayConfig({name: "default", projectId: "p", dataset: "staging"})',
        'console.log(JSON.stringify({',
        '  defineOverlayConfig: typeof defineOverlayConfig,',
        '  plugin: plugin.name,',
        '  constant: OVERLAY_PLUGIN_NAME,',
        '  dataset: wrapped.dataset,',
        '  pluginInstalled: (wrapped.plugins ?? []).some((p) => p.name === OVERLAY_PLUGIN_NAME),',
        '  subpaths: [typeof classifyTokenEnvKey, Array.isArray(HOSTED_FEATURES)],',
        '}))',
      ]),
    ).toEqual({
      defineOverlayConfig: 'function',
      plugin: 'sanity-overlay-studio',
      constant: 'sanity-overlay-studio',
      dataset: 'staging',
      pluginInstalled: true,
      subpaths: ['function', true],
    })
  })

  it('resolves the packages a rendered page needs, each on its own', () => {
    expect(
      probe('sanity-overlay-client', 'probe-client', [
        "import {createOverlayClient} from 'sanity-overlay-client'",
        "import {isStagingWrite} from 'sanity-overlay-client/stagingHost'",
        'console.log(JSON.stringify([typeof createOverlayClient, typeof isStagingWrite]))',
      ]),
    ).toEqual(['function', 'function'])

    expect(
      probe('sanity-overlay-next', 'probe-next', [
        "import * as next from 'sanity-overlay-next'",
        'console.log(JSON.stringify(Object.keys(next).length > 0))',
      ]),
    ).toBe(true)

    expect(
      probe('sanity-overlay-store-fs', 'probe-store', [
        "import {FsOverlayStore, OVERLAY_DIR} from 'sanity-overlay-store-fs'",
        'console.log(JSON.stringify([typeof FsOverlayStore, OVERLAY_DIR]))',
      ]),
    ).toEqual(['function', '.sanity-overlay'])

    expect(
      probe('sanity-overlay-query', 'probe-query', [
        "import {createQueryRegistry} from 'sanity-overlay-query'",
        "import {planCandidateRequests} from 'sanity-overlay-query/planner'",
        'console.log(JSON.stringify([typeof createQueryRegistry, typeof planCandidateRequests]))',
      ]),
    ).toEqual(['function', 'function'])

    expect(
      probe('sanity-overlay-core', 'probe-core', [
        "import {toPublishedId} from 'sanity-overlay-core'",
        "import {sha256Hex} from 'sanity-overlay-core/checksum'",
        'console.log(JSON.stringify([toPublishedId("drafts.a"), typeof sha256Hex]))',
      ]),
    ).toEqual(['a', 'function'])
  })

  it('exposes a CLI binary that runs without the Studio peers installed', () => {
    /* No react, no sanity, no @sanity/client anywhere in this project — see
     * the header. `--legacy-peer-deps` is what keeps npm from installing them
     * on the studio's behalf, so this is a real absence, not a layout trick. */
    const cliProject = projectOf('sanity-overlay-cli')
    for (const peer of Object.keys(peerStubs)) {
      const found = run('node', ['-e', `console.log(require('node:fs').existsSync('node_modules/${peer}'))`], cliProject)
      expect(found.trim(), `${peer} leaked into the CLI project`).toBe('false')
    }
    const bin = join(projectOf('sanity-overlay-cli'), 'node_modules', '.bin', 'sanity-overlay')
    expect(run(bin, ['--help'], projectOf('sanity-overlay-cli'))).toContain('sanity-overlay')
  })

  it('ships type declarations for every published entry point', () => {
    for (const pkg of PUBLISHABLE) {
      const manifest = JSON.parse(readFileSync(join(installedRoot(pkg), 'package.json'), 'utf8'))
      const entries = Object.entries(manifest.exports ?? {})
      expect(entries.length, `${pkg}: publishes nothing`).toBeGreaterThan(0)
      for (const [subpath, entry] of entries) {
        const target = entry as {types?: string; import?: string}
        expect(target.types, `${pkg} exports["${subpath}"] has no types`).toBeTruthy()
        for (const file of [target.types!, target.import!]) {
          expect(existsSync(join(installedRoot(pkg), file)), `${pkg}: ${file} not packed`).toBe(true)
        }
      }
    }
  })

  it('ships JavaScript, not the TypeScript sources', () => {
    /*
     * The failure this whole file was written against. Before the build existed
     * every `exports` pointed at `./src/index.ts`, the tarball carried the
     * TypeScript, and the first `import` on a consumer's machine died with
     * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — Node will not strip types
     * for anything under `node_modules`, whatever flags it is given.
     *
     * Asserted on the INSTALLED tree rather than the manifest, because a
     * `files` entry npm silently ignored would leave the manifest looking right.
     */
    for (const pkg of PUBLISHABLE) {
      expect(existsSync(join(installedRoot(pkg), 'dist')), `${pkg}: no dist/`).toBe(true)
      expect(existsSync(join(installedRoot(pkg), 'src')), `${pkg}: shipped its sources`).toBe(false)
    }
  })

  it('declares its siblings as real dependencies, not workspace protocol leftovers', () => {
    for (const pkg of PUBLISHABLE) {
      const manifest = JSON.parse(readFileSync(join(installedRoot(pkg), 'package.json'), 'utf8'))
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        expect(String(range), `${pkg} -> ${name}`).not.toContain('workspace:')
      }
      /* pnpm removes `publishConfig` once it has applied it; a leftover would
       * mean the swap never happened and `exports` still points at `src/`. */
      expect(manifest.publishConfig, `${pkg}: publishConfig survived the pack`).toBeUndefined()
    }
  })

  it('keeps the studio peer pins exactly as declared', () => {
    const manifest = JSON.parse(
      readFileSync(join(installedRoot('sanity-overlay-studio'), 'package.json'), 'utf8'),
    )
    expect(manifest.peerDependencies).toEqual({
      '@sanity/client': '7.26.0',
      react: '^19.0.0',
      sanity: '6.8.0',
    })
  })
})
