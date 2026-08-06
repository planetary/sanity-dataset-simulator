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
    expect(() => resolve({}, {SANITY_STUDIO_WRITE_TOKEN: 'sk-live'})).toThrow(/write token/i)
    expect(() => resolve({}, {SANITY_STUDIO_SANITY_API_WRITE_TOKEN: 'sk-live'})).toThrow(
      /write token/i,
    )
  })

  it('allows a write token when the overlay is explicitly off', () => {
    expect(() => resolve({mode: 'off'}, {SANITY_STUDIO_WRITE_TOKEN: 'sk-live'})).not.toThrow()
  })

  it('warns when the proxy apiHost carries a path, which @sanity/client cannot use', () => {
    expect(resolve({apiHost: 'http://localhost:3999/proxy'}).warnings.join(' ')).toMatch(/path/i)
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
  it('defaults to strict, so an unsupported GROQ read fails instead of silently hitting staging', () => {
    expect(resolve().strictQueries).toBe(true)
  })

  it('can be relaxed explicitly', () => {
    expect(resolve({strictQueries: false}).strictQueries).toBe(false)
    expect(resolve({}, {SANITY_STUDIO_OVERLAY_STRICT_QUERIES: '0'}).strictQueries).toBe(false)
  })
})
