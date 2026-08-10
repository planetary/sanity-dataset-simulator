/**
 * Kitchen Sink — the overlay's proof-of-install target.
 *
 * TWO PATHS LIVE IN THIS FILE, and which one runs is decided by `localStorage`.
 *
 * 1. **The product path (default).** `defineOverlayConfig` from
 *    `sanity-overlay-studio` installs the interception, the hosted-feature
 *    switches, the document-action filter and the status banner. This is the
 *    single line a real consumer writes, and it is what a browser check should
 *    exercise.
 *
 * 2. **The Spike A path.** If ANY `SPIKE_*` flag is present in `localStorage`,
 *    the config falls back to `spikeClientFactory` exactly as before — same
 *    factory, same flags, same topologies (Track A / D13 hybrid / local echo).
 *    Every Phase-1 evidence procedure in
 *    `docs/plans/evidence/phase-1/spike-a-studio-interception/` is written as
 *    "set these localStorage flags, reload", so those procedures keep working
 *    byte-for-byte: setting a flag is *itself* the switch back.
 *
 *    (The spike *tests* never load this file — they import
 *    `spikeA/instrumentedClient` directly — so they are unaffected either way.)
 *
 * The package is imported by relative path, as everything else in this repo is.
 * A real consumer writes `pnpm add sanity-overlay-studio` and
 * `import {defineOverlayConfig} from 'sanity-overlay-studio'`, which also wires
 * `createClient` and React for them; here they are passed explicitly so the
 * example needs no install of its own.
 */
import './spikeA/eventSourceTap'
import {createElement, useEffect, useState} from 'react'
import {createClient} from '@sanity/client'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes'
import {studioIdentity} from './studioIdentity.mjs'
import {spikeClientFactory} from './spikeA/instrumentedClient'
/*
 * THE PACKAGE ENTRY POINT, NOT AN INTERNAL MODULE.
 *
 * This line used to read `.../src/config` and `.../src/ui/statusLayout`. A
 * consumer cannot write that — `sanity-overlay-studio`'s manifest exposes one
 * entry point — so the example was demonstrating an import nobody else can
 * make, and it demonstrated it while the two spellings of `defineOverlayConfig`
 * differed in completeness: the entry point attached the §21.7 document actions
 * and the internal module defaulted them to nothing. The Studio installed
 * cleanly, reported healthy, and had no overlay actions in it.
 *
 * `bindings.ts` has since moved that default one level below both, so the two
 * spellings agree again — but the example should still import what a consumer
 * imports, because the next divergence will be as silent as the last one.
 */
import {
  createOverlayStatusLayout,
  defineOverlayConfig,
} from '../../packages/sanity-overlay-studio/src/index'

/** The flags every Spike A evidence run sets. Any one of them selects the spike. */
const SPIKE_FLAGS = [
  'SPIKE_LOCAL_ECHO',
  'SPIKE_API_HOST',
  'SPIKE_INSTRUMENT',
  'SPIKE_OVERLAY_PERSIST',
  'SPIKE_STRICT_QUERIES',
]

function spikePathRequested(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return SPIKE_FLAGS.some((flag) => (localStorage.getItem(flag) ?? '').trim() !== '')
  } catch {
    return false
  }
}

const workspace = {
  name: 'kitchen-sink',
  title: 'Kitchen Sink (overlay test target)',
  /* `SANITY_STUDIO_PROJECT_ID` / `SANITY_STUDIO_DATASET` still configure this
   * Studio, from this directory's `.env` — see `studioIdentity.mjs`. What
   * changed is that `sanity.cli.ts` has already refused to start if the shell
   * disagreed with that file, so a value arriving here was declared on purpose
   * rather than inherited from whatever the terminal was last used for. */
  ...studioIdentity(process.env as Record<string, string | undefined>),
  plugins: [structureTool()],
  schema: {types: schemaTypes},
}

export default spikePathRequested()
  ? // SPIKE A path — unchanged from the original lab rig (§36.1).
    defineConfig({...workspace, unstable_clientFactory: spikeClientFactory})
  : // Product path — the one line `sanity-overlay-studio` exists to make possible.
    defineOverlayConfig(workspace, {
      /* The WHOLE ambient environment, deliberately. Nothing the plugin reads
       * out of it points at a project — it reads `OVERLAY_MODE`, `OVERLAY_API_URL`
       * and friends, which select behaviour inside this repository — and one
       * thing it does with it is SCAN for a write token under any spelling
       * (`options.ts` → `assertNoWriteToken`). Handing that scan a filtered map
       * would blind the safety check to exactly the variable it exists to find. */
      env: process.env as Record<string, string | undefined>,
      createClient: (options) => createClient(options as never) as unknown as object,
      layout: createOverlayStatusLayout({createElement, useEffect, useState}),
    })
