/**
 * THE UPGRADE COMPATIBILITY BASELINE (PRD §37 Phase 4 acceptance, §5.5).
 *
 * ==========================================================================
 * WHY THIS IS A TEST AND NOT A DOCUMENT
 *
 * "Upgrade compatibility baseline recorded" is a phase-exit criterion, and the
 * obvious way to satisfy it is a markdown table of versions and caveats. A
 * document is the wrong artefact here, for one reason: the things this system
 * depends on are **observable behaviours of a shipped library**, not documented
 * API. Three examples, all found in one session:
 *
 *   - `unstable_clientFactory` is a `@hidden @beta` member of a `@hidden @beta`
 *     interface. It is the ONLY key that installs the write interception; a
 *     plugin cannot set it. Nothing obliges Sanity to keep it.
 *   - rxjs operators are `lift`-based, so `operate()` throws on anything that is
 *     not a genuine `Observable`. The facade therefore ADOPTS the constructor
 *     off a live observable instead of importing rxjs, and that adoption
 *     depends on `_requestObservable` being cold.
 *   - `SanityClient.config(newConfig)` mutates in place and returns `this` — the
 *     RAW client. It was not in `CLONING_METHODS` because nothing is
 *     constructed, so it handed an unwrapped client back through the facade.
 *
 * A markdown table saying "verified against sanity@6.8.0" goes stale silently.
 * A test that RE-DERIVES each fact from the installed package, and fails when
 * the installed version leaves the verified range, cannot.
 *
 * WHAT EACH CASE BELOW IS
 *   §1  the version floor — installed versions vs. the versions each fact was
 *       verified against, and the manifests that pin them;
 *   §2  the facts themselves, re-derived from the installed library;
 *   §3  the content-hashed dist chunk names our own source comments cite, which
 *       are the most brittle dependency of all: a patch bump rewrites the hash
 *       and the file simply vanishes;
 *   §4  the baseline's own completeness, so an entry cannot be added without a
 *       check or a check deleted without noticing.
 *
 * HOW TO ACT ON A FAILURE HERE: do not widen the range. Re-verify the fact
 * against the new version, at the `verifiedIn` location named in the entry, and
 * move the pin. The entry says what breaks if the fact is gone.
 * ==========================================================================
 */
import {execFileSync} from 'node:child_process'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {createClient} from '../../../examples/kitchen-sink/node_modules/@sanity/client'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const KITCHEN_SINK = join(REPO, 'examples/kitchen-sink/')
const requireFromExample = createRequire(join(KITCHEN_SINK, 'package.json'))

/* ------------------------------------------------------------------ *
 * The baseline, as data
 * ------------------------------------------------------------------ */

interface BaselineEntry {
  /** npm name, as installed. */
  package: string
  /** The exact version every fact below was verified against. */
  verified: string
  /** What is depended on that the package does not promise. */
  fact: string
  /** Where the fact is relied on, and where it was checked. */
  reliedOnIn: readonly string[]
  /** The test in this file that re-derives it. */
  check: string
  /** What stops working if the fact moves. */
  breaks: string
}

/**
 * Every library fact this system reads out of a shipped package rather than out
 * of its documentation.
 *
 * Ordered by blast radius: the first entry, if it disappears, ends the product.
 */
