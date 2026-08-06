/**
 * `sanity-overlay-next` — the overlay HTTP API (PRD §10, §10.1 "Next package
 * exposes App Router handlers and server helpers"; §37 Phase 2 "Local API and
 * client").
 *
 * WHAT LIVES HERE
 * The document, mutation, action, status and event endpoints PRD §37 Phase 2
 * lists, as ONE framework-neutral handler plus two mountings of it:
 *
 *   {@link createOverlayApi}       `handle(Request): Promise<Response>` — mount
 *                                  directly from an App Router `route.ts`.
 *   {@link startOverlayApiServer}  a `node:http` server for local development,
 *                                  which is what the Studio plugin talks to.
 *
 * WHAT DOES NOT LIVE HERE
 * No overlay semantics. Persistence is `sanity-overlay-store-fs`, mutation and
 * action semantics are `sanity-overlay-core`, GROQ is `sanity-overlay-query`.
 * This package is HTTP, an overlay lifecycle, a projection of what is on disk, a
 * commit queue and an event bridge. The one dialect it does own is Studio's wire
 * format, in `translate.ts`, because that is what arrives on its endpoints.
 *
 * Milestone note (PRD §1.4): `[M-LOCAL]` foundations. No milestone acceptance is
 * claimed by this package.
 */

export {OverlayApiError} from './errors'
export type {OverlayApiErrorCode} from './errors'

export {
  DUPLICATE_ACTION_TYPE,
  GUARD_PSEUDO_FIELD,
  parseSanityPath,
  translateActions,
  translateDocumentActions,
  translateInterceptedWrite,
  translateMutations,
} from './translate'
export type {
  DocumentActionStep,
  DocumentActionTranslation,
  InterceptedWrite,
  TranslationResult,
} from './translate'

export {evaluateRegisteredQuery, planRegisteredQuery} from './queries'
export type {EvaluateInput} from './queries'

export {encodeSseFrame} from './sse'
export type {SseFrame} from './sse'

export {createOverlayApi} from './api'
export type {
  OverlayApi,
  OverlayApiOptions,
  OverlayEventName,
  OverlayHydrationDocument,
} from './api'

export {DEFAULT_API_PORT, DEFAULT_STUDIO_ORIGIN, startOverlayApiServer} from './server'
export type {OverlayApiServer, StartOverlayApiServerOptions} from './server'
