/**
 * `sanity-overlay-studio` — configuration resolution (PRD §11.1, §11.2, §11.3).
 *
 * The package's whole reason to exist is that today the overlay is switched on by
 * hand-editing `sanity.config.ts` and typing three `localStorage` flags into
 * devtools. Every one of those flags becomes a resolved option here, and this
 * file is where the *precedence* between plugin options, `SANITY_STUDIO_*` env
 * and bare `OVERLAY_*` env is pinned.
 *
 * WHY `SANITY_STUDIO_*` MATTERS. A Studio is a Vite bundle: only variables
 * prefixed `SANITY_STUDIO_` are exposed to browser code. `OVERLAY_MODE` from
 * PRD §11.2 is a *server* variable and simply does not exist in the browser, so
 * a resolver that only read §11.2's spellings would silently resolve to its
 * defaults in the one runtime that matters. Both are accepted; the browser-
 * visible spelling wins.
 *
 * THE DEFAULT IS THE SAFETY DECISION. `mode` defaults to `fs`, not `off`.
 * Defaulting to `off` would mean "installed the overlay, still editing staging" —
 * a silent, destructive no-op. Installing the plugin *is* the opt-in; turning it
 * off has to be typed.
 */
import {describe, expect, it} from 'vitest'
import {
  OVERLAY_MODES,
  resolveOverlayOptions,
  type OverlayStudioOptions,
} from '../../sanity-overlay-studio/src/options'

const EMPTY: Record<string, string | undefined> = {}

function resolve(
  options: OverlayStudioOptions = {},
  env: Record<string, string | undefined> = EMPTY,
): ReturnType<typeof resolveOverlayOptions> {
  return resolveOverlayOptions(options, env)
}

describe('resolveOverlayOptions — defaults', () => {
  it('defaults to fs mode so installing the plugin cannot silently keep writing to staging', () => {
    const resolved = resolve()
    expect(resolved.mode).toBe('fs')
    expect(resolved.enabled).toBe(true)
  })

  it('says out loud that the mode was defaulted rather than configured', () => {
    expect(resolve().warnings.join(' ')).toMatch(/OVERLAY_MODE/)
    expect(resolve({mode: 'fs'}).warnings.join(' ')).not.toMatch(/OVERLAY_MODE/)
  })

  it('defaults the overlay API URL to the local overlay server', () => {
    expect(resolve().apiUrl).toBe('http://localhost:3998')
  })

  it('injects no apiHost unless a proxy is configured', () => {
    expect(resolve().apiHost).toBeNull()
  })

  it('exports the §11.1 mode union as data', () => {
    expect([...OVERLAY_MODES]).toEqual(['off', 'fs', 'blob', 'memory'])
  })
})

describe('resolveOverlayOptions — precedence', () => {
  it('prefers an explicit plugin option over both env spellings', () => {
    const resolved = resolve(
      {mode: 'memory'},
      {SANITY_STUDIO_OVERLAY_MODE: 'fs', OVERLAY_MODE: 'off'},
    )
    expect(resolved.mode).toBe('memory')
  })

  it('prefers the browser-visible SANITY_STUDIO_ spelling over the server spelling', () => {
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_MODE: 'memory', OVERLAY_MODE: 'off'}).mode).toBe(
      'memory',
    )
  })

  it('falls back to the PRD §11.2 server spelling when that is all there is', () => {
    expect(resolve({}, {OVERLAY_MODE: 'off'}).mode).toBe('off')
  })

  it('applies the same precedence to the overlay API URL', () => {
    expect(
      resolve(
        {},
        {
          SANITY_STUDIO_OVERLAY_API_URL: 'http://localhost:4100',
          OVERLAY_API_URL: 'http://localhost:4200',
        },
      ).apiUrl,
    ).toBe('http://localhost:4100')
    expect(resolve({apiUrl: 'http://localhost:4300'}, {OVERLAY_API_URL: 'http://x:1'}).apiUrl).toBe(
      'http://localhost:4300',
    )
  })
})

