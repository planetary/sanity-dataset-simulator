/**
 * A REFUSAL THIS SYSTEM ISSUED IS NOT A FAILURE OF THE USER'S SANITY SESSION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT, observed live on 2026-08-06.
 *
 * Studio booted against the Track B proxy (`PROXY_BLOCK_WRITES=1`) and rendered
 *
 *     "Your Sanity session is no longer authenticated.
 *      Editing is read-only until the token refreshes."
 *
 * The session was fine. The proxy log for that session held exactly two 4xx
 * responses and both were **our own write guard doing its job**:
 *
 *     403 POST /v2025-02-19/descriptors/claim     (uploadSchema)
 *     403 POST /v2023-12-18/intake/batch          (telemetry ingest)
 *
 * `echo.ts` observed a 403 and ended the session, because `AUTH_STATUSES` was
 * `{401, 403}` and nothing else was consulted. A refusal *this system produced*
 * was read as *Sanity revoking the editor's credential*, and the editor was told
 * they were logged out and read-only while holding a perfectly good token.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLASS, which is what this file is actually for.
 *
 * The proxy's 403 is one member. Every way a refusal ORIGINATING IN THIS SYSTEM
 * can reach the session observer is a member, and each is pinned below:
 *
 *   §2.1  the Track B proxy's write guard          `OVERLAY_WRITE_BLOCKED` 403
 *   §2.2  origin mode's 403 for the same endpoints `OVERLAY_WRITE_BLOCKED` 403
 *         and origin mode's own error vocabulary   `OVERLAY_ORIGIN_*`
 *   §2.3  the runtime staging-host refusal         `StagingWriteRefusedError`
 *   §2.4  the facade's own write refusals,         `refuseUnechoable`, including
 *         including the four version-write methods `createVersion` and siblings
 *   §2.5  strict-mode read refusal                 `OverlayReadRefusedError`
 *   §2.6  the facade's unacknowledged-write error, which carries a 401/403 of
 *         its own and must not be re-observed as fresh evidence
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE OTHER HALF, which the fix must not break (§3).
 *
 * A genuine 401 from Sanity, and a genuine 403 from Sanity meaning *your token
 * lacks this grant*, MUST still end the session. So the discriminator cannot be
 * the status code: it is the ORIGIN. This system stamps its own refusals — with
 * a marker on the errors it constructs, and with an `OVERLAY_*` error code on
 * the JSON its guards answer with — and only those are exempted.
 *
 * THE ORACLE IS NOT HAND-ROLLED. The 4xx bodies are the literal bodies the
 * guards send (`examples/kitchen-sink/spikeB-proxy/proxy.mjs:481-489` and
 * `:742-751`; `origin.mjs:1205-1355`), and they are turned into errors by the
 * REAL `@sanity/client@7.26.0` `ClientError`, so the shape under test is the
 * shape Studio actually receives rather than one this file invented.
 */
import {describe, expect, it} from 'vitest'
import {ClientError} from '../../../examples/kitchen-sink/node_modules/@sanity/client'

import {
  authStatusOf,
  createOverlayEcho,
  isOverlayRefusal,
  markOverlayRefusal,
  type OverlayEcho,
} from '../../sanity-overlay-studio/src/client/echo'
import {wrapWithOverlay} from '../../sanity-overlay-studio/src/client/facade'
import {createStudioReader} from '../../sanity-overlay-studio/src/client/reads'
import {overlaySourceFromBranch} from '../../sanity-overlay-studio/src/client/readSource'
import type {OverlayTransport} from '../../sanity-overlay-studio/src/client/transport'
import {deriveOverlayStatus} from '../../sanity-overlay-studio/src/status'
import {assertNoStagingWrite} from '../../sanity-overlay-client/src/stagingHost'

type Rec = Record<string, unknown>

/* ─────────────────────────────────────────────────────────── the bodies */

/**
 * `proxy.mjs:481-489` — the body the Track B write guard answers a blocked
 * write with, verbatim. `descriptors/claim` is `uploadSchema()`; the live
 * session's other refusal, `POST /v2023-12-18/intake/batch`, differs only in
 * `path`.
 */
const PROXY_WRITE_BLOCKED_BODY = {
  error: {
    code: 'OVERLAY_WRITE_BLOCKED',
    description: 'Writes to Content Lake are blocked by the overlay proxy (PRD §36.1 Track B).',
    method: 'POST',
    path: '/v2025-02-19/descriptors/claim',
  },
}