export const UPGRADE_BASELINE: readonly BaselineEntry[] = Object.freeze([
  {
    package: 'sanity',
    verified: '6.8.0',
    fact: '`unstable_clientFactory` exists on `SourceOptions` and is read by direct property access off the source config.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/config.ts (sets it)',
      'packages/sanity-overlay-studio/src/plugin.ts (documents why a plugin cannot)',
      'packages/sanity-overlay-testkit/test/studio-config.test.ts',
    ],
    check: 'the sanity type declarations still declare unstable_clientFactory on SourceOptions',
    breaks:
      'Everything. It is the only seam that hands the Studio our wrapped client, so without it ' +
      'every Studio write reaches the shared dataset and no read sees the branch. It is declared ' +
      '`@hidden @beta` on a `@hidden @beta` interface, so nothing obliges Sanity to keep it.',
  },
  {
    /*
     * A BASELINE ENTRY FOR A GAP, WHICH IS THE UNUSUAL CASE HERE.
     *
     * Every other entry names a behaviour this system DEPENDS ON and must be
     * told about when it moves. This one names a behaviour that DEFEATS it: the
     * timeline's transaction log is fetched with the global `fetch()`, so no
     * wrapper around a client method can see it, and `history.ts` therefore
     * states `EMPTY_TRANSLOG_NDJSON` as a contract for whatever serves
     * `apiHost` instead of enforcing it.
     *
     * It belongs in the baseline for exactly the reason the file's header
     * gives. "The translog is unreachable" is currently written in three source
     * comments, and a comment is the artefact that goes stale silently — the
     * day Sanity routes that read through `client.request`, the gap CLOSES, the
     * comments become false, and §32.2 history acquires a route nobody notices
     * is available. A red test is how that news arrives.
     */
    package: 'sanity',
    verified: '6.8.0',
    fact:
      'Both translog reads the document timeline actually makes — `TimelineController` (datastores:7097) ' +
      'and `getTransactionsLogs` (useBundleDocuments:4822) — go through `getJsonStream`, which calls the ' +
      'GLOBAL `fetch()`; the client contributes only `getUrl()` and `config().token`. The one translog ' +
      'read that IS on `client.request` (`getTransactions`, datastores:7157) is published on `HistoryStore` ' +
      'for plugins and has no caller anywhere in the bundle.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/client/history.ts (states EMPTY_TRANSLOG_NDJSON as a contract it cannot enforce)',
      'packages/sanity-overlay-studio/src/client/facade.ts (the read-class table, and why the history answer is EMPTY rather than served)',
      'packages/sanity-overlay-testkit/test/studio-history-endpoints.test.ts',
    ],
    check:
      'the timeline transaction log is still fetched with the global fetch, out of reach of a client wrapper',
    breaks:
      'Nothing breaks — it IMPROVES, silently, which is why it needs a test rather than a comment. ' +
      'A timeline read moving onto `client.request`, or a Studio call site appearing for the already-' +
      'wrappable `getTransactions`, makes the third of Sanity’s three history endpoints servable — and ' +
      '§32.2 branch history stops being blocked on a transport the facade cannot see. Until then the ' +
      'empty-and-announced timeline (`announceEmptyHistory`) is the honest answer, and delegating ' +
      '`getTransactions` is right because nothing asks.',
  },
  {
    package: '@sanity/client',
    verified: '7.26.0',
    fact: '`SanityClient.config(newConfig)` mutates in place and returns `this` — the same instance, not a clone.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/client/facade.ts (`wrapIfClient` guard)',
      'packages/sanity-overlay-testkit/test/preview-write-impossibility.test.ts',
    ],
    check: 'config(newConfig) still returns the same instance',
    breaks:
      'The facade escape it closes reopens. `config()` constructs nothing, so it did not look ' +
      'like a clone and fell through to the default branch, handing the caller the RAW client — ' +
      'one call away from an unintercepted write.',
  },
  {
    package: '@sanity/client',
    verified: '7.26.0',
    fact: 'A client observable is a genuine rxjs `Observable`, and `client.observable.fetch()` is COLD — building one issues no request.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/client/facade.ts (`probeObservableCtor` adopts the class)',
      'packages/sanity-overlay-testkit/test/studio-observable-contract.test.ts',
    ],
    check: 'the observable the installed client returns is a real rxjs Observable and pipes',
    breaks:
      'rxjs operators are `lift`-based — `operate()` throws "Unable to lift unknown Observable ' +
      'type" on a look-alike — so every `.pipe()` in Studio against a facade-returned observable ' +
      'fails. The facade adopts the constructor rather than importing rxjs precisely so there ' +
      'cannot be a second copy; if the probe stopped being cold it would also fire a real ' +
      'request on every wrap.',
  },
  {
    package: '@sanity/client',
    verified: '7.26.0',
    fact: '`fetch`, `getUrl`, `getDataUrl` and `withConfig` are prototype methods on both `SanityClient` and `ObservableSanityClient`; `listen` is an instance property and proves nothing.',
    reliedOnIn: ['packages/sanity-overlay-studio/src/client/facade.ts (`isSanityClientInstance`)'],
    check: 'the structural client detector still matches the installed client',
    breaks:
      'The prototype-based detector stops recognising a client, so a client returned from an ' +
      'unlisted method is handed back unwrapped.',
  },
  {
    package: '@sanity/client',
    verified: '7.26.0',
    fact: '`LiveClient` exposes exactly `events`, and it is the namespace that streams from the Content Lake.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/client/writeGuard.ts (`push` list)',
      'packages/sanity-overlay-studio/src/client/facade.ts (`refuseLivePush`)',
    ],
    check: 'client.live still exposes exactly the methods the push policy names',
    breaks:
      'A new streaming method would be classified a write by the fall-through — refused, but ' +
      'reported as a blocked mutation of the shared dataset, which is false and sends the next ' +
      'reader to the wrong place (PRD §23.3, §37 Phase 5).',
  },
  {
    package: 'groq-js',
    verified: '2.0.0',
    fact: '`parse` and `evaluate` keep the 2.x signature, and evaluation is the §22.6 oracle.',
    reliedOnIn: [
      'packages/sanity-overlay-query/src/evaluate.ts',
      'every studio read test that imports `groq-js` directly as an oracle',
    ],
    check: 'the pinned groq-js still parses and evaluates through the 2.x API',
    breaks:
      'Every Tier A parity assertion. PRD §5.5 requires 100% pass on audited Tier A GROQ parity ' +
      'and §37 Phase 5 requires the version be pinned; a minor bump can change evaluation ' +
      'semantics, and the tests would move WITH it rather than catch it.',
  },
  {
    package: 'react',
    verified: '19.2.8',
    fact: '`createElement`, `useState` and `useEffect` are the whole of the surface this package binds.',
    reliedOnIn: [
      'packages/sanity-overlay-studio/src/index.ts (the only module importing react)',
      'packages/sanity-overlay-studio/src/ui/statusLayout.ts (`ReactLike`)',
      'packages/sanity-overlay-studio/src/ui/conflictPanel.ts',
      'packages/sanity-overlay-studio/src/ui/documentActions.ts',
    ],
    check: 'react still exports the three hooks the injected ReactLike declares',
    breaks:
      'The status banner and the §28.3 conflict panel stop rendering. Narrow on purpose: the ' +
      'components take React as a parameter, so this is the entire dependency and a wider one ' +
      'would be a wider thing to break.',
  },
])

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function installedVersion(name: string): string {
  const manifest = requireFromExample.resolve(`${name}/package.json`)
  return (JSON.parse(readFileSync(manifest, 'utf8')) as {version: string}).version
}