describe('resolveOverlayOptions — blank is unset, not a value', () => {
  /**
   * Transcribed from the spike's own scar (`instrumentedClient.ts:157-174`): a
   * blank `SPIKE_API_HOST` read as "hybrid configured" at the decision site and
   * as falsy at the injection site, so Studio ran with no proxy AND no facade.
   * Whitespace was worse: `'   '` was injected as the API host verbatim.
   */
  it.each([
    ['empty string', ''],
    ['spaces', '   '],
    ['tab', '\t'],
  ])('treats %s as unset for the mode', (_label, value) => {
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_MODE: value, OVERLAY_MODE: 'memory'}).mode).toBe(
      'memory',
    )
  })

  it('treats a blank apiHost as no proxy at all', () => {
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_API_HOST: '   '}).apiHost).toBeNull()
  })

  it('trims a configured apiHost rather than injecting the whitespace', () => {
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_API_HOST: ' http://localhost:3999 '}).apiHost).toBe(
      'http://localhost:3999',
    )
  })
})

describe('resolveOverlayOptions — rejects nonsense loudly (PRD §11.3)', () => {
  it('throws on an unknown mode instead of falling back to a default', () => {
    expect(() => resolve({}, {SANITY_STUDIO_OVERLAY_MODE: 'fs-ish'})).toThrow(/fs-ish/)
    expect(() => resolve({}, {SANITY_STUDIO_OVERLAY_MODE: 'fs-ish'})).toThrow(
      /off, fs, blob, memory/,
    )
  })

  it('throws on a relative overlay API URL', () => {
    expect(() => resolve({apiUrl: '/api/sanity-overlay'})).toThrow(/absolute/i)
  })

  it('throws on a non-http overlay API URL', () => {
    expect(() => resolve({apiUrl: 'ws://localhost:3998'})).toThrow(/http/i)
  })

  it('throws when blob mode is asked for, because no blob store exists yet', () => {
    expect(() => resolve({mode: 'blob'})).toThrow(/blob/i)
  })

  it('refuses to run alongside a write-capable token in the Studio bundle', () => {
    expect(() => resolve({}, {SANITY_STUDIO_WRITE_TOKEN: 'sk-live'})).toThrow(/token/i)
    expect(() => resolve({}, {SANITY_STUDIO_SANITY_API_WRITE_TOKEN: 'sk-live'})).toThrow(/token/i)
  })

  it('allows a write token when the overlay is explicitly off', () => {
    expect(() => resolve({mode: 'off'}, {SANITY_STUDIO_WRITE_TOKEN: 'sk-live'})).not.toThrow()
  })

  it('warns when the proxy apiHost carries a path, which @sanity/client cannot use', () => {
    expect(resolve({apiHost: 'http://localhost:3999/proxy'}).warnings.join(' ')).toMatch(/path/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE TOKEN CHECK, AND THE FAIL-OPEN IT USED TO BE.
 *
 * `WRITE_TOKEN_PATTERN = /WRITE_TOKEN$/` tested a NAMING CONVENTION, not a
 * capability, and it tested the wrong half of the convention. Measured:
 *
 *     CAUGHT   SANITY_WRITE_TOKEN, SANITY_STUDIO_WRITE_TOKEN,
 *              SANITY_API_WRITE_TOKEN
 *     MISSED   SANITY_API_TOKEN, SANITY_TOKEN, SANITY_DEPLOY_TOKEN
 *
 * `SANITY_API_TOKEN` is the name **Sanity's own documentation uses most**, so
 * the single most likely way a write-capable credential arrives in a preview
 * environment was the one spelling the check could not see.
 *
 * WHY IT IS STILL NAME-BASED. Capability cannot be established from a name; it
 * can only be established by asking Sanity, which is a network call at startup.
 * A capability probe that fails open when the network is down is worse than no
 * probe — it would report "no write token" for the exact reason it could not
 * tell. So the check stays name-based and FAILS CLOSED: a Sanity-scoped
 * credential whose name does not positively say "read-only" is treated as
 * write-capable and refused. The cost is a false positive on an oddly-named read
 * token, which is one rename away from fixed and fails loudly at startup.
 *
 * THE CLASS is "a Sanity credential in an overlay-mode environment", enumerated
 * below along all three axes that matter: the credential noun (TOKEN / SECRET /
 * API_KEY), the Sanity scoping (which is what keeps `GITHUB_TOKEN` out), and the
 * read-only escape hatch.
 */
describe('resolveOverlayOptions — the write-token check (PRD §11.3)', () => {
  const WRITE_CAPABLE_OR_UNKNOWN: ReadonlyArray<readonly [label: string, key: string]> = [
    ['the three the old pattern already caught', 'SANITY_WRITE_TOKEN'],
    ['browser-bundle spelling', 'SANITY_STUDIO_WRITE_TOKEN'],
    ['api write token', 'SANITY_API_WRITE_TOKEN'],
    ["Sanity's own documented name — MISSED before", 'SANITY_API_TOKEN'],
    ['the shortest spelling — MISSED before', 'SANITY_TOKEN'],
    ['deploy token — MISSED before', 'SANITY_DEPLOY_TOKEN'],
    ['auth token', 'SANITY_AUTH_TOKEN'],
    ['editor token', 'SANITY_EDITOR_TOKEN'],
    ['browser-bundle api token', 'SANITY_STUDIO_API_TOKEN'],
    ['doubled prefix, as CI templates emit', 'SANITY_STUDIO_SANITY_API_TOKEN'],
    ['a Next.js public spelling — worst case, it ships to the browser', 'NEXT_PUBLIC_SANITY_API_TOKEN'],
    ['secret noun', 'SANITY_SECRET'],
    ['api key noun', 'SANITY_API_KEY'],
    ['api key, no separator', 'SANITY_APIKEY'],
    ['bare write token, no Sanity scoping', 'WRITE_TOKEN'],
    ['lower-cased key', 'sanity_api_token'],
  ]

  it.each(WRITE_CAPABLE_OR_UNKNOWN)('refuses %s (%s)', (_label, key) => {
    expect(() => resolve({mode: 'fs'}, {[key]: 'skLIVE'})).toThrow(/token|credential/i)
  })

  it('names the offending variable, so the failure is one edit away from fixed', () => {
    expect(() => resolve({mode: 'fs'}, {SANITY_API_TOKEN: 'skLIVE'})).toThrow(/SANITY_API_TOKEN/)
  })

  const NOT_A_SANITY_CREDENTIAL: ReadonlyArray<readonly [label: string, key: string]> = [
    ['another vendor entirely', 'GITHUB_TOKEN'],
    ['npm', 'NPM_TOKEN'],
    ['the deployment platform', 'VERCEL_TOKEN'],
    ['a vendor whose name contains a vendor', 'HOMEBREW_GITHUB_API_TOKEN'],
    ['a Sanity setting that is not a credential', 'SANITY_PROJECT_ID'],
    ['another one', 'SANITY_DATASET'],
    ['an overlay setting', 'SANITY_STUDIO_OVERLAY_ID'],
    ['api version is not an api key', 'SANITY_API_VERSION'],
    ['a substring lookalike — SANITY is a label, not a substring', 'INSANITY_TOKEN'],
    ['the same on the other side', 'SANITYX_TOKEN'],
  ]

  it.each(NOT_A_SANITY_CREDENTIAL)('does not refuse %s (%s)', (_label, key) => {
    expect(() => resolve({mode: 'fs'}, {[key]: 'value'})).not.toThrow()
  })

  const READ_ONLY: ReadonlyArray<readonly [label: string, key: string]> = [
    ['read token', 'SANITY_READ_TOKEN'],
    ['api read token', 'SANITY_API_READ_TOKEN'],
    ['readonly, one word', 'SANITY_READONLY_TOKEN'],
    ['viewer', 'SANITY_VIEWER_TOKEN'],
  ]

  it.each(READ_ONLY)('allows %s (%s) — a read token is the recommended architecture', (_l, key) => {
    expect(() => resolve({mode: 'fs'}, {[key]: 'skREAD'})).not.toThrow()
  })

  it('but still warns when a read token is compiled into the BROWSER bundle', () => {
    /* It cannot write, so it is not a §11.3 refusal — but `SANITY_STUDIO_*` is
     * inlined into JavaScript that ships to every visitor, so it is a credential
     * leak and must not pass in silence. */
    const resolved = resolve({mode: 'fs'}, {SANITY_STUDIO_READ_TOKEN: 'skREAD'})
    expect(resolved.warnings.join(' ')).toMatch(/SANITY_STUDIO_READ_TOKEN/)
  })

  it('does not warn about a server-side read token', () => {
    expect(resolve({mode: 'fs'}, {SANITY_READ_TOKEN: 'skREAD'}).warnings.join(' ')).not.toMatch(
      /SANITY_READ_TOKEN/,
    )
  })

  it('does not mistake a word merely containing "read" for a read-only token', () => {
    /* `READ` is matched as a name LABEL. A guard that used `includes('READ')`
     * would let `SANITY_ALREADY_TOKEN` — and, more to the point, anything an
     * attacker or a careless template names — through as read-only. */
    expect(() => resolve({mode: 'fs'}, {SANITY_ALREADY_TOKEN: 'skLIVE'})).toThrow(/token|credential/i)
    expect(() => resolve({mode: 'fs'}, {SANITY_BREADCRUMB_TOKEN: 'skLIVE'})).toThrow(
      /token|credential/i,
    )
  })

  it('treats a blank value as absent, at every spelling', () => {
    for (const value of ['', '   ', '\t']) {
      expect(() => resolve({mode: 'fs'}, {SANITY_API_TOKEN: value})).not.toThrow()
    }
  })

  it('checks the whole environment, not the first match', () => {
    expect(() =>
      resolve({mode: 'fs'}, {SANITY_PROJECT_ID: 'p', SANITY_DATASET: 'd', SANITY_TOKEN: 'skLIVE'}),
    ).toThrow(/SANITY_TOKEN/)
  })

  it('is inert in off mode, where native Sanity is the point', () => {
    for (const [, key] of WRITE_CAPABLE_OR_UNKNOWN) {
      expect(() => resolve({mode: 'off'}, {[key]: 'skLIVE'})).not.toThrow()
    }
  })
})

describe('resolveOverlayOptions — off mode', () => {
  it('reports disabled and leaves hosted features alone', () => {
    const resolved = resolve({mode: 'off'})
    expect(resolved.enabled).toBe(false)
    expect(resolved.disableHostedFeatures).toBe(false)
  })

  it('disables hosted features in every overlay mode', () => {
    for (const mode of ['fs', 'memory'] as const) {
      expect(resolve({mode}).disableHostedFeatures).toBe(true)
    }
  })

  it('lets hosted-feature disabling be opted out of independently', () => {
    expect(resolve({mode: 'fs', hostedFeatures: 'leave'}).disableHostedFeatures).toBe(false)
  })
})

describe('resolveOverlayOptions — identity (§12.1)', () => {
  it('carries an explicit overlay id through', () => {
    expect(resolve({overlayId: 'repo:branch'}).overlayId).toBe('repo:branch')
  })

  it('derives an overlay id from the Vercel git identity when one is not given', () => {
    expect(
      resolve({}, {SANITY_STUDIO_VERCEL_GIT_COMMIT_REF: 'feature/new-hero'}).overlayId,
    ).toContain('feature/new-hero')
  })

  it('prefers a pull-request identity over a branch identity (§12.1 stability)', () => {
    const resolved = resolve(
      {},
      {
        SANITY_STUDIO_VERCEL_GIT_PULL_REQUEST_ID: '184',
        SANITY_STUDIO_VERCEL_GIT_COMMIT_REF: 'feature/new-hero',
      },
    )
    expect(resolved.overlayId).toContain('184')
    expect(resolved.overlayId).not.toContain('new-hero')
  })

  it('reports no overlay id rather than inventing an unstable one', () => {
    expect(resolve().overlayId).toBeNull()
  })
})

describe('resolveOverlayOptions — strict queries', () => {
  /*
   * Changed 2026-08-05 from strict-by-default. Measured against the shipped
   * `sanity` package: with a non-empty branch, strict threw
   * `OverlayReadRefusedError` for the structure tool's document list, asset
   * upload dedup, and every file/image input preview — so the first branch edit
   * broke the Studio. PRD §22.5 makes warn mode the `[SHOULD]` anyway, and warn
   * mode is not the silent approximation §5.5 forbids: every refusal is still
   * recorded and logged once per distinct shape.
   */
  it('defaults to warn mode, because strict breaks the Studio on the first branch edit', () => {
    expect(resolve().strictQueries).toBe(false)
  })

  it('can be made strict explicitly — the right setting for a preview frontend', () => {
    expect(resolve({strictQueries: true}).strictQueries).toBe(true)
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_STRICT_QUERIES: '1'}).strictQueries).toBe(true)
  })

  it('still honours an explicit relaxation', () => {
    expect(resolve({strictQueries: false}).strictQueries).toBe(false)
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_STRICT_QUERIES: '0'}).strictQueries).toBe(false)
  })
})