const PROXY_TELEMETRY_BLOCKED_BODY = {
  error: {
    ...PROXY_WRITE_BLOCKED_BODY.error,
    path: '/v2023-12-18/intake/batch',
  },
}

/** `origin.mjs:1226` — Mode 2 refusing a project it does not serve. */
const ORIGIN_UNKNOWN_PROJECT_BODY = {
  error: {
    code: 'OVERLAY_ORIGIN_UNKNOWN_PROJECT',
    description: 'This origin serves a single project.',
  },
}

/** A REAL Sanity 401: the token expired. Nothing overlay-shaped about it. */
const SANITY_UNAUTHORIZED_BODY = {
  error: {
    type: 'credentialsError',
    description: 'Session expired. Please log in again.',
  },
}

/**
 * A REAL Sanity 403: the session is valid, the grant is not. This is the shape
 * the fix must NOT sweep up with the guard's own 403 — it is the editor's token
 * genuinely lacking a permission, and the banner is right about it.
 */
const SANITY_FORBIDDEN_BODY = {
  error: {
    type: 'insufficientPermissionsError',
    description: 'Insufficient permissions; permission "update" required',
  },
}

/** Build the error `@sanity/client` itself would throw for this response. */
function clientError(statusCode: number, body: unknown): Error {
  return new ClientError({
    statusCode,
    headers: {},
    body,
    url: 'https://b1n03q3z.api.sanity.io/v2025-02-19/descriptors/claim',
    method: 'POST',
  } as never) as unknown as Error
}

/* ─────────────────────────────────────────────────────────────── the rig */

function inertTransport(): OverlayTransport {
  return {
    apiUrl: 'http://localhost:3998',
    commit: async () => ({outcome: 'ok'}),
    operation: async () => ({outcome: 'ok'}),
    resolve: async () => ({outcome: 'ok'}),
    query: async () => ({outcome: 'ok'}),
    state: async () => ({outcome: 'ok'}),
  }
}

interface Rig {
  echo: OverlayEcho
  wrapped: Rec
  errors: string[]
}

/**
 * A wrapped client whose underlying "real" client fails every read with
 * `failure`. Own-property methods on purpose: the facade must never *call* a
 * double it has not proven to be a real `@sanity/client`.
 */
function rig(options: {failure?: unknown; strict?: boolean; branch?: boolean} = {}): Rig {
  const errors: string[] = []
  const echo = createOverlayEcho({onError: (message) => errors.push(message)})
  const reject = (): Promise<never> => Promise.reject(options.failure)
  const client: Rec = {
    fetch: reject,
    getDocument: reject,
    getDocuments: reject,
    request: reject,
    listen: () => ({
      subscribe: (observer: Rec) => {
        ;(observer.error as ((error: unknown) => void) | undefined)?.(options.failure)
        return {unsubscribe: (): void => {}}
      },
    }),
    assets: {upload: reject},
    createVersion: reject,
    replaceVersion: reject,
    discardVersion: reject,
    unpublishVersion: reject,
  }

  const overlay = overlaySourceFromBranch(
    options.branch === false
      ? []
      : [
          {
            logicalId: 'article-01',
            schemaType: 'article',
            draft: {_id: 'drafts.article-01', _type: 'article', title: 'branch'},
          },
        ],
  )

  const wrapped = wrapWithOverlay(client, {
    echo,
    transport: inertTransport(),
    onError: (message) => errors.push(message),
    ...(options.strict === true
      ? {
          reads: createStudioReader({
            overlay: () => overlay,
            strict: () => true,
            onLog: (message) => errors.push(message),
          }),
        }
      : {}),
  }) as unknown as Rec

  return {echo, wrapped, errors}
}

/** Read through the facade and swallow whatever it rejects with. */
async function readAndIgnore(rigged: Rig): Promise<void> {
  await (rigged.wrapped.fetch as (query: string) => Promise<unknown>)(
    '*[_type == "article"]',
  ).catch(() => undefined)
}