function manifestAt(relative: string): {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(REPO, relative), 'utf8')) as never
}

function sanityLibDir(): string {
  return join(dirname(requireFromExample.resolve('sanity/package.json')), 'lib')
}

const CONFIG = {
  projectId: 'baseline',
  dataset: 'staging',
  apiVersion: '2025-02-19',
  useCdn: false,
} as const

/* ================================================================== *
 * §1 — the version floor
 * ================================================================== */

describe('§1 the installed versions are the versions the facts were verified against', () => {
  it.each([...new Set(UPGRADE_BASELINE.map((entry) => entry.package))])(
    '%s is installed at the verified version',
    (name) => {
      const verified = UPGRADE_BASELINE.find((entry) => entry.package === name)!.verified
      /* Not `satisfies a range` — the SAME version. Every fact in §2 was read ' +
       * out of this exact build. */
      expect(`${name}@${installedVersion(name)}`).toBe(`${name}@${verified}`)
    },
  )

  it('every baseline entry for one package names the same verified version', () => {
    const byPackage = new Map<string, Set<string>>()
    for (const entry of UPGRADE_BASELINE) {
      const seen = byPackage.get(entry.package) ?? new Set<string>()
      seen.add(entry.verified)
      byPackage.set(entry.package, seen)
    }
    for (const [name, versions] of byPackage) {
      expect(`${name}: ${[...versions].join(', ')}`).toBe(`${name}: ${[...versions][0]}`)
    }
  })

  it('the example app pins §5.5’s named packages exactly, with no range', () => {
    const example = manifestAt('examples/kitchen-sink/package.json')
    /* PRD §5.5: "Exact versions are pinned for `sanity`, `@sanity/client`, ...
     * `groq-js`". A leading `^` or `~` here is the pin not being a pin. */
    for (const [name, range] of Object.entries({
      ...example.dependencies,
      ...example.devDependencies,
    })) {
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+$/)
    }
    expect(example.dependencies?.sanity).toBe('6.8.0')
    expect(example.dependencies?.['@sanity/client']).toBe('7.26.0')
  })

  it('the studio package’s peer ranges do not admit an unverified version', () => {
    const studio = manifestAt('packages/sanity-overlay-studio/package.json')
    const peers = studio.peerDependencies ?? {}

    /*
     * THE POINT OF THIS CASE.
     *
     * `^6.8.0` and `^7.25.0` were the declared peers. They admit `sanity@6.9.x`
     * and `@sanity/client@7.99.x` — versions in which every fact in §2 is
     * unverified, and one of which (`@sanity/client@7.25.0`) is a version this
     * repository has never installed at all. A consumer install would succeed,
     * §2 would still be green because the WORKSPACE has 7.26.0, and the failure
     * would surface in their Studio as an unintercepted write.
     *
     * PRD §5.5 requires exact pins for exactly these two names. A peer range is
     * the manifest's only statement about what a consumer may install, so it is
     * where the pin has to be.
     */
    for (const name of ['sanity', '@sanity/client']) {
      const declared = peers[name]
      expect(`${name}: ${declared}`).toBe(
        `${name}: ${UPGRADE_BASELINE.find((entry) => entry.package === name)!.verified}`,
      )
    }

    /* React is deliberately NOT exact: the injected `ReactLike` surface is three
     * functions that have been stable since React 16, and pinning a patch of the
     * host's own React would be a false constraint. The range is still asserted,
     * so widening it is a decision rather than a drift. */
    expect(peers.react).toBe('^19.0.0')
    expect(installedVersion('react').startsWith('19.')).toBe(true)
  })

  it('groq-js is pinned exactly in every workspace package that declares it', () => {
    const packages = execFileSync('git', ['ls-files', 'packages/*/package.json'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '')

    /* The enumeration asserts its own denominator, so a broken glob cannot pass
     * by checking nothing. */
    expect(packages.length).toBeGreaterThanOrEqual(5)

    let declared = 0
    for (const relative of packages) {
      const manifest = manifestAt(relative)
      const range = manifest.dependencies?.['groq-js'] ?? manifest.devDependencies?.['groq-js']
      if (range === undefined) continue
      declared += 1
      expect(`${relative}: groq-js@${range}`).toBe(`${relative}: groq-js@2.0.0`)
    }
    expect(declared).toBeGreaterThanOrEqual(3)
  })
})

