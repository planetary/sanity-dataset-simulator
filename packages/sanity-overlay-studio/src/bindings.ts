/**
 * The host Studio's React, bound ONCE, and the three components that need it.
 *
 * WHY THIS MODULE EXISTS.
 *
 * The overlay contributes three things a Studio can only receive as React
 * components: the §21.3 status banner, the §28.3 conflict panel, and the §21.7
 * document actions (rebase, resolve conflicts, checkpoint). Every module that
 * *decides* anything about them is React-free and takes an injected `ReactLike`,
 * which is what makes their behaviour testable in plain Node with no DOM.
 *
 * Somewhere that injection has to actually happen. It used to happen in
 * `index.ts` alone, and `config.ts` — which is what builds the workspace —
 * defaulted `documentActions` to `[]` when nobody handed it any. That produced a
 * workspace that installed cleanly, reported `healthy`, and simply had no
 * overlay actions in it: `examples/kitchen-sink/sanity.config.ts` imports
 * `defineOverlayConfig` from `./config` rather than from the entry point, so a
 * real Studio rendered publish / Duplicate / Delete and nothing else, with no
 * error anywhere. Two exports of the same name with different completeness is
 * not a configuration option; it is a defect with a 50% hit rate.
 *
 * So the binding lives here, one level below both, and `config.ts` uses it as
 * its default. There is now exactly one answer to "what does a workspace the
 * overlay patched contain", whichever module a caller reached for.
 *
 * IT IS STILL AN INJECTION. `DefineOverlayConfigOptions.documentActions` and
 * `.layout` override these, which is how a Node test drives the same seam with a
 * fake React (`test/studio-document-action-delivery.test.ts`) and how a host
 * that wants its own surface supplies one.
 *
 * IDENTITY. Built at module scope, so the component objects are the same on
 * every resolve pass — `actions.ts` de-duplicates by `.action` key and Studio
 * compares by reference. `spike-a-client-identity` exists because an unstable
 * reference in this position cost 20,000 resubscribes.
 */

import {createElement, useEffect, useState} from 'react'

import {createOverlayConflictPanel} from './ui/conflictPanel'
import {createOverlayDocumentActions} from './ui/documentActions'
import {createOverlayStatusLayout, type ReactLike} from './ui/statusLayout'

/**
 * The slice of the host's React this package uses.
 *
 * `react` is a peer dependency, declared and never bundled, so this resolves to
 * the single copy the Studio already has. It is imported here and in no decision
 * module — see `ui/statusLayout.ts` for why the modules underneath take it as an
 * argument instead.
 */
export const HOST_REACT: ReactLike = {createElement, useEffect, useState}

/** The §21.3 status banner, bound to the host's React. */
export const OverlayStatusLayout = createOverlayStatusLayout(HOST_REACT)

/** The §28.3 conflict panel, for a host building its own surface around it. */
export const OverlayConflictPanel = createOverlayConflictPanel(HOST_REACT)

/** The three §21.7 document actions, in menu order: rebase, resolve, checkpoint. */
export const OverlayDocumentActions = createOverlayDocumentActions(HOST_REACT)