/** The sentence the editor actually saw. */
function bannerHeadline(echo: OverlayEcho): string {
  return deriveOverlayStatus({
    enabled: true,
    mode: 'fs',
    apiUrl: 'http://localhost:3998',
    overlayId: null,
    connection: 'ok',
    session: echo.sessionState(),
    pendingWrites: 0,
    degradedWrites: 0,
    uncheckpointedEdits: 0,
    conflicts: {hard: 0, soft: 0},
  }).headline
}

const READ_ONLY_BANNER =
  'Your Sanity session is no longer authenticated. Editing is read-only until the token refreshes.'

/* ══════════════════════════════════════════════════════════════════ §1 */

describe('§1 the reported defect, at the surface the editor sees', () => {
  it('does not tell the editor they are logged out when our own proxy refused a write', async () => {
    const rigged = rig({failure: clientError(403, PROXY_WRITE_BLOCKED_BODY)})
    await readAndIgnore(rigged)

    expect(rigged.echo.sessionState()).toBe('active')
    expect(bannerHeadline(rigged.echo)).not.toBe(READ_ONLY_BANNER)
  })

  it('keeps acknowledging writes after our own guard refused one', async () => {
    const rigged = rig({failure: clientError(403, PROXY_TELEMETRY_BLOCKED_BODY)})
    await readAndIgnore(rigged)

    /* The consequence that matters: an unauthenticated session refuses to
     * acknowledge, so the editor's next keystroke is reported unsaved. */
    expect(rigged.echo.acknowledgeWrite()).toEqual({ok: true})
  })

  it('records nothing in the auth-failure log for a refusal we issued', async () => {
    const rigged = rig({failure: clientError(403, PROXY_WRITE_BLOCKED_BODY)})
    await readAndIgnore(rigged)
    expect(rigged.echo.authFailures()).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════ §2 */

describe('§2 the whole class — every refusal this system can issue', () => {
  it('§2.1 the Track B proxy write guard (both live endpoints)', () => {
    for (const body of [PROXY_WRITE_BLOCKED_BODY, PROXY_TELEMETRY_BLOCKED_BODY]) {
      const error = clientError(403, body)
      expect(isOverlayRefusal(error)).toBe(true)
      expect(authStatusOf(error)).toBeUndefined()
    }
  })

  it('§2.2 origin mode, for the same blocked endpoints and its own vocabulary', () => {
    /* Mode 2 keeps the proxy in front of it, so a blocked write is refused with
     * the same body; the origin's own refusals speak `OVERLAY_ORIGIN_*`. */
    for (const body of [PROXY_WRITE_BLOCKED_BODY, ORIGIN_UNKNOWN_PROJECT_BODY]) {
      expect(authStatusOf(clientError(403, body))).toBeUndefined()
      expect(authStatusOf(clientError(401, body))).toBeUndefined()
    }
  })

  it('§2.3 the runtime staging-host refusal', () => {
    let refusal: unknown
    try {
      assertNoStagingWrite(
        {method: 'POST', url: 'https://b1n03q3z.api.sanity.io/v2025-02-19/data/mutate/parity'},
        'facade',
      )
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    expect(isOverlayRefusal(refusal)).toBe(true)
    expect(authStatusOf(refusal)).toBeUndefined()
  })

  it('§2.4 the facade’s own write refusals, asset plane included', async () => {
    const rigged = rig()
    const upload = (rigged.wrapped.assets as Rec).upload as (...args: unknown[]) => Promise<unknown>
    const refusal = await upload('image', new Uint8Array()).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(Error)
    expect(isOverlayRefusal(refusal)).toBe(true)
    expect(authStatusOf(refusal)).toBeUndefined()
  })

  it('§2.4b the four version-write methods refuse without ending the session', async () => {
    for (const method of [
      'createVersion',
      'replaceVersion',
      'discardVersion',
      'unpublishVersion',
    ]) {
      const rigged = rig()
      const call = rigged.wrapped[method] as (...args: unknown[]) => Promise<unknown>
      const refusal = await call({}).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(refusal, method).toBeInstanceOf(Error)
      expect(isOverlayRefusal(refusal), method).toBe(true)
      expect(authStatusOf(refusal), method).toBeUndefined()

      /* And observing it the way a read error is observed changes nothing. */
      rigged.echo.noteAuthFailure
      expect(rigged.echo.sessionState(), method).toBe('active')
    }
  })

  it('§2.5 a strict-mode read refusal', async () => {
    const rigged = rig({strict: true, failure: new Error('never reached')})
    const refusal = await (rigged.wrapped.fetch as (q: string) => Promise<unknown>)('count(*)').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((refusal as Error).name).toBe('OverlayReadRefusedError')
    expect(isOverlayRefusal(refusal)).toBe(true)
    expect(authStatusOf(refusal)).toBeUndefined()
    /* The observable half: the facade routes this error through the same
     * `noteAuthFailureFrom` a delegated read error takes. */
    expect(rigged.echo.sessionState()).toBe('active')
  })

  it('§2.6 the unacknowledged-write error is not re-observed as fresh evidence', () => {
    const echo = createOverlayEcho()
    echo.noteAuthFailure({status: 401, source: 'read', message: 'token expired'})
    const ack = echo.acknowledgeWrite()
    expect(ack.ok).toBe(false)

    /* `facade.ts` turns this into an `Error` carrying `statusCode`. It describes
     * a session that is ALREADY dead; treating it as a new observation would let
     * a refused write re-arm the state a token refresh had just cleared. */
    const error = markOverlayRefusal(
      Object.assign(new Error(`refusing to acknowledge: ${ack.error?.message}`), {
        statusCode: ack.error?.status,
      }),
    )
    expect(authStatusOf(error)).toBeUndefined()
  })

  it('every member reaches the observer without ending the session', async () => {
    const failures = [
      clientError(403, PROXY_WRITE_BLOCKED_BODY),
      clientError(403, PROXY_TELEMETRY_BLOCKED_BODY),
      clientError(403, ORIGIN_UNKNOWN_PROJECT_BODY),
      clientError(401, ORIGIN_UNKNOWN_PROJECT_BODY),
    ]
    for (const failure of failures) {
      const rigged = rig({failure})
      await readAndIgnore(rigged)
      await (rigged.wrapped.getDocument as (id: string) => Promise<unknown>)('article-01').catch(
        () => undefined,
      )
      ;(rigged.wrapped.listen as (q: string) => {subscribe: (o: Rec) => unknown})(
        '*[_type == "article"]',
      ).subscribe({error: () => {}})
      expect(rigged.echo.sessionState(), String((failure as Error).message)).toBe('active')
    }
  })
})

/* ══════════════════════════════════════════════════════════════════ §3 */

describe('§3 a real Sanity auth failure still ends the session', () => {
  it('a genuine 401 does', async () => {
    const rigged = rig({failure: clientError(401, SANITY_UNAUTHORIZED_BODY)})
    await readAndIgnore(rigged)
    expect(rigged.echo.sessionState()).toBe('unauthenticated')
    expect(bannerHeadline(rigged.echo)).toBe(READ_ONLY_BANNER)
  })

  it('a genuine 403 meaning "your token lacks this grant" does', async () => {
    const rigged = rig({failure: clientError(403, SANITY_FORBIDDEN_BODY)})
    await readAndIgnore(rigged)
    expect(rigged.echo.sessionState()).toBe('unauthenticated')
    expect(rigged.echo.authFailures()).toEqual([
      expect.objectContaining({status: 403, source: 'read'}),
    ])
  })

  it('a bare 401 with no body at all does — the shape a proxy hop can produce', async () => {
    const rigged = rig({failure: clientError(401, '')})
    await readAndIgnore(rigged)
    expect(rigged.echo.sessionState()).toBe('unauthenticated')
  })

  it('keeps the pre-existing narrowness: 500, network failure and "401" in prose do not', async () => {
    for (const failure of [
      clientError(500, {error: {description: 'Internal server error'}}),
      new TypeError('fetch failed'),
      new Error('request 401 could not be parsed'),
    ]) {
      const rigged = rig({failure})
      await readAndIgnore(rigged)
      expect(rigged.echo.sessionState(), String((failure as Error).message)).toBe('active')
    }
  })

  it('does not exempt an error merely because the word OVERLAY appears in its message', () => {
    /* The discriminator is a STRUCTURED code, never prose — the same standard
     * `authStatusOf` already holds for not matching the digits "401" inside an
     * unrelated message. */
    const error = clientError(401, {
      error: {description: 'OVERLAY_WRITE_BLOCKED is not why this failed; your token expired'},
    })
    expect(isOverlayRefusal(error)).toBe(false)
    expect(authStatusOf(error)).toBe(401)
  })
})