/* ================================================================== *
 * §2 — the facts, re-derived from the installed library
 * ================================================================== */

describe('§2 every depended-on behaviour still holds in the installed build', () => {
  it('the sanity type declarations still declare unstable_clientFactory on SourceOptions', () => {
    const lib = sanityLibDir()
    const declarations = execFileSync(
      'grep',
      ['-rl', 'unstable_clientFactory', lib],
      {encoding: 'utf8'},
    )
      .split('\n')
      .filter((line) => line.endsWith('.d.ts'))

    expect(declarations.length).toBeGreaterThan(0)

    /* Not merely "the string appears somewhere": it must be declared INSIDE
     * `interface SourceOptions`, because that is the object `config.ts` sets it
     * on. A move to `PluginOptions` or to a workspace-only type would leave the
     * grep green and the interception dead. */
    const source = readFileSync(declarations[0]!, 'utf8')
    const start = source.indexOf('interface SourceOptions extends PluginOptions {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('unstable_clientFactory')
    expect(body).toMatch(/unstable_clientFactory\?:\s*\(options: ClientConfig\) => SanityClient/)
  })

  it('the timeline transaction log is still fetched with the global fetch, out of reach of a client wrapper', () => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * MEASURED, AND THE MEASUREMENT CORRECTED THE CLAIM IT WAS WRITTEN FOR.
     *
     * This check began as "the translog is fetched with the global `fetch()`,
     * full stop" — the sentence three source comments carry and that §32.2
     * branch history is recorded as blocked by. Enumerating the WHOLE bundle
     * rather than the two known line numbers turned up a THIRD translog read
     * the flat version of the claim is false about:
     *
     *   datastores-DqFH7RLd.js:7097   TimelineController      global `fetch`
     *   useBundleDocuments…:4822      getTransactionsLogs     global `fetch`
     *   datastores-DqFH7RLd.js:7157   getTransactions         `client.request`  ← wrappable
     *
     * So the honest claim has two halves, and both are asserted below.
     *
     *   1. THE TWO READS THE TIMELINE ACTUALLY MAKES are on `getJsonStream`,
     *      which calls the global `fetch` with no client on the response path.
     *      The client contributes `getUrl()` and `config().token` — both
     *      wrappable — so a facade can REDIRECT these reads and can never
     *      ANSWER them. That asymmetry is the whole reason
     *      `EMPTY_TRANSLOG_NDJSON` is stated in `history.ts` as a contract for
     *      whatever serves `apiHost` instead of being enforced there.
     *
     *   2. THE ONE READ THAT IS WRAPPABLE HAS NO CALLER. `getTransactions` is
     *      published on `HistoryStore` (`index-C1EcC1UN.d.ts:6686`) for
     *      plugins, and nothing inside `sanity@6.8.0` invokes it — there is no
     *      `.getTransactions(` anywhere in the bundle. Intercepting it would
     *      therefore serve a caller that does not exist, and would move the
     *      timeline not at all.
     *
     * WHAT MAKES THIS WORTH A TEST RATHER THAN A PARAGRAPH: either half can
     * change silently in an upgrade, and both changes are good news that nobody
     * would otherwise go looking for. A timeline read moving onto
     * `client.request`, or a Studio call site appearing for `getTransactions`,
     * unblocks §32.2 — and arrives here as a red line naming the file.
     * ─────────────────────────────────────────────────────────────────────────
     */
    const lib = sanityLibDir()
    const chunks = readdirSync(lib).filter((name) => name.endsWith('.js'))
    /* The denominator, asserted: a lib directory that failed to list would make
     * every "no call site does X" below vacuously true. */
    expect(chunks.length).toBeGreaterThan(50)

    const translogLines: {file: string; line: number; text: string}[] = []
    const propertyCalls: string[] = []
    let jsonStreamBody: string | undefined
    let wrappableBody: string | undefined
    for (const name of chunks) {
      const source = readFileSync(join(lib, name), 'utf8')
      source.split('\n').forEach((text, index) => {
        if (/\/data\/history\/\$\{[^}]*\}\/transactions\//.test(text)) {
          translogLines.push({file: name, line: index + 1, text})
        }
        /* The consumer probe for half 2. A property call is the only way to
         * reach `historyStore.getTransactions`; the bare identifier appears in
         * this bundle as a local in `index.js:4618` and as a prefix of
         * `getTransactionsLogs`, and neither is this function. */
        if (/\.getTransactions\(/.test(text)) propertyCalls.push(`${name}:${index + 1}`)
      })
      const start = source.indexOf('async function getJsonStream(url, token) {')
      if (start !== -1) jsonStreamBody = source.slice(start, source.indexOf('\n}', start))
      const wrappableStart = source.indexOf('getTransactions = async (client, documentIds) => {')
      if (wrappableStart !== -1) {
        wrappableBody = source.slice(wrappableStart, source.indexOf('\n}', wrappableStart))
      }
    }

    /* ---- half 1: the reader the timeline uses ---------------------------- */

    expect(jsonStreamBody, '`getJsonStream` is gone — re-verify the whole entry').toBeDefined()
    expect(jsonStreamBody).toMatch(/return getStream\(await fetch\(url, options\)\)/)
    expect(jsonStreamBody).not.toContain('.request(')
    /* No client reaches the response path at all — not even to produce it. */
    expect(jsonStreamBody).not.toContain('client')

    /* Every translog URL in the bundle, enumerated. A fourth one appearing is
     * itself the news, whichever transport it is on. */
    const byLocation = new Map(translogLines.map((entry) => [`${entry.file}:${entry.line}`, entry]))
    expect([...byLocation.keys()].sort()).toEqual([
      'datastores-DqFH7RLd.js:7097',
      'datastores-DqFH7RLd.js:7157',
      'useBundleDocuments-BYW8M9LS.js:4822',
    ])

    for (const where of ['datastores-DqFH7RLd.js:7097', 'useBundleDocuments-BYW8M9LS.js:4822']) {
      const text = byLocation.get(where)!.text
      expect(`${where} reads via getJsonStream: ${text.includes('getJsonStream(')}`).toBe(
        `${where} reads via getJsonStream: true`,
      )
      /* THE LINE THAT WOULD FLIP. A timeline translog read on `client.request`
       * — or `client.fetch`, or the observable spelling — is one this facade
       * COULD answer. Deliberately not `.not.toContain('client')`:
       * `client.getUrl` and `client.config` are both on these lines, and
       * neither produces a response. */
      expect(`${where} issues a client request: ${/\.(request|fetch)\(/.test(text)}`).toBe(
        `${where} issues a client request: false`,
      )
      /* …and the wrappable half, stated rather than implied: the URL really is
       * built off the client, so interception can redirect but not satisfy. */
      expect(`${where} builds its URL off the client: ${text.includes('.getUrl(')}`).toBe(
        `${where} builds its URL off the client: true`,
      )
    }

    /* ---- half 2: the wrappable read, and its absent caller --------------- */

    /* The whole function, not the URL line: minified output puts the URL on
     * `:7157` and the request that carries it on `:7158`. */
    expect(wrappableBody, '`getTransactions` is gone — re-verify half 2').toBeDefined()
    expect(wrappableBody).toContain('/data/history/${dataset}/transactions/')
    expect(wrappableBody).toContain('client.request(')
    expect(wrappableBody).not.toContain('getJsonStream(')

    /* Nothing calls it. When something does, this is the line that says so —
     * and `facade.ts`'s read-class table stops being right to delegate it. */
    expect(propertyCalls).toEqual([])
  })

  it('config(newConfig) still returns the same instance', () => {
    const client = createClient({...CONFIG})

    /* An independent oracle: identity, checked with `Object.is`, not a claim
     * read off the type declaration. */
    expect(client.config({apiVersion: '2025-06-01'})).toBe(client)
    /* ...and with NO argument it must keep being a plain config object, which is
     * what stops the facade's guard capturing it. */
    const read = client.config()
    expect(read).not.toBe(client)
    expect(read.apiVersion).toBe('2025-06-01')
  })

  it('the observable the installed client returns is a real rxjs Observable and pipes', async () => {
    /* Resolved through @sanity/client's REAL path so pnpm's isolated layout
     * hands back the same rxjs copy the client itself imports — a second copy
     * would fail `instanceof` and this would prove nothing. */
    const rx = createRequire(
      requireFromExample.resolve('@sanity/client/package.json'),
    )('rxjs') as {Observable: new (...args: never[]) => unknown; map?: unknown}

    const client = createClient({...CONFIG})
    const observable = client.observable.fetch('*[false][0]')

    expect(observable).toBeInstanceOf(rx.Observable)
    expect(Object.getPrototypeOf(observable).constructor).toBe(rx.Observable)
    /* `lift`: the operator machinery the facade must not break. */
    expect(typeof (observable as {pipe?: unknown}).pipe).toBe('function')
  })

  it('client.observable.fetch is cold — constructing one issues no request', () => {
    /* The facade builds and drops an observable purely to steal its constructor.
     * If `_requestObservable` ever became hot, every `wrapWithOverlay` would
     * fire a real network call. The suite-wide outbound monitor
     * (`vitest.setup.ts`) would catch a write; this catches a read too. */
    const calls: unknown[] = []
    const client = createClient({
      ...CONFIG,
      /* @ts-expect-error -- `fetch` is an accepted ClientConfig escape hatch. */
      fetch: (...args: unknown[]) => {
        calls.push(args)
        return Promise.reject(new Error('the probe must never reach here'))
      },
    })

    client.observable.fetch('*[false][0]')

    expect(calls).toEqual([])
  })

  it('the structural client detector still matches the installed client', () => {
    const client = createClient({...CONFIG})
    const required = ['fetch', 'getUrl', 'getDataUrl', 'withConfig']

    for (const holder of [client, client.observable]) {
      const prototype = Object.getPrototypeOf(holder) as Record<string, unknown>
      for (const method of required) {
        expect(`${method}: ${typeof prototype[method]}`).toBe(`${method}: function`)
      }
    }

    /* `listen` is an INSTANCE property, deliberately excluded from the detector.
     * If it ever became a prototype method the exclusion would be pointless but
     * harmless; if a required one became an instance property the detector would
     * silently stop matching, which is why the assertion is directional. */
    expect(Object.getPrototypeOf(client)).not.toHaveProperty('listen')
  })

  it('client.live still exposes exactly the methods the push policy names', async () => {
    const {CLIENT_NAMESPACE_POLICY} = await import(
      '../../sanity-overlay-studio/src/client/writeGuard'
    )
    const client = createClient({...CONFIG})
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(client.live) as object,
    ).filter((name) => name !== 'constructor')

    const policy = CLIENT_NAMESPACE_POLICY.live!
    const declared = [...policy.read, ...policy.write, ...(policy.push ?? [])]

    expect(methods.sort()).toEqual([...declared].sort())
    expect(policy.push).toEqual(['events'])
  })

  it('the pinned groq-js still parses and evaluates through the 2.x API', async () => {
    const {parse, evaluate} = await import('groq-js')

    const tree = parse('*[_type == $type].title')
    const result = await (
      await evaluate(tree, {
        dataset: [
          {_id: 'a', _type: 'article', title: 'Alpha'},
          {_id: 'b', _type: 'other', title: 'Beta'},
        ],
        params: {type: 'article'},
      })
    ).get()

    expect(result).toEqual(['Alpha'])
  })

  it('react still exports the three hooks the injected ReactLike declares', () => {
    /* Resolved from the example app, like every other library oracle here:
     * `react` is a PEER of `sanity-overlay-studio` and is deliberately not a
     * dependency of the test package, so the only honest copy to check is the
     * one a Studio would actually load. */
    const react = createRequire(join(KITCHEN_SINK, 'package.json'))('react') as Record<
      string,
      unknown
    >
    for (const name of ['createElement', 'useState', 'useEffect']) {
      expect(`${name}: ${typeof react[name]}`).toBe(`${name}: function`)
    }
  })
})

/* ================================================================== *
 * §3 — the content-hashed dist chunks our own source cites
 * ================================================================== */

/**
 * Every `sanity` dist chunk named in a comment in shipped source.
 *
 * These are the most brittle dependency in the system and the least visible: a
 * patch bump rewrites the content hash, the file vanishes, and the comment that
 * justified a guard now points at nothing. Several tests already READ these
 * files at runtime (`preview-write-impossibility`, `origin-findability`,
 * `studio-perspective-reads`) and would fail on a bump — this case names the
 * whole set in one place so the failure is one legible message rather than four
 * scattered ones.
 */
const CITED_SANITY_CHUNKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'WorkspaceLoader-BRx2afZV.js': [
    'packages/sanity-overlay-client/src/browserWriteBarrier.ts',
    'packages/sanity-overlay-client/src/previewCsp.ts',
    'packages/sanity-overlay-client/src/previewWriteGuard.ts',
    'packages/sanity-overlay-studio/src/features.ts',
  ],
  'datastores-DqFH7RLd.js': [
    'packages/sanity-overlay-client/src/previewWriteGuard.ts',
    'packages/sanity-overlay-studio/src/client/perspective.ts',
    'packages/sanity-overlay-studio/src/client/reads.ts',
  ],
  'LiveQueries-rJao7vYj.js': ['packages/sanity-overlay-studio/src/client/facade.ts'],
  /* The two places sanity 6.8.0 subscribes to `client.live.events()`, cited by
   * `refuseLivePush` to justify why the refusal is an erroring Observable rather
   * than a rejected Promise (PRD §23.3). */
  'PresentationToolGrantsCheck-CITNu5DG.js': [
    'packages/sanity-overlay-studio/src/client/facade.ts',
  ],
  'PaneContainer-Bp8RN3ON.js': [
    'packages/sanity-overlay-studio/src/client/perspective.ts',
    'packages/sanity-overlay-studio/src/client/reads.ts',
  ],
  'structureTool-EN0gOzyJ.js': ['packages/sanity-overlay-studio/src/documentActions.ts'],
  /*
   * The form-builder chunk: `resolveUploader`, `uploadSanityAsset`,
   * `fetchExisting`, `DatasetAssetSourceUploader`. Cited by the three modules
   * that had to know what an image field ACTUALLY calls before an upload can
   * send a byte — the dedup probe at `:13450` gates all of them, and answering
   * it from base was the live "Uploading forever" defect (2026-08-09).
   */
  'useBundleDocuments-BYW8M9LS.js': [
    'packages/sanity-overlay-studio/src/client/assetDedup.ts',
    'packages/sanity-overlay-studio/src/client/facade.ts',
    'packages/sanity-overlay-studio/src/client/reads.ts',
  ],
  /*
   * The document-action hook runtime: `defineHookStateComponent` at `:26` and
   * the `handleNext(id, hookState)` collector at `:31` that DROPS a `null`
   * return. `sanityConfigResolution.ts` reproduces that reducer, so it has to
   * cite the lines it reproduces.
   *
   * ADDED BY THE CHECK BELOW RATHER THAN BY HAND. `sanityConfigResolution.ts`
   * arrived in f797062 citing this chunk twice while the table said nothing
   * about it, so `finds no cited chunk the baseline forgot to list` was red at
   * HEAD — which is exactly the job that test was written to do.
   */
  'useStudioUrl-90xCJc-c.js': ['packages/sanity-overlay-testkit/src/sanityConfigResolution.ts'],
})

describe('§3 the dist chunks our source cites still exist in the installed sanity', () => {
  it.each(Object.keys(CITED_SANITY_CHUNKS))('%s is still shipped', (chunk) => {
    expect(existsSync(join(sanityLibDir(), chunk))).toBe(true)
  })

  it('every citation names a file that exists and really cites it', () => {
    for (const [chunk, citers] of Object.entries(CITED_SANITY_CHUNKS)) {
      for (const relative of citers) {
        const path = join(REPO, relative)
        expect(`${relative} exists: ${existsSync(path)}`).toBe(`${relative} exists: true`)
        expect(`${relative} cites ${chunk}: ${readFileSync(path, 'utf8').includes(chunk)}`).toBe(
          `${relative} cites ${chunk}: true`,
        )
      }
    }
  })

  it('finds no cited chunk the baseline forgot to list', () => {
    /* The oracle is the SOURCE, not this table: a new hashed filename added to a
     * comment tomorrow makes this red rather than quietly joining the set of
     * things nobody checks. */
    /* `git ls-files packages` then filtered here, rather than a pathspec glob.
     * A glob of the form "packages, star, src, double-star, dot-ts" silently
     * matched a SUBSET — git's star does not cross a slash — so the scan
     * under-reported, which is the one thing a completeness check must never do.
     * The denominator is asserted below for the same reason. */
    const tracked = execFileSync('git', ['ls-files', 'packages'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => /^packages\/[^/]+\/src\/.*\.ts$/.test(line))
    expect(tracked.length).toBeGreaterThan(40)

    const pattern = /[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]{8}\.js/g
    const found = new Set<string>()
    for (const relative of tracked) {
      const source = readFileSync(join(REPO, relative), 'utf8')
      for (const match of source.matchAll(pattern)) found.add(match[0])
    }

    expect([...found].sort()).toEqual(Object.keys(CITED_SANITY_CHUNKS).sort())
  })
})

/* ================================================================== *
 * §4 — the baseline's own completeness
 * ================================================================== */

describe('§4 the baseline cannot rot quietly', () => {
  it('every entry names a check that really exists in this file', () => {
    /* An entry whose `check` names no test is a fact nobody verifies — the
     * document-shaped failure this whole file exists to avoid. The oracle is
     * this file's own source. */
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const missing = UPGRADE_BASELINE.filter((entry) => !own.includes(`it('${entry.check}'`))
    expect(missing.map((entry) => entry.check)).toEqual([])
  })

  it('every entry says where it is relied on, and every path exists', () => {
    expect(UPGRADE_BASELINE.length).toBeGreaterThanOrEqual(7)
    for (const entry of UPGRADE_BASELINE) {
      expect(entry.reliedOnIn.length).toBeGreaterThan(0)
      for (const location of entry.reliedOnIn) {
        /* Entries may carry a parenthetical note; the path is the first token. */
        const path = location.split(' ')[0]!
        if (!path.startsWith('packages/')) continue
        expect(`${path}: ${existsSync(join(REPO, path))}`).toBe(`${path}: true`)
      }
    }
  })

  it('every entry says what breaks, in enough words to act on', () => {
    for (const entry of UPGRADE_BASELINE) {
      /* A one-word "breaks: reads" is not a baseline; the next person has to be
       * able to decide whether to block the upgrade. */
      expect(`${entry.package}/${entry.check}: ${entry.breaks.length > 80}`).toBe(
        `${entry.package}/${entry.check}: true`,
      )
      expect(entry.fact.length).toBeGreaterThan(30)
    }
  })
})
